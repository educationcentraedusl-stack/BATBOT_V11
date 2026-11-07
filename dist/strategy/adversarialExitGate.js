"use strict";
/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * VEGAM Phase 6: Adversarial Exit Gate (Layer 4 Defensive Shield)
 *
 * Implements Layer 4 (Adversarial Order Flow Emergency Exit Gate) per
 * the VEGAM Master Implementation Plan (2026 SOTA Exit Architecture).
 *
 * Core Functionality:
 * Evaluates real-time microstructural order flow toxicity, rapid mid-price drift,
 * and multi-signal consensus. When >= adversarialMinSignals (default: 2) independent
 * anomaly signals fire simultaneously concurrently with an adverse price velocity shock
 * exceeding the dynamic ATR threshold, triggers an immediate aggressive market exit:
 * executionStyle = "AGGRESSIVE_MARKET"
 * reason = "ADVERSARIAL_CASCADE_EXIT_${slot.side}"
 *
 * Zero-GC Invariant:
 * Pre-allocated singleton and circular result payload ring buffer ensuring < 0.5 µs latency.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdversarialExitGate = exports.DEFAULT_ADVERSARIAL_CONFIG = void 0;
const urgencyRouter_1 = require("./urgencyRouter");
exports.DEFAULT_ADVERSARIAL_CONFIG = Object.freeze({
    adversarialMinSignals: 2,
    vpinToxicFloor: 0.65,
    hawkesExpansionThreshold: 1.80,
    obiTightenThreshold: -0.20,
    obiExpandThreshold: 0.20,
    atrVelocityMultiplier: 1.25,
    minHoldingSeconds: 0.0,
    entropyAnomalyThreshold: 2.80,
    ofiAdverseThreshold: -0.40,
});
class AdversarialExitGate {
    config;
    // Zero-GC Pre-allocated Cached Result Payload Ring Buffer (8 slots)
    resultRing = Array.from({ length: 8 }, () => ({
        isBreached: false,
        activeSignalCount: 0,
        signals: {
            obiReversal: false,
            toxicVpin: false,
            adverseFlow: false,
            hawkesBurst: false,
            adverseSweep: false,
            entropyCollapse: false,
            priceVelocityShock: false,
        },
        adverseVelocity: 0,
        thresholdVelocity: 0,
        reason: "",
        urgencyScore: 0,
        executionStyle: "PASSIVE_MAKER",
    }));
    ringIdx = 0;
    // Pre-allocated static singleton for zero-GC static evaluation
    static STATIC_RESULT = {
        isBreached: false,
        activeSignalCount: 0,
        signals: {
            obiReversal: false,
            toxicVpin: false,
            adverseFlow: false,
            hawkesBurst: false,
            adverseSweep: false,
            entropyCollapse: false,
            priceVelocityShock: false,
        },
        adverseVelocity: 0,
        thresholdVelocity: 0,
        reason: "",
        urgencyScore: 0,
        executionStyle: "PASSIVE_MAKER",
    };
    constructor(config) {
        this.config = config ? { ...exports.DEFAULT_ADVERSARIAL_CONFIG, ...config } : { ...exports.DEFAULT_ADVERSARIAL_CONFIG };
    }
    getConfig() {
        return this.config;
    }
    /**
     * Evaluates the Adversarial Exit Gate on an occupied position slot.
     * Hot-path zero heap allocation execution (< 0.5 µs latency).
     */
    evaluate(slot, markPrice, hazardMetrics, gkAtrComposite, hawkesIntensity, isSweepDetected, lobEntropy, nowMs = 0) {
        const out = this.resultRing[this.ringIdx];
        this.ringIdx = (this.ringIdx + 1) & 7;
        return AdversarialExitGate.evaluateInternal(slot, markPrice, hazardMetrics, gkAtrComposite, hawkesIntensity, isSweepDetected, lobEntropy, nowMs, this.config, out);
    }
    /**
     * Static evaluation using pre-allocated singleton
     */
    static evaluate(slot, markPrice, hazardMetrics, gkAtrComposite, hawkesIntensity, isSweepDetected, lobEntropy, nowMs = 0, config) {
        return AdversarialExitGate.evaluateInternal(slot, markPrice, hazardMetrics, gkAtrComposite, hawkesIntensity, isSweepDetected, lobEntropy, nowMs, config ?? exports.DEFAULT_ADVERSARIAL_CONFIG, AdversarialExitGate.STATIC_RESULT);
    }
    static evaluateInternal(slot, markPrice, hazardMetrics, gkAtrComposite, hawkesIntensity, isSweepDetected, lobEntropy, nowMs, cfg, out) {
        // Reset output struct
        out.isBreached = false;
        out.activeSignalCount = 0;
        out.signals.obiReversal = false;
        out.signals.toxicVpin = false;
        out.signals.adverseFlow = false;
        out.signals.hawkesBurst = false;
        out.signals.adverseSweep = false;
        out.signals.entropyCollapse = false;
        out.signals.priceVelocityShock = false;
        out.adverseVelocity = 0;
        out.thresholdVelocity = 0;
        out.reason = "";
        out.urgencyScore = 0;
        out.executionStyle = "PASSIVE_MAKER";
        if (!slot.isOccupied || slot.quantity <= 0 || slot.entryPrice <= 0 || markPrice <= 0) {
            return out;
        }
        if (cfg.minHoldingSeconds > 0) {
            const openTime = (slot.originalOpenTime && slot.originalOpenTime > 0)
                ? slot.originalOpenTime
                : (slot.openTime && slot.openTime > 0 ? slot.openTime : nowMs);
            const effectiveNow = nowMs > 0 ? nowMs : Date.now();
            const durationSec = Math.max(0, (effectiveNow - openTime) / 1000);
            if (durationSec < cfg.minHoldingSeconds) {
                return out;
            }
        }
        const isLong = slot.side === "LONG";
        const safeAtr = (typeof gkAtrComposite === "number" && Number.isFinite(gkAtrComposite) && gkAtrComposite > 0)
            ? gkAtrComposite
            : 0.00906;
        // -------------------------------------------------------------------------
        // 1. Adverse Price Velocity Shock Evaluation
        // Measures price divergence against position entry / peak
        // -------------------------------------------------------------------------
        const adversePriceMove = isLong ? (slot.entryPrice - markPrice) : (markPrice - slot.entryPrice);
        const adverseMovePct = (adversePriceMove / slot.entryPrice);
        const thresholdVelocity = cfg.atrVelocityMultiplier * safeAtr;
        out.adverseVelocity = adverseMovePct;
        out.thresholdVelocity = thresholdVelocity;
        const isPriceShock = adverseMovePct >= thresholdVelocity;
        out.signals.priceVelocityShock = isPriceShock;
        // -------------------------------------------------------------------------
        // 2. Microstructure Toxicity & Reversal Signals
        // -------------------------------------------------------------------------
        const liveObi = hazardMetrics && Number.isFinite(hazardMetrics.obi) ? hazardMetrics.obi : 0.0;
        const liveVpin = hazardMetrics && Number.isFinite(hazardMetrics.vpin) ? hazardMetrics.vpin : 0.0;
        const liveOfi = hazardMetrics && Number.isFinite(hazardMetrics.ofi) ? hazardMetrics.ofi : 0.0;
        const liveTfi = hazardMetrics && Number.isFinite(hazardMetrics.tfi) ? hazardMetrics.tfi : 0.0;
        const liveHawkes = typeof hawkesIntensity === "number" && Number.isFinite(hawkesIntensity) ? hawkesIntensity : 1.0;
        const liveSweep = Boolean(isSweepDetected);
        const liveEntropy = typeof lobEntropy === "number" && Number.isFinite(lobEntropy) ? lobEntropy : 1.0;
        // Signal A: Directional OBI Reversal (Book depth pressure aggressively against position)
        const isObiReversed = isLong
            ? (liveObi < cfg.obiTightenThreshold)
            : (liveObi > cfg.obiExpandThreshold);
        out.signals.obiReversal = isObiReversed;
        // Signal B: Toxic Order Flow / Informed Trading Spike (VPIN >= 0.65)
        const isToxicVpin = liveVpin >= cfg.vpinToxicFloor;
        out.signals.toxicVpin = isToxicVpin;
        // Signal C: Adverse Flow Imbalance (OFI / TFI order flow delta against position)
        const isAdverseFlow = isLong
            ? (liveOfi < cfg.ofiAdverseThreshold || liveTfi < cfg.ofiAdverseThreshold)
            : (liveOfi > -cfg.ofiAdverseThreshold || liveTfi > -cfg.ofiAdverseThreshold);
        out.signals.adverseFlow = isAdverseFlow;
        // Signal D: Hawkes Intensity Burst (High order arrival frequency concurrent with adverse book pressure)
        const isHawkesBurst = liveHawkes >= cfg.hawkesExpansionThreshold && (isLong ? liveObi < 0 : liveObi > 0);
        out.signals.hawkesBurst = isHawkesBurst;
        // Signal E: Adverse Liquidity Sweep (Aggressive order sweep against position)
        const isAdverseSweep = liveSweep && (isLong ? (liveObi < 0 || markPrice < slot.entryPrice) : (liveObi > 0 || markPrice > slot.entryPrice));
        out.signals.adverseSweep = isAdverseSweep;
        // Signal F: Limit Order Book Entropy Collapse (Book dispersion breakdown)
        const isEntropyCollapse = liveEntropy >= cfg.entropyAnomalyThreshold;
        out.signals.entropyCollapse = isEntropyCollapse;
        // -------------------------------------------------------------------------
        // 3. Multi-Signal Consensus Aggregation
        // Count independent microstructural signals firing simultaneously
        // -------------------------------------------------------------------------
        let activeSignalCount = 0;
        if (isObiReversed)
            activeSignalCount++;
        if (isToxicVpin)
            activeSignalCount++;
        if (isAdverseFlow)
            activeSignalCount++;
        if (isHawkesBurst)
            activeSignalCount++;
        if (isAdverseSweep)
            activeSignalCount++;
        if (isEntropyCollapse)
            activeSignalCount++;
        out.activeSignalCount = activeSignalCount;
        // -------------------------------------------------------------------------
        // 4. Breach Evaluation & Dynamic Urgency Resolution (Phase 4)
        // Consensus >= adversarialMinSignals (default: 2) concurrently with
        // adverse price velocity shock exceeding dynamic ATR threshold.
        // -------------------------------------------------------------------------
        const openTime = (slot.originalOpenTime && slot.originalOpenTime > 0)
            ? slot.originalOpenTime
            : (slot.openTime && slot.openTime > 0 ? slot.openTime : nowMs);
        const effectiveNow = nowMs > 0 ? nowMs : Date.now();
        const durationSec = Math.max(0, (effectiveNow - openTime) / 1000);
        const queueRatio = liveSweep ? 1.0 : 0.0;
        const urgency = urgencyRouter_1.DynamicUrgencyRouter.compute(activeSignalCount, cfg.adversarialMinSignals, durationSec, 360.0, queueRatio, liveVpin);
        if (activeSignalCount >= cfg.adversarialMinSignals && isPriceShock) {
            out.isBreached = true;
            out.reason = `ADVERSARIAL_CASCADE_EXIT_${slot.side}`;
            // In a verified catastrophic breach (consensus anomaly + price collapse), urgency is critical (>= 0.75)
            out.urgencyScore = Math.max(0.75, urgency.compositeUrgency);
            out.executionStyle = "AGGRESSIVE_MARKET";
        }
        else {
            out.urgencyScore = urgency.compositeUrgency;
            out.executionStyle = urgency.executionStyle;
        }
        return out;
    }
}
exports.AdversarialExitGate = AdversarialExitGate;
