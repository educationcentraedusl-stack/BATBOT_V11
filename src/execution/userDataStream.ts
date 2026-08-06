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
  };
}

export type OrderTradeUpdateCallback = (update: OrderTradeUpdatePayload) => void;

export class BinanceUserDataStream {
  private client: BinanceExecutionClient;
  private ws: WebSocket | null = null;
  private listenKey: string = "";
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private callbacks: Set<OrderTradeUpdateCallback> = new Set();

  private keepAliveIntervalMs: number;
  private maxReconnectRetries: number;

  constructor(client: BinanceExecutionClient) {
    this.client = client;
    this.keepAliveIntervalMs = parseInt(process.env.WEBSOCKET_KEEP_ALIVE_INTERVAL_MS || "1800000", 10);
    this.maxReconnectRetries = parseInt(process.env.WEBSOCKET_RECONNECT_MAX_RETRIES || "10", 10);
  }

  public subscribeOrderUpdates(callback: OrderTradeUpdateCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  public isStreamConnected(): boolean {
    return this.isConnected;
  }

  public async start(): Promise<boolean> {
    if (!this.client.isConfigured()) {
      console.warn(`[BinanceUserDataStream] Execution client is not configured. User Data Stream disabled.`);
      return false;
    }

    try {
      this.listenKey = await this.client.createListenKey();
      console.log(`[BinanceUserDataStream] Created listenKey: ${this.listenKey.substring(0, 8)}...`);

      const wsBase = this.client.getWsUrl();
      const wsUrl = `${wsBase}/ws/${this.listenKey}`;

      this.connectWebSocket(wsUrl);
      this.startKeepAliveTimer();
      return true;
    } catch (err: any) {
      console.error(`[BinanceUserDataStream] Failed to start User Data Stream: ${err.message}`);
      return false;
    }
  }

  private connectWebSocket(url: string): void {
    try {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log(`[BinanceUserDataStream] WebSocket connection established successfully.`);
      });

      this.ws.on("message", (data: WebSocket.RawData) => {
        try {
          const payload = JSON.parse(data.toString());
          if (payload && payload.e === "ORDER_TRADE_UPDATE") {
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
              },
            };

            for (const cb of this.callbacks) {
              try {
                cb(parsedUpdate);
              } catch (err: any) {
                console.error(`[BinanceUserDataStream] Error in callback handler: ${err.message}`);
              }
            }
          }
        } catch (err: any) {
          console.error(`[BinanceUserDataStream] Failed to parse WebSocket message: ${err.message}`);
        }
      });

      this.ws.on("error", (err: Error) => {
        console.error(`[BinanceUserDataStream] WebSocket Error: ${err.message}`);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        this.isConnected = false;
        console.warn(`[BinanceUserDataStream] WebSocket closed [Code: ${code}, Reason: ${reason.toString()}]`);
        this.handleReconnect(url);
      });
    } catch (err: any) {
      console.error(`[BinanceUserDataStream] Failed to initiate WebSocket: ${err.message}`);
    }
  }

  private handleReconnect(url: string): void {
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

  private startKeepAliveTimer(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(async () => {
      try {
        if (this.listenKey) {
          await this.client.keepAliveListenKey();
          console.log(`[BinanceUserDataStream] Sent listenKey keep-alive ping.`);
        }
      } catch (err: any) {
        console.error(`[BinanceUserDataStream] Keep-alive ping failed: ${err.message}`);
      }
    }, this.keepAliveIntervalMs);
  }

  public stop(): void {
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
