import "dotenv/config";
import { HedgePositionLedger } from "../strategy/positionLedger";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[ASSERTION_FAILED] ${message}`);
  }
}

function runLiveTrailingSlScenarioTest(): void {
  console.log("================================================================================");
  console.log("  BATBOT_V11 SOTA: LIVE TRAILING SL & BREAK-EVEN RATCHET VERIFICATION TEST");
  console.log("  Verifying ETHUSDT (+2.5% ROE) and LINKUSDT (+8.3% ROE) Trailing Ratchet Fixes");
  console.log("================================================================================\n");

  // SCENARIO 1: ETHUSDT SHORT @ $1917.30
  console.log("[SCENARIO 1] ETHUSDT Short Position at +2.5% ROE...");
  const ethLedger = new HedgePositionLedger("ETHUSDT", 3);
  ethLedger.setLeverage(20);
  
  // Occupy Short Slot 0 (qty 0.1 @ $1917.30, SL 1.00%, TP 2.50%)
  ethLedger.occupyShortSlot(0, 0.1, 1917.30, 2.50, 1.00);
  let ethSummary = ethLedger.getAggregatedSideSummary("SHORT");
  console.log(`  Initial State: Entry=$${String(ethSummary.vwapEntryPrice)}, Initial SL=$${String(ethSummary.stopLossPrice)}`);
  assert(Math.abs(ethSummary.stopLossPrice - 1936.47) <= 0.1, `Initial SL should be ~$1936.47, got $${String(ethSummary.stopLossPrice)}`);

  // Tick at $1915.36 (+2.02% ROE at 20x leverage)
  ethLedger.evaluateHedgeDynamicTpSl(1915.36, 0.0, 0.5, 0.1, 0.5, 0.0004, 0.0, Date.now());
  
  const ethSlot = ethLedger.getShortSlots()[0];
  ethSummary = ethLedger.getAggregatedSideSummary("SHORT");
  console.log(`  After Tick @ $1915.36 (+2.02% ROE): Slot SL=$${String(ethSlot.stopLossPrice)}, Aggregated SL=$${String(ethSummary.stopLossPrice)}`);
  
  assert(ethSlot.breakEvenLocked === true, "breakEvenLocked must be true");
  assert(ethSlot.stopLossPrice <= 1917.30, `Stop Loss ($${String(ethSlot.stopLossPrice)}) MUST be at or below entry ($1917.30) to secure breakeven`);
  assert(ethSummary.stopLossPrice === ethSlot.stopLossPrice, `Aggregated SL ($${String(ethSummary.stopLossPrice)}) must match slot SL ($${String(ethSlot.stopLossPrice)}) and not remain stuck at $1936.5`);
  console.log(`  ✓ ETHUSDT SL successfully ratcheted from $1936.5 (loss zone) to $${String(ethSummary.stopLossPrice)} (profit/breakeven zone)!`);

  // SCENARIO 2: LINKUSDT SHORT @ $9.522
  console.log("\n[SCENARIO 2] LINKUSDT Short Position at +8.3% ROE...");
  const linkLedger = new HedgePositionLedger("LINKUSDT", 3);
  linkLedger.setLeverage(20);

  // Occupy Short Slot 0 (qty 5.67 @ $9.522, SL 1.00%, TP 2.50%)
  linkLedger.occupyShortSlot(0, 5.67, 9.522, 2.50, 1.00);
  let linkSummary = linkLedger.getAggregatedSideSummary("SHORT");
  console.log(`  Initial State: Entry=$${String(linkSummary.vwapEntryPrice)}, Initial SL=$${String(linkSummary.stopLossPrice)}`);
  assert(Math.abs(linkSummary.stopLossPrice - 9.617) <= 0.005, `Initial SL should be ~$9.617, got $${String(linkSummary.stopLossPrice)}`);

  // Tick at $9.482 (+8.40% ROE at 20x leverage)
  linkLedger.evaluateHedgeDynamicTpSl(9.482, 0.0, 0.5, 0.1, 0.5, 0.0004, 0.0, Date.now());

  const linkSlot = linkLedger.getShortSlots()[0];
  linkSummary = linkLedger.getAggregatedSideSummary("SHORT");
  console.log(`  After Tick @ $9.482 (+8.40% ROE): Slot SL=$${String(linkSlot.stopLossPrice)}, Aggregated SL=$${String(linkSummary.stopLossPrice)}`);

  assert(linkSlot.breakEvenLocked === true, "breakEvenLocked must be true");
  assert(linkSlot.stopLossPrice < 9.522, `Stop Loss ($${String(linkSlot.stopLossPrice)}) MUST be below entry ($9.522) to lock in profit`);
  assert(linkSummary.stopLossPrice === linkSlot.stopLossPrice, `Aggregated SL ($${String(linkSummary.stopLossPrice)}) must match slot SL ($${String(linkSlot.stopLossPrice)}) and not remain stuck at $9.617`);
  console.log(`  ✓ LINKUSDT SL successfully ratcheted from $9.617 (loss zone) to $${String(linkSummary.stopLossPrice)} (profit zone)!`);

  console.log("\n================================================================================");
  console.log("  ALL LIVE TRAILING SL SCENARIO TESTS PASSED SUCCESSFULLY! (100% VERIFIED)");
  console.log("================================================================================");
}

try {
  runLiveTrailingSlScenarioTest();
} catch (err: unknown) {
  console.error("FATAL TEST FAILURE:", err);
  process.exit(1);
}
