use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

pub const SHARED_MEMORY_SLOTS: usize = 256;
pub const SHARED_MEMORY_BYTES: usize = SHARED_MEMORY_SLOTS * 8; // 2048 bytes

const HAWKES_BUF_CAP: usize = 64;

struct MicroburstMetricsTracker {
    timestamps: [u64; HAWKES_BUF_CAP],
    mid_prices: [f64; HAWKES_BUF_CAP],
    head: usize,
    count: usize,
}

impl MicroburstMetricsTracker {
    const fn new() -> Self {
        Self {
            timestamps: [0; HAWKES_BUF_CAP],
            mid_prices: [0.0; HAWKES_BUF_CAP],
            head: 0,
            count: 0,
        }
    }

    fn push(&mut self, timestamp_ns: u64, mid_price: f64) {
        self.timestamps[self.head] = timestamp_ns;
        self.mid_prices[self.head] = mid_price;
        self.head = (self.head + 1) % HAWKES_BUF_CAP;
        if self.count < HAWKES_BUF_CAP {
            self.count += 1;
        }
    }

    /// Computes true Hawkes Process Intensity λ(t) = μ + ∑_{t_i < t} α * exp(-β * (t - t_i))
    /// with μ = 1.0 baseline, α = 0.75 jump size, β = 2.5 sec⁻¹ decay rate.
    fn compute_hawkes_intensity(&self, current_ts_ns: u64, abs_vel: f64, abs_obi: f64) -> f64 {
        let baseline = 1.0 + (abs_vel * 10.0) + (abs_obi - 0.4).max(0.0) * 5.0;
        if self.count == 0 || current_ts_ns == 0 {
            return baseline.min(20.0);
        }

        let alpha = 0.75;
        let beta = 2.5;
        let mut decay_sum = 0.0;

        let mut i = 0;
        while i < self.count {
            let ts = self.timestamps[i];
            if ts > 0 && ts <= current_ts_ns {
                let delta_sec = (current_ts_ns - ts) as f64 / 1_000_000_000.0;
                if delta_sec >= 0.0 && delta_sec <= 10.0 {
                    decay_sum += alpha * (-beta * delta_sec).exp();
                }
            }
            i += 1;
        }

        (baseline + decay_sum).min(20.0)
    }

    /// Computes true Realized Volatility using rolling logarithmic returns σ = √( 1/N * ∑ (ln(P_t / P_{t-1}))² )
    fn compute_realized_volatility(&self, fallback_vel: f64) -> f64 {
        if self.count < 2 {
            return (fallback_vel * 0.05 + 0.001).min(0.1);
        }

        let mut sum_sq_log_returns = 0.0;
        let mut valid_returns = 0usize;

        let start_idx = if self.count < HAWKES_BUF_CAP { 0 } else { self.head };
        let n = self.count;

        let mut i = 0;
        while i < n - 1 {
            let idx_prev = (start_idx + i) % HAWKES_BUF_CAP;
            let idx_curr = (start_idx + i + 1) % HAWKES_BUF_CAP;
            let p_prev = self.mid_prices[idx_prev];
            let p_curr = self.mid_prices[idx_curr];

            if p_prev > 0.0 && p_curr > 0.0 {
                let log_ret = (p_curr / p_prev).ln();
                sum_sq_log_returns += log_ret * log_ret;
                valid_returns += 1;
            }
            i += 1;
        }

        if valid_returns == 0 {
            return (fallback_vel * 0.05 + 0.001).min(0.1);
        }

        let variance = sum_sq_log_returns / (valid_returns as f64);
        variance.sqrt().max(0.0001).min(0.1)
    }
}

thread_local! {
    static METRICS_TRACKER: RefCell<MicroburstMetricsTracker> = RefCell::new(MicroburstMetricsTracker::new());
}

#[derive(Clone, Copy)]
pub struct AtomicSharedMemoryBridge {
    ptr: *mut AtomicU64,
}

unsafe impl Send for AtomicSharedMemoryBridge {}
unsafe impl Sync for AtomicSharedMemoryBridge {}

impl AtomicSharedMemoryBridge {
    pub fn new(ptr: *mut u8, len: usize) -> Result<Self, &'static str> {
        if len < SHARED_MEMORY_BYTES {
            return Err("Buffer is smaller than required 2048 bytes");
        }
        if ptr.is_null() {
            return Err("Buffer pointer is null");
        }
        if (ptr as usize) % 8 != 0 {
            return Err("Buffer pointer is not aligned to 8-byte boundary");
        }
        Ok(Self {
            ptr: ptr as *mut AtomicU64,
        })
    }

    #[inline]
    pub fn store_u64(&self, slot: usize, val: u64) {
        if slot < SHARED_MEMORY_SLOTS {
            unsafe {
                let cell = &*self.ptr.add(slot);
                cell.store(val, Ordering::Release);
            }
        }
    }

    #[inline]
    pub fn load_u64(&self, slot: usize) -> u64 {
        if slot < SHARED_MEMORY_SLOTS {
            unsafe {
                let cell = &*self.ptr.add(slot);
                cell.load(Ordering::Acquire)
            }
        } else {
            0
        }
    }

    #[inline]
    pub fn store_f64(&self, slot: usize, val: f64) {
        self.store_u64(slot, val.to_bits());
    }

    #[inline]
    pub fn load_f64(&self, slot: usize) -> f64 {
        f64::from_bits(self.load_u64(slot))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn write_lob_snapshot(
        &self,
        bids: &[(f64, f64); 20],
        asks: &[(f64, f64); 20],
        obi: f64,
        cvd: f64,
        spread_vel: f64,
        total_liq: f64,
        buy_liq: f64,
        sell_liq: f64,
        timestamp_ns: u64,
        dropped_events: u64,
        seq: u64,
    ) {
        self.store_u64(0, timestamp_ns);
        self.store_f64(1, obi);
        self.store_f64(2, cvd);
        self.store_f64(3, spread_vel);

        // Best Bid & Ask
        self.store_f64(4, bids[0].0);
        self.store_f64(5, bids[0].1);
        self.store_f64(6, asks[0].0);
        self.store_f64(7, asks[0].1);

        // Liquidations
        self.store_f64(8, total_liq);
        self.store_f64(9, buy_liq);
        self.store_f64(10, sell_liq);

        // Top 20 Bids: Slots 11..50
        let mut i = 0;
        while i < 20 {
            let base = 11 + i * 2;
            self.store_f64(base, bids[i].0);
            self.store_f64(base + 1, bids[i].1);
            i += 1;
        }

        // Top 20 Asks: Slots 51..90
        let mut j = 0;
        while j < 20 {
            let base = 51 + j * 2;
            self.store_f64(base, asks[j].0);
            self.store_f64(base + 1, asks[j].1);
            j += 1;
        }

        // Telemetry & Metrics
        self.store_u64(91, dropped_events);
        self.store_u64(92, seq);

        // Slots 112..114: Micro-Burst & Dynamic Dispersion Metrics
        let abs_obi = obi.abs();
        let abs_vel = spread_vel.abs();
        let mid_price = if bids[0].0 > 0.0 && asks[0].0 > 0.0 {
            (bids[0].0 + asks[0].0) * 0.5
        } else {
            bids[0].0
        };

        let (hawkes_intensity, realized_vol) = METRICS_TRACKER.with(|tracker| {
            let mut tr = tracker.borrow_mut();
            tr.push(timestamp_ns, mid_price);
            let h = tr.compute_hawkes_intensity(timestamp_ns, abs_vel, abs_obi);
            let v = tr.compute_realized_volatility(abs_vel);
            (h, v)
        });

        let microburst_score = (hawkes_intensity / 10.0).min(1.0);

        self.store_f64(112, hawkes_intensity);
        self.store_f64(113, microburst_score);
        self.store_f64(114, realized_vol);
    }
}

