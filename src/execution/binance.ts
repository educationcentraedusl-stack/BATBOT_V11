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

export class BinanceExecutionClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  constructor(options?: { apiKey?: string; apiSecret?: string; baseUrl?: string }) {
    this.apiKey = options?.apiKey ?? process.env.BINANCE_API_KEY ?? "";
    this.apiSecret = options?.apiSecret ?? process.env.BINANCE_API_SECRET ?? "";
    this.baseUrl = options?.baseUrl ?? "https://fapi.binance.com";

    if (!this.apiKey || !this.apiSecret) {
      console.error(
        "[CRITICAL][BinanceExecutionClient] Missing BINANCE_API_KEY or BINANCE_API_SECRET in environment variables. Live trading execution disabled."
      );
    }
  }

  public isConfigured(): boolean {
    return this.apiKey.length > 0 && this.apiSecret.length > 0;
  }

  public signQuery(params: Record<string, string | number | boolean>): string {
    const timestamp = Date.now();
    const queryParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
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
    signed: boolean = true
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

        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data as T);
            } else {
              const errCode = data?.code ?? res.statusCode;
              const errMsg = data?.msg ?? body;
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

  public async placeOrder(params: BinanceOrderParams): Promise<BinanceOrderResponse> {
    const payload: Record<string, string | number | boolean> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: params.quantity,
    };

    if (params.price !== undefined) payload.price = params.price;
    if (params.stopPrice !== undefined) payload.stopPrice = params.stopPrice;
    if (params.timeInForce !== undefined) payload.timeInForce = params.timeInForce;
    if (params.reduceOnly !== undefined) payload.reduceOnly = params.reduceOnly;
    if (params.closePosition !== undefined) payload.closePosition = params.closePosition;
    if (params.workingType !== undefined) payload.workingType = params.workingType;
    if (params.recvWindow !== undefined) payload.recvWindow = params.recvWindow;

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
