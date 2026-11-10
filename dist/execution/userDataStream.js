"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BinanceUserDataStream = void 0;
require("dotenv/config");
const ws_1 = __importDefault(require("ws"));
function rawDataToString(data) {
    if (Buffer.isBuffer(data)) {
        return data.toString("utf8");
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString("utf8");
    }
    return Buffer.from(data).toString("utf8");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(obj, key, fallback) {
    const value = obj[key];
    return typeof value === "string" ? value : fallback;
}
function readNumber(obj, key, fallback) {
    const value = obj[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function parseFloatField(obj, key) {
    const value = obj[key];
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === "string" && value.length > 0) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}
function parseOrderSide(value) {
    return value === "SELL" ? "SELL" : "BUY";
}
function parseOrderStatus(value) {
    switch (value) {
        case "PARTIALLY_FILLED":
        case "FILLED":
        case "CANCELED":
        case "EXPIRED":
            return value;
        default:
            return "NEW";
    }
}
function parsePositionSide(value) {
    if (value === "LONG" || value === "SHORT") {
        return value;
    }
    return "BOTH";
}
function toRawPositionPayload(item) {
    return {
        s: readString(item, "s", ""),
        pa: readString(item, "pa", "0"),
        ep: readString(item, "ep", "0"),
        cr: readString(item, "cr", "0"),
        up: readString(item, "up", "0"),
        ps: parsePositionSide(item["ps"]),
    };
}
function toRawBalancePayload(item) {
    return {
        a: readString(item, "a", ""),
        wb: readString(item, "wb", "0"),
        cw: readString(item, "cw", "0"),
        bc: readString(item, "bc", "0"),
    };
}
class BinanceUserDataStream {
    client;
    ws = null;
    listenKey = "";
    keepAliveTimer = null;
    reconnectTimer = null;
    isConnected = false;
    isDisposed = false;
    reconnectAttempts = 0;
    orderCallbacks = new Set();
    accountCallbacks = new Set();
    keepAliveIntervalMs;
    maxReconnectRetries;
    constructor(client) {
        this.client = client;
        const parsedKeepAlive = parseInt(process.env.WEBSOCKET_KEEP_ALIVE_INTERVAL_MS || "1800000", 10);
        this.keepAliveIntervalMs = Number.isFinite(parsedKeepAlive) && parsedKeepAlive > 0 ? parsedKeepAlive : 1800000;
        const parsedRetries = parseInt(process.env.WEBSOCKET_RECONNECT_MAX_RETRIES || "10", 10);
        this.maxReconnectRetries = Number.isFinite(parsedRetries) && parsedRetries > 0 ? parsedRetries : 10;
    }
    subscribeOrderUpdates(callback) {
        this.orderCallbacks.add(callback);
        return () => {
            this.orderCallbacks.delete(callback);
        };
    }
    subscribeAccountUpdates(callback) {
        this.accountCallbacks.add(callback);
        return () => {
            this.accountCallbacks.delete(callback);
        };
    }
    isStreamConnected() {
        return this.isConnected && !this.isDisposed;
    }
    async start() {
        if (!this.client.isConfigured()) {
            console.warn(`[BinanceUserDataStream] Execution client is not configured. User Data Stream disabled.`);
            return false;
        }
        this.isDisposed = false;
        try {
            this.listenKey = await this.client.createListenKey();
            console.log(`[BinanceUserDataStream] Created centralized listenKey: ${this.listenKey.substring(0, 8)}...`);
            const wsBase = this.client.getWsUrl();
            const wsUrl = `${wsBase}/ws/${this.listenKey}`;
            this.connectWebSocket(wsUrl);
            this.startKeepAliveTimer();
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[BinanceUserDataStream] Failed to start User Data Stream: ${msg}`);
            return false;
        }
    }
    connectWebSocket(url) {
        if (this.isDisposed)
            return;
        try {
            this.ws = new ws_1.default(url);
            this.ws.on("open", () => {
                if (this.isDisposed) {
                    this.ws?.close();
                    return;
                }
                this.isConnected = true;
                this.reconnectAttempts = 0;
                console.log(`[BinanceUserDataStream] Centralized account WebSocket connection established successfully.`);
            });
            this.ws.on("message", (data) => {
                if (this.isDisposed)
                    return;
                try {
                    const payload = JSON.parse(rawDataToString(data));
                    if (!isRecord(payload))
                        return;
                    const eventType = readString(payload, "e", "");
                    if (eventType === "ORDER_TRADE_UPDATE" && isRecord(payload["o"])) {
                        const ord = payload["o"];
                        const parsedUpdate = {
                            eventType,
                            eventTime: readNumber(payload, "E", 0),
                            transactionTime: readNumber(payload, "T", 0),
                            order: {
                                symbol: readString(ord, "s", ""),
                                clientOrderId: readString(ord, "c", ""),
                                side: parseOrderSide(ord["S"]),
                                orderType: readString(ord, "o", ""),
                                timeInForce: readString(ord, "f", ""),
                                originalQuantity: parseFloatField(ord, "q"),
                                originalPrice: parseFloatField(ord, "p"),
                                averagePrice: parseFloatField(ord, "ap"),
                                stopPrice: parseFloatField(ord, "sp"),
                                executionType: readString(ord, "x", ""),
                                orderStatus: parseOrderStatus(ord["X"]),
                                orderId: readNumber(ord, "i", 0),
                                lastFilledQuantity: parseFloatField(ord, "l"),
                                cumulativeFilledQuantity: parseFloatField(ord, "z"),
                                lastFilledPrice: parseFloatField(ord, "L"),
                                commissionAsset: readString(ord, "N", ""),
                                commissionAmount: parseFloatField(ord, "n"),
                                tradeTime: readNumber(ord, "T", 0),
                                tradeId: readNumber(ord, "t", 0),
                                bidsNotional: parseFloatField(ord, "b"),
                                isMaker: ord["m"] === true,
                                positionSide: parsePositionSide(ord["ps"]),
                                realizedPnl: parseFloatField(ord, "rp"),
                                reduceOnly: ord["R"] === true,
                            },
                        };
                        for (const cb of this.orderCallbacks) {
                            try {
                                cb(parsedUpdate);
                            }
                            catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                console.error(`[BinanceUserDataStream] Error in order callback handler: ${msg}`);
                            }
                        }
                    }
                    else if (eventType === "ACCOUNT_UPDATE" && isRecord(payload["a"])) {
                        const acct = payload["a"];
                        const rawPositions = Array.isArray(acct["P"])
                            ? acct["P"].filter(isRecord).map(toRawPositionPayload)
                            : [];
                        const positions = rawPositions.map((p) => {
                            const amt = parseFloat(p.pa);
                            const ep = parseFloat(p.ep);
                            const cr = parseFloat(p.cr);
                            const up = parseFloat(p.up);
                            return {
                                symbol: p.s,
                                positionAmt: Number.isFinite(amt) ? amt : 0,
                                entryPrice: Number.isFinite(ep) ? ep : 0,
                                accumulatedRealized: Number.isFinite(cr) ? cr : 0,
                                unrealizedPnl: Number.isFinite(up) ? up : 0,
                                positionSide: p.ps ?? "BOTH",
                            };
                        });
                        const rawBalances = Array.isArray(acct["B"])
                            ? acct["B"].filter(isRecord).map(toRawBalancePayload)
                            : [];
                        const balances = rawBalances.map((b) => {
                            const wb = parseFloat(b.wb);
                            const cw = parseFloat(b.cw);
                            const bc = parseFloat(b.bc);
                            return {
                                asset: b.a,
                                walletBalance: Number.isFinite(wb) ? wb : 0,
                                crossWalletBalance: Number.isFinite(cw) ? cw : 0,
                                balanceChange: Number.isFinite(bc) ? bc : 0,
                            };
                        });
                        // CRITICAL FIX: The Binance ACCOUNT_UPDATE WebSocket event (payload.a.B) carries ONLY
                        // `wb` (walletBalance) and `cw` (crossWalletBalance). It does NOT emit a true
                        // `availableBalance` field. crossWalletBalance != availableBalance — it does not
                        // account for open-order margin reservations. Using it as available balance causes
                        // a systematic overstatement (wallet > available whenever orders are open).
                        //
                        // Correct strategy:
                        //   1. Update the cached walletBalance from `wb` for bookkeeping.
                        //   2. Schedule a single debounced REST call to GET /fapi/v2/balance which is the
                        //      authoritative source of `availableBalance` — updated by Binance after each
                        //      account state mutation (trade fill, fee deduction, margin change).
                        const usdtItem = balances.find((b) => b.asset === "USDT");
                        if (usdtItem && Number.isFinite(usdtItem.walletBalance)) {
                            this.client.updateWalletBalanceFromWs(usdtItem.walletBalance);
                        }
                        // Trigger an async REST fetch for the authoritative availableBalance.
                        this.client.scheduleAvailableBalanceRefetch();
                        const rawReason = readString(acct, "m", "");
                        const accountUpdate = {
                            eventType,
                            eventTime: readNumber(payload, "E", 0),
                            transactionTime: readNumber(payload, "T", 0),
                            reasonType: rawReason.length > 0 ? rawReason : "ORDER",
                            positions,
                            balances,
                        };
                        for (const cb of this.accountCallbacks) {
                            try {
                                cb(accountUpdate);
                            }
                            catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                console.error(`[BinanceUserDataStream] Error in account callback handler: ${msg}`);
                            }
                        }
                    }
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[BinanceUserDataStream] Failed to parse WebSocket message: ${msg}`);
                }
            });
            this.ws.on("error", (err) => {
                if (this.isDisposed)
                    return;
                console.error(`[BinanceUserDataStream] WebSocket Error: ${err.message}`);
            });
            this.ws.on("close", (code, reason) => {
                this.isConnected = false;
                if (this.isDisposed)
                    return;
                const reasonStr = reason ? reason.toString("utf8") : "";
                console.warn(`[BinanceUserDataStream] WebSocket closed [Code: ${String(code)}, Reason: ${reasonStr}]`);
                this.handleReconnect();
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[BinanceUserDataStream] Failed to initiate WebSocket: ${msg}`);
        }
    }
    async reconnectWithFreshListenKey() {
        if (this.isDisposed)
            return;
        try {
            this.listenKey = await this.client.createListenKey();
            const wsBase = this.client.getWsUrl();
            const wsUrl = `${wsBase}/ws/${this.listenKey}`;
            this.connectWebSocket(wsUrl);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[BinanceUserDataStream] Failed to renew listenKey on reconnect: ${msg}`);
            this.handleReconnect();
        }
    }
    async sendKeepAlivePing() {
        if (this.isDisposed)
            return;
        try {
            if (this.listenKey) {
                await this.client.keepAliveListenKey();
                console.log(`[BinanceUserDataStream] Sent listenKey keep-alive ping.`);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[BinanceUserDataStream] Keep-alive ping failed: ${msg}`);
        }
    }
    handleReconnect() {
        if (this.isDisposed)
            return;
        if (this.reconnectAttempts >= this.maxReconnectRetries) {
            console.error(`[BinanceUserDataStream] Exceeded max reconnect attempts (${String(this.maxReconnectRetries)}). User Data Stream halted.`);
            return;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts++;
        const backoffMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        console.log(`[BinanceUserDataStream] Reconnecting in ${String(backoffMs)}ms (Attempt ${String(this.reconnectAttempts)}/${String(this.maxReconnectRetries)})...`);
        this.reconnectTimer = setTimeout(() => {
            void this.reconnectWithFreshListenKey();
        }, backoffMs);
    }
    startKeepAliveTimer() {
        if (this.keepAliveTimer)
            clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = setInterval(() => {
            void this.sendKeepAlivePing();
        }, this.keepAliveIntervalMs);
    }
    stop() {
        this.isDisposed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        this.orderCallbacks.clear();
        this.accountCallbacks.clear();
        console.log(`[BinanceUserDataStream] User Data Stream stopped.`);
    }
}
exports.BinanceUserDataStream = BinanceUserDataStream;
