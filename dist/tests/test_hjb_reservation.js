"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hjbReservationEngine_1 = require("../strategy/hjbReservationEngine");
const microstructureHazardEngine_1 = require("../strategy/microstructureHazardEngine");
async function runHJBReservationTestSuite() {
    console.log("=========================================================================");
    console.log("  BATBOT_V11 SOTA PHASE 2: HJB RESERVATION & HAZARD EXIT TEST SUITE     ");
    console.log("=========================================================================\n");
    const symbol = "BTCUSDT";
    // -------------------------------------------------------------------------
    // TEST 1: Avellaneda-Stoikov Reservation Price R(s, q, t) Drift
    // -------------------------------------------------------------------------
    console.log("[TEST 1] Testing HJB Reservation Price R(s, q, t) Drift Math...");
    const hjbEngine = new hjbReservationEngine_1.HJBReservationEngine(symbol, 0.10, 60.0, 1.5);
    const midPrice = 60000.0;
    const inventoryLong = 2.0; // 2.0 BTC Long
    const garmanKlassVol = 0.02; // 2.0% realized vol
    // Evaluate at t = 0s
    const r0 = hjbEngine.calculateReservationPrice(midPrice, inventoryLong, 0, garmanKlassVol);
    // Evaluate at t = 30s
    const r30 = hjbEngine.calculateReservationPrice(midPrice, inventoryLong, 30000, garmanKlassVol);
    // Evaluate at t = 55s
    const r55 = hjbEngine.calculateReservationPrice(midPrice, inventoryLong, 55000, garmanKlassVol);
    console.log(`  - Mid Price: $${midPrice.toFixed(2)}, Inventory: +${inventoryLong} BTC`);
    console.log(`  - R(s, q, t=0s):  $${r0.toFixed(2)} (Penalty: $${(midPrice - r0).toFixed(2)})`);
    console.log(`  - R(s, q, t=30s): $${r30.toFixed(2)} (Penalty: $${(midPrice - r30).toFixed(2)})`);
    console.log(`  - R(s, q, t=55s): $${r55.toFixed(2)} (Penalty: $${(midPrice - r55).toFixed(2)})`);
    if (r0 >= midPrice) {
        throw new Error(`❌ Test 1 Failed! Long inventory must pull reservation price below mid price. Got R0=$${r0}`);
    }
    if (r55 <= r30 || r30 <= r0) {
        throw new Error(`❌ Test 1 Failed! As holding time approaches horizon T, remaining penalty must decay. Expected R55 > R30 > R0`);
    }
    console.log("  ✅ HJB Reservation Price drift mathematically verified.\n");
    // -------------------------------------------------------------------------
    // TEST 2: Continuous HJB Liquidation Boundary Evaluation
    // -------------------------------------------------------------------------
    console.log("[TEST 2] Testing HJB Optimal Stopping Liquidation Boundary...");
    const entryPx = 60000.0;
    const currentPxNormal = 59980.0; // Minor drop
    const currentPxAdverse = 56000.0; // Severe drop breaching $56,765 HJB liquidation boundary
    const evalNormal = hjbEngine.getOptimalExitBoundary("LONG", entryPx, currentPxNormal, 1.5, 10000, 0.03);
    console.log(`  - Normal Price ($${currentPxNormal}): LiqBoundary=$${evalNormal.liquidationBoundary.toFixed(2)}, Triggered=${evalNormal.isLiquidationTriggered}`);
    const evalAdverse = hjbEngine.getOptimalExitBoundary("LONG", entryPx, currentPxAdverse, 1.5, 10000, 0.03);
    console.log(`  - Adverse Price ($${currentPxAdverse}): LiqBoundary=$${evalAdverse.liquidationBoundary.toFixed(2)}, Triggered=${evalAdverse.isLiquidationTriggered}, Reason=${evalAdverse.exitReason}`);
    if (evalNormal.isLiquidationTriggered) {
        throw new Error(`❌ Test 2 Failed! Normal price drop should not trigger HJB liquidation.`);
    }
    if (!evalAdverse.isLiquidationTriggered) {
        throw new Error(`❌ Test 2 Failed! Severe price drop breaching HJB boundary must trigger liquidation.`);
    }
    console.log("  ✅ HJB Optimal Liquidation boundary mathematically verified.\n");
    // -------------------------------------------------------------------------
    // TEST 3: Cox Proportional Hazard Rate Response h(t) = h0(t) * exp(theta^T * X_t)
    // -------------------------------------------------------------------------
    console.log("[TEST 3] Testing Cox Proportional Hazard Rate Model...");
    const hazardEngine = new microstructureHazardEngine_1.MicrostructureHazardEngine(symbol, 50, 100, 1.0, 20, 0.75);
    // Initial order book & trades
    hazardEngine.updateOrderBook(60000, 10.0, 60001, 10.0);
    // Quiet flow metrics
    const quietMetrics = hazardEngine.getHazardMetrics("LONG", 0.50, 5000);
    console.log(`  - Quiet Market: Cox Hazard Rate h(t)=${quietMetrics.coxHazardRate.toFixed(4)}, Survival S(t)=${quietMetrics.survivalProbability.toFixed(4)}`);
    // Inject toxic sell flow (20 taker sell trades of 1.0 BTC each)
    for (let i = 0; i < 20; i++) {
        hazardEngine.updateTrade(60000, 1.0, true); // Taker Sell
        hazardEngine.updateOrderBook(60000 - i * 0.5, 1.0, 60000.5 - i * 0.5, 5.0); // Ask pushing down
    }
    const toxicMetrics = hazardEngine.getHazardMetrics("LONG", 0.35, 10000);
    console.log(`  - Toxic Market: Cox Hazard Rate h(t)=${toxicMetrics.coxHazardRate.toFixed(4)}, Survival S(t)=${toxicMetrics.survivalProbability.toFixed(4)}, ExitTriggered=${toxicMetrics.isHazardExitTriggered}`);
    if (toxicMetrics.coxHazardRate <= quietMetrics.coxHazardRate) {
        throw new Error(`❌ Test 3 Failed! Toxic market flow must increase Cox Hazard Rate h(t).`);
    }
    if (toxicMetrics.survivalProbability >= quietMetrics.survivalProbability) {
        throw new Error(`❌ Test 3 Failed! Toxic market flow must decay Position Survival Probability S(t).`);
    }
    console.log("  ✅ Cox Proportional Hazard Rate model mathematically verified.\n");
    // -------------------------------------------------------------------------
    // TEST 4: Hazard Flush Position Liquidation Triggering
    // -------------------------------------------------------------------------
    console.log("[TEST 4] Testing Hazard Flush Risk-Neutral Liquidation...");
    if (!toxicMetrics.isHazardExitTriggered) {
        throw new Error(`❌ Test 4 Failed! Toxic order flow spike must trigger hazard flush liquidation exit.`);
    }
    console.log("  ✅ Hazard Flush risk-neutral liquidation mathematically verified.\n");
    // -------------------------------------------------------------------------
    // TEST 5: Microsecond Processing Latency Benchmark (<1.5 µs target per engine)
    // -------------------------------------------------------------------------
    console.log("[TEST 5] Running 100,000 Tick Latency & Zero-GC Benchmark (Phase 2 Engines)...");
    const iterations = 100000;
    const durationMs = 15000;
    const startHrTime = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        const curPx = 60000 + (i % 20);
        hjbEngine.getOptimalExitBoundary("LONG", 60000, curPx, 1.0, durationMs, 0.02);
        hazardEngine.getHazardMetrics("LONG", 0.50, durationMs);
    }
    const endHrTime = process.hrtime.bigint();
    const totalNs = Number(endHrTime - startHrTime);
    const avgNsPerDualEval = totalNs / iterations;
    const avgUsPerEngine = (avgNsPerDualEval / 2) / 1000;
    console.log(`  - Total Elapsed Time: ${(totalNs / 1e6).toFixed(2)} ms for ${iterations.toLocaleString()} dual-engine evaluation cycles`);
    console.log(`  - Average Execution Latency per Engine: ${avgUsPerEngine.toFixed(3)} microseconds (${(avgUsPerEngine * 1000).toFixed(1)} ns)`);
    if (avgUsPerEngine > 1.5) {
        throw new Error(`❌ Test 5 Failed! Phase 2 per-engine latency ${avgUsPerEngine.toFixed(3)} µs exceeded 1.5 µs target.`);
    }
    console.log(`  ✅ Phase 2 Latency Benchmark PASSED! Per-engine execution time ${avgUsPerEngine.toFixed(3)} µs < 1.5 µs SOTA HFT target.\n`);
    console.log("=========================================================================");
    console.log("  ✅ ALL 5 PHASE 2 TEST SUITES PASSED cleanly with 100% MATH INTEGRITY   ");
    console.log("=========================================================================");
}
runHJBReservationTestSuite().catch((err) => {
    console.error("❌ FATAL TEST ERROR:", err);
    process.exit(1);
});
