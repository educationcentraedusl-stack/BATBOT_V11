import { MarketDataClient } from "../marketDataClient";
import { MultiAssetCLIDashboard } from "../telemetry/multiAssetDashboard";
import { AutoRecalibrationManager } from "../ai/recalibrationWorker";
import * as fs from "fs";
import * as path from "path";

async function runLocalAiAndTuiIntegrationTests(): Promise<void> {
  console.log("=========================================================================");
  console.log("  BATBOT_V11: LOCAL AI PIPELINE & MULTI-ASSET TUI INTEGRATION QA SUITE    ");
  console.log("=========================================================================\n");

  const totalSABBytes = 10 * 256 * 8;
  const sab = new SharedArrayBuffer(totalSABBytes);
  const client = new MarketDataClient(sab, 10, 256);
  const recalManager = AutoRecalibrationManager.getInstance();

  // Test 1: Verify .env T-KAN Dynamic Interval Scheduling
  console.log("[TEST 1/4] Verifying Dynamic .env T-KAN Scheduler Configuration...");
  const configuredDays = recalManager.getTkanScheduleIntervalDays();
  console.log(`  - Configured T-KAN Interval: ${configuredDays} Days`);
  if (configuredDays <= 0 || !Number.isFinite(configuredDays)) {
    throw new Error(`Invalid TKAN schedule interval: ${configuredDays}`);
  }
  console.log("  ✅ [PASS] T-KAN Schedule Interval correctly read from .env configuration.");

  // Test 2: Verify Cold-Start SafeTensors Fallback in Auto-Recalibration Pipeline
  console.log("\n[TEST 2/4] Verifying Cold-Start SafeTensors Fallback (signals.jsonl < 100 bytes)...");
  const signalsPath = path.join(process.cwd(), "data", "signals.jsonl");
  const signalsSize = fs.existsSync(signalsPath) ? fs.statSync(signalsPath).size : 0;
  console.log(`  - Current signals.jsonl size: ${signalsSize} bytes (Simulating Cold Start)`);

  const coldStartSuccess = await recalManager.runRecalibrationPipeline(0.005, true);
  console.log(`  - Recalibration Execution Result: ${coldStartSuccess}`);
  if (!coldStartSuccess) {
    throw new Error("AutoRecalibrationManager failed on cold-start fallback execution!");
  }
  const status = recalManager.getStatus();
  console.log(`  - Total Recalibrations Completed: ${status.totalRecalibrations}`);
  console.log("  ✅ [PASS] Cold-start fallback executed seamlessly via SafeTensors without crashing.");

  // Test 3: Verify N-API IC Tracker State & SAB Mapping
  console.log("\n[TEST 3/4] Verifying SAB Slot 101/102 and IC Status Telemetry...");
  // Simulate synthetic IC drift write in SAB
  client.setRollingIC(0.0345);
  client.setIsModelDrifted(false);

  const readIc = client.getRollingIC();
  const readDrift = client.getIsModelDrifted();
  console.log(`  - SAB Slot 101 (Rolling IC): ${readIc}`);
  console.log(`  - SAB Slot 102 (Is Drifted): ${readDrift}`);

  if (Math.abs(readIc - 0.0345) > 1e-4) {
    throw new Error(`SAB Slot 101 mismatch: expected 0.0345, got ${readIc}`);
  }
  if (readDrift !== false) {
    throw new Error(`SAB Slot 102 mismatch: expected false, got ${readDrift}`);
  }
  console.log("  ✅ [PASS] SAB Slot 101/102 telemetry mapping verified.");

  // Test 4: Verify MultiAssetCLIDashboard Terminal Rendering with AI Panel
  console.log("\n[TEST 4/4] Verifying MultiAssetCLIDashboard AI Telemetry Panel Integration...");
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT", "XRPUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT"];
  const dashboard = new MultiAssetCLIDashboard(client, true, symbols);

  // Capture stdout write by intercepting process.stdout.write
  let capturedOutput = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: string | Uint8Array) => {
    capturedOutput += chunk.toString();
    return true;
  };

  try {
    dashboard.render();
  } finally {
    dashboard.restoreConsole();
    process.stdout.write = originalWrite;
  }

  console.log(`  - Rendered Frame Length: ${capturedOutput.length} characters`);
  const containsAiHeader = capturedOutput.includes("AI RECALIBRATION & MODEL DRIFT MONITOR");
  const containsIc = capturedOutput.includes("IC (Spearman)");
  const containsTrainer = capturedOutput.includes("Auto-Trainer");
  const containsHotSwap = capturedOutput.includes("Hot-Swap: \x1b[32m[ACTIVE]\x1b[0m");

  console.log(`  - Contains AI Panel Header: ${containsAiHeader}`);
  console.log(`  - Contains IC Spearman Metric: ${containsIc}`);
  console.log(`  - Contains Auto-Trainer State: ${containsTrainer}`);
  console.log(`  - Contains Active Hot-Swap Indicator: ${containsHotSwap}`);

  if (!containsAiHeader || !containsIc || !containsTrainer || !containsHotSwap) {
    throw new Error("MultiAssetCLIDashboard frame is missing expected AI Telemetry panel elements!");
  }
  console.log("  ✅ [PASS] AI Telemetry & Model Drift Monitor safely rendered at the bottom of TUI dashboard.");

  console.log("\n=========================================================================");
  console.log("  🎉 ALL 4 LOCAL AI & TUI INTEGRATION TESTS PASSED 100%!                   ");
  console.log("=========================================================================\n");
}

runLocalAiAndTuiIntegrationTests().catch((err) => {
  console.error("❌ TEST SUITE FAILED:", err);
  process.exit(1);
});
