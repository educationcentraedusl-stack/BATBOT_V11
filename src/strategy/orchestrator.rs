use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use crossbeam_queue::ArrayQueue;

use crate::ai::engine::{AIEngine, StreamingFeaturePipeline};
use crate::ipc::shared_memory::AtomicSharedMemoryBridge;
use crate::lob::book::{MultiAssetLOBManager, MAX_CONCURRENT_ASSETS};
use crate::lob::LockFreeSpscQueue;
use crate::oms::multi_asset_oms::MultiAssetOmsEngine;
use crate::risk::CovarianceRiskGuard;

pub static ORCHESTRATOR_TICK_COUNT: AtomicU64 = AtomicU64::new(0);
pub static ORCHESTRATOR_SIGNAL_COUNT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy)]
pub struct OrchestratorSignal {
    pub asset_idx: usize,
    pub symbol: [u8; 16],
    pub symbol_len: usize,
    pub signal_direction: f64, // +1.0 (BUY), -1.0 (SELL), 0.0 (NEUTRAL)
    pub confidence: f64,
    pub target_notional: f64,
    pub price: f64,
    pub timestamp_ns: u64,
}

#[inline(always)]
fn format_asset_symbol_bytes(asset_idx: usize) -> ([u8; 16], usize) {
    let mut buf = [0u8; 16];
    buf[0] = b'A';
    buf[1] = b'S';
    buf[2] = b'S';
    buf[3] = b'E';
    buf[4] = b'T';
    buf[5] = b'_';
    if asset_idx < 10 {
        buf[6] = b'0' + (asset_idx as u8);
        (buf, 7)
    } else {
        buf[6] = b'1';
        buf[7] = b'0';
        (buf, 8)
    }
}

pub struct StrategyOrchestrator {
    lob_manager: Arc<MultiAssetLOBManager>,
    ai_engine: Option<Arc<AIEngine>>,
    risk_guard: Option<Arc<CovarianceRiskGuard>>,
    oms_engine: Option<Arc<MultiAssetOmsEngine>>,
    sab_bridge: Option<Arc<AtomicSharedMemoryBridge>>,
    signal_queue: Arc<ArrayQueue<OrchestratorSignal>>,
    is_running: Arc<AtomicBool>,
}

impl StrategyOrchestrator {
    pub fn new(
        lob_manager: Arc<MultiAssetLOBManager>,
        ai_engine: Option<Arc<AIEngine>>,
        risk_guard: Option<Arc<CovarianceRiskGuard>>,
        oms_engine: Option<Arc<MultiAssetOmsEngine>>,
        sab_bridge: Option<Arc<AtomicSharedMemoryBridge>>,
    ) -> Self {
        Self {
            lob_manager,
            ai_engine,
            risk_guard,
            oms_engine,
            sab_bridge,
            signal_queue: Arc::new(ArrayQueue::new(1024)),
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::Relaxed);
    }

    pub fn signal_queue(&self) -> Arc<ArrayQueue<OrchestratorSignal>> {
        self.signal_queue.clone()
    }

    pub fn pop_signal(&self) -> Option<OrchestratorSignal> {
        self.signal_queue.pop()
    }

    pub fn tick_count() -> u64 {
        ORCHESTRATOR_TICK_COUNT.load(Ordering::Relaxed)
    }

    pub fn signal_count() -> u64 {
        ORCHESTRATOR_SIGNAL_COUNT.load(Ordering::Relaxed)
    }

    /// Dedicated synchronous unblocked event processing thread (Condition 2: Async Bypass)
    /// Pops events from WS queues, updates L2 orderbooks, extracts alpha features, runs AI inference,
    /// performs risk screening, and dispatches OMS orders synchronously without yielding to Tokio.
    pub fn start_synchronous_orchestrator(
        self: Arc<Self>,
        queues: Vec<LockFreeSpscQueue>,
    ) -> std::thread::JoinHandle<()> {
        self.is_running.store(true, Ordering::Relaxed);
        let orchestrator = self.clone();

        std::thread::Builder::new()
            .name("batbot-strategy-orchestrator".to_string())
            .spawn(move || {
                println!("[StrategyOrchestrator] Dedicated synchronous orchestrator thread launched.");

                // Pre-allocated streaming feature pipelines per asset (zero heap allocations in hot path)
                let mut feature_pipelines: [StreamingFeaturePipeline; MAX_CONCURRENT_ASSETS] =
                    std::array::from_fn(|_| StreamingFeaturePipeline::new());

                while orchestrator.is_running.load(Ordering::Relaxed) {
                    let mut processed_any = false;

                    for (asset_idx, q) in queues.iter().enumerate() {
                        while let Some(evt) = q.pop() {
                            processed_any = true;
                            ORCHESTRATOR_TICK_COUNT.fetch_add(1, Ordering::Relaxed);

                            // 1. Single-lock batch update & evaluation (takes RwLock write guard EXACTLY ONCE per tick)
                            if let Some((top_of_book, metrics)) = orchestrator.lob_manager.process_and_evaluate_asset(asset_idx, evt) {
                                // Update SAB zero-copy telemetry if attached
                                if let Some(ref sab) = orchestrator.sab_bridge {
                                    sab.store_f64_asset(asset_idx, 0, metrics.obi);
                                    sab.store_f64_asset(asset_idx, 1, metrics.last_spread);
                                    sab.store_f64_asset(asset_idx, 2, metrics.cvd);
                                    sab.store_f64_asset(asset_idx, 3, metrics.spread_velocity);
                                    sab.store_f64_asset(asset_idx, 4, metrics.rv_gk);
                                    sab.store_f64_asset(asset_idx, 5, metrics.vpin);
                                    sab.store_f64_asset(asset_idx, 6, metrics.hurst);
                                    sab.store_f64_asset(asset_idx, 7, metrics.lob_entropy);
                                    sab.store_f64_asset(asset_idx, 8, metrics.micro_price);
                                    sab.store_u64_asset(asset_idx, 90, metrics.last_timestamp_ns);
                                }

                                // 2. Alpha Feature Extraction & AI Signal Evaluation
                                if let Some(ref ai) = orchestrator.ai_engine {
                                    let lat_us = 1.0;
                                    let mut features = [0.0f64; 40];
                                    if let Some(ref sab) = orchestrator.sab_bridge {
                                        if let Ok(feat_vec) = feature_pipelines[asset_idx].update_and_normalize_asset(sab, lat_us, asset_idx) {
                                            features = feat_vec;
                                        }
                                    }

                                    // Run AI inference (CFC + TKAN)
                                    let ai_result = ai.evaluate_features(&features);
                                    let signal_direction = ai_result.0; // Direction
                                    let confidence = ai_result.1;       // Confidence

                                    // If signal confidence exceeds threshold (e.g. 0.65)
                                    if confidence >= 0.65 && signal_direction.abs() > 0.5 {
                                        // Dynamic price derivation from live top of L2 orderbook
                                        if let Some((best_bid, best_ask, mid_price)) = top_of_book {
                                            let is_buy = signal_direction > 0.0;
                                            let price = if is_buy {
                                                if best_ask > 0.0 { best_ask } else { mid_price }
                                            } else {
                                                if best_bid > 0.0 { best_bid } else { mid_price }
                                            };

                                            if price <= 0.0 {
                                                continue;
                                            }

                                            let target_notional = 100.0 * confidence;

                                            // Global Portfolio Risk State Aggregation across ALL active assets (0..K-1)
                                            let mut total_portfolio_exposure = 0.0;
                                            let mut total_portfolio_pnl = 0.0;
                                            let mut current_drawdown = 0.0;

                                            if let Some(ref oms) = orchestrator.oms_engine {
                                                let balance = oms.account_balance_usd();
                                                let symbols = oms.symbols();
                                                let max_a = symbols.len().min(MAX_CONCURRENT_ASSETS);

                                                for i in 0..max_a {
                                                    let oms_m = oms.get_metrics(i);
                                                    total_portfolio_exposure += (oms_m.current_position_size * oms_m.avg_entry_price).abs();
                                                    total_portfolio_pnl += oms_m.realized_pnl_usd + oms_m.unrealized_pnl_usd;
                                                }

                                                if balance > 0.0 && total_portfolio_pnl < 0.0 {
                                                    current_drawdown = (-total_portfolio_pnl / balance).clamp(0.0, 1.0);
                                                }
                                            }

                                            // 3. Pre-trade Risk Screening against Global Portfolio Risk Limits
                                            let mut risk_passed = true;
                                            if let Some(ref risk) = orchestrator.risk_guard {
                                                risk_passed = risk.verify_pretrade_risk(
                                                    target_notional,
                                                    current_drawdown,
                                                    total_portfolio_exposure,
                                                );
                                            }

                                            if risk_passed {
                                                // Resolve actual asset symbol string from OMS ledger or fallback
                                                let mut symbol_buf = [0u8; 16];
                                                let sym_len;

                                                if let Some(ref oms) = orchestrator.oms_engine {
                                                    let symbols = oms.symbols();
                                                    let sym_name = symbols.get(asset_idx).map(|s| s.as_str()).unwrap_or("ASSET");
                                                    let bytes = sym_name.as_bytes();
                                                    sym_len = bytes.len().min(16);
                                                    symbol_buf[..sym_len].copy_from_slice(&bytes[..sym_len]);
                                                } else {
                                                    let (b, l) = format_asset_symbol_bytes(asset_idx);
                                                    symbol_buf = b;
                                                    sym_len = l;
                                                }

                                                let signal = OrchestratorSignal {
                                                    asset_idx,
                                                    symbol: symbol_buf,
                                                    symbol_len: sym_len,
                                                    signal_direction,
                                                    confidence,
                                                    target_notional,
                                                    price,
                                                    timestamp_ns: metrics.last_timestamp_ns,
                                                };

                                                let _ = orchestrator.signal_queue.push(signal);
                                                ORCHESTRATOR_SIGNAL_COUNT.fetch_add(1, Ordering::Relaxed);

                                                // 4. Direct Phase 4 OMS Dispatch with explicit asset_idx
                                                if let Some(ref oms) = orchestrator.oms_engine {
                                                    let sym_str = std::str::from_utf8(&symbol_buf[..sym_len]).unwrap_or("ASSET");
                                                    let _ = oms.submit_sliced_order(asset_idx, sym_str, is_buy, price, target_notional, 3);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if !processed_any {
                        std::hint::spin_loop();
                    }
                }

                println!("[StrategyOrchestrator] Synchronous orchestrator thread shutdown cleanly.");
            })
            .expect("Failed to spawn dedicated strategy orchestrator thread")
    }
}
