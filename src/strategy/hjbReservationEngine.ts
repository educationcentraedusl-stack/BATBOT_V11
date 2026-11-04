/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING ENGINE
 * HJB Reservation Price & Optimal Stopping Engine
 *
 * Solves Avellaneda-Stoikov continuous-time Hamilton-Jacobi-Bellman (HJB) equations
 * to compute dynamic reservation prices R(s, q, t) and optimal liquidation boundaries.
 * High-performance zero-GC precalculated math for sub-microsecond HFT execution.
 */

import { DEFAULT_VEGAM_CONFIG } from "./vegamTpLadderEngine";

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
    riskAversionGamma?: number,
    targetHorizonSeconds?: number,
    liquidityKappa: number = 1.5
  ) {
    this.symbol = symbol;

    const cleanSym = symbol ? symbol.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";

    // Multi-tier Risk Aversion Gamma resolution:
    // 1. Explicit caller argument (if finite and > 0)
    // 2. Per-asset environment variable (e.g. HJB_GAMMA_BTCUSDT)
    // 3. Global environment variable (HJB_RISK_AVERSION_GAMMA or HJB_GAMMA)
    // 4. SOTA calibrated default from DEFAULT_VEGAM_CONFIG (4.20)
    let resolvedGamma = DEFAULT_VEGAM_CONFIG.hjbRiskAversionGamma;
    if (typeof riskAversionGamma === "number" && Number.isFinite(riskAversionGamma) && riskAversionGamma > 0) {
      resolvedGamma = riskAversionGamma;
    } else {
      const envPerAsset = cleanSym ? process.env[`HJB_GAMMA_${cleanSym}`] : undefined;
      const envGlobal = process.env.HJB_RISK_AVERSION_GAMMA || process.env.HJB_GAMMA;
      const rawEnv = envPerAsset || envGlobal;
      if (rawEnv) {
        const parsed = parseFloat(rawEnv);
        if (Number.isFinite(parsed) && parsed > 0) {
          resolvedGamma = parsed;
        }
      }
    }
    this.riskAversionGamma = resolvedGamma;

    // Multi-tier Target Horizon Seconds resolution:
    // 1. Explicit caller argument (if finite and > 0)
    // 2. Per-asset environment variable (e.g. HJB_HORIZON_BTCUSDT)
    // 3. Global environment variable (HJB_TARGET_HORIZON_SECONDS or HJB_HORIZON)
    // 4. SOTA calibrated default from DEFAULT_VEGAM_CONFIG (120.0s)
    let resolvedHorizon = DEFAULT_VEGAM_CONFIG.hjbTargetHorizonSeconds;
    if (typeof targetHorizonSeconds === "number" && Number.isFinite(targetHorizonSeconds) && targetHorizonSeconds > 0) {
      resolvedHorizon = targetHorizonSeconds;
    } else {
      const envPerAsset = cleanSym ? process.env[`HJB_HORIZON_${cleanSym}`] : undefined;
      const envGlobal = process.env.HJB_TARGET_HORIZON_SECONDS || process.env.HJB_HORIZON;
      const rawEnv = envPerAsset || envGlobal;
      if (rawEnv) {
        const parsed = parseFloat(rawEnv);
        if (Number.isFinite(parsed) && parsed > 0) {
          resolvedHorizon = parsed;
        }
      }
    }
    this.targetHorizonSeconds = resolvedHorizon;
    this.liquidityKappa = liquidityKappa;

    // Precalculate static mathematical terms with resolved gamma
    this.precalcLogTerm = (1.0 / this.liquidityKappa) * Math.log(1.0 + (this.riskAversionGamma / this.liquidityKappa));
    this.precalcSqrtCoeff = Math.sqrt(this.riskAversionGamma / (2.0 * this.liquidityKappa));
  }

  public getRiskAversionGamma(): number {
    return this.riskAversionGamma;
  }

  public getTargetHorizonSeconds(): number {
    return this.targetHorizonSeconds;
  }

  public getLiquidityKappa(): number {
    return this.liquidityKappa;
  }

  /**
   * Calculates Avellaneda-Stoikov Reservation Price R(s, q, t) = s - q * gamma * sigma^2 * (T - t)
   * Inventory q is notional-normalized against standard slot trade size ($200.0 USDT) to maintain
   * price-scale invariance across all cryptocurrency assets (BTC to DOGE).
   */
  public calculateReservationPrice(
    basePrice: number,
    inventory: number,
    durationMs: number,
    garmanKlassVol: number,
    referenceNotionalUsdt: number = 200.0,
    targetHorizonSec?: number
  ): number {
    if (basePrice <= 0) return 0;

    const effHorizon = typeof targetHorizonSec === "number" && Number.isFinite(targetHorizonSec) && targetHorizonSec > 0
      ? targetHorizonSec
      : this.targetHorizonSeconds;
    const remainingHorizon = Math.max(0.001, effHorizon - durationMs * 0.001);
    const variance = garmanKlassVol * garmanKlassVol;

    // Notional-normalized inventory across all cryptocurrency assets (0.001 BTC to 1000 DOGE):
    // Maps raw token quantity against standard slot size (refNotional, default $200 USDT).
    const refNotional = referenceNotionalUsdt > 0 ? referenceNotionalUsdt : 200.0;
    const absQty = Math.abs(inventory);
    const notional = absQty * basePrice;
    const slotUnits = notional > 0 ? notional / refNotional : 1.0;
    const qNorm = Math.sign(inventory) * Math.max(0.1, Math.min(5.0, slotUnits));

    // Inventory Penalty Delta = q_norm * gamma * variance * (T - t) * S0
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
    referenceNotionalUsdt: number = 200.0,
    targetHorizonSec?: number
  ): HJBExitEvaluation {
    const res = this.cachedExitEvalRing[this.evalRingIdx];
    this.evalRingIdx = (this.evalRingIdx + 1) & 7;

    if (currentPrice <= 0 || entryPrice <= 0) {
      res.reservationPrice = currentPrice;
      res.liquidationBoundary = currentPrice;
      res.isLiquidationTriggered = false;
      res.inventoryPenalty = 0;
      res.exitReason = "NONE";
      return res;
    }

    const safeVol = Math.max(0.001, garmanKlassVol);
    const refNotional = referenceNotionalUsdt > 0 ? referenceNotionalUsdt : 200.0;
    const absQty = Math.abs(inventory);
    const notional = absQty * entryPrice;
    const slotUnits = notional > 0 ? notional / refNotional : 1.0;
    const normalizedQty = Math.max(0.1, Math.min(5.0, slotUnits));
    const isLong = side === "LONG";

    const effHorizon = typeof targetHorizonSec === "number" && Number.isFinite(targetHorizonSec) && targetHorizonSec > 0
      ? targetHorizonSec
      : this.targetHorizonSeconds;
    const remainingHorizon = Math.max(0.001, effHorizon - durationMs * 0.001);
    const variance = safeVol * safeVol;
    const qNorm = isLong ? normalizedQty : -normalizedQty;
    const inventoryPenalty = qNorm * this.riskAversionGamma * variance * remainingHorizon * entryPrice;
    const reservationPrice = entryPrice - inventoryPenalty;
    const penaltyAbs = Math.abs(inventoryPenalty);

    // SOTA Noise Floor & Actionable Institutional Boundary:
    // Anchored directly to reservation price R(s, q, t) = S0 - inventoryPenalty
    // with a minimum noise floor max(0.0050, term1) to prevent sub-second noise panic,
    // and strictly clamped to sit within [0.5x, 3.0x] GK_ATR of entry.
    const term1 = safeVol * this.precalcLogTerm;
    const noiseFloorPct = Math.max(0.0050, term1);
    const noiseFloorUsdt = entryPrice * noiseFloorPct;
    const gkAtr = entryPrice * safeVol;
    const maxBoundDistUsdt = 3.0 * gkAtr;

    let liquidationBoundary = 0;
    let isLiquidationTriggered = false;

    if (isLong) {
      const minBound = entryPrice - noiseFloorUsdt;
      const maxBound = entryPrice - maxBoundDistUsdt;
      const rawBoundary = Math.min(minBound, reservationPrice);
      liquidationBoundary = Math.max(maxBound, rawBoundary);
      isLiquidationTriggered = currentPrice <= liquidationBoundary;
    } else {
      const minBound = entryPrice + noiseFloorUsdt;
      const maxBound = entryPrice + maxBoundDistUsdt;
      const rawBoundary = Math.max(minBound, reservationPrice);
      liquidationBoundary = Math.min(maxBound, rawBoundary);
      isLiquidationTriggered = currentPrice >= liquidationBoundary;
    }

    res.reservationPrice = reservationPrice;
    res.liquidationBoundary = liquidationBoundary;
    res.isLiquidationTriggered = isLiquidationTriggered;
    res.inventoryPenalty = penaltyAbs;
    res.exitReason = isLiquidationTriggered ? `HJB_RESERVATION_LIQUIDATE_${side}` : "NONE";

    return res;
  }

  public getSymbol(): string {
    return this.symbol;
  }
}
