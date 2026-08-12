import { MarketDataClient } from "./marketDataClient";
import { StrategyEngine } from "./strategy/engine";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient, BinancePositionRisk } from "./execution/binance";

async function testStateRecovery() {
  console.log("=================================================");
  console.log("RUNNING STARTUP STATE RECOVERY VERIFICATION TEST");
  console.log("=================================================");

  const sab = new SharedArrayBuffer(20480);
  const client = new MarketDataClient(sab);
  const riskGuard = new RiskGuard();
  const executionClient = new BinanceExecutionClient();

  const strategyEngine = new StrategyEngine(client, riskGuard, executionClient, {
    symbol: "ETHUSDT",
    assetIndex: 0,
    orderQuantity: 0.038,
    longTakeProfitPercent: 0.35,
    longStopLossPercent: 0.25,
  });

  // Mock Binance positionRisk response representing the user's active Binance position (0.038 ETH LONG @ 1875.22)
  const mockPositions: BinancePositionRisk[] = [
    {
      symbol: "ETHUSDT",
      positionAmt: "0.038",
      entryPrice: "1875.22",
      markPrice: "1876.03",
      unRealizedProfit: "-0.0308",
      liquidationPrice: "0",
      leverage: "5",
      maxNotionalValue: "1000000",
      marginType: "cross",
      isolatedMargin: "0.00000000",
      isAutoAddMargin: "false",
      positionSide: "LONG",
      notional: "71.25",
      isolatedWallet: "0",
      updateTime: Date.now(),
    },
    {
      symbol: "ETHUSDT",
      positionAmt: "0",
      entryPrice: "0.00000000",
      markPrice: "1876.03",
      unRealizedProfit: "0",
      liquidationPrice: "0",
      leverage: "5",
      maxNotionalValue: "1000000",
      marginType: "cross",
      isolatedMargin: "0.00000000",
      isAutoAddMargin: "false",
      positionSide: "SHORT",
      notional: "0",
      isolatedWallet: "0",
      updateTime: Date.now(),
    },
  ];

  // 1. Reconcile startup positions
  strategyEngine.reconcileStartupPositions(mockPositions);

  // 2. Verify active trades monitor returns recovered position
  const activeTrades = strategyEngine.getActiveTrades(1876.03);
  console.log(`Active trades recovered count: ${activeTrades.length}`);
  if (activeTrades.length !== 1) {
    throw new Error(`FAIL: Expected 1 active trade, got ${activeTrades.length}`);
  }

  const trade = activeTrades[0];
  console.log(`Recovered Trade Symbol: ${trade.symbol}, Side: ${trade.side}, Size: ${trade.size}, Entry: $${trade.entryPrice}`);
  if (trade.symbol !== "ETHUSDT" || trade.side !== "BUY/LONG" || trade.size !== 0.038 || trade.entryPrice !== 1875.22) {
    throw new Error(`FAIL: Recovered trade fields mismatched!`);
  }
  console.log("✓ Test 1 Passed: Startup position successfully injected into HedgePositionLedger.");

  // 3. Verify position ledger summary
  const summary = strategyEngine.getPositionLedger().getSummary(1876.03);
  if (summary.side !== "LONG" || summary.netQuantity !== 0.038 || summary.averageEntryPrice !== 1875.22) {
    throw new Error(`FAIL: PositionLedger summary mismatch: side=${summary.side}, netQty=${summary.netQuantity}`);
  }
  console.log("✓ Test 2 Passed: PositionLedger summary correctly aligned with recovered position.");

  // Write seq #1 in Slot 92 and Best Bid = 1882.0 (Slot 4), Best Ask = 1882.5 (Slot 6)
  const bitBuf = new ArrayBuffer(8);
  const fView = new Float64Array(bitBuf);
  const bView = new BigInt64Array(bitBuf);

  Atomics.store(new BigInt64Array(sab), 92, 1n);

  fView[0] = 1882.0;
  Atomics.store(new BigInt64Array(sab), 4, bView[0]);

  fView[0] = 1882.5;
  Atomics.store(new BigInt64Array(sab), 6, bView[0]);

  const tickResult = strategyEngine.evaluateTick();
  console.log(`Tick Result Signal: ${tickResult.signalType}, PositionSide: ${tickResult.positionSide}, ExitReason: ${tickResult.exitReason}`);

  if (tickResult.signalType !== "SELL" || tickResult.positionSide !== "LONG" || !tickResult.exitReason?.startsWith("TAKE_PROFIT")) {
    throw new Error(`FAIL: AI monitoring loop failed to trigger dynamic exit for recovered position! Got: ${tickResult.exitReason}`);
  }
  console.log("✓ Test 3 Passed: AI Monitoring Loop dynamically intercepted and triggered TAKE_PROFIT exit for recovered trade.");

  console.log("=================================================");
  console.log("✅ ALL STARTUP STATE RECOVERY TESTS PASSED!");
  console.log("=================================================");
}

testStateRecovery().catch((err) => {
  console.error("❌ VERIFICATION TEST FAILED:", err);
  process.exit(1);
});
