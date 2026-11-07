"use strict";
/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * Master HFT Overhaul Phase 4: Dynamic Exit Urgency Router
 *
 * Eradicates "Fee Drag" (losing small profits to 4.5 bps taker fees) by dynamically
 * transitioning between PASSIVE_MAKER (1.8 bps) and AGGRESSIVE_MARKET (4.5 bps)
 * using a continuous Urgency Score U in [0.0, 1.0].
 *
 * Mathematical Invariant:
 * U = (Adversarial * 0.40) + (Age * 0.30) + (Queue * 0.20) + (VPIN * 0.10)
 *
 * Execution Style Routing Table:
 * 0.00 - 0.49: PASSIVE_MAKER
 * 0.50 - 0.74: PASSIVE_MAKER (with 2-tick aggressive offset)
 * 0.75 - 0.89: AGGRESSIVE_MARKET
 * 0.90 - 1.00: AGGRESSIVE_MARKET immediate
 *
 * Zero-GC Invariant:
 * Pre-allocated static/singleton result object mutated in-place. Zero `new` allocations
 * in the evaluation hot-path (< 0.15 µs SLA, < 50 bytes/call Heap Delta).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamicUrgencyRouter = void 0;
class DynamicUrgencyRouter {
    static W_ADVERSARIAL = 0.40;
    static W_AGE = 0.30;
    static W_QUEUE = 0.20;
    static W_VPIN = 0.10;
    // Zero-GC pre-allocated static singleton result object
    static RESULT = {
        adversarialScore: 0.0,
        ageScore: 0.0,
        queueScore: 0.0,
        vpinScore: 0.0,
        compositeUrgency: 0.0,
        executionStyle: "PASSIVE_MAKER",
        tickOffset: 0,
        isImmediate: false,
    };
    // Pre-allocated instance result object for instance-based usage
    instanceResult = {
        adversarialScore: 0.0,
        ageScore: 0.0,
        queueScore: 0.0,
        vpinScore: 0.0,
        compositeUrgency: 0.0,
        executionStyle: "PASSIVE_MAKER",
        tickOffset: 0,
        isImmediate: false,
    };
    /**
     * Evaluates the dynamic urgency score and resolves execution style.
     * Supports both 4 normalized components in [0.0, 1.0] or 6 raw metrics.
     * Hot-path Zero-GC execution (< 0.15 µs latency, 0 heap allocations).
     */
    compute(adversarialOrActiveSignals, ageOrMinSignals, queueOrAgeSec, vpinOrMhdcSec, queueDepthRatio, vpinRaw) {
        return DynamicUrgencyRouter.computeInternal(adversarialOrActiveSignals, ageOrMinSignals, queueOrAgeSec, vpinOrMhdcSec, queueDepthRatio, vpinRaw, this.instanceResult);
    }
    /**
     * Static evaluation using global pre-allocated singleton (Zero-GC).
     */
    static compute(adversarialOrActiveSignals, ageOrMinSignals, queueOrAgeSec, vpinOrMhdcSec, queueDepthRatio, vpinRaw) {
        return DynamicUrgencyRouter.computeInternal(adversarialOrActiveSignals, ageOrMinSignals, queueOrAgeSec, vpinOrMhdcSec, queueDepthRatio, vpinRaw, DynamicUrgencyRouter.RESULT);
    }
    static computeInternal(arg0, arg1, arg2, arg3, arg4, arg5, out) {
        let advScore = 0.0;
        let ageScore = 0.0;
        let queueScore = 0.0;
        let vpinScore = 0.0;
        if (arg4 !== undefined && arg5 !== undefined) {
            // 6 raw metric arguments:
            // (activeSignals, minSignalsRequired, positionAgeSec, mhdcSec, queueDepthRatio, vpin)
            const activeSignals = Number.isFinite(arg0) ? Math.max(0.0, arg0) : 0.0;
            const minSignals = Number.isFinite(arg1) && arg1 > 0 ? arg1 : 1.0;
            const positionAgeSec = Number.isFinite(arg2) ? Math.max(0.0, arg2) : 0.0;
            const mhdcSec = Number.isFinite(arg3) && arg3 > 0 ? arg3 : 1.0;
            const queueRatio = Number.isFinite(arg4) ? Math.max(0.0, arg4) : 0.0;
            const vpinVal = Number.isFinite(arg5) ? Math.max(0.0, arg5) : 0.0;
            advScore = Math.min(1.0, activeSignals / minSignals);
            ageScore = Math.min(1.0, positionAgeSec / mhdcSec);
            queueScore = Math.min(1.0, queueRatio);
            vpinScore = Math.min(1.0, vpinVal);
        }
        else {
            // 4 normalized component arguments:
            // (adversarial, age, queue, vpin) each in [0.0, 1.0]
            advScore = Number.isFinite(arg0) ? Math.min(1.0, Math.max(0.0, arg0)) : 0.0;
            ageScore = Number.isFinite(arg1) ? Math.min(1.0, Math.max(0.0, arg1)) : 0.0;
            queueScore = Number.isFinite(arg2) ? Math.min(1.0, Math.max(0.0, arg2)) : 0.0;
            vpinScore = Number.isFinite(arg3) ? Math.min(1.0, Math.max(0.0, arg3)) : 0.0;
        }
        out.adversarialScore = advScore;
        out.ageScore = ageScore;
        out.queueScore = queueScore;
        out.vpinScore = vpinScore;
        // Exact Math: U = (Adversarial * 0.40) + (Age * 0.30) + (Queue * 0.20) + (VPIN * 0.10)
        // Round to 8 decimal places to eliminate floating point representation artifacts near boundaries
        const rawU = (advScore * DynamicUrgencyRouter.W_ADVERSARIAL) +
            (ageScore * DynamicUrgencyRouter.W_AGE) +
            (queueScore * DynamicUrgencyRouter.W_QUEUE) +
            (vpinScore * DynamicUrgencyRouter.W_VPIN);
        const clampedU = Math.min(1.0, Math.max(0.0, Math.round(rawU * 1e8) / 1e8));
        out.compositeUrgency = clampedU;
        // Execution Style routing table:
        // 0.00 - 0.49: PASSIVE_MAKER
        // 0.50 - 0.74: PASSIVE_MAKER (with 2-tick aggressive offset)
        // 0.75 - 0.89: AGGRESSIVE_MARKET
        // 0.90 - 1.00: AGGRESSIVE_MARKET immediate
        if (clampedU < 0.50) {
            out.executionStyle = "PASSIVE_MAKER";
            out.tickOffset = 0;
            out.isImmediate = false;
        }
        else if (clampedU < 0.75) {
            out.executionStyle = "PASSIVE_MAKER";
            out.tickOffset = 2; // 2-tick aggressive offset
            out.isImmediate = false;
        }
        else if (clampedU < 0.90) {
            out.executionStyle = "AGGRESSIVE_MARKET";
            out.tickOffset = 0;
            out.isImmediate = false;
        }
        else {
            out.executionStyle = "AGGRESSIVE_MARKET";
            out.tickOffset = 0;
            out.isImmediate = true; // immediate market execution
        }
        return out;
    }
    resolveExecutionStyle(urgency) {
        return DynamicUrgencyRouter.resolveExecutionStyle(urgency);
    }
    static resolveExecutionStyle(urgency) {
        return urgency >= 0.75 ? "AGGRESSIVE_MARKET" : "PASSIVE_MAKER";
    }
    resolveTickOffset(urgency) {
        return DynamicUrgencyRouter.resolveTickOffset(urgency);
    }
    static resolveTickOffset(urgency) {
        return (urgency >= 0.50 && urgency < 0.75) ? 2 : 0;
    }
    isImmediateMarket(urgency) {
        return DynamicUrgencyRouter.isImmediateMarket(urgency);
    }
    static isImmediateMarket(urgency) {
        return urgency >= 0.90;
    }
}
exports.DynamicUrgencyRouter = DynamicUrgencyRouter;
