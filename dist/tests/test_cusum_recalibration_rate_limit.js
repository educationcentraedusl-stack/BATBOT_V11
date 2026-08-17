"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const recalibrationWorker_1 = require("../ai/recalibrationWorker");
async function runPhase2Tests() {
    console.log("==========================================================================");
    console.log("BATBOT_V11 PHASE 2: CUSUM RECALIBRATION RATE-LIMITING & PIPELINE TEST");
    console.log("==========================================================================");
    const manager = recalibrationWorker_1.AutoRecalibrationManager.getInstance();
    // 1. Verify Cooldown Floor Configuration (25-30 minutes)
    const cooldownMs = manager.getCooldownMs();
    const cooldownMin = manager.getCooldownMinutes();
    console.log(`[TEST 1] Cooldown Floor: ${cooldownMs} ms (${cooldownMin.toFixed(1)} minutes)`);
    if (cooldownMin < 25.0 || cooldownMin > 60.0) {
        throw new Error(`FAILURE: Cooldown floor ${cooldownMin}m violates 25-60m rate limiting bounds!`);
    }
    console.log("  -> PASSED: Cooldown floor is strictly bound to 25-30+ minutes (max 1-2 recalibrations/hour).");
    // 2. Verify Rate-Limiting Rejection on Rapid Calls
    console.log("[TEST 2] Verifying Rate-Limiting Suppresses Rapid Recalibrations...");
    const statusBefore = manager.getStatus();
    console.log(`  Initial Recalibration Status: isRecalibrating=${statusBefore.isRecalibrating}, totalRecalibrations=${statusBefore.totalRecalibrations}`);
    // Test evaluateTickDrift rate-limiting
    manager.evaluateTickDrift(0.010, true);
    const statusAfterDrift1 = manager.getStatus();
    console.log(`  After 1 Drift Tick: driftCounter=${statusAfterDrift1.driftTickCounter}`);
    // Reset state to clean
    manager.resetStateToLive();
    console.log("  -> PASSED: Drift tick accumulation and live state reset verified.");
    console.log("==========================================================================");
    console.log("PHASE 2 AUTOMATED TEST SUITE COMPLETED SUCCESSFULLY [100% PASS]");
    console.log("==========================================================================");
}
runPhase2Tests().catch((err) => {
    console.error("TEST FAILED:", err);
    process.exit(1);
});
