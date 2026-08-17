"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const risk_1 = require("../execution/risk");
const orderManager_1 = require("../execution/orderManager");
function assert(condition, message) {
    if (!condition) {
        throw new Error(`[ASSERTION_FAILED] ${message}`);
    }
}
async function runStepCollarTests() {
    console.log("===============================================================================");
    console.log("BATBOT_V11: PHASE 3 AGGRESSIVE PROFIT-LOCKING STEP-COLLAR (PL-SC) TEST SUITE");
    console.log("===============================================================================");
    const riskEngine = new risk_1.StepCollarRiskEngine({
        tier1ProfitThresholdUsdt: 0.50,
        tier2ProfitThresholdUsdt: 1.50,
        tier2LockProfitUsdt: 0.50,
        tier3ProfitThresholdUsdt: 2.00,
        tier3LockProfitUsdt: 1.50,
        tier3TrailingMarginUsdt: 0.50,
        takeProfitBarrierUsdt: 5.00,
        makerFeeRate: 0.00018,
        takerFeeRate: 0.00045,
    });
    // -----------------------------------------------------------------------------------------
    // TEST 1: LONG Position Multi-Tier Step-Collar Transition Verification
    // Entry: $60,000.00, Qty: 0.01 BTC ($600 Notional).
    // Total round-trip fees: $600 * 0.00018 + $600 * 0.00045 ≈ $0.108 + $0.27 = $0.378
    // -----------------------------------------------------------------------------------------
    console.log("\n[TEST 1] LONG Position Multi-Tier Step-Collar Transitions...");
    const entryPrice = 60000.0;
    const quantity = 0.01;
    const initialSl = 59280.0; // 1.20% initial SL
    const targetTp = 61500.0; // 2.50% initial TP
    const pos = riskEngine.registerPosition("BTCUSDT", "LONG", entryPrice, quantity, initialSl, targetTp);
    assert(pos.currentStopLossPrice === initialSl, `Initial SL should be ${initialSl}`);
    assert(pos.activeTier === "NONE", "Initial tier should be NONE");
    // Tick 1: Small tick without reaching Tier 1 (+0.20 gross = $60020, net ~-$0.18)
    let res = riskEngine.evaluateTick("BTCUSDT", "LONG", 60020.0);
    assert(!res.shouldUpdateStopLoss, "SL should not update below Tier 1");
    assert(res.activeTier === "NONE", "Tier should remain NONE");
    // Tick 2: Reaching Tier 1 (+0.50 net profit threshold)
    // For Qty 0.01, Net = (DeltaP * 0.01) - 0.38 >= 0.50 => DeltaP >= 88 => Price >= 60088.0
    const tier1Price = 60100.0; // Gross = $1.00, Fees ~ $0.38, Net ~ $0.62 >= $0.50
    res = riskEngine.evaluateTick("BTCUSDT", "LONG", tier1Price);
    assert(res.shouldUpdateStopLoss, "SL should update on Tier 1 trigger");
    assert(res.activeTier === "TIER_1_BREAK_EVEN", "Tier should be TIER_1_BREAK_EVEN");
    assert(res.newStopLossPrice >= entryPrice, `Stop Loss ($${res.newStopLossPrice}) must be locked at or above entry price ($${entryPrice})`);
    console.log(`  -> Tier 1 Lock Verified: Net PnL = $${res.unrealizedNetPnlUsdt.toFixed(2)}, New SL = $${res.newStopLossPrice} (Locked @ Break-Even)`);
    const tier1Sl = res.newStopLossPrice;
    // Tick 3: Reaching Tier 2 (+1.50 net profit threshold)
    // For Qty 0.01, Net >= 1.50 => Gross >= 1.88 => Price >= 60188.0
    const tier2Price = 60200.0; // Gross = $2.00, Net ~ $1.62 >= $1.50
    res = riskEngine.evaluateTick("BTCUSDT", "LONG", tier2Price);
    assert(res.shouldUpdateStopLoss, "SL should update on Tier 2 trigger");
    assert(res.activeTier === "TIER_2_PARTIAL_PROFIT", "Tier should be TIER_2_PARTIAL_PROFIT");
    assert(res.newStopLossPrice > tier1Sl, `Tier 2 SL ($${res.newStopLossPrice}) must exceed Tier 1 SL ($${tier1Sl})`);
    console.log(`  -> Tier 2 Lock Verified: Net PnL = $${res.unrealizedNetPnlUsdt.toFixed(2)}, New SL = $${res.newStopLossPrice} (Locked @ +$0.50 Net Profit)`);
    const tier2Sl = res.newStopLossPrice;
    // Tick 4: Reaching Tier 3 (+2.00 net profit threshold -> Lock +$1.50 & Aggressive Trail)
    const tier3Price = 60300.0; // Gross = $3.00, Net ~ $2.62 >= $2.00
    res = riskEngine.evaluateTick("BTCUSDT", "LONG", tier3Price);
    assert(res.shouldUpdateStopLoss, "SL should update on Tier 3 trigger");
    assert(res.activeTier === "TIER_3_AGGRESSIVE_TRAIL", "Tier should be TIER_3_AGGRESSIVE_TRAIL");
    assert(res.newStopLossPrice > tier2Sl, `Tier 3 SL ($${res.newStopLossPrice}) must exceed Tier 2 SL ($${tier2Sl})`);
    console.log(`  -> Tier 3 Base Lock Verified: Net PnL = $${res.unrealizedNetPnlUsdt.toFixed(2)}, New SL = $${res.newStopLossPrice} (Locked @ +$1.50+ Net Profit)`);
    const tier3BaseSl = res.newStopLossPrice;
    // Tick 5: Price advances further to $60,400.00 (Peak Net PnL ~ $3.62) -> SL trails tightly behind peak with $0.50 margin
    res = riskEngine.evaluateTick("BTCUSDT", "LONG", 60400.0);
    assert(res.shouldUpdateStopLoss, "SL should trail behind higher peak");
    assert(res.newStopLossPrice > tier3BaseSl, `Trailing SL ($${res.newStopLossPrice}) must advance higher with peak price`);
    console.log(`  -> Tier 3 Aggressive Trail Verified: Price = $60400.00, Peak Net = $${res.unrealizedNetPnlUsdt.toFixed(2)}, Trailing SL = $${res.newStopLossPrice}`);
    const peakTrailingSl = res.newStopLossPrice;
    // Tick 6: Monotonicity Check - Price dips from $60,400 to $60,350 -> SL MUST NOT RETREAT
    res = riskEngine.evaluateTick("BTCUSDT", "LONG", 60350.0);
    assert(!res.shouldUpdateStopLoss, "SL must not update on downward price pullbacks");
    assert(pos.currentStopLossPrice === peakTrailingSl, `SL must remain locked at peak ($${peakTrailingSl}), got $${pos.currentStopLossPrice}`);
    console.log(`  -> Monotonicity Check Verified: Pullback to $60350.00, SL remained rock-solid at $${pos.currentStopLossPrice}`);
    // Tick 7: Take Profit Barrier Hit @ $5.00 Net Profit
    // For Qty 0.01, Net >= $5.00 => Gross >= $5.38 => Price >= $60,540.00
    res = riskEngine.evaluateTick("BTCUSDT", "LONG", 60550.0);
    assert(res.isTakeProfitTriggered, "Take profit barrier must trigger at $5.00 net profit");
    assert(res.reason.includes("5_USDT"), "Reason should indicate $5 TP barrier");
    console.log(`  -> $5.00 Take Profit Barrier Verified: Price = $60550.00, Net PnL = $${res.unrealizedNetPnlUsdt.toFixed(2)}, TP Triggered = ${res.isTakeProfitTriggered}`);
    // -----------------------------------------------------------------------------------------
    // TEST 2: SHORT Position Multi-Tier Step-Collar Symmetry Verification
    // Entry: $3,000.00, Qty: 0.2 ETH ($600 Notional).
    // -----------------------------------------------------------------------------------------
    console.log("\n[TEST 2] SHORT Position Multi-Tier Step-Collar Symmetry...");
    const ethEntry = 3000.0;
    const ethQty = 0.2;
    const ethInitialSl = 3036.0;
    const ethPos = riskEngine.registerPosition("ETHUSDT", "SHORT", ethEntry, ethQty, ethInitialSl);
    // Price drops to $2,990.00 -> Gross = $2.00, Net ~ $1.62 (Tier 2 Lock)
    let ethRes = riskEngine.evaluateTick("ETHUSDT", "SHORT", 2990.0);
    assert(ethRes.activeTier === "TIER_2_PARTIAL_PROFIT" || ethRes.activeTier === "TIER_3_AGGRESSIVE_TRAIL", "Should reach Tier 2+");
    assert(ethRes.newStopLossPrice < ethEntry, `Short SL ($${ethRes.newStopLossPrice}) must be below entry price ($${ethEntry})`);
    console.log(`  -> Short Tier 2 Lock Verified: Net PnL = $${ethRes.unrealizedNetPnlUsdt.toFixed(2)}, Short SL = $${ethRes.newStopLossPrice}`);
    // Price drops to $2,970.00 -> Net PnL ~ $5.62 -> $5.00 TP Barrier Hit
    ethRes = riskEngine.evaluateTick("ETHUSDT", "SHORT", 2970.0);
    assert(ethRes.isTakeProfitTriggered, "Short position $5 TP barrier must trigger");
    console.log(`  -> Short $5.00 TP Barrier Verified: Price = $2970.00, Net PnL = $${ethRes.unrealizedNetPnlUsdt.toFixed(2)}, TP Triggered = ${ethRes.isTakeProfitTriggered}`);
    // -----------------------------------------------------------------------------------------
    // TEST 3: Pure Risk Engine Latency Benchmarking (100,000 Ticks)
    // -----------------------------------------------------------------------------------------
    console.log("\n[TEST 3] Pure Risk Engine Latency Benchmark (100,000 Ticks)...");
    const testSymbol = "SOLUSDT";
    riskEngine.registerPosition(testSymbol, "LONG", 150.0, 4.0, 148.0, 155.0);
    const startBenchmark = process.hrtime.bigint();
    const iterations = 100000;
    for (let i = 0; i < iterations; i++) {
        const syntheticPrice = 150.0 + (i % 100) * 0.05;
        riskEngine.evaluateTick(testSymbol, "LONG", syntheticPrice);
    }
    const endBenchmark = process.hrtime.bigint();
    const totalDurationMs = Number(endBenchmark - startBenchmark) / 1_000_000;
    const avgLatencyUs = (totalDurationMs * 1000) / iterations;
    console.log(`  -> Total Tick Evaluations: ${iterations}`);
    console.log(`  -> Avg Risk Engine Evaluation Latency: ${avgLatencyUs.toFixed(3)} µs / tick (< 1.5 µs SOTA target)`);
    console.log(`  -> Total Benchmark Duration: ${totalDurationMs.toFixed(2)} ms for ${iterations} ticks`);
    assert(avgLatencyUs < 5.0, `Evaluation latency (${avgLatencyUs} µs) must be well within HFT limits`);
    // -----------------------------------------------------------------------------------------
    // TEST 4: OrderManager End-to-End Pipeline Verification
    // -----------------------------------------------------------------------------------------
    console.log("\n[TEST 4] OrderManager Pipeline & Position Lifecycle...");
    const orderManager = new orderManager_1.OrderManager({
        enableExchangeNativeSl: false, // Pure pipeline evaluation without live REST network calls
    });
    const tracked = orderManager.trackPosition("SOLUSDT", "LONG", 150.0, 4.0, 148.0, 155.0);
    assert(tracked.symbol === "SOLUSDT", "Tracked symbol should be SOLUSDT");
    const tickResults = orderManager.onPriceTick("SOLUSDT", 151.0);
    assert(tickResults.length === 1, "Should evaluate 1 active position");
    assert(tickResults[0].activeTier === "TIER_1_BREAK_EVEN" || tickResults[0].activeTier === "TIER_2_PARTIAL_PROFIT" || tickResults[0].activeTier === "TIER_3_AGGRESSIVE_TRAIL", "Should transition tier on profit");
    const metrics = orderManager.getMetrics();
    console.log(`  -> Total Tracked Positions: ${metrics.activeTrackedPositions}`);
    console.log(`  -> Total Stop Loss Updates Triggered: ${metrics.totalStopLossUpdates}`);
    orderManager.untrackPosition("SOLUSDT", "LONG");
    assert(orderManager.getAllTrackedPositions().length === 0, "Position should be untracked");
    console.log("  -> Position Untracking Verified");
    console.log("\n===============================================================================");
    console.log("✅ ALL PHASE 3 STEP-COLLAR RISK ENGINE TESTS PASSED 100% SUCCESSFULLY!");
    console.log("===============================================================================");
}
runStepCollarTests().catch((err) => {
    console.error("❌ Phase 3 Step-Collar Test Failed:", err);
    process.exit(1);
});
