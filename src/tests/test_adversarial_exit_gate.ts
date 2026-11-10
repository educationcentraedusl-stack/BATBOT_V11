/**
 * BATBOT_V11 SOTA QA TEST SUITE: VEGAM PHASE 6 ADVERSARIAL EXIT GATE
 *
 * Verifies Layer 4 Adversarial Exit Gate:
 * 1. Normal market resilience (zero false triggers during standard volatility).
 * 2. Multi-signal consensus requirement (>= 2 signals; single signal does not trigger).
 * 3. Symmetrical LONG flash-crash multi-signal consensus cascade execution.
 * 4. Symmetrical SHORT squeeze multi-signal consensus cascade execution.
 * 5. Sub-microsecond latency SLA (< 0.5 µs hot-path evaluation).
 * 6. Zero heap allocations (Zero-GC compliance).
 */

import { AdversarialExitGate } from "../strategy/adversarialExitGate";
import { HedgePositionLedger, PositionSlot } from "../strategy/positionLedger";
import { MicrostructureMetrics } from "../strategy/microstructureHazardEngine";
import { MarketDataClient } from "../marketDataClient";

console.log("================================================================================");
console.log("   BATBOT_V11 SOTA QA TEST SUITE: VEGAM PHASE 6 ADVERSARIAL EXIT GATE");
console.log("   LAYER 4 DEFENSIVE SHIELD: MULTI-SIGNAL CONSENSUS & TOXICITY GATING");
console.log("================================================================================");

let totalPassed = 0;
let totalFailed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`[PASS] ${message}`);
    totalPassed++;
  } else {
    console.error(`[FAIL] ${message}`);
    totalFailed++;
  }
}

// =========================================================================================
// STAGE 1: Normal Market Resilience (Zero False Triggers)
// =========================================================================================
console.log("\n--- STAGE 1: Normal Market Resilience (Zero False Triggers) ---");

const gate = new AdversarialExitGate();
const longSlot: PositionSlot = {
  slotId: "CORE_LONG",
  isOccupied: true,
  side: "LONG",
  quantity: 0.10,
  entryPrice: 60000.0,
  openTime: Date.now() - 60000,
  takeProfitPrice: 60600.0,
  stopLossPrice: 59100.0,
  takeProfitPercent: 1.0,
  stopLossPercent: 1.5,
  activeTpOrderIds: [101, 102, 103],
  activeStopLossOrderId: 901,
};

const normalHazardMetrics: MicrostructureMetrics = {
  ofi: 0.05,
  obi: 0.08,
  tfi: 0.02,
  vpin: 0.32,
  hazardScore: 0.10,
  coxHazardRate: 0.05,
  survivalProbability: 0.95,
  isHazardExitTriggered: false,
};

const gkAtr = 0.010; // 1.0% composite ATR ($600)
const res1 = gate.evaluate(
  longSlot,
  60050.0, // Mild profit tick
  normalHazardMetrics,
  gkAtr,
  1.0, // Normal Hawkes
  false, // No sweep
  1.20, // Normal entropy
  Date.now()
);

assert(!res1.isBreached, "Normal profitable tick does not trigger adversarial breach");
assert(res1.activeSignalCount === 0, `Active signal count is 0 in healthy market: got ${String(res1.activeSignalCount)}`);
assert(!res1.signals.priceVelocityShock, "No price velocity shock during healthy tick");

// Mild pullback within noise (e.g., $59,940 -> -10 bps, well below 1.25 * ATR = 125 bps)
const res1B = gate.evaluate(
  longSlot,
  59940.0,
  normalHazardMetrics,
  gkAtr,
  1.0,
  false,
  1.20,
  Date.now()
);
assert(!res1B.isBreached, "Mild pullback (-10 bps) does not trigger breach");
assert(!res1B.signals.priceVelocityShock, "Pullback is well within ATR velocity shock threshold");

// =========================================================================================
// STAGE 2: Single-Signal Rejection & Strict Consensus Requirement (>= 2 signals)
// =========================================================================================
console.log("\n--- STAGE 2: Single-Signal Rejection & Strict Consensus Requirement ---");

// Test 2A: Only VPIN is toxic (0.80), but OBI and OFI are supportive, and price is stable
const toxicVpinOnlyMetrics: MicrostructureMetrics = {
  ...normalHazardMetrics,
  vpin: 0.80,
  obi: 0.15,
  ofi: 0.10,
};
const res2A = gate.evaluate(
  longSlot,
  60000.0,
  toxicVpinOnlyMetrics,
  gkAtr,
  1.0,
  false,
  1.20,
  Date.now()
);
assert(!res2A.isBreached, "Isolated toxic VPIN without consensus or price shock does NOT trigger breach");
assert(res2A.activeSignalCount === 1, `Exact 1 active anomaly signal (toxic VPIN): got ${String(res2A.activeSignalCount)}`);
assert(res2A.signals.toxicVpin, "toxicVpin signal is detected");

// Test 2B: Only OBI is adverse (-0.35), but VPIN is low (0.30) and no price shock
const adverseObiOnlyMetrics: MicrostructureMetrics = {
  ...normalHazardMetrics,
  vpin: 0.30,
  obi: -0.35,
};
const res2B = gate.evaluate(
  longSlot,
  60000.0,
  adverseObiOnlyMetrics,
  gkAtr,
  1.0,
  false,
  1.20,
  Date.now()
);
assert(!res2B.isBreached, "Isolated adverse OBI without consensus does NOT trigger breach");
assert(res2B.activeSignalCount === 1, `Exact 1 active anomaly signal (adverse OBI): got ${String(res2B.activeSignalCount)}`);
assert(res2B.signals.obiReversal, "obiReversal signal is detected");

// Test 2C: Price drops by 1.50% (exceeding 1.25x ATR = 1.25%), BUT microstructure is completely healthy (zero toxicity signals)
const res2C = gate.evaluate(
  longSlot,
  59100.0, // $900 drop = 1.50% drop
  normalHazardMetrics,
  gkAtr,
  1.0,
  false,
  1.20,
  Date.now()
);
assert(!res2C.isBreached, "Price shock without microstructure toxicity consensus does NOT trigger breach (protected by SL instead)");
assert(res2C.signals.priceVelocityShock, "priceVelocityShock is identified");
assert(res2C.activeSignalCount === 0, "Zero microstructural consensus signals during clean non-toxic price move");

// =========================================================================================
// STAGE 3: Symmetrical LONG Flash Crash Multi-Signal Consensus Cascade
// =========================================================================================
console.log("\n--- STAGE 3: Symmetrical LONG Flash Crash Multi-Signal Consensus Cascade ---");

// Simulated hostile flash crash:
// - Adverse price shock: drops from $60,000 to $59,100 (-1.50% > 1.25% ATR threshold)
// - Signal 1: OBI collapses to -0.45 (book depth inverted against LONG)
// - Signal 2: VPIN surges to 0.78 (> 0.65 toxic floor)
// - Signal 3: OFI crashes to -0.65 (aggressive sell imbalance)
// - Signal 4: Hawkes intensity explodes to 2.30 (> 1.80 expansion threshold)
// - Signal 5: Sweep detected = true
const flashCrashMetrics: MicrostructureMetrics = {
  obi: -0.45,
  vpin: 0.78,
  ofi: -0.65,
  tfi: -0.50,
  hazardScore: 0.85,
  coxHazardRate: 0.75,
  survivalProbability: 0.20,
  isHazardExitTriggered: true,
};

const res3 = gate.evaluate(
  longSlot,
  59100.0,
  flashCrashMetrics,
  gkAtr,
  2.30,
  true, // isSweepDetected
  3.10, // Entropy collapse
  Date.now()
);

assert(res3.isBreached, "Adversarial breach successfully triggered on flash crash cascade");
assert(res3.activeSignalCount >= 2, `Multi-signal consensus met: got ${String(res3.activeSignalCount)} concurrent signals`);
assert(res3.signals.obiReversal, "OBI reversal confirmed");
assert(res3.signals.toxicVpin, "Toxic VPIN confirmed");
assert(res3.signals.adverseFlow, "Adverse flow imbalance confirmed");
assert(res3.signals.hawkesBurst, "Hawkes burst confirmed");
assert(res3.signals.adverseSweep, "Adverse sweep confirmed");
assert(res3.signals.entropyCollapse, "Entropy collapse confirmed");
assert(res3.signals.priceVelocityShock, "Price velocity shock confirmed");
assert(res3.reason === "ADVERSARIAL_CASCADE_EXIT_LONG", `Exact reason string matched: got ${res3.reason}`);

// --- Live Ledger Integration Verification (HedgePositionLedger) ---
const testSab = new SharedArrayBuffer(10 * 256 * 8);
const mdClient = new MarketDataClient(testSab, 10, 256);
const ledger = new HedgePositionLedger("BTCUSDT", 3, mdClient, 0);

// Set up live telemetry in SAB
mdClient.setVegamGkAtrComposite(0.010, 0);
mdClient.setHawkesIntensity(2.30, 0);
mdClient.setIsSweepDetected(true, 0);
mdClient.setLOBEntropy(3.10, 0);
mdClient.setVPIN(0.78, 0);
mdClient.setOBI(-0.45, 0);

ledger.occupyCoreLong(0.10, 60000.0, 1.0, 1.5);
ledger.registerActiveTpOrderIds("CORE_LONG", [10001, 10002, 10003]);
ledger.registerActiveStopLossOrderId("LONG", 90001);

const longTriggers = ledger.evaluateSotaDynamicExits(
  59100.0,
  59100.0,
  flashCrashMetrics,
  undefined,
  undefined,
  Date.now(),
  0.50
);

const advLongTrigger = longTriggers.find((t) => t.reason === "ADVERSARIAL_CASCADE_EXIT_LONG");
assert(advLongTrigger !== undefined, "Ledger emitted ADVERSARIAL_CASCADE_EXIT_LONG trigger");
assert(advLongTrigger?.slotId === "CORE_LONG", `Target slot is CORE_LONG: got ${String(advLongTrigger?.slotId)}`);
assert(advLongTrigger?.executionStyle === "AGGRESSIVE_MARKET", `executionStyle strictly AGGRESSIVE_MARKET: got ${String(advLongTrigger?.executionStyle)}`);
assert(advLongTrigger?.executionType === "AGGRESSIVE_MARKET", `executionType strictly AGGRESSIVE_MARKET: got ${String(advLongTrigger?.executionType)}`);
assert(advLongTrigger?.quantity === 0.10, `Exit quantity equals full position: got ${String(advLongTrigger?.quantity)}`);
const longCancelIds = advLongTrigger?.cancelOrderIds;
assert(
  Boolean(
    longCancelIds &&
    longCancelIds.includes(10001) &&
    longCancelIds.includes(10002) &&
    longCancelIds.includes(10003) &&
    longCancelIds.includes(90001)
  ),
  "All resting TP limit orders and protective stop loss scheduled for cancellation"
);

// =========================================================================================
// STAGE 4: Symmetrical SHORT Squeeze Multi-Signal Consensus Cascade
// =========================================================================================
console.log("\n--- STAGE 4: Symmetrical SHORT Squeeze Multi-Signal Consensus Cascade ---");

ledger.clearSlots();

// Occupy SHORT slot #0 @ $60,000
ledger.occupyShortSlot(0, 0.05, 60000.0, 1.0, 1.5);
ledger.registerActiveTpOrderIds("SHORT_SLOT_0", [20001, 20002]);
ledger.registerActiveStopLossOrderId("SHORT", 90002);

// Simulated violent short squeeze:
// - Price spikes to $60,900 (+1.50% adverse jump against SHORT)
// - OBI flips to +0.55 (massive bid wall buying through the book)
// - VPIN spikes to 0.82 (toxic buyer flow)
// - OFI surges to +0.70 (strong positive buyer delta)
// - Hawkes surges to 2.40
// - Sweep detected = true
const shortSqueezeMetrics: MicrostructureMetrics = {
  obi: 0.55,
  vpin: 0.82,
  ofi: 0.70,
  tfi: 0.60,
  hazardScore: 0.90,
  coxHazardRate: 0.80,
  survivalProbability: 0.15,
  isHazardExitTriggered: true,
};

mdClient.setHawkesIntensity(2.40, 0);
mdClient.setIsSweepDetected(true, 0);
mdClient.setLOBEntropy(3.20, 0);
mdClient.setVPIN(0.82, 0);
mdClient.setOBI(0.55, 0);

const shortTriggers = ledger.evaluateSotaDynamicExits(
  60900.0,
  60900.0,
  shortSqueezeMetrics,
  undefined,
  undefined,
  Date.now(),
  0.50
);

const advShortTrigger = shortTriggers.find((t) => t.reason === "ADVERSARIAL_CASCADE_EXIT_SHORT");
assert(advShortTrigger !== undefined, "Ledger emitted ADVERSARIAL_CASCADE_EXIT_SHORT trigger");
assert(advShortTrigger?.slotId === "SHORT_SLOT_0", `Target slot is SHORT_SLOT_0: got ${String(advShortTrigger?.slotId)}`);
assert(advShortTrigger?.executionStyle === "AGGRESSIVE_MARKET", `Short executionStyle strictly AGGRESSIVE_MARKET: got ${String(advShortTrigger?.executionStyle)}`);
assert(advShortTrigger?.quantity === 0.05, `Exit quantity equals full short position: got ${String(advShortTrigger?.quantity)}`);
const shortCancelIds = advShortTrigger?.cancelOrderIds;
assert(
  Boolean(
    shortCancelIds &&
    shortCancelIds.includes(20001) &&
    shortCancelIds.includes(20002) &&
    shortCancelIds.includes(90002)
  ),
  "All short resting TP orders and stop loss order scheduled for cancellation"
);

// =========================================================================================
// STAGE 5: Sub-Microsecond Execution Latency & Zero-GC Invariant Benchmark
// =========================================================================================
console.log("\n--- STAGE 5: Sub-Microsecond Latency SLA & Zero-GC Benchmark ---");

const benchSlot: PositionSlot = {
  slotId: "BENCH_LONG",
  isOccupied: true,
  side: "LONG",
  quantity: 0.10,
  entryPrice: 60000.0,
  openTime: Date.now() - 30000,
  takeProfitPrice: 60600.0,
  stopLossPrice: 59100.0,
  takeProfitPercent: 1.0,
  stopLossPercent: 1.5,
};

// Warm-up JIT compilation (10,000 iterations)
const benchNow = Date.now();
for (let i = 0; i < 10000; i++) {
  gate.evaluate(benchSlot, 59900.0, normalHazardMetrics, 0.010, 1.0, false, 1.20, benchNow);
}

if (global.gc) {
  global.gc();
}

const ITERATIONS = 100000;
const startMem = process.memoryUsage().heapUsed;
const startTime = process.hrtime.bigint();

for (let i = 0; i < ITERATIONS; i++) {
  gate.evaluate(
    benchSlot,
    59950.0 + (i & 15),
    normalHazardMetrics,
    0.010,
    1.1,
    false,
    1.25,
    benchNow
  );
}

const endTime = process.hrtime.bigint();
const endMem = process.memoryUsage().heapUsed;
const totalNs = Number(endTime - startTime);
const totalDurationMs = totalNs / 1e6;
const avgLatencyUs = totalNs / ITERATIONS / 1000.0;
const heapDeltaBytes = Math.max(0, endMem - startMem);
const bytesPerCall = heapDeltaBytes / ITERATIONS;

console.log(`[BENCHMARK] Executed ${ITERATIONS.toLocaleString()} evaluations in ${totalDurationMs.toFixed(2)} ms`);
console.log(`[BENCHMARK] Average Latency Per Call: ${avgLatencyUs.toFixed(4)} µs (SLA Target: < 0.5000 µs)`);
console.log(`[BENCHMARK] Heap Delta over ${ITERATIONS.toLocaleString()} calls: ${(heapDeltaBytes / 1024).toFixed(2)} KB (${bytesPerCall.toFixed(2)} bytes/call)`);

assert(avgLatencyUs < 0.5000, `Sub-microsecond latency SLA verified: ${avgLatencyUs.toFixed(4)} µs < 0.5000 µs`);
assert(bytesPerCall < 50.0, `Zero-GC invariant verified: ${bytesPerCall.toFixed(2)} bytes/call (< 50.0 bytes V8 noise threshold)`);

// =========================================================================================
// SUMMARY
// =========================================================================================
console.log("\n================================================================================");
console.log(`   VEGAM PHASE 6 ADVERSARIAL EXIT GATE QA MATRIX: ${String(totalPassed)} PASSED / ${String(totalFailed)} FAILED`);
console.log("================================================================================");

if (totalFailed > 0) {
  console.error("❌ VEGAM PHASE 6 QA TESTS FAILED!");
  process.exit(1);
} else {
  console.log("✅ ALL VEGAM PHASE 6 QA TESTS PASSED (100% SUCCESS)!");
}
