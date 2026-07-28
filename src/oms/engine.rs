use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
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
    metrics_orders_submitted: AtomicU64,
    metrics_orders_filled: AtomicU64,
    metrics_orders_canceled: AtomicU64,
    metrics_orders_rejected: AtomicU64,
    metrics_volume_usd_bits: AtomicU64,
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
            metrics_orders_submitted: AtomicU64::new(0),
            metrics_orders_filled: AtomicU64::new(0),
            metrics_orders_canceled: AtomicU64::new(0),
            metrics_orders_rejected: AtomicU64::new(0),
            metrics_volume_usd_bits: AtomicU64::new(0.0f64.to_bits()),
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

    fn add_volume_usd(&self, volume: f64) {
        let mut cur = self.metrics_volume_usd_bits.load(Ordering::Relaxed);
        loop {
            let new_val = f64::from_bits(cur) + volume;
            match self.metrics_volume_usd_bits.compare_exchange_weak(
                cur,
                new_val.to_bits(),
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => cur = actual,
            }
        }
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

        // Dynamically compute rolling volatility from SAB slot 98 or microsecond spread velocity
        let sab_vol = sab.load_f64(98);
        let realized_vol = if sab_vol > 0.0 {
            sab_vol
        } else {
            (spread_vel.abs() / mid_price).max(0.001)
        };

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

        // Dynamic tick size from SmartOrderRouter configuration
        let tick_size = self.sor.tick_size();
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
            self.metrics_orders_rejected.fetch_add(1, Ordering::Relaxed);
            return None;
        }

        // 6. Submit Order to Exchange Socket (if WS client initialized)
        if let Some(ws) = &self.ws_client {
            if let Err(e) = ws.send_order_intent(&intent) {
                eprintln!("[BATBOT_V11][OMS WS Error] Failed to submit order: {}", e);
                return None;
            }
        }

        // 7. Update Lock-Free Metrics & SAB Sync
        self.metrics_orders_submitted.fetch_add(1, Ordering::Relaxed);
        self.add_volume_usd(intent.notional_value());

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

            self.metrics_orders_filled.fetch_add(1, Ordering::Relaxed);

            if let Some(sab_bridge) = sab {
                self.position_ledger.sync_to_sab(sab_bridge);
            }
        } else if report.status == OrderStatus::Canceled {
            self.metrics_orders_canceled.fetch_add(1, Ordering::Relaxed);
        } else if report.status == OrderStatus::Rejected {
            self.metrics_orders_rejected.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn get_metrics(&self) -> OmsMetrics {
        OmsMetrics {
            total_orders_submitted: self.metrics_orders_submitted.load(Ordering::Relaxed),
            total_orders_filled: self.metrics_orders_filled.load(Ordering::Relaxed),
            total_orders_canceled: self.metrics_orders_canceled.load(Ordering::Relaxed),
            total_orders_rejected: self.metrics_orders_rejected.load(Ordering::Relaxed),
            total_volume_usd: f64::from_bits(self.metrics_volume_usd_bits.load(Ordering::Relaxed)),
            realized_pnl_usd: self.position_ledger.realized_pnl(),
            unrealized_pnl_usd: self.position_ledger.unrealized_pnl(),
            current_position_size: self.position_ledger.position_qty(),
            avg_entry_price: self.position_ledger.avg_entry_price(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oms::types::OrderSide;
    use crate::oms::websocket_api::BinanceWsApiClient;

    #[test]
    fn test_oms_lock_free_engine_and_sab_evaluation() {
        let mut buffer = [0u64; 256];
        let sab = AtomicSharedMemoryBridge::new(
            buffer.as_mut_ptr() as *mut u8,
            buffer.len() * 8,
        ).unwrap();

        let risk_config = RiskConfig {
            max_notional_per_order: 100_000.0,
            ..RiskConfig::default()
        };

        let engine = OmsEngine::new("BTCUSDT".to_string(), 100_000.0, None, Some(risk_config), None);

        // Populate SAB with test tick data
        sab.store_f64(3, 0.2); // Spread velocity
        sab.store_f64(4, 50000.0); // Best bid
        sab.store_f64(6, 50002.0); // Best ask
        sab.store_f64(93, 1.0); // Direction (Long)
        sab.store_f64(94, 0.90); // High confidence
        sab.store_f64(95, 20.0); // Horizon ms
        sab.store_f64(98, 0.005); // Rolling volatility
        sab.store_f64(100, 2.0); // Slippage ticks
        sab.store_u64(102, 500_000); // 500us latency
        sab.store_u64(103, 1); // Sequence 1

        let intent = engine.evaluate_sab_prediction(&sab);
        assert!(intent.is_some());
        let intent = intent.unwrap();

        assert_eq!(intent.symbol, "BTCUSDT");
        assert_eq!(intent.side, OrderSide::Buy);
        assert!(intent.quantity > 0.0);

        let metrics = engine.get_metrics();
        assert_eq!(metrics.total_orders_submitted, 1);
        assert!(metrics.total_volume_usd > 0.0);
    }

    #[test]
    fn test_zero_heap_hmac_signing() {
        let query = "apiKey=testkey&timestamp=1600000000000";
        let secret = "testsecret";
        let sig1 = BinanceWsApiClient::sign_query_string(query, secret).unwrap();

        let mut sig_buf = [0u8; 64];
        BinanceWsApiClient::sign_query_string_buf(query.as_bytes(), secret, &mut sig_buf).unwrap();
        let sig2 = std::str::from_utf8(&sig_buf).unwrap();

        assert_eq!(sig1, sig2);
        assert_eq!(sig1.len(), 64);
    }

    #[test]
    fn test_sor_dynamic_tick_size_and_zero_format_routing() {
        let sor = SmartOrderRouter::default_hft();
        assert_eq!(sor.tick_size(), 0.10);

        let intent = sor.route_order(
            "ETHUSDT",
            1.0,
            0.90,
            20.0,
            3000.0,
            3000.5,
            0.6,
            2.0,
            0.05,
            1.5,
            1600000000000000000,
        );

        assert!(intent.is_some());
        let intent = intent.unwrap();
        assert_eq!(intent.symbol, "ETHUSDT");
        assert_eq!(intent.side, OrderSide::Buy);
        assert!(intent.client_order_id.starts_with("BAT_"));
    }
}

