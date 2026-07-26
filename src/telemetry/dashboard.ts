import { TradeLoggerStats } from "./logger";

export interface TelemetryFrame {
  symbol: string;
  sequenceNum: bigint;
  bidPrice: number;
  askPrice: number;
  obi: number;
  cvd: number;
  spreadVelocity: number;
  lastSignal: "NONE" | "BUY" | "SELL";
  tickEvaluationLatencyUs: number;
  stats: TradeLoggerStats;
  riskStatus: string;
  isEngineActive: boolean;
}

export class CLIDashboard {
  private enabled: boolean;
  private lastRenderTimestamp = 0;
  private renderIntervalMs = 200; // 5Hz UI refresh rate to save CPU/GPU

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  /**
   * Renders real-time HFT telemetry frame directly to stdout using ANSI control codes.
   */
  public render(frame: TelemetryFrame): void {
    if (!this.enabled) return;

    const now = Date.now();
    if (now - this.lastRenderTimestamp < this.renderIntervalMs) {
      return;
    }
    this.lastRenderTimestamp = now;

    const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const spread = (frame.askPrice - frame.bidPrice).toFixed(2);
    const obiBar = this.formatProgressBar(frame.obi, -1, 1, 20);
    const pnlColor = frame.stats.realizedPnl >= 0 ? "\x1b[32m" : "\x1b[31m";
    const signalColor = frame.lastSignal === "BUY" ? "\x1b[32m" : frame.lastSignal === "SELL" ? "\x1b[31m" : "\x1b[90m";
    const reset = "\x1b[0m";
    const cyan = "\x1b[36m";
    const yellow = "\x1b[33m";
    const bold = "\x1b[1m";

    let output = "";
    output += "\x1b[2J\x1b[3J\x1b[H"; // Clear screen viewport, clear scrollback, move cursor to top-left (0,0)

    output += `${cyan}${bold}================================================================================${reset}\n`;
    output += `${cyan}${bold}            BATBOT_V11 HFT ENGINE TELEMETRY & COMMAND MONITOR                   ${reset}\n`;
    output += `${cyan}${bold}================================================================================${reset}\n`;
    output += ` Status: ${frame.isEngineActive ? "\x1b[32m[LIVE ACTIVE]\x1b[0m" : "\x1b[33m[IDLE/PAUSED]\x1b[0m"}  |  Memory: ${memMb} MB  |  Sequence: #${frame.sequenceNum.toString()}\n`;
    output += ` Tick Latency: ${yellow}${frame.tickEvaluationLatencyUs.toFixed(3)} µs${reset}  |  Avg Latency: ${frame.stats.avgTickLatencyUs.toFixed(3)} µs  |  Queue Depth: ${frame.stats.bufferQueueDepth}\n`;
    output += `--------------------------------------------------------------------------------\n`;
    output += `${bold}--- ORDER BOOK & MICROSTRUCTURE METRICS (${frame.symbol}) ---${reset}\n`;
    output += ` Best Bid: ${frame.bidPrice.toFixed(2)}  |  Best Ask: ${frame.askPrice.toFixed(2)}  |  Spread: ${spread}\n`;
    output += ` OBI (-1..+1): [${obiBar}]  Val: ${frame.obi >= 0 ? "+" : ""}${frame.obi.toFixed(4)}\n`;
    output += ` CVD: ${frame.cvd >= 0 ? "+" : ""}${frame.cvd.toFixed(2)}  |  Spread Velocity: ${frame.spreadVelocity.toFixed(4)}\n`;
    output += `--------------------------------------------------------------------------------\n`;
    output += `${bold}--- STRATEGY & RISK STATUS ---${reset}\n`;
    output += ` Active Signal: ${signalColor}${bold}${frame.lastSignal}${reset}  |  Risk Gate: ${frame.riskStatus}\n`;
    output += ` Logged Signals: ${frame.stats.totalSignalsLogged}  |  Executions Logged: ${frame.stats.totalExecutionsLogged}\n`;
    output += `--------------------------------------------------------------------------------\n`;
    output += `${bold}--- TRADING PERFORMANCE & PnL ---${reset}\n`;
    output += ` Realized PnL: ${pnlColor}${bold}$${frame.stats.realizedPnl.toFixed(2)}${reset}  |  Cumulative Fees: $${frame.stats.totalFees.toFixed(2)}\n`;
    output += ` Win Rate: ${yellow}${frame.stats.winRatePercent.toFixed(2)}%${reset}  |  Total Trades: ${frame.stats.totalTrades} (W: ${frame.stats.winningTrades} / L: ${frame.stats.losingTrades})\n`;
    output += `${cyan}${bold}================================================================================${reset}\n`;

    process.stdout.write(output);
  }

  private formatProgressBar(val: number, min: number, max: number, length: number): string {
    const clamped = Math.max(min, Math.min(max, val));
    const norm = (clamped - min) / (max - min);
    const filled = Math.round(norm * length);
    const empty = length - filled;
    return "\x1b[32m" + "=".repeat(filled) + "\x1b[90m" + "-".repeat(empty) + "\x1b[0m";
  }

  public clear(): void {
    if (this.enabled) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
  }
}
