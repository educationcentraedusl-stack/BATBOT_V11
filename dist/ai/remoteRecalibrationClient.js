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
const stream_1 = require("stream");
const promises_1 = require("stream/promises");
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
     * Offload PyTorch CfC Neural Network training to remote Modal serverless GPU webhook
     * using chunked HTTP upload streaming and direct-to-disk weight download streaming.
     */
    async trainRemotely(options) {
        const datasetPath = options?.datasetPath || this.defaultDatasetPath;
        const weightsPath = options?.weightsPath || this.defaultWeightsPath;
        const endpointUrl = options?.endpointUrl || process.env.MODAL_TRAINING_URL || this.defaultEndpointUrl;
        const timeoutMs = options?.timeoutMs || 600000; // 600s (10 min) extended timeout
        if (!fs.existsSync(datasetPath)) {
            console.warn(`[BATBOT_V11][REMOTE-TRAINING] Dataset file missing at '${datasetPath}'. Cannot offload training.`);
            return false;
        }
        const datasetStat = fs.statSync(datasetPath);
        if (datasetStat.size < 100) {
            console.warn(`[BATBOT_V11][REMOTE-TRAINING] Dataset file at '${datasetPath}' is empty or corrupt (${datasetStat.size} bytes).`);
            return false;
        }
        console.log(`[BATBOT_V11][REMOTE-TRAINING] Uploading SafeTensors dataset (${datasetStat.size} bytes) via chunked stream to Modal Serverless GPU (${endpointUrl})...`);
        const startTime = Date.now();
        const maxAttempts = 3;
        let response = null;
        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                let customAgent = undefined;
                try {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const undici = require("undici");
                    if (typeof undici.Agent === "function") {
                        customAgent = new undici.Agent({
                            headersTimeout: 0,
                            bodyTimeout: 0,
                            connectTimeout: 300000,
                        });
                    }
                }
                catch {
                    // ignore if undici not loadable
                }
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                const headers = {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": datasetStat.size.toString(),
                    "User-Agent": "BATBOT_V11-HFT-Client/1.0",
                };
                if (process.env.HFT_SECRET_TOKEN) {
                    headers["Authorization"] = `Bearer ${process.env.HFT_SECRET_TOKEN}`;
                }
                const isLargeFile = datasetStat.size > 50 * 1024 * 1024;
                const bodyPayload = isLargeFile
                    ? stream_1.Readable.toWeb(fs.createReadStream(datasetPath))
                    : fs.readFileSync(datasetPath);
                const fetchOptions = {
                    method: "POST",
                    headers,
                    body: bodyPayload,
                    signal: controller.signal,
                };
                if (isLargeFile) {
                    fetchOptions.duplex = "half";
                }
                if (customAgent) {
                    fetchOptions.dispatcher = customAgent;
                }
                response = await fetch(endpointUrl, fetchOptions);
                clearTimeout(timeoutId);
                if (response.ok) {
                    break; // Success! Break retry loop
                }
                else {
                    const errorText = await response.text();
                    console.warn(`[BATBOT_V11][REMOTE-TRAINING WARN] Attempt ${attempt}/${maxAttempts} failed. HTTP ${response.status}: ${errorText}`);
                }
            }
            catch (err) {
                lastError = err;
                console.warn(`[BATBOT_V11][REMOTE-TRAINING WARN] Attempt ${attempt}/${maxAttempts} network exception: ${err.message || String(err)}`);
            }
            if (attempt < maxAttempts) {
                const backoffMs = attempt * 3000;
                console.log(`[BATBOT_V11][REMOTE-TRAINING] Retrying in ${backoffMs}ms...`);
                await new Promise((r) => setTimeout(r, backoffMs));
            }
        }
        if (!response || !response.ok) {
            console.error(`[BATBOT_V11][REMOTE-TRAINING ERROR] All ${maxAttempts} Modal Cloud GPU attempts failed. ${lastError ? lastError.message : ""}`);
            return false;
        }
        if (!response.body) {
            console.error("[BATBOT_V11][REMOTE-TRAINING ERROR] Modal GPU response body is empty.");
            return false;
        }
        try {
            // Stream incoming trained model weights directly to disk without buffering full file in RAM
            const dir = path.dirname(weightsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tmpPath = `${weightsPath}.remote.tmp`;
            const fileWriteStream = fs.createWriteStream(tmpPath);
            const resNodeStream = stream_1.Readable.fromWeb(response.body);
            await (0, promises_1.pipeline)(resNodeStream, fileWriteStream);
            const weightsStat = fs.statSync(tmpPath);
            if (weightsStat.size < 100) {
                fs.unlinkSync(tmpPath);
                console.error(`[BATBOT_V11][REMOTE-TRAINING ERROR] Downloaded SafeTensors file is suspiciously small (${weightsStat.size} bytes).`);
                return false;
            }
            // Atomic rename to final weights target path
            await fs.promises.rename(tmpPath, weightsPath).catch(async () => {
                // Fallback for Windows file replace lock
                await fs.promises.copyFile(tmpPath, weightsPath);
                await fs.promises.unlink(tmpPath).catch(() => { });
            });
            // Also ensure cfc_updated.safetensors copy exists if weightsPath is cfc_weights.safetensors or vice-versa
            const altWeightsPath = path.join(dir, "cfc_updated.safetensors");
            if (weightsPath !== altWeightsPath) {
                await fs.promises.copyFile(weightsPath, altWeightsPath).catch(() => { });
            }
            const totalMs = Date.now() - startTime;
            console.log(`[BATBOT_V11][REMOTE-TRAINING SUCCESS] Trained SafeTensors weights streamed directly to disk (${weightsStat.size} bytes) in ${totalMs}ms!`);
            return true;
        }
        catch (err) {
            const isAbort = err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
            const causeStr = err?.cause ? ` (Cause: ${String(err.cause.message || err.cause.code || err.cause)})` : "";
            const errorMsg = isAbort
                ? `Request timed out after ${Math.round(timeoutMs / 1000)}s waiting for Modal GPU container cold boot and training.`
                : `${err instanceof Error ? err.message : String(err)}${causeStr}`;
            console.error(`[BATBOT_V11][REMOTE-TRAINING FAILURE] Failed to offload training to Modal: ${errorMsg}`);
            return false;
        }
    }
}
exports.RemoteRecalibrationClient = RemoteRecalibrationClient;
