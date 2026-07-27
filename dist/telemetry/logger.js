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
exports.TradeLogger = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DEFAULT_BUFFER_SIZE = 10000;
class TradeLogger {
    logDir;
    signalLogPath;
    executionLogPath;
    // Pre-allocated Circular Ring Buffer for Signals to avoid heap allocations on tick evaluation
    signalRingBuffer;
    signalHead = 0;
    signalTail = 0;
    signalCount = 0;
    // Pre-allocated Circular Ring Buffer for Executions
    executionRingBuffer;
    executionHead = 0;
    executionTail = 0;
    executionCount = 0;
    bufferCapacity;
    flushTimer = null;
    isFlushing = false;
    processedTickCount = 0;
    // Performance & PnL Aggregators
    totalSignalsLogged = 0;
    totalExecutionsLogged = 0;
    totalTrades = 0;
    winningTrades = 0;
    losingTrades = 0;
    cumulativeRealizedPnl = 0;
    cumulativeFees = 0;
    cumulativeTickLatencyUs = 0;
    tickCountForLatency = 0;
    constructor(outputDir = "data", bufferCapacity = DEFAULT_BUFFER_SIZE) {
        this.logDir = path.resolve(process.cwd(), outputDir);
        this.signalLogPath = path.join(this.logDir, "signals.jsonl");
        this.executionLogPath = path.join(this.logDir, "executions.jsonl");
        this.bufferCapacity = bufferCapacity;
        // Ensure storage directory exists
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        // Pre-allocate fixed-size ring buffer objects to guarantee Zero-GC impact on hot-path
        this.signalRingBuffer = new Array(this.bufferCapacity);
        for (let i = 0; i < this.bufferCapacity; i++) {
            this.signalRingBuffer[i] = {
                timestamp: 0,
                sequenceNum: 0n,
                signalType: "NONE",
                obi: 0,
                cvd: 0,
                spreadVelocity: 0,
                bidPrice: 0,
                askPrice: 0,
                latencyUs: 0,
            };
        }
        this.executionRingBuffer = new Array(this.bufferCapacity);
        for (let i = 0; i < this.bufferCapacity; i++) {
            this.executionRingBuffer[i] = {
                timestamp: 0,
                symbol: "",
                side: "BUY",
                price: 0,
                quantity: 0,
                realizedPnl: 0,
                fee: 0,
                latencyMs: 0,
            };
        }
        // Background asynchronous batch persistence timer (flushes every 250ms)
        this.flushTimer = setInterval(() => {
            this.flushAsync().catch((err) => {
                console.error(`[TradeLogger] Background flush error: ${err.message}`);
            });
        }, 250);
    }
    /**
     * Hot-path non-blocking signal logger.
     * Modifies pre-allocated ring buffer slot in O(1) time without GC allocations.
     */
    logSignal(sequenceNum, signalType, obi, cvd, spreadVelocity, bidPrice, askPrice, latencyUs) {
        this.processedTickCount++;
        // Only log actionable signals or periodic metric samples to keep buffer clean
        if (signalType === "NONE" && this.processedTickCount % 100 !== 0) {
            this.cumulativeTickLatencyUs += latencyUs;
            this.tickCountForLatency++;
            return;
        }
        const slot = this.signalRingBuffer[this.signalHead];
        slot.timestamp = Date.now();
        slot.sequenceNum = sequenceNum;
        slot.signalType = signalType;
        slot.obi = obi;
        slot.cvd = cvd;
        slot.spreadVelocity = spreadVelocity;
        slot.bidPrice = bidPrice;
        slot.askPrice = askPrice;
        slot.latencyUs = latencyUs;
        this.signalHead = (this.signalHead + 1) % this.bufferCapacity;
        if (this.signalCount < this.bufferCapacity) {
            this.signalCount++;
        }
        else {
            // Buffer full: advance tail (drop oldest) to enforce lock-free non-blocking invariant
            this.signalTail = (this.signalTail + 1) % this.bufferCapacity;
        }
        this.totalSignalsLogged++;
        this.cumulativeTickLatencyUs += latencyUs;
        this.tickCountForLatency++;
    }
    /**
     * Non-blocking trade execution logger.
     * Records execution outcome and updates PnL telemetry statistics.
     */
    logExecution(symbol, side, price, quantity, realizedPnl, fee, latencyMs) {
        const slot = this.executionRingBuffer[this.executionHead];
        slot.timestamp = Date.now();
        slot.symbol = symbol;
        slot.side = side;
        slot.price = price;
        slot.quantity = quantity;
        slot.realizedPnl = realizedPnl;
        slot.fee = fee;
        slot.latencyMs = latencyMs;
        this.executionHead = (this.executionHead + 1) % this.bufferCapacity;
        if (this.executionCount < this.bufferCapacity) {
            this.executionCount++;
        }
        else {
            this.executionTail = (this.executionTail + 1) % this.bufferCapacity;
        }
        this.totalExecutionsLogged++;
        this.cumulativeRealizedPnl += realizedPnl;
        this.cumulativeFees += fee;
        if (realizedPnl > 0) {
            this.totalTrades++;
            this.winningTrades++;
        }
        else if (realizedPnl < 0) {
            this.totalTrades++;
            this.losingTrades++;
        }
    }
    /**
     * Asynchronous non-blocking file writer batch flush loop.
     */
    async flushAsync() {
        if (this.isFlushing || (this.signalCount === 0 && this.executionCount === 0)) {
            return;
        }
        this.isFlushing = true;
        try {
            let signalLines = "";
            let execLines = "";
            // Batch drain signal ring buffer synchronously before async I/O yield
            if (this.signalCount > 0) {
                const drainCount = this.signalCount;
                for (let i = 0; i < drainCount; i++) {
                    const idx = (this.signalTail + i) % this.bufferCapacity;
                    const rec = this.signalRingBuffer[idx];
                    signalLines += JSON.stringify({
                        ts: rec.timestamp,
                        seq: rec.sequenceNum.toString(),
                        type: rec.signalType,
                        obi: rec.obi,
                        cvd: rec.cvd,
                        vel: rec.spreadVelocity,
                        bid: rec.bidPrice,
                        ask: rec.askPrice,
                        latUs: rec.latencyUs,
                    }) + "\n";
                }
                this.signalTail = (this.signalTail + drainCount) % this.bufferCapacity;
                this.signalCount -= drainCount;
            }
            // Batch drain execution ring buffer synchronously before async I/O yield
            if (this.executionCount > 0) {
                const drainCount = this.executionCount;
                for (let i = 0; i < drainCount; i++) {
                    const idx = (this.executionTail + i) % this.bufferCapacity;
                    const rec = this.executionRingBuffer[idx];
                    execLines += JSON.stringify(rec) + "\n";
                }
                this.executionTail = (this.executionTail + drainCount) % this.bufferCapacity;
                this.executionCount -= drainCount;
            }
            if (signalLines.length > 0) {
                await fs.promises.appendFile(this.signalLogPath, signalLines, "utf8");
            }
            if (execLines.length > 0) {
                await fs.promises.appendFile(this.executionLogPath, execLines, "utf8");
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[TradeLogger] Append error: ${msg}`);
        }
        finally {
            this.isFlushing = false;
        }
    }
    /**
     * Returns current real-time telemetry and PnL metrics.
     */
    getStats(positionInfo) {
        const winRatePercent = this.totalTrades > 0 ? (this.winningTrades / this.totalTrades) * 100 : 0;
        const avgTickLatencyUs = this.tickCountForLatency > 0 ? this.cumulativeTickLatencyUs / this.tickCountForLatency : 0;
        return {
            totalSignalsLogged: this.totalSignalsLogged,
            totalExecutionsLogged: this.totalExecutionsLogged,
            totalTrades: this.totalTrades,
            winningTrades: this.winningTrades,
            losingTrades: this.losingTrades,
            realizedPnl: Number(this.cumulativeRealizedPnl.toFixed(4)),
            unrealizedPnl: Number((positionInfo?.unrealizedPnl ?? 0).toFixed(4)),
            positionSide: positionInfo?.positionSide ?? "FLAT",
            netQuantity: Number((positionInfo?.netQuantity ?? 0).toFixed(6)),
            averageEntryPrice: Number((positionInfo?.averageEntryPrice ?? 0).toFixed(4)),
            totalFees: Number(this.cumulativeFees.toFixed(4)),
            winRatePercent: Number(winRatePercent.toFixed(2)),
            avgTickLatencyUs: Number(avgTickLatencyUs.toFixed(3)),
            bufferQueueDepth: this.signalCount + this.executionCount,
        };
    }
    /**
     * Graceful shutdown of logger.
     */
    async close() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flushAsync();
    }
}
exports.TradeLogger = TradeLogger;
