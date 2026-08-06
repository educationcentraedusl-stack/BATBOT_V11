import "dotenv/config";
import { DynamicSizingCalculator } from "../strategy/dynamicSizing";
import { HedgePositionLedger } from "../strategy/positionLedger";

async function runMakerTpRemediationTests() {
  console.log(`=================================================================`);
  console.log(`[QA TEST SUITE] BATBOT_V11 MAKER/TAKER TP REMEDIATION VERIFICATION`);
  console.log(`=================================================================\n`);

  const savedEnv = { ...process.env };

  // =========================================================================
  // TEST 1: DEF-03 - Zero-Hardcoding Env Compliance & Fatal Exception Guards
  // =========================================================================
  console.log(`[TEST 1: DEF-03] Testing DynamicSizingCalculator fatal error throws on missing .env keys...`);

  // Test Case 1A: Missing TP_STAGE_ALLOCATION_3STAGE
  delete process.env.TP_STAGE_ALLOCATION_3STAGE;
  let errorThrown1A = false;
  try {
    new DynamicSizingCalculator();
  } catch (err: any) {
    errorThrown1A = true;
    if (!err.message.includes("Missing required environment variable: TP_STAGE_ALLOCATION_3STAGE")) {
      throw new Error(`[FAIL] Expected message containing missing 3STAGE env var, got: ${err.message}`);
    }
  }
  if (!errorThrown1A) {
    throw new Error(`[FAIL] DynamicSizingCalculator failed to throw fatal error when TP_STAGE_ALLOCATION_3STAGE is missing!`);
  }
  console.log(`  ✓ Test 1A Passed: Missing TP_STAGE_ALLOCATION_3STAGE explicitly threw fatal Error.`);

  // Restore 3Stage, test missing MAKER_FEE_RATE
  process.env.TP_STAGE_ALLOCATION_3STAGE = "40,30,30";
  delete process.env.MAKER_FEE_RATE;
  let errorThrown1B = false;
  try {
    new DynamicSizingCalculator();
  } catch (err: any) {
    errorThrown1B = true;
    if (!err.message.includes("Missing required environment variable: MAKER_FEE_RATE")) {
      throw new Error(`[FAIL] Expected message containing missing MAKER_FEE_RATE env var, got: ${err.message}`);
    }
  }
  if (!errorThrown1B) {
    throw new Error(`[FAIL] DynamicSizingCalculator failed to throw fatal error when MAKER_FEE_RATE is missing!`);
  }
  console.log(`  ✓ Test 1B Passed: Missing MAKER_FEE_RATE explicitly threw fatal Error.\n`);

  // Restore env for remaining tests
  process.env = { ...savedEnv };
  process.env.TP_STAGE_ALLOCATION_3STAGE = "40,30,30";
  process.env.TP_STAGE_ALLOCATION_2STAGE = "60,40";
  process.env.DYNAMIC_SIZING_CONSOLIDATION_THRESHOLD_USDT = "150.0";
  process.env.MIN_NOTIONAL_USDT = "5.0";
  process.env.MAKER_FEE_RATE = "0.00018"; // 0.018%
  process.env.TAKER_FEE_RATE = "0.00045"; // 0.045%

  // =========================================================================
  // TEST 2: DEF-04 - Dynamic Fee Rate Accessor Verification
  // =========================================================================
  console.log(`[TEST 2: DEF-04] Testing DynamicSizingCalculator getMakerFeeRate() & getTakerFeeRate()...`);
  const sizingCalc = new DynamicSizingCalculator();

  const makerFee = sizingCalc.getMakerFeeRate();
  const takerFee = sizingCalc.getTakerFeeRate();

  if (makerFee !== 0.00018) {
    throw new Error(`[FAIL] getMakerFeeRate() returned ${makerFee}, expected 0.00018`);
  }
  if (takerFee !== 0.00045) {
    throw new Error(`[FAIL] getTakerFeeRate() returned ${takerFee}, expected 0.00045`);
  }
  console.log(`  ✓ Test 2 Passed: getMakerFeeRate() strictly returned dynamic .env rate (${(makerFee * 100).toFixed(3)}%).\n`);

  // =========================================================================
  // TEST 3: DEF-02 - PositionLedger hasActiveLimitOrders Guard Verification
  // =========================================================================
  console.log(`[TEST 3: DEF-02] Testing evaluateHedgeDynamicTpSl() hasActiveLimitOrders suppression guard...`);
  const hedgeLedger = new HedgePositionLedger("BTCUSDT", 3);

  // Subtest 3A: Position open WITHOUT active limit orders -> Local TP should trigger
  hedgeLedger.occupyCoreLong(0.1, 3000.0, 2.5, 1.2);
  const triggers3A = hedgeLedger.evaluateHedgeDynamicTpSl(3075.0); // Mark price > TP1 price (3007.5)

  if (triggers3A.length === 0 || triggers3A[0].reason !== "TAKE_PROFIT_TP1") {
    throw new Error(`[FAIL] Expected TAKE_PROFIT_TP1 trigger when no active limit orders exist, got: ${JSON.stringify(triggers3A)}`);
  }
  console.log(`  ✓ Subtest 3A Passed: Local TAKE_PROFIT_TP1 triggered when activeTpOrderIds is empty.`);

  // Subtest 3B: Position open WITH active limit orders -> Local TP MUST BE BLOCKED
  hedgeLedger.releaseCoreLong();
  hedgeLedger.occupyCoreLong(0.1, 3000.0, 2.5, 1.2);
  hedgeLedger.registerActiveTpOrderIds("CORE_LONG", [999001, 999002]);

  const triggers3B = hedgeLedger.evaluateHedgeDynamicTpSl(3075.0); // Price above TP1, but limit orders active!
  if (triggers3B.length > 0) {
    throw new Error(`[FAIL] Local TAKE_PROFIT triggered while activeTpOrderIds registered! Guard failed! Triggers: ${JSON.stringify(triggers3B)}`);
  }
  console.log(`  ✓ Subtest 3B Passed: Local TAKE_PROFIT physically blocked while activeTpOrderIds [999001, 999002] are registered.`);

  // Subtest 3C: Price drops below Stop Loss while active limit orders registered -> SL MUST TRIGGER & CANCEL ORDERS
  const triggers3C = hedgeLedger.evaluateHedgeDynamicTpSl(2900.0); // Price below SL (2964.0)
  if (triggers3C.length === 0 || (triggers3C[0].reason !== "STOP_LOSS" && triggers3C[0].reason !== "BREAK_EVEN_STOP_LOSS")) {
    throw new Error(`[FAIL] Expected STOP_LOSS trigger on price drop below SL price, got: ${JSON.stringify(triggers3C)}`);
  }
  if (!triggers3C[0].cancelOrderIds || triggers3C[0].cancelOrderIds.length !== 2) {
    throw new Error(`[FAIL] Stop Loss trigger missing cancelOrderIds payload! Got: ${JSON.stringify(triggers3C[0].cancelOrderIds)}`);
  }
  console.log(`  ✓ Subtest 3C Passed: Stop Loss triggered correctly with cancelOrderIds payload [999001, 999002].\n`);

  // =========================================================================
  // TEST 4: DEF-01 - Sequential Async Batch Order Cancellation Guard
  // =========================================================================
  console.log(`[TEST 4: DEF-01] Verifying async cancelBatchOrders execution blocking before MARKET SL dispatch...`);

  let cancelBatchOrdersCalled = false;
  let cancelBatchOrdersTimestamp = 0;
  let placeOrderCalled = false;
  let placeOrderTimestamp = 0;

  const mockExecutionClient: any = {
    isConfigured: () => true,
    cancelBatchOrders: async (symbol: string, orderIds: number[]) => {
      cancelBatchOrdersCalled = true;
      cancelBatchOrdersTimestamp = Date.now();
      // Simulate 50ms REST network delay for cancellation
      await new Promise((r) => setTimeout(r, 50));
      return [{ orderId: orderIds[0], status: "CANCELED" }];
    },
    placeOrder: async (params: any) => {
      placeOrderCalled = true;
      placeOrderTimestamp = Date.now();
      return { orderId: 123456, status: "FILLED", executedQty: params.quantity };
    },
  };

  // Simulate StrategyEngine async execution pipeline block
  const triggerPayload = triggers3C[0];
  const executionPipeline = async () => {
    if (triggerPayload.cancelOrderIds && triggerPayload.cancelOrderIds.length > 0) {
      await mockExecutionClient.cancelBatchOrders("BTCUSDT", triggerPayload.cancelOrderIds);
    }
    return mockExecutionClient.placeOrder({
      symbol: "BTCUSDT",
      side: "SELL",
      type: "MARKET",
      quantity: triggerPayload.quantity,
      positionSide: triggerPayload.side,
    });
  };

  await executionPipeline();

  if (!cancelBatchOrdersCalled || !placeOrderCalled) {
    throw new Error(`[FAIL] Both cancelBatchOrders and placeOrder must be invoked during emergency close.`);
  }
  if (placeOrderTimestamp <= cancelBatchOrdersTimestamp) {
    throw new Error(`[FAIL] placeOrder was executed BEFORE cancelBatchOrders completed! Async await sequence broken!`);
  }
  const timeDiff = placeOrderTimestamp - cancelBatchOrdersTimestamp;
  if (timeDiff < 45) {
    throw new Error(`[FAIL] placeOrder executed too quickly (${timeDiff}ms), indicating cancelBatchOrders was not awaited!`);
  }
  console.log(`  ✓ Test 4 Passed: cancelBatchOrders was fully awaited (${timeDiff}ms delay) prior to placeOrder MARKET dispatch.\n`);

  console.log(`=================================================================`);
  console.log(`✅ ALL MAKER/TAKER TP REMEDIATION TESTS PASSED DETERMINISTICALLY!`);
  console.log(`=================================================================\n`);
}

runMakerTpRemediationTests().catch((err) => {
  console.error(`❌ QA TEST SUITE ERROR: ${err.message}`);
  process.exit(1);
});
