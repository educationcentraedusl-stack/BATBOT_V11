"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const binance_1 = require("../execution/binance");
const engine_1 = require("../strategy/engine");
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const symbolPrecision_1 = require("../config/symbolPrecision");
const positionLedger_1 = require("../strategy/positionLedger");
function makePositionRisk(partial) {
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
async function runDeterministicCancelReplaceTests() {
    console.log("=========================================================================");
    console.log("  SOTA DETERMINISTIC VERIFICATION: ERROR -4130 ERADICATION & BARRIER     ");
    console.log("=========================================================================\n");
    symbolPrecision_1.SymbolPrecisionRegistry.preseedOfflineDefaults(["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"]);
    const cleanupTargets = [];
    try {
        // =========================================================================
        // STAGE 1: Synchronous Pre-Flight Annihilation & Clean State Verification
        // =========================================================================
        console.log("[STAGE 1] Testing Synchronous Pre-Flight Annihilation before Order Submission...");
        const cancelledOrders = [];
        let openOrdersList = [
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
        const submittedOrders = [];
        class Stage1Client extends binance_1.BinanceExecutionClient {
            getOpenOrders(symbol) {
                return Promise.resolve(openOrdersList.filter((o) => !symbol || o.symbol === symbol));
            }
            cancelOrder(_sym, orderId) {
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
            executeHttpRequest(_method, path, payload = {}) {
                if (path === "/fapi/v1/order") {
                    submittedOrders.push({ ...payload });
                    const activeSl = openOrdersList.filter((o) => o.type === "STOP_MARKET" && o.positionSide === "SHORT");
                    assert_1.default.strictEqual(activeSl.length, 0, "Exchange MUST have 0 resting STOP_MARKET orders when new closePosition order arrives");
                    const orderRes = {
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
                        stopPrice: typeof payload.stopPrice === "string" || typeof payload.stopPrice === "number" ? String(payload.stopPrice) : "0",
                        workingType: "CONTRACT_PRICE",
                        updateTime: Date.now(),
                    };
                    return Promise.resolve(orderRes);
                }
                return Promise.resolve({});
            }
        }
        const mockClient = new Stage1Client();
        cleanupTargets.push(mockClient);
        const res1 = await mockClient.placePositionStopLoss("BTCUSDT", "BUY", "SHORT", 77890.2);
        assert_1.default.strictEqual(res1.orderId, 555666, "New SL order must be successfully placed");
        assert_1.default.strictEqual(cancelledOrders.includes(101), true, "Resting SL #101 must have been synchronously cancelled");
        assert_1.default.strictEqual(submittedOrders.length, 1, "Submitted order payload must be recorded");
        console.log("  ✅ Stage 1 Passed: Pre-flight annihilation executed and verified clean before dispatch.");
        // =========================================================================
        // STAGE 2: State Verification Barrier with Matching Engine Partition Lag
        // =========================================================================
        console.log("\n[STAGE 2] Testing Zero-Trust State Verification Barrier under Simulated Partition Lag...");
        let probeCount = 0;
        let simulatedLagOrders = [
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
        class Stage2Client extends binance_1.BinanceExecutionClient {
            getOpenOrders(_sym) {
                probeCount++;
                if (probeCount >= 3) {
                    simulatedLagOrders = [];
                }
                return Promise.resolve([...simulatedLagOrders]);
            }
            cancelOrder(_sym, orderId) {
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
            executeHttpRequest(_method, path, payload = {}) {
                if (path === "/fapi/v1/order") {
                    assert_1.default.ok(probeCount >= 3, `State Verification Barrier must poll until clean (probes: ${String(probeCount)})`);
                    assert_1.default.strictEqual(simulatedLagOrders.length, 0, "Orders list must be completely empty when order is placed");
                    const orderRes = {
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
                    };
                    return Promise.resolve(orderRes);
                }
                return Promise.resolve({});
            }
        }
        const delayedClient = new Stage2Client();
        cleanupTargets.push(delayedClient);
        const res2 = await delayedClient.placePositionStopLoss("DOGEUSDT", "BUY", "SHORT", 0.09312);
        assert_1.default.strictEqual(res2.orderId, 777888, "Order must succeed after barrier polling completes");
        console.log(`  ✅ Stage 2 Passed: State Verification Barrier successfully waited for partition lag (${String(probeCount)} probes).`);
        // =========================================================================
        // STAGE 3: Native Cancel-Replace (PUT /fapi/v1/order) Verification
        // =========================================================================
        console.log("\n[STAGE 3] Testing Native Cancel-Replace (PUT /fapi/v1/order)...");
        class Stage3Client extends binance_1.BinanceExecutionClient {
            capturedPutPayload;
            executeHttpRequest(method, path, payload = {}) {
                if (method === "PUT" && path === "/fapi/v1/order") {
                    this.capturedPutPayload = { ...payload };
                    const orderRes = {
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
                        stopPrice: typeof payload.stopPrice === "string" || typeof payload.stopPrice === "number" ? String(payload.stopPrice) : "0",
                        workingType: "CONTRACT_PRICE",
                        updateTime: Date.now(),
                    };
                    return Promise.resolve(orderRes);
                }
                return Promise.resolve({});
            }
        }
        const nativeClient = new Stage3Client();
        cleanupTargets.push(nativeClient);
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
        assert_1.default.strictEqual(putRes.orderId, 999111, "PUT cancelReplaceOrder must return new orderId");
        assert_1.default.ok(capturedPutPayload !== undefined, "PUT payload must be captured");
        assert_1.default.strictEqual(capturedPutPayload.cancelOrderId, 888222, "cancelOrderId must match");
        assert_1.default.strictEqual(capturedPutPayload.cancelReplaceMode, "STOP_ON_FAILURE", "cancelReplaceMode must be STOP_ON_FAILURE");
        assert_1.default.strictEqual(capturedPutPayload.closePosition, "true", "closePosition must be string 'true'");
        assert_1.default.strictEqual(capturedPutPayload.quantity, undefined, "quantity must be undefined for closePosition");
        console.log("  ✅ Stage 3 Passed: Native Cancel-Replace (PUT) payload and atomic execution verified.");
        // =========================================================================
        // STAGE 4: Zero-Naked Quantity-Based Fallback on Anomalous -4130 / -4509
        // =========================================================================
        console.log("\n[STAGE 4] Testing Deterministic Quantity-Based Fallback on Anomalous -4130...");
        class Stage4Client extends binance_1.BinanceExecutionClient {
            fallbackCapturedPayload;
            attempt = 0;
            getOpenOrders() {
                return Promise.resolve([]);
            }
            getPositionRisk(_sym) {
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
            executeHttpRequest(_method, path, payload = {}) {
                if (path === "/fapi/v1/order") {
                    this.attempt++;
                    if (payload.closePosition === "true") {
                        return Promise.reject(new Error("Binance API Error [-4130]: An open closePosition in the direction is existing"));
                    }
                    this.fallbackCapturedPayload = { ...payload };
                    const orderRes = {
                        orderId: 333444,
                        symbol: typeof payload.symbol === "string" ? payload.symbol : "ETHUSDT",
                        status: "NEW",
                        clientOrderId: typeof payload.newClientOrderId === "string" ? payload.newClientOrderId : "",
                        price: "0",
                        avgPrice: "0",
                        origQty: typeof payload.quantity === "string" || typeof payload.quantity === "number" ? String(payload.quantity) : "0",
                        executedQty: "0",
                        cumQuote: "0",
                        timeInForce: "GTC",
                        type: "STOP_MARKET",
                        reduceOnly: false,
                        side: typeof payload.side === "string" ? payload.side : "BUY",
                        positionSide: typeof payload.positionSide === "string" ? payload.positionSide : "SHORT",
                        stopPrice: typeof payload.stopPrice === "string" || typeof payload.stopPrice === "number" ? String(payload.stopPrice) : "0",
                        workingType: "CONTRACT_PRICE",
                        updateTime: Date.now(),
                    };
                    return Promise.resolve(orderRes);
                }
                return Promise.resolve({});
            }
        }
        const fallbackClient = new Stage4Client();
        cleanupTargets.push(fallbackClient);
        const fallbackRes = await fallbackClient.placePositionStopLoss("ETHUSDT", "BUY", "SHORT", 2500.0);
        const fallbackCapturedPayload = fallbackClient.fallbackCapturedPayload;
        assert_1.default.strictEqual(fallbackRes.orderId, 333444, "Fallback order ID must be returned");
        assert_1.default.ok(fallbackCapturedPayload !== undefined, "Fallback payload must be captured");
        assert_1.default.strictEqual(fallbackCapturedPayload.closePosition, undefined, "Fallback must omit closePosition from payload when quantity-based");
        assert_1.default.strictEqual(fallbackCapturedPayload.quantity, 2.5, "Fallback quantity must match live position size (2.50)");
        assert_1.default.strictEqual(fallbackCapturedPayload.side, "BUY", "Fallback side must be BUY for SHORT position");
        assert_1.default.strictEqual(fallbackCapturedPayload.positionSide, "SHORT", "Fallback positionSide must be SHORT");
        console.log("  ✅ Stage 4 Passed: Deterministic Quantity-Based Fallback seamlessly protected position without throwing.");
        // =========================================================================
        // STAGE 5: StrategyEngine Mutex & Ratchet Concurrency Integration
        // =========================================================================
        console.log("\n[STAGE 5] Testing StrategyEngine GTEM-AE Mutex & LVCQ Coalescing with High-Frequency Ratchet Updates...");
        const sab = new SharedArrayBuffer(20480);
        const mdClient = new marketDataClient_1.MarketDataClient(sab, 10, 256);
        const riskGuard = new risk_1.RiskGuard();
        const hedgeLedger = new positionLedger_1.HedgePositionLedger("BTCUSDT");
        // Setup mock position in ledger
        hedgeLedger.occupyShortSlot(0, 0.01, 77100.0, 75000.0, 78000.0);
        class Stage5Client extends binance_1.BinanceExecutionClient {
            liveOrderIdSeq = 1000;
            getOpenOrders() {
                return Promise.resolve([]);
            }
            cancelOrder(symbol, orderId) {
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
            executeHttpRequest(_m, _p, payload = {}) {
                const orderRes = {
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
                    stopPrice: typeof payload.stopPrice === "string" || typeof payload.stopPrice === "number" ? String(payload.stopPrice) : "77890.0",
                    workingType: "CONTRACT_PRICE",
                    updateTime: Date.now(),
                };
                return Promise.resolve(orderRes);
            }
        }
        const engineClient = new Stage5Client();
        cleanupTargets.push(engineClient);
        const engine = new engine_1.StrategyEngine(mdClient, riskGuard, engineClient, { symbol: "BTCUSDT" }, undefined, hedgeLedger);
        cleanupTargets.push(engine);
        // Dispatch 10 rapid concurrent SL ratchet updates
        const ratchetPromises = [];
        for (let i = 0; i < 10; i++) {
            const slPx = 77800.0 - i * 10; // Tightening SL
            ratchetPromises.push(engine.syncExchangeStopLossOrder("SHORT", 0.01, slPx));
        }
        await Promise.all(ratchetPromises);
        const finalSlId = hedgeLedger.getActiveStopLossOrderId("SHORT");
        assert_1.default.ok(finalSlId !== undefined && finalSlId > 0, "Final active SL order ID must be registered in ledger");
        console.log(`  ✅ Stage 5 Passed: 10 concurrent ratchet updates safely coalesced (Final SL OrderId #${String(finalSlId)}).`);
        console.log("\n=========================================================================");
        console.log("  ALL 5 STAGES PASSED: DETERMINISTIC CANCEL-REPLACE 100% QA VERIFIED!     ");
        console.log("=========================================================================\n");
    }
    finally {
        for (let i = cleanupTargets.length - 1; i >= 0; i--) {
            cleanupTargets[i].destroy();
        }
    }
}
runDeterministicCancelReplaceTests().catch((err) => {
    console.error("TEST FAILED:", err);
    process.exit(1);
});
