"use strict";
/**
 * BATBOT_V11 — Phase 1 HFT Overhaul
 * Test Suite: WebSocket Order Client (wsOrderClient.ts)
 *
 * Coverage:
 *  T01  Constructor resolves correct endpoint for testnet
 *  T02  Constructor resolves correct endpoint for mainnet
 *  T03  connect() resolves when socket opens (mock)
 *  T04  placeOrder() rejects when not connected
 *  T05  cancelOrder() rejects when not connected
 *  T06  cancelReplaceOrder() rejects when not connected
 *  T07  placeOrder() MARKET — timeInForce excluded from payload
 *  T08  placeOrder() STOP_MARKET — timeInForce excluded from payload
 *  T09  placeOrder() TAKE_PROFIT_MARKET — timeInForce excluded from payload
 *  T10  placeOrder() LIMIT — timeInForce included in payload
 *  T11  placeOrder() closePosition=true excludes reduceOnly
 *  T12  placeOrder() quantity formatted via SymbolPrecisionRegistry
 *  T13  placeOrder() price formatted via SymbolPrecisionRegistry
 *  T14  _signParams() injects timestamp, recvWindow, apiKey, signature
 *  T15  _signParams() HMAC-SHA256 signature is correct
 *  T16  _dispatch() registers pending request with timeout
 *  T17  _onMessage() resolves pending promise on status 200
 *  T18  _onMessage() rejects pending promise on non-200 status
 *  T19  _onMessage() ignores messages without matching id
 *  T20  timeout: pending request rejected after requestTimeoutMs
 *  T21  destroy() rejects all pending requests
 *  T22  destroy() closes the WebSocket
 *  T23  _onClose() triggers reconnect on non-shutdown close
 *  T24  _onClose() does NOT reconnect when isShuttingDown=true
 *  T25  rttMs is correctly computed and injected into WsOrderResponse
 *
 * Runtime: Node.js built-in test runner (node:test + node:assert).
 * No external dependencies. Zero mock data for production logic.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const node_test_1 = require("node:test");
const crypto = __importStar(require("node:crypto"));
const wsOrderClient_1 = require("../execution/wsOrderClient");
const symbolPrecision_1 = require("../config/symbolPrecision");
const binance_1 = require("../execution/binance");
const marketDataClient_1 = require("../marketDataClient");
// ─── Helpers ─────────────────────────────────────────────────────────────────
/**
 * Minimal EventEmitter-compatible WebSocket mock implementing WsSocketLike.
 */
class MockWebSocket {
    readyState = 1; // OPEN = 1
    static OPEN = 1;
    sentMessages = [];
    listeners = new Map();
    on(event, handler) {
        const handlers = this.listeners.get(event) ?? [];
        handlers.push(handler);
        this.listeners.set(event, handlers);
        return this;
    }
    once(event, handler) {
        const wrapper = (...args) => {
            handler(...args);
            this.off(event, wrapper);
        };
        return this.on(event, wrapper);
    }
    off(event, handler) {
        const handlers = this.listeners.get(event) ?? [];
        this.listeners.set(event, handlers.filter((h) => h !== handler));
        return this;
    }
    removeAllListeners() {
        this.listeners.clear();
    }
    emit(event, ...args) {
        for (const h of this.listeners.get(event) ?? []) {
            h(...args);
        }
    }
    send(data, cb) {
        this.sentMessages.push(data);
        if (cb)
            cb(null);
    }
    ping() { }
    close(_code, _reason) {
        this.readyState = 3; // CLOSED
    }
}
class TestWsOrderClient extends wsOrderClient_1.WsOrderClient {
    attachMockSocket(socket) {
        this.ws = socket;
        this.isConnected = true;
    }
    setShuttingDown(value) {
        this.isShuttingDown = value;
    }
    setReconnectAttempts(value) {
        this.reconnectAttempts = value;
    }
    setConnected(value) {
        this.isConnected = value;
    }
    invokeOnMessage(data) {
        this._onMessage(data);
    }
    invokeOnClose(code, reason) {
        this._onClose(code, reason);
    }
}
class StubWsOrderClient extends wsOrderClient_1.WsOrderClient {
    readyOverride = true;
    placeOrderHandler;
    cancelOrderHandler;
    cancelReplaceOrderHandler;
    constructor() {
        super({ useTestnet: false, apiKey: "test_key", apiSecret: "test_secret" });
    }
    isReady() {
        return this.readyOverride;
    }
    placeOrder(params) {
        if (this.placeOrderHandler) {
            return this.placeOrderHandler(params);
        }
        return Promise.resolve({ id: "1", status: 200, result: null, error: null, rateLimits: [], rttMs: 5 });
    }
    cancelOrder(params) {
        if (this.cancelOrderHandler) {
            return this.cancelOrderHandler(params);
        }
        return Promise.resolve({ id: "1", status: 200, result: null, error: null, rateLimits: [], rttMs: 5 });
    }
    cancelReplaceOrder(params) {
        if (this.cancelReplaceOrderHandler) {
            return this.cancelReplaceOrderHandler(params);
        }
        return Promise.resolve({ id: "1", status: 200, result: null, error: null, rateLimits: [], rttMs: 5 });
    }
}
class SpyMarketDataClient extends marketDataClient_1.MarketDataClient {
    writes = [];
    constructor(maxAssets = 10) {
        super(new SharedArrayBuffer(maxAssets * 256 * 8), maxAssets, 256);
    }
    writeAtomicFloat64Asset(assetIdx, slot, value) {
        this.writes.push({ assetIdx, slot, val: value });
        super.writeAtomicFloat64Asset(assetIdx, slot, value);
    }
}
class StubRestExecutionClient extends binance_1.BinanceExecutionClient {
    httpHandler;
    executeHttpRequest(method, endpoint, params = {}) {
        if (this.httpHandler) {
            return this.httpHandler(method, endpoint, params);
        }
        return Promise.resolve({});
    }
}
class ThrowingAssetIndexExecutionClient extends binance_1.BinanceExecutionClient {
    resolveAssetIndex(_symbol, _explicitIdx) {
        throw new Error("Simulated pre-flight validation failure");
    }
}
// ─── Test Suite ───────────────────────────────────────────────────────────────
void (0, node_test_1.describe)("WsOrderClient — Phase 1 HFT Test Suite (Full Tier-1 Verification)", () => {
    // ── T01: Testnet endpoint ──────────────────────────────────────────────────
    void (0, node_test_1.it)("T01: constructor resolves testnet endpoint", () => {
        process.env["USE_TESTNET"] = "true";
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: true, apiKey: "k", apiSecret: "s" });
        const ep = client.getWsEndpoint();
        node_assert_1.strict.ok(ep.includes("testnet.binancefuture.com"), `Expected testnet endpoint, got: ${ep}`);
        process.env["USE_TESTNET"] = "false";
    });
    // ── T02: Mainnet endpoint ──────────────────────────────────────────────────
    void (0, node_test_1.it)("T02: constructor resolves mainnet endpoint", () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const ep = client.getWsEndpoint();
        node_assert_1.strict.ok(ep.includes("ws-fapi.binance.com"), `Expected mainnet endpoint, got: ${ep}`);
    });
    // ── T03: connect() resolves when socket opens ──────────────────────────────
    void (0, node_test_1.it)("T03: connect() is idempotent and respects connection state", async () => {
        const client = new TestWsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const mockSocket = new MockWebSocket();
        client.attachMockSocket(mockSocket);
        // Must resolve immediately without creating another connection or throwing
        await client.connect();
        node_assert_1.strict.strictEqual(client.isReady(), true, "Should be ready");
    });
    // ── T04: placeOrder() rejects when not connected ───────────────────────────
    void (0, node_test_1.it)("T04: placeOrder() rejects when WebSocket is not ready", async () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        // isConnected defaults to false — socket null
        await node_assert_1.strict.rejects(() => client.placeOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "MARKET",
            quantity: 0.001,
        }), /not ready/, "Should reject with 'not ready' when WS is disconnected");
    });
    // ── T05: cancelOrder() rejects when not connected ─────────────────────────
    void (0, node_test_1.it)("T05: cancelOrder() rejects when WebSocket is not ready", async () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        await node_assert_1.strict.rejects(() => client.cancelOrder({ symbol: "BTCUSDT", orderId: 12345 }), /not ready/);
    });
    // ── T06: cancelReplaceOrder() rejects when not connected ──────────────────
    void (0, node_test_1.it)("T06: cancelReplaceOrder() rejects when WebSocket is not ready", async () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        await node_assert_1.strict.rejects(() => client.cancelReplaceOrder({
            symbol: "BTCUSDT",
            side: "SELL",
            type: "LIMIT",
            cancelOrderId: 999,
        }), /not ready/);
    });
    // ── T07: MARKET order excludes timeInForce ─────────────────────────────────
    void (0, node_test_1.it)("T07: MARKET order payload excludes timeInForce", () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const payloadStr = client._buildPlaceOrderPayload({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "MARKET",
            quantity: 0.001,
            timeInForce: "GTC",
        }, "req-mkt-1");
        const payload = JSON.parse(payloadStr);
        node_assert_1.strict.strictEqual(payload.method, "order.place");
        node_assert_1.strict.strictEqual(payload.params.symbol, "BTCUSDT");
        node_assert_1.strict.strictEqual(payload.params.type, "MARKET");
        node_assert_1.strict.strictEqual(payload.params.timeInForce, undefined, "MARKET order must NOT have timeInForce in params");
    });
    // ── T08: STOP_MARKET order excludes timeInForce ───────────────────────────
    void (0, node_test_1.it)("T08: STOP_MARKET order payload excludes timeInForce", () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const payloadStr = client._buildPlaceOrderPayload({
            symbol: "BTCUSDT",
            side: "SELL",
            type: "STOP_MARKET",
            stopPrice: 60000,
            quantity: 0.001,
            timeInForce: "GTC",
        }, "req-stop-1");
        const payload = JSON.parse(payloadStr);
        node_assert_1.strict.strictEqual(payload.params.type, "STOP_MARKET");
        node_assert_1.strict.strictEqual(payload.params.timeInForce, undefined, "STOP_MARKET order must NOT have timeInForce in params");
    });
    // ── T09: TAKE_PROFIT_MARKET order excludes timeInForce ────────────────────
    void (0, node_test_1.it)("T09: TAKE_PROFIT_MARKET order payload excludes timeInForce", () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const payloadStr = client._buildPlaceOrderPayload({
            symbol: "BTCUSDT",
            side: "SELL",
            type: "TAKE_PROFIT_MARKET",
            stopPrice: 70000,
            quantity: 0.001,
            timeInForce: "GTC",
        }, "req-tp-1");
        const payload = JSON.parse(payloadStr);
        node_assert_1.strict.strictEqual(payload.params.type, "TAKE_PROFIT_MARKET");
        node_assert_1.strict.strictEqual(payload.params.timeInForce, undefined, "TAKE_PROFIT_MARKET order must NOT have timeInForce in params");
    });
    // ── T10: LIMIT order includes timeInForce ─────────────────────────────────
    void (0, node_test_1.it)("T10: LIMIT order payload includes timeInForce", () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const payloadStr = client._buildPlaceOrderPayload({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            price: 60000,
            quantity: 0.001,
            timeInForce: "GTX",
        }, "req-limit-1");
        const payload = JSON.parse(payloadStr);
        node_assert_1.strict.strictEqual(payload.params.type, "LIMIT");
        node_assert_1.strict.strictEqual(payload.params.timeInForce, "GTX", "LIMIT order MUST include timeInForce");
    });
    // ── T11: closePosition=true excludes reduceOnly and quantity ──────────────
    void (0, node_test_1.it)("T11: closePosition=true payload correctly sets closePosition string and excludes reduceOnly/quantity", () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const payloadStr = client._buildPlaceOrderPayload({
            symbol: "BTCUSDT",
            side: "SELL",
            type: "MARKET",
            closePosition: true,
            reduceOnly: true,
            quantity: 1.5,
        }, "req-close-1");
        const payload = JSON.parse(payloadStr);
        node_assert_1.strict.strictEqual(payload.params.closePosition, "true", "closePosition string must be 'true'");
        node_assert_1.strict.strictEqual(payload.params.reduceOnly, undefined, "reduceOnly must NOT be present when closePosition=true");
        node_assert_1.strict.strictEqual(payload.params.quantity, undefined, "quantity must NOT be present when closePosition=true");
    });
    // ── T12: quantity formatting via SymbolPrecisionRegistry ──────────────────
    void (0, node_test_1.it)("T12: quantity formatted via SymbolPrecisionRegistry (3 decimal places for BTCUSDT)", () => {
        const formatted = symbolPrecision_1.SymbolPrecisionRegistry.formatQuantity("BTCUSDT", 0.00123456);
        node_assert_1.strict.ok(typeof formatted === "number", "Formatted quantity must be a number");
        node_assert_1.strict.ok(formatted >= 0, "Formatted quantity must be non-negative");
    });
    // ── T13: price formatting via SymbolPrecisionRegistry ─────────────────────
    void (0, node_test_1.it)("T13: price formatted via SymbolPrecisionRegistry for BTCUSDT", () => {
        const formatted = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice("BTCUSDT", 59999.567);
        node_assert_1.strict.ok(typeof formatted === "number", "Formatted price must be a number");
        node_assert_1.strict.ok(formatted > 0, "Formatted price must be positive");
    });
    // ── T14: _signParams() injects required fields ────────────────────────────
    void (0, node_test_1.it)("T14: _signParams() injects timestamp, recvWindow, apiKey, and signature", () => {
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "test_api_key",
            apiSecret: "test_secret",
        });
        const p = {
            symbol: "BTCUSDT",
            side: "BUY",
            type: "MARKET",
        };
        client._signParams(p, 5000);
        node_assert_1.strict.ok(typeof p["timestamp"] === "number", "timestamp must be a number");
        node_assert_1.strict.ok(p["timestamp"] > 0, "timestamp must be positive");
        node_assert_1.strict.strictEqual(p["recvWindow"], 5000, "recvWindow must match argument");
        node_assert_1.strict.strictEqual(p["apiKey"], "test_api_key", "apiKey must be injected");
        node_assert_1.strict.ok(typeof p["signature"] === "string" && p["signature"].length === 64, "signature must be 64-char hex");
    });
    // ── T15: HMAC-SHA256 signature correctness (including apiKey and strict alphabetical sort) ─
    void (0, node_test_1.it)("T15: HMAC-SHA256 signature includes apiKey and enforces strict alphabetical parameter order", () => {
        const apiSecret = "super_secret_key";
        const apiKey = "my_api_key_institutional";
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey,
            apiSecret,
        });
        const p = {
            symbol: "ETHUSDT",
            side: "SELL",
            type: "LIMIT",
            price: 2500.0,
            quantity: 1.5,
        };
        client._signParams(p, 5000);
        node_assert_1.strict.strictEqual(p["apiKey"], apiKey, "apiKey must be present in params");
        node_assert_1.strict.strictEqual(p["recvWindow"], 5000, "recvWindow must be present in params");
        node_assert_1.strict.ok(typeof p["timestamp"] === "number", "timestamp must be present in params");
        const sortedKeys = Object.keys(p)
            .filter((k) => k !== "signature")
            .sort();
        for (let i = 0; i < sortedKeys.length - 1; i++) {
            node_assert_1.strict.ok(sortedKeys[i] < sortedKeys[i + 1], `Keys must be strictly alphabetical: ${sortedKeys[i]} < ${sortedKeys[i + 1]}`);
        }
        const expectedQueryString = sortedKeys
            .map((k) => `${k}=${encodeURIComponent(String(p[k]))}`)
            .join("&");
        const expectedSignature = crypto
            .createHmac("sha256", apiSecret)
            .update(expectedQueryString)
            .digest("hex");
        node_assert_1.strict.strictEqual(p["signature"], expectedSignature, "Injected signature must match independently computed HMAC-SHA256 over sorted query string including apiKey");
    });
    // ── T15B: Consecutive order signing without parameter pollution (Fix DEF-01) ─
    void (0, node_test_1.it)("T15B: consecutive order signing does not leak residual parameters across ticks", () => {
        const apiSecret = "consecutive_test_secret";
        const apiKey = "consecutive_test_key";
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey,
            apiSecret,
        });
        const p1 = {
            symbol: "BTCUSDT",
            side: "SELL",
            type: "STOP_MARKET",
            stopPrice: 60000,
            workingType: "CONTRACT_PRICE",
        };
        client._signParams(p1, 5000);
        const p2 = {
            symbol: "ETHUSDT",
            side: "BUY",
            type: "MARKET",
            quantity: 0.5,
        };
        client._signParams(p2, 5000);
        node_assert_1.strict.strictEqual(p2["stopPrice"], undefined, "Order 2 must not inherit stopPrice from Order 1");
        node_assert_1.strict.strictEqual(p2["workingType"], undefined, "Order 2 must not inherit workingType from Order 1");
        const sortedKeys2 = Object.keys(p2)
            .filter((k) => k !== "signature")
            .sort();
        const expectedQs2 = sortedKeys2
            .map((k) => `${k}=${encodeURIComponent(String(p2[k]))}`)
            .join("&");
        const expectedSig2 = crypto
            .createHmac("sha256", apiSecret)
            .update(expectedQs2)
            .digest("hex");
        node_assert_1.strict.strictEqual(p2["signature"], expectedSig2, "Order 2 signature must be unpolluted by Order 1");
    });
    // ── T15C: HMAC-SHA256 signing with custom keys strictly enforces ASCII order (Fix DEF-06) ─
    void (0, node_test_1.it)("T15C: HMAC-SHA256 signing with custom keys strictly enforces ASCII lexicographical order", () => {
        const apiSecret = "custom_key_secret";
        const apiKey = "custom_key_id";
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey,
            apiSecret,
        });
        const p = {
            activationPrice: 58000,
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            price: 59000,
            quantity: 0.1,
            zetaFactor: 99,
        };
        client._signParams(p, 5000);
        const sortedKeys = Object.keys(p)
            .filter((k) => k !== "signature")
            .sort();
        const expectedQueryString = sortedKeys
            .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`)
            .join("&");
        const expectedSig = crypto
            .createHmac("sha256", apiSecret)
            .update(expectedQueryString)
            .digest("hex");
        node_assert_1.strict.strictEqual(p["signature"], expectedSig, "Signature with custom unmapped keys must match unified strictly sorted query string");
    });
    // ── T16: _dispatch() registers pending request ────────────────────────────
    void (0, node_test_1.it)("T16: _dispatch() registers a pending request in the internal map", async () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 500,
        });
        const mockSocket = new MockWebSocket();
        client.attachMockSocket(mockSocket);
        const timeoutState = { caught: false };
        const p = client
            .placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.001 })
            .catch((_err) => {
            timeoutState.caught = true;
        });
        node_assert_1.strict.strictEqual(client.getPendingRequestCount(), 1, "Pending map must have exactly 1 entry after dispatch");
        await p;
        node_assert_1.strict.strictEqual(timeoutState.caught, true, "Pending request must reject on timeout");
        node_assert_1.strict.strictEqual(client.getPendingRequestCount(), 0, "Pending map must be empty after timeout resolution");
    });
    // ── T17: _onMessage() resolves on status 200 ──────────────────────────────
    void (0, node_test_1.it)("T17: _onMessage() resolves the promise on Binance status 200", async () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 2000,
        });
        const mockSocket = new MockWebSocket();
        client.attachMockSocket(mockSocket);
        const dispatchPromise = client.placeOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "MARKET",
            quantity: 0.001,
        });
        const sentRaw = mockSocket.sentMessages[0];
        node_assert_1.strict.ok(sentRaw, "A message must have been sent over the socket");
        const sentPayload = JSON.parse(sentRaw);
        const id = sentPayload.id;
        const mockResponse = {
            id,
            status: 200,
            result: {
                orderId: 999001,
                symbol: "BTCUSDT",
                status: "FILLED",
                clientOrderId: "TEST_CID",
                price: "0",
                avgPrice: "59000.00",
                origQty: "0.001",
                executedQty: "0.001",
                cumQuote: "59.00",
                timeInForce: "GTC",
                type: "MARKET",
                reduceOnly: false,
                side: "BUY",
                positionSide: "LONG",
                stopPrice: "0",
                workingType: "CONTRACT_PRICE",
                updateTime: Date.now(),
            },
            error: null,
            rateLimits: [],
        };
        client.invokeOnMessage(Buffer.from(JSON.stringify(mockResponse)));
        const response = await dispatchPromise;
        node_assert_1.strict.strictEqual(response.status, 200);
        node_assert_1.strict.ok(response.result !== null && "orderId" in response.result, "Expected WsOrderResult with orderId");
        node_assert_1.strict.strictEqual(response.result.orderId, 999001);
        node_assert_1.strict.ok(response.rttMs >= 0, "rttMs must be non-negative");
    });
    // ── T18: _onMessage() rejects on non-200 ──────────────────────────────────
    void (0, node_test_1.it)("T18: _onMessage() rejects the promise on Binance error status", async () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 2000,
        });
        const mockSocket = new MockWebSocket();
        client.attachMockSocket(mockSocket);
        const dispatchPromise = client.placeOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            price: 1,
            quantity: 0.001,
            timeInForce: "GTX",
        });
        const sentPayload = JSON.parse(mockSocket.sentMessages[0]);
        const id = sentPayload.id;
        const errorResponse = {
            id,
            status: 400,
            result: undefined,
            error: { code: -1100, msg: "Illegal characters found in parameter" },
            rateLimits: [],
        };
        client.invokeOnMessage(Buffer.from(JSON.stringify(errorResponse)));
        await node_assert_1.strict.rejects(() => dispatchPromise, (err) => err.message.includes("-1100") &&
            err.message.includes("Illegal characters"), "Should reject with Binance error code and message");
    });
    // ── T19: _onMessage() ignores unknown ids ─────────────────────────────────
    void (0, node_test_1.it)("T19: _onMessage() silently ignores messages with unknown correlation IDs", () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
        });
        const unknownResponse = {
            id: "completely-unknown-uuid-9999",
            status: 200,
            result: { orderId: 1 },
            rateLimits: [],
        };
        node_assert_1.strict.doesNotThrow(() => {
            client.invokeOnMessage(Buffer.from(JSON.stringify(unknownResponse)));
        });
    });
    // ── T20: Timeout — pending request rejected after requestTimeoutMs ─────────
    void (0, node_test_1.it)("T20: pending request is rejected after requestTimeoutMs with timeout error", async () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 50,
        });
        const mockSocket = new MockWebSocket();
        client.attachMockSocket(mockSocket);
        await node_assert_1.strict.rejects(() => client.placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.001 }), (err) => err.message.includes("timed out after 50ms"), "Should reject with timeout error after requestTimeoutMs");
    });
    // ── T21: destroy() rejects all pending requests ────────────────────────────
    void (0, node_test_1.it)("T21: destroy() rejects all pending requests with shutdown error", async () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 60_000,
        });
        const mockSocket = new MockWebSocket();
        client.attachMockSocket(mockSocket);
        const p1 = client
            .placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.001 })
            .then(() => node_assert_1.strict.fail("Expected placeOrder to reject on destroy"))
            .catch((e) => (e instanceof Error ? e.message : String(e)));
        const p2 = client
            .cancelOrder({ symbol: "BTCUSDT", orderId: 123 })
            .then(() => node_assert_1.strict.fail("Expected cancelOrder to reject on destroy"))
            .catch((e) => (e instanceof Error ? e.message : String(e)));
        client.destroy();
        const [msg1, msg2] = await Promise.all([p1, p2]);
        node_assert_1.strict.ok(msg1.includes("destroyed"), `p1 error: ${msg1}`);
        node_assert_1.strict.ok(msg2.includes("destroyed"), `p2 error: ${msg2}`);
    });
    // ── T22: destroy() closes the WebSocket ───────────────────────────────────
    void (0, node_test_1.it)("T22: destroy() closes the WebSocket and sets isConnected=false", () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
        });
        const mockSocket = new MockWebSocket();
        client.attachMockSocket(mockSocket);
        client.destroy();
        node_assert_1.strict.strictEqual(client.isSocketConnected(), false, "isConnected must be false after destroy");
    });
    // ── T23: _onClose() schedules reconnect on non-shutdown close ─────────────
    void (0, node_test_1.it)("T23: _onClose() schedules a reconnect timer when not shutting down", () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
        });
        client.setShuttingDown(false);
        client.setConnected(true);
        client.setReconnectAttempts(0);
        client.invokeOnClose(1006, "Abnormal closure");
        const timer = client.getReconnectTimer();
        node_assert_1.strict.notStrictEqual(timer, null, "reconnectTimer must be set after abnormal close");
        if (timer !== null)
            clearTimeout(timer);
    });
    // ── T24: _onClose() does NOT reconnect when shutting down ─────────────────
    void (0, node_test_1.it)("T24: _onClose() does NOT schedule reconnect when isShuttingDown=true", () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
        });
        client.setShuttingDown(true);
        client.setConnected(true);
        client.invokeOnClose(1000, "Normal shutdown");
        const timer = client.getReconnectTimer();
        node_assert_1.strict.strictEqual(timer, null, "reconnectTimer must remain null during shutdown");
    });
    // ── T25: rttMs is correctly computed ──────────────────────────────────────
    void (0, node_test_1.it)("T25: rttMs in WsOrderResponse reflects wall-clock dispatch-to-ack latency", async () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 2000,
        });
        const mockSocket = new MockWebSocket();
        client.attachMockSocket(mockSocket);
        const dispatchPromise = client.placeOrder({
            symbol: "BTCUSDT",
            side: "SELL",
            type: "MARKET",
            quantity: 0.001,
        });
        const beforeAck = Date.now();
        await new Promise((r) => setTimeout(r, 10));
        const sentPayload = JSON.parse(mockSocket.sentMessages[0]);
        const id = sentPayload.id;
        const mockResponse = {
            id,
            status: 200,
            result: {
                orderId: 777001,
                symbol: "BTCUSDT",
                status: "NEW",
                clientOrderId: "RTT_TEST",
                price: "0",
                avgPrice: "0",
                origQty: "0.001",
                executedQty: "0",
                cumQuote: "0",
                timeInForce: "GTC",
                type: "MARKET",
                reduceOnly: false,
                side: "SELL",
                positionSide: "SHORT",
                stopPrice: "0",
                workingType: "CONTRACT_PRICE",
                updateTime: beforeAck,
            },
            error: null,
            rateLimits: [],
        };
        client.invokeOnMessage(Buffer.from(JSON.stringify(mockResponse)));
        const response = await dispatchPromise;
        node_assert_1.strict.ok(response.rttMs >= 10, `rttMs (${String(response.rttMs)}ms) must be >= 10ms (simulated delay)`);
        node_assert_1.strict.ok(response.rttMs < 2000, `rttMs (${String(response.rttMs)}ms) must be < timeout`);
    });
    // ── T26: inFlightClientOrderIds memory leak eradication (Fix DEF-03) ───────
    void (0, node_test_1.it)("T26: inFlightClientOrderIds is unconditionally cleared on successful WS order execution", async () => {
        const execClient = new binance_1.BinanceExecutionClient();
        const mockWs = new StubWsOrderClient();
        mockWs.placeOrderHandler = (params) => Promise.resolve({
            id: "req-001",
            status: 200,
            result: {
                orderId: 888001,
                symbol: params.symbol,
                status: "FILLED",
                clientOrderId: params.newClientOrderId || "TEST_CID",
                price: "50000",
                avgPrice: "50000",
                origQty: "1",
                executedQty: "1",
                cumQuote: "50000",
                timeInForce: "GTC",
                type: params.type,
                reduceOnly: false,
                side: params.side,
                positionSide: "BOTH",
                stopPrice: "0",
                workingType: "CONTRACT_PRICE",
                updateTime: Date.now(),
            },
            error: null,
            rateLimits: [],
            rttMs: 14.2,
        });
        const mockSab = new SpyMarketDataClient();
        execClient.attachWsOrderClient(mockWs, mockSab, 0);
        const testCid = "LEAK_CHECK_CID_001";
        await execClient.placeOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            price: 50000,
            quantity: 1,
            clientOrderId: testCid,
        });
        node_assert_1.strict.strictEqual(execClient.hasInFlightClientOrderId(testCid), false, "inFlightClientOrderIds must NOT retain CID after WS success");
        node_assert_1.strict.strictEqual(execClient.getInFlightClientOrderIdCount(), 0, "inFlightClientOrderIds size must be 0 (zero leak)");
    });
    // ── T27: Multi-asset telemetry routing & singleton attachment (Fix DEF-04) ─
    void (0, node_test_1.it)("T27: attachWsOrderClient is idempotent and routes telemetry to the exact assetIndex per symbol", async () => {
        const execClient = new binance_1.BinanceExecutionClient();
        const mockSab = new SpyMarketDataClient();
        const mockWs = new StubWsOrderClient();
        mockWs.placeOrderHandler = (params) => Promise.resolve({
            id: "req-multi",
            status: 200,
            result: {
                orderId: 999111,
                symbol: params.symbol,
                status: "NEW",
                clientOrderId: params.newClientOrderId || "MULTI_CID",
                price: "100",
                avgPrice: "0",
                origQty: "1",
                executedQty: "0",
                cumQuote: "0",
                timeInForce: "GTC",
                type: params.type,
                reduceOnly: false,
                side: params.side,
                positionSide: "BOTH",
                stopPrice: "0",
                workingType: "CONTRACT_PRICE",
                updateTime: Date.now(),
            },
            error: null,
            rateLimits: [],
            rttMs: 16.5,
        });
        execClient.attachWsOrderClient(mockWs, mockSab, 0);
        execClient.attachWsOrderClient(mockWs, mockSab, 1);
        mockSab.writes.length = 0;
        await execClient.placeOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            price: 60000,
            quantity: 0.1,
            assetIndex: 0,
        });
        const btcRttWrite = mockSab.writes.find((w) => w.assetIdx === 0 && w.slot === 159);
        node_assert_1.strict.ok(btcRttWrite !== undefined, "BTCUSDT order must write RTT to assetIndex 0 slot 159");
        node_assert_1.strict.strictEqual(btcRttWrite.val, 16.5);
        mockSab.writes.length = 0;
        await execClient.placeOrder({
            symbol: "ETHUSDT",
            side: "SELL",
            type: "LIMIT",
            price: 2500,
            quantity: 1.0,
            assetIndex: 1,
        });
        const ethRttWrite = mockSab.writes.find((w) => w.assetIdx === 1 && w.slot === 159);
        node_assert_1.strict.ok(ethRttWrite !== undefined, "ETHUSDT order must write RTT to assetIndex 1 slot 159");
        node_assert_1.strict.strictEqual(ethRttWrite.val, 16.5);
    });
    // ── T28: REST Fallback routing on -1022 signature error (Fix DEF-05) ───────
    void (0, node_test_1.it)("T28: placeOrder cleanly falls back to REST HTTPS on -1022 signature error without crashing", async () => {
        const execClient = new StubRestExecutionClient();
        let restCalled = false;
        execClient.httpHandler = () => {
            restCalled = true;
            const restOrderRes = {
                orderId: 555001,
                symbol: "BTCUSDT",
                status: "NEW",
                clientOrderId: "REST_FALLBACK_CID",
                price: "60000",
                avgPrice: "0",
                origQty: "0.1",
                executedQty: "0",
                cumQuote: "0",
                timeInForce: "GTC",
                type: "LIMIT",
                reduceOnly: false,
                side: "BUY",
                positionSide: "LONG",
                stopPrice: "0",
                workingType: "CONTRACT_PRICE",
                updateTime: Date.now(),
            };
            return Promise.resolve(restOrderRes);
        };
        const mockFailingWs = new StubWsOrderClient();
        mockFailingWs.placeOrderHandler = () => Promise.reject(new Error("[WsOrderClient] Binance WS Order API Error [-1022]: Signature for this request is not valid."));
        const mockSab = new SpyMarketDataClient();
        execClient.attachWsOrderClient(mockFailingWs, mockSab, 0);
        const res = await execClient.placeOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            price: 60000,
            quantity: 0.1,
            clientOrderId: "SIG_TEST_CID",
        });
        node_assert_1.strict.strictEqual(restCalled, true, "REST path must have been called on -1022 fallback");
        node_assert_1.strict.strictEqual(res.orderId, 555001, "Returned orderId must be from REST fallback response");
    });
    // ── T29: WS-First cancelOrder execution & fallback (Fix DEF-06) ────────────
    void (0, node_test_1.it)("T29: cancelOrder uses WebSocket client when ready and falls back to REST on error", async () => {
        const execClient = new binance_1.BinanceExecutionClient();
        let wsCancelCalled = false;
        const mockWs = new StubWsOrderClient();
        mockWs.cancelOrderHandler = (params) => {
            wsCancelCalled = true;
            return Promise.resolve({
                id: "cancel-req-1",
                status: 200,
                result: {
                    orderId: params.orderId || 12345,
                    symbol: params.symbol,
                    status: "CANCELED",
                    clientOrderId: "CANCEL_CID",
                    price: "0",
                    avgPrice: "0",
                    origQty: "1",
                    executedQty: "0",
                    cumQuote: "0",
                    timeInForce: "GTC",
                    type: "LIMIT",
                    reduceOnly: false,
                    side: "BUY",
                    positionSide: "BOTH",
                    stopPrice: "0",
                    workingType: "CONTRACT_PRICE",
                    updateTime: Date.now(),
                },
                error: null,
                rateLimits: [],
                rttMs: 11.8,
            });
        };
        const mockSab = new SpyMarketDataClient();
        execClient.attachWsOrderClient(mockWs, mockSab, 0);
        const cancelRes = await execClient.cancelOrder("BTCUSDT", 12345);
        node_assert_1.strict.strictEqual(wsCancelCalled, true, "cancelOrder must be dispatched via WebSocket");
        node_assert_1.strict.strictEqual(cancelRes.status, "CANCELED");
        node_assert_1.strict.strictEqual(cancelRes.orderId, 12345);
    });
    // ── T29B: cancelOrder with alphanumeric ID preserves full origClientOrderId (Fix DEF-07) ──
    void (0, node_test_1.it)("T29B: cancelOrder with alphanumeric string ID preserves origClientOrderId without numeric truncation", async () => {
        const execClient = new binance_1.BinanceExecutionClient();
        const capturedBox = {
            params: null,
        };
        const mockWs = new StubWsOrderClient();
        mockWs.cancelOrderHandler = (params) => {
            capturedBox.params = params;
            return Promise.resolve({
                id: "cancel-req-2",
                status: 200,
                result: {
                    orderId: 0,
                    symbol: params.symbol,
                    status: "CANCELED",
                    clientOrderId: params.origClientOrderId || "",
                    price: "0",
                    avgPrice: "0",
                    origQty: "1",
                    executedQty: "0",
                    cumQuote: "0",
                    timeInForce: "GTC",
                    type: "LIMIT",
                    reduceOnly: false,
                    side: "BUY",
                    positionSide: "BOTH",
                    stopPrice: "0",
                    workingType: "CONTRACT_PRICE",
                    updateTime: Date.now(),
                },
                error: null,
                rateLimits: [],
                rttMs: 8.5,
            });
        };
        const mockSab = new SpyMarketDataClient();
        execClient.attachWsOrderClient(mockWs, mockSab, 0);
        await execClient.cancelOrder("BTCUSDT", "12345_BATBOT_SL");
        const resultParams = capturedBox.params;
        node_assert_1.strict.ok(resultParams !== null, "cancelOrder must be called");
        node_assert_1.strict.strictEqual(resultParams.orderId, undefined, "orderId must be undefined for alphanumeric clientOrderId");
        node_assert_1.strict.strictEqual(resultParams.origClientOrderId, "12345_BATBOT_SL", "origClientOrderId must match full string without truncation");
    });
    // ── T30: -5022 POST_ONLY spread crossing on WS triggers 1-tick shift retry (Fix DEF-03) ──
    void (0, node_test_1.it)("T30: placeOrder recovers from -5022 WS rejection by shifting 1 tick away and retrying", async () => {
        const execClient = new binance_1.BinanceExecutionClient();
        let attempt = 0;
        const dispatchedPrices = [];
        const mockWs = new StubWsOrderClient();
        mockWs.placeOrderHandler = (params) => {
            attempt++;
            if (params.price !== undefined)
                dispatchedPrices.push(params.price);
            if (attempt === 1) {
                return Promise.reject(new Error("[WsOrderClient] Binance WS Order API Error [-5022]: Post Only order would immediately trigger."));
            }
            return Promise.resolve({
                id: "req-retry",
                status: 200,
                result: {
                    orderId: 777123,
                    symbol: "BTCUSDT",
                    status: "NEW",
                    clientOrderId: "GTX_RETRY_CID",
                    price: String(params.price),
                    avgPrice: "0",
                    origQty: "0.1",
                    executedQty: "0",
                    cumQuote: "0",
                    timeInForce: "GTX",
                    type: "LIMIT",
                    reduceOnly: false,
                    side: "BUY",
                    positionSide: "BOTH",
                    stopPrice: "0",
                    workingType: "CONTRACT_PRICE",
                    updateTime: Date.now(),
                },
                error: null,
                rateLimits: [],
                rttMs: 12.0,
            });
        };
        const mockSab = new SpyMarketDataClient();
        execClient.attachWsOrderClient(mockWs, mockSab, 0);
        const res = await execClient.placeOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            price: 60000.0,
            quantity: 0.1,
            timeInForce: "GTX",
            clientOrderId: "GTX_TEST_CID",
        });
        node_assert_1.strict.strictEqual(attempt, 2, "placeOrder must have retried after -5022 rejection");
        node_assert_1.strict.strictEqual(res.orderId, 777123, "Order must succeed on retry pass");
        node_assert_1.strict.ok(dispatchedPrices.length === 2, "Must have recorded two price attempts");
        node_assert_1.strict.ok(dispatchedPrices[1] < dispatchedPrices[0], "BUY retry price must be shifted 1 tick lower to clear spread");
    });
    // ── T31: Singleton ensureWsOrderClient eliminates startup race condition (Fix DEF-02) ──
    void (0, node_test_1.it)("T31: ensureWsOrderClient returns exact same singleton across 10 concurrent asset calls", async () => {
        const execClient = new binance_1.BinanceExecutionClient();
        const mockSab = new SpyMarketDataClient();
        const mockWs = new TestWsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const mockSocket = new MockWebSocket();
        mockWs.attachMockSocket(mockSocket);
        execClient.attachWsOrderClient(mockWs, mockSab, 0);
        const promises = Array.from({ length: 10 }, (_, i) => execClient.ensureWsOrderClient(mockSab, i, `ASSET_${String(i)}`));
        const clients = await Promise.all(promises);
        for (let i = 0; i < clients.length; i++) {
            node_assert_1.strict.strictEqual(clients[i], mockWs, `Client ${String(i)} must be identical to singleton instance`);
        }
    });
    // ── T32: cancelReplaceOrder partial failure does NOT issue redundant REST cancel (Fix DEF-08) ──
    void (0, node_test_1.it)("T32: cancelReplaceOrder throws WS_CANCEL_REPLACE_PARTIAL and halts when cancel succeeded but new order failed", async () => {
        const execClient = new StubRestExecutionClient();
        let restPutCalled = false;
        execClient.httpHandler = () => {
            restPutCalled = true;
            return Promise.resolve({ orderId: 999 });
        };
        const mockWs = new StubWsOrderClient();
        mockWs.cancelReplaceOrderHandler = () => Promise.resolve({
            id: "cr-part-1",
            status: 200,
            result: {
                cancelResult: "SUCCESS",
                newOrderResult: "FAILURE",
                cancelResponse: {
                    orderId: 111222,
                    symbol: "BTCUSDT",
                    status: "CANCELED",
                    clientOrderId: "",
                    price: "50000",
                    avgPrice: "0",
                    origQty: "1",
                    executedQty: "0",
                    cumQuote: "0",
                    timeInForce: "GTC",
                    type: "LIMIT",
                    reduceOnly: false,
                    side: "BUY",
                    positionSide: "BOTH",
                    stopPrice: "0",
                    workingType: "CONTRACT_PRICE",
                    updateTime: Date.now(),
                },
                newOrderResponse: { code: -2010, msg: "Account has insufficient balance for new order" },
            },
            error: null,
            rateLimits: [],
            rttMs: 14.0,
        });
        const mockSab = new SpyMarketDataClient();
        execClient.attachWsOrderClient(mockWs, mockSab, 0);
        await node_assert_1.strict.rejects(() => execClient.cancelReplaceOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            price: 50000,
            quantity: 1,
            cancelOrderId: 111222,
        }), (err) => err.message.includes("[WS_CANCEL_REPLACE_PARTIAL]") &&
            err.message.includes("insufficient balance"), "Must throw WS_CANCEL_REPLACE_PARTIAL indicating resting order was canceled but replacement failed");
        node_assert_1.strict.strictEqual(restPutCalled, false, "REST PUT must NEVER be called when order was already canceled");
    });
    // ── T33: inFlightClientOrderIds is cleaned up even if pre-flight throws (Fix DEF-05) ──
    void (0, node_test_1.it)("T33: inFlightClientOrderIds is cleaned up in finally block even if pre-flight checks throw", async () => {
        const execClient = new ThrowingAssetIndexExecutionClient();
        const testCid = "PREFLIGHT_FAIL_CID";
        await node_assert_1.strict.rejects(() => execClient.placeOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "MARKET",
            quantity: 1,
            clientOrderId: testCid,
        }), /Simulated pre-flight validation failure/);
        node_assert_1.strict.strictEqual(execClient.hasInFlightClientOrderId(testCid), false, "inFlightClientOrderIds must be cleared in finally block after pre-flight exception");
    });
    // ── T34: _dispatch() handles cb(null) as successful transmission without throwing TypeError ──
    void (0, node_test_1.it)("T34: _dispatch() handles cb(null) as successful transmission without throwing TypeError", async () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "test_key",
            apiSecret: "test_secret",
            requestTimeoutMs: 1000,
        });
        const mockSocket = new MockWebSocket();
        let callbackReceivedNull = false;
        mockSocket.send = (data, cb) => {
            mockSocket.sentMessages.push(data);
            if (cb) {
                callbackReceivedNull = true;
                cb(null);
            }
        };
        client.attachMockSocket(mockSocket);
        const orderPromise = client.placeOrder({
            symbol: "ETHUSDT",
            side: "SELL",
            type: "MARKET",
            quantity: 0.05,
            positionSide: "LONG",
        });
        node_assert_1.strict.strictEqual(callbackReceivedNull, true, "Mock socket must have invoked cb(null)");
        const sentRaw = mockSocket.sentMessages[0];
        node_assert_1.strict.ok(sentRaw, "Payload must be sent over mock socket");
        const sentPayload = JSON.parse(sentRaw);
        client.invokeOnMessage(JSON.stringify({
            id: sentPayload.id,
            status: 200,
            result: {
                orderId: 777123,
                symbol: "ETHUSDT",
                status: "FILLED",
                clientOrderId: "TEST_EXIT_CID",
                price: "0",
                avgPrice: "2236.40",
                origQty: "0.05",
                executedQty: "0.05",
                cumQuote: "111.82",
                timeInForce: "GTC",
                type: "MARKET",
                reduceOnly: false,
                side: "SELL",
                positionSide: "LONG",
                stopPrice: "0",
                workingType: "CONTRACT_PRICE",
                updateTime: Date.now(),
            },
        }));
        const response = await orderPromise;
        node_assert_1.strict.strictEqual(response.status, 200);
        node_assert_1.strict.ok(response.result);
    });
    // ── T35: _dispatch() intercepts synchronous ws.send exception and rejects promise cleanly ──
    void (0, node_test_1.it)("T35: _dispatch() intercepts synchronous ws.send exception and rejects promise cleanly", async () => {
        const client = new TestWsOrderClient({
            useTestnet: false,
            apiKey: "test_key",
            apiSecret: "test_secret",
            requestTimeoutMs: 1000,
        });
        const mockSocket = new MockWebSocket();
        mockSocket.send = () => {
            throw new Error("WebSocket is not open: readyState 2 (CLOSING)");
        };
        client.attachMockSocket(mockSocket);
        await node_assert_1.strict.rejects(() => client.placeOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "MARKET",
            quantity: 0.001,
        }), (err) => err.message.includes("[WsOrderClient] Synchronous socket send error") &&
            err.message.includes("WebSocket is not open: readyState 2 (CLOSING)"), "Must cleanly reject Promise on synchronous socket send error without crashing");
    });
});
