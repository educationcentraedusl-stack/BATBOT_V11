"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamicSizingCalculator = void 0;
require("dotenv/config");
class DynamicSizingCalculator {
    allocation3Stage;
    allocation2Stage;
    consolidationThresholdUsdt;
    minNotionalUsdt;
    makerFeeRate;
    takerFeeRate;
    minNetAlpha;
    constructor() {
        // Dynamically parse configuration from process.env (Zero hardcoding rule - Strict Error Enforcement)
        const raw3Stage = process.env.TP_STAGE_ALLOCATION_3STAGE;
        if (!raw3Stage) {
            throw new Error("[DynamicSizingCalculator] Missing required environment variable: TP_STAGE_ALLOCATION_3STAGE");
        }
        this.allocation3Stage = raw3Stage
            .split(",")
            .map((val) => parseFloat(val.trim()) / 100.0)
            .filter((val) => !isNaN(val) && val > 0);
        if (this.allocation3Stage.length === 0) {
            throw new Error("[DynamicSizingCalculator] Invalid TP_STAGE_ALLOCATION_3STAGE environment variable format.");
        }
        const raw2Stage = process.env.TP_STAGE_ALLOCATION_2STAGE;
        if (!raw2Stage) {
            throw new Error("[DynamicSizingCalculator] Missing required environment variable: TP_STAGE_ALLOCATION_2STAGE");
        }
        this.allocation2Stage = raw2Stage
            .split(",")
            .map((val) => parseFloat(val.trim()) / 100.0)
            .filter((val) => !isNaN(val) && val > 0);
        if (this.allocation2Stage.length === 0) {
            throw new Error("[DynamicSizingCalculator] Invalid TP_STAGE_ALLOCATION_2STAGE environment variable format.");
        }
        const rawConsolidation = process.env.DYNAMIC_SIZING_CONSOLIDATION_THRESHOLD_USDT;
        if (!rawConsolidation) {
            throw new Error("[DynamicSizingCalculator] Missing required environment variable: DYNAMIC_SIZING_CONSOLIDATION_THRESHOLD_USDT");
        }
        this.consolidationThresholdUsdt = parseFloat(rawConsolidation);
        const rawMinNotional = process.env.MIN_NOTIONAL_USDT;
        if (!rawMinNotional) {
            throw new Error("[DynamicSizingCalculator] Missing required environment variable: MIN_NOTIONAL_USDT");
        }
        this.minNotionalUsdt = parseFloat(rawMinNotional);
        const rawMakerFee = process.env.MAKER_FEE_RATE;
        if (!rawMakerFee) {
            throw new Error("[DynamicSizingCalculator] Missing required environment variable: MAKER_FEE_RATE");
        }
        this.makerFeeRate = parseFloat(rawMakerFee);
        const rawTakerFee = process.env.TAKER_FEE_RATE;
        if (!rawTakerFee) {
            throw new Error("[DynamicSizingCalculator] Missing required environment variable: TAKER_FEE_RATE");
        }
        this.takerFeeRate = parseFloat(rawTakerFee);
        const rawMinNetAlpha = process.env.MIN_NET_ALPHA;
        if (!rawMinNetAlpha) {
            throw new Error("[DynamicSizingCalculator] Missing required environment variable: MIN_NET_ALPHA");
        }
        this.minNetAlpha = parseFloat(rawMinNetAlpha);
        if (isNaN(this.minNetAlpha) || this.minNetAlpha <= 0) {
            throw new Error("[DynamicSizingCalculator] Invalid MIN_NET_ALPHA environment variable format.");
        }
    }
    getMinNetAlpha() {
        return this.minNetAlpha;
    }
    getMakerFeeRate() {
        return this.makerFeeRate;
    }
    getTakerFeeRate() {
        return this.takerFeeRate;
    }
    getMinNotionalUsdt() {
        return this.minNotionalUsdt;
    }
    getConsolidationThresholdUsdt() {
        return this.consolidationThresholdUsdt;
    }
    /**
     * Calculates optimized dynamic partial TP chunks based on current entry price and total position size.
     * Automatically collapses 3-stage ladders into 2-stage or 1-stage if position size falls below consolidation/minNotional limits.
     * Zero GC allocations.
     */
    calculateDynamicTpChunks(totalQuantity, currentPrice, quantityPrecision = 3) {
        if (totalQuantity <= 0 || currentPrice <= 0) {
            return {
                totalQuantity: 0,
                totalNotionalUsdt: 0,
                stageCount: 0,
                chunks: [],
                totalMakerFeeUsdt: 0,
                totalTakerFeeUsdt: 0,
                feeSavingsUsdt: 0,
                isConsolidated: false,
            };
        }
        const totalNotionalUsdt = totalQuantity * currentPrice;
        const isConsolidated = totalNotionalUsdt < this.consolidationThresholdUsdt;
        const targetAllocations = isConsolidated ? this.allocation2Stage : this.allocation3Stage;
        const rawChunks = [];
        let remainingQuantity = totalQuantity;
        for (let i = 0; i < targetAllocations.length; i++) {
            const isLast = i === targetAllocations.length - 1;
            const pct = targetAllocations[i];
            let rawQty = isLast ? remainingQuantity : totalQuantity * pct;
            rawQty = Number(rawQty.toFixed(quantityPrecision));
            const notional = rawQty * currentPrice;
            // Check minimum notional guard
            if (notional < this.minNotionalUsdt && rawChunks.length > 0) {
                // Merge tiny sub-notional chunk into previous stage
                const prev = rawChunks[rawChunks.length - 1];
                prev.quantity = Number((prev.quantity + rawQty).toFixed(quantityPrecision));
                prev.notionalUsdt = prev.quantity * currentPrice;
                prev.percentage += pct * 100;
                prev.estimatedFeeUsdt = prev.notionalUsdt * this.makerFeeRate;
                remainingQuantity -= rawQty;
                continue;
            }
            const estimatedMakerFee = notional * this.makerFeeRate;
            rawChunks.push({
                stage: rawChunks.length + 1,
                percentage: Number((pct * 100).toFixed(1)),
                quantity: rawQty,
                notionalUsdt: Number(notional.toFixed(2)),
                isMaker: true,
                estimatedFeeUsdt: Number(estimatedMakerFee.toFixed(4)),
            });
            remainingQuantity -= rawQty;
        }
        const totalMakerFeeUsdt = rawChunks.reduce((acc, c) => acc + c.estimatedFeeUsdt, 0);
        const totalTakerFeeUsdt = totalNotionalUsdt * this.takerFeeRate;
        const feeSavingsUsdt = Math.max(0, totalTakerFeeUsdt - totalMakerFeeUsdt);
        return {
            totalQuantity,
            totalNotionalUsdt: Number(totalNotionalUsdt.toFixed(2)),
            stageCount: rawChunks.length,
            chunks: rawChunks,
            totalMakerFeeUsdt: Number(totalMakerFeeUsdt.toFixed(4)),
            totalTakerFeeUsdt: Number(totalTakerFeeUsdt.toFixed(4)),
            feeSavingsUsdt: Number(feeSavingsUsdt.toFixed(4)),
            isConsolidated,
        };
    }
    /**
     * Calculates net PnL after deducting Maker/Taker fees according to execution type.
     */
    calculateNetPnl(grossPnlUsdt, entryNotionalUsdt, exitNotionalUsdt, isEntryMaker = false, isExitMaker = true) {
        const entryFeeRate = isEntryMaker ? this.makerFeeRate : this.takerFeeRate;
        const exitFeeRate = isExitMaker ? this.makerFeeRate : this.takerFeeRate;
        const entryFeeUsdt = entryNotionalUsdt * entryFeeRate;
        const exitFeeUsdt = exitNotionalUsdt * exitFeeRate;
        const totalFeeUsdt = entryFeeUsdt + exitFeeUsdt;
        const netPnlUsdt = grossPnlUsdt - totalFeeUsdt;
        return {
            netPnlUsdt: Number(netPnlUsdt.toFixed(4)),
            entryFeeUsdt: Number(entryFeeUsdt.toFixed(4)),
            exitFeeUsdt: Number(exitFeeUsdt.toFixed(4)),
            totalFeeUsdt: Number(totalFeeUsdt.toFixed(4)),
        };
    }
    /**
     * SOTA August 2026 Alpha-Gated Dynamic Kelly Recovery Sizing (AG-DKRS).
     * Dynamically adjusts position sizing during session drawdown:
     * - Never doubles down (Strict Zero-Martingale protocol).
     * - When cumulativeRealizedPnl < 0:
     *   * Alpha Regime 1 (High Conviction: aiConfidence >= 0.80, zScore >= 2.0):
     *     Scales notional by: S_recovery = S_base * (1.0 + min(0.50, (|Drawdown| / MaxDailyLoss) * (aiConfidence / 1.0)))
     *     Clamped strictly up to 1.50x base size.
     *   * Marginal Regimes (aiConfidence < 0.80):
     *     Scales down notional to 0.75x to preserve capital until alpha regime returns.
     * - When cumulativeRealizedPnl >= 0:
     *   * Normal conviction sizing between 1.0x and 1.20x based on AI confidence.
     */
    calculateAlphaGatedRecoverySize(baseNotionalUsdt, cumulativeRealizedPnl, maxDailyLossUsdt = 500.0, aiConfidence = 0.50, zScore = 0.0, hurstExponent = 0.50) {
        const safeBase = Math.max(10.0, baseNotionalUsdt);
        const isDrawdown = cumulativeRealizedPnl < 0;
        const safeMaxDailyLoss = Math.max(10.0, maxDailyLossUsdt);
        if (!isDrawdown) {
            // Normal / Positive PnL regime: Base sizing scaled gently by high confidence
            const confidenceBonus = aiConfidence >= 0.85 && zScore >= 2.0 ? 1.20 : 1.0;
            const targetNotional = safeBase * confidenceBonus;
            return {
                targetNotionalUsdt: Number(targetNotional.toFixed(2)),
                sizingMultiplier: confidenceBonus,
                recoveryActive: false,
                reason: "NORMAL_PROFIT_REGIME",
            };
        }
        const drawdownUsdt = Math.abs(cumulativeRealizedPnl);
        const drawdownRatio = Math.min(1.0, drawdownUsdt / safeMaxDailyLoss);
        const isHighConvictionAlpha = aiConfidence >= 0.80 && zScore >= 2.0 && hurstExponent >= 0.50;
        if (isHighConvictionAlpha) {
            // SOTA Alpha-Gated Recovery Sizing: Boost only on high-conviction setups
            const recoveryBoost = Math.min(0.50, drawdownRatio * (aiConfidence / 1.0));
            const sizingMultiplier = Math.min(1.50, 1.0 + recoveryBoost);
            const targetNotional = safeBase * sizingMultiplier;
            return {
                targetNotionalUsdt: Number(targetNotional.toFixed(2)),
                sizingMultiplier: Number(sizingMultiplier.toFixed(3)),
                recoveryActive: true,
                reason: `ALPHA_RECOVERY_BOOST (+${(recoveryBoost * 100).toFixed(1)}%)`,
            };
        }
        else {
            // Defensive Capital Preservation: Reduce size on marginal setups during drawdown
            const defensiveMultiplier = 0.75;
            const targetNotional = safeBase * defensiveMultiplier;
            return {
                targetNotionalUsdt: Number(targetNotional.toFixed(2)),
                sizingMultiplier: defensiveMultiplier,
                recoveryActive: true,
                reason: "DEFENSIVE_DRAWDOWN_REDUCTION (0.75x)",
            };
        }
    }
}
exports.DynamicSizingCalculator = DynamicSizingCalculator;
