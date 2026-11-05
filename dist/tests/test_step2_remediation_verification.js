"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const risk_1 = require("../strategy/risk");
const marketDataClient_1 = require("../marketDataClient");
const engine_1 = require("../strategy/engine");
const binance_1 = require("../execution/binance");
function assert(condition, message) {
    if (!condition) {
        throw new Error(`[ASSERTION_FAILED] ${message}`);
    }
}
async function runStep2RemediationTests() {
    console.log("================================================================================");
    console.log("   STEP 2 REMEDIATION COMPREHENSIVE VERIFICATION SUITE");
    console.log("   1. Cross-Asset Drift Isolation & SAB Slot 102 Integrity");
    console.log("   2. IC Kill Switch Strict Drift Latching & Cold-Start Loophole Eradication");
    console.log("   3. Global Portfolio Consecutive Loss Circuit Breaker");
    console.log("================================================================================\n");
    const maxAssets = 10;
    const slotsPerAsset = 256;
    const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    // -----------------------------------------------------------------------------------------
    // TEST 1: Global Portfolio Breaker Across Multiple Assets
    // -----------------------------------------------------------------------------------------
    console.log("[TEST 1] Testing Global Portfolio Breaker (Cross-Asset Loss Aggregation)...");
    risk_1.RiskGuard.resetGlobalConsecutiveLosses();
    assert(risk_1.RiskGuard.getGlobalConsecutiveLosses() === 0, "Initial global consecutive losses must be 0");
    assert(!risk_1.RiskGuard.isGlobalCircuitBreakerActive(), "Global circuit breaker must initially be inactive");
    const riskGuard = new risk_1.MultiAssetRiskGuard();
    // Loss 1 on BTCUSDT
    riskGuard.recordTradeOutcome("BTCUSDT", -10.0, -2.0);
    assert(risk_1.RiskGuard.getGlobalConsecutiveLosses() === 1, "Global losses should be 1 after BTC loss");
    assert(riskGuard.getConsecutiveLosses("BTCUSDT") === 1, "BTC losses should be 1");
    // Loss 2 on ETHUSDT
    riskGuard.recordTradeOutcome("ETHUSDT", -8.0, -1.5);
    assert(risk_1.RiskGuard.getGlobalConsecutiveLosses() === 2, "Global losses should be 2 after ETH loss");
    assert(riskGuard.getConsecutiveLosses("ETHUSDT") === 1, "ETH losses should be 1 (isolated)");
    // Loss 3 on SOLUSDT
    riskGuard.recordTradeOutcome("SOLUSDT", -12.0, -2.5);
    assert(risk_1.RiskGuard.getGlobalConsecutiveLosses() === 3, "Global losses should be 3 after SOL loss");
    // Loss 4 on DOGEUSDT
    riskGuard.recordTradeOutcome("DOGEUSDT", -5.0, -1.0);
    assert(risk_1.RiskGuard.getGlobalConsecutiveLosses() === 4, "Global losses should be 4 after DOGE loss");
    assert(!risk_1.RiskGuard.isGlobalCircuitBreakerActive(), "Global circuit breaker should NOT trip at 4 losses");
    // Loss 5 on AVAXUSDT -> TRIPS GLOBAL BREAKER
    riskGuard.recordTradeOutcome("AVAXUSDT", -15.0, -3.0);
    assert(risk_1.RiskGuard.getGlobalConsecutiveLosses() === 5, "Global losses should be 5 after AVAX loss");
    assert(risk_1.RiskGuard.isGlobalCircuitBreakerActive(), "Global circuit breaker MUST be active at >= 5 losses");
    // Verify new entry on a completely fresh asset (e.g. LINKUSDT) is BLOCKED
    const linkEntry = {
        symbol: "LINKUSDT",
        side: "BUY",
        quantity: 10,
        price: 15.0,
        stopLossPrice: 14.5,
        takeProfitPrice: 16.0,
    };
    const linkCheck = riskGuard.validateOrder(linkEntry, true, "FLAT");
    assert(!linkCheck.passed, "New entry on LINKUSDT must be rejected under global circuit breaker");
    assert(linkCheck.reasonCode === "CIRCUIT_BREAKER_ACTIVE", `Expected CIRCUIT_BREAKER_ACTIVE, got ${linkCheck.reasonCode}`);
    console.log("  ✓ Cross-asset 5 consecutive losses successfully tripped global portfolio breaker");
    console.log(`  ✓ Rejection verified: ${linkCheck.message}`);
    // Emergency Hard-Stop on BTCUSDT MUST bypass global breaker
    const btcHardStop = {
        symbol: "BTCUSDT",
        side: "SELL",
        quantity: 0.1,
        price: 60000.0,
        isHardStop: true,
    };
    const btcHsCheck = riskGuard.validateOrder(btcHardStop, true, "LONG");
    assert(btcHsCheck.passed, "Emergency hard stop MUST bypass global circuit breaker");
    console.log("  ✓ Emergency hard stop successfully bypassed global circuit breaker");
    // Winning trade on ANY asset (e.g. BTCUSDT) MUST reset global breaker
    riskGuard.recordTradeOutcome("BTCUSDT", 25.0, 3.5);
    assert(risk_1.RiskGuard.getGlobalConsecutiveLosses() === 0, "Winning trade must reset global losses to 0");
    assert(!risk_1.RiskGuard.isGlobalCircuitBreakerActive(), "Global circuit breaker must be inactive after winning trade");
    const linkCheckAfterWin = riskGuard.validateOrder(linkEntry, true, "FLAT");
    assert(linkCheckAfterWin.passed, "New entry should pass after winning trade reset");
    console.log("  ✓ Winning trade on BTC successfully reset global consecutive losses to 0 and restored trading\n");
    // -----------------------------------------------------------------------------------------
    // TEST 2: IC Kill Switch Cold-Start Loophole & Strict Drift Latching in engine.ts
    // -----------------------------------------------------------------------------------------
    console.log("[TEST 2] Testing IC Kill Switch in StrategyEngine (engine.ts)...");
    const execClient = new binance_1.BinanceExecutionClient({
        apiKey: "test_key",
        apiSecret: "test_secret",
        useTestnet: true,
    });
    const engine = new engine_1.StrategyEngine(client, new risk_1.RiskGuard({ minCooldownMs: 0 }), execClient, {
        symbol: "BTCUSDT",
        orderQuantity: 0.001,
    });
    // Set 0 samples in SAB
    client.setIcSampleCount(0, 0);
    assert(client.getIcSampleCount(0) === 0, "IC sample count should be 0");
    // 2A: Manually trigger DEGRADED state
    // Even with 0 samples, updateICKillSwitchState should NOT auto-unlatch from DEGRADED to ALPHA_ACTIVE
    const now = Date.now();
    // Force state to DEGRADED
    engine.icState = "DEGRADED";
    assert(engine.getIcState() === "DEGRADED", "Engine state should be DEGRADED");
    // Call updateICKillSwitchState with safeIC=0.00 and no drift, sampleCount=0
    engine.updateICKillSwitchState(0.00, false, now);
    assert(engine.getIcState() === "DEGRADED", "DEGRADED state must NOT auto-unlatch to ALPHA_ACTIVE on cold start (0 samples)!");
    console.log("  ✓ Cold-start loophole eradicated: DEGRADED state remains locked with 0 samples");
    // 2B: Strict Drift Latching when SAB Slot 102 reads 1.0 (Drifted)
    // Flag drift on asset 0 in SAB
    client.setIsModelDrifted(true, 0);
    assert(client.getIsModelDrifted(0) === true, "SAB Slot 102 must read true");
    // Even if engine was in ALPHA_ACTIVE or DEGRADED, and sample count is 0:
    engine.icState = "ALPHA_ACTIVE";
    engine.updateICKillSwitchState(0.02, true, now);
    assert(engine.getIcState() === "MODEL_BROKEN", "SAB Slot 102 Drift flag must strictly latch engine to MODEL_BROKEN!");
    console.log("  ✓ Strict drift latching verified: SAB Slot 102=1.0 latched engine to MODEL_BROKEN");
    // Populate valid tick prices in SAB for asset 0
    client.setBestBidPrice(60000.0, 0);
    client.setBestAskPrice(60001.0, 0);
    const bigIntView = new BigInt64Array(sab);
    Atomics.store(bigIntView, 0, BigInt(now) * 1000000n);
    // Verify evaluateTick short-circuits and triggers IC_KILL_SWITCH_BLOCKED
    const tickResult = engine.evaluateTick();
    assert(tickResult.signalType === "NONE", "Signal must be NONE when MODEL_BROKEN");
    assert(!tickResult.riskResult?.passed, "Risk result must be passed=false");
    assert(tickResult.riskResult?.reasonCode === "IC_MODEL_BROKEN", `Expected IC_MODEL_BROKEN, got ${tickResult.riskResult?.reasonCode}`);
    console.log("  ✓ evaluateTick short-circuited and blocked entry with IC_MODEL_BROKEN\n");
    // -----------------------------------------------------------------------------------------
    // TEST 3: Cross-Asset Drift Isolation in SAB
    // -----------------------------------------------------------------------------------------
    console.log("[TEST 3] Testing Multi-Asset Drift Isolation in SAB...");
    // Asset 0: Clear drift
    client.setIsModelDrifted(false, 0);
    // Asset 1 (ETHUSDT): Set drift
    client.setIsModelDrifted(true, 1);
    // Asset 2 (SOLUSDT): Clear drift
    client.setIsModelDrifted(false, 2);
    assert(client.getIsModelDrifted(0) === false, "Asset 0 drift must be false");
    assert(client.getIsModelDrifted(1) === true, "Asset 1 drift must be true");
    assert(client.getIsModelDrifted(2) === false, "Asset 2 drift must be false");
    console.log("  ✓ SAB Slot 102 verified orthogonal across all asset slots");
    console.log("\n================================================================================");
    console.log("  ALL STEP 2 REMEDIATION TESTS PASSED 100%!");
    console.log("================================================================================");
}
runStep2RemediationTests().catch((err) => {
    console.error("\n[FATAL FAILURE IN STEP 2 TESTS]:", err);
    process.exit(1);
});
