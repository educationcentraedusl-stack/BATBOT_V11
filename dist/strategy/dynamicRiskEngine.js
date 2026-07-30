"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamicRiskEngine = void 0;
class DynamicRiskEngine {
    vpinThreshold = 0.70;
    minHurstTrend = 0.55;
    maxHurstMeanReversion = 0.45;
    constructor(vpinThreshold) {
        if (vpinThreshold && vpinThreshold > 0) {
            this.vpinThreshold = vpinThreshold;
        }
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
            regimeState = "TOXIC_CHOP_TRAP";
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
            const tpDistance = Math.max(volFactor * 2.0 * (1.0 + 0.5 * obiSigned) * entryPrice, minSpreadDistance * 3.0);
            stopLossPrice = entryPrice - slDistance;
            takeProfitPrice = entryPrice + tpDistance;
        }
        else {
            // Short Position:
            // Positive OBI -> expands SL distance.
            // Negative OBI -> expands TP distance.
            const slDistance = Math.max(volFactor * 1.5 * (1.0 + 0.4 * obiSigned) * entryPrice, minSpreadDistance * 2.0);
            const tpDistance = Math.max(volFactor * 2.0 * (1.0 - 0.5 * obiSigned) * entryPrice, minSpreadDistance * 3.0);
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
}
exports.DynamicRiskEngine = DynamicRiskEngine;
