use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ipc::shared_memory::AtomicSharedMemoryBridge;
use crate::oms::position::PositionLedger;
use crate::oms::risk::{OmsRiskGuard, RiskConfig};
use crate::oms::sizing::{KellySizer, SizerConfig};
use crate::oms::sor::SmartOrderRouter;
use crate::oms::types::{ExecutionReport, OmsMetrics, OrderIntent, OrderStatus};
use crate::oms::websocket_api::{BinanceWsApiClient, BinanceWsConfig};

pub struct OmsEngine {
    symbol: String,
    position_ledger: Arc<PositionLedger>,
    kelly_sizer: KellySizer,
    risk_guard: OmsRiskGuard,
    sor: SmartOrderRouter,
    ws_client: Option<Arc<BinanceWsApiClient>>,
    metrics: RwLock<OmsMetrics>,
    last_processed_seq: AtomicU64,
    account_balance_usd: AtomicU64,
}

impl OmsEngine {
    pub fn new(
        symbol: String,
        initial_balance_usd: f64,
        sizer_config: Option<SizerConfig>,
        risk_config: Option<RiskConfig>,
        ws_config: Option<BinanceWsConfig>,
    ) -> Self {
        let position_ledger = Arc::new(PositionLedger::new(symbol.clone(), 5.0));
        let kelly_sizer = KellySizer::new(sizer_config.unwrap_or_default());
        let risk_guard = OmsRiskGuard::new(risk_config.unwrap_or_default());
        let sor = SmartOrderRouter::default_hft();

        let (ws_client, rx_reports) = if let Some(cfg) = ws_config {
            let (client, rx) = BinanceWsApiClient::new(cfg);
            (Some(Arc::new(client)), Some(rx))
        } else {
            (None, None)
        };

        let engine = Self {
            symbol,
            position_ledger: position_ledger.clone(),
            kelly_sizer,
            risk_guard,
            sor,
            ws_client,
            metrics: RwLock::new(OmsMetrics::default()),
            last_processed_seq: AtomicU64::new(0),
            account_balance_usd: AtomicU64::new(initial_balance_usd.to_bits()),
        };

        // If WS client provided, spawn execution report handler loop
        if let Some(mut rx) = rx_reports {
            let ledger_clone = position_ledger;
            tokio::spawn(async move {
                while let Some(report) = rx.recv().await {
                    if report.status == OrderStatus::Filled || report.status == OrderStatus::PartiallyFilled {
                        ledger_clone.apply_fill(
                            report.side,
                            report.last_filled_qty,
                            report.last_filled_price,
                            report.commission,
                        );
                    }
                }
            });
        }

        engine
    }

    pub fn position_ledger(&self) -> &PositionLedger {
        &self.position_ledger
    }

    pub fn account_balance_usd(&self) -> f64 {
        f64::from_bits(self.account_balance_usd.load(Ordering::Relaxed))
    }

    pub fn set_account_balance_usd(&self, balance: f64) {
        self.account_balance_usd.store(balance.to_bits(), Ordering::Release);
    }

    pub fn evaluate_sab_prediction(&self, sab: &AtomicSharedMemoryBridge) -> Option<OrderIntent> {
        let seq = sab.load_u64(103);
        if seq == 0 || seq == self.last_processed_seq.load(Ordering::Relaxed) {
            return None;
        }
        self.last_processed_seq.store(seq, Ordering::Relaxed);

        // 1. Read AI Prediction output from SAB slots 93..102
        let direction = sab.load_f64(93);
        let confidence = sab.load_f64(94);
        let horizon_ms = sab.load_f64(95);
        let slippage_ticks = sab.load_f64(100);
        let latency_ns = sab.load_u64(102);

        // 2. Read LOB Prices from SAB slots 3..6
        let spread_vel = sab.load_f64(3);
        let best_bid = sab.load_f64(4);
        let best_ask = sab.load_f64(6);

        if best_bid <= 0.0 || best_ask <= 0.0 {
            return None;
        }

        let mid_price = (best_bid + best_ask) / 2.0;
        self.position_ledger.update_mark_price(mid_price);

        // 3. Compute dynamic order size via Latency-Decayed Fractional Kelly
        let current_pos_qty = self.position_ledger.position_qty();
        let balance = self.account_balance_usd();
        let realized_vol = 0.01; // Rolling microsecond volatility

        let order_qty = self.kelly_sizer.compute_order_quantity(
            direction,
            confidence,
            horizon_ms,
            latency_ns,
            mid_price,
            spread_vel,
            balance,
            current_pos_qty,
            realized_vol,
        );

        if order_qty <= 0.0 {
            return None;
        }

        // 4. Route Order via Smart Order Router (SOR)
        let now_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;

        let tick_size = 0.10; // BTCUSDT tick size
        let intent = self.sor.route_order(
            &self.symbol,
            direction,
            confidence,
            horizon_ms,
            best_bid,
            best_ask,
            spread_vel,
            slippage_ticks,
            tick_size,
            order_qty,
            now_ns,
        )?;

        // 5. Pre-Trade Risk Verification
        if let Err(risk_err) = self.risk_guard.validate_order(&intent, mid_price, current_pos_qty) {
            eprintln!("[BATBOT_V11][OMS Risk Rejected] Order {} rejected: {}", intent.client_order_id, risk_err);
            if let Ok(mut m) = self.metrics.write() {
                m.total_orders_rejected += 1;
            }
            return None;
        }

        // 6. Submit Order to Exchange Socket (if WS client initialized)
        if let Some(ws) = &self.ws_client {
            if let Err(e) = ws.send_order_intent(&intent) {
                eprintln!("[BATBOT_V11][OMS WS Error] Failed to submit order: {}", e);
                return None;
            }
        }

        // 7. Update Metrics & SAB Sync
        if let Ok(mut m) = self.metrics.write() {
            m.total_orders_submitted += 1;
            m.total_volume_usd += intent.notional_value();
        }

        self.position_ledger.sync_to_sab(sab);

        Some(intent)
    }

    pub fn process_execution_report(&self, report: ExecutionReport, sab: Option<&AtomicSharedMemoryBridge>) {
        if report.status == OrderStatus::Filled || report.status == OrderStatus::PartiallyFilled {
            self.position_ledger.apply_fill(
                report.side,
                report.last_filled_qty,
                report.last_filled_price,
                report.commission,
            );

            if let Ok(mut m) = self.metrics.write() {
                m.total_orders_filled += 1;
                m.realized_pnl_usd = self.position_ledger.realized_pnl();
                m.unrealized_pnl_usd = self.position_ledger.unrealized_pnl();
                m.current_position_size = self.position_ledger.position_qty();
                m.avg_entry_price = self.position_ledger.avg_entry_price();
            }

            if let Some(sab_bridge) = sab {
                self.position_ledger.sync_to_sab(sab_bridge);
            }
        }
    }

    pub fn get_metrics(&self) -> OmsMetrics {
        if let Ok(m) = self.metrics.read() {
            m.clone()
        } else {
            OmsMetrics::default()
        }
    }
}
