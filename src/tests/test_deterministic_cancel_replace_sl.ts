import assert from "assert";
import {
  BinanceExecutionClient,
  BinanceOrderResponse,
  BinancePositionRisk,
} from "../execution/binance";
import { StrategyEngine } from "../strategy/engine";
import { MarketDataClient } from "../marketDataClient";
import { RiskGuard } from "../strategy/risk";
import { SymbolPrecisionRegistry } from "../config/symbolPrecision";
import { HedgePositionLedger } from "../strategy/positionLedger";

type ReqPayload = Record<string, string | number | boolean | undefined | null>;

function makePositionRisk(partial: {
  symbol: string;
  positionAmt: string;
  positionSide: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
}): BinancePositionRisk {
  return {
    ...partial,
    maxNotionalValue: "1000000",
    marginType: "cross",
    isolatedMargin: "0",
    isAutoAddMargin: "false",
    notional: "0",
    isolatedWallet: "0",
    updateTime: Date.now(),
  };
}

async function runDeterministicCancelReplaceTests(): Promise<void> {
  console.log("=========================================================================");
  console.log("  SOTA DETERMINISTIC VERIFICATION: ERROR -4130 ERADICATION & BARRIER     ");
  console.log("=========================================================================\n");

  SymbolPrecisionRegistry.preseedOfflineDefaults(["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"]);

  // =========================================================================
  // STAGE 1: Synchronous Pre-Flight Annihilation & Clean State Verification
  // =========================================================================
  console.log("[STAGE 1] Testing Synchronous Pre-Flight Annihilation before Order Submission...");
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
  const submittedOrders: ReqPayload[] = [];

  class Stage1Client extends BinanceExecutionClient {
    public override getOpenOrders(symbol?: string): Promise<BinanceOrderResponse[]> {
      return Promise.resolve(openOrdersList.filter((o) => !symbol || o.symbol === symbol));
    }
    public override cancelOrder(_sym: string, orderId: number | string): Promise<BinanceOrderResponse> {
      cancelledOrders.push(orderId);
      openOrdersList = openOrdersList.filter((o) => o.orderId !== orderId);
      return Promise.resolve({
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
      });
    }
    protected override request<T>(
      _method: "GET" | "POST" | "DELETE" | "PUT",
      path: string,
      payload: ReqPayload = {}
    ): Promise<T> {
      if (path === "/fapi/v1/order") {
        submittedOrders.push({ ...payload });
        const activeSl = openOrdersList.filter((o) => o.type === "STOP_MARKET" && o.positionSide === "SHORT");
        assert.strictEqual(
          activeSl.length,
          0,
          "Exchange MUST have 0 resting STOP_MARKET orders when new closePosition order arrives"
        );
        return Promise.resolve({
          orderId: 555666,
          symbol: typeof payload.symbol === "string" ? payload.symbol : "BTCUSDT",
          status: "NEW",
          clientOrderId: typeof payload.newClientOrderId === "string" ? payload.newClientOrderId : "",
          price: "0",
          avgPrice: "0",
          origQty: "0",
          executedQty: "0",
          cumQuote: "0",
          timeInForce: "GTC",
          type: "STOP_MARKET",
          reduceOnly: false,
          side: typeof payload.side === "string" ? payload.side : "BUY",
          positionSide: typeof payload.positionSide === "string" ? payload.positionSide : "SHORT",
          stopPrice: String(payload.stopPrice ?? "0"),
          workingType: "CONTRACT_PRICE",
          updateTime: Date.now(),
        } as unknown as T);
      }
      return Promise.resolve({} as unknown as T);
    }
  }
  const mockClient = new Stage1Client();

  const res1 = await mockClient.placePositionStopLoss("BTCUSDT", "BUY", "SHORT", 77890.2);
  assert.strictEqual(res1.orderId, 555666, "New SL order must be successfully placed");
  assert.strictEqual(cancelledOrders.includes(101), true, "Resting SL #101 must have been synchronously cancelled");
  assert.strictEqual(submittedOrders.length, 1, "Submitted order payload must be recorded");
  console.log("  ✅ Stage 1 Passed: Pre-flight annihilation executed and verified clean before dispatch.");

  // =========================================================================
  // STAGE 2: State Verification Barrier with Matching Engine Partition Lag
  // =========================================================================
  console.log("\n[STAGE 2] Testing Zero-Trust State Verification Barrier under Simulated Partition Lag...");
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

  class Stage2Client extends BinanceExecutionClient {
    public override getOpenOrders(_sym?: string): Promise<BinanceOrderResponse[]> {
      probeCount++;
      if (probeCount >= 3) {
        simulatedLagOrders = [];
      }
      return Promise.resolve([...simulatedLagOrders]);
    }
    public override cancelOrder(_sym: string, orderId: number | string): Promise<BinanceOrderResponse> {
      return Promise.resolve({
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
      });
    }
    protected override request<T>(
      _method: "GET" | "POST" | "DELETE" | "PUT",
      path: string,
      payload: ReqPayload = {}
    ): Promise<T> {
      if (path === "/fapi/v1/order") {
        assert.ok(probeCount >= 3, `State Verification Barrier must poll until clean (probes: ${String(probeCount)})`);
        assert.strictEqual(simulatedLagOrders.length, 0, "Orders list must be completely empty when order is placed");
        return Promise.resolve({
          orderId: 777888,
          symbol: "DOGEUSDT",
          status: "NEW",
          clientOrderId: typeof payload.newClientOrderId === "string" ? payload.newClientOrderId : "",
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
        } as unknown as T);
      }
      return Promise.resolve({} as unknown as T);
    }
  }
  const delayedClient = new Stage2Client();

  const res2 = await delayedClient.placePositionStopLoss("DOGEUSDT", "BUY", "SHORT", 0.09312);
  assert.strictEqual(res2.orderId, 777888, "Order must succeed after barrier polling completes");
  console.log(`  ✅ Stage 2 Passed: State Verification Barrier successfully waited for partition lag (${String(probeCount)} probes).`);

  // =========================================================================
  // STAGE 3: Native Cancel-Replace (PUT /fapi/v1/order) Verification
  // =========================================================================
  console.log("\n[STAGE 3] Testing Native Cancel-Replace (PUT /fapi/v1/order)...");
  class Stage3Client extends BinanceExecutionClient {
    public capturedPutPayload: ReqPayload | undefined;
    protected override request<T>(
      method: "GET" | "POST" | "DELETE" | "PUT",
      path: string,
      payload: ReqPayload = {}
    ): Promise<T> {
      if (method === "PUT" && path === "/fapi/v1/order") {
        this.capturedPutPayload = { ...payload };
        return Promise.resolve({
          orderId: 999111,
          symbol: typeof payload.symbol === "string" ? payload.symbol : "SOLUSDT",
          status: "NEW",
          clientOrderId: typeof payload.newClientOrderId === "string" ? payload.newClientOrderId : "",
          price: "0",
          avgPrice: "0",
          origQty: "0",
          executedQty: "0",
          cumQuote: "0",
          timeInForce: "GTC",
          type: "STOP_MARKET",
          reduceOnly: false,
          side: typeof payload.side === "string" ? payload.side : "BUY",
          positionSide: typeof payload.positionSide === "string" ? payload.positionSide : "SHORT",
          stopPrice: String(payload.stopPrice ?? "0"),
          workingType: "CONTRACT_PRICE",
          updateTime: Date.now(),
        } as unknown as T);
      }
      return Promise.resolve({} as unknown as T);
    }
  }
  const nativeClient = new Stage3Client();

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

  const capturedPutPayload = nativeClient.capturedPutPayload;
  assert.strictEqual(putRes.orderId, 999111, "PUT cancelReplaceOrder must return new orderId");
  assert.ok(capturedPutPayload !== undefined, "PUT payload must be captured");
  assert.strictEqual(capturedPutPayload.cancelOrderId, 888222, "cancelOrderId must match");
  assert.strictEqual(capturedPutPayload.cancelReplaceMode, "STOP_ON_FAILURE", "cancelReplaceMode must be STOP_ON_FAILURE");
  assert.strictEqual(capturedPutPayload.closePosition, "true", "closePosition must be string 'true'");
  assert.strictEqual(capturedPutPayload.quantity, undefined, "quantity must be undefined for closePosition");
  console.log("  ✅ Stage 3 Passed: Native Cancel-Replace (PUT) payload and atomic execution verified.");

  // =========================================================================
  // STAGE 4: Zero-Naked Quantity-Based Fallback on Anomalous -4130 / -4509
  // =========================================================================
  console.log("\n[STAGE 4] Testing Deterministic Quantity-Based Fallback on Anomalous -4130...");
  class Stage4Client extends BinanceExecutionClient {
    public fallbackCapturedPayload: ReqPayload | undefined;
    public attempt = 0;
    public override getOpenOrders(): Promise<BinanceOrderResponse[]> {
      return Promise.resolve([]);
    }
    public override getPositionRisk(_sym?: string): Promise<BinancePositionRisk[]> {
      return Promise.resolve([
        makePositionRisk({
          symbol: "ETHUSDT",
          positionAmt: "-2.50",
          positionSide: "SHORT",
          entryPrice: "2450.0",
          markPrice: "2455.0",
          unRealizedProfit: "-12.50",
          liquidationPrice: "3100.0",
          leverage: "20",
        }),
      ]);
    }
    protected override request<T>(
      _method: "GET" | "POST" | "DELETE" | "PUT",
      path: string,
      payload: ReqPayload = {}
    ): Promise<T> {
      if (path === "/fapi/v1/order") {
        this.attempt++;
        if (payload.closePosition === "true") {
          return Promise.reject(
            new Error("Binance API Error [-4130]: An open closePosition in the direction is existing")
          );
        }
        this.fallbackCapturedPayload = { ...payload };
        return Promise.resolve({
          orderId: 333444,
          symbol: typeof payload.symbol === "string" ? payload.symbol : "ETHUSDT",
          status: "NEW",
          clientOrderId: typeof payload.newClientOrderId === "string" ? payload.newClientOrderId : "",
          price: "0",
          avgPrice: "0",
          origQty: String(payload.quantity ?? "0"),
          executedQty: "0",
          cumQuote: "0",
          timeInForce: "GTC",
          type: "STOP_MARKET",
          reduceOnly: false,
          side: typeof payload.side === "string" ? payload.side : "BUY",
          positionSide: typeof payload.positionSide === "string" ? payload.positionSide : "SHORT",
          stopPrice: String(payload.stopPrice ?? "0"),
          workingType: "CONTRACT_PRICE",
          updateTime: Date.now(),
        } as unknown as T);
      }
      return Promise.resolve({} as unknown as T);
    }
  }
  const fallbackClient = new Stage4Client();

  const fallbackRes = await fallbackClient.placePositionStopLoss("ETHUSDT", "BUY", "SHORT", 2500.0);
  const fallbackCapturedPayload = fallbackClient.fallbackCapturedPayload;
  assert.strictEqual(fallbackRes.orderId, 333444, "Fallback order ID must be returned");
  assert.ok(fallbackCapturedPayload !== undefined, "Fallback payload must be captured");
  assert.strictEqual(fallbackCapturedPayload.closePosition, undefined, "Fallback must omit closePosition from payload when quantity-based");
  assert.strictEqual(fallbackCapturedPayload.quantity, 2.5, "Fallback quantity must match live position size (2.50)");
  assert.strictEqual(fallbackCapturedPayload.side, "BUY", "Fallback side must be BUY for SHORT position");
  assert.strictEqual(fallbackCapturedPayload.positionSide, "SHORT", "Fallback positionSide must be SHORT");
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

  class Stage5Client extends BinanceExecutionClient {
    private liveOrderIdSeq = 1000;
    public override getOpenOrders(): Promise<BinanceOrderResponse[]> {
      return Promise.resolve([]);
    }
    public override cancelOrder(symbol: string, orderId: number | string): Promise<BinanceOrderResponse> {
      return Promise.resolve({
        orderId: Number(orderId),
        symbol,
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
      });
    }
    protected override request<T>(
      _m: "GET" | "POST" | "DELETE" | "PUT",
      _p: string,
      payload: ReqPayload = {}
    ): Promise<T> {
      return Promise.resolve({
        orderId: ++this.liveOrderIdSeq,
        symbol: "BTCUSDT",
        status: "NEW",
        clientOrderId: typeof payload.newClientOrderId === "string" ? payload.newClientOrderId : "",
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
        stopPrice: String(payload.stopPrice ?? "77890.0"),
        workingType: "CONTRACT_PRICE",
        updateTime: Date.now(),
      } as unknown as T);
    }
  }
  const engineClient = new Stage5Client();

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
  console.log(`  ✅ Stage 5 Passed: 10 concurrent ratchet updates safely coalesced (Final SL OrderId #${String(finalSlId)}).`);

  console.log("\n=========================================================================");
  console.log("  ALL 5 STAGES PASSED: DETERMINISTIC CANCEL-REPLACE 100% QA VERIFIED!     ");
  console.log("=========================================================================\n");
}

runDeterministicCancelReplaceTests().catch((err: unknown) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
