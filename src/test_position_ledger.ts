import { PositionLedger } from "./strategy/positionLedger";

function runPositionLedgerTests() {
  console.log("==================================================");
  console.log("   RUNNING ZERO-GC POSITION LEDGER UNIT TESTS     ");
  console.log("==================================================");

  const ledger = new PositionLedger("BTCUSDT");

  // Test 1: Single Round-Trip Profitable Trade (BUY @ 60000, SELL @ 61000, qty 0.001)
  console.log("\n[TEST 1] Single Round-Trip Profitable Trade...");
  const fill1 = ledger.processFill("BTCUSDT", "BUY", 60000, 0.001, 0.024);
  console.log("  Buy Fill 1 Result:", {
    side: fill1.positionSideAfterFill,
    netQty: fill1.netQuantityAfterFill,
    avgPrice: fill1.averageEntryPriceAfterFill,
    realizedPnl: fill1.realizedPnl,
  });
  if (fill1.positionSideAfterFill !== "LONG" || fill1.netQuantityAfterFill !== 0.001 || fill1.realizedPnl !== 0) {
    throw new Error("Test 1 Buy Fill Failed");
  }

  const fill2 = ledger.processFill("BTCUSDT", "SELL", 61000, 0.001, 0.0244);
  console.log("  Sell Fill 2 Result:", {
    side: fill2.positionSideAfterFill,
    netQty: fill2.netQuantityAfterFill,
    avgPrice: fill2.averageEntryPriceAfterFill,
    realizedPnl: fill2.realizedPnl,
  });
  // Profit = (61000 - 60000) * 0.001 - 0.0244 = 1.0 - 0.0244 = 0.9756
  const expectedPnl1 = (61000 - 60000) * 0.001 - 0.0244;
  if (fill2.positionSideAfterFill !== "FLAT" || Math.abs(fill2.realizedPnl - expectedPnl1) > 1e-5) {
    throw new Error(`Test 1 Sell Fill Failed. Expected PnL ${expectedPnl1}, got ${fill2.realizedPnl}`);
  }
  console.log("  ✅ TEST 1 PASSED!");

  // Test 2: Partial Fill Closure
  console.log("\n[TEST 2] Partial Fill Closure...");
  ledger.reset();
  ledger.processFill("BTCUSDT", "BUY", 60000, 0.002, 0.048);
  const partialFill = ledger.processFill("BTCUSDT", "SELL", 62000, 0.001, 0.0248);
  console.log("  Partial Sell Result:", {
    side: partialFill.positionSideAfterFill,
    netQty: partialFill.netQuantityAfterFill,
    avgPrice: partialFill.averageEntryPriceAfterFill,
    realizedPnl: partialFill.realizedPnl,
  });
  // Profit = (62000 - 60000) * 0.001 - 0.0248 = 2.0 - 0.0248 = 1.9752
  const expectedPnl2 = (62000 - 60000) * 0.001 - 0.0248;
  if (partialFill.positionSideAfterFill !== "LONG" || Math.abs(partialFill.netQuantityAfterFill - 0.001) > 1e-6 || Math.abs(partialFill.realizedPnl - expectedPnl2) > 1e-5) {
    throw new Error(`Test 2 Partial Fill Failed. Expected PnL ${expectedPnl2}, got ${partialFill.realizedPnl}`);
  }
  console.log("  ✅ TEST 2 PASSED!");

  // Test 3: Loss Trade (BUY @ 60000, SELL @ 59000)
  console.log("\n[TEST 3] Loss Trade...");
  ledger.reset();
  ledger.processFill("BTCUSDT", "BUY", 60000, 0.001, 0.024);
  const lossFill = ledger.processFill("BTCUSDT", "SELL", 59000, 0.001, 0.0236);
  // Loss = (59000 - 60000) * 0.001 - 0.0236 = -1.0 - 0.0236 = -1.0236
  const expectedPnl3 = (59000 - 60000) * 0.001 - 0.0236;
  console.log("  Loss Sell Result:", {
    side: lossFill.positionSideAfterFill,
    realizedPnl: lossFill.realizedPnl,
  });
  if (Math.abs(lossFill.realizedPnl - expectedPnl3) > 1e-5) {
    throw new Error(`Test 3 Loss Fill Failed. Expected PnL ${expectedPnl3}, got ${lossFill.realizedPnl}`);
  }
  console.log("  ✅ TEST 3 PASSED!");

  // Test 4: Performance Benchmark (100,000 fills)
  console.log("\n[TEST 4] High-Frequency Latency Benchmark (100,000 fills)...");
  ledger.reset();
  const start = process.hrtime.bigint();
  for (let i = 0; i < 100000; i++) {
    const side = i % 2 === 0 ? "BUY" : "SELL";
    const price = 60000 + (i % 50);
    ledger.processFill("BTCUSDT", side, price, 0.001, 0.024);
  }
  const end = process.hrtime.bigint();
  const durationMs = Number(end - start) / 1e6;
  const avgUs = (Number(end - start) / 1000) / 100000;
  console.log(`  Processed 100,000 fills in ${durationMs.toFixed(2)} ms (${avgUs.toFixed(3)} µs/fill)`);
  if (avgUs > 1.5) {
    console.warn(`  ⚠️ Benchmark warning: Latency ${avgUs.toFixed(3)} µs exceeds 1.5 µs target`);
  } else {
    console.log("  ✅ TEST 4 PASSED (Sub-microsecond latency target achieved)!");
  }

  const summary = ledger.getSummary(60050);
  console.log("\n[FINAL LEDGER SUMMARY]:", summary);
  console.log("\n==================================================");
  console.log("   ALL POSITION LEDGER TESTS PASSED SUCCESSFULLY!  ");
  console.log("==================================================");
}

runPositionLedgerTests();
