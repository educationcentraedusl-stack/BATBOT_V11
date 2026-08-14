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
const symbolPrecision_1 = require("../config/symbolPrecision");
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
    timeSyncPromise = null;
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
        if (this.timeSyncPromise) {
            return this.timeSyncPromise;
        }
        this.timeSyncPromise = (async () => {
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
            if (err.message && err.message.includes("-4059")) {
                console.log(`[BinanceExecutionClient] Dual-side Hedge Mode is already set to ${enable}.`);
                return true;
            }
            console.warn(`[BinanceExecutionClient] Unable to set Hedge Mode: ${err.message}`);
            return false;
        }
    }
    async placeOrder(params, retryCount = 0) {
        const isAlgoOrder = params.type === "STOP_MARKET" || params.type === "TAKE_PROFIT_MARKET";
        const formattedQty = symbolPrecision_1.SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity);
        const payload = {
            symbol: params.symbol,
            side: params.side,
            type: params.type,
            quantity: formattedQty,
        };
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
        if (params.closePosition !== undefined)
            payload.closePosition = params.closePosition;
        if (params.workingType !== undefined)
            payload.workingType = params.workingType;
        if (params.recvWindow !== undefined)
            payload.recvWindow = params.recvWindow;
        if (params.positionSide !== undefined)
            payload.positionSide = params.positionSide;
        // Binance API Error -1106: Parameter 'reduceonly' sent when not required.
        // In Hedge Mode (when positionSide is "LONG" or "SHORT"), reduceOnly MUST NOT be sent.
        if (params.reduceOnly !== undefined &&
            (params.positionSide === undefined || params.positionSide === "BOTH")) {
            payload.reduceOnly = params.reduceOnly;
        }
        else {
            delete payload.reduceOnly;
        }
        try {
            if (isAlgoOrder) {
                // Route conditional stop orders through /fapi/v1/algoOrder endpoint with required algoType: "CONDITIONAL" and triggerPrice
                try {
                    const algoPayload = {
                        ...payload,
                        algoType: "CONDITIONAL",
                    };
                    if (params.stopPrice !== undefined) {
                        algoPayload.triggerPrice = params.stopPrice;
                        delete algoPayload.stopPrice;
                    }
                    delete algoPayload.reduceOnly;
                    const algoRes = await this.request("POST", "/fapi/v1/algoOrder", algoPayload, true);
                    if (algoRes && (algoRes.algoId || algoRes.orderId)) {
                        return {
                            orderId: algoRes.algoId || algoRes.orderId,
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
                catch (algoErr) {
                    const algoMsg = algoErr?.message || String(algoErr);
                    if (algoMsg.includes("-4120") || algoMsg.includes("404") || algoMsg.includes("not supported")) {
                        // Fall back to standard /fapi/v1/order if algoOrder endpoint is unmapped
                        return await this.request("POST", "/fapi/v1/order", payload, true);
                    }
                    throw algoErr;
                }
            }
            return await this.request("POST", "/fapi/v1/order", payload, true);
        }
        catch (err) {
            const errMsg = err?.message || String(err);
            if (errMsg.includes("-4120") && !isAlgoOrder) {
                // Fallback to /fapi/v1/algoOrder if /fapi/v1/order threw -4120
                const algoPayload = {
                    ...payload,
                    algoType: "CONDITIONAL",
                };
                if (params.stopPrice !== undefined) {
                    algoPayload.triggerPrice = params.stopPrice;
                    delete algoPayload.stopPrice;
                }
                delete algoPayload.reduceOnly;
                const algoRes = await this.request("POST", "/fapi/v1/algoOrder", algoPayload, true);
                if (algoRes && (algoRes.algoId || algoRes.orderId)) {
                    return {
                        orderId: algoRes.algoId || algoRes.orderId,
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
                    }, 1);
                }
                else if (retryCount === 1) {
                    console.warn(`[BinanceExecutionClient][-5022 FALLBACK] GTX retry failed for ${params.symbol}. Falling back to standard LIMIT (GTC) order @ ${newPrice} to safeguard position...`);
                    return await this.placeOrder({
                        ...params,
                        price: newPrice,
                        timeInForce: "GTC",
                    }, 2);
                }
            }
            throw err;
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
        const formattedOrders = targetOrders.map((params) => {
            const formattedQty = symbolPrecision_1.SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity);
            const orderObj = {
                symbol: params.symbol,
                side: params.side,
                type: params.type,
                quantity: formattedQty,
            };
            if (params.price !== undefined)
                orderObj.price = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, params.price);
            if (params.stopPrice !== undefined)
                orderObj.stopPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice);
            if (params.type !== "MARKET" &&
                params.type !== "STOP_MARKET" &&
                params.type !== "TAKE_PROFIT_MARKET" &&
                params.timeInForce !== undefined) {
                orderObj.timeInForce = params.timeInForce;
            }
            if (params.closePosition !== undefined)
                orderObj.closePosition = params.closePosition;
            if (params.workingType !== undefined)
                orderObj.workingType = params.workingType;
            if (params.positionSide !== undefined)
                orderObj.positionSide = params.positionSide;
            if (params.reduceOnly !== undefined &&
                (params.positionSide === undefined || params.positionSide === "BOTH")) {
                orderObj.reduceOnly = params.reduceOnly;
            }
            return orderObj;
        });
        const payload = {
            batchOrders: JSON.stringify(formattedOrders),
            recvWindow,
        };
        try {
            const resList = await this.request("POST", "/fapi/v1/batchOrders", payload, true);
            return resList;
        }
        catch (err) {
            const errMsg = err?.message || String(err);
            if (errMsg.includes("-5022") || errMsg.includes("5022")) {
                console.warn(`[BinanceExecutionClient][-5022 BATCH REJECTION] Batch POST_ONLY order rejected with -5022. Retrying target orders individually with 1-tick price shift...`);
                const fallbackResults = [];
                for (const orderParams of targetOrders) {
                    try {
                        const tickSize = symbolPrecision_1.SymbolPrecisionRegistry.getTickSize(orderParams.symbol);
                        const currentPrice = orderParams.price || 0;
                        const adjustedPrice = orderParams.side === "BUY" ? currentPrice - tickSize : currentPrice + tickSize;
                        const newPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(orderParams.symbol, adjustedPrice);
                        const singleRes = await this.placeOrder({
                            ...orderParams,
                            price: newPrice,
                        });
                        fallbackResults.push(singleRes);
                    }
                    catch (itemErr) {
                        console.error(`[BinanceExecutionClient][-5022 BATCH FALLBACK ITEM FAILED] ${itemErr?.message || String(itemErr)}`);
                    }
                }
                return fallbackResults;
            }
            throw err;
        }
    }
    /**
     * Cancels a list of open orders for a symbol in a single batch request (DELETE /fapi/v1/batchOrders).
     */
    async cancelBatchOrders(symbol, orderIdList) {
        if (!symbol || !orderIdList || orderIdList.length === 0)
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
    async cancelOrder(symbol, orderId) {
        try {
            return await this.request("DELETE", "/fapi/v1/order", { symbol, orderId }, true);
        }
        catch (err) {
            const errMsg = err?.message || String(err);
            if (errMsg.includes("-2011") || errMsg.includes("-4120") || errMsg.includes("Unknown order") || errMsg.includes("not found")) {
                // Fallback to /fapi/v1/algoOrder cancellation
                try {
                    const algoCancel = await this.request("DELETE", "/fapi/v1/algoOrder", { symbol, algoId: orderId }, true);
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
                console.log(`[BinanceExecutionClient] Notice during algoOpenOrders cancellation: ${err?.message || String(err)}`);
            });
        }
        catch (err) {
            console.log(`[BinanceExecutionClient] Notice during algoOpenOrders dispatch: ${err?.message || String(err)}`);
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
    async getOpenOrders(symbol) {
        const params = {};
        if (symbol)
            params.symbol = symbol;
        const [standardOrders, algoOrders] = await Promise.all([
            this.request("GET", "/fapi/v1/openOrders", params, true).catch(() => []),
            this.request("GET", "/fapi/v1/openAlgoOrders", params, true).catch(() => []),
        ]);
        const mappedAlgoOrders = (Array.isArray(algoOrders) ? algoOrders : []).map((ao) => ({
            orderId: ao.algoId || ao.orderId,
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
        return this.request("GET", "/fapi/v2/account", {}, true);
    }
    async getOrder(symbol, orderId) {
        return this.request("GET", "/fapi/v1/order", { symbol, orderId }, true);
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
