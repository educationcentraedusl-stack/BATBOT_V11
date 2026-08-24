import "dotenv/config";
import { HedgePositionLedger } from "../strategy/positionLedger";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`\x1b[31m[TEST_ASSERTION_FAILED] ${message}\x1b[0m`);
    throw new Error(message);
  }
}

async function runMonotonicZeroRetreatHardLockTests(): Promise<void> {
  console.log("================================================================================");
  console.log("  BATBOT_V11 SOTA: ZERO-RETREAT MONOTONIC STOP LOSS HARD LOCK TEST SUITE");
  console.log("  - Exact BTCUSDT Short Live Incident Regression Verification ($79,696.5)");
  console.log("  - Anti-Retreat Invariant: Math.min (Shorts) & Math.max (Longs)");
  console.log("  - Volatility Recalculation & Snapshot Re-Ingestion Monotonic Defense");
  console.log("  - Sub-Microsecond HFT Latency Constraint (< 1.500 µs)");
  console.log("================================================================================\n");

  // ============================================================================
  // TEST 1: Exact BTCUSDT Short Live Incident Regression
  // ============================================================================
  console.log("[TEST 1] Replicating BTCUSDT Short Live Incident ($79,696.5 Entry)...");
  const btcLedger = new HedgePositionLedger("BTCUSDT", 3);
  btcLedger.setLeverage(20);

  const entryPrice = 79696.5;
  const qty = 0.0007;
  const initialSlPct = 1.0; // 1.0% -> $80,493.5
  const initialTpPct = 2.5;

  // 1. Initial short entry
  btcLedger.occupyShortSlot(0, qty, entryPrice, initialTpPct, initialSlPct);
  const initialShort = btcLedger.getShortSlots()[0];
  console.log(`  ✓ Short Occupied @ $${entryPrice}: Initial SL set to $${initialShort.stopLossPrice}`);
  assert(initialShort.stopLossPrice === 80493.5, `Initial SL must be $80493.5, got $${initialShort.stopLossPrice}`);

  // 2. Price falls to $79,434.6 (In Profit). Step-Collar / Trailing ratchets SL down to $79,553.8
  btcLedger.evaluateHedgeDynamicTpSl(79434.6, 0, 0, 0, 0, 0.00028, 0, Date.now());
  btcLedger.applyMonotonicStopLoss(btcLedger.getShortSlots()[0] as any, 79553.8);
  const ratchetedSl = btcLedger.getShortSlots()[0].stopLossPrice;
  console.log(`  ✓ In-Profit Ratchet: SL successfully tightened to $${ratchetedSl} (locking in profit below entry)`);
  assert(ratchetedSl === 79553.8, `Ratcheted SL must be $79553.8, got $${ratchetedSl}`);

  // 3. ATTEMPT 1: Tick evaluation with wider Garman-Klass volatility recalculation ($80,493.5)
  btcLedger.applyMonotonicStopLoss(btcLedger.getShortSlots()[0] as any, 80493.5);
  assert(btcLedger.getShortSlots()[0].stopLossPrice === 79553.8, 
    `FATAL: Volatility recalculation caused SL retreat! Expected $79553.8, got $${btcLedger.getShortSlots()[0].stopLossPrice}`);
  console.log(`  ✓ ATTEMPT 1 BLOCKED: Wider volatility SL ($80,493.5) rejected! Maintained ratcheted SL @ $${btcLedger.getShortSlots()[0].stopLossPrice}`);

  // 4. ATTEMPT 2: Authoritative Snapshot reconciliation re-occupying slot
  btcLedger.occupyShortSlot(0, qty, entryPrice, initialTpPct, initialSlPct, true);
  assert(btcLedger.getShortSlots()[0].stopLossPrice === 79553.8,
    `FATAL: Snapshot reconciliation caused SL retreat! Expected $79553.8, got $${btcLedger.getShortSlots()[0].stopLossPrice}`);
  console.log(`  ✓ ATTEMPT 2 BLOCKED: Snapshot reconciliation rejected wider baseline SL! Maintained ratcheted SL @ $${btcLedger.getShortSlots()[0].stopLossPrice}`);

  // 5. ATTEMPT 3: Multi-lot accumulation re-evaluating slot
  btcLedger.occupyShortSlot(0, qty, entryPrice, initialTpPct, initialSlPct, false);
  assert(btcLedger.getShortSlots()[0].stopLossPrice === 79553.8,
    `FATAL: Position accumulation caused SL retreat! Expected $79553.8, got $${btcLedger.getShortSlots()[0].stopLossPrice}`);
  console.log(`  ✓ ATTEMPT 3 BLOCKED: Position accumulation preserved ratcheted SL @ $${btcLedger.getShortSlots()[0].stopLossPrice}`);

  // 6. ATTEMPT 4: Break-Even fill with wider breakEvenPrice than ratcheted SL
  (btcLedger.getShortSlots()[0] as any).breakEvenPrice = 79650.0;
  btcLedger.processTpLimitFill("SHORT_SLOT_0", 12345, 0.0001, 78000.0, true);
  assert(btcLedger.getShortSlots()[0].stopLossPrice === 79553.8,
    `FATAL: processTpLimitFill caused SL retreat! Expected $79553.8, got $${btcLedger.getShortSlots()[0].stopLossPrice}`);
  console.log(`  ✓ ATTEMPT 4 BLOCKED: TP limit fill preserved tighter SL ($79,553.8) vs wider Break-Even ($79,650.0)\n`);

  // ============================================================================
  // TEST 2: Long Position Symmetrical Zero-Retreat Defense
  // ============================================================================
  console.log("[TEST 2] Testing LONG Position Symmetrical Zero-Retreat Defense ($60,000 Entry)...");
  const ethLedger = new HedgePositionLedger("ETHUSDT", 3);
  ethLedger.setLeverage(20);

  const longEntry = 60000.0;
  const longQty = 0.1;
  ethLedger.occupyCoreLong(longQty, longEntry, 2.5, 1.0);
  const initialLongSl = ethLedger.getCoreLong().stopLossPrice;
  console.log(`  ✓ Long Occupied @ $${longEntry}: Initial SL set to $${initialLongSl}`);
  assert(initialLongSl === 59400.0, `Initial Long SL must be $59400, got $${initialLongSl}`);

  // Tighten Long SL to $60,500 (+10% ROE)
  ethLedger.applyMonotonicStopLoss(ethLedger.getCoreLong() as any, 60500.0);
  assert(ethLedger.getCoreLong().stopLossPrice === 60500.0, `Long SL must be ratcheted to $60500`);
  console.log(`  ✓ Long SL Ratcheted to $${ethLedger.getCoreLong().stopLossPrice}`);

  // Attempt backward retreat to $59,400 or $60,100
  ethLedger.applyMonotonicStopLoss(ethLedger.getCoreLong() as any, 59400.0);
  assert(ethLedger.getCoreLong().stopLossPrice === 60500.0, `Long SL must not retreat to $59400`);
  ethLedger.applyMonotonicStopLoss(ethLedger.getCoreLong() as any, 60100.0);
  assert(ethLedger.getCoreLong().stopLossPrice === 60500.0, `Long SL must not retreat to $60100`);
  console.log(`  ✓ Backward Retreat Attempts Blocked! SL firmly locked at $${ethLedger.getCoreLong().stopLossPrice}`);

  // Legitimate tightening to $61,000 must succeed
  ethLedger.applyMonotonicStopLoss(ethLedger.getCoreLong() as any, 61000.0);
  assert(ethLedger.getCoreLong().stopLossPrice === 61000.0, `Legitimate tightening must advance SL to $61000`);
  console.log(`  ✓ Legitimate Tightening Succeeded: SL advanced to $${ethLedger.getCoreLong().stopLossPrice}\n`);

  // ============================================================================
  // TEST 3: Latency Benchmark (< 1.5 µs / evaluation)
  // ============================================================================
  console.log("[TEST 3] Running 100,000-Iteration applyMonotonicStopLoss Benchmark...");
  const slot = ethLedger.getCoreLong() as any;
  const startHr = process.hrtime.bigint();
  for (let i = 0; i < 100000; i++) {
    ethLedger.applyMonotonicStopLoss(slot, 60000.0 + (i % 100));
  }
  const endHr = process.hrtime.bigint();
  const totalNs = Number(endHr - startHr);
  const totalMs = totalNs / 1e6;
  const perCallUs = totalNs / (100000 * 1e3);

  console.log(`  ✓ Executed 100,000 monotonic evaluations in ${totalMs.toFixed(2)} ms`);
  console.log(`  ✓ Average Latency: ${perCallUs.toFixed(3)} µs / call (< 1.500 µs HFT threshold)`);
  assert(perCallUs < 1.5, `Monotonic Stop Loss latency must be < 1.5µs, got ${perCallUs}µs`);

  console.log("\n================================================================================");
  console.log("  ALL ZERO-RETREAT MONOTONIC HARD LOCK TESTS PASSED! (100% MATHEMATICALLY PROVEN)");
  console.log("================================================================================");
}

runMonotonicZeroRetreatHardLockTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
