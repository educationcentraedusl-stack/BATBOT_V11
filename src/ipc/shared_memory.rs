use std::sync::atomic::{AtomicU64, Ordering};

pub const SHARED_MEMORY_SLOTS: usize = 256;
pub const SHARED_MEMORY_BYTES: usize = SHARED_MEMORY_SLOTS * 8; // 2048 bytes

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
    }
}
