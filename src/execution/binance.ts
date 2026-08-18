import "dotenv/config";
import * as crypto from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import { SymbolPrecisionRegistry } from "../config/symbolPrecision";


export interface BinanceOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
  reduceOnly?: boolean;
  closePosition?: boolean;
  workingType?: "MARKET_PRICE" | "CONTRACT_PRICE";
  recvWindow?: number;
  positionSide?: "LONG" | "SHORT" | "BOTH";
  clientOrderId?: string;
}

export interface BinanceUserTrade {
  id: number;
  symbol: string;
  orderId: number;
  side: "BUY" | "SELL";
  price: string;
  qty: string;
  realizedPnl: string;
  marginAsset: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  positionSide: "LONG" | "SHORT" | "BOTH";
  buyer: boolean;
  maker: boolean;
}

export interface BinanceOrderResponse {
  orderId: number;
  symbol: string;
  status: string;
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQuote: string;
  timeInForce: string;
  type: string;
  reduceOnly: boolean;
  side: string;
  positionSide: string;
  stopPrice: string;
  workingType: string;
  updateTime: number;
}

export interface BinanceCancelAllResponse {
  code: number;
  msg: string;
}

export interface BinancePositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  maxNotionalValue: string;
  marginType: string;
  isolatedMargin: string;
  isAutoAddMargin: string;
  positionSide: string;
  notional: string;
  isolatedWallet: string;
  updateTime: number;
}

export interface BinanceIncomeHistory {
  symbol?: string;
  incomeType: string; // "TRANSFER" | "WELCOME_BONUS" | "REALIZED_PNL" | "FUNDING_FEE" | "COMMISSION" | "INSURANCE_CLEAR" etc.
  income: string;
  asset: string;
  info?: string;
  time: number;
  tranId: number | string;
  tradeId?: string;
}

export interface BinanceAccountBalance {
  accountAlias: string;
  asset: string;
  balance: string;
  crossWalletBalance: string;
  crossUnPnl: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  marginAvailable: boolean;
  updateTime: number;
}

export interface BinanceAccountInfo {
  totalInitialMargin: string;
  totalMaintMargin: string;
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  totalPositionInitialMargin: string;
  totalOpenOrderInitialMargin: string;
  maxWithdrawAmount: string;
  availableBalance: string;
  updateTime: number;
  assets: BinanceAccountBalance[];
  positions: BinancePositionRisk[];
}

export interface BinanceClientOptions {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  wsUrl?: string;
  useTestnet?: boolean;
}

export interface BinanceSymbolFilter {
  filterType: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  notional?: string;
  minNotional?: string;
}

export interface BinanceSymbolInfo {
  symbol: string;
  pair: string;
  contractType: string;
  status: string;
  pricePrecision: number;
  quantityPrecision: number;
  filters: BinanceSymbolFilter[];
}

export interface BinanceExchangeInfoResponse {
  timezone: string;
  serverTime: number;
  symbols: BinanceSymbolInfo[];
}

export class BinanceExecutionClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private wsUrl: string;
  private testnet: boolean;
  private cachedUsdtAvailableBalance: number = 0;
  private cachedReconciledWalletBalance: number = 0;
  private cachedTotalUnrealizedProfit: number = 0;
  private balancePollTimer: NodeJS.Timeout | null = null;
  private incomeSyncTimer: NodeJS.Timeout | null = null;
  private userTradesSyncTimer: NodeJS.Timeout | null = null;
  private lastIncomeSyncTime: number = 0;
  private lastUserTradeSyncTimes: Map<string, number> = new Map();
  private cachedCumulativeFunding: Map<string, number> = new Map();
  private cachedCumulativeCommission: Map<string, number> = new Map();
  private incomeCallbacks: Set<(incomes: BinanceIncomeHistory[]) => void> = new Set();
  private userTradeCallbacks: Set<(trades: BinanceUserTrade[]) => void> = new Set();
  private timeOffset: number = 0;
  private isTimeSynced: boolean = false;
  private timeSyncPromise: Promise<number> | null = null;
  private inFlightClientOrderIds: Set<string> = new Set();

  constructor(options?: BinanceClientOptions) {
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
      console.error(
        `[CRITICAL][BinanceExecutionClient] Missing BINANCE_API_KEY or BINANCE_API_SECRET in environment variables. Execution mode: ${
          this.testnet ? "BINANCE FUTURES TESTNET" : "LIVE PRODUCTION"
        }`
      );
    }
  }

  public isTestnet(): boolean {
    return this.testnet;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public getWsUrl(): string {
    return this.wsUrl;
  }

  public isConfigured(): boolean {
    return this.apiKey.length > 0 && this.apiSecret.length > 0;
  }

  public getTimeOffset(): number {
    return this.timeOffset;
  }

  public async syncServerTime(): Promise<number> {
    if (this.timeSyncPromise) {
      return this.timeSyncPromise;
    }

    this.timeSyncPromise = (async () => {
      try {
        const startTime = Date.now();
        const res = await this.request<{ serverTime: number }>("GET", "/fapi/v1/time", {}, false);
        const endTime = Date.now();
        const rtt = endTime - startTime;
        if (res && typeof res.serverTime === "number") {
          this.timeOffset = res.serverTime - (startTime + Math.floor(rtt / 2));
          this.isTimeSynced = true;
          console.log(`[BinanceExecutionClient] Time synced with Binance Server. Server Time: ${res.serverTime}, Local Time: ${Date.now()}, Offset: ${this.timeOffset}ms (RTT: ${rtt}ms)`);
          return this.timeOffset;
        }
      } catch (err: any) {
        console.error(`[BinanceExecutionClient] Failed to sync Binance server time: ${err.message}`);
      } finally {
        this.timeSyncPromise = null;
      }
      return this.timeOffset;
    })();

    return this.timeSyncPromise;
  }

  public async fetchExchangeInfo(): Promise<BinanceExchangeInfoResponse> {
    return this.request<BinanceExchangeInfoResponse>("GET", "/fapi/v1/exchangeInfo", {}, false);
  }

  public getUsdtAvailableBalance(): number {
    return this.cachedUsdtAvailableBalance;
  }

  public async fetchUsdtBalanceAsync(): Promise<number> {
    if (!this.isConfigured()) return 0;
    try {
      const balances = await this.request<BinanceAccountBalance[]>("GET", "/fapi/v2/balance", {}, true);
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[BinanceExecutionClient] USDT balance fetch notice: ${msg}`);
    }
    return this.cachedUsdtAvailableBalance;
  }

  public startBalancePolling(intervalMs: number = 5000): void {
    if (this.balancePollTimer) return;
    // Trigger initial fetch asynchronously
    this.fetchUsdtBalanceAsync().catch((err: unknown) => {
      console.log(`[BinanceExecutionClient] Initial USDT balance fetch notice: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.balancePollTimer = setInterval(() => {
      this.fetchUsdtBalanceAsync().catch((err: unknown) => {
        console.log(`[BinanceExecutionClient] Polling USDT balance fetch notice: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
  }

  public stopBalancePolling(): void {
    if (this.balancePollTimer) {
      clearInterval(this.balancePollTimer);
      this.balancePollTimer = null;
    }
  }


  public signQuery(params: Record<string, string | number | boolean>): string {
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

  protected async request<T>(
    method: "GET" | "POST" | "DELETE" | "PUT",
    endpoint: string,
    params: Record<string, string | number | boolean> = {},
    signed: boolean = true,
    isRetryAfterSync: boolean = false
  ): Promise<T> {
    if (signed && !this.isConfigured()) {
      throw new Error(
        "BinanceExecutionClient is not configured with API key and secret. Cannot execute signed request."
      );
    }

    const queryString = signed ? this.signQuery(params) : new URLSearchParams(params as Record<string, string>).toString();
    const fullUrl = `${this.baseUrl}${endpoint}${queryString ? "?" + queryString : ""}`;
    const url = new URL(fullUrl);

    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === "https:";
      const httpModule = isHttps ? https : http;

      const reqOptions: http.RequestOptions = {
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
              resolve(data as T);
            } else {
              const errCode = data?.code ?? res.statusCode;
              const errMsg = data?.msg ?? body;
              // Auto-resync timestamp and retry once if error code is -1021 (Timestamp ahead/behind)
              if (errCode === -1021 && signed && !isRetryAfterSync) {
                console.warn(`[BinanceExecutionClient] Timestamp error -1021 detected. Resynchronizing server time and retrying request...`);
                await this.syncServerTime();
                try {
                  const retryRes = await this.request<T>(method, endpoint, params, signed, true);
                  resolve(retryRes);
                  return;
                } catch (retryErr) {
                  reject(retryErr);
                  return;
                }
              }
              reject(new Error(`Binance API Error [${errCode}]: ${errMsg}`));
            }
          } catch (err) {
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

  public async setHedgeMode(enable: boolean): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const dualSidePosition = enable ? "true" : "false";
      const res = await this.request<{ code: number; msg: string }>(
        "POST",
        "/fapi/v1/positionSide/dual",
        { dualSidePosition },
        true
      );
      console.log(`[BinanceExecutionClient] Dual-side Hedge Mode set to ${enable} (Response: ${JSON.stringify(res)})`);
      return true;
    } catch (err: any) {
      if (err.message && err.message.includes("-4059")) {
        console.log(`[BinanceExecutionClient] Dual-side Hedge Mode is already set to ${enable}.`);
        return true;
      }
      console.warn(`[BinanceExecutionClient] Unable to set Hedge Mode: ${err.message}`);
      return false;
    }
  }

  public async setLeverage(
    symbol: string,
    leverage: number
  ): Promise<{ symbol: string; leverage: number; maxNotionalValue: string } | null> {
    if (!this.isConfigured() || !symbol || leverage <= 0) return null;
    try {
      const roundedLev = Math.round(leverage);
      const res = await this.request<{ symbol: string; leverage: number; maxNotionalValue: string }>(
        "POST",
        "/fapi/v1/leverage",
        { symbol, leverage: roundedLev },
        true
      );
      console.log(`[BinanceExecutionClient] Exchange Leverage for ${symbol} set to ${res.leverage}x (MaxNotional: $${res.maxNotionalValue})`);
      return res;
    } catch (err: any) {
      console.warn(`[BinanceExecutionClient] Unable to set leverage for ${symbol} to ${leverage}x: ${err?.message || String(err)}`);
      return null;
    }
  }

  public async placeOrder(params: BinanceOrderParams, retryCount: number = 0): Promise<BinanceOrderResponse> {
    const cid = (params.clientOrderId || "").trim();
    if (cid.length > 0 && retryCount === 0) {
      if (this.inFlightClientOrderIds.has(cid)) {
        console.warn(`[BinanceExecutionClient][DEDUPLICATION_BARRIER] Blocked duplicate concurrent submission for ClientOrderId: ${cid}`);
        return null as any;
      }
      this.inFlightClientOrderIds.add(cid);
    }

    try {
      const isAlgoOrder = params.type === "STOP_MARKET" || params.type === "TAKE_PROFIT_MARKET";
      const formattedQty = SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity);
      const payload: Record<string, string | number | boolean> = {
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        quantity: formattedQty,
      };

      if (params.price !== undefined) payload.price = SymbolPrecisionRegistry.formatPrice(params.symbol, params.price);
      if (params.stopPrice !== undefined) payload.stopPrice = SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice);
      
      // Binance API Error -1106: Parameter 'timeinforce' sent when not required.
      // timeInForce MUST NOT be sent for MARKET, STOP_MARKET, or TAKE_PROFIT_MARKET orders.
      if (
        params.type !== "MARKET" &&
        params.type !== "STOP_MARKET" &&
        params.type !== "TAKE_PROFIT_MARKET" &&
        params.timeInForce !== undefined
      ) {
        payload.timeInForce = params.timeInForce;
      } else {
        delete payload.timeInForce;
      }

      if (params.closePosition !== undefined) payload.closePosition = params.closePosition;
      if (params.workingType !== undefined) payload.workingType = params.workingType;
      if (params.recvWindow !== undefined) payload.recvWindow = params.recvWindow;
      if (params.positionSide !== undefined) payload.positionSide = params.positionSide;
      if (cid.length > 0) {
        payload.newClientOrderId = cid;
      }

      // Binance API Error -1106: Parameter 'reduceonly' sent when not required.
      // In Hedge Mode (when positionSide is "LONG" or "SHORT"), reduceOnly MUST NOT be sent.
      if (
        params.reduceOnly !== undefined &&
        (params.positionSide === undefined || params.positionSide === "BOTH")
      ) {
        payload.reduceOnly = params.reduceOnly;
      } else {
        delete payload.reduceOnly;
      }

      try {
        if (isAlgoOrder) {
          // Route conditional stop orders through /fapi/v1/algoOrder endpoint with required algoType: "CONDITIONAL" and triggerPrice
          try {
            const algoPayload: Record<string, string | number | boolean> = {
              ...payload,
              algoType: "CONDITIONAL",
            };
            if (params.stopPrice !== undefined) {
              algoPayload.triggerPrice = SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice);
              delete algoPayload.stopPrice;
            }
            if (cid.length > 0) {
              algoPayload.clientAlgoId = cid;
              delete algoPayload.newClientOrderId;
            }
            delete algoPayload.reduceOnly;

            const algoRes = await this.request<any>("POST", "/fapi/v1/algoOrder", algoPayload, true);
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
            return algoRes as BinanceOrderResponse;
          } catch (algoErr: any) {
            const algoMsg = algoErr?.message || String(algoErr);
            if (algoMsg.includes("-4120") || algoMsg.includes("404") || algoMsg.includes("not supported")) {
              // Fall back to standard /fapi/v1/order if algoOrder endpoint is unmapped
              return await this.request<BinanceOrderResponse>("POST", "/fapi/v1/order", payload, true);
            }
            throw algoErr;
          }
        }

        return await this.request<BinanceOrderResponse>("POST", "/fapi/v1/order", payload, true);
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        if (errMsg.includes("-4120") && !isAlgoOrder) {
          // Fallback to /fapi/v1/algoOrder if /fapi/v1/order threw -4120
          const algoPayload: Record<string, string | number | boolean> = {
            ...payload,
            algoType: "CONDITIONAL",
          };
          if (params.stopPrice !== undefined) {
            algoPayload.triggerPrice = SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice);
            delete algoPayload.stopPrice;
          }
          delete algoPayload.reduceOnly;
          const algoRes = await this.request<any>("POST", "/fapi/v1/algoOrder", algoPayload, true);
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
          return algoRes as BinanceOrderResponse;
        }

        if ((errMsg.includes("-5022") || errMsg.includes("5022")) && retryCount < 2) {
          const tickSize = SymbolPrecisionRegistry.getTickSize(params.symbol);
          const currentPrice = params.price || 0;
          // Shift 1 tick away from spread to guarantee Maker placement
          const adjustedPrice = params.side === "BUY" ? currentPrice - tickSize : currentPrice + tickSize;
          const newPrice = SymbolPrecisionRegistry.formatPrice(params.symbol, adjustedPrice);

          if (retryCount === 0 && params.timeInForce === "GTX") {
            console.warn(`[BinanceExecutionClient][-5022 REJECTION] POST_ONLY order for ${params.symbol} ${params.side} @ ${currentPrice} crossed spread. Shifting 1 tick away to ${newPrice} and retrying...`);
            return await this.placeOrder({
              ...params,
              price: newPrice,
            }, 1);
          } else if (retryCount === 1) {
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
    } finally {
      if (cid.length > 0 && retryCount === 0) {
        this.inFlightClientOrderIds.delete(cid);
      }
    }
  }

  /**
   * Submits a batch of orders in a single low-latency HTTP REST request (POST /fapi/v1/batchOrders).
   * Dynamically loads batch order max limits and recvWindow from environment variables.
   */
  public async placeBatchOrders(orders: BinanceOrderParams[]): Promise<BinanceOrderResponse[]> {
    if (!orders || orders.length === 0) return [];
    
    const maxBatchLimit = parseInt(process.env.BATCH_ORDER_MAX_LIMIT || "5", 10);
    const recvWindow = parseInt(process.env.RECV_WINDOW_MS || "5000", 10);
    
    if (orders.length > maxBatchLimit) {
      console.warn(`[BinanceExecutionClient] Batch order count (${orders.length}) exceeds BATCH_ORDER_MAX_LIMIT (${maxBatchLimit}). Truncating to ${maxBatchLimit}.`);
    }

    const targetOrders = orders.slice(0, maxBatchLimit);
    const formattedOrders = targetOrders.map((params) => {
      const formattedQty = SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity);
      const orderObj: Record<string, string | number | boolean> = {
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        quantity: formattedQty,
      };

      if (params.price !== undefined) orderObj.price = SymbolPrecisionRegistry.formatPrice(params.symbol, params.price);
      if (params.stopPrice !== undefined) orderObj.stopPrice = SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice);
      if (params.clientOrderId !== undefined && params.clientOrderId.trim().length > 0) {
        orderObj.newClientOrderId = params.clientOrderId.trim();
      }

      if (
        params.type !== "MARKET" &&
        params.type !== "STOP_MARKET" &&
        params.type !== "TAKE_PROFIT_MARKET" &&
        params.timeInForce !== undefined
      ) {
        orderObj.timeInForce = params.timeInForce;
      }

      if (params.closePosition !== undefined) orderObj.closePosition = params.closePosition;
      if (params.workingType !== undefined) orderObj.workingType = params.workingType;
      if (params.positionSide !== undefined) orderObj.positionSide = params.positionSide;

      if (
        params.reduceOnly !== undefined &&
        (params.positionSide === undefined || params.positionSide === "BOTH")
      ) {
        orderObj.reduceOnly = params.reduceOnly;
      }

      return orderObj;
    });

    const payload = {
      batchOrders: JSON.stringify(formattedOrders),
      recvWindow,
    };

    try {
      const resList = await this.request<BinanceOrderResponse[]>("POST", "/fapi/v1/batchOrders", payload, true);
      return resList;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes("-5022") || errMsg.includes("5022")) {
        console.warn(`[BinanceExecutionClient][-5022 BATCH REJECTION] Batch POST_ONLY order rejected with -5022. Retrying target orders individually with 1-tick price shift...`);
        const fallbackResults: BinanceOrderResponse[] = [];
        for (const orderParams of targetOrders) {
          try {
            const tickSize = SymbolPrecisionRegistry.getTickSize(orderParams.symbol);
            const currentPrice = orderParams.price || 0;
            const adjustedPrice = orderParams.side === "BUY" ? currentPrice - tickSize : currentPrice + tickSize;
            const newPrice = SymbolPrecisionRegistry.formatPrice(orderParams.symbol, adjustedPrice);
            const singleRes = await this.placeOrder({
              ...orderParams,
              price: newPrice,
            });
            fallbackResults.push(singleRes);
          } catch (itemErr: any) {
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
  public async cancelBatchOrders(symbol: string, orderIdList: (number | string)[]): Promise<BinanceOrderResponse[]> {
    if (!symbol || !orderIdList || orderIdList.length === 0) return [];
    
    const recvWindow = parseInt(process.env.RECV_WINDOW_MS || "5000", 10);
    const maxBatchLimit = parseInt(process.env.BATCH_ORDER_MAX_LIMIT || "5", 10);
    const targetIds = orderIdList.slice(0, maxBatchLimit);

    const payload = {
      symbol,
      orderIdList: JSON.stringify(targetIds),
      recvWindow,
    };

    return this.request<BinanceOrderResponse[]>("DELETE", "/fapi/v1/batchOrders", payload, true);
  }

  public async cancelOrder(symbol: string, orderId: number | string): Promise<BinanceOrderResponse> {
    try {
      return await this.request<BinanceOrderResponse>(
        "DELETE",
        "/fapi/v1/order",
        { symbol, orderId },
        true
      );
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes("-2011") || errMsg.includes("-4120") || errMsg.includes("Unknown order") || errMsg.includes("not found")) {
        // Fallback to /fapi/v1/algoOrder cancellation
        try {
          const algoCancel = await this.request<any>(
            "DELETE",
            "/fapi/v1/algoOrder",
            { symbol, algoId: orderId },
            true
          );
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
        } catch (algoErr: any) {
          throw err;
        }
      }
      throw err;
    }
  }

  public async cancelAllOrders(symbol: string): Promise<BinanceCancelAllResponse> {
    try {
      await this.request<any>("DELETE", "/fapi/v1/algoOpenOrders", { symbol }, true).catch((err) => {
        console.log(`[BinanceExecutionClient] Notice during algoOpenOrders cancellation: ${err?.message || String(err)}`);
      });
    } catch (err: any) {
      console.log(`[BinanceExecutionClient] Notice during algoOpenOrders dispatch: ${err?.message || String(err)}`);
    }
    return this.request<BinanceCancelAllResponse>(
      "DELETE",
      "/fapi/v1/allOpenOrders",
      { symbol },
      true
    );
  }


  public async flattenPositions(symbol: string): Promise<boolean> {
    try {
      await this.cancelAllOrders(symbol);
      const positions = await this.getPositionRisk(symbol);
      for (const pos of positions) {
        const amt = parseFloat(pos.positionAmt || "0");
        if (Math.abs(amt) > 0) {
          const side = amt > 0 ? "SELL" : "BUY";
          const orderParams: BinanceOrderParams = {
            symbol: pos.symbol,
            side: side,
            type: "MARKET",
            quantity: Math.abs(amt),
          };
          if (pos.positionSide && pos.positionSide !== "BOTH") {
            orderParams.positionSide = pos.positionSide as "LONG" | "SHORT";
          } else {
            orderParams.reduceOnly = true;
          }
          await this.placeOrder(orderParams);
        }
      }
      return true;
    } catch (err: any) {
      console.error(`[BinanceExecutionClient] flattenPositions error: ${err.message}`);
      return false;
    }
  }

  public async getPositionRisk(symbol?: string): Promise<BinancePositionRisk[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    return this.request<BinancePositionRisk[]>("GET", "/fapi/v3/positionRisk", params, true).catch(async (err: any) => {
      // Graceful fallback to /fapi/v2/positionRisk if /fapi/v3/positionRisk is unavailable
      if (err?.message?.includes("404") || err?.message?.includes("-4120")) {
        return this.request<BinancePositionRisk[]>("GET", "/fapi/v2/positionRisk", params, true);
      }
      throw err;
    });
  }

  public async getAccountInfo(): Promise<BinanceAccountInfo> {
    return this.request<BinanceAccountInfo>("GET", "/fapi/v3/account", {}, true).catch(async (err: any) => {
      // Graceful fallback to /fapi/v2/account if /fapi/v3/account is unavailable
      if (err?.message?.includes("404") || err?.message?.includes("-4120")) {
        return this.request<BinanceAccountInfo>("GET", "/fapi/v2/account", {}, true);
      }
      throw err;
    });
  }

  /**
   * SOTA Dual-Source Consensus Position Ingestion:
   * Merges real-time /fapi/v3/positionRisk and authoritative margin ledger /fapi/v3/account in parallel.
   * Eliminates single-endpoint pagination/caching omissions across all active symbols.
   */
  public async getDualPositionRisk(symbol?: string): Promise<BinancePositionRisk[]> {
    const [posRiskRes, accountInfoRes] = await Promise.allSettled([
      this.getPositionRisk(symbol),
      this.getAccountInfo(),
    ]);

    // Strict Anti-Masking Invariant: If BOTH authoritative queries fail, throw critical consensus failure
    if (posRiskRes.status === "rejected" && accountInfoRes.status === "rejected") {
      const posRiskErr = (posRiskRes as PromiseRejectedResult).reason;
      const accountInfoErr = (accountInfoRes as PromiseRejectedResult).reason;
      throw new Error(
        `[BinanceExecutionClient][CONSENSUS_FAILURE] Dual-source position consensus failed: positionRisk error (${
          posRiskErr?.message || String(posRiskErr)
        }), accountInfo error (${accountInfoErr?.message || String(accountInfoErr)})`
      );
    }

    if (posRiskRes.status === "rejected") {
      console.warn(
        `[BinanceExecutionClient][CONSENSUS_DEGRADED] positionRisk query failed: ${
          (posRiskRes as PromiseRejectedResult).reason?.message
        }. Relying on accountInfo ledger.`
      );
    }
    if (accountInfoRes.status === "rejected") {
      console.warn(
        `[BinanceExecutionClient][CONSENSUS_DEGRADED] accountInfo query failed: ${
          (accountInfoRes as PromiseRejectedResult).reason?.message
        }. Relying on positionRisk stream.`
      );
    }

    const posRiskList: BinancePositionRisk[] =
      posRiskRes.status === "fulfilled" && Array.isArray(posRiskRes.value) ? posRiskRes.value : [];
    const accountPositions: BinancePositionRisk[] =
      accountInfoRes.status === "fulfilled" && accountInfoRes.value && Array.isArray(accountInfoRes.value.positions)
        ? accountInfoRes.value.positions
        : [];

    const mergedMap = new Map<string, BinancePositionRisk>();

    // 1. Ingest positionRisk entries
    for (const p of posRiskList) {
      if (symbol && p.symbol !== symbol) continue;
      const key = `${p.symbol}:${p.positionSide || "BOTH"}`;
      mergedMap.set(key, p);
    }

    // 2. Ingest / Merge account positions (authoritative margin ledger)
    for (const ap of accountPositions) {
      if (symbol && ap.symbol !== symbol) continue;
      const key = `${ap.symbol}:${ap.positionSide || "BOTH"}`;
      const existing = mergedMap.get(key);
      const apQty = Math.abs(parseFloat(ap.positionAmt || "0"));

      if (!existing) {
        mergedMap.set(key, ap);
      } else {
        const existingQty = Math.abs(parseFloat(existing.positionAmt || "0"));
        // If account ledger shows active position and positionRisk was 0/stale, prioritize account ledger
        if (apQty > 0 && existingQty === 0) {
          mergedMap.set(key, ap);
        } else if (apQty > 0 && existingQty > 0) {
          // Both non-zero, take latest updateTime
          if ((ap.updateTime || 0) >= (existing.updateTime || 0)) {
            mergedMap.set(key, { ...existing, ...ap });
          }
        }
      }
    }

    return Array.from(mergedMap.values());
  }

  public async getOpenOrders(symbol?: string): Promise<BinanceOrderResponse[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;

    // Standard open orders query MUST succeed; errors propagate directly to caller
    const standardOrders = await this.request<BinanceOrderResponse[]>("GET", "/fapi/v1/openOrders", params, true);

    // Open algo orders query (gracefully fall back if algo endpoint unmapped on this account/symbol)
    const algoOrders = await this.request<any[]>("GET", "/fapi/v1/openAlgoOrders", params, true).catch((err: any) => {
      const msg = err?.message || String(err);
      if (msg.includes("404") || msg.includes("-4120") || msg.includes("not supported")) {
        return [] as any[];
      }
      throw err;
    });

    const mappedAlgoOrders: BinanceOrderResponse[] = (Array.isArray(algoOrders) ? algoOrders : []).map((ao) => ({
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

  public async getAccountBalance(): Promise<BinanceAccountBalance[]> {
    return this.request<any>("GET", "/fapi/v3/account", {}, true).then(
      (res: any) => (Array.isArray(res?.assets) ? res.assets : (Array.isArray(res) ? res : []))
    ).catch(async () => {
      const v2Res = await this.request<any>("GET", "/fapi/v2/account", {}, true);
      return Array.isArray(v2Res?.assets) ? v2Res.assets : (Array.isArray(v2Res) ? v2Res : []);
    });
  }

  public async getOrder(symbol: string, orderId: number | string): Promise<BinanceOrderResponse> {
    return this.request<BinanceOrderResponse>(
      "GET",
      "/fapi/v1/order",
      { symbol, orderId },
      true
    );
  }

  public async getUserTrades(
    symbol: string,
    limit: number = 50,
    startTime?: number,
    endTime?: number,
    fromId?: number
  ): Promise<BinanceUserTrade[]> {
    const params: Record<string, string | number> = { symbol, limit };
    if (startTime !== undefined && startTime > 0) params.startTime = startTime;
    if (endTime !== undefined && endTime > 0) params.endTime = endTime;
    if (fromId !== undefined && fromId > 0) params.fromId = fromId;

    const res = await this.request<BinanceUserTrade[]>(
      "GET",
      "/fapi/v1/userTrades",
      params,
      true
    );
    return Array.isArray(res) ? res : [];
  }

  /**
   * Fetches micro-cent exchange income history (/fapi/v1/income) including FUNDING_FEE, COMMISSION, and REALIZED_PNL.
   */
  public async getIncomeHistory(
    symbol?: string,
    incomeType?: string,
    startTime?: number,
    endTime?: number,
    limit: number = 100
  ): Promise<BinanceIncomeHistory[]> {
    const params: Record<string, string | number> = { limit };
    if (symbol) params.symbol = symbol;
    if (incomeType) params.incomeType = incomeType;
    if (startTime !== undefined && startTime > 0) params.startTime = startTime;
    if (endTime !== undefined && endTime > 0) params.endTime = endTime;

    const res = await this.request<BinanceIncomeHistory[]>(
      "GET",
      "/fapi/v1/income",
      params,
      true
    );
    return Array.isArray(res) ? res : [];
  }

  /**
   * Reconciles available wallet balance and total unrealized profit directly from Binance REST API.
   */
  public async fetchReconciledAccountBalanceAsync(): Promise<{ totalWalletBalance: number; availableBalance: number; unrealizedProfit: number }> {
    if (!this.isConfigured()) {
      return { totalWalletBalance: 0, availableBalance: 0, unrealizedProfit: 0 };
    }
    try {
      const accountInfo = await this.getAccountInfo();
      if (accountInfo) {
        const totalWallet = parseFloat(accountInfo.totalWalletBalance || "0");
        const available = parseFloat(accountInfo.availableBalance || "0");
        const unrealized = parseFloat(accountInfo.totalUnrealizedProfit || "0");

        if (!isNaN(totalWallet)) this.cachedReconciledWalletBalance = totalWallet;
        if (!isNaN(available)) this.cachedUsdtAvailableBalance = available;
        if (!isNaN(unrealized)) this.cachedTotalUnrealizedProfit = unrealized;

        return {
          totalWalletBalance: this.cachedReconciledWalletBalance,
          availableBalance: this.cachedUsdtAvailableBalance,
          unrealizedProfit: this.cachedTotalUnrealizedProfit,
        };
      }
    } catch (err: any) {
      console.warn(`[BinanceExecutionClient] Reconciled account balance fetch notice: ${err?.message || String(err)}`);
    }
    return {
      totalWalletBalance: this.cachedReconciledWalletBalance,
      availableBalance: this.cachedUsdtAvailableBalance,
      unrealizedProfit: this.cachedTotalUnrealizedProfit,
    };
  }

  public getReconciledWalletBalance(): number {
    return this.cachedReconciledWalletBalance > 0 ? this.cachedReconciledWalletBalance : this.cachedUsdtAvailableBalance;
  }

  public getTotalUnrealizedProfit(): number {
    return this.cachedTotalUnrealizedProfit;
  }

  public getCumulativeFunding(symbol?: string): number {
    if (symbol) {
      return this.cachedCumulativeFunding.get(symbol) ?? 0;
    }
    let total = 0;
    for (const val of this.cachedCumulativeFunding.values()) {
      total += val;
    }
    return total;
  }

  public getCumulativeCommission(symbol?: string): number {
    if (symbol) {
      return this.cachedCumulativeCommission.get(symbol) ?? 0;
    }
    let total = 0;
    for (const val of this.cachedCumulativeCommission.values()) {
      total += val;
    }
    return total;
  }

  public subscribeIncomeUpdates(callback: (incomes: BinanceIncomeHistory[]) => void): () => void {
    this.incomeCallbacks.add(callback);
    return () => {
      this.incomeCallbacks.delete(callback);
    };
  }

  public subscribeUserTradeUpdates(callback: (trades: BinanceUserTrade[]) => void): () => void {
    this.userTradeCallbacks.add(callback);
    return () => {
      this.userTradeCallbacks.delete(callback);
    };
  }

  /**
   * Starts background synchronization of /fapi/v1/income and /fapi/v1/userTrades.
   */
  public startBackgroundSync(
    symbols: string[] = ["BTCUSDT"],
    incomeIntervalMs: number = 30000,
    tradeIntervalMs: number = 10000
  ): void {
    if (!this.isConfigured()) return;

    // 1. Initial immediate reconciliation
    this.fetchReconciledAccountBalanceAsync().catch(() => {});
    this.syncIncomeBackground(symbols).catch(() => {});

    // 2. Start periodic income sync
    if (!this.incomeSyncTimer) {
      this.incomeSyncTimer = setInterval(() => {
        this.syncIncomeBackground(symbols).catch((err: any) => {
          console.warn(`[BinanceExecutionClient] Background income sync notice: ${err?.message || String(err)}`);
        });
        this.fetchReconciledAccountBalanceAsync().catch(() => {});
      }, incomeIntervalMs);
    }

    // 3. Start periodic userTrades sync
    if (!this.userTradesSyncTimer) {
      this.userTradesSyncTimer = setInterval(() => {
        this.syncUserTradesBackground(symbols).catch((err: any) => {
          console.warn(`[BinanceExecutionClient] Background userTrades sync notice: ${err?.message || String(err)}`);
        });
      }, tradeIntervalMs);
    }
  }

  public stopBackgroundSync(): void {
    if (this.incomeSyncTimer) {
      clearInterval(this.incomeSyncTimer);
      this.incomeSyncTimer = null;
    }
    if (this.userTradesSyncTimer) {
      clearInterval(this.userTradesSyncTimer);
      this.userTradesSyncTimer = null;
    }
  }

  private async syncIncomeBackground(symbols: string[]): Promise<void> {
    const startTime = this.lastIncomeSyncTime > 0 ? this.lastIncomeSyncTime : Date.now() - 24 * 60 * 60 * 1000;
    const incomes = await this.getIncomeHistory(undefined, undefined, startTime, undefined, 100);

    if (incomes.length > 0) {
      let maxTime = this.lastIncomeSyncTime;
      for (const inc of incomes) {
        if (inc.time > maxTime) maxTime = inc.time;
        const sym = inc.symbol || "GLOBAL";
        const val = parseFloat(inc.income || "0");

        if (inc.incomeType === "FUNDING_FEE" && !isNaN(val)) {
          const currentFunding = this.cachedCumulativeFunding.get(sym) ?? 0;
          this.cachedCumulativeFunding.set(sym, currentFunding + val);
        } else if (inc.incomeType === "COMMISSION" && !isNaN(val)) {
          const currentComm = this.cachedCumulativeCommission.get(sym) ?? 0;
          this.cachedCumulativeCommission.set(sym, currentComm + Math.abs(val));
        }
      }
      this.lastIncomeSyncTime = maxTime + 1;

      for (const cb of this.incomeCallbacks) {
        try {
          cb(incomes);
        } catch (err: any) {
          console.error(`[BinanceExecutionClient] Error in income callback: ${err?.message || String(err)}`);
        }
      }
    }
  }

  private async syncUserTradesBackground(symbols: string[]): Promise<void> {
    for (const sym of symbols) {
      const lastSyncTime = this.lastUserTradeSyncTimes.get(sym) || (Date.now() - 60 * 60 * 1000);
      const trades = await this.getUserTrades(sym, 50, lastSyncTime);
      if (trades.length > 0) {
        let maxTime = lastSyncTime;
        for (const t of trades) {
          if (t.time > maxTime) maxTime = t.time;
        }
        this.lastUserTradeSyncTimes.set(sym, maxTime + 1);

        for (const cb of this.userTradeCallbacks) {
          try {
            cb(trades);
          } catch (err: any) {
            console.error(`[BinanceExecutionClient] Error in userTrade callback for ${sym}: ${err?.message || String(err)}`);
          }
        }
      }
    }
  }

  public async createListenKey(): Promise<string> {
    const res = await this.request<{ listenKey: string }>("POST", "/fapi/v1/listenKey", {}, true);
    return res.listenKey;
  }

  public async keepAliveListenKey(): Promise<boolean> {
    await this.request<Record<string, unknown>>("PUT", "/fapi/v1/listenKey", {}, true);
    return true;
  }
}

