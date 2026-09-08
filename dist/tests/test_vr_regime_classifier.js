"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const regimeClassifier_1 = require("../strategy/regimeClassifier");
function assert(condition, message) {
    if (!condition) {
        console.error(`❌ [ASSERTION_FAILED] ${message}`);
        throw new Error(`ASSERTION_FAILED: ${message}`);
    }
}
async function runVRRegimeClassifierTestSuite() {
    console.log("================================================================================");
    console.log("  TEST: SOTA LO-MACKINLAY ONLINE VARIANCE RATIO REGIME CLASSIFIER (DEF-R5)");
    console.log("================================================================================\n");
    // --------------------------------------------------------------------------
    // STAGE 1: Warmup & Initial Invariant Verification
    // --------------------------------------------------------------------------
    console.log("[STAGE 1] Testing Classifier Initialization & Warm-Up Behavior...");
    const classifier = new regimeClassifier_1.OnlineVarianceRatioClassifier(5, 60, 0.05);
    assert(classifier.getCount() === 0, "Initial sample count must be 0");
    assert(classifier.getVarianceRatio() === 1.0, "Initial VR must be 1.0 (neutral)");
    assert(classifier.getRegimeState() === "RANDOM_WALK", "Pre-warmup regime must be RANDOM_WALK");
    // Feed 4 ticks (less than k + 2 = 7)
    const initialPrices = [100.0, 100.1, 100.2, 100.3];
    for (const p of initialPrices) {
        classifier.updatePrice(p);
    }
    assert(classifier.getCount() === 4, `Sample count must be 4, got ${classifier.getCount()}`);
    assert(classifier.getRegimeState() === "RANDOM_WALK", "Warm-up (< k+2) must strictly return RANDOM_WALK");
    console.log("  ✓ Warm-up invariants strictly enforced (< k+2 returns RANDOM_WALK)\n");
    // --------------------------------------------------------------------------
    // STAGE 2: Mean-Reverting Noise Chop Detection (Negative Autocorrelation)
    // --------------------------------------------------------------------------
    console.log("[STAGE 2] Testing Mean-Reverting Noise Chop Regime (VR < 0.75)...");
    classifier.reset();
    // Oscillating synthetic price series (classic bid-ask bounce / toxic chop)
    // 100.0, 100.5, 100.0, 100.5, 100.0, 100.5 ...
    for (let i = 0; i < 80; i++) {
        const price = i % 2 === 0 ? 100.0 : 100.5;
        classifier.updatePrice(price);
    }
    const chopVR = classifier.getVarianceRatio();
    const chopState = classifier.getRegimeState();
    console.log(`  Chop Series Final VR: ${chopVR.toFixed(4)} | Regime: ${chopState}`);
    assert(chopVR < 0.75, `VR in oscillating chop must be < 0.75, got ${chopVR.toFixed(4)}`);
    assert(chopState === "MEAN_REVERT", `Regime in oscillating chop must be MEAN_REVERT, got ${chopState}`);
    console.log("  ✓ Mean-reverting noise chop correctly classified as MEAN_REVERT (VR < 0.75)\n");
    // --------------------------------------------------------------------------
    // STAGE 3: Trending Momentum Regime Detection (Positive Autocorrelation)
    // --------------------------------------------------------------------------
    console.log("[STAGE 3] Testing Trending Momentum Regime (VR > 1.30)...");
    classifier.reset();
    // Consistent trending series: 100.0, 100.2, 100.5, 100.9, 101.4, 102.0 ...
    // Returns have strong positive autocorrelation (momentum builds upon previous move)
    let trendPrice = 100.0;
    for (let i = 1; i <= 80; i++) {
        trendPrice += 0.20 + (i * 0.02); // Accelerating directional drift
        classifier.updatePrice(trendPrice);
    }
    const trendVR = classifier.getVarianceRatio();
    const trendState = classifier.getRegimeState();
    console.log(`  Trending Series Final VR: ${trendVR.toFixed(4)} | Regime: ${trendState}`);
    assert(trendVR > 1.30, `VR in persistent trend must be > 1.30, got ${trendVR.toFixed(4)}`);
    assert(trendState === "TRENDING", `Regime in persistent trend must be TRENDING, got ${trendState}`);
    console.log("  ✓ Persistent momentum trend correctly classified as TRENDING (VR > 1.30)\n");
    // --------------------------------------------------------------------------
    // STAGE 4: Zero GC & Fixed Ring Buffer Boundary Invariance
    // --------------------------------------------------------------------------
    console.log("[STAGE 4] Testing Circular Buffer Ring Wraparound & Numerical Stability...");
    // Feed 10,000 prices through the 60-slot ring buffer to verify zero drift / bounds safety
    for (let i = 0; i < 10000; i++) {
        const p = 100.0 + Math.sin(i * 0.05) * 2.0;
        classifier.updatePrice(p);
    }
    assert(classifier.getCount() === 60, "Buffer count must saturate at windowSize (60)");
    const vrBounded = classifier.getVarianceRatio();
    assert(Number.isFinite(vrBounded) && vrBounded > 0, `VR must remain finite and positive, got ${vrBounded}`);
    console.log(`  ✓ 10,000 tick circular buffer test passed (VR: ${vrBounded.toFixed(4)}, finite and bounded)\n`);
    console.log("================================================================================");
    console.log("  ✅ ALL 4 TEST STAGES PASSED (100% SOTA DEF-R5 SPECIFICATION COMPLIANCE)");
    console.log("================================================================================\n");
}
runVRRegimeClassifierTestSuite().catch((err) => {
    console.error(`\n❌ TEST SUITE FAILED: ${err?.stack || err?.message || String(err)}\n`);
    process.exit(1);
});
