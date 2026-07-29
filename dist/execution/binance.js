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
exports.BinanceExecutionClient = void 0;
require("dotenv/config");
const crypto = __importStar(require("node:crypto"));
const https = __importStar(require("node:https"));
const http = __importStar(require("node:http"));
const node_url_1 = require("node:url");
class BinanceExecutionClient {
    apiKey;
    apiSecret;
    baseUrl;
    wsUrl;
    testnet;
    cachedUsdtAvailableBalance = 0;
    balancePollTimer = null;
    timeOffset = 0;
    isTimeSynced = false;
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
        return this.timeOffset;
    }
    async syncServerTime() {
        try {
            const startTime = Date.now();
            const res = await this.request("GET", "/fapi/v1/time", {}, false);
            const endTime = Date.now();
            const rtt = endTime - startTime;
            if (res && typeof res.serverTime === "number") {
                this.timeOffset = res.serverTime - (startTime + Math.floor(rtt / 2));
                this.isTimeSynced = true;
                console.log(`[BinanceExecutionClient] Time synced with Binance Server. Server Time: ${res.serverTime}, Local Time: ${Date.now()}, Offset: ${this.timeOffset}ms (RTT: ${rtt}ms)`);
                return this.timeOffset;
            }
        }
        catch (err) {
            console.error(`[BinanceExecutionClient] Failed to sync Binance server time: ${err.message}`);
        }
        return this.timeOffset;
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
            // Log failure silently to background telemetry log without interrupting HFT loops
        }
        return this.cachedUsdtAvailableBalance;
    }
    startBalancePolling(intervalMs = 5000) {
        if (this.balancePollTimer)
            return;
        // Trigger initial fetch asynchronously
        this.fetchUsdtBalanceAsync().catch(() => { });
        this.balancePollTimer = setInterval(() => {
            this.fetchUsdtBalanceAsync().catch(() => { });
        }, intervalMs);
    }
    stopBalancePolling() {
        if (this.balancePollTimer) {
            clearInterval(this.balancePollTimer);
            this.balancePollTimer = null;
        }
    }
    signQuery(params) {
        const timestamp = Date.now() + this.timeOffset;
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
    async request(method, endpoint, params = {}, signed = true, isRetryAfterSync = false) {
        if (signed && !this.isConfigured()) {
            throw new Error("BinanceExecutionClient is not configured with API key and secret. Cannot execute signed request.");
        }
        const queryString = signed ? this.signQuery(params) : new URLSearchParams(params).toString();
        const fullUrl = `${this.baseUrl}${endpoint}${queryString ? "?" + queryString : ""}`;
        const url = new node_url_1.URL(fullUrl);
        return new Promise((resolve, reject) => {
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
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", async () => {
                    try {
                        const data = JSON.parse(body);
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(data);
                        }
                        else {
                            const errCode = data?.code ?? res.statusCode;
                            const errMsg = data?.msg ?? body;
                            // Auto-resync timestamp and retry once if error code is -1021 (Timestamp ahead/behind)
                            if (errCode === -1021 && signed && !isRetryAfterSync) {
                                console.warn(`[BinanceExecutionClient] Timestamp error -1021 detected. Resynchronizing server time and retrying request...`);
                                await this.syncServerTime();
                                try {
                                    const retryRes = await this.request(method, endpoint, params, signed, true);
                                    resolve(retryRes);
                                    return;
                                }
                                catch (retryErr) {
                                    reject(retryErr);
                                    return;
                                }
                            }
                            reject(new Error(`Binance API Error [${errCode}]: ${errMsg}`));
                        }
                    }
                    catch (err) {
                        reject(new Error(`Failed to parse Binance response: ${body}`));
                    }
                });
            });
            req.on("error", (err) => {
                reject(new Error(`Network error in Binance request: ${err.message}`));
            });
            req.end();
        });
    }
    async placeOrder(params) {
        const payload = {
            symbol: params.symbol,
            side: params.side,
            type: params.type,
            quantity: params.quantity,
        };
        if (params.price !== undefined)
            payload.price = params.price;
        if (params.stopPrice !== undefined)
            payload.stopPrice = params.stopPrice;
        if (params.timeInForce !== undefined)
            payload.timeInForce = params.timeInForce;
        if (params.reduceOnly !== undefined)
            payload.reduceOnly = params.reduceOnly;
        if (params.closePosition !== undefined)
            payload.closePosition = params.closePosition;
        if (params.workingType !== undefined)
            payload.workingType = params.workingType;
        if (params.recvWindow !== undefined)
            payload.recvWindow = params.recvWindow;
        return this.request("POST", "/fapi/v1/order", payload, true);
    }
    async cancelOrder(symbol, orderId) {
        return this.request("DELETE", "/fapi/v1/order", { symbol, orderId }, true);
    }
    async cancelAllOrders(symbol) {
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
                    await this.placeOrder({
                        symbol: pos.symbol,
                        side: side,
                        type: "MARKET",
                        quantity: Math.abs(amt),
                        reduceOnly: true,
                    });
                }
            }
            return true;
        }
        catch (err) {
            console.error(`[BinanceExecutionClient] flattenPositions error: ${err.message}`);
            return false;
        }
    }
    async getPositionRisk(symbol) {
        const params = {};
        if (symbol)
            params.symbol = symbol;
        return this.request("GET", "/fapi/v2/positionRisk", params, true);
    }
    async getAccountBalance() {
        return this.request("GET", "/fapi/v2/account", {}, true);
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
