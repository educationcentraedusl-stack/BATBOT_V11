import * as assert from "assert";
import { StrategyEngine } from "../strategy/engine";
import { MarketDataClient } from "../marketDataClient";
import { BinanceExecutionClient, BinanceOrderParams, BinanceOrderResponse } from "../execution/binance";
import { RiskGuard } from "../strategy/risk";
import { HedgePositionLedger } from "../strategy/positionLedger";

async function runSotaRestingOrderSpreadAnnihilationTests() {
  console.log("================================================================================");
  console.log("  TEST SUITE: SOTA 4-TIER SPREAD SHIELD & AROS-CA ANNIHILATION VERIFICATION     ");
  console.log("================================================================================");

  const slotsPerAsset = 256;
  const maxAssets = 10;
  const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
  const client = new MarketDataClient(sab, maxAssets, slotsPerAsset);
  const riskGuard = new RiskGuard();
  const mockExecutionClient = new BinanceExecutionClient();

  let cancelledOrderIds: number[] = [];
  let placedOrders: BinanceOrderParams[] = [];

  mockExecutionClient.isConfigured = () => true;
  mockExecutionClient.cancelOrder = async (symbol: string, orderId: number | string): Promise<BinanceOrderResponse> => {
    const numericId = typeof orderId === "number" ? orderId : parseInt(orderId, 10);
    cancelledOrderIds.push(numericId);
    return {
      symbol,
      orderId: numericId,
      clientOrderId: "CANCEL_CID",
      price: "0",
      avgPrice: "0",
      origQty: "0",
      executedQty: "0",
      cumQuote: "0",
      status: "CANCELED",
      timeInForce: "GTC",
      type: "LIMIT",
      reduceOnly: false,
      side: "BUY",
      positionSide: "SHORT",
      stopPrice: "0",
      workingType: "CONTRACT_PRICE",
      updateTime: Date.now(),
    };
  };
  mockExecutionClient.placeOrder = async (params: BinanceOrderParams): Promise<BinanceOrderResponse> => {
    placedOrders.push(params);
    // Return pending resting LIMIT order
    return {
      symbol: params.symbol,
      orderId: 888123,
      clientOrderId: params.clientOrderId || "CID_TEST",
      price: String(params.price || "79050.0"),
      avgPrice: "0",
      origQty: String(params.quantity),
      executedQty: "0",
      cumQuote: "0",
      status: "NEW",
      timeInForce: "GTX",
      type: "LIMIT",
      reduceOnly: false,
      side: params.side,
      positionSide: params.positionSide || "SHORT",
      stopPrice: "0",
      workingType: "CONTRACT_PRICE",
      updateTime: Date.now(),
    };
  };

  const hedgeLedger = new HedgePositionLedger("BTCUSDT", 3);
  const engine = new StrategyEngine(
    client,
    riskGuard,
    mockExecutionClient,
    {
      symbol: "BTCUSDT",
      assetIndex: 0,
      minAiConfidence: 0.60,
      aggressiveConfidenceThreshold: 0.70,
      maxSpreadBtc: 1.50,
      orderQuantity: 0.001,
      tradeSizeUsdt: 60.0,
      obiBuyThreshold: 0.10,
      obiSellThreshold: -0.10,
    },
    hedgeLedger.getLegacyLedger(),
    hedgeLedger
  );

  const nowMs = Date.now();
  const nowNs = BigInt(nowMs) * 1000000n;
  const bigIntView = new BigInt64Array(sab);
  bigIntView[0] = nowNs; // Fresh timestamp
  bigIntView[92] = 1n;   // Seq #1

  // ============================================================================
  // STAGE 1: TIGHT SPREAD PLACES RESTING LIMIT ORDER
  // ============================================================================
  console.log("\n[STAGE 1] Testing Resting Limit Order Placement under Tight Spread ($0.20)...");
  client.writeAtomicFloat64Asset(0, 4, 79050.0); // Best Bid
  client.writeAtomicFloat64Asset(0, 6, 79050.20); // Best Ask ($0.20 spread <= $1.50 cap)
  client.writeAtomicFloat64Asset(0, 93, -0.95);  // AI Dir (-0.95 Bearish)
  client.writeAtomicFloat64Asset(0, 94, 0.90);   // AI Conf (90%)
  client.writeAtomicFloat64Asset(0, 1, -0.50);   // OBI (-0.50)
  client.writeAtomicFloat64Asset(0, 2, -5.0);    // CVD

  const res1 = engine.evaluateTick();
  console.log(`  -> Signal Type: ${res1.signalType}, Target Side: ${res1.positionSide}`);
  assert.strictEqual(res1.signalType, "SELL", "Stage 1: Must generate SELL signal on tight spread");
  assert.ok(res1.executionPromise, "Stage 1: executionPromise must be present");

  // Await order dispatch
  const orderRes = await res1.executionPromise;
  assert.ok(orderRes, "Stage 1: Order response must be returned");
  assert.strictEqual(orderRes?.orderId, 888123, "Stage 1: Order ID must match mock");
  assert.strictEqual(hedgeLedger.getShortSlots()[0].lifecycleState, "PENDING_ENTRY", "Stage 1: Slot 0 must be PENDING_ENTRY");
  console.log("  ✅ STAGE 1 PASSED: Limit order #888123 placed & resting on Binance orderbook (PENDING_ENTRY).");

  // ============================================================================
  // STAGE 2: TIER-1 AROS-CA SPREAD BLOWOUT RESTING ORDER ANNIHILATION
  // ============================================================================
  console.log("\n[STAGE 2] Testing AROS-CA: Orderbook Blows Out ($60.30 Spread) -> Annihilation...");
  bigIntView[92] = 2n; // Seq #2
  // Simulate market maker retreat / spread blowout to $60.30 on BTC
  client.writeAtomicFloat64Asset(0, 4, 79000.0); // Best Bid
  client.writeAtomicFloat64Asset(0, 6, 79060.30); // Best Ask ($60.30 spread > $1.50 cap)

  const res2 = engine.evaluateTick();
  console.log(`  -> Tick #2 Signal Type: ${res2.signalType}, Reason: ${res2.riskResult?.reasonCode}`);
  assert.strictEqual(res2.signalType, "NONE", "Stage 2: Must reject tick evaluation on blowout");

  // Verify AROS-CA triggered immediate cancellation of resting order #888123
  assert.ok(cancelledOrderIds.includes(888123), "Stage 2: Resting Order #888123 MUST be cancelled on Binance!");
  assert.strictEqual(hedgeLedger.getShortSlots()[0].lifecycleState, "FLAT", "Stage 2: Slot 0 must be rolled back to FLAT");
  assert.strictEqual(hedgeLedger.getShortSlots()[0].isOccupied, false, "Stage 2: Slot 0 must NOT be occupied");
  console.log("  ✅ STAGE 2 PASSED: AROS-CA swept and annihilated resting order #888123, restored slot to FLAT!");

  // ============================================================================
  // STAGE 3: TIER-3 PRE-FLIGHT SPREAD BLOWOUT BARRIER INTERCEPTION
  // ============================================================================
  console.log("\n[STAGE 3] Testing Tier-3 Transport-Level Pre-Flight Spread Barrier...");
  bigIntView[92] = 3n;
  placedOrders = [];
  cancelledOrderIds = [];

  // Reset cooldown locks and provide fresh timestamp for Stage 3 evaluation
  client.setShortCooldownLock(0, 0);
  client.setLongCooldownLock(0, 0);
  const stage3Now = Date.now();
  bigIntView[0] = BigInt(stage3Now) * 1000000n;

  // Set tight initial spread ($0.20 spread) to trigger SELL entry signal
  client.writeAtomicFloat64Asset(0, 4, 79050.0);
  client.writeAtomicFloat64Asset(0, 6, 79050.20);
  client.writeAtomicFloat64Asset(0, 93, -0.95);  // AI Dir (-0.95 Bearish)
  client.writeAtomicFloat64Asset(0, 94, 0.90);   // AI Conf (90%)
  client.writeAtomicFloat64Asset(0, 1, -0.50);   // OBI (-0.50)
  client.writeAtomicFloat64Asset(0, 2, -5.0);    // CVD

  const preflightLedger = new HedgePositionLedger("BTCUSDT", 3);
  const preflightEngine = new StrategyEngine(
    client,
    riskGuard,
    mockExecutionClient,
    {
      symbol: "BTCUSDT",
      assetIndex: 0,
      minAiConfidence: 0.60,
      aggressiveConfidenceThreshold: 0.70,
      maxSpreadBtc: 1.50,
      orderQuantity: 0.001,
      tradeSizeUsdt: 60.0,
      obiBuyThreshold: 0.10,
      obiSellThreshold: -0.10,
    },
    preflightLedger.getLegacyLedger(),
    preflightLedger
  );

  // Hook getBestAskPrice to simulate concurrent Rust WebSocket ingestion mutating SAB right at the pre-flight check
  let askReadCount = 0;
  const originalGetBestAsk = client.getBestAskPrice.bind(client);
  client.getBestAskPrice = (assetIdx: number) => {
    askReadCount++;
    if (askReadCount > 1) {
      // Simulate concurrent Rust WebSocket ingestion blowing out spread to $40.0 right before socket write
      client.writeAtomicFloat64Asset(0, 6, 79090.0);
      return 79090.0;
    }
    return originalGetBestAsk(assetIdx);
  };

  const res3 = preflightEngine.evaluateTick();
  // Restore original getter
  client.getBestAskPrice = originalGetBestAsk;

  assert.strictEqual(res3.signalType, "SELL", "Stage 3: Signal must be generated under initial tight spread");
  assert.ok(res3.executionPromise, "Stage 3: executionPromise must be instantiated");

  // Await pre-flight promise resolution
  const preflightOrderRes = await res3.executionPromise;
  assert.strictEqual(preflightOrderRes, null, "Stage 3: Pre-flight barrier MUST return null on blowout");
  assert.strictEqual(placedOrders.length, 0, "Stage 3: mockExecutionClient.placeOrder must NEVER be called!");
  assert.strictEqual(preflightLedger.getShortSlots()[0].lifecycleState, "FLAT", "Stage 3: Slot reservation must be rolled back to FLAT");
  assert.strictEqual(preflightLedger.getShortSlots()[0].isOccupied, false, "Stage 3: Slot must remain unoccupied");
  console.log("  ✅ STAGE 3 PASSED: Pre-flight barrier intercepted blowout ($40.0 > $1.50), blocked socket write, and rolled back slot to FLAT.");

  // ============================================================================
  // STAGE 4: TIER-4 DYNAMIC GRID SPREAD GATING IN POSITION LEDGER
  // ============================================================================
  console.log("\n[STAGE 4] Testing Tier-4 Dynamic Grid Spread Gating in HedgePositionLedger...");
  const gridLedger = new HedgePositionLedger("BTCUSDT", 3);
  const tightAlloc = gridLedger.evaluateDispersedShortSlotAllocation(79000.0, 0.1, 0.005, 1.2, 0, nowMs, 0.50, 1.50);
  assert.ok(tightAlloc !== null, "Stage 4: Tight spread must permit slot allocation");
  assert.strictEqual(tightAlloc?.slotIndex, 0, "Stage 4: First slot index must be 0");

  const blowoutAlloc = gridLedger.evaluateDispersedShortSlotAllocation(79000.0, 0.1, 0.005, 1.2, 0, nowMs, 60.30, 1.50);
  assert.strictEqual(blowoutAlloc, null, "Stage 4: Blown-out spread (60.30 > 1.50) MUST strictly reject slot allocation");
  console.log("  ✅ STAGE 4 PASSED: Dynamic Grid Spread Gating strictly rejected allocation on blown-out spread.");

  console.log("\n================================================================================");
  console.log("  ALL 4 STAGES OF 4-TIER SPREAD SHIELD & AROS-CA VERIFIED (100% SUCCESS)         ");
  console.log("================================================================================");
}

runSotaRestingOrderSpreadAnnihilationTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
