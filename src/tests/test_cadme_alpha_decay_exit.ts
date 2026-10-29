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
  `SAB Slot 101 (ROLLING_IC) successfully stored: got ${mdClient.getRollingIC(assetIndex)}`
);

const ledger = new HedgePositionLedger(symbol, 3, mdClient, assetIndex);
const entryPrice = 60000.0;
const entryQty = 0.10;
const now = Date.now();

// Occupy Core Long slot
ledger.occupyCoreLong(entryQty, entryPrice, 1.0, 1.0);
const coreLong = ledger.getCoreLong();

assert(coreLong.isOccupied === true, "Core Long slot is successfully occupied");
assert(
  Math.abs((coreLong.icAtEntry ?? 0) - initialEwmaIc) < 1e-9,
  `Core Long slot captured live EWMA IC from SAB Slot 101: expected ${initialEwmaIc}, got ${coreLong.icAtEntry}`
);
assert(coreLong.cadmeState === 0, `Initial cadmeState is 0 (INACTIVE): got ${coreLong.cadmeState}`);

// =========================================================================================
// STAGE 2: Prime Alpha Trade Immunity (tau = 0.5 * halfLifeSec)
// =========================================================================================
console.log("\n--- STAGE 2: Prime Alpha Trade Immunity (tau = 0.5 * halfLifeSec) ---");

// Fixed Hurst = 0.50 -> Trending baseline halfLifeSec = 90.0s
const halfLifeSec = 90.0;
const earlyDurationSec = halfLifeSec * 0.5; // 45.0s
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
  `Prime alpha immunity verified: No CADME exit at tau = 0.5*t_half (triggers = ${earlyCadmeTriggers.length})`
);
assert(
  coreLong.cadmeState === 0,
  `cadmeState remains 0 during prime alpha regime (got ${coreLong.cadmeState})`
);

// =========================================================================================
// STAGE 3: Dual-Confirmation Rejection Matrix
// =========================================================================================
console.log("\n--- STAGE 3: Dual-Confirmation Rejection Matrix ---");

// Sub-Test 3A: Modeled Decay Reached (tau = 2 * halfLifeSec), BUT Live IC Persists (liveIc >= 0.75 * icAtEntry)
// alphaDecay = 0.050 * exp(-LN2 * 2) = 0.0125 < 0.050 * 0.60 (0.030) -> Modeled decay condition MET!
// But liveIc = 0.045 >= 0.050 * 0.75 (0.0375) -> Live market condition FAILS!
const lateDurationSec = halfLifeSec * 2.0; // 180.0s
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
  `cadmeState advances to 1 (MONITORING) when modeled decay approaches (got ${coreLong.cadmeState})`
);

// Sub-Test 3B: Live IC Drops (liveIc < 0.75 * icAtEntry), BUT Duration is Young (tau = 10s)
// liveIc = 0.010 < 0.0375 -> Live condition MET!
// But duration = 10s -> alphaDecay = 0.050 * exp(-LN2 * 10/90) = 0.0463 > 0.030 -> Modeled condition FAILS!
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
// 1. tau = 2.0 * halfLifeSec = 180s -> alphaDecay = 0.0125 < 0.030 (0.60 * 0.050)
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
assert(cadmeExit?.slotId === "CORE_LONG", `Target slotId is CORE_LONG: got ${cadmeExit?.slotId}`);
assert(cadmeExit?.quantity === entryQty, `Exit quantity equals full slot quantity (${entryQty}): got ${cadmeExit?.quantity}`);
assert(cadmeExit?.executionStyle === "PASSIVE_MAKER", `executionStyle strictly PASSIVE_MAKER: got ${cadmeExit?.executionStyle}`);
assert(cadmeExit?.executionType === "PASSIVE_MAKER", `executionType strictly PASSIVE_MAKER: got ${cadmeExit?.executionType}`);
assert(coreLong.cadmeState === 2, `Slot cadmeState strictly updated to 2 (EXIT_TRIGGERED): got ${coreLong.cadmeState}`);

// Verify SAB Slot 158 Telemetry Bitcasting Sync
const sabCadmeState = mdClient.getVegamCadmeState(assetIndex);
assert(sabCadmeState === 2.0, `SAB Slot 158 (VEGAM_CADME_STATE) atomically written: expected 2.0, got ${sabCadmeState}`);

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

assert(shortSlot.isOccupied === true, "Short slot #0 is occupied");
assert(
  Math.abs((shortSlot.icAtEntry ?? 0) - 0.040) < 1e-9,
  `Short slot captured live IC (0.040): got ${shortSlot.icAtEntry}`
);
assert(shortSlot.cadmeState === 0, `Short slot initial cadmeState is 0: got ${shortSlot.cadmeState}`);

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
assert(shortCadmeExit?.slotId === "SHORT_SLOT_0", `Target slotId is SHORT_SLOT_0: got ${shortCadmeExit?.slotId}`);
assert(shortCadmeExit?.executionStyle === "PASSIVE_MAKER", `Short executionStyle is PASSIVE_MAKER: got ${shortCadmeExit?.executionStyle}`);
assert(shortSlot.cadmeState === 2, `Short slot cadmeState updated to 2: got ${shortSlot.cadmeState}`);

// =========================================================================================
// STAGE 6: Clean Slot Release & SAB Reset Verification
// =========================================================================================
console.log("\n--- STAGE 6: Clean Slot Release & SAB Reset Verification ---");

ledger.releaseShortSlot(shortIdx, shortEntryPrice, 0.0002, "CADME_TEST_CLOSE");
assert(shortSlot.isOccupied === false, "Short slot #0 is flat");
assert(shortSlot.icAtEntry === 0, `Short slot icAtEntry reset to 0: got ${shortSlot.icAtEntry}`);
assert(shortSlot.cadmeState === 0, `Short slot cadmeState reset to 0: got ${shortSlot.cadmeState}`);

const sabResetState = mdClient.getVegamCadmeState(assetIndex);
assert(sabResetState === 0.0, `SAB Slot 158 atomically reset to 0.0 on slot release: got ${sabResetState}`);

// =========================================================================================
// SUMMARY
// =========================================================================================
console.log("\n================================================================================");
console.log(`   VEGAM PHASE 4 CADME QA MATRIX: ${totalPassed} PASSED / ${totalFailed} FAILED`);
console.log("================================================================================");

if (totalFailed > 0) {
  console.error("❌ VEGAM PHASE 4 CADME QA TESTS FAILED!");
  process.exit(1);
} else {
  console.log("✅ ALL VEGAM PHASE 4 CADME QA TESTS PASSED (100% SUCCESS)!");
}
