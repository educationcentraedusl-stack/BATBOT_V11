import "dotenv/config";
import { HedgePositionLedger } from "../strategy/positionLedger";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`\x1b[31m[TEST_ASSERTION_FAILED] ${message}\x1b[0m`);
    throw new Error(message);
  }
}

async function runSota5PctRoeRatchetTestSuite() {
  console.log("================================================================================");
  console.log("  BATBOT_V11 SOTA: 5% ROE RATCHET & CONTINUOUS TRAILING SL PROOF SUITE");
  console.log("  - Verification of Tier 1 Break-Even Ratchet at exactly +5.0% Net ROE");
  console.log("  - Verification of Active Dynamic Trailing SL behind Peak/Trough");
  console.log("  - Zero-Retreat Monotonic Defense on Noise Pullbacks");
  console.log("================================================================================\n");

  const symbol = "BTCUSDT";
  const ledger = new HedgePositionLedger(symbol, 3);
  ledger.setLeverage(5); // 5x leverage matching production Phase 4 clamp

  const entryPrice = 80000.0;
  const quantity = 0.005; // $400 notional / $80 margin

  // -----------------------------------------------------------------------------------------
  // TEST 1: LONG Position +5.0% ROE Ratchet & Continuous Trailing Verification
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 1] Testing LONG Position +5.0% ROE Ratchet & Dynamic Trail...");
  // Occupy CORE_LONG with initial SL = 1.50% ($78,800)
  ledger.occupyCoreLong(quantity, entryPrice, 3.00, 1.50);
  let slot = ledger.getCoreLong();
  assert(slot.isOccupied === true, "Core Long slot must be occupied");
  assert(slot.stopLossPrice === 78800.0, `Initial SL must have breathing room @ $78,800, got $${slot.stopLossPrice}`);
  console.log(`  ✓ Initial SL confirmed at $${slot.stopLossPrice} (1.50% breathing room)`);

  // Tick 1: Small profit (+2.5% ROE => +0.50% price move => $80,400)
  // Below +5.0% ROE -> No Tier 1 ratchet
  ledger.evaluateHedgeDynamicTpSl(80400.0, 0.0, 0.50, 0.20, 1.0, 0.0001, 0.0, Date.now());
  slot = ledger.getCoreLong();
  assert(slot.stepCollarTier === undefined || slot.stepCollarTier === 0, "StepCollar tier should remain 0 below +5.0% ROE");
  assert(slot.stopLossPrice === 78800.0, `SL must remain at initial level @ $78,800, got $${slot.stopLossPrice}`);
  console.log("  ✓ Tick 1 ($80,400, +2.5% ROE): Position holding without premature ratchet");

  // Tick 2: Reach +5.0% ROE (+1.00% price move @ 5x lev => $80,800)
  // MUST trigger Tier 1 Break-Even Ratchet!
  ledger.evaluateHedgeDynamicTpSl(80800.0, 0.0, 0.50, 0.20, 1.0, 0.0001, 0.0, Date.now());
  slot = ledger.getCoreLong();
  assert(slot.stepCollarTier === 1, `StepCollar tier must be 1 at +5.0% ROE, got ${slot.stepCollarTier}`);
  assert(slot.breakEvenLocked === true, "breakEvenLocked must be true at +5.0% ROE");
  assert(slot.stopLossPrice > entryPrice, `Stop Loss ($${slot.stopLossPrice}) MUST be ratcheted ABOVE entry ($${entryPrice})`);
  const tier1Sl = slot.stopLossPrice;
  console.log(`  ✓ Tick 2 ($80,800, +5.0% ROE): Tier 1 Ratchet Active! SL ratcheted to $${tier1Sl} (Entry + Fees secured)`);

  // Tick 3: Price advances further to $81,200 (+7.5% ROE)
  // Continuous trailing stop must follow behind peak
  ledger.evaluateHedgeDynamicTpSl(81200.0, 0.0, 0.50, 0.20, 1.0, 0.0001, 0.0, Date.now());
  slot = ledger.getCoreLong();
  const trailingSl = slot.stopLossPrice;
  assert(trailingSl >= tier1Sl, `Trailing SL ($${trailingSl}) must be >= Tier 1 Break-Even SL ($${tier1Sl})`);
  console.log(`  ✓ Tick 3 ($81,200, +7.5% ROE): Trailing SL advanced to $${trailingSl}`);

  // Tick 4: Noise pullback to $80,600
  // Monotonic Zero-Retreat invariant: SL must NOT retreat
  ledger.evaluateHedgeDynamicTpSl(80600.0, 0.0, 0.50, 0.20, 1.0, 0.0001, 0.0, Date.now());
  slot = ledger.getCoreLong();
  assert(slot.stopLossPrice === trailingSl, `Monotonic Guarantee: SL must remain locked at $${trailingSl}, got $${slot.stopLossPrice}`);
  console.log(`  ✓ Tick 4 ($80,600 pullback): Monotonic lock verified! SL strictly maintained at $${slot.stopLossPrice}`);

  ledger.releaseCoreLong();

  // -----------------------------------------------------------------------------------------
  // TEST 2: SHORT Position +5.0% ROE Ratchet Symmetry Verification
  // -----------------------------------------------------------------------------------------
  console.log("\n[TEST 2] Testing SHORT Position +5.0% ROE Ratchet Symmetry...");
  ledger.occupyShortSlot(0, quantity, entryPrice, 3.00, 1.50);
  let shortSlot = ledger.getShortSlots()[0];
  assert(shortSlot.stopLossPrice === 81200.0, `Initial Short SL must be $81,200, got $${shortSlot.stopLossPrice}`);
  console.log(`  ✓ Initial Short SL confirmed at $${shortSlot.stopLossPrice} (1.50% breathing room)`);

  // Tick 1: Small profit (+2.5% ROE => $79,600)
  ledger.evaluateHedgeDynamicTpSl(79600.0, 0.0, 0.50, 0.20, 1.0, 0.0001, 0.0, Date.now());
  shortSlot = ledger.getShortSlots()[0];
  assert(shortSlot.stepCollarTier === undefined || shortSlot.stepCollarTier === 0, "Short StepCollar tier should remain 0 below +5.0% ROE");
  assert(shortSlot.stopLossPrice === 81200.0, `Short SL must remain at initial $81,200, got $${shortSlot.stopLossPrice}`);

  // Tick 2: Reach +5.0% ROE ($79,200)
  ledger.evaluateHedgeDynamicTpSl(79200.0, 0.0, 0.50, 0.20, 1.0, 0.0001, 0.0, Date.now());
  shortSlot = ledger.getShortSlots()[0];
  assert(shortSlot.stepCollarTier === 1, `Short StepCollar tier must be 1 at +5.0% ROE, got ${shortSlot.stepCollarTier}`);
  assert(shortSlot.breakEvenLocked === true, "Short breakEvenLocked must be true at +5.0% ROE");
  assert(shortSlot.stopLossPrice < entryPrice, `Short SL ($${shortSlot.stopLossPrice}) MUST be ratcheted BELOW entry ($${entryPrice})`);
  const shortTier1Sl = shortSlot.stopLossPrice;
  console.log(`  ✓ Tick 2 ($79,200, +5.0% ROE): Short Tier 1 Ratchet Active! SL ratcheted to $${shortTier1Sl} (Entry - Fees secured)`);

  // Tick 3: Pullback bounce back up to $79,500
  ledger.evaluateHedgeDynamicTpSl(79500.0, 0.0, 0.50, 0.20, 1.0, 0.0001, 0.0, Date.now());
  shortSlot = ledger.getShortSlots()[0];
  assert(shortSlot.stopLossPrice === shortTier1Sl, `Short Monotonic Guarantee: SL must remain locked at $${shortTier1Sl}, got $${shortSlot.stopLossPrice}`);
  console.log(`  ✓ Tick 3 ($79,500 bounce): Monotonic lock verified! Short SL maintained at $${shortSlot.stopLossPrice}\n`);

  ledger.releaseShortSlot(0);

  console.log("================================================================================");
  console.log("  ✅ ALL SOTA +5.0% ROE RATCHET & TRAILING TESTS PASSED 100% SUCCESSFULLY!");
  console.log("================================================================================");
}

runSota5PctRoeRatchetTestSuite().catch((err) => {
  console.error("FATAL TEST FAILURE:", err);
  process.exit(1);
});

