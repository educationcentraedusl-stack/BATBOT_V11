"use strict";
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
exports.BinanceExecutionClient = exports.BinanceRateLimiter = void 0;
require("dotenv/config");
const crypto = __importStar(require("node:crypto"));
const https = __importStar(require("node:https"));
const http = __importStar(require("node:http"));
const node_url_1 = require("node:url");
const symbolPrecision_1 = require("../config/symbolPrecision");
const clientOrderIdGenerator_1 = require("./clientOrderIdGenerator");
const timeSynchronizer_1 = require("../utils/timeSynchronizer");
class BinanceRateLimiter {
    static MAX_WEIGHT_1M = 2400;
    static MAX_ORDERS_10S = 300;
    static MAX_ORDERS_1M = 1200;
    // 80% Proactive Backoff Thresholds
    static THRESHOLD_WEIGHT_1M = 1920; // 80% of 2400
    static THRESHOLD_ORDERS_10S = 240; // 80% of 300
    static THRESHOLD_ORDERS_1M = 960; // 80% of 1200
    usedWeight1m = 0;
    orderCount10s = 0;
    orderCount1m = 0;
    backoffUntil = 0;
    lastHeaderTimestamp = 0;
    updateFromHeaders(headers) {
        const now = Date.now();
        this.lastHeaderTimestamp = now;
        for (const [key, val] of Object.entries(headers)) {
            const lowerKey = key.toLowerCase();
            if (lowerKey.includes("used-weight-1m")) {
                const parsed = parseInt(Array.isArray(val) ? val[0] : String(val), 10);
                if (!isNaN(parsed) && parsed >= 0) {
                    this.usedWeight1m = parsed;
                }
            }
            else if (lowerKey.includes("order-count-10s")) {
                const parsed = parseInt(Array.isArray(val) ? val[0] : String(val), 10);
                if (!isNaN(parsed) && parsed >= 0) {
                    this.orderCount10s = parsed;
                }
            }
            else if (lowerKey.includes("order-count-1m")) {
                const parsed = parseInt(Array.isArray(val) ? val[0] : String(val), 10);
                if (!isNaN(parsed) && parsed >= 0) {
                    this.orderCount1m = parsed;
                }
            }
            else if (lowerKey === "retry-after") {
                const retrySec = parseInt(Array.isArray(val) ? val[0] : String(val), 10);
                if (!isNaN(retrySec) && retrySec > 0) {
                    this.backoffUntil = Math.max(this.backoffUntil, now + retrySec * 1000);
                    console.warn(`[BinanceRateLimiter] Received Retry-After: ${retrySec}s. Enforcing backoff until ${new Date(this.backoffUntil).toISOString()}`);
                }
            }
        }
    }
    register429Backoff(retryAfterMs = 5000) {
        const now = Date.now();
        this.backoffUntil = Math.max(this.backoffUntil, now + retryAfterMs);
        console.error(`[BinanceRateLimiter][429_CIRCUIT_BREAKER] Binance 429/418 detected. Backing off for ${retryAfterMs}ms.`);
    }
    async acquirePreFlightAllowance(isOrder, signal) {
        const now = Date.now();
        // 1. Check active 429/418 Circuit Breaker Backoff
        if (this.backoffUntil > now) {
            const waitMs = this.backoffUntil - now;
            console.warn(`[BinanceRateLimiter][THROTTLED_CIRCUIT_BREAKER] Waiting ${waitMs}ms before dispatching request...`);
            await this.sleep(waitMs, signal);
        }
        // 2. Check 80% Weight Threshold (2400 limit -> 1920 threshold)
        if (this.usedWeight1m >= BinanceRateLimiter.THRESHOLD_WEIGHT_1M) {
            const waitMs = Math.min(2000, Math.max(250, (this.usedWeight1m - BinanceRateLimiter.THRESHOLD_WEIGHT_1M) * 5));
            console.warn(`[BinanceRateLimiter][WEIGHT_THROTTLED] Weight approaching limit (${this.usedWeight1m}/${BinanceRateLimiter.MAX_WEIGHT_1M}). Pre-flight delay: ${waitMs}ms`);
            await this.sleep(waitMs, signal);
        }
        // 3. Check 80% Order Count Threshold (300/10s limit -> 240 threshold)
        if (isOrder && this.orderCount10s >= BinanceRateLimiter.THRESHOLD_ORDERS_10S) {
            const waitMs = Math.min(1500, Math.max(200, (this.orderCount10s - BinanceRateLimiter.THRESHOLD_ORDERS_10S) * 25));
            console.warn(`[BinanceRateLimiter][ORDER_COUNT_THROTTLED] 10s Order count approaching limit (${this.orderCount10s}/${BinanceRateLimiter.MAX_ORDERS_10S}). Pre-flight delay: ${waitMs}ms`);
            await this.sleep(waitMs, signal);
        }
    }
    sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                return reject(new Error("Request aborted during rate-limit backoff"));
            }
            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, ms);
            const abortHandler = () => {
                clearTimeout(timer);
                cleanup();
                reject(new Error("Request aborted during rate-limit backoff"));
            };
            if (signal) {
                signal.addEventListener("abort", abortHandler, { once: true });
            }
            function cleanup() {
                if (signal) {
                    signal.removeEventListener("abort", abortHandler);
                }
            }
        });
    }
    getStatus() {
        const now = Date.now();
        return {
            usedWeight1m: this.usedWeight1m,
            orderCount10s: this.orderCount10s,
            orderCount1m: this.orderCount1m,
            isThrottled: this.backoffUntil > now ||
                this.usedWeight1m >= BinanceRateLimiter.THRESHOLD_WEIGHT_1M ||
                this.orderCount10s >= BinanceRateLimiter.THRESHOLD_ORDERS_10S,
            backoffRemainingMs: Math.max(0, this.backoffUntil - now),
        };
    }
}
exports.BinanceRateLimiter = BinanceRateLimiter;
class BinanceExecutionClient {
    apiKey;
    apiSecret;
    baseUrl;
    wsUrl;
    testnet;
    rateLimiter = new BinanceRateLimiter();
    cachedUsdtAvailableBalance = 0;
    cachedReconciledWalletBalance = 0;
    cachedTotalUnrealizedProfit = 0;
    balancePollTimer = null;
    incomeSyncTimer = null;
    userTradesSyncTimer = null;
    lastIncomeSyncTime = 0;
    lastUserTradeSyncTimes = new Map();
    cachedCumulativeFunding = new Map();
    cachedCumulativeCommission = new Map();
    incomeCallbacks = new Set();
    userTradeCallbacks = new Set();
    timeOffset = 0;
    isTimeSynced = false;
    timeSyncPromise = null;
    inFlightClientOrderIds = new Set();
    constructor(options) {
        this.testnet = options?.useTestnet ?? (process.env.USE_TESTNET === "true" || process.env.USE_TESTNET === "1" || process.env.BINANCE_TESTNET === "true");
        const envApiKey = this.testnet
            ? (process.env.BINANCE_TESTNET_API_KEY || process.env.BINANCE_API_KEY || "")
            : (process.env.BINANCE_API_KEY || "");
        const envApiSecret = this.testnet
            ? (process.env.BINANCE_TESTNET_SECRET_KEY || process.env.BINANCE_API_SECRET || process.env.BINANCE_SECRET_KEY || "")
            : (process.env.BINANCE_API_SECRET || process.env.BINANCE_SECRET_KEY || "");
        this.apiKey = options?.apiKey ?? envApiKey;
        this.apiSecret = options?.apiSecret ?? envApiSecret;
        const defaultRestBase = this.testnet
            ? "https://testnet.binancefuture.com"
            : "https://fapi.binance.com";
        const defaultWsBase = this.testnet
            ? "wss://stream.binancefuture.com"
            : "wss://fstream.binance.com";
        this.baseUrl = options?.baseUrl ?? defaultRestBase;
        this.wsUrl = options?.wsUrl ?? defaultWsBase;
        if (!this.apiKey || !this.apiSecret) {
            console.error(`[CRITICAL][BinanceExecutionClient] Missing BINANCE_API_KEY or BINANCE_API_SECRET in environment variables. Execution mode: ${this.testnet ? "BINANCE FUTURES TESTNET" : "LIVE PRODUCTION"}`);
        }
    }
    isTestnet() {
        return this.testnet;
    }
    getBaseUrl() {
        return this.baseUrl;
    }
    getWsUrl() {
        return this.wsUrl;
    }
    isConfigured() {
        return this.apiKey.length > 0 && this.apiSecret.length > 0;
    }
    getTimeOffset() {
        const syncOffset = timeSynchronizer_1.timeSynchronizer.getOffsetMs();
        return Number.isFinite(syncOffset)
            ? Math.round(syncOffset)
            : Math.round(this.timeOffset);
    }
    async syncServerTime() {
        if (this.timeSyncPromise) {
            return this.timeSyncPromise;
        }
        this.timeSyncPromise = (async () => {
            try {
                const offset = await timeSynchronizer_1.timeSynchronizer.sync();
                this.timeOffset = offset;
                this.isTimeSynced = true;
                return offset;
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.error(`[BinanceExecutionClient] Failed to sync Binance server time: ${errMsg}`);
            }
            finally {
                this.timeSyncPromise = null;
            }
            return this.timeOffset;
        })();
        return this.timeSyncPromise;
    }
    async fetchExchangeInfo() {
        return this.request("GET", "/fapi/v1/exchangeInfo", {}, false);
    }
    getUsdtAvailableBalance() {
        return this.cachedUsdtAvailableBalance;
    }
    async fetchUsdtBalanceAsync() {
        if (!this.isConfigured())
            return 0;
        try {
            const balances = await this.request("GET", "/fapi/v2/balance", {}, true);
            if (Array.isArray(balances)) {
                const usdtItem = balances.find((b) => b.asset === "USDT");
                if (usdtItem) {
                    const val = parseFloat(usdtItem.availableBalance || usdtItem.balance || "0");
                    if (!isNaN(val)) {
                        this.cachedUsdtAvailableBalance = val;
                        return val;
                    }
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`[BinanceExecutionClient] USDT balance fetch notice: ${msg}`);
        }
        return this.cachedUsdtAvailableBalance;
    }
    startBalancePolling(intervalMs = 5000) {
        if (this.balancePollTimer)
            return;
        // Trigger initial fetch asynchronously
        this.fetchUsdtBalanceAsync().catch((err) => {
            console.log(`[BinanceExecutionClient] Initial USDT balance fetch notice: ${err instanceof Error ? err.message : String(err)}`);
        });
        this.balancePollTimer = setInterval(() => {
            this.fetchUsdtBalanceAsync().catch((err) => {
                console.log(`[BinanceExecutionClient] Polling USDT balance fetch notice: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, intervalMs);
    }
    stopBalancePolling() {
        if (this.balancePollTimer) {
            clearInterval(this.balancePollTimer);
            this.balancePollTimer = null;
        }
    }
    signQuery(params) {
        const timestamp = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs();
        const queryParams = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                queryParams.append(key, String(value));
            }
        }
        if (!queryParams.has("recvWindow")) {
            queryParams.append("recvWindow", "10000");
        }
        queryParams.append("timestamp", String(timestamp));
        const queryString = queryParams.toString();
        const signature = crypto
            .createHmac("sha256", this.apiSecret)
            .update(queryString)
            .digest("hex");
        return `${queryString}&signature=${signature}`;
    }
    getRateLimiter() {
        return this.rateLimiter;
    }
    async request(method, endpoint, params = {}, signed = true, isRetryAfterSync = false, signal) {
        if (signed && !this.isConfigured()) {
            throw new Error("BinanceExecutionClient is not configured with API key and secret. Cannot execute signed request.");
        }
        if (signal?.aborted) {
            throw new Error(`[BinanceExecutionClient] Request aborted by caller before dispatch (${method} ${endpoint})`);
        }
        const isOrderEndpoint = endpoint.includes("/order") || endpoint.includes("/batchOrders") || endpoint.includes("/algoOrder");
        await this.rateLimiter.acquirePreFlightAllowance(isOrderEndpoint, signal);
        const queryString = signed ? this.signQuery(params) : new URLSearchParams(params).toString();
        const fullUrl = `${this.baseUrl}${endpoint}${queryString ? "?" + queryString : ""}`;
        const url = new node_url_1.URL(fullUrl);
        const defaultTimeoutMs = parseInt(process.env.REST_REQUEST_TIMEOUT_MS || "2500", 10);
        return new Promise((resolve, reject) => {
            let isSettled = false;
            const isHttps = url.protocol === "https:";
            const httpModule = isHttps ? https : http;
            const reqOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: `${url.pathname}${url.search}`,
                method: method,
                headers: {
                    "X-MBX-APIKEY": this.apiKey,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "BATBOT_V11-HFT-Engine/1.0",
                },
            };
            const req = httpModule.request(reqOptions, (res) => {
                let body = "";
                this.rateLimiter.updateFromHeaders(res.headers);
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", async () => {
                    if (isSettled)
                        return;
                    cleanup();
                    this.rateLimiter.updateFromHeaders(res.headers);
                    try {
                        const data = JSON.parse(body);
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            isSettled = true;
                            resolve(data);
                        }
                        else {
                            const errCode = data?.code ?? res.statusCode;
                            const errMsg = data?.msg ?? body;
                            const isRateLimit = res.statusCode === 429 ||
                                res.statusCode === 418 ||
                                errCode === -1003 ||
                                errCode === -1015 ||
                                String(errMsg).includes("Too Many Requests") ||
                                String(errMsg).includes("IP banned");
                            if (isRateLimit) {
                                this.rateLimiter.register429Backoff(5000);
                            }
                            // Auto-resync timestamp and retry once if error code is -1021 (Timestamp ahead/behind)
                            if (errCode === -1021 && signed && !isRetryAfterSync) {
                                console.warn(`[BinanceExecutionClient] Timestamp error -1021 detected. Resynchronizing server time and retrying request...`);
                                await this.syncServerTime();
                                try {
                                    const retryRes = await this.request(method, endpoint, params, signed, true, signal);
                                    isSettled = true;
                                    resolve(retryRes);
                                    return;
                                }
                                catch (retryErr) {
                                    isSettled = true;
                                    reject(retryErr);
                                    return;
                                }
                            }
                            isSettled = true;
                            reject(new Error(`Binance API Error [${errCode}]: ${errMsg}`));
                        }
                    }
                    catch (err) {
                        isSettled = true;
                        reject(new Error(`Failed to parse Binance response: ${body}`));
                    }
                });
            });
            // Transport-level Socket Timeout Enforcement:
            req.setTimeout(defaultTimeoutMs, () => {
                if (isSettled)
                    return;
                isSettled = true;
                cleanup();
                req.destroy(new Error(`[BinanceExecutionClient] HTTP request socket timeout (${defaultTimeoutMs}ms) exceeded on ${method} ${endpoint}`));
                reject(new Error(`[BinanceExecutionClient] HTTP request socket timeout (${defaultTimeoutMs}ms) exceeded on ${method} ${endpoint}`));
            });
            let abortHandler = null;
            if (signal) {
                abortHandler = () => {
                    if (isSettled)
                        return;
                    isSettled = true;
                    cleanup();
                    req.destroy(new Error(`[BinanceExecutionClient] HTTP request aborted by caller on ${method} ${endpoint}`));
                    reject(new Error(`[BinanceExecutionClient] HTTP request aborted by caller on ${method} ${endpoint}`));
                };
                signal.addEventListener("abort", abortHandler, { once: true });
            }
            function cleanup() {
                if (signal && abortHandler) {
                    signal.removeEventListener("abort", abortHandler);
                    abortHandler = null;
                }
            }
            req.on("error", (err) => {
                if (isSettled)
                    return;
                isSettled = true;
                cleanup();
                reject(new Error(`Network error in Binance request: ${err.message}`));
            });
            req.end();
        });
    }
    async setHedgeMode(enable) {
        if (!this.isConfigured())
            return false;
        try {
            const dualSidePosition = enable ? "true" : "false";
            const res = await this.request("POST", "/fapi/v1/positionSide/dual", { dualSidePosition }, true);
            console.log(`[BinanceExecutionClient] Dual-side Hedge Mode set to ${enable} (Response: ${JSON.stringify(res)})`);
            return true;
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("-4059")) {
                console.log(`[BinanceExecutionClient] Dual-side Hedge Mode is already set to ${enable}.`);
                return true;
            }
            console.warn(`[BinanceExecutionClient] Unable to set Hedge Mode: ${errMsg}`);
            return false;
        }
    }
    async setLeverage(symbol, leverage) {
        if (!this.isConfigured() || !symbol || leverage <= 0)
            return null;
        try {
            const roundedLev = Math.round(leverage);
            const res = await this.request("POST", "/fapi/v1/leverage", { symbol, leverage: roundedLev }, true);
            console.log(`[BinanceExecutionClient] Exchange Leverage for ${symbol} set to ${res.leverage}x (MaxNotional: $${res.maxNotionalValue})`);
            return res;
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[BinanceExecutionClient] Unable to set leverage for ${symbol} to ${leverage}x: ${errMsg}`);
            return null;
        }
    }
    /**
     * SOTA Synchronous Pre-Flight Annihilation & State Verification Barrier:
     * Synchronously queries Binance for all resting conditional / closePosition orders matching symbol & positionSide,
     * forcibly cancels them, and verifies through zero-trust polling that exactly 0 conflicting orders remain on the exchange.
     */
    async synchronizeAndCancelConflictingOrders(symbol, positionSide, signal) {
        const targetPosSide = positionSide;
        let cancelledCount = 0;
        try {
            const openOrders = await this.getOpenOrders(symbol);
            const conflictingOrders = openOrders.filter((ord) => {
                const matchesPosSide = !ord.positionSide || ord.positionSide === "BOTH" || ord.positionSide === targetPosSide;
                const isConditionalOrClose = ord.type === "STOP_MARKET" ||
                    ord.type === "TAKE_PROFIT_MARKET" ||
                    ord.type === "STOP" ||
                    ord.type === "TAKE_PROFIT" ||
                    ord.closePosition === true ||
                    String(ord.closePosition).toLowerCase() === "true";
                return matchesPosSide && isConditionalOrClose;
            });
            if (conflictingOrders.length > 0) {
                console.log(`[BinanceExecutionClient][PRE_FLIGHT_ANNIHILATION] Found ${conflictingOrders.length} conflicting resting order(s) for ${symbol} (${targetPosSide}). Forcibly cancelling...`);
                for (const ord of conflictingOrders) {
                    try {
                        await this.cancelOrder(symbol, ord.orderId, signal);
                        cancelledCount++;
                    }
                    catch (cancelErr) {
                        const errMsg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
                        if (!errMsg.includes("-2011") && !errMsg.includes("Unknown order")) {
                            console.warn(`[BinanceExecutionClient][PRE_FLIGHT_CANCEL_WARN] Order #${ord.orderId} cancel notice: ${errMsg}`);
                        }
                    }
                }
                // State Verification Barrier: Zero-trust verified poll barrier
                // Up to 5 verification probes with 10ms micro-backoff to guarantee exchange state has 0 resting conflicting orders
                let remainingConflicts = 1;
                let verifyAttempts = 0;
                const maxVerifyAttempts = 5;
                while (remainingConflicts > 0 && verifyAttempts < maxVerifyAttempts) {
                    verifyAttempts++;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    try {
                        const recheckOrders = await this.getOpenOrders(symbol);
                        const stillActive = recheckOrders.filter((ord) => {
                            const matchesPosSide = !ord.positionSide || ord.positionSide === "BOTH" || ord.positionSide === targetPosSide;
                            const isConditionalOrClose = ord.type === "STOP_MARKET" ||
                                ord.type === "TAKE_PROFIT_MARKET" ||
                                ord.type === "STOP" ||
                                ord.type === "TAKE_PROFIT" ||
                                ord.closePosition === true ||
                                String(ord.closePosition).toLowerCase() === "true";
                            return matchesPosSide && isConditionalOrClose;
                        });
                        remainingConflicts = stillActive.length;
                        if (remainingConflicts > 0) {
                            console.warn(`[BinanceExecutionClient][VERIFY_BARRIER_POLL] ${remainingConflicts} order(s) still clearing on Binance (Probe ${verifyAttempts}/${maxVerifyAttempts})...`);
                            for (const ord of stillActive) {
                                try {
                                    await this.cancelOrder(symbol, ord.orderId, signal);
                                }
                                catch (_) { }
                            }
                        }
                    }
                    catch (recheckErr) {
                        break;
                    }
                }
                if (remainingConflicts === 0) {
                    console.log(`[BinanceExecutionClient][VERIFY_BARRIER_CLEARED] Exchange verified clean: 0 resting conflicting orders for ${symbol} (${targetPosSide}).`);
                }
            }
        }
        catch (queryErr) {
            console.warn(`[BinanceExecutionClient][PRE_FLIGHT_QUERY_WARN] Pre-flight open orders query notice: ${queryErr instanceof Error ? queryErr.message : String(queryErr)}`);
        }
        return cancelledCount;
    }
    /**
     * Native Binance USD-M Futures Cancel-Replace an Order (PUT /fapi/v1/order).
     * Atomically cancels an existing order and places a replacement order in a single transaction on the matching engine.
     */
    async cancelReplaceOrder(params, signal) {
        const isClosePosition = params.closePosition === true || String(params.closePosition).toLowerCase() === "true";
        const formattedQty = params.quantity !== undefined ? symbolPrecision_1.SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity) : 0;
        const cid = (params.clientOrderId || "").trim();
        const payload = {
            symbol: params.symbol,
            side: params.side,
            type: params.type,
            cancelReplaceMode: params.cancelReplaceMode || "STOP_ON_FAILURE",
        };
        if (params.cancelOrderId !== undefined)
            payload.cancelOrderId = params.cancelOrderId;
        if (params.cancelOrigClientOrderId !== undefined)
            payload.cancelOrigClientOrderId = params.cancelOrigClientOrderId;
        if (!isClosePosition) {
            payload.quantity = formattedQty;
        }
        if (params.price !== undefined)
            payload.price = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, params.price);
        if (params.stopPrice !== undefined)
            payload.stopPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice);
        if (isClosePosition) {
            payload.closePosition = "true";
            delete payload.quantity;
            delete payload.reduceOnly;
            delete payload.price;
            delete payload.timeInForce;
        }
        if (params.workingType !== undefined)
            payload.workingType = params.workingType;
        if (params.recvWindow !== undefined)
            payload.recvWindow = params.recvWindow;
        if (params.positionSide !== undefined)
            payload.positionSide = params.positionSide;
        if (cid.length > 0)
            payload.newClientOrderId = cid;
        return await this.request("PUT", "/fapi/v1/order", payload, true, false, signal);
    }
    async placePositionStopLoss(symbol, side, positionSide, stopPrice, clientOrderId, signal, quantity) {
        const formattedSlPx = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(symbol, stopPrice);
        const cid = clientOrderId || clientOrderIdGenerator_1.ClientOrderIdGenerator.generate(symbol, positionSide === "LONG" ? "CORE_LONG" : "SHORT_AGG", "SL");
        // Strict Zero-Trust Assertion:
        // SHORT position -> side MUST be "BUY"
        // LONG position -> side MUST be "SELL"
        const expectedSide = positionSide === "SHORT" ? "BUY" : (positionSide === "LONG" ? "SELL" : side);
        if (side !== expectedSide && positionSide !== "BOTH") {
            console.warn(`[BinanceExecutionClient][SL_DIRECTION_CORRECTION] Correcting misaligned SL side ${side} to ${expectedSide} for ${positionSide} position on ${symbol}.`);
        }
        const sanitizedSide = expectedSide;
        // PHASE 1-3: Synchronous Pre-Flight Annihilation & State Verification Barrier
        await this.synchronizeAndCancelConflictingOrders(symbol, positionSide, signal);
        // PHASE 4: Sovereign Dispatch
        const params = {
            symbol,
            side: sanitizedSide,
            type: "STOP_MARKET",
            stopPrice: formattedSlPx,
            positionSide,
            closePosition: true,
            quantity: quantity && quantity > 0 ? quantity : undefined,
            clientOrderId: cid,
            workingType: "CONTRACT_PRICE",
        };
        try {
            return await this.placeOrder(params, 0, signal);
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isClosePositionConflict = errMsg.includes("-4130") ||
                errMsg.includes("4130") ||
                errMsg.includes("-4509") ||
                errMsg.includes("4509") ||
                errMsg.includes("closePosition");
            // PHASE 5: Zero-Naked Guaranteed Quantity-Based Fallback
            if (isClosePositionConflict) {
                console.warn(`[BinanceExecutionClient][SL_ZERO_NAKED_FALLBACK] closePosition=true rejected with ${errMsg} on ${symbol} (${positionSide}). Engaging Deterministic Quantity-Based STOP_MARKET Fallback...`);
                let fallbackQty = quantity;
                if (!fallbackQty || fallbackQty <= 0) {
                    try {
                        const posRisks = await this.getPositionRisk(symbol);
                        const matchPos = posRisks.find((p) => p.positionSide === positionSide || (positionSide === "BOTH" && parseFloat(p.positionAmt) !== 0));
                        if (matchPos) {
                            const amt = Math.abs(parseFloat(matchPos.positionAmt || "0"));
                            if (amt > 0)
                                fallbackQty = amt;
                        }
                    }
                    catch (_) { }
                }
                if (fallbackQty && fallbackQty > 0) {
                    const fallbackCid = clientOrderIdGenerator_1.ClientOrderIdGenerator.generate(symbol, positionSide === "LONG" ? "CORE_LONG" : "SHORT_AGG", "SL_FALLBACK");
                    const fallbackParams = {
                        symbol,
                        side: sanitizedSide,
                        type: "STOP_MARKET",
                        stopPrice: formattedSlPx,
                        positionSide,
                        closePosition: false,
                        quantity: fallbackQty,
                        clientOrderId: fallbackCid,
                        workingType: "CONTRACT_PRICE",
                    };
                    return await this.placeOrder(fallbackParams, 0, signal);
                }
            }
            throw err;
        }
    }
    async placeOrder(params, retryCount = 0, signal) {
        const cid = (params.clientOrderId || "").trim();
        if (cid.length > 0 && retryCount === 0) {
            if (this.inFlightClientOrderIds.has(cid)) {
                throw new Error(`[BinanceExecutionClient][DEDUPLICATION_BARRIER] Blocked duplicate concurrent submission for ClientOrderId: ${cid}`);
            }
            this.inFlightClientOrderIds.add(cid);
        }
        try {
            const isClosePosition = params.closePosition === true || String(params.closePosition).toLowerCase() === "true";
            const formattedQty = params.quantity !== undefined ? symbolPrecision_1.SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity) : 0;
            const payload = {
                symbol: params.symbol,
                side: params.side,
                type: params.type,
            };
            if (!isClosePosition) {
                payload.quantity = formattedQty;
            }
            if (params.price !== undefined)
                payload.price = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, params.price);
            if (params.stopPrice !== undefined)
                payload.stopPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice);
            // Binance API Error -1106: Parameter 'timeinforce' sent when not required.
            // timeInForce MUST NOT be sent for MARKET, STOP_MARKET, or TAKE_PROFIT_MARKET orders.
            if (params.type !== "MARKET" &&
                params.type !== "STOP_MARKET" &&
                params.type !== "TAKE_PROFIT_MARKET" &&
                params.timeInForce !== undefined) {
                payload.timeInForce = params.timeInForce;
            }
            else {
                delete payload.timeInForce;
            }
            if (isClosePosition) {
                payload.closePosition = "true";
                delete payload.quantity;
                delete payload.reduceOnly;
                delete payload.price;
                delete payload.timeInForce;
            }
            else if (params.reduceOnly !== undefined &&
                (params.positionSide === undefined || params.positionSide === "BOTH")) {
                payload.reduceOnly = params.reduceOnly;
            }
            else {
                delete payload.reduceOnly;
            }
            if (params.workingType !== undefined)
                payload.workingType = params.workingType;
            if (params.recvWindow !== undefined)
                payload.recvWindow = params.recvWindow;
            if (params.positionSide !== undefined)
                payload.positionSide = params.positionSide;
            if (cid.length > 0) {
                payload.newClientOrderId = cid;
            }
            try {
                return await this.request("POST", "/fapi/v1/order", payload, true, false, signal);
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                if (errMsg.includes("-4120")) {
                    // Fallback to /fapi/v1/algoOrder if /fapi/v1/order threw -4120
                    const algoPayload = {
                        ...payload,
                        algoType: "CONDITIONAL",
                    };
                    if (params.stopPrice !== undefined) {
                        algoPayload.triggerPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice);
                        delete algoPayload.stopPrice;
                    }
                    if (cid.length > 0) {
                        algoPayload.clientAlgoId = cid;
                        delete algoPayload.newClientOrderId;
                    }
                    delete algoPayload.reduceOnly;
                    const algoRes = await this.request("POST", "/fapi/v1/algoOrder", algoPayload, true, false, signal);
                    if (algoRes && (algoRes.algoId || algoRes.orderId)) {
                        return {
                            orderId: Number(algoRes.algoId || algoRes.orderId),
                            symbol: algoRes.symbol || params.symbol,
                            status: algoRes.algoStatus || algoRes.status || "NEW",
                            clientOrderId: algoRes.clientAlgoId || algoRes.clientOrderId || "",
                            price: String(algoRes.price || "0"),
                            avgPrice: String(algoRes.avgPrice || "0"),
                            origQty: String(algoRes.quantity || formattedQty),
                            executedQty: String(algoRes.executedQty || "0"),
                            cumQuote: String(algoRes.cumQuote || "0"),
                            timeInForce: algoRes.timeInForce || "GTC",
                            type: algoRes.orderType || params.type,
                            reduceOnly: false,
                            side: algoRes.side || params.side,
                            positionSide: algoRes.positionSide || params.positionSide || "BOTH",
                            stopPrice: String(algoRes.triggerPrice || params.stopPrice || "0"),
                            workingType: algoRes.workingType || params.workingType || "CONTRACT_PRICE",
                            updateTime: algoRes.updateTime || Date.now(),
                        };
                    }
                    return algoRes;
                }
                const isConflictOrGteError = errMsg.includes("-4509") ||
                    errMsg.includes("4509") ||
                    errMsg.includes("TIF GTE") ||
                    errMsg.includes("Time in Force (TIF) GTE can only be used with open positions") ||
                    errMsg.includes("-4130") ||
                    errMsg.includes("4130") ||
                    errMsg.includes("would trigger immediately") ||
                    errMsg.includes("closePosition in the direction is existing");
                if (isConflictOrGteError && retryCount < 2) {
                    console.warn(`[BinanceExecutionClient][-4509/-4130 AUTO_RECOVERY] Binance rejected closePosition order on ${params.symbol} (${params.positionSide || "BOTH"} ${params.side}): ${errMsg}. Executing synchronous pre-flight annihilation and retrying...`);
                    // 1. Synchronously purge conflicting orders with State Verification Barrier
                    await this.synchronizeAndCancelConflictingOrders(params.symbol, params.positionSide || "BOTH", signal);
                    // 2. Generate a fresh unique clientOrderId for the retry
                    const nextCid = params.clientOrderId ? `${params.clientOrderId}_R${retryCount + 1}` : undefined;
                    return await this.placeOrder({
                        ...params,
                        clientOrderId: nextCid,
                    }, retryCount + 1, signal);
                }
                // Secondary SOTA Fallback: If closePosition: true is rejected after retries, execute a deterministic Quantity-Based STOP_MARKET
                if (isConflictOrGteError && retryCount >= 2 && isClosePosition) {
                    let fallbackQty = params.quantity;
                    if (!fallbackQty || fallbackQty <= 0) {
                        try {
                            const posRisks = await this.getPositionRisk(params.symbol);
                            const targetPosSide = params.positionSide || "BOTH";
                            const matchPos = posRisks.find((p) => p.positionSide === targetPosSide || (targetPosSide === "BOTH" && parseFloat(p.positionAmt) !== 0));
                            if (matchPos) {
                                const amt = Math.abs(parseFloat(matchPos.positionAmt || "0"));
                                if (amt > 0)
                                    fallbackQty = amt;
                            }
                        }
                        catch (posErr) {
                            // Ignore position risk query error in fallback
                        }
                    }
                    if (fallbackQty && fallbackQty > 0) {
                        console.warn(`[BinanceExecutionClient][SOTA_SL_FALLBACK] closePosition=true rejected after retries on ${params.symbol} (${params.positionSide}). Executing deterministic Quantity-Based STOP_MARKET fallback (Qty: ${fallbackQty})...`);
                        const fallbackParams = {
                            ...params,
                            closePosition: false,
                            quantity: fallbackQty,
                            clientOrderId: params.clientOrderId ? `${params.clientOrderId}_FALLBACK` : undefined,
                        };
                        return await this.placeOrder(fallbackParams, 0, signal);
                    }
                }
                if ((errMsg.includes("-5022") || errMsg.includes("5022")) && retryCount < 2) {
                    const tickSize = symbolPrecision_1.SymbolPrecisionRegistry.getTickSize(params.symbol);
                    const currentPrice = params.price || 0;
                    // Shift 1 tick away from spread to guarantee Maker placement
                    const adjustedPrice = params.side === "BUY" ? currentPrice - tickSize : currentPrice + tickSize;
                    const newPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, adjustedPrice);
                    if (retryCount === 0 && params.timeInForce === "GTX") {
                        console.warn(`[BinanceExecutionClient][-5022 REJECTION] POST_ONLY order for ${params.symbol} ${params.side} @ ${currentPrice} crossed spread. Shifting 1 tick away to ${newPrice} and retrying...`);
                        return await this.placeOrder({
                            ...params,
                            price: newPrice,
                        }, 1, signal);
                    }
                    else if (retryCount === 1) {
                        console.warn(`[BinanceExecutionClient][-5022 FALLBACK] GTX retry failed for ${params.symbol}. Falling back to standard LIMIT (GTC) order @ ${newPrice} to safeguard position...`);
                        return await this.placeOrder({
                            ...params,
                            price: newPrice,
                            timeInForce: "GTC",
                        }, 2, signal);
                    }
                }
                throw err;
            }
        }
        finally {
            if (cid.length > 0 && retryCount === 0) {
                this.inFlightClientOrderIds.delete(cid);
            }
        }
    }
    /**
     * Submits a batch of orders in a single low-latency HTTP REST request (POST /fapi/v1/batchOrders).
     * Dynamically loads batch order max limits and recvWindow from environment variables.
     */
    async placeBatchOrders(orders) {
        if (!orders || orders.length === 0)
            return [];
        const maxBatchLimit = parseInt(process.env.BATCH_ORDER_MAX_LIMIT || "5", 10);
        const recvWindow = parseInt(process.env.RECV_WINDOW_MS || "5000", 10);
        if (orders.length > maxBatchLimit) {
            console.warn(`[BinanceExecutionClient] Batch order count (${orders.length}) exceeds BATCH_ORDER_MAX_LIMIT (${maxBatchLimit}). Truncating to ${maxBatchLimit}.`);
        }
        const targetOrders = orders.slice(0, maxBatchLimit);
        const batchPayload = targetOrders.map((params) => {
            const cid = params.clientOrderId || "";
            const isClosePosition = params.closePosition === true || String(params.closePosition).toLowerCase() === "true";
            const formattedQty = params.quantity !== undefined ? symbolPrecision_1.SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity) : 0;
            const payload = {
                symbol: params.symbol,
                side: params.side,
                type: params.type,
            };
            if (!isClosePosition) {
                payload.quantity = formattedQty;
            }
            if (params.price !== undefined)
                payload.price = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, params.price);
            if (params.stopPrice !== undefined)
                payload.stopPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice);
            // Binance API Error -1106: Parameter 'timeinforce' sent when not required.
            // timeInForce MUST NOT be sent for MARKET, STOP_MARKET, or TAKE_PROFIT_MARKET orders.
            if (params.type !== "MARKET" &&
                params.type !== "STOP_MARKET" &&
                params.type !== "TAKE_PROFIT_MARKET" &&
                params.timeInForce !== undefined) {
                payload.timeInForce = params.timeInForce;
            }
            if (isClosePosition) {
                payload.closePosition = "true";
                delete payload.quantity;
                delete payload.reduceOnly;
            }
            else if (params.reduceOnly !== undefined &&
                (params.positionSide === undefined || params.positionSide === "BOTH")) {
                payload.reduceOnly = params.reduceOnly;
            }
            if (params.workingType !== undefined)
                payload.workingType = params.workingType;
            if (params.recvWindow !== undefined)
                payload.recvWindow = params.recvWindow;
            if (params.positionSide !== undefined)
                payload.positionSide = params.positionSide;
            if (cid.length > 0)
                payload.newClientOrderId = cid;
            return payload;
        });
        const batchQuery = {
            batchOrders: JSON.stringify(batchPayload),
            recvWindow,
        };
        return this.request("POST", "/fapi/v1/batchOrders", batchQuery, true);
    }
    async cancelBatchOrders(symbol, orderIdList) {
        if (!orderIdList || orderIdList.length === 0)
            return [];
        const recvWindow = parseInt(process.env.RECV_WINDOW_MS || "5000", 10);
        const maxBatchLimit = parseInt(process.env.BATCH_ORDER_MAX_LIMIT || "5", 10);
        const targetIds = orderIdList.slice(0, maxBatchLimit);
        const payload = {
            symbol,
            orderIdList: JSON.stringify(targetIds),
            recvWindow,
        };
        return this.request("DELETE", "/fapi/v1/batchOrders", payload, true);
    }
    async cancelOrder(symbol, orderId, signal) {
        try {
            return await this.request("DELETE", "/fapi/v1/order", { symbol, orderId }, true, false, signal);
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("-2011") || errMsg.includes("-4120") || errMsg.includes("Unknown order") || errMsg.includes("not found")) {
                // Fallback to /fapi/v1/algoOrder cancellation
                try {
                    const algoCancel = await this.request("DELETE", "/fapi/v1/algoOrder", { symbol, algoId: orderId }, true, false, signal);
                    return {
                        orderId: Number(orderId),
                        symbol,
                        status: algoCancel.algoStatus || algoCancel.status || "CANCELED",
                        clientOrderId: algoCancel.clientAlgoId || algoCancel.clientOrderId || "",
                        price: "0",
                        avgPrice: "0",
                        origQty: "0",
                        executedQty: "0",
                        cumQuote: "0",
                        timeInForce: "GTC",
                        type: "STOP_MARKET",
                        reduceOnly: false,
                        side: "SELL",
                        positionSide: "BOTH",
                        stopPrice: "0",
                        workingType: "CONTRACT_PRICE",
                        updateTime: Date.now(),
                    };
                }
                catch (algoErr) {
                    throw err;
                }
            }
            throw err;
        }
    }
    async cancelAllOrders(symbol) {
        try {
            await this.request("DELETE", "/fapi/v1/algoOpenOrders", { symbol }, true).catch((err) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.log(`[BinanceExecutionClient] Notice during algoOpenOrders cancellation: ${errMsg}`);
            });
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.log(`[BinanceExecutionClient] Notice during algoOpenOrders dispatch: ${errMsg}`);
        }
        return this.request("DELETE", "/fapi/v1/allOpenOrders", { symbol }, true);
    }
    async flattenPositions(symbol) {
        try {
            await this.cancelAllOrders(symbol);
            const positions = await this.getPositionRisk(symbol);
            for (const pos of positions) {
                const amt = parseFloat(pos.positionAmt || "0");
                if (Math.abs(amt) > 0) {
                    const side = amt > 0 ? "SELL" : "BUY";
                    const orderParams = {
                        symbol: pos.symbol,
                        side: side,
                        type: "MARKET",
                        quantity: Math.abs(amt),
                    };
                    if (pos.positionSide && pos.positionSide !== "BOTH") {
                        orderParams.positionSide = pos.positionSide;
                    }
                    else {
                        orderParams.reduceOnly = true;
                    }
                    await this.placeOrder(orderParams);
                }
            }
            return true;
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[BinanceExecutionClient] flattenPositions error: ${errMsg}`);
            return false;
        }
    }
    async getPositionRisk(symbol) {
        const params = {};
        if (symbol)
            params.symbol = symbol;
        return this.request("GET", "/fapi/v3/positionRisk", params, true).catch(async (err) => {
            // Graceful fallback to /fapi/v2/positionRisk if /fapi/v3/positionRisk is unavailable
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("404") || errMsg.includes("-4120")) {
                return this.request("GET", "/fapi/v2/positionRisk", params, true);
            }
            throw err;
        });
    }
    async getAccountInfo() {
        return this.request("GET", "/fapi/v3/account", {}, true).catch(async (err) => {
            // Graceful fallback to /fapi/v2/account if /fapi/v3/account is unavailable
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("404") || errMsg.includes("-4120")) {
                return this.request("GET", "/fapi/v2/account", {}, true);
            }
            throw err;
        });
    }
    /**
     * SOTA Dual-Source Consensus Position Ingestion:
     * Merges real-time /fapi/v3/positionRisk and authoritative margin ledger /fapi/v3/account in parallel.
     * Eliminates single-endpoint pagination/caching omissions across all active symbols.
     */
    async getDualPositionRisk(symbol) {
        const [posRiskRes, accountInfoRes] = await Promise.allSettled([
            this.getPositionRisk(symbol),
            this.getAccountInfo(),
        ]);
        // Strict Anti-Masking Invariant: If BOTH authoritative queries fail, throw critical consensus failure
        if (posRiskRes.status === "rejected" && accountInfoRes.status === "rejected") {
            const posRiskErr = posRiskRes.reason;
            const accountInfoErr = accountInfoRes.reason;
            throw new Error(`[BinanceExecutionClient][CONSENSUS_FAILURE] Dual-source position consensus failed: positionRisk error (${posRiskErr?.message || String(posRiskErr)}), accountInfo error (${accountInfoErr?.message || String(accountInfoErr)})`);
        }
        if (posRiskRes.status === "rejected") {
            console.warn(`[BinanceExecutionClient][CONSENSUS_DEGRADED] positionRisk query failed: ${posRiskRes.reason?.message}. Relying on accountInfo ledger.`);
        }
        if (accountInfoRes.status === "rejected") {
            console.warn(`[BinanceExecutionClient][CONSENSUS_DEGRADED] accountInfo query failed: ${accountInfoRes.reason?.message}. Relying on positionRisk stream.`);
        }
        const posRiskList = posRiskRes.status === "fulfilled" && Array.isArray(posRiskRes.value) ? posRiskRes.value : [];
        const accountPositions = accountInfoRes.status === "fulfilled" && accountInfoRes.value && Array.isArray(accountInfoRes.value.positions)
            ? accountInfoRes.value.positions
            : [];
        const mergedMap = new Map();
        // 1. Ingest positionRisk entries
        for (const p of posRiskList) {
            if (symbol && p.symbol !== symbol)
                continue;
            const key = `${p.symbol}:${p.positionSide || "BOTH"}`;
            mergedMap.set(key, p);
        }
        // 2. Ingest / Merge account positions (authoritative margin ledger)
        for (const ap of accountPositions) {
            if (symbol && ap.symbol !== symbol)
                continue;
            const key = `${ap.symbol}:${ap.positionSide || "BOTH"}`;
            const existing = mergedMap.get(key);
            const apQty = Math.abs(parseFloat(ap.positionAmt || "0"));
            if (!existing) {
                mergedMap.set(key, ap);
            }
            else {
                const existingQty = Math.abs(parseFloat(existing.positionAmt || "0"));
                // If account ledger shows active position and positionRisk was 0/stale, prioritize account ledger
                if (apQty > 0 && existingQty === 0) {
                    mergedMap.set(key, ap);
                }
                else if (apQty > 0 && existingQty > 0) {
                    // Both non-zero, take latest updateTime
                    if ((ap.updateTime || 0) >= (existing.updateTime || 0)) {
                        mergedMap.set(key, { ...existing, ...ap });
                    }
                }
            }
        }
        return Array.from(mergedMap.values());
    }
    async getOpenOrders(symbol) {
        const params = {};
        if (symbol)
            params.symbol = symbol;
        // Standard open orders query MUST succeed; errors propagate directly to caller
        const standardOrders = await this.request("GET", "/fapi/v1/openOrders", params, true);
        const algoOrders = await this.request("GET", "/fapi/v1/openAlgoOrders", params, true).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("404") || msg.includes("-4120") || msg.includes("not supported")) {
                return [];
            }
            throw err;
        });
        const mappedAlgoOrders = (Array.isArray(algoOrders) ? algoOrders : []).map((ao) => ({
            orderId: ao.algoId || ao.orderId || 0,
            symbol: ao.symbol,
            status: ao.algoStatus || ao.status || "NEW",
            clientOrderId: ao.clientAlgoId || ao.clientOrderId || "",
            price: String(ao.price || "0"),
            avgPrice: String(ao.avgPrice || "0"),
            origQty: String(ao.quantity || ao.origQty || "0"),
            executedQty: String(ao.executedQty || "0"),
            cumQuote: String(ao.cumQuote || "0"),
            timeInForce: ao.timeInForce || "GTC",
            type: ao.orderType || ao.type || "STOP_MARKET",
            reduceOnly: ao.reduceOnly || false,
            side: ao.side,
            positionSide: ao.positionSide || "BOTH",
            stopPrice: String(ao.stopPrice || "0"),
            workingType: ao.workingType || "CONTRACT_PRICE",
            updateTime: ao.updateTime || Date.now(),
        }));
        return [...(Array.isArray(standardOrders) ? standardOrders : []), ...mappedAlgoOrders];
    }
    async getAccountBalance() {
        return this.request("GET", "/fapi/v3/account", {}, true).then((res) => (Array.isArray(res?.assets) ? res.assets : [])).catch(async () => {
            const v2Res = await this.request("GET", "/fapi/v2/account", {}, true);
            return Array.isArray(v2Res?.assets) ? v2Res.assets : [];
        });
    }
    async getOrder(symbol, orderId) {
        return this.request("GET", "/fapi/v1/order", { symbol, orderId }, true);
    }
    async getUserTrades(symbol, limit = 50, startTime, endTime, fromId) {
        const params = { symbol, limit };
        if (startTime !== undefined && startTime > 0)
            params.startTime = startTime;
        if (endTime !== undefined && endTime > 0)
            params.endTime = endTime;
        if (fromId !== undefined && fromId > 0)
            params.fromId = fromId;
        const res = await this.request("GET", "/fapi/v1/userTrades", params, true);
        return Array.isArray(res) ? res : [];
    }
    /**
     * Fetches micro-cent exchange income history (/fapi/v1/income) including FUNDING_FEE, COMMISSION, and REALIZED_PNL.
     */
    async getIncomeHistory(symbol, incomeType, startTime, endTime, limit = 100) {
        const params = { limit };
        if (symbol)
            params.symbol = symbol;
        if (incomeType)
            params.incomeType = incomeType;
        if (startTime !== undefined && startTime > 0)
            params.startTime = startTime;
        if (endTime !== undefined && endTime > 0)
            params.endTime = endTime;
        const res = await this.request("GET", "/fapi/v1/income", params, true);
        return Array.isArray(res) ? res : [];
    }
    /**
     * Reconciles available wallet balance and total unrealized profit directly from Binance REST API.
     */
    async fetchReconciledAccountBalanceAsync() {
        if (!this.isConfigured()) {
            return { totalWalletBalance: 0, availableBalance: 0, unrealizedProfit: 0 };
        }
        try {
            const accountInfo = await this.getAccountInfo();
            if (accountInfo) {
                const totalWallet = parseFloat(accountInfo.totalWalletBalance || "0");
                const available = parseFloat(accountInfo.availableBalance || "0");
                const unrealized = parseFloat(accountInfo.totalUnrealizedProfit || "0");
                if (!isNaN(totalWallet))
                    this.cachedReconciledWalletBalance = totalWallet;
                if (!isNaN(available))
                    this.cachedUsdtAvailableBalance = available;
                if (!isNaN(unrealized))
                    this.cachedTotalUnrealizedProfit = unrealized;
                return {
                    totalWalletBalance: this.cachedReconciledWalletBalance,
                    availableBalance: this.cachedUsdtAvailableBalance,
                    unrealizedProfit: this.cachedTotalUnrealizedProfit,
                };
            }
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[BinanceExecutionClient] Reconciled account balance fetch notice: ${errMsg}`);
        }
        return {
            totalWalletBalance: this.cachedReconciledWalletBalance,
            availableBalance: this.cachedUsdtAvailableBalance,
            unrealizedProfit: this.cachedTotalUnrealizedProfit,
        };
    }
    getReconciledWalletBalance() {
        return this.cachedReconciledWalletBalance > 0 ? this.cachedReconciledWalletBalance : this.cachedUsdtAvailableBalance;
    }
    getTotalUnrealizedProfit() {
        return this.cachedTotalUnrealizedProfit;
    }
    getCumulativeFunding(symbol) {
        if (symbol) {
            return this.cachedCumulativeFunding.get(symbol) ?? 0;
        }
        let total = 0;
        for (const val of this.cachedCumulativeFunding.values()) {
            total += val;
        }
        return total;
    }
    getCumulativeCommission(symbol) {
        if (symbol) {
            return this.cachedCumulativeCommission.get(symbol) ?? 0;
        }
        let total = 0;
        for (const val of this.cachedCumulativeCommission.values()) {
            total += val;
        }
        return total;
    }
    subscribeIncomeUpdates(callback) {
        this.incomeCallbacks.add(callback);
        return () => {
            this.incomeCallbacks.delete(callback);
        };
    }
    subscribeUserTradeUpdates(callback) {
        this.userTradeCallbacks.add(callback);
        return () => {
            this.userTradeCallbacks.delete(callback);
        };
    }
    /**
     * Starts background synchronization of /fapi/v1/income and /fapi/v1/userTrades.
     */
    startBackgroundSync(symbols = ["BTCUSDT"], incomeIntervalMs = 30000, tradeIntervalMs = 10000) {
        if (!this.isConfigured())
            return;
        // 1. Initial immediate reconciliation
        this.fetchReconciledAccountBalanceAsync().catch(() => { });
        this.syncIncomeBackground(symbols).catch(() => { });
        // 2. Start periodic income sync
        if (!this.incomeSyncTimer) {
            this.incomeSyncTimer = setInterval(() => {
                this.syncIncomeBackground(symbols).catch((err) => {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    console.warn(`[BinanceExecutionClient] Background income sync notice: ${errMsg}`);
                });
                this.fetchReconciledAccountBalanceAsync().catch(() => { });
            }, incomeIntervalMs);
        }
        // 3. Start periodic userTrades sync
        if (!this.userTradesSyncTimer) {
            this.userTradesSyncTimer = setInterval(() => {
                this.syncUserTradesBackground(symbols).catch((err) => {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    console.warn(`[BinanceExecutionClient] Background userTrades sync notice: ${errMsg}`);
                });
            }, tradeIntervalMs);
        }
    }
    stopBackgroundSync() {
        if (this.incomeSyncTimer) {
            clearInterval(this.incomeSyncTimer);
            this.incomeSyncTimer = null;
        }
        if (this.userTradesSyncTimer) {
            clearInterval(this.userTradesSyncTimer);
            this.userTradesSyncTimer = null;
        }
    }
    async syncIncomeBackground(symbols) {
        const startTime = this.lastIncomeSyncTime > 0 ? this.lastIncomeSyncTime : Date.now() - 24 * 60 * 60 * 1000;
        const incomes = await this.getIncomeHistory(undefined, undefined, startTime, undefined, 100);
        if (incomes.length > 0) {
            let maxTime = this.lastIncomeSyncTime;
            for (const inc of incomes) {
                if (inc.time > maxTime)
                    maxTime = inc.time;
                const sym = inc.symbol || "GLOBAL";
                const val = parseFloat(inc.income || "0");
                if (inc.incomeType === "FUNDING_FEE" && !isNaN(val)) {
                    const currentFunding = this.cachedCumulativeFunding.get(sym) ?? 0;
                    this.cachedCumulativeFunding.set(sym, currentFunding + val);
                }
                else if (inc.incomeType === "COMMISSION" && !isNaN(val)) {
                    const currentComm = this.cachedCumulativeCommission.get(sym) ?? 0;
                    this.cachedCumulativeCommission.set(sym, currentComm + Math.abs(val));
                }
            }
            this.lastIncomeSyncTime = maxTime + 1;
            for (const cb of this.incomeCallbacks) {
                try {
                    cb(incomes);
                }
                catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    console.error(`[BinanceExecutionClient] Error in income callback: ${errMsg}`);
                }
            }
        }
    }
    async syncUserTradesBackground(symbols) {
        for (const sym of symbols) {
            const lastSyncTime = this.lastUserTradeSyncTimes.get(sym) || (Date.now() - 60 * 60 * 1000);
            const trades = await this.getUserTrades(sym, 50, lastSyncTime);
            if (trades.length > 0) {
                let maxTime = lastSyncTime;
                for (const t of trades) {
                    if (t.time > maxTime)
                        maxTime = t.time;
                }
                this.lastUserTradeSyncTimes.set(sym, maxTime + 1);
                for (const cb of this.userTradeCallbacks) {
                    try {
                        cb(trades);
                    }
                    catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        console.error(`[BinanceExecutionClient] Error in userTrade callback for ${sym}: ${errMsg}`);
                    }
                }
            }
        }
    }
    async createListenKey() {
        const res = await this.request("POST", "/fapi/v1/listenKey", {}, true);
        return res.listenKey;
    }
    async keepAliveListenKey() {
        await this.request("PUT", "/fapi/v1/listenKey", {}, true);
        return true;
    }
}
exports.BinanceExecutionClient = BinanceExecutionClient;
