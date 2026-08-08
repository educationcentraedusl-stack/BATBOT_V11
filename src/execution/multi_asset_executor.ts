import "dotenv/config";
import {
  startMultiAssetOmsNapi,
  submitMultiAssetIntentNapi,
  applyMultiAssetFillNapi,
  getMultiAssetOmsMetricsNapi,
  popNextIntentPacketNapi,
  syncMultiOmsSabNapi,
} from "../../index";
import { BinanceExecutionClient, BinanceClientOptions } from "./binance";
import { BinanceUserDataStream, OrderTradeUpdatePayload } from "./userDataStream";

export interface MultiAssetExecutorConfig {
  initialBalanceUsd: number;
  activeSymbols: string[];
  clientOptions?: BinanceClientOptions;
}

export interface ExecutionMetrics {
  assetIdx: number;
  symbol: string;
  totalOrdersSubmitted: number;
  totalOrdersFilled: number;
  totalOrdersCanceled: number;
  totalOrdersRejected: number;
  totalVolumeUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  currentPositionSize: number;
  avgEntryPrice: number;
}

export interface OrderIntentSlice {
  client_order_id: string;
  symbol: string;
  asset_idx: number;
  side: "Buy" | "Sell";
  order_type: "Limit" | "Market";
  time_in_force: string;
  quantity: number;
  price: number;
  reduce_only: boolean;
  post_only: boolean;
  target_horizon_ms: number;
  ai_confidence: number;
  ai_direction: number;
  creation_ns: number;
}

export interface IntentSubmissionResult {
  status: "SUBMITTED" | "REJECTED";
  slices?: OrderIntentSlice[];
  reason?: string;
}

export interface IntentOptions {
  postOnly?: boolean;
  targetHorizonMs?: number;
  aiConfidence?: number;
  timeInForce?: "Gtc" | "Ioc" | "Fok" | "Gtx";
  reduceOnly?: boolean;
}

export class MultiAssetExecutor {
  private initialBalanceUsd: number;
  private activeSymbols: string[];
  private symbolToIdxMap: Map<string, number> = new Map();
  private client: BinanceExecutionClient;
  private userStream: BinanceUserDataStream;
  private isRunning: boolean = false;

  constructor(config: MultiAssetExecutorConfig) {
    this.initialBalanceUsd = config.initialBalanceUsd;
    this.activeSymbols = config.activeSymbols.slice(0, 10);

    this.activeSymbols.forEach((sym, idx) => {
      this.symbolToIdxMap.set(sym, idx);
    });

    this.client = new BinanceExecutionClient(config.clientOptions);
    this.userStream = new BinanceUserDataStream(this.client);

    // Initialize Rust Native MultiAssetOmsEngine
    startMultiAssetOmsNapi(this.initialBalanceUsd, JSON.stringify(this.activeSymbols));
  }

  public async start(): Promise<boolean> {
    if (this.isRunning) return true;

    // Subscribe to Binance User Data Stream for live order updates
    this.userStream.subscribeOrderUpdates((update: OrderTradeUpdatePayload) => {
      this.handleUserStreamUpdate(update);
    });

    await this.userStream.start();
    this.isRunning = true;
    return true;
  }

  public stop(): void {
    this.userStream.stop();
    this.isRunning = false;
  }

  public getAssetIndex(symbol: string): number {
    const idx = this.symbolToIdxMap.get(symbol);
    if (idx === undefined) {
      throw new Error(`[MultiAssetExecutor] Unmapped symbol '${symbol}' not found in activeSymbols`);
    }
    return idx;
  }

  public submitIntent(
    symbol: string,
    side: "BUY" | "SELL",
    orderType: "LIMIT" | "MARKET" | "STOP_MARKET" | "TAKE_PROFIT_MARKET",
    quantity: number,
    price: number,
    midPrice: number,
    top5DepthUsd: number,
    stepSize: number = 0.001,
    tickSize: number = 0.01,
    portfolioLeverage: number = 0.0,
    avgCorrelation: number = 0.0,
    options?: IntentOptions
  ): IntentSubmissionResult {
    const assetIdx = this.getAssetIndex(symbol);
    const isMarket = orderType === "MARKET";
    const postOnly = isMarket ? false : (options?.postOnly ?? true);
    const timeInForce = isMarket ? "Ioc" : (options?.timeInForce ?? "Gtx");
    const targetHorizonMs = options?.targetHorizonMs ?? 100.0;
    const aiConfidence = options?.aiConfidence ?? 0.85;
    const reduceOnly = options?.reduceOnly ?? false;

    const nanoTimeStr = process.hrtime.bigint().toString();

    const baseJson = JSON.stringify({
      client_order_id: `BAT_${assetIdx}_${Date.now()}`,
      symbol,
      asset_idx: assetIdx,
      side: side === "BUY" ? "Buy" : "Sell",
      order_type: isMarket ? "Market" : "Limit",
      time_in_force: timeInForce,
      quantity,
      price,
      reduce_only: reduceOnly,
      post_only: postOnly,
      target_horizon_ms: targetHorizonMs,
      ai_confidence: aiConfidence,
      ai_direction: side === "BUY" ? 1.0 : -1.0,
    });
    const intentJson = baseJson.substring(0, baseJson.length - 1) + `,"creation_ns":${nanoTimeStr}}`;

    try {
      const resStr = submitMultiAssetIntentNapi(
        assetIdx,
        intentJson,
        midPrice,
        top5DepthUsd,
        stepSize,
        tickSize,
        portfolioLeverage,
        avgCorrelation
      );

      if (resStr.startsWith('{"status":"REJECTED"')) {
        const parsed = JSON.parse(resStr) as { status: string; reason?: string };
        return { status: "REJECTED", reason: parsed.reason };
      } else {
        const slices = JSON.parse(resStr) as OrderIntentSlice[];
        return { status: "SUBMITTED", slices };
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { status: "REJECTED", reason: errorMsg };
    }
  }

  public popNextPacket(): OrderIntentSlice | null {
    try {
      const pktStr = popNextIntentPacketNapi();
      if (!pktStr) return null;
      return JSON.parse(pktStr) as OrderIntentSlice;
    } catch (err: unknown) {
      console.error("[MultiAssetExecutor] Failed to pop intent packet:", err);
      return null;
    }
  }

  public syncSab(sabBuffer: Buffer): boolean {
    return syncMultiOmsSabNapi(sabBuffer);
  }

  public getMetrics(symbol: string): ExecutionMetrics {
    const assetIdx = this.getAssetIndex(symbol);
    const metricsStr = getMultiAssetOmsMetricsNapi(assetIdx);
    try {
      const raw = JSON.parse(metricsStr) as Record<string, number>;
      return {
        assetIdx: raw.asset_idx ?? assetIdx,
        symbol,
        totalOrdersSubmitted: raw.total_orders_submitted ?? 0,
        totalOrdersFilled: raw.total_orders_filled ?? 0,
        totalOrdersCanceled: raw.total_orders_canceled ?? 0,
        totalOrdersRejected: raw.total_orders_rejected ?? 0,
        totalVolumeUsd: raw.total_volume_usd ?? 0,
        realizedPnlUsd: raw.realized_pnl_usd ?? 0,
        unrealizedPnlUsd: raw.unrealized_pnl_usd ?? 0,
        currentPositionSize: raw.current_position_size ?? 0,
        avgEntryPrice: raw.avg_entry_price ?? 0,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`[MultiAssetExecutor] Failed to parse metrics for ${symbol}: ${errorMsg}`);
    }
  }

  private handleUserStreamUpdate(update: OrderTradeUpdatePayload): void {
    if (!update || update.eventType !== "ORDER_TRADE_UPDATE") return;
    try {
      const ord = update.order;
      const assetIdx = this.getAssetIndex(ord.symbol);

      const reportJson = JSON.stringify({
        client_order_id: ord.clientOrderId,
        order_id: ord.orderId,
        symbol: ord.symbol,
        asset_idx: assetIdx,
        side: ord.side === "BUY" ? "Buy" : "Sell",
        status: ord.orderStatus,
        last_filled_qty: ord.lastFilledQuantity,
        last_filled_price: ord.lastFilledPrice,
        cum_filled_qty: ord.cumulativeFilledQuantity,
        avg_price: ord.averagePrice,
        commission: ord.commissionAmount,
        commission_asset: ord.commissionAsset,
        trade_id: ord.tradeId,
        event_time_ns: ord.tradeTime * 1_000_000,
        is_maker: ord.isMaker,
      });

      applyMultiAssetFillNapi(reportJson);
    } catch (err: unknown) {
      console.error("[MultiAssetExecutor] Error in user stream fill update processing:", err);
    }
  }
}
