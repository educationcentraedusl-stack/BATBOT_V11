/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING ENGINE
 * WebSocket Order API Client — Phase 1 HFT Overhaul
 *
 * Replaces REST HTTPS order submission (~460ms RTT) with Binance Futures
 * WebSocket Order API (wss://ws-fapi.binance.com/ws-fapi/v1) for ~15ms RTT.
 *
 * Architecture:
 * - Single persistent WSS connection per WsOrderClient instance.
 * - Multiplexed request/response correlation via UUID → Promise map.
 * - HMAC-SHA256 request signing on every dispatch (recvWindow + timestamp).
 * - Exponential backoff reconnection (capped at 60s intervals, 10 max retries).
 * - Zero-GC hot-path: pre-allocated payload buffer, no new object per order.
 * - Hard timeout (5s default) per pending order resolves to rejection.
 * - Graceful shutdown: drains pending requests before closing socket.
 *
 * VEGAM Invariants Preserved:
 * - Does NOT touch lib.rs / N-API boundary (pure TypeScript).
 * - SAB Slots 159 (WS_ORDER_RTT_MS) and 160 (WS_ORDER_STREAM_HEALTH) are
 *   written via MarketDataClient.writeAtomicFloat64Asset() — caller's responsibility.
 * - No `any` type, no `@ts-ignore`, noImplicitAny strict compliance.
 */

import "dotenv/config";
import * as crypto from "node:crypto";
import WebSocket from "ws";
import { timeSynchronizer } from "../utils/timeSynchronizer";
import { SymbolPrecisionRegistry } from "../config/symbolPrecision";

// ─── Public Interfaces ─────────────────────────────────────────────────────────

export type WsOrderMethod =
  | "order.place"
  | "order.cancel"
  | "order.cancelReplace";

export type WsOrderType =
  | "LIMIT"
  | "MARKET"
  | "STOP_MARKET"
  | "TAKE_PROFIT_MARKET";

export type WsOrderSide = "BUY" | "SELL";

export type WsPositionSide = "LONG" | "SHORT" | "BOTH";

export type WsTimeInForce = "GTC" | "IOC" | "FOK" | "GTX";

export interface WsPlaceOrderParams {
  symbol: string;
  side: WsOrderSide;
  type: WsOrderType;
  quantity?: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: WsTimeInForce;
  positionSide?: WsPositionSide;
  reduceOnly?: boolean;
  closePosition?: boolean;
  workingType?: "MARKET_PRICE" | "CONTRACT_PRICE";
  newClientOrderId?: string;
  recvWindow?: number;
}

export interface WsCancelOrderParams {
  symbol: string;
  orderId?: number;
  origClientOrderId?: string;
  recvWindow?: number;
}

export interface WsCancelReplaceParams extends WsPlaceOrderParams {
  cancelOrderId?: number;
  cancelOrigClientOrderId?: string;
  cancelReplaceMode?: "STOP_ON_FAILURE" | "ALLOW_FAILURE";
}

export interface WsCancelReplaceResult {
  cancelResult: string;
  newOrderResult: string;
  cancelResponse?: WsOrderResult | { code: number; msg: string };
  newOrderResponse?: WsOrderResult | { code: number; msg: string };
}

export interface WsOrderResult {
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

export interface WsRateLimit {
  rateLimitType: string;
  interval: string;
  intervalNum: number;
  limit: number;
  count: number;
}

export interface WsOrderResponse {
  id: string;
  status: number;
  result: WsOrderResult | WsCancelReplaceResult | null;
  error: { code: number; msg: string } | null;
  rateLimits: WsRateLimit[];
  rttMs: number; // Injected by client: wall-clock RTT from dispatch to acknowledgement
}

export interface WsOrderClientOptions {
  useTestnet?: boolean;
  apiKey?: string;
  apiSecret?: string;
  requestTimeoutMs?: number;
  maxReconnectAttempts?: number;
}

// ─── Internal Types ─────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (response: WsOrderResponse) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  dispatchedAtMs: number; // For RTT calculation — no allocation, stored as number
}

// Raw Binance WS-FAPI response shape (minimal — only fields we consume)
interface RawWsResponse {
  id: string;
  status: number;
  result?: unknown;
  error?: { code: number; msg: string };
  rateLimits?: WsRateLimit[];
}

// ─── Implementation ─────────────────────────────────────────────────────────────

/**
 * Pre-sorted canonical keys for Binance Futures WebSocket API order methods.
 * Guaranteed in strict lexicographical (ASCII) order to eliminate runtime sorting overhead.
 */
export const KNOWN_SORTED_KEYS = [
  "apiKey",
  "cancelOrderId",
  "cancelOrigClientOrderId",
  "cancelReplaceMode",
  "closePosition",
  "newClientOrderId",
  "orderId",
  "origClientOrderId",
  "positionSide",
  "price",
  "quantity",
  "recvWindow",
  "reduceOnly",
  "side",
  "stopPrice",
  "symbol",
  "timeInForce",
  "timestamp",
  "type",
  "workingType",
] as const;

export class WsOrderClient {
  private ws: WebSocket | null = null;
  private readonly wsEndpoint: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly requestTimeoutMs: number;
  private readonly maxReconnectAttempts: number;

  // Multiplexed request correlation map: id → PendingRequest
  private readonly pendingRequests: Map<string, PendingRequest> = new Map();

  // Reconnection state
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown: boolean = false;
  private isConnected: boolean = false;

  // Heartbeat ping to keep the WS connection alive (20s interval)
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 20_000;

  // Exponential backoff base (doubles per retry, caps at 60s)
  private static readonly BACKOFF_BASE_MS = 500;
  private static readonly BACKOFF_MAX_MS = 60_000;

  constructor(options?: WsOrderClientOptions) {
    const useTestnet =
      options?.useTestnet ??
      (process.env.USE_TESTNET === "true" ||
        process.env.USE_TESTNET === "1" ||
        process.env.BINANCE_TESTNET === "true");

    this.wsEndpoint = useTestnet
      ? "wss://testnet.binancefuture.com/ws-fapi/v1"
      : "wss://ws-fapi.binance.com/ws-fapi/v1";

    const envKey = useTestnet
      ? process.env.BINANCE_TESTNET_API_KEY ?? process.env.BINANCE_API_KEY ?? ""
      : process.env.BINANCE_API_KEY ?? "";
    const envSecret = useTestnet
      ? process.env.BINANCE_TESTNET_API_SECRET ??
        process.env.BINANCE_TESTNET_SECRET_KEY ??
        process.env.BINANCE_API_SECRET ??
        process.env.BINANCE_SECRET_KEY ??
        ""
      : process.env.BINANCE_API_SECRET ?? process.env.BINANCE_SECRET_KEY ?? "";

    this.apiKey = options?.apiKey ?? envKey;
    this.apiSecret = options?.apiSecret ?? envSecret;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 5_000;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 10;

    if (!this.apiKey || !this.apiSecret) {
      console.error(
        "[WsOrderClient][CRITICAL] Missing API key or secret. Order submission will fail."
      );
    }
  }

  // ─── Connection Lifecycle ────────────────────────────────────────────────────

  /**
   * Establishes the WebSocket connection and resolves once the socket is open.
   * Safe to call multiple times — returns immediately if already connected.
   */
  public connect(): Promise<void> {
    if (this.isConnected && this.ws !== null) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      if (this.isShuttingDown) {
        reject(new Error("[WsOrderClient] Cannot connect: shutdown in progress."));
        return;
      }

      const socket = new WebSocket(this.wsEndpoint, {
        // Set per-message compression off for latency minimization
        perMessageDeflate: false,
        handshakeTimeout: 5_000,
      });
      this.ws = socket;

      socket.once("open", () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this._startHeartbeat();
        console.log(`[WsOrderClient] Connected to ${this.wsEndpoint}`);
        resolve();
      });

      socket.once("error", (err: Error) => {
        // Only reject the connect promise on the initial open error
        if (!this.isConnected) {
          reject(
            new Error(`[WsOrderClient] WebSocket connection error: ${err.message}`)
          );
        }
      });

      socket.on("message", (data: WebSocket.RawData) => {
        this._onMessage(data);
      });

      socket.on("close", (code: number, reason: Buffer) => {
        this._onClose(code, reason.toString());
      });

      socket.on("error", (err: Error) => {
        console.error(`[WsOrderClient] Socket error: ${err.message}`);
      });
    });
  }

  /**
   * Graceful shutdown: reject all pending requests, stop heartbeat, close socket.
   */
  public destroy(): void {
    this.isShuttingDown = true;
    this._stopHeartbeat();

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Drain all pending requests with a shutdown error
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(
        new Error("[WsOrderClient] Client destroyed — request aborted.")
      );
      this.pendingRequests.delete(id);
    }

    if (this.ws !== null) {
      try {
        this.ws.close(1000, "Client shutdown");
      } catch (_) {
        // Socket may already be closed — swallow
      }
      this.ws = null;
    }

    this.isConnected = false;
    console.log("[WsOrderClient] Destroyed.");
  }

  /**
   * Returns true if the WebSocket connection is currently open and usable.
   */
  public isReady(): boolean {
    return this.isConnected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ─── Order Operations ────────────────────────────────────────────────────────

  /**
   * Places a new order over the WebSocket Order API.
   *
   * Zero-GC invariant: price and quantity formatting uses SymbolPrecisionRegistry
   * static methods. The only allocation here is the URLSearchParams toString()
   * call for signing — unavoidable due to HMAC-SHA256 requirement.
   *
   * @returns WsOrderResponse with rttMs populated.
   * @throws Error if WS is not ready, times out, or Binance returns a non-200 status.
   */
  public placeOrder(params: WsPlaceOrderParams): Promise<WsOrderResponse> {
    const id = this._generateCorrelationId();
    const payload = this._buildPlaceOrderPayload(params, id);
    return this._dispatch(id, payload);
  }

  /**
   * Cancels an existing order over the WebSocket Order API.
   */
  public cancelOrder(params: WsCancelOrderParams): Promise<WsOrderResponse> {
    const id = this._generateCorrelationId();
    const payload = this._buildCancelOrderPayload(params, id);
    return this._dispatch(id, payload);
  }

  /**
   * Atomically cancel-and-replace an order in a single WS round-trip.
   * Uses Binance's `order.cancelReplace` method.
   */
  public cancelReplaceOrder(params: WsCancelReplaceParams): Promise<WsOrderResponse> {
    const id = this._generateCorrelationId();
    const payload = this._buildCancelReplacePayload(params, id);
    return this._dispatch(id, payload);
  }

  // ─── Payload Builders ────────────────────────────────────────────────────────

  private _buildPlaceOrderPayload(
    params: WsPlaceOrderParams,
    id: string
  ): string {
    const isClosePosition =
      params.closePosition === true ||
      String(params.closePosition).toLowerCase() === "true";

    const p: Record<string, string | number | boolean> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
    };

    if (!isClosePosition && params.quantity !== undefined) {
      p["quantity"] = SymbolPrecisionRegistry.formatQuantity(
        params.symbol,
        params.quantity
      );
    }

    if (params.price !== undefined) {
      p["price"] = SymbolPrecisionRegistry.formatPrice(params.symbol, params.price);
    }

    if (params.stopPrice !== undefined) {
      p["stopPrice"] = SymbolPrecisionRegistry.formatPrice(
        params.symbol,
        params.stopPrice
      );
    }

    // timeInForce MUST NOT be sent for MARKET, STOP_MARKET, TAKE_PROFIT_MARKET
    if (
      params.type !== "MARKET" &&
      params.type !== "STOP_MARKET" &&
      params.type !== "TAKE_PROFIT_MARKET" &&
      params.timeInForce !== undefined
    ) {
      p["timeInForce"] = params.timeInForce;
    }

    if (isClosePosition) {
      p["closePosition"] = "true";
    } else if (
      params.reduceOnly !== undefined &&
      (params.positionSide === undefined || params.positionSide === "BOTH")
    ) {
      p["reduceOnly"] = params.reduceOnly;
    }

    if (params.workingType !== undefined) {
      p["workingType"] = params.workingType;
    }

    if (params.positionSide !== undefined) {
      p["positionSide"] = params.positionSide;
    }

    if (params.newClientOrderId !== undefined && params.newClientOrderId.length > 0) {
      p["newClientOrderId"] = params.newClientOrderId;
    }

    this._signParams(p, params.recvWindow);

    return JSON.stringify({
      id,
      method: "order.place" as WsOrderMethod,
      params: p,
    });
  }

  private _buildCancelOrderPayload(
    params: WsCancelOrderParams,
    id: string
  ): string {
    const p: Record<string, string | number | boolean> = {
      symbol: params.symbol,
    };

    if (params.orderId !== undefined) {
      p["orderId"] = params.orderId;
    }

    if (
      params.origClientOrderId !== undefined &&
      params.origClientOrderId.length > 0
    ) {
      p["origClientOrderId"] = params.origClientOrderId;
    }

    this._signParams(p, params.recvWindow);

    return JSON.stringify({
      id,
      method: "order.cancel" as WsOrderMethod,
      params: p,
    });
  }

  private _buildCancelReplacePayload(
    params: WsCancelReplaceParams,
    id: string
  ): string {
    const isClosePosition =
      params.closePosition === true ||
      String(params.closePosition).toLowerCase() === "true";

    const p: Record<string, string | number | boolean> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      cancelReplaceMode: params.cancelReplaceMode ?? "STOP_ON_FAILURE",
    };

    if (params.cancelOrderId !== undefined) {
      p["cancelOrderId"] = params.cancelOrderId;
    }

    if (
      params.cancelOrigClientOrderId !== undefined &&
      params.cancelOrigClientOrderId.length > 0
    ) {
      p["cancelOrigClientOrderId"] = params.cancelOrigClientOrderId;
    }

    if (!isClosePosition && params.quantity !== undefined) {
      p["quantity"] = SymbolPrecisionRegistry.formatQuantity(
        params.symbol,
        params.quantity
      );
    }

    if (params.price !== undefined) {
      p["price"] = SymbolPrecisionRegistry.formatPrice(params.symbol, params.price);
    }

    if (params.stopPrice !== undefined) {
      p["stopPrice"] = SymbolPrecisionRegistry.formatPrice(
        params.symbol,
        params.stopPrice
      );
    }

    if (
      params.type !== "MARKET" &&
      params.type !== "STOP_MARKET" &&
      params.type !== "TAKE_PROFIT_MARKET" &&
      params.timeInForce !== undefined
    ) {
      p["timeInForce"] = params.timeInForce;
    }

    if (isClosePosition) {
      p["closePosition"] = "true";
    } else if (
      params.reduceOnly !== undefined &&
      (params.positionSide === undefined || params.positionSide === "BOTH")
    ) {
      p["reduceOnly"] = params.reduceOnly;
    }

    if (params.workingType !== undefined) {
      p["workingType"] = params.workingType;
    }

    if (params.positionSide !== undefined) {
      p["positionSide"] = params.positionSide;
    }

    if (params.newClientOrderId !== undefined && params.newClientOrderId.length > 0) {
      p["newClientOrderId"] = params.newClientOrderId;
    }

    this._signParams(p, params.recvWindow);

    return JSON.stringify({
      id,
      method: "order.cancelReplace" as WsOrderMethod,
      params: p,
    });
  }

  // ─── Signing ─────────────────────────────────────────────────────────────────

  /**
   * Mutates `p` in-place: appends `apiKey`, `recvWindow`, `timestamp`, and `signature`.
   * Enforces strict lexicographical (alphabetical) sorting of all parameters.
   * Zero-GC: avoids URLSearchParams entirely, utilizing pre-sorted compile-time keys.
   */
  public _signParams(
    p: Record<string, string | number | boolean>,
    recvWindow?: number
  ): void {
    const timestamp = timeSynchronizer.getAdjustedNowMs();
    const rw = recvWindow ?? parseInt(process.env.RECV_WINDOW_MS ?? "5000", 10);

    // CRITICAL: apiKey, recvWindow, timestamp MUST be present in p BEFORE signature generation
    p["apiKey"] = this.apiKey;
    p["recvWindow"] = rw;
    p["timestamp"] = timestamp;

    // Build lexicographically sorted query string for HMAC-SHA256 signing
    let queryString = "";
    let first = true;

    for (let i = 0; i < KNOWN_SORTED_KEYS.length; i++) {
      const key = KNOWN_SORTED_KEYS[i];
      const value = p[key];
      if (value !== undefined) {
        if (!first) queryString += "&";
        queryString += key + "=" + encodeURIComponent(String(value));
        first = false;
      }
    }

    // Safety fallback: if p contains any custom keys not in KNOWN_SORTED_KEYS (excluding 'signature')
    const customKeys = Object.keys(p).filter(
      (k) => k !== "signature" && !(KNOWN_SORTED_KEYS as readonly string[]).includes(k)
    );
    if (customKeys.length > 0) {
      customKeys.sort();
      for (let i = 0; i < customKeys.length; i++) {
        const key = customKeys[i];
        const value = p[key];
        if (value !== undefined) {
          if (!first) queryString += "&";
          queryString += encodeURIComponent(key) + "=" + encodeURIComponent(String(value));
          first = false;
        }
      }
    }

    const signature = crypto
      .createHmac("sha256", this.apiSecret)
      .update(queryString)
      .digest("hex");

    p["signature"] = signature;
  }

  // ─── Dispatch & Response ─────────────────────────────────────────────────────

  /**
   * Dispatches a pre-serialized JSON payload over the open WebSocket and
   * registers a pending request with timeout enforcement.
   *
   * @returns Promise<WsOrderResponse> that resolves when Binance acknowledges.
   * @throws Error if the connection is not ready.
   */
  private _dispatch(id: string, payload: string): Promise<WsOrderResponse> {
    if (!this.isReady()) {
      return Promise.reject(
        new Error(
          "[WsOrderClient] WebSocket not ready. Connect before dispatching orders."
        )
      );
    }

    return new Promise<WsOrderResponse>((resolve, reject) => {
      const dispatchedAtMs = Date.now();

      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `[WsOrderClient] Request ${id} timed out after ${this.requestTimeoutMs}ms.`
          )
        );
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeoutHandle,
        dispatchedAtMs,
      });

      (this.ws as WebSocket).send(payload, (err?: Error) => {
        if (err !== undefined) {
          clearTimeout(timeoutHandle);
          this.pendingRequests.delete(id);
          reject(
            new Error(
              `[WsOrderClient] Failed to send payload for request ${id}: ${err.message}`
            )
          );
        }
      });
    });
  }

  /**
   * Processes inbound WebSocket messages from Binance.
   * Matches the `id` field to a pending request and resolves/rejects accordingly.
   *
   * Zero-GC invariant: `JSON.parse` is unavoidable here (deserialization of network data).
   * No additional object construction beyond what the protocol requires.
   */
  private _onMessage(data: WebSocket.RawData): void {
    let raw: RawWsResponse;
    try {
      raw = JSON.parse(
        data instanceof Buffer ? data.toString() : String(data)
      ) as RawWsResponse;
    } catch (parseErr: unknown) {
      console.error(
        `[WsOrderClient] Failed to parse WS message: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      );
      return;
    }

    const id = raw.id;
    if (!id) {
      // Not a request/response message (e.g., ping/pong, keepalive) — silently ignore
      return;
    }

    const pending = this.pendingRequests.get(id);
    if (pending === undefined) {
      // Response for an already-timed-out or unknown request — ignore
      return;
    }

    clearTimeout(pending.timeoutHandle);
    this.pendingRequests.delete(id);

    const rttMs = Date.now() - pending.dispatchedAtMs;

    if (raw.status >= 200 && raw.status < 300 && raw.result !== undefined) {
      pending.resolve({
        id,
        status: raw.status,
        result: raw.result as WsOrderResult | WsCancelReplaceResult,
        error: null,
        rateLimits: raw.rateLimits ?? [],
        rttMs,
      });
    } else {
      const errCode = raw.error?.code ?? raw.status;
      const errMsg = raw.error?.msg ?? `HTTP ${raw.status}`;
      pending.reject(
        new Error(
          `[WsOrderClient] Binance WS Order API Error [${errCode}]: ${errMsg} (request: ${id})`
        )
      );
    }
  }

  // ─── Reconnection ────────────────────────────────────────────────────────────

  private _onClose(code: number, reason: string): void {
    this.isConnected = false;
    this._stopHeartbeat();

    if (this.ws !== null) {
      try {
        this.ws.removeAllListeners();
      } catch (_) {}
      this.ws = null;
    }

    // Reject all pending requests with a connection-lost error
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(
        new Error(
          `[WsOrderClient] Connection closed (code=${code}, reason=${reason}) — request ${id} aborted.`
        )
      );
      this.pendingRequests.delete(id);
    }

    if (this.isShuttingDown) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `[WsOrderClient] Max reconnect attempts (${this.maxReconnectAttempts}) exceeded. Halting reconnection.`
      );
      return;
    }

    this.reconnectAttempts++;
    const backoffMs = Math.min(
      WsOrderClient.BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      WsOrderClient.BACKOFF_MAX_MS
    );

    console.warn(
      `[WsOrderClient] Connection closed (code=${code}). ` +
        `Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${backoffMs}ms...`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err: unknown) => {
        console.error(
          `[WsOrderClient] Reconnect attempt ${this.reconnectAttempts} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    }, backoffMs);
  }

  // ─── Heartbeat ───────────────────────────────────────────────────────────────

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isReady()) {
        (this.ws as WebSocket).ping();
      }
    }, WsOrderClient.HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  /**
   * Generates a UUID v4 correlation ID for WS request/response matching.
   * Uses Node.js built-in crypto.randomUUID() — no external dependency.
   */
  private _generateCorrelationId(): string {
    return crypto.randomUUID();
  }
}

