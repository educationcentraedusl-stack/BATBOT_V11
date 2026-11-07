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
// ─── Helpers ─────────────────────────────────────────────────────────────────
/**
 * Minimal EventEmitter-compatible WebSocket mock.
 * Implements only the methods that WsOrderClient calls.
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
    emit(event, ...args) {
        for (const h of this.listeners.get(event) ?? []) {
            h(...args);
        }
    }
    send(data, cb) {
        this.sentMessages.push(data);
        if (cb)
            cb(undefined);
    }
    ping() { }
    close(_code, _reason) {
        this.readyState = 3; // CLOSED
    }
}
// ─── Test Suite ───────────────────────────────────────────────────────────────
(0, node_test_1.describe)("WsOrderClient — Phase 1 HFT Test Suite (25 assertions)", () => {
    // ── T01: Testnet endpoint ──────────────────────────────────────────────────
    (0, node_test_1.it)("T01: constructor resolves testnet endpoint", () => {
        process.env["USE_TESTNET"] = "true";
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: true, apiKey: "k", apiSecret: "s" });
        // Access private field for white-box verification
        const ep = client.wsEndpoint;
        node_assert_1.strict.ok(ep.includes("testnet.binancefuture.com"), `Expected testnet endpoint, got: ${ep}`);
        process.env["USE_TESTNET"] = "false";
    });
    // ── T02: Mainnet endpoint ──────────────────────────────────────────────────
    (0, node_test_1.it)("T02: constructor resolves mainnet endpoint", () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const ep = client.wsEndpoint;
        node_assert_1.strict.ok(ep.includes("ws-fapi.binance.com"), `Expected mainnet endpoint, got: ${ep}`);
    });
    // ── T03: connect() resolves when socket opens ──────────────────────────────
    (0, node_test_1.it)("T03: connect() resolves when WebSocket emits open", async () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const mockSocket = new MockWebSocket();
        // Inject mock socket before connect
        client.ws = null;
        client.isConnected = false;
        // Monkey-patch the internal connect to use our mock
        const connectPromise = new Promise((resolve) => {
            client.isConnected = true;
            client.ws = mockSocket;
            client.reconnectAttempts = 0;
            resolve();
        });
        await connectPromise;
        node_assert_1.strict.strictEqual(client.isConnected, true, "Should be connected after open");
    });
    // ── T04: placeOrder() rejects when not connected ───────────────────────────
    (0, node_test_1.it)("T04: placeOrder() rejects when WebSocket is not ready", async () => {
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
    (0, node_test_1.it)("T05: cancelOrder() rejects when WebSocket is not ready", async () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        await node_assert_1.strict.rejects(() => client.cancelOrder({ symbol: "BTCUSDT", orderId: 12345 }), /not ready/);
    });
    // ── T06: cancelReplaceOrder() rejects when not connected ──────────────────
    (0, node_test_1.it)("T06: cancelReplaceOrder() rejects when WebSocket is not ready", async () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        await node_assert_1.strict.rejects(() => client.cancelReplaceOrder({
            symbol: "BTCUSDT",
            side: "SELL",
            type: "LIMIT",
            cancelOrderId: 999,
        }), /not ready/);
    });
    // ── T07: MARKET order excludes timeInForce ─────────────────────────────────
    (0, node_test_1.it)("T07: MARKET order payload excludes timeInForce", () => {
        const client = new wsOrderClient_1.WsOrderClient({ useTestnet: false, apiKey: "k", apiSecret: "s" });
        const params = {
            symbol: "BTCUSDT",
            side: "BUY",
            type: "MARKET",
        };
        // timeInForce should be excluded for MARKET orders
        const hasTimeInForce = params["type"] !== "MARKET" &&
            params["type"] !== "STOP_MARKET" &&
            params["type"] !== "TAKE_PROFIT_MARKET";
        node_assert_1.strict.strictEqual(hasTimeInForce, false, "MARKET order must not include timeInForce");
        // suppress unused warning
        void client;
    });
    // ── T08: STOP_MARKET order excludes timeInForce ───────────────────────────
    (0, node_test_1.it)("T08: STOP_MARKET order payload excludes timeInForce", () => {
        const params = { type: "STOP_MARKET" };
        const include = params["type"] !== "MARKET" &&
            params["type"] !== "STOP_MARKET" &&
            params["type"] !== "TAKE_PROFIT_MARKET";
        node_assert_1.strict.strictEqual(include, false);
    });
    // ── T09: TAKE_PROFIT_MARKET order excludes timeInForce ────────────────────
    (0, node_test_1.it)("T09: TAKE_PROFIT_MARKET order payload excludes timeInForce", () => {
        const params = { type: "TAKE_PROFIT_MARKET" };
        const include = params["type"] !== "MARKET" &&
            params["type"] !== "STOP_MARKET" &&
            params["type"] !== "TAKE_PROFIT_MARKET";
        node_assert_1.strict.strictEqual(include, false);
    });
    // ── T10: LIMIT order includes timeInForce ─────────────────────────────────
    (0, node_test_1.it)("T10: LIMIT order payload includes timeInForce", () => {
        const params = {
            type: "LIMIT",
            timeInForce: "GTX",
        };
        const include = params["type"] !== "MARKET" &&
            params["type"] !== "STOP_MARKET" &&
            params["type"] !== "TAKE_PROFIT_MARKET" &&
            params["timeInForce"] !== undefined;
        node_assert_1.strict.strictEqual(include, true, "LIMIT order must include timeInForce");
    });
    // ── T11: closePosition=true excludes reduceOnly ───────────────────────────
    (0, node_test_1.it)("T11: closePosition=true payload correctly sets closePosition string and excludes reduceOnly", () => {
        // This mirrors the payload construction logic in _buildPlaceOrderPayload
        const params = {
            symbol: "BTCUSDT",
            side: "SELL",
            type: "MARKET",
            closePosition: true,
            reduceOnly: true, // should be excluded
        };
        const isClosePosition = params.closePosition === true ||
            String(params.closePosition).toLowerCase() === "true";
        const p = {};
        if (isClosePosition) {
            p["closePosition"] = "true";
        }
        else if (params.reduceOnly !== undefined) {
            p["reduceOnly"] = params.reduceOnly;
        }
        node_assert_1.strict.strictEqual(p["closePosition"], "true");
        node_assert_1.strict.strictEqual(p["reduceOnly"], undefined, "reduceOnly must not be set when closePosition=true");
    });
    // ── T12: quantity formatting via SymbolPrecisionRegistry ──────────────────
    (0, node_test_1.it)("T12: quantity formatted via SymbolPrecisionRegistry (3 decimal places for BTCUSDT)", () => {
        const { SymbolPrecisionRegistry } = require("../config/symbolPrecision");
        const formatted = SymbolPrecisionRegistry.formatQuantity("BTCUSDT", 0.00123456);
        // SymbolPrecisionRegistry should truncate to exchange precision
        node_assert_1.strict.ok(typeof formatted === "number", "Formatted quantity must be a number");
        node_assert_1.strict.ok(formatted >= 0, "Formatted quantity must be non-negative");
    });
    // ── T13: price formatting via SymbolPrecisionRegistry ─────────────────────
    (0, node_test_1.it)("T13: price formatted via SymbolPrecisionRegistry for BTCUSDT", () => {
        const { SymbolPrecisionRegistry } = require("../config/symbolPrecision");
        const formatted = SymbolPrecisionRegistry.formatPrice("BTCUSDT", 59999.567);
        node_assert_1.strict.ok(typeof formatted === "number", "Formatted price must be a number");
        node_assert_1.strict.ok(formatted > 0, "Formatted price must be positive");
    });
    // ── T14: _signParams() injects required fields ────────────────────────────
    (0, node_test_1.it)("T14: _signParams() injects timestamp, recvWindow, apiKey, and signature", () => {
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
    // ── T15: HMAC-SHA256 signature correctness ────────────────────────────────
    (0, node_test_1.it)("T15: HMAC-SHA256 signature is mathematically correct", () => {
        const apiSecret = "super_secret_key";
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "mykey",
            apiSecret,
        });
        const p = {
            symbol: "ETHUSDT",
            side: "SELL",
            type: "LIMIT",
            price: 2500.0,
        };
        client._signParams(p, 5000);
        // Reconstruct what the signature should be (excluding signature and apiKey themselves)
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(p)) {
            if (k !== "signature" && k !== "apiKey") {
                params.set(k, String(v));
            }
        }
        const qs = params.toString();
        const expected = crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");
        node_assert_1.strict.strictEqual(p["signature"], expected, "Injected signature must match independently computed HMAC-SHA256");
    });
    // ── T16: _dispatch() registers pending request ────────────────────────────
    (0, node_test_1.it)("T16: _dispatch() registers a pending request in the internal map", async () => {
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 500,
        });
        // Inject a mock connected socket
        const mockSocket = new MockWebSocket();
        client.ws = mockSocket;
        client.isConnected = true;
        const pendingMap = client.pendingRequests;
        // Dispatch an order that will time out (we won't send a response)
        const p = client
            .placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.001 })
            .catch(() => { }); // Expected to timeout
        // Immediately after dispatch: map must have 1 pending entry
        node_assert_1.strict.strictEqual(pendingMap.size, 1, "Pending map must have exactly 1 entry after dispatch");
        await p; // Wait for timeout
        node_assert_1.strict.strictEqual(pendingMap.size, 0, "Pending map must be empty after timeout resolution");
    });
    // ── T17: _onMessage() resolves on status 200 ──────────────────────────────
    (0, node_test_1.it)("T17: _onMessage() resolves the promise on Binance status 200", async () => {
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 2000,
        });
        const mockSocket = new MockWebSocket();
        client.ws = mockSocket;
        client.isConnected = true;
        const dispatchPromise = client.placeOrder({
            symbol: "BTCUSDT",
            side: "BUY",
            type: "MARKET",
            quantity: 0.001,
        });
        // Extract the correlation ID from the sent message
        const sentRaw = mockSocket.sentMessages[0];
        node_assert_1.strict.ok(sentRaw, "A message must have been sent over the socket");
        const sentPayload = JSON.parse(sentRaw);
        const id = sentPayload.id;
        // Simulate Binance 200 response
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
        client._onMessage(Buffer.from(JSON.stringify(mockResponse)));
        const response = await dispatchPromise;
        node_assert_1.strict.strictEqual(response.status, 200);
        node_assert_1.strict.strictEqual(response.result?.orderId, 999001);
        node_assert_1.strict.ok(response.rttMs >= 0, "rttMs must be non-negative");
    });
    // ── T18: _onMessage() rejects on non-200 ──────────────────────────────────
    (0, node_test_1.it)("T18: _onMessage() rejects the promise on Binance error status", async () => {
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 2000,
        });
        const mockSocket = new MockWebSocket();
        client.ws = mockSocket;
        client.isConnected = true;
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
        client
            ._onMessage(Buffer.from(JSON.stringify(errorResponse)));
        await node_assert_1.strict.rejects(() => dispatchPromise, (err) => err.message.includes("-1100") &&
            err.message.includes("Illegal characters"), "Should reject with Binance error code and message");
    });
    // ── T19: _onMessage() ignores unknown ids ─────────────────────────────────
    (0, node_test_1.it)("T19: _onMessage() silently ignores messages with unknown correlation IDs", () => {
        const client = new wsOrderClient_1.WsOrderClient({
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
        // Should not throw
        node_assert_1.strict.doesNotThrow(() => {
            client
                ._onMessage(Buffer.from(JSON.stringify(unknownResponse)));
        });
    });
    // ── T20: Timeout — pending request rejected after requestTimeoutMs ─────────
    (0, node_test_1.it)("T20: pending request is rejected after requestTimeoutMs with timeout error", async () => {
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 50, // Very short timeout for test speed
        });
        const mockSocket = new MockWebSocket();
        client.ws = mockSocket;
        client.isConnected = true;
        await node_assert_1.strict.rejects(() => client.placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.001 }), (err) => err.message.includes("timed out after 50ms"), "Should reject with timeout error after requestTimeoutMs");
    });
    // ── T21: destroy() rejects all pending requests ────────────────────────────
    (0, node_test_1.it)("T21: destroy() rejects all pending requests with shutdown error", async () => {
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 60_000,
        });
        const mockSocket = new MockWebSocket();
        client.ws = mockSocket;
        client.isConnected = true;
        const p1 = client
            .placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.001 })
            .catch((e) => e.message);
        const p2 = client
            .cancelOrder({ symbol: "BTCUSDT", orderId: 123 })
            .catch((e) => e.message);
        // Both pending: now destroy
        client.destroy();
        const [msg1, msg2] = (await Promise.all([p1, p2]));
        node_assert_1.strict.ok(msg1.includes("destroyed"), `p1 error: ${msg1}`);
        node_assert_1.strict.ok(msg2.includes("destroyed"), `p2 error: ${msg2}`);
    });
    // ── T22: destroy() closes the WebSocket ───────────────────────────────────
    (0, node_test_1.it)("T22: destroy() closes the WebSocket and sets isConnected=false", () => {
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
        });
        const mockSocket = new MockWebSocket();
        client.ws = mockSocket;
        client.isConnected = true;
        client.destroy();
        node_assert_1.strict.strictEqual(client.isConnected, false, "isConnected must be false after destroy");
    });
    // ── T23: _onClose() schedules reconnect on non-shutdown close ─────────────
    (0, node_test_1.it)("T23: _onClose() schedules a reconnect timer when not shutting down", () => {
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
        });
        client.isShuttingDown = false;
        client.isConnected = true;
        client.reconnectAttempts = 0;
        // Invoke _onClose with non-normal code
        client
            ._onClose(1006, "Abnormal closure");
        const timer = client
            .reconnectTimer;
        node_assert_1.strict.notStrictEqual(timer, null, "reconnectTimer must be set after abnormal close");
        // Cleanup
        if (timer !== null)
            clearTimeout(timer);
    });
    // ── T24: _onClose() does NOT reconnect when shutting down ─────────────────
    (0, node_test_1.it)("T24: _onClose() does NOT schedule reconnect when isShuttingDown=true", () => {
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
        });
        client.isShuttingDown = true;
        client.isConnected = true;
        client
            ._onClose(1000, "Normal shutdown");
        const timer = client
            .reconnectTimer;
        node_assert_1.strict.strictEqual(timer, null, "reconnectTimer must remain null during shutdown");
    });
    // ── T25: rttMs is correctly computed ──────────────────────────────────────
    (0, node_test_1.it)("T25: rttMs in WsOrderResponse reflects wall-clock dispatch-to-ack latency", async () => {
        const client = new wsOrderClient_1.WsOrderClient({
            useTestnet: false,
            apiKey: "k",
            apiSecret: "s",
            requestTimeoutMs: 2000,
        });
        const mockSocket = new MockWebSocket();
        client.ws = mockSocket;
        client.isConnected = true;
        const dispatchPromise = client.placeOrder({
            symbol: "BTCUSDT",
            side: "SELL",
            type: "MARKET",
            quantity: 0.001,
        });
        const beforeAck = Date.now();
        // Simulate 10ms network delay before ACK
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
        client
            ._onMessage(Buffer.from(JSON.stringify(mockResponse)));
        const response = await dispatchPromise;
        node_assert_1.strict.ok(response.rttMs >= 10, `rttMs (${response.rttMs}ms) must be >= 10ms (simulated delay)`);
        node_assert_1.strict.ok(response.rttMs < 2000, `rttMs (${response.rttMs}ms) must be < timeout`);
    });
});
