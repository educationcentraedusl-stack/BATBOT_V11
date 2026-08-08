use batbot_v11_core::ipc::shared_memory::AtomicSharedMemoryBridge;
use batbot_v11_core::oms::{
    KellySizer, OmsEngine, OmsRiskGuard, OrderSide, OrderType, PositionLedger, RiskConfig,
    SmartOrderRouter, TimeInForce,
};

#[test]
fn test_position_ledger_fills() {
    let ledger = PositionLedger::new("BTCUSDT".to_string(), 5.0);

    // Initial state check
    assert_eq!(ledger.position_qty(), 0.0);
    assert_eq!(ledger.avg_entry_price(), 0.0);
    assert_eq!(ledger.realized_pnl(), 0.0);

    // Buy 1.0 BTC @ $90,000
    ledger.apply_fill(OrderSide::Buy, 1.0, 90000.0, 36.0);
    assert_eq!(ledger.position_qty(), 1.0);
    assert_eq!(ledger.avg_entry_price(), 90000.0);

    // Buy another 1.0 BTC @ $92,000 (weighted entry should be $91,000)
    ledger.apply_fill(OrderSide::Buy, 1.0, 92000.0, 36.8);
    assert_eq!(ledger.position_qty(), 2.0);
    assert_eq!(ledger.avg_entry_price(), 91000.0);

    // Update mark price to $95,000 -> Unrealized PnL = 2.0 * (95000 - 91000) = $8,000
    let upnl = ledger.update_mark_price(95000.0);
    assert_eq!(upnl, 8000.0);
    assert_eq!(ledger.unrealized_pnl(), 8000.0);

    // Sell 1.0 BTC @ $95,000 -> Realized PnL = 1.0 * (95000 - 91000) - fee($38) = $3962
    ledger.apply_fill(OrderSide::Sell, 1.0, 95000.0, 38.0);
    assert_eq!(ledger.position_qty(), 1.0);
    assert_eq!(ledger.realized_pnl(), 3962.0);
}

#[test]
fn test_kelly_sizer_math() {
    let sizer = KellySizer::with_default_config();

    // High confidence, low latency -> should produce positive order size
    let qty = sizer.compute_order_quantity(
        1.0,      // direction
        0.90,     // confidence
        100.0,    // horizon ms
        5_000_000, // latency ns (5ms)
        90000.0,  // mid price
        0.1,      // spread vel
        100000.0, // account balance
        0.0,      // current position
        0.01,     // realized vol
    );

    assert!(qty > 0.0);
    assert!(qty <= 10.0); // clamped to max_order_qty

    // Zero direction -> 0 qty
    let zero_qty = sizer.compute_order_quantity(
        0.0, 0.90, 100.0, 5_000_000, 90000.0, 0.1, 100000.0, 0.0, 0.01,
    );
    assert_eq!(zero_qty, 0.0);
}

#[test]
fn test_risk_guard_collars() {
    let risk_guard = OmsRiskGuard::with_default_config();

    let sor = SmartOrderRouter::default_hft();
    let intent = sor
        .route_order(
            "BTCUSDT", 0, 1.0, 0.90, 30.0, 90000.0, 90001.0, 0.6, 0.2, 0.1, 2.0, 0.10, 0.5, 1000000,
        )
        .expect("SOR should return OrderIntent");

    // Valid order within limits
    let res = risk_guard.validate_order(&intent, 90000.5, 0.0);
    assert!(res.is_ok());

    // Price collar violation (> 1% distance from mid price)
    let bad_res = risk_guard.validate_order(&intent, 80000.0, 0.0);
    assert!(bad_res.is_err());
}

#[test]
fn test_oms_engine_sab_evaluation() {
    let mut buffer = vec![0u8; 2048];
    let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len())
        .expect("Failed to create bridge");

    let mut risk_config = RiskConfig::default();
    risk_config.max_notional_per_order = 100_000.0;

    let oms = OmsEngine::new("BTCUSDT".to_string(), 100000.0, None, Some(risk_config), None);

    // Setup SAB prediction slots 93..103
    bridge.store_f64(3, 0.6); // spread_vel
    bridge.store_f64(4, 90000.0); // best_bid
    bridge.store_f64(6, 90001.0); // best_ask
    bridge.store_f64(93, 1.0); // direction +1.0
    bridge.store_f64(94, 0.95); // confidence 0.95
    bridge.store_f64(95, 30.0); // horizon 30ms
    bridge.store_f64(100, 2.0); // slippage 2 ticks
    bridge.store_u64(103, 2_000_000); // 2ms latency (slot 103)
    bridge.store_u64(104, 1); // sequence 1 (slot 104)

    let intent_opt = oms.evaluate_sab_prediction(&bridge);
    assert!(intent_opt.is_some());

    let intent = intent_opt.unwrap();
    assert_eq!(intent.symbol, "BTCUSDT");
    assert_eq!(intent.side, OrderSide::Buy);
    assert_eq!(intent.order_type, OrderType::Limit);
    assert_eq!(intent.time_in_force, TimeInForce::Ioc); // Aggressive sweep triggered!

    // Position state synced to SAB
    let pos_qty_sab = bridge.load_f64(105);
    assert_eq!(pos_qty_sab, 0.0); // position flat prior to fills
}

#[test]
fn test_multi_asset_oms_engine_lifecycle() {
    use batbot_v11_core::oms::{ExecutionReport, MultiAssetOmsEngine, OrderIntent, OrderStatus};

    let mut buffer = vec![0u8; 20480]; // 10 assets * 256 slots * 8 bytes
    let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len())
        .expect("Failed to create multi-asset bridge");

    let symbols = vec![
        "ETHUSDT".to_string(),
        "SOLUSDT".to_string(),
        "BNBUSDT".to_string(),
    ];
    let engine = MultiAssetOmsEngine::new(3, 100000.0, symbols, None);

    let intent = OrderIntent::new(
        "CUSTOM_TS_ID_101".to_string(),
        "ETHUSDT".to_string(),
        OrderSide::Buy,
        OrderType::Limit,
        TimeInForce::Gtx,
        1.0,
        3000.0,
        false,
        true,
        50.0,
        0.90,
        1.0,
        1700000000123456789,
    ).with_asset_idx(0);

    let submit_res = engine.submit_intent(
        intent,
        3000.0,
        50000.0,
        0.001,
        0.01,
        1.0,
        0.20,
    );

    assert!(submit_res.is_ok(), "Multi-asset intent submission should succeed");
    let slices = submit_res.unwrap();
    assert!(!slices.is_empty());
    assert!(slices[0].client_order_id.starts_with("CUSTOM_TS_ID_101"));

    // Pop from intent queue
    let popped = engine.intent_queue().pop();
    assert!(popped.is_some());
    let pkt_intent = popped.unwrap().to_intent();
    assert!(pkt_intent.client_order_id.starts_with("CUSTOM_TS_ID_101"));

    // Sync SAB slots
    engine.sync_sab_slots(&bridge);
    let submitted_count = bridge.load_f64_asset(0, 186);
    assert_eq!(submitted_count, slices.len() as f64);

    // Apply fill and check sanitized volume
    let report = ExecutionReport {
        client_order_id: "CUSTOM_TS_ID_101".to_string(),
        order_id: 1,
        symbol: "ETHUSDT".to_string(),
        asset_idx: 0,
        side: OrderSide::Buy,
        status: OrderStatus::Filled,
        last_filled_qty: 1.0,
        last_filled_price: 3000.0,
        cum_filled_qty: 1.0,
        avg_price: 3000.0,
        commission: 0.75,
        commission_asset: "USDT".to_string(),
        trade_id: 100,
        event_time_ns: 1700000000123456789,
        is_maker: true,
    };
    engine.apply_fill(report);

    let metrics = engine.get_metrics(0);
    assert_eq!(metrics.total_orders_filled, 1);
    assert_eq!(metrics.total_volume_usd, 3000.0);
}
