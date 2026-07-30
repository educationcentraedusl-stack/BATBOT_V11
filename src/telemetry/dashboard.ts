import * as fs from "fs";
import * as path from "path";
import { TradeLoggerStats } from "./logger";
import { ActiveTradeSlot } from "../strategy/positionLedger";

function readTrainingProgress(): number | null {
  try {
    const progressPath = path.resolve(process.cwd(), ".training_progress");
    if (fs.existsSync(progressPath)) {
      const raw = fs.readFileSync(progressPath, "utf-8").trim();
      const val = parseInt(raw, 10);
      if (!isNaN(val) && val >= 0 && val <= 100) {
        return val;
      }
    }
  } catch (_e) {
    // Safe non-blocking read
  }
  return null;
}

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
  usdtBalance: number;
  aiDirection?: number;
  aiConfidence?: number;
  rollingIc?: number;
  aiInferenceLatencyNs?: bigint;
  rttMs?: number;
  latencyPenalty?: number;
  slippageTicks?: number;
  activeTrades?: ActiveTradeSlot[];
}

export class CLIDashboard {
  private enabled: boolean;
  private lastRenderTimestamp = 0;
  private renderIntervalMs = 200; // 5Hz UI refresh rate to save CPU/GPU
  private static promptActive = false;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  public static setPromptActive(active: boolean): void {
    CLIDashboard.promptActive = active;
  }

  public static isPromptActive(): boolean {
    return CLIDashboard.promptActive;
  }

  /**
   * Renders real-time HFT telemetry frame directly to stdout using ANSI control codes.
   */
  public render(frame: TelemetryFrame): void {
    if (!this.enabled || CLIDashboard.promptActive) return;

    const now = Date.now();
    if (now - this.lastRenderTimestamp < this.renderIntervalMs) {
      return;
    }
    this.lastRenderTimestamp = now;

    const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const spread = (frame.askPrice - frame.bidPrice).toFixed(2);
    const obiBar = this.formatProgressBar(frame.obi, -1, 1, 20);
    const unrealizedColor = frame.stats.unrealizedPnl >= 0 ? "\x1b[32m" : "\x1b[31m";
    const pnlColor = frame.stats.realizedPnl >= 0 ? "\x1b[32m" : "\x1b[31m";
    const signalColor = frame.lastSignal === "BUY" ? "\x1b[32m" : frame.lastSignal === "SELL" ? "\x1b[31m" : "\x1b[90m";
    const posSideColor = frame.stats.positionSide === "LONG" ? "\x1b[32m" : frame.stats.positionSide === "SHORT" ? "\x1b[31m" : "\x1b[33m";
    const reset = "\x1b[0m";
    const cyan = "\x1b[36m";
    const yellow = "\x1b[33m";
    const bold = "\x1b[1m";
    const green = "\x1b[32m";
    const red = "\x1b[31m";
    const clearLine = "\x1b[K";

    const aiDir = frame.aiDirection ?? 0;
    const aiConf = (frame.aiConfidence ?? 0) * 100;
    const icVal = frame.rollingIc ?? 0;
    const infLatUs = frame.aiInferenceLatencyNs ? Number(frame.aiInferenceLatencyNs) / 1000 : 0;
    const rtt = frame.rttMs ?? 0;
    const penalty = frame.latencyPenalty ?? 1.0;
    const slippage = frame.slippageTicks ?? 2;
    const aiDirStr = aiDir >= 0 ? `+${aiDir.toFixed(4)}` : aiDir.toFixed(4);

    const borderLine = `${cyan}${bold}======================================================================================================================${reset}${clearLine}\n`;
    const subDivider = `----------------------------------------------------------------------------------------------------------------------${clearLine}\n`;
    const tableDivider = `+-----------+-------------+----------+--------------+----------------+------------+------------+-----------+---------------------+-----------+${clearLine}\n`;

    let output = "";
    output += "\x1b[H"; // Move cursor to top-left (0,0) without full screen erase to eliminate flicker

    output += borderLine;
    output += `${cyan}${bold}                               BATBOT_V11 HFT ENGINE TELEMETRY & COMMAND MONITOR                                      ${reset}${clearLine}\n`;
    output += borderLine;
    output += ` Status: ${frame.isEngineActive ? "\x1b[32m[LIVE ACTIVE]\x1b[0m" : "\x1b[33m[IDLE/PAUSED]\x1b[0m"}  |  Memory: ${memMb} MB  |  Sequence: #${frame.sequenceNum.toString()}${clearLine}\n`;
    output += ` Tick Latency: ${yellow}${frame.tickEvaluationLatencyUs.toFixed(3)} µs${reset}  |  Avg Latency: ${frame.stats.avgTickLatencyUs.toFixed(3)} µs  |  Queue Depth: ${frame.stats.bufferQueueDepth}${clearLine}\n`;
    output += subDivider;
    output += `${bold}--- ORDER BOOK & MICROSTRUCTURE METRICS (${frame.symbol}) ---${reset}${clearLine}\n`;
    output += ` Best Bid: ${frame.bidPrice.toFixed(2)}  |  Best Ask: ${frame.askPrice.toFixed(2)}  |  Spread: ${spread}${clearLine}\n`;
    output += ` OBI (-1..+1): [${obiBar}]  Val: ${frame.obi >= 0 ? "+" : ""}${frame.obi.toFixed(4)}${clearLine}\n`;
    output += ` CVD: ${frame.cvd >= 0 ? "+" : ""}${frame.cvd.toFixed(2)}  |  Spread Velocity: ${frame.spreadVelocity.toFixed(4)}${clearLine}\n`;
    output += subDivider;
    output += `${bold}--- AI PREDICTION & DYNAMIC EXECUTION METRICS ---${reset}${clearLine}\n`;
    output += ` Direction: ${aiDir >= 0 ? "\x1b[32m" : "\x1b[31m"}${aiDirStr}${reset}  |  Confidence: ${yellow}${aiConf.toFixed(1)}%${reset}  |  IC: ${icVal.toFixed(4)}  |  Inference: ${infLatUs.toFixed(1)} µs${clearLine}\n`;
    output += ` REST RTT: ${yellow}${rtt.toFixed(1)} ms${reset}  |  Latency Penalty: ${penalty.toFixed(3)}  |  Slippage Buffer: +${slippage} Ticks${clearLine}\n`;
    output += subDivider;
    output += `${bold}--- STRATEGY & RISK STATUS ---${reset}${clearLine}\n`;
    output += ` Active Signal: ${signalColor}${bold}${frame.lastSignal}${reset}  |  Risk Gate: ${frame.riskStatus}${clearLine}\n`;
    output += ` Logged Signals: ${frame.stats.totalSignalsLogged}  |  Executions Logged: ${frame.stats.totalExecutionsLogged}${clearLine}\n`;
    output += subDivider;
    output += `${bold}--- ACTIVE TRADES MONITOR (SLOTS, TP, SL & LEVERAGE) ---${reset}${clearLine}\n`;
    output += tableDivider;
    output += `| ${bold}Symbol${reset}    | ${bold}Side${reset}        | ${bold}Size${reset}     | ${bold}Entry Price${reset}  | ${bold}Current Price${reset}  | ${bold}TP${reset}         | ${bold}SL${reset}         | ${bold}Leverage${reset}  | ${bold}Unrealized PnL ($)${reset}  | ${bold}Duration${reset}  |${clearLine}\n`;
    output += tableDivider;

    const activeTrades = frame.activeTrades ?? [];
    if (activeTrades.length === 0) {
      output += `| ${yellow}NO ACTIVE OPEN POSITIONS (ALL TRADE SLOTS FLAT)${reset}`.padEnd(142) + `|${clearLine}\n`;
    } else {
      for (const trade of activeTrades) {
        const symStr = trade.symbol.padEnd(9);
        const rawSide = trade.side.startsWith("BUY") || trade.side === "LONG" ? "BUY/LONG" : "SELL/SHORT";
        const sideColor = rawSide === "BUY/LONG" ? green : red;
        const sidePadded = rawSide.padEnd(11);

        const sizeStr = trade.size.toFixed(4).padEnd(8);
        const entryStr = `$${trade.entryPrice.toFixed(2)}`.padEnd(12);
        const currStr = `$${trade.currentPrice.toFixed(2)}`.padEnd(14);
        const tpStr = `$${trade.tpPrice.toFixed(2)}`.padEnd(10);
        const slStr = `$${trade.slPrice.toFixed(2)}`.padEnd(10);
        const levStr = `${trade.leverage}x`.padEnd(9);

        const pnl = trade.unrealizedPnl;
        const pnlSign = pnl >= 0 ? "+" : "";
        const pnlColor = pnl >= 0 ? green : red;
        const pnlRawStr = `${pnlSign}$${pnl.toFixed(2)}`;
        const pnlPadded = pnlRawStr.padEnd(19);

        const durStr = this.formatDuration(trade.durationMs).padEnd(9);

        output += `| ${symStr} | ${sideColor}${bold}${sidePadded}${reset} | ${sizeStr} | ${entryStr} | ${currStr} | ${tpStr} | ${slStr} | ${levStr} | ${pnlColor}${bold}${pnlPadded}${reset} | ${durStr} |${clearLine}\n`;
      }
    }
    output += tableDivider;

    output += `${bold}--- TRADING PERFORMANCE, INVENTORY & PnL ---${reset}${clearLine}\n`;
    output += ` Position: ${posSideColor}${bold}${frame.stats.positionSide}${reset} (${frame.stats.netQuantity.toFixed(4)})  |  Avg Entry: $${frame.stats.averageEntryPrice.toFixed(2)}  |  Unrealized PnL: ${unrealizedColor}${bold}$${frame.stats.unrealizedPnl.toFixed(2)}${reset}${clearLine}\n`;
    output += ` Available Balance: ${green}${bold}$${frame.usdtBalance.toFixed(2)}${reset}  |  Realized PnL: ${pnlColor}${bold}$${frame.stats.realizedPnl.toFixed(2)}${reset}  |  Fees: $${frame.stats.totalFees.toFixed(2)}${clearLine}\n`;
    output += ` Win Rate: ${yellow}${frame.stats.winRatePercent.toFixed(2)}%${reset}  |  Total Trades: ${frame.stats.totalTrades} (W: ${frame.stats.winningTrades} / L: ${frame.stats.losingTrades})${clearLine}\n`;

    const trainingProgress = readTrainingProgress();
    if (trainingProgress !== null) {
      const totalBlocks = 20;
      const filledBlocks = Math.round((trainingProgress / 100) * totalBlocks);
      const emptyBlocks = totalBlocks - filledBlocks;
      const progressBar = "▓".repeat(filledBlocks) + "░".repeat(emptyBlocks);
      output += subDivider;
      output += `${bold}--- NOTIFICATION AREA & REAL-TIME TRAINING MONITOR ---${reset}${clearLine}\n`;
      output += ` [BATBOT_V11][TRAINING] Progress: ${yellow}${bold}${trainingProgress}%${reset} [${green}${progressBar}${reset}]${clearLine}\n`;
    }

    output += borderLine;

    process.stdout.write(output);
  }

  private formatDuration(ms: number): string {
    if (ms <= 0) return "0s";
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m === 0) return `${s}s`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    if (h === 0) return `${m}m ${s < 10 ? "0" : ""}${s}s`;
    return `${h}h ${remM}m`;
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

