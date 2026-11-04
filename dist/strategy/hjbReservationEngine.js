"use strict";
/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING ENGINE
 * HJB Reservation Price & Optimal Stopping Engine
 *
 * Solves Avellaneda-Stoikov continuous-time Hamilton-Jacobi-Bellman (HJB) equations
 * to compute dynamic reservation prices R(s, q, t) and optimal liquidation boundaries.
 * High-performance zero-GC precalculated math for sub-microsecond HFT execution.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HJBReservationEngine = void 0;
const vegamTpLadderEngine_1 = require("./vegamTpLadderEngine");
class HJBReservationEngine {
    symbol;
    riskAversionGamma;
    targetHorizonSeconds;
    liquidityKappa;
    // Pre-calculated Math Constants for Sub-Microsecond Execution
    precalcLogTerm;
    precalcSqrtCoeff;
    // Zero-GC Pre-allocated Cached Result Payload Ring Buffer
    cachedExitEvalRing = Array.from({ length: 8 }, () => ({
        reservationPrice: 0,
        liquidationBoundary: 0,
        isLiquidationTriggered: false,
        inventoryPenalty: 0,
        exitReason: "NONE",
    }));
    evalRingIdx = 0;
    constructor(symbol, riskAversionGamma, targetHorizonSeconds, liquidityKappa = 1.5) {
        this.symbol = symbol;
        const cleanSym = symbol ? symbol.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
        // Multi-tier Risk Aversion Gamma resolution:
        // 1. Explicit caller argument (if finite and > 0)
        // 2. Per-asset environment variable (e.g. HJB_GAMMA_BTCUSDT)
        // 3. Global environment variable (HJB_RISK_AVERSION_GAMMA or HJB_GAMMA)
        // 4. SOTA calibrated default from DEFAULT_VEGAM_CONFIG (4.20)
        let resolvedGamma = vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG.hjbRiskAversionGamma;
        if (typeof riskAversionGamma === "number" && Number.isFinite(riskAversionGamma) && riskAversionGamma > 0) {
            resolvedGamma = riskAversionGamma;
        }
        else {
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
        let resolvedHorizon = vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG.hjbTargetHorizonSeconds;
        if (typeof targetHorizonSeconds === "number" && Number.isFinite(targetHorizonSeconds) && targetHorizonSeconds > 0) {
            resolvedHorizon = targetHorizonSeconds;
        }
        else {
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
    getRiskAversionGamma() {
        return this.riskAversionGamma;
    }
    getTargetHorizonSeconds() {
        return this.targetHorizonSeconds;
    }
    getLiquidityKappa() {
        return this.liquidityKappa;
    }
    /**
     * Calculates Avellaneda-Stoikov Reservation Price R(s, q, t) = s - q * gamma * sigma^2 * (T - t)
     * Inventory q is notional-normalized against standard slot trade size ($60.0 USDT) to maintain
     * price-scale invariance across all cryptocurrency assets (BTC to DOGE).
     */
    calculateReservationPrice(basePrice, inventory, durationMs, garmanKlassVol, referenceNotionalUsdt = 60.0) {
        if (basePrice <= 0)
            return 0;
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
    getOptimalExitBoundary(side, entryPrice, currentPrice, inventory, durationMs, garmanKlassVol, referenceNotionalUsdt = 60.0) {
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
        const refNotional = referenceNotionalUsdt > 0 ? referenceNotionalUsdt : 60.0;
        const absQty = Math.abs(inventory);
        const notional = absQty * entryPrice;
        const slotUnits = notional > 0 ? notional / refNotional : 1.0;
        const normalizedQty = Math.max(0.1, Math.min(5.0, slotUnits));
        const isLong = side === "LONG";
        const remainingHorizon = Math.max(0.001, this.targetHorizonSeconds - durationMs * 0.001);
        const variance = safeVol * safeVol;
        const qNorm = isLong ? normalizedQty : -normalizedQty;
        const inventoryPenalty = qNorm * this.riskAversionGamma * variance * remainingHorizon * entryPrice;
        const reservationPrice = entryPrice - inventoryPenalty;
        const penaltyAbs = Math.abs(inventoryPenalty);
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
        if (isLong) {
            liquidationBoundary = reservationPrice - offsetUsdt;
            isLiquidationTriggered = currentPrice <= liquidationBoundary;
        }
        else {
            liquidationBoundary = reservationPrice + offsetUsdt;
            isLiquidationTriggered = currentPrice >= liquidationBoundary;
        }
        res.reservationPrice = reservationPrice;
        res.liquidationBoundary = liquidationBoundary;
        res.isLiquidationTriggered = isLiquidationTriggered;
        res.inventoryPenalty = penaltyAbs;
        res.exitReason = isLiquidationTriggered ? `HJB_RESERVATION_LIQUIDATE_${side}` : "NONE";
        return res;
    }
    getSymbol() {
        return this.symbol;
    }
}
exports.HJBReservationEngine = HJBReservationEngine;
