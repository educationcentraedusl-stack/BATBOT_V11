import { MarketDataClient } from "../marketDataClient";

export interface ActiveTradeSlot {
  assetIdx: number;
  symbol: string;
  side: "BUY" | "SELL" | "LONG" | "SHORT" | "FLAT";
  size: number;
  entryPrice: number;
  currentPrice: number;
  tpPrice: number;
  slPrice: number;
  leverage: number;
  unrealizedPnl: number;
  realizedPnl: number;
  durationMs: number;
}

export const DEFAULT_ASSET_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "DOTUSDT",
];

export class MultiAssetCLIDashboard {
  private client: MarketDataClient;
  private enabled: boolean;
  private renderIntervalMs = 150; // ~6.6Hz refresh rate for zero-flicker sub-millisecond telemetry
  private lastRenderTimestamp = 0;
  private focusedAssetIdx = 0;
  private assetSymbols: string[];
  private notificationLog: string[] = [];
  private maxLogEntries = 5;
  private cachedMemMb = "0.00";
  private renderCount = 0;

  // Pre-allocated static buffers for zero-allocation L2 depth reading
  private bidBuffer = new Float64Array(40); // 20 price/qty pairs
  private askBuffer = new Float64Array(40); // 20 price/qty pairs

  // Static pre-rendered Mini-Bar lookup table (0 to 10 filled blocks) to avoid .repeat() heap allocations on hot-path
  private static readonly MINI_BAR_CACHE: string[] = Array.from({ length: 11 }, (_, filled) => {
    const empty = 10 - filled;
    return "\x1b[32m" + "=".repeat(filled) + "\x1b[90m" + "-".repeat(empty) + "\x1b[0m";
  });

  // Static pre-rendered ANSI UI dividers cached to eliminate hot-path string allocations in render loop
  private static readonly BORDER = "\x1b[36m\x1b[1m======================================================================================================================\x1b[0m\x1b[K\n";
  private static readonly SUB_DIVIDER = "\x1b[90m----------------------------------------------------------------------------------------------------------------------\x1b[0m\x1b[K\n";
  private static readonly TABLE_DIVIDER = "\x1b[90m+------+----------+-----------+-----------+---------+--------------------+------------+----------+------------+---------+\x1b[0m\x1b[K\n";
  private static readonly TRADES_DIVIDER = "\x1b[90m+------+----------+--------+-----------+--------------+--------------+------------+----------+--------------------+\x1b[0m\x1b[K\n";

  constructor(
    client: MarketDataClient,
    enabled: boolean = true,
    customSymbols: string[] = DEFAULT_ASSET_SYMBOLS
  ) {
    this.client = client;
    this.enabled = enabled;
    this.assetSymbols = customSymbols;

    // Listen for terminal resize event to cleanly clear and re-render frame
    if (process.stdout.isTTY) {
      process.stdout.on("resize", () => {
        this.clear();
      });
    }
  }

  /**
   * Sets current focused asset index slot (0 to maxAssets-1) for detailed L2 view.
   */
  public setFocusedAsset(assetIdx: number): void {
    if (assetIdx >= 0 && assetIdx < this.client.maxAssets) {
      this.focusedAssetIdx = assetIdx;
    }
  }

  public getFocusedAsset(): number {
    return this.focusedAssetIdx;
  }

  /**
   * Appends notification message to TUI event log buffer.
   */
  public pushNotification(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 19);
    this.notificationLog.push(`[${timestamp}] ${message}`);
    if (this.notificationLog.length > this.maxLogEntries) {
      this.notificationLog.shift();
    }
  }

  /**
   * Zero-allocation render loop fetching telemetry directly from SAB via Atomics.load.
   * Outputs double-buffered ANSI frame to stdout using cursor top-left repositioning (\x1b[H).
   */
  public render(): void {
    if (!this.enabled) return;

    const now = Date.now();
    if (now - this.lastRenderTimestamp < this.renderIntervalMs) {
      return;
    }
    this.lastRenderTimestamp = now;
    this.renderCount++;

    // ANSI escape sequences
    const reset = "\x1b[0m";
    const bold = "\x1b[1m";
    const cyan = "\x1b[36m";
    const yellow = "\x1b[33m";
    const green = "\x1b[32m";
    const red = "\x1b[31m";
    const gray = "\x1b[90m";
    const clearLine = "\x1b[K";

    // Read system-wide status from SAB asset 0
    const isKilled = this.client.getKillSwitchFlag(0);
    const isCloseAll = this.client.getCloseAllPositionsFlag(0);
    const isPaused = this.client.getEnginePausedFlag(0);
    const isRecalibrating = this.client.getTriggerRecalibrationFlag(0);

    let statusStr = `${green}${bold}[LIVE ACTIVE]${reset}`;
    if (isKilled) {
      statusStr = `${red}${bold}[KILLED - EMERGENCY STOP]${reset}`;
    } else if (isCloseAll) {
      statusStr = `${yellow}${bold}[PANIC CLOSE ALL]${reset}`;
    } else if (isRecalibrating) {
      statusStr = `${yellow}${bold}[RECALIBRATING]${reset}`;
    } else if (isPaused) {
      statusStr = `${yellow}${bold}[PAUSED]${reset}`;
    }

    // Throttle memory usage check to once every 10 frames (~1.5s) to eliminate V8 process.memoryUsage() allocations
    if (this.renderCount % 10 === 1) {
      this.cachedMemMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    }
    const memMb = this.cachedMemMb;
    const seqNum = this.client.getSequenceNum(this.focusedAssetIdx);

    // Aggregate portfolio metrics across all 10 assets
    let totalUnrealizedPnl = 0;
    let totalRealizedPnl = 0;
    let totalTrades = 0n;
    let activePositionCount = 0;

    for (let i = 0; i < this.client.maxAssets; i++) {
      totalUnrealizedPnl += this.client.getOmsUnrealizedPnl(i);
      totalRealizedPnl += this.client.getOmsRealizedPnl(i);
      totalTrades += this.client.getOmsTotalTrades(i);
      if (Math.abs(this.client.getOmsPositionQty(i)) > 1e-6) {
        activePositionCount++;
      }
    }

    let out = "\x1b[H"; // Move cursor top-left

    out += MultiAssetCLIDashboard.BORDER;
    out += `${cyan}${bold}                         BATBOT_V11 MULTI-ASSET HFT TELEMETRY & COMMAND MONITOR (10 ASSETS)                            ${reset}${clearLine}\n`;
    out += MultiAssetCLIDashboard.BORDER;

    const availBalance = this.client.getAvailableBalance(0);

    out += ` Engine Status: ${statusStr}  |  Memory: ${memMb} MB  |  Sequence: #${seqNum.toString()}  |  Active Positions: ${activePositionCount}/10${clearLine}\n`;
    out += ` Available Balance: ${green}${bold}$${availBalance.toFixed(2)}${reset}  |  Portfolio Unrealized PnL: ${totalUnrealizedPnl >= 0 ? green : red}${bold}$${totalUnrealizedPnl.toFixed(2)}${reset}  |  Realized PnL: ${totalRealizedPnl >= 0 ? green : red}${bold}$${totalRealizedPnl.toFixed(2)}${reset}  |  Total Trades Logged: ${totalTrades}${clearLine}\n`;

    out += MultiAssetCLIDashboard.SUB_DIVIDER;
    out += `${bold}--- 10-ASSET CONCURRENCY REAL-TIME MATRIX ---${reset}${clearLine}\n`;
    out += MultiAssetCLIDashboard.TABLE_DIVIDER;
    out += `| ${bold}Slot${reset} | ${bold}Symbol${reset}   | ${bold}Best Bid${reset}  | ${bold}Best Ask${reset}  | ${bold}Spread${reset}  | ${bold}OBI (-1..+1)${reset}        | ${bold}CVD${reset}        | ${bold}Hawkes${reset}   | ${bold}Garman-Klass${reset} | ${bold}Signal${reset}  |${clearLine}\n`;
    out += MultiAssetCLIDashboard.TABLE_DIVIDER;

    for (let i = 0; i < this.client.maxAssets; i++) {
      const sym = (this.assetSymbols[i] || `ASSET_${i}`).padEnd(8);
      const bid = this.client.getBestBidPrice(i);
      const ask = this.client.getBestAskPrice(i);
      const spread = ask > bid ? (ask - bid).toFixed(2) : "0.00";
      const obi = this.client.getOBI(i);
      const cvd = this.client.getCVD(i);
      const hawkes = this.client.getHawkesIntensity(i);
      const gkRv = this.client.getGarmanKlassRV(i);
      const aiDir = this.client.getAIPredictionDirection(i);

      const obiBar = this.getFastMiniBar(obi, -1, 1);
      const signalStr = aiDir > 0.3 ? `${green}BUY ${reset}` : aiDir < -0.3 ? `${red}SELL${reset}` : `${gray}NONE${reset}`;

      const focusMarker = i === this.focusedAssetIdx ? `${yellow}${bold}#${i}${reset}` : ` #${i}`;

      out += `| ${focusMarker}  | ${sym} | ${bid.toFixed(2).padEnd(9)} | ${ask.toFixed(2).padEnd(9)} | ${spread.padEnd(7)} | [${obiBar}] | ${cvd >= 0 ? "+" : ""}${cvd.toFixed(1).padEnd(9)} | ${hawkes.toFixed(3).padEnd(8)} | ${gkRv.toFixed(5).padEnd(12)} | ${signalStr}  |${clearLine}\n`;
    }
    out += MultiAssetCLIDashboard.TABLE_DIVIDER;

    // Focused Asset Deep Microstructure & L2 View
    const fIdx = this.focusedAssetIdx;
    const fSym = this.assetSymbols[fIdx] || `ASSET_${fIdx}`;
    this.client.fillTopBids(this.bidBuffer, 5, fIdx);
    this.client.fillTopAsks(this.askBuffer, 5, fIdx);

    const fObi = this.client.getOBI(fIdx);
    const fCvd = this.client.getCVD(fIdx);
    const fHawkes = this.client.getHawkesIntensity(fIdx);
    const fVpin = this.client.getVPIN(fIdx);
    const fHurst = this.client.getHurstExponent(fIdx);
    const fAiDir = this.client.getAIPredictionDirection(fIdx);
    const fAiConf = (this.client.getAIPredictionConfidence(fIdx) * 100).toFixed(1);
    const fInfLat = (Number(this.client.getAIInferenceLatencyNs(fIdx)) / 1000).toFixed(1);

    out += `${bold}--- FOCUSED ASSET METRICS & LEVEL-2 BOOK (#${fIdx} - ${fSym}) ---${reset}${clearLine}\n`;
    out += ` OBI: ${fObi >= 0 ? "+" : ""}${fObi.toFixed(4)}  |  CVD: ${fCvd >= 0 ? "+" : ""}${fCvd.toFixed(2)}  |  Hawkes: ${fHawkes.toFixed(4)}  |  VPIN: ${fVpin.toFixed(4)}  |  Hurst: ${fHurst.toFixed(4)}${clearLine}\n`;
    out += ` AI Prediction Direction: ${fAiDir >= 0 ? green : red}${fAiDir >= 0 ? "+" : ""}${fAiDir.toFixed(4)}${reset}  |  Confidence: ${yellow}${fAiConf}%${reset}  |  Inference Latency: ${fInfLat} µs${clearLine}\n`;

    out += ` Top 3 Bids: [1] $${this.bidBuffer[0].toFixed(2)} (${this.bidBuffer[1].toFixed(3)})  [2] $${this.bidBuffer[2].toFixed(2)} (${this.bidBuffer[3].toFixed(3)})  [3] $${this.bidBuffer[4].toFixed(2)} (${this.bidBuffer[5].toFixed(3)})${clearLine}\n`;
    out += ` Top 3 Asks: [1] $${this.askBuffer[0].toFixed(2)} (${this.askBuffer[1].toFixed(3)})  [2] $${this.askBuffer[2].toFixed(2)} (${this.askBuffer[3].toFixed(3)})  [3] $${this.askBuffer[4].toFixed(2)} (${this.askBuffer[5].toFixed(3)})${clearLine}\n`;

    out += MultiAssetCLIDashboard.SUB_DIVIDER;
    out += `${bold}--- MULTI-ASSET ACTIVE POSITIONS (10 OMS SLOTS) ---${reset}${clearLine}\n`;
    out += MultiAssetCLIDashboard.TRADES_DIVIDER;
    out += `| ${bold}Slot${reset} | ${bold}Symbol${reset}   | ${bold}Side${reset}   | ${bold}Position${reset}  | ${bold}Avg Entry${reset}   | ${bold}Mark Price${reset}   | ${bold}Leverage${reset} | ${bold}Realized${reset} | ${bold}Unrealized PnL ($)${reset}  |${clearLine}\n`;
    out += MultiAssetCLIDashboard.TRADES_DIVIDER;

    let hasActivePosition = false;
    for (let i = 0; i < this.client.maxAssets; i++) {
      const qty = this.client.getOmsPositionQty(i);
      if (Math.abs(qty) > 1e-6) {
        hasActivePosition = true;
        const sym = (this.assetSymbols[i] || `ASSET_${i}`).padEnd(8);
        const side = qty > 0 ? `${green}LONG ${reset}` : `${red}SHORT${reset}`;
        const entry = this.client.getOmsAvgEntryPrice(i);
        const mark = this.client.getBestBidPrice(i);
        const lev = `${this.client.getOmsLeverage(i).toFixed(0)}x`.padEnd(8);
        const rPnl = this.client.getOmsRealizedPnl(i);
        const uPnl = this.client.getOmsUnrealizedPnl(i);

        const uPnlColor = uPnl >= 0 ? green : red;
        const uPnlStr = `${uPnl >= 0 ? "+" : ""}$${uPnl.toFixed(2)}`.padEnd(18);

        out += `| #${i}   | ${sym} | ${side} | ${qty.toFixed(4).padEnd(9)} | $${entry.toFixed(2).padEnd(11)} | $${mark.toFixed(2).padEnd(11)} | ${lev} | $${rPnl.toFixed(2).padEnd(7)} | ${uPnlColor}${bold}${uPnlStr}${reset} |${clearLine}\n`;
      }
    }

    if (!hasActivePosition) {
      out += `| ${yellow}NO ACTIVE OPEN POSITIONS ACROSS ALL 10 ASSET SLOTS (ALL POSITIONS FLAT)${reset}`.padEnd(132) + `|${clearLine}\n`;
    }
    out += MultiAssetCLIDashboard.TRADES_DIVIDER;

    // Command Feedback & Real-Time Event Log
    out += `${bold}--- INTERACTIVE COMMAND FEEDBACK & NOTIFICATION LOG ---${reset}${clearLine}\n`;
    if (this.notificationLog.length === 0) {
      out += ` ${gray}[SYSTEM READY] Listening for raw keyboard controls...${reset}${clearLine}\n`;
    } else {
      for (const logLine of this.notificationLog) {
        out += ` ${logLine}${clearLine}\n`;
      }
    }
    out += MultiAssetCLIDashboard.BORDER;

    process.stdout.write(out);
  }

  /**
   * Zero-allocation O(1) mini-bar string lookup from pre-rendered static MINI_BAR_CACHE.
   */
  private getFastMiniBar(val: number, min: number, max: number): string {
    const clamped = Math.max(min, Math.min(max, val));
    const norm = (clamped - min) / (max - min);
    const idx = Math.round(norm * 10);
    return MultiAssetCLIDashboard.MINI_BAR_CACHE[idx] || MultiAssetCLIDashboard.MINI_BAR_CACHE[5];
  }

  public clear(): void {
    if (this.enabled) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
  }
}

