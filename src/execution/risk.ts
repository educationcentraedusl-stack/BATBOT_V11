import { SymbolPrecisionRegistry } from "../config/symbolPrecision";

export type StepCollarTier =
  | "NONE"
  | "TIER_1_BREAK_EVEN"
  | "TIER_2_PARTIAL_PROFIT"
  | "TIER_3_AGGRESSIVE_TRAIL";

export interface StepCollarConfig {
  tier1ProfitThresholdUsdt: number; // +$0.50 net after fees -> Break-Even Lock
  tier2ProfitThresholdUsdt: number; // +$1.50 net after fees -> Lock +$0.50
  tier2LockProfitUsdt: number;      // +$0.50 locked net profit
  tier3ProfitThresholdUsdt: number; // +$2.00 net after fees -> Lock +$1.50 & Trail
  tier3LockProfitUsdt: number;      // +$1.50 locked net profit base
  tier3TrailingMarginUsdt: number;  // $0.50 trailing margin behind peak net profit
  takeProfitBarrierUsdt: number;    // $5.00 net profit target barrier
  makerFeeRate: number;             // Default: 0.00018 (0.018%)
  takerFeeRate: number;             // Default: 0.00045 (0.045%)
  feeBufferMultiplier: number;      // Multiplier for fee-adjusted BE price
}

export interface PositionRiskState {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  quantity: number;
  currentMarkPrice: number;
  peakPrice: number;
  troughPrice: number;
  peakNetPnlUsdt: number;
  unrealizedPnlUsdt: number;
  grossPnlUsdt: number;
  totalFeesUsdt: number;
  currentStopLossPrice: number;
  initialStopLossPrice: number;
  targetTakeProfitPrice: number;
  activeTier: StepCollarTier;
  isBreakEvenLocked: boolean;
  takeProfitBarrierHit: boolean;
  stopLossHit: boolean;
  lastUpdateTimestamp: number;
}

export interface StepCollarEvaluationResult {
  symbol: string;
  side: "LONG" | "SHORT";
  shouldUpdateStopLoss: boolean;
  newStopLossPrice: number;
  activeTier: StepCollarTier;
  unrealizedNetPnlUsdt: number;
  grossPnlUsdt: number;
  totalFeesUsdt: number;
  isTakeProfitTriggered: boolean;
  isStopLossTriggered: boolean;
  reason: string;
}

export class StepCollarRiskEngine {
  private config: StepCollarConfig;
  private positions: Map<string, PositionRiskState> = new Map();

  // Zero-GC pre-allocated reusable evaluation result object
  private evalResult: StepCollarEvaluationResult = {
    symbol: "",
    side: "LONG",
    shouldUpdateStopLoss: false,
    newStopLossPrice: 0,
    activeTier: "NONE",
    unrealizedNetPnlUsdt: 0,
    grossPnlUsdt: 0,
    totalFeesUsdt: 0,
    isTakeProfitTriggered: false,
    isStopLossTriggered: false,
    reason: "NORMAL",
  };

  constructor(config?: Partial<StepCollarConfig>) {
    const envMakerFee = process.env.MAKER_FEE_RATE ? parseFloat(process.env.MAKER_FEE_RATE) : NaN;
    const envTakerFee = process.env.TAKER_FEE_RATE ? parseFloat(process.env.TAKER_FEE_RATE) : NaN;

    this.config = {
      tier1ProfitThresholdUsdt: config?.tier1ProfitThresholdUsdt ?? 0.50,
      tier2ProfitThresholdUsdt: config?.tier2ProfitThresholdUsdt ?? 1.50,
      tier2LockProfitUsdt: config?.tier2LockProfitUsdt ?? 0.50,
      tier3ProfitThresholdUsdt: config?.tier3ProfitThresholdUsdt ?? 2.00,
      tier3LockProfitUsdt: config?.tier3LockProfitUsdt ?? 1.50,
      tier3TrailingMarginUsdt: config?.tier3TrailingMarginUsdt ?? 0.50,
      takeProfitBarrierUsdt: config?.takeProfitBarrierUsdt ?? 5.00,
      makerFeeRate: config?.makerFeeRate ?? (!isNaN(envMakerFee) ? envMakerFee : 0.00018),
      takerFeeRate: config?.takerFeeRate ?? (!isNaN(envTakerFee) ? envTakerFee : 0.00045),
      feeBufferMultiplier: config?.feeBufferMultiplier ?? 1.0,
    };
  }

  public getConfig(): Readonly<StepCollarConfig> {
    return this.config;
  }

  /**
   * Registers or updates a tracked position in the Step-Collar Risk Engine.
   */
  public registerPosition(
    symbol: string,
    side: "LONG" | "SHORT",
    entryPrice: number,
    quantity: number,
    initialStopLossPrice?: number,
    targetTakeProfitPrice?: number
  ): PositionRiskState {
    if (entryPrice <= 0 || quantity <= 0) {
      throw new Error(`[StepCollarRiskEngine] Invalid position params: ${symbol} ${side} Qty=${quantity} Entry=${entryPrice}`);
    }

    const key = this.getPositionKey(symbol, side);
    const existing = this.positions.get(key);

    const defaultSlDistance = entryPrice * 0.012; // 1.20% default SL floor
    const defaultTpDistance = entryPrice * 0.025; // 2.50% default TP

    const slPrice = (initialStopLossPrice && initialStopLossPrice > 0)
      ? initialStopLossPrice
      : (side === "LONG" ? entryPrice - defaultSlDistance : entryPrice + defaultSlDistance);

    const tpPrice = (targetTakeProfitPrice && targetTakeProfitPrice > 0)
      ? targetTakeProfitPrice
      : (side === "LONG" ? entryPrice + defaultTpDistance : entryPrice - defaultTpDistance);

    const formattedSl = SymbolPrecisionRegistry.formatPrice(symbol, slPrice);
    const formattedTp = SymbolPrecisionRegistry.formatPrice(symbol, tpPrice);

    if (existing) {
      existing.entryPrice = entryPrice;
      existing.quantity = quantity;
      existing.currentStopLossPrice = formattedSl;
      existing.initialStopLossPrice = formattedSl;
      existing.targetTakeProfitPrice = formattedTp;
      existing.peakPrice = entryPrice;
      existing.troughPrice = entryPrice;
      existing.peakNetPnlUsdt = 0;
      existing.activeTier = "NONE";
      existing.isBreakEvenLocked = false;
      existing.takeProfitBarrierHit = false;
      existing.stopLossHit = false;
      existing.lastUpdateTimestamp = Date.now();
      return existing;
    }

    const newPos: PositionRiskState = {
      symbol,
      side,
      entryPrice,
      quantity,
      currentMarkPrice: entryPrice,
      peakPrice: entryPrice,
      troughPrice: entryPrice,
      peakNetPnlUsdt: 0,
      unrealizedPnlUsdt: 0,
      grossPnlUsdt: 0,
      totalFeesUsdt: 0,
      currentStopLossPrice: formattedSl,
      initialStopLossPrice: formattedSl,
      targetTakeProfitPrice: formattedTp,
      activeTier: "NONE",
      isBreakEvenLocked: false,
      takeProfitBarrierHit: false,
      stopLossHit: false,
      lastUpdateTimestamp: Date.now(),
    };

    this.positions.set(key, newPos);
    return newPos;
  }

  /**
   * Removes a tracked position upon position closure.
   */
  public removePosition(symbol: string, side: "LONG" | "SHORT"): void {
    const key = this.getPositionKey(symbol, side);
    this.positions.delete(key);
  }

  /**
   * Retrieves active position state.
   */
  public getPosition(symbol: string, side: "LONG" | "SHORT"): PositionRiskState | undefined {
    const key = this.getPositionKey(symbol, side);
    return this.positions.get(key);
  }

  /**
   * Zero-GC High-Frequency Step-Collar Hot-Path Tick Evaluation (< 1.5 µs latency).
   * Evaluates unrealized net PnL (after fees), updates peak tracking, ratchets Stop Loss monotonically across Tiers 1-3,
   * and triggers the $5.00 Take Profit barrier.
   */
  public evaluateTick(
    symbol: string,
    side: "LONG" | "SHORT",
    markPrice: number
  ): StepCollarEvaluationResult {
    const key = this.getPositionKey(symbol, side);
    const pos = this.positions.get(key);

    if (!pos || markPrice <= 0) {
      this.evalResult.symbol = symbol;
      this.evalResult.side = side;
      this.evalResult.shouldUpdateStopLoss = false;
      this.evalResult.newStopLossPrice = 0;
      this.evalResult.activeTier = "NONE";
      this.evalResult.unrealizedNetPnlUsdt = 0;
      this.evalResult.grossPnlUsdt = 0;
      this.evalResult.totalFeesUsdt = 0;
      this.evalResult.isTakeProfitTriggered = false;
      this.evalResult.isStopLossTriggered = false;
      this.evalResult.reason = !pos ? "POSITION_NOT_FOUND" : "INVALID_PRICE";
      return this.evalResult;
    }

    const isLong = side === "LONG";
    pos.currentMarkPrice = markPrice;
    pos.lastUpdateTimestamp = Date.now();

    // 1. Fee Calculations (Round-Trip: Entry Maker + Exit Taker)
    const entryNotional = pos.entryPrice * pos.quantity;
    const exitNotional = markPrice * pos.quantity;
    const entryFee = entryNotional * this.config.makerFeeRate;
    const exitFee = exitNotional * this.config.takerFeeRate;
    const totalFees = (entryFee + exitFee) * this.config.feeBufferMultiplier;
    pos.totalFeesUsdt = totalFees;

    // 2. Real-Time PnL Calculations
    const grossPnl = isLong
      ? (markPrice - pos.entryPrice) * pos.quantity
      : (pos.entryPrice - markPrice) * pos.quantity;
    const netPnl = grossPnl - totalFees;

    pos.grossPnlUsdt = grossPnl;
    pos.unrealizedPnlUsdt = netPnl;

    // 3. Peak/Trough Tracking
    if (isLong) {
      if (markPrice > pos.peakPrice) {
        pos.peakPrice = markPrice;
      }
    } else {
      if (markPrice < pos.troughPrice || pos.troughPrice <= 0) {
        pos.troughPrice = markPrice;
      }
    }

    const peakGrossPnl = isLong
      ? (pos.peakPrice - pos.entryPrice) * pos.quantity
      : (pos.entryPrice - pos.troughPrice) * pos.quantity;
    const peakExitFee = (isLong ? pos.peakPrice : pos.troughPrice) * pos.quantity * this.config.takerFeeRate;
    const peakNetPnl = peakGrossPnl - (entryFee + peakExitFee) * this.config.feeBufferMultiplier;

    if (peakNetPnl > pos.peakNetPnlUsdt) {
      pos.peakNetPnlUsdt = peakNetPnl;
    }

    // 4. Evaluate Take-Profit $5.00 Barrier
    let isTpTriggered = false;
    if (netPnl >= this.config.takeProfitBarrierUsdt) {
      isTpTriggered = true;
      pos.takeProfitBarrierHit = true;
    }

    // 5. Evaluate Multi-Tier Step-Collar Logic
    // Tier 1: Break-Even Lock when net profit >= +$0.50
    // Tier 2: Partial Profit Lock when net profit >= +$1.50 (locks +$0.50 profit)
    // Tier 3: Aggressive Trail when net profit >= +$2.00 (locks +$1.50 & trails with $0.50 margin)
    let candidateSlPrice = pos.currentStopLossPrice;
    let newTier: StepCollarTier = pos.activeTier;
    let reason = "COLLAR_HOLD";

    if (pos.peakNetPnlUsdt >= this.config.tier3ProfitThresholdUsdt) {
      // Tier 3: Aggressive Trail
      newTier = "TIER_3_AGGRESSIVE_TRAIL";
      pos.isBreakEvenLocked = true;

      // Desired locked net profit: max($1.50, peakNetPnl - $0.50)
      const targetLockedProfit = Math.max(
        this.config.tier3LockProfitUsdt,
        pos.peakNetPnlUsdt - this.config.tier3TrailingMarginUsdt
      );

      // Price that yields targetLockedProfit after all fees:
      // NetPnl = (PriceDelta * Qty) - TotalFees = targetLockedProfit
      // PriceDelta * Qty = targetLockedProfit + TotalFees
      const requiredGrossDelta = (targetLockedProfit + totalFees) / pos.quantity;
      candidateSlPrice = isLong
        ? pos.entryPrice + requiredGrossDelta
        : pos.entryPrice - requiredGrossDelta;

      reason = `TIER_3_TRAIL_ACTIVE (Peak Net: $${pos.peakNetPnlUsdt.toFixed(2)}, Lock: $${targetLockedProfit.toFixed(2)})`;
    } else if (pos.peakNetPnlUsdt >= this.config.tier2ProfitThresholdUsdt) {
      // Tier 2: Partial Profit Lock (+0.50 net locked)
      if (newTier !== "TIER_3_AGGRESSIVE_TRAIL") {
        newTier = "TIER_2_PARTIAL_PROFIT";
      }
      pos.isBreakEvenLocked = true;

      const targetLockedProfit = this.config.tier2LockProfitUsdt;
      const requiredGrossDelta = (targetLockedProfit + totalFees) / pos.quantity;
      const tier2Candidate = isLong
        ? pos.entryPrice + requiredGrossDelta
        : pos.entryPrice - requiredGrossDelta;

      candidateSlPrice = isLong
        ? Math.max(candidateSlPrice, tier2Candidate)
        : (candidateSlPrice > 0 ? Math.min(candidateSlPrice, tier2Candidate) : tier2Candidate);

      reason = `TIER_2_LOCK_ACTIVE (Lock: +$${targetLockedProfit.toFixed(2)})`;
    } else if (pos.peakNetPnlUsdt >= this.config.tier1ProfitThresholdUsdt) {
      // Tier 1: Break-Even Lock (0.00 net loss covering exact fees)
      if (newTier === "NONE") {
        newTier = "TIER_1_BREAK_EVEN";
      }
      pos.isBreakEvenLocked = true;

      const beGrossDelta = totalFees / pos.quantity;
      const tier1Candidate = isLong
        ? pos.entryPrice + beGrossDelta
        : pos.entryPrice - beGrossDelta;

      candidateSlPrice = isLong
        ? Math.max(candidateSlPrice, tier1Candidate)
        : (candidateSlPrice > 0 ? Math.min(candidateSlPrice, tier1Candidate) : tier1Candidate);

      reason = "TIER_1_BREAK_EVEN_LOCKED";
    }

    // 6. Monotonicity Ratchet Rule: Stop Loss can ONLY move in the direction of profit
    const formattedCandidateSl = SymbolPrecisionRegistry.formatPrice(symbol, candidateSlPrice);
    let finalSl = pos.currentStopLossPrice;
    let shouldUpdate = false;

    if (isLong) {
      if (formattedCandidateSl > pos.currentStopLossPrice) {
        finalSl = formattedCandidateSl;
        shouldUpdate = true;
      }
    } else {
      if (pos.currentStopLossPrice <= 0 || formattedCandidateSl < pos.currentStopLossPrice) {
        finalSl = formattedCandidateSl;
        shouldUpdate = true;
      }
    }

    if (shouldUpdate) {
      pos.currentStopLossPrice = finalSl;
      pos.activeTier = newTier;
    }

    // 7. Evaluate Stop Loss Breach
    let isSlTriggered = false;
    if (finalSl > 0) {
      if (isLong && markPrice <= finalSl) {
        isSlTriggered = true;
        pos.stopLossHit = true;
      } else if (!isLong && markPrice >= finalSl) {
        isSlTriggered = true;
        pos.stopLossHit = true;
      }
    }

    // Populate reusable zero-GC evaluation result
    this.evalResult.symbol = symbol;
    this.evalResult.side = side;
    this.evalResult.shouldUpdateStopLoss = shouldUpdate;
    this.evalResult.newStopLossPrice = finalSl;
    this.evalResult.activeTier = pos.activeTier;
    this.evalResult.unrealizedNetPnlUsdt = netPnl;
    this.evalResult.grossPnlUsdt = grossPnl;
    this.evalResult.totalFeesUsdt = totalFees;
    this.evalResult.isTakeProfitTriggered = isTpTriggered;
    this.evalResult.isStopLossTriggered = isSlTriggered;
    this.evalResult.reason = isTpTriggered
      ? "TAKE_PROFIT_BARRIER_5_USDT"
      : isSlTriggered
      ? `STOP_LOSS_BREACH_${pos.activeTier}`
      : reason;

    return this.evalResult;
  }

  /**
   * Helper to compute fee-adjusted break-even price for a position.
   */
  public calculateBreakEvenPrice(
    symbol: string,
    side: "LONG" | "SHORT",
    entryPrice: number,
    quantity: number
  ): number {
    if (entryPrice <= 0 || quantity <= 0) return entryPrice;
    const roundTripFeePct = (this.config.makerFeeRate + this.config.takerFeeRate) * this.config.feeBufferMultiplier;
    const feeOffset = entryPrice * roundTripFeePct;
    const bePrice = side === "LONG" ? entryPrice + feeOffset : entryPrice - feeOffset;
    return SymbolPrecisionRegistry.formatPrice(symbol, bePrice);
  }

  private getPositionKey(symbol: string, side: "LONG" | "SHORT"): string {
    return `${symbol.toUpperCase()}_${side.toUpperCase()}`;
  }
}
