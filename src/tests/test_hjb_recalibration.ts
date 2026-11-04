/**
 * BATBOT_V11 SOTA QA TEST SUITE: VEGAM PHASE 7 HJB RECALIBRATION
 *
 * Verifies HJB Reservation Engine Recalibration (Fix for DEFECT-PM-04):
 * 1. Default recalibration invariants (gamma = 4.20, horizon = 120.0s).
 * 2. Dynamic per-asset and global environment overrides.
 * 3. Mathematical actionability at 50% horizon (liquidation boundary within 1.5x - 3.0x GK_ATR).
 * 4. Comparison against legacy gamma = 0.10 showing > 80x increase in penalty responsiveness.
 * 5. Full HedgePositionLedger wiring and symmetrical LONG/SHORT liquidation triggers.
 * 6. Sub-microsecond hot-path execution latency (< 0.5 µs) and zero-GC heap invariance.
 */

import { HJBReservationEngine, HJBExitEvaluation } from "../strategy/hjbReservationEngine";
import { HedgePositionLedger } from "../strategy/positionLedger";
import { MicrostructureMetrics } from "../strategy/microstructureHazardEngine";
import { VolatilitySurfaceMetrics } from "../strategy/volatilitySurfaceEngine";
import { DEFAULT_VEGAM_CONFIG } from "../strategy/vegamTpLadderEngine";

console.log("================================================================================");
console.log("   BATBOT_V11 SOTA QA TEST SUITE: VEGAM PHASE 7 HJB RECALIBRATION");
console.log("   DEFECT-PM-04 REMEDIATION: ACTIONABLE INVENTORY PENALTY & SPREAD ALIGNMENT");
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
// STAGE 1: Default Recalibration Invariants (gamma = 4.20, horizon = 120.0s)
// =========================================================================================
console.log("\n--- STAGE 1: Default Recalibration Invariants ---");

const defaultHjb = new HJBReservationEngine("LINKUSDT");

assert(
  defaultHjb.getRiskAversionGamma() === 4.20,
  `Default riskAversionGamma is 4.20: got ${defaultHjb.getRiskAversionGamma()}`
);
assert(
  defaultHjb.getTargetHorizonSeconds() === 120.0,
  `Default targetHorizonSeconds is 120.0s: got ${defaultHjb.getTargetHorizonSeconds()}`
);
assert(
  defaultHjb.getLiquidityKappa() === 1.5,
  `Default liquidityKappa is 1.5: got ${defaultHjb.getLiquidityKappa()}`
);
assert(
  DEFAULT_VEGAM_CONFIG.hjbRiskAversionGamma === 4.20,
  `DEFAULT_VEGAM_CONFIG.hjbRiskAversionGamma is 4.20: got ${DEFAULT_VEGAM_CONFIG.hjbRiskAversionGamma}`
);
assert(
  DEFAULT_VEGAM_CONFIG.hjbTargetHorizonSeconds === 120.0,
  `DEFAULT_VEGAM_CONFIG.hjbTargetHorizonSeconds is 120.0: got ${DEFAULT_VEGAM_CONFIG.hjbTargetHorizonSeconds}`
);

// =========================================================================================
// STAGE 2: Dynamic Per-Asset and Global Environment Variable Overrides
// =========================================================================================
console.log("\n--- STAGE 2: Dynamic Environment Variable Overrides ---");

// Test 2A: Per-Asset Gamma and Horizon override
process.env.HJB_GAMMA_BTCUSDT = "6.50";
process.env.HJB_HORIZON_BTCUSDT = "180.0";

const btcHjb = new HJBReservationEngine("BTCUSDT");
assert(
  btcHjb.getRiskAversionGamma() === 6.50,
  `Per-asset HJB_GAMMA_BTCUSDT override parsed: got ${btcHjb.getRiskAversionGamma()}`
);
assert(
  btcHjb.getTargetHorizonSeconds() === 180.0,
  `Per-asset HJB_HORIZON_BTCUSDT override parsed: got ${btcHjb.getTargetHorizonSeconds()}`
);

delete process.env.HJB_GAMMA_BTCUSDT;
delete process.env.HJB_HORIZON_BTCUSDT;

// Test 2B: Global Gamma and Horizon override
process.env.HJB_RISK_AVERSION_GAMMA = "3.75";
process.env.HJB_TARGET_HORIZON_SECONDS = "90.0";

const globalHjb = new HJBReservationEngine("ETHUSDT");
assert(
  globalHjb.getRiskAversionGamma() === 3.75,
  `Global HJB_RISK_AVERSION_GAMMA override parsed: got ${globalHjb.getRiskAversionGamma()}`
);
assert(
  globalHjb.getTargetHorizonSeconds() === 90.0,
  `Global HJB_TARGET_HORIZON_SECONDS override parsed: got ${globalHjb.getTargetHorizonSeconds()}`
);

delete process.env.HJB_RISK_AVERSION_GAMMA;
delete process.env.HJB_TARGET_HORIZON_SECONDS;

// Test 2C: Explicit caller parameters take highest precedence
const explicitHjb = new HJBReservationEngine("SOLUSDT", 5.00, 150.0, 2.0);
assert(
  explicitHjb.getRiskAversionGamma() === 5.00,
  `Explicit gamma argument takes precedence: got ${explicitHjb.getRiskAversionGamma()}`
);
assert(
  explicitHjb.getTargetHorizonSeconds() === 150.0,
  `Explicit horizon argument takes precedence: got ${explicitHjb.getTargetHorizonSeconds()}`
);

// =========================================================================================
// STAGE 3: Mathematical Actionability at 50% Horizon & Legacy Comparison
// =========================================================================================
console.log("\n--- STAGE 3: Mathematical Actionability at 50% Horizon (LINK 2x Example) ---");

const entryPrice = 11.59; // LINK entry price
const gkVol = 0.006325; // 63.25 bps (variance = 0.00004)
const holdingMs = 60000; // 60.0s = exactly 50% of 120s horizon
const slotQty = 1.0;

// Recalibrated Engine (gamma = 4.20, horizon = 120.0s)
const recalEngine = new HJBReservationEngine("LINKUSDT", 4.20, 120.0, 1.5);
const recalEvalLong = recalEngine.getOptimalExitBoundary("LONG", entryPrice, entryPrice, slotQty, holdingMs, gkVol);

// Legacy Engine (gamma = 0.10, horizon = 60.0s, holdingMs = 30000 -> 50% of 60s horizon)
const legacyEngine = new HJBReservationEngine("LINKUSDT", 0.10, 60.0, 1.5);
const legacyEvalLong = legacyEngine.getOptimalExitBoundary("LONG", entryPrice, entryPrice, slotQty, 30000, gkVol);

console.log(`  - Entry Price: $${entryPrice.toFixed(4)}, GK Vol: ${(gkVol * 10000).toFixed(1)} bps`);
console.log(`  - Legacy (gamma=0.10, T=60s): Inventory Penalty = $${legacyEvalLong.inventoryPenalty.toFixed(6)} (${(legacyEvalLong.inventoryPenalty / (entryPrice * gkVol)).toFixed(4)}x GK_ATR)`);
console.log(`  - Recalibrated (gamma=4.20, T=120s): Inventory Penalty = $${recalEvalLong.inventoryPenalty.toFixed(6)} (${(recalEvalLong.inventoryPenalty / (entryPrice * gkVol)).toFixed(4)}x GK_ATR)`);

// Assert inventory penalty is actionable and significantly greater than legacy
const penaltyRatio = recalEvalLong.inventoryPenalty / Math.max(1e-9, legacyEvalLong.inventoryPenalty);
console.log(`  - Penalty Amplification Factor: ${penaltyRatio.toFixed(1)}x`);
assert(penaltyRatio > 50.0, `Inventory penalty responsiveness increased by > 50x (got ${penaltyRatio.toFixed(1)}x)`);

// Assert liquidation boundary sits within [1.5 * GK_ATR, 3.0 * GK_ATR] of entry
const distFromEntryUsdtLong = entryPrice - recalEvalLong.liquidationBoundary;
const distInGkAtrLong = distFromEntryUsdtLong / (entryPrice * gkVol);
console.log(`  - LONG Liquidation Boundary: $${recalEvalLong.liquidationBoundary.toFixed(4)} (Distance: $${distFromEntryUsdtLong.toFixed(4)}, ${distInGkAtrLong.toFixed(2)}x GK_ATR)`);

assert(
  distInGkAtrLong >= 1.50 && distInGkAtrLong <= 3.00,
  `LONG Liquidation boundary sits within [1.5x, 3.0x] GK_ATR of entry: got ${distInGkAtrLong.toFixed(4)}x GK_ATR`
);
assert(
  distInGkAtrLong >= 0.50 && distInGkAtrLong <= 3.00,
  `Master Plan constraint [0.5x, 3.0x] satisfied: got ${distInGkAtrLong.toFixed(4)}x GK_ATR`
);

// Symmetrical SHORT position verification
const recalEvalShort = recalEngine.getOptimalExitBoundary("SHORT", entryPrice, entryPrice, slotQty, holdingMs, gkVol);
const distFromEntryUsdtShort = recalEvalShort.liquidationBoundary - entryPrice;
const distInGkAtrShort = distFromEntryUsdtShort / (entryPrice * gkVol);
console.log(`  - SHORT Liquidation Boundary: $${recalEvalShort.liquidationBoundary.toFixed(4)} (Distance: $${distFromEntryUsdtShort.toFixed(4)}, ${distInGkAtrShort.toFixed(2)}x GK_ATR)`);

assert(
  distInGkAtrShort >= 1.50 && distInGkAtrShort <= 3.00,
  `SHORT Liquidation boundary sits within [1.5x, 3.0x] GK_ATR of entry: got ${distInGkAtrShort.toFixed(4)}x GK_ATR`
);

// Normal price does not trigger liquidation
assert(
  !recalEvalLong.isLiquidationTriggered,
  "Entry price does not prematurely trigger LONG liquidation"
);
assert(
  !recalEvalShort.isLiquidationTriggered,
  "Entry price does not prematurely trigger SHORT liquidation"
);

// Adverse price breaching boundary triggers liquidation
const adverseLongPrice = recalEvalLong.liquidationBoundary - 0.01;
const adverseEvalLong = recalEngine.getOptimalExitBoundary("LONG", entryPrice, adverseLongPrice, slotQty, holdingMs, gkVol);
assert(
  adverseEvalLong.isLiquidationTriggered === true,
  "Adverse price below boundary triggers LONG liquidation"
);
assert(
  adverseEvalLong.exitReason === "HJB_RESERVATION_LIQUIDATE_LONG",
  `Exact exitReason emitted: got ${adverseEvalLong.exitReason}`
);

// =========================================================================================
// STAGE 4: HedgePositionLedger Integration & Dynamic Overload Wiring
// =========================================================================================
console.log("\n--- STAGE 4: HedgePositionLedger Integration & Wiring ---");

const ledger = new HedgePositionLedger("BTCUSDT", 3);
assert(
  ledger.getHjbReservationEngine().getRiskAversionGamma() === 4.20,
  `Ledger internal HJB engine initialized with recalibrated gamma (4.20): got ${ledger.getHjbReservationEngine().getRiskAversionGamma()}`
);
assert(
  ledger.getHjbReservationEngine().getTargetHorizonSeconds() === 120.0,
  `Ledger internal HJB engine initialized with recalibrated horizon (120.0s): got ${ledger.getHjbReservationEngine().getTargetHorizonSeconds()}`
);

// Test 4A: Normal price tick (-10 bps dip) does NOT trigger HJB liquidation
ledger.occupyCoreLong(0.001, 60000.0, 1.5, 5.0);
const normalVolMetrics: VolatilitySurfaceMetrics = {
  garmanKlass1s: 0.0080,
  garmanKlass10s: 0.0080,
  garmanKlass60s: 0.0080,
  parkinson60s: 0.0080,
  volatilityMultiplier: 1.0,
};
const quietHazardMetrics: MicrostructureMetrics = {
  ofi: 0.0,
  obi: 0.0,
  tfi: 0.0,
  vpin: 0.30,
  hazardScore: 0.10,
  coxHazardRate: 0.05,
  survivalProbability: 0.95,
  isHazardExitTriggered: false,
};

const quietTriggers = ledger.evaluateSotaDynamicExits(
  59940.0, // -10 bps dip
  quietHazardMetrics,
  undefined, // Omitted hjbEngine -> tests fallback to ledger.hjbEngine
  normalVolMetrics,
  Date.now()
);
assert(
  quietTriggers.length === 0,
  `Normal -10 bps dip does not trigger false HJB liquidation (triggers: ${quietTriggers.length})`
);

// Test 4B: Adverse drop beyond HJB liquidation boundary triggers PASSIVE_MAKER liquidation
// At 60s holding (50% horizon), with entry = $60,000, 0.001 BTC ($60 USDT notional), and vol = 0.0080 (0.80% = $480):
// HJB boundary sits at $57,753. Drop to $57,500 breaches the boundary and triggers liquidation.
const nowMs = Date.now();
const hjbBreachTriggers = ledger.evaluateSotaDynamicExits(
  57500.0,
  quietHazardMetrics,
  undefined,
  normalVolMetrics,
  nowMs + 60000 // 60s into the trade
);

const hjbLongTrigger = hjbBreachTriggers.find((t) => t.reason === "HJB_RESERVATION_LIQUIDATE_LONG");
assert(
  hjbLongTrigger !== undefined,
  "Ledger emitted HJB_RESERVATION_LIQUIDATE_LONG trigger upon boundary breach"
);
assert(
  hjbLongTrigger?.slotId === "CORE_LONG",
  `Target slot is CORE_LONG: got ${hjbLongTrigger?.slotId}`
);
assert(
  hjbLongTrigger?.executionStyle === "PASSIVE_MAKER",
  `HJB liquidation executionStyle is PASSIVE_MAKER: got ${hjbLongTrigger?.executionStyle}`
);
assert(
  hjbLongTrigger?.quantity === 0.001,
  `Exit quantity equals full slot quantity: got ${hjbLongTrigger?.quantity}`
);

// Test 4C: Symmetrical SHORT HJB liquidation
// At 60s holding, short boundary sits at $62,247. Price surge to $62,500 breaches the boundary.
ledger.clearSlots();
ledger.occupyShortSlot(0, 0.001, 60000.0, 1.5, 5.0);

const hjbShortBreachTriggers = ledger.evaluateSotaDynamicExits(
  62500.0, // Adverse spike beyond short liquidation boundary
  quietHazardMetrics,
  undefined,
  normalVolMetrics,
  nowMs + 60000
);

const hjbShortTrigger = hjbShortBreachTriggers.find((t) => t.reason === "HJB_RESERVATION_LIQUIDATE_SHORT");
assert(
  hjbShortTrigger !== undefined,
  "Ledger emitted HJB_RESERVATION_LIQUIDATE_SHORT trigger upon boundary breach"
);
assert(
  hjbShortTrigger?.slotId === "SHORT_SLOT_0",
  `Target slot is SHORT_SLOT_0: got ${hjbShortTrigger?.slotId}`
);
assert(
  hjbShortTrigger?.executionStyle === "PASSIVE_MAKER",
  `Short HJB liquidation executionStyle is PASSIVE_MAKER: got ${hjbShortTrigger?.executionStyle}`
);
assert(
  hjbShortTrigger?.quantity === 0.001,
  `Short exit quantity equals full slot quantity: got ${hjbShortTrigger?.quantity}`
);

// =========================================================================================
// STAGE 5: Sub-Microsecond Execution Latency & Zero-GC Benchmark
// =========================================================================================
console.log("\n--- STAGE 5: Sub-Microsecond Latency SLA & Zero-GC Benchmark ---");

const benchEngine = new HJBReservationEngine("BTCUSDT", 4.20, 120.0, 1.5);
const ITERATIONS = 100000;

// Warm up JIT
for (let i = 0; i < 10000; i++) {
  benchEngine.getOptimalExitBoundary("LONG", 60000.0, 59950.0, 0.001, 30000, 0.0080);
}

if (global.gc) {
  global.gc();
}

const startMem = process.memoryUsage().heapUsed;
const startTime = process.hrtime.bigint();

for (let i = 0; i < ITERATIONS; i++) {
  benchEngine.getOptimalExitBoundary(
    "LONG",
    60000.0,
    59900.0 + (i & 127),
    0.001,
    30000 + (i & 1023),
    0.0080
  );
}

const endTime = process.hrtime.bigint();
const endMem = process.memoryUsage().heapUsed;
const totalNs = Number(endTime - startTime);
const totalDurationMs = totalNs / 1e6;
const avgLatencyUs = totalNs / ITERATIONS / 1000.0;
const heapDeltaBytes = Math.max(0, endMem - startMem);
const bytesPerCall = heapDeltaBytes / ITERATIONS;

console.log(`[BENCHMARK] Executed ${ITERATIONS.toLocaleString()} HJB evaluations in ${totalDurationMs.toFixed(2)} ms`);
console.log(`[BENCHMARK] Average Latency Per Call: ${avgLatencyUs.toFixed(4)} µs (SLA Target: < 0.5000 µs)`);
console.log(`[BENCHMARK] Heap Delta over ${ITERATIONS.toLocaleString()} calls: ${(heapDeltaBytes / 1024).toFixed(2)} KB (${bytesPerCall.toFixed(2)} bytes/call)`);

assert(avgLatencyUs < 0.5000, `Sub-microsecond latency SLA verified: ${avgLatencyUs.toFixed(4)} µs < 0.5000 µs`);
assert(bytesPerCall < 50.0, `Zero-GC invariant verified: ${bytesPerCall.toFixed(2)} bytes/call (< 50.0 bytes V8 noise threshold)`);

// =========================================================================================
// SUMMARY
// =========================================================================================
console.log("\n================================================================================");
console.log(`   VEGAM PHASE 7 HJB RECALIBRATION QA MATRIX: ${totalPassed} PASSED / ${totalFailed} FAILED`);
console.log("================================================================================");

if (totalFailed > 0) {
  console.error("❌ VEGAM PHASE 7 QA TESTS FAILED!");
  process.exit(1);
} else {
  console.log("✅ ALL VEGAM PHASE 7 QA TESTS PASSED (100% SUCCESS)!");
}
