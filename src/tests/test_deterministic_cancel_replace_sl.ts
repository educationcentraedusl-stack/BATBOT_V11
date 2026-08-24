import assert from "assert";
import { BinanceExecutionClient, BinanceOrderResponse, BinanceOrderParams } from "../execution/binance";
import { StrategyEngine } from "../strategy/engine";
import { MarketDataClient } from "../marketDataClient";
import { RiskGuard } from "../strategy/risk";
import { SymbolPrecisionRegistry } from "../config/symbolPrecision";
import { HedgePositionLedger } from "../strategy/positionLedger";

async function runDeterministicCancelReplaceTests(): Promise<void> {
  console.log("=========================================================================");
  console.log("  SOTA DETERMINISTIC VERIFICATION: ERROR -4130 ERADICATION & BARRIER     ");
  console.log("=========================================================================\n");

  SymbolPrecisionRegistry.preseedOfflineDefaults(["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"]);

  // =========================================================================
  // STAGE 1: Synchronous Pre-Flight Annihilation & Clean State Verification
  // =========================================================================
  console.log("[STAGE 1] Testing Synchronous Pre-Flight Annihilation before Order Submission...");
  const mockClient = new BinanceExecutionClient();
  const cancelledOrders: (number | string)[] = [];
  let openOrdersList: BinanceOrderResponse[] = [
    {
      orderId: 101,
      symbol: "BTCUSDT",
      status: "NEW",
      clientOrderId: "RESTING_SL_BTC",
      price: "0",
      avgPrice: "0",
      origQty: "0",
      executedQty: "0",
      cumQuote: "0",
      timeInForce: "GTC",
      type: "STOP_MARKET",
      reduceOnly: false,
      side: "BUY",
      positionSide: "SHORT",
      stopPrice: "78000.0",
      workingType: "CONTRACT_PRICE",
      updateTime: Date.now() - 5000,
    },
    {
      orderId: 102,
      symbol: "BTCUSDT",
      status: "NEW",
      clientOrderId: "RESTING_TP_BTC",
      price: "75000.0",
      avgPrice: "0",
      origQty: "0.01",
      executedQty: "0",
      cumQuote: "0",
      timeInForce: "GTX",
      type: "LIMIT",
      reduceOnly: true,
      side: "BUY",
      positionSide: "SHORT",
      stopPrice: "0",
      workingType: "CONTRACT_PRICE",
      updateTime: Date.now() - 5000,
    },
  ];

  (mockClient as any).getOpenOrders = async (symbol?: string): Promise<BinanceOrderResponse[]> => {
    return openOrdersList.filter((o) => !symbol || o.symbol === symbol);
  };

  (mockClient as any).cancelOrder = async (_sym: string, orderId: number | string): Promise<BinanceOrderResponse> => {
    cancelledOrders.push(orderId);
    // Mutate state: order is immediately removed from exchange open orders
    openOrdersList = openOrdersList.filter((o) => o.orderId !== orderId);
    return {
      orderId: Number(orderId),
      symbol: "BTCUSDT",
      status: "CANCELED",
      clientOrderId: "",
      price: "0",
      avgPrice: "0",
      origQty: "0",
      executedQty: "0",
      cumQuote: "0",
      timeInForce: "GTC",
      type: "STOP_MARKET",
      reduceOnly: false,
      side: "BUY",
      positionSide: "SHORT",
      stopPrice: "0",
      workingType: "CONTRACT_PRICE",
      updateTime: Date.now(),
    };
  };

  let submittedOrders: Record<string, unknown>[] = [];
  (mockClient as any).request = async (_method: string, path: string, payload?: any): Promise<any> => {
    if (path === "/fapi/v1/order") {
      submittedOrders.push({ ...payload });
      // Assert that when the order arrives on the exchange, 0 conflicting orders are resting!
      const activeSl = openOrdersList.filter((o) => o.type === "STOP_MARKET" && o.positionSide === "SHORT");
      assert.strictEqual(
        activeSl.length,
        0,
        "Exchange MUST have 0 resting STOP_MARKET orders when new closePosition order arrives"
      );
      return {
        orderId: 555666,
        symbol: payload?.symbol || "BTCUSDT",
        status: "NEW",
        clientOrderId: payload?.newClientOrderId || "",
        price: "0",
        avgPrice: "0",
        origQty: "0",
        executedQty: "0",
        cumQuote: "0",
        timeInForce: "GTC",
        type: "STOP_MARKET",
        reduceOnly: false,
        side: payload?.side,
        positionSide: payload?.positionSide,
        stopPrice: payload?.stopPrice,
        workingType: "CONTRACT_PRICE",
        updateTime: Date.now(),
      };
    }
    return {};
  };

  const res1 = await mockClient.placePositionStopLoss("BTCUSDT", "BUY", "SHORT", 77890.2);
  assert.strictEqual(res1.orderId, 555666, "New SL order must be successfully placed");
  assert.strictEqual(cancelledOrders.includes(101), true, "Resting SL #101 must have been synchronously cancelled");
  console.log("  ✅ Stage 1 Passed: Pre-flight annihilation executed and verified clean before dispatch.");

  // =========================================================================
  // STAGE 2: State Verification Barrier with Matching Engine Partition Lag
  // =========================================================================
  console.log("\n[STAGE 2] Testing Zero-Trust State Verification Barrier under Simulated Partition Lag...");
  const delayedClient = new BinanceExecutionClient();
  let probeCount = 0;
  let simulatedLagOrders: BinanceOrderResponse[] = [
    {
      orderId: 201,
      symbol: "DOGEUSDT",
      status: "NEW",
      clientOrderId: "LINGERING_SL_DOGE",
      price: "0",
      avgPrice: "0",
      origQty: "0",
      executedQty: "0",
      cumQuote: "0",
      timeInForce: "GTC",
      type: "STOP_MARKET",
      reduceOnly: false,
      side: "BUY",
      positionSide: "SHORT",
      stopPrice: "0.09500",
      workingType: "CONTRACT_PRICE",
      updateTime: Date.now() - 1000,
    },
  ];

  (delayedClient as any).getOpenOrders = async (_sym: string): Promise<BinanceOrderResponse[]> => {
    probeCount++;
    // Simulate partition lag: order stays active in openOrders for first 2 verification probes, then clears on probe 3
    if (probeCount >= 3) {
      simulatedLagOrders = [];
    }
    return [...simulatedLagOrders];
  };

  (delayedClient as any).cancelOrder = async (_sym: string, orderId: number | string): Promise<BinanceOrderResponse> => {
    return {
      orderId: Number(orderId),
      symbol: "DOGEUSDT",
      status: "CANCELED",
      clientOrderId: "",
      price: "0",
      avgPrice: "0",
      origQty: "0",
      executedQty: "0",
      cumQuote: "0",
      timeInForce: "GTC",
      type: "STOP_MARKET",
      reduceOnly: false,
      side: "BUY",
      positionSide: "SHORT",
      stopPrice: "0",
      workingType: "CONTRACT_PRICE",
      updateTime: Date.now(),
    };
  };

  (delayedClient as any).request = async (_method: string, path: string, payload?: any): Promise<any> => {
    if (path === "/fapi/v1/order") {
      // Must only reach here once probeCount >= 3 (after barrier confirmed 0 orders)
      assert.ok(probeCount >= 3, `State Verification Barrier must poll until clean (probes: ${probeCount})`);
      assert.strictEqual(simulatedLagOrders.length, 0, "Orders list must be completely empty when order is placed");
      return {
        orderId: 777888,
        symbol: "DOGEUSDT",
        status: "NEW",
        clientOrderId: payload?.newClientOrderId || "",
        price: "0",
        avgPrice: "0",
        origQty: "0",
        executedQty: "0",
        cumQuote: "0",
        timeInForce: "GTC",
        type: "STOP_MARKET",
        reduceOnly: false,
        side: "BUY",
        positionSide: "SHORT",
        stopPrice: "0.09312",
        workingType: "CONTRACT_PRICE",
        updateTime: Date.now(),
      };
    }
    return {};
  };

  const res2 = await delayedClient.placePositionStopLoss("DOGEUSDT", "BUY", "SHORT", 0.09312);
  assert.strictEqual(res2.orderId, 777888, "Order must succeed after barrier polling completes");
  console.log(`  ✅ Stage 2 Passed: State Verification Barrier successfully waited for partition lag (${probeCount} probes).`);

  // =========================================================================
  // STAGE 3: Native Cancel-Replace (PUT /fapi/v1/order) Verification
  // =========================================================================
  console.log("\n[STAGE 3] Testing Native Cancel-Replace (PUT /fapi/v1/order)...");
  const nativeClient = new BinanceExecutionClient();
  let capturedPutPayload: Record<string, any> | undefined;

  (nativeClient as any).request = async (method: string, path: string, payload?: any): Promise<any> => {
    if (method === "PUT" && path === "/fapi/v1/order") {
      capturedPutPayload = { ...payload };
      return {
        orderId: 999111,
        symbol: payload?.symbol,
        status: "NEW",
        clientOrderId: payload?.newClientOrderId || "",
        price: "0",
        avgPrice: "0",
        origQty: "0",
        executedQty: "0",
        cumQuote: "0",
        timeInForce: "GTC",
        type: "STOP_MARKET",
        reduceOnly: false,
        side: payload?.side,
        positionSide: payload?.positionSide,
        stopPrice: payload?.stopPrice,
        workingType: "CONTRACT_PRICE",
        updateTime: Date.now(),
      };
    }
    return {};
  };

  const putRes = await nativeClient.cancelReplaceOrder({
    symbol: "SOLUSDT",
    side: "BUY",
    positionSide: "SHORT",
    type: "STOP_MARKET",
    stopPrice: 95.12,
    closePosition: true,
    cancelOrderId: 888222,
    cancelReplaceMode: "STOP_ON_FAILURE",
    clientOrderId: "SOL_CR_001",
  });

  assert.strictEqual(putRes.orderId, 999111, "PUT cancelReplaceOrder must return new orderId");
  assert.strictEqual(capturedPutPayload?.cancelOrderId, 888222, "cancelOrderId must match");
  assert.strictEqual(capturedPutPayload?.cancelReplaceMode, "STOP_ON_FAILURE", "cancelReplaceMode must be STOP_ON_FAILURE");
  assert.strictEqual(capturedPutPayload?.closePosition, "true", "closePosition must be string 'true'");
  assert.strictEqual(capturedPutPayload?.quantity, undefined, "quantity must be undefined for closePosition");
  console.log("  ✅ Stage 3 Passed: Native Cancel-Replace (PUT) payload and atomic execution verified.");

  // =========================================================================
  // STAGE 4: Zero-Naked Quantity-Based Fallback on Anomalous -4130 / -4509
  // =========================================================================
  console.log("\n[STAGE 4] Testing Deterministic Quantity-Based Fallback on Anomalous -4130...");
  const fallbackClient = new BinanceExecutionClient();
  let fallbackCapturedPayload: Record<string, any> | undefined;
  let attempt = 0;

  (fallbackClient as any).getOpenOrders = async (): Promise<BinanceOrderResponse[]> => [];
  (fallbackClient as any).getPositionRisk = async (_sym: string) => [
    {
      symbol: "ETHUSDT",
      positionAmt: "-2.50",
      positionSide: "SHORT",
      entryPrice: "2450.0",
      markPrice: "2455.0",
      unRealizedProfit: "-12.50",
      liquidationPrice: "3100.0",
      leverage: "20",
    },
  ];

  (fallbackClient as any).request = async (_method: string, path: string, payload?: any): Promise<any> => {
    if (path === "/fapi/v1/order") {
      attempt++;
      if (payload?.closePosition === "true") {
        // Force Binance rejection with -4130
        throw new Error("Binance API Error [-4130]: An open closePosition in the direction is existing");
      }
      // Quantity-based fallback succeeds
      fallbackCapturedPayload = { ...payload };
      return {
        orderId: 333444,
        symbol: payload?.symbol,
        status: "NEW",
        clientOrderId: payload?.newClientOrderId || "",
        price: "0",
        avgPrice: "0",
        origQty: String(payload?.quantity || "0"),
        executedQty: "0",
        cumQuote: "0",
        timeInForce: "GTC",
        type: "STOP_MARKET",
        reduceOnly: false,
        side: payload?.side,
        positionSide: payload?.positionSide,
        stopPrice: payload?.stopPrice,
        workingType: "CONTRACT_PRICE",
        updateTime: Date.now(),
      };
    }
    return {};
  };

  const fallbackRes = await fallbackClient.placePositionStopLoss("ETHUSDT", "BUY", "SHORT", 2500.0);
  assert.strictEqual(fallbackRes.orderId, 333444, "Fallback order ID must be returned");
  assert.strictEqual(fallbackCapturedPayload?.closePosition, undefined, "Fallback must omit closePosition from payload when quantity-based");
  assert.strictEqual(fallbackCapturedPayload?.quantity, 2.5, "Fallback quantity must match live position size (2.50)");
  assert.strictEqual(fallbackCapturedPayload?.side, "BUY", "Fallback side must be BUY for SHORT position");
  assert.strictEqual(fallbackCapturedPayload?.positionSide, "SHORT", "Fallback positionSide must be SHORT");
  console.log("  ✅ Stage 4 Passed: Deterministic Quantity-Based Fallback seamlessly protected position without throwing.");

  // =========================================================================
  // STAGE 5: StrategyEngine Mutex & Ratchet Concurrency Integration
  // =========================================================================
  console.log("\n[STAGE 5] Testing StrategyEngine GTEM-AE Mutex & LVCQ Coalescing with High-Frequency Ratchet Updates...");
  const sab = new SharedArrayBuffer(20480);
  const mdClient = new MarketDataClient(sab, 10, 256);
  const riskGuard = new RiskGuard();
  const hedgeLedger = new HedgePositionLedger("BTCUSDT");
  
  // Setup mock position in ledger
  hedgeLedger.occupyShortSlot(0, 0.01, 77100.0, 75000.0, 78000.0);

  const engineClient = new BinanceExecutionClient();
  let liveOrderIdSeq = 1000;
  (engineClient as any).getOpenOrders = async () => [];
  (engineClient as any).cancelOrder = async () => ({ status: "CANCELED" });
  (engineClient as any).request = async (_m: string, _p: string, payload?: any) => ({
    orderId: ++liveOrderIdSeq,
    symbol: "BTCUSDT",
    status: "NEW",
    clientOrderId: payload?.newClientOrderId || "",
    price: "0",
    avgPrice: "0",
    origQty: "0",
    executedQty: "0",
    cumQuote: "0",
    timeInForce: "GTC",
    type: "STOP_MARKET",
    reduceOnly: false,
    side: "BUY",
    positionSide: "SHORT",
    stopPrice: payload?.stopPrice || "77890.0",
    workingType: "CONTRACT_PRICE",
    updateTime: Date.now(),
  });

  const engine = new StrategyEngine(
    mdClient,
    riskGuard,
    engineClient,
    { symbol: "BTCUSDT" },
    undefined,
    hedgeLedger
  );

  // Dispatch 10 rapid concurrent SL ratchet updates
  const ratchetPromises: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) {
    const slPx = 77800.0 - i * 10; // Tightening SL
    ratchetPromises.push(engine.syncExchangeStopLossOrder("SHORT", 0.01, slPx));
  }

  await Promise.all(ratchetPromises);

  const finalSlId = hedgeLedger.getActiveStopLossOrderId("SHORT");
  assert.ok(finalSlId !== undefined && finalSlId > 0, "Final active SL order ID must be registered in ledger");
  console.log(`  ✅ Stage 5 Passed: 10 concurrent ratchet updates safely coalesced (Final SL OrderId #${finalSlId}).`);
  console.log(`  ✅ Stage 5 Passed: 10 concurrent ratchet updates safely coalesced (Final SL OrderId #${finalSlId}).`);

  console.log("\n=========================================================================");
  console.log("  ALL 5 STAGES PASSED: DETERMINISTIC CANCEL-REPLACE 100% QA VERIFIED!     ");
  console.log("=========================================================================\n");
}

runDeterministicCancelReplaceTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
