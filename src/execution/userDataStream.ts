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
    orderStatus: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "EXPIRED" | "REJECTED";
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

function rawDataToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  context: string
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `[BinanceUserDataStream] Missing or empty string field "${key}" in ${context}`
    );
  }
  return value;
}

function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  context: string
): string {
  const value = obj[key];
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(
      `[BinanceUserDataStream] Expected string for optional field "${key}" in ${context}`
    );
  }
  return value;
}

function requireFiniteNumber(
  obj: Record<string, unknown>,
  key: string,
  context: string
): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `[BinanceUserDataStream] Missing or non-finite numeric field "${key}" in ${context}`
    );
  }
  return value;
}

function parseStrictNumericString(
  raw: string,
  fieldName: string,
  context: string
): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `[BinanceUserDataStream] Empty numeric string for "${fieldName}" in ${context}`
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `[BinanceUserDataStream] Malformed numeric string "${raw}" for "${fieldName}" in ${context}`
    );
  }
  return parsed;
}

function requireNumericField(
  obj: Record<string, unknown>,
  key: string,
  context: string
): number {
  const value = obj[key];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `[BinanceUserDataStream] Non-finite number for "${key}" in ${context}`
      );
    }
    return value;
  }
  if (typeof value === "string") {
    return parseStrictNumericString(value, key, context);
  }
  throw new Error(
    `[BinanceUserDataStream] Missing or invalid numeric field "${key}" in ${context}`
  );
}

function parseOptionalNumericField(
  obj: Record<string, unknown>,
  key: string,
  context: string
): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `[BinanceUserDataStream] Non-finite number for optional "${key}" in ${context}`
      );
    }
    return value;
  }
  if (typeof value === "string") {
    return parseStrictNumericString(value, key, context);
  }
  throw new Error(
    `[BinanceUserDataStream] Invalid type for optional numeric field "${key}" in ${context}`
  );
}

function requireNumericStringField(
  obj: Record<string, unknown>,
  key: string,
  context: string
): string {
  const raw = obj[key];
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new Error(
        `[BinanceUserDataStream] Non-finite number for "${key}" in ${context}`
      );
    }
    return String(raw);
  }
  if (typeof raw === "string") {
    parseStrictNumericString(raw, key, context);
    return raw.trim();
  }
  throw new Error(
    `[BinanceUserDataStream] Missing or invalid numeric string field "${key}" in ${context}`
  );
}

function describeUnknownValue(value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function parseOrderSide(value: unknown, context: string): "BUY" | "SELL" {
  if (value === "BUY" || value === "SELL") {
    return value;
  }
  throw new Error(
    `[BinanceUserDataStream] Invalid order side "${describeUnknownValue(value)}" in ${context}`
  );
}

function parseOrderStatus(
  value: unknown,
  context: string
): OrderTradeUpdatePayload["order"]["orderStatus"] {
  switch (value) {
    case "NEW":
    case "PARTIALLY_FILLED":
    case "FILLED":
    case "CANCELED":
    case "EXPIRED":
    case "REJECTED":
      return value;
    default:
      throw new Error(
        `[BinanceUserDataStream] Invalid orderStatus "${describeUnknownValue(value)}" in ${context}`
      );
  }
}

function parsePositionSide(
  value: unknown,
  context: string
): "LONG" | "SHORT" | "BOTH" {
  if (value === undefined || value === null) {
    return "BOTH";
  }
  if (value === "LONG" || value === "SHORT" || value === "BOTH") {
    return value;
  }
  throw new Error(
    `[BinanceUserDataStream] Invalid positionSide "${describeUnknownValue(value)}" in ${context}`
  );
}

function toRawPositionPayload(item: unknown): RawWsPositionPayload {
  if (!isRecord(item)) {
    throw new Error("[BinanceUserDataStream] Malformed position entry in ACCOUNT_UPDATE.a.P");
  }
  return {
    s: requireNonEmptyString(item, "s", "ACCOUNT_UPDATE.a.P"),
    pa: requireNumericStringField(item, "pa", "ACCOUNT_UPDATE.a.P"),
    ep: requireNumericStringField(item, "ep", "ACCOUNT_UPDATE.a.P"),
    cr: requireNumericStringField(item, "cr", "ACCOUNT_UPDATE.a.P"),
    up: requireNumericStringField(item, "up", "ACCOUNT_UPDATE.a.P"),
    ps: parsePositionSide(item["ps"], "ACCOUNT_UPDATE.a.P"),
  };
}

function toRawBalancePayload(item: unknown): RawWsBalancePayload {
  if (!isRecord(item)) {
    throw new Error("[BinanceUserDataStream] Malformed balance entry in ACCOUNT_UPDATE.a.B");
  }
  return {
    a: requireNonEmptyString(item, "a", "ACCOUNT_UPDATE.a.B"),
    wb: requireNumericStringField(item, "wb", "ACCOUNT_UPDATE.a.B"),
    cw: requireNumericStringField(item, "cw", "ACCOUNT_UPDATE.a.B"),
    bc: requireNumericStringField(item, "bc", "ACCOUNT_UPDATE.a.B"),
  };
}

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
          this.processWsMessage(rawDataToString(data));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[BinanceUserDataStream] Failed to parse WebSocket message: ${msg}`);
        }
      });

      this.ws.on("error", (err: Error) => {
        if (this.isDisposed) return;
        console.error(`[BinanceUserDataStream] WebSocket Error: ${err.message}`);
      });

      this.ws.on("close", (code: number, reason?: Buffer) => {
        this.isConnected = false;
        if (this.isDisposed) return;
        const reasonStr = reason ? reason.toString("utf8") : "";
        console.warn(`[BinanceUserDataStream] WebSocket closed [Code: ${String(code)}, Reason: ${reasonStr}]`);
        this.handleReconnect();
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BinanceUserDataStream] Failed to initiate WebSocket: ${msg}`);
    }
  }

  public processWsMessage(rawText: string): void {
    const payload: unknown = JSON.parse(rawText);
    if (!isRecord(payload)) {
      throw new Error("[BinanceUserDataStream] Expected WebSocket JSON object payload");
    }

    const eventType = requireNonEmptyString(payload, "e", "WebSocket message");
    if (eventType === "ORDER_TRADE_UPDATE") {
      if (!isRecord(payload["o"])) {
        throw new Error("[BinanceUserDataStream] Missing order payload \"o\" in ORDER_TRADE_UPDATE");
      }
      const ord = payload["o"];
      const executionType = requireNonEmptyString(ord, "x", "ORDER_TRADE_UPDATE.o");
      const commissionAmountOpt = parseOptionalNumericField(ord, "n", "ORDER_TRADE_UPDATE.o");
      if (executionType === "TRADE" && commissionAmountOpt === undefined) {
        throw new Error(
          "[BinanceUserDataStream] Missing required commission amount \"n\" for TRADE execution in ORDER_TRADE_UPDATE.o"
        );
      }

      const parsedUpdate: OrderTradeUpdatePayload = {
        eventType,
        eventTime: requireFiniteNumber(payload, "E", "ORDER_TRADE_UPDATE"),
        transactionTime: requireFiniteNumber(payload, "T", "ORDER_TRADE_UPDATE"),
        order: {
          symbol: requireNonEmptyString(ord, "s", "ORDER_TRADE_UPDATE.o"),
          clientOrderId: readOptionalString(ord, "c", "ORDER_TRADE_UPDATE.o"),
          side: parseOrderSide(ord["S"], "ORDER_TRADE_UPDATE.o"),
          orderType: requireNonEmptyString(ord, "o", "ORDER_TRADE_UPDATE.o"),
          timeInForce: requireNonEmptyString(ord, "f", "ORDER_TRADE_UPDATE.o"),
          originalQuantity: requireNumericField(ord, "q", "ORDER_TRADE_UPDATE.o"),
          originalPrice: requireNumericField(ord, "p", "ORDER_TRADE_UPDATE.o"),
          averagePrice: requireNumericField(ord, "ap", "ORDER_TRADE_UPDATE.o"),
          stopPrice: requireNumericField(ord, "sp", "ORDER_TRADE_UPDATE.o"),
          executionType,
          orderStatus: parseOrderStatus(ord["X"], "ORDER_TRADE_UPDATE.o"),
          orderId: requireFiniteNumber(ord, "i", "ORDER_TRADE_UPDATE.o"),
          lastFilledQuantity: requireNumericField(ord, "l", "ORDER_TRADE_UPDATE.o"),
          cumulativeFilledQuantity: requireNumericField(ord, "z", "ORDER_TRADE_UPDATE.o"),
          lastFilledPrice: requireNumericField(ord, "L", "ORDER_TRADE_UPDATE.o"),
          commissionAsset: readOptionalString(ord, "N", "ORDER_TRADE_UPDATE.o"),
          commissionAmount: commissionAmountOpt ?? 0,
          tradeTime: requireFiniteNumber(ord, "T", "ORDER_TRADE_UPDATE.o"),
          tradeId: requireFiniteNumber(ord, "t", "ORDER_TRADE_UPDATE.o"),
          bidsNotional: requireNumericField(ord, "b", "ORDER_TRADE_UPDATE.o"),
          isMaker: ord["m"] === true,
          positionSide: parsePositionSide(ord["ps"], "ORDER_TRADE_UPDATE.o"),
          realizedPnl: requireNumericField(ord, "rp", "ORDER_TRADE_UPDATE.o"),
          reduceOnly: ord["R"] === true,
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
      return;
    }

    if (eventType === "ACCOUNT_UPDATE") {
      if (!isRecord(payload["a"])) {
        throw new Error("[BinanceUserDataStream] Missing account payload \"a\" in ACCOUNT_UPDATE");
      }
      const acct = payload["a"];

      if (acct["P"] !== undefined && !Array.isArray(acct["P"])) {
        throw new Error("[BinanceUserDataStream] Expected array for \"P\" in ACCOUNT_UPDATE.a");
      }
      const rawPositions: RawWsPositionPayload[] = Array.isArray(acct["P"])
        ? acct["P"].map(toRawPositionPayload)
        : [];
      const positions: AccountPositionUpdatePayload[] = rawPositions.map((p) => ({
        symbol: p.s,
        positionAmt: parseStrictNumericString(p.pa, "pa", "ACCOUNT_UPDATE.a.P"),
        entryPrice: parseStrictNumericString(p.ep, "ep", "ACCOUNT_UPDATE.a.P"),
        accumulatedRealized: parseStrictNumericString(p.cr, "cr", "ACCOUNT_UPDATE.a.P"),
        unrealizedPnl: parseStrictNumericString(p.up, "up", "ACCOUNT_UPDATE.a.P"),
        positionSide: p.ps ?? "BOTH",
      }));

      if (acct["B"] !== undefined && !Array.isArray(acct["B"])) {
        throw new Error("[BinanceUserDataStream] Expected array for \"B\" in ACCOUNT_UPDATE.a");
      }
      const rawBalances: RawWsBalancePayload[] = Array.isArray(acct["B"])
        ? acct["B"].map(toRawBalancePayload)
        : [];
      const balances: AccountBalanceUpdatePayload[] = rawBalances.map((b) => ({
        asset: b.a,
        walletBalance: parseStrictNumericString(b.wb, "wb", "ACCOUNT_UPDATE.a.B"),
        crossWalletBalance: parseStrictNumericString(b.cw, "cw", "ACCOUNT_UPDATE.a.B"),
        balanceChange: parseStrictNumericString(b.bc, "bc", "ACCOUNT_UPDATE.a.B"),
      }));

      // CRITICAL FIX: The Binance ACCOUNT_UPDATE WebSocket event (payload.a.B) carries ONLY
      // `wb` (walletBalance) and `cw` (crossWalletBalance). It does NOT emit a true
      // `availableBalance` field. crossWalletBalance != availableBalance — it does not
      // account for open-order margin reservations.
      const usdtItem = balances.find((b) => b.asset === "USDT");
      if (usdtItem && Number.isFinite(usdtItem.walletBalance)) {
        this.client.updateWalletBalanceFromWs(usdtItem.walletBalance);
      }
      // Trigger an async REST fetch for the authoritative availableBalance.
      this.client.scheduleAvailableBalanceRefetch();

      const reasonType = requireNonEmptyString(acct, "m", "ACCOUNT_UPDATE.a");
      const accountUpdate: AccountUpdatePayload = {
        eventType,
        eventTime: requireFiniteNumber(payload, "E", "ACCOUNT_UPDATE"),
        transactionTime: requireFiniteNumber(payload, "T", "ACCOUNT_UPDATE"),
        reasonType,
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
  }

  private async reconnectWithFreshListenKey(): Promise<void> {
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
  }

  private async sendKeepAlivePing(): Promise<void> {
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
  }

  private handleReconnect(): void {
    if (this.isDisposed) return;

    if (this.reconnectAttempts >= this.maxReconnectRetries) {
      console.error(`[BinanceUserDataStream] Exceeded max reconnect attempts (${String(this.maxReconnectRetries)}). User Data Stream halted.`);
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempts++;
    const backoffMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(
      `[BinanceUserDataStream] Reconnecting in ${String(backoffMs)}ms (Attempt ${String(this.reconnectAttempts)}/${String(this.maxReconnectRetries)})...`
    );

    this.reconnectTimer = setTimeout(() => {
      void this.reconnectWithFreshListenKey();
    }, backoffMs);
  }

  private startKeepAliveTimer(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      void this.sendKeepAlivePing();
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
      const sock = this.ws;
      sock.removeAllListeners();
      sock.on("error", (teardownErr: Error) => {
        if (!teardownErr.message.includes("closed before the connection was established")) {
          console.warn(`[BinanceUserDataStream] Socket teardown warning: ${teardownErr.message}`);
        }
      });
      sock.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.orderCallbacks.clear();
    this.accountCallbacks.clear();
    console.log(`[BinanceUserDataStream] User Data Stream stopped.`);
  }
}
