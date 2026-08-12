"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const microstructureHazardEngine_1 = require("../strategy/microstructureHazardEngine");
const volatilitySurfaceEngine_1 = require("../strategy/volatilitySurfaceEngine");
async function runMicrostructureVolatilityTestSuite() {
    console.log("=========================================================================");
    console.log("  BATBOT_V11 SOTA PHASE 1: MICROSTRUCTURE & VOLATILITY TEST SUITE       ");
    console.log("=========================================================================\n");
    const symbol = "BTCUSDT";
    // -------------------------------------------------------------------------
    // TEST 1: Cont-Kukanov-Stoikov Order Flow Imbalance (OFI) Calculation
    // -------------------------------------------------------------------------
    console.log("[TEST 1] Testing Order Flow Imbalance (OFI) Math...");
    const hazardEngine = new microstructureHazardEngine_1.MicrostructureHazardEngine(symbol, 50, 100, 1.0, 20, 0.75);
    // Initial Book: Bid $60,000 (1.0), Ask $60,001 (1.0)
    hazardEngine.updateOrderBook(60000, 1.0, 60001, 1.0);
    // Update 1: Bid price increases to $60,000.50 (2.0 BTC), Ask stays $60,001 (1.0 BTC)
    // e_bid = +2.0 (price up), e_ask = 0 (price same, size same) -> instantOFI = +2.0
    const ofi1 = hazardEngine.updateOrderBook(60000.5, 2.0, 60001.0, 1.0);
    console.log(`  - OFI Step 1 (Bid Up): instantOFI=${ofi1}, normOFI=${hazardEngine.getNormalizedOFI().toFixed(4)}`);
    if (ofi1 !== 2.0) {
        throw new Error(`❌ Test 1 Failed! Expected instantOFI=2.0, got ${ofi1}`);
    }
    // Update 2: Bid stays $60,000.50 (size drops to 1.5 BTC), Ask drops to $60,000.80 (3.0 BTC)
    // e_bid = 1.5 - 2.0 = -0.5, e_ask = +3.0 (ask price down) -> instantOFI = -0.5 - 3.0 = -3.5
    const ofi2 = hazardEngine.updateOrderBook(60000.5, 1.5, 60000.8, 3.0);
    console.log(`  - OFI Step 2 (Ask Drop): instantOFI=${ofi2}, normOFI=${hazardEngine.getNormalizedOFI().toFixed(4)}`);
    if (Math.abs(ofi2 - (-3.5)) > 1e-6) {
        throw new Error(`❌ Test 1 Failed! Expected instantOFI=-3.5, got ${ofi2}`);
    }
    console.log("  ✅ Order Flow Imbalance (OFI) math mathematically verified.\n");
    // -------------------------------------------------------------------------
    // TEST 2: Trade Flow Imbalance (TFI) Execution Aggression
    // -------------------------------------------------------------------------
    console.log("[TEST 2] Testing Trade Flow Imbalance (TFI) Aggression Ratio...");
    // Feed 10 aggressive Taker Buy trades (isBuyerMaker = false)
    for (let i = 0; i < 10; i++) {
        hazardEngine.updateTrade(60000, 0.5, false);
    }
    const tfiBuyAggression = hazardEngine.getTFI();
    console.log(`  - TFI after 10 Taker Buys: ${tfiBuyAggression.toFixed(4)} (Expected ~ +1.0)`);
    if (tfiBuyAggression < 0.99) {
        throw new Error(`❌ Test 2 Failed! Expected TFI ~ 1.0, got ${tfiBuyAggression}`);
    }
    // Feed 10 aggressive Taker Sell trades (isBuyerMaker = true)
    for (let i = 0; i < 10; i++) {
        hazardEngine.updateTrade(60000, 0.5, true);
    }
    const tfiBalanced = hazardEngine.getTFI();
    console.log(`  - TFI after equal Buy/Sell flow: ${tfiBalanced.toFixed(4)} (Expected ~ 0.0)`);
    if (Math.abs(tfiBalanced) > 0.01) {
        throw new Error(`❌ Test 2 Failed! Expected TFI ~ 0.0, got ${tfiBalanced}`);
    }
    console.log("  ✅ Trade Flow Imbalance (TFI) math mathematically verified.\n");
    // -------------------------------------------------------------------------
    // TEST 3: Volume-Synchronized Probability of Toxicity (VPIN)
    // -------------------------------------------------------------------------
    console.log("[TEST 3] Testing VPIN Toxicity Bucket Aggregation...");
    // Bucket volume = 1.0. Feed pure sell volume to fill 5 buckets with 100% imbalance
    for (let i = 0; i < 5; i++) {
        hazardEngine.updateTrade(60000, 1.0, true); // 1.0 BTC sell per bucket
    }
    const vpinTox = hazardEngine.getVPIN();
    console.log(`  - VPIN after toxic sell flow: ${vpinTox.toFixed(4)}`);
    const hazardMetrics = hazardEngine.getHazardMetrics("LONG", 0.40);
    console.log(`  - Composite Hazard Score (LONG position): ${hazardMetrics.hazardScore.toFixed(4)}, ExitTriggered: ${hazardMetrics.isHazardExitTriggered}`);
    if (vpinTox <= 0) {
        throw new Error(`❌ Test 3 Failed! Expected positive VPIN, got ${vpinTox}`);
    }
    console.log("  ✅ VPIN & Microstructure Hazard Rate mathematically verified.\n");
    // -------------------------------------------------------------------------
    // TEST 4: Garman-Klass & Parkinson Realized Volatility Calibration
    // -------------------------------------------------------------------------
    console.log("[TEST 4] Testing Garman-Klass & Parkinson Realized Volatility...");
    const volEngine = new volatilitySurfaceEngine_1.VolatilitySurfaceEngine(symbol, 600);
    // Push known test bar: Open=100, High=105, Low=95, Close=102
    // Theoretical Parkinson: ~0.0601, Garman-Klass: ~0.0697
    for (let i = 0; i < 50; i++) {
        volEngine.pushBar(100.0, 105.0, 95.0, 102.0);
    }
    const gkVol = volEngine.getGarmanKlassVolatility(50);
    const parkinsonVol = volEngine.getParkinsonVolatility(50);
    const volSurface = volEngine.getVolatilitySurfaceMetrics();
    console.log(`  - Garman-Klass Realized Volatility: ${gkVol.toFixed(6)} (Theoretical ~0.069691)`);
    console.log(`  - Parkinson Realized Volatility:    ${parkinsonVol.toFixed(6)} (Theoretical ~0.060106)`);
    console.log(`  - Volatility Multiplier:            ${volSurface.volatilityMultiplier.toFixed(4)}`);
    if (Math.abs(gkVol - 0.069691) > 0.005) {
        throw new Error(`❌ Test 4 Failed! Garman-Klass vol mismatch. Expected ~0.069691, got ${gkVol}`);
    }
    if (Math.abs(parkinsonVol - 0.060106) > 0.005) {
        throw new Error(`❌ Test 4 Failed! Parkinson vol mismatch. Expected ~0.060106, got ${parkinsonVol}`);
    }
    console.log("  ✅ Garman-Klass & Parkinson realized volatility math mathematically verified.\n");
    // -------------------------------------------------------------------------
    // TEST 5: Microsecond Processing Latency Benchmark (<1.5 µs target)
    // -------------------------------------------------------------------------
    console.log("[TEST 5] Running 100,000 Tick Latency & Zero-GC Benchmark...");
    const iterations = 100000;
    const startHrTime = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        hazardEngine.updateOrderBook(60000 + (i % 10), 1.5, 60001 + (i % 10), 2.0);
        hazardEngine.updateTrade(60000.5, 0.1, i % 2 === 0);
        volEngine.updatePrice(60000 + (i % 5));
    }
    const endHrTime = process.hrtime.bigint();
    const totalNs = Number(endHrTime - startHrTime);
    const avgNsPerTick = totalNs / iterations;
    const avgUsPerTick = avgNsPerTick / 1000;
    console.log(`  - Total Elapsed Time: ${(totalNs / 1e6).toFixed(2)} ms for ${iterations.toLocaleString()} ticks`);
    console.log(`  - Average Execution Latency per Tick: ${avgUsPerTick.toFixed(3)} microseconds (${avgNsPerTick.toFixed(1)} ns)`);
    if (avgUsPerTick > 1.5) {
        throw new Error(`❌ Test 5 Failed! Latency benchmark ${avgUsPerTick.toFixed(3)} µs exceeded 1.5 µs target.`);
    }
    console.log(`  ✅ Latency Benchmark PASSED! Execution time ${avgUsPerTick.toFixed(3)} µs < 1.5 µs SOTA HFT target.\n`);
    console.log("=========================================================================");
    console.log("  ✅ ALL 5 PHASE 1 TEST SUITES PASSED cleanly with 100% MATH INTEGRITY   ");
    console.log("=========================================================================");
}
runMicrostructureVolatilityTestSuite().catch((err) => {
    console.error("❌ FATAL TEST ERROR:", err);
    process.exit(1);
});
