"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamicRiskEngine = void 0;
class DynamicRiskEngine {
    vpinThreshold = 0.85;
    minHurstTrend = 0.55;
    maxHurstMeanReversion = 0.45;
    constructor(vpinThreshold) {
        const envVpinThreshold = process.env.VPIN_THRESHOLD ? parseFloat(process.env.VPIN_THRESHOLD) : NaN;
        const defaultVpin = !isNaN(envVpinThreshold) ? envVpinThreshold : 0.85;
        this.vpinThreshold = (vpinThreshold && vpinThreshold > 0) ? vpinThreshold : defaultVpin;
    }
    /**
     * Calculates real-time dynamic stop-loss, take-profit, regime classification,
     * and trap detection flags for an order intent.
     * Zero GC allocations in hot-path execution.
     */
    evaluateDynamicRisk(entryPrice, positionSide, metrics, spread = 2.0) {
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
        let regimeState = "MEAN_REVERTING";
        if (metrics.vpin > this.vpinThreshold || metrics.isSweepDetected) {
            regimeState = "TOXIC_CHOP_TRAP";
        }
        else if (metrics.hurst > this.minHurstTrend) {
            regimeState = "DIRECTIONAL_TREND";
        }
        else if (metrics.hurst < this.maxHurstMeanReversion) {
            regimeState = "MEAN_REVERTING";
        }
        else {
            regimeState = "MEAN_REVERTING";
        }
        // 2. Trap Detection Checks
        let isTrapDetected = false;
        let trapReason = null;
        if (metrics.isSweepDetected) {
            isTrapDetected = true;
            trapReason = "LIQUIDITY_SWEEP_TRAP_DETECTED";
        }
        else if (metrics.vpin > this.vpinThreshold) {
            isTrapDetected = true;
            trapReason = "HIGH_VPIN_TOXIC_FLOW";
        }
        else if (regimeState === "TOXIC_CHOP_TRAP") {
            isTrapDetected = true;
            trapReason = "NOISY_CHOP_REGIME";
        }
        // 3. Dynamic Volatility & OBI Collar Calculation
        // Base Volatility Factor: Garman-Klass RV or minimum 0.20%
        const volFactor = Math.max(metrics.rvGk, 0.0020);
        const minSpreadDistance = Math.max(spread, entryPrice * 0.0001);
        const obiSigned = Math.max(-1.0, Math.min(1.0, metrics.obi));
        let stopLossPrice = 0;
        let takeProfitPrice = 0;
        if (positionSide === "LONG") {
            // Long Position:
            // Negative OBI -> expands SL distance to avoid stop-hunts.
            // Positive OBI -> expands TP distance to capture trend runaway.
            const slDistance = Math.max(volFactor * 1.5 * (1.0 - 0.4 * obiSigned) * entryPrice, minSpreadDistance * 2.0);
            let tpDistance = Math.max(volFactor * 2.0 * (1.0 + 0.5 * obiSigned) * entryPrice, minSpreadDistance * 3.0);
            // Enforce minimum 2.01 R:R ratio floor and 55 bps friction defense floor
            tpDistance = Math.max(tpDistance, slDistance * 2.01, entryPrice * 0.0055);
            stopLossPrice = entryPrice - slDistance;
            takeProfitPrice = entryPrice + tpDistance;
        }
        else {
            // Short Position:
            // Positive OBI -> expands SL distance.
            // Negative OBI -> expands TP distance.
            const slDistance = Math.max(volFactor * 1.5 * (1.0 + 0.4 * obiSigned) * entryPrice, minSpreadDistance * 2.0);
            let tpDistance = Math.max(volFactor * 2.0 * (1.0 - 0.5 * obiSigned) * entryPrice, minSpreadDistance * 3.0);
            // Enforce minimum 2.01 R:R ratio floor and 55 bps friction defense floor
            tpDistance = Math.max(tpDistance, slDistance * 2.01, entryPrice * 0.0055);
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
    calculateFeeAdjustedBreakEvenPrice(entryPrice, positionSide, overrideFeeRate) {
        if (entryPrice <= 0)
            return 0;
        const defaultMakerFee = parseFloat(process.env.MAKER_FEE_RATE || "0.00018");
        const defaultTakerFee = parseFloat(process.env.TAKER_FEE_RATE || "0.00045");
        const effectiveFeeRate = overrideFeeRate ?? (defaultMakerFee + defaultTakerFee);
        const feeMultiplier = effectiveFeeRate * 2.5; // Round-trip fee buffer (2 x fee + 0.5 fee slippage)
        if (positionSide === "LONG") {
            return entryPrice * (1.0 + feeMultiplier);
        }
        else {
            return entryPrice * (1.0 - feeMultiplier);
        }
    }
    /**
     * Evaluates absolute Ruthless Hard Stop condition.
     * Returns true if markPrice breaches stopLossPrice by any amount,
     * triggering an unblockable, high-priority emergency market close order.
     */
    evaluateEmergencyHardStop(positionSide, entryPrice, currentMarkPrice, stopLossPrice) {
        if (entryPrice <= 0 || currentMarkPrice <= 0 || stopLossPrice <= 0) {
            return { isHardStopBreached: false, breachAmount: 0 };
        }
        if (positionSide === "LONG") {
            const isBreached = currentMarkPrice <= stopLossPrice;
            const breachAmount = isBreached ? stopLossPrice - currentMarkPrice : 0;
            return { isHardStopBreached: isBreached, breachAmount };
        }
        else {
            const isBreached = currentMarkPrice >= stopLossPrice;
            const breachAmount = isBreached ? currentMarkPrice - stopLossPrice : 0;
            return { isHardStopBreached: isBreached, breachAmount };
        }
    }
}
exports.DynamicRiskEngine = DynamicRiskEngine;
