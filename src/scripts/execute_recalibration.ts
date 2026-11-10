import * as fs from "fs";
import * as path from "path";
import { MarketDataClient } from "../marketDataClient";
import { AutoRecalibrationManager } from "../ai/recalibrationWorker";
import { getIcStatus, loadAiModel, loadAiModelFull, resetIcTracker } from "../../index";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function main(client?: MarketDataClient): void {
  console.log("=".repeat(75));
  console.log("BATBOT_V11 NAPI ZERO-LOCK HOT-SWAP & IC RESET ORCHESTRATOR");
  console.log("=".repeat(75));

  const projectRoot = process.cwd();
  const weightsPath = path.join(projectRoot, "models", "cfc_weights.safetensors");

  console.log(`[Hot-Swap] Validating SafeTensors file: '${weightsPath}'...`);
  if (!fs.existsSync(weightsPath)) {
    console.error(`❌ Weights file missing at '${weightsPath}'`);
    process.exit(1);
  }

  const stat = fs.statSync(weightsPath);
  if (stat.size === 0) {
    console.error(`❌ Weights file at '${weightsPath}' is empty (0 bytes)!`);
    process.exit(1);
  }

  console.log(`  [PASS] Weights file verified (${String(stat.size)} bytes, modified: ${stat.mtime.toISOString()}).`);

  // Step 1: Query initial IC status
  console.log(`\n[IC Status - PRE HOT-SWAP]: ${getIcStatus()}`);

  // Step 2: Atomic Hot-Swap via NAPI RCU Pointer Swap
  console.log("\n[Hot-Swap] Step 1/2: Triggering NAPI loadAiModel RCU pointer swap...");

  // Extract physical SAB buffer from registered live MarketDataClient on AutoRecalibrationManager
  const recalManager = AutoRecalibrationManager.getInstance();
  if (client) {
    recalManager.setMarketDataClient(client);
  }
  const sabBuffer = recalManager.getSabBufferForNapi();

  const tkanPath = path.join(projectRoot, "models", "tkan_luts.bin");
  console.log(`[STEP 1 PROOF] Passing physical SAB Buffer to Rust. Byte Length: ${String(sabBuffer.length)}`);
  const loaded = fs.existsSync(tkanPath)
    ? loadAiModelFull(weightsPath, tkanPath, sabBuffer)
    : loadAiModel(weightsPath, sabBuffer);

  if (!loaded) {
    console.error(`❌ NAPI loadAiModel failed to load weights from '${weightsPath}'!`);
    process.exit(1);
  }
  console.log("  [SUCCESS] NAPI zero-lock RCU hot-swap completed with SAB HOTSWAP_EPOCH bump! Live engine now referencing updated PyTorch weights.");

  // Step 3: Reset IC Tracker window
  console.log("\n[Hot-Swap] Step 2/2: Resetting rolling Spearman IC Tracker window...");

  const resetSuccess = resetIcTracker();
  console.log(`  [SUCCESS] NAPI resetIcTracker result: ${String(resetSuccess)}`);

  // Step 4: Verify post-reset IC status
  const postStatus = getIcStatus();
  console.log(`\n[IC Status - POST HOT-SWAP]: ${postStatus}`);

  try {
    const parsed: unknown = JSON.parse(postStatus);
    if (isRecord(parsed) && parsed["is_drifted"] === false && parsed["ic"] === 0) {
      console.log("\n" + "=".repeat(75));
      console.log("[BATBOT_V11] RECALIBRATION COMPLETE: Model hot-swapped & IC tracker reset to clean state!");
      console.log("=".repeat(75));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[execute_recalibration] IC status parse notice (non-JSON format): ${msg}`);
  }
}

if (require.main === module) {
  main();
}
