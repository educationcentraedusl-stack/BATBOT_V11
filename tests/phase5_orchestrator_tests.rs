use batbot_v11_core::lob::book::{MarketUpdateEvent, MultiAssetLOBManager, LOB_DEPTH, MAX_CONCURRENT_ASSETS};
use batbot_v11_core::lob::LockFreeSpscQueue;
use batbot_v11_core::oms::multi_asset_oms::MultiAssetOmsEngine;
use batbot_v11_core::strategy::orchestrator::StrategyOrchestrator;
use batbot_v11_core::ai::AIEngine;
use std::sync::Arc;
use std::time::Instant;

#[test]
fn test_fast_float_parsing_performance() {
    let price_str = "95432.50";
    let qty_str = "1.524";

    let start = Instant::now();
    let iterations = 100_000;

    for _ in 0..iterations {
        let p = fast_float::parse::<f64, _>(price_str.as_bytes()).unwrap();
        let q = fast_float::parse::<f64, _>(qty_str.as_bytes()).unwrap();
        assert!((p - 95432.50).abs() < 1e-6);
        assert!((q - 1.524).abs() < 1e-6);
    }

    let elapsed = start.elapsed();
    let nanos_per_op = elapsed.as_nanos() as f64 / (iterations * 2) as f64;
    println!(
        "\n[Bench] fast-float parsed 200,000 floats in {:?}. Average latency: {:.2} ns / parse",
        elapsed, nanos_per_op
    );
    let threshold_ns = if cfg!(debug_assertions) { 1000.0 } else { 50.0 };
    assert!(
        nanos_per_op < threshold_ns,
        "Float parse latency ({:.2} ns) exceeded threshold ({:.2} ns)",
        nanos_per_op,
        threshold_ns
    );
}

#[test]
fn test_multi_asset_lob_manager_unblocked_thread() {
    let lob_mgr = Arc::new(MultiAssetLOBManager::new());
    let queues: Vec<LockFreeSpscQueue> = (0..MAX_CONCURRENT_ASSETS)
        .map(|_| LockFreeSpscQueue::new(4096))
        .collect();

    let handle = lob_mgr.clone().spawn_unblocked_processor(queues.clone());

    // Push 10,000 depth events across 10 asset queues
    let mut bids = [(0.0, 0.0); LOB_DEPTH];
    let mut asks = [(0.0, 0.0); LOB_DEPTH];
    bids[0] = (100.0, 1.5);
    asks[0] = (100.5, 2.0);

    let _start = Instant::now();
    let total_events = 10_000;

    for i in 0..total_events {
        let asset_idx = i % MAX_CONCURRENT_ASSETS;
        let evt = MarketUpdateEvent::DepthUpdate {
            bids,
            asks,
            timestamp_ns: (1_000_000 + i) as u64,
        };
        let _ = queues[asset_idx].push(evt);
    }

    // Wait briefly for synchronous unblocked processor thread to consume queue
    std::thread::sleep(std::time::Duration::from_millis(50));
    lob_mgr.stop();
    let _ = handle.join();

    for asset_idx in 0..MAX_CONCURRENT_ASSETS {
        let metrics = lob_mgr.get_metrics_for_asset(asset_idx).expect("Metrics missing");
        assert!((metrics.last_spread - 0.5).abs() < 1e-6);
    }

    println!(
        "[Test] MultiAssetLOBManager synchronous processor successfully verified across 10 assets in {:?}",
        _start.elapsed()
    );
}

#[test]
fn test_strategy_orchestrator_end_to_end() {
    let lob_mgr = Arc::new(MultiAssetLOBManager::new());
    let ai_engine = Arc::new(AIEngine::new());
    let oms_engine = Arc::new(MultiAssetOmsEngine::default_hft(100_000.0));

    let orchestrator = Arc::new(StrategyOrchestrator::new(
        lob_mgr,
        Some(ai_engine),
        None,
        Some(oms_engine.clone()),
        None,
    ));

    let queues: Vec<LockFreeSpscQueue> = (0..MAX_CONCURRENT_ASSETS)
        .map(|_| LockFreeSpscQueue::new(4096))
        .collect();

    let handle = orchestrator.clone().start_synchronous_orchestrator(queues.clone());

    // Push depth and trade events
    let mut bids = [(0.0, 0.0); LOB_DEPTH];
    let mut asks = [(0.0, 0.0); LOB_DEPTH];
    bids[0] = (50000.0, 10.0);
    asks[0] = (50001.0, 1.0);

    for i in 0..100 {
        let evt = MarketUpdateEvent::DepthUpdate {
            bids,
            asks,
            timestamp_ns: (1000 + i) as u64,
        };
        let _ = queues[0].push(evt);
    }

    std::thread::sleep(std::time::Duration::from_millis(30));
    orchestrator.stop();
    let _ = handle.join();

    assert!(StrategyOrchestrator::tick_count() >= 100);
    println!(
        "[Test] StrategyOrchestrator verified. Ticks processed: {}",
        StrategyOrchestrator::tick_count()
    );
}
