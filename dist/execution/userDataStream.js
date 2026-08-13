"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BinanceUserDataStream = void 0;
require("dotenv/config");
const ws_1 = __importDefault(require("ws"));
class BinanceUserDataStream {
    client;
    ws = null;
    listenKey = "";
    keepAliveTimer = null;
    isConnected = false;
    reconnectAttempts = 0;
    orderCallbacks = new Set();
    accountCallbacks = new Set();
    keepAliveIntervalMs;
    maxReconnectRetries;
    constructor(client) {
        this.client = client;
        this.keepAliveIntervalMs = parseInt(process.env.WEBSOCKET_KEEP_ALIVE_INTERVAL_MS || "1800000", 10);
        this.maxReconnectRetries = parseInt(process.env.WEBSOCKET_RECONNECT_MAX_RETRIES || "10", 10);
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
        return this.isConnected;
    }
    async start() {
        if (!this.client.isConfigured()) {
            console.warn(`[BinanceUserDataStream] Execution client is not configured. User Data Stream disabled.`);
            return false;
        }
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
            console.error(`[BinanceUserDataStream] Failed to start User Data Stream: ${err.message}`);
            return false;
        }
    }
    connectWebSocket(url) {
        try {
            this.ws = new ws_1.default(url);
            this.ws.on("open", () => {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                console.log(`[BinanceUserDataStream] Centralized account WebSocket connection established successfully.`);
            });
            this.ws.on("message", (data) => {
                try {
                    const payload = JSON.parse(data.toString());
                    if (!payload)
                        return;
                    if (payload.e === "ORDER_TRADE_UPDATE" && payload.o) {
                        const parsedUpdate = {
                            eventType: payload.e,
                            eventTime: payload.E,
                            transactionTime: payload.T,
                            order: {
                                symbol: payload.o.s,
                                clientOrderId: payload.o.c,
                                side: payload.o.S,
                                orderType: payload.o.o,
                                timeInForce: payload.o.f,
                                originalQuantity: parseFloat(payload.o.q || "0"),
                                originalPrice: parseFloat(payload.o.p || "0"),
                                averagePrice: parseFloat(payload.o.ap || "0"),
                                stopPrice: parseFloat(payload.o.sp || "0"),
                                executionType: payload.o.x,
                                orderStatus: payload.o.X,
                                orderId: payload.o.i,
                                lastFilledQuantity: parseFloat(payload.o.l || "0"),
                                cumulativeFilledQuantity: parseFloat(payload.o.z || "0"),
                                lastFilledPrice: parseFloat(payload.o.L || "0"),
                                commissionAsset: payload.o.N || "",
                                commissionAmount: parseFloat(payload.o.n || "0"),
                                tradeTime: payload.o.T,
                                tradeId: payload.o.t,
                                bidsNotional: parseFloat(payload.o.b || "0"),
                                isMaker: payload.o.m === true,
                                positionSide: payload.o.ps || "BOTH",
                                realizedPnl: parseFloat(payload.o.rp || "0"),
                            },
                        };
                        for (const cb of this.orderCallbacks) {
                            try {
                                cb(parsedUpdate);
                            }
                            catch (err) {
                                console.error(`[BinanceUserDataStream] Error in order callback handler: ${err.message}`);
                            }
                        }
                    }
                    else if (payload.e === "ACCOUNT_UPDATE" && payload.a) {
                        const rawPositions = Array.isArray(payload.a.P) ? payload.a.P : [];
                        const positions = rawPositions.map((p) => ({
                            symbol: p.s,
                            positionAmt: parseFloat(p.pa || "0"),
                            entryPrice: parseFloat(p.ep || "0"),
                            accumulatedRealized: parseFloat(p.cr || "0"),
                            unrealizedPnl: parseFloat(p.up || "0"),
                            positionSide: p.ps || "BOTH",
                        }));
                        const accountUpdate = {
                            eventType: payload.e,
                            eventTime: payload.E,
                            transactionTime: payload.T,
                            reasonType: payload.a.m || "ORDER",
                            positions,
                        };
                        for (const cb of this.accountCallbacks) {
                            try {
                                cb(accountUpdate);
                            }
                            catch (err) {
                                console.error(`[BinanceUserDataStream] Error in account callback handler: ${err.message}`);
                            }
                        }
                    }
                }
                catch (err) {
                    console.error(`[BinanceUserDataStream] Failed to parse WebSocket message: ${err.message}`);
                }
            });
            this.ws.on("error", (err) => {
                console.error(`[BinanceUserDataStream] WebSocket Error: ${err.message}`);
            });
            this.ws.on("close", (code, reason) => {
                this.isConnected = false;
                console.warn(`[BinanceUserDataStream] WebSocket closed [Code: ${code}, Reason: ${reason.toString()}]`);
                this.handleReconnect(url);
            });
        }
        catch (err) {
            console.error(`[BinanceUserDataStream] Failed to initiate WebSocket: ${err.message}`);
        }
    }
    handleReconnect(url) {
        if (this.reconnectAttempts >= this.maxReconnectRetries) {
            console.error(`[BinanceUserDataStream] Exceeded max reconnect attempts (${this.maxReconnectRetries}). User Data Stream halted.`);
            return;
        }
        this.reconnectAttempts++;
        const backoffMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        console.log(`[BinanceUserDataStream] Reconnecting in ${backoffMs}ms (Attempt ${this.reconnectAttempts}/${this.maxReconnectRetries})...`);
        setTimeout(() => {
            this.connectWebSocket(url);
        }, backoffMs);
    }
    startKeepAliveTimer() {
        if (this.keepAliveTimer)
            clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = setInterval(async () => {
            try {
                if (this.listenKey) {
                    await this.client.keepAliveListenKey();
                    console.log(`[BinanceUserDataStream] Sent listenKey keep-alive ping.`);
                }
            }
            catch (err) {
                console.error(`[BinanceUserDataStream] Keep-alive ping failed: ${err.message}`);
            }
        }, this.keepAliveIntervalMs);
    }
    stop() {
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
        console.log(`[BinanceUserDataStream] User Data Stream stopped.`);
    }
}
exports.BinanceUserDataStream = BinanceUserDataStream;
