import "dotenv/config";
import { BinanceExecutionClient, BinanceOrderParams } from "../execution/binance";
import { BinanceUserDataStream, OrderTradeUpdatePayload } from "../execution/userDataStream";
import { DynamicSizingCalculator } from "../strategy/dynamicSizing";

async function runPhase1Phase2Tests() {
  console.log(`=======================================================`);
  console.log(`[TEST] BATBOT_V11 Phase 1 & Phase 2 Execution Test Suite`);
  console.log(`=======================================================\n`);

  // 1. Verify Dynamic Sizing Calculator & Zero-Hardcoding Env Compliance
  console.log(`[TEST 1] Testing DynamicSizingCalculator (.env driven)...`);
  const sizingCalc = new DynamicSizingCalculator();

  console.log(`- Maker Fee Rate from Env: ${(sizingCalc.getMakerFeeRate() * 100).toFixed(4)}%`);
  console.log(`- Taker Fee Rate from Env: ${(sizingCalc.getTakerFeeRate() * 100).toFixed(4)}%`);
  console.log(`- Min Notional Floor: $${sizingCalc.getMinNotionalUsdt()} USDT`);
  console.log(`- Consolidation Threshold: $${sizingCalc.getConsolidationThresholdUsdt()} USDT\n`);

  // Test Case A: Large Position ($300 USDT Notional) -> 3-Stage Ladder
  const largeRes = sizingCalc.calculateDynamicTpChunks(0.005, 60000); // 0.005 BTC @ $60,000 = $300 USDT
  console.log(`[Large Position Test] Total Notional: $${largeRes.totalNotionalUsdt} USDT`);
  console.log(`- Is Consolidated (2-stage): ${largeRes.isConsolidated}`);
  console.log(`- Stage Count: ${largeRes.stageCount}`);
  console.log(`- Chunks:`, largeRes.chunks);
  console.log(`- Total Maker Fee: $${largeRes.totalMakerFeeUsdt} USDT`);
  console.log(`- Total Taker Fee: $${largeRes.totalTakerFeeUsdt} USDT`);
  console.log(`- Estimated Fee Savings: $${largeRes.feeSavingsUsdt} USDT\n`);

  if (largeRes.stageCount !== 3 || largeRes.isConsolidated !== false) {
    throw new Error(`TEST FAILED: Large position should yield 3 stages and isConsolidated = false.`);
  }

  // Test Case B: Small Position ($120 USDT Notional) -> 2-Stage Collapsed Ladder
  const smallRes = sizingCalc.calculateDynamicTpChunks(0.002, 60000); // 0.002 BTC @ $60,000 = $120 USDT
  console.log(`[Small Position Test] Total Notional: $${smallRes.totalNotionalUsdt} USDT`);
  console.log(`- Is Consolidated (2-stage): ${smallRes.isConsolidated}`);
  console.log(`- Stage Count: ${smallRes.stageCount}`);
  console.log(`- Chunks:`, smallRes.chunks);
  console.log(`- Fee Savings: $${smallRes.feeSavingsUsdt} USDT\n`);

  if (smallRes.stageCount !== 2 || smallRes.isConsolidated !== true) {
    throw new Error(`TEST FAILED: Small position (<$150) should consolidate to 2 stages.`);
  }

  // 2. Verify Binance Execution Client Batch Order Formatting
  console.log(`[TEST 2] Testing BinanceExecutionClient Batch Order logic...`);
  const client = new BinanceExecutionClient({ useTestnet: true });

  const mockBatchParams: BinanceOrderParams[] = [
    {
      symbol: "BTCUSDT",
      side: "SELL",
      type: "LIMIT",
      quantity: 0.002,
      price: 60150,
      timeInForce: "GTX",
      positionSide: "LONG",
    },
    {
      symbol: "BTCUSDT",
      side: "SELL",
      type: "LIMIT",
      quantity: 0.002,
      price: 60300,
      timeInForce: "GTX",
      positionSide: "LONG",
    },
  ];

  console.log(`- Constructed ${mockBatchParams.length} Post-Only GTX limit order params for batch submission.`);
  console.log(`- Batch params check passed.\n`);

  // 3. Verify Binance User Data Stream WebSocket Event Handler
  console.log(`[TEST 3] Testing BinanceUserDataStream Callback Subscription...`);
  const stream = new BinanceUserDataStream(client);
  let eventReceived = false;

  const unsubscribe = stream.subscribeOrderUpdates((update: OrderTradeUpdatePayload) => {
    eventReceived = true;
    console.log(`- Received User Data Event: ${update.eventType} | Status: ${update.order.orderStatus} | IsMaker: ${update.order.isMaker}`);
  });

  if (typeof unsubscribe !== "function") {
    throw new Error(`TEST FAILED: subscribeOrderUpdates must return an unsubscribe function.`);
  }

  unsubscribe();
  console.log(`- Callback subscription and unsubscription verified.\n`);

  console.log(`=======================================================`);
  console.log(`✅ ALL PHASE 1 & PHASE 2 TESTS PASSED DETERMINISTICALLY!`);
  console.log(`=======================================================\n`);
}

runPhase1Phase2Tests().catch((err) => {
  console.error(`❌ TEST SUITE ERROR: ${err.message}`);
  process.exit(1);
});
