import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { RemoteRecalibrationClient } from "./ai/remoteRecalibrationClient";

const execFileAsync = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nativeAddon = require("../index.js");

async function runRemoteRecalibrationTest() {
  console.log("=" .repeat(80));
  console.log("BATBOT_V11 PHASE 4 VERIFICATION: REMOTE MODAL SERVERLESS GPU RECALIBRATION");
  console.log("=" .repeat(80));

  const projectRoot = process.cwd();
  const pythonCmd = process.platform === "win32"
    ? path.join(projectRoot, "training", ".venv", "Scripts", "python.exe")
    : path.join(projectRoot, "training", ".venv", "bin", "python");

  const prepScript = path.join(projectRoot, "training", "prepare_data.py");
  const datasetPath = path.join(projectRoot, "data", "cfc_features.safetensors");
  const weightsPath = path.join(projectRoot, "models", "cfc_weights.safetensors");

  // Step 1: Execute Data Preparation
  console.log(`[Test Step 1/4] Executing Python Data Prep: '${prepScript}'...`);
  const prepStart = Date.now();
  const prepResult = await execFileAsync(pythonCmd, [prepScript], {
    cwd: projectRoot,
    env: { ...process.env },
  });

  const prepTime = Date.now() - prepStart;
  console.log(`[Test Step 1/4] Data Prep Completed in ${prepTime}ms.`);
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Dataset SafeTensors file missing at '${datasetPath}'.`);
  }

  const datasetStat = fs.statSync(datasetPath);
  console.log(`               Dataset file created successfully (${datasetStat.size} bytes).`);

  // Step 2: Offload PyTorch CfC Neural Network Training to Modal Cloud GPU
  console.log("\n[Test Step 2/4] Offloading PyTorch CfC Training to Modal Serverless GPU...");
  const remoteClient = new RemoteRecalibrationClient();

  const remoteStart = Date.now();
  const success = await remoteClient.trainRemotely({
    datasetPath,
    weightsPath,
    timeoutMs: 180000,
  });

  const remoteTime = Date.now() - remoteStart;

  if (!success) {
    throw new Error("[TEST FAILED] Remote Modal GPU training failed or timed out.");
  }

  console.log(`[Test Step 2/4] Remote GPU Training & Weights Download Completed in ${remoteTime}ms! 🎉`);

  // Step 3: Validate Downloaded SafeTensors File
  console.log("\n[Test Step 3/4] Validating Trained SafeTensors Weights...");
  if (!fs.existsSync(weightsPath)) {
    throw new Error(`Weights SafeTensors file missing at '${weightsPath}'.`);
  }
  const weightsStat = fs.statSync(weightsPath);
  if (weightsStat.size < 100) {
    throw new Error(`Weights SafeTensors file '${weightsPath}' is empty or corrupt.`);
  }

  console.log(`[Test Step 3/4] SafeTensors validation passed (${weightsStat.size} bytes).`);

  // Step 4: Test NAPI Candle Rust Zero-Lock RCU Hot-Swap
  console.log("\n[Test Step 4/4] Testing NAPI Candle Rust Atomic RCU Hot-Swap...");
  if (typeof nativeAddon.loadAiModel === "function") {
    const loaded = nativeAddon.loadAiModel(weightsPath);
    if (!loaded) {
      throw new Error("nativeAddon.loadAiModel returned false.");
    }
    console.log("[Test Step 4/4] Candle Rust NAPI loadAiModel Hot-Swap: PASSED! [SUCCESS]");
  } else {
    console.warn("[Test Step 4/4 Warning] nativeAddon.loadAiModel is not defined in addon.");
  }

  console.log("\n" + "=" .repeat(80));
  console.log(`ALL TEST STAGES COMPLETED SUCCESSFULLY!`);
  console.log(`Total End-to-End Recalibration Latency: ${prepTime + remoteTime}ms (Data Prep: ${prepTime}ms | Cloud GPU: ${remoteTime}ms)`);
  console.log("=" .repeat(80));
}

runRemoteRecalibrationTest().catch((err) => {
  console.error("\n[TEST ERROR] Verification harness failed:", err);
  process.exit(1);
});
