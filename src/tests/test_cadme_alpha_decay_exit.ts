/**
 * BATBOT_V11 SOTA QA TEST SUITE: VEGAM PHASE 4 (CADME INTEGRATION)
 *
 * Verifies Layer 3: AI Alpha Decay Managed Exit (CADME)
 * Mathematical Specifications:
 * 1. Ornstein-Uhlenbeck Modeled Decay: alpha(tau) = IC_entry * exp(-ln2 * durationSec / halfLifeSec)
 * 2. Dual-Confirmation Trigger Gate:
 *    - Modeled Decay: alphaDecay < IC_entry * 0.60
 *    - Live Market Confirmation: liveIc < IC_entry * 0.75 (from SAB Slot 101)
 * 3. Passive Maker Unwind: executionStyle / executionType = "PASSIVE_MAKER"
 * 4. Slot State Progression: cadmeState in {0=INACTIVE, 1=MONITORING, 2=EXIT_TRIGGERED}
 * 5. SAB Slot 158 Telemetry Bitcasting Sync
 */

import { HedgePositionLedger } from "../strategy/positionLedger";
import { MarketDataClient } from "../marketDataClient";

console.log("================================================================================");
console.log("   BATBOT_V11 SOTA QA TEST SUITE: VEGAM PHASE 4 CADME INTEGRATION");
console.log("   ORNSTEIN-UHLENBECK ALPHA DECAY & DUAL-CONFIRMATION PASSIVE MAKER EXITS");
console.log("================================================================================");

let totalPassed = 0;
let totalFailed = 0;

function assert(condition: boolean, testName: string): void {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    totalPassed++;
  } else {
    console.error(`[FAIL] ${testName}`);
    totalFailed++;
    process.exitCode = 1;
  }
}

// -------------------------------------------------------------------------
// Setup SharedArrayBuffer and MarketDataClient
// -------------------------------------------------------------------------
const maxAssets = 10;
const slotsPerAsset = 256;
const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
const mdClient = new MarketDataClient(sab, maxAssets, slotsPerAsset);

const assetIndex = 0; // BTCUSDT
const symbol = "BTCUSDT";

// =========================================================================================
// STAGE 1: Slot Occupation & Atomic IC Capture via SAB Slot 101
// =========================================================================================
console.log("\n--- STAGE 1: Slot Occupation & Atomic IC Capture via SAB Slot 101 ---");

const initialEwmaIc = 0.050; // High entry IC
mdClient.setRollingIC(initialEwmaIc, assetIndex);
assert(
  Math.abs(mdClient.getRollingIC(assetIndex) - initialEwmaIc) < 1e-9,
  `SAB Slot 101 (ROLLING_IC) successfully stored: got ${String(mdClient.getRollingIC(assetIndex))}`
);

const ledger = new HedgePositionLedger(symbol, 3, mdClient, assetIndex);
const entryPrice = 60000.0;
const entryQty = 0.10;


// Occupy Core Long slot
ledger.occupyCoreLong(entryQty, entryPrice, 1.0, 1.0);
const coreLong = ledger.getCoreLong();

assert(coreLong.isOccupied, "Core Long slot is successfully occupied");
assert(
  Math.abs((coreLong.icAtEntry ?? 0) - initialEwmaIc) < 1e-9,
  `Core Long slot captured live EWMA IC from SAB Slot 101: expected ${String(initialEwmaIc)}, got ${String(coreLong.icAtEntry)}`
);
assert(coreLong.cadmeState === 0, `Initial cadmeState is 0 (INACTIVE): got ${String(coreLong.cadmeState)}`);

// =========================================================================================
// STAGE 2: Prime Alpha Trade Immunity (tau = 0.2 * halfLifeSec)
// =========================================================================================
console.log("\n--- STAGE 2: Prime Alpha Trade Immunity (tau = 0.2 * halfLifeSec) ---");

// Fixed Hurst = 0.50 -> Neutral baseline halfLifeSec = 120.0s (matching HedgePositionLedger default)
const halfLifeSec = 120.0;
assert(
  Math.abs(ledger.getMhdcDefaultHalfLifeSec() - halfLifeSec) < 1e-9,
  `HedgePositionLedger neutral MHDC default half-life is ${String(halfLifeSec)}s: got ${String(ledger.getMhdcDefaultHalfLifeSec())}`
);
const earlyDurationSec = halfLifeSec * 0.20; // 24.0s -> alphaDecay = 0.050 * 2^-0.2 = 0.0435 > 0.75 * 0.050 (0.0375)
const earlyTime = coreLong.openTime + earlyDurationSec * 1000;

// Tick at mid-price $60,000 (neutral market price)
const earlyTriggers = ledger.evaluateSotaDynamicExits(
  entryPrice,
  entryPrice,
  undefined,
  undefined,
  undefined,
  earlyTime,
  0.50
);

const earlyCadmeTriggers = earlyTriggers.filter((t) => t.reason.startsWith("CADME_ALPHA_DECAY_EXIT"));
assert(
  earlyCadmeTriggers.length === 0,
  `Prime alpha immunity verified: No CADME exit at tau = 0.20*t_half (triggers = ${String(earlyCadmeTriggers.length)})`
);
assert(
  coreLong.cadmeState === 0,
  `cadmeState remains 0 during prime alpha regime (got ${String(coreLong.cadmeState)})`
);

// =========================================================================================
// STAGE 3: Dual-Confirmation Rejection Matrix
// =========================================================================================
console.log("\n--- STAGE 3: Dual-Confirmation Rejection Matrix ---");

// Sub-Test 3A: Modeled Decay Reached (tau = 2 * halfLifeSec), BUT Live IC Persists (liveIc >= 0.75 * icAtEntry)
// alphaDecay = 0.050 * exp(-LN2 * 2) = 0.0125 < 0.050 * 0.60 (0.030) -> Modeled decay condition MET!
// But liveIc = 0.045 >= 0.050 * 0.75 (0.0375) -> Live market condition FAILS!
const lateDurationSec = halfLifeSec * 2.0; // 240.0s
const lateTime = coreLong.openTime + lateDurationSec * 1000;

mdClient.setRollingIC(0.045, assetIndex); // Live IC is still strong
const test3ATriggers = ledger.evaluateSotaDynamicExits(
  entryPrice,
  entryPrice,
  undefined,
  undefined,
  undefined,
  lateTime,
  0.50
);

const cadme3A = test3ATriggers.filter((t) => t.reason.startsWith("CADME_ALPHA_DECAY_EXIT"));
assert(
  cadme3A.length === 0,
  "Dual-confirmation Gate 1 passed: Strong live IC (0.045 >= 0.0375) prevents premature exit despite modeled time decay"
);
assert(
  coreLong.cadmeState === 1,
  `cadmeState advances to 1 (MONITORING) when modeled decay approaches (got ${String(coreLong.cadmeState)})`
);

// Sub-Test 3B: Live IC Drops (liveIc < 0.75 * icAtEntry), BUT Duration is Young (tau = 10s)
// liveIc = 0.010 < 0.0375 -> Live condition MET!
// But duration = 10s -> alphaDecay = 0.050 * exp(-LN2 * 10/120) = 0.0472 > 0.030 -> Modeled condition FAILS!
mdClient.setRollingIC(0.010, assetIndex);
const youngTime = coreLong.openTime + 10.0 * 1000;

const test3BTriggers = ledger.evaluateSotaDynamicExits(
  entryPrice,
  entryPrice,
  undefined,
  undefined,
  undefined,
  youngTime,
  0.50
);

const cadme3B = test3BTriggers.filter((t) => t.reason.startsWith("CADME_ALPHA_DECAY_EXIT"));
assert(
  cadme3B.length === 0,
  "Dual-confirmation Gate 2 passed: Young trade (tau=10s) immune to transient live IC drop (alphaDecay > 0.60*icAtEntry)"
);

// =========================================================================================
// STAGE 4: Successful CADME Trigger Execution (Dual Confirmation Met)
// =========================================================================================
console.log("\n--- STAGE 4: Successful CADME Trigger Execution (Dual Confirmation Met) ---");

// Set both conditions simultaneously:
// 1. tau = 2.0 * halfLifeSec = 240s -> alphaDecay = 0.0125 < 0.030 (0.60 * 0.050)
// 2. liveIc = 0.010 < 0.0375 (0.75 * 0.050)
mdClient.setRollingIC(0.010, assetIndex);

const exitTriggers = ledger.evaluateSotaDynamicExits(
  entryPrice,
  entryPrice,
  undefined,
  undefined,
  undefined,
  lateTime,
  0.50
);

const cadmeExit = exitTriggers.find((t) => t.reason === "CADME_ALPHA_DECAY_EXIT_LONG");
assert(cadmeExit !== undefined, "CADME dual-confirmation trigger fired: found CADME_ALPHA_DECAY_EXIT_LONG");
assert(cadmeExit?.slotId === "CORE_LONG", `Target slotId is CORE_LONG: got ${String(cadmeExit?.slotId)}`);
assert(cadmeExit?.quantity === entryQty, `Exit quantity equals full slot quantity (${String(entryQty)}): got ${String(cadmeExit?.quantity)}`);
assert(cadmeExit?.executionStyle === "PASSIVE_MAKER", `executionStyle strictly PASSIVE_MAKER: got ${String(cadmeExit?.executionStyle)}`);
assert(cadmeExit?.executionType === "PASSIVE_MAKER", `executionType strictly PASSIVE_MAKER: got ${String(cadmeExit?.executionType)}`);
assert(coreLong.cadmeState === 2, `Slot cadmeState strictly updated to 2 (EXIT_TRIGGERED): got ${String(coreLong.cadmeState)}`);

// Verify SAB Slot 158 Telemetry Bitcasting Sync
const sabCadmeState = mdClient.getVegamCadmeState(assetIndex);
assert(sabCadmeState === 2.0, `SAB Slot 158 (VEGAM_CADME_STATE) atomically written: expected 2.0, got ${String(sabCadmeState)}`);

// Test debounce / idempotency: second evaluation tick on triggered state should not flood duplicate triggers
const repeatTriggers = ledger.evaluateSotaDynamicExits(
  entryPrice,
  entryPrice,
  undefined,
  undefined,
  undefined,
  lateTime + 100,
  0.50
);
const repeatCadme = repeatTriggers.filter((t) => t.reason.startsWith("CADME_ALPHA_DECAY_EXIT"));
assert(repeatCadme.length === 0, "Idempotent trigger deduplication: repeat evaluation tick does not re-emit duplicate trigger");

// =========================================================================================
// STAGE 5: Symmetric SHORT Slot CADME Exit Execution
// =========================================================================================
console.log("\n--- STAGE 5: Symmetric SHORT Slot CADME Exit Execution ---");

// Clean release long slot
ledger.releaseCoreLong(entryPrice, 0.0002, "CADME_TEST_CLOSE");

// Set up Short slot with IC = 0.040
mdClient.setRollingIC(0.040, assetIndex);
const shortEntryPrice = 60000.0;
const shortQty = 0.05;
const shortIdx = 0;

ledger.occupyShortSlot(shortIdx, shortQty, shortEntryPrice, 1.0, 1.0);
const shortSlot = ledger.getShortSlots()[shortIdx];

assert(shortSlot.isOccupied, "Short slot #0 is occupied");
assert(
  Math.abs((shortSlot.icAtEntry ?? 0) - 0.040) < 1e-9,
  `Short slot captured live IC (0.040): got ${String(shortSlot.icAtEntry)}`
);
assert(shortSlot.cadmeState === 0, `Short slot initial cadmeState is 0: got ${String(shortSlot.cadmeState)}`);

// Advance duration to 2.0 * halfLifeSec, live IC = 0.008 (< 0.040 * 0.75 = 0.030)
mdClient.setRollingIC(0.008, assetIndex);
const shortLateTime = shortSlot.openTime + halfLifeSec * 2.0 * 1000;

const shortExitTriggers = ledger.evaluateSotaDynamicExits(
  shortEntryPrice,
  shortEntryPrice,
  undefined,
  undefined,
  undefined,
  shortLateTime,
  0.50
);

const shortCadmeExit = shortExitTriggers.find((t) => t.reason === "CADME_ALPHA_DECAY_EXIT_SHORT");
assert(shortCadmeExit !== undefined, "Short slot CADME trigger fired: found CADME_ALPHA_DECAY_EXIT_SHORT");
assert(shortCadmeExit?.slotId === "SHORT_SLOT_0", `Target slotId is SHORT_SLOT_0: got ${String(shortCadmeExit?.slotId)}`);
assert(shortCadmeExit?.executionStyle === "PASSIVE_MAKER", `Short executionStyle is PASSIVE_MAKER: got ${String(shortCadmeExit?.executionStyle)}`);
assert(shortSlot.cadmeState === 2, `Short slot cadmeState updated to 2: got ${String(shortSlot.cadmeState)}`);

// =========================================================================================
// STAGE 6: Clean Slot Release & SAB Reset Verification
// =========================================================================================
console.log("\n--- STAGE 6: Clean Slot Release & SAB Reset Verification ---");

ledger.releaseShortSlot(shortIdx, shortEntryPrice, 0.0002, "CADME_TEST_CLOSE");
assert(!shortSlot.isOccupied, "Short slot #0 is flat");
assert(shortSlot.icAtEntry === 0, `Short slot icAtEntry reset to 0: got ${String(shortSlot.icAtEntry)}`);
assert(shortSlot.cadmeState === 0, `Short slot cadmeState reset to 0: got ${String(shortSlot.cadmeState)}`);

const sabResetState = mdClient.getVegamCadmeState(assetIndex);
assert(sabResetState === 0.0, `SAB Slot 158 atomically reset to 0.0 on slot release: got ${String(sabResetState)}`);

// =========================================================================================
// STAGE 7: CADME State Latching, Stop-Loss Continuity & Multi-Slot SAB 158 Aggregation
// =========================================================================================
console.log("\n--- STAGE 7: CADME State Latching, Stop-Loss Continuity & Multi-Slot SAB 158 Aggregation ---");

// Test 7A: State Latching under oscillating live IC
mdClient.setRollingIC(0.050, assetIndex);
ledger.occupyCoreLong(0.10, 60000.0, 1.0, 1.0);
const testLongSlot = ledger.getCoreLong();

// Force CADME trigger: duration = 240s (2.0 * 120.0s), live IC = 0.010 (< 0.050 * 0.75)
mdClient.setRollingIC(0.010, assetIndex);
const trig1 = ledger.evaluateSotaDynamicExits(60000.0, 60000.0, undefined, undefined, undefined, testLongSlot.openTime + 240000, 0.50);
assert(testLongSlot.cadmeState === 2, "Slot successfully entered cadmeState = 2 (EXIT_TRIGGERED)");
assert(trig1.some((t) => t.reason.startsWith("CADME_ALPHA_DECAY_EXIT")), "First tick emits CADME exit trigger");

// Now oscillate live IC back to high (0.050)
mdClient.setRollingIC(0.050, assetIndex);
const trig2 = ledger.evaluateSotaDynamicExits(60000.0, 60000.0, undefined, undefined, undefined, testLongSlot.openTime + 245000, 0.50);
assert(testLongSlot.cadmeState === 2, `CADME state strictly latched at 2 despite live IC rebound (got ${String(testLongSlot.cadmeState)})`);
assert(
  !trig2.some((t) => t.reason.startsWith("CADME_ALPHA_DECAY_EXIT")),
  "Latched state does not re-emit duplicate CADME exit triggers on subsequent ticks"
);

// Test 7B: Stop-Loss Continuity while passive maker exit rests on book
// Price crashes to $59,000 (below stop loss at $59,400)
const slTriggers = ledger.evaluateSotaDynamicExits(59000.0, 59000.0, undefined, undefined, undefined, testLongSlot.openTime + 246000, 0.50);
assert(
  slTriggers.some((t) => t.reason.includes("STOP_LOSS") || t.reason.includes("TRAILING_STOP")),
  "Hard stop-loss protection remains 100% active while CADME maker exit rests on book"
);

// Test 7C: Multi-Slot SAB 158 Aggregation (No Clobbering by Secondary Inactive Slots)
// Occupy Short Slot 0 while Core Long is in cadmeState = 2
ledger.occupyShortSlot(0, 0.05, 60000.0, 1.0, 1.0);
const testShortSlot0 = ledger.getShortSlots()[0];
assert(testShortSlot0.cadmeState === 0, "Newly occupied Short Slot 0 starts in cadmeState = 0");

// Evaluate dynamic exits: Short Slot 0 is healthy (state 0), Core Long is latched (state 2)
ledger.evaluateSotaDynamicExits(60000.0, 60000.0, undefined, undefined, undefined, testLongSlot.openTime + 247000, 0.50);
assert(
  mdClient.getVegamCadmeState(assetIndex) === 2.0,
  `SAB Slot 158 preserves maximum active state (2.0) across all occupied slots (got ${String(mdClient.getVegamCadmeState(assetIndex))})`
);

// Release Short Slot 0: Core Long is still in state 2, so SAB Slot 158 must remain 2.0
ledger.releaseShortSlot(0, 60000.0, 0.0002, "TEST_CLOSE");
assert(
  mdClient.getVegamCadmeState(assetIndex) === 2.0,
  `Releasing secondary slot does NOT clobber active urgent alert in SAB Slot 158 (got ${String(mdClient.getVegamCadmeState(assetIndex))})`
);

// Clean release Core Long
ledger.releaseCoreLong(60000.0, 0.0002, "TEST_CLOSE");
assert(
  mdClient.getVegamCadmeState(assetIndex) === 0.0,
  `Releasing final slot clears SAB Slot 158 to 0.0 (got ${String(mdClient.getVegamCadmeState(assetIndex))})`
);

// Test 7D: CADME Pre-Warning Tier (cadmeState = 1)
// Duration: 0.60 * icAtEntry <= alphaDecay < 0.75 * icAtEntry
// halfLife = 120s, tau = 60s -> alphaDecay = 0.050 * exp(-LN2 * 0.5) = 0.03536 (70.7% of icAtEntry)
mdClient.setRollingIC(0.050, assetIndex);
ledger.occupyCoreLong(0.10, 60000.0, 1.0, 1.0);
const preWarnLong = ledger.getCoreLong();
ledger.evaluateSotaDynamicExits(60000.0, 60000.0, undefined, undefined, undefined, preWarnLong.openTime + 60000, 0.50);
assert(
  preWarnLong.cadmeState === 1,
  `cadmeState advances to 1 (MONITORING) in pre-warning decay zone (0.60 <= alpha/ic < 0.75): got ${String(preWarnLong.cadmeState)}`
);
assert(
  mdClient.getVegamCadmeState(assetIndex) === 1.0,
  `SAB Slot 158 reflects MONITORING state (1.0): got ${String(mdClient.getVegamCadmeState(assetIndex))}`
);

// Test 7E: Complete Slot Cleanup via clearSlots()
ledger.clearSlots();
assert(preWarnLong.icAtEntry === 0, `clearSlots resets coreLong icAtEntry to 0: got ${String(preWarnLong.icAtEntry)}`);
assert(preWarnLong.cadmeState === 0, `clearSlots resets coreLong cadmeState to 0: got ${String(preWarnLong.cadmeState)}`);
assert(
  mdClient.getVegamCadmeState(assetIndex) === 0.0,
  `clearSlots synchronizes SAB Slot 158 to 0.0: got ${String(mdClient.getVegamCadmeState(assetIndex))}`
);

// =========================================================================================
// SUMMARY
// =========================================================================================
console.log("\n================================================================================");
console.log(`   VEGAM PHASE 4 CADME QA MATRIX: ${String(totalPassed)} PASSED / ${String(totalFailed)} FAILED`);
console.log("================================================================================");

if (totalFailed > 0) {
  console.error("❌ VEGAM PHASE 4 CADME QA TESTS FAILED!");
  process.exit(1);
} else {
  console.log("✅ ALL VEGAM PHASE 4 CADME QA TESTS PASSED (100% SUCCESS)!");
}
