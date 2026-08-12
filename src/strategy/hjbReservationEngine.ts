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
   */
  public calculateReservationPrice(
    basePrice: number,
    inventory: number,
    durationMs: number,
    garmanKlassVol: number
  ): number {
    if (basePrice <= 0) return 0;

    const remainingHorizon = Math.max(0.001, this.targetHorizonSeconds - durationMs * 0.001);
    const variance = garmanKlassVol * garmanKlassVol;

    // Inventory Penalty Delta = q * gamma * sigma^2 * (T - t) * S0
    const inventoryPenalty = inventory * this.riskAversionGamma * variance * remainingHorizon * basePrice;

    return basePrice - inventoryPenalty;
  }

  /**
   * Evaluates continuous HJB optimal stopping liquidation boundary relative to position entry price
   */
  public getOptimalExitBoundary(
    side: "LONG" | "SHORT",
    entryPrice: number,
    currentPrice: number,
    inventory: number,
    durationMs: number,
    garmanKlassVol: number
  ): HJBExitEvaluation {
    if (currentPrice <= 0 || entryPrice <= 0) {
      return {
        reservationPrice: currentPrice,
        liquidationBoundary: currentPrice,
        isLiquidationTriggered: false,
        inventoryPenalty: 0,
        exitReason: "NONE"
      };
    }

    const safeVol = Math.max(0.001, garmanKlassVol);
    const signedInventory = side === "LONG" ? Math.abs(inventory) : -Math.abs(inventory);

    const reservationPrice = this.calculateReservationPrice(
      entryPrice,
      signedInventory,
      durationMs,
      safeVol
    );

    const absQty = Math.abs(inventory);

    // Fast Volatility-Scaled Avellaneda-Stoikov Optimal Spread Offset:
    // term1 = safeVol * precalcLogTerm
    // term2 = (2*|q|+1)/2 * safeVol * precalcSqrtCoeff
    const term1 = safeVol * this.precalcLogTerm;
    const term2 = (absQty + 0.5) * safeVol * this.precalcSqrtCoeff;

    const halfSpreadOffsetPct = Math.max(0.001, term1 + term2);
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

    return {
      reservationPrice,
      liquidationBoundary,
      isLiquidationTriggered,
      inventoryPenalty,
      exitReason: isLiquidationTriggered ? `HJB_RESERVATION_LIQUIDATE_${side}` : "NONE"
    };
  }

  public getSymbol(): string {
    return this.symbol;
  }
}
