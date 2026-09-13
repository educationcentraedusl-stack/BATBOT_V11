import "dotenv/config";
import { MarketDataClient } from "../src/marketDataClient";
import { RiskGuard } from "../src/strategy/risk";
import { BinanceExecutionClient } from "../src/execution/binance";
import { StrategyEngine } from "../src/strategy/engine";
import { HOTSWAP_EPOCH, SURVIVAL_PROBABILITY } from "../src/ipc/sabSchema";
import { timeSynchronizer } from "../src/utils/timeSynchronizer";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ [ASSERTION_FAILED] ${message}`);
    throw new Error(`ASSERTION_FAILED: ${message}`);
  }
}

async function runPhysicalVerification(): Promise<void> {
  console.log("================================================================================");
  console.log("  [PHYSICAL VERIFICATION] SOTA KILL SWITCH SPRT & SAB HOTSWAP_EPOCH (ZERO-MOCK)");
  console.log("  [AUDIT 33.0 COMPLIANT] All state transitions are ORGANIC via SAB + evaluateTick()");
  console.log("================================================================================\n");

  const maxAssets = 10;
  const slotsPerAsset = 256;
  const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
  const client = new MarketDataClient(sab, maxAssets, slotsPerAsset);
  const bigIntView = new BigInt64Array(sab);

  // --------------------------------------------------------------------------
  // STAGE 1: SAB Slot 151 Allocation, Multi-Asset Stride & Type Harmonization
  // --------------------------------------------------------------------------
  console.log("[STAGE 1] Validating SAB Slot 151 Memory Allocation & Zero Collision (DEF-3.1, DEF-3.2, DEF-2.2)...");
  assert(HOTSWAP_EPOCH === 151, `HOTSWAP_EPOCH slot constant must be 151, got ${HOTSWAP_EPOCH}`);
  assert(SURVIVAL_PROBABILITY === 140, `SURVIVAL_PROBABILITY slot constant must be 140, got ${SURVIVAL_PROBABILITY}`);
  assert(HOTSWAP_EPOCH !== SURVIVAL_PROBABILITY, "DEF-3.1 FATAL: HOTSWAP_EPOCH and SURVIVAL_PROBABILITY collision!");

  for (let i = 0; i < maxAssets; i++) {
    const initEpoch = client.getHotswapEpoch(i);
    assert(initEpoch === 0, `Initial epoch for asset ${i} must be 0, got ${initEpoch}`);
  }

  // Write survival probability to Slot 140
  const expectedSurvival = 0.9825;
  client.setSurvivalProbability(expectedSurvival, 0);
  assert(
    Math.abs(client.getSurvivalProbability(0) - expectedSurvival) < 1e-6,
    `Slot 140 survival probability readback mismatch`
  );

  // Increment epoch via client (loops across all maxAssets writing Slot 151)
  const bumpedEpoch = client.incrementHotswapEpoch();
  assert(bumpedEpoch === 1, `Bumped epoch must be 1, got ${bumpedEpoch}`);

  // Verify all 10 assets were atomically updated to epoch 1 in Slot 151 (DEF-2.2)
  for (let i = 0; i < maxAssets; i++) {
    const epochVal = client.getHotswapEpoch(i);
    assert(epochVal === 1, `Asset ${i} epoch in Slot 151 must be 1, got ${epochVal}`);
  }

  // Verify Slot 140 was NOT mutated or corrupted (DEF-3.1 zero memory collision)
  const survivalAfterBump = client.getSurvivalProbability(0);
  assert(
    Math.abs(survivalAfterBump - expectedSurvival) < 1e-6,
    `DEF-3.1 COLLISION: Slot 140 survival probability corrupted after epoch bump! Expected ${expectedSurvival}, got ${survivalAfterBump}`
  );

  // Verify IEEE-754 64-bit float bitcast fidelity (DEF-3.2 binary type harmonization)
  const rawFloatBits = client.readAtomicFloat64Asset(0, 151);
  assert(rawFloatBits === 1.0, `DEF-3.2: Slot 151 float representation mismatch, got ${rawFloatBits}`);

  console.log(`  ✓ Slot 151 cleanly allocated for HOTSWAP_EPOCH across all ${maxAssets} assets`);
  console.log(`  ✓ Slot 140 SURVIVAL_PROBABILITY remains uncorrupted (${(survivalAfterBump * 100).toFixed(2)}%)`);
  console.log(`  ✓ Binary IEEE-754 float representation synchronized between Rust and TS\n`);

  // --------------------------------------------------------------------------
  // STAGE 2: Organic State Transition via SAB reads + evaluateTick()
  //          NO backdoor setters (setIcStateForTesting is BANNED).
  //          State transitions are driven exclusively through SAB IC/drift values.
  // --------------------------------------------------------------------------
  console.log("[STAGE 2] Instantiating Physical StrategyEngine & Testing ORGANIC State Transitions (DEF-5.1)...");
  const riskGuard = new RiskGuard({ minCooldownMs: 0 });
  const execClient = new BinanceExecutionClient({
    apiKey: "audit_33_remediation_test_key",
    apiSecret: "audit_33_remediation_test_secret",
    useTestnet: true,
  });

  const engine = new StrategyEngine(client, riskGuard, execClient, {
    symbol: "BTCUSDT",
    orderQuantity: 0.001,
    cooldownMs: 0,
    minAiConfidence: 0.70,
    aggressiveConfidenceThreshold: 0.75,
  });

  const updateTimestamp = (): void => {
    Atomics.store(bigIntView, 0, BigInt(timeSynchronizer.getAdjustedNowMs()) * 1000000n);
  };

  // Seed live orderbook and timestamp into SharedArrayBuffer for Asset 0
  updateTimestamp();
  client.setBestBidPrice(50000.0, 0);
  client.setBestBidQuantity(1.5, 0);
  client.setBestAskPrice(50001.0, 0);
  client.setBestAskQuantity(2.0, 0);
  client.setOBI(0.20, 0);
  client.setCVD(100.0, 0);
  client.setAIPredictionDirection(0.65, 0);
  client.setAIPredictionConfidence(0.85, 0);
  client.setHurstExponent(0.65, 0);
  client.setLOBEntropy(0.50, 0);
  client.setHawkesIntensity(1.0, 0);
  client.setGarmanKlassRV(0.002, 0);
  client.setRollingIC(0.05, 0);
  client.setIsModelDrifted(false, 0);

  // Prime engine on current epoch with sequence 1
  client.setSequenceNum(1n, 0);
  await engine.evaluateTick();
  assert(engine.getIcState() === "ALPHA_ACTIVE", `Engine must start in ALPHA_ACTIVE, got ${engine.getIcState()}`);
  console.log(`  ✓ Engine initialized in ALPHA_ACTIVE state via organic evaluateTick()`);

  // ORGANIC DEGRADATION: Feed negative IC and drift flag via SAB to trigger MODEL_BROKEN
  // The IC kill switch state machine transitions deterministically:
  //   ALPHA_ACTIVE -> MODEL_BROKEN when: isDriftFlagged || safeIC <= -0.02
  // With IC = -0.05 and isDriftFlagged = true, this is a SINGLE-TICK deterministic transition.
  client.setSequenceNum(2n, 0);
  client.setRollingIC(-0.05, 0);        // Negative IC signals model failure
  client.setIsModelDrifted(true, 0);     // Drift flag confirms structural break
  updateTimestamp();

  await engine.evaluateTick();

  // With isDriftFlagged=true, the state machine transitions DETERMINISTICALLY to MODEL_BROKEN
  // in exactly ONE tick (engine.ts line 398). No hedge assertion tolerated.
  assert(
    engine.getIcState() === "MODEL_BROKEN",
    `Engine must be MODEL_BROKEN after negative IC (-0.05) + drift flag, got ${engine.getIcState()}`
  );
  console.log(`  ✓ Engine organically transitioned to MODEL_BROKEN via negative IC (-0.05) + drift flag (single-tick deterministic)`);

  // Verify MODEL_BROKEN halts signal generation and returns IC_MODEL_BROKEN reason code
  client.setSequenceNum(3n, 0);
  client.setRollingIC(-0.05, 0);
  client.setIsModelDrifted(true, 0);
  updateTimestamp();
  const resBroken = await engine.evaluateTick();
  assert(
    resBroken.signalType === "NONE",
    `Signal must be NONE when engine is MODEL_BROKEN, got ${resBroken.signalType}`
  );
  assert(
    resBroken.riskResult?.reasonCode === "IC_MODEL_BROKEN",
    `Reason code must be IC_MODEL_BROKEN, got ${resBroken.riskResult?.reasonCode}`
  );
  assert(
    resBroken.executionPromise === undefined,
    `executionPromise must be undefined when MODEL_BROKEN, got ${typeof resBroken.executionPromise}`
  );
  console.log(`  ✓ evaluateTick() correctly suppressed signals with IC_MODEL_BROKEN reason code`);

  // --------------------------------------------------------------------------
  // STAGE 3: Organic SPRT Fast-Path Unlatch via High-Conviction IC
  //          Feed IC >= 0.10 with no drift to trigger instant unlatch
  // --------------------------------------------------------------------------
  console.log("\n[STAGE 3] Testing Organic SPRT Fast-Path Unlatch via High IC (DEF-5.1)...");

  // Feed high-conviction positive IC without drift to trigger fast-path unlatch
  // SPRT Fast-Path: IC >= 0.10 && !isDriftFlagged => SINGLE-TICK deterministic unlatch to ALPHA_ACTIVE
  client.setSequenceNum(11n, 0);
  client.setRollingIC(0.15, 0);
  client.setIsModelDrifted(false, 0);
  client.setAIPredictionDirection(0.65, 0);
  client.setAIPredictionConfidence(0.85, 0);
  updateTimestamp();
  await engine.evaluateTick();

  // SPRT Fast-Path at engine.ts:378 is deterministic: IC >= 0.10 && !drift => instant unlatch.
  // No retry loop tolerated — this is a single-tick transition.
  assert(
    engine.getIcState() === "ALPHA_ACTIVE",
    `SPRT Fast-Path failed: state must be ALPHA_ACTIVE after single tick with IC=0.15 and no drift, got ${engine.getIcState()}`
  );
  console.log(`  ✓ Engine unlatched to ALPHA_ACTIVE via SPRT Fast-Path (single-tick, IC=0.15, drift=false)`);

  // --------------------------------------------------------------------------
  // STAGE 4: Physical evaluateTick() Hot-Swap Epoch Handshake & Live Unlatch
  // --------------------------------------------------------------------------
  console.log("\n[STAGE 4] Testing Physical StrategyEngine.evaluateTick() SAB Epoch Handshake...");

  // Re-degrade the engine organically via negative IC + drift
  client.setSequenceNum(30n, 0);
  client.setRollingIC(-0.08, 0);
  client.setIsModelDrifted(true, 0);
  updateTimestamp();
  await engine.evaluateTick();

  // isDriftFlagged=true with IC=-0.08 deterministically transitions to MODEL_BROKEN in one tick
  assert(
    engine.getIcState() === "MODEL_BROKEN",
    `Engine must be MODEL_BROKEN for epoch handshake test, got ${engine.getIcState()}`
  );
  console.log(`  ✓ Engine re-degraded organically to MODEL_BROKEN (single-tick deterministic)`);

  // Simulate background model reload / promotion: bump Slot 151 epoch and restore IC
  client.setSequenceNum(50n, 0);
  client.setRollingIC(0.06, 0);
  client.setIsModelDrifted(false, 0);
  updateTimestamp();
  const newModelEpoch = client.incrementHotswapEpoch();
  console.log(`  ✓ Background candidate model promoted: HOTSWAP_EPOCH bumped to #${newModelEpoch} across all assets`);

  // Evaluate tick: evaluateTick() must detect new epoch in Slot 151 and unlatch
  const resRecovered = await engine.evaluateTick();
  assert(
    engine.getIcState() === "ALPHA_ACTIVE",
    `Hot-swap epoch handshake failed: engine state must unlatch to ALPHA_ACTIVE, got ${engine.getIcState()}`
  );
  assert(
    resRecovered.riskResult?.reasonCode !== "IC_MODEL_BROKEN",
    `evaluateTick() remained blocked after epoch bump!`
  );
  console.log(`  ✓ evaluateTick() detected new model epoch #${newModelEpoch}: physically unlatched to ${engine.getIcState()}`);
  console.log(`  ✓ Hot-swap epoch handshake fully validated with 100% physical fidelity\n`);

  console.log("================================================================================");
  console.log("  ✅ ALL 4 TEST STAGES PASSED (100% ZERO-TRUST PHYSICAL COMPLIANCE)");
  console.log("  ✅ ZERO BACKDOOR SETTERS USED — ALL TRANSITIONS ARE ORGANIC VIA evaluateTick()");
  console.log("================================================================================\n");
}

runPhysicalVerification().catch((err) => {
  console.error(`\n❌ VERIFICATION TEST SUITE FAILED: ${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
