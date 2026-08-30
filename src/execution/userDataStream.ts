import "dotenv/config";
import WebSocket from "ws";
import { BinanceExecutionClient } from "./binance";

export interface OrderTradeUpdatePayload {
  eventType: string; // "ORDER_TRADE_UPDATE"
  eventTime: number;
  transactionTime: number;
  order: {
    symbol: string;
    clientOrderId: string;
    side: "BUY" | "SELL";
    orderType: string;
    timeInForce: string;
    originalQuantity: number;
    originalPrice: number;
    averagePrice: number;
    stopPrice: number;
    executionType: string; // "NEW", "CANCELED", "CALCULATED", "EXPIRED", "TRADE"
    orderStatus: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "EXPIRED";
    orderId: number;
    lastFilledQuantity: number;
    cumulativeFilledQuantity: number;
    lastFilledPrice: number;
    commissionAsset: string;
    commissionAmount: number;
    tradeTime: number;
    tradeId: number;
    bidsNotional: number;
    isMaker: boolean;
    positionSide: "LONG" | "SHORT" | "BOTH";
    realizedPnl: number;
    reduceOnly?: boolean;
  };
}

export interface AccountPositionUpdatePayload {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  accumulatedRealized: number;
  unrealizedPnl: number;
  positionSide: "LONG" | "SHORT" | "BOTH";
}

export interface AccountBalanceUpdatePayload {
  asset: string;
  walletBalance: number;
  crossWalletBalance: number;
  balanceChange: number;
}

export interface RawWsPositionPayload {
  s: string;
  pa: string;
  ep: string;
  cr: string;
  up: string;
  ps?: "LONG" | "SHORT" | "BOTH";
}

export interface RawWsBalancePayload {
  a: string;
  wb: string;
  cw: string;
  bc: string;
}

export interface AccountUpdatePayload {
  eventType: string; // "ACCOUNT_UPDATE"
  eventTime: number;
  transactionTime: number;
  reasonType: string; // "ORDER", "FUNDING_FEE", "DEPOSIT", "WITHDRAW", etc.
  positions: AccountPositionUpdatePayload[];
  balances?: AccountBalanceUpdatePayload[];
}

export type OrderTradeUpdateCallback = (update: OrderTradeUpdatePayload) => void;
export type AccountUpdateCallback = (update: AccountUpdatePayload) => void;

export class BinanceUserDataStream {
  private client: BinanceExecutionClient;
  private ws: WebSocket | null = null;
  private listenKey: string = "";
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private isDisposed: boolean = false;
  private reconnectAttempts: number = 0;
  private orderCallbacks: Set<OrderTradeUpdateCallback> = new Set();
  private accountCallbacks: Set<AccountUpdateCallback> = new Set();

  private keepAliveIntervalMs: number;
  private maxReconnectRetries: number;

  constructor(client: BinanceExecutionClient) {
    this.client = client;
    const parsedKeepAlive = parseInt(process.env.WEBSOCKET_KEEP_ALIVE_INTERVAL_MS || "1800000", 10);
    this.keepAliveIntervalMs = Number.isFinite(parsedKeepAlive) && parsedKeepAlive > 0 ? parsedKeepAlive : 1800000;

    const parsedRetries = parseInt(process.env.WEBSOCKET_RECONNECT_MAX_RETRIES || "10", 10);
    this.maxReconnectRetries = Number.isFinite(parsedRetries) && parsedRetries > 0 ? parsedRetries : 10;
  }

  public subscribeOrderUpdates(callback: OrderTradeUpdateCallback): () => void {
    this.orderCallbacks.add(callback);
    return () => {
      this.orderCallbacks.delete(callback);
    };
  }

  public subscribeAccountUpdates(callback: AccountUpdateCallback): () => void {
    this.accountCallbacks.add(callback);
    return () => {
      this.accountCallbacks.delete(callback);
    };
  }

  public isStreamConnected(): boolean {
    return this.isConnected && !this.isDisposed;
  }

  public async start(): Promise<boolean> {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BinanceUserDataStream] Failed to start User Data Stream: ${msg}`);
      return false;
    }
  }

  private connectWebSocket(url: string): void {
    if (this.isDisposed) return;

    try {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        if (this.isDisposed) {
          this.ws?.close();
          return;
        }
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log(`[BinanceUserDataStream] Centralized account WebSocket connection established successfully.`);
      });

      this.ws.on("message", (data: WebSocket.RawData) => {
        if (this.isDisposed) return;
        try {
          const payload = JSON.parse(data.toString());
          if (!payload) return;

          if (payload.e === "ORDER_TRADE_UPDATE" && payload.o) {
            const parsedUpdate: OrderTradeUpdatePayload = {
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
                reduceOnly: payload.o.R === true,
              },
            };

            for (const cb of this.orderCallbacks) {
              try {
                cb(parsedUpdate);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[BinanceUserDataStream] Error in order callback handler: ${msg}`);
              }
            }
          } else if (payload.e === "ACCOUNT_UPDATE" && payload.a) {
            const rawPositions: RawWsPositionPayload[] = Array.isArray(payload.a.P) ? payload.a.P : [];
            const positions: AccountPositionUpdatePayload[] = rawPositions.map((p: RawWsPositionPayload) => ({
              symbol: p.s,
              positionAmt: parseFloat(p.pa || "0"),
              entryPrice: parseFloat(p.ep || "0"),
              accumulatedRealized: parseFloat(p.cr || "0"),
              unrealizedPnl: parseFloat(p.up || "0"),
              positionSide: p.ps || "BOTH",
            }));

            const rawBalances: RawWsBalancePayload[] = Array.isArray(payload.a.B) ? payload.a.B : [];
            const balances: AccountBalanceUpdatePayload[] = rawBalances.map((b: RawWsBalancePayload) => ({
              asset: b.a,
              walletBalance: parseFloat(b.wb || "0"),
              crossWalletBalance: parseFloat(b.cw || "0"),
              balanceChange: parseFloat(b.bc || "0"),
            }));

            // Immediately mutate BinanceExecutionClient cached balance via zero-weight WebSocket push
            const usdtItem = balances.find((b) => b.asset === "USDT");
            if (usdtItem && Number.isFinite(usdtItem.crossWalletBalance) && usdtItem.crossWalletBalance >= 0) {
              this.client.updateBalancesFromWs(usdtItem.crossWalletBalance, usdtItem.walletBalance);
            }

            const accountUpdate: AccountUpdatePayload = {
              eventType: payload.e,
              eventTime: payload.E,
              transactionTime: payload.T,
              reasonType: payload.a.m || "ORDER",
              positions,
              balances,
            };

            for (const cb of this.accountCallbacks) {
              try {
                cb(accountUpdate);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[BinanceUserDataStream] Error in account callback handler: ${msg}`);
              }
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[BinanceUserDataStream] Failed to parse WebSocket message: ${msg}`);
        }
      });

      this.ws.on("error", (err: Error) => {
        if (this.isDisposed) return;
        console.error(`[BinanceUserDataStream] WebSocket Error: ${err.message}`);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        this.isConnected = false;
        if (this.isDisposed) return;
        console.warn(`[BinanceUserDataStream] WebSocket closed [Code: ${code}, Reason: ${reason.toString()}]`);
        this.handleReconnect();
      });
    } catch (err: unknown) {
      if (!this.isDisposed) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[BinanceUserDataStream] Failed to initiate WebSocket: ${msg}`);
      }
    }
  }

  private handleReconnect(): void {
    if (this.isDisposed) return;

    if (this.reconnectAttempts >= this.maxReconnectRetries) {
      console.error(`[BinanceUserDataStream] Exceeded max reconnect attempts (${this.maxReconnectRetries}). User Data Stream halted.`);
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempts++;
    const backoffMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[BinanceUserDataStream] Reconnecting in ${backoffMs}ms (Attempt ${this.reconnectAttempts}/${this.maxReconnectRetries})...`);

    this.reconnectTimer = setTimeout(async () => {
      if (this.isDisposed) return;
      try {
        this.listenKey = await this.client.createListenKey();
        const wsBase = this.client.getWsUrl();
        const wsUrl = `${wsBase}/ws/${this.listenKey}`;
        this.connectWebSocket(wsUrl);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[BinanceUserDataStream] Failed to renew listenKey on reconnect: ${msg}`);
        this.handleReconnect();
      }
    }, backoffMs);
  }

  private startKeepAliveTimer(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(async () => {
      if (this.isDisposed) return;
      try {
        if (this.listenKey) {
          await this.client.keepAliveListenKey();
          console.log(`[BinanceUserDataStream] Sent listenKey keep-alive ping.`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[BinanceUserDataStream] Keep-alive ping failed: ${msg}`);
      }
    }, this.keepAliveIntervalMs);
  }

  public stop(): void {
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
