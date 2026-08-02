import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

export interface RemoteTrainingOptions {
  datasetPath?: string;
  weightsPath?: string;
  endpointUrl?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface JobSubmissionResponse {
  jobId: string;
  status: string;
  message?: string;
}

export interface JobStatusResponse {
  jobId: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "NOT_FOUND";
  weightsSize?: number;
  error?: string;
  updatedAt?: number;
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
      "https://dhanushka-stu-kcc1993--batbot-cfc-trainer-train-cfc-webhook.modal.run";
  }

  /**
   * Helper to construct candidate URL endpoints for decoupled sub-routes.
   */
  private getCandidateUrls(baseUrl: string, pathSegment: string): string[] {
    const urls: string[] = [];
    const cleanSegment = pathSegment.replace(/^\//, "");
    
    // 1. If baseUrl contains a known function name, substitute it
    if (baseUrl.includes("train-cfc-webhook")) {
      urls.push(baseUrl.replace(/train-cfc-webhook\/?$/, cleanSegment));
    }

    // 2. Try parsing base domain
    try {
      const parsed = new URL(baseUrl);
      const domainBase = `${parsed.protocol}//${parsed.host}`;
      urls.push(`${domainBase}/${cleanSegment}`);
      urls.push(`${domainBase}/api/${cleanSegment}`);
    } catch {
      // ignore URL parse errors
    }

    // 3. Simple append
    urls.push(`${baseUrl.replace(/\/$/, "")}/${cleanSegment}`);
    return Array.from(new Set(urls));
  }

  /**
   * Offload PyTorch CfC Neural Network training to remote Modal serverless GPU
   * using 2026 SOTA Decoupled Asynchronous Job Dispatch, Modal Volume Storage, & Non-blocking Polling.
   */
  public async trainRemotely(options?: RemoteTrainingOptions): Promise<boolean> {
    const datasetPath = options?.datasetPath || this.defaultDatasetPath;
    const weightsPath = options?.weightsPath || this.defaultWeightsPath;
    const endpointUrl = options?.endpointUrl || process.env.MODAL_TRAINING_URL || this.defaultEndpointUrl;
    const timeoutMs = options?.timeoutMs || 300000; // 5 min timeout cap
    const pollIntervalMs = options?.pollIntervalMs || 3000;

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
      `[BATBOT_V11][REMOTE-TRAINING] Initiating 2026 SOTA Decoupled Async Cloud GPU Offload (${datasetStat.size} bytes)...`
    );

    const startTime = Date.now();

    // Stage 1: Submit Job (Sub-Second Latency)
    const submission = await this.submitJob(endpointUrl, datasetPath, datasetStat.size);
    if (!submission) {
      console.warn(`[BATBOT_V11][REMOTE-TRAINING WARN] Async job submission endpoint unreachable. Falling back to synchronous endpoint...`);
      return this.trainRemotelySynchronous(endpointUrl, datasetPath, datasetStat.size, weightsPath, timeoutMs);
    }

    console.log(
      `[BATBOT_V11][REMOTE-TRAINING] Job #${submission.jobId} submitted successfully! Status: ${submission.status}. Polling for completion...`
    );

    // Stage 2: Non-Blocking Status Polling Loop
    const pollResult = await this.pollJobCompletion(endpointUrl, submission.jobId, timeoutMs, pollIntervalMs);
    if (!pollResult || pollResult.status !== "COMPLETED") {
      console.error(
        `[BATBOT_V11][REMOTE-TRAINING ERROR] Job #${submission.jobId} failed or timed out during GPU execution.`
      );
      return false;
    }

    // Stage 3: Zero-Copy Weight Retrieval Stream
    console.log(`[BATBOT_V11][REMOTE-TRAINING] Training complete. Downloading trained SafeTensors weights...`);
    const downloadSuccess = await this.downloadWeights(endpointUrl, submission.jobId, weightsPath);

    if (downloadSuccess) {
      const durationMs = Date.now() - startTime;
      console.log(
        `[BATBOT_V11][REMOTE-TRAINING SUCCESS] Async Cloud GPU Recalibration completed in ${durationMs}ms with ZERO HTTP timeouts!`
      );
    }

    return downloadSuccess;
  }

  /**
   * Stage 1: Submit Job to Modal Cloud Storage
   */
  private async submitJob(
    baseUrl: string,
    datasetPath: string,
    datasetSize: number
  ): Promise<JobSubmissionResponse | null> {
    const candidateUrls = this.getCandidateUrls(baseUrl, "submit-job");
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Length": datasetSize.toString(),
      "User-Agent": "BATBOT_V11-HFT-Client/1.0",
    };

    if (process.env.HFT_SECRET_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.HFT_SECRET_TOKEN}`;
    }

    const payload = fs.readFileSync(datasetPath);

    for (const url of candidateUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s submission timeout

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: payload,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok || response.status === 202) {
          const json = (await response.json()) as JobSubmissionResponse;
          if (json && json.jobId) {
            return json;
          }
        }
      } catch {
        // Try next candidate URL
      }
    }

    return null;
  }

  /**
   * Stage 2: Non-Blocking Job Status Polling
   */
  private async pollJobCompletion(
    baseUrl: string,
    jobId: string,
    maxWaitMs: number,
    pollIntervalMs: number
  ): Promise<JobStatusResponse | null> {
    const candidateUrls = this.getCandidateUrls(baseUrl, "job-status");
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      for (const url of candidateUrls) {
        try {
          const pollUrl = `${url}?job_id=${encodeURIComponent(jobId)}`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s poll timeout

          const response = await fetch(pollUrl, {
            method: "GET",
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (response.ok) {
            const statusJson = (await response.json()) as JobStatusResponse;
            if (statusJson.status === "COMPLETED") {
              return statusJson;
            }
            if (statusJson.status === "FAILED") {
              console.error(`[BATBOT_V11][REMOTE-TRAINING ERROR] GPU Worker Error: ${statusJson.error}`);
              return statusJson;
            }

            const elapsedSec = Math.round((Date.now() - startTime) / 1000);
            console.log(`[BATBOT_V11][REMOTE-TRAINING] Job #${jobId} status: ${statusJson.status} (${elapsedSec}s elapsed)...`);
            break; // Valid status received, break URL candidates loop & wait for next poll interval
          }
        } catch {
          // Try next candidate URL
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    console.error(`[BATBOT_V11][REMOTE-TRAINING ERROR] Job #${jobId} polling exceeded max timeout of ${maxWaitMs}ms.`);
    return null;
  }

  /**
   * Stage 3: Direct Weight Download Stream
   */
  private async downloadWeights(baseUrl: string, jobId: string, weightsPath: string): Promise<boolean> {
    const candidateUrls = this.getCandidateUrls(baseUrl, "download-weights");

    for (const url of candidateUrls) {
      try {
        const downloadUrl = `${url}?job_id=${encodeURIComponent(jobId)}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s download timeout

        const response = await fetch(downloadUrl, {
          method: "GET",
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok && response.body) {
          const dir = path.dirname(weightsPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }

          const tmpPath = `${weightsPath}.remote.tmp`;
          const fileWriteStream = fs.createWriteStream(tmpPath);
          const resNodeStream = Readable.fromWeb(response.body as any);

          await pipeline(resNodeStream, fileWriteStream);

          const weightsStat = fs.statSync(tmpPath);
          if (weightsStat.size < 100) {
            fs.unlinkSync(tmpPath);
            console.error(`[BATBOT_V11][REMOTE-TRAINING ERROR] SafeTensors file suspiciously small (${weightsStat.size} bytes).`);
            return false;
          }

          // Atomic rename to final path
          await fs.promises.rename(tmpPath, weightsPath).catch(async () => {
            await fs.promises.copyFile(tmpPath, weightsPath);
            await fs.promises.unlink(tmpPath).catch(() => {});
          });

          // Ensure cfc_updated.safetensors copy exists
          const altWeightsPath = path.join(dir, "cfc_updated.safetensors");
          if (weightsPath !== altWeightsPath) {
            await fs.promises.copyFile(weightsPath, altWeightsPath).catch(() => {});
          }

          return true;
        }
      } catch (err: any) {
        console.warn(`[BATBOT_V11][REMOTE-TRAINING WARN] Weight download exception from '${url}': ${err.message}`);
      }
    }

    return false;
  }

  /**
   * Legacy Fallback: Synchronous HTTP POST Streaming
   */
  private async trainRemotelySynchronous(
    endpointUrl: string,
    datasetPath: string,
    datasetSize: number,
    weightsPath: string,
    timeoutMs: number
  ): Promise<boolean> {
    console.log(`[BATBOT_V11][REMOTE-TRAINING] Executing legacy synchronous HTTP POST offload...`);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        "Content-Length": datasetSize.toString(),
        "User-Agent": "BATBOT_V11-HFT-Client/1.0",
      };

      if (process.env.HFT_SECRET_TOKEN) {
        headers["Authorization"] = `Bearer ${process.env.HFT_SECRET_TOKEN}`;
      }

      const bodyPayload = fs.readFileSync(datasetPath);
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers,
        body: bodyPayload,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok && response.body) {
        const dir = path.dirname(weightsPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const tmpPath = `${weightsPath}.remote.tmp`;
        const fileWriteStream = fs.createWriteStream(tmpPath);
        const resNodeStream = Readable.fromWeb(response.body as any);

        await pipeline(resNodeStream, fileWriteStream);

        const weightsStat = fs.statSync(tmpPath);
        if (weightsStat.size >= 100) {
          await fs.promises.rename(tmpPath, weightsPath).catch(async () => {
            await fs.promises.copyFile(tmpPath, weightsPath);
            await fs.promises.unlink(tmpPath).catch(() => {});
          });
          return true;
        }
      }
    } catch (err: any) {
      console.error(`[BATBOT_V11][REMOTE-TRAINING ERROR] Legacy sync offload failed: ${err.message}`);
    }
    return false;
  }
}
