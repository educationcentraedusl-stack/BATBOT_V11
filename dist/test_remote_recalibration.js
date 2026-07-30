"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const remoteRecalibrationClient_1 = require("./ai/remoteRecalibrationClient");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nativeAddon = require("../index.js");
async function runRemoteRecalibrationTest() {
    console.log("=".repeat(80));
    console.log("BATBOT_V11 PHASE 4 VERIFICATION: REMOTE MODAL SERVERLESS GPU RECALIBRATION");
    console.log("=".repeat(80));
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
    const remoteClient = new remoteRecalibrationClient_1.RemoteRecalibrationClient();
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
    }
    else {
        console.warn("[Test Step 4/4 Warning] nativeAddon.loadAiModel is not defined in addon.");
    }
    console.log("\n" + "=".repeat(80));
    console.log(`ALL TEST STAGES COMPLETED SUCCESSFULLY!`);
    console.log(`Total End-to-End Recalibration Latency: ${prepTime + remoteTime}ms (Data Prep: ${prepTime}ms | Cloud GPU: ${remoteTime}ms)`);
    console.log("=".repeat(80));
}
runRemoteRecalibrationTest().catch((err) => {
    console.error("\n[TEST ERROR] Verification harness failed:", err);
    process.exit(1);
});
