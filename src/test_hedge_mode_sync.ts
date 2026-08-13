import { MarketDataClient } from "./marketDataClient";
import { StrategyEngine } from "./strategy/engine";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient, BinancePositionRisk } from "./execution/binance";

async function testHedgeModeSync() {
  console.log("=========================================================================");
  console.log("RUNNING HEDGE MODE DUAL-DIRECTIONAL POSITION SYNC VERIFICATION TEST");
  console.log("=========================================================================");

  const sab = new SharedArrayBuffer(20480);
  const client = new MarketDataClient(sab);
  const riskGuard = new RiskGuard();
  const executionClient = new BinanceExecutionClient();

  const strategyEngine = new StrategyEngine(client, riskGuard, executionClient, {
    symbol: "ETHUSDT",
    assetIndex: 1,
    orderQuantity: 0.032,
    longTakeProfitPercent: 0.35,
    longStopLossPercent: 0.25,
  });

  // Mock Binance positionRisk response representing Binance in Hedge Mode with BOTH a Long and Short position on ETHUSDT
  const mockPositions: BinancePositionRisk[] = [
    {
      symbol: "ETHUSDT",
      positionAmt: "0.032",
      entryPrice: "1874.45",
      markPrice: "1874.45",
      unRealizedProfit: "0.00",
      liquidationPrice: "0",
      leverage: "10",
      maxNotionalValue: "1000000",
      marginType: "cross",
      isolatedMargin: "0.00000000",
      isAutoAddMargin: "false",
      positionSide: "LONG",
      notional: "59.98",
      isolatedWallet: "0",
      updateTime: Date.now(),
    },
    {
      symbol: "ETHUSDT",
      positionAmt: "-0.032",
      entryPrice: "1874.45",
      markPrice: "1874.45",
      unRealizedProfit: "0.00",
      liquidationPrice: "0",
      leverage: "10",
      maxNotionalValue: "1000000",
      marginType: "cross",
      isolatedMargin: "0.00000000",
      isAutoAddMargin: "false",
      positionSide: "SHORT",
      notional: "59.98",
      isolatedWallet: "0",
      updateTime: Date.now(),
    },
  ];

  // 1. Reconcile startup positions
  strategyEngine.reconcileStartupPositions(mockPositions);

  // 2. Verify both coreLong and shortSlots are occupied simultaneously
  const coreLong = strategyEngine.getHedgeLedger().getCoreLong();
  const shortSlots = strategyEngine.getHedgeLedger().getShortSlots();

  if (!coreLong.isOccupied || coreLong.quantity !== 0.032) {
    throw new Error(`FAIL: Core Long not occupied or quantity mismatched! Got: ${coreLong.quantity}`);
  }

  if (!shortSlots[0].isOccupied || shortSlots[0].quantity !== 0.032) {
    throw new Error(`FAIL: Short Slot #0 not occupied or quantity mismatched! Got: ${shortSlots[0].quantity}`);
  }

  console.log("✓ Test 1 Passed: Both Core Long (0.032) and Short Slot #0 (0.032) occupied in local HedgePositionLedger.");

  // 3. Verify position ledger summary
  const summary = strategyEngine.getHedgeLedger().getSummary(1874.45);
  console.log(`Position Summary -> Side: ${summary.side}, NetQty: ${summary.netQuantity}, AvgEntry: $${summary.averageEntryPrice}`);

  if (summary.side !== "BOTH") {
    throw new Error(`FAIL: PositionLedger summary side must be 'BOTH', got '${summary.side}'`);
  }

  if (summary.netQuantity !== 0.064) {
    throw new Error(`FAIL: PositionLedger summary gross netQuantity must be 0.064, got ${summary.netQuantity}`);
  }

  console.log("✓ Test 2 Passed: HedgePositionLedger summary correctly identifies 'BOTH' side and non-zero gross quantity (0.064).");

  // 4. Verify SAB Position State Synchronization
  strategyEngine.syncSabPositionState(1874.45);
  const omsQty = client.getOmsPositionQty(1);
  const omsSideCode = client.getOmsPositionSide(1);

  console.log(`SAB Metrics -> OmsPositionQty: ${omsQty}, OmsPositionSideCode: ${omsSideCode}`);

  if (Math.abs(omsQty - 0.064) > 1e-5) {
    throw new Error(`FAIL: SAB OMS Position Quantity must be 0.064, got ${omsQty}`);
  }

  if (omsSideCode !== 3.0) {
    throw new Error(`FAIL: SAB OMS Position Side Code must be 3.0 (BOTH), got ${omsSideCode}`);
  }

  console.log("✓ Test 3 Passed: SAB memory state correctly populated with 0.064 gross size and 3.0 (BOTH) side code.");

  // 5. Verify Active Trades array contains 2 distinct active slots (1 LONG, 1 SHORT)
  const activeTradeSlots = strategyEngine.getActiveTrades(1874.45);
  console.log(`Active Trade Slots count: ${activeTradeSlots.length}`);
  if (activeTradeSlots.length !== 2) {
    throw new Error(`FAIL: Expected 2 active trade slots (1 LONG, 1 SHORT), got ${activeTradeSlots.length}`);
  }

  console.log(`Slot 1: ${activeTradeSlots[0].side} ${activeTradeSlots[0].size} @ $${activeTradeSlots[0].entryPrice}`);
  console.log(`Slot 2: ${activeTradeSlots[1].side} ${activeTradeSlots[1].size} @ $${activeTradeSlots[1].entryPrice}`);

  console.log("✓ Test 4 Passed: StrategyEngine returns 2 distinct active trade slots for execution & telemetry monitoring.");

  console.log("=========================================================================");
  console.log("✅ HEDGE MODE DUAL-DIRECTIONAL POSITION SYNC TEST PASSED PERFECTLY!");
  console.log("=========================================================================");
}

testHedgeModeSync().catch((err) => {
  console.error("❌ TEST FAILED:", err);
  process.exit(1);
});
