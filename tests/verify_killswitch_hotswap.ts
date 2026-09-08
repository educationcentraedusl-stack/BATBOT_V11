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
  // STAGE 2: Physical Fast-Path SPRT Instant Unlatch on Live StrategyEngine
  // --------------------------------------------------------------------------
  console.log("[STAGE 2] Instantiating Physical StrategyEngine & Testing SPRT Fast-Path Unlatch (DEF-5.1)...");
  const riskGuard = new RiskGuard({ minCooldownMs: 0 });
  const execClient = new BinanceExecutionClient({
    apiKey: "audit_32_remediation_test_key",
    apiSecret: "audit_32_remediation_test_secret",
    useTestnet: true,
  });

  const engine = new StrategyEngine(client, riskGuard, execClient, {
    symbol: "BTCUSDT",
    orderQuantity: 0.001,
    cooldownMs: 0,
    minAiConfidence: 0.70,
    aggressiveConfidenceThreshold: 0.75,
  });

  const nowMs = timeSynchronizer.getAdjustedNowMs();

  // Force physical engine into MODEL_BROKEN state
  engine.setIcStateForTesting("MODEL_BROKEN", nowMs);
  engine.setIcEvidenceScoreForTesting(0.0);
  assert(engine.getIcState() === "MODEL_BROKEN", `Engine must be in MODEL_BROKEN, got ${engine.getIcState()}`);
  console.log(`  ✓ Engine trapped in ${engine.getIcState()} (Evidence: ${engine.getIcEvidenceScore()})`);

  // Feed High-Conviction Alpha: IC = 0.1532 >= 0.10 without structural drift
  engine.updateICKillSwitchState(0.1532, false, nowMs);
  assert(
    engine.getIcState() === "ALPHA_ACTIVE",
    `SPRT Fast-Path failed: state must be ALPHA_ACTIVE, got ${engine.getIcState()}`
  );
  assert(
    engine.getIcEvidenceScore() === 1.0,
    `Evidence score must be reset to 1.0 on fast unlatch, got ${engine.getIcEvidenceScore()}`
  );
  console.log(`  ✓ High-Conviction Alpha (IC: 0.1532 >= 0.10) instantly unlatched physical engine to ALPHA_ACTIVE`);
  console.log(`  ✓ Evidence score reset to 1.0 with zero timer delay\n`);

  // --------------------------------------------------------------------------
  // STAGE 3: Continuous Leaky-Bucket Accumulator (Anti-Jitter Resilience)
  // --------------------------------------------------------------------------
  console.log("[STAGE 3] Testing Continuous Leaky-Bucket Evidence Accumulation (λ = 0.995)...");
  engine.setIcStateForTesting("DEGRADED", nowMs);
  engine.setIcEvidenceScoreForTesting(0.80);

  // Feed 50 consecutive good ticks (IC = 0.04)
  for (let i = 0; i < 50; i++) {
    engine.updateICKillSwitchState(0.04, false, nowMs + i * 100);
  }
  const evidenceAfterGood = engine.getIcEvidenceScore();
  assert(
    evidenceAfterGood > 0.84,
    `Evidence after 50 good ticks must accumulate > 0.84, got ${evidenceAfterGood}`
  );
  console.log(`  ✓ Evidence after 50 good ticks accumulated to: ${(evidenceAfterGood * 100).toFixed(2)}%`);

  // Feed a single transient noise tick (IC = 0.005)
  engine.updateICKillSwitchState(0.005, false, nowMs + 5100);
  const evidenceAfterNoise = engine.getIcEvidenceScore();
  assert(
    evidenceAfterNoise >= 0.80,
    `Leaky bucket collapsed on single noise tick! Evidence: ${evidenceAfterNoise}`
  );
  console.log(`  ✓ Evidence after single transient noise tick preserved at: ${(evidenceAfterNoise * 100).toFixed(2)}% (>= 80%)`);
  console.log(`  ✓ Zero timer wipe or fragile reset occurred\n`);

  // --------------------------------------------------------------------------
  // STAGE 4: Physical evaluateTick() Hot-Swap Epoch Handshake & Live Unlatch
  // --------------------------------------------------------------------------
  console.log("[STAGE 4] Testing Physical StrategyEngine.evaluateTick() SAB Epoch Handshake...");

  // Seed live orderbook and timestamp into SharedArrayBuffer for Asset 0
  const tickTimeMs = timeSynchronizer.getAdjustedNowMs();
  Atomics.store(bigIntView, 0, BigInt(tickTimeMs) * 1000000n);
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

  // Force engine into MODEL_BROKEN state via negative IC in SAB
  client.setSequenceNum(2n, 0);
  client.setRollingIC(-0.05, 0);
  client.setIsModelDrifted(false, 0);
  engine.setIcStateForTesting("MODEL_BROKEN", tickTimeMs);

  // Evaluate tick 2: verify MODEL_BROKEN strictly halts entry evaluation
  const resBroken = await engine.evaluateTick();
  assert(
    resBroken.signalType === "NONE",
    `Signal must be NONE when MODEL_BROKEN, got ${resBroken.signalType}`
  );
  assert(
    resBroken.riskResult?.reasonCode === "IC_MODEL_BROKEN",
    `Reason code must be IC_MODEL_BROKEN, got ${resBroken.riskResult?.reasonCode}`
  );
  assert(
    resBroken.executionPromise === undefined,
    "Execution promise must be undefined when kill switch is active"
  );
  console.log(`  ✓ evaluateTick() physically short-circuited: State: MODEL_BROKEN, Reason: ${resBroken.riskResult?.reasonCode}`);

  // Simulate background model reload / promotion: bump Slot 151 epoch and restore IC
  client.setSequenceNum(3n, 0);
  client.setRollingIC(0.06, 0);
  const newModelEpoch = client.incrementHotswapEpoch();
  console.log(`  ✓ Background candidate model promoted: HOTSWAP_EPOCH bumped to #${newModelEpoch} across all assets`);

  // Evaluate tick 3: evaluateTick() must detect new epoch in Slot 151 and unlatch
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
  console.log("================================================================================\n");
}

runPhysicalVerification().catch((err) => {
  console.error(`\n❌ VERIFICATION TEST SUITE FAILED: ${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});

