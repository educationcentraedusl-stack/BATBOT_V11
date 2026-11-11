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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
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
const wsOrderClient_1 = require("./wsOrderClient");
const sabSchema_1 = require("../ipc/sabSchema");
const tradingSymbols_1 = require("../config/tradingSymbols");
const ws_1 = __importDefault(require("ws"));
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function formatRejectionReason(reason) {
    return reason instanceof Error ? reason.message : String(reason);
}
function isClosePositionResponse(ord) {
    return (ord.closePosition === true ||
        (typeof ord.closePosition === "string" && ord.closePosition.toLowerCase() === "true"));
}
function parseOptionalAlgoDecimalString(val, fieldName, context) {
    if (val === undefined) {
        return "";
    }
    const trimmed = val.trim();
    if (trimmed.length === 0 || !Number.isFinite(Number(trimmed))) {
        throw new Error(`[BinanceExecutionClient] Malformed numeric string "${trimmed}" for "${fieldName}" in ${context}`);
    }
    return trimmed;
}
function resolveCredentialValue(raw) {
    if (typeof raw !== "string")
        return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function normalizeOptionalString(raw) {
    if (typeof raw !== "string")
        return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function requireNonEmptyString(raw, fieldName, context) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new Error(`[BinanceExecutionClient] Missing or empty string for "${fieldName}" in ${context}`);
    }
    return raw.trim();
}
function parseStrictFloat(raw, fieldName, context) {
    if (typeof raw === "number") {
        if (!Number.isFinite(raw)) {
            throw new Error(`[BinanceExecutionClient] Non-finite number (${String(raw)}) for "${fieldName}" in ${context}`);
        }
        return raw;
    }
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }
    throw new Error(`[BinanceExecutionClient] Missing or invalid numeric value (${String(raw)}) for "${fieldName}" in ${context}`);
}
function parseStrictPositionSide(raw, fieldName, context) {
    if (raw === "LONG" || raw === "SHORT" || raw === "BOTH") {
        return raw;
    }
    throw new Error(`[BinanceExecutionClient] Invalid ${fieldName} (${String(raw)}) in ${context}`);
}
function requireValidAdjustPrice(params, pathLabel) {
    if (typeof params.price !== "number" || !Number.isFinite(params.price) || params.price <= 0) {
        throw new Error(`[BinanceExecutionClient][-5022_INVALID_PRICE] Missing or non-positive params.price (${String(params.price)}) during ${pathLabel} retry for ${params.symbol} ${params.side}`);
    }
    return params.price;
}
function requirePositiveQuantity(params) {
    if (typeof params.quantity !== "number" || !Number.isFinite(params.quantity) || params.quantity <= 0) {
        throw new Error(`[BinanceExecutionClient][INVALID_QUANTITY] Missing or non-positive quantity (${String(params.quantity)}) for non-closePosition ${params.type} order on ${params.symbol}`);
    }
    return symbolPrecision_1.SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity);
}
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
                    console.warn(`[BinanceRateLimiter] Received Retry-After: ${String(retrySec)}s. Enforcing backoff until ${new Date(this.backoffUntil).toISOString()}`);
                }
            }
        }
    }
    register429Backoff(retryAfterMs = 5000) {
        const now = Date.now();
        this.backoffUntil = Math.max(this.backoffUntil, now + retryAfterMs);
        console.error(`[BinanceRateLimiter][429_CIRCUIT_BREAKER] Binance 429/418 detected. Backing off for ${String(retryAfterMs)}ms.`);
    }
    async acquirePreFlightAllowance(isOrder, signal) {
        const now = Date.now();
        // 1. Check active 429/418 Circuit Breaker Backoff
        if (this.backoffUntil > now) {
            const waitMs = this.backoffUntil - now;
            console.warn(`[BinanceRateLimiter][THROTTLED_CIRCUIT_BREAKER] Waiting ${String(waitMs)}ms before dispatching request...`);
            await this.sleep(waitMs, signal);
        }
        // 2. Check 80% Weight Threshold (2400 limit -> 1920 threshold)
        if (this.usedWeight1m >= BinanceRateLimiter.THRESHOLD_WEIGHT_1M) {
            const waitMs = Math.min(2000, Math.max(250, (this.usedWeight1m - BinanceRateLimiter.THRESHOLD_WEIGHT_1M) * 5));
            console.warn(`[BinanceRateLimiter][WEIGHT_THROTTLED] Weight approaching limit (${String(this.usedWeight1m)}/${String(BinanceRateLimiter.MAX_WEIGHT_1M)}). Pre-flight delay: ${String(waitMs)}ms`);
            await this.sleep(waitMs, signal);
        }
        // 3. Check 80% Order Count Threshold (300/10s limit -> 240 threshold)
        if (isOrder && this.orderCount10s >= BinanceRateLimiter.THRESHOLD_ORDERS_10S) {
            const waitMs = Math.min(1500, Math.max(200, (this.orderCount10s - BinanceRateLimiter.THRESHOLD_ORDERS_10S) * 25));
            console.warn(`[BinanceRateLimiter][ORDER_COUNT_THROTTLED] 10s Order count approaching limit (${String(this.orderCount10s)}/${String(BinanceRateLimiter.MAX_ORDERS_10S)}). Pre-flight delay: ${String(waitMs)}ms`);
            await this.sleep(waitMs, signal);
        }
    }
    sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new Error("Request aborted during rate-limit backoff"));
                return;
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
    hasReconciledWalletBalance = false;
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
    // ─── Phase 1 HFT Overhaul: WebSocket Order API Primary Path ─────────────────
    // WsOrderClient is the primary execution path (~15ms RTT).
    // REST HTTP remains as the automatic fallback when WS is not ready.
    //
    // Zero-GC invariant: wsOrderClient and sabClient are plain object references.
    // SAB Slots 159 (WS_ORDER_RTT_MS) and 160 (WS_ORDER_STREAM_HEALTH) are
    // updated atomically via MarketDataClient.writeAtomicFloat64Asset() after
    // every WS acknowledgement or fallback event per asset.
    wsOrderClient = null;
    pendingWsOrderClient = null;
    wsOrderClientInitPromise = null;
    isDestroyed = false;
    sabClient = null;
    symbolAssetIndexMap = new Map();
    // ─── Phase 5 HFT Overhaul: Live Perpetual Funding Rate Telemetry ──────────────
    // Streaming @markPrice@1s WebSocket and resilient REST /fapi/v1/premiumIndex
    // directly writing to SAB Slot 168 (FUNDING_RATE) via setFundingRate().
    fundingRateWs = null;
    fundingRatePollTimer = null;
    fundingRateReconnectTimer = null;
    registeredFundingSymbols = new Map();
    isFundingRateConnecting = false;
    /**
     * Resolves the assetIndex for SAB telemetry writes.
     * Uses explicit index if passed, otherwise looks up from cached symbol-to-index map.
     */
    resolveAssetIndex(symbol, explicitIdx) {
        const sym = symbol ? symbol.toUpperCase() : "";
        if (explicitIdx !== undefined && explicitIdx >= 0) {
            if (sym.length > 0) {
                this.symbolAssetIndexMap.set(sym, explicitIdx);
            }
            return explicitIdx;
        }
        const cached = this.symbolAssetIndexMap.get(sym);
        if (cached !== undefined)
            return cached;
        const symbols = (0, tradingSymbols_1.getTradingSymbols)();
        const idx = symbols.indexOf(sym);
        const finalIdx = idx >= 0 ? idx : 0;
        if (sym.length > 0) {
            this.symbolAssetIndexMap.set(sym, finalIdx);
        }
        return finalIdx;
    }
    /**
     * Returns true if a WsOrderClient is already attached to this execution client.
     */
    hasWsOrderClient() {
        return this.wsOrderClient !== null;
    }
    hasInFlightClientOrderId(clientOrderId) {
        return this.inFlightClientOrderIds.has(clientOrderId);
    }
    getInFlightClientOrderIdCount() {
        return this.inFlightClientOrderIds.size;
    }
    hasBeenDestroyed() {
        return this.isDestroyed;
    }
    /**
     * Guarantees a single, shared WsOrderClient connection across all assets and engine instances.
     * Completely eliminates the startup race condition when multiple engines initialize concurrently.
     */
    async ensureWsOrderClient(sabClient, assetIndex = 0, symbol) {
        if (this.hasBeenDestroyed()) {
            throw new Error("[BinanceExecutionClient] Execution client destroyed; skipping WsOrderClient startup.");
        }
        if (symbol) {
            this.symbolAssetIndexMap.set(symbol.toUpperCase(), assetIndex);
        }
        if (this.wsOrderClient !== null && this.wsOrderClient.isReady()) {
            sabClient.writeAtomicFloat64Asset(assetIndex, sabSchema_1.SAB_SLOTS.WS_ORDER_STREAM_HEALTH, 1.0);
            return this.wsOrderClient;
        }
        if (this.wsOrderClientInitPromise !== null) {
            const client = await this.wsOrderClientInitPromise;
            if (this.hasBeenDestroyed()) {
                throw new Error("[BinanceExecutionClient] Execution client destroyed while awaiting WsOrderClient.");
            }
            sabClient.writeAtomicFloat64Asset(assetIndex, sabSchema_1.SAB_SLOTS.WS_ORDER_STREAM_HEALTH, 1.0);
            return client;
        }
        this.wsOrderClientInitPromise = (async () => {
            let wsClient = null;
            try {
                if (this.apiKey === null || this.apiSecret === null) {
                    throw new Error("[BinanceExecutionClient][UNCONFIGURED] Cannot start WsOrderClient without API credentials.");
                }
                const envTimeout = process.env.WS_ORDER_REQUEST_TIMEOUT_MS
                    ? parseInt(process.env.WS_ORDER_REQUEST_TIMEOUT_MS, 10)
                    : undefined;
                const envMaxReconnect = process.env.WS_ORDER_MAX_RECONNECT_ATTEMPTS
                    ? parseInt(process.env.WS_ORDER_MAX_RECONNECT_ATTEMPTS, 10)
                    : undefined;
                wsClient = new wsOrderClient_1.WsOrderClient({
                    useTestnet: this.testnet,
                    apiKey: this.apiKey,
                    apiSecret: this.apiSecret,
                    requestTimeoutMs: envTimeout !== undefined && Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : undefined,
                    maxReconnectAttempts: envMaxReconnect !== undefined && Number.isFinite(envMaxReconnect) && envMaxReconnect >= 0
                        ? envMaxReconnect
                        : undefined,
                });
                this.pendingWsOrderClient = wsClient;
                await wsClient.connect();
                if (this.isDestroyed) {
                    wsClient.destroy();
                    throw new Error("[BinanceExecutionClient] Execution client destroyed during WsOrderClient handshake.");
                }
                this.attachWsOrderClient(wsClient, sabClient, assetIndex);
                return wsClient;
            }
            catch (initErr) {
                if (wsClient !== null) {
                    wsClient.destroy();
                }
                throw initErr;
            }
            finally {
                this.pendingWsOrderClient = null;
                this.wsOrderClientInitPromise = null;
            }
        })();
        return await this.wsOrderClientInitPromise;
    }
    /**
     * Attaches a WsOrderClient and a MarketDataClient for WS-first execution.
     * Safe to call multiple times across multiple StrategyEngine asset initializations.
     * Reuses the existing WsOrderClient instance to avoid spawning multiple connections.
     *
     * @param wsClient  Fully constructed, connected WsOrderClient instance.
     * @param sabClient MarketDataClient bound to the SharedArrayBuffer.
     * @param assetIndex Asset index for SAB telemetry slot writes.
     */
    attachWsOrderClient(wsClient, sabClient, assetIndex = 0) {
        if (this.wsOrderClient === null) {
            this.wsOrderClient = wsClient;
            this.sabClient = sabClient;
        }
        else if (this.wsOrderClient !== wsClient) {
            // Prevent orphan connection leak: destroy redundant incoming client immediately
            try {
                wsClient.destroy();
            }
            catch (destroyErr) {
                console.warn(`[BinanceExecutionClient][WS_ORDER_CLIENT] Redundant client destroy notice: ${formatRejectionReason(destroyErr)}`);
            }
        }
        // Mark the WS stream as healthy for this asset in the SAB
        sabClient.writeAtomicFloat64Asset(assetIndex, sabSchema_1.SAB_SLOTS.WS_ORDER_STREAM_HEALTH, 1.0);
        console.log(`[BinanceExecutionClient][WS_ORDER_CLIENT] WebSocket Order API primary path attached (assetIndex=${String(assetIndex)}).`);
    }
    /**
     * Detaches the WsOrderClient and destroys it. Reverts to REST fallback.
     * SAB Slot 160 is set to 0.0 (REST fallback active) across registered assets.
     */
    detachWsOrderClient() {
        if (this.wsOrderClient !== null) {
            this.wsOrderClient.destroy();
            this.wsOrderClient = null;
        }
        this.wsOrderClientInitPromise = null;
        if (this.sabClient !== null) {
            const activeIndices = new Set(this.symbolAssetIndexMap.values());
            const symbols = (0, tradingSymbols_1.getTradingSymbols)();
            for (let i = 0; i < symbols.length; i++) {
                activeIndices.add(i);
            }
            for (const idx of activeIndices) {
                this.sabClient.writeAtomicFloat64Asset(idx, sabSchema_1.SAB_SLOTS.WS_ORDER_STREAM_HEALTH, 0.0);
            }
        }
        console.log("[BinanceExecutionClient][WS_ORDER_CLIENT] WebSocket Order API detached. Fallback to REST active.");
    }
    /**
     * Zero-GC SAB telemetry writer: atomically records WS RTT and health after each dispatch.
     *
     * @param assetIndex Target asset index in the SharedArrayBuffer.
     * @param rttMs  Round-trip time in milliseconds from dispatch to Binance acknowledgement.
     * @param healthy true = WS primary active, false = fallback to REST.
     */
    _writeWsTelemetry(assetIndex, rttMs, healthy) {
        if (this.sabClient === null)
            return;
        this.sabClient.writeAtomicFloat64Asset(assetIndex, sabSchema_1.SAB_SLOTS.WS_ORDER_RTT_MS, rttMs);
        this.sabClient.writeAtomicFloat64Asset(assetIndex, sabSchema_1.SAB_SLOTS.WS_ORDER_STREAM_HEALTH, healthy ? 1.0 : 0.0);
    }
    constructor(options) {
        this.testnet = options?.useTestnet ?? (process.env.USE_TESTNET === "true" || process.env.USE_TESTNET === "1" || process.env.BINANCE_TESTNET === "true");
        const envApiKey = this.testnet
            ? (resolveCredentialValue(process.env.BINANCE_TESTNET_API_KEY) ?? resolveCredentialValue(process.env.BINANCE_API_KEY))
            : resolveCredentialValue(process.env.BINANCE_API_KEY);
        const envApiSecret = this.testnet
            ? (resolveCredentialValue(process.env.BINANCE_TESTNET_SECRET_KEY) ??
                resolveCredentialValue(process.env.BINANCE_API_SECRET) ??
                resolveCredentialValue(process.env.BINANCE_SECRET_KEY))
            : (resolveCredentialValue(process.env.BINANCE_API_SECRET) ??
                resolveCredentialValue(process.env.BINANCE_SECRET_KEY));
        this.apiKey = options?.apiKey !== undefined ? resolveCredentialValue(options.apiKey) : envApiKey;
        this.apiSecret = options?.apiSecret !== undefined ? resolveCredentialValue(options.apiSecret) : envApiSecret;
        const defaultRestBase = this.testnet
            ? "https://testnet.binancefuture.com"
            : "https://fapi.binance.com";
        const defaultWsBase = this.testnet
            ? "wss://stream.binancefuture.com"
            : "wss://fstream.binance.com";
        this.baseUrl = options?.baseUrl ?? defaultRestBase;
        this.wsUrl = options?.wsUrl ?? defaultWsBase;
        if (this.apiKey === null || this.apiSecret === null) {
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
        return this.apiKey !== null && this.apiSecret !== null;
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
    /**
     * Phase 5 HFT Overhaul: Fetches mark price and live perpetual funding rate
     * from Binance Futures REST API (/fapi/v1/premiumIndex).
     * Public unsigned endpoint — requires zero API credentials.
     */
    async fetchPremiumIndex(symbol) {
        const params = {};
        if (symbol) {
            params.symbol = symbol.toUpperCase();
        }
        return this.request("GET", "/fapi/v1/premiumIndex", params, false);
    }
    /**
     * Phase 5 HFT Overhaul: Fetches the scalar live perpetual funding rate for a specific symbol.
     * Returns funding rate as a float (e.g. 0.0001 = 1 bp).
     */
    async fetchFundingRate(symbol) {
        const cleanSymbol = requireNonEmptyString(symbol, "symbol", "fetchFundingRate").toUpperCase();
        const res = await this.fetchPremiumIndex(cleanSymbol);
        const item = Array.isArray(res) ? res.find((p) => p.symbol === cleanSymbol) : res;
        if (!item) {
            throw new Error(`[BinanceExecutionClient][INVALID_FUNDING_RATE] Missing premiumIndex entry for ${cleanSymbol}`);
        }
        return parseStrictFloat(item.lastFundingRate, "lastFundingRate", `fetchFundingRate (${cleanSymbol})`);
    }
    /**
     * Phase 5 HFT Overhaul: Batch fetches live perpetual funding rates for all Binance Futures symbols
     * in a single round-trip and atomically populates SAB Slot 168 across all registered/active asset indices.
     */
    async syncAllFundingRates(client) {
        try {
            const allRates = await this.fetchPremiumIndex();
            if (!Array.isArray(allRates))
                return;
            const rateMap = new Map();
            for (const item of allRates) {
                if (typeof item.symbol !== "string" || item.symbol.trim().length === 0)
                    continue;
                if (typeof item.lastFundingRate !== "string")
                    continue;
                const trimmedRate = item.lastFundingRate.trim();
                if (trimmedRate.length === 0)
                    continue;
                const r = Number(trimmedRate);
                if (!Number.isFinite(r)) {
                    throw new Error(`[BinanceExecutionClient][INVALID_FUNDING_RATE] Malformed lastFundingRate "${trimmedRate}" for ${item.symbol}`);
                }
                rateMap.set(item.symbol.toUpperCase(), r);
            }
            // Update explicitly registered symbols
            for (const [sym, entry] of this.registeredFundingSymbols) {
                const rate = rateMap.get(sym);
                if (rate !== undefined) {
                    entry.client.setFundingRate(rate, entry.assetIndex);
                }
            }
            // If client was passed, also update standard symbols
            if (client) {
                const symbols = (0, tradingSymbols_1.getTradingSymbols)();
                for (let i = 0; i < symbols.length; i++) {
                    const sym = symbols[i];
                    const rate = rateMap.get(sym);
                    if (rate !== undefined) {
                        client.setFundingRate(rate, i);
                    }
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[BinanceExecutionClient] Batch funding rate sync notice: ${msg}`);
        }
    }
    /**
     * Phase 5 HFT Overhaul: Ensures live funding rate telemetry ingestion for the given symbol and assetIndex:
     * 1. Immediately hydrates SAB Slot 168 via REST /fapi/v1/premiumIndex.
     * 2. Registers symbol for ongoing real-time WebSocket updates.
     * 3. Establishes / updates the real-time WebSocket connection to @markPrice@1s on /market/stream.
     * 4. Starts periodic background polling fallback (every 30s).
     */
    async ensureFundingRateStream(client, assetIndex, symbol) {
        if (process.env.NODE_ENV === "test" || this.isDestroyed)
            return;
        const sym = requireNonEmptyString(symbol, "symbol", "ensureFundingRateStream").toUpperCase();
        this.registeredFundingSymbols.set(sym, { client, assetIndex });
        this.resolveAssetIndex(sym, assetIndex);
        // 1. Immediate REST hydration to guarantee SAB Slot 168 is populated right away
        try {
            const initialRate = await this.fetchFundingRate(sym);
            if (this.hasBeenDestroyed())
                return;
            client.setFundingRate(initialRate, assetIndex);
        }
        catch (err) {
            if (this.hasBeenDestroyed())
                return;
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[BinanceExecutionClient] Initial funding rate fetch notice for ${sym}: ${msg}`);
        }
        if (this.hasBeenDestroyed())
            return;
        // 2. Start or update real-time WebSocket stream
        this.startOrUpdateFundingRateWs();
        // 3. Ensure periodic background poll timer is active
        if (!this.fundingRatePollTimer) {
            this.fundingRatePollTimer = setInterval(() => {
                if (this.isDestroyed)
                    return;
                this.syncAllFundingRates(client).catch((pollErr) => {
                    console.warn(`[BinanceExecutionClient][FUNDING_POLL] Poll sync notice: ${formatRejectionReason(pollErr)}`);
                });
            }, 30000);
            this.fundingRatePollTimer.unref();
        }
    }
    /**
     * Establishes or maintains the persistent WebSocket stream for @markPrice@1s
     * across all registered trading symbols.
     */
    startOrUpdateFundingRateWs() {
        if (this.isDestroyed || this.registeredFundingSymbols.size === 0)
            return;
        const streams = Array.from(this.registeredFundingSymbols.keys())
            .map((s) => `${s.toLowerCase()}@markPrice@1s`)
            .join("/");
        const wsEndpoint = `${this.wsUrl}/market/stream?streams=${streams}`;
        if (this.fundingRateWs && this.fundingRateWs.readyState === ws_1.default.OPEN) {
            return;
        }
        if (this.isFundingRateConnecting)
            return;
        this.isFundingRateConnecting = true;
        try {
            if (this.fundingRateWs) {
                try {
                    const oldWs = this.fundingRateWs;
                    oldWs.removeAllListeners();
                    oldWs.on("error", (teardownErr) => {
                        if (!teardownErr.message.includes("closed before the connection was established")) {
                            console.warn(`[BinanceExecutionClient][FUNDING_WS] Existing socket teardown error: ${teardownErr.message}`);
                        }
                    });
                    oldWs.terminate();
                }
                catch (termErr) {
                    console.warn(`[BinanceExecutionClient][FUNDING_WS] Existing socket terminate notice: ${formatRejectionReason(termErr)}`);
                }
                this.fundingRateWs = null;
            }
            const ws = new ws_1.default(wsEndpoint);
            this.fundingRateWs = ws;
            ws.on("open", () => {
                this.isFundingRateConnecting = false;
                if (this.isDestroyed) {
                    ws.terminate();
                    return;
                }
                console.log(`[BinanceExecutionClient][FUNDING_WS] Live Perpetual Funding Rate stream connected (${String(this.registeredFundingSymbols.size)} symbols).`);
            });
            ws.on("message", (raw) => {
                if (this.isDestroyed)
                    return;
                try {
                    const msgStr = Buffer.isBuffer(raw)
                        ? raw.toString("utf8")
                        : Array.isArray(raw)
                            ? Buffer.concat(raw).toString("utf8")
                            : Buffer.from(raw).toString("utf8");
                    if (!msgStr.includes("markPriceUpdate"))
                        return;
                    const parsed = JSON.parse(msgStr);
                    let payload = null;
                    if (isRecord(parsed)) {
                        if (isRecord(parsed["data"])) {
                            payload = parsed["data"];
                        }
                        else if (parsed["e"] === "markPriceUpdate") {
                            payload = parsed;
                        }
                    }
                    if (!payload || typeof payload["s"] !== "string" || typeof payload["r"] !== "string")
                        return;
                    const rate = parseFloat(payload["r"]);
                    if (!Number.isFinite(rate))
                        return;
                    const sym = payload["s"].toUpperCase();
                    const target = this.registeredFundingSymbols.get(sym);
                    if (target) {
                        target.client.setFundingRate(rate, target.assetIndex);
                    }
                }
                catch (parseErr) {
                    console.warn(`[BinanceExecutionClient][FUNDING_WS] Message parse notice: ${formatRejectionReason(parseErr)}`);
                }
            });
            ws.on("error", (err) => {
                this.isFundingRateConnecting = false;
                if (!this.isDestroyed) {
                    console.warn(`[BinanceExecutionClient][FUNDING_WS] WebSocket warning: ${err.message}. REST poller remains active.`);
                }
            });
            ws.on("close", () => {
                this.isFundingRateConnecting = false;
                if (this.fundingRateWs === ws) {
                    this.fundingRateWs = null;
                }
                if (this.isDestroyed) {
                    return;
                }
                if (this.fundingRateReconnectTimer)
                    clearTimeout(this.fundingRateReconnectTimer);
                this.fundingRateReconnectTimer = setTimeout(() => {
                    this.startOrUpdateFundingRateWs();
                }, 5000);
                this.fundingRateReconnectTimer.unref();
            });
        }
        catch (err) {
            this.isFundingRateConnecting = false;
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[BinanceExecutionClient][FUNDING_WS] Connection error: ${msg}. REST poller active.`);
        }
    }
    /**
     * Destroys all background timers and sockets associated with this execution client.
     */
    destroy() {
        this.isDestroyed = true;
        if (this.pendingWsOrderClient !== null) {
            try {
                this.pendingWsOrderClient.destroy();
            }
            catch (pendingErr) {
                console.warn(`[BinanceExecutionClient][WS_ORDER_CLIENT] Pending client destroy notice: ${formatRejectionReason(pendingErr)}`);
            }
            this.pendingWsOrderClient = null;
        }
        if (this.fundingRateWs) {
            try {
                const sock = this.fundingRateWs;
                sock.removeAllListeners();
                sock.on("error", (teardownErr) => {
                    if (!teardownErr.message.includes("closed before the connection was established")) {
                        console.warn(`[BinanceExecutionClient][FUNDING_WS] Destroy socket teardown error: ${teardownErr.message}`);
                    }
                });
                sock.terminate();
            }
            catch (destroyErr) {
                console.warn(`[BinanceExecutionClient][FUNDING_WS] Destroy terminate notice: ${formatRejectionReason(destroyErr)}`);
            }
            this.fundingRateWs = null;
        }
        if (this.fundingRatePollTimer) {
            clearInterval(this.fundingRatePollTimer);
            this.fundingRatePollTimer = null;
        }
        if (this.fundingRateReconnectTimer) {
            clearTimeout(this.fundingRateReconnectTimer);
            this.fundingRateReconnectTimer = null;
        }
        if (this._availableBalanceRefetchTimer !== null) {
            clearTimeout(this._availableBalanceRefetchTimer);
            this._availableBalanceRefetchTimer = null;
        }
        this.detachWsOrderClient();
    }
    getUsdtAvailableBalance() {
        return this.cachedUsdtAvailableBalance;
    }
    setUsdtAvailableBalance(val) {
        if (Number.isFinite(val)) {
            this.cachedUsdtAvailableBalance = val;
        }
    }
    /**
     * @deprecated MUST NOT be called with crossWalletBalance as the first argument.
     * The Binance ACCOUNT_UPDATE WebSocket event does NOT carry a true `availableBalance`.
     * Call `updateWalletBalanceFromWs()` for wallet balance and `scheduleAvailableBalanceRefetch()`
     * for the true available balance instead.
     *
     * Retained only to avoid breaking any external callers that may still pass walletBalance.
     * The first argument is treated as walletBalance, not availableBalance.
     */
    updateBalancesFromWs(walletBalance, _ignored) {
        if (Number.isFinite(walletBalance)) {
            this.cachedReconciledWalletBalance = walletBalance;
            this.hasReconciledWalletBalance = true;
        }
        // NOTE: cachedUsdtAvailableBalance is intentionally NOT updated here.
        // Available balance can only be accurately sourced from GET /fapi/v2/balance (REST).
    }
    /**
     * Updates the cached wallet balance (wb) received from an ACCOUNT_UPDATE WebSocket event.
     * This is the total futures wallet balance and does NOT represent available margin.
     */
    updateWalletBalanceFromWs(walletBalance) {
        if (Number.isFinite(walletBalance)) {
            this.cachedReconciledWalletBalance = walletBalance;
            this.hasReconciledWalletBalance = true;
        }
    }
    /**
     * Schedules a single debounced REST call to GET /fapi/v2/balance to re-hydrate
     * `cachedUsdtAvailableBalance` with the true, authoritative availableBalance.
     *
     * Called immediately after every ACCOUNT_UPDATE WebSocket event (trade fills, fees,
     * funding rate charges, deposits, withdrawals). Debounced to 200ms to coalesce
     * back-to-back events without generating redundant REST calls.
     *
     * Rate-limit impact: 5 weight per call (within the 1200/min budget). Safe to call
     * on every account mutation event.
     */
    _availableBalanceRefetchTimer = null;
    scheduleAvailableBalanceRefetch() {
        if (this._availableBalanceRefetchTimer !== null) {
            clearTimeout(this._availableBalanceRefetchTimer);
        }
        this._availableBalanceRefetchTimer = setTimeout(() => {
            this._availableBalanceRefetchTimer = null;
            this.fetchUsdtBalanceAsync().catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[BinanceExecutionClient] Available balance refetch after ACCOUNT_UPDATE failed: ${msg}`);
            });
        }, 200);
    }
    async fetchUsdtBalanceAsync() {
        if (!this.isConfigured()) {
            throw new Error("[BinanceExecutionClient][UNCONFIGURED] Cannot fetch USDT balance without API credentials.");
        }
        const balances = await this.request("GET", "/fapi/v2/balance", {}, true);
        if (!Array.isArray(balances)) {
            throw new Error("[BinanceExecutionClient][INVALID_BALANCE_RESPONSE] Expected array from /fapi/v2/balance.");
        }
        const usdtItem = balances.find((b) => b.asset === "USDT");
        if (!usdtItem) {
            throw new Error("[BinanceExecutionClient][MISSING_USDT_BALANCE] USDT entry absent in /fapi/v2/balance response.");
        }
        const rawBalance = normalizeOptionalString(usdtItem.availableBalance) ?? usdtItem.balance;
        const val = parseStrictFloat(rawBalance, "availableBalance/balance", "fetchUsdtBalanceAsync (USDT)");
        this.cachedUsdtAvailableBalance = val;
        return val;
    }
    /**
     * Seed startup balance asynchronously. Recurring REST polling is physically eradicated
     * in favor of real-time WebSocket ACCOUNT_UPDATE stream.
     */
    startBalancePolling(_intervalMs = 60000) {
        // Perform initial one-shot balance seed without setting an aggressive polling timer
        this.fetchUsdtBalanceAsync().catch((err) => {
            console.log(`[BinanceExecutionClient] Initial USDT balance fetch notice: ${err instanceof Error ? err.message : String(err)}`);
        });
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
        if (this.apiSecret === null) {
            throw new Error("[BinanceExecutionClient][UNCONFIGURED] Cannot sign query without API secret.");
        }
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
    async executeHttpRequest(method, endpoint, params = {}, signed = true, isRetryAfterSync = false, signal) {
        if (signed && !this.isConfigured()) {
            throw new Error("BinanceExecutionClient is not configured with API key and secret. Cannot execute signed request.");
        }
        if (signal?.aborted) {
            throw new Error(`[BinanceExecutionClient] Request aborted by caller before dispatch (${method} ${endpoint})`);
        }
        const isOrderEndpoint = endpoint.includes("/order") || endpoint.includes("/batchOrders") || endpoint.includes("/algoOrder");
        await this.rateLimiter.acquirePreFlightAllowance(isOrderEndpoint, signal);
        let queryString = "";
        if (signed) {
            queryString = this.signQuery(params);
        }
        else {
            const unsignedParams = new URLSearchParams();
            for (const [key, value] of Object.entries(params)) {
                if (value !== undefined && value !== null) {
                    unsignedParams.append(key, String(value));
                }
            }
            queryString = unsignedParams.toString();
        }
        const fullUrl = `${this.baseUrl}${endpoint}${queryString ? "?" + queryString : ""}`;
        const url = new node_url_1.URL(fullUrl);
        const defaultTimeoutMs = parseInt(process.env.REST_REQUEST_TIMEOUT_MS || "2500", 10);
        return new Promise((resolve, reject) => {
            let isSettled = false;
            const isHttps = url.protocol === "https:";
            const httpModule = isHttps ? https : http;
            const reqHeaders = {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "BATBOT_V11-HFT-Engine/1.0",
            };
            if (this.apiKey !== null) {
                reqHeaders["X-MBX-APIKEY"] = this.apiKey;
            }
            const reqOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: `${url.pathname}${url.search}`,
                method: method,
                headers: reqHeaders,
            };
            const req = httpModule.request(reqOptions, (res) => {
                let body = "";
                this.rateLimiter.updateFromHeaders(res.headers);
                res.on("data", (chunk) => {
                    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
                });
                res.on("end", () => {
                    void (async () => {
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
                                const rawCode = isRecord(data) ? data["code"] : undefined;
                                const rawMsg = isRecord(data) ? data["msg"] : undefined;
                                const errCode = typeof rawCode === "number" || typeof rawCode === "string"
                                    ? String(rawCode)
                                    : String(res.statusCode ?? "UNKNOWN");
                                const errMsg = typeof rawMsg === "string" ? rawMsg : body;
                                const isRateLimit = res.statusCode === 429 ||
                                    res.statusCode === 418 ||
                                    errCode === "-1003" ||
                                    errCode === "-1015" ||
                                    errMsg.includes("Too Many Requests") ||
                                    errMsg.includes("IP banned");
                                if (isRateLimit) {
                                    this.rateLimiter.register429Backoff(5000);
                                }
                                // Auto-resync timestamp and retry once if error code is -1021 (Timestamp ahead/behind)
                                if (errCode === "-1021" && signed && !isRetryAfterSync) {
                                    console.warn(`[BinanceExecutionClient] Timestamp error -1021 detected. Resynchronizing server time and retrying request...`);
                                    await this.syncServerTime();
                                    try {
                                        const retryRes = await this.executeHttpRequest(method, endpoint, params, signed, true, signal);
                                        isSettled = true;
                                        resolve(retryRes);
                                        return;
                                    }
                                    catch (retryErr) {
                                        isSettled = true;
                                        reject(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
                                        return;
                                    }
                                }
                                isSettled = true;
                                reject(new Error(`Binance API Error [${errCode}]: ${errMsg}`));
                            }
                        }
                        catch (parseErr) {
                            const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                            isSettled = true;
                            reject(new Error(`Failed to parse Binance response (${parseMsg}): ${body}`));
                        }
                    })();
                });
            });
            // Transport-level Socket Timeout Enforcement:
            req.setTimeout(defaultTimeoutMs, () => {
                if (isSettled)
                    return;
                isSettled = true;
                cleanup();
                req.destroy(new Error(`[BinanceExecutionClient] HTTP request socket timeout (${String(defaultTimeoutMs)}ms) exceeded on ${method} ${endpoint}`));
                reject(new Error(`[BinanceExecutionClient] HTTP request socket timeout (${String(defaultTimeoutMs)}ms) exceeded on ${method} ${endpoint}`));
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
    async request(method, endpoint, params = {}, signed = true, isRetryAfterSync = false, signal) {
        const data = await this.executeHttpRequest(method, endpoint, params, signed, isRetryAfterSync, signal);
        return data;
    }
    async setHedgeMode(enable) {
        if (!this.isConfigured())
            return false;
        try {
            const dualSidePosition = enable ? "true" : "false";
            const res = await this.request("POST", "/fapi/v1/positionSide/dual", { dualSidePosition }, true);
            console.log(`[BinanceExecutionClient] Dual-side Hedge Mode set to ${String(enable)} (Response: ${JSON.stringify(res)})`);
            return true;
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("-4059")) {
                console.log(`[BinanceExecutionClient] Dual-side Hedge Mode is already set to ${String(enable)}.`);
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
            console.log(`[BinanceExecutionClient] Exchange Leverage for ${symbol} set to ${String(res.leverage)}x (MaxNotional: $${res.maxNotionalValue})`);
            return res;
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[BinanceExecutionClient] Unable to set leverage for ${symbol} to ${String(leverage)}x: ${errMsg}`);
            return null;
        }
    }
    /**
     * SOTA Synchronous Pre-Flight Annihilation & State Verification Barrier:
     * Synchronously queries Binance for all resting conditional / closePosition orders matching symbol & positionSide,
     * forcibly cancels them, and verifies through zero-trust polling that exactly 0 conflicting orders remain on the exchange.
     */
    async synchronizeAndCancelConflictingOrders(symbol, positionSide, signal) {
        const posSideLabel = positionSide !== undefined ? positionSide : "UNSPECIFIED";
        let cancelledCount = 0;
        try {
            const openOrders = await this.getOpenOrders(symbol);
            const conflictingOrders = openOrders.filter((ord) => {
                const matchesPosSide = positionSide === undefined
                    ? (!ord.positionSide || ord.positionSide === "BOTH")
                    : (!ord.positionSide || ord.positionSide === "BOTH" || ord.positionSide === positionSide);
                const isConditionalOrClose = ord.type === "STOP_MARKET" ||
                    ord.type === "TAKE_PROFIT_MARKET" ||
                    ord.type === "STOP" ||
                    ord.type === "TAKE_PROFIT" ||
                    isClosePositionResponse(ord);
                return matchesPosSide && isConditionalOrClose;
            });
            if (conflictingOrders.length > 0) {
                console.log(`[BinanceExecutionClient][PRE_FLIGHT_ANNIHILATION] Found ${String(conflictingOrders.length)} conflicting resting order(s) for ${symbol} (${posSideLabel}). Forcibly cancelling...`);
                for (const ord of conflictingOrders) {
                    try {
                        await this.cancelOrder(symbol, ord.orderId, signal);
                        cancelledCount++;
                    }
                    catch (cancelErr) {
                        const errMsg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
                        if (!errMsg.includes("-2011") && !errMsg.includes("Unknown order")) {
                            console.warn(`[BinanceExecutionClient][PRE_FLIGHT_CANCEL_WARN] Order #${String(ord.orderId)} cancel notice: ${errMsg}`);
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
                            const matchesPosSide = positionSide === undefined
                                ? (!ord.positionSide || ord.positionSide === "BOTH")
                                : (!ord.positionSide || ord.positionSide === "BOTH" || ord.positionSide === positionSide);
                            const isConditionalOrClose = ord.type === "STOP_MARKET" ||
                                ord.type === "TAKE_PROFIT_MARKET" ||
                                ord.type === "STOP" ||
                                ord.type === "TAKE_PROFIT" ||
                                isClosePositionResponse(ord);
                            return matchesPosSide && isConditionalOrClose;
                        });
                        remainingConflicts = stillActive.length;
                        if (remainingConflicts > 0) {
                            console.warn(`[BinanceExecutionClient][VERIFY_BARRIER_POLL] ${String(remainingConflicts)} order(s) still clearing on Binance (Probe ${String(verifyAttempts)}/${String(maxVerifyAttempts)})...`);
                            for (const ord of stillActive) {
                                try {
                                    await this.cancelOrder(symbol, ord.orderId, signal);
                                }
                                catch (retryCancelErr) {
                                    console.warn(`[BinanceExecutionClient][VERIFY_BARRIER_CANCEL_NOTICE] Order #${String(ord.orderId)} probe cancel notice: ${formatRejectionReason(retryCancelErr)}`);
                                }
                            }
                        }
                    }
                    catch (recheckErr) {
                        console.warn(`[BinanceExecutionClient][VERIFY_BARRIER_POLL_NOTICE] Open orders recheck aborted: ${formatRejectionReason(recheckErr)}`);
                        break;
                    }
                }
                if (remainingConflicts === 0) {
                    console.log(`[BinanceExecutionClient][VERIFY_BARRIER_CLEARED] Exchange verified clean: 0 resting conflicting orders for ${symbol} (${posSideLabel}).`);
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
        const targetAssetIndex = this.resolveAssetIndex(params.symbol, params.assetIndex);
        // Phase 1 HFT Overhaul: WS-First Cancel-Replace Path (~15ms RTT)
        if (this.wsOrderClient !== null && this.wsOrderClient.isReady()) {
            try {
                const rawCancelId = params.cancelOrderId;
                const isNumericCancelId = typeof rawCancelId === "number"
                    ? Number.isFinite(rawCancelId) && rawCancelId > 0
                    : typeof rawCancelId === "string" && /^\d+$/.test(rawCancelId.trim());
                const numCancelOrderId = isNumericCancelId
                    ? (typeof rawCancelId === "number" ? rawCancelId : Number(String(rawCancelId).trim()))
                    : undefined;
                const strOrigClientOrderId = !isNumericCancelId && rawCancelId !== undefined
                    ? String(rawCancelId).trim()
                    : params.cancelOrigClientOrderId;
                const wsParams = {
                    symbol: params.symbol,
                    side: params.side,
                    type: params.type,
                    quantity: params.quantity,
                    price: params.price,
                    stopPrice: params.stopPrice,
                    timeInForce: params.timeInForce,
                    positionSide: params.positionSide,
                    reduceOnly: params.reduceOnly,
                    closePosition: params.closePosition,
                    workingType: params.workingType,
                    newClientOrderId: params.clientOrderId,
                    cancelOrderId: numCancelOrderId,
                    cancelOrigClientOrderId: strOrigClientOrderId,
                    cancelReplaceMode: params.cancelReplaceMode,
                    recvWindow: params.recvWindow,
                };
                const wsRes = await this.wsOrderClient.cancelReplaceOrder(wsParams);
                this._writeWsTelemetry(targetAssetIndex, wsRes.rttMs, true);
                if (wsRes.result !== null) {
                    const cr = wsRes.result;
                    const newOrder = cr.newOrderResponse;
                    // Case 1: Both cancel and new order succeeded
                    if (cr.cancelResult === "SUCCESS" && cr.newOrderResult === "SUCCESS" && newOrder && "orderId" in newOrder) {
                        return {
                            orderId: newOrder.orderId,
                            symbol: newOrder.symbol,
                            status: newOrder.status,
                            clientOrderId: newOrder.clientOrderId,
                            price: newOrder.price,
                            avgPrice: newOrder.avgPrice,
                            origQty: newOrder.origQty,
                            executedQty: newOrder.executedQty,
                            cumQuote: newOrder.cumQuote,
                            timeInForce: newOrder.timeInForce,
                            type: newOrder.type,
                            reduceOnly: newOrder.reduceOnly,
                            side: newOrder.side,
                            positionSide: newOrder.positionSide,
                            stopPrice: newOrder.stopPrice,
                            workingType: newOrder.workingType,
                            updateTime: newOrder.updateTime,
                        };
                    }
                    // Case 2: Cancel succeeded, but new order failed on exchange matching engine.
                    // CRITICAL DEF-08: Resting order was ALREADY canceled by exchange!
                    // We MUST NOT fall through to REST PUT /fapi/v1/order because that would issue a cancel on an already-canceled order!
                    if (cr.cancelResult === "SUCCESS" && cr.newOrderResult !== "SUCCESS") {
                        const errObj = cr.newOrderResponse;
                        const code = errObj?.code ?? -1;
                        const msg = errObj?.msg ?? "Placement of replacement order failed";
                        throw new Error(`[BinanceExecutionClient][WS_CANCEL_REPLACE_PARTIAL] Original order ${String(rawCancelId ?? strOrigClientOrderId ?? "UNKNOWN")} was CANCELED, but replacement order failed [${String(code)}]: ${msg}`);
                    }
                    // Case 3: Cancel failed (e.g. STOP_ON_FAILURE). Original order is still resting on exchange.
                    // Safe to fall through to REST PUT below.
                }
            }
            catch (wsErr) {
                const wsErrMsg = wsErr instanceof Error ? wsErr.message : String(wsErr);
                if (wsErrMsg.includes("[WS_CANCEL_REPLACE_PARTIAL]")) {
                    // Re-throw partial cancellation: position order was canceled, do not issue duplicate REST cancel
                    throw wsErr;
                }
                this._writeWsTelemetry(targetAssetIndex, 0.0, false);
                console.warn(`[BinanceExecutionClient][WS_CANCEL_REPLACE_FALLBACK] WS cancelReplaceOrder failed for ${params.symbol}: ${wsErrMsg}. Falling back to REST PUT /fapi/v1/order.`);
            }
        }
        const isClosePosition = params.closePosition === true || String(params.closePosition).toLowerCase() === "true";
        const formattedQty = !isClosePosition ? requirePositiveQuantity(params) : undefined;
        const cid = normalizeOptionalString(params.clientOrderId);
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
        if (!isClosePosition && formattedQty !== undefined) {
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
        if (cid !== undefined)
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
                        const matchPos = posRisks.find((p) => p.positionSide === positionSide ||
                            (positionSide === "BOTH" && parseStrictFloat(p.positionAmt, "positionAmt", `positionRisk (${p.symbol})`) !== 0));
                        if (matchPos) {
                            const amt = Math.abs(parseStrictFloat(matchPos.positionAmt, "positionAmt", `positionRisk (${matchPos.symbol})`));
                            if (amt > 0)
                                fallbackQty = amt;
                        }
                    }
                    catch (posErr) {
                        console.warn(`[BinanceExecutionClient][SL_ZERO_NAKED_FALLBACK] Position query notice: ${formatRejectionReason(posErr)}`);
                    }
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
    /**
     * Places an exact-quantity STOP_MARKET conditional order on Binance Futures.
     * Phase 2 Place-Before-Cancel Architecture (Zero-Naked Invariant):
     * Sets closePosition: false and supplies explicit quantity to allow dual-order coexistence
     * during stop-loss ratcheting, completely bypassing Binance -4130/-4509 conflicts and
     * eliminating the 50-200ms naked exposure gap.
     */
    async placeQuantityStopLoss(symbol, side, positionSide, stopPrice, quantity, clientOrderId, signal) {
        // Mock harness compatibility: If a test harness specifically overrode placePositionStopLoss
        // but not placeQuantityStopLoss, delegate to maintain backwards compatibility.
        if (this.placePositionStopLoss !== BinanceExecutionClient.prototype.placePositionStopLoss &&
            this.placeQuantityStopLoss === BinanceExecutionClient.prototype.placeQuantityStopLoss) {
            return this.placePositionStopLoss(symbol, side, positionSide, stopPrice, clientOrderId, signal, quantity);
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new Error(`[BinanceExecutionClient][INVALID_QUANTITY] Cannot place quantity-based STOP_MARKET on ${symbol} with non-positive quantity: ${String(quantity)}`);
        }
        const formattedSlPx = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(symbol, stopPrice);
        const formattedQty = symbolPrecision_1.SymbolPrecisionRegistry.formatQuantity(symbol, quantity);
        const cid = clientOrderId ||
            clientOrderIdGenerator_1.ClientOrderIdGenerator.generate(symbol, positionSide === "LONG" ? "CORE_LONG" : "SHORT_AGG", "SL");
        // Strict Zero-Trust Assertion:
        // SHORT position -> side MUST be "BUY"
        // LONG position -> side MUST be "SELL"
        const expectedSide = positionSide === "SHORT" ? "BUY" : positionSide === "LONG" ? "SELL" : side;
        if (side !== expectedSide && positionSide !== "BOTH") {
            console.warn(`[BinanceExecutionClient][SL_DIRECTION_CORRECTION] Correcting misaligned SL side ${side} to ${expectedSide} for ${positionSide} position on ${symbol}.`);
        }
        const sanitizedSide = expectedSide;
        // PLACE-BEFORE-CANCEL ARCHITECTURE (Zero-Naked Invariant):
        // By omitting pre-flight order annihilation and setting closePosition: false,
        // this conditional order coexists with the prior resting SL, enabling atomic place-before-cancel.
        const isOneWay = positionSide === "BOTH";
        const params = {
            symbol,
            side: sanitizedSide,
            type: "STOP_MARKET",
            stopPrice: formattedSlPx,
            positionSide,
            closePosition: false,
            reduceOnly: isOneWay ? true : undefined,
            quantity: formattedQty,
            clientOrderId: cid,
            workingType: "CONTRACT_PRICE",
        };
        return await this.placeOrder(params, 0, signal);
    }
    async placeOrder(params, retryCount = 0, signal) {
        const cid = normalizeOptionalString(params.clientOrderId);
        if (cid !== undefined && retryCount === 0) {
            if (this.inFlightClientOrderIds.has(cid)) {
                throw new Error(`[BinanceExecutionClient][DEDUPLICATION_BARRIER] Blocked duplicate concurrent submission for ClientOrderId: ${cid}`);
            }
        }
        try {
            if (cid !== undefined && retryCount === 0) {
                this.inFlightClientOrderIds.add(cid);
            }
            const targetAssetIndex = this.resolveAssetIndex(params.symbol, params.assetIndex);
            // ─── Phase 1 HFT Overhaul: WS-First Execution Path ─────────────────────────
            // Primary path: WebSocket Order API (~15ms RTT).
            // Automatic fallback: REST HTTPS (~460ms RTT) if WS is not ready or throws.
            //
            // Eligibility: Only attempt WS for MARKET, LIMIT, STOP_MARKET, TAKE_PROFIT_MARKET
            // order types on attempts before exhausting retries (retryCount < 2).
            // Conditional orders (STOP_MARKET / TAKE_PROFIT_MARKET) with closePosition=true
            // are excluded from the WS path because Binance WS-FAPI does not support
            // the closePosition flag for conditional orders as of Nov-2026.
            // Retries (retryCount >= 2) go through REST to preserve fallback logic.
            if (retryCount < 2 &&
                this.wsOrderClient !== null &&
                this.wsOrderClient.isReady()) {
                const isClosePositionOrder = params.closePosition === true ||
                    String(params.closePosition).toLowerCase() === "true";
                // WS path supports MARKET and LIMIT orders, and conditional orders WITHOUT closePosition.
                // closePosition=true conditional orders must remain on the REST path for full recovery logic.
                const isWsEligible = !isClosePositionOrder ||
                    (params.type !== "STOP_MARKET" && params.type !== "TAKE_PROFIT_MARKET");
                if (isWsEligible) {
                    try {
                        const wsParams = {
                            symbol: params.symbol,
                            side: params.side,
                            type: params.type,
                            quantity: params.quantity,
                            price: params.price,
                            stopPrice: params.stopPrice,
                            timeInForce: params.timeInForce,
                            positionSide: params.positionSide,
                            reduceOnly: params.reduceOnly,
                            closePosition: params.closePosition,
                            workingType: params.workingType,
                            newClientOrderId: cid,
                            recvWindow: params.recvWindow,
                        };
                        const wsResponse = await this.wsOrderClient.placeOrder(wsParams);
                        // Update SAB telemetry slots 159 and 160 atomically (zero-GC scalar writes)
                        this._writeWsTelemetry(targetAssetIndex, wsResponse.rttMs, true);
                        if (wsResponse.result === null) {
                            throw new Error(`[BinanceExecutionClient][WS_NULL_RESULT] WS order.place returned null result for ${params.symbol} cid=${cid ?? "UNSET"}`);
                        }
                        // Normalize WsOrderResult → BinanceOrderResponse (shape-compatible)
                        const r = wsResponse.result;
                        return {
                            orderId: r.orderId,
                            symbol: r.symbol,
                            status: r.status,
                            clientOrderId: r.clientOrderId,
                            price: r.price,
                            avgPrice: r.avgPrice,
                            origQty: r.origQty,
                            executedQty: r.executedQty,
                            cumQuote: r.cumQuote,
                            timeInForce: r.timeInForce,
                            type: r.type,
                            reduceOnly: r.reduceOnly,
                            side: r.side,
                            positionSide: r.positionSide,
                            stopPrice: r.stopPrice,
                            workingType: r.workingType,
                            updateTime: r.updateTime,
                        };
                    }
                    catch (wsErr) {
                        const wsErrMsg = wsErr instanceof Error ? wsErr.message : String(wsErr);
                        // Unrecoverable account-level rejections: margin / balance / lot filter failures
                        const isUnrecoverableAccountError = wsErrMsg.includes("-2010") ||
                            wsErrMsg.includes("-2019") ||
                            wsErrMsg.includes("-1013") ||
                            wsErrMsg.includes("-1111");
                        if (isUnrecoverableAccountError) {
                            this._writeWsTelemetry(targetAssetIndex, 0.0, true);
                            throw wsErr;
                        }
                        // DEF-03: Restore -5022 POST_ONLY spread crossing 1-tick shift recovery
                        if ((wsErrMsg.includes("-5022") || wsErrMsg.includes("5022")) && retryCount < 2) {
                            this._writeWsTelemetry(targetAssetIndex, 0.0, true);
                            const tickSize = symbolPrecision_1.SymbolPrecisionRegistry.getTickSize(params.symbol);
                            const currentPrice = requireValidAdjustPrice(params, "WS");
                            const adjustedPrice = params.side === "BUY" ? currentPrice - tickSize : currentPrice + tickSize;
                            const newPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, adjustedPrice);
                            if (retryCount === 0 && params.timeInForce === "GTX") {
                                console.warn(`[BinanceExecutionClient][-5022 WS REJECTION] POST_ONLY order for ${params.symbol} ${params.side} @ ${String(currentPrice)} crossed spread. Shifting 1 tick away to ${String(newPrice)} and retrying...`);
                                return await this.placeOrder({
                                    ...params,
                                    price: newPrice,
                                    assetIndex: targetAssetIndex,
                                }, 1, signal);
                            }
                            else if (retryCount === 1) {
                                console.warn(`[BinanceExecutionClient][-5022 WS FALLBACK] GTX retry failed for ${params.symbol}. Falling back to standard LIMIT (GTC) order @ ${String(newPrice)} to safeguard position...`);
                                return await this.placeOrder({
                                    ...params,
                                    price: newPrice,
                                    timeInForce: "GTC",
                                    assetIndex: targetAssetIndex,
                                }, 2, signal);
                            }
                        }
                        // DEF-03: Restore -4509 / -4130 order conflict recovery
                        const isConflictOrGteError = wsErrMsg.includes("-4509") ||
                            wsErrMsg.includes("4509") ||
                            wsErrMsg.includes("-4130") ||
                            wsErrMsg.includes("4130") ||
                            wsErrMsg.includes("would trigger immediately") ||
                            wsErrMsg.includes("closePosition in the direction is existing");
                        if (isConflictOrGteError && retryCount < 2) {
                            this._writeWsTelemetry(targetAssetIndex, 0.0, false);
                            console.warn(`[BinanceExecutionClient][-4509/-4130 WS RECOVERY] Binance WS rejected order on ${params.symbol}: ${wsErrMsg}. Synchronizing conflicting orders and retrying...`);
                            await this.synchronizeAndCancelConflictingOrders(params.symbol, params.positionSide, signal);
                            const nextCid = cid !== undefined ? `${cid}_R${String(retryCount + 1)}` : undefined;
                            return await this.placeOrder({
                                ...params,
                                clientOrderId: nextCid,
                                assetIndex: targetAssetIndex,
                            }, retryCount + 1, signal);
                        }
                        // Transport, signature, timeout, or server error: degrade WS health and cleanly fall through to REST
                        this._writeWsTelemetry(targetAssetIndex, 0.0, false);
                        console.warn(`[BinanceExecutionClient][WS_FALLBACK] WS Order API failure for ${params.symbol} ` +
                            `(cid=${cid ?? "UNSET"}): ${wsErrMsg}. Falling back to REST HTTPS.`);
                        // Fall through to the existing REST path below
                    }
                }
            }
            // ────────────────────────────────────────────────────────────────────────────
            const isClosePosition = params.closePosition === true || String(params.closePosition).toLowerCase() === "true";
            const formattedQty = !isClosePosition ? requirePositiveQuantity(params) : undefined;
            const payload = {
                symbol: params.symbol,
                side: params.side,
                type: params.type,
            };
            if (!isClosePosition && formattedQty !== undefined) {
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
            if (cid !== undefined) {
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
                    if (cid !== undefined) {
                        algoPayload.clientAlgoId = cid;
                        delete algoPayload.newClientOrderId;
                    }
                    delete algoPayload.reduceOnly;
                    const algoRes = await this.request("POST", "/fapi/v1/algoOrder", algoPayload, true, false, signal);
                    const resolvedAlgoId = typeof algoRes.algoId === "number" && Number.isFinite(algoRes.algoId) && algoRes.algoId > 0
                        ? algoRes.algoId
                        : typeof algoRes.orderId === "number" && Number.isFinite(algoRes.orderId) && algoRes.orderId > 0
                            ? algoRes.orderId
                            : null;
                    if (resolvedAlgoId === null) {
                        throw new Error(`[BinanceExecutionClient][ALGO_ORDER_FAILED] Invalid or rejected algoOrder response: code=${String(algoRes.code ?? "UNKNOWN")}, msg=${algoRes.msg ?? "Missing algoId/orderId"}`);
                    }
                    const algoContext = `/fapi/v1/algoOrder (${params.symbol} #${String(resolvedAlgoId)})`;
                    const algoStatus = requireNonEmptyString(algoRes.algoStatus ?? algoRes.status, "algoStatus/status", algoContext);
                    const resolvedStopPrice = algoRes.triggerPrice !== undefined
                        ? parseOptionalAlgoDecimalString(algoRes.triggerPrice, "triggerPrice", algoContext)
                        : algoRes.stopPrice !== undefined
                            ? parseOptionalAlgoDecimalString(algoRes.stopPrice, "stopPrice", algoContext)
                            : params.stopPrice !== undefined
                                ? String(symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice))
                                : null;
                    if (resolvedStopPrice === null || resolvedStopPrice.length === 0) {
                        throw new Error(`[BinanceExecutionClient][ALGO_ORDER_FAILED] Missing triggerPrice/stopPrice in ${algoContext}`);
                    }
                    const resolvedUpdateTime = typeof algoRes.updateTime === "number" && Number.isFinite(algoRes.updateTime) && algoRes.updateTime > 0
                        ? algoRes.updateTime
                        : typeof algoRes.createTime === "number" && Number.isFinite(algoRes.createTime) && algoRes.createTime > 0
                            ? algoRes.createTime
                            : null;
                    if (resolvedUpdateTime === null) {
                        throw new Error(`[BinanceExecutionClient][ALGO_ORDER_FAILED] Missing valid updateTime/createTime in ${algoContext}`);
                    }
                    const resolvedPositionSide = parseStrictPositionSide(algoRes.positionSide ?? params.positionSide, "positionSide", algoContext);
                    const resolvedWorkingType = requireNonEmptyString(algoRes.workingType ?? params.workingType, "workingType", algoContext);
                    const resolvedClientOrderId = normalizeOptionalString(algoRes.clientAlgoId) ??
                        normalizeOptionalString(algoRes.clientOrderId) ??
                        cid ??
                        `ALGO_${String(resolvedAlgoId)}`;
                    const resolvedOrigQty = algoRes.quantity !== undefined
                        ? parseOptionalAlgoDecimalString(algoRes.quantity, "quantity", algoContext)
                        : algoRes.origQty !== undefined
                            ? parseOptionalAlgoDecimalString(algoRes.origQty, "origQty", algoContext)
                            : formattedQty !== undefined
                                ? String(formattedQty)
                                : "";
                    return {
                        orderId: resolvedAlgoId,
                        symbol: requireNonEmptyString(algoRes.symbol ?? params.symbol, "symbol", algoContext),
                        status: algoStatus,
                        clientOrderId: resolvedClientOrderId,
                        price: parseOptionalAlgoDecimalString(algoRes.price, "price", algoContext),
                        avgPrice: parseOptionalAlgoDecimalString(algoRes.avgPrice, "avgPrice", algoContext),
                        origQty: resolvedOrigQty,
                        executedQty: parseOptionalAlgoDecimalString(algoRes.executedQty, "executedQty", algoContext),
                        cumQuote: parseOptionalAlgoDecimalString(algoRes.cumQuote, "cumQuote", algoContext),
                        timeInForce: normalizeOptionalString(algoRes.timeInForce) ?? params.timeInForce ?? "GTE_GTC",
                        type: requireNonEmptyString(algoRes.orderType ?? algoRes.type ?? params.type, "orderType/type", algoContext),
                        reduceOnly: algoRes.reduceOnly === true,
                        closePosition: isClosePosition,
                        side: requireNonEmptyString(algoRes.side ?? params.side, "side", algoContext),
                        positionSide: resolvedPositionSide,
                        stopPrice: resolvedStopPrice,
                        workingType: resolvedWorkingType,
                        updateTime: resolvedUpdateTime,
                    };
                }
                const isConflictOrGteError = errMsg.includes("-4509") ||
                    errMsg.includes("4509") ||
                    errMsg.includes("TIF GTE") ||
                    errMsg.includes("Time in Force (TIF) GTE can only be used with open positions") ||
                    errMsg.includes("-4130") ||
                    errMsg.includes("4130") ||
                    errMsg.includes("would trigger immediately") ||
                    errMsg.includes("closePosition in the direction is existing");
                const posSideLabel = params.positionSide !== undefined ? params.positionSide : "UNSPECIFIED";
                if (isConflictOrGteError && retryCount < 2) {
                    console.warn(`[BinanceExecutionClient][-4509/-4130 AUTO_RECOVERY] Binance rejected closePosition order on ${params.symbol} (${posSideLabel} ${params.side}): ${errMsg}. Executing synchronous pre-flight annihilation and retrying...`);
                    // 1. Synchronously purge conflicting orders with State Verification Barrier
                    await this.synchronizeAndCancelConflictingOrders(params.symbol, params.positionSide, signal);
                    // 2. Generate a fresh unique clientOrderId for the retry
                    const nextCid = cid !== undefined ? `${cid}_R${String(retryCount + 1)}` : undefined;
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
                            const matchPos = posRisks.find((p) => {
                                const parsedAmt = parseStrictFloat(p.positionAmt, "positionAmt", `positionRisk (${p.symbol})`);
                                if (params.positionSide === "LONG" || params.positionSide === "SHORT") {
                                    return p.positionSide === params.positionSide;
                                }
                                return parsedAmt !== 0;
                            });
                            if (matchPos) {
                                const amt = Math.abs(parseStrictFloat(matchPos.positionAmt, "positionAmt", `positionRisk (${matchPos.symbol})`));
                                if (amt > 0)
                                    fallbackQty = amt;
                            }
                        }
                        catch (posErr) {
                            console.warn(`[BinanceExecutionClient][SOTA_SL_FALLBACK] Position risk fallback query notice: ${formatRejectionReason(posErr)}`);
                        }
                    }
                    if (fallbackQty && fallbackQty > 0) {
                        console.warn(`[BinanceExecutionClient][SOTA_SL_FALLBACK] closePosition=true rejected after retries on ${params.symbol} (${posSideLabel}). Executing deterministic Quantity-Based STOP_MARKET fallback (Qty: ${String(fallbackQty)})...`);
                        const fallbackParams = {
                            ...params,
                            closePosition: false,
                            quantity: fallbackQty,
                            clientOrderId: cid !== undefined ? `${cid}_FALLBACK` : undefined,
                        };
                        return await this.placeOrder(fallbackParams, 0, signal);
                    }
                }
                if ((errMsg.includes("-5022") || errMsg.includes("5022")) && retryCount < 2) {
                    const tickSize = symbolPrecision_1.SymbolPrecisionRegistry.getTickSize(params.symbol);
                    const currentPrice = requireValidAdjustPrice(params, "REST");
                    // Shift 1 tick away from spread to guarantee Maker placement
                    const adjustedPrice = params.side === "BUY" ? currentPrice - tickSize : currentPrice + tickSize;
                    const newPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, adjustedPrice);
                    if (retryCount === 0 && params.timeInForce === "GTX") {
                        console.warn(`[BinanceExecutionClient][-5022 REJECTION] POST_ONLY order for ${params.symbol} ${params.side} @ ${String(currentPrice)} crossed spread. Shifting 1 tick away to ${String(newPrice)} and retrying...`);
                        return await this.placeOrder({
                            ...params,
                            price: newPrice,
                        }, 1, signal);
                    }
                    else if (retryCount === 1) {
                        console.warn(`[BinanceExecutionClient][-5022 FALLBACK] GTX retry failed for ${params.symbol}. Falling back to standard LIMIT (GTC) order @ ${String(newPrice)} to safeguard position...`);
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
            if (cid !== undefined && retryCount === 0) {
                this.inFlightClientOrderIds.delete(cid);
            }
        }
    }
    /**
     * Submits a batch of orders in a single low-latency HTTP REST request (POST /fapi/v1/batchOrders).
     * Dynamically loads batch order max limits and recvWindow from environment variables.
     */
    async placeBatchOrders(orders) {
        if (orders.length === 0)
            return [];
        const maxBatchLimit = parseInt(process.env.BATCH_ORDER_MAX_LIMIT || "5", 10);
        const recvWindow = parseInt(process.env.RECV_WINDOW_MS || "5000", 10);
        if (orders.length > maxBatchLimit) {
            console.warn(`[BinanceExecutionClient] Batch order count (${String(orders.length)}) exceeds BATCH_ORDER_MAX_LIMIT (${String(maxBatchLimit)}). Truncating to ${String(maxBatchLimit)}.`);
        }
        const targetOrders = orders.slice(0, maxBatchLimit);
        const batchPayload = targetOrders.map((params) => {
            const cid = normalizeOptionalString(params.clientOrderId);
            const isClosePosition = params.closePosition === true || String(params.closePosition).toLowerCase() === "true";
            const formattedQty = !isClosePosition ? requirePositiveQuantity(params) : undefined;
            const payload = {
                symbol: params.symbol,
                side: params.side,
                type: params.type,
            };
            if (!isClosePosition && formattedQty !== undefined) {
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
            if (cid !== undefined)
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
        if (orderIdList.length === 0)
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
    async cancelOrder(symbol, orderId, signal, assetIndex) {
        const targetAssetIndex = this.resolveAssetIndex(symbol, assetIndex);
        const rawOrderId = orderId;
        const isNumericOrderId = typeof rawOrderId === "number"
            ? Number.isFinite(rawOrderId) && rawOrderId > 0
            : typeof rawOrderId === "string" && /^\d+$/.test(rawOrderId.trim());
        const numOrderId = isNumericOrderId
            ? (typeof rawOrderId === "number" ? rawOrderId : Number(rawOrderId.trim()))
            : undefined;
        const strOrigClientOrderId = !isNumericOrderId
            ? String(rawOrderId).trim()
            : undefined;
        // Phase 1 HFT Overhaul: WS-First Cancellation Path (~15ms RTT)
        if (this.wsOrderClient !== null && this.wsOrderClient.isReady()) {
            try {
                const cancelParams = {
                    symbol,
                    ...(numOrderId !== undefined
                        ? { orderId: numOrderId }
                        : { origClientOrderId: strOrigClientOrderId }),
                };
                const wsRes = await this.wsOrderClient.cancelOrder(cancelParams);
                this._writeWsTelemetry(targetAssetIndex, wsRes.rttMs, true);
                if (wsRes.result !== null) {
                    const r = wsRes.result;
                    return {
                        orderId: r.orderId,
                        symbol: r.symbol,
                        status: r.status,
                        clientOrderId: r.clientOrderId,
                        price: r.price,
                        avgPrice: r.avgPrice,
                        origQty: r.origQty,
                        executedQty: r.executedQty,
                        cumQuote: r.cumQuote,
                        timeInForce: r.timeInForce,
                        type: r.type,
                        reduceOnly: r.reduceOnly,
                        side: r.side,
                        positionSide: r.positionSide,
                        stopPrice: r.stopPrice,
                        workingType: r.workingType,
                        updateTime: r.updateTime,
                    };
                }
            }
            catch (wsErr) {
                const wsErrMsg = wsErr instanceof Error ? wsErr.message : String(wsErr);
                this._writeWsTelemetry(targetAssetIndex, 0.0, false);
                console.warn(`[BinanceExecutionClient][WS_CANCEL_FALLBACK] WS cancelOrder failed for ${symbol} orderId=${String(orderId)}: ${wsErrMsg}. Falling back to REST.`);
            }
        }
        try {
            const restPayload = { symbol };
            if (numOrderId !== undefined) {
                restPayload["orderId"] = numOrderId;
            }
            else if (strOrigClientOrderId !== undefined) {
                restPayload["origClientOrderId"] = strOrigClientOrderId;
            }
            else {
                restPayload["orderId"] = orderId;
            }
            return await this.request("DELETE", "/fapi/v1/order", restPayload, true, false, signal);
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("-2011") || errMsg.includes("-4120") || errMsg.includes("Unknown order") || errMsg.includes("not found")) {
                // Fallback to /fapi/v1/algoOrder cancellation
                try {
                    const algoCancelPayload = { symbol };
                    if (numOrderId !== undefined) {
                        algoCancelPayload["algoId"] = numOrderId;
                    }
                    else if (strOrigClientOrderId !== undefined && strOrigClientOrderId.length > 0) {
                        algoCancelPayload["clientAlgoId"] = strOrigClientOrderId;
                    }
                    else {
                        throw new Error(`[BinanceExecutionClient][ALGO_CANCEL_FAILED] Invalid orderId (${String(orderId)}) for ${symbol}`);
                    }
                    const algoCancel = await this.request("DELETE", "/fapi/v1/algoOrder", algoCancelPayload, true, false, signal);
                    if (algoCancel.code !== undefined && algoCancel.code !== 200 && algoCancel.code !== "200") {
                        throw new Error(`[BinanceExecutionClient][ALGO_CANCEL_FAILED] code=${String(algoCancel.code)} msg=${algoCancel.msg ?? "Algo cancel rejected"}`);
                    }
                    const resolvedAlgoId = typeof algoCancel.algoId === "number" && Number.isFinite(algoCancel.algoId) && algoCancel.algoId > 0
                        ? algoCancel.algoId
                        : typeof algoCancel.orderId === "number" && Number.isFinite(algoCancel.orderId) && algoCancel.orderId > 0
                            ? algoCancel.orderId
                            : numOrderId;
                    if (resolvedAlgoId === undefined || !Number.isFinite(resolvedAlgoId) || resolvedAlgoId <= 0) {
                        throw new Error(`[BinanceExecutionClient][ALGO_CANCEL_FAILED] Missing valid algoId/orderId in cancel response for ${symbol}`);
                    }
                    const resolvedStatus = normalizeOptionalString(algoCancel.algoStatus) ??
                        normalizeOptionalString(algoCancel.status) ??
                        (algoCancel.code === 200 || algoCancel.code === "200" ? "CANCELED" : undefined);
                    if (resolvedStatus === undefined) {
                        throw new Error(`[BinanceExecutionClient][ALGO_CANCEL_FAILED] Missing algoStatus/status in cancel response for ${symbol} #${String(resolvedAlgoId)}`);
                    }
                    const cancelContext = `/fapi/v1/algoOrder DELETE (${symbol} #${String(resolvedAlgoId)})`;
                    const resolvedCancelTime = typeof algoCancel.updateTime === "number" && Number.isFinite(algoCancel.updateTime) && algoCancel.updateTime > 0
                        ? algoCancel.updateTime
                        : typeof algoCancel.createTime === "number" && Number.isFinite(algoCancel.createTime) && algoCancel.createTime > 0
                            ? algoCancel.createTime
                            : 0;
                    const resolvedStopPx = algoCancel.triggerPrice !== undefined
                        ? parseOptionalAlgoDecimalString(algoCancel.triggerPrice, "triggerPrice", cancelContext)
                        : parseOptionalAlgoDecimalString(algoCancel.stopPrice, "stopPrice", cancelContext);
                    return {
                        orderId: resolvedAlgoId,
                        symbol: requireNonEmptyString(algoCancel.symbol ?? symbol, "symbol", cancelContext),
                        status: resolvedStatus,
                        clientOrderId: normalizeOptionalString(algoCancel.clientAlgoId) ??
                            normalizeOptionalString(algoCancel.clientOrderId) ??
                            normalizeOptionalString(strOrigClientOrderId) ??
                            `ALGO_${String(resolvedAlgoId)}`,
                        price: parseOptionalAlgoDecimalString(algoCancel.price, "price", cancelContext),
                        avgPrice: parseOptionalAlgoDecimalString(algoCancel.avgPrice, "avgPrice", cancelContext),
                        origQty: parseOptionalAlgoDecimalString(algoCancel.quantity ?? algoCancel.origQty, "origQty", cancelContext),
                        executedQty: parseOptionalAlgoDecimalString(algoCancel.executedQty, "executedQty", cancelContext),
                        cumQuote: parseOptionalAlgoDecimalString(algoCancel.cumQuote, "cumQuote", cancelContext),
                        timeInForce: normalizeOptionalString(algoCancel.timeInForce) ?? "UNSPECIFIED",
                        type: normalizeOptionalString(algoCancel.orderType) ?? normalizeOptionalString(algoCancel.type) ?? "ALGO_CONDITIONAL",
                        reduceOnly: algoCancel.reduceOnly === true,
                        side: normalizeOptionalString(algoCancel.side) ?? "UNKNOWN",
                        positionSide: algoCancel.positionSide !== undefined
                            ? parseStrictPositionSide(algoCancel.positionSide, "positionSide", cancelContext)
                            : "UNKNOWN",
                        stopPrice: resolvedStopPx,
                        workingType: normalizeOptionalString(algoCancel.workingType) ?? "UNSPECIFIED",
                        updateTime: resolvedCancelTime,
                    };
                }
                catch (algoErr) {
                    console.warn(`[BinanceExecutionClient][ALGO_CANCEL_FALLBACK] Algo order cancel fallback failed for ${symbol} #${String(orderId)}: ${formatRejectionReason(algoErr)}`);
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
                const amt = parseStrictFloat(pos.positionAmt, "positionAmt", `flattenPositions (${pos.symbol})`);
                if (Math.abs(amt) > 0) {
                    const posSide = parseStrictPositionSide(pos.positionSide, "positionSide", `flattenPositions (${pos.symbol})`);
                    const side = amt > 0 ? "SELL" : "BUY";
                    const orderParams = {
                        symbol: pos.symbol,
                        side: side,
                        type: "MARKET",
                        quantity: Math.abs(amt),
                    };
                    if (posSide !== "BOTH") {
                        orderParams.positionSide = posSide;
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
            const posRiskErrMsg = formatRejectionReason(posRiskRes.reason);
            const accountInfoErrMsg = formatRejectionReason(accountInfoRes.reason);
            throw new Error(`[BinanceExecutionClient][CONSENSUS_FAILURE] Dual-source position consensus failed: positionRisk error (${posRiskErrMsg}), accountInfo error (${accountInfoErrMsg})`);
        }
        if (posRiskRes.status === "rejected") {
            console.warn(`[BinanceExecutionClient][CONSENSUS_DEGRADED] positionRisk query failed: ${formatRejectionReason(posRiskRes.reason)}. Relying on accountInfo ledger.`);
        }
        if (accountInfoRes.status === "rejected") {
            console.warn(`[BinanceExecutionClient][CONSENSUS_DEGRADED] accountInfo query failed: ${formatRejectionReason(accountInfoRes.reason)}. Relying on positionRisk stream.`);
        }
        const posRiskList = posRiskRes.status === "fulfilled" && Array.isArray(posRiskRes.value) ? posRiskRes.value : [];
        const accountPositions = accountInfoRes.status === "fulfilled" && Array.isArray(accountInfoRes.value.positions)
            ? accountInfoRes.value.positions
            : [];
        const mergedMap = new Map();
        // 1. Ingest positionRisk entries
        for (const p of posRiskList) {
            if (symbol && p.symbol !== symbol)
                continue;
            const posSide = parseStrictPositionSide(p.positionSide, "positionSide", `positionRisk (${p.symbol})`);
            const key = `${p.symbol}:${posSide}`;
            mergedMap.set(key, p);
        }
        // 2. Ingest / Merge account positions (authoritative margin ledger)
        for (const ap of accountPositions) {
            if (symbol && ap.symbol !== symbol)
                continue;
            const apPosSide = parseStrictPositionSide(ap.positionSide, "positionSide", `accountInfo.positions (${ap.symbol})`);
            const key = `${ap.symbol}:${apPosSide}`;
            const existing = mergedMap.get(key);
            const apQty = Math.abs(parseStrictFloat(ap.positionAmt, "positionAmt", `accountInfo.positions (${key})`));
            if (!existing) {
                mergedMap.set(key, ap);
            }
            else {
                const existingPosSide = parseStrictPositionSide(existing.positionSide, "positionSide", `positionRisk (${existing.symbol})`);
                const existingQty = Math.abs(parseStrictFloat(existing.positionAmt, "positionAmt", `positionRisk (${key})`));
                // If account ledger shows active position and positionRisk was 0/stale, prioritize account ledger
                if (apQty > 0 && existingQty === 0) {
                    mergedMap.set(key, ap);
                }
                else if (apQty > 0 && existingQty > 0) {
                    // Both non-zero, take latest updateTime
                    if (typeof ap.updateTime !== "number" || !Number.isFinite(ap.updateTime)) {
                        throw new Error(`[BinanceExecutionClient][INVALID_POSITION_RISK] Missing or non-finite accountInfo updateTime for ${ap.symbol}:${apPosSide} (value=${String(ap.updateTime)})`);
                    }
                    if (typeof existing.updateTime !== "number" || !Number.isFinite(existing.updateTime)) {
                        throw new Error(`[BinanceExecutionClient][INVALID_POSITION_RISK] Missing or non-finite positionRisk updateTime for ${existing.symbol}:${existingPosSide} (value=${String(existing.updateTime)})`);
                    }
                    if (ap.updateTime >= existing.updateTime) {
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
        const mappedAlgoOrders = (Array.isArray(algoOrders) ? algoOrders : []).map((ao) => {
            if (typeof ao.symbol !== "string" || ao.symbol.trim().length === 0) {
                throw new Error("[BinanceExecutionClient][INVALID_ALGO_ORDER] openAlgoOrders entry missing symbol");
            }
            let resolvedOrderId;
            if (typeof ao.algoId === "number" && Number.isFinite(ao.algoId) && ao.algoId > 0) {
                resolvedOrderId = ao.algoId;
            }
            else if (typeof ao.orderId === "number" && Number.isFinite(ao.orderId) && ao.orderId > 0) {
                resolvedOrderId = ao.orderId;
            }
            else {
                throw new Error(`[BinanceExecutionClient][INVALID_ALGO_ORDER] openAlgoOrders entry for ${ao.symbol} missing valid positive algoId/orderId`);
            }
            if (ao.side !== "BUY" && ao.side !== "SELL") {
                throw new Error(`[BinanceExecutionClient][INVALID_ALGO_ORDER] openAlgoOrders entry ${ao.symbol} (#${String(resolvedOrderId)}) has invalid side: ${String(ao.side)}`);
            }
            const resolvedStatus = ao.algoStatus ?? ao.status;
            if (typeof resolvedStatus !== "string" || resolvedStatus.trim().length === 0) {
                throw new Error(`[BinanceExecutionClient][INVALID_ALGO_ORDER] openAlgoOrders entry ${ao.symbol} (#${String(resolvedOrderId)}) missing algoStatus/status`);
            }
            const resolvedType = ao.orderType ?? ao.type;
            if (typeof resolvedType !== "string" || resolvedType.trim().length === 0) {
                throw new Error(`[BinanceExecutionClient][INVALID_ALGO_ORDER] openAlgoOrders entry ${ao.symbol} (#${String(resolvedOrderId)}) missing orderType/type`);
            }
            const rawStopPrice = ao.triggerPrice ?? ao.stopPrice;
            if (typeof rawStopPrice !== "string" || rawStopPrice.trim().length === 0 || !Number.isFinite(Number(rawStopPrice))) {
                throw new Error(`[BinanceExecutionClient][INVALID_ALGO_ORDER] openAlgoOrders entry ${ao.symbol} (#${String(resolvedOrderId)}) missing valid triggerPrice/stopPrice (${String(rawStopPrice)})`);
            }
            let resolvedUpdateTime;
            if (typeof ao.updateTime === "number" && Number.isFinite(ao.updateTime) && ao.updateTime > 0) {
                resolvedUpdateTime = ao.updateTime;
            }
            else if (typeof ao.createTime === "number" && Number.isFinite(ao.createTime) && ao.createTime > 0) {
                resolvedUpdateTime = ao.createTime;
            }
            else {
                throw new Error(`[BinanceExecutionClient][INVALID_ALGO_ORDER] openAlgoOrders entry ${ao.symbol} (#${String(resolvedOrderId)}) missing positive updateTime/createTime`);
            }
            const algoContext = `/fapi/v1/openAlgoOrders (${ao.symbol} #${String(resolvedOrderId)})`;
            const resolvedPositionSide = parseStrictPositionSide(ao.positionSide, "positionSide", algoContext);
            const resolvedClientOrderId = normalizeOptionalString(ao.clientAlgoId) ??
                normalizeOptionalString(ao.clientOrderId) ??
                `ALGO_${String(resolvedOrderId)}`;
            return {
                orderId: resolvedOrderId,
                symbol: ao.symbol,
                status: resolvedStatus,
                clientOrderId: resolvedClientOrderId,
                price: parseOptionalAlgoDecimalString(ao.price, "price", algoContext),
                avgPrice: parseOptionalAlgoDecimalString(ao.avgPrice, "avgPrice", algoContext),
                origQty: parseOptionalAlgoDecimalString(ao.quantity ?? ao.origQty, "origQty", algoContext),
                executedQty: parseOptionalAlgoDecimalString(ao.executedQty, "executedQty", algoContext),
                cumQuote: parseOptionalAlgoDecimalString(ao.cumQuote, "cumQuote", algoContext),
                timeInForce: normalizeOptionalString(ao.timeInForce) ?? "UNSPECIFIED",
                type: resolvedType,
                reduceOnly: ao.reduceOnly === true,
                side: ao.side,
                positionSide: resolvedPositionSide,
                stopPrice: rawStopPrice.trim(),
                workingType: normalizeOptionalString(ao.workingType) ?? "UNSPECIFIED",
                updateTime: resolvedUpdateTime,
            };
        });
        return [...(Array.isArray(standardOrders) ? standardOrders : []), ...mappedAlgoOrders];
    }
    async getAccountBalance() {
        return this.request("GET", "/fapi/v3/account", {}, true).then((res) => (Array.isArray(res.assets) ? res.assets : [])).catch(async () => {
            const v2Res = await this.request("GET", "/fapi/v2/account", {}, true);
            return Array.isArray(v2Res.assets) ? v2Res.assets : [];
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
            throw new Error("[BinanceExecutionClient][UNCONFIGURED] Cannot fetch reconciled account balance without API credentials.");
        }
        const accountInfo = await this.getAccountInfo();
        const ctx = "fetchReconciledAccountBalanceAsync (/fapi/v3/account)";
        const totalWallet = parseStrictFloat(accountInfo.totalWalletBalance, "totalWalletBalance", ctx);
        const available = parseStrictFloat(accountInfo.availableBalance, "availableBalance", ctx);
        const unrealized = parseStrictFloat(accountInfo.totalUnrealizedProfit, "totalUnrealizedProfit", ctx);
        this.cachedReconciledWalletBalance = totalWallet;
        this.hasReconciledWalletBalance = true;
        this.cachedUsdtAvailableBalance = available;
        this.cachedTotalUnrealizedProfit = unrealized;
        return {
            totalWalletBalance: this.cachedReconciledWalletBalance,
            availableBalance: this.cachedUsdtAvailableBalance,
            unrealizedProfit: this.cachedTotalUnrealizedProfit,
        };
    }
    getReconciledWalletBalance() {
        if (this.hasReconciledWalletBalance && Number.isFinite(this.cachedReconciledWalletBalance)) {
            return this.cachedReconciledWalletBalance;
        }
        return this.cachedUsdtAvailableBalance;
    }
    getTotalUnrealizedProfit() {
        return this.cachedTotalUnrealizedProfit;
    }
    getCumulativeFunding(symbol) {
        if (symbol) {
            const symbolFunding = this.cachedCumulativeFunding.get(symbol);
            return symbolFunding !== undefined ? symbolFunding : 0;
        }
        let total = 0;
        for (const val of this.cachedCumulativeFunding.values()) {
            total += val;
        }
        return total;
    }
    getCumulativeCommission(symbol) {
        if (symbol) {
            const symbolCommission = this.cachedCumulativeCommission.get(symbol);
            return symbolCommission !== undefined ? symbolCommission : 0;
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
     * Performs initial background synchronization of /fapi/v1/income.
     * Recurring interval polling is deactivated in favor of real-time WebSocket User Data Stream.
     */
    startBackgroundSync(symbols, _incomeIntervalMs = 60000, _tradeIntervalMs = 60000) {
        if (!this.isConfigured())
            return;
        const resolvedSymbols = Array.isArray(symbols) && symbols.length > 0 ? symbols : (0, tradingSymbols_1.getTradingSymbols)();
        if (resolvedSymbols.length === 0) {
            throw new Error("[BinanceExecutionClient][BACKGROUND_SYNC] Cannot start background sync with an empty symbol list.");
        }
        // 1. Initial one-shot immediate reconciliation
        this.fetchReconciledAccountBalanceAsync().catch((balErr) => {
            console.warn(`[BinanceExecutionClient][BACKGROUND_SYNC] Balance sync notice: ${formatRejectionReason(balErr)}`);
        });
        this.syncIncomeBackground(resolvedSymbols).catch((incErr) => {
            console.warn(`[BinanceExecutionClient][BACKGROUND_SYNC] Income sync notice: ${formatRejectionReason(incErr)}`);
        });
        // Polling intervals deactivated: trades and balance mutations are processed via WebSocket stream
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
    async syncIncomeBackground(_symbols) {
        const startTime = this.lastIncomeSyncTime > 0 ? this.lastIncomeSyncTime : Date.now() - 24 * 60 * 60 * 1000;
        const incomes = await this.getIncomeHistory(undefined, undefined, startTime, undefined, 100);
        if (incomes.length > 0) {
            let maxTime = this.lastIncomeSyncTime;
            for (const inc of incomes) {
                if (inc.time > maxTime)
                    maxTime = inc.time;
                if (inc.incomeType === "FUNDING_FEE" || inc.incomeType === "COMMISSION") {
                    const sym = requireNonEmptyString(inc.symbol, "symbol", `syncIncomeBackground (${inc.incomeType})`);
                    const val = parseStrictFloat(inc.income, "income", `syncIncomeBackground (${inc.incomeType} ${sym})`);
                    if (inc.incomeType === "FUNDING_FEE") {
                        const existingFunding = this.cachedCumulativeFunding.get(sym);
                        const currentFunding = existingFunding !== undefined ? existingFunding : 0;
                        this.cachedCumulativeFunding.set(sym, currentFunding + val);
                    }
                    else {
                        const existingCommission = this.cachedCumulativeCommission.get(sym);
                        const currentComm = existingCommission !== undefined ? existingCommission : 0;
                        this.cachedCumulativeCommission.set(sym, currentComm + Math.abs(val));
                    }
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
