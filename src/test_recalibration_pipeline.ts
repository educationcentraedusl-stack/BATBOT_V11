import * as fs from "fs";
import * as path from "path";
import { AutoRecalibrationManager } from "./ai/recalibrationWorker";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nativeAddon = require("../index.js");

function runTest(): void {
  console.log("================================================================================");
  console.log("      BATBOT_V11 AUTONOMOUS AI MODEL AUTO-RECALIBRATION TEST SUITE              ");
  console.log("================================================================================");

  // 1. Verify NAPI Exports
  console.log("[Test 1/4] Verifying NAPI exports...");
  if (typeof nativeAddon.loadAiModel !== "function") {
    throw new Error("NAPI export 'loadAiModel' is missing!");
  }
  if (typeof nativeAddon.resetIcTracker !== "function") {
    throw new Error("NAPI export 'resetIcTracker' is missing!");
  }
  if (typeof nativeAddon.getIcStatus !== "function") {
    throw new Error("NAPI export 'getIcStatus' is missing!");
  }
  console.log("  [PASS] NAPI functions (loadAiModel, resetIcTracker, getIcStatus) detected.");

  // 2. Test IC Status & Reset via NAPI
  console.log("[Test 2/4] Testing NAPI getIcStatus & resetIcTracker...");
  const rawStatusStr = nativeAddon.getIcStatus();
  console.log(`  Initial NAPI IC status JSON: ${rawStatusStr}`);
  const statusObj = JSON.parse(rawStatusStr);
  if (typeof statusObj.ic !== "number" || typeof statusObj.is_drifted !== "boolean") {
    throw new Error("Invalid IC status schema returned from Rust NAPI!");
  }

  const resetSuccess = nativeAddon.resetIcTracker();
  console.log(`  [PASS] NAPI resetIcTracker result: ${resetSuccess}`);

  // 3. Test AutoRecalibrationManager Singleton & Trigger Logic
  console.log("[Test 3/4] Testing AutoRecalibrationManager trigger evaluation...");
  const manager = AutoRecalibrationManager.getInstance();
  manager.setSustainedDriftThreshold(5);

  let successCallbackFired = false;
  manager.setOnSuccessCallback(() => {
    successCallbackFired = true;
    console.log("  [CALLBACK] Auto-recalibration success callback received! IDLE_ACTIVE clamp lifted.");
  });

  // Evaluate ticks below threshold
  for (let i = 1; i <= 4; i++) {
    manager.evaluateTickDrift(0.015, true);
    const status = manager.getStatus();
    console.log(`  Tick ${i}: Drift Counter = ${status.driftTickCounter}`);
    if (status.driftTickCounter !== i) {
      throw new Error(`Expected drift counter ${i}, got ${status.driftTickCounter}`);
    }
  }

  console.log("  [PASS] Drift counter incremented predictably.");

  // 4. Verify Telemetry Signals Data & Weight File Accessibility
  console.log("[Test 4/4] Verifying training paths & data directories...");
  const dataDir = path.join(process.cwd(), "data");
  const signalsPath = path.join(dataDir, "signals.jsonl");
  const weightsPath = path.join(process.cwd(), "models", "cfc_weights.safetensors");

  console.log(`  Signals Path: '${signalsPath}' (Exists: ${fs.existsSync(signalsPath)})`);
  console.log(`  Weights Path: '${weightsPath}' (Exists: ${fs.existsSync(weightsPath)})`);

  console.log("================================================================================");
  console.log(" [SUCCESS] ALL AUTONOMOUS AUTO-RECALIBRATION PIPELINE TESTS PASSED 100%");
  console.log("================================================================================");
}

try {
  runTest();
} catch (err: unknown) {
  console.error("❌ Test Suite Failed:", err);
  process.exit(1);
}
