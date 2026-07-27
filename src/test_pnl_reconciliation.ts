import { MarketDataClient } from "./marketDataClient";
import { StrategyEngine } from "./strategy/engine";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient } from "./execution/binance";
import { TradeLogger } from "./telemetry/logger";

const bitcastBuf = new ArrayBuffer(8);
const bitcastBigInt = new BigInt64Array(bitcastBuf);
const bitcastFloat = new Float64Array(bitcastBuf);

function setAtomicFloat(bigIntView: BigInt64Array, slot: number, val: number) {
  bitcastFloat[0] = val;
  Atomics.store(bigIntView, slot, bitcastBigInt[0]);
}

async function testPnlReconciliationIntegration() {
  console.log("==================================================");
  console.log("   RUNNING PnL RECONCILIATION INTEGRATION HARNESS ");
  console.log("==================================================");

  const sab = new SharedArrayBuffer(2048);
  const bigIntView = new BigInt64Array(sab);

  const client = new MarketDataClient(sab);
  const riskGuard = new RiskGuard({ minCooldownMs: 0 });
  const executionClient = new BinanceExecutionClient();
  const strategyEngine = new StrategyEngine(client, riskGuard, executionClient);
  const logger = new TradeLogger("data_test");

  // Step 1: BUY Signal tick at Bid=60000, Ask=60001
  Atomics.store(bigIntView, 92, 100n);
  setAtomicFloat(bigIntView, 1, 0.5); // OBI > 0.25
  setAtomicFloat(bigIntView, 2, 100.0); // CVD > 50
  setAtomicFloat(bigIntView, 3, 0.01); // SpreadVelocity
  setAtomicFloat(bigIntView, 4, 60000.0); // BestBid
  setAtomicFloat(bigIntView, 5, 1.0);
  setAtomicFloat(bigIntView, 6, 60001.0); // BestAsk
  setAtomicFloat(bigIntView, 7, 1.0);

  console.log("\n[STEP 1] Evaluating tick 1 (BUY Signal)...");
  const tick1 = strategyEngine.evaluateTick();
  console.log("  Signal 1:", tick1.signalType, "| Bid:", tick1.bidPrice, "| Ask:", tick1.askPrice);

  if (tick1.signalType !== "BUY") {
    throw new Error("Expected BUY signal on tick 1");
  }

  // Simulate execution fill for BUY order filled at 60001
  const buyFillQty = 0.001;
  const buyFillPx = 60001.0;
  const fee1 = buyFillPx * buyFillQty * 0.0004;

  const positionLedger = strategyEngine.getPositionLedger();
  const ledgerResult1 = positionLedger.processFill(
    "BTCUSDT",
    "BUY",
    buyFillPx,
    buyFillQty,
    fee1
  );

  console.log("  Buy Fill 1 Reconciliation:", {
    side: ledgerResult1.positionSideAfterFill,
    netQty: ledgerResult1.netQuantityAfterFill,
    avgEntryPrice: ledgerResult1.averageEntryPriceAfterFill,
    realizedPnl: ledgerResult1.realizedPnl,
  });

  logger.logExecution("BTCUSDT", "BUY", buyFillPx, buyFillQty, ledgerResult1.realizedPnl, fee1, 1);

  if (ledgerResult1.positionSideAfterFill !== "LONG" || ledgerResult1.realizedPnl !== 0) {
    throw new Error("Buy fill failed to enter LONG position with 0 realized PnL");
  }

  // Step 2: Mark-to-market Unrealized PnL check at 61000
  Atomics.store(bigIntView, 92, 101n);
  setAtomicFloat(bigIntView, 1, 0.0);
  setAtomicFloat(bigIntView, 2, 0.0);
  setAtomicFloat(bigIntView, 3, 0.01);
  setAtomicFloat(bigIntView, 4, 61000.0);
  setAtomicFloat(bigIntView, 6, 61001.0);

  strategyEngine.evaluateTick();
  const unrealizedPnl = positionLedger.getUnrealizedPnl(61000);
  console.log(`\n[STEP 2] Price moves to $61,000. Floating Unrealized PnL: $${unrealizedPnl.toFixed(4)}`);
  const expectedUnrealized = (61000 - 60001) * 0.001; // = 0.999
  if (Math.abs(unrealizedPnl - expectedUnrealized) > 1e-4) {
    throw new Error(`Unrealized PnL error. Expected ${expectedUnrealized}, got ${unrealizedPnl}`);
  }

  // Step 3: SELL Signal tick at Bid=61000, Ask=61001
  Atomics.store(bigIntView, 92, 102n);
  setAtomicFloat(bigIntView, 1, -0.5); // OBI < -0.25 (SELL)
  setAtomicFloat(bigIntView, 2, -100.0); // CVD < -50 (SELL)
  setAtomicFloat(bigIntView, 3, 0.01);
  setAtomicFloat(bigIntView, 4, 61000.0);
  setAtomicFloat(bigIntView, 6, 61001.0);

  console.log("\n[STEP 3] Evaluating tick 3 (SELL Signal)...");
  const tick3 = strategyEngine.evaluateTick();
  console.log("  Signal 3:", tick3.signalType);

  if (tick3.signalType !== "SELL") {
    throw new Error("Expected SELL signal on tick 3");
  }

  // Simulate execution fill for SELL order filled at 61000
  const sellFillQty = 0.001;
  const sellFillPx = 61000.0;
  const fee2 = sellFillPx * sellFillQty * 0.0004;

  const ledgerResult2 = positionLedger.processFill(
    "BTCUSDT",
    "SELL",
    sellFillPx,
    sellFillQty,
    fee2
  );

  console.log("  Sell Fill 2 Reconciliation:", {
    side: ledgerResult2.positionSideAfterFill,
    netQty: ledgerResult2.netQuantityAfterFill,
    realizedPnl: ledgerResult2.realizedPnl,
  });

  logger.logExecution("BTCUSDT", "SELL", sellFillPx, sellFillQty, ledgerResult2.realizedPnl, fee2, 1);

  // Expected Realized PnL = (61000 - 60001) * 0.001 - fee2 = 0.999 - 0.0244 = 0.9746
  const expectedRealizedPnl = (61000 - 60001) * 0.001 - fee2;
  console.log(`  Expected Realized PnL: $${expectedRealizedPnl.toFixed(4)}, Received: $${ledgerResult2.realizedPnl.toFixed(4)}`);

  if (ledgerResult2.positionSideAfterFill !== "FLAT" || Math.abs(ledgerResult2.realizedPnl - expectedRealizedPnl) > 1e-4) {
    throw new Error(`Sell fill Realized PnL reconciliation failed. Expected ${expectedRealizedPnl}, got ${ledgerResult2.realizedPnl}`);
  }

  const posSummary = positionLedger.getSummary(61000);
  const stats = logger.getStats({
    unrealizedPnl: posSummary.unrealizedPnl,
    positionSide: posSummary.side,
    netQuantity: posSummary.netQuantity,
    averageEntryPrice: posSummary.averageEntryPrice,
  });
  console.log("\n[STEP 4] Logger Stats Telemetry:", stats);

  if (stats.realizedPnl <= 0 || stats.winRatePercent !== 100) {
    throw new Error(`Logger stats fail. Expected positive realized PnL and 100% win rate. Received PnL: $${stats.realizedPnl}`);
  }

  await logger.close();

  console.log("\n==================================================");
  console.log("   ✅ PnL RECONCILIATION HARNESS 100% SUCCESSFUL! ");
  console.log("==================================================");
}

testPnlReconciliationIntegration().catch((err) => {
  console.error("Integration harness failed:", err);
  process.exit(1);
});
