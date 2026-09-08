"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
const engine_1 = require("../strategy/engine");
const timeSynchronizer_1 = require("../utils/timeSynchronizer");
function assert(condition, message) {
    if (!condition) {
        console.error(`❌ [ASSERTION_FAILED] ${message}`);
        throw new Error(`ASSERTION_FAILED: ${message}`);
    }
}
async function runICKillSwitchHysteresisTestSuite() {
    console.log("================================================================================");
    console.log("  TEST: SOTA 3-STATE HYSTERESIS CUSUM-SPRT IC KILL SWITCH (DEF-R7)");
    console.log("================================================================================\n");
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
    const engine = new engine_1.StrategyEngine(client, riskGuard, execClient, {
        symbol: "BTCUSDT",
        orderQuantity: 0.001,
        cooldownMs: 0,
        minAiConfidence: 0.70,
        aggressiveConfidenceThreshold: 0.75,
    });
    const bigIntView = new BigInt64Array(sab);
    let nowMs = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs();
    Atomics.store(bigIntView, 0, BigInt(nowMs) * 1000000n);
    let simulatedNowMs = 1_000_000.0;
    // --------------------------------------------------------------------------
    // STAGE 1: Initial State Invariant (ALPHA_ACTIVE)
    // --------------------------------------------------------------------------
    console.log("[STAGE 1] Testing Initial State & Healthy IC (ALPHA_ACTIVE)...");
    assert(engine.getIcState() === "ALPHA_ACTIVE", `Initial state must be ALPHA_ACTIVE, got ${engine.getIcState()}`);
    // Healthy IC (+0.05) and no drift
    engine.updateICKillSwitchState(0.05, false, simulatedNowMs);
    assert(engine.getIcState() === "ALPHA_ACTIVE", "State must remain ALPHA_ACTIVE under healthy IC (+0.05)");
    console.log("  ✓ Initial state is ALPHA_ACTIVE; healthy IC (+0.05) maintains active alpha\n");
    // --------------------------------------------------------------------------
    // STAGE 2: Hysteresis Degradation (IC < 0.01 for >= 30s)
    // --------------------------------------------------------------------------
    console.log("[STAGE 2] Testing Degradation Hysteresis Timer (Requires 30s)...");
    // Step 2a: IC drops to +0.005 (< 0.01) at t = 1,000,000
    engine.updateICKillSwitchState(0.005, false, simulatedNowMs);
    assert(engine.getIcState() === "ALPHA_ACTIVE", "Must not immediately drop to DEGRADED without 30s persistence");
    // Step 2b: At t + 20s (elapsed 20,000ms < 30,000ms), still ALPHA_ACTIVE
    simulatedNowMs += 20_000;
    engine.updateICKillSwitchState(0.005, false, simulatedNowMs);
    assert(engine.getIcState() === "ALPHA_ACTIVE", "State must remain ALPHA_ACTIVE at t+20s (timer not expired)");
    // Step 2c: Momentary spike back to +0.02 resets timer
    simulatedNowMs += 5_000;
    engine.updateICKillSwitchState(0.02, false, simulatedNowMs);
    assert(engine.getIcState() === "ALPHA_ACTIVE", "State remains ALPHA_ACTIVE and timer resets on recovery");
    // Step 2d: IC drops to +0.002, must now wait full 30s from new drop
    simulatedNowMs += 1_000;
    engine.updateICKillSwitchState(0.002, false, simulatedNowMs); // drop start
    simulatedNowMs += 29_000; // 29s elapsed
    engine.updateICKillSwitchState(0.002, false, simulatedNowMs);
    assert(engine.getIcState() === "ALPHA_ACTIVE", "State must still be ALPHA_ACTIVE at 29s elapsed");
    simulatedNowMs += 1_500; // 30.5s elapsed >= 30s
    engine.updateICKillSwitchState(0.002, false, simulatedNowMs);
    assert(engine.getIcState() === "DEGRADED", `State must transition to DEGRADED after >= 30s, got ${engine.getIcState()}`);
    console.log("  ✓ Degradation timer verified: requires full 30s sustained low IC to enter DEGRADED\n");
    // --------------------------------------------------------------------------
    // STAGE 3: Immediate Trip to MODEL_BROKEN (CUSUM Drift or Catastrophic IC)
    // --------------------------------------------------------------------------
    console.log("[STAGE 3] Testing Immediate Collapse to MODEL_BROKEN (CUSUM Drift)...");
    // In DEGRADED state, CUSUM drift is detected in Rust SAB
    simulatedNowMs += 5_000;
    engine.updateICKillSwitchState(0.002, true, simulatedNowMs); // isDriftFlagged = true
    assert(engine.getIcState() === "MODEL_BROKEN", `CUSUM drift must immediately force MODEL_BROKEN, got ${engine.getIcState()}`);
    // Physical evaluateTick() proof: even under strong BUY conviction, MODEL_BROKEN must short-circuit and block
    client.setBestBidPrice(60000.0, 0);
    client.setBestBidQuantity(25.0, 0);
    client.setBestAskPrice(60000.5, 0);
    client.setBestAskQuantity(2.0, 0);
    client.setOBI(0.85, 0);
    client.setCVD(100.0, 0);
    client.setAIPredictionDirection(0.85, 0);
    client.setAIPredictionConfidence(0.90, 0);
    client.setHurstExponent(0.65, 0);
    client.setLOBEntropy(0.50, 0);
    client.setHawkesIntensity(1.0, 0);
    client.setGarmanKlassRV(0.002, 0);
    client.setIsModelDrifted(true, 0);
    const blockedTickSignal = engine.evaluateTick();
    assert(blockedTickSignal.signalType === "NONE", `Signal must be NONE in MODEL_BROKEN state, got ${blockedTickSignal.signalType}`);
    assert(blockedTickSignal.riskResult?.reasonCode === "IC_MODEL_BROKEN", `Reason must be IC_MODEL_BROKEN, got ${blockedTickSignal.riskResult?.reasonCode}`);
    assert(blockedTickSignal.executionPromise === undefined, "Execution promise must be undefined when kill switch trips");
    console.log("  ✓ Structural CUSUM drift immediately trips kill switch to MODEL_BROKEN & evaluateTick() strictly halts\n");
    // --------------------------------------------------------------------------
    // STAGE 4: Recovery from MODEL_BROKEN to DEGRADED (Requires 120s)
    // --------------------------------------------------------------------------
    console.log("[STAGE 4] Testing MODEL_BROKEN Recovery Hysteresis (Requires 120s without drift)...");
    // IC recovers to +0.015, but drift clears at t = simulatedNowMs
    simulatedNowMs += 1_000;
    engine.updateICKillSwitchState(0.015, false, simulatedNowMs);
    assert(engine.getIcState() === "MODEL_BROKEN", "Must not immediately exit MODEL_BROKEN");
    // At 60s elapsed: still MODEL_BROKEN
    simulatedNowMs += 60_000;
    engine.updateICKillSwitchState(0.015, false, simulatedNowMs);
    assert(engine.getIcState() === "MODEL_BROKEN", "Must remain MODEL_BROKEN at 60s (requires 120s)");
    // At 119s elapsed: still MODEL_BROKEN
    simulatedNowMs += 59_000;
    engine.updateICKillSwitchState(0.015, false, simulatedNowMs);
    assert(engine.getIcState() === "MODEL_BROKEN", "Must remain MODEL_BROKEN at 119s");
    // At 121s elapsed: transitions to DEGRADED
    simulatedNowMs += 2_000;
    engine.updateICKillSwitchState(0.015, false, simulatedNowMs);
    assert(engine.getIcState() === "DEGRADED", `Must transition to DEGRADED after >= 120s, got ${engine.getIcState()}`);
    console.log("  ✓ MODEL_BROKEN recovery verified: requires 120s sustained recovery\n");
    // --------------------------------------------------------------------------
    // STAGE 5: Recovery from DEGRADED to ALPHA_ACTIVE (Requires 60s)
    // --------------------------------------------------------------------------
    console.log("[STAGE 5] Testing DEGRADED Recovery to ALPHA_ACTIVE (Requires 60s at IC >= 0.03)...");
    // IC jumps to +0.04 (>= 0.03)
    simulatedNowMs += 1_000;
    engine.updateICKillSwitchState(0.04, false, simulatedNowMs);
    assert(engine.getIcState() === "DEGRADED", "Must not immediately jump to ALPHA_ACTIVE");
    // At 45s: still DEGRADED
    simulatedNowMs += 45_000;
    engine.updateICKillSwitchState(0.04, false, simulatedNowMs);
    assert(engine.getIcState() === "DEGRADED", "Must remain DEGRADED at 45s");
    // At 61s: transitions to ALPHA_ACTIVE
    simulatedNowMs += 16_000;
    engine.updateICKillSwitchState(0.04, false, simulatedNowMs);
    assert(engine.getIcState() === "ALPHA_ACTIVE", `Must recover to ALPHA_ACTIVE after 60s, got ${engine.getIcState()}`);
    console.log("  ✓ Full recovery verified: restored to ALPHA_ACTIVE after 60s sustained high IC\n");
    // --------------------------------------------------------------------------
    // STAGE 6: Catastrophic Collapse directly from ALPHA_ACTIVE (IC <= -0.02)
    // --------------------------------------------------------------------------
    console.log("[STAGE 6] Testing Direct Collapse from ALPHA_ACTIVE on Negative IC (<= -0.02)...");
    simulatedNowMs += 10_000;
    engine.updateICKillSwitchState(-0.11, false, simulatedNowMs); // Autopsy condition: IC = -0.11
    assert(engine.getIcState() === "MODEL_BROKEN", `IC = -0.11 must immediately force MODEL_BROKEN, got ${engine.getIcState()}`);
    // Physical evaluateTick() proof: catastrophic IC immediately halts engine
    nowMs = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs();
    Atomics.store(bigIntView, 0, BigInt(nowMs) * 1000000n);
    client.setSequenceNum(2n, 0);
    client.setRollingIC(-0.11, 0);
    client.setIsModelDrifted(false, 0);
    const catastrophicSignal = engine.evaluateTick();
    assert(catastrophicSignal.signalType === "NONE", `Signal must be NONE after catastrophic IC collapse, got ${catastrophicSignal.signalType}`);
    assert(catastrophicSignal.riskResult?.reasonCode === "IC_MODEL_BROKEN", `Reason must be IC_MODEL_BROKEN, got ${catastrophicSignal.riskResult?.reasonCode}`);
    assert(catastrophicSignal.executionPromise === undefined, "Execution promise must be undefined when collapsed");
    console.log("  ✓ Autopsy condition (IC = -0.11) instantly triggers MODEL_BROKEN & physically halts evaluateTick()\n");
    console.log("================================================================================");
    console.log("  ✅ ALL 6 TEST STAGES PASSED (100% SOTA DEF-R7 SPECIFICATION COMPLIANCE)");
    console.log("================================================================================\n");
}
runICKillSwitchHysteresisTestSuite().catch((err) => {
    console.error(`\n❌ TEST SUITE FAILED: ${err?.stack || err?.message || String(err)}\n`);
    process.exit(1);
});
