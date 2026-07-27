import * as fs from "fs";
import * as path from "path";

export interface SignalRecord {
  timestamp: number;
  sequenceNum: bigint;
  signalType: "NONE" | "BUY" | "SELL";
  obi: number;
  cvd: number;
  spreadVelocity: number;
  bidPrice: number;
  askPrice: number;
  latencyUs: number;
}

export interface ExecutionRecord {
  timestamp: number;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  realizedPnl: number;
  fee: number;
  latencyMs: number;
}

export interface TradeLoggerStats {
  totalSignalsLogged: number;
  totalExecutionsLogged: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  realizedPnl: number;
  unrealizedPnl: number;
  positionSide: "FLAT" | "LONG" | "SHORT";
  netQuantity: number;
  averageEntryPrice: number;
  totalFees: number;
  winRatePercent: number;
  avgTickLatencyUs: number;
  bufferQueueDepth: number;
}

const DEFAULT_BUFFER_SIZE = 10000;

export class TradeLogger {
  private logDir: string;
  private signalLogPath: string;
  private executionLogPath: string;
  
  // Pre-allocated Circular Ring Buffer for Signals to avoid heap allocations on tick evaluation
  private signalRingBuffer: SignalRecord[];
  private signalHead = 0;
  private signalTail = 0;
  private signalCount = 0;

  // Pre-allocated Circular Ring Buffer for Executions
  private executionRingBuffer: ExecutionRecord[];
  private executionHead = 0;
  private executionTail = 0;
  private executionCount = 0;

  private bufferCapacity: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private processedTickCount = 0;

  // Performance & PnL Aggregators
  private totalSignalsLogged = 0;
  private totalExecutionsLogged = 0;
  private totalTrades = 0;
  private winningTrades = 0;
  private losingTrades = 0;
  private cumulativeRealizedPnl = 0;
  private cumulativeFees = 0;
  private cumulativeTickLatencyUs = 0;
  private tickCountForLatency = 0;

  constructor(outputDir: string = "data", bufferCapacity: number = DEFAULT_BUFFER_SIZE) {
    this.logDir = path.resolve(process.cwd(), outputDir);
    this.signalLogPath = path.join(this.logDir, "signals.jsonl");
    this.executionLogPath = path.join(this.logDir, "executions.jsonl");
    this.bufferCapacity = bufferCapacity;

    // Ensure storage directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // Pre-allocate fixed-size ring buffer objects to guarantee Zero-GC impact on hot-path
    this.signalRingBuffer = new Array<SignalRecord>(this.bufferCapacity);
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

    this.executionRingBuffer = new Array<ExecutionRecord>(this.bufferCapacity);
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
  public logSignal(
    sequenceNum: bigint,
    signalType: "NONE" | "BUY" | "SELL",
    obi: number,
    cvd: number,
    spreadVelocity: number,
    bidPrice: number,
    askPrice: number,
    latencyUs: number
  ): void {
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
    } else {
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
  public logExecution(
    symbol: string,
    side: "BUY" | "SELL",
    price: number,
    quantity: number,
    realizedPnl: number,
    fee: number,
    latencyMs: number
  ): void {
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
    } else {
      this.executionTail = (this.executionTail + 1) % this.bufferCapacity;
    }

    this.totalExecutionsLogged++;
    this.cumulativeRealizedPnl += realizedPnl;
    this.cumulativeFees += fee;

    if (realizedPnl > 0) {
      this.totalTrades++;
      this.winningTrades++;
    } else if (realizedPnl < 0) {
      this.totalTrades++;
      this.losingTrades++;
    }
  }

  /**
   * Asynchronous non-blocking file writer batch flush loop.
   */
  public async flushAsync(): Promise<void> {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TradeLogger] Append error: ${msg}`);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Returns current real-time telemetry and PnL metrics using PositionLedger as Single Source of Truth.
   */
  public getStats(positionInfo?: {
    unrealizedPnl?: number;
    positionSide?: "FLAT" | "LONG" | "SHORT";
    netQuantity?: number;
    averageEntryPrice?: number;
    cumulativeRealizedPnl?: number;
    cumulativeFees?: number;
    totalTrades?: number;
    winningTrades?: number;
    losingTrades?: number;
  }): TradeLoggerStats {
    const totalTrades = positionInfo?.totalTrades ?? this.totalTrades;
    const winningTrades = positionInfo?.winningTrades ?? this.winningTrades;
    const losingTrades = positionInfo?.losingTrades ?? this.losingTrades;
    const realizedPnl = positionInfo?.cumulativeRealizedPnl ?? this.cumulativeRealizedPnl;
    const totalFees = positionInfo?.cumulativeFees ?? this.cumulativeFees;

    const winRatePercent = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const avgTickLatencyUs = this.tickCountForLatency > 0 ? this.cumulativeTickLatencyUs / this.tickCountForLatency : 0;

    return {
      totalSignalsLogged: this.totalSignalsLogged,
      totalExecutionsLogged: this.totalExecutionsLogged,
      totalTrades,
      winningTrades,
      losingTrades,
      realizedPnl: Number(realizedPnl.toFixed(4)),
      unrealizedPnl: Number((positionInfo?.unrealizedPnl ?? 0).toFixed(4)),
      positionSide: positionInfo?.positionSide ?? "FLAT",
      netQuantity: Number((positionInfo?.netQuantity ?? 0).toFixed(6)),
      averageEntryPrice: Number((positionInfo?.averageEntryPrice ?? 0).toFixed(4)),
      totalFees: Number(totalFees.toFixed(4)),
      winRatePercent: Number(winRatePercent.toFixed(2)),
      avgTickLatencyUs: Number(avgTickLatencyUs.toFixed(3)),
      bufferQueueDepth: this.signalCount + this.executionCount,
    };
  }

  /**
   * Graceful shutdown of logger.
   */
  public async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushAsync();
  }
}
