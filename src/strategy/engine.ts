import { MarketDataClient } from "../marketDataClient";
import { RiskGuard, MultiAssetRiskGuard, OrderIntent, RiskCheckResult } from "./risk";
import { BinanceExecutionClient, BinanceOrderResponse, BinanceOrderParams, BinancePositionRisk } from "../execution/binance";
import { PositionLedger, HedgePositionLedger, MultiAssetPositionLedger, PositionSlot, SlotExitTrigger, ActiveTradeSlot } from "./positionLedger";
import { DynamicRiskEngine, DynamicMicrostructureMetrics } from "./dynamicRiskEngine";
import { BinanceUserDataStream, OrderTradeUpdatePayload } from "../execution/userDataStream";

export interface StrategyConfig {
  symbol: string;
  orderQuantity: number;
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
  minNotionalUsdt: number;
  cooldownMs: number;
  vpinThreshold: number;
  vpinBucketVolume: number;
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
  private userDataStream: BinanceUserDataStream | null = null;
  private lastProcessedSequence: bigint = -1n;
  private state: EngineState = "LIVE_ACTIVE";

  private reusableOrderIntent: OrderIntent = {
    symbol: process.env.SYMBOL ?? "BTCUSDT",
    side: "BUY",
    quantity: 0.001,
    price: 0,
  };

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
    const envMinNotionalUsdt = process.env.MIN_NOTIONAL_USDT ? parseFloat(process.env.MIN_NOTIONAL_USDT) : NaN;
    const envCooldownMs = process.env.COOLDOWN_MS ? parseInt(process.env.COOLDOWN_MS, 10) : NaN;
    const envVpinThreshold = process.env.VPIN_THRESHOLD ? parseFloat(process.env.VPIN_THRESHOLD) : NaN;
    const envVpinBucketVolume = process.env.VPIN_BUCKET_VOLUME ? parseFloat(process.env.VPIN_BUCKET_VOLUME) : NaN;

    const defaultLongTp = !isNaN(envLongTp) ? envLongTp : 0.45;
    const defaultLongSl = !isNaN(envLongSl) ? envLongSl : 0.15;
    const defaultShortTp = !isNaN(envShortTp) ? envShortTp : 0.45;
    const defaultShortSl = !isNaN(envShortSl) ? envShortSl : 0.15;
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
    const defaultMaxSpreadBtc = !isNaN(envMaxSpreadBtc) ? envMaxSpreadBtc : 5.0;
    const defaultMinNotionalUsdt = !isNaN(envMinNotionalUsdt) ? envMinNotionalUsdt : 55.0;
    const defaultCooldownMs = !isNaN(envCooldownMs) ? envCooldownMs : 250;
    const defaultVpinThreshold = !isNaN(envVpinThreshold) ? envVpinThreshold : 0.85;
    const defaultVpinBucketVolume = !isNaN(envVpinBucketVolume) ? envVpinBucketVolume : 50000.0;
    const targetSymbol = config?.symbol ?? process.env.SYMBOL ?? "BTCUSDT";
    const defaultOrderQty = !isNaN(envOrderQty)
      ? envOrderQty
      : (targetSymbol.includes("ETH") ? 0.05 : 0.001);
    const defaultLeverage = !isNaN(envLeverage) ? envLeverage : 10;

    this.config = {
      symbol: targetSymbol,
      orderQuantity: config?.orderQuantity ?? defaultOrderQty,
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
      minNotionalUsdt: config?.minNotionalUsdt ?? defaultMinNotionalUsdt,
      cooldownMs: config?.cooldownMs ?? defaultCooldownMs,
      vpinThreshold: config?.vpinThreshold ?? defaultVpinThreshold,
      vpinBucketVolume: config?.vpinBucketVolume ?? defaultVpinBucketVolume,
    };

    this.dynamicRiskEngine = new DynamicRiskEngine(this.config.vpinThreshold);

    this.hedgeLedger = hedgeLedger ?? new HedgePositionLedger(this.config.symbol, this.config.maxShortSlots);
    this.positionLedger = positionLedger ?? this.hedgeLedger.getLegacyLedger();
    this.reusableOrderIntent.symbol = this.config.symbol;
    this.reusableOrderIntent.quantity = this.config.orderQuantity;
  }

  public async initUserDataStream(): Promise<boolean> {
    if (!this.executionClient.isConfigured()) return false;
    this.userDataStream = new BinanceUserDataStream(this.executionClient);

    this.userDataStream.subscribeOrderUpdates((update: OrderTradeUpdatePayload) => {
      const { order } = update;
      if (order.orderStatus === "FILLED" || order.orderStatus === "PARTIALLY_FILLED") {
        if (order.orderType === "LIMIT" || order.isMaker) {
          console.log(`[MAKER_TP_ENGINE][WS_FILL_NOTIFIED] OrderId #${order.orderId} filled as ${order.isMaker ? "MAKER" : "TAKER"}. Qty: ${order.lastFilledQuantity} @ $${order.lastFilledPrice}`);

          const coreLong = this.hedgeLedger.getCoreLong();
          const shortSlots = this.hedgeLedger.getShortSlots();

          let targetSlotId: string | null = null;
          if (coreLong.isOccupied && coreLong.activeTpOrderIds?.includes(order.orderId)) {
            targetSlotId = "CORE_LONG";
          } else {
            for (const s of shortSlots) {
              if (s.isOccupied && s.activeTpOrderIds?.includes(order.orderId)) {
                targetSlotId = s.slotId;
                break;
              }
            }
          }

          if (targetSlotId) {
            const res = this.hedgeLedger.processTpLimitFill(targetSlotId, order.orderId, order.lastFilledQuantity, order.lastFilledPrice, order.isMaker);
            console.log(`[MAKER_TP_ENGINE][RECONCILED] Slot ${targetSlotId} updated. Closed: ${res.isPositionClosed}, RemQty: ${res.remainingQuantity}, NewSL: $${res.newStopLossPrice}`);
          }
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
    const isPostOnlyTpEnabled = process.env.ENABLE_POST_ONLY_TP !== "false";
    if (!isPostOnlyTpEnabled) return;

    const intents = this.hedgeLedger.generateBatchTpOrderIntents(slotId, entryPrice, quantity, side);
    if (intents.length === 0) return;

    console.log(`[MAKER_TP_ENGINE][DISPATCHING] Submitting ${intents.length} POST_ONLY limit TP orders for ${slotId} via batchOrders...`);
    try {
      const resList = await this.executionClient.placeBatchOrders(intents);
      if (Array.isArray(resList) && resList.length > 0) {
        const orderIds = resList
          .map((r) => r.orderId)
          .filter((id) => typeof id === "number" || typeof id === "string");
        this.hedgeLedger.registerActiveTpOrderIds(slotId, orderIds as any[]);
        console.log(`[MAKER_TP_ENGINE][SUCCESS] Registered ${orderIds.length} POST_ONLY TP limit order IDs on Binance orderbook: [${orderIds.join(", ")}]`);
      }
    } catch (err: any) {
      console.error(`[MAKER_TP_ENGINE][ERROR] Failed to submit batch POST_ONLY TP orders: ${err.message}`);
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
  }

  /**
   * High-frequency tick evaluation loop.
   * Reads scalar metrics directly from SharedArrayBuffer via MarketDataClient getters.
   * Zero GC heap allocation when no trade signals are generated.
   */
  public evaluateTick(): StrategySignalResult {
    const seq = this.client.getSequenceNum();

    if (seq === this.lastProcessedSequence) {
      this.staticResult.sequenceNum = seq;
      this.staticResult.signalType = "NONE";
      return this.staticResult;
    }
    this.lastProcessedSequence = seq;

    // Read scalar metrics atomically from SAB
    const obi = this.client.getOBI();
    const cvd = this.client.getCVD();
    const spreadVelocity = this.client.getSpreadVelocity();
    const bidPrice = this.client.getBestBidPrice();
    const askPrice = this.client.getBestAskPrice();

    // Read AI predictions & latency metrics from SAB
    const aiDirection = this.client.getAIPredictionDirection();
    const aiConfidence = this.client.getAIPredictionConfidence();
    const latencyPenalty = this.client.getLatencyPenaltyCoefficient();
    const penaltyCoeff = latencyPenalty > 0 ? Math.max(0.75, latencyPenalty) : 1.0;
    const slippageTicks = this.client.getDynamicSlippageTicks();

    // 1. Dynamic Monitoring: Evaluate Unrealized PnL against dynamic TP/SL thresholds across Hedge Slots
    const markPrice = askPrice > 0 ? (askPrice + bidPrice) / 2 : bidPrice;
    if (markPrice > 0) {
      const hedgeTriggers = this.hedgeLedger.evaluateHedgeDynamicTpSl(markPrice);
      if (hedgeTriggers.length > 0) {
        const trigger = hedgeTriggers[0];
        const exitSide: "BUY" | "SELL" = trigger.side === "LONG" ? "SELL" : "BUY";
        const isHardStopTrigger =
          trigger.reason === "STOP_LOSS" ||
          trigger.reason === "BREAK_EVEN_STOP_LOSS" ||
          trigger.reason === "LONG_HOLD_PROFIT_HARVEST" ||
          trigger.reason === "TIME_DECAY_PROFIT_LOCK";

        console.log(
          `[HEDGE_DYNAMIC_MONITORING] Slot ${trigger.slotId} ${trigger.reason} TRIGGERED! Side: ${trigger.side}, Entry: $${trigger.entryPrice.toFixed(
            2
          )}, Mark: $${markPrice.toFixed(2)}. Dispatching MARKET close with positionSide: ${trigger.side}.${isHardStopTrigger ? " [RUTHLESS HARD STOP OVERRIDE ACTIVE]" : ""}`
        );

        this.reusableOrderIntent.symbol = this.config.symbol;
        this.reusableOrderIntent.side = exitSide;
        this.reusableOrderIntent.quantity = trigger.quantity;
        this.reusableOrderIntent.price = markPrice;
        this.reusableOrderIntent.currentPositionSide = trigger.side;
        this.reusableOrderIntent.isCloseOrder = true;
        this.reusableOrderIntent.isHardStop = isHardStopTrigger;

        const isConfigured = this.executionClient.isConfigured();
        const riskResult = this.riskGuard.validateOrder(
          this.reusableOrderIntent,
          isConfigured,
          trigger.side
        );

        let executionPromise: Promise<BinanceOrderResponse | null> | undefined = undefined;
        if (riskResult.passed) {
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
                  if (trigger.isPartialClose && trigger.quantity > 0) {
                    if (trigger.side === "LONG") {
                      this.hedgeLedger.deductCoreLongQuantity(trigger.quantity);
                    } else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                      const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                      this.hedgeLedger.deductShortSlotQuantity(sIdx, trigger.quantity);
                    }
                  } else if (!trigger.isPartialClose) {
                    if (trigger.side === "LONG") {
                      this.hedgeLedger.releaseCoreLong();
                    } else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                      const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                      this.hedgeLedger.releaseShortSlot(sIdx);
                    }
                  }
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
          })();
        }

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
    const hawkesIntensity = this.client.getHawkesIntensity();
    const realizedVol = this.client.getRealizedVolatility();
    const rawShortCooldownLock = this.client.getShortCooldownLock();
    const rawLongCooldownLock = this.client.getLongCooldownLock();
    const hurstExponent = this.client.getHurstExponent();
    const garmanKlassRV = this.client.getGarmanKlassRV();

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

    if (isHighConfidenceAi) {
      // AI-Override Rule: High-confidence AI must also satisfy strict OBI directional pressure threshold (+/- 0.35)
      isBuySignal = aiDirection > 0 && obi >= this.config.obiBuyThreshold;
      isSellSignal = aiDirection < 0 && obi <= this.config.obiSellThreshold;
      if (isBuySignal || isSellSignal) {
        console.log(`[StrategyEngine][HIGH_CONFIDENCE] Seq #${seq} | Dir: ${aiDirection.toFixed(4)}, Conf: ${(aiConfidence * 100).toFixed(1)}%, OBI: ${obi.toFixed(4)}, BuySignal: ${isBuySignal}, SellSignal: ${isSellSignal}`);
      }
    } else {
      // Weighted Composite Rule with dynamic effective confidence thresholding
      isBuySignal = compositeScore > 0.12 && aiConfidence >= effectiveMinConfidence && obi >= this.config.obiBuyThreshold;
      isSellSignal = compositeScore < -0.12 && aiConfidence >= effectiveMinConfidence && obi <= this.config.obiSellThreshold;
    }

    // BUY -> Core Long Entry (allowed if Core Long is FLAT & temporal cooldown expired)
    const isCoreLongOccupied = this.hedgeLedger.getCoreLong().isOccupied;
    const isCooldownCleared = nowMs >= longCooldownLock;

    if (!isCoreLongOccupied && !isCooldownCleared) {
      console.log(`[StrategyEngine][COOLDOWN_BLOCK] Seq #${seq} | nowMs: ${nowMs}, longCooldownLock: ${longCooldownLock}, diff: ${longCooldownLock - nowMs}ms`);
    }

    if (
      isBuySignal &&
      (isHighConfidenceAi || spreadVelocity < this.config.maxSpreadVelocity) &&
      askPrice > 0 &&
      !isCoreLongOccupied &&
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
        signalType = "SELL";
        targetPosSide = "SHORT";
        targetSlotIndex = slotEval.slotIndex;
        targetSlotId = `SHORT_SLOT_${slotEval.slotIndex}`;
        targetSizeDecayCoeff = slotEval.sizeDecayCoeff;
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

    // Apply latency penalty & slot-index decay coefficients to orderQuantity BEFORE RiskGuard check
    const scaledQuantity = Number((this.config.orderQuantity * penaltyCoeff * targetSizeDecayCoeff).toFixed(3));
    let finalQuantity = Math.max(0.001, scaledQuantity);

    // Dynamic Taker Fallback (>75% Confidence) & 1-Tick Post-Only Offset (<=75%)
    const effectiveSlippage = Math.max(2, slippageTicks);
    const priceAdjustment = effectiveSlippage * this.config.tickSize;
    const basePrice = signalType === "BUY" ? askPrice : bidPrice;

    const isHighConfidence = aiConfidence >= this.config.aggressiveConfidenceThreshold;
    const isAggressive = isHighConfidence;

    let targetPrice: number;
    let orderType: "LIMIT" | "MARKET";
    let timeInForce: "GTC" | "IOC" | "GTX";

    if (isHighConfidence) {
      orderType = "MARKET";
      timeInForce = "IOC";
      targetPrice = signalType === "BUY" ? askPrice + priceAdjustment : bidPrice - priceAdjustment;
    } else {
      orderType = "LIMIT";
      timeInForce = "GTX";
      targetPrice = signalType === "BUY" ? bidPrice : askPrice;
    }

    // SPREAD GUARD: Explicitly block MARKET executions if spread is invalid or exceeds configured max threshold
    const isTickValid = askPrice > 0 && bidPrice > 0 && askPrice >= bidPrice;
    const currentSpread = isTickValid ? askPrice - bidPrice : Infinity;
    const maxSpreadAllowed = this.config.symbol.includes("ETH") ? this.config.maxSpreadEth : this.config.maxSpreadBtc;
    if (
      orderType === "MARKET" &&
      currentSpread > maxSpreadAllowed &&
      !this.reusableOrderIntent.isCloseOrder &&
      !this.reusableOrderIntent.isHardStop
    ) {
      const reasonCode = !isTickValid ? "INVALID_TICK_DATA" : "REJECTED_LIQUIDITY_SWEEP_TRAP";
      const message = !isTickValid
        ? `Market execution blocked: invalid tick prices (bid: ${bidPrice}, ask: ${askPrice})`
        : `Market execution blocked: current spread (${currentSpread.toFixed(2)} USDT) > ${maxSpreadAllowed.toFixed(2)} USDT threshold`;

      console.log(`[StrategyEngine][SPREAD_GUARD_BLOCK] Seq #${seq} | ${message}`);
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

    // Avellaneda-Stoikov Inventory Shift: Skew sell target higher for deeper short slots
    if (signalType === "SELL" && targetSlotIndex !== undefined && targetSlotIndex > 0) {
      targetPrice = targetPrice + targetSlotIndex * 2.0 * this.config.tickSize;
    }

    // Binance Futures Min Notional Guard: ensure order notional >= minNotionalUsdt
    if (basePrice > 0) {
      const minNotionalUsdt = this.config.minNotionalUsdt;
      if (finalQuantity * basePrice < minNotionalUsdt) {
        finalQuantity = Number((minNotionalUsdt / basePrice).toFixed(3));
      }
    }

    // Evaluate Dynamic Risk & Microstructure Trap Avoidance Profile
    const microMetrics: DynamicMicrostructureMetrics = {
      obi,
      cvd,
      rvGk: this.client.getGarmanKlassRV(),
      vpin: this.client.getVPIN(),
      hurst: this.client.getHurstExponent(),
      lobEntropy: this.client.getLOBEntropy(),
      regime: this.client.getRegimeStateCode(),
      isSweepDetected: this.client.getIsSweepDetected(),
    };

    const riskProfile = this.dynamicRiskEngine.evaluateDynamicRisk(
      basePrice,
      targetPosSide === "LONG" ? "LONG" : "SHORT",
      microMetrics,
      Math.abs(askPrice - bidPrice)
    );
    riskProfile.isHighConfidenceAi = isHighConfidenceAi;
    riskProfile.aiConfidence = aiConfidence;

    // Populate pre-allocated intent
    this.reusableOrderIntent.symbol = this.config.symbol;
    this.reusableOrderIntent.side = signalType;
    this.reusableOrderIntent.quantity = finalQuantity;
    this.reusableOrderIntent.price = Number(targetPrice.toFixed(2));
    this.reusableOrderIntent.currentPositionSide = targetPosSide;
    this.reusableOrderIntent.isCloseOrder = false;
    this.reusableOrderIntent.riskProfile = riskProfile;
    this.reusableOrderIntent.stopLossPrice = riskProfile.stopLossPrice;
    this.reusableOrderIntent.takeProfitPrice = riskProfile.takeProfitPrice;

    // Pass through Risk Management Guard with target position side
    const isConfigured = this.executionClient.isConfigured();
    const riskResult = this.riskGuard.validateOrder(
      this.reusableOrderIntent,
      isConfigured,
      targetPosSide
    );

    if (!riskResult.passed) {
      if (seq % 1000n === 0n) {
        console.log(`[StrategyEngine][RISK_REJECTED] Seq #${seq} | Reason: ${riskResult.reasonCode} - ${riskResult.message}`);
      }
    }

    let executionPromise: Promise<BinanceOrderResponse | null> | undefined = undefined;

    if (riskResult.passed) {
      // Set atomic SAB hysteresis lockout (cooldown per side) to suppress microburst sweeps
      if (targetPosSide === "SHORT") {
        this.client.setShortCooldownLock(Date.now() + this.config.cooldownMs);
        this.client.setLastShortFillPrice(this.reusableOrderIntent.price);
      } else if (targetPosSide === "LONG") {
        this.client.setLongCooldownLock(Date.now() + this.config.cooldownMs);
        this.client.setLastLongFillPrice(this.reusableOrderIntent.price);
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
            this.riskGuard.recordExecutionSuccess(notional);
            console.log(`[BinanceExecution][SUCCESS] Order Executed on Binance! OrderId: ${res.orderId}, Status: ${res.status}, ExecQty: ${res.executedQty}`);
            const execPx = parseFloat(res.price || res.avgPrice || "0") || targetPrice;
            if (targetPosSide === "LONG") {
              this.hedgeLedger.occupyCoreLong(finalQuantity, execPx, this.config.longTakeProfitPercent, this.config.longStopLossPercent);
              this.dispatchBatchPostOnlyTpOrders("CORE_LONG", execPx, finalQuantity, "LONG");
            } else if (targetPosSide === "SHORT" && targetSlotIndex !== undefined) {
              const slotId = `SHORT_SLOT_${targetSlotIndex}`;
              this.hedgeLedger.occupyShortSlot(targetSlotIndex, finalQuantity, execPx, this.config.shortTakeProfitPercent, this.config.shortStopLossPercent);
              this.dispatchBatchPostOnlyTpOrders(slotId, execPx, finalQuantity, "SHORT");
            }
          }
          return res;
        })
        .catch((err) => {
          console.error(`[BinanceExecution][REJECTED] Order Placement Failed: ${err.message}`);
          throw err;
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
  }

  public getConfig(): Readonly<StrategyConfig> {
    return this.config;
  }
}

export interface MultiAssetSignalBatch {
  timestamp: number;
  signals: Array<{
    assetIndex: number;
    symbol: string;
    signalType: "NONE" | "BUY" | "SELL";
    confidence: number;
    obi: number;
    cvd: number;
    hurst: number;
    isApproved: boolean;
    rejectReason?: string;
  }>;
}

export class MultiAssetStrategyEngine {
  private client: MarketDataClient;
  private riskGuard: MultiAssetRiskGuard;
  private executionClient: BinanceExecutionClient;
  private positionLedger: MultiAssetPositionLedger;
  private activeSymbols: string[];
  private symbolIndexMap: Map<string, number> = new Map();

  constructor(
    client: MarketDataClient,
    riskGuard: MultiAssetRiskGuard,
    executionClient: BinanceExecutionClient,
    activeSymbols: string[] = ["ETHUSDT", "BTCUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT"],
    positionLedger?: MultiAssetPositionLedger
  ) {
    this.client = client;
    this.riskGuard = riskGuard;
    this.executionClient = executionClient;
    this.activeSymbols = activeSymbols;
    this.positionLedger = positionLedger ?? new MultiAssetPositionLedger(activeSymbols);
    this.rebuildSymbolIndexMap();
  }

  public updateActiveSymbols(symbols: string[]): void {
    if (symbols && symbols.length > 0) {
      this.activeSymbols = symbols.slice(0, 10);
      this.rebuildSymbolIndexMap();
    }
  }

  private rebuildSymbolIndexMap(): void {
    this.symbolIndexMap.clear();
    for (let i = 0; i < this.activeSymbols.length; i++) {
      const sym = this.activeSymbols[i];
      if (sym) {
        this.symbolIndexMap.set(sym, i);
      }
    }
  }

  public getAssetIndex(symbol: string): number {
    const idx = this.symbolIndexMap.get(symbol);
    return idx !== undefined ? idx : -1;
  }

  public getActiveSymbols(): ReadonlyArray<string> {
    return this.activeSymbols;
  }

  public evaluateMultiAssetTick(): MultiAssetSignalBatch {
    const timestamp = Date.now();
    const signals: MultiAssetSignalBatch["signals"] = [];

    for (let i = 0; i < this.activeSymbols.length; i++) {
      const symbol = this.activeSymbols[i];
      if (!symbol) continue;

      const assetIdx = this.getAssetIndex(symbol);
      if (assetIdx < 0 || assetIdx >= this.client.maxAssets) continue;

      const obi = this.client.getOBI(assetIdx);
      const cvd = this.client.getCVD(assetIdx);
      const hurst = this.client.getHurst(assetIdx);
      const vpin = this.client.getVPIN(assetIdx);
      const hawkes = this.client.getHawkesIntensity(assetIdx);

      let signalType: "NONE" | "BUY" | "SELL" = "NONE";
      let confidence = 0;
      let isApproved = false;
      let rejectReason: string | undefined = undefined;

      if (vpin > 0.75) {
        rejectReason = "REJECTED_TOXIC_FLOW";
      } else if (hurst < 0.45) {
        rejectReason = "REJECTED_COUNTER_TREND_REGIME";
      } else if (obi >= 0.35 && cvd >= 0.0 && hawkes >= 0.5) {
        signalType = "BUY";
        confidence = Math.min(0.99, 0.5 + obi * 0.3 + (hurst - 0.45) * 0.5);
        isApproved = true;
      } else if (obi <= -0.35 && cvd <= 0.0 && hawkes >= 0.5) {
        signalType = "SELL";
        confidence = Math.min(0.99, 0.5 + Math.abs(obi) * 0.3 + (hurst - 0.45) * 0.5);
        isApproved = true;
      }

      signals.push({
        assetIndex: assetIdx,
        symbol,
        signalType,
        confidence,
        obi,
        cvd,
        hurst,
        isApproved,
        rejectReason,
      });
    }

    return {
      timestamp,
      signals,
    };
  }

  public getPositionLedger(): MultiAssetPositionLedger {
    return this.positionLedger;
  }

  public getRiskGuard(): MultiAssetRiskGuard {
    return this.riskGuard;
  }
}
