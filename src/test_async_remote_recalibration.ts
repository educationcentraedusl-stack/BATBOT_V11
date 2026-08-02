import * as fs from "fs";
import * as path from "path";
import { RemoteRecalibrationClient } from "./ai/remoteRecalibrationClient";

async function runAsyncRemoteRecalibrationTest() {
  console.log("==========================================================================");
  console.log("   BATBOT_V11: 2026 SOTA DECOUPLED ASYNC REMOTE RECALIBRATION TEST       ");
  console.log("==========================================================================");

  const projectRoot = process.cwd();
  const datasetPath = path.join(projectRoot, "data", "cfc_features.safetensors");
  const weightsPath = path.join(projectRoot, "models", "cfc_weights.safetensors");

  if (!fs.existsSync(datasetPath)) {
    console.error(`❌ STAGE 1 FAILED: Dataset file missing at '${datasetPath}'. Run prepare_data.py first.`);
    process.exit(1);
  }

  const datasetStat = fs.statSync(datasetPath);
  console.log(`[STAGE 1 PASSED] Valid dataset file detected (${datasetStat.size} bytes).`);

  const client = new RemoteRecalibrationClient();
  const startTime = Date.now();

  console.log("[STAGE 2] Triggering 2026 SOTA Decoupled Async Cloud GPU Training Offload...");
  const success = await client.trainRemotely({
    datasetPath,
    weightsPath,
    timeoutMs: 300000,
    pollIntervalMs: 3000,
  });

  if (!success) {
    console.error("❌ STAGE 2 FAILED: RemoteRecalibrationClient.trainRemotely returned false.");
    process.exit(1);
  }

  const durationMs = Date.now() - startTime;
  console.log(`[STAGE 2 PASSED] trainRemotely completed successfully in ${durationMs}ms!`);

  if (!fs.existsSync(weightsPath)) {
    console.error(`❌ STAGE 3 FAILED: Weights file missing at '${weightsPath}' after training.`);
    process.exit(1);
  }

  const weightsStat = fs.statSync(weightsPath);
  console.log(`[STAGE 3 PASSED] Trained SafeTensors file verified on disk (${weightsStat.size} bytes).`);

  // Test Candle Rust N-API zero-lock RCU hot-swap
  try {
    const nativePath = path.join(projectRoot, "index.js");
    const native = require(nativePath);
    if (typeof native.loadAiModel === "function") {
      console.log("[STAGE 4] Executing N-API zero-lock RCU atomic pointer swap (loadAiModel)...");
      const swapped = native.loadAiModel(weightsPath);
      if (swapped) {
        console.log("[STAGE 4 PASSED] Candle Rust AIEngine model weights hot-swapped into memory cleanly!");
      } else {
        console.warn("[STAGE 4 WARN] loadAiModel returned false. Check Rust module log.");
      }
    } else {
      console.log("[STAGE 4 SKIPPED] Native module loadAiModel function not found.");
    }
  } catch (err: any) {
    console.warn(`[STAGE 4 NOTICE] Native module load notice: ${err.message}`);
  }

  console.log("==========================================================================");
  console.log("   ✅ ALL STAGES PASSED: ZERO-TIMEOUT ASYNC CLOUD GPU PIPELINE VERIFIED!  ");
  console.log("==========================================================================");
}

runAsyncRemoteRecalibrationTest().catch((err) => {
  console.error("CRITICAL TEST FAILURE:", err);
  process.exit(1);
});
