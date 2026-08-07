use crate::{GLOBAL_AI_ENGINE, GLOBAL_SHADOW_ENGINE};
use crate::ai::PreflightPhase;
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
        self.start_consumer_loop_asset(queue, 0);
    }

    pub fn start_consumer_loop_asset(&self, queue: LockFreeSpscQueue, asset_idx: usize) {
        if asset_idx >= self.bridge.max_assets() {
            eprintln!(
                "[BATBOT_V11][Bridge Error] asset_idx {} out of bounds (max_assets: {})",
                asset_idx,
                self.bridge.max_assets()
            );
            return;
        }

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
                    bridge.write_lob_snapshot_asset(
                        asset_idx,
                        &lob.bids,
                        &lob.asks,
                        lob.metrics.obi,
                        lob.metrics.cvd,
                        lob.metrics.spread_velocity,
                        lob.metrics.total_liquidation_vol,
                        lob.metrics.buy_liquidation_vol,
                        lob.metrics.sell_liquidation_vol,
                        lob.metrics.rv_gk,
                        lob.metrics.vpin,
                        lob.metrics.hurst,
                        lob.metrics.lob_entropy,
                        lob.metrics.regime,
                        lob.metrics.is_sweep_detected,
                        lob.last_update_ns,
                        LockFreeSpscQueue::dropped_count(),
                        seq,
                    );

                    // Execute AI inference pipeline on every 10th LOB snapshot using GLOBAL_AI_ENGINE (Lock-Free RCU)
                    if seq % 10 == 0 {
                        if let Some(engine) = GLOBAL_AI_ENGINE.load().as_ref() {
                            if let Err(e) = engine.run_inference_asset(&bridge, asset_idx) {
                                eprintln!("[BATBOT_V11][AI Engine Error][Asset {}] Inference error: {}", asset_idx, e);
                            }
                        }

                        // Parallel Shadow Ingestion & Pre-Flight Gated Auto-Promotion
                        if let Some(shadow_mutex) = GLOBAL_SHADOW_ENGINE.load().as_ref() {
                            if let Ok(mut validator) = shadow_mutex.try_lock() {
                                validator.step_shadow(&bridge);
                                if validator.phase() == PreflightPhase::Passed {
                                    if let Some(promoted_engine) = validator.promote() {
                                        GLOBAL_AI_ENGINE.store(Some(Arc::new(promoted_engine)));
                                        GLOBAL_SHADOW_ENGINE.store(None);
                                        println!(
                                            "[BATBOT_V11][Pre-Flight Auto-Promotion SUCCESS] Passed all 4 Gates! Atomically promoted candidate model to GLOBAL_AI_ENGINE via lock-free RCU store."
                                        );
                                    }
                                }
                            }
                        }
                    }
                } else {
                    sleep(Duration::from_micros(100)).await;
                }
            }
        });
    }
}
