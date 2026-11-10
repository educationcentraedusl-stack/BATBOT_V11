/**
 * BATBOT_V11 SOTA QA TEST SUITE: PHASE 4 (DYNAMIC EXIT URGENCY ROUTER)
 *
 * Verifies Phase 4: Dynamic Exit Urgency Router (Fee-Optimal Execution Routing)
 *
 * Mathematical & Architectural Invariants:
 * 1. Exact Linear Urgency Formula:
 *    U = (Adversarial * 0.40) + (Age * 0.30) + (Queue * 0.20) + (VPIN * 0.10)
 * 2. Exact Execution Style Routing Table:
 *    - 0.00 - 0.49: PASSIVE_MAKER (tickOffset = 0, isImmediate = false)
 *    - 0.50 - 0.74: PASSIVE_MAKER with 2-tick aggressive offset (tickOffset = 2, isImmediate = false)
 *    - 0.75 - 0.89: AGGRESSIVE_MARKET (tickOffset = 0, isImmediate = false)
 *    - 0.90 - 1.00: AGGRESSIVE_MARKET immediate (tickOffset = 0, isImmediate = true)
 * 3. Boundary Precision:
 *    - Strict assertion on 0.49 vs 0.50
 *    - Strict assertion on 0.74 vs 0.75
 *    - Strict assertion on 0.89 vs 0.90
 * 4. Zero-GC Hot-Path Guarantee:
 *    - In-place mutation of pre-allocated singleton/instance result objects
 *    - Heap Delta < 50.0 bytes/call V8 noise SLA across 100,000 iterations
 *    - Sub-microsecond latency (< 0.50 µs SLA)
 * 5. SAB Slot 167 (URGENCY_SCORE) Telemetry:
 *    - Lock-free atomic bitcasting across all 10 assets
 * 6. Position Ledger Integration:
 *    - Dynamic fee-optimal maker execution in calm market
 *    - Immediate aggressive market execution under toxic flow
 */

import { DynamicUrgencyRouter } from "../strategy/urgencyRouter";
import { HedgePositionLedger } from "../strategy/positionLedger";
import { MarketDataClient } from "../marketDataClient";
import { SAB_SLOTS } from "../ipc/sabSchema";
import { MicrostructureMetrics } from "../strategy/microstructureHazardEngine";
import { VolatilitySurfaceMetrics } from "../strategy/volatilitySurfaceEngine";

console.log("================================================================================");
console.log("   BATBOT_V11 SOTA QA TEST SUITE: PHASE 4 DYNAMIC EXIT URGENCY ROUTER");
console.log("   FEE-OPTIMAL MAKER/TAKER EXECUTION & ZERO-GC TELEMETRY BENCHMARK");
console.log("================================================================================");

let totalPassed = 0;
let totalFailed = 0;

function assert(condition: boolean, testName: string): void {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    totalPassed++;
  } else {
    console.error(`\x1b[31m[FAIL] ${testName}\x1b[0m`);
    totalFailed++;
    process.exitCode = 1;
  }
}

const router = new DynamicUrgencyRouter();

// =========================================================================================
// STAGE 1: Mathematical Formula & Component Weight Calibration Proof
// =========================================================================================
console.log("\n--- STAGE 1: Mathematical Formula & Component Weight Calibration Proof ---");

const wAdv: number = DynamicUrgencyRouter.W_ADVERSARIAL;
const wAge: number = DynamicUrgencyRouter.W_AGE;
const wQueue: number = DynamicUrgencyRouter.W_QUEUE;
const wVpin: number = DynamicUrgencyRouter.W_VPIN;
assert(wAdv === 0.40, "Adversarial weight W_A equals 0.40");
assert(wAge === 0.30, "Age weight W_T equals 0.30");
assert(wQueue === 0.20, "Queue weight W_Q equals 0.20");
assert(wVpin === 0.10, "VPIN weight W_V equals 0.10");

const weightSum =
  DynamicUrgencyRouter.W_ADVERSARIAL +
  DynamicUrgencyRouter.W_AGE +
  DynamicUrgencyRouter.W_QUEUE +
  DynamicUrgencyRouter.W_VPIN;
assert(Math.abs(weightSum - 1.0) < 1e-12, `Weight sum strictly equals 1.0: got ${String(weightSum)}`);

// Isolated component tests
const uAdvOnly = router.compute(1.0, 0.0, 0.0, 0.0);
assert(Math.abs(uAdvOnly.compositeUrgency - 0.40) < 1e-8, `Isolated Adversarial (1,0,0,0) = 0.40: got ${String(uAdvOnly.compositeUrgency)}`);
assert(uAdvOnly.adversarialScore === 1.0, "adversarialScore correctly captured");

const uAgeOnly = router.compute(0.0, 1.0, 0.0, 0.0);
assert(Math.abs(uAgeOnly.compositeUrgency - 0.30) < 1e-8, `Isolated Age (0,1,0,0) = 0.30: got ${String(uAgeOnly.compositeUrgency)}`);

const uQueueOnly = router.compute(0.0, 0.0, 1.0, 0.0);
assert(Math.abs(uQueueOnly.compositeUrgency - 0.20) < 1e-8, `Isolated Queue (0,0,1,0) = 0.20: got ${String(uQueueOnly.compositeUrgency)}`);

const uVpinOnly = router.compute(0.0, 0.0, 0.0, 1.0);
assert(Math.abs(uVpinOnly.compositeUrgency - 0.10) < 1e-8, `Isolated VPIN (0,0,0,1) = 0.10: got ${String(uVpinOnly.compositeUrgency)}`);

const uZero = router.compute(0.0, 0.0, 0.0, 0.0);
assert(uZero.compositeUrgency === 0.0, `Zero baseline (0,0,0,0) = 0.0: got ${String(uZero.compositeUrgency)}`);

const uMax = router.compute(1.0, 1.0, 1.0, 1.0);
assert(uMax.compositeUrgency === 1.0, `Max saturation (1,1,1,1) = 1.0: got ${String(uMax.compositeUrgency)}`);

const uHalf = router.compute(0.5, 0.5, 0.5, 0.5);
assert(Math.abs(uHalf.compositeUrgency - 0.50) < 1e-8, `Uniform half (0.5,0.5,0.5,0.5) = 0.50: got ${String(uHalf.compositeUrgency)}`);

// =========================================================================================
// STAGE 2: Exact Mathematical Boundaries of the Execution Routing Table
// =========================================================================================
console.log("\n--- STAGE 2: Exact Mathematical Boundaries of the Execution Routing Table ---");

// Boundary 1A: Sub-boundary 0.49
// Adversarial = 1.0 (0.40), Age = 0.30 (0.09) -> U = 0.49
const u049 = router.compute(1.0, 0.30, 0.0, 0.0);
assert(Math.abs(u049.compositeUrgency - 0.49) < 1e-8, `U = 0.49 verified: got ${String(u049.compositeUrgency)}`);
assert(u049.executionStyle === "PASSIVE_MAKER", `U = 0.49 routes to PASSIVE_MAKER: got ${u049.executionStyle}`);
assert(u049.tickOffset === 0, `U = 0.49 tickOffset is 0: got ${String(u049.tickOffset)}`);
assert(!u049.isImmediate, "U = 0.49 isImmediate is false");

// Boundary 1B: Exact boundary 0.50
// Adversarial = 0.50 (0.20), Age = 1.0 (0.30) -> U = 0.50
const u050 = router.compute(0.50, 1.0, 0.0, 0.0);
assert(Math.abs(u050.compositeUrgency - 0.50) < 1e-8, `U = 0.50 verified: got ${String(u050.compositeUrgency)}`);
assert(u050.executionStyle === "PASSIVE_MAKER", `U = 0.50 routes to PASSIVE_MAKER: got ${u050.executionStyle}`);
assert(u050.tickOffset === 2, `U = 0.50 tickOffset is 2 (aggressive offset): got ${String(u050.tickOffset)}`);
assert(!u050.isImmediate, "U = 0.50 isImmediate is false");

// Boundary 2A: Sub-boundary 0.74
// Adversarial = 1.0 (0.40), Age = 1.0 (0.30), Queue = 0.20 (0.04) -> U = 0.74
const u074 = router.compute(1.0, 1.0, 0.20, 0.0);
assert(Math.abs(u074.compositeUrgency - 0.74) < 1e-8, `U = 0.74 verified: got ${String(u074.compositeUrgency)}`);
assert(u074.executionStyle === "PASSIVE_MAKER", `U = 0.74 routes to PASSIVE_MAKER: got ${u074.executionStyle}`);
assert(u074.tickOffset === 2, `U = 0.74 tickOffset is 2: got ${String(u074.tickOffset)}`);
assert(!u074.isImmediate, "U = 0.74 isImmediate is false");

// Boundary 2B: Exact boundary 0.75
// Adversarial = 1.0 (0.40), Age = 1.0 (0.30), Queue = 0.25 (0.05) -> U = 0.75
const u075 = router.compute(1.0, 1.0, 0.25, 0.0);
assert(Math.abs(u075.compositeUrgency - 0.75) < 1e-8, `U = 0.75 verified: got ${String(u075.compositeUrgency)}`);
assert(u075.executionStyle === "AGGRESSIVE_MARKET", `U = 0.75 routes to AGGRESSIVE_MARKET: got ${u075.executionStyle}`);
assert(u075.tickOffset === 0, `U = 0.75 tickOffset resets to 0: got ${String(u075.tickOffset)}`);
assert(!u075.isImmediate, "U = 0.75 isImmediate is false (standard market)");

// Boundary 3A: Sub-boundary 0.89
// Adversarial = 1.0 (0.40), Age = 1.0 (0.30), Queue = 0.95 (0.19) -> U = 0.89
const u089 = router.compute(1.0, 1.0, 0.95, 0.0);
assert(Math.abs(u089.compositeUrgency - 0.89) < 1e-8, `U = 0.89 verified: got ${String(u089.compositeUrgency)}`);
assert(u089.executionStyle === "AGGRESSIVE_MARKET", `U = 0.89 routes to AGGRESSIVE_MARKET: got ${u089.executionStyle}`);
assert(u089.tickOffset === 0, "U = 0.89 tickOffset is 0");
assert(!u089.isImmediate, "U = 0.89 isImmediate is false");

// Boundary 3B: Exact boundary 0.90
// Adversarial = 1.0 (0.40), Age = 1.0 (0.30), Queue = 1.0 (0.20) -> U = 0.90
const u090 = router.compute(1.0, 1.0, 1.0, 0.0);
assert(Math.abs(u090.compositeUrgency - 0.90) < 1e-8, `U = 0.90 verified: got ${String(u090.compositeUrgency)}`);
assert(u090.executionStyle === "AGGRESSIVE_MARKET", `U = 0.90 routes to AGGRESSIVE_MARKET: got ${u090.executionStyle}`);
assert(u090.tickOffset === 0, "U = 0.90 tickOffset is 0");
assert(u090.isImmediate, "U = 0.90 isImmediate is true (immediate market execution)");

// Boundary 4: Ceiling 1.00
const u100 = router.compute(1.0, 1.0, 1.0, 1.0);
assert(u100.compositeUrgency === 1.00, "U = 1.00 verified");
assert(u100.executionStyle === "AGGRESSIVE_MARKET", "U = 1.00 executionStyle is AGGRESSIVE_MARKET");
assert(u100.isImmediate, "U = 1.00 isImmediate is true");

// =========================================================================================
// STAGE 3: Helper Resolution & Scalar Direct Functions
// =========================================================================================
console.log("\n--- STAGE 3: Helper Resolution & Scalar Direct Functions ---");

assert(DynamicUrgencyRouter.resolveExecutionStyle(0.00) === "PASSIVE_MAKER", "resolveExecutionStyle(0.00) = PASSIVE_MAKER");
assert(DynamicUrgencyRouter.resolveExecutionStyle(0.49) === "PASSIVE_MAKER", "resolveExecutionStyle(0.49) = PASSIVE_MAKER");
assert(DynamicUrgencyRouter.resolveExecutionStyle(0.50) === "PASSIVE_MAKER", "resolveExecutionStyle(0.50) = PASSIVE_MAKER");
assert(DynamicUrgencyRouter.resolveExecutionStyle(0.74) === "PASSIVE_MAKER", "resolveExecutionStyle(0.74) = PASSIVE_MAKER");
assert(DynamicUrgencyRouter.resolveExecutionStyle(0.75) === "AGGRESSIVE_MARKET", "resolveExecutionStyle(0.75) = AGGRESSIVE_MARKET");
assert(DynamicUrgencyRouter.resolveExecutionStyle(0.89) === "AGGRESSIVE_MARKET", "resolveExecutionStyle(0.89) = AGGRESSIVE_MARKET");
assert(DynamicUrgencyRouter.resolveExecutionStyle(0.90) === "AGGRESSIVE_MARKET", "resolveExecutionStyle(0.90) = AGGRESSIVE_MARKET");
assert(DynamicUrgencyRouter.resolveExecutionStyle(1.00) === "AGGRESSIVE_MARKET", "resolveExecutionStyle(1.00) = AGGRESSIVE_MARKET");

assert(DynamicUrgencyRouter.resolveTickOffset(0.00) === 0, "resolveTickOffset(0.00) = 0");
assert(DynamicUrgencyRouter.resolveTickOffset(0.49) === 0, "resolveTickOffset(0.49) = 0");
assert(DynamicUrgencyRouter.resolveTickOffset(0.50) === 2, "resolveTickOffset(0.50) = 2");
assert(DynamicUrgencyRouter.resolveTickOffset(0.74) === 2, "resolveTickOffset(0.74) = 2");
assert(DynamicUrgencyRouter.resolveTickOffset(0.75) === 0, "resolveTickOffset(0.75) = 0");

assert(!DynamicUrgencyRouter.isImmediateMarket(0.89), "isImmediateMarket(0.89) = false");
assert(DynamicUrgencyRouter.isImmediateMarket(0.90), "isImmediateMarket(0.90) = true");
assert(DynamicUrgencyRouter.isImmediateMarket(1.00), "isImmediateMarket(1.00) = true");

// Instance delegate parity
assert(router.resolveExecutionStyle(0.75) === "AGGRESSIVE_MARKET", "instance.resolveExecutionStyle parity");
assert(router.resolveTickOffset(0.60) === 2, "instance.resolveTickOffset parity");
assert(router.isImmediateMarket(0.95), "instance.isImmediateMarket parity");

// =========================================================================================
// STAGE 4: Raw Microstructural Metrics (6-Parameter Overload) & Sanitization
// =========================================================================================
console.log("\n--- STAGE 4: Raw Microstructural Metrics (6-Parameter Overload) & Sanitization ---");

// compute(activeSignals, minSignals, positionAgeSec, mhdcSec, queueRatio, vpin)
// Scenario: 1 active signal (out of 2), age 180s (out of 360s), queue 0.50, vpin 0.60
// adv = 1/2 = 0.50 -> 0.20
// age = 180/360 = 0.50 -> 0.15
// queue = 0.50 -> 0.10
// vpin = 0.60 -> 0.06
// U = 0.20 + 0.15 + 0.10 + 0.06 = 0.51 -> PASSIVE_MAKER with 2-tick offset
const uRaw1 = router.compute(1, 2, 180, 360, 0.50, 0.60);
assert(Math.abs(uRaw1.compositeUrgency - 0.51) < 1e-8, `Raw 6-param composite urgency = 0.51: got ${String(uRaw1.compositeUrgency)}`);
assert(uRaw1.executionStyle === "PASSIVE_MAKER", `Raw 6-param style is PASSIVE_MAKER: got ${uRaw1.executionStyle}`);
assert(uRaw1.tickOffset === 2, `Raw 6-param tickOffset is 2: got ${String(uRaw1.tickOffset)}`);
assert(uRaw1.adversarialScore === 0.5, `advScore = 0.5: got ${String(uRaw1.adversarialScore)}`);
assert(uRaw1.ageScore === 0.5, `ageScore = 0.5: got ${String(uRaw1.ageScore)}`);
assert(uRaw1.queueScore === 0.5, `queueScore = 0.5: got ${String(uRaw1.queueScore)}`);
assert(uRaw1.vpinScore === 0.6, `vpinScore = 0.6: got ${String(uRaw1.vpinScore)}`);

// Clamping guards: super-saturated inputs
const uSaturated = router.compute(6, 2, 720, 360, 2.5, 3.0);
assert(uSaturated.compositeUrgency === 1.0, `Saturated metrics cleanly clamped to 1.0: got ${String(uSaturated.compositeUrgency)}`);
assert(uSaturated.executionStyle === "AGGRESSIVE_MARKET", "Saturated style is AGGRESSIVE_MARKET");
assert(uSaturated.isImmediate, "Saturated isImmediate is true");

// Zero division & NaN sanitization
const uNanGuard = router.compute(NaN, 0, -50, 0, NaN, Infinity);
assert(Number.isFinite(uNanGuard.compositeUrgency), `Sanitized NaN/0 inputs yield finite urgency: got ${String(uNanGuard.compositeUrgency)}`);
assert(uNanGuard.compositeUrgency >= 0 && uNanGuard.compositeUrgency <= 1.0, "Urgency remains bounded in [0, 1]");

// Static compute parity
const uStatic = DynamicUrgencyRouter.compute(1.0, 1.0, 1.0, 1.0);
assert(uStatic.compositeUrgency === 1.0, "Static compute matches instance compute");

// =========================================================================================
// STAGE 5: In-Place Mutation & Object Identity (Zero-GC Invariant)
// =========================================================================================
console.log("\n--- STAGE 5: In-Place Mutation & Object Identity (Zero-GC Invariant) ---");

const res1 = router.compute(0.2, 0.2, 0.2, 0.2);
const res2 = router.compute(0.8, 0.8, 0.8, 0.8);

assert(res1 === res2, "Instance compute mutates internal result in-place: res1 === res2 reference equality verified");
assert(res1.compositeUrgency === 0.8, "Mutated reference reflects latest computation");

const staticRes1 = DynamicUrgencyRouter.compute(0.1, 0.1, 0.1, 0.1);
const staticRes2 = DynamicUrgencyRouter.compute(0.9, 0.9, 0.9, 0.9);
assert(staticRes1 === staticRes2, "Static compute mutates static singleton in-place: staticRes1 === staticRes2 reference equality verified");

// =========================================================================================
// STAGE 6: SharedArrayBuffer Slot 167 (URGENCY_SCORE) Telemetry
// =========================================================================================
console.log("\n--- STAGE 6: SharedArrayBuffer Slot 167 (URGENCY_SCORE) Telemetry ---");

const urgencyScoreSlot: number = SAB_SLOTS.URGENCY_SCORE;
assert(urgencyScoreSlot === 167, "SAB_SLOTS.URGENCY_SCORE strictly equals 167");

const maxAssets = 10;
const slotsPerAsset = 256;
const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
const mdClient = new MarketDataClient(sab, maxAssets, slotsPerAsset);

assert(mdClient.getUrgencyScore(0) === 0.0, "SAB Slot 167 zero-initialized: got 0.0");

// Atomic write and read round-trip
const testScore = 0.74285912;
mdClient.setUrgencyScore(testScore, 0);
const readScore = mdClient.getUrgencyScore(0);
assert(Math.abs(readScore - testScore) < 1e-8, `Slot 167 atomic round-trip accurate: expected ${String(testScore)}, got ${String(readScore)}`);

// Multi-asset isolation check
mdClient.setUrgencyScore(0.91234567, 2);
assert(mdClient.getUrgencyScore(0) === testScore, `Asset 0 Slot 167 unaffected by write to Asset 2: got ${String(mdClient.getUrgencyScore(0))}`);
assert(mdClient.getUrgencyScore(2) === 0.91234567, `Asset 2 Slot 167 accurate: got ${String(mdClient.getUrgencyScore(2))}`);

// Slot 165 Queue Position Est getter/setter
assert(mdClient.getQueuePositionEst(0) === 0.0, "Slot 165 zero-initialized");
mdClient.setQueuePositionEst(0.65, 0);
assert(Math.abs(mdClient.getQueuePositionEst(0) - 0.65) < 1e-8, `Slot 165 atomic round-trip: got ${String(mdClient.getQueuePositionEst(0))}`);

// Clean reset of telemetry slots prior to ledger integration test
mdClient.setQueuePositionEst(0.0, 0);
mdClient.setUrgencyScore(0.0, 0);
mdClient.setUrgencyScore(0.0, 2);

// =========================================================================================
// STAGE 7: Position Ledger Dynamic Routing Integration
// =========================================================================================
console.log("\n--- STAGE 7: Position Ledger Dynamic Routing Integration ---");

const ledger = new HedgePositionLedger("BTCUSDT", 3, mdClient, 0);
const entryPrice = 60000.0;
const entryQty = 0.10;

const hazardNeutral: MicrostructureMetrics = {
  ofi: 0.0,
  obi: 0.0,
  tfi: 0.0,
  vpin: 0.50,
  hazardScore: 0.0,
  coxHazardRate: 0.001,
  survivalProbability: 0.999,
  isHazardExitTriggered: false,
};

const volNormal: VolatilitySurfaceMetrics = {
  garmanKlass1s: 0.00004,
  garmanKlass10s: 0.00004,
  garmanKlass60s: 0.00004,
  parkinson60s: 0.00004,
  volatilityMultiplier: 1.0,
};

// Sub-scenario 7A: Calm Market MHDC Expiration -> Dynamically Routes to PASSIVE_MAKER (Fee Drag Eradication)
ledger.occupyCoreLong(entryQty, entryPrice, 1.0, 1.5);
const coreLong = ledger.getCoreLong();
const openTime = coreLong.openTime;

// Age 360s = MHDC boundary in calm market
// U = 0 * 0.40 + 1.0 * 0.30 + 0 * 0.20 + 0.50 * 0.10 = 0.35
const t360 = openTime + 360 * 1000;
const triggersCalm = ledger.evaluateSotaDynamicExits(entryPrice, entryPrice, hazardNeutral, undefined, volNormal, t360, 0.50);

assert(triggersCalm.length === 1, "MHDC trigger fires at boundary in calm market");
assert(triggersCalm[0].reason === "MHDC_ALPHA_EXPIRATION_LONG", `Reason string matched: ${triggersCalm[0].reason}`);
assert(triggersCalm[0].executionStyle === "PASSIVE_MAKER", `Calm market MHDC dynamically routes to PASSIVE_MAKER: got ${String(triggersCalm[0].executionStyle)}`);
assert(triggersCalm[0].executionType === "PASSIVE_MAKER", `executionType matches executionStyle: got ${String(triggersCalm[0].executionType)}`);

// Check SAB Slot 167 write
const sabUrgencyCalm = mdClient.getUrgencyScore(0);
assert(Math.abs(sabUrgencyCalm - 0.35) < 1e-4, `SAB Slot 167 updated on evaluation: expected 0.35, got ${String(sabUrgencyCalm)}`);

ledger.releaseCoreLong();

// Sub-scenario 7B: Toxic Market MHDC Expiration -> Dynamically Routes to AGGRESSIVE_MARKET
ledger.occupyCoreLong(entryQty, entryPrice, 1.0, 1.5);
const openTime2 = ledger.getCoreLong().openTime;

// Toxic hazard at boundary: VPIN = 0.90, OBI = -0.60, OFI = -0.80, sweep = true (queue = 1.0)
// Adv signals = 2+ (consensus) -> adv = 1.0 (0.40)
// Age = 1.0 (0.30)
// Queue = 1.0 (0.20)
// VPIN = 0.90 (0.09)
// U = 0.40 + 0.30 + 0.20 + 0.09 = 0.99 >= 0.90 -> AGGRESSIVE_MARKET
const toxicHazard: MicrostructureMetrics = {
  ...hazardNeutral,
  obi: -0.60,
  vpin: 0.90,
  ofi: -0.80,
  tfi: -0.60,
};
mdClient.setIsSweepDetected(true, 0);

const t360Toxic = openTime2 + 360 * 1000;
const triggersToxic = ledger.evaluateSotaDynamicExits(entryPrice, entryPrice, toxicHazard, undefined, volNormal, t360Toxic, 0.50);

assert(triggersToxic.length === 1, "MHDC trigger fires at boundary under toxic flow");
assert(triggersToxic[0].executionStyle === "AGGRESSIVE_MARKET", `Toxic market MHDC dynamically routes to AGGRESSIVE_MARKET: got ${String(triggersToxic[0].executionStyle)}`);

mdClient.setIsSweepDetected(false, 0);
ledger.releaseCoreLong();

// =========================================================================================
// STAGE 8: Sub-Microsecond Latency SLA & Zero-GC Hot-Path Benchmark
// =========================================================================================
console.log("\n--- STAGE 8: Sub-Microsecond Latency SLA & Zero-GC Hot-Path Benchmark ---");

const ITERATIONS = 100_000;

// JIT warm-up
for (let i = 0; i < 10_000; i++) {
  router.compute(0.5, 0.5, 0.5, 0.5);
  router.compute(2, 2, 180, 360, 0.5, 0.6);
  DynamicUrgencyRouter.compute(0.7, 0.7, 0.7, 0.7);
}

// Garbage collection if exposed
if (global.gc) {
  global.gc();
}

const memBefore = process.memoryUsage().heapUsed;
const startHr = process.hrtime.bigint();

for (let i = 0; i < ITERATIONS; i++) {
  router.compute(0.65, 0.80, 0.30, 0.70);
}

const endHr = process.hrtime.bigint();
const memAfter = process.memoryUsage().heapUsed;

const totalNs = Number(endHr - startHr);
const avgNs = totalNs / ITERATIONS;
const avgUs = avgNs / 1000.0;
const bytesAllocated = Math.max(0, memAfter - memBefore);
const bytesPerCall = bytesAllocated / ITERATIONS;

console.log(`[BENCHMARK] Executed ${ITERATIONS.toLocaleString()} router.compute() calls in ${(totalNs / 1e6).toFixed(2)} ms`);
console.log(`[BENCHMARK] Average Latency Per Call: ${avgUs.toFixed(4)} µs (${avgNs.toFixed(1)} ns) (SLA Target: < 0.5000 µs)`);
console.log(`[BENCHMARK] Heap Delta over 100k calls: ${(bytesAllocated / 1024).toFixed(2)} KB (${bytesPerCall.toFixed(2)} bytes/call)`);

assert(avgUs < 0.50, `Sub-microsecond latency SLA verified: ${avgUs.toFixed(4)} µs < 0.5000 µs`);
assert(bytesPerCall < 50.0, `Zero-GC Hot-Path Invariant Verified: ${bytesPerCall.toFixed(2)} bytes/call (< 50.0 bytes V8 noise threshold)`);

// =========================================================================================
// SUMMARY
// =========================================================================================
console.log("\n================================================================================");
console.log(`   PHASE 4 DYNAMIC URGENCY ROUTER MATRIX: ${String(totalPassed)} PASSED / ${String(totalFailed)} FAILED`);
console.log("================================================================================");

if (totalFailed === 0) {
  console.log("✅ ALL PHASE 4 DYNAMIC EXIT URGENCY ROUTER TESTS PASSED (100% SUCCESS)!\n");
  process.exit(0);
} else {
  console.error("❌ PHASE 4 DYNAMIC EXIT URGENCY ROUTER TESTS FAILED!\n");
  process.exit(1);
}
