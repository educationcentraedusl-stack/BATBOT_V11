use crate::ipc::shared_memory::AtomicSharedMemoryBridge;
use crate::lob::{LimitOrderBook, LockFreeSpscQueue};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::time::{sleep, Duration};

pub struct IngestionBridge {
    bridge: AtomicSharedMemoryBridge,
    is_running: Arc<AtomicBool>,
}

impl IngestionBridge {
    pub fn new(bridge: AtomicSharedMemoryBridge) -> Self {
        Self {
            bridge,
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::Relaxed);
    }

    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::Relaxed)
    }

    pub fn start_consumer_loop(&self, queue: LockFreeSpscQueue) {
        let bridge = self.bridge;
        let is_running = self.is_running.clone();
        is_running.store(true, Ordering::Relaxed);

        tokio::spawn(async move {
            let mut lob = LimitOrderBook::new();
            let mut seq = 0u64;

            while is_running.load(Ordering::Relaxed) {
                let mut processed_any = false;

                // Process up to 256 queued events per loop batch
                let mut count = 0;
                while count < 256 {
                    if let Some(event) = queue.pop() {
                        lob.process_event(event);
                        processed_any = true;
                        count += 1;
                    } else {
                        break;
                    }
                }

                if processed_any {
                    seq = seq.wrapping_add(1);
                    bridge.write_lob_snapshot(
                        &lob.bids,
                        &lob.asks,
                        lob.metrics.obi,
                        lob.metrics.cvd,
                        lob.metrics.spread_velocity,
                        lob.metrics.total_liquidation_vol,
                        lob.metrics.buy_liquidation_vol,
                        lob.metrics.sell_liquidation_vol,
                        lob.last_update_ns,
                        LockFreeSpscQueue::dropped_count(),
                        seq,
                    );
                } else {
                    sleep(Duration::from_micros(100)).await;
                }
            }
        });
    }
}
