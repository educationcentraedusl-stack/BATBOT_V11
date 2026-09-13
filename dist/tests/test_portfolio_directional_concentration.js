"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
const engine_1 = require("../strategy/engine");
const sabSchema_1 = require("../ipc/sabSchema");
const timeSynchronizer_1 = require("../utils/timeSynchronizer");
function assert(condition, message) {
    if (!condition) {
        console.error(`❌ [ASSERTION_FAILED] ${message}`);
        throw new Error(`ASSERTION_FAILED: ${message}`);
    }
}
function createMockPositionRisk(symbol, amt, entryPx, posSide, lev = "10") {
    return {
        symbol,
        positionAmt: amt,
        entryPrice: entryPx,
        markPrice: entryPx,
        unRealizedProfit: "0",
        liquidationPrice: "0",
        leverage: lev,
        maxNotionalValue: "1000000",
        marginType: "cross",
        isolatedMargin: "0",
        isAutoAddMargin: "false",
        positionSide: posSide,
        notional: String(Math.abs(parseFloat(amt) * parseFloat(entryPx))),
        isolatedWallet: "0",
        updateTime: Date.now(),
    };
}
async function runPortfolioDirectionalConcentrationTestSuite() {
    console.log("================================================================================");
    console.log("  TEST: DEF-3101 PORTFOLIO SAME-DIRECTION CONCENTRATION LIMIT (MAX 3)");
    console.log("  In-Line Live Pipeline Production Enforcement Proof");
    console.log("================================================================================\n");
    engine_1.StrategyEngine.resetRegisteredEngines();
    const maxAssets = 10;
    const slotsPerAsset = 256;
    const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    const riskGuard = new risk_1.RiskGuard({ minCooldownMs: 0 });
    const execClient = new binance_1.BinanceExecutionClient({
        apiKey: "test_key",
        apiSecret: "test_secret",
        useTestnet: true,
    });
    const bigIntView = new BigInt64Array(sab);
    const nowMs = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs();
    for (let i = 0; i < maxAssets; i++) {
        Atomics.store(bigIntView, i * slotsPerAsset, BigInt(nowMs) * 1000000n);
    }
    // Create 4 distinct engines for 4 distinct symbols
    const engineBTC = new engine_1.StrategyEngine(client, riskGuard, execClient, {
        symbol: "BTCUSDT",
        assetIndex: 0,
        orderQuantity: 0.001,
        cooldownMs: 0,
        minAiConfidence: 0.70,
        aggressiveConfidenceThreshold: 0.75,
    });
    const engineETH = new engine_1.StrategyEngine(client, riskGuard, execClient, {
        symbol: "ETHUSDT",
        assetIndex: 1,
        orderQuantity: 0.05,
        cooldownMs: 0,
        minAiConfidence: 0.70,
        aggressiveConfidenceThreshold: 0.75,
    });
    const engineSOL = new engine_1.StrategyEngine(client, riskGuard, execClient, {
        symbol: "SOLUSDT",
        assetIndex: 2,
        orderQuantity: 1.0,
        cooldownMs: 0,
        minAiConfidence: 0.70,
        aggressiveConfidenceThreshold: 0.75,
    });
    const engineAVAX = new engine_1.StrategyEngine(client, riskGuard, execClient, {
        symbol: "AVAXUSDT",
        assetIndex: 3,
        orderQuantity: 5.0,
        cooldownMs: 0,
        minAiConfidence: 0.70,
        aggressiveConfidenceThreshold: 0.75,
    });
    const engines = [engineBTC, engineETH, engineSOL, engineAVAX];
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT"];
    const prices = [60000.0, 3000.0, 150.0, 30.0];
    const spreads = [0.5, 0.1, 0.01, 0.005];
    // Initialize healthy baseline metrics across all 4 assets
    for (let aIdx = 0; aIdx < 4; aIdx++) {
        const px = prices[aIdx];
        const sp = spreads[aIdx];
        client.setBestBidPrice(px, aIdx);
        client.setBestBidQuantity(10.0, aIdx);
        client.setBestAskPrice(px + sp, aIdx);
        client.setBestAskQuantity(10.0, aIdx);
        client.setOBI(0.0, aIdx);
        client.setCVD(0.0, aIdx);
        client.setRollingIC(0.05, aIdx); // Healthy IC (+0.05) to satisfy IR gate
        client.setHawkesIntensity(1.0, aIdx);
        client.setGarmanKlassRV(0.002, aIdx);
        client.setHurstExponent(0.65, aIdx);
        client.setLOBEntropy(0.50, aIdx);
        client.writeAtomicFloat64Asset(aIdx, sabSchema_1.SAB_SLOTS.SPREAD_VELOCITY, 0.0);
        client.setShortCooldownLock(0, aIdx);
        client.setLongCooldownLock(0, aIdx);
    }
    // --------------------------------------------------------------------------
    // STAGE 1: Baseline Directional State (Zero Active Positions)
    // --------------------------------------------------------------------------
    console.log("[STAGE 1] Verifying Baseline Directional Position Counts...");
    const initialLongs = engineAVAX.getGlobalDirectionalPositionCount("LONG");
    const initialShorts = engineAVAX.getGlobalDirectionalPositionCount("SHORT");
    console.log(`  Initial Global Long Count: ${initialLongs}, Short Count: ${initialShorts}`);
    assert(initialLongs === 0, `Initial Longs must be 0, got ${initialLongs}`);
    assert(initialShorts === 0, `Initial Shorts must be 0, got ${initialShorts}`);
    console.log("  ✓ Baseline verified: 0 Longs and 0 Shorts across all registered engines\n");
    // --------------------------------------------------------------------------
    // STAGE 2: Allocate 3 Concurrent LONG Positions (BTC, ETH, SOL)
    // --------------------------------------------------------------------------
    console.log("[STAGE 2] Allocating 3 Concurrent LONG Positions across BTC, ETH, and SOL...");
    client.setOmsLongPositionQty(0.001, 0);
    engineBTC.reconcileStartupPositions([
        createMockPositionRisk("BTCUSDT", "0.001", "60000.0", "LONG", "10"),
    ]);
    client.setOmsLongPositionQty(0.05, 1);
    engineETH.reconcileStartupPositions([
        createMockPositionRisk("ETHUSDT", "0.05", "3000.0", "LONG", "10"),
    ]);
    client.setOmsLongPositionQty(1.0, 2);
    engineSOL.reconcileStartupPositions([
        createMockPositionRisk("SOLUSDT", "1.0", "150.0", "LONG", "10"),
    ]);
    const activeLongsCount = engineAVAX.getGlobalDirectionalPositionCount("LONG");
    console.log(`  Active Global Long Count: ${activeLongsCount} (Max Allowed = 3)`);
    assert(activeLongsCount === 3, `Expected exactly 3 active Long positions, got ${activeLongsCount}`);
    console.log("  ✓ 3 Concurrent Long positions successfully confirmed in global portfolio\n");
    // --------------------------------------------------------------------------
    // STAGE 3: 4th Asset (AVAX) Evaluates Strong BUY Setup -> Must be BLOCKED
    // --------------------------------------------------------------------------
    console.log("[STAGE 3] Evaluating AVAX with Strong Bullish Setup (Expecting Concentration Limit Block)...");
    // Baseline tick on AVAX to initialize LCI
    client.writeAtomicFloat64Asset(3, sabSchema_1.SAB_SLOTS.AI_DIRECTION, 0.85);
    client.writeAtomicFloat64Asset(3, sabSchema_1.SAB_SLOTS.AI_CONFIDENCE, 0.90);
    client.setOBI(0.50, 3);
    client.setCVD(50.0, 3);
    const sig1 = engineAVAX.evaluateTick();
    if (sig1.executionPromise)
        await sig1.executionPromise;
    // Tick 2: Surging buy pressure on AVAX
    await new Promise((r) => setTimeout(r, 10));
    const nowMs2 = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs();
    Atomics.store(bigIntView, 3 * slotsPerAsset, BigInt(nowMs2) * 1000000n);
    client.setSequenceNum(2n, 3);
    client.setBestBidQuantity(30.0, 3);
    client.setBestAskQuantity(2.0, 3);
    client.setOBI(0.85, 3);
    client.setCVD(100.0, 3);
    const blockedSignal = engineAVAX.evaluateTick();
    console.log(`  AVAX Signal: ${blockedSignal.signalType}`);
    console.log(`  AVAX Risk Result Passed: ${blockedSignal.riskResult?.passed}`);
    console.log(`  AVAX Reason Code: ${blockedSignal.riskResult?.reasonCode}`);
    assert(blockedSignal.signalType === "NONE", `4th Long entry MUST be blocked (signalType=NONE), got ${blockedSignal.signalType}`);
    assert(blockedSignal.riskResult !== undefined, "Expected riskResult to be defined");
    assert(blockedSignal.riskResult?.passed === false, "Expected riskResult.passed === false");
    assert(blockedSignal.riskResult?.reasonCode === "PORTFOLIO_CONCENTRATION_LIMIT", `Expected reasonCode "PORTFOLIO_CONCENTRATION_LIMIT", got "${blockedSignal.riskResult?.reasonCode}"`);
    console.log("  ✓ DEF-3101 Verified: 4th Long signal physically blocked at the engine entry gate!\n");
    // --------------------------------------------------------------------------
    // STAGE 4: Deallocate 1 Long (ETH) -> AVAX 4th Long is Now PERMITTED
    // --------------------------------------------------------------------------
    console.log("[STAGE 4] Releasing ETH Long Position and Re-evaluating AVAX...");
    client.setOmsLongPositionQty(0.0, 1);
    engineETH.getHedgeLedger().clearSlots();
    engineETH.syncSabPositionState(0);
    const relievedLongsCount = engineAVAX.getGlobalDirectionalPositionCount("LONG");
    console.log(`  Relieved Global Long Count: ${relievedLongsCount}`);
    assert(relievedLongsCount === 2, `Expected 2 active Longs after ETH release, got ${relievedLongsCount}`);
    await new Promise((r) => setTimeout(r, 10));
    const nowMs3 = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs();
    Atomics.store(bigIntView, 3 * slotsPerAsset, BigInt(nowMs3) * 1000000n);
    client.setSequenceNum(3n, 3);
    client.setBestBidQuantity(35.0, 3);
    client.setBestAskQuantity(2.0, 3);
    client.setOBI(0.89, 3);
    client.setCVD(150.0, 3);
    const approvedSignal = engineAVAX.evaluateTick();
    if (approvedSignal.executionPromise)
        await approvedSignal.executionPromise;
    console.log(`  AVAX Signal after capacity freed: ${approvedSignal.signalType}`);
    assert(approvedSignal.signalType === "BUY", `AVAX entry must be approved when under limit (BUY), got ${approvedSignal.signalType}`);
    assert(approvedSignal.positionSide === "LONG", `Expected positionSide LONG, got ${approvedSignal.positionSide}`);
    console.log("  ✓ AVAX BUY order successfully approved once concentration fell below limit of 3\n");
    // --------------------------------------------------------------------------
    // STAGE 5: Symmetric SHORT Concentration Limit Verification
    // --------------------------------------------------------------------------
    console.log("[STAGE 5] Testing Symmetric SHORT Portfolio Concentration Limit...");
    // Clear all Long positions
    for (let i = 0; i < 4; i++) {
        client.setOmsLongPositionQty(0.0, i);
        engines[i].getHedgeLedger().clearSlots();
        engines[i].syncSabPositionState(0);
        engines[i].annihilateRestingEntryOrders("TEST_RESET");
    }
    // Allocate 3 SHORT positions across BTC, ETH, SOL
    client.setOmsShortPositionQty(0.001, 0);
    engineBTC.reconcileStartupPositions([
        createMockPositionRisk("BTCUSDT", "-0.001", "60000.0", "SHORT", "10"),
    ]);
    client.setOmsShortPositionQty(0.05, 1);
    engineETH.reconcileStartupPositions([
        createMockPositionRisk("ETHUSDT", "-0.05", "3000.0", "SHORT", "10"),
    ]);
    client.setOmsShortPositionQty(1.0, 2);
    engineSOL.reconcileStartupPositions([
        createMockPositionRisk("SOLUSDT", "-1.0", "150.0", "SHORT", "10"),
    ]);
    const activeShortsCount = engineAVAX.getGlobalDirectionalPositionCount("SHORT");
    console.log(`  Active Global Short Count: ${activeShortsCount} (Max Allowed = 3)`);
    assert(activeShortsCount === 3, `Expected exactly 3 active Short positions, got ${activeShortsCount}`);
    // AVAX evaluates strong SELL setup
    client.writeAtomicFloat64Asset(3, sabSchema_1.SAB_SLOTS.AI_DIRECTION, -0.85);
    client.writeAtomicFloat64Asset(3, sabSchema_1.SAB_SLOTS.AI_CONFIDENCE, 0.90);
    client.setOBI(-0.50, 3);
    client.setCVD(-50.0, 3);
    client.setSequenceNum(4n, 3);
    const baseShortSig = engineAVAX.evaluateTick(); // baseline
    if (baseShortSig.executionPromise)
        await baseShortSig.executionPromise;
    await new Promise((r) => setTimeout(r, 10));
    const nowMs5 = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs();
    Atomics.store(bigIntView, 3 * slotsPerAsset, BigInt(nowMs5) * 1000000n);
    client.setSequenceNum(5n, 3);
    client.setBestBidQuantity(2.0, 3);
    client.setBestAskQuantity(30.0, 3);
    client.setOBI(-0.85, 3);
    client.setCVD(-100.0, 3);
    const blockedShortSignal = engineAVAX.evaluateTick();
    console.log(`  AVAX Short Signal: ${blockedShortSignal.signalType}`);
    console.log(`  AVAX Short Reason Code: ${blockedShortSignal.riskResult?.reasonCode}`);
    assert(blockedShortSignal.signalType === "NONE", `4th Short entry MUST be blocked (signalType=NONE), got ${blockedShortSignal.signalType}`);
    assert(blockedShortSignal.riskResult?.reasonCode === "PORTFOLIO_CONCENTRATION_LIMIT", `Expected reasonCode "PORTFOLIO_CONCENTRATION_LIMIT", got "${blockedShortSignal.riskResult?.reasonCode}"`);
    console.log("  ✓ DEF-3101 Verified: 4th Short signal physically blocked at the engine entry gate!\n");
    // Deallocate 1 Short (BTC)
    client.setOmsShortPositionQty(0.0, 0);
    engineBTC.getHedgeLedger().clearSlots();
    engineBTC.syncSabPositionState(0);
    const relievedShortsCount = engineAVAX.getGlobalDirectionalPositionCount("SHORT");
    console.log(`  Relieved Global Short Count: ${relievedShortsCount}`);
    assert(relievedShortsCount === 2, `Expected 2 active Shorts after BTC release, got ${relievedShortsCount}`);
    await new Promise((r) => setTimeout(r, 10));
    const nowMs6 = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs();
    Atomics.store(bigIntView, 3 * slotsPerAsset, BigInt(nowMs6) * 1000000n);
    client.setSequenceNum(6n, 3);
    client.setBestBidQuantity(2.0, 3);
    client.setBestAskQuantity(35.0, 3);
    client.setOBI(-0.89, 3);
    client.setCVD(-150.0, 3);
    const approvedShortSignal = engineAVAX.evaluateTick();
    if (approvedShortSignal.executionPromise)
        await approvedShortSignal.executionPromise;
    console.log(`  AVAX Short Signal after capacity freed: ${approvedShortSignal.signalType}`);
    assert(approvedShortSignal.signalType === "SELL", `AVAX short entry must be approved when under limit (SELL), got ${approvedShortSignal.signalType}`);
    assert(approvedShortSignal.positionSide === "SHORT", `Expected positionSide SHORT, got ${approvedShortSignal.positionSide}`);
    console.log("  ✓ AVAX SELL order successfully approved once short concentration fell below limit of 3\n");
    engine_1.StrategyEngine.resetRegisteredEngines();
    console.log("================================================================================");
    console.log("  ✅ ALL 5 PORTFOLIO CONCENTRATION STAGES PASSED (100% SOTA DEF-3101 COMPLIANCE)");
    console.log("================================================================================\n");
}
runPortfolioDirectionalConcentrationTestSuite().catch((err) => {
    console.error("❌ Test Suite Failed:", err);
    process.exit(1);
});
