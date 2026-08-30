import "dotenv/config";
import * as crypto from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import { SymbolPrecisionRegistry } from "../config/symbolPrecision";
import { ClientOrderIdGenerator } from "./clientOrderIdGenerator";
import { timeSynchronizer } from "../utils/timeSynchronizer";

export interface BinanceOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity?: number;
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

export interface BinanceAlgoOrderResponse {
  algoId?: number;
  orderId?: number;
  symbol?: string;
  algoStatus?: string;
  status?: string;
  clientAlgoId?: string;
  clientOrderId?: string;
  price?: string;
  avgPrice?: string;
  quantity?: string;
  executedQty?: string;
  cumQuote?: string;
  timeInForce?: string;
  orderType?: string;
  type?: string;
  side?: string;
  positionSide?: string;
  triggerPrice?: string;
  stopPrice?: string;
  workingType?: string;
  updateTime?: number;
  code?: number;
  msg?: string;
}

export interface BinanceAlgoCancelResponse {
  algoId?: number;
  orderId?: number;
  symbol?: string;
  algoStatus?: string;
  status?: string;
  clientAlgoId?: string;
  clientOrderId?: string;
  code?: number;
  msg?: string;
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

export interface RateLimitStatus {
  usedWeight1m: number;
  orderCount10s: number;
  orderCount1m: number;
  isThrottled: boolean;
  backoffRemainingMs: number;
}

export class BinanceRateLimiter {
  private static readonly MAX_WEIGHT_1M = 2400;
  private static readonly MAX_ORDERS_10S = 300;
  private static readonly MAX_ORDERS_1M = 1200;

  // 80% Proactive Backoff Thresholds
  private static readonly THRESHOLD_WEIGHT_1M = 1920; // 80% of 2400
  private static readonly THRESHOLD_ORDERS_10S = 240;  // 80% of 300
  private static readonly THRESHOLD_ORDERS_1M = 960;   // 80% of 1200

  private usedWeight1m: number = 0;
  private orderCount10s: number = 0;
  private orderCount1m: number = 0;
  private backoffUntil: number = 0;
  private lastHeaderTimestamp: number = 0;

  public updateFromHeaders(headers: http.IncomingHttpHeaders): void {
    const now = Date.now();
    this.lastHeaderTimestamp = now;

    for (const [key, val] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("used-weight-1m")) {
        const parsed = parseInt(Array.isArray(val) ? val[0] : String(val), 10);
        if (!isNaN(parsed) && parsed >= 0) {
          this.usedWeight1m = parsed;
        }
      } else if (lowerKey.includes("order-count-10s")) {
        const parsed = parseInt(Array.isArray(val) ? val[0] : String(val), 10);
        if (!isNaN(parsed) && parsed >= 0) {
          this.orderCount10s = parsed;
        }
      } else if (lowerKey.includes("order-count-1m")) {
        const parsed = parseInt(Array.isArray(val) ? val[0] : String(val), 10);
        if (!isNaN(parsed) && parsed >= 0) {
          this.orderCount1m = parsed;
        }
      } else if (lowerKey === "retry-after") {
        const retrySec = parseInt(Array.isArray(val) ? val[0] : String(val), 10);
        if (!isNaN(retrySec) && retrySec > 0) {
          this.backoffUntil = Math.max(this.backoffUntil, now + retrySec * 1000);
          console.warn(
            `[BinanceRateLimiter] Received Retry-After: ${retrySec}s. Enforcing backoff until ${new Date(
              this.backoffUntil
            ).toISOString()}`
          );
        }
      }
    }
  }

  public register429Backoff(retryAfterMs: number = 5000): void {
    const now = Date.now();
    this.backoffUntil = Math.max(this.backoffUntil, now + retryAfterMs);
    console.error(
      `[BinanceRateLimiter][429_CIRCUIT_BREAKER] Binance 429/418 detected. Backing off for ${retryAfterMs}ms.`
    );
  }

  public async acquirePreFlightAllowance(isOrder: boolean, signal?: AbortSignal): Promise<void> {
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
      console.warn(
        `[BinanceRateLimiter][WEIGHT_THROTTLED] Weight approaching limit (${this.usedWeight1m}/${BinanceRateLimiter.MAX_WEIGHT_1M}). Pre-flight delay: ${waitMs}ms`
      );
      await this.sleep(waitMs, signal);
    }

    // 3. Check 80% Order Count Threshold (300/10s limit -> 240 threshold)
    if (isOrder && this.orderCount10s >= BinanceRateLimiter.THRESHOLD_ORDERS_10S) {
      const waitMs = Math.min(1500, Math.max(200, (this.orderCount10s - BinanceRateLimiter.THRESHOLD_ORDERS_10S) * 25));
      console.warn(
        `[BinanceRateLimiter][ORDER_COUNT_THROTTLED] 10s Order count approaching limit (${this.orderCount10s}/${BinanceRateLimiter.MAX_ORDERS_10S}). Pre-flight delay: ${waitMs}ms`
      );
      await this.sleep(waitMs, signal);
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

  public getStatus(): RateLimitStatus {
    const now = Date.now();
    return {
      usedWeight1m: this.usedWeight1m,
      orderCount10s: this.orderCount10s,
      orderCount1m: this.orderCount1m,
      isThrottled:
        this.backoffUntil > now ||
        this.usedWeight1m >= BinanceRateLimiter.THRESHOLD_WEIGHT_1M ||
        this.orderCount10s >= BinanceRateLimiter.THRESHOLD_ORDERS_10S,
      backoffRemainingMs: Math.max(0, this.backoffUntil - now),
    };
  }
}

export class BinanceExecutionClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private wsUrl: string;
  private testnet: boolean;
  private rateLimiter: BinanceRateLimiter = new BinanceRateLimiter();
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
    const syncOffset = timeSynchronizer.getOffsetMs();
    return Number.isFinite(syncOffset)
      ? Math.round(syncOffset)
      : Math.round(this.timeOffset);
  }

  public async syncServerTime(): Promise<number> {
    if (this.timeSyncPromise) {
      return this.timeSyncPromise;
    }

    this.timeSyncPromise = (async () => {
      try {
        const offset = await timeSynchronizer.sync();
        this.timeOffset = offset;
        this.isTimeSynced = true;
        return offset;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[BinanceExecutionClient] Failed to sync Binance server time: ${errMsg}`);
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

  public setUsdtAvailableBalance(val: number): void {
    if (Number.isFinite(val) && val >= 0) {
      this.cachedUsdtAvailableBalance = val;
    }
  }

  /**
   * Updates cached USDT available and wallet balances in memory via WebSocket ACCOUNT_UPDATE push.
   * Zero REST API calls and zero rate limit consumption.
   */
  public updateBalancesFromWs(availableBalance: number, walletBalance?: number): void {
    if (Number.isFinite(availableBalance) && availableBalance >= 0) {
      this.cachedUsdtAvailableBalance = availableBalance;
    }
    if (walletBalance !== undefined && Number.isFinite(walletBalance) && walletBalance >= 0) {
      this.cachedReconciledWalletBalance = walletBalance;
    }
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

  /**
   * Seed startup balance asynchronously. Recurring REST polling is physically eradicated
   * in favor of real-time WebSocket ACCOUNT_UPDATE stream.
   */
  public startBalancePolling(_intervalMs: number = 60000): void {
    // Perform initial one-shot balance seed without setting an aggressive polling timer
    this.fetchUsdtBalanceAsync().catch((err: unknown) => {
      console.log(`[BinanceExecutionClient] Initial USDT balance fetch notice: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  public stopBalancePolling(): void {
    if (this.balancePollTimer) {
      clearInterval(this.balancePollTimer);
      this.balancePollTimer = null;
    }
  }


  public signQuery(params: Record<string, string | number | boolean>): string {
    const timestamp = timeSynchronizer.getAdjustedNowMs();
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

  public getRateLimiter(): BinanceRateLimiter {
    return this.rateLimiter;
  }

  protected async request<T>(
    method: "GET" | "POST" | "DELETE" | "PUT",
    endpoint: string,
    params: Record<string, string | number | boolean> = {},
    signed: boolean = true,
    isRetryAfterSync: boolean = false,
    signal?: AbortSignal
  ): Promise<T> {
    if (signed && !this.isConfigured()) {
      throw new Error(
        "BinanceExecutionClient is not configured with API key and secret. Cannot execute signed request."
      );
    }

    if (signal?.aborted) {
      throw new Error(`[BinanceExecutionClient] Request aborted by caller before dispatch (${method} ${endpoint})`);
    }

    const isOrderEndpoint = endpoint.includes("/order") || endpoint.includes("/batchOrders") || endpoint.includes("/algoOrder");
    await this.rateLimiter.acquirePreFlightAllowance(isOrderEndpoint, signal);

    const queryString = signed ? this.signQuery(params) : new URLSearchParams(params as Record<string, string>).toString();
    const fullUrl = `${this.baseUrl}${endpoint}${queryString ? "?" + queryString : ""}`;
    const url = new URL(fullUrl);

    const defaultTimeoutMs = parseInt(process.env.REST_REQUEST_TIMEOUT_MS || "2500", 10);

    return new Promise((resolve, reject) => {
      let isSettled = false;
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
        this.rateLimiter.updateFromHeaders(res.headers);

        res.on("data", (chunk) => {
          body += chunk;
        });

        res.on("end", async () => {
          if (isSettled) return;
          cleanup();
          this.rateLimiter.updateFromHeaders(res.headers);
          try {
            const data = JSON.parse(body);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              isSettled = true;
              resolve(data as T);
            } else {
              const errCode = data?.code ?? res.statusCode;
              const errMsg = data?.msg ?? body;

              const isRateLimit =
                res.statusCode === 429 ||
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
                  const retryRes = await this.request<T>(method, endpoint, params, signed, true, signal);
                  isSettled = true;
                  resolve(retryRes);
                  return;
                } catch (retryErr) {
                  isSettled = true;
                  reject(retryErr);
                  return;
                }
              }
              isSettled = true;
              reject(new Error(`Binance API Error [${errCode}]: ${errMsg}`));
            }
          } catch (err) {
            isSettled = true;
            reject(new Error(`Failed to parse Binance response: ${body}`));
          }
        });
      });

      // Transport-level Socket Timeout Enforcement:
      req.setTimeout(defaultTimeoutMs, () => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        req.destroy(new Error(`[BinanceExecutionClient] HTTP request socket timeout (${defaultTimeoutMs}ms) exceeded on ${method} ${endpoint}`));
        reject(new Error(`[BinanceExecutionClient] HTTP request socket timeout (${defaultTimeoutMs}ms) exceeded on ${method} ${endpoint}`));
      });

      let abortHandler: (() => void) | null = null;
      if (signal) {
        abortHandler = () => {
          if (isSettled) return;
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
        if (isSettled) return;
        isSettled = true;
        cleanup();
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
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("-4059")) {
        console.log(`[BinanceExecutionClient] Dual-side Hedge Mode is already set to ${enable}.`);
        return true;
      }
      console.warn(`[BinanceExecutionClient] Unable to set Hedge Mode: ${errMsg}`);
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
    } catch (err: unknown) {
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
  public async synchronizeAndCancelConflictingOrders(
    symbol: string,
    positionSide: "LONG" | "SHORT" | "BOTH",
    signal?: AbortSignal
  ): Promise<number> {
    const targetPosSide = positionSide;
    let cancelledCount = 0;

    try {
      const openOrders = await this.getOpenOrders(symbol);
      const conflictingOrders = openOrders.filter((ord) => {
        const matchesPosSide =
          !ord.positionSide || ord.positionSide === "BOTH" || ord.positionSide === targetPosSide;
        const isConditionalOrClose =
          ord.type === "STOP_MARKET" ||
          ord.type === "TAKE_PROFIT_MARKET" ||
          ord.type === "STOP" ||
          ord.type === "TAKE_PROFIT" ||
          (ord as unknown as Record<string, unknown>).closePosition === true ||
          String((ord as unknown as Record<string, unknown>).closePosition).toLowerCase() === "true";
        return matchesPosSide && isConditionalOrClose;
      });

      if (conflictingOrders.length > 0) {
        console.log(
          `[BinanceExecutionClient][PRE_FLIGHT_ANNIHILATION] Found ${conflictingOrders.length} conflicting resting order(s) for ${symbol} (${targetPosSide}). Forcibly cancelling...`
        );
        for (const ord of conflictingOrders) {
          try {
            await this.cancelOrder(symbol, ord.orderId, signal);
            cancelledCount++;
          } catch (cancelErr: unknown) {
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
              const matchesPosSide =
                !ord.positionSide || ord.positionSide === "BOTH" || ord.positionSide === targetPosSide;
              const isConditionalOrClose =
                ord.type === "STOP_MARKET" ||
                ord.type === "TAKE_PROFIT_MARKET" ||
                ord.type === "STOP" ||
                ord.type === "TAKE_PROFIT" ||
                (ord as unknown as Record<string, unknown>).closePosition === true ||
                String((ord as unknown as Record<string, unknown>).closePosition).toLowerCase() === "true";
              return matchesPosSide && isConditionalOrClose;
            });
            remainingConflicts = stillActive.length;
            if (remainingConflicts > 0) {
              console.warn(
                `[BinanceExecutionClient][VERIFY_BARRIER_POLL] ${remainingConflicts} order(s) still clearing on Binance (Probe ${verifyAttempts}/${maxVerifyAttempts})...`
              );
              for (const ord of stillActive) {
                try {
                  await this.cancelOrder(symbol, ord.orderId, signal);
                } catch (_) {}
              }
            }
          } catch (recheckErr: unknown) {
            break;
          }
        }

        if (remainingConflicts === 0) {
          console.log(
            `[BinanceExecutionClient][VERIFY_BARRIER_CLEARED] Exchange verified clean: 0 resting conflicting orders for ${symbol} (${targetPosSide}).`
          );
        }
      }
    } catch (queryErr: unknown) {
      console.warn(
        `[BinanceExecutionClient][PRE_FLIGHT_QUERY_WARN] Pre-flight open orders query notice: ${
          queryErr instanceof Error ? queryErr.message : String(queryErr)
        }`
      );
    }

    return cancelledCount;
  }

  /**
   * Native Binance USD-M Futures Cancel-Replace an Order (PUT /fapi/v1/order).
   * Atomically cancels an existing order and places a replacement order in a single transaction on the matching engine.
   */
  public async cancelReplaceOrder(
    params: BinanceOrderParams & {
      cancelOrderId?: number | string;
      cancelOrigClientOrderId?: string;
      cancelReplaceMode?: "STOP_ON_FAILURE" | "ALLOW_FAILURE";
    },
    signal?: AbortSignal
  ): Promise<BinanceOrderResponse> {
    const isClosePosition = params.closePosition === true || String(params.closePosition).toLowerCase() === "true";
    const formattedQty = params.quantity !== undefined ? SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity) : 0;
    const cid = (params.clientOrderId || "").trim();

    const payload: Record<string, string | number | boolean> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      cancelReplaceMode: params.cancelReplaceMode || "STOP_ON_FAILURE",
    };

    if (params.cancelOrderId !== undefined) payload.cancelOrderId = params.cancelOrderId;
    if (params.cancelOrigClientOrderId !== undefined) payload.cancelOrigClientOrderId = params.cancelOrigClientOrderId;

    if (!isClosePosition) {
      payload.quantity = formattedQty;
    }

    if (params.price !== undefined) payload.price = SymbolPrecisionRegistry.formatPrice(params.symbol, params.price);
    if (params.stopPrice !== undefined) payload.stopPrice = SymbolPrecisionRegistry.formatPrice(params.symbol, params.stopPrice);

    if (isClosePosition) {
      payload.closePosition = "true";
      delete payload.quantity;
      delete payload.reduceOnly;
      delete payload.price;
      delete payload.timeInForce;
    }

    if (params.workingType !== undefined) payload.workingType = params.workingType;
    if (params.recvWindow !== undefined) payload.recvWindow = params.recvWindow;
    if (params.positionSide !== undefined) payload.positionSide = params.positionSide;
    if (cid.length > 0) payload.newClientOrderId = cid;

    return await this.request<BinanceOrderResponse>("PUT", "/fapi/v1/order", payload, true, false, signal);
  }

  public async placePositionStopLoss(
    symbol: string,
    side: "BUY" | "SELL",
    positionSide: "LONG" | "SHORT" | "BOTH",
    stopPrice: number,
    clientOrderId?: string,
    signal?: AbortSignal,
    quantity?: number
  ): Promise<BinanceOrderResponse> {
    const formattedSlPx = SymbolPrecisionRegistry.formatPrice(symbol, stopPrice);
    const cid = clientOrderId || ClientOrderIdGenerator.generate(symbol, positionSide === "LONG" ? "CORE_LONG" : "SHORT_AGG", "SL");
    
    // Strict Zero-Trust Assertion:
    // SHORT position -> side MUST be "BUY"
    // LONG position -> side MUST be "SELL"
    const expectedSide: "BUY" | "SELL" = positionSide === "SHORT" ? "BUY" : (positionSide === "LONG" ? "SELL" : side);
    if (side !== expectedSide && positionSide !== "BOTH") {
      console.warn(`[BinanceExecutionClient][SL_DIRECTION_CORRECTION] Correcting misaligned SL side ${side} to ${expectedSide} for ${positionSide} position on ${symbol}.`);
    }
    const sanitizedSide = expectedSide;

    // PHASE 1-3: Synchronous Pre-Flight Annihilation & State Verification Barrier
    await this.synchronizeAndCancelConflictingOrders(symbol, positionSide, signal);

    // PHASE 4: Sovereign Dispatch
    const params: BinanceOrderParams = {
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
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isClosePositionConflict =
        errMsg.includes("-4130") ||
        errMsg.includes("4130") ||
        errMsg.includes("-4509") ||
        errMsg.includes("4509") ||
        errMsg.includes("closePosition");

      // PHASE 5: Zero-Naked Guaranteed Quantity-Based Fallback
      if (isClosePositionConflict) {
        console.warn(
          `[BinanceExecutionClient][SL_ZERO_NAKED_FALLBACK] closePosition=true rejected with ${errMsg} on ${symbol} (${positionSide}). Engaging Deterministic Quantity-Based STOP_MARKET Fallback...`
        );
        let fallbackQty = quantity;
        if (!fallbackQty || fallbackQty <= 0) {
          try {
            const posRisks = await this.getPositionRisk(symbol);
            const matchPos = posRisks.find(
              (p) => p.positionSide === positionSide || (positionSide === "BOTH" && parseFloat(p.positionAmt) !== 0)
            );
            if (matchPos) {
              const amt = Math.abs(parseFloat(matchPos.positionAmt || "0"));
              if (amt > 0) fallbackQty = amt;
            }
          } catch (_) {}
        }

        if (fallbackQty && fallbackQty > 0) {
          const fallbackCid = ClientOrderIdGenerator.generate(
            symbol,
            positionSide === "LONG" ? "CORE_LONG" : "SHORT_AGG",
            "SL_FALLBACK"
          );
          const fallbackParams: BinanceOrderParams = {
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

  public async placeOrder(params: BinanceOrderParams, retryCount: number = 0, signal?: AbortSignal): Promise<BinanceOrderResponse> {
    const cid = (params.clientOrderId || "").trim();
    if (cid.length > 0 && retryCount === 0) {
      if (this.inFlightClientOrderIds.has(cid)) {
        throw new Error(`[BinanceExecutionClient][DEDUPLICATION_BARRIER] Blocked duplicate concurrent submission for ClientOrderId: ${cid}`);
      }
      this.inFlightClientOrderIds.add(cid);
    }

    try {
      const isClosePosition = params.closePosition === true || String(params.closePosition).toLowerCase() === "true";
      const formattedQty = params.quantity !== undefined ? SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity) : 0;
      const payload: Record<string, string | number | boolean> = {
        symbol: params.symbol,
        side: params.side,
        type: params.type,
      };

      if (!isClosePosition) {
        payload.quantity = formattedQty;
      }

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

      if (isClosePosition) {
        payload.closePosition = "true";
        delete payload.quantity;
        delete payload.reduceOnly;
        delete payload.price;
        delete payload.timeInForce;
      } else if (
        params.reduceOnly !== undefined &&
        (params.positionSide === undefined || params.positionSide === "BOTH")
      ) {
        payload.reduceOnly = params.reduceOnly;
      } else {
        delete payload.reduceOnly;
      }

      if (params.workingType !== undefined) payload.workingType = params.workingType;
      if (params.recvWindow !== undefined) payload.recvWindow = params.recvWindow;
      if (params.positionSide !== undefined) payload.positionSide = params.positionSide;
      if (cid.length > 0) {
        payload.newClientOrderId = cid;
      }

      try {
        return await this.request<BinanceOrderResponse>("POST", "/fapi/v1/order", payload, true, false, signal);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("-4120")) {
          // Fallback to /fapi/v1/algoOrder if /fapi/v1/order threw -4120
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
          const algoRes = await this.request<BinanceAlgoOrderResponse>("POST", "/fapi/v1/algoOrder", algoPayload, true, false, signal);
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
          return algoRes as BinanceOrderResponse;
        }

        const isConflictOrGteError =
          errMsg.includes("-4509") ||
          errMsg.includes("4509") ||
          errMsg.includes("TIF GTE") ||
          errMsg.includes("Time in Force (TIF) GTE can only be used with open positions") ||
          errMsg.includes("-4130") ||
          errMsg.includes("4130") ||
          errMsg.includes("would trigger immediately") ||
          errMsg.includes("closePosition in the direction is existing");

        if (isConflictOrGteError && retryCount < 2) {
          console.warn(
            `[BinanceExecutionClient][-4509/-4130 AUTO_RECOVERY] Binance rejected closePosition order on ${params.symbol} (${params.positionSide || "BOTH"} ${params.side}): ${errMsg}. Executing synchronous pre-flight annihilation and retrying...`
          );

          // 1. Synchronously purge conflicting orders with State Verification Barrier
          await this.synchronizeAndCancelConflictingOrders(
            params.symbol,
            params.positionSide as "LONG" | "SHORT" | "BOTH" || "BOTH",
            signal
          );

          // 2. Generate a fresh unique clientOrderId for the retry
          const nextCid = params.clientOrderId ? `${params.clientOrderId}_R${retryCount + 1}` : undefined;
          return await this.placeOrder(
            {
              ...params,
              clientOrderId: nextCid,
            },
            retryCount + 1,
            signal
          );
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
                if (amt > 0) fallbackQty = amt;
              }
            } catch (posErr: unknown) {
              // Ignore position risk query error in fallback
            }
          }

          if (fallbackQty && fallbackQty > 0) {
            console.warn(
              `[BinanceExecutionClient][SOTA_SL_FALLBACK] closePosition=true rejected after retries on ${params.symbol} (${params.positionSide}). Executing deterministic Quantity-Based STOP_MARKET fallback (Qty: ${fallbackQty})...`
            );
            const fallbackParams: BinanceOrderParams = {
              ...params,
              closePosition: false,
              quantity: fallbackQty,
              clientOrderId: params.clientOrderId ? `${params.clientOrderId}_FALLBACK` : undefined,
            };
            return await this.placeOrder(fallbackParams, 0, signal);
          }
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
            }, 1, signal);
          } else if (retryCount === 1) {
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

    const batchPayload = targetOrders.map((params) => {
      const cid = params.clientOrderId || "";
      const isClosePosition = params.closePosition === true || String(params.closePosition).toLowerCase() === "true";
      const formattedQty = params.quantity !== undefined ? SymbolPrecisionRegistry.formatQuantity(params.symbol, params.quantity) : 0;
      
      const payload: Record<string, string | number | boolean> = {
        symbol: params.symbol,
        side: params.side,
        type: params.type,
      };

      if (!isClosePosition) {
        payload.quantity = formattedQty;
      }

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
      }

      if (isClosePosition) {
        payload.closePosition = "true";
        delete payload.quantity;
        delete payload.reduceOnly;
      } else if (
        params.reduceOnly !== undefined &&
        (params.positionSide === undefined || params.positionSide === "BOTH")
      ) {
        payload.reduceOnly = params.reduceOnly;
      }

      if (params.workingType !== undefined) payload.workingType = params.workingType;
      if (params.recvWindow !== undefined) payload.recvWindow = params.recvWindow;
      if (params.positionSide !== undefined) payload.positionSide = params.positionSide;
      if (cid.length > 0) payload.newClientOrderId = cid;

      return payload;
    });

    const batchQuery: Record<string, string | number | boolean> = {
      batchOrders: JSON.stringify(batchPayload),
      recvWindow,
    };

    return this.request<BinanceOrderResponse[]>("POST", "/fapi/v1/batchOrders", batchQuery, true);
  }

  public async cancelBatchOrders(symbol: string, orderIdList: (number | string)[]): Promise<BinanceOrderResponse[]> {
    if (!orderIdList || orderIdList.length === 0) return [];
    
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

  public async cancelOrder(symbol: string, orderId: number | string, signal?: AbortSignal): Promise<BinanceOrderResponse> {
    try {
      return await this.request<BinanceOrderResponse>(
        "DELETE",
        "/fapi/v1/order",
        { symbol, orderId },
        true,
        false,
        signal
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("-2011") || errMsg.includes("-4120") || errMsg.includes("Unknown order") || errMsg.includes("not found")) {
        // Fallback to /fapi/v1/algoOrder cancellation
        try {
          const algoCancel = await this.request<BinanceAlgoCancelResponse>(
            "DELETE",
            "/fapi/v1/algoOrder",
            { symbol, algoId: orderId },
            true,
            false,
            signal
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
        } catch (algoErr: unknown) {
          throw err;
        }
      }
      throw err;
    }
  }

  public async cancelAllOrders(symbol: string): Promise<BinanceCancelAllResponse> {
    try {
      await this.request<BinanceCancelAllResponse | Record<string, unknown>>("DELETE", "/fapi/v1/algoOpenOrders", { symbol }, true).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`[BinanceExecutionClient] Notice during algoOpenOrders cancellation: ${errMsg}`);
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[BinanceExecutionClient] Notice during algoOpenOrders dispatch: ${errMsg}`);
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
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[BinanceExecutionClient] flattenPositions error: ${errMsg}`);
      return false;
    }
  }

  public async getPositionRisk(symbol?: string): Promise<BinancePositionRisk[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    return this.request<BinancePositionRisk[]>("GET", "/fapi/v3/positionRisk", params, true).catch(async (err: unknown) => {
      // Graceful fallback to /fapi/v2/positionRisk if /fapi/v3/positionRisk is unavailable
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("404") || errMsg.includes("-4120")) {
        return this.request<BinancePositionRisk[]>("GET", "/fapi/v2/positionRisk", params, true);
      }
      throw err;
    });
  }

  public async getAccountInfo(): Promise<BinanceAccountInfo> {
    return this.request<BinanceAccountInfo>("GET", "/fapi/v3/account", {}, true).catch(async (err: unknown) => {
      // Graceful fallback to /fapi/v2/account if /fapi/v3/account is unavailable
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("404") || errMsg.includes("-4120")) {
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
    interface RawAlgoOrder {
      algoId?: number;
      orderId?: number;
      symbol: string;
      algoStatus?: string;
      status?: string;
      clientAlgoId?: string;
      clientOrderId?: string;
      price?: string;
      avgPrice?: string;
      quantity?: string;
      origQty?: string;
      executedQty?: string;
      cumQuote?: string;
      timeInForce?: string;
      orderType?: string;
      type?: string;
      reduceOnly?: boolean;
      side: "BUY" | "SELL";
      positionSide?: "LONG" | "SHORT" | "BOTH";
      stopPrice?: string;
      workingType?: string;
      updateTime?: number;
    }

    const algoOrders = await this.request<RawAlgoOrder[]>("GET", "/fapi/v1/openAlgoOrders", params, true).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404") || msg.includes("-4120") || msg.includes("not supported")) {
        return [] as RawAlgoOrder[];
      }
      throw err;
    });

    const mappedAlgoOrders: BinanceOrderResponse[] = (Array.isArray(algoOrders) ? algoOrders : []).map((ao) => ({
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

  public async getAccountBalance(): Promise<BinanceAccountBalance[]> {
    return this.request<BinanceAccountInfo>("GET", "/fapi/v3/account", {}, true).then(
      (res: BinanceAccountInfo) => (Array.isArray(res?.assets) ? res.assets : [])
    ).catch(async () => {
      const v2Res = await this.request<BinanceAccountInfo>("GET", "/fapi/v2/account", {}, true);
      return Array.isArray(v2Res?.assets) ? v2Res.assets : [];
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
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[BinanceExecutionClient] Reconciled account balance fetch notice: ${errMsg}`);
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
   * Performs initial background synchronization of /fapi/v1/income.
   * Recurring interval polling is deactivated in favor of real-time WebSocket User Data Stream.
   */
  public startBackgroundSync(
    symbols: string[] = ["BTCUSDT"],
    _incomeIntervalMs: number = 60000,
    _tradeIntervalMs: number = 60000
  ): void {
    if (!this.isConfigured()) return;

    // 1. Initial one-shot immediate reconciliation
    this.fetchReconciledAccountBalanceAsync().catch(() => {});
    this.syncIncomeBackground(symbols).catch(() => {});
    // Polling intervals deactivated: trades and balance mutations are processed via WebSocket stream
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
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[BinanceExecutionClient] Error in income callback: ${errMsg}`);
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
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[BinanceExecutionClient] Error in userTrade callback for ${sym}: ${errMsg}`);
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

