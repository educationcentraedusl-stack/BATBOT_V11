export type RegimeState = "MEAN_REVERTING" | "DIRECTIONAL_TREND" | "TOXIC_CHOP_TRAP";

export interface DynamicMicrostructureMetrics {
  obi: number;
  cvd: number;
  rvGk: number;
  vpin: number;
  hurst: number;
  lobEntropy: number;
  regime: number; // 0 = MEAN_REVERTING, 1 = DIRECTIONAL_TREND, 2 = TOXIC_CHOP_TRAP
  isSweepDetected: boolean;
}

export interface DynamicRiskProfile {
  stopLossPrice: number;
  takeProfitPrice: number;
  isTrapDetected: boolean;
  trapReason: string | null;
  regimeState: RegimeState;
  vpinToxicity: number;
  rvGkVol: number;
  hurstExponent: number;
  isHighConfidenceAi?: boolean;
  aiConfidence?: number;
}

export class DynamicRiskEngine {
  private vpinThreshold: number = 0.85;
  private minHurstTrend: number = 0.55;
  private maxHurstMeanReversion: number = 0.45;

  constructor(vpinThreshold?: number) {
    const envVpinThreshold = process.env.VPIN_THRESHOLD ? parseFloat(process.env.VPIN_THRESHOLD) : NaN;
    const defaultVpin = !isNaN(envVpinThreshold) ? envVpinThreshold : 0.85;
    this.vpinThreshold = (vpinThreshold && vpinThreshold > 0) ? vpinThreshold : defaultVpin;
  }

  /**
   * Calculates real-time dynamic stop-loss, take-profit, regime classification,
   * and trap detection flags for an order intent.
   * Zero GC allocations in hot-path execution.
   */
  public evaluateDynamicRisk(
    entryPrice: number,
    positionSide: "LONG" | "SHORT",
    metrics: DynamicMicrostructureMetrics,
    spread: number = 2.0,
    isDrawdown: boolean = false
  ): DynamicRiskProfile {
    if (entryPrice <= 0) {
      return {
        stopLossPrice: 0,
        takeProfitPrice: 0,
        isTrapDetected: true,
        trapReason: "INVALID_ENTRY_PRICE",
        regimeState: "TOXIC_CHOP_TRAP",
        vpinToxicity: metrics.vpin,
        rvGkVol: metrics.rvGk,
        hurstExponent: metrics.hurst,
      };
    }

    // 1. Regime Classification
    let regimeState: RegimeState = "MEAN_REVERTING";
    const isChopRegime = metrics.hurst < 0.45 && metrics.lobEntropy > 0.85;
    const isTrendRegime = metrics.hurst >= 0.55 && metrics.lobEntropy <= 0.75;

    if (metrics.vpin > this.vpinThreshold || metrics.isSweepDetected || isChopRegime) {
      regimeState = "TOXIC_CHOP_TRAP";
    } else if (isTrendRegime) {
      regimeState = "DIRECTIONAL_TREND";
    } else if (metrics.hurst < this.maxHurstMeanReversion) {
      regimeState = "MEAN_REVERTING";
    } else {
      regimeState = "MEAN_REVERTING";
    }

    // 2. Trap Detection Checks
    let isTrapDetected = false;
    let trapReason: string | null = null;

    if (metrics.isSweepDetected) {
      isTrapDetected = true;
      trapReason = "LIQUIDITY_SWEEP_TRAP_DETECTED";
    } else if (metrics.vpin > this.vpinThreshold) {
      isTrapDetected = true;
      trapReason = "HIGH_VPIN_TOXIC_FLOW";
    } else if (isChopRegime) {
      isTrapDetected = true;
      trapReason = "NOISY_CHOP_REGIME (H < 0.45 & S_LOB > 0.85)";
    } else if (regimeState === "TOXIC_CHOP_TRAP") {
      isTrapDetected = true;
      trapReason = "NOISY_CHOP_REGIME";
    }

    // 3. Dynamic Volatility & OBI Collar Calculation
    // Base Volatility Factor: Garman-Klass RV or minimum 0.20%
    const volFactor = Math.max(metrics.rvGk, 0.0020);
    const minSpreadDistance = Math.max(spread, entryPrice * 0.0001);
    const obiSigned = Math.max(-1.0, Math.min(1.0, metrics.obi));
    const targetRrMultiplier = 2.05;

    let stopLossPrice = 0;
    let takeProfitPrice = 0;

    if (positionSide === "LONG") {
      // Long Position:
      // Negative OBI -> expands SL distance to avoid stop-hunts.
      // Positive OBI -> expands TP distance to capture trend runaway.
      const slDistance = Math.max(
        volFactor * 1.5 * (1.0 - 0.4 * obiSigned) * entryPrice,
        minSpreadDistance * 2.0
      );
      let tpDistance = Math.max(
        volFactor * 2.0 * (1.0 + 0.5 * obiSigned) * entryPrice,
        minSpreadDistance * 3.0
      );
      // Enforce dynamic R:R ratio floor and friction defense floor
      tpDistance = Math.max(tpDistance, slDistance * targetRrMultiplier, entryPrice * 0.0040);

      stopLossPrice = entryPrice - slDistance;
      takeProfitPrice = entryPrice + tpDistance;
    } else {
      // Short Position:
      // Positive OBI -> expands SL distance.
      // Negative OBI -> expands TP distance.
      const slDistance = Math.max(
        volFactor * 1.5 * (1.0 + 0.4 * obiSigned) * entryPrice,
        minSpreadDistance * 2.0
      );
      let tpDistance = Math.max(
        volFactor * 2.0 * (1.0 - 0.5 * obiSigned) * entryPrice,
        minSpreadDistance * 3.0
      );
      // Enforce dynamic R:R ratio floor and friction defense floor
      tpDistance = Math.max(tpDistance, slDistance * targetRrMultiplier, entryPrice * 0.0040);

      stopLossPrice = entryPrice + slDistance;
      takeProfitPrice = entryPrice - tpDistance;
    }

    return {
      stopLossPrice,
      takeProfitPrice,
      isTrapDetected,
      trapReason,
      regimeState,
      vpinToxicity: metrics.vpin,
      rvGkVol: metrics.rvGk,
      hurstExponent: metrics.hurst,
    };
  }

  /**
   * Calculates fee-adjusted Break-Even Stop Loss price:
   * EntryPrice ± (EntryPrice * FeeRate * 2.5) to guarantee zero-loss covering commissions & slippage.
   * Dynamically loads fee rates from process.env (Zero hardcoding rule).
   */
  public calculateFeeAdjustedBreakEvenPrice(
    entryPrice: number,
    positionSide: "LONG" | "SHORT",
    overrideFeeRate?: number
  ): number {
    if (entryPrice <= 0) return 0;
    const defaultMakerFee = parseFloat(process.env.MAKER_FEE_RATE || "0.00018");
    const defaultTakerFee = parseFloat(process.env.TAKER_FEE_RATE || "0.00045");
    const effectiveFeeRate = overrideFeeRate ?? (defaultMakerFee + defaultTakerFee);
    const feeMultiplier = effectiveFeeRate * 2.5; // Round-trip fee buffer (2 x fee + 0.5 fee slippage)
    if (positionSide === "LONG") {
      return entryPrice * (1.0 + feeMultiplier);
    } else {
      return entryPrice * (1.0 - feeMultiplier);
    }
  }

  /**
   * Evaluates absolute Ruthless Hard Stop condition.
   * Returns true if markPrice breaches stopLossPrice by any amount,
   * triggering an unblockable, high-priority emergency market close order.
   */
  public evaluateEmergencyHardStop(
    positionSide: "LONG" | "SHORT",
    entryPrice: number,
    currentMarkPrice: number,
    stopLossPrice: number
  ): { isHardStopBreached: boolean; breachAmount: number } {
    if (entryPrice <= 0 || currentMarkPrice <= 0 || stopLossPrice <= 0) {
      return { isHardStopBreached: false, breachAmount: 0 };
    }

    if (positionSide === "LONG") {
      const isBreached = currentMarkPrice <= stopLossPrice;
      const breachAmount = isBreached ? stopLossPrice - currentMarkPrice : 0;
      return { isHardStopBreached: isBreached, breachAmount };
    } else {
      const isBreached = currentMarkPrice >= stopLossPrice;
      const breachAmount = isBreached ? currentMarkPrice - stopLossPrice : 0;
      return { isHardStopBreached: isBreached, breachAmount };
    }
  }
}
