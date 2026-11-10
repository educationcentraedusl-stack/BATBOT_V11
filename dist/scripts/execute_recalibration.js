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
exports.main = main;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const recalibrationWorker_1 = require("../ai/recalibrationWorker");
const index_1 = require("../../index");
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function main(client) {
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
    console.log(`\n[IC Status - PRE HOT-SWAP]: ${(0, index_1.getIcStatus)()}`);
    // Step 2: Atomic Hot-Swap via NAPI RCU Pointer Swap
    console.log("\n[Hot-Swap] Step 1/2: Triggering NAPI loadAiModel RCU pointer swap...");
    // Extract physical SAB buffer from registered live MarketDataClient on AutoRecalibrationManager
    const recalManager = recalibrationWorker_1.AutoRecalibrationManager.getInstance();
    if (client) {
        recalManager.setMarketDataClient(client);
    }
    const sabBuffer = recalManager.getSabBufferForNapi();
    const tkanPath = path.join(projectRoot, "models", "tkan_luts.bin");
    console.log(`[STEP 1 PROOF] Passing physical SAB Buffer to Rust. Byte Length: ${String(sabBuffer.length)}`);
    const loaded = fs.existsSync(tkanPath)
        ? (0, index_1.loadAiModelFull)(weightsPath, tkanPath, sabBuffer)
        : (0, index_1.loadAiModel)(weightsPath, sabBuffer);
    if (!loaded) {
        console.error(`❌ NAPI loadAiModel failed to load weights from '${weightsPath}'!`);
        process.exit(1);
    }
    console.log("  [SUCCESS] NAPI zero-lock RCU hot-swap completed with SAB HOTSWAP_EPOCH bump! Live engine now referencing updated PyTorch weights.");
    // Step 3: Reset IC Tracker window
    console.log("\n[Hot-Swap] Step 2/2: Resetting rolling Spearman IC Tracker window...");
    const resetSuccess = (0, index_1.resetIcTracker)();
    console.log(`  [SUCCESS] NAPI resetIcTracker result: ${String(resetSuccess)}`);
    // Step 4: Verify post-reset IC status
    const postStatus = (0, index_1.getIcStatus)();
    console.log(`\n[IC Status - POST HOT-SWAP]: ${postStatus}`);
    try {
        const parsed = JSON.parse(postStatus);
        if (isRecord(parsed) && parsed["is_drifted"] === false && parsed["ic"] === 0) {
            console.log("\n" + "=".repeat(75));
            console.log("[BATBOT_V11] RECALIBRATION COMPLETE: Model hot-swapped & IC tracker reset to clean state!");
            console.log("=".repeat(75));
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[execute_recalibration] IC status parse notice (non-JSON format): ${msg}`);
    }
}
if (require.main === module) {
    main();
}
