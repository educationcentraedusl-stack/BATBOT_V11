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
exports.RemoteRecalibrationClient = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class RemoteRecalibrationClient {
    projectRoot;
    defaultDatasetPath;
    defaultWeightsPath;
    defaultEndpointUrl;
    constructor() {
        this.projectRoot = process.cwd();
        this.defaultDatasetPath = path.join(this.projectRoot, "data", "cfc_features.safetensors");
        this.defaultWeightsPath = path.join(this.projectRoot, "models", "cfc_weights.safetensors");
        this.defaultEndpointUrl =
            process.env.MODAL_TRAINING_URL ||
                "https://educationcentra-edu-sl--batbot-cfc-trainer-train-cfc-webhook.modal.run";
    }
    /**
     * Offload PyTorch CfC Neural Network training to remote Modal serverless GPU webhook.
     */
    async trainRemotely(options) {
        const datasetPath = options?.datasetPath || this.defaultDatasetPath;
        const weightsPath = options?.weightsPath || this.defaultWeightsPath;
        const endpointUrl = options?.endpointUrl || process.env.MODAL_TRAINING_URL || this.defaultEndpointUrl;
        const timeoutMs = options?.timeoutMs || 180000; // 180s (3 min) max timeout for large datasets & network transport
        if (!fs.existsSync(datasetPath)) {
            console.warn(`[BATBOT_V11][REMOTE-TRAINING] Dataset file missing at '${datasetPath}'. Cannot offload training.`);
            return false;
        }
        const datasetStat = fs.statSync(datasetPath);
        if (datasetStat.size < 100) {
            console.warn(`[BATBOT_V11][REMOTE-TRAINING] Dataset file at '${datasetPath}' is empty or corrupt (${datasetStat.size} bytes).`);
            return false;
        }
        console.log(`[BATBOT_V11][REMOTE-TRAINING] Uploading SafeTensors dataset (${datasetStat.size} bytes) to Modal Serverless GPU (${endpointUrl})...`);
        const startTime = Date.now();
        try {
            const datasetBuffer = await fs.promises.readFile(datasetPath);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const response = await fetch(endpointUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": datasetBuffer.length.toString(),
                    "User-Agent": "BATBOT_V11-HFT-Client/1.0",
                },
                body: datasetBuffer,
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[BATBOT_V11][REMOTE-TRAINING ERROR] Modal GPU returned HTTP ${response.status}: ${errorText}`);
                return false;
            }
            const arrayBuffer = await response.arrayBuffer();
            const weightsBuffer = Buffer.from(arrayBuffer);
            if (weightsBuffer.length < 100) {
                console.error(`[BATBOT_V11][REMOTE-TRAINING ERROR] Returned SafeTensors buffer is suspiciously small (${weightsBuffer.length} bytes).`);
                return false;
            }
            // Atomic write to weights path
            const dir = path.dirname(weightsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tmpPath = `${weightsPath}.remote.tmp`;
            await fs.promises.writeFile(tmpPath, weightsBuffer);
            await fs.promises.rename(tmpPath, weightsPath).catch(async () => {
                // Fallback for Windows file replace lock
                await fs.promises.copyFile(tmpPath, weightsPath);
                await fs.promises.unlink(tmpPath).catch(() => { });
            });
            const totalMs = Date.now() - startTime;
            console.log(`[BATBOT_V11][REMOTE-TRAINING SUCCESS] Trained SafeTensors weights received (${weightsBuffer.length} bytes) in ${totalMs}ms!`);
            return true;
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[BATBOT_V11][REMOTE-TRAINING FAILURE] Failed to offload training to Modal: ${errorMsg}`);
            return false;
        }
    }
}
exports.RemoteRecalibrationClient = RemoteRecalibrationClient;
