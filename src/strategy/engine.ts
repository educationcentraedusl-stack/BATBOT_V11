import { MarketDataClient } from "../marketDataClient";
import { RiskGuard, MultiAssetRiskGuard, OrderIntent, RiskCheckResult } from "./risk";
import { BinanceExecutionClient, BinanceOrderResponse, BinanceOrderParams, BinancePositionRisk } from "../execution/binance";
import { PositionLedger, HedgePositionLedger, MultiAssetPositionLedger, PositionSlot, SlotExitTrigger, ActiveTradeSlot } from "./positionLedger";
import { DynamicRiskEngine, DynamicMicrostructureMetrics, DynamicRiskProfile } from "./dynamicRiskEngine";
import { MicrostructureHazardEngine } from "./microstructureHazardEngine";
import { VolatilitySurfaceEngine } from "./volatilitySurfaceEngine";
import { HJBReservationEngine } from "./hjbReservationEngine";
import { BinanceUserDataStream, OrderTradeUpdatePayload } from "../execution/userDataStream";
import { SymbolPrecisionRegistry } from "../config/symbolPrecision";
import { getTradingSymbols } from "../config/tradingSymbols";

export interface StrategyConfig {
  symbol: string;
  orderQuantity: number;
  tradeSizeUsdt: number;
  obiBuyThreshold: number;
  obiSellThreshold: number;
  cvdBuyThreshold: number;
  cvdSellThreshold: number;
  maxSpreadVelocity: number;
  minAiConfidence: number;
  aggressiveConfidenceThreshold: number;
  tickSize: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  longTakeProfitPercent: number;
  longStopLossPercent: number;
  shortTakeProfitPercent: number;
  shortStopLossPercent: number;
  dailyProfitLockUsdt: number;
  maxShortSlots: number;
  leverageMultiplier: number;
  maxSpreadEth: number;
  maxSpreadBtc: number;
  maxSpreadAlt: number;
  minNotionalUsdt: number;
  cooldownMs: number;
  vpinThreshold: number;
  vpinBucketVolume: number;
  assetIndex?: number;
}

export function getSymbolQuantityPrecision(symbol: string): { decimals: number; stepSize: number; minNotional: number } {
  const rule = SymbolPrecisionRegistry.getPrecisionRule(symbol);
  return {
    decimals: rule.qtyDecimals,
    stepSize: rule.stepSize,
    minNotional: rule.minNotional,
  };
}

export function formatQuantityForSymbol(symbol: string, rawQty: number, isMinNotionalGuard: boolean = false): number {
  return SymbolPrecisionRegistry.formatQuantity(symbol, rawQty, isMinNotionalGuard);
}

export type EngineState = "LIVE_ACTIVE" | "TRAINING_LOCK" | "RECALIBRATING" | "PAUSED" | "EMERGENCY_HALT";

export interface StrategySignalResult {
  sequenceNum: bigint;
  signalType: "NONE" | "BUY" | "SELL";
  positionSide?: "LONG" | "SHORT";
  slotId?: string;
  targetSlotIndex?: number;
  obi: number;
  cvd: number;
  spreadVelocity: number;
  bidPrice: number;
  askPrice: number;
  riskResult?: RiskCheckResult;
  executionPromise?: Promise<BinanceOrderResponse | null>;
  exitReason?: string;
}

export class StrategyEngine {
  private client: MarketDataClient;
  private riskGuard: RiskGuard;
  private executionClient: BinanceExecutionClient;
  private positionLedger: PositionLedger;
  private hedgeLedger: HedgePositionLedger;
  private config: StrategyConfig;
  private dynamicRiskEngine: DynamicRiskEngine = new DynamicRiskEngine();
  private hazardEngine: MicrostructureHazardEngine;
  private hjbEngine: HJBReservationEngine;
  private volEngine: VolatilitySurfaceEngine;
  private userDataStream: BinanceUserDataStream | null = null;
  private lastProcessedSequence: bigint = -1n;
  private state: EngineState = "LIVE_ACTIVE";
  private assetIndex: number = 0;
  private isOrderInFlight: boolean = false;
  private pendingEntryOrders: Map<number, { slotId: string; posSide: "LONG" | "SHORT"; slotIndex?: number; qty: number; targetPrice: number }> = new Map();

  private reusableOrderIntent!: OrderIntent;

  // Reusable static result object for NONE signals to achieve zero GC-heap allocation in hot path
  private staticResult: StrategySignalResult = {
    sequenceNum: 0n,
    signalType: "NONE",
    obi: 0,
    cvd: 0,
    spreadVelocity: 0,
    bidPrice: 0,
    askPrice: 0,
  };

  constructor(
    client: MarketDataClient,
    riskGuard: RiskGuard,
    executionClient: BinanceExecutionClient,
    config?: Partial<StrategyConfig>,
    positionLedger?: PositionLedger,
    hedgeLedger?: HedgePositionLedger
  ) {
    this.client = client;
    this.riskGuard = riskGuard;
    this.executionClient = executionClient;

    const envLongTp = process.env.LONG_TAKE_PROFIT_PERCENT ? parseFloat(process.env.LONG_TAKE_PROFIT_PERCENT) : NaN;
    const envLongSl = process.env.LONG_STOP_LOSS_PERCENT ? parseFloat(process.env.LONG_STOP_LOSS_PERCENT) : NaN;
    const envShortTp = process.env.SHORT_TAKE_PROFIT_PERCENT ? parseFloat(process.env.SHORT_TAKE_PROFIT_PERCENT) : NaN;
    const envShortSl = process.env.SHORT_STOP_LOSS_PERCENT ? parseFloat(process.env.SHORT_STOP_LOSS_PERCENT) : NaN;
    const envProfitLock = process.env.DAILY_PROFIT_LOCK_USDT ? parseFloat(process.env.DAILY_PROFIT_LOCK_USDT) : NaN;
    const envMaxShortSlots = process.env.MAX_SHORT_SLOTS ? parseInt(process.env.MAX_SHORT_SLOTS, 10) : NaN;
    const envMinAiConfidence = process.env.MIN_AI_CONFIDENCE ? parseFloat(process.env.MIN_AI_CONFIDENCE) : NaN;
    const envAggressiveConfidence = process.env.AGGRESSIVE_CONFIDENCE_THRESHOLD ? parseFloat(process.env.AGGRESSIVE_CONFIDENCE_THRESHOLD) : NaN;
    const envObiBuy = process.env.OBI_BUY_THRESHOLD ? parseFloat(process.env.OBI_BUY_THRESHOLD) : NaN;
    const envObiSell = process.env.OBI_SELL_THRESHOLD ? parseFloat(process.env.OBI_SELL_THRESHOLD) : NaN;
    const envCvdBuy = process.env.CVD_BUY_THRESHOLD ? parseFloat(process.env.CVD_BUY_THRESHOLD) : NaN;
    const envCvdSell = process.env.CVD_SELL_THRESHOLD ? parseFloat(process.env.CVD_SELL_THRESHOLD) : NaN;
    const envMaxSpreadVelocity = process.env.MAX_SPREAD_VELOCITY ? parseFloat(process.env.MAX_SPREAD_VELOCITY) : NaN;
    const envOrderQty = process.env.ORDER_QUANTITY ? parseFloat(process.env.ORDER_QUANTITY) : NaN;
    const envLeverage = process.env.LEVERAGE ? parseInt(process.env.LEVERAGE, 10) : NaN;
    const envMaxSpreadEth = process.env.MAX_SPREAD_ETH ? parseFloat(process.env.MAX_SPREAD_ETH) : NaN;
    const envMaxSpreadBtc = process.env.MAX_SPREAD_BTC ? parseFloat(process.env.MAX_SPREAD_BTC) : NaN;
    const envMaxSpreadAlt = process.env.MAX_SPREAD_ALT ? parseFloat(process.env.MAX_SPREAD_ALT) : NaN;
    const envMinNotionalUsdt = process.env.MIN_NOTIONAL_USDT ? parseFloat(process.env.MIN_NOTIONAL_USDT) : NaN;
    const envCooldownMs = process.env.COOLDOWN_MS ? parseInt(process.env.COOLDOWN_MS, 10) : NaN;
    const envVpinThreshold = process.env.VPIN_THRESHOLD ? parseFloat(process.env.VPIN_THRESHOLD) : NaN;
    const envVpinBucketVolume = process.env.VPIN_BUCKET_VOLUME ? parseFloat(process.env.VPIN_BUCKET_VOLUME) : NaN;

    const defaultLongTp = !isNaN(envLongTp) ? envLongTp : 1.0;
    const defaultLongSl = !isNaN(envLongSl) ? envLongSl : 0.50;
    const defaultShortTp = !isNaN(envShortTp) ? envShortTp : 1.0;
    const defaultShortSl = !isNaN(envShortSl) ? envShortSl : 0.50;
    const defaultProfitLock = !isNaN(envProfitLock) ? envProfitLock : 10.0;
    const defaultMaxShortSlots = !isNaN(envMaxShortSlots) ? envMaxShortSlots : 3;
    const defaultMinAiConfidence = !isNaN(envMinAiConfidence) ? envMinAiConfidence : 0.65;
    const defaultAggressiveConfidence = !isNaN(envAggressiveConfidence) ? envAggressiveConfidence : 0.75;
    const defaultObiBuy = !isNaN(envObiBuy) ? envObiBuy : 0.35;
    const defaultObiSell = !isNaN(envObiSell) ? envObiSell : -0.35;
    const defaultCvdBuy = !isNaN(envCvdBuy) ? envCvdBuy : 0.0;
    const defaultCvdSell = !isNaN(envCvdSell) ? envCvdSell : 0.0;
    const defaultMaxSpreadVelocity = !isNaN(envMaxSpreadVelocity) ? envMaxSpreadVelocity : 5.0;
    const defaultMaxSpreadEth = !isNaN(envMaxSpreadEth) ? envMaxSpreadEth : 0.50;
    const defaultMaxSpreadBtc = !isNaN(envMaxSpreadBtc) ? envMaxSpreadBtc : 50.0;
    const defaultMaxSpreadAlt = !isNaN(envMaxSpreadAlt) ? envMaxSpreadAlt : 1.0;
    const defaultMinNotionalUsdt = !isNaN(envMinNotionalUsdt) ? envMinNotionalUsdt : 55.0;
    const defaultCooldownMs = !isNaN(envCooldownMs) ? envCooldownMs : 250;
    const defaultVpinThreshold = !isNaN(envVpinThreshold) ? envVpinThreshold : 0.85;
    const defaultVpinBucketVolume = !isNaN(envVpinBucketVolume) ? envVpinBucketVolume : 50000.0;
    const targetSymbol = config?.symbol ?? process.env.SYMBOL ?? "BTCUSDT";
    const defaultOrderQty = !isNaN(envOrderQty)
      ? envOrderQty
      : (targetSymbol.includes("ETH") ? 0.05 : 0.001);
    const defaultLeverage = !isNaN(envLeverage) ? envLeverage : 10;

    const envTradeSizeUsdt = process.env.TRADE_SIZE_USDT ? parseFloat(process.env.TRADE_SIZE_USDT) : NaN;
    const defaultTradeSizeUsdt = !isNaN(envTradeSizeUsdt) ? envTradeSizeUsdt : 60.0;

    this.config = {
      symbol: targetSymbol,
      orderQuantity: config?.orderQuantity ?? defaultOrderQty,
      tradeSizeUsdt: config?.tradeSizeUsdt ?? defaultTradeSizeUsdt,
      obiBuyThreshold: config?.obiBuyThreshold ?? defaultObiBuy,
      obiSellThreshold: config?.obiSellThreshold ?? defaultObiSell,
      cvdBuyThreshold: config?.cvdBuyThreshold ?? defaultCvdBuy,
      cvdSellThreshold: config?.cvdSellThreshold ?? defaultCvdSell,
      maxSpreadVelocity: config?.maxSpreadVelocity ?? defaultMaxSpreadVelocity,
      minAiConfidence: config?.minAiConfidence ?? defaultMinAiConfidence,

      aggressiveConfidenceThreshold: config?.aggressiveConfidenceThreshold ?? defaultAggressiveConfidence,
      tickSize: config?.tickSize ?? 0.1,
      takeProfitPercent: config?.takeProfitPercent ?? defaultLongTp,
      stopLossPercent: config?.stopLossPercent ?? defaultLongSl,
      longTakeProfitPercent: config?.longTakeProfitPercent ?? defaultLongTp,
      longStopLossPercent: config?.longStopLossPercent ?? defaultLongSl,
      shortTakeProfitPercent: config?.shortTakeProfitPercent ?? defaultShortTp,
      shortStopLossPercent: config?.shortStopLossPercent ?? defaultShortSl,
      dailyProfitLockUsdt: config?.dailyProfitLockUsdt ?? defaultProfitLock,
      maxShortSlots: config?.maxShortSlots ?? defaultMaxShortSlots,
      leverageMultiplier: config?.leverageMultiplier ?? defaultLeverage,
      maxSpreadEth: config?.maxSpreadEth ?? defaultMaxSpreadEth,
      maxSpreadBtc: config?.maxSpreadBtc ?? defaultMaxSpreadBtc,
      maxSpreadAlt: config?.maxSpreadAlt ?? defaultMaxSpreadAlt,
      minNotionalUsdt: config?.minNotionalUsdt ?? defaultMinNotionalUsdt,
      cooldownMs: config?.cooldownMs ?? defaultCooldownMs,
      vpinThreshold: config?.vpinThreshold ?? defaultVpinThreshold,
      vpinBucketVolume: config?.vpinBucketVolume ?? defaultVpinBucketVolume,
    };

    this.dynamicRiskEngine = new DynamicRiskEngine(this.config.vpinThreshold);

    if (typeof config?.assetIndex === "number" && config.assetIndex >= 0) {
      this.assetIndex = config.assetIndex;
    } else {
      const activeSymbols = getTradingSymbols();
      const symIdx = activeSymbols.indexOf(this.config.symbol);
      this.assetIndex = symIdx >= 0 ? symIdx : 0;
    }

    this.hedgeLedger = hedgeLedger ?? new HedgePositionLedger(this.config.symbol, this.config.maxShortSlots);
    this.positionLedger = positionLedger ?? this.hedgeLedger.getLegacyLedger();
    this.hazardEngine = new MicrostructureHazardEngine(this.config.symbol);
    this.hjbEngine = new HJBReservationEngine(this.config.symbol);
    this.volEngine = new VolatilitySurfaceEngine(this.config.symbol);
    this.reusableOrderIntent = {
      symbol: this.config.symbol,
      side: "BUY",
      quantity: this.config.orderQuantity,
      price: 0,
    };
  }

  /**
   * Pure Zero-GC Mutator Method for reusableOrderIntent.
   * Enforces strict constructor-bound symbol invariance and resets all transient fields
   * across evaluation ticks to prevent cross-asset or cross-tick intent state pollution.
   */
  private prepareOrderIntent(
    side: "BUY" | "SELL",
    quantity: number,
    price: number,
    currentPositionSide: "LONG" | "SHORT" | "FLAT" | undefined,
    isCloseOrder: boolean,
    isHardStop?: boolean,
    riskProfile?: DynamicRiskProfile,
    stopLossPrice?: number,
    takeProfitPrice?: number
  ): OrderIntent {
    this.reusableOrderIntent.symbol = this.config.symbol;
    this.reusableOrderIntent.side = side;
    this.reusableOrderIntent.quantity = quantity;
    this.reusableOrderIntent.price = price;
    this.reusableOrderIntent.currentPositionSide = currentPositionSide;
    this.reusableOrderIntent.isCloseOrder = isCloseOrder;
    this.reusableOrderIntent.isHardStop = isHardStop ?? false;
    this.reusableOrderIntent.riskProfile = riskProfile;
    this.reusableOrderIntent.stopLossPrice = stopLossPrice;
    this.reusableOrderIntent.takeProfitPrice = takeProfitPrice;
    return this.reusableOrderIntent;
  }

  /**
   * Centralized fill lifecycle observer for both ENTRY and EXIT executions.
   * Enforces dual-tier cooldown synchronization across RiskGuard (software state)
   * and SharedArrayBuffer (zero-copy shared memory state).
   */
  public syncSabPositionState(currentMarkPrice: number = 0): void {
    const summary = this.hedgeLedger.getSummary(currentMarkPrice);
    const netSignedQty = summary.side === "SHORT" ? -summary.netQuantity : summary.netQuantity;
    this.client.setOmsPositionQty(netSignedQty, this.assetIndex);
    this.client.setOmsAvgEntryPrice(summary.averageEntryPrice, this.assetIndex);
    this.client.setOmsRealizedPnl(summary.cumulativeRealizedPnl, this.assetIndex);
    this.client.setOmsUnrealizedPnl(summary.unrealizedPnl, this.assetIndex);
    this.client.setOmsLeverage(this.config.leverageMultiplier, this.assetIndex);
    this.client.setOmsTotalTrades(summary.totalTrades, this.assetIndex);
    this.client.setOmsWinningTrades(summary.winningTrades, this.assetIndex);
    this.client.setOmsLosingTrades(summary.losingTrades, this.assetIndex);
  }

  public hasPendingEntryForSlot(slotId: string): boolean {
    for (const pending of this.pendingEntryOrders.values()) {
      if (pending.slotId === slotId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Centralized fill lifecycle observer for both ENTRY and EXIT executions.
   * Enforces dual-tier cooldown synchronization across RiskGuard (software state)
   * and SharedArrayBuffer (zero-copy shared memory state).
   */
  private onExecutionCompleted(params: {
    symbol: string;
    assetIndex: number;
    side: "BUY" | "SELL";
    positionSide: "LONG" | "SHORT";
    isCloseOrder: boolean;
    executedQty: number;
    executedPrice: number;
    realizedPnl?: number;
    fillTimestampMs?: number;
  }): void {
    const fillTime = params.fillTimestampMs ?? Date.now();
    const notionalUsdt = params.executedQty * params.executedPrice;
    const cooldownExpiry = fillTime + this.config.cooldownMs;

    // 1. Tier 1: RiskGuard Software State & Realized PnL Synchronization
    if (this.riskGuard instanceof MultiAssetRiskGuard) {
      (this.riskGuard as MultiAssetRiskGuard).recordExecutionSuccess(
        notionalUsdt,
        params.side,
        params.symbol,
        params.isCloseOrder
      );
    } else {
      this.riskGuard.recordExecutionSuccess(
        notionalUsdt,
        params.side,
        params.symbol,
        params.isCloseOrder
      );
    }

    if (params.realizedPnl && params.realizedPnl !== 0) {
      this.riskGuard.recordRealizedPnl(params.realizedPnl);
    }

    // 2. Tier 2: Atomic SharedArrayBuffer Cooldown Synchronization
    // Enforce post-trade execution cooldown per asset and side on SAB for both entries and exits
    if (params.positionSide === "LONG") {
      this.client.setLongCooldownLock(cooldownExpiry, params.assetIndex);
      this.client.setLastLongFillPrice(params.executedPrice, params.assetIndex);
    } else if (params.positionSide === "SHORT") {
      this.client.setShortCooldownLock(cooldownExpiry, params.assetIndex);
      this.client.setLastShortFillPrice(params.executedPrice, params.assetIndex);
    }

    // 3. Tier 3: Immediate Zero-Latency SAB Position State Sync
    this.syncSabPositionState(0);

    console.log(
      `[COOLDOWN_SYNC][${params.isCloseOrder ? "EXIT" : "ENTRY"}] Completed ${params.positionSide} ${params.side} on ${params.symbol}. Qty: ${params.executedQty} @ $${params.executedPrice.toFixed(
        2
      )}. Cooldown active for ${this.config.cooldownMs}ms (until ${cooldownExpiry}). PnL: $${(params.realizedPnl ?? 0).toFixed(2)}`
    );
  }

  public async initUserDataStream(): Promise<boolean> {
    if (!this.executionClient.isConfigured()) return false;
    this.userDataStream = new BinanceUserDataStream(this.executionClient);

    this.userDataStream.subscribeOrderUpdates((update: OrderTradeUpdatePayload) => {
      const { order } = update;
      if (order.symbol !== this.config.symbol) return; // Strict asset symbol filter for zero cross-asset state pollution
      const orderId = order.orderId;

      if (order.orderStatus === "FILLED" || order.orderStatus === "PARTIALLY_FILLED") {
        // 1. Check if this is a pending ENTRY order confirmation from Binance
        if (this.pendingEntryOrders.has(orderId)) {
          const pending = this.pendingEntryOrders.get(orderId)!;
          this.pendingEntryOrders.delete(orderId);

          const execPx = order.lastFilledPrice > 0 ? order.lastFilledPrice : pending.targetPrice;
          const execQty = order.cumulativeFilledQuantity > 0 ? order.cumulativeFilledQuantity : pending.qty;

          console.log(`[BinanceExecution][WS_ENTRY_FILL_CONFIRMED] OrderId #${orderId} FILLED on Binance! Occupying local slot ${pending.slotId}. Qty: ${execQty} @ $${execPx}`);

          const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
          const volEstimate = garmanKlassRV > 0.000001 ? Math.sqrt(garmanKlassRV) : 0.005;
          const dynamicSlPct = Math.max(0.005, volEstimate * 2.0);
          const dynamicSlPercent = dynamicSlPct * 100;

          if (pending.posSide === "LONG") {
            this.hedgeLedger.occupyCoreLong(execQty, execPx, this.config.longTakeProfitPercent, dynamicSlPercent);
            this.dispatchBatchPostOnlyTpOrders("CORE_LONG", execPx, execQty, "LONG").catch((err) => {
              console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
            });
          } else if (pending.posSide === "SHORT" && pending.slotIndex !== undefined) {
            this.hedgeLedger.occupyShortSlot(pending.slotIndex, execQty, execPx, this.config.shortTakeProfitPercent, dynamicSlPercent);
            this.dispatchBatchPostOnlyTpOrders(pending.slotId, execPx, execQty, "SHORT").catch((err) => {
              console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
            });
          }

          this.onExecutionCompleted({
            symbol: this.config.symbol,
            assetIndex: this.assetIndex,
            side: order.side as "BUY" | "SELL",
            positionSide: pending.posSide,
            isCloseOrder: false,
            executedQty: execQty,
            executedPrice: execPx,
            fillTimestampMs: Date.now(),
          });
          this.syncSabPositionState();
          return;
        }

        // 2. Check if this is a TP limit order fill or exit order fill
        if (order.orderType === "LIMIT" || order.isMaker) {
          const coreLong = this.hedgeLedger.getCoreLong();
          const shortSlots = this.hedgeLedger.getShortSlots();

          let targetSlotId: string | null = null;
          let posSide: "LONG" | "SHORT" = "LONG";
          let entryPx = 0;

          if (coreLong.isOccupied && coreLong.activeTpOrderIds?.includes(order.orderId)) {
            targetSlotId = "CORE_LONG";
            posSide = "LONG";
            entryPx = coreLong.entryPrice;
          } else {
            for (const s of shortSlots) {
              if (s.isOccupied && s.activeTpOrderIds?.includes(order.orderId)) {
                targetSlotId = s.slotId;
                posSide = "SHORT";
                entryPx = s.entryPrice;
                break;
              }
            }
          }

          if (targetSlotId) {
            console.log(`[MAKER_TP_ENGINE][WS_FILL_NOTIFIED] OrderId #${order.orderId} filled as ${order.isMaker ? "MAKER" : "TAKER"}. Qty: ${order.lastFilledQuantity} @ $${order.lastFilledPrice}`);
            const res = this.hedgeLedger.processTpLimitFill(targetSlotId, order.orderId, order.lastFilledQuantity, order.lastFilledPrice, order.isMaker);
            console.log(`[MAKER_TP_ENGINE][RECONCILED] Slot ${targetSlotId} updated. Closed: ${res.isPositionClosed}, RemQty: ${res.remainingQuantity}, NewSL: $${res.newStopLossPrice}`);

            let realizedPnl = 0;
            if (entryPx > 0) {
              const makerFee = this.hedgeLedger.getSizingCalculator().getMakerFeeRate();
              const takerFee = this.hedgeLedger.getSizingCalculator().getTakerFeeRate();
              const feeRate = order.isMaker ? makerFee : takerFee;
              const grossPnl = posSide === "LONG"
                ? (order.lastFilledPrice - entryPx) * order.lastFilledQuantity
                : (entryPx - order.lastFilledPrice) * order.lastFilledQuantity;
              const totalFees = (entryPx * order.lastFilledQuantity * takerFee) + (order.lastFilledPrice * order.lastFilledQuantity * feeRate);
              realizedPnl = grossPnl - totalFees;
            }

            const fillSide = order.side as "BUY" | "SELL";
            this.onExecutionCompleted({
              symbol: this.config.symbol,
              assetIndex: this.assetIndex,
              side: fillSide,
              positionSide: posSide,
              isCloseOrder: true,
              executedQty: order.lastFilledQuantity,
              executedPrice: order.lastFilledPrice,
              realizedPnl,
              fillTimestampMs: Date.now(),
            });
            this.syncSabPositionState();
            return;
          }
        }

        // 3. Fallback: Untracked ENTRY fill handling (e.g. immediate fills or REST placement fills)
        const isEntrySide = (order.side === "BUY" && (order.positionSide === "LONG" || order.positionSide === "BOTH")) ||
                            (order.side === "SELL" && (order.positionSide === "SHORT" || order.positionSide === "BOTH"));
        if (isEntrySide) {
          const execPx = order.lastFilledPrice > 0 ? order.lastFilledPrice : order.originalPrice;
          const execQty = order.lastFilledQuantity > 0 ? order.lastFilledQuantity : order.cumulativeFilledQuantity;
          if (execPx > 0 && execQty > 0) {
            const posSide: "LONG" | "SHORT" = (order.side === "BUY") ? "LONG" : "SHORT";
            console.log(`[BinanceExecution][UNTRACKED_ENTRY_FILL] OrderId #${orderId} filled for ${this.config.symbol} ${posSide}! Occupying/accumulating slot. Qty: ${execQty} @ $${execPx}`);

            const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
            const volEstimate = garmanKlassRV > 0.000001 ? Math.sqrt(garmanKlassRV) : 0.005;
            const dynamicSlPct = Math.max(0.005, volEstimate * 2.0);
            const dynamicSlPercent = dynamicSlPct * 100;

            if (posSide === "LONG") {
              this.hedgeLedger.occupyCoreLong(execQty, execPx, this.config.longTakeProfitPercent, dynamicSlPercent);
              this.dispatchBatchPostOnlyTpOrders("CORE_LONG", execPx, execQty, "LONG").catch(() => {});
            } else {
              const slotIdx = this.hedgeLedger.getAvailableShortSlotIndex();
              const targetIdx = slotIdx >= 0 ? slotIdx : 0;
              this.hedgeLedger.occupyShortSlot(targetIdx, execQty, execPx, this.config.shortTakeProfitPercent, dynamicSlPercent);
              this.dispatchBatchPostOnlyTpOrders(`SHORT_SLOT_${targetIdx}`, execPx, execQty, "SHORT").catch(() => {});
            }

            this.onExecutionCompleted({
              symbol: this.config.symbol,
              assetIndex: this.assetIndex,
              side: order.side as "BUY" | "SELL",
              positionSide: posSide,
              isCloseOrder: false,
              executedQty: execQty,
              executedPrice: execPx,
              fillTimestampMs: Date.now(),
            });
            this.syncSabPositionState();
          }
        }
      } else if (order.orderStatus === "CANCELED" || order.orderStatus === "EXPIRED" || (order.orderStatus as string) === "REJECTED") {
        if (this.pendingEntryOrders.has(orderId)) {
          console.warn(`[BinanceExecution][WS_ENTRY_CANCELLED] Pending entry OrderId #${orderId} was ${order.orderStatus} on Binance. Local slot remains FLAT.`);
          this.pendingEntryOrders.delete(orderId);
        }
      }
    });

    return this.userDataStream.start();
  }

  private async dispatchBatchPostOnlyTpOrders(
    slotId: string,
    entryPrice: number,
    quantity: number,
    side: "LONG" | "SHORT"
  ): Promise<void> {
    let intents: BinanceOrderParams[] = [];
    try {
      intents = this.hedgeLedger.generateBatchTpOrderIntents(slotId, entryPrice, quantity, side);
      if (intents.length === 0) return;

      console.log(`[MAKER_TP_ENGINE][DISPATCHING] Submitting ${intents.length} POST_ONLY limit TP orders for ${slotId} via batchOrders...`);
      const resList = await this.executionClient.placeBatchOrders(intents);
      if (Array.isArray(resList) && resList.length > 0) {
        const validOrderIds: any[] = [];
        const rejectedIntents: { intent: BinanceOrderParams; code?: number }[] = [];

        resList.forEach((res: any, idx: number) => {
          if (res && res.orderId) {
            validOrderIds.push(res.orderId);
          } else if (res && (res.code === -5022 || (res.msg && String(res.msg).includes("-5022")))) {
            if (intents[idx]) rejectedIntents.push({ intent: intents[idx], code: res.code });
          }
        });

        if (validOrderIds.length > 0) {
          this.hedgeLedger.registerActiveTpOrderIds(slotId, validOrderIds as any[]);
          console.log(`[MAKER_TP_ENGINE][SUCCESS] Registered ${validOrderIds.length} POST_ONLY TP limit order IDs on Binance orderbook: [${validOrderIds.join(", ")}]`);
        }

        // Retry any individual -5022 rejections within the batch response with 1-tick price shift
        for (const rej of rejectedIntents) {
          try {
            const tickSize = SymbolPrecisionRegistry.getTickSize(rej.intent.symbol);
            const currentPx = rej.intent.price || entryPrice;
            const adjustedPx = rej.intent.side === "BUY" ? currentPx - tickSize : currentPx + tickSize;
            const newPrice = SymbolPrecisionRegistry.formatPrice(rej.intent.symbol, adjustedPx);

            console.warn(`[MAKER_TP_ENGINE][-5022 ITEM RETRY] Retrying rejected TP order 1 tick away @ ${newPrice}...`);
            const retryRes = await this.executionClient.placeOrder({
              ...rej.intent,
              price: newPrice,
            });
            if (retryRes && retryRes.orderId) {
              this.hedgeLedger.registerActiveTpOrderIds(slotId, [retryRes.orderId as any]);
            }
          } catch (retryErr: any) {
            console.error(`[MAKER_TP_ENGINE][-5022 ITEM RETRY FAILED] ${retryErr.message}`);
          }
        }
      }
    } catch (err: any) {
      if (err.message && (err.message.includes("-5022") || err.message.includes("5022"))) {
        console.warn(`[MAKER_TP_ENGINE][-5022 BATCH REJECTION] Entire TP batch rejected with -5022. Retrying target orders individually with 1-tick price shift...`);
        for (const intent of intents) {
          try {
            const tickSize = SymbolPrecisionRegistry.getTickSize(intent.symbol);
            const currentPx = intent.price || entryPrice;
            const adjustedPx = intent.side === "BUY" ? currentPx - tickSize : currentPx + tickSize;
            const newPrice = SymbolPrecisionRegistry.formatPrice(intent.symbol, adjustedPx);

            const retryRes = await this.executionClient.placeOrder({
              ...intent,
              price: newPrice,
            });
            if (retryRes && retryRes.orderId) {
              this.hedgeLedger.registerActiveTpOrderIds(slotId, [retryRes.orderId as any]);
            }
          } catch (retryErr: any) {
            console.error(`[MAKER_TP_ENGINE][-5022 INDIVIDUAL RETRY FAILED] ${retryErr.message}`);
          }
        }
      } else {
        console.error(`[MAKER_TP_ENGINE][ERROR] Failed to submit batch POST_ONLY TP orders: ${err.message}`);
      }
    }
  }

  public getEngineState(): EngineState {
    return this.state;
  }

  public setEngineState(newState: EngineState): void {
    const oldState = this.state;
    this.state = newState;
    if (oldState !== newState) {
      console.log(`[ENGINE_STATE] State Transition: ${oldState} -> ${newState}`);
    }
  }

  public getPositionLedger(): PositionLedger {
    return this.positionLedger;
  }

  public getHedgeLedger(): HedgePositionLedger {
    return this.hedgeLedger;
  }

  public getActiveTrades(currentPrice: number = 0): ActiveTradeSlot[] {
    return this.hedgeLedger.getActiveTradeSlots(
      currentPrice,
      this.config.leverageMultiplier,
      this.config.longTakeProfitPercent,
      this.config.longStopLossPercent,
      this.config.shortTakeProfitPercent,
      this.config.shortStopLossPercent
    );
  }

  /**
  /**
   * Phase 3 Emergency Remediation: State Hydration & Orphaned Position Guard.
   * Hydrates position state from caller-supplied Binance positionRisk & openOrders arrays.
   */
  public async syncExchangeStateWithData(
    positions: BinancePositionRisk[],
    openOrders: BinanceOrderResponse[]
  ): Promise<void> {
    try {
      const activePositions = (Array.isArray(positions) ? positions : []).filter(
        (pos) => pos.symbol === this.config.symbol && Math.abs(parseFloat(pos.positionAmt || "0")) > 0
      );

      const symbolOpenOrders = Array.isArray(openOrders)
        ? openOrders.filter((o) => o.symbol === this.config.symbol)
        : [];

      if (activePositions.length === 0) {
        console.log(`[StrategyEngine][StateSync] Binance position state: FLAT (0.0000) for ${this.config.symbol}.`);
        this.client.setOmsPositionQty(0, this.assetIndex);
        this.client.setOmsAvgEntryPrice(0, this.assetIndex);
        return;
      }

      // Reconcile active position(s) into internal ledgers (strictly overwrites and assigns exact Binance position size)
      this.reconcileStartupPositions(activePositions);

      // Map position metrics into SharedArrayBuffer slots
      this.syncSabPositionState(0);

      // ORPHANED POSITION GUARD: Inject dynamic SL/TP if position lacks exchange orders
      for (const pos of activePositions) {
        const qty = Math.abs(parseFloat(pos.positionAmt || "0"));
        const entryPx = parseFloat(pos.entryPrice || "0");
        if (qty <= 0 || entryPx <= 0) continue;

        const posSide: "LONG" | "SHORT" =
          pos.positionSide === "LONG" || (pos.positionSide === "BOTH" && parseFloat(pos.positionAmt || "0") > 0)
            ? "LONG"
            : "SHORT";

        const exitSide = posSide === "LONG" ? "SELL" : "BUY";
        const hasSlTpOrder = symbolOpenOrders.some((ord) => {
          const isMatchSide = ord.side === exitSide;
          const isSlTpType =
            ord.type === "STOP_MARKET" ||
            ord.type === "TAKE_PROFIT_MARKET" ||
            ord.type === "LIMIT" ||
            ord.reduceOnly === true;
          return isMatchSide && isSlTpType;
        });

        if (!hasSlTpOrder) {
          console.warn(
            `[ORPHAN_GUARD] Active ${posSide} position on ${this.config.symbol} (${qty} @ $${entryPx}) is UNPROTECTED on exchange!`
          );

          // Dynamic Volatility-Based SL/TP (Phase 2 Formulas)
          const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
          const volEstimate = garmanKlassRV > 0.000001 ? Math.sqrt(garmanKlassRV) : 0.005;
          const dynamicSlPct = Math.max(0.005, volEstimate * 2.0);
          const dynamicSlPercent = dynamicSlPct * 100;
          const dynamicTpPercent = posSide === "LONG" ? this.config.longTakeProfitPercent : this.config.shortTakeProfitPercent;

          const slotId = posSide === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0";

          // NOTE: reconcileStartupPositions() above already reset and occupied the position slot with the exact Binance quantity.
          // We MUST NOT call occupyCoreLong / occupyShortSlot here because calling occupy on an already occupied slot triggers quantity accumulation (doubling the position size).

          const slPrice = posSide === "LONG" ? entryPx * (1.0 - dynamicSlPct) : entryPx * (1.0 + dynamicSlPct);
          const formattedSlPrice = SymbolPrecisionRegistry.formatPrice(this.config.symbol, slPrice);

          // 1. Attach and dispatch protective POST_ONLY TP limit order batch to Binance
          await this.dispatchBatchPostOnlyTpOrders(slotId, entryPx, qty, posSide);

          // 2. Explicitly dispatch LIVE STOP_MARKET Stop-Loss order to Binance exchange
          try {
            const slOrder = await this.executionClient.placeOrder({
              symbol: this.config.symbol,
              side: exitSide,
              type: "STOP_MARKET",
              quantity: qty,
              stopPrice: formattedSlPrice,
              positionSide: posSide,
            });
            console.log(
              `[ORPHAN_GUARD][DISPATCHED] Live STOP_MARKET order #${slOrder.orderId} confirmed on Binance for ${this.config.symbol} ${posSide}: stopPrice=$${formattedSlPrice}`
            );
          } catch (slErr: any) {
            console.error(
              `[ORPHAN_GUARD][ERROR] Failed to dispatch live STOP_MARKET order to Binance for ${this.config.symbol} ${posSide}: ${slErr.message}`
            );
          }

          console.log(
            `[ORPHAN_GUARD][DISPATCHED] Dynamic Volatility SL/TP attached to ${this.config.symbol} ${posSide} position: SL=$${formattedSlPrice} (${dynamicSlPercent.toFixed(2)}%), TP=${dynamicTpPercent.toFixed(2)}%`
          );
        } else {
          console.log(`[ORPHAN_GUARD] Active ${posSide} position on ${this.config.symbol} has active exchange protective order(s).`);
        }
      }

      // Final synchronization of SharedArrayBuffer OMS slots
      this.syncSabPositionState(0);
    } catch (err: any) {
      console.error(`[StrategyEngine][StateSync][ERROR] Failed to sync exchange state for ${this.config.symbol}: ${err.message}`);
    }
  }

  public async syncExchangeState(): Promise<void> {
    if (!this.executionClient.isConfigured()) {
      console.log(`[StrategyEngine][StateSync] BinanceExecutionClient unconfigured for ${this.config.symbol}. Skipping state sync.`);
      return;
    }

    try {
      console.log(`[StrategyEngine][StateSync] Syncing exchange state & open orders for ${this.config.symbol}...`);
      const [positions, openOrders] = await Promise.all([
        this.executionClient.getPositionRisk(this.config.symbol),
        this.executionClient.getOpenOrders(this.config.symbol),
      ]);

      await this.syncExchangeStateWithData(positions, openOrders);
    } catch (err: any) {
      console.error(`[StrategyEngine][StateSync][ERROR] Failed to sync exchange state for ${this.config.symbol}: ${err.message}`);
    }
  }

  public reconcileStartupPositions(rawPositions: BinancePositionRisk[]): void {
    if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
      console.log(`[StrategyEngine][StateRecovery] No active positions returned from Binance REST API for ${this.config.symbol}.`);
      return;
    }

    const recovered: { side: "LONG" | "SHORT"; quantity: number; entryPrice: number }[] = [];

    for (const pos of rawPositions) {
      if (pos.symbol !== this.config.symbol) continue;

      const amt = parseFloat(pos.positionAmt || "0");
      const entryPx = parseFloat(pos.entryPrice || "0");
      if (Math.abs(amt) <= 0 || entryPx <= 0) continue;

      const side: "LONG" | "SHORT" =
        pos.positionSide === "LONG" || (pos.positionSide === "BOTH" && amt > 0) ? "LONG" : "SHORT";
      recovered.push({
        side,
        quantity: Math.abs(amt),
        entryPrice: entryPx,
      });
    }

    if (recovered.length > 0) {
      this.hedgeLedger.syncStartupPositions(
        recovered,
        this.config.longTakeProfitPercent,
        this.config.longStopLossPercent,
        this.config.shortTakeProfitPercent,
        this.config.shortStopLossPercent
      );
      console.log(
        `[StrategyEngine][StateRecovery] Successfully recovered ${recovered.length} open position(s) from Binance REST API for ${this.config.symbol}.`
      );
    } else {
      console.log(`[StrategyEngine][StateRecovery] Binance position state: FLAT (0.0000) for ${this.config.symbol}.`);
    }

    this.syncSabPositionState(0);
  }

  /**
   * High-frequency tick evaluation loop.
   * Reads scalar metrics directly from SharedArrayBuffer via MarketDataClient getters.
   * Zero GC heap allocation when no trade signals are generated.
   */
  public evaluateTick(): StrategySignalResult {
    let finalizedSignalVal = 0.0;
    try {
      const seq = this.client.getSequenceNum(this.assetIndex);

      if (seq === this.lastProcessedSequence || this.isOrderInFlight) {
        this.staticResult.sequenceNum = seq;
        this.staticResult.signalType = "NONE";
        this.staticResult.riskResult = undefined;
        this.staticResult.executionPromise = undefined;
        return this.staticResult;
      }
      this.lastProcessedSequence = seq;

      // Read scalar metrics atomically from SAB
      const obi = this.client.getOBI(this.assetIndex);
      const cvd = this.client.getCVD(this.assetIndex);
      const spreadVelocity = this.client.getSpreadVelocity(this.assetIndex);
      const bidPrice = this.client.getBestBidPrice(this.assetIndex);
      const askPrice = this.client.getBestAskPrice(this.assetIndex);

      // SPREAD & TICK GUARD: Immediately reject invalid tick data (bid <= 0, ask <= 0, bid > ask) or excessive spread BEFORE evaluating dynamic exits or signals
      const isTickValid = askPrice > 0 && bidPrice > 0 && askPrice >= bidPrice;
      const currentSpread = isTickValid ? askPrice - bidPrice : Infinity;
      let maxSpreadAllowed: number;
      if (this.config.symbol.includes("BTC")) {
        maxSpreadAllowed = Math.max(this.config.maxSpreadBtc, askPrice * 0.0015);
      } else if (this.config.symbol.includes("ETH")) {
        maxSpreadAllowed = Math.max(this.config.maxSpreadEth, askPrice * 0.0015);
      } else {
        maxSpreadAllowed = Math.max(this.config.maxSpreadAlt, askPrice * 0.0020);
      }

      if (!isTickValid || currentSpread > maxSpreadAllowed) {
        const reasonCode = !isTickValid ? "INVALID_TICK_DATA" : "REJECTED_LIQUIDITY_SWEEP_TRAP";
        const message = !isTickValid
          ? `Tick evaluation rejected: invalid tick prices (bid: ${bidPrice}, ask: ${askPrice})`
          : `Tick evaluation rejected: current spread (${currentSpread.toFixed(2)} USDT) > ${maxSpreadAllowed.toFixed(2)} USDT threshold`;

        if (seq % 500n === 0n || !isTickValid) {
          console.warn(`[StrategyEngine][SPREAD_GUARD_REJECT] Seq #${seq} | ${message}`);
        }
        this.staticResult.sequenceNum = seq;
        this.staticResult.signalType = "NONE";
        this.staticResult.obi = obi;
        this.staticResult.cvd = cvd;
        this.staticResult.spreadVelocity = spreadVelocity;
        this.staticResult.bidPrice = bidPrice;
        this.staticResult.askPrice = askPrice;
        this.staticResult.riskResult = {
          passed: false,
          reasonCode,
          message,
        };
        this.staticResult.executionPromise = undefined;
        return this.staticResult;
      }

      // Read AI predictions & latency metrics from SAB
      const aiDirection = this.client.getAIPredictionDirection(this.assetIndex);
      const aiConfidence = this.client.getAIPredictionConfidence(this.assetIndex);
      const aiDirectionMag = this.client.getAIDirectionMagnitude(this.assetIndex) || Math.abs(aiDirection);
      const latencyPenalty = this.client.getLatencyPenaltyCoefficient(this.assetIndex);
      const penaltyCoeff = latencyPenalty > 0 ? Math.max(0.75, latencyPenalty) : 1.0;
      const slippageTicks = this.client.getDynamicSlippageTicks(this.assetIndex);

      // 1. Dynamic Monitoring: Evaluate Microstructure, Volatility & Dynamic Exit Boundaries
      const markPrice = askPrice > 0 ? (askPrice + bidPrice) / 2 : bidPrice;

      // Feed live orderbook & price ticks into SOTA microstructure & volatility engines
      const bestBidQty = this.client.getBestBidQuantity(this.assetIndex);
      const bestAskQty = this.client.getBestAskQuantity(this.assetIndex);
      this.hazardEngine.updateOrderBook(bidPrice, bestBidQty, askPrice, bestAskQty);
      this.volEngine.updatePrice(markPrice);

      const summary = this.hedgeLedger.getSummary(markPrice > 0 ? markPrice : 0);
      const activePosSide = summary.side === "FLAT" ? "LONG" : summary.side;
      let holdingDurationMs = 0;
      if (summary.side === "LONG") {
        const coreLong = this.hedgeLedger.getCoreLong();
        holdingDurationMs = coreLong.isOccupied && coreLong.openTime > 0 ? Math.max(0, Date.now() - coreLong.openTime) : 0;
      } else if (summary.side === "SHORT") {
        const shortSlots = this.hedgeLedger.getShortSlots();
        let oldestOpenTime = 0;
        for (const slot of shortSlots) {
          if (slot.isOccupied && slot.openTime > 0) {
            if (oldestOpenTime === 0 || slot.openTime < oldestOpenTime) {
              oldestOpenTime = slot.openTime;
            }
          }
        }
        holdingDurationMs = oldestOpenTime > 0 ? Math.max(0, Date.now() - oldestOpenTime) : 0;
      }
      const hazardMetrics = this.hazardEngine.getHazardMetrics(activePosSide, aiConfidence, holdingDurationMs);
      const volMetrics = this.volEngine.getVolatilitySurfaceMetrics();

      const signedInventory = summary.side === "SHORT" ? -summary.netQuantity : summary.netQuantity;
      const hjbResPrice = this.hjbEngine.calculateReservationPrice(
        markPrice,
        signedInventory,
        holdingDurationMs,
        volMetrics.garmanKlass1s
      );

      // Atomically sync SAB Telemetry Slots 138-141 for Live TUI Monitor & OMS
      this.client.setOFI(hazardMetrics.ofi, this.assetIndex);
      this.client.setHJBReservationPrice(hjbResPrice, this.assetIndex);
      this.client.setSurvivalProbability(hazardMetrics.survivalProbability, this.assetIndex);
      const hasActivePos = summary.netQuantity > 0 || summary.side !== "FLAT";
      const dynamicSlPx = hasActivePos
        ? (summary.side === "LONG"
            ? summary.averageEntryPrice * (1.0 - this.config.longStopLossPercent / 100)
            : summary.averageEntryPrice * (1.0 + this.config.shortStopLossPercent / 100))
        : 0;
      this.client.setDynamicStopLossPrice(dynamicSlPx, this.assetIndex);

      // Sync active position state to SharedArrayBuffer for TUI Table telemetry
      if (markPrice > 0) {
        const netSignedQty = summary.side === "SHORT" ? -summary.netQuantity : summary.netQuantity;
        this.client.setOmsPositionQty(netSignedQty, this.assetIndex);
        this.client.setOmsAvgEntryPrice(summary.averageEntryPrice, this.assetIndex);
        this.client.setOmsRealizedPnl(summary.cumulativeRealizedPnl, this.assetIndex);
        this.client.setOmsUnrealizedPnl(summary.unrealizedPnl, this.assetIndex);
        this.client.setOmsLeverage(this.config.leverageMultiplier, this.assetIndex);
        this.client.setOmsTotalTrades(summary.totalTrades, this.assetIndex);
        this.client.setOmsWinningTrades(summary.winningTrades, this.assetIndex);
        this.client.setOmsLosingTrades(summary.losingTrades, this.assetIndex);
      }

      if (markPrice > 0) {
        // Priority 1: Evaluate SOTA Dynamic Exits (Cox Hazard Survival Flush, HJB Liquidation Boundary, MVA-TS)
        const sotaTriggers = hasActivePos
          ? this.hedgeLedger.evaluateSotaDynamicExits(markPrice, hazardMetrics, this.hjbEngine, volMetrics)
          : [];
        // Priority 2: Evaluate Hedge Slot Dynamic TP/SL (Fixed/Trailing TP/SL, Profit Lock)
        const hedgeTriggers = this.hedgeLedger.evaluateHedgeDynamicTpSl(markPrice);

        const activeTriggers = sotaTriggers.length > 0 ? sotaTriggers : hedgeTriggers;

        if (activeTriggers.length > 0) {
          const trigger = activeTriggers[0];
          const exitSide: "BUY" | "SELL" = trigger.side === "LONG" ? "SELL" : "BUY";
          const isHardStopTrigger =
            trigger.reason.includes("HAZARD") ||
            trigger.reason.includes("HJB") ||
            trigger.reason.includes("MVA_TS") ||
            trigger.reason === "STOP_LOSS" ||
            trigger.reason === "BREAK_EVEN_STOP_LOSS" ||
            trigger.reason === "LONG_HOLD_PROFIT_HARVEST" ||
            trigger.reason === "TIME_DECAY_PROFIT_LOCK";

          console.log(
            `[HEDGE_DYNAMIC_MONITORING] Slot ${trigger.slotId} ${trigger.reason} TRIGGERED! Side: ${trigger.side}, Entry: $${trigger.entryPrice.toFixed(
              2
            )}, Mark: $${markPrice.toFixed(2)}. Dispatching MARKET close with positionSide: ${trigger.side}.${isHardStopTrigger ? " [RUTHLESS HARD STOP OVERRIDE ACTIVE]" : ""}`
          );

          this.prepareOrderIntent(
            exitSide,
            trigger.quantity,
            markPrice,
            trigger.side,
            true,
            isHardStopTrigger
          );

          const isConfigured = this.executionClient.isConfigured();
          const riskResult = (this.riskGuard instanceof MultiAssetRiskGuard)
            ? (this.riskGuard as MultiAssetRiskGuard).validateMultiAssetOrder(this.reusableOrderIntent, isConfigured)
            : this.riskGuard.validateOrder(
                this.reusableOrderIntent,
                isConfigured,
                trigger.side
              );

          let executionPromise: Promise<BinanceOrderResponse | null> | undefined = undefined;
          if (riskResult.passed) {
            this.isOrderInFlight = true;
            executionPromise = (async () => {
              if (trigger.cancelOrderIds && trigger.cancelOrderIds.length > 0) {
                console.log(
                  `[MAKER_TP_ENGINE][EMERGENCY_CANCEL] Cancelling ${trigger.cancelOrderIds.length} open POST_ONLY limit TP orders for ${trigger.slotId} before MARKET SL dispatch...`
                );
                try {
                  await this.executionClient.cancelBatchOrders(this.config.symbol, trigger.cancelOrderIds);
                  console.log(`[MAKER_TP_ENGINE][EMERGENCY_CANCEL] Batch order cancellation confirmed by exchange.`);
                } catch (err: any) {
                  console.warn(`[MAKER_TP_ENGINE][CANCEL_WARN] Batch order cancellation warning: ${err.message}`);
                }
              }

              return this.executionClient
                .placeOrder({
                  symbol: this.config.symbol,
                  side: exitSide,
                  type: "MARKET",
                  quantity: trigger.quantity,
                  positionSide: trigger.side,
                })
                .then((res) => {
                  if (res) {
                    const execPx = parseFloat(res.price || res.avgPrice || "0") || markPrice;
                    const takerFeeRate = this.hedgeLedger.getSizingCalculator().getTakerFeeRate();
                    let realizedPnl = 0;

                    if (trigger.isPartialClose && trigger.quantity > 0) {
                      if (trigger.side === "LONG") {
                        const entryPx = this.hedgeLedger.getCoreLong().entryPrice;
                        const closedQty = Math.min(this.hedgeLedger.getCoreLong().quantity, trigger.quantity);
                        if (entryPx > 0) {
                          const grossPnl = (execPx - entryPx) * closedQty;
                          const fees = (entryPx * closedQty + execPx * closedQty) * takerFeeRate;
                          realizedPnl = grossPnl - fees;
                        }
                        this.hedgeLedger.deductCoreLongQuantity(trigger.quantity, execPx, takerFeeRate, trigger.reason);
                      } else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                        const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                        const slot = this.hedgeLedger.getShortSlots().find((s) => s.slotId === trigger.slotId);
                        if (slot && slot.entryPrice > 0) {
                          const entryPx = slot.entryPrice;
                          const closedQty = Math.min(slot.quantity, trigger.quantity);
                          const grossPnl = (entryPx - execPx) * closedQty;
                          const fees = (entryPx * closedQty + execPx * closedQty) * takerFeeRate;
                          realizedPnl = grossPnl - fees;
                        }
                        this.hedgeLedger.deductShortSlotQuantity(sIdx, trigger.quantity, execPx, takerFeeRate, trigger.reason);
                      }
                    } else if (!trigger.isPartialClose) {
                      if (trigger.side === "LONG") {
                        const coreLong = this.hedgeLedger.getCoreLong();
                        if (coreLong.isOccupied && coreLong.entryPrice > 0) {
                          const entryPx = coreLong.entryPrice;
                          const qty = coreLong.quantity;
                          const grossPnl = (execPx - entryPx) * qty;
                          const fees = (entryPx * qty + execPx * qty) * takerFeeRate;
                          realizedPnl = grossPnl - fees;
                        }
                        this.hedgeLedger.releaseCoreLong(execPx, takerFeeRate, trigger.reason);
                      } else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                        const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                        const slot = this.hedgeLedger.getShortSlots().find((s) => s.slotId === trigger.slotId);
                        if (slot && slot.isOccupied && slot.entryPrice > 0) {
                          const entryPx = slot.entryPrice;
                          const qty = slot.quantity;
                          const grossPnl = (entryPx - execPx) * qty;
                          const fees = (entryPx * qty + execPx * qty) * takerFeeRate;
                          realizedPnl = grossPnl - fees;
                        }
                        this.hedgeLedger.releaseShortSlot(sIdx, execPx, takerFeeRate, trigger.reason);
                      }
                    }

                    // Dual-tier cooldown & risk sync for dynamic MARKET exit executions
                    this.onExecutionCompleted({
                      symbol: this.config.symbol,
                      assetIndex: this.assetIndex,
                      side: exitSide,
                      positionSide: trigger.side,
                      isCloseOrder: true,
                      executedQty: trigger.quantity,
                      executedPrice: execPx,
                      realizedPnl,
                      fillTimestampMs: Date.now(),
                    });
                  }
                  return res;
                })
                .catch((err) => {
                  console.error(`[DYNAMIC_MONITORING_ERROR] Hedge ${trigger.reason} MARKET order failed: ${err.message}`);
                  if (
                    err.message &&
                    (err.message.includes("-2022") ||
                      err.message.includes("ReduceOnly") ||
                      err.message.includes("-2011") ||
                      err.message.includes("not configured"))
                  ) {
                    console.warn(
                      `[DYNAMIC_MONITORING_WARN] Clearing local slot ${trigger.slotId} due to exchange release/error: ${err.message}`
                    );
                    if (trigger.side === "LONG") {
                      this.hedgeLedger.releaseCoreLong();
                    } else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                      const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                      this.hedgeLedger.releaseShortSlot(sIdx);
                    }
                  }
                  return null;
                });
            })().finally(() => {
              this.isOrderInFlight = false;
            });
          }

          finalizedSignalVal = riskResult.passed ? (exitSide === "BUY" ? 1.0 : exitSide === "SELL" ? 2.0 : 0.0) : 0.0;

          return {
            sequenceNum: seq,
            signalType: exitSide,
            positionSide: trigger.side,
            slotId: trigger.slotId,
            obi,
            cvd,
            spreadVelocity,
            bidPrice,
            askPrice,
            riskResult,
            executionPromise,
            exitReason: trigger.reason,
          };
        }
      }

      // Safety Clamp: Suppress new signal generation when engine is in TRAINING_LOCK, RECALIBRATING, PAUSED or EMERGENCY_HALT state
      if (this.state === "TRAINING_LOCK" || this.state === "RECALIBRATING" || this.state === "PAUSED" || this.state === "EMERGENCY_HALT") {
        if (seq % 500n === 0n) {
          console.log(`[StrategyEngine][StateLock] Seq #${seq} | Engine locked in [${this.state}] state. Signal evaluation suppressed.`);
        }

        const reasonCode = this.state === "TRAINING_LOCK" ? "TRAINING_LOCK_ACTIVE" : this.state === "RECALIBRATING" ? "RECALIBRATING_ACTIVE" : "ENGINE_PAUSED";

        this.staticResult.sequenceNum = seq;
        this.staticResult.signalType = "NONE";
        this.staticResult.obi = obi;
        this.staticResult.cvd = cvd;
        this.staticResult.spreadVelocity = spreadVelocity;
        this.staticResult.bidPrice = bidPrice;
        this.staticResult.askPrice = askPrice;
        this.staticResult.riskResult = {
          passed: false,
          reasonCode,
          message: `Engine signal evaluation paused due to state: ${this.state}`,
        };
        this.staticResult.executionPromise = undefined;
        return this.staticResult;
      }

      let signalType: "NONE" | "BUY" | "SELL" = "NONE";
      let targetPosSide: "LONG" | "SHORT" | undefined = undefined;
      let targetSlotId: string | undefined = undefined;
      let targetSlotIndex: number | undefined = undefined;

      // Auto-reconcile hedge ledger slots if local position ledger is flat
      if (this.positionLedger.getSide() === "FLAT" || this.positionLedger.getNetQuantity() === 0) {
        if (this.hedgeLedger.getCoreLong().isOccupied && (!this.hedgeLedger.getCoreLong().quantity || this.hedgeLedger.getCoreLong().quantity <= 0)) {
          this.hedgeLedger.releaseCoreLong();
        }
      }

      // Read Hawkes & Microburst Metrics from SAB
      const hawkesIntensity = this.client.getHawkesIntensity(this.assetIndex);
      const realizedVol = this.client.getRealizedVolatility(this.assetIndex);
      const rawShortCooldownLock = this.client.getShortCooldownLock(this.assetIndex);
      const rawLongCooldownLock = this.client.getLongCooldownLock(this.assetIndex);
      const hurstExponent = this.client.getHurstExponent(this.assetIndex);
      const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);

      const nowMs = Date.now();
      // Defensive ceiling guard: if cooldown lock is set to a future timestamp > 60s, reset lock to 0
      const longCooldownLock = rawLongCooldownLock > nowMs + 60000 ? 0 : rawLongCooldownLock;
      const shortCooldownLock = rawShortCooldownLock > nowMs + 60000 ? 0 : rawShortCooldownLock;

      let targetSizeDecayCoeff = 1.0;

      // 50-25-25 Weighted Composite Signal Engine & High-Confidence AI Override
      const obiScore = Math.max(-1.0, Math.min(1.0, obi));
      const cvdScore = cvd > 0 ? 1.0 : cvd < 0 ? -1.0 : 0.0;
      const aiScore = Math.max(-1.0, Math.min(1.0, aiDirection * aiConfidence));

      // Regime-aware AI confidence threshold adaptation:
      // In strong trend regime (Hurst > 0.55), lower required minAiConfidence to 0.52 for fast momentum capture.
      let effectiveMinConfidence = this.config.minAiConfidence;
      if (hurstExponent > 0.55 && garmanKlassRV > 0.001) {
        effectiveMinConfidence = Math.max(0.50, this.config.minAiConfidence - 0.15);
      }

      // Weights: AI Model = 50% (0.50), OBI = 25% (0.25), CVD = 25% (0.25)
      const compositeScore = 0.50 * aiScore + 0.25 * obiScore + 0.25 * cvdScore;

      const isHighConfidenceAi = aiConfidence >= this.config.aggressiveConfidenceThreshold;

      let isBuySignal = false;
      let isSellSignal = false;

      // SOTA Dynamic Volatility-Normalized Conviction Floor Gate (K_conviction)
      // Eradicates micro-return fee traps. Explicitly includes round-trip exchange fees (10 bps) + half spread.
      const ROUND_TRIP_FEE_BPS = 0.001; // 10 bps mandatory exchange fee floor
      const midPrice = askPrice > 0 && bidPrice > 0 ? (bidPrice + askPrice) / 2.0 : 1.0;
      const halfSpreadBps = midPrice > 0 ? ((askPrice - bidPrice) / (2.0 * midPrice)) : 0.0001;
      const volEstimate = garmanKlassRV > 0.000001 ? Math.sqrt(garmanKlassRV) : 0.005;
      const hawkesMultiplier = 1.0 + 0.2 * Math.log(1.0 + Math.max(0, hawkesIntensity));
      
      // Dynamic Conviction Floor: K_conviction(t) MUST exceed half spread + round trip fees
      const dynamicConvictionFloor = Math.max(halfSpreadBps + ROUND_TRIP_FEE_BPS, 0.5 * volEstimate * hawkesMultiplier);
      
      // Volatility-Standardized Z-Score of the signal
      const zScore = aiDirectionMag / Math.max(volEstimate, 0.0001);

      // Dynamic Conviction Authorization: Require BOTH dynamicConvictionFloor AND Z-Score >= 1.5
      const minZScoreThreshold = 1.5;
      const isConvictionValid = aiDirectionMag >= dynamicConvictionFloor && zScore >= minZScoreThreshold;

      if (isConvictionValid) {
        if (isHighConfidenceAi) {
          // AI-Override Rule: High-confidence AI must also satisfy strict OBI directional pressure threshold (+/- 0.35)
          isBuySignal = aiDirection > 0 && obi >= this.config.obiBuyThreshold;
          isSellSignal = aiDirection < 0 && obi <= this.config.obiSellThreshold;
          if (isBuySignal || isSellSignal) {
            console.log(`[StrategyEngine][HIGH_CONFIDENCE] Seq #${seq} | Dir: ${aiDirection.toFixed(4)} (Mag: ${aiDirectionMag.toFixed(4)}), Conf: ${(aiConfidence * 100).toFixed(1)}%, OBI: ${obi.toFixed(4)}, BuySignal: ${isBuySignal}, SellSignal: ${isSellSignal}`);
          }
        } else {
          // Weighted Composite Rule with dynamic effective confidence thresholding
          isBuySignal = compositeScore > 0.12 && aiConfidence >= effectiveMinConfidence && obi >= this.config.obiBuyThreshold;
          isSellSignal = compositeScore < -0.12 && aiConfidence >= effectiveMinConfidence && obi <= this.config.obiSellThreshold;
        }
      } else if (seq % 1000n === 0n) {
        console.log(`[StrategyEngine][CONVICTION_FLOOR_GATE] Seq #${seq} | Dir: ${aiDirection.toFixed(4)} (Mag: ${aiDirectionMag.toFixed(4)} < DynamicFloor: ${dynamicConvictionFloor.toFixed(4)}, Z-Score: ${zScore.toFixed(2)} < 1.5) -> Signals Filtered`);
      }

      // BUY -> Core Long Entry (allowed if Core Long is FLAT & temporal cooldown expired)
      const isCoreLongOccupied = this.hedgeLedger.getCoreLong().isOccupied;
      const hasPendingCoreLong = this.hasPendingEntryForSlot("CORE_LONG");
      const isCooldownCleared = nowMs >= longCooldownLock;

      if (!isCoreLongOccupied && !hasPendingCoreLong && !isCooldownCleared) {
        console.log(`[StrategyEngine][COOLDOWN_BLOCK] Seq #${seq} | nowMs: ${nowMs}, longCooldownLock: ${longCooldownLock}, diff: ${longCooldownLock - nowMs}ms`);
      }

      if (
        isBuySignal &&
        (isHighConfidenceAi || spreadVelocity < this.config.maxSpreadVelocity) &&
        askPrice > 0 &&
        !isCoreLongOccupied &&
        !hasPendingCoreLong &&
        isCooldownCleared
      ) {
        signalType = "BUY";
        targetPosSide = "LONG";
        targetSlotId = "CORE_LONG";
      }
      // SELL -> Short Slot Entry (Evaluated via Tier-1 Dynamic Slot Dispersion Engine)
      else if (
        isSellSignal &&
        (isHighConfidenceAi || spreadVelocity < this.config.maxSpreadVelocity) &&
        bidPrice > 0
      ) {
        const slotEval = this.hedgeLedger.evaluateDispersedShortSlotAllocation(
          bidPrice,
          this.config.tickSize,
          realizedVol,
          hawkesIntensity,
          shortCooldownLock,
          nowMs
        );

        if (slotEval !== null) {
          const slotId = `SHORT_SLOT_${slotEval.slotIndex}`;
          if (!this.hasPendingEntryForSlot(slotId)) {
            signalType = "SELL";
            targetPosSide = "SHORT";
            targetSlotIndex = slotEval.slotIndex;
            targetSlotId = slotId;
            targetSizeDecayCoeff = slotEval.sizeDecayCoeff;
          }
        }
      }

      if (signalType === "NONE") {
        if (seq % 500n === 0n) {
          console.log(
            `[StrategyEngine][SignalGate] Seq #${seq} | Composite: ${compositeScore.toFixed(4)} | AI: (dir=${aiDirection.toFixed(2)}, conf=${(aiConfidence * 100).toFixed(0)}%) | OBI: ${obi.toFixed(2)} | CVD: ${cvd.toFixed(0)} | Status: NO SIGNAL TRIGGERED`
          );
        }
        this.staticResult.sequenceNum = seq;
        this.staticResult.signalType = "NONE";
        this.staticResult.obi = obi;
        this.staticResult.cvd = cvd;
        this.staticResult.spreadVelocity = spreadVelocity;
        this.staticResult.bidPrice = bidPrice;
        this.staticResult.askPrice = askPrice;
        this.staticResult.riskResult = undefined;
        this.staticResult.executionPromise = undefined;
        return this.staticResult;
      }

      // Dynamic Taker Fallback (>75% Confidence) & 1-Tick Post-Only Offset (<=75%)
      const effectiveSlippage = Math.max(2, slippageTicks);
      const priceAdjustment = effectiveSlippage * this.config.tickSize;
      const basePrice = signalType === "BUY" ? askPrice : bidPrice;

      // 100% SOTA Maker-Dominant Execution Architecture (POST_ONLY GTX Order Routing)
      // Completely eradicates MARKET/IOC taker fee dispatches for entry signals.
      // Forces limit orders directly on the order book at best bid (BUY) and best ask (SELL), guaranteeing zero spread loss & Maker fee execution.
      let orderType: "LIMIT" | "MARKET" = "LIMIT";
      const timeInForce: "GTC" | "IOC" | "GTX" = "GTX";
      let targetPrice: number = signalType === "BUY" ? bidPrice : askPrice;

      // Dynamic .env driven USDT Sizing & LOT_SIZE Precision Rounding (Unlocks All 10 Assets)
      let finalQuantity = 0.001;
      if (basePrice > 0) {
        let targetNotionalUsdt = this.config.tradeSizeUsdt > 0 ? this.config.tradeSizeUsdt : 60.0;

        // Cap single order target notional against RiskGuard max position size limit
        const maxPosSizeUsdt = this.riskGuard.getConfig().maxPositionSizeUsdt;
        if (maxPosSizeUsdt > 0 && targetNotionalUsdt > maxPosSizeUsdt) {
          targetNotionalUsdt = maxPosSizeUsdt;
        }

        const rawQty = (targetNotionalUsdt / basePrice) * penaltyCoeff * targetSizeDecayCoeff;
        finalQuantity = formatQuantityForSymbol(this.config.symbol, rawQty, false);

        // Binance Futures Min Notional Guard: ensure order notional >= effectiveMinNotional using conservative price
        const symbolRule = SymbolPrecisionRegistry.getPrecisionRule(this.config.symbol);
        const effectiveMinNotional = Math.max(this.config.minNotionalUsdt, symbolRule.minNotional);
        const effectivePrice = Math.min(basePrice, targetPrice);

        if (effectivePrice > 0 && finalQuantity * effectivePrice < effectiveMinNotional) {
          const requiredQty = effectiveMinNotional / effectivePrice;
          finalQuantity = formatQuantityForSymbol(this.config.symbol, requiredQty, true);
        }
      }



      // Avellaneda-Stoikov Inventory Shift: Skew sell target higher for deeper short slots
      if (signalType === "SELL" && targetSlotIndex !== undefined && targetSlotIndex > 0) {
        targetPrice = targetPrice + targetSlotIndex * 2.0 * this.config.tickSize;
      }

      // Evaluate Dynamic Risk & Microstructure Trap Avoidance Profile
      const microMetrics: DynamicMicrostructureMetrics = {
        obi,
        cvd,
        rvGk: this.client.getGarmanKlassRV(this.assetIndex),
        vpin: this.client.getVPIN(this.assetIndex),
        hurst: this.client.getHurstExponent(this.assetIndex),
        lobEntropy: this.client.getLOBEntropy(this.assetIndex),
        regime: this.client.getRegimeStateCode(this.assetIndex),
        isSweepDetected: this.client.getIsSweepDetected(this.assetIndex),
      };

      const riskProfile = this.dynamicRiskEngine.evaluateDynamicRisk(
        targetPrice,
        targetPosSide === "LONG" ? "LONG" : "SHORT",
        microMetrics,
        Math.abs(askPrice - bidPrice)
      );
      riskProfile.isHighConfidenceAi = isHighConfidenceAi;
      riskProfile.aiConfidence = aiConfidence;

      // Populate pre-allocated intent via Zero-GC Mutator
      this.prepareOrderIntent(
        signalType,
        finalQuantity,
        SymbolPrecisionRegistry.formatPrice(this.config.symbol, targetPrice),
        targetPosSide,
        false,
        false,
        riskProfile,
        SymbolPrecisionRegistry.formatPrice(this.config.symbol, riskProfile.stopLossPrice),
        SymbolPrecisionRegistry.formatPrice(this.config.symbol, riskProfile.takeProfitPrice)
      );

      // Pass through Risk Management Guard with target position side
      const isConfigured = this.executionClient.isConfigured();
      const riskResult = (this.riskGuard instanceof MultiAssetRiskGuard)
        ? (this.riskGuard as MultiAssetRiskGuard).validateMultiAssetOrder(this.reusableOrderIntent, isConfigured)
        : this.riskGuard.validateOrder(
            this.reusableOrderIntent,
            isConfigured,
            targetPosSide
          );

      if (!riskResult.passed) {
        if (seq % 1000n === 0n) {
          console.log(`[StrategyEngine][RISK_REJECTED] Seq #${seq} | Reason: ${riskResult.reasonCode} - ${riskResult.message}`);
        }
      } else {
        finalizedSignalVal = signalType === "BUY" ? 1.0 : signalType === "SELL" ? 2.0 : 0.0;
      }

      let executionPromise: Promise<BinanceOrderResponse | null> | undefined = undefined;

      if (riskResult.passed) {
        this.isOrderInFlight = true;

        // Set atomic SAB hysteresis lockout (cooldown per side) to suppress microburst sweeps
        if (targetPosSide === "SHORT") {
          this.client.setShortCooldownLock(Date.now() + this.config.cooldownMs, this.assetIndex);
          this.client.setLastShortFillPrice(this.reusableOrderIntent.price, this.assetIndex);
        } else if (targetPosSide === "LONG") {
          this.client.setLongCooldownLock(Date.now() + this.config.cooldownMs, this.assetIndex);
          this.client.setLastLongFillPrice(this.reusableOrderIntent.price, this.assetIndex);
        }

        const notional = this.reusableOrderIntent.price * this.reusableOrderIntent.quantity;

        console.log(`[BinanceExecution][DISPATCHING] Submitting ${orderType} ${this.reusableOrderIntent.side} order for ${this.reusableOrderIntent.quantity} ${this.reusableOrderIntent.symbol} to Binance Futures...`);

        const orderParams: BinanceOrderParams = {
          symbol: this.reusableOrderIntent.symbol,
          side: this.reusableOrderIntent.side,
          type: orderType,
          quantity: this.reusableOrderIntent.quantity,
          positionSide: targetPosSide,
        };

        if (orderType === "LIMIT") {
          orderParams.price = this.reusableOrderIntent.price;
          orderParams.timeInForce = timeInForce;
        }

        executionPromise = this.executionClient
          .placeOrder(orderParams)
          .then((res) => {
            if (res) {
              const execPx = parseFloat(res.price || res.avgPrice || "0") || targetPrice;
              const executedQty = parseFloat(res.executedQty || "0");
              const isFilled = res.status === "FILLED" || executedQty > 0;
              const isPending = res.status === "NEW";

              console.log(`[BinanceExecution][RESPONSE] OrderId: ${res.orderId}, Status: ${res.status}, ExecQty: ${executedQty}, Price: ${execPx}`);

              if (isFilled) {
                // Confirmed Fill on REST Response! Occupy slot immediately
                this.onExecutionCompleted({
                  symbol: this.config.symbol,
                  assetIndex: this.assetIndex,
                  side: res.side as "BUY" | "SELL",
                  positionSide: targetPosSide!,
                  isCloseOrder: false,
                  executedQty: executedQty > 0 ? executedQty : finalQuantity,
                  executedPrice: execPx,
                  fillTimestampMs: Date.now(),
                });

                const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
                const volEstimate = garmanKlassRV > 0.000001 ? Math.sqrt(garmanKlassRV) : 0.005;
                const dynamicSlPct = Math.max(0.005, volEstimate * 2.0);
                const dynamicSlPercent = dynamicSlPct * 100;

                if (targetPosSide === "LONG") {
                  this.hedgeLedger.occupyCoreLong(finalQuantity, execPx, this.config.longTakeProfitPercent, dynamicSlPercent);
                  this.dispatchBatchPostOnlyTpOrders("CORE_LONG", execPx, finalQuantity, "LONG").catch((err) => {
                    console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
                  });
                } else if (targetPosSide === "SHORT" && targetSlotIndex !== undefined) {
                  const slotId = `SHORT_SLOT_${targetSlotIndex}`;
                  this.hedgeLedger.occupyShortSlot(targetSlotIndex, finalQuantity, execPx, this.config.shortTakeProfitPercent, dynamicSlPercent);
                  this.dispatchBatchPostOnlyTpOrders(slotId, execPx, finalQuantity, "SHORT").catch((err) => {
                    console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
                  });
                }
              } else if (isPending && res.orderId) {
                // Pending Limit / Post-Only Order placed on Binance orderbook: DO NOT occupy slot until WS fill confirmation
                const numericOrderId = typeof res.orderId === "number" ? res.orderId : parseInt(String(res.orderId), 10);
                if (!isNaN(numericOrderId)) {
                  this.pendingEntryOrders.set(numericOrderId, {
                    slotId: targetSlotId!,
                    posSide: targetPosSide!,
                    slotIndex: targetSlotIndex,
                    qty: finalQuantity,
                    targetPrice: execPx,
                  });
                  console.log(`[BinanceExecution][PENDING_FILL] Registered pending entry OrderId #${numericOrderId} for slot ${targetSlotId}. Slot WILL NOT be occupied until WS fill confirmation.`);
                }
              } else {
                console.warn(`[BinanceExecution][UNFILLED_ORDER] Order placement returned status "${res.status}". Local slot ${targetSlotId} remains FLAT.`);
              }
            }
            return res;
          })
          .catch((err) => {
            console.error(`[BinanceExecution][REJECTED] Order Placement Failed: ${err.message}`);
            return null;
          })
          .finally(() => {
            this.isOrderInFlight = false;
          });
      }

      return {
        sequenceNum: seq,
        signalType,
        positionSide: targetPosSide,
        slotId: targetSlotId,
        targetSlotIndex,
        obi,
        cvd,
        spreadVelocity,
        bidPrice,
        askPrice,
        riskResult,
        executionPromise,
      };
    } catch (err: any) {
      finalizedSignalVal = 0.0;
      console.error(`[ENGINE_EVALUATE_TICK_ERROR][Asset #${this.assetIndex}] Exception in evaluateTick: ${err.message}`);
      this.staticResult.sequenceNum = this.lastProcessedSequence;
      this.staticResult.signalType = "NONE";
      this.staticResult.riskResult = {
        passed: false,
        reasonCode: "CRITICAL_EVALUATION_EXCEPTION",
        message: err.message || "Unhandled exception during tick evaluation",
      };
      this.staticResult.executionPromise = undefined;
      return this.staticResult;
    } finally {
      // NON-NEGOTIABLE SAFETY INVARIANT: Enforce atomic SAB Slot 137 synchronization across ALL exit paths
      this.client.setFinalizedSignal(finalizedSignalVal, this.assetIndex);
    }
  }

  public getConfig(): Readonly<StrategyConfig> {
    return this.config;
  }
}

export { MultiAssetStrategyEngine, MultiAssetSignalBatch } from "./multiEngine";

