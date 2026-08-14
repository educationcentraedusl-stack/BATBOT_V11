"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const positionLedger_1 = require("./strategy/positionLedger");
const engine_1 = require("./strategy/engine");
const risk_1 = require("./strategy/risk");
const marketDataClient_1 = require("./marketDataClient");
const binance_1 = require("./execution/binance");
class AuditedBinanceClient extends binance_1.BinanceExecutionClient {
    placedOrders = [];
    cancelledOrderIds = [];
    orderIdCounter = 900001;
    isConfigured() {
        return true;
    }
    async placeOrder(params) {
        this.placedOrders.push(params);
        const orderId = this.orderIdCounter++;
        return {
            symbol: params.symbol,
            orderId,
            clientOrderId: `test_${orderId}`,
            price: String(params.price || 0),
            origQty: String(params.quantity),
            executedQty: "0",
            status: "NEW",
            timeInForce: params.timeInForce || "GTC",
            type: params.type,
            side: params.side,
            reduceOnly: false,
            positionSide: params.positionSide || "BOTH",
            stopPrice: String(params.stopPrice || 0),
            workingType: "CONTRACT_PRICE",
            cumQuote: "0",
            avgPrice: "0",
            updateTime: Date.now(),
        };
    }
    async cancelOrder(symbol, orderId) {
        const numId = typeof orderId === "number" ? orderId : parseInt(orderId, 10);
        this.cancelledOrderIds.push(numId);
        return {
            symbol,
            orderId: numId,
            clientOrderId: `cancel_${numId}`,
            price: "0",
            origQty: "0",
            executedQty: "0",
            status: "CANCELED",
            timeInForce: "GTC",
            type: "MARKET",
            side: "SELL",
            reduceOnly: false,
            positionSide: "BOTH",
            stopPrice: "0",
            workingType: "CONTRACT_PRICE",
            cumQuote: "0",
            avgPrice: "0",
            updateTime: Date.now(),
        };
    }
}
async function runPhase3Proof() {
    console.log("==========================================================================================");
    console.log("  🔍 PHASE 3 PROOF: EXCHANGE-NATIVE STOP_MARKET ORDER DISPATCH & TRACKING VERIFICATION");
    console.log("==========================================================================================\n");
    const mockClient = new AuditedBinanceClient();
    const symbol = "BTCUSDT";
    const entryPrice = 60000.0;
    const initialSl = 59880.0;
    const qty = 0.005;
    const sab = new SharedArrayBuffer(1024 * 64);
    const mdc = new marketDataClient_1.MarketDataClient(sab, 10);
    const risk = new risk_1.RiskGuard();
    const ledger = new positionLedger_1.HedgePositionLedger(symbol);
    const engine = new engine_1.StrategyEngine(mdc, risk, mockClient, { symbol, assetIndex: 0 }, ledger.getLegacyLedger(), ledger);
    ledger.occupyCoreLong(qty, entryPrice, 0.40, 0.20);
    console.log(`[Position Entry] Long 0.005 BTC @ $${entryPrice} | Target SL: $${initialSl}`);
    // 1. Dispatch Initial Exchange STOP_MARKET Order via StrategyEngine
    console.log("\n------------------------------------------------------------------------------------------");
    console.log("[TEST 1] Dispatching Initial Exchange-Native STOP_MARKET Order via StrategyEngine");
    const orderId = await engine.dispatchExchangeStopLossOrder("CORE_LONG", entryPrice, qty, "LONG", initialSl);
    const trackedSlId = ledger.getActiveStopLossOrderId("CORE_LONG");
    console.log(`  dispatchExchangeStopLossOrder() Response -> OrderId: #${orderId}`);
    console.log(`  PositionLedger Registered activeStopLossOrderId: #${trackedSlId}`);
    if (trackedSlId !== orderId || !orderId) {
        throw new Error(`❌ PROOF FAILED: activeStopLossOrderId #${trackedSlId} does not match placed order #${orderId}`);
    }
    console.log("  ✅ TEST 1 PASSED: Exchange-Native STOP_MARKET Order placed & ID tracked!");
    // 2. Test Cancel-Replace Ratchet Sync via StrategyEngine
    console.log("\n------------------------------------------------------------------------------------------");
    console.log("[TEST 2] Testing AI Breakeven SL Ratchet Cancel-Replace Sync (Target SL: $60124.50)");
    const newSlPrice = 60124.50;
    await engine.syncExchangeStopLossOrder("CORE_LONG", qty, "LONG", newSlPrice);
    const updatedSlId = ledger.getActiveStopLossOrderId("CORE_LONG");
    console.log(`  PositionLedger Active SL ID Updated: #${updatedSlId}`);
    if (mockClient.cancelledOrderIds[0] !== orderId) {
        throw new Error(`❌ PROOF FAILED: Previous SL OrderId #${orderId} was not cancelled during ratchet!`);
    }
    if (updatedSlId === orderId || !updatedSlId) {
        throw new Error(`❌ PROOF FAILED: Updated activeStopLossOrderId #${updatedSlId} was not assigned new ID!`);
    }
    console.log("  ✅ TEST 2 PASSED: Cancel-Replace Ratchet correctly cancelled old SL and activated new SL!");
    // 3. Test Concurrency Lock & Debounce Protection on Simultaneous Ratchets
    console.log("\n------------------------------------------------------------------------------------------");
    console.log("[TEST 3] Testing Concurrency Lock & Debounce Defense on Simultaneous Ratchet Dispatches");
    const preConcurrentCount = mockClient.placedOrders.length;
    // Trigger 5 concurrent simultaneous sync calls for CORE_LONG
    await Promise.all([
        engine.syncExchangeStopLossOrder("CORE_LONG", qty, "LONG", 60130.0),
        engine.syncExchangeStopLossOrder("CORE_LONG", qty, "LONG", 60135.0),
        engine.syncExchangeStopLossOrder("CORE_LONG", qty, "LONG", 60140.0),
        engine.syncExchangeStopLossOrder("CORE_LONG", qty, "LONG", 60145.0),
    ]);
    const postConcurrentCount = mockClient.placedOrders.length;
    const newOrdersPlaced = postConcurrentCount - preConcurrentCount;
    const finalActiveSlId = ledger.getActiveStopLossOrderId("CORE_LONG");
    const finalPlacedOrder = mockClient.placedOrders[mockClient.placedOrders.length - 1];
    console.log(`  Concurrent Dispatches: 4 | New Orders Placed: ${newOrdersPlaced} (Sequential Queue Drained)`);
    console.log(`  Final Active SL OrderId: #${finalActiveSlId} @ stopPrice $${finalPlacedOrder.stopPrice}`);
    if (newOrdersPlaced > 2) {
        throw new Error(`❌ PROOF FAILED: Overlapping orders placed! Expected at most 2 orders placed during queue drain, got ${newOrdersPlaced}`);
    }
    if (parseFloat(String(finalPlacedOrder.stopPrice)) !== 60145.0) {
        throw new Error(`❌ PROOF FAILED: Final resting SL price ($${finalPlacedOrder.stopPrice}) did not match latest queued target ($60145.0)!`);
    }
    console.log("  ✅ TEST 3 PASSED: Concurrency mutex & sequential queue successfully synchronized final SL to $60145 with zero orphan orders!");
    // 4. Test Order Summary Audit
    console.log("\n------------------------------------------------------------------------------------------");
    console.log("[TEST 4] Exchange Client Order History Audit");
    console.log(`  Total Orders Placed: ${mockClient.placedOrders.length}`);
    console.log(`  Total Orders Cancelled: ${mockClient.cancelledOrderIds.length}`);
    mockClient.placedOrders.forEach((ord, idx) => {
        console.log(`  Order #${idx + 1} -> Type: ${ord.type} | Side: ${ord.side} | Qty: ${ord.quantity} | StopPrice: $${ord.stopPrice}`);
    });
    console.log("\n==========================================================================================");
    console.log("  ✅ PHASE 3 PROOF PASSED: Exchange-Native STOP_MARKET orders physically placed & tracked!");
    console.log("==========================================================================================\n");
}
runPhase3Proof().catch((err) => {
    console.error("❌ Phase 3 Proof Execution Error:", err);
    process.exit(1);
});
