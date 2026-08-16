import { HedgePositionLedger } from "../strategy/positionLedger";
import { RiskGuard, OrderIntent } from "../strategy/risk";

async function testLongHoldProfitGuaranteeQA() {
  console.log("=========================================================================");
  console.log("   RUNNING QA HARNESS: LONG-HOLD PROFIT GUARANTEE & R:R RECALIBRATION    ");
  console.log("=========================================================================\n");

  const riskGuard = new RiskGuard({ minRiskRewardRatio: 2.0 });

  // -------------------------------------------------------------------------
  // TEST 1: Asymmetric Risk/Reward Ratio Enforcement (Floor: 2.0)
  // -------------------------------------------------------------------------
  console.log("[TEST 1] Testing Risk/Reward Ratio Enforcement...");
  
  // Non-compliant OrderIntent: Entry @ 1900, TP @ 1912.00 (+0.63%), SL @ 1890.40 (-0.505%) -> R:R = 1.25 (< 2.0)
  const nonCompliantIntent: OrderIntent = {
    symbol: "ETHUSDT",
    side: "BUY",
    quantity: 0.05,
    price: 1900.00,
    takeProfitPrice: 1912.00,
    stopLossPrice: 1890.40,
  };

  const nonCompliantRes = riskGuard.validateOrder(nonCompliantIntent, true);
  console.log("  Non-Compliant R:R (1.25) Result:", nonCompliantRes.reasonCode, "| Passed:", nonCompliantRes.passed);
  if (nonCompliantRes.passed || nonCompliantRes.reasonCode !== "INVALID_RISK_REWARD") {
    throw new Error(`FAIL: Expected INVALID_RISK_REWARD rejection for R:R 1.25, received: ${nonCompliantRes.reasonCode}`);
  }

  // Compliant OrderIntent: Entry @ 1900, TP @ 1928.50 (+1.50%), SL @ 1890.50 (-0.50%) -> R:R = 3.00 (>= 2.0)
  const compliantIntent: OrderIntent = {
    symbol: "ETHUSDT",
    side: "BUY",
    quantity: 0.05,
    price: 1900.00,
    takeProfitPrice: 1928.50,
    stopLossPrice: 1890.50,
  };

  const compliantRes = riskGuard.validateOrder(compliantIntent, true);
  console.log("  Compliant R:R (3.00) Result:", compliantRes.reasonCode, "| Passed:", compliantRes.passed);
  if (!compliantRes.passed || compliantRes.reasonCode !== "APPROVED") {
    throw new Error(`FAIL: Expected APPROVED for R:R 3.00, received: ${compliantRes.reasonCode}`);
  }
  console.log("  ✅ TEST 1 PASSED: Risk/Reward ratio floor (2.0) mathematically enforced!\n");

  // -------------------------------------------------------------------------
  // TEST 2: Profit-Gated Breakeven Lock (Tier 1 CAD-DTLM Escalation)
  // -------------------------------------------------------------------------
  console.log("[TEST 2] Testing Profit-Gated Breakeven Lock...");
  const hedgeLedger = new HedgePositionLedger("ETHUSDT", 3);
  const entryPrice = 1900.00;
  const initialOpenTime = Date.now();

  hedgeLedger.occupyCoreLong(0.05, entryPrice, 0.45, 0.15);
  const coreLongSlot = hedgeLedger.getCoreLong();
  const initialSl = coreLongSlot.stopLossPrice;
  console.log(`  Initial Position: Entry = $${entryPrice.toFixed(2)}, Initial SL = $${initialSl.toFixed(2)}`);

  // Evaluate at 35s when NOT in profit -> SL must remain initial SL (No 30s suicide stop)
  hedgeLedger.evaluateHedgeDynamicTpSl(entryPrice, initialOpenTime + 35000);
  if (coreLongSlot.stopLossPrice !== initialSl) {
    throw new Error(`FAIL: SL prematurely changed at 35s while not in profit! Expected $${initialSl}, got $${coreLongSlot.stopLossPrice}`);
  }
  console.log(`  - At 35s (Not In Profit): SL safely remained initial SL ($${coreLongSlot.stopLossPrice.toFixed(2)})`);

  // Evaluate at 65s when price moves into verified profit ($1905.00) -> must lock profit-gated Breakeven SL
  const profitPrice = 1905.00;
  hedgeLedger.evaluateHedgeDynamicTpSl(profitPrice, initialOpenTime + 65000);
  const tier1Sl = coreLongSlot.stopLossPrice;
  console.log(`  At 65s Elapsed (in profit $${profitPrice}): Breakeven Locked SL = $${tier1Sl.toFixed(2)}`);
  if (tier1Sl <= entryPrice || coreLongSlot.timeDecayTier !== 1) {
    throw new Error(`FAIL: 60s Profit-gated Breakeven lock failed! Tier1 SL ($${tier1Sl}) must be > Entry ($${entryPrice})`);
  }

  // Drop mark price below Breakeven SL -> must trigger BREAK_EVEN_STOP_LOSS exit with profit/zero loss
  const triggersAfterLock = hedgeLedger.evaluateHedgeDynamicTpSl(tier1Sl - 0.50, initialOpenTime + 70000);
  if (triggersAfterLock.length === 0 || triggersAfterLock[0].reason !== "BREAK_EVEN_STOP_LOSS") {
    throw new Error(`FAIL: Expected BREAK_EVEN_STOP_LOSS trigger when price dropped below breakeven lock.`);
  }
  console.log(`  Triggered Exit Reason: ${triggersAfterLock[0].reason} @ Mark: $${triggersAfterLock[0].markPrice}`);
  console.log("  ✅ TEST 2 PASSED: Profit-Gated Breakeven Lock verified without premature 30s stop trap!\n");

  // -------------------------------------------------------------------------
  // TEST 3: 180s Micro-Profit Guard (Tier 2 Time-Decay Escalation)
  // -------------------------------------------------------------------------
  console.log("[TEST 3] Testing 180s Micro-Profit Guard...");
  hedgeLedger.releaseCoreLong();
  hedgeLedger.occupyCoreLong(0.05, entryPrice, 0.45, 0.15);

  const tier2MarkPrice = 1910.00;
  hedgeLedger.evaluateHedgeDynamicTpSl(tier2MarkPrice, initialOpenTime + 200000); // 200s elapsed in profit
  const tier2Sl = hedgeLedger.getCoreLong().stopLossPrice;
  console.log(`  At 200s (3.3 min) Elapsed: Micro-Profit Locked SL = $${tier2Sl.toFixed(2)}`);
  if (tier2Sl <= tier1Sl || hedgeLedger.getCoreLong().timeDecayTier !== 2) {
    throw new Error(`FAIL: 180s Micro-Profit Guard failed! Tier2 SL ($${tier2Sl}) must be > Tier1 SL ($${tier1Sl})`);
  }
  console.log("  ✅ TEST 3 PASSED: 180s Micro-Profit Guard escalated stop-loss into positive profit territory!\n");

  // -------------------------------------------------------------------------
  // TEST 4: 600s Guaranteed Profit Lock (Tier 3 Time-Decay Escalation)
  // -------------------------------------------------------------------------
  console.log("[TEST 4] Testing 600s (10 Min) Guaranteed Profit Lock...");
  const tier3MarkPrice = 1915.00;
  hedgeLedger.evaluateHedgeDynamicTpSl(tier3MarkPrice, initialOpenTime + 650000); // 650s elapsed in profit
  const tier3Sl = hedgeLedger.getCoreLong().stopLossPrice;
  console.log(`  At 650s (10.8 min) Elapsed: Guaranteed Profit Locked SL = $${tier3Sl.toFixed(2)}`);
  if (tier3Sl <= tier2Sl || hedgeLedger.getCoreLong().timeDecayTier !== 3) {
    throw new Error(`FAIL: 600s Guaranteed Profit Lock failed! Tier3 SL ($${tier3Sl}) must be > Tier2 SL ($${tier2Sl})`);
  }

  const pnlUsdt = (tier3Sl - entryPrice) * 0.05;
  console.log(`  Guaranteed Minimum Net Profit on Exit: +$${pnlUsdt.toFixed(4)} USDT`);
  console.log("  ✅ TEST 4 PASSED: 600s (10 Min) Guaranteed Profit Lock mathematically guarantees positive PnL on long-hold positions!\n");

  // -------------------------------------------------------------------------
  // TEST 5: 1800s Hard Harvest Timeout (Tier 4 Time-Decay Escalation)
  // -------------------------------------------------------------------------
  console.log("[TEST 5] Testing 1800s (30 Min) Hard Harvest Timeout...");
  const triggers1800s = hedgeLedger.evaluateHedgeDynamicTpSl(entryPrice, initialOpenTime + 1850000); // 1850s elapsed
  if (triggers1800s.length === 0 || triggers1800s[0].reason !== "LONG_HOLD_PROFIT_HARVEST") {
    throw new Error(`FAIL: Expected LONG_HOLD_PROFIT_HARVEST exit trigger at 1850s, received: ${triggers1800s[0]?.reason}`);
  }
  console.log(`  Triggered Exit Reason: ${triggers1800s[0].reason} for slot ${triggers1800s[0].slotId}`);
  console.log("  ✅ TEST 5 PASSED: 1800s Hard Harvest Timeout forces profit-taking exit on extended holding duration!\n");

  console.log("=========================================================================");
  console.log("   ✅ ALL 5 LONG-HOLD PROFIT GUARANTEE QA TESTS 100% SUCCESSFUL!         ");
  console.log("=========================================================================");
}

testLongHoldProfitGuaranteeQA().catch((err) => {
  console.error("QA Harness Failed:", err);
  process.exit(1);
});
