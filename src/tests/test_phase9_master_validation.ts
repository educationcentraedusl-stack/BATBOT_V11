/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * SOTA EXIT ARCHITECTURE: VEGAM MASTER INTEGRATION SUITE (PHASE 9)
 *
 * Comprehensive Master Simulation and End-to-End Stress Test Suite
 * validating the full 4-layer VEGAM state machine under live conditions:
 *
 * Stage 1: Cold start latency & SAB Telemetry warm-up (Slots 138-141, 156-158).
 * Stage 2: HJB optimal stopping preempted by hard Stop-Loss (flash crash test).
 * Stage 3: Adversarial Exit Gate activation (multi-signal consensus on toxic flow).
 * Stage 4: Trailing Stop-Loss activation (< 0.50% ROE) and subsequent OBI tightening.
 * Stage 5: CAD-DTLM time-decay acceleration under prolonged exposure & lifespan kill.
 * Stage 6: End-to-end multi-layer evaluation latency (< 3.0 µs SLA) & Zero-GC benchmark.
 */

import { HedgePositionLedger, PositionSlot } from "../strategy/positionLedger";
import { MicrostructureHazardEngine, MicrostructureMetrics } from "../strategy/microstructureHazardEngine";
import { VolatilitySurfaceEngine, VolatilitySurfaceMetrics } from "../strategy/volatilitySurfaceEngine";
import { HJBReservationEngine } from "../strategy/hjbReservationEngine";
import { MarketDataClient } from "../marketDataClient";
import {
  VegamTpLadderEngine,
  DEFAULT_VEGAM_CONFIG,
  computeObiWeightedTrailDistance,
} from "../strategy/vegamTpLadderEngine";
import { AdversarialExitGate } from "../strategy/adversarialExitGate";

console.log("================================================================================");
console.log("   BATBOT_V11 SOTA MASTER INTEGRATION SUITE: VEGAM PHASE 9");
console.log("   FULL-LIFECYCLE STRESS VALIDATION, FLASH CRASH DEFENSE & ZERO-GC SLA");
console.log("================================================================================");

let totalPassed = 0;
let totalFailed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`[PASS] ${message}`);
    totalPassed++;
  } else {
    console.error(`\x1b[31m[FAIL] ${message}\x1b[0m`);
    totalFailed++;
  }
}

async function runMasterIntegrationSuite() {
  const symbol = "BTCUSDT";

  // =========================================================================================
  // STAGE 1: Cold Start Latency & SAB Telemetry Warm-Up
  // =========================================================================================
  console.log("\n--- STAGE 1: Cold Start Latency & SAB Telemetry Warm-Up ---");

  const coldStartStart = process.hrtime.bigint();

  // Instantiate physical SharedArrayBuffer memory (10 assets, 256 Float64 slots each)
  const masterSab = new SharedArrayBuffer(10 * 256 * 8);
  const masterClient = new MarketDataClient(masterSab, 10, 256);

  const hazardEngine = new MicrostructureHazardEngine(symbol, 50, 100, 1.0, 20, 0.75);
  const volEngine = new VolatilitySurfaceEngine(symbol, 600);
  const hjbEngine = new HJBReservationEngine(symbol, 4.20, 120.0, 1.5);
  const ledger = new HedgePositionLedger(symbol, 3, masterClient, 0);
  ledger.setLeverage(2.0);

  const coldStartEnd = process.hrtime.bigint();
  const coldStartDurationUs = Number(coldStartEnd - coldStartStart) / 1000.0;
  console.log(`[COLD_START] Module initialization latency: ${coldStartDurationUs.toFixed(2)} µs`);
  assert(coldStartDurationUs < 50000.0, `Cold start initialization completed under 50ms: got ${coldStartDurationUs.toFixed(2)} µs`);

  // Seed baseline volatility bars (Garman-Klass composite baseline ~90.6 bps)
  const baselineAtr = 0.00906;
  const barVar = baselineAtr * baselineAtr;
  for (let i = 0; i < 50; i++) {
    volEngine.pushBar(60000.0, 60000.0 + 60000.0 * baselineAtr, 60000.0 - 60000.0 * baselineAtr, 60000.0);
  }

  // Seed baseline order book depth
  hazardEngine.updateOrderBook(60000.0, 5.0, 60000.5, 5.0);

  // Ingest & verify SAB high-frequency telemetry slots
  const testOFI = 0.4285;
  const testHJB = 59820.50;
  const testSurvival = 0.8920;
  const testDynamicSL = 59450.00;
  const testGkAtr = 0.00906;
  const testKRegime = 1.20;
  const testCadmeState = 1.0;

  masterClient.setOFI(testOFI, 0);
  masterClient.setHJBReservationPrice(testHJB, 0);
  masterClient.setSurvivalProbability(testSurvival, 0);
  masterClient.setDynamicStopLossPrice(testDynamicSL, 0);
  masterClient.setVegamGkAtrComposite(testGkAtr, 0);
  masterClient.setVegamTrailKRegime(testKRegime, 0);
  masterClient.setVegamCadmeState(testCadmeState, 0);

  assert(Math.abs(masterClient.getOFI(0) - testOFI) < 1e-4, `SAB Slot 138 (OFI) verified: got ${masterClient.getOFI(0)}`);
  assert(Math.abs(masterClient.getHJBReservationPrice(0) - testHJB) < 1e-2, `SAB Slot 139 (HJB Reservation) verified: got $${masterClient.getHJBReservationPrice(0)}`);
  assert(Math.abs(masterClient.getSurvivalProbability(0) - testSurvival) < 1e-4, `SAB Slot 140 (Survival Prob) verified: got ${masterClient.getSurvivalProbability(0)}`);
  assert(Math.abs(masterClient.getDynamicStopLossPrice(0) - testDynamicSL) < 1e-2, `SAB Slot 141 (Dynamic SL) verified: got $${masterClient.getDynamicStopLossPrice(0)}`);
  assert(Math.abs(masterClient.getVegamGkAtrComposite(0) - testGkAtr) < 1e-5, `SAB Slot 156 (VEGAM_GK_ATR_COMPOSITE) verified: got ${masterClient.getVegamGkAtrComposite(0)}`);
  assert(Math.abs(masterClient.getVegamTrailKRegime(0) - testKRegime) < 1e-4, `SAB Slot 157 (VEGAM_TRAIL_K_REGIME) verified: got ${masterClient.getVegamTrailKRegime(0)}`);
  assert(masterClient.getVegamCadmeState(0) === testCadmeState, `SAB Slot 158 (VEGAM_CADME_STATE) verified: got ${masterClient.getVegamCadmeState(0)}`);

  // =========================================================================================
  // STAGE 2: HJB Optimal Stopping Preempted by Hard Stop-Loss (Flash Crash Test)
  // =========================================================================================
  console.log("\n--- STAGE 2: HJB Optimal Stopping Preempted by Hard Stop-Loss (Flash Crash Test) ---");

  // Occupy CORE_LONG @ $60,000, qty: 0.001 BTC ($60 notional, target leverage budget), initial SL = 1.50% ($59,100)
  ledger.occupyCoreLong(0.001, 60000.0, 3.0, 1.5);
  const initialLong = ledger.getCoreLong();
  assert(initialLong.isOccupied === true, "Core Long slot is occupied");
  assert(initialLong.stopLossPrice === 59100.0, `Initial Core Long SL set to $59,100: got $${initialLong.stopLossPrice}`);

  const volMetricsNormal = volEngine.getVolatilitySurfaceMetrics();
  const hazardMetricsNormal = hazardEngine.getHazardMetrics("LONG", 0.50, 10000);

  // Sub-scenario 2A: Moderate adverse price move breaching HJB liquidation boundary ($59,300)
  // at 150s holding duration while remaining strictly ABOVE the hard Stop-Loss ($59,100).
  // HJB must trigger as PASSIVE_MAKER scratch/unwind.
  const stage2OpenTs = initialLong.openTime;
  const hjbBoundaryTriggers = ledger.evaluateSotaDynamicExits(
    59300.0,
    hazardMetricsNormal,
    hjbEngine,
    volMetricsNormal,
    stage2OpenTs + 150000 // 150s into the trade
  );
  assert(hjbBoundaryTriggers.length === 1, `HJB boundary breach produces exactly 1 trigger: got ${hjbBoundaryTriggers.length}`);
  assert(hjbBoundaryTriggers[0]?.reason === "HJB_RESERVATION_LIQUIDATE_LONG", `Emits HJB_RESERVATION_LIQUIDATE_LONG: got ${hjbBoundaryTriggers[0]?.reason}`);
  assert(hjbBoundaryTriggers[0]?.executionStyle === "PASSIVE_MAKER", `HJB liquidation executionStyle is PASSIVE_MAKER: got ${hjbBoundaryTriggers[0]?.executionStyle}`);

  // Sub-scenario 2B: Severe multi-sigma Flash Crash to $58,500 breaching BOTH HJB and Hard Stop-Loss ($59,100).
  // Constitutional Precedence Rule: Hard Stop-Loss MUST unconditionally preempt HJB liquidation,
  // executing immediately as AGGRESSIVE_MARKET to avoid passive maker inventory toxic absorption.
  const flashCrashTriggers = ledger.evaluateSotaDynamicExits(58500.0, hazardMetricsNormal, hjbEngine, volMetricsNormal, stage2OpenTs + 150000);
  assert(flashCrashTriggers.length === 1, `Flash crash produces exactly 1 exit trigger: got ${flashCrashTriggers.length}`);
  assert(
    flashCrashTriggers[0]?.reason === "MVA_TRAILING_STOP_LONG" || flashCrashTriggers[0]?.reason === "BREAK_EVEN_STOP_LOSS",
    `Hard Stop-Loss preempts HJB: reason is ${flashCrashTriggers[0]?.reason}`
  );
  assert(flashCrashTriggers[0]?.executionStyle === "AGGRESSIVE_MARKET", `Hard Stop-Loss executionStyle is strictly AGGRESSIVE_MARKET: got ${flashCrashTriggers[0]?.executionStyle}`);
  assert(flashCrashTriggers[0]?.executionType === "AGGRESSIVE_MARKET", `executionType is strictly AGGRESSIVE_MARKET: got ${flashCrashTriggers[0]?.executionType}`);
  assert(flashCrashTriggers[0]?.quantity === 0.001, `Full position liquidated: expected 0.001, got ${flashCrashTriggers[0]?.quantity}`);

  ledger.releaseCoreLong();

  // =========================================================================================
  // STAGE 3: Adversarial Exit Gate Activation (Multi-Signal Consensus on Toxic Flow)
  // =========================================================================================
  console.log("\n--- STAGE 3: Adversarial Exit Gate Activation (Multi-Signal Consensus) ---");

  // Re-occupy CORE_LONG @ $60,000, initial SL = 2.0% ($58,800)
  ledger.occupyCoreLong(0.10, 60000.0, 3.0, 2.0);

  // Sub-scenario 3A: Single-signal noise rejection.
  // Isolated adverse OBI (-0.40) without VPIN spike, sweep, or price velocity shock MUST NOT trigger.
  const singleSignalHazard: MicrostructureMetrics = {
    ...hazardMetricsNormal,
    obi: -0.40, // Adverse OBI alone
    vpin: 0.35, // Normal VPIN
    isHazardExitTriggered: false,
  };
  const singleSignalTriggers = ledger.evaluateSotaDynamicExits(60010.0, singleSignalHazard, hjbEngine, volMetricsNormal, Date.now());
  assert(singleSignalTriggers.length === 0, `Isolated adverse OBI does NOT trigger Adversarial Exit Gate: triggers count=${singleSignalTriggers.length}`);

  // Sub-scenario 3B: Isolated toxic VPIN (0.75) with neutral OBI and calm price MUST NOT trigger.
  const isolatedVpinHazard: MicrostructureMetrics = {
    ...hazardMetricsNormal,
    obi: 0.05,
    vpin: 0.75, // Toxic VPIN alone
    isHazardExitTriggered: false,
  };
  const isolatedVpinTriggers = ledger.evaluateSotaDynamicExits(60005.0, isolatedVpinHazard, hjbEngine, volMetricsNormal, Date.now());
  assert(isolatedVpinTriggers.length === 0, `Isolated toxic VPIN does NOT trigger Adversarial Exit Gate: triggers count=${isolatedVpinTriggers.length}`);

  // Sub-scenario 3C: Full Adversarial Cascade (Multi-Signal Consensus: Adverse OBI + Toxic VPIN + Sweep + Hawkes + Entropy Collapse + Price Shock)
  masterClient.setHawkesIntensity(2.40, 0); // High Hawkes burst (>= 1.80)
  masterClient.setIsSweepDetected(true, 0);  // Adverse aggressive sweep detected
  masterClient.setLOBEntropy(3.10, 0);       // Book entropy collapse (>= 2.80)

  const adversarialHazard: MicrostructureMetrics = {
    ...hazardMetricsNormal,
    obi: -0.55, // Strong adverse book pressure (< -0.20)
    vpin: 0.78, // Extreme toxic flow (> 0.65)
    ofi: -0.80, // Massive selling flow imbalance (< -0.40)
    tfi: -0.60,
    isHazardExitTriggered: false,
  };

  // Adverse price velocity shock down to $59,100 ($900 drop = 1.50% drop exceeding 1.25x GK_ATR threshold of 1.13%, but strictly above the $58,800 Stop-Loss)
  const advTriggers = ledger.evaluateSotaDynamicExits(59100.0, adversarialHazard, hjbEngine, volMetricsNormal, Date.now());
  assert(advTriggers.length === 1, `Adversarial cascade emits defensive exit trigger: count=${advTriggers.length}`);
  assert(advTriggers[0]?.reason === "ADVERSARIAL_CASCADE_EXIT_LONG", `Exact reason string matched: got ${advTriggers[0]?.reason}`);
  assert(advTriggers[0]?.executionStyle === "AGGRESSIVE_MARKET", `Adversarial exit executes as AGGRESSIVE_MARKET: got ${advTriggers[0]?.executionStyle}`);
  assert(advTriggers[0]?.quantity === 0.10, `Full position liquidated: got ${advTriggers[0]?.quantity}`);

  // Reset telemetry
  masterClient.setHawkesIntensity(1.0, 0);
  masterClient.setIsSweepDetected(false, 0);
  masterClient.setLOBEntropy(1.0, 0);
  ledger.releaseCoreLong();

  // =========================================================================================
  // STAGE 4: Trailing Stop-Loss Activation (< 0.50% ROE) & Subsequent OBI Tightening
  // =========================================================================================
  console.log("\n--- STAGE 4: Trailing Stop-Loss Activation & Subsequent OBI Tightening ---");

  // Re-occupy CORE_LONG @ $60,000, initial SL = 1.50% ($59,100)
  ledger.occupyCoreLong(0.10, 60000.0, 3.0, 1.5);
  let coreLong = ledger.getCoreLong();
  assert(coreLong.stopLossPrice === 59100.0, `Initial Core Long SL confirmed at $59,100: got $${coreLong.stopLossPrice}`);

  // Test 4A: Sub-activation gate: Price moves to $60,050 (+0.083% price move @ 2x = +0.167% ROE < 0.50%)
  const subActivationHazard: MicrostructureMetrics = {
    ...hazardMetricsNormal,
    obi: 0.0,
    vpin: 0.30,
    isHazardExitTriggered: false,
  };
  ledger.evaluateSotaDynamicExits(60050.0, subActivationHazard, hjbEngine, volMetricsNormal, Date.now());
  coreLong = ledger.getCoreLong();
  assert(coreLong.stopLossPrice === 59100.0, `Trail does NOT activate below 0.50% ROE: SL remains $59,100 (got $${coreLong.stopLossPrice})`);

  // Test 4B: Trail activates at ROE >= 0.50% (+0.333% move @ 2x = +0.667% ROE @ $60,200)
  // Neutral OBI (0.0): trailDist = 60000 * 0.00906 * 1.0 = $543.60 -> proposed SL = 60200 - 543.60 = $59,656.40
  ledger.evaluateSotaDynamicExits(60200.0, subActivationHazard, hjbEngine, volMetricsNormal, Date.now());
  coreLong = ledger.getCoreLong();
  assert(coreLong.stopLossPrice > 59100.0, `Dynamic trail activates at >= 0.50% ROE: SL ratcheted to $${coreLong.stopLossPrice}`);
  assert(Math.abs(coreLong.stopLossPrice - 59656.4) < 1.0, `Neutral OBI trailing stop matches exact formula ($59,656.40): got $${coreLong.stopLossPrice}`);
  assert(coreLong.stepCollarTier === undefined || coreLong.stepCollarTier === 0, `Tier 1 Break-Even ratchet remains inactive below 5.0% ROE: stepCollarTier=${coreLong.stepCollarTier ?? 0}`);

  // Test 4C: Adverse OBI Tightening (OBI = -0.35 < -0.20 -> k_regime = 0.80)
  // trailDist = 60000 * 0.00906 * 0.80 = $434.88 -> proposed SL = 60200 - 434.88 = $59,765.12
  const adverseObiHazard: MicrostructureMetrics = {
    ...subActivationHazard,
    obi: -0.35,
  };
  ledger.evaluateSotaDynamicExits(60200.0, adverseObiHazard, hjbEngine, volMetricsNormal, Date.now());
  coreLong = ledger.getCoreLong();
  assert(coreLong.stopLossPrice > 59656.4, `Adverse OBI tightens trail distance: SL raised from $59656.4 to $${coreLong.stopLossPrice}`);
  assert(Math.abs(coreLong.stopLossPrice - 59765.12) < 1.0, `Tightened trailing stop matches exact 0.80x k_regime formula ($59,765.12): got $${coreLong.stopLossPrice}`);

  // Test 4D: Monotonic Zero-Retreat Invariant on Pullback
  // Price pulls back to $60,080 -> SL must NOT retreat back down
  ledger.evaluateSotaDynamicExits(60080.0, adverseObiHazard, hjbEngine, volMetricsNormal, Date.now());
  coreLong = ledger.getCoreLong();
  assert(Math.abs(coreLong.stopLossPrice - 59765.12) < 1.0, `Monotonic zero-retreat invariant: SL strictly locked at $59,765.12 on pullback (got $${coreLong.stopLossPrice})`);

  // Test 4E: Tier 1 Break-Even Ratchet Coexistence at >= +5.0% ROE
  // Advance price to $61,600 (+2.667% price move @ 2x = +5.333% ROE >= 5.0%)
  ledger.evaluateSotaDynamicExits(61600.0, subActivationHazard, hjbEngine, volMetricsNormal, Date.now());
  coreLong = ledger.getCoreLong();
  assert(coreLong.stepCollarTier === 1, `Tier 1 Break-Even ratchet engages at >= 5.0% ROE: stepCollarTier=${coreLong.stepCollarTier}`);
  assert(coreLong.breakEvenLocked === true, `breakEvenLocked is set to true at Tier 1: got ${coreLong.breakEvenLocked}`);
  assert(coreLong.stopLossPrice > 60000.0, `Stop-Loss ratcheted securely ABOVE entry: got $${coreLong.stopLossPrice}`);

  ledger.releaseCoreLong();

  // Test 4F: Symmetrical SHORT position verification
  ledger.occupyShortSlot(0, 0.10, 60000.0, 3.0, 1.5);
  let shortSlot0 = ledger.getShortSlots()[0];
  assert(shortSlot0.stopLossPrice === 60900.0, `Initial Short SL set to $60,900: got $${shortSlot0.stopLossPrice}`);

  // Short price drop to $59,800 (+0.667% ROE >= 0.50%) with adverse OBI (+0.35 against short -> directional OBI = -0.35)
  // directional OBI = -0.35 -> k_regime = 0.80 -> trailDist = $434.88 -> Short SL = 59800 + 434.88 = $60,234.88
  const shortAdverseHazard: MicrostructureMetrics = {
    ...subActivationHazard,
    obi: 0.35, // Positive raw OBI is adverse for SHORT position
  };
  ledger.evaluateSotaDynamicExits(59800.0, shortAdverseHazard, hjbEngine, volMetricsNormal, Date.now());
  shortSlot0 = ledger.getShortSlots()[0];
  assert(shortSlot0.stopLossPrice < 60900.0, `Short dynamic trail activates at >= 0.50% ROE: SL tightened to $${shortSlot0.stopLossPrice}`);
  assert(Math.abs(shortSlot0.stopLossPrice - 60234.88) < 1.0, `Short tightened SL matches exact 0.80x k_regime formula ($60,234.88): got $${shortSlot0.stopLossPrice}`);

  // Short pullback bounce to $59,950 -> Short SL must NOT retreat upwards
  ledger.evaluateSotaDynamicExits(59950.0, shortAdverseHazard, hjbEngine, volMetricsNormal, Date.now());
  shortSlot0 = ledger.getShortSlots()[0];
  assert(Math.abs(shortSlot0.stopLossPrice - 60234.88) < 1.0, `Short Monotonic Zero-Retreat invariant: SL remains locked at $${shortSlot0.stopLossPrice} on bounce`);

  ledger.releaseShortSlot(0);

  // =========================================================================================
  // STAGE 5: CAD-DTLM Time-Decay Acceleration & Lifespan Exhaustion
  // =========================================================================================
  console.log("\n--- STAGE 5: CAD-DTLM Time-Decay Acceleration & Lifespan Exhaustion ---");

  // Sub-scenario 5A: CADME AI Alpha Decay Dual-Confirmation Exit
  masterClient.setRollingIC(0.050, 0); // Ingest live IC 0.050 into SAB Slot 101
  ledger.occupyCoreLong(0.10, 60000.0, 3.0, 1.5);
  let cadmeSlot = ledger.getCoreLong();
  assert(cadmeSlot.icAtEntry === 0.050, `Core Long captured live entry IC from SAB Slot 101: expected 0.050, got ${cadmeSlot.icAtEntry}`);
  assert(cadmeSlot.cadmeState === 0, `Initial cadmeState is 0 (INACTIVE): got ${cadmeSlot.cadmeState}`);

  const openTs = cadmeSlot.openTime;
  const halfLifeSec = 120.0; // 120s OU half-life

  // 1. Prime alpha test: tau = 30s (< 0.5 * halfLifeSec) -> Zero premature exit
  masterClient.setRollingIC(0.050, 0);
  const primeAlphaTriggers = ledger.evaluateSotaDynamicExits(
    60000.0,
    subActivationHazard,
    hjbEngine,
    volMetricsNormal,
    openTs + 30 * 1000
  );
  assert(primeAlphaTriggers.length === 0, `Prime alpha regime suppresses CADME exit: triggers count=${primeAlphaTriggers.length}`);

  // 2. Pre-warning monitoring: tau = 150s, modeled decay < 0.60 * icAtEntry, but live IC is strong (0.045 >= 0.0375)
  // Gate 2 prevents premature exit; cadmeState advances to 1 (MONITORING)
  masterClient.setRollingIC(0.045, 0);
  ledger.evaluateSotaDynamicExits(
    60000.0,
    subActivationHazard,
    hjbEngine,
    volMetricsNormal,
    openTs + 150 * 1000
  );
  cadmeSlot = ledger.getCoreLong();
  assert(cadmeSlot.cadmeState === 1, `cadmeState advances to 1 (MONITORING) under modeled decay without live drop: got ${cadmeSlot.cadmeState}`);

  // 3. Dual-confirmation triggered: modeled decay < 0.60 * icAtEntry AND live IC < 0.75 * icAtEntry (0.020 < 0.0375)
  masterClient.setRollingIC(0.020, 0); // live IC collapse confirmed via SAB Slot 101
  const cadmeExitTriggers = ledger.evaluateSotaDynamicExits(
    60000.0,
    subActivationHazard,
    hjbEngine,
    volMetricsNormal,
    openTs + 160 * 1000
  );
  assert(cadmeExitTriggers.length === 1, `CADME dual-confirmation fires exit trigger: count=${cadmeExitTriggers.length}`);
  assert(cadmeExitTriggers[0]?.reason === "CADME_ALPHA_DECAY_EXIT_LONG", `Exact CADME reason matched: got ${cadmeExitTriggers[0]?.reason}`);
  assert(cadmeExitTriggers[0]?.executionStyle === "PASSIVE_MAKER", `CADME executes as PASSIVE_MAKER: got ${cadmeExitTriggers[0]?.executionStyle}`);
  cadmeSlot = ledger.getCoreLong();
  assert(cadmeSlot.cadmeState === 2, `cadmeState strictly updated to 2 (EXIT_TRIGGERED): got ${cadmeSlot.cadmeState}`);
  assert(masterClient.getVegamCadmeState(0) === 2.0, `SAB Slot 158 atomically synchronized to 2.0: got ${masterClient.getVegamCadmeState(0)}`);

  ledger.releaseCoreLong();

  // Sub-scenario 5B: Terminal Lifespan Hard Kill (duration >= 1800s / 30 Minutes Max Lifespan)
  ledger.occupyCoreLong(0.10, 60000.0, 3.0, 1.5);
  const terminalSlot = ledger.getCoreLong();
  const terminalTriggers = ledger.evaluateSotaDynamicExits(
    60000.0,
    subActivationHazard,
    hjbEngine,
    volMetricsNormal,
    terminalSlot.openTime + 1850 * 1000 // 1850 seconds elapsed (exceeds 1800s max horizon)
  );
  assert(terminalTriggers.length === 1, `Terminal lifespan produces exactly 1 trigger: count=${terminalTriggers.length}`);
  assert(terminalTriggers[0]?.reason === "LONG_HOLD_PROFIT_HARVEST", `Emits LONG_HOLD_PROFIT_HARVEST: got ${terminalTriggers[0]?.reason}`);
  assert(terminalTriggers[0]?.executionStyle === "PASSIVE_MAKER", `Terminal liquidation executes as PASSIVE_MAKER: got ${terminalTriggers[0]?.executionStyle}`);

  ledger.releaseCoreLong();

  // =========================================================================================
  // STAGE 6: End-to-End Latency Benchmark (< 3.0 µs SLA) & Zero-GC Invariant
  // =========================================================================================
  console.log("\n--- STAGE 6: End-to-End Multi-Layer Latency Benchmark & Zero-GC Invariant ---");

  ledger.occupyCoreLong(0.10, 60000.0, 3.0, 1.5);
  const benchHazard = hazardMetricsNormal;
  const benchVol = volMetricsNormal;
  const benchNow = Date.now();

  // Warmup loop: 25,000 iterations for V8 Turbofan JIT compilation and memory tier stability
  for (let w = 0; w < 25000; w++) {
    ledger.evaluateSotaDynamicExits(60000.0, benchHazard, hjbEngine, benchVol, benchNow);
  }

  // Benchmark loop: 100,000 full-pipeline evaluations
  const iterations = 100000;
  const startMem = process.memoryUsage().heapUsed;
  const startHr = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    ledger.evaluateSotaDynamicExits(60000.0, benchHazard, hjbEngine, benchVol, benchNow);
  }

  const endHr = process.hrtime.bigint();
  const endMem = process.memoryUsage().heapUsed;

  const totalNs = Number(endHr - startHr);
  const avgNsPerTick = totalNs / iterations;
  const avgUsPerTick = avgNsPerTick / 1000.0;
  const heapDeltaKb = Math.max(0, (endMem - startMem) / 1024.0);
  const bytesPerCall = (heapDeltaKb * 1024.0) / iterations;

  console.log(`[BENCHMARK] Executed ${iterations.toLocaleString()} full multi-layer evaluations in ${(totalNs / 1e6).toFixed(2)} ms`);
  console.log(`[BENCHMARK] Average Latency Per Tick: ${avgUsPerTick.toFixed(4)} µs (SLA Target: < 3.0000 µs)`);
  console.log(`[BENCHMARK] Heap Delta over 100k calls: ${heapDeltaKb.toFixed(2)} KB (${bytesPerCall.toFixed(2)} bytes/call)`);

  assert(avgUsPerTick < 3.0, `SLA Latency Target Verified: ${avgUsPerTick.toFixed(4)} µs < 3.0000 µs`);
  assert(bytesPerCall < 50.0, `Zero-GC Hot-Path Verified: ${bytesPerCall.toFixed(2)} bytes/call (< 50 bytes V8 runtime noise threshold)`);

  ledger.releaseCoreLong();

  // =========================================================================================
  // SUMMARY & VERDICT
  // =========================================================================================
  console.log("\n================================================================================");
  console.log(`   VEGAM PHASE 9 MASTER INTEGRATION TEST MATRIX: ${totalPassed} PASSED / ${totalFailed} FAILED`);
  console.log("================================================================================");

  if (totalFailed > 0) {
    console.error(`\x1b[31m❌ VEGAM PHASE 9 MASTER INTEGRATION FAILED WITH ${totalFailed} FAILURES!\x1b[0m`);
    process.exit(1);
  } else {
    console.log("\x1b[32m✅ ALL VEGAM PHASE 9 MASTER INTEGRATION TESTS PASSED (100% SUCCESS)!\x1b[0m");
    process.exit(0);
  }
}

runMasterIntegrationSuite().catch((err) => {
  console.error("FATAL ERROR IN MASTER INTEGRATION SUITE:", err);
  process.exit(1);
});
