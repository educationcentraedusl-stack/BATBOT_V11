import "dotenv/config";
import * as crypto from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";


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

export interface BinanceClientOptions {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  wsUrl?: string;
  useTestnet?: boolean;
}

export class BinanceExecutionClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private wsUrl: string;
  private testnet: boolean;
  private cachedUsdtAvailableBalance: number = 0;
  private balancePollTimer: NodeJS.Timeout | null = null;
  private timeOffset: number = 0;
  private isTimeSynced: boolean = false;

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
    }
    return this.timeOffset;
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
      // Log failure silently to background telemetry log without interrupting HFT loops
    }
    return this.cachedUsdtAvailableBalance;
  }

  public startBalancePolling(intervalMs: number = 5000): void {
    if (this.balancePollTimer) return;
    // Trigger initial fetch asynchronously
    this.fetchUsdtBalanceAsync().catch(() => {});
    this.balancePollTimer = setInterval(() => {
      this.fetchUsdtBalanceAsync().catch(() => {});
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

  private async request<T>(
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

  public async placeOrder(params: BinanceOrderParams): Promise<BinanceOrderResponse> {
    const formattedQty = Number(params.quantity.toFixed(3));
    const payload: Record<string, string | number | boolean> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: formattedQty,
    };

    if (params.price !== undefined) payload.price = Number(params.price.toFixed(2));
    if (params.stopPrice !== undefined) payload.stopPrice = params.stopPrice;
    
    // Binance API Error -1106: Parameter 'timeinforce' sent when not required.
    // timeInForce MUST NOT be sent for MARKET, STOP_MARKET, or TAKE_PROFIT_MARKET orders.
    if (
      params.timeInForce !== undefined &&
      params.type !== "MARKET" &&
      params.type !== "STOP_MARKET" &&
      params.type !== "TAKE_PROFIT_MARKET"
    ) {
      payload.timeInForce = params.timeInForce;
    }

    if (params.closePosition !== undefined) payload.closePosition = params.closePosition;
    if (params.workingType !== undefined) payload.workingType = params.workingType;
    if (params.recvWindow !== undefined) payload.recvWindow = params.recvWindow;
    if (params.positionSide !== undefined) payload.positionSide = params.positionSide;

    // Binance API Error -1106: Parameter 'reduceonly' sent when not required.
    // In Hedge Mode (when positionSide is "LONG" or "SHORT"), reduceOnly MUST NOT be sent.
    if (
      params.reduceOnly !== undefined &&
      (params.positionSide === undefined || params.positionSide === "BOTH")
    ) {
      payload.reduceOnly = params.reduceOnly;
    }

    return this.request<BinanceOrderResponse>("POST", "/fapi/v1/order", payload, true);
  }

  public async cancelOrder(symbol: string, orderId: number | string): Promise<BinanceOrderResponse> {
    return this.request<BinanceOrderResponse>(
      "DELETE",
      "/fapi/v1/order",
      { symbol, orderId },
      true
    );
  }

  public async cancelAllOrders(symbol: string): Promise<BinanceCancelAllResponse> {
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
    return this.request<BinancePositionRisk[]>("GET", "/fapi/v2/positionRisk", params, true);
  }

  public async getAccountBalance(): Promise<BinanceAccountBalance[]> {
    return this.request<BinanceAccountBalance[]>("GET", "/fapi/v2/account", {}, true);
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
