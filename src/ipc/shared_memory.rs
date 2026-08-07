use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

pub const DEFAULT_MAX_CONCURRENT_ASSETS: usize = 10;
pub const DEFAULT_SAB_SLOTS_PER_ASSET: usize = 256;
pub const SHARED_MEMORY_SLOTS: usize = DEFAULT_SAB_SLOTS_PER_ASSET;
pub const SHARED_MEMORY_BYTES: usize = SHARED_MEMORY_SLOTS * 8; // 2048 bytes for single-asset baseline

const MAX_ASSETS_TRACKER: usize = 32;
const HAWKES_BUF_CAP: usize = 64;

struct MicroburstMetricsTracker {
    timestamps: [[u64; HAWKES_BUF_CAP]; MAX_ASSETS_TRACKER],
    mid_prices: [[f64; HAWKES_BUF_CAP]; MAX_ASSETS_TRACKER],
    head: [usize; MAX_ASSETS_TRACKER],
    count: [usize; MAX_ASSETS_TRACKER],
}

impl MicroburstMetricsTracker {
    const fn new() -> Self {
        Self {
            timestamps: [[0; HAWKES_BUF_CAP]; MAX_ASSETS_TRACKER],
            mid_prices: [[0.0; HAWKES_BUF_CAP]; MAX_ASSETS_TRACKER],
            head: [0; MAX_ASSETS_TRACKER],
            count: [0; MAX_ASSETS_TRACKER],
        }
    }

    fn push(&mut self, asset_idx: usize, timestamp_ns: u64, mid_price: f64) {
        let idx = asset_idx % MAX_ASSETS_TRACKER;
        let h = self.head[idx];
        self.timestamps[idx][h] = timestamp_ns;
        self.mid_prices[idx][h] = mid_price;
        self.head[idx] = (h + 1) % HAWKES_BUF_CAP;
        if self.count[idx] < HAWKES_BUF_CAP {
            self.count[idx] += 1;
        }
    }

    /// Computes true Hawkes Process Intensity λ(t) = μ + ∑_{t_i < t} α * exp(-β * (t - t_i))
    /// with μ = 1.0 baseline, α = 0.75 jump size, β = 2.5 sec⁻¹ decay rate.
    fn compute_hawkes_intensity(&self, asset_idx: usize, current_ts_ns: u64, abs_vel: f64, abs_obi: f64) -> f64 {
        let idx = asset_idx % MAX_ASSETS_TRACKER;
        let baseline = 1.0 + (abs_vel * 10.0) + (abs_obi - 0.4).max(0.0) * 5.0;
        if self.count[idx] == 0 || current_ts_ns == 0 {
            return baseline.min(20.0);
        }

        let alpha = 0.75;
        let beta = 2.5;
        let mut decay_sum = 0.0;

        let mut i = 0;
        while i < self.count[idx] {
            let ts = self.timestamps[idx][i];
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
    fn compute_realized_volatility(&self, asset_idx: usize, fallback_vel: f64) -> f64 {
        let idx = asset_idx % MAX_ASSETS_TRACKER;
        if self.count[idx] < 2 {
            return (fallback_vel * 0.05 + 0.001).min(0.1);
        }

        let mut sum_sq_log_returns = 0.0;
        let mut valid_returns = 0usize;

        let start_idx = if self.count[idx] < HAWKES_BUF_CAP { 0 } else { self.head[idx] };
        let n = self.count[idx];

        let mut i = 0;
        while i < n - 1 {
            let idx_prev = (start_idx + i) % HAWKES_BUF_CAP;
            let idx_curr = (start_idx + i + 1) % HAWKES_BUF_CAP;
            let p_prev = self.mid_prices[idx][idx_prev];
            let p_curr = self.mid_prices[idx][idx_curr];

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
    total_slots: usize,
    max_assets: usize,
    slots_per_asset: usize,
}

unsafe impl Send for AtomicSharedMemoryBridge {}
unsafe impl Sync for AtomicSharedMemoryBridge {}

impl AtomicSharedMemoryBridge {
    pub fn new(ptr: *mut u8, len: usize) -> Result<Self, &'static str> {
        let slots_per_asset: usize = std::env::var("SAB_SLOTS_PER_ASSET")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_SAB_SLOTS_PER_ASSET);
        let min_required_bytes = slots_per_asset * 8;

        if len < min_required_bytes {
            return Err("Buffer is smaller than minimum required bytes (SAB_SLOTS_PER_ASSET * 8)");
        }
        if ptr.is_null() {
            return Err("Buffer pointer is null");
        }
        if (ptr as usize) % 8 != 0 {
            return Err("Buffer pointer is not aligned to 8-byte boundary");
        }

        let total_slots = len / 8;
        let max_assets = (total_slots / slots_per_asset).max(1);

        Ok(Self {
            ptr: ptr as *mut AtomicU64,
            total_slots,
            max_assets,
            slots_per_asset,
        })
    }

    #[inline]
    pub fn max_assets(&self) -> usize {
        self.max_assets
    }

    #[inline]
    pub fn slots_per_asset(&self) -> usize {
        self.slots_per_asset
    }

    #[inline]
    pub fn total_slots(&self) -> usize {
        self.total_slots
    }

    #[inline]
    pub fn store_u64_asset(&self, asset_idx: usize, slot: usize, val: u64) {
        if asset_idx < self.max_assets && slot < self.slots_per_asset {
            let global_slot = asset_idx * self.slots_per_asset + slot;
            if global_slot < self.total_slots {
                unsafe {
                    let cell = &*self.ptr.add(global_slot);
                    cell.store(val, Ordering::Release);
                }
            }
        }
    }

    #[inline]
    pub fn load_u64_asset(&self, asset_idx: usize, slot: usize) -> u64 {
        if asset_idx < self.max_assets && slot < self.slots_per_asset {
            let global_slot = asset_idx * self.slots_per_asset + slot;
            if global_slot < self.total_slots {
                unsafe {
                    let cell = &*self.ptr.add(global_slot);
                    cell.load(Ordering::Acquire)
                }
            } else {
                0
            }
        } else {
            0
        }
    }

    #[inline]
    pub fn store_f64_asset(&self, asset_idx: usize, slot: usize, val: f64) {
        self.store_u64_asset(asset_idx, slot, val.to_bits());
    }

    #[inline]
    pub fn load_f64_asset(&self, asset_idx: usize, slot: usize) -> f64 {
        f64::from_bits(self.load_u64_asset(asset_idx, slot))
    }

    #[inline]
    pub fn store_u64(&self, slot: usize, val: u64) {
        self.store_u64_asset(0, slot, val);
    }

    #[inline]
    pub fn load_u64(&self, slot: usize) -> u64 {
        self.load_u64_asset(0, slot)
    }

    #[inline]
    pub fn store_f64(&self, slot: usize, val: f64) {
        self.store_f64_asset(0, slot, val);
    }

    #[inline]
    pub fn load_f64(&self, slot: usize) -> f64 {
        self.load_f64_asset(0, slot)
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
        rv_gk: f64,
        vpin: f64,
        hurst: f64,
        lob_entropy: f64,
        regime: u8,
        is_sweep_detected: bool,
        timestamp_ns: u64,
        dropped_events: u64,
        seq: u64,
    ) {
        self.write_lob_snapshot_asset(
            0, bids, asks, obi, cvd, spread_vel, total_liq, buy_liq, sell_liq,
            rv_gk, vpin, hurst, lob_entropy, regime, is_sweep_detected,
            timestamp_ns, dropped_events, seq
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub fn write_lob_snapshot_asset(
        &self,
        asset_idx: usize,
        bids: &[(f64, f64); 20],
        asks: &[(f64, f64); 20],
        obi: f64,
        cvd: f64,
        spread_vel: f64,
        total_liq: f64,
        buy_liq: f64,
        sell_liq: f64,
        rv_gk: f64,
        vpin: f64,
        hurst: f64,
        lob_entropy: f64,
        regime: u8,
        is_sweep_detected: bool,
        timestamp_ns: u64,
        dropped_events: u64,
        seq: u64,
    ) {
        self.store_u64_asset(asset_idx, 0, timestamp_ns);
        self.store_f64_asset(asset_idx, 1, obi);
        self.store_f64_asset(asset_idx, 2, cvd);
        self.store_f64_asset(asset_idx, 3, spread_vel);

        // Best Bid & Ask
        self.store_f64_asset(asset_idx, 4, bids[0].0);
        self.store_f64_asset(asset_idx, 5, bids[0].1);
        self.store_f64_asset(asset_idx, 6, asks[0].0);
        self.store_f64_asset(asset_idx, 7, asks[0].1);

        // Liquidations
        self.store_f64_asset(asset_idx, 8, total_liq);
        self.store_f64_asset(asset_idx, 9, buy_liq);
        self.store_f64_asset(asset_idx, 10, sell_liq);

        // Top 20 Bids: Slots 11..50
        let mut i = 0;
        while i < 20 {
            let base = 11 + i * 2;
            self.store_f64_asset(asset_idx, base, bids[i].0);
            self.store_f64_asset(asset_idx, base + 1, bids[i].1);
            i += 1;
        }

        // Top 20 Asks: Slots 51..90
        let mut j = 0;
        while j < 20 {
            let base = 51 + j * 2;
            self.store_f64_asset(asset_idx, base, asks[j].0);
            self.store_f64_asset(asset_idx, base + 1, asks[j].1);
            j += 1;
        }

        // Telemetry & Metrics
        self.store_u64_asset(asset_idx, 91, dropped_events);
        self.store_u64_asset(asset_idx, 92, seq);

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
            tr.push(asset_idx, timestamp_ns, mid_price);
            let h = tr.compute_hawkes_intensity(asset_idx, timestamp_ns, abs_vel, abs_obi);
            let v = tr.compute_realized_volatility(asset_idx, abs_vel);
            (h, v)
        });

        let microburst_score = (hawkes_intensity / 10.0).min(1.0);

        self.store_f64_asset(asset_idx, 112, hawkes_intensity);
        self.store_f64_asset(asset_idx, 113, microburst_score);
        self.store_f64_asset(asset_idx, 114, realized_vol);

        // Slots 121..126: Dynamic Microstructure & Trap Metrics
        self.store_f64_asset(asset_idx, 121, rv_gk);
        self.store_f64_asset(asset_idx, 122, vpin);
        self.store_f64_asset(asset_idx, 123, hurst);
        self.store_f64_asset(asset_idx, 124, lob_entropy);
        self.store_f64_asset(asset_idx, 125, regime as f64);
        self.store_f64_asset(asset_idx, 126, if is_sweep_detected { 1.0 } else { 0.0 });
    }
}
