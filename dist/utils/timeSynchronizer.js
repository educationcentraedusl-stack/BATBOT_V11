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
exports.timeSynchronizer = exports.TimeSynchronizer = void 0;
const https = __importStar(require("node:https"));
const http = __importStar(require("node:http"));
const node_url_1 = require("node:url");
class TimeSynchronizer {
    static instance = null;
    baseUrl;
    syncIntervalMs;
    maxAcceptableRttMs;
    ewmaAlpha;
    startupBurstSamples;
    offsetMs = 0;
    isInitialized = false;
    lastSyncTimestamp = 0;
    lastRttMs = 0;
    syncTimer = null;
    inFlightSyncPromise = null;
    onOffsetUpdatedCallbacks = new Set();
    constructor(options) {
        const isTestnet = options?.useTestnet ??
            (process.env.USE_TESTNET === "true" ||
                process.env.USE_TESTNET === "1" ||
                process.env.BINANCE_TESTNET === "true");
        const defaultRestBase = isTestnet
            ? "https://testnet.binancefuture.com"
            : "https://fapi.binance.com";
        this.baseUrl = options?.baseUrl ?? defaultRestBase;
        this.syncIntervalMs = options?.syncIntervalMs ?? 30000;
        this.maxAcceptableRttMs = options?.maxAcceptableRttMs ?? 150;
        this.ewmaAlpha = options?.ewmaAlpha ?? 0.25;
        this.startupBurstSamples = options?.startupBurstSamples ?? 5;
        if (options?.onOffsetUpdated) {
            this.onOffsetUpdatedCallbacks.add(options.onOffsetUpdated);
        }
    }
    static getInstance(options) {
        if (!TimeSynchronizer.instance) {
            TimeSynchronizer.instance = new TimeSynchronizer(options);
        }
        return TimeSynchronizer.instance;
    }
    /**
     * Resets the singleton instance (useful for testing).
     */
    static resetInstance() {
        if (TimeSynchronizer.instance) {
            TimeSynchronizer.instance.stop();
            TimeSynchronizer.instance = null;
        }
    }
    subscribeOffsetUpdated(cb) {
        this.onOffsetUpdatedCallbacks.add(cb);
        return () => {
            this.onOffsetUpdatedCallbacks.delete(cb);
        };
    }
    /**
     * Returns the adjusted current timestamp in milliseconds (Date.now() + offset).
     */
    getAdjustedNowMs() {
        const offset = Number.isFinite(this.offsetMs) ? Math.round(this.offsetMs) : 0;
        return Date.now() + offset;
    }
    /**
     * Returns the adjusted current timestamp in nanoseconds.
     */
    getAdjustedNowNs() {
        const offset = Number.isFinite(this.offsetMs) ? Math.round(this.offsetMs) : 0;
        const nowMs = Date.now() + offset;
        return BigInt(nowMs) * 1000000n;
    }
    /**
     * Returns the smoothed time offset in milliseconds (serverTime - localTime).
     */
    getOffsetMs() {
        return this.offsetMs;
    }
    getLastRttMs() {
        return this.lastRttMs;
    }
    isReady() {
        return this.isInitialized;
    }
    /**
     * Manually sets the offset (useful for test simulations and unit tests).
     */
    setManualOffsetMs(offset) {
        this.offsetMs = Number.isFinite(offset) ? offset : 0;
        this.isInitialized = true;
        this.lastSyncTimestamp = Date.now();
        for (const cb of this.onOffsetUpdatedCallbacks) {
            try {
                cb(this.offsetMs);
            }
            catch (err) {
                console.error(`[TimeSynchronizer] Callback error: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    /**
     * Executes a single probe against GET /fapi/v1/time using Cristian's Algorithm.
     * Discards samples with RTT > maxAcceptableRttMs (default 150ms).
     */
    async probeServerTime() {
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
                console.warn(`[TimeSynchronizer][OUTLIER_REJECTED] Probe RTT ${rtt}ms exceeds threshold (${this.maxAcceptableRttMs}ms). Discarding sample.`);
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[TimeSynchronizer][PROBE_ERROR] Failed to fetch server time: ${msg}`);
            return null;
        }
    }
    /**
     * Synchronizes time using Cristian's Algorithm and updates the rolling EWMA offset.
     */
    async sync() {
        if (this.inFlightSyncPromise) {
            return this.inFlightSyncPromise;
        }
        this.inFlightSyncPromise = (async () => {
            try {
                const sample = await this.probeServerTime();
                if (sample !== null) {
                    this.applySample(sample);
                }
            }
            finally {
                this.inFlightSyncPromise = null;
            }
            return this.offsetMs;
        })();
        return this.inFlightSyncPromise;
    }
    /**
     * Starts the time synchronizer with a fast startup burst (5 samples) and periodic background sync (every 30s).
     */
    async start() {
        if (this.syncTimer) {
            return;
        }
        console.log(`[TimeSynchronizer] Starting SOTA Time Synchronization Engine (BaseUrl: ${this.baseUrl}, Interval: ${this.syncIntervalMs}ms)...`);
        // Startup Burst: Probe multiple times and pick the best (lowest RTT) sample for initial calibration
        const validSamples = [];
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
            console.log(`[TimeSynchronizer][CALIBRATED] Startup calibration complete. Initial Offset: ${this.offsetMs > 0 ? "+" : ""}${this.offsetMs}ms (Best RTT: ${bestSample.rttMs}ms from ${validSamples.length} samples). Adjusted Now: ${new Date(this.getAdjustedNowMs()).toISOString()}`);
            for (const cb of this.onOffsetUpdatedCallbacks) {
                try {
                    cb(this.offsetMs);
                }
                catch (err) {
                    console.error(`[TimeSynchronizer] Startup callback error: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        else {
            console.warn(`[TimeSynchronizer][WARN] Startup burst failed to collect valid samples under ${this.maxAcceptableRttMs}ms RTT. Operating with zero offset until background sync.`);
        }
        // Start continuous periodic synchronization loop
        this.syncTimer = setInterval(() => {
            this.sync().catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[TimeSynchronizer][SYNC_WARN] Periodic time sync notice: ${msg}`);
            });
        }, this.syncIntervalMs);
    }
    stop() {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
    }
    applySample(sample) {
        if (!Number.isFinite(sample.rawOffsetMs) || !Number.isFinite(sample.rttMs)) {
            return;
        }
        this.lastRttMs = sample.rttMs;
        this.lastSyncTimestamp = Date.now();
        if (!this.isInitialized) {
            this.offsetMs = sample.rawOffsetMs;
            this.isInitialized = true;
        }
        else {
            // Exponentially Weighted Moving Average (EWMA) smoother
            const prevOffset = this.offsetMs;
            this.offsetMs = this.ewmaAlpha * sample.rawOffsetMs + (1 - this.ewmaAlpha) * prevOffset;
        }
        for (const cb of this.onOffsetUpdatedCallbacks) {
            try {
                cb(this.offsetMs);
            }
            catch (err) {
                console.error(`[TimeSynchronizer] Offset update callback error: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    fetchBinanceServerTime() {
        const fullUrl = `${this.baseUrl}/fapi/v1/time`;
        const url = new node_url_1.URL(fullUrl);
        const isHttps = url.protocol === "https:";
        const httpModule = isHttps ? https : http;
        return new Promise((resolve, reject) => {
            let isSettled = false;
            const req = httpModule.get(fullUrl, {
                timeout: 1000,
                headers: {
                    "User-Agent": "BATBOT_V11-HFT-Engine/1.0",
                },
            }, (res) => {
                let body = "";
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", () => {
                    if (isSettled)
                        return;
                    isSettled = true;
                    try {
                        const data = JSON.parse(body);
                        if (data && typeof data.serverTime === "number" && Number.isFinite(data.serverTime)) {
                            resolve(data.serverTime);
                        }
                        else {
                            reject(new Error(`Invalid serverTime payload: ${body}`));
                        }
                    }
                    catch (err) {
                        reject(new Error(`Failed to parse Binance time response: ${body}`));
                    }
                });
            });
            req.setTimeout(1000, () => {
                if (isSettled)
                    return;
                isSettled = true;
                req.destroy(new Error("Timeout (1000ms) fetching Binance server time"));
                reject(new Error("Timeout (1000ms) fetching Binance server time"));
            });
            req.on("error", (err) => {
                if (isSettled)
                    return;
                isSettled = true;
                reject(err);
            });
        });
    }
}
exports.TimeSynchronizer = TimeSynchronizer;
exports.timeSynchronizer = TimeSynchronizer.getInstance();
