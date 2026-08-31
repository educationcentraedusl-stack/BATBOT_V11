/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING ENGINE
 * HJB Reservation Price & Optimal Stopping Engine
 *
 * Solves Avellaneda-Stoikov continuous-time Hamilton-Jacobi-Bellman (HJB) equations
 * to compute dynamic reservation prices R(s, q, t) and optimal liquidation boundaries.
 * High-performance zero-GC precalculated math for sub-microsecond HFT execution.
 */

export interface HJBExitEvaluation {
  reservationPrice: number;
  liquidationBoundary: number;
  isLiquidationTriggered: boolean;
  inventoryPenalty: number;
  exitReason: string;
}

export class HJBReservationEngine {
  private readonly symbol: string;
  private readonly riskAversionGamma: number;
  private readonly targetHorizonSeconds: number;
  private readonly liquidityKappa: number;

  // Pre-calculated Math Constants for Sub-Microsecond Execution
  private readonly precalcLogTerm: number;
  private readonly precalcSqrtCoeff: number;

  // Zero-GC Pre-allocated Cached Result Payload Ring Buffer
  private readonly cachedExitEvalRing: HJBExitEvaluation[] = Array.from({ length: 8 }, () => ({
    reservationPrice: 0,
    liquidationBoundary: 0,
    isLiquidationTriggered: false,
    inventoryPenalty: 0,
    exitReason: "NONE",
  }));
  private evalRingIdx: number = 0;

  constructor(
    symbol: string,
    riskAversionGamma: number = 0.10,
    targetHorizonSeconds: number = 60.0,
    liquidityKappa: number = 1.5
  ) {
    this.symbol = symbol;
    this.riskAversionGamma = riskAversionGamma;
    this.targetHorizonSeconds = targetHorizonSeconds;
    this.liquidityKappa = liquidityKappa;

    // Precalculate static mathematical terms
    this.precalcLogTerm = (1.0 / liquidityKappa) * Math.log(1.0 + (riskAversionGamma / liquidityKappa));
    this.precalcSqrtCoeff = Math.sqrt(riskAversionGamma / (2.0 * liquidityKappa));
  }

  /**
   * Calculates Avellaneda-Stoikov Reservation Price R(s, q, t) = s - q * gamma * sigma^2 * (T - t)
   * Inventory q is notional-normalized against standard slot trade size ($60.0 USDT) to maintain
   * price-scale invariance across all cryptocurrency assets (BTC to DOGE).
   */
  public calculateReservationPrice(
    basePrice: number,
    inventory: number,
    durationMs: number,
    garmanKlassVol: number,
    referenceNotionalUsdt: number = 60.0
  ): number {
    if (basePrice <= 0) return 0;

    const remainingHorizon = Math.max(0.001, this.targetHorizonSeconds - durationMs * 0.001);
    const variance = garmanKlassVol * garmanKlassVol;

    // Notional-normalized inventory across all cryptocurrency assets (0.001 BTC to 1000 DOGE):
    // Maps raw token quantity against standard slot size (refNotional, default $60 USDT).
    const refNotional = referenceNotionalUsdt > 0 ? referenceNotionalUsdt : 60.0;
    const absQty = Math.abs(inventory);
    const notional = absQty * basePrice;
    const slotUnits = notional > 0 ? notional / refNotional : 1.0;
    const qNorm = Math.sign(inventory) * Math.max(0.1, Math.min(5.0, slotUnits));

    // Inventory Penalty Delta = q_norm * gamma * sigma^2 * (T - t) * S0
    const inventoryPenalty = qNorm * this.riskAversionGamma * variance * remainingHorizon * basePrice;

    return basePrice - inventoryPenalty;
  }

  /**
   * Evaluates continuous HJB optimal stopping liquidation boundary relative to position entry price using zero-GC cached payload ring.
   */
  public getOptimalExitBoundary(
    side: "LONG" | "SHORT",
    entryPrice: number,
    currentPrice: number,
    inventory: number,
    durationMs: number,
    garmanKlassVol: number,
    referenceNotionalUsdt: number = 60.0
  ): HJBExitEvaluation {
    const res = this.cachedExitEvalRing[this.evalRingIdx];
    this.evalRingIdx = (this.evalRingIdx + 1) % 8;

    if (currentPrice <= 0 || entryPrice <= 0) {
      res.reservationPrice = currentPrice;
      res.liquidationBoundary = currentPrice;
      res.isLiquidationTriggered = false;
      res.inventoryPenalty = 0;
      res.exitReason = "NONE";
      return res;
    }

    const safeVol = Math.max(0.001, garmanKlassVol);
    const refNotional = referenceNotionalUsdt > 0 ? referenceNotionalUsdt : 60.0;
    const absQty = Math.abs(inventory);
    const notional = absQty * entryPrice;
    const slotUnits = notional > 0 ? notional / refNotional : 1.0;
    const normalizedQty = Math.max(0.1, Math.min(5.0, slotUnits));
    const signedInventory = side === "LONG" ? absQty : -absQty;

    const reservationPrice = this.calculateReservationPrice(
      entryPrice,
      signedInventory,
      durationMs,
      safeVol,
      refNotional
    );

    // SOTA Stoikov-Lehalle Multi-Scale Breathing Boundary (August 2026):
    // Brownian motion noise protection: Delta_breathing = max(0.0050, k_vol * sigma_GK * sqrt((t + t0) / T), term1 + term2)
    // Guarantees at least 50 bps breathing room so sub-second micro-ticks cannot panic liquidations.
    const term1 = safeVol * this.precalcLogTerm;
    const term2 = (normalizedQty + 0.5) * safeVol * this.precalcSqrtCoeff;
    const durationSec = Math.max(0, durationMs * 0.001);
    const timeScaleFactor = Math.sqrt((durationSec + 10.0) / Math.max(10.0, this.targetHorizonSeconds));
    const dynamicVolBreathingPct = safeVol * 2.5 * timeScaleFactor;

    // Minimum 50 bps (0.0050) breathing floor prevents noise scratches
    const halfSpreadOffsetPct = Math.max(0.0050, Math.max(term1 + term2, dynamicVolBreathingPct));
    const offsetUsdt = entryPrice * halfSpreadOffsetPct;

    let liquidationBoundary = 0;
    let isLiquidationTriggered = false;

    if (side === "LONG") {
      liquidationBoundary = reservationPrice - offsetUsdt;
      isLiquidationTriggered = currentPrice <= liquidationBoundary;
    } else {
      liquidationBoundary = reservationPrice + offsetUsdt;
      isLiquidationTriggered = currentPrice >= liquidationBoundary;
    }

    const inventoryPenalty = Math.abs(entryPrice - reservationPrice);

    res.reservationPrice = reservationPrice;
    res.liquidationBoundary = liquidationBoundary;
    res.isLiquidationTriggered = isLiquidationTriggered;
    res.inventoryPenalty = inventoryPenalty;
    res.exitReason = isLiquidationTriggered ? `HJB_RESERVATION_LIQUIDATE_${side}` : "NONE";

    return res;
  }

  public getSymbol(): string {
    return this.symbol;
  }
}
