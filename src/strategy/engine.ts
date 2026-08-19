import { MarketDataClient } from "../marketDataClient";
import { RiskGuard, MultiAssetRiskGuard, OrderIntent, RiskCheckResult } from "./risk";
import { BinanceExecutionClient, BinanceOrderResponse, BinanceOrderParams, BinancePositionRisk, BinanceUserTrade } from "../execution/binance";
import { ClientOrderIdGenerator } from "../execution/clientOrderIdGenerator";
import { PositionLedger, HedgePositionLedger, MultiAssetPositionLedger, PositionSlot, SlotExitTrigger, ActiveTradeSlot } from "./positionLedger";
import { DynamicRiskEngine, DynamicMicrostructureMetrics, DynamicRiskProfile } from "./dynamicRiskEngine";
import { MicrostructureHazardEngine } from "./microstructureHazardEngine";
import { VolatilitySurfaceEngine } from "./volatilitySurfaceEngine";
import { HJBReservationEngine } from "./hjbReservationEngine";
import { BinanceUserDataStream, OrderTradeUpdatePayload, AccountPositionUpdatePayload } from "../execution/userDataStream";
import { SymbolPrecisionRegistry } from "../config/symbolPrecision";
import { getTradingSymbols } from "../config/tradingSymbols";
import { AutoRecalibrationManager } from "../ai/recalibrationWorker";

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
  private slSyncLocks: Set<string> = new Set();
  private pendingSlSyncTargets: Map<string, { quantity: number; side: "LONG" | "SHORT"; price: number }> = new Map();
  private pendingEntryOrders: Map<number, { slotId: string; posSide: "LONG" | "SHORT"; slotIndex?: number; qty: number; targetPrice: number; clientOrderId?: string; timeoutTimer?: NodeJS.Timeout }> = new Map();
  private processedFillOrderIds: Set<number> = new Set();
  private processedFillClientOrderIds: Set<string> = new Set();
  private settlementTimers: Map<string, NodeJS.Timeout> = new Map();

  private reusableOrderIntent!: OrderIntent;
  private lastSabSyncTs: number = 0;

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
    const defaultMinAiConfidence = !isNaN(envMinAiConfidence) ? envMinAiConfidence : 0.653;
    const defaultAggressiveConfidence = !isNaN(envAggressiveConfidence) ? envAggressiveConfidence : 0.750;
    const defaultObiBuy = !isNaN(envObiBuy) ? envObiBuy : 0.35;
    const defaultObiSell = !isNaN(envObiSell) ? envObiSell : -0.35;
    const defaultCvdBuy = !isNaN(envCvdBuy) ? envCvdBuy : 0.0;
    const defaultCvdSell = !isNaN(envCvdSell) ? envCvdSell : 0.0;
    const defaultMaxSpreadVelocity = !isNaN(envMaxSpreadVelocity) ? envMaxSpreadVelocity : 5.0;
    const defaultMaxSpreadEth = !isNaN(envMaxSpreadEth) ? envMaxSpreadEth : 0.40;
    const defaultMaxSpreadBtc = !isNaN(envMaxSpreadBtc) ? envMaxSpreadBtc : 1.50;
    const defaultMaxSpreadAlt = !isNaN(envMaxSpreadAlt) ? envMaxSpreadAlt : 0.20;
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

    if (this.executionClient) {
      this.executionClient.subscribeIncomeUpdates((incomes) => {
        for (const inc of incomes) {
          if (inc.symbol && inc.symbol !== this.config.symbol && inc.symbol !== "GLOBAL") continue;
          const val = parseFloat(inc.income || "0");
          if (inc.incomeType === "FUNDING_FEE" && !isNaN(val)) {
            this.hedgeLedger.recordFundingFee(val, inc.symbol);
            console.log(`[BinanceExecution][INCOME_SYNC] [${this.config.symbol}] Funding fee recorded: ${val >= 0 ? "+" : ""}$${val.toFixed(4)} (Total Funding: $${this.hedgeLedger.getCumulativeFundingFees().toFixed(4)})`);
          } else if (inc.incomeType === "COMMISSION" && !isNaN(val)) {
            this.hedgeLedger.recordExactCommission(Math.abs(val));
          }
        }
        const reconciledBal = this.executionClient.getReconciledWalletBalance();
        if (reconciledBal > 0) {
          this.hedgeLedger.setReconciledWalletBalance(reconciledBal);
        }
        this.syncSabPositionState();
      });
    }
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
    const sideCode = summary.side === "BOTH" ? 3.0 : summary.side === "LONG" ? 1.0 : summary.side === "SHORT" ? 2.0 : 0.0;
    this.client.setOmsPositionQty(summary.netQuantity, this.assetIndex);
    this.client.setOmsPositionSide(sideCode, this.assetIndex);
    this.client.setOmsLongPositionQty(summary.longQuantity, this.assetIndex);
    this.client.setOmsShortPositionQty(summary.shortQuantity, this.assetIndex);
    this.client.setOmsAvgEntryPrice(summary.averageEntryPrice, this.assetIndex);
    this.client.setOmsLongAvgEntryPrice(summary.longAverageEntryPrice, this.assetIndex);
    this.client.setOmsShortAvgEntryPrice(summary.shortAverageEntryPrice, this.assetIndex);
    this.client.setOmsLongUnrealizedPnl(summary.longUnrealizedPnl, this.assetIndex);
    this.client.setOmsShortUnrealizedPnl(summary.shortUnrealizedPnl, this.assetIndex);
    this.client.setOmsRealizedPnl(summary.cumulativeRealizedPnl, this.assetIndex);
    this.client.setOmsUnrealizedPnl(summary.unrealizedPnl, this.assetIndex);
    this.client.setOmsLeverage(this.config.leverageMultiplier, this.assetIndex);
    this.client.setOmsTotalTrades(summary.totalTrades, this.assetIndex);
    this.client.setOmsWinningTrades(summary.winningTrades, this.assetIndex);
    this.client.setOmsLosingTrades(summary.losingTrades, this.assetIndex);
  }

  public setLeverageMultiplier(leverage: number): void {
    if (Number.isFinite(leverage) && leverage > 0) {
      this.config.leverageMultiplier = leverage;
      this.positionLedger.setLeverage(leverage);
      this.hedgeLedger.setLeverage(leverage);
      this.client.setOmsLeverage(leverage, this.assetIndex);
    }
  }

  public getLeverageMultiplier(): number {
    return this.config.leverageMultiplier;
  }

  public hasPendingEntryForSlot(slotId: string): boolean {
    for (const pending of this.pendingEntryOrders.values()) {
      if (pending.slotId === slotId) {
        return true;
      }
    }
    return false;
  }

  public clearPendingEntryOrders(): void {
    for (const pending of this.pendingEntryOrders.values()) {
      if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
      }
    }
    this.pendingEntryOrders.clear();
    for (const timer of this.settlementTimers.values()) {
      clearTimeout(timer);
    }
    this.settlementTimers.clear();
  }

  /**
   * Centralized fill lifecycle observer for both ENTRY and EXIT executions.  /**
   * Enforces dual-tier cooldown synchronization across RiskGuard (software state)
   * and SharedArrayBuffer (zero-copy shared memory state).
   * Phase 3: Consecutive-Loss Circuit Breaker & Exponential Pacing:
   * 1 loss -> 15s pause
   * 2 losses -> 60s pause
   * 3 losses -> 180s pause
   * 5+ losses -> 900s (15 min) hard symbol circuit breaker halt
   * Realized winning exit (> +0.20% Net ROE) resets consecutive loss counter to 0.
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
    netRoe?: number;
  }): void {
    const fillTime = params.fillTimestampMs ?? Date.now();
    const notionalUsdt = params.executedQty * params.executedPrice;
    let cooldownDurationMs = this.config.cooldownMs;

    // 1. Tier 1: RiskGuard Software State & Realized PnL / Consecutive Loss Synchronization
    if (params.isCloseOrder) {
      const realizedPnl = params.realizedPnl ?? 0;
      let netRoePercent = params.netRoe;
      if (netRoePercent === undefined && notionalUsdt > 0) {
        const leverage = this.config.leverageMultiplier || 10;
        const initialMargin = notionalUsdt / leverage;
        netRoePercent = initialMargin > 0 ? (realizedPnl / initialMargin) * 100 : (realizedPnl / notionalUsdt) * 100;
      }

      const consecutiveLosses = this.riskGuard.recordTradeOutcome(
        params.symbol,
        realizedPnl,
        netRoePercent
      );

      const lossCooldownMs = RiskGuard.calculateExponentialLossCooldownMs(consecutiveLosses);
      cooldownDurationMs = Math.max(cooldownDurationMs, lossCooldownMs);
      this.riskGuard.setSymbolCooldownExpiry(params.symbol, fillTime + cooldownDurationMs);
    }

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

    const cooldownExpiry = fillTime + cooldownDurationMs;

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

    const isCircuitBreaker = params.isCloseOrder && (this.riskGuard.getConsecutiveLosses(params.symbol) >= 5);
    console.log(
      `[COOLDOWN_SYNC][${params.isCloseOrder ? (isCircuitBreaker ? "CIRCUIT_BREAKER_HALT" : "EXIT_BACKOFF") : "ENTRY"}] Completed ${params.positionSide} ${params.side} on ${params.symbol}. Qty: ${params.executedQty} @ $${params.executedPrice.toFixed(
        2
      )}. Cooldown: ${cooldownDurationMs}ms (until ${cooldownExpiry}). PnL: $${(params.realizedPnl ?? 0).toFixed(2)}${params.isCloseOrder ? ` (Consecutive Losses: ${this.riskGuard.getConsecutiveLosses(params.symbol)})` : ""}`
    );
  }

  public async initUserDataStream(): Promise<boolean> {
    if (!this.executionClient.isConfigured()) return false;
    this.userDataStream = new BinanceUserDataStream(this.executionClient);

    this.userDataStream.subscribeOrderUpdates((update: OrderTradeUpdatePayload) => {
      this.handleWsOrderUpdate(update);
    });

    this.userDataStream.subscribeAccountUpdates((accUpdate) => {
      for (const pos of accUpdate.positions) {
        if (pos.symbol === this.config.symbol) {
          this.handleWsAccountPositionUpdate(pos);
        }
      }
    });

    return this.userDataStream.start();
  }

  public handleConfirmedEntryFill(
    orderId: number,
    slotId: string,
    posSide: "LONG" | "SHORT",
    slotIndex: number | undefined,
    execQty: number,
    execPx: number
  ): void {
    const pending = this.pendingEntryOrders.get(orderId);
    const cid = pending?.clientOrderId;
    if ((orderId > 0 && this.processedFillOrderIds.has(orderId)) || (cid && this.processedFillClientOrderIds.has(cid))) {
      console.log(`[BinanceExecution][DUPLICATE_FILL_IGNORED] OrderId #${orderId} (ClId: ${cid || "N/A"}) already processed. Skipping duplicate slot occupation.`);
      return;
    }
    if (orderId > 0) this.processedFillOrderIds.add(orderId);
    if (cid) this.processedFillClientOrderIds.add(cid);

    if (pending?.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
    }
    this.pendingEntryOrders.delete(orderId);

    const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
    const volEstimate = (Number.isFinite(garmanKlassRV) && garmanKlassRV > 0.000001) ? Math.sqrt(garmanKlassRV) : 0.005;
    const baseSlPercent = posSide === "LONG" ? this.config.longStopLossPercent : this.config.shortStopLossPercent;
    const dynamicSlPercent = Math.max(baseSlPercent, Math.max(1.00, volEstimate * 3.50 * 100));
    const dynamicTpPercent = dynamicSlPercent * 2.50;

    if (posSide === "LONG") {
      this.hedgeLedger.occupyCoreLong(execQty, execPx, dynamicTpPercent, dynamicSlPercent, false);
      const aggLong = this.hedgeLedger.getAggregatedSideSummary("LONG");

      // Atomic TP Replacement: Cancel previous resting TP limit orders to prevent stale sub-lots
      this.cancelRestingTpOrders("CORE_LONG").then(() => {
        return this.dispatchAggregatedBatchPostOnlyTpOrders("CORE_LONG", aggLong.vwapEntryPrice, aggLong.totalQuantity, "LONG");
      }).catch((err) => {
        console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
      });

      // Position-Level Stop Loss: Submits native STOP_MARKET with closePosition=true covering 100% of aggregated position
      this.syncExchangeStopLossOrder("CORE_LONG", aggLong.totalQuantity, "LONG", aggLong.stopLossPrice).catch((err) => {
        console.error(`[EXCHANGE_SL_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
      });
    } else if (posSide === "SHORT") {
      const targetIdx = slotIndex !== undefined ? slotIndex : (this.hedgeLedger.getAvailableShortSlotIndex() >= 0 ? this.hedgeLedger.getAvailableShortSlotIndex() : 0);
      const targetSlotId = `SHORT_SLOT_${targetIdx}`;
      this.hedgeLedger.occupyShortSlot(targetIdx, execQty, execPx, dynamicTpPercent, dynamicSlPercent, false);
      const aggShort = this.hedgeLedger.getAggregatedSideSummary("SHORT");

      // Atomic TP Replacement: Cancel all existing resting TP limit orders across short slots
      Promise.all(aggShort.slotIds.map((slId) => this.cancelRestingTpOrders(slId))).then(() => {
        return this.dispatchAggregatedBatchPostOnlyTpOrders(targetSlotId, aggShort.vwapEntryPrice, aggShort.totalQuantity, "SHORT");
      }).catch((err) => {
        console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
      });

      // Position-Level Stop Loss: Submits native STOP_MARKET with closePosition=true covering 100% of aggregated position
      this.syncExchangeStopLossOrder(targetSlotId, aggShort.totalQuantity, "SHORT", aggShort.stopLossPrice).catch((err) => {
        console.error(`[EXCHANGE_SL_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
      });
    }

    this.onExecutionCompleted({
      symbol: this.config.symbol,
      assetIndex: this.assetIndex,
      side: posSide === "LONG" ? "BUY" : "SELL",
      positionSide: posSide,
      isCloseOrder: false,
      executedQty: execQty,
      executedPrice: execPx,
      fillTimestampMs: Date.now(),
    });
    this.syncSabPositionState();
  }

  /**
   * Double-Entry Asynchronous Fallback Trade Settlement State Machine.
   * When an exchange notification indicates a position is flat (amount = 0),
   * pauses for a 250ms grace buffer to allow in-flight WS ORDER_TRADE_UPDATE fills to resolve.
   * If local slots remain occupied after 250ms, fetches exact trade fills from Binance REST /fapi/v1/userTrades
   * to extract the exact executed price, realized PnL, and commission, ensuring 100% micro-cent accurate SAB updates.
   */
  public async reconcileFlatPositionWithUserTrades(
    posSide: "LONG" | "SHORT" | "BOTH",
    delayMs: number = 250
  ): Promise<void> {
    const timerKey = `${this.config.symbol}_${posSide}`;
    if (this.settlementTimers.has(timerKey)) {
      clearTimeout(this.settlementTimers.get(timerKey)!);
      this.settlementTimers.delete(timerKey);
    }

    const settleAction = async () => {
      this.settlementTimers.delete(timerKey);
      const summary = this.hedgeLedger.getSummary();
      const needsLongSettle = (posSide === "LONG" || posSide === "BOTH") && summary.longQuantity > 1e-6;
      const needsShortSettle = (posSide === "SHORT" || posSide === "BOTH") && summary.shortQuantity > 1e-6;

      if (!needsLongSettle && !needsShortSettle) {
        return; // Slot was already settled by an incoming WS fill report during the grace buffer
      }

      console.log(
        `[DOUBLE_ENTRY_OMS][SETTLEMENT_TRIGGERED] [${this.config.symbol}] Fallback settlement active after ${delayMs}ms grace buffer. Fetching REST userTrades for exact PnL...`
      );

      const coreLongSlot = this.hedgeLedger.getCoreLong();
      const longOpenTime = coreLongSlot.isOccupied ? coreLongSlot.openTime : 0;
      const occupiedShortSlots = this.hedgeLedger.getShortSlots().filter((s) => s.isOccupied && s.openTime > 0);
      const shortOpenTime = occupiedShortSlots.length > 0 ? Math.min(...occupiedShortSlots.map((s) => s.openTime)) : 0;

      // SOTA Audit 3.0 Timestamp Barrier: Bounded 1-hour fallback window for unrecorded/adopted slots (Loophole #2 Fix)
      const fallbackWindowMs = 3600000; // 1 hour
      const effectiveLongOpenTime = longOpenTime > 0 ? longOpenTime : (Date.now() - fallbackWindowMs);
      const effectiveShortOpenTime = shortOpenTime > 0 ? shortOpenTime : (Date.now() - fallbackWindowMs);

      let trades: BinanceUserTrade[] = [];
      if (this.executionClient.isConfigured()) {
        try {
          // SOTA Audit 3.0 Multi-Side Selection: Earliest timestamp strictly governs BOTH mode queries (Loophole #3 Fix)
          const slotOpenTime = posSide === "LONG"
            ? effectiveLongOpenTime
            : posSide === "SHORT"
            ? effectiveShortOpenTime
            : Math.min(effectiveLongOpenTime, effectiveShortOpenTime);

          trades = await this.executionClient.getUserTrades(this.config.symbol, 10, slotOpenTime);
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.warn(
            `[DOUBLE_ENTRY_OMS][USER_TRADES_WARN] [${this.config.symbol}] Failed to fetch userTrades: ${errorMessage}`
          );
        }
      }

      const markPrice = this.client.getMidPrice(this.assetIndex);
      const takerFeeRate = this.hedgeLedger.getSizingCalculator().getTakerFeeRate();

      // 1. Reconcile LONG position if still open
      if (needsLongSettle) {
        // Filter trades for closing LONG position: strictly requires SELL side and t.time >= effectiveLongOpenTime (Loophole #1 & #2 Fix)
        const longExitTrades = trades.filter(
          (t) =>
            ((t.buyer === false || t.side === "SELL") && t.side !== "BUY") &&
            (t.positionSide === "LONG" || t.positionSide === "BOTH" || !t.positionSide) &&
            parseFloat(t.qty || "0") > 0 &&
            t.time !== undefined &&
            t.time >= effectiveLongOpenTime
        );

        let exactPnl: number | undefined = undefined;
        let exactCommission: number | undefined = undefined;
        let exactExitPrice: number | undefined = undefined;

        if (longExitTrades.length > 0) {
          let totalPnl = 0;
          let totalComm = 0;
          let weightedPxSum = 0;
          let totalQty = 0;
          let hasRealizedPnl = false;

          for (const t of longExitTrades) {
            const tQty = parseFloat(t.qty || "0");
            const tPx = parseFloat(t.price || "0");
            const tPnl = parseFloat(t.realizedPnl || "0");
            const tComm = parseFloat(t.commission || "0");

            if (t.realizedPnl !== undefined && !isNaN(tPnl)) {
              totalPnl += tPnl;
              hasRealizedPnl = true;
            }
            if (!isNaN(tComm)) totalComm += tComm;
            if (tQty > 0 && tPx > 0) {
              weightedPxSum += tPx * tQty;
              totalQty += tQty;
            }
          }

          if (totalQty > 0) exactExitPrice = weightedPxSum / totalQty;
          if (hasRealizedPnl) exactPnl = totalPnl;
          if (totalComm > 0) exactCommission = totalComm;

          console.log(
            `[DOUBLE_ENTRY_OMS][LONG_SETTLED_EXACT] [${this.config.symbol}:CORE_LONG] Reconciled from ${longExitTrades.length} Binance trade(s): ExitPrice: $${exactExitPrice?.toFixed(4)}, RealizedPnL: $${exactPnl?.toFixed(4)}, Comm: $${exactCommission?.toFixed(4)}`
          );

          const resolvedExitPx = exactExitPrice && exactExitPrice > 0 ? exactExitPrice : (markPrice > 0 ? markPrice : undefined);
          this.hedgeLedger.releaseCoreLong(
            resolvedExitPx,
            takerFeeRate,
            "EXCHANGE_REST_TRADE_SETTLED",
            markPrice,
            exactPnl,
            exactCommission
          );
        } else {
          // SOTA TWO-PHASE FLATTENING BARRIER:
          // No closing trades detected in userTrades! Before blindly wiping, verify against live exchange position state.
          let isStillOpenOnExchange = false;
          let isVerifiedFlatOnExchange = false;

          if (this.executionClient.isConfigured()) {
            try {
              const freshPositions = await this.executionClient.getDualPositionRisk(this.config.symbol);
              const activeOnExchange = freshPositions.filter((p) => {
                if (p.symbol !== this.config.symbol) return false;
                const amt = parseFloat(p.positionAmt || "0");
                if (p.positionSide === "LONG") return amt > 0;
                if (p.positionSide === "BOTH") return amt > 0; // Strict positive sign for LONG in One-Way mode
                return false;
              });

              if (activeOnExchange.length > 0) {
                isStillOpenOnExchange = true;
                console.warn(
                  `[TWO_PHASE_BARRIER][PROTECTED] [${this.config.symbol}:CORE_LONG] Blind wipe aborted! No closing trades found and exchange shows position STILL OPEN (${activeOnExchange[0].positionAmt} @ $${activeOnExchange[0].entryPrice}). Re-adopting into ledger.`
                );
                this.reconcileStartupPositions(activeOnExchange);
              } else {
                isVerifiedFlatOnExchange = true;
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              console.error(
                `[TWO_PHASE_BARRIER][NETWORK_ERROR] [${this.config.symbol}:CORE_LONG] Position verification failed due to network/consensus error: ${errorMessage}. ABORTING FLATTENING TO PROTECT ACTIVE POSITION.`
              );
            }
          } else {
            isVerifiedFlatOnExchange = true;
          }

          if (isVerifiedFlatOnExchange && !isStillOpenOnExchange) {
            console.log(`[DOUBLE_ENTRY_OMS][LONG_SETTLED_FALLBACK] [${this.config.symbol}:CORE_LONG] Position verified flat on exchange. Releasing slot with mark price $${markPrice}.`);
            this.hedgeLedger.releaseCoreLong(
              markPrice > 0 ? markPrice : undefined,
              takerFeeRate,
              "EXCHANGE_WS_ACCOUNT_EXIT",
              markPrice
            );
          }
        }
      }

      // 2. Reconcile SHORT position if still open
      if (needsShortSettle) {
        // Filter trades for closing SHORT position: strictly requires BUY side and t.time >= effectiveShortOpenTime (Loophole #1 & #2 Fix)
        const shortExitTrades = trades.filter(
          (t) =>
            ((t.buyer === true || t.side === "BUY") && t.side !== "SELL") &&
            (t.positionSide === "SHORT" || t.positionSide === "BOTH" || !t.positionSide) &&
            parseFloat(t.qty || "0") > 0 &&
            t.time !== undefined &&
            t.time >= effectiveShortOpenTime
        );

        let exactPnl: number | undefined = undefined;
        let exactCommission: number | undefined = undefined;
        let exactExitPrice: number | undefined = undefined;

        if (shortExitTrades.length > 0) {
          let totalPnl = 0;
          let totalComm = 0;
          let weightedPxSum = 0;
          let totalQty = 0;
          let hasRealizedPnl = false;

          for (const t of shortExitTrades) {
            const tQty = parseFloat(t.qty || "0");
            const tPx = parseFloat(t.price || "0");
            const tPnl = parseFloat(t.realizedPnl || "0");
            const tComm = parseFloat(t.commission || "0");

            if (t.realizedPnl !== undefined && !isNaN(tPnl)) {
              totalPnl += tPnl;
              hasRealizedPnl = true;
            }
            if (!isNaN(tComm)) totalComm += tComm;
            if (tQty > 0 && tPx > 0) {
              weightedPxSum += tPx * tQty;
              totalQty += tQty;
            }
          }

          if (totalQty > 0) exactExitPrice = weightedPxSum / totalQty;
          if (hasRealizedPnl) exactPnl = totalPnl;
          if (totalComm > 0) exactCommission = totalComm;

          console.log(
            `[DOUBLE_ENTRY_OMS][SHORT_SETTLED_EXACT] [${this.config.symbol}:SHORT_SLOTS] Reconciled from ${shortExitTrades.length} Binance trade(s): ExitPrice: $${exactExitPrice?.toFixed(4)}, RealizedPnL: $${exactPnl?.toFixed(4)}, Comm: $${exactCommission?.toFixed(4)}`
          );

          const resolvedExitPx = exactExitPrice && exactExitPrice > 0 ? exactExitPrice : (markPrice > 0 ? markPrice : undefined);
          for (let i = 0; i < this.config.maxShortSlots; i++) {
            this.hedgeLedger.releaseShortSlot(
              i,
              resolvedExitPx,
              takerFeeRate,
              "EXCHANGE_REST_TRADE_SETTLED",
              markPrice,
              exactPnl,
              exactCommission
            );
          }
        } else {
          // SOTA TWO-PHASE FLATTENING BARRIER:
          // No closing trades detected in userTrades! Before blindly wiping, verify against live exchange position state.
          let isStillOpenOnExchange = false;
          let isVerifiedFlatOnExchange = false;

          if (this.executionClient.isConfigured()) {
            try {
              const freshPositions = await this.executionClient.getDualPositionRisk(this.config.symbol);
              const activeOnExchange = freshPositions.filter((p) => {
                if (p.symbol !== this.config.symbol) return false;
                const amt = parseFloat(p.positionAmt || "0");
                if (p.positionSide === "SHORT") return amt < 0;
                if (p.positionSide === "BOTH") return amt < 0; // Strict negative sign for SHORT in One-Way mode
                return false;
              });

              if (activeOnExchange.length > 0) {
                isStillOpenOnExchange = true;
                console.warn(
                  `[TWO_PHASE_BARRIER][PROTECTED] [${this.config.symbol}:SHORT_SLOTS] Blind wipe aborted! No closing trades found and exchange shows position STILL OPEN (${activeOnExchange[0].positionAmt} @ $${activeOnExchange[0].entryPrice}). Re-adopting into ledger.`
                );
                this.reconcileStartupPositions(activeOnExchange);
              } else {
                isVerifiedFlatOnExchange = true;
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              console.error(
                `[TWO_PHASE_BARRIER][NETWORK_ERROR] [${this.config.symbol}:SHORT_SLOTS] Position verification failed due to network/consensus error: ${errorMessage}. ABORTING FLATTENING TO PROTECT ACTIVE POSITION.`
              );
            }
          } else {
            isVerifiedFlatOnExchange = true;
          }

          if (isVerifiedFlatOnExchange && !isStillOpenOnExchange) {
            console.log(`[DOUBLE_ENTRY_OMS][SHORT_SETTLED_FALLBACK] [${this.config.symbol}:SHORT_SLOTS] Position verified flat on exchange. Releasing slots with mark price $${markPrice}.`);
            for (let i = 0; i < this.config.maxShortSlots; i++) {
              this.hedgeLedger.releaseShortSlot(
                i,
                markPrice > 0 ? markPrice : undefined,
                takerFeeRate,
                "EXCHANGE_WS_ACCOUNT_EXIT",
                markPrice
              );
            }
          }
        }
      }

      this.syncSabPositionState(0);
    };

    if (delayMs <= 0) {
      await settleAction();
    } else {
      const timer = setTimeout(() => {
        settleAction().catch((err) => {
          console.error(`[DOUBLE_ENTRY_OMS][SETTLEMENT_ERROR] [${this.config.symbol}] ${err?.message || String(err)}`);
        });
      }, delayMs);
      this.settlementTimers.set(timerKey, timer);
    }
  }

  public handleWsAccountPositionUpdate(posUpdate: AccountPositionUpdatePayload): void {
    if (posUpdate.symbol !== this.config.symbol) return;
    const amt = posUpdate.positionAmt;
    const entryPx = posUpdate.entryPrice;
    const summary = this.hedgeLedger.getSummary();
    const absQty = Math.abs(amt);

    if (absQty === 0) {
      if ((posUpdate.positionSide === "LONG" || posUpdate.positionSide === "BOTH") && summary.longQuantity > 1e-6) {
        console.log(`[BinanceExecution][WS_ACCOUNT_UPDATE] [${this.config.symbol}:CORE_LONG] Exchange LONG position FLAT. Initiating double-entry settlement.`);
        this.reconcileFlatPositionWithUserTrades("LONG", 250);
      }
      if ((posUpdate.positionSide === "SHORT" || posUpdate.positionSide === "BOTH") && summary.shortQuantity > 1e-6) {
        console.log(`[BinanceExecution][WS_ACCOUNT_UPDATE] [${this.config.symbol}:SHORT_SLOTS] Exchange SHORT position FLAT. Initiating double-entry settlement.`);
        this.reconcileFlatPositionWithUserTrades("SHORT", 250);
      }
    } else if (absQty > 0 && entryPx > 0) {
      const targetSide = posUpdate.positionSide === "LONG" || (posUpdate.positionSide === "BOTH" && amt > 0) ? "LONG" : "SHORT";
      const isTracked = (targetSide === "LONG" && Math.abs(summary.longQuantity - absQty) < 1e-5) ||
                        (targetSide === "SHORT" && Math.abs(summary.shortQuantity - absQty) < 1e-5);
      if (!isTracked) {
        console.warn(`[BinanceExecution][WS_ACCOUNT_UPDATE_DESYNC] Reconciling active ${targetSide} position for ${this.config.symbol}: ${absQty} @ $${entryPx}`);
        if (targetSide === "LONG") {
          this.hedgeLedger.occupyCoreLong(absQty, entryPx, this.config.longTakeProfitPercent, this.config.longStopLossPercent, true);
          if (posUpdate.positionSide === "BOTH") {
            this.reconcileFlatPositionWithUserTrades("SHORT", 0);
          }
          const aggLong = this.hedgeLedger.getAggregatedSideSummary("LONG");
          this.syncExchangeStopLossOrder("CORE_LONG", aggLong.totalQuantity, "LONG", aggLong.stopLossPrice).catch((err) => {
            console.error(`[EXCHANGE_SL_ENGINE][SYNC_ERR] Long SL desync sync failed: ${err.message}`);
          });
        } else {
          const availIdx = this.hedgeLedger.getAvailableShortSlotIndex();
          const slotIdx = availIdx >= 0 ? availIdx : 0;
          this.hedgeLedger.occupyShortSlot(slotIdx, absQty, entryPx, this.config.shortTakeProfitPercent, this.config.shortStopLossPercent, true);
          if (posUpdate.positionSide === "BOTH") {
            this.reconcileFlatPositionWithUserTrades("LONG", 0);
          }
          const aggShort = this.hedgeLedger.getAggregatedSideSummary("SHORT");
          const targetSlotId = `SHORT_SLOT_${slotIdx}`;
          this.syncExchangeStopLossOrder(targetSlotId, aggShort.totalQuantity, "SHORT", aggShort.stopLossPrice).catch((err) => {
            console.error(`[EXCHANGE_SL_ENGINE][SYNC_ERR] Short SL desync sync failed: ${err.message}`);
          });
        }
        this.syncSabPositionState(0);
      }
    }
  }

  public handleWsOrderUpdate(update: OrderTradeUpdatePayload): void {
    const { order } = update;
    if (order.symbol !== this.config.symbol) return; // Strict asset symbol filter for zero cross-asset state pollution
    const orderId = order.orderId;
    const parsedCid = ClientOrderIdGenerator.parse(order.clientOrderId);

    if (order.orderStatus === "FILLED" || order.orderStatus === "PARTIALLY_FILLED") {
      // 1. Check if this is a pending ENTRY order confirmation from Binance
      if (this.pendingEntryOrders.has(orderId)) {
        const pending = this.pendingEntryOrders.get(orderId)!;
        const execPx = order.lastFilledPrice > 0 ? order.lastFilledPrice : (order.averagePrice > 0 ? order.averagePrice : pending.targetPrice);
        const execQty = order.cumulativeFilledQuantity > 0 ? order.cumulativeFilledQuantity : (order.lastFilledQuantity > 0 ? order.lastFilledQuantity : pending.qty);

        console.log(`[BinanceExecution][WS_ENTRY_FILL_CONFIRMED] [${this.config.symbol}:${pending.slotId}] OrderId #${orderId} (ClId: ${order.clientOrderId || "N/A"}) FILLED on Binance! Occupying local slot. Qty: ${execQty} @ $${execPx}`);
        this.handleConfirmedEntryFill(orderId, pending.slotId, pending.posSide, pending.slotIndex, execQty, execPx);
        return;
      }

      // 2. Check if this is a TP limit order fill or exit order fill
      if (order.orderType === "LIMIT" || order.isMaker || (parsedCid && parsedCid.orderType.startsWith("TP"))) {
        const coreLong = this.hedgeLedger.getCoreLong();
        const shortSlots = this.hedgeLedger.getShortSlots();

        let targetSlotId: string | null = null;
        let posSide: "LONG" | "SHORT" = "LONG";
        let entryPx = 0;

        if (parsedCid && parsedCid.orderType.startsWith("TP")) {
          targetSlotId = parsedCid.slotId;
          if (targetSlotId === "CORE_LONG") {
            posSide = "LONG";
            entryPx = coreLong.entryPrice;
          } else {
            posSide = "SHORT";
            const s = shortSlots.find((sl) => sl.slotId === targetSlotId);
            if (s) entryPx = s.entryPrice;
          }
        } else if (coreLong.isOccupied && coreLong.activeTpOrderIds?.includes(order.orderId)) {
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
          console.log(`[MAKER_TP_ENGINE][WS_FILL_NOTIFIED] [${this.config.symbol}:${targetSlotId}] OrderId #${order.orderId} (ClId: ${order.clientOrderId || "N/A"}) filled as ${order.isMaker ? "MAKER" : "TAKER"}. Qty: ${order.lastFilledQuantity} @ $${order.lastFilledPrice}`);
          const res = this.hedgeLedger.processTpLimitFill(targetSlotId, order.orderId, order.lastFilledQuantity, order.lastFilledPrice, order.isMaker);
          console.log(`[MAKER_TP_ENGINE][RECONCILED] [${this.config.symbol}:${targetSlotId}] Slot updated. Closed: ${res.isPositionClosed}, RemQty: ${res.remainingQuantity}, NewSL: $${res.newStopLossPrice}`);

          if (res.isPositionClosed) {
            const slId = this.hedgeLedger.getActiveStopLossOrderId(targetSlotId);
            if (slId) {
              this.executionClient.cancelOrder(this.config.symbol, slId).catch((err) => {
                console.warn(`[EXCHANGE_SL_ENGINE][CANCEL_WARN] [${this.config.symbol}:${targetSlotId}] Unable to cancel resting SL on position close #${slId}: ${err.message}`);
              });
              this.hedgeLedger.registerActiveStopLossOrderId(targetSlotId, 0);
            }
          } else if (res.remainingQuantity > 0 && res.newStopLossPrice > 0) {
            this.syncExchangeStopLossOrder(targetSlotId, res.remainingQuantity, posSide, res.newStopLossPrice).catch((err) => {
              console.error(`[EXCHANGE_SL_ENGINE][RATCHET_ERR] [${this.config.symbol}:${targetSlotId}] ${err?.message || String(err)}`);
            });
          }

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

      // 3. Fallback: Untracked WebSocket fill classification & execution
      const activeSummary = this.hedgeLedger.getSummary();
      const rawPosSide = order.positionSide;

      let isExitSide = false;
      let isEntrySide = false;
      let targetPosSide: "LONG" | "SHORT" = "LONG";

      if (rawPosSide === "LONG") {
        if (order.side === "BUY") {
          isEntrySide = true;
          targetPosSide = "LONG";
        } else {
          isExitSide = true;
          targetPosSide = "LONG";
        }
      } else if (rawPosSide === "SHORT") {
        if (order.side === "SELL") {
          isEntrySide = true;
          targetPosSide = "SHORT";
        } else {
          isExitSide = true;
          targetPosSide = "SHORT";
        }
      } else {
        // Both or Undefined (One-Way Mode or missing positionSide WS attribute)
        const isReduce = order.reduceOnly === true;
        if (isReduce) {
          if (order.side === "SELL") {
            isExitSide = true;
            targetPosSide = "LONG";
          } else {
            isExitSide = true;
            targetPosSide = "SHORT";
          }
        } else {
          if (order.side === "SELL") {
            if (activeSummary.longQuantity > 1e-9 && activeSummary.shortQuantity <= 1e-9) {
              isExitSide = true;
              targetPosSide = "LONG";
            } else {
              isEntrySide = true;
              targetPosSide = "SHORT";
            }
          } else {
            // order.side === "BUY"
            if (activeSummary.shortQuantity > 1e-9 && activeSummary.longQuantity <= 1e-9) {
              isExitSide = true;
              targetPosSide = "SHORT";
            } else {
              isEntrySide = true;
              targetPosSide = "LONG";
            }
          }
        }
      }

      const execPx = order.lastFilledPrice > 0 ? order.lastFilledPrice : (order.averagePrice > 0 ? order.averagePrice : order.originalPrice);
      const execQty = order.lastFilledQuantity > 0 ? order.lastFilledQuantity : order.cumulativeFilledQuantity;

      if (execPx > 0 && execQty > 0) {
        if (isEntrySide) {
          console.log(`[BinanceExecution][UNTRACKED_ENTRY_FILL] [${this.config.symbol}:${targetPosSide}] OrderId #${orderId} (ClId: ${order.clientOrderId || "N/A"}) filled for ${this.config.symbol} ${targetPosSide}! Occupying/accumulating slot. Qty: ${execQty} @ $${execPx}`);

          const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
          const volEstimate = (Number.isFinite(garmanKlassRV) && garmanKlassRV > 0.000001) ? Math.sqrt(garmanKlassRV) : 0.005;
          const baseSlPercent = targetPosSide === "LONG" ? this.config.longStopLossPercent : this.config.shortStopLossPercent;
          const dynamicSlPercent = Math.max(baseSlPercent, Math.max(1.00, volEstimate * 3.50 * 100));
          const dynamicTpPercent = dynamicSlPercent * 2.50;

          if (targetPosSide === "LONG") {
            this.hedgeLedger.occupyCoreLong(execQty, execPx, dynamicTpPercent, dynamicSlPercent);
            const slot = this.hedgeLedger.getCoreLong();
            this.dispatchBatchPostOnlyTpOrders("CORE_LONG", execPx, execQty, "LONG").catch((err) => {
              console.error(`[BinanceExecution][UNTRACKED_TP_DISPATCH_ERROR] [${this.config.symbol}:CORE_LONG] ${err?.message || String(err)}`);
            });
            this.dispatchExchangeStopLossOrder("CORE_LONG", execPx, execQty, "LONG", slot.stopLossPrice).catch((err) => {
              console.error(`[BinanceExecution][UNTRACKED_SL_DISPATCH_ERROR] [${this.config.symbol}:CORE_LONG] ${err?.message || String(err)}`);
            });
          } else {
            const slotIdx = this.hedgeLedger.getAvailableShortSlotIndex();
            const targetIdx = slotIdx >= 0 ? slotIdx : 0;
            const slotId = `SHORT_SLOT_${targetIdx}`;
            this.hedgeLedger.occupyShortSlot(targetIdx, execQty, execPx, dynamicTpPercent, dynamicSlPercent);
            const slot = this.hedgeLedger.getShortSlots()[targetIdx];
            this.dispatchBatchPostOnlyTpOrders(slotId, execPx, execQty, "SHORT").catch((err) => {
              console.error(`[BinanceExecution][UNTRACKED_TP_DISPATCH_ERROR] [${this.config.symbol}:${slotId}] ${err?.message || String(err)}`);
            });
            if (slot) {
              this.dispatchExchangeStopLossOrder(slotId, execPx, execQty, "SHORT", slot.stopLossPrice).catch((err) => {
                console.error(`[BinanceExecution][UNTRACKED_SL_DISPATCH_ERROR] [${this.config.symbol}:${slotId}] ${err?.message || String(err)}`);
              });
            }
          }

          this.onExecutionCompleted({
            symbol: this.config.symbol,
            assetIndex: this.assetIndex,
            side: order.side as "BUY" | "SELL",
            positionSide: targetPosSide,
            isCloseOrder: false,
            executedQty: execQty,
            executedPrice: execPx,
            fillTimestampMs: Date.now(),
          });
          this.syncSabPositionState();
        } else if (isExitSide) {
          console.log(`[BinanceExecution][UNTRACKED_EXIT_FILL] [${this.config.symbol}:${targetPosSide}] OrderId #${orderId} (ClId: ${order.clientOrderId || "N/A"}) filled for ${this.config.symbol} ${targetPosSide}! Deducting/releasing slot. Qty: ${execQty} @ $${execPx}`);
          if (targetPosSide === "LONG") {
            this.hedgeLedger.deductCoreLongQuantity(execQty, execPx, this.hedgeLedger.getSizingCalculator().getTakerFeeRate(), "EXTERNAL_EXIT");
          } else {
            let remainingQtyToDeduct = execQty;
            const slots = this.hedgeLedger.getShortSlots();
            for (let sIdx = 0; sIdx < slots.length && remainingQtyToDeduct > 1e-9; sIdx++) {
              const slot = slots[sIdx];
              if (slot.isOccupied && slot.quantity > 0) {
                const closedFromSlot = Math.min(slot.quantity, remainingQtyToDeduct);
                this.hedgeLedger.deductShortSlotQuantity(sIdx, closedFromSlot, execPx, this.hedgeLedger.getSizingCalculator().getTakerFeeRate(), "EXTERNAL_EXIT");
                remainingQtyToDeduct -= closedFromSlot;
              }
            }
          }

          this.onExecutionCompleted({
            symbol: this.config.symbol,
            assetIndex: this.assetIndex,
            side: order.side as "BUY" | "SELL",
            positionSide: targetPosSide,
            isCloseOrder: true,
            executedQty: execQty,
            executedPrice: execPx,
            fillTimestampMs: Date.now(),
          });
          this.syncSabPositionState();
        }
      }
    } else if (order.orderStatus === "CANCELED" || order.orderStatus === "EXPIRED" || (order.orderStatus as string) === "REJECTED") {
      if (this.pendingEntryOrders.has(orderId)) {
        const pending = this.pendingEntryOrders.get(orderId);
        if (pending?.timeoutTimer) clearTimeout(pending.timeoutTimer);
        console.warn(`[BinanceExecution][WS_ENTRY_CANCELLED] [${this.config.symbol}] Pending entry OrderId #${orderId} (ClId: ${order.clientOrderId || "N/A"}) was ${order.orderStatus} on Binance. Rolling back slot ${pending?.slotId} to FLAT.`);
        if (pending?.slotId) {
          this.hedgeLedger.rollbackPendingSlot(pending.slotId, `WS_${order.orderStatus}`);
        }
        this.pendingEntryOrders.delete(orderId);
      }
    }
  }

  private async cancelRestingTpOrders(slotId: string): Promise<void> {
    const slot = slotId === "CORE_LONG" ? this.hedgeLedger.getCoreLong() : this.hedgeLedger.getShortSlots().find((s) => s.slotId === slotId);
    if (!slot || !slot.activeTpOrderIds || slot.activeTpOrderIds.length === 0) return;
    const orderIdsToCancel = [...slot.activeTpOrderIds];
    this.hedgeLedger.registerActiveTpOrderIds(slotId, []);
    try {
      await this.executionClient.cancelBatchOrders(this.config.symbol, orderIdsToCancel);
    } catch (err: unknown) {
      console.warn(`[MAKER_TP_ENGINE][CANCEL_BATCH_WARN] [${this.config.symbol}:${slotId}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async dispatchAggregatedBatchPostOnlyTpOrders(
    slotId: string,
    vwapEntryPrice: number,
    aggregatedQty: number,
    side: "LONG" | "SHORT"
  ): Promise<void> {
    let intents: BinanceOrderParams[] = [];
    try {
      intents = this.hedgeLedger.generateAggregatedBatchTpIntents(side, aggregatedQty, vwapEntryPrice, slotId);
      if (intents.length === 0) return;

      console.log(`[MAKER_TP_ENGINE][DISPATCHING_AGGREGATED] [${this.config.symbol}:${slotId}] Submitting ${intents.length} POST_ONLY limit TP orders for aggregated size ${aggregatedQty} @ VWAP $${vwapEntryPrice}...`);
      const resList = await this.executionClient.placeBatchOrders(intents);
      if (Array.isArray(resList) && resList.length > 0) {
        const validOrderIds: number[] = [];
        const rejectedIntents: { intent: BinanceOrderParams; code?: number }[] = [];

        resList.forEach((res: BinanceOrderResponse, idx: number) => {
          if (res && res.orderId) {
            validOrderIds.push(res.orderId);
          } else {
            const rawRes = res as unknown as { code?: number; msg?: string };
            if (rawRes && (rawRes.code === -5022 || (rawRes.msg && String(rawRes.msg).includes("-5022")))) {
              if (intents[idx]) rejectedIntents.push({ intent: intents[idx], code: rawRes.code });
            }
          }
        });

        if (validOrderIds.length > 0) {
          this.hedgeLedger.registerActiveTpOrderIds(slotId, validOrderIds);
          console.log(`[MAKER_TP_ENGINE][SUCCESS_AGGREGATED] [${this.config.symbol}:${slotId}] Registered ${validOrderIds.length} POST_ONLY TP limit order IDs for aggregated pos: [${validOrderIds.join(", ")}]`);
        }

        // Retry any individual -5022 rejections with 1-tick price shift
        for (const rej of rejectedIntents) {
          try {
            const tickSize = SymbolPrecisionRegistry.getTickSize(rej.intent.symbol);
            const currentPx = rej.intent.price || vwapEntryPrice;
            const adjustedPx = rej.intent.side === "BUY" ? currentPx - tickSize : currentPx + tickSize;
            const newPrice = SymbolPrecisionRegistry.formatPrice(rej.intent.symbol, adjustedPx);

            console.warn(`[MAKER_TP_ENGINE][-5022 AGGREGATED ITEM RETRY] [${this.config.symbol}:${slotId}] Retrying rejected TP order 1 tick away @ ${newPrice}...`);
            const retryRes = await this.executionClient.placeOrder({
              ...rej.intent,
              price: newPrice,
            });
            if (retryRes && retryRes.orderId) {
              const currentTps = this.hedgeLedger.getActiveTpOrderIds(slotId);
              this.hedgeLedger.registerActiveTpOrderIds(slotId, [...currentTps, retryRes.orderId]);
            }
          } catch (retryErr: unknown) {
            console.error(`[MAKER_TP_ENGINE][-5022 AGGREGATED ITEM RETRY FAILED] [${this.config.symbol}:${slotId}] ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
          }
        }
      }
    } catch (err: unknown) {
      console.error(`[MAKER_TP_ENGINE][ERROR_AGGREGATED] [${this.config.symbol}:${slotId}] Failed to dispatch aggregated TP batch orders: ${err instanceof Error ? err.message : String(err)}`);
    }
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

      console.log(`[MAKER_TP_ENGINE][DISPATCHING] [${this.config.symbol}:${slotId}] Submitting ${intents.length} POST_ONLY limit TP orders via batchOrders...`);
      const resList = await this.executionClient.placeBatchOrders(intents);
      if (Array.isArray(resList) && resList.length > 0) {
        const validOrderIds: number[] = [];
        const rejectedIntents: { intent: BinanceOrderParams; code?: number }[] = [];

        resList.forEach((res: BinanceOrderResponse, idx: number) => {
          if (res && res.orderId) {
            validOrderIds.push(res.orderId);
          } else {
            const rawRes = res as unknown as { code?: number; msg?: string };
            if (rawRes && (rawRes.code === -5022 || (rawRes.msg && String(rawRes.msg).includes("-5022")))) {
              if (intents[idx]) rejectedIntents.push({ intent: intents[idx], code: rawRes.code });
            }
          }
        });

        if (validOrderIds.length > 0) {
          this.hedgeLedger.registerActiveTpOrderIds(slotId, validOrderIds);
          console.log(`[MAKER_TP_ENGINE][SUCCESS] [${this.config.symbol}:${slotId}] Registered ${validOrderIds.length} POST_ONLY TP limit order IDs on Binance orderbook: [${validOrderIds.join(", ")}]`);
        }

        // Retry any individual -5022 rejections within the batch response with 1-tick price shift
        for (const rej of rejectedIntents) {
          try {
            const tickSize = SymbolPrecisionRegistry.getTickSize(rej.intent.symbol);
            const currentPx = rej.intent.price || entryPrice;
            const adjustedPx = rej.intent.side === "BUY" ? currentPx - tickSize : currentPx + tickSize;
            const newPrice = SymbolPrecisionRegistry.formatPrice(rej.intent.symbol, adjustedPx);

            console.warn(`[MAKER_TP_ENGINE][-5022 ITEM RETRY] [${this.config.symbol}:${slotId}] Retrying rejected TP order 1 tick away @ ${newPrice}...`);
            const retryRes = await this.executionClient.placeOrder({
              ...rej.intent,
              price: newPrice,
            });
            if (retryRes && retryRes.orderId) {
              const currentTps = this.hedgeLedger.getActiveTpOrderIds(slotId);
              this.hedgeLedger.registerActiveTpOrderIds(slotId, [...currentTps, retryRes.orderId]);
            }
          } catch (retryErr: unknown) {
            console.error(`[MAKER_TP_ENGINE][-5022 ITEM RETRY FAILED] [${this.config.symbol}:${slotId}] ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
          }
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("-5022") || errMsg.includes("5022")) {
        console.warn(`[MAKER_TP_ENGINE][-5022 BATCH REJECTION] [${this.config.symbol}:${slotId}] Entire TP batch rejected with -5022. Retrying target orders individually with 1-tick price shift...`);
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
              const currentTps = this.hedgeLedger.getActiveTpOrderIds(slotId);
              this.hedgeLedger.registerActiveTpOrderIds(slotId, [...currentTps, retryRes.orderId]);
            }
          } catch (retryErr: unknown) {
            console.error(`[MAKER_TP_ENGINE][-5022 INDIVIDUAL RETRY FAILED] [${this.config.symbol}:${slotId}] ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
          }
        }
      } else {
        console.error(`[MAKER_TP_ENGINE][ERROR] [${this.config.symbol}:${slotId}] Failed to submit batch POST_ONLY TP orders: ${errMsg}`);
      }
    }
  }

  public async dispatchExchangeStopLossOrder(
    slotId: string,
    entryPrice: number,
    quantity: number,
    side: "LONG" | "SHORT",
    stopLossPrice: number
  ): Promise<number | undefined> {
    if (stopLossPrice <= 0) return undefined;
    const exitSide: "BUY" | "SELL" = side === "LONG" ? "SELL" : "BUY";
    const formattedSlPx = SymbolPrecisionRegistry.formatPrice(this.config.symbol, stopLossPrice);

    const clientOrderId = ClientOrderIdGenerator.generate(this.config.symbol, slotId, "SL");
    try {
      console.log(
        `[EXCHANGE_SL_ENGINE][DISPATCHING] [${this.config.symbol}:${slotId}] Submitting position-level STOP_MARKET order on Binance: ${exitSide} (closePosition: true) @ stopPrice $${formattedSlPx} (ClId: ${clientOrderId})...`
      );
      const res = await this.executionClient.placePositionStopLoss(
        this.config.symbol,
        exitSide,
        side,
        stopLossPrice,
        clientOrderId
      );

      if (res && res.orderId) {
        this.hedgeLedger.registerActiveStopLossOrderId(slotId, res.orderId);
        console.log(`[EXCHANGE_SL_ENGINE][SUCCESS] [${this.config.symbol}:${slotId}] Registered position-level Exchange STOP_MARKET OrderId #${res.orderId} (ClId: ${res.clientOrderId || clientOrderId})`);
        return res.orderId;
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[EXCHANGE_SL_ENGINE][ERROR] [${this.config.symbol}:${slotId}] Failed to dispatch exchange STOP_MARKET order: ${errorMessage}`);
    }
    return undefined;
  }

  public async syncExchangeStopLossOrder(
    slotId: string,
    quantity: number,
    side: "LONG" | "SHORT",
    newStopLossPrice: number
  ): Promise<void> {
    if (this.slSyncLocks.has(slotId)) {
      this.pendingSlSyncTargets.set(slotId, { quantity, side, price: newStopLossPrice });
      console.log(`[EXCHANGE_SL_ENGINE][LOCKED] [${this.config.symbol}:${slotId}] Sync is already in-flight. Queued latest target SL $${newStopLossPrice}.`);
      return;
    }
    this.slSyncLocks.add(slotId);

    try {
      let currentTargetPrice = newStopLossPrice;
      let currentQty = quantity;
      let currentSide = side;

      while (true) {
        this.pendingSlSyncTargets.delete(slotId);

        const slot = slotId === "CORE_LONG" ? this.hedgeLedger.getCoreLong() : this.hedgeLedger.getShortSlots().find((s) => s.slotId === slotId);
        if (!slot || !slot.isOccupied || slot.quantity <= 0) {
          console.log(`[EXCHANGE_SL_ENGINE][SKIP] [${this.config.symbol}:${slotId}] Slot is not occupied. Skipping SL placement.`);
          return;
        }

        const existingSlId = this.hedgeLedger.getActiveStopLossOrderId(slotId);
        if (existingSlId) {
          this.hedgeLedger.registerActiveStopLossOrderId(slotId, 0);
          try {
            console.log(`[EXCHANGE_SL_ENGINE][RATCHET_CANCEL] [${this.config.symbol}:${slotId}] Cancelling previous resting Exchange STOP_MARKET OrderId #${existingSlId}...`);
            await this.executionClient.cancelOrder(this.config.symbol, existingSlId);
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.warn(`[EXCHANGE_SL_ENGINE][CANCEL_WARN] [${this.config.symbol}:${slotId}] Unable to cancel previous SL order #${existingSlId}: ${errorMessage}`);
          }
        }

        // Re-verify slot is still occupied after awaiting order cancellation
        if (!slot.isOccupied || slot.quantity <= 0) {
          console.log(`[EXCHANGE_SL_ENGINE][SKIP] [${this.config.symbol}:${slotId}] Slot closed during cancellation. Skipping new SL order.`);
          return;
        }

        const placedOrderId = await this.dispatchExchangeStopLossOrder(slotId, slot.entryPrice, currentQty, currentSide, currentTargetPrice);
        if (placedOrderId) {
          this.hedgeLedger.updateLastSyncedSlPrice(slotId, currentTargetPrice);
        }

        // If a subsequent ratchet target was queued while the network request was in-flight, process it immediately
        if (this.pendingSlSyncTargets.has(slotId)) {
          const queued = this.pendingSlSyncTargets.get(slotId)!;
          if (queued.price !== currentTargetPrice || queued.quantity !== currentQty) {
            currentTargetPrice = queued.price;
            currentQty = queued.quantity;
            currentSide = queued.side;
            continue;
          }
        }
        break;
      }
    } finally {
      this.slSyncLocks.delete(slotId);
    }
  }

  /**
   * Closed-Loop Zero-Naked Invariant Guard.
   * Continuously verifies that 100% of the active aggregated position is protected by an active exchange-native stop loss order.
   * If any unhedged exposure is detected, auto-dispatches an emergency position-level SL.
   */
  public auditActivePositionRiskClosedLoop(): void {
    const longSummary = this.hedgeLedger.getAggregatedSideSummary("LONG");
    if (longSummary.isOccupied && longSummary.totalQuantity > 0) {
      const audit = this.riskGuard.auditAggregatedPositionRisk(
        this.config.symbol,
        "LONG",
        longSummary.totalQuantity,
        longSummary.activeStopLossOrderId
      );
      if (!audit.isProtected) {
        console.warn(`[RiskGuard][CLOSED_LOOP_AUDIT_FAIL] [${this.config.symbol}:LONG] ${audit.reason} Auto-dispatching emergency position-level SL...`);
        this.syncExchangeStopLossOrder("CORE_LONG", longSummary.totalQuantity, "LONG", longSummary.stopLossPrice).catch((err) => {
          console.error(`[RiskGuard][CLOSED_LOOP_EMERGENCY_SL_FAIL] Long SL emergency sync failed: ${err.message}`);
        });
      }
    }

    const shortSummary = this.hedgeLedger.getAggregatedSideSummary("SHORT");
    if (shortSummary.isOccupied && shortSummary.totalQuantity > 0) {
      const audit = this.riskGuard.auditAggregatedPositionRisk(
        this.config.symbol,
        "SHORT",
        shortSummary.totalQuantity,
        shortSummary.activeStopLossOrderId
      );
      if (!audit.isProtected) {
        const targetSlot = shortSummary.slotIds[0] || "SHORT_SLOT_0";
        console.warn(`[RiskGuard][CLOSED_LOOP_AUDIT_FAIL] [${this.config.symbol}:SHORT] ${audit.reason} Auto-dispatching emergency position-level SL...`);
        this.syncExchangeStopLossOrder(targetSlot, shortSummary.totalQuantity, "SHORT", shortSummary.stopLossPrice).catch((err) => {
          console.error(`[RiskGuard][CLOSED_LOOP_EMERGENCY_SL_FAIL] Short SL emergency sync failed: ${err.message}`);
        });
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
      const symbolPositions = (Array.isArray(positions) ? positions : []).filter(
        (pos) => pos.symbol === this.config.symbol
      );

      // Ingest live exchange leverage setting for this symbol (even if position is currently FLAT)
      const matchingPosWithLev = symbolPositions.find((p) => parseFloat(p.leverage || "0") > 0);
      if (matchingPosWithLev) {
        const liveLev = parseFloat(matchingPosWithLev.leverage);
        this.setLeverageMultiplier(liveLev);
      }

      const activePositions = symbolPositions.filter(
        (pos) => Math.abs(parseFloat(pos.positionAmt || "0")) > 0
      );

      const symbolOpenOrders = Array.isArray(openOrders)
        ? openOrders.filter((o) => o.symbol === this.config.symbol)
        : [];

      if (activePositions.length === 0) {
        const summary = this.hedgeLedger.getSummary();

        // SOTA TWO-PHASE FLATTENING BARRIER:
        // If local ledger tracks an active position but caller snapshot reports 0, perform targeted verification
        if (summary.longQuantity > 1e-6 || summary.shortQuantity > 1e-6) {
          if (this.executionClient.isConfigured()) {
            try {
              const freshPositions = await this.executionClient.getDualPositionRisk(this.config.symbol);
              const activeOnExchange = freshPositions.filter(
                (p) => p.symbol === this.config.symbol && Math.abs(parseFloat(p.positionAmt || "0")) > 0
              );
              if (activeOnExchange.length > 0) {
                console.warn(
                  `[TWO_PHASE_BARRIER][PROTECTED] Blind wipe aborted! Targeted check found ${activeOnExchange.length} active position(s) for ${this.config.symbol}. Re-adopting into ledger.`
                );
                this.reconcileStartupPositions(activeOnExchange);
                this.syncSabPositionState(0);
                return;
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              console.error(
                `[TWO_PHASE_BARRIER][NETWORK_ERROR] [${this.config.symbol}] Targeted position check failed on network error: ${errorMessage}. Aborting state sync to protect active position.`
              );
              return; // Strict Anti-Blind-Wipe Invariant: Never assume position is flat on network failure
            }
          }

          if (summary.longQuantity > 1e-6) {
            console.log(`[StrategyEngine][StateSync] [${this.config.symbol}:CORE_LONG] Reconciling closed position via exchange state sync.`);
            await this.reconcileFlatPositionWithUserTrades("LONG", 0);
          }
          if (summary.shortQuantity > 1e-6) {
            console.log(`[StrategyEngine][StateSync] [${this.config.symbol}:SHORT_SLOTS] Reconciling closed short positions via exchange state sync.`);
            await this.reconcileFlatPositionWithUserTrades("SHORT", 0);
          }
        }

        console.log(`[StrategyEngine][StateSync] Binance position state: FLAT (0.0000) for ${this.config.symbol} (Leverage: ${this.config.leverageMultiplier}x).`);
        this.syncSabPositionState(0);
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
          } catch (slErr: unknown) {
            const errorMessage = slErr instanceof Error ? slErr.message : String(slErr);
            console.error(
              `[ORPHAN_GUARD][ERROR] Failed to dispatch live STOP_MARKET order to Binance for ${this.config.symbol} ${posSide}: ${errorMessage}`
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
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[StrategyEngine][StateSync][ERROR] Failed to sync exchange state for ${this.config.symbol}: ${errorMessage}`);
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
        this.executionClient.getDualPositionRisk(this.config.symbol),
        this.executionClient.getOpenOrders(this.config.symbol),
      ]);

      await this.syncExchangeStateWithData(positions, openOrders);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[StrategyEngine][StateSync][ERROR] Failed to sync exchange state for ${this.config.symbol}: ${errorMessage}`);
    }
  }

  public reconcileStartupPositions(rawPositions: BinancePositionRisk[]): void {
    if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
      console.log(`[StrategyEngine][StateRecovery] No active positions returned from Binance REST API for ${this.config.symbol}.`);
      return;
    }

    const matchingPosWithLev = rawPositions.find(
      (p) => p.symbol === this.config.symbol && parseFloat(p.leverage || "0") > 0
    );
    if (matchingPosWithLev) {
      const liveLev = parseFloat(matchingPosWithLev.leverage);
      this.setLeverageMultiplier(liveLev);
    }

    const recovered: { side: "LONG" | "SHORT"; quantity: number; entryPrice: number; originalOpenTime?: number }[] = [];

    for (const pos of rawPositions) {
      if (pos.symbol !== this.config.symbol) continue;

      const amt = parseFloat(pos.positionAmt || "0");
      const entryPx = parseFloat(pos.entryPrice || "0");
      if (Math.abs(amt) <= 0 || entryPx <= 0) continue;

      const side: "LONG" | "SHORT" =
        pos.positionSide === "LONG" || (pos.positionSide === "BOTH" && amt > 0) ? "LONG" : "SHORT";

      // Binance REST /fapi/v2/positionRisk returns `updateTime` (Unix ms) — the last time this position
      // was opened or modified. Used to restore CAD-DTLM position age across restarts.
      const originalOpenTime = pos.updateTime && pos.updateTime > 0 ? pos.updateTime : 0;

      recovered.push({
        side,
        quantity: Math.abs(amt),
        entryPrice: entryPx,
        originalOpenTime,
      });
    }

    if (recovered.length > 0) {
      this.hedgeLedger.syncStartupPositions(
        recovered,
        this.config.longTakeProfitPercent,
        this.config.longStopLossPercent,
        this.config.shortTakeProfitPercent,
        this.config.shortStopLossPercent,
        this.config.leverageMultiplier
      );
      console.log(
        `[StrategyEngine][StateRecovery] Successfully recovered ${recovered.length} open position(s) from Binance REST API for ${this.config.symbol} at ${this.config.leverageMultiplier}x leverage.`
      );
    } else {
      console.log(`[StrategyEngine][StateRecovery] Binance position state: FLAT (0.0000) for ${this.config.symbol} at ${this.config.leverageMultiplier}x leverage.`);
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
      const symbol = this.config.symbol;
      if (this.riskGuard.isSymbolHalted(symbol)) {
        const seq = this.client.getSequenceNum(this.assetIndex);
        this.staticResult.sequenceNum = seq;
        this.staticResult.signalType = "NONE";
        this.staticResult.riskResult = {
          passed: false,
          reasonCode: "CIRCUIT_BREAKER_ACTIVE",
          message: `Trading halted: Symbol ${symbol} circuit breaker active (${this.riskGuard.getConsecutiveLosses(symbol)} consecutive losses).`,
        };
        this.staticResult.executionPromise = undefined;
        return this.staticResult; // STRICT CIRCUIT BREAKER
      }

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
      const nowMs = Date.now();
      const obi = this.client.getOBI(this.assetIndex);
      const cvd = this.client.getCVDVelocity(this.assetIndex, 5000, nowMs);
      const spreadVelocity = this.client.getSpreadVelocity(this.assetIndex);
      const bidPrice = this.client.getBestBidPrice(this.assetIndex);
      const askPrice = this.client.getBestAskPrice(this.assetIndex);

      // WEBSOCKET FRESHNESS & STALENESS GUARD (750ms Hard Staleness Barrier)
      const packetTimestampNs = this.client.getTimestampNs(this.assetIndex);
      const packetAgeMs = packetTimestampNs > 0n ? Number((BigInt(nowMs) * 1000000n - packetTimestampNs) / 1000000n) : 0;
      const isStale = packetTimestampNs > 0n && packetAgeMs > 750;

      // SPREAD & TICK GUARD: Immediately reject invalid tick data, stale orderbooks, or spread blowouts BEFORE evaluating dynamic exits or signals
      const isTickValid = askPrice > 0 && bidPrice > 0 && askPrice >= bidPrice;
      const currentSpread = isTickValid ? askPrice - bidPrice : Infinity;
      const currentMidPrice = isTickValid ? (bidPrice + askPrice) * 0.5 : 0;

      let maxSpreadAllowed: number;
      if (this.config.symbol.includes("BTC")) {
        // Strict BTC Hard Cap: Min($1.50, max(0.10, currentMidPrice * 1.5 bps))
        maxSpreadAllowed = Math.min(this.config.maxSpreadBtc, Math.max(0.10, currentMidPrice * 0.00015));
      } else if (this.config.symbol.includes("ETH")) {
        // Strict ETH Hard Cap: Min($0.40, max(0.01, currentMidPrice * 2.0 bps))
        maxSpreadAllowed = Math.min(this.config.maxSpreadEth, Math.max(0.01, currentMidPrice * 0.00020));
      } else {
        // Strict Altcoins Hard Cap: Min(maxSpreadAlt, max(0.0001, currentMidPrice * 5.0 bps))
        maxSpreadAllowed = Math.min(this.config.maxSpreadAlt, Math.max(0.0001, currentMidPrice * 0.00050));
      }

      if (!isTickValid || isStale || currentSpread > maxSpreadAllowed) {
        const reasonCode: RiskCheckResult["reasonCode"] = !isTickValid
          ? "INVALID_TICK_DATA"
          : isStale
          ? "REJECTED_STALE_ORDERBOOK"
          : "REJECTED_MAX_SPREAD_BLOWOUT";

        const message = !isTickValid
          ? `Tick evaluation rejected: invalid tick prices (bid: ${bidPrice}, ask: ${askPrice})`
          : isStale
          ? `Tick evaluation rejected: stale orderbook data (Packet latency: ${packetAgeMs.toFixed(0)}ms > 750ms threshold)`
          : `Tick evaluation rejected: current spread (${currentSpread.toFixed(4)} USDT / ${currentMidPrice > 0 ? ((currentSpread / currentMidPrice) * 10000).toFixed(1) : "0"} bps) > ${maxSpreadAllowed.toFixed(4)} USDT threshold (SPREAD BLOWOUT)`;

        if (seq % 500n === 0n || !isTickValid || isStale) {
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

      // Read AI predictions & latency metrics from SAB (Sanitized for NaN & magnitude non-negativity)
      const rawDir = this.client.getAIPredictionDirection(this.assetIndex);
      const rawConf = this.client.getAIPredictionConfidence(this.assetIndex);
      const aiDirection = Number.isFinite(rawDir) ? rawDir : 0.0;
      const rawAiConfidence = Number.isFinite(rawConf) ? Math.max(0.0, Math.min(1.0, rawConf)) : 0.0;

      // Wire exact calibrated Platt-scaled AI confidence from SAB directly to StrategyEngine & SignalGate
      const aiConfidence = rawAiConfidence;

      const aiDirectionMag = Math.abs(aiDirection);
      const latencyPenalty = this.client.getLatencyPenaltyCoefficient(this.assetIndex);
      const penaltyCoeff = latencyPenalty > 0 ? Math.max(0.75, latencyPenalty) : 1.0;

      // 1. Dynamic Monitoring: Evaluate Microstructure, Volatility & Dynamic Exit Boundaries
      const markPrice = askPrice > 0 ? (askPrice + bidPrice) / 2 : bidPrice;

      // Feed live orderbook & price ticks into SOTA microstructure & volatility engines
      const bestBidQty = this.client.getBestBidQuantity(this.assetIndex);
      const bestAskQty = this.client.getBestAskQuantity(this.assetIndex);
      this.hazardEngine.updateOrderBook(bidPrice, bestBidQty, askPrice, bestAskQty);
      this.volEngine.updatePrice(markPrice);

      const summary = this.hedgeLedger.getSummary(markPrice > 0 ? markPrice : 0);
      const activePosSide: "LONG" | "SHORT" = summary.side === "SHORT" ? "SHORT" : "LONG";
      let holdingDurationMs = 0;
      const coreLong = this.hedgeLedger.getCoreLong();
      const coreLongDuration = coreLong.isOccupied && coreLong.openTime > 0 ? Math.max(0, nowMs - coreLong.openTime) : 0;
      let shortDuration = 0;
      const shortSlots = this.hedgeLedger.getShortSlots();
      for (const slot of shortSlots) {
        if (slot.isOccupied && slot.openTime > 0) {
          const dur = Math.max(0, nowMs - slot.openTime);
          if (dur > shortDuration) shortDuration = dur;
        }
      }
      holdingDurationMs = Math.max(coreLongDuration, shortDuration);

      const hazardMetrics = this.hazardEngine.getHazardMetrics(activePosSide, aiConfidence, holdingDurationMs);
      const volMetrics = this.volEngine.getVolatilitySurfaceMetrics();

      const signedInventory = summary.netQuantity;
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
      let dynamicSlPx = 0;
      if (this.hedgeLedger.getCoreLong().isOccupied && this.hedgeLedger.getCoreLong().quantity > 0) {
        dynamicSlPx = this.hedgeLedger.getCoreLong().stopLossPrice;
      } else {
        for (const s of this.hedgeLedger.getShortSlots()) {
          if (s.isOccupied && s.quantity > 0 && s.stopLossPrice > 0) {
            dynamicSlPx = s.stopLossPrice;
            break;
          }
        }
      }
      if (dynamicSlPx === 0 && hasActivePos) {
        dynamicSlPx = summary.side === "LONG"
          ? summary.averageEntryPrice * (1.0 - this.config.longStopLossPercent / 100)
          : summary.averageEntryPrice * (1.0 + this.config.shortStopLossPercent / 100);
      }
      this.client.setDynamicStopLossPrice(dynamicSlPx, this.assetIndex);

      // Sync active position state to SharedArrayBuffer for TUI Table telemetry
      if (hasActivePos && markPrice > 0 && nowMs - this.lastSabSyncTs >= 100) {
        this.lastSabSyncTs = nowMs;
        this.syncSabPositionState(markPrice);
      }

      if (markPrice > 0) {
        const hurstExponent = this.client.getHurstExponent(this.assetIndex);
        // Priority 1: Evaluate SOTA Dynamic Exits (MS-SOPC, CAD-DTLM, Cox Hazard Survival Flush, HJB Liquidation Boundary)
        const sotaTriggers = hasActivePos
          ? this.hedgeLedger.evaluateSotaDynamicExits(
              bidPrice,
              askPrice,
              hazardMetrics,
              this.hjbEngine,
              volMetrics,
              Date.now(),
              hurstExponent
            )
          : [];

        // Priority 2: Evaluate Hedge Slot Dynamic TP/SL Fallback (Fixed/Trailing TP/SL, Profit Lock)
        const hawkesIntensity = this.client.getHawkesIntensity(this.assetIndex);
        const hedgeTriggers = (hasActivePos && sotaTriggers.length === 0)
          ? this.hedgeLedger.evaluateHedgeDynamicTpSl(
              markPrice,
              aiDirection,
              aiConfidence,
              hazardMetrics.vpin,
              hawkesIntensity,
              volMetrics.garmanKlass1s,
              hazardMetrics.ofi,
              Date.now()
            )
          : [];

        const activeTriggers = sotaTriggers.length > 0 ? sotaTriggers : hedgeTriggers;

        if (hasActivePos) {
          // Closed-Loop Zero-Naked Invariant Audit: Verify 100% of aggregated active positions are protected by resting exchange-native SL
          this.auditActivePositionRiskClosedLoop();

          // Check for Stop-Loss Ratchet Shifts that require Exchange-Native STOP_MARKET cancel-replace sync
          if (activeTriggers.length === 0) {
            const aggLong = this.hedgeLedger.getAggregatedSideSummary("LONG");
            if (aggLong.isOccupied && aggLong.totalQuantity > 0 && aggLong.stopLossPrice > 0) {
              const coreLong = this.hedgeLedger.getCoreLong();
              if (coreLong.lastSyncedSlPrice === undefined || coreLong.lastSyncedSlPrice === 0 || aggLong.stopLossPrice > coreLong.lastSyncedSlPrice) {
                this.syncExchangeStopLossOrder("CORE_LONG", aggLong.totalQuantity, "LONG", aggLong.stopLossPrice).catch((err: unknown) => {
                  console.error(`[EXCHANGE_SL_ENGINE][SYNC_ERR] Core Long SL ratchet sync failed: ${err instanceof Error ? err.message : String(err)}`);
                });
              }
            }
            const aggShort = this.hedgeLedger.getAggregatedSideSummary("SHORT");
            if (aggShort.isOccupied && aggShort.totalQuantity > 0 && aggShort.stopLossPrice > 0) {
              const primarySlotId = aggShort.slotIds[0] || "SHORT_SLOT_0";
              let needsSync = false;
              for (const s of this.hedgeLedger.getShortSlots()) {
                if (s.isOccupied && s.quantity > 0) {
                  if (s.lastSyncedSlPrice === undefined || s.lastSyncedSlPrice === 0 || aggShort.stopLossPrice < s.lastSyncedSlPrice) {
                    needsSync = true;
                    break;
                  }
                }
              }
              if (needsSync) {
                this.syncExchangeStopLossOrder(primarySlotId, aggShort.totalQuantity, "SHORT", aggShort.stopLossPrice).catch((err: unknown) => {
                  console.error(`[EXCHANGE_SL_ENGINE][SYNC_ERR] Aggregated Short SL ratchet sync failed: ${err instanceof Error ? err.message : String(err)}`);
                });
              }
            }
          }
        }

        if (activeTriggers.length > 0) {
          const primaryTrigger = activeTriggers[0];
          const exitSide: "BUY" | "SELL" = primaryTrigger.side === "LONG" ? "SELL" : "BUY";
          const sameSideTriggers = activeTriggers.filter((t) => t.side === primaryTrigger.side);
          const isMultiSlotExit = sameSideTriggers.length > 1 && !primaryTrigger.isPartialClose;
          const totalExitQty = isMultiSlotExit
            ? sameSideTriggers.reduce((sum, t) => sum + t.quantity, 0)
            : primaryTrigger.quantity;
          const formattedExitQty = SymbolPrecisionRegistry.formatQuantity(this.config.symbol, totalExitQty);

          const allCancelOrderIds: number[] = [];
          for (const t of sameSideTriggers) {
            if (t.cancelOrderIds && t.cancelOrderIds.length > 0) {
              for (const cid of t.cancelOrderIds) {
                if (!allCancelOrderIds.includes(cid)) allCancelOrderIds.push(cid);
              }
            }
          }

          const isHardStopTrigger =
            primaryTrigger.reason.includes("HAZARD") ||
            primaryTrigger.reason.includes("HJB") ||
            primaryTrigger.reason.includes("MS_SOPC") ||
            primaryTrigger.reason.includes("MVA_TS") ||
            primaryTrigger.reason === "STOP_LOSS" ||
            primaryTrigger.reason === "BREAK_EVEN_STOP_LOSS" ||
            primaryTrigger.reason === "LONG_HOLD_PROFIT_HARVEST" ||
            primaryTrigger.reason === "CAD_TERMINAL_HORIZON_KILL" ||
            primaryTrigger.reason === "TIME_DECAY_PROFIT_LOCK";

          console.log(
            `[HEDGE_DYNAMIC_MONITORING] Slot ${primaryTrigger.slotId} ${primaryTrigger.reason} TRIGGERED! Side: ${primaryTrigger.side}, Executing aggregated exit qty: ${formattedExitQty}, Mark: $${markPrice.toFixed(2)}. Dispatching MARKET close with positionSide: ${primaryTrigger.side}.${isHardStopTrigger ? " [RUTHLESS HARD STOP OVERRIDE ACTIVE]" : ""}`
          );

          this.prepareOrderIntent(
            exitSide,
            formattedExitQty,
            markPrice,
            primaryTrigger.side,
            true,
            isHardStopTrigger
          );

          const isConfigured = this.executionClient.isConfigured();
          const riskResult = (this.riskGuard instanceof MultiAssetRiskGuard)
            ? (this.riskGuard as MultiAssetRiskGuard).validateMultiAssetOrder(this.reusableOrderIntent, isConfigured)
            : this.riskGuard.validateOrder(
                this.reusableOrderIntent,
                isConfigured,
                primaryTrigger.side
              );

          let executionPromise: Promise<BinanceOrderResponse | null> | undefined = undefined;
          if (riskResult.passed) {
            this.isOrderInFlight = true;
            executionPromise = (async () => {
              if (allCancelOrderIds.length > 0) {
                console.log(
                  `[MAKER_TP_ENGINE][EMERGENCY_CANCEL] Cancelling ${allCancelOrderIds.length} open POST_ONLY limit TP orders before MARKET SL dispatch...`
                );
                try {
                  await this.executionClient.cancelBatchOrders(this.config.symbol, allCancelOrderIds);
                  console.log(`[MAKER_TP_ENGINE][EMERGENCY_CANCEL] Batch order cancellation confirmed by exchange.`);
                } catch (err: unknown) {
                  console.warn(`[MAKER_TP_ENGINE][CANCEL_WARN] Batch order cancellation warning: ${err instanceof Error ? err.message : String(err)}`);
                }
              }

              const exitCid = ClientOrderIdGenerator.generate(this.config.symbol, primaryTrigger.slotId, "EM");
              return this.executionClient
                .placeOrder({
                  symbol: this.config.symbol,
                  side: exitSide,
                  type: "MARKET",
                  quantity: formattedExitQty,
                  positionSide: primaryTrigger.side,
                  clientOrderId: exitCid,
                })
                .then((res) => {
                  if (res) {
                    const execPx = parseFloat(res.price || res.avgPrice || "0") || markPrice;
                    const takerFeeRate = this.hedgeLedger.getSizingCalculator().getTakerFeeRate();

                    // Capture ledger PnL BEFORE deduct/release
                    const pnlBefore = this.hedgeLedger.getCumulativeRealizedPnl();

                    for (const trig of sameSideTriggers) {
                      if (trig.isPartialClose && trig.quantity > 0) {
                        if (trig.side === "LONG") {
                          this.hedgeLedger.deductCoreLongQuantity(trig.quantity, execPx, takerFeeRate, trig.reason);
                        } else if (trig.slotId.startsWith("SHORT_SLOT_")) {
                          const sIdx = parseInt(trig.slotId.replace("SHORT_SLOT_", ""), 10);
                          this.hedgeLedger.deductShortSlotQuantity(sIdx, trig.quantity, execPx, takerFeeRate, trig.reason);
                        }
                      } else if (!trig.isPartialClose) {
                        if (trig.side === "LONG") {
                          this.hedgeLedger.releaseCoreLong(execPx, takerFeeRate, trig.reason);
                        } else if (trig.slotId.startsWith("SHORT_SLOT_")) {
                          const sIdx = parseInt(trig.slotId.replace("SHORT_SLOT_", ""), 10);
                          this.hedgeLedger.releaseShortSlot(sIdx, execPx, takerFeeRate, trig.reason);
                        }
                      }
                    }

                    // Delta = exactly what recordRealizedExit recorded
                    const realizedPnl = this.hedgeLedger.getCumulativeRealizedPnl() - pnlBefore;

                    // Dual-tier cooldown & risk sync for dynamic MARKET exit executions
                    this.onExecutionCompleted({
                      symbol: this.config.symbol,
                      assetIndex: this.assetIndex,
                      side: exitSide,
                      positionSide: primaryTrigger.side,
                      isCloseOrder: true,
                      executedQty: formattedExitQty,
                      executedPrice: execPx,
                      realizedPnl,
                      fillTimestampMs: Date.now(),
                    });
                  }
                  return res;
                })
                .catch((err: unknown) => {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  console.error(`[DYNAMIC_MONITORING_ERROR] Hedge ${primaryTrigger.reason} MARKET order failed: ${errMsg}`);
                  if (
                    errMsg.includes("-2022") ||
                    errMsg.includes("ReduceOnly") ||
                    errMsg.includes("-2011") ||
                    errMsg.includes("not configured")
                  ) {
                    console.warn(
                      `[DYNAMIC_MONITORING_WARN] Reconciling local slot ${primaryTrigger.slotId} with exchange trades due to error: ${errMsg}`
                    );
                    // Do NOT prematurely wipe slot! Directly trigger double-entry reconciliation
                    this.reconcileFlatPositionWithUserTrades(primaryTrigger.side, 0);
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
            positionSide: primaryTrigger.side,
            slotId: primaryTrigger.slotId,
            obi,
            cvd,
            spreadVelocity,
            bidPrice,
            askPrice,
            riskResult,
            executionPromise,
            exitReason: primaryTrigger.reason,
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

      // Read Hawkes & Microburst & Microstructure Metrics from SAB (Slots 112, 114, 119, 120, 121, 123, 124)
      const hawkesIntensity = this.client.getHawkesIntensity(this.assetIndex);
      const realizedVol = this.client.getRealizedVolatility(this.assetIndex);
      const rawShortCooldownLock = this.client.getShortCooldownLock(this.assetIndex);
      const rawLongCooldownLock = this.client.getLongCooldownLock(this.assetIndex);
      const hurstExponent = this.client.getHurstExponent(this.assetIndex);
      const lobEntropy = this.client.getLOBEntropy(this.assetIndex);
      const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
      // Defensive ceiling guard: allow up to 30 min (1,800,000ms) for consecutive loss circuit breaker halts
      const longCooldownLock = rawLongCooldownLock > nowMs + 1800000 ? 0 : rawLongCooldownLock;
      const shortCooldownLock = rawShortCooldownLock > nowMs + 1800000 ? 0 : rawShortCooldownLock;

      let targetSizeDecayCoeff = 1.0;

      // Dynamic Environment Ingestion (Zero-Hardcoding Protocol)
      const minNetAlpha = this.hedgeLedger.getSizingCalculator().getMinNetAlpha();
      const makerFeeRate = this.hedgeLedger.getSizingCalculator().getMakerFeeRate();
      const takerFeeRate = this.hedgeLedger.getSizingCalculator().getTakerFeeRate();

      const midPrice = askPrice > 0 && bidPrice > 0 && Number.isFinite(askPrice) && Number.isFinite(bidPrice)
        ? (bidPrice + askPrice) / 2.0
        : 1.0;

      const rawHalfSpread = midPrice > 0 && askPrice >= bidPrice && Number.isFinite(askPrice) && Number.isFinite(bidPrice)
        ? (askPrice - bidPrice) / (2.0 * midPrice)
        : 0.0001;
      const halfSpreadBps = Number.isFinite(rawHalfSpread) && rawHalfSpread >= 0 ? rawHalfSpread : 0.0001;

      const safeGarmanKlass = Number.isFinite(garmanKlassRV) && garmanKlassRV > 0.000001 ? garmanKlassRV : 0;
      const volEstimate = safeGarmanKlass > 0 ? Math.sqrt(safeGarmanKlass) : 0.005;

      const safeHawkes = Number.isFinite(hawkesIntensity) && hawkesIntensity > 0 ? hawkesIntensity : 0;
      const hawkesMultiplier = 1.0 + 0.15 * Math.log(1.0 + safeHawkes);

      // SOTA Alpha-to-Friction Barrier Model (August 2026)
      // E[alpha] = |aiDirection| * volEstimate * sqrt(horizon_s) * hawkesMultiplier
      // Total Friction = 2 * MakerFee + HalfSpread + SlippageEst
      const horizonSec = 5.0;
      const expectedAlpha = aiDirectionMag * volEstimate * Math.sqrt(horizonSec / 60.0) * hawkesMultiplier;
      const estimatedSlippage = (spreadVelocity > 0 ? Math.min(0.0002, (spreadVelocity / 50.0) * 0.0001) : 0.0);
      const totalFrictionBarrier = (2.0 * makerFeeRate) + halfSpreadBps + estimatedSlippage;
      const expectedNetAlpha = expectedAlpha - totalFrictionBarrier;

      // SOTA Volatility, Toxicity & Drawdown Adjusted Dynamic Conviction Floor (theta_conf)
      // Strict base confidence constraint locked to exactly 0.653 (65.3%)
      const baseMinConfidence = this.config.minAiConfidence;
      let effectiveMinConfidence = baseMinConfidence;
      const sessionPnl = this.riskGuard.getCumulativeDailyRealizedPnl();
      const isDrawdown = sessionPnl < -5.0; // Enforce drawdown penalty only on significant drawdowns (> $5)

      // Dynamic Regime Conviction: Modulate confidence with bounded proportional scaling rather than rigid +800 bps spikes
      if (volEstimate < 0.0015) {
        effectiveMinConfidence = Math.min(0.75, effectiveMinConfidence + 0.02);
      } else if (hurstExponent > 0.55 && safeGarmanKlass > 0.001) {
        // Strong trend regime: allow frictionless capture down to base floor
        effectiveMinConfidence = Math.max(baseMinConfidence, effectiveMinConfidence - 0.02);
      }

      // Microstructure Toxicity Surcharge: Scaled proportionally with VPIN severity
      const vpinVal = this.client.getVPIN(this.assetIndex);
      if (vpinVal >= 0.90) {
        effectiveMinConfidence = Math.min(0.75, effectiveMinConfidence + 0.03);
      }

      // Drawdown Surcharge: Apply moderate protection during deep drawdown
      if (isDrawdown) {
        effectiveMinConfidence = Math.min(0.75, effectiveMinConfidence + 0.03);
      }

      // Strict bounding around base conviction floor
      effectiveMinConfidence = Math.min(0.85, Math.max(baseMinConfidence, effectiveMinConfidence));

      // SOTA August 2026 4-Factor Multi-Variate Composite Signal Engine
      const obiScore = Math.max(-1.0, Math.min(1.0, obi));
      const cvdVelocity = cvd;
      const cvdScore = Math.max(-1.0, Math.min(1.0, cvdVelocity));
      const aiScore = Math.max(-1.0, Math.min(1.0, aiDirection * aiConfidence));
      const ofiScore = Math.max(-1.0, Math.min(1.0, hazardMetrics.ofi));

      // SOTA Continuous 4-Factor Alpha Fusion: 50% AI Direction*Conf, 20% LOB OBI, 15% Rolling CVD Velocity, 15% Multi-Level OFI
      const compositeScore = 0.50 * aiScore + 0.20 * obiScore + 0.15 * cvdScore + 0.15 * ofiScore;

      const isHighConfidenceAi = aiConfidence >= Math.max(this.config.aggressiveConfidenceThreshold, effectiveMinConfidence);

      // Volatility-Standardized Z-Score of the signal
      const safeVol = Number.isFinite(volEstimate) && volEstimate >= 0.0001 ? volEstimate : 0.005;
      const rawZScore = aiDirectionMag / safeVol;
      const zScore = Number.isFinite(rawZScore) ? rawZScore : 0.0;

      // Dynamic Conviction Authorization: Require Alpha-to-Friction Barrier clearance AND Z-Score >= 1.5 (2.0 during drawdown)
      const minZScoreThreshold = isDrawdown ? 2.0 : 1.5;
      const isAlphaFrictionPassed = expectedNetAlpha >= minNetAlpha;
      const isConvictionValid = isAlphaFrictionPassed && zScore >= minZScoreThreshold && aiConfidence >= effectiveMinConfidence;

      // SOTA August 2026: Adaptive Sigmoidal Confidence-Relaxation Gating (ASCRG)
      const baseObiMagnitude = Math.abs(this.config.obiBuyThreshold || 0.20);
      const maxOpposingObi = 0.45; // Strict toxic wall / liquidity sweep trap guard

      // Continuous confidence relaxation: kappa = 2.5
      // When AI Confidence increases beyond effective minimum confidence floor, the required directional OBI threshold (0.20)
      // dynamically relaxes towards 0.0 (neutral), allowing pre-breakdown entry without chasing swept books.
      const confExcess = Math.max(0.0, (aiConfidence - effectiveMinConfidence) / Math.max(0.01, 1.0 - effectiveMinConfidence));
      const requiredObiThreshold = baseObiMagnitude * (1.0 - 2.5 * Math.tanh(confExcess));

      // Symmetrical Favorable OBI directional verification with toxic opposing wall protection:
      // BUY: Requires obi >= +requiredObiThreshold AND obi > -maxOpposingObi
      // SELL: Requires obi <= -requiredObiThreshold AND obi < +maxOpposingObi
      const isObiFavorableBuy = obi >= requiredObiThreshold && obi > -maxOpposingObi;
      const isObiFavorableSell = obi <= -requiredObiThreshold && obi < maxOpposingObi;

      let isBuySignal = false;
      let isSellSignal = false;

      if (isConvictionValid) {
        if (isHighConfidenceAi) {
          // SOTA ASCRG High-Confidence AI Rule (>70%): Dynamic OBI relaxation allows execution in neutral/pre-breakdown books
          isBuySignal = aiDirection > 0 && isObiFavorableBuy;
          isSellSignal = aiDirection < 0 && isObiFavorableSell;
        } else {
          // SOTA Composite Gating Rule: Multi-variate composite score with dynamic thresholding
          isBuySignal = compositeScore > 0.15 && isObiFavorableBuy;
          isSellSignal = compositeScore < -0.15 && isObiFavorableSell;
        }
      } else if (seq % 1000n === 0n) {
        const netAlphaBps = (expectedNetAlpha * 10000).toFixed(1);
        const hurdleBps = (minNetAlpha * 10000).toFixed(1);
        const confPct = (aiConfidence * 100).toFixed(1);
        const floorPct = (effectiveMinConfidence * 100).toFixed(1);
        const alphaOp = isAlphaFrictionPassed ? ">=" : "<";
        const confOp = aiConfidence >= effectiveMinConfidence ? ">=" : "<";
        const zOp = zScore >= minZScoreThreshold ? ">=" : "<";

        console.log(
          `[StrategyEngine][${this.config.symbol}][CONVICTION_FLOOR_GATE] Seq #${seq} | Dir: ${aiDirection.toFixed(4)} ` +
          `(NetAlpha: ${netAlphaBps} bps ${alphaOp} Hurdle: ${hurdleBps} bps [${isAlphaFrictionPassed ? "PASS" : "FAIL"}], ` +
          `Conf: ${confPct}% ${confOp} Floor: ${floorPct}% [${aiConfidence >= effectiveMinConfidence ? "PASS" : "FAIL"}], ` +
          `Z: ${zScore.toFixed(2)} ${zOp} ${minZScoreThreshold.toFixed(1)} [${zScore >= minZScoreThreshold ? "PASS" : "FAIL"}]) -> Signals Filtered`
        );
      }

      // SOTA Phase 4: Microstructure Chop & LOB Entropy Regime Filter
      // Extreme Mean-Reverting Noise Chop (H < 0.30 and S_LOB > 0.90 for AI, or H < 0.45 and S_LOB > 0.85 for composite)
      const isChopRegime = isHighConfidenceAi
        ? (hurstExponent < 0.30 && lobEntropy > 0.90)
        : (hurstExponent < 0.45 && lobEntropy > 0.85);

      // Restrict low-conviction directional entries to verified trend regimes ONLY (H >= 0.55, S_LOB <= 0.75, Hawkes <= 2.0)
      const isVerifiedTrendRegime = hurstExponent >= 0.55 && lobEntropy <= 0.75 && safeHawkes <= 2.0;

      if (isChopRegime) {
        if (seq % 1000n === 0n || (isBuySignal || isSellSignal)) {
          console.log(
            `[StrategyEngine][${this.config.symbol}][REJECTED_CHOP_REGIME] Seq #${seq} | Directional signal filtered: Severe Noise Chop (H: ${hurstExponent.toFixed(3)}, S_LOB: ${lobEntropy.toFixed(3)}).`
          );
        }
        isBuySignal = false;
        isSellSignal = false;
      } else if (!isVerifiedTrendRegime && !isHighConfidenceAi) {
        if (seq % 1000n === 0n && (isBuySignal || isSellSignal)) {
          console.log(
            `[StrategyEngine][${this.config.symbol}][TREND_REGIME_GATE] Seq #${seq} | Directional entry restricted: Not a verified trend regime (H: ${hurstExponent.toFixed(3)} [req >= 0.55], S_LOB: ${lobEntropy.toFixed(3)} [req <= 0.75], Hawkes: ${safeHawkes.toFixed(3)} [req <= 2.0]).`
          );
        }
        isBuySignal = false;
        isSellSignal = false;
      }

      // BUY -> Core Long Entry (allowed if Core Long is FLAT, not PENDING_ENTRY, & temporal cooldown expired)
      const coreLongSlot = this.hedgeLedger.getCoreLong();
      const isCoreLongOccupied = coreLongSlot.isOccupied || coreLongSlot.lifecycleState === "PENDING_ENTRY";
      const hasPendingCoreLong = this.hasPendingEntryForSlot("CORE_LONG");
      const isCooldownCleared = nowMs >= longCooldownLock;

      if (!isCoreLongOccupied && !hasPendingCoreLong && !isCooldownCleared && seq % 10000n === 0n) {
        console.log(`[StrategyEngine][${this.config.symbol}][COOLDOWN_BLOCK] Seq #${seq} | nowMs: ${nowMs}, longCooldownLock: ${longCooldownLock}, diff: ${longCooldownLock - nowMs}ms`);
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
        if (seq % 10000n === 0n) {
          console.log(`[StrategyEngine][${this.config.symbol}][ACTIONABLE_SIGNAL] Seq #${seq} | BUY CORE_LONG | Dir: ${aiDirection.toFixed(4)} (NetAlpha: ${(expectedNetAlpha * 10000).toFixed(1)} bps), Conf: ${(aiConfidence * 100).toFixed(1)}%, OBI: ${obi.toFixed(4)}`);
        }
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
            if (seq % 10000n === 0n) {
              console.log(`[StrategyEngine][${this.config.symbol}][ACTIONABLE_SIGNAL] Seq #${seq} | SELL ${slotId} | Dir: ${aiDirection.toFixed(4)} (NetAlpha: ${(expectedNetAlpha * 10000).toFixed(1)} bps), Conf: ${(aiConfidence * 100).toFixed(1)}%, OBI: ${obi.toFixed(4)}`);
            }
          }
        }
      }

      if (signalType === "NONE") {
        if (seq % 10000n === 0n) {
          console.log(
            `[StrategyEngine][${this.config.symbol}][SignalGate] Seq #${seq} | Composite: ${compositeScore.toFixed(4)} | AI: (dir=${aiDirection.toFixed(2)}, conf=${(aiConfidence * 100).toFixed(0)}%) | OBI: ${obi.toFixed(2)} | CVD: ${(cvd >= 0 ? "+" : "") + cvd.toFixed(4)} | Status: NO SIGNAL TRIGGERED`
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

      const basePrice = signalType === "BUY" ? askPrice : bidPrice;

      // 100% SOTA Maker-Dominant Execution Architecture (POST_ONLY GTX Order Routing)
      // Completely eradicates MARKET/IOC taker fee dispatches for entry signals.
      // Forces limit orders directly on the order book at best bid (BUY) and best ask (SELL), guaranteeing zero spread loss & Maker fee execution.
      let orderType: "LIMIT" | "MARKET" = "LIMIT";
      const timeInForce: "GTC" | "IOC" | "GTX" = "GTX";
      let targetPrice: number = signalType === "BUY" ? bidPrice : askPrice;

      // SOTA August 2026 Alpha-Gated Dynamic Kelly Recovery Sizing (AG-DKRS)
      let finalQuantity = 0.001;
      if (basePrice > 0) {
        const baseNotional = this.config.tradeSizeUsdt > 0 ? this.config.tradeSizeUsdt : 60.0;
        const maxDailyLoss = this.riskGuard.getConfig().maxDailyLossUsdt;
        const sizingRes = this.hedgeLedger.getSizingCalculator().calculateAlphaGatedRecoverySize(
          baseNotional,
          sessionPnl,
          maxDailyLoss,
          aiConfidence,
          zScore,
          hurstExponent
        );
        let targetNotionalUsdt = sizingRes.targetNotionalUsdt;

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
        hurst: hurstExponent,
        lobEntropy: lobEntropy,
        regime: this.client.getRegimeStateCode(this.assetIndex),
        isSweepDetected: this.client.getIsSweepDetected(this.assetIndex),
      };

      const riskProfile = this.dynamicRiskEngine.evaluateDynamicRisk(
        targetPrice,
        targetPosSide === "LONG" ? "LONG" : "SHORT",
        microMetrics,
        Math.abs(askPrice - bidPrice),
        isDrawdown
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
          console.log(`[StrategyEngine][${this.config.symbol}][RISK_REJECTED] Seq #${seq} | Reason: ${riskResult.reasonCode} - ${riskResult.message}`);
        }
      } else {
        finalizedSignalVal = signalType === "BUY" ? 1.0 : signalType === "SELL" ? 2.0 : 0.0;
      }

      let executionPromise: Promise<BinanceOrderResponse | null> | undefined = undefined;

      if (riskResult.passed) {
        const entrySlotId = targetPosSide === "LONG" ? "CORE_LONG" : `SHORT_SLOT_${targetSlotIndex !== undefined ? targetSlotIndex : 0}`;
        const targetSlot = targetPosSide === "LONG" ? this.hedgeLedger.getCoreLong() : (targetSlotIndex !== undefined ? this.hedgeLedger.getShortSlots()[targetSlotIndex] : undefined);
        if (!targetSlot || targetSlot.isOccupied || targetSlot.lifecycleState === "PENDING_ENTRY") {
          if (seq % 1000n === 0n) {
            console.warn(`[OPTIMISTIC_MUTEX][BLOCKED] [${this.config.symbol}:${entrySlotId}] Slot is already occupied or pending entry. Aborting duplicate order dispatch.`);
          }
          this.staticResult.sequenceNum = seq;
          this.staticResult.signalType = "NONE";
          this.staticResult.riskResult = undefined;
          this.staticResult.executionPromise = undefined;
          return this.staticResult;
        }

        const entryCid = ClientOrderIdGenerator.generate(this.config.symbol, entrySlotId, "EN");

        // 1. Synchronously reserve slot in HedgePositionLedger (Optimistic Mutex Lock)
        let isReserved = false;
        if (targetPosSide === "LONG") {
          isReserved = this.hedgeLedger.reserveCoreLongPending(entryCid, targetPrice, finalQuantity);
        } else if (targetPosSide === "SHORT" && targetSlotIndex !== undefined) {
          isReserved = this.hedgeLedger.reserveShortSlotPending(targetSlotIndex, entryCid, targetPrice, finalQuantity);
        }

        if (!isReserved) {
          if (seq % 1000n === 0n) {
            console.warn(`[OPTIMISTIC_MUTEX][BLOCKED] [${this.config.symbol}:${entrySlotId}] Slot is already occupied or pending entry. Aborting duplicate order dispatch.`);
          }
          this.staticResult.sequenceNum = seq;
          this.staticResult.signalType = "NONE";
          this.staticResult.riskResult = undefined;
          this.staticResult.executionPromise = undefined;
          return this.staticResult;
        }

        this.isOrderInFlight = true;

        // 2. Synchronously pre-register in pendingEntryOrders with clientOrderId
        const preFlightKey = -Math.abs(Date.now());
        this.pendingEntryOrders.set(preFlightKey, {
          slotId: entrySlotId,
          posSide: targetPosSide!,
          slotIndex: targetSlotIndex,
          qty: finalQuantity,
          targetPrice,
          clientOrderId: entryCid,
        });

        // Set atomic SAB hysteresis lockout (cooldown per side) to suppress microburst sweeps
        if (targetPosSide === "SHORT") {
          this.client.setShortCooldownLock(Date.now() + this.config.cooldownMs, this.assetIndex);
          this.client.setLastShortFillPrice(this.reusableOrderIntent.price, this.assetIndex);
        } else if (targetPosSide === "LONG") {
          this.client.setLongCooldownLock(Date.now() + this.config.cooldownMs, this.assetIndex);
          this.client.setLastLongFillPrice(this.reusableOrderIntent.price, this.assetIndex);
        }

        console.log(`[BinanceExecution][DISPATCHING] [${this.config.symbol}:${entrySlotId}] Submitting ${orderType} ${this.reusableOrderIntent.side} order for ${this.reusableOrderIntent.quantity} ${this.reusableOrderIntent.symbol} (ClId: ${entryCid}) to Binance Futures...`);

        const orderParams: BinanceOrderParams = {
          symbol: this.reusableOrderIntent.symbol,
          side: this.reusableOrderIntent.side,
          type: orderType,
          quantity: this.reusableOrderIntent.quantity,
          positionSide: targetPosSide,
          clientOrderId: entryCid,
        };

        if (orderType === "LIMIT") {
          orderParams.price = this.reusableOrderIntent.price;
          orderParams.timeInForce = timeInForce;
        }

        executionPromise = this.executionClient
          .placeOrder(orderParams)
          .then((res) => {
            // Remove preflight temporary pending key
            this.pendingEntryOrders.delete(preFlightKey);

            if (res) {
              const execPx = parseFloat(res.price || res.avgPrice || "0") || targetPrice;
              const executedQty = parseFloat(res.executedQty || "0");
              const isFilled = res.status === "FILLED" || executedQty > 0;
              const isPending = res.status === "NEW";

              const numericOrderId = res.orderId ? (typeof res.orderId === "number" ? res.orderId : parseInt(String(res.orderId), 10)) : 0;
              const resCid = res.clientOrderId || entryCid;

              console.log(`[BinanceExecution][RESPONSE] [${this.config.symbol}:${entrySlotId}] OrderId: ${res.orderId}, ClId: ${resCid}, Status: ${res.status}, ExecQty: ${executedQty}, Price: ${execPx}`);

              if ((numericOrderId > 0 && this.processedFillOrderIds.has(numericOrderId)) || (resCid && this.processedFillClientOrderIds.has(resCid))) {
                console.log(`[BinanceExecution][REST_FILL_ALREADY_PROCESSED] OrderId #${numericOrderId} (ClId: ${resCid}) already reconciled via WebSocket. Skipping redundant slot occupation.`);
                return res;
              }

              if (isFilled) {
                if (numericOrderId > 0) this.processedFillOrderIds.add(numericOrderId);
                if (resCid) this.processedFillClientOrderIds.add(resCid);

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
                const volEstimate = (Number.isFinite(garmanKlassRV) && garmanKlassRV > 0.000001) ? Math.sqrt(garmanKlassRV) : 0.005;
                const baseSlPercent = targetPosSide === "LONG" ? this.config.longStopLossPercent : this.config.shortStopLossPercent;
                const dynamicSlPercent = Math.max(baseSlPercent, Math.max(1.00, volEstimate * 3.50 * 100));
                const dynamicTpPercent = dynamicSlPercent * 2.50;

                if (targetPosSide === "LONG") {
                  this.hedgeLedger.occupyCoreLong(finalQuantity, execPx, dynamicTpPercent, dynamicSlPercent, false);
                  const aggLong = this.hedgeLedger.getAggregatedSideSummary("LONG");

                  // Atomic TP Replacement: Cancel previous resting TP limit orders to prevent stale sub-lots
                  this.cancelRestingTpOrders("CORE_LONG").then(() => {
                    return this.dispatchAggregatedBatchPostOnlyTpOrders("CORE_LONG", aggLong.vwapEntryPrice, aggLong.totalQuantity, "LONG");
                  }).catch((err: unknown) => {
                    console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err instanceof Error ? err.message : String(err)}`);
                  });

                  // Position-Level Stop Loss: Submits native STOP_MARKET with closePosition=true covering 100% of aggregated position
                  this.syncExchangeStopLossOrder("CORE_LONG", aggLong.totalQuantity, "LONG", aggLong.stopLossPrice).catch((err: unknown) => {
                    console.error(`[EXCHANGE_SL_ENGINE][UNHANDLED_DISPATCH_ERR] ${err instanceof Error ? err.message : String(err)}`);
                  });
                } else if (targetPosSide === "SHORT" && targetSlotIndex !== undefined) {
                  const slotId = `SHORT_SLOT_${targetSlotIndex}`;
                  this.hedgeLedger.occupyShortSlot(targetSlotIndex, finalQuantity, execPx, dynamicTpPercent, dynamicSlPercent, false);
                  const aggShort = this.hedgeLedger.getAggregatedSideSummary("SHORT");

                  // Atomic TP Replacement: Cancel all existing resting TP limit orders across short slots
                  Promise.all(aggShort.slotIds.map((slId) => this.cancelRestingTpOrders(slId))).then(() => {
                    return this.dispatchAggregatedBatchPostOnlyTpOrders(slotId, aggShort.vwapEntryPrice, aggShort.totalQuantity, "SHORT");
                  }).catch((err: unknown) => {
                    console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err instanceof Error ? err.message : String(err)}`);
                  });

                  // Position-Level Stop Loss: Submits native STOP_MARKET with closePosition=true covering 100% of aggregated position
                  this.syncExchangeStopLossOrder(slotId, aggShort.totalQuantity, "SHORT", aggShort.stopLossPrice).catch((err: unknown) => {
                    console.error(`[EXCHANGE_SL_ENGINE][UNHANDLED_DISPATCH_ERR] ${err instanceof Error ? err.message : String(err)}`);
                  });
                }
              } else if (isPending && res.orderId) {
                // Pending Limit / Post-Only Order placed on Binance orderbook
                const numericOrderId = typeof res.orderId === "number" ? res.orderId : parseInt(String(res.orderId), 10);
                if (!isNaN(numericOrderId)) {
                  const fallbackTimer = setTimeout(async () => {
                    if (this.pendingEntryOrders.has(numericOrderId)) {
                      console.log(`[BinanceExecution][PENDING_FALLBACK_CHECK] Auditing pending OrderId #${numericOrderId} for ${this.config.symbol}...`);
                      try {
                        const orderCheck = await this.executionClient.getOrder(this.config.symbol, numericOrderId);
                        // Race Condition Defense: Verify order wasn't already filled by WebSocket during the getOrder await
                        if (!this.pendingEntryOrders.has(numericOrderId)) {
                          return;
                        }
                        if (orderCheck && (orderCheck.status === "FILLED" || parseFloat(orderCheck.executedQty || "0") > 0)) {
                          const execQty = parseFloat(orderCheck.executedQty || "0") || finalQuantity;
                          const execPx = parseFloat(orderCheck.avgPrice || orderCheck.price || "0") || targetPrice;
                          console.log(`[BinanceExecution][FALLBACK_FILL_CONFIRMED] OrderId #${numericOrderId} confirmed FILLED via REST audit!`);
                          this.handleConfirmedEntryFill(numericOrderId, targetSlotId!, targetPosSide!, targetSlotIndex, execQty, execPx);
                        } else if (orderCheck && (orderCheck.status === "CANCELED" || orderCheck.status === "EXPIRED" || orderCheck.status === "REJECTED")) {
                          console.warn(`[BinanceExecution][FALLBACK_CLEANUP] OrderId #${numericOrderId} was ${orderCheck.status}. Removing from pending and rolling back slot.`);
                          this.pendingEntryOrders.delete(numericOrderId);
                          this.hedgeLedger.rollbackPendingSlot(entrySlotId, `ORDER_${orderCheck.status}`);
                        }
                      } catch (err: unknown) {
                        if (this.pendingEntryOrders.has(numericOrderId)) {
                          const errMsg = err instanceof Error ? err.message : String(err);
                          console.error(`[BinanceExecution][FALLBACK_AUDIT_ERROR] Failed to audit order #${numericOrderId}: ${errMsg}`);
                          this.syncExchangeState().catch((syncErr: unknown) => {
                            console.error(`[BinanceExecution][FALLBACK_SYNC_ERROR] ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
                          });
                        }
                      }
                    }
                  }, 2500);

                  this.pendingEntryOrders.set(numericOrderId, {
                    slotId: targetSlotId!,
                    posSide: targetPosSide!,
                    slotIndex: targetSlotIndex,
                    qty: finalQuantity,
                    targetPrice: execPx,
                    clientOrderId: entryCid,
                    timeoutTimer: fallbackTimer,
                  });
                  console.log(`[BinanceExecution][PENDING_FILL] Registered pending entry OrderId #${numericOrderId} for slot ${targetSlotId}. Slot reserved in PENDING_ENTRY (2.5s fallback active).`);
                }
              } else {
                console.warn(`[BinanceExecution][UNFILLED_ORDER] Order placement returned status "${res.status}". Rolling back slot ${entrySlotId} to FLAT.`);
                this.hedgeLedger.rollbackPendingSlot(entrySlotId, `STATUS_${res.status}`);
              }
            }
            return res;
          })
          .catch((err) => {
            console.error(`[BinanceExecution][REJECTED] Order Placement Failed: ${err.message}`);
            this.pendingEntryOrders.delete(preFlightKey);
            this.hedgeLedger.rollbackPendingSlot(entrySlotId, `REJECTED_${err.message}`);
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
    } catch (err: unknown) {
      finalizedSignalVal = 0.0;
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[ENGINE_EVALUATE_TICK_ERROR][Asset #${this.assetIndex}] Exception in evaluateTick: ${errorMessage}`);
      this.staticResult.sequenceNum = this.lastProcessedSequence;
      this.staticResult.signalType = "NONE";
      this.staticResult.riskResult = {
        passed: false,
        reasonCode: "CRITICAL_EVALUATION_EXCEPTION",
        message: errorMessage || "Unhandled exception during tick evaluation",
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

