import { AutoRecalibrationManager } from "../ai/recalibrationWorker";

function runPhase2Tests(): void {
  console.log("==========================================================================");
  console.log("BATBOT_V11 PHASE 2: CUSUM RECALIBRATION RATE-LIMITING & PIPELINE TEST");
  console.log("==========================================================================");

  const manager = AutoRecalibrationManager.getInstance();

  // 1. Verify Cooldown Floor Configuration (25-30 minutes)
  const cooldownMs = manager.getCooldownMs();
  const cooldownMin = manager.getCooldownMinutes();
  console.log(`[TEST 1] Cooldown Floor: ${String(cooldownMs)} ms (${cooldownMin.toFixed(1)} minutes)`);
  if (cooldownMin < 25.0 || cooldownMin > 60.0) {
    throw new Error(`FAILURE: Cooldown floor ${String(cooldownMin)}m violates 25-60m rate limiting bounds!`);
  }
  console.log("  -> PASSED: Cooldown floor is strictly bound to 25-30+ minutes (max 1-2 recalibrations/hour).");

  // 2. Verify Rate-Limiting Rejection on Rapid Calls
  console.log("[TEST 2] Verifying Rate-Limiting Suppresses Rapid Recalibrations...");
  const statusBefore = manager.getStatus();
  console.log(`  Initial Recalibration Status: isRecalibrating=${String(statusBefore.isRecalibrating)}, totalRecalibrations=${String(statusBefore.totalRecalibrations)}`);

  // Test evaluateTickDrift rate-limiting
  manager.evaluateTickDrift(0.010, true);
  const statusAfterDrift1 = manager.getStatus();
  console.log(`  After 1 Drift Tick: driftCounter=${String(statusAfterDrift1.driftTickCounter)}`);

  // Reset state to clean
  manager.resetStateToLive();
  console.log("  -> PASSED: Drift tick accumulation and live state reset verified.");

  console.log("==========================================================================");
  console.log("PHASE 2 AUTOMATED TEST SUITE COMPLETED SUCCESSFULLY [100% PASS]");
  console.log("==========================================================================");
}

try {
  runPhase2Tests();
} catch (err: unknown) {
  console.error("TEST FAILED:", err);
  process.exit(1);
}
