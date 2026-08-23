import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

export interface TimeSyncSample {
  serverTime: number;
  localTimeAtRequest: number;
  localTimeAtResponse: number;
  rttMs: number;
  rawOffsetMs: number;
}

export interface TimeSynchronizerOptions {
  baseUrl?: string;
  useTestnet?: boolean;
  syncIntervalMs?: number;
  maxAcceptableRttMs?: number;
  ewmaAlpha?: number;
  startupBurstSamples?: number;
  onOffsetUpdated?: (offsetMs: number) => void;
}

export class TimeSynchronizer {
  private static instance: TimeSynchronizer | null = null;

  private baseUrl: string;
  private syncIntervalMs: number;
  private maxAcceptableRttMs: number;
  private ewmaAlpha: number;
  private startupBurstSamples: number;

  private offsetMs: number = 0;
  private isInitialized: boolean = false;
  private lastSyncTimestamp: number = 0;
  private lastRttMs: number = 0;
  private ewmaRttMs: number = 0;
  private rttJitterMs: number = 0;
  private syncTimer: NodeJS.Timeout | null = null;
  private inFlightSyncPromise: Promise<number> | null = null;
  private onOffsetUpdatedCallbacks: Set<(offsetMs: number) => void> = new Set();

  constructor(options?: TimeSynchronizerOptions) {
    const isTestnet =
      options?.useTestnet ??
      (process.env.USE_TESTNET === "true" ||
        process.env.USE_TESTNET === "1" ||
        process.env.BINANCE_TESTNET === "true");

    const defaultRestBase = isTestnet
      ? "https://testnet.binancefuture.com"
      : "https://fapi.binance.com";

    this.baseUrl = options?.baseUrl ?? defaultRestBase;
    this.syncIntervalMs = options?.syncIntervalMs ?? 30000;
    this.maxAcceptableRttMs =
      options?.maxAcceptableRttMs ??
      (process.env.TIME_SYNC_MAX_RTT_MS ? parseInt(process.env.TIME_SYNC_MAX_RTT_MS, 10) : 1500);
    this.ewmaAlpha = options?.ewmaAlpha ?? 0.25;
    this.startupBurstSamples = options?.startupBurstSamples ?? 5;

    if (options?.onOffsetUpdated) {
      this.onOffsetUpdatedCallbacks.add(options.onOffsetUpdated);
    }
  }

  public static getInstance(options?: TimeSynchronizerOptions): TimeSynchronizer {
    if (!TimeSynchronizer.instance) {
      TimeSynchronizer.instance = new TimeSynchronizer(options);
    }
    return TimeSynchronizer.instance;
  }

  /**
   * Resets the singleton instance (useful for testing).
   */
  public static resetInstance(): void {
    if (TimeSynchronizer.instance) {
      TimeSynchronizer.instance.stop();
      TimeSynchronizer.instance = null;
    }
  }

  public subscribeOffsetUpdated(cb: (offsetMs: number) => void): () => void {
    this.onOffsetUpdatedCallbacks.add(cb);
    return () => {
      this.onOffsetUpdatedCallbacks.delete(cb);
    };
  }

  /**
   * Returns the adjusted current timestamp in milliseconds (Date.now() + offset).
   */
  public getAdjustedNowMs(): number {
    const offset = Number.isFinite(this.offsetMs) ? Math.round(this.offsetMs) : 0;
    return Date.now() + offset;
  }

  /**
   * Returns the adjusted current timestamp in nanoseconds.
   */
  public getAdjustedNowNs(): bigint {
    const offset = Number.isFinite(this.offsetMs) ? Math.round(this.offsetMs) : 0;
    const nowMs = Date.now() + offset;
    return BigInt(nowMs) * 1000000n;
  }

  /**
   * Returns the smoothed time offset in milliseconds (serverTime - localTime).
   */
  public getOffsetMs(): number {
    return this.offsetMs;
  }

  public getLastRttMs(): number {
    return this.lastRttMs;
  }

  public getSmoothedRttMs(): number {
    return this.ewmaRttMs > 0 ? this.ewmaRttMs : this.lastRttMs;
  }

  public getRttJitterMs(): number {
    return this.rttJitterMs;
  }

  public isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Manually sets the offset (useful for test simulations and unit tests).
   */
  public setManualOffsetMs(offset: number): void {
    this.offsetMs = Number.isFinite(offset) ? offset : 0;
    this.isInitialized = true;
    this.lastSyncTimestamp = Date.now();
    for (const cb of this.onOffsetUpdatedCallbacks) {
      try {
        cb(this.offsetMs);
      } catch (err: unknown) {
        console.error(`[TimeSynchronizer] Callback error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Executes a single probe against GET /fapi/v1/time using Cristian's Algorithm.
   * Discards samples with RTT > maxAcceptableRttMs (default 150ms).
   */
  public async probeServerTime(): Promise<TimeSyncSample | null> {
    const t0 = Date.now();
    try {
      const serverTime = await this.fetchBinanceServerTime();
      if (!Number.isFinite(serverTime)) {
        console.warn(`[TimeSynchronizer][NON_FINITE_PAYLOAD] serverTime ${serverTime} is not finite. Discarding probe.`);
        return null;
      }
      const t1 = Date.now();
      const rtt = t1 - t0;

      if (rtt > this.maxAcceptableRttMs) {
        console.warn(
          `[TimeSynchronizer][OUTLIER_REJECTED] Probe RTT ${rtt}ms exceeds threshold (${this.maxAcceptableRttMs}ms). Discarding sample.`
        );
        return null;
      }

      // Cristian's Algorithm: assume symmetric network latency (one-way latency = RTT / 2)
      const estimatedOneWayLatency = Math.floor(rtt / 2);
      const rawOffset = serverTime - (t0 + estimatedOneWayLatency);

      if (!Number.isFinite(rawOffset)) {
        return null;
      }

      return {
        serverTime,
        localTimeAtRequest: t0,
        localTimeAtResponse: t1,
        rttMs: rtt,
        rawOffsetMs: rawOffset,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[TimeSynchronizer][PROBE_ERROR] Failed to fetch server time: ${msg}`);
      return null;
    }
  }

  /**
   * Synchronizes time using Cristian's Algorithm and updates the rolling EWMA offset.
   */
  public async sync(): Promise<number> {
    if (this.inFlightSyncPromise) {
      return this.inFlightSyncPromise;
    }

    this.inFlightSyncPromise = (async () => {
      try {
        const sample = await this.probeServerTime();
        if (sample !== null) {
          this.applySample(sample);
        }
      } finally {
        this.inFlightSyncPromise = null;
      }
      return this.offsetMs;
    })();

    return this.inFlightSyncPromise;
  }

  /**
   * Starts the time synchronizer with a fast startup burst (5 samples) and periodic background sync (every 30s).
   */
  public async start(): Promise<void> {
    if (this.syncTimer) {
      return;
    }

    console.log(`[TimeSynchronizer] Starting SOTA Time Synchronization Engine (BaseUrl: ${this.baseUrl}, Interval: ${this.syncIntervalMs}ms)...`);

    // Startup Burst: Probe multiple times and pick the best (lowest RTT) sample for initial calibration
    const validSamples: TimeSyncSample[] = [];
    for (let i = 0; i < this.startupBurstSamples; i++) {
      const sample = await this.probeServerTime();
      if (sample) {
        validSamples.push(sample);
      }
      if (i < this.startupBurstSamples - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    if (validSamples.length > 0) {
      // Sort by RTT and pick the lowest-latency sample for initial anchoring
      validSamples.sort((a, b) => a.rttMs - b.rttMs);
      const bestSample = validSamples[0];
      this.offsetMs = bestSample.rawOffsetMs;
      this.lastRttMs = bestSample.rttMs;
      this.isInitialized = true;
      this.lastSyncTimestamp = Date.now();

      console.log(
        `[TimeSynchronizer][CALIBRATED] Startup calibration complete. Initial Offset: ${this.offsetMs > 0 ? "+" : ""}${this.offsetMs}ms (Best RTT: ${bestSample.rttMs}ms from ${validSamples.length} samples). Adjusted Now: ${new Date(this.getAdjustedNowMs()).toISOString()}`
      );

      for (const cb of this.onOffsetUpdatedCallbacks) {
        try {
          cb(this.offsetMs);
        } catch (err: unknown) {
          console.error(`[TimeSynchronizer] Startup callback error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      console.warn(`[TimeSynchronizer][WARN] Startup burst failed to collect valid samples under ${this.maxAcceptableRttMs}ms RTT. Operating with zero offset until background sync.`);
    }

    // Start continuous periodic synchronization loop
    this.syncTimer = setInterval(() => {
      this.sync().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[TimeSynchronizer][SYNC_WARN] Periodic time sync notice: ${msg}`);
      });
    }, this.syncIntervalMs);
  }

  public stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private applySample(sample: TimeSyncSample): void {
    if (!Number.isFinite(sample.rawOffsetMs) || !Number.isFinite(sample.rttMs)) {
      return;
    }
    this.lastRttMs = sample.rttMs;
    this.lastSyncTimestamp = Date.now();

    if (!this.isInitialized) {
      this.offsetMs = sample.rawOffsetMs;
      this.ewmaRttMs = sample.rttMs;
      this.rttJitterMs = 0;
      this.isInitialized = true;
    } else {
      // Exponentially Weighted Moving Average (EWMA) smoother
      const prevOffset = this.offsetMs;
      this.offsetMs = this.ewmaAlpha * sample.rawOffsetMs + (1 - this.ewmaAlpha) * prevOffset;

      // RFC 6298 Jacobson RTT & Jitter Tracking
      const rttDiff = Math.abs(sample.rttMs - this.ewmaRttMs);
      this.ewmaRttMs = 0.125 * sample.rttMs + 0.875 * this.ewmaRttMs;
      this.rttJitterMs = 0.25 * rttDiff + 0.75 * this.rttJitterMs;
    }

    for (const cb of this.onOffsetUpdatedCallbacks) {
      try {
        cb(this.offsetMs);
      } catch (err: unknown) {
        console.error(`[TimeSynchronizer] Offset update callback error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private fetchBinanceServerTime(): Promise<number> {
    const fullUrl = `${this.baseUrl}/fapi/v1/time`;
    const url = new URL(fullUrl);
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : http;
    const socketTimeoutMs = Math.max(2500, this.maxAcceptableRttMs + 1000);

    return new Promise((resolve, reject) => {
      let isSettled = false;
      const req = httpModule.get(
        fullUrl,
        {
          timeout: socketTimeoutMs,
          headers: {
            "User-Agent": "BATBOT_V11-HFT-Engine/1.0",
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            if (isSettled) return;
            isSettled = true;
            try {
              const data = JSON.parse(body);
              if (data && typeof data.serverTime === "number" && Number.isFinite(data.serverTime)) {
                resolve(data.serverTime);
              } else {
                reject(new Error(`Invalid serverTime payload: ${body}`));
              }
            } catch (err) {
              reject(new Error(`Failed to parse Binance time response: ${body}`));
            }
          });
        }
      );

      req.setTimeout(socketTimeoutMs, () => {
        if (isSettled) return;
        isSettled = true;
        req.destroy(new Error(`Timeout (${socketTimeoutMs}ms) fetching Binance server time`));
        reject(new Error(`Timeout (${socketTimeoutMs}ms) fetching Binance server time`));
      });

      req.on("error", (err) => {
        if (isSettled) return;
        isSettled = true;
        reject(err);
      });
    });
  }
}

export const timeSynchronizer = TimeSynchronizer.getInstance();
