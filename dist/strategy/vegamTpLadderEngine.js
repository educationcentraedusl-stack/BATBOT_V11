"use strict";
/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * VEGAM (Volatility-Engineered & AI-Governed Adaptive Management) TP Ladder Engine
 *
 * Implements Layer 1 (ATR-Anchored TP Ladder) and Layer 2 (OBI-Weighted Dynamic Trailing SL)
 * per VEGAM Master Implementation Plan (2026 SOTA Exit Architecture).
 *
 * Guaranteed Invariants:
 * 1. TP1 >= RPM_min (Guaranteed fee coverage even under compressed volatility).
 * 2. High-precision zero-heap tick state machine (zero GC allocations in hot-path).
 * 3. Dynamic k_regime scaling: OBI book pressure, VPIN toxic flow clamp, and Hawkes intensity burst.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VegamTpLadderEngine = exports.DEFAULT_VEGAM_CONFIG = void 0;
exports.computeRpmMin = computeRpmMin;
exports.computeKRegime = computeKRegime;
exports.computeObiWeightedTrailDistance = computeObiWeightedTrailDistance;
exports.computeVegamTpLevels = computeVegamTpLevels;
/**
 * Exact default parameters from Section 2.3 of the Master Plan.
 */
exports.DEFAULT_VEGAM_CONFIG = Object.freeze({
    gkAlpha: 0.30,
    tp1AtrMultiplier: 1.00,
    tp2AtrMultiplier: 2.50,
    tp3TrailAtrMultiplier: 0.80,
    tp1SizeRatio: 0.35,
    tp2SizeRatio: 0.40,
    tp3SizeRatio: 0.25,
    trailActivationRoePct: 0.50,
    obiTightenThreshold: -0.20,
    obiExpandThreshold: 0.20,
    vpinToxicFloor: 0.65,
    hawkesExpansionThreshold: 1.80,
    aiDecayExitMultiplier: 0.60,
    adversarialMinSignals: 2,
    hjbRiskAversionGamma: 4.20,
    hjbTargetHorizonSeconds: 120.0,
    makerFee: 0.0002,
    takerFee: 0.0005,
});
/**
 * Pre-allocated singleton for zero-GC static tick evaluation
 */
const STATIC_TICK_RESULT = {
    action: "NONE",
    kRegime: 1.0,
    trailDist: 0.0,
    proposedSl: 0.0,
    currentSl: 0.0,
    tp1Hit: false,
    tp2Hit: false,
    slHit: false,
    rawRoePct: 0.0,
    peakRoe: 0.0,
};
/**
 * Computes minimum required price move (RPM_min) to cover round-trip fees with safety buffer.
 * Formula from Section 1.2.3: RPM_min = (makerFee + takerFee * 1.5)
 */
function computeRpmMin(leverage = 1.0, makerFee = 0.0002, takerFee = 0.0005) {
    const safeMaker = Number.isFinite(makerFee) && makerFee >= 0 ? makerFee : 0.0002;
    const safeTaker = Number.isFinite(takerFee) && takerFee >= 0 ? takerFee : 0.0005;
    const baseRpm = safeMaker + safeTaker * 1.5;
    return Math.max(0.0001, baseRpm);
}
/**
 * Computes the dynamic k_regime multiplier from order flow metrics.
 *
 * Precedence / Hierarchy:
 * 1. VPIN > 0.65 -> Toxic Flow: hard clamp k_regime = 0.5 (adverse selection protection)
 * 2. Hawkes > 1.80 -> High Intensity: expand k_regime = 2.0 (momentum extension)
 * 3. OBI directional book depth:
 *    - Book pressure against trade (< -0.20): k_regime = 0.8 (tighten to protect profit)
 *    - Supportive book depth (> +0.20): k_regime = 1.2 (expand to let trade breathe)
 *    - Neutral regime (-0.20 to +0.20): k_regime = 1.0 (baseline)
 */
function computeKRegime(obi, vpin, hawkes, config, side = "LONG") {
    const cfg = config ?? exports.DEFAULT_VEGAM_CONFIG;
    // Condition 1: Toxic flow takes absolute risk priority
    if (Number.isFinite(vpin) && vpin >= cfg.vpinToxicFloor) {
        return 0.5;
    }
    // Condition 2: High order intensity momentum extension
    if (Number.isFinite(hawkes) && hawkes >= cfg.hawkesExpansionThreshold) {
        return 2.0;
    }
    // Conditions 3, 4, 5: Directional Order Book Imbalance (OBI)
    const safeObi = Number.isFinite(obi) ? obi : 0.0;
    const directionalObi = side === "SHORT" ? -safeObi : safeObi;
    if (directionalObi < cfg.obiTightenThreshold) {
        return 0.8;
    }
    if (directionalObi > cfg.obiExpandThreshold) {
        return 1.2;
    }
    return 1.0;
}
/**
 * Computes OBI-Weighted Dynamic Trailing Distance:
 * TrailDist_t = GK_ATR_composite * k_regime(t) [* entryPrice]
 */
function computeObiWeightedTrailDistance(gkAtr, obi, vpin, hawkes, config, entryPrice, side = "LONG") {
    const cfg = config ?? exports.DEFAULT_VEGAM_CONFIG;
    const safeAtr = Number.isFinite(gkAtr) && gkAtr > 0 ? gkAtr : 0.00906;
    const kRegime = computeKRegime(obi, vpin, hawkes, cfg, side);
    const relativeTrail = safeAtr * kRegime;
    if (typeof entryPrice === "number" && entryPrice > 0) {
        return relativeTrail * entryPrice;
    }
    return relativeTrail;
}
/**
 * Computes ATR-Anchored Take-Profit Ladder Levels:
 * TP1: entry + max(1 * GK_ATR, RPM_min)
 * TP2: entry + max(2.5 * GK_ATR, 2 * RPM_min)
 * TP3: peakPrice - 0.8 * GK_ATR (trailing distance)
 */
function computeVegamTpLevels(entryPrice, gkAtrComposite, leverage, side, config, totalQuantity) {
    const cfg = config ?? exports.DEFAULT_VEGAM_CONFIG;
    const safePrice = Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : 1.0;
    const safeAtr = Number.isFinite(gkAtrComposite) && gkAtrComposite > 0 ? gkAtrComposite : 0.00906;
    const rpmMin = computeRpmMin(leverage, cfg.makerFee, cfg.takerFee);
    // Assert TP1 offset is always >= RPM_min to guarantee round-trip fee coverage
    const tp1Offset = Math.max(cfg.tp1AtrMultiplier * safeAtr, rpmMin);
    const tp2Offset = Math.max(cfg.tp2AtrMultiplier * safeAtr, 2.0 * rpmMin);
    const isLong = side === "LONG";
    const tp1Price = isLong ? safePrice * (1.0 + tp1Offset) : safePrice * (1.0 - tp1Offset);
    const tp2Price = isLong ? safePrice * (1.0 + tp2Offset) : safePrice * (1.0 - tp2Offset);
    const tp3TrailingDist = cfg.tp3TrailAtrMultiplier * safeAtr * safePrice;
    let tp1Qty;
    let tp2Qty;
    let tp3Qty;
    if (typeof totalQuantity === "number" && totalQuantity > 0) {
        tp1Qty = totalQuantity * cfg.tp1SizeRatio;
        tp2Qty = totalQuantity * cfg.tp2SizeRatio;
        tp3Qty = Math.max(0, totalQuantity - tp1Qty - tp2Qty);
    }
    else {
        tp1Qty = cfg.tp1SizeRatio;
        tp2Qty = cfg.tp2SizeRatio;
        tp3Qty = cfg.tp3SizeRatio;
    }
    return {
        tp1Price,
        tp2Price,
        tp1Qty,
        tp2Qty,
        tp3Qty,
        tp1Offset,
        tp2Offset,
        tp3TrailingDist,
        rpmMin,
    };
}
/**
 * High-Performance Zero-GC Tick State Machine
 *
 * Mutates slot state in-place and reuses pre-allocated result structures.
 * Performs zero heap allocations per tick evaluation.
 */
class VegamTpLadderEngine {
    config;
    // Zero-GC Pre-allocated Cached Result Payload Ring Buffer (8 slots)
    tickResultRing = Array.from({ length: 8 }, () => ({
        action: "NONE",
        kRegime: 1.0,
        trailDist: 0.0,
        proposedSl: 0.0,
        currentSl: 0.0,
        tp1Hit: false,
        tp2Hit: false,
        slHit: false,
        rawRoePct: 0.0,
        peakRoe: 0.0,
    }));
    tickRingIdx = 0;
    constructor(config) {
        this.config = config ? { ...exports.DEFAULT_VEGAM_CONFIG, ...config } : { ...exports.DEFAULT_VEGAM_CONFIG };
    }
    getConfig() {
        return this.config;
    }
    computeVegamTpLevels(entryPrice, gkAtrComposite, leverage, side, totalQuantity) {
        return computeVegamTpLevels(entryPrice, gkAtrComposite, leverage, side, this.config, totalQuantity);
    }
    computeRpmMin(leverage) {
        return computeRpmMin(leverage, this.config.makerFee, this.config.takerFee);
    }
    computeObiWeightedTrailDistance(gkAtr, obi, vpin, hawkes, entryPrice, side = "LONG") {
        return computeObiWeightedTrailDistance(gkAtr, obi, vpin, hawkes, this.config, entryPrice, side);
    }
    computeKRegime(obi, vpin, hawkes, side = "LONG") {
        return computeKRegime(obi, vpin, hawkes, this.config, side);
    }
    /**
     * Instance zero-GC tick state machine evaluation
     */
    tick(slot, markPrice, stoikovMicroPrice, obi, vpin, hawkes, gkAtrComposite, leverage) {
        const res = this.tickResultRing[this.tickRingIdx];
        this.tickRingIdx = (this.tickRingIdx + 1) & 7;
        return VegamTpLadderEngine.evaluateTickInternal(slot, markPrice, stoikovMicroPrice, obi, vpin, hawkes, gkAtrComposite, leverage, this.config, res);
    }
    /**
     * Static zero-GC tick state machine evaluation
     */
    static tick(slot, markPrice, stoikovMicroPrice, obi, vpin, hawkes, gkAtrComposite, leverage, config) {
        return VegamTpLadderEngine.evaluateTickInternal(slot, markPrice, stoikovMicroPrice, obi, vpin, hawkes, gkAtrComposite, leverage, config ?? exports.DEFAULT_VEGAM_CONFIG, STATIC_TICK_RESULT);
    }
    static evaluateTickInternal(slot, markPrice, stoikovMicroPrice, obi, vpin, hawkes, gkAtrComposite, leverage, cfg, out) {
        // Reset out struct fields
        out.action = "NONE";
        out.kRegime = 1.0;
        out.trailDist = 0.0;
        out.proposedSl = 0.0;
        out.currentSl = slot.stopLossPrice;
        out.tp1Hit = false;
        out.tp2Hit = false;
        out.slHit = false;
        out.rawRoePct = 0.0;
        out.peakRoe = slot.peakRoe ?? 0.0;
        if (!slot.isOccupied || markPrice <= 0 || slot.entryPrice <= 0) {
            return out;
        }
        const isLong = slot.side === "LONG";
        const effLev = typeof leverage === "number" && leverage > 0 ? leverage : 20.0;
        // 1. Monotonic Peak/Trough Tracking
        if (isLong) {
            if (!slot.peakPrice || markPrice > slot.peakPrice) {
                slot.peakPrice = markPrice;
            }
        }
        else {
            if (!slot.troughPrice || slot.troughPrice <= 0 || markPrice < slot.troughPrice) {
                slot.troughPrice = markPrice;
            }
        }
        // 2. Return on Equity (ROE) Calculation
        const priceDiff = isLong ? (markPrice - slot.entryPrice) : (slot.entryPrice - markPrice);
        const rawRoePct = (priceDiff / slot.entryPrice) * effLev * 100.0;
        out.rawRoePct = rawRoePct;
        if (!slot.peakRoe || rawRoePct > slot.peakRoe) {
            slot.peakRoe = rawRoePct;
        }
        out.peakRoe = slot.peakRoe;
        // 3. Dynamic k_regime Calculation (Zero allocation)
        const kRegime = computeKRegime(obi, vpin, hawkes, cfg, slot.side);
        out.kRegime = kRegime;
        // 4. Volatility Scaling & Trailing Distance
        const safeAtr = typeof gkAtrComposite === "number" && gkAtrComposite > 0 ? gkAtrComposite : 0.00906;
        const trailDist = safeAtr * kRegime * slot.entryPrice;
        out.trailDist = trailDist;
        // 5. Layer 1: TP1 Hit Evaluation & Risk-Free SL Ratchet
        if (slot.takeProfitPrice > 0) {
            const isTp1Reached = isLong ? markPrice >= slot.takeProfitPrice : markPrice <= slot.takeProfitPrice;
            if (isTp1Reached) {
                out.tp1Hit = true;
                if (!slot.tpStageReached || slot.tpStageReached < 1) {
                    slot.tpStageReached = 1;
                    slot.breakEvenLocked = true;
                    // Ratchet SL to entry price to secure 100% risk-free trade on remainder
                    if (isLong) {
                        if (slot.stopLossPrice < slot.entryPrice) {
                            slot.stopLossPrice = slot.entryPrice;
                        }
                    }
                    else {
                        if (slot.stopLossPrice <= 0 || slot.stopLossPrice > slot.entryPrice) {
                            slot.stopLossPrice = slot.entryPrice;
                        }
                    }
                    out.action = "TP1_RATCHET";
                }
            }
        }
        // 6. Layer 2: OBI-Weighted Dynamic Trailing SL
        // Activates once rawRoePct >= trailActivationRoePct (0.50%) or peakRoe >= trailActivationRoePct
        const isTrailActive = rawRoePct >= cfg.trailActivationRoePct || (slot.peakRoe ?? 0) >= cfg.trailActivationRoePct;
        if (isTrailActive) {
            if (isLong) {
                const proposedSl = (slot.peakPrice ?? markPrice) - trailDist;
                out.proposedSl = proposedSl;
                if (proposedSl > slot.stopLossPrice) {
                    slot.stopLossPrice = proposedSl;
                    if (out.action === "NONE") {
                        out.action = "TRAIL_UPDATED";
                    }
                }
            }
            else {
                const proposedSl = (slot.troughPrice ?? markPrice) + trailDist;
                out.proposedSl = proposedSl;
                if (slot.stopLossPrice <= 0 || proposedSl < slot.stopLossPrice) {
                    slot.stopLossPrice = proposedSl;
                    if (out.action === "NONE") {
                        out.action = "TRAIL_UPDATED";
                    }
                }
            }
        }
        out.currentSl = slot.stopLossPrice;
        // 7. Stop-Loss Trigger Evaluation
        if (isLong) {
            if (slot.stopLossPrice > 0 && markPrice <= slot.stopLossPrice) {
                out.slHit = true;
                out.action = "SL_TRIGGERED";
            }
        }
        else {
            if (slot.stopLossPrice > 0 && markPrice >= slot.stopLossPrice) {
                out.slHit = true;
                out.action = "SL_TRIGGERED";
            }
        }
        return out;
    }
}
exports.VegamTpLadderEngine = VegamTpLadderEngine;
