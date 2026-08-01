import * as fs from "fs";
import * as path from "path";

export interface RemoteTrainingOptions {
  datasetPath?: string;
  weightsPath?: string;
  endpointUrl?: string;
  timeoutMs?: number;
}

export class RemoteRecalibrationClient {
  private projectRoot: string;
  private defaultDatasetPath: string;
  private defaultWeightsPath: string;
  private defaultEndpointUrl: string;

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
  public async trainRemotely(options?: RemoteTrainingOptions): Promise<boolean> {
    const datasetPath = options?.datasetPath || this.defaultDatasetPath;
    const weightsPath = options?.weightsPath || this.defaultWeightsPath;
    const endpointUrl = options?.endpointUrl || process.env.MODAL_TRAINING_URL || this.defaultEndpointUrl;
    const timeoutMs = options?.timeoutMs || 600000; // 600s (10 min) extended timeout for Modal container cold boot & GPU training

    if (!fs.existsSync(datasetPath)) {
      console.warn(`[BATBOT_V11][REMOTE-TRAINING] Dataset file missing at '${datasetPath}'. Cannot offload training.`);
      return false;
    }

    const datasetStat = fs.statSync(datasetPath);
    if (datasetStat.size < 100) {
      console.warn(`[BATBOT_V11][REMOTE-TRAINING] Dataset file at '${datasetPath}' is empty or corrupt (${datasetStat.size} bytes).`);
      return false;
    }

    console.log(
      `[BATBOT_V11][REMOTE-TRAINING] Uploading SafeTensors dataset (${datasetStat.size} bytes) to Modal Serverless GPU (${endpointUrl})...`
    );

    const startTime = Date.now();

    try {
      let customAgent: any = undefined;
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
      } catch {
        // ignore if undici not loadable
      }

      const datasetBuffer = await fs.promises.readFile(datasetPath);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const fetchOptions: any = {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": datasetBuffer.length.toString(),
          "User-Agent": "BATBOT_V11-HFT-Client/1.0",
        },
        body: datasetBuffer,
        signal: controller.signal,
      };

      if (customAgent) {
        fetchOptions.dispatcher = customAgent;
      }

      const response = await fetch(endpointUrl, fetchOptions);

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[BATBOT_V11][REMOTE-TRAINING ERROR] Modal GPU returned HTTP ${response.status}: ${errorText}`
        );
        return false;
      }

      const arrayBuffer = await response.arrayBuffer();
      const weightsBuffer = Buffer.from(arrayBuffer);

      if (weightsBuffer.length < 100) {
        console.error(
          `[BATBOT_V11][REMOTE-TRAINING ERROR] Returned SafeTensors buffer is suspiciously small (${weightsBuffer.length} bytes).`
        );
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
        await fs.promises.unlink(tmpPath).catch(() => {});
      });

      const totalMs = Date.now() - startTime;
      console.log(
        `[BATBOT_V11][REMOTE-TRAINING SUCCESS] Trained SafeTensors weights received (${weightsBuffer.length} bytes) in ${totalMs}ms!`
      );

      return true;
    } catch (err: unknown) {
      const isAbort = err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
      const causeStr = (err as any)?.cause ? ` (Cause: ${String((err as any).cause.message || (err as any).cause.code || (err as any).cause)})` : "";
      const errorMsg = isAbort
        ? `Request timed out after ${Math.round(timeoutMs / 1000)}s waiting for Modal GPU container cold boot and training.`
        : `${err instanceof Error ? err.message : String(err)}${causeStr}`;
      console.error(`[BATBOT_V11][REMOTE-TRAINING FAILURE] Failed to offload training to Modal: ${errorMsg}`);
      return false;
    }
  }
}
