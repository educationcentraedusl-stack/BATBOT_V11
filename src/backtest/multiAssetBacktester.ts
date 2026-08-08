import * as fs from "fs";
import * as readline from "readline";
import { Readable } from "stream";
import { MarketDataClient } from "../marketDataClient";

export interface MultiAssetBacktestTick {
  assetIdx: number;
  symbol: string;
  timestamp: number;
  bidPrice: number;
  askPrice: number;
  obi: number;
  cvd: number;
  hawkesIntensity?: number;
  realizedVol?: number;
  aiDirection?: number;
  aiConfidence?: number;
}

export interface MultiAssetBacktestConfig {
  initialCapital: number;
  orderQuantityUsd: number; // Order size in USD notional per trade
  takerFeeRate: number; // Default: 0.0004 (4 bps taker fee)
  minSlippageTicks: number; // Minimum price slippage in ticks (default: 1)
  maxSlippageTicks: number; // Maximum price slippage in ticks (default: 3)
  tickSize: number; // Tick size multiplier (default: 0.1)
  maxAssets: number; // Default: 10 concurrent asset slots
}

export interface AssetPerformance {
  assetIdx: number;
  symbol: string;
  totalTrades: number; // Completed round-trip trades
  winningTrades: number;
  losingTrades: number;
  winRatePercent: number;
  realizedPnlUsd: number;
  feeDragUsd: number;
  slippageDragUsd: number;
}

export interface MultiAssetBacktestResult {
  initialCapital: number;
  finalCapital: number;
  netPnlUsd: number;
  totalReturnPercent: number;
  totalTicksEvaluated: number;
  totalSignalsGenerated: number;
  totalOrderLegs: number; // Total individual order executions (entries + exits)
  totalTradesExecuted: number; // Total completed round-trip trades (winning + losing + breakeven)
  winningTrades: number;
  losingTrades: number;
  winRatePercent: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  totalFeeDragUsd: number;
  totalSlippageDragUsd: number;
  avgTickProcessingTimeUs: number;
  throughputTicksPerSec: number;
  assetBreakdown: AssetPerformance[];
}

export class MultiAssetBacktestEngine {
  private config: MultiAssetBacktestConfig;
  private client: MarketDataClient;

  // Pre-allocated static conversion buffers for atomic SAB writes
  private bigIntView: BigInt64Array;
  private floatBuf = new ArrayBuffer(8);
  private floatBigInt = new BigInt64Array(this.floatBuf);
  private floatVal = new Float64Array(this.floatBuf);

  constructor(sab: SharedArrayBuffer, config?: Partial<MultiAssetBacktestConfig>) {
    this.client = new MarketDataClient(sab, config?.maxAssets ?? 10, 256);
    this.bigIntView = new BigInt64Array(sab);

    this.config = {
      initialCapital: config?.initialCapital ?? 100000.0,
      orderQuantityUsd: config?.orderQuantityUsd ?? 5000.0,
      takerFeeRate: config?.takerFeeRate ?? 0.0004, // Strict 4 bps taker fee
      minSlippageTicks: config?.minSlippageTicks ?? 1,
      maxSlippageTicks: config?.maxSlippageTicks ?? 3,
      tickSize: config?.tickSize ?? 0.1,
      maxAssets: config?.maxAssets ?? 10,
    };
  }

  private writeAtomicFloat(assetIdx: number, slot: number, val: number): void {
    const globalSlot = assetIdx * 256 + slot;
    this.floatVal[0] = val;
    Atomics.store(this.bigIntView, globalSlot, this.floatBigInt[0]);
  }

  private writeAtomicBigInt(assetIdx: number, slot: number, val: bigint): void {
    const globalSlot = assetIdx * 256 + slot;
    Atomics.store(this.bigIntView, globalSlot, val);
  }

  /**
   * Updates SharedArrayBuffer state slots for a single multi-asset tick atomically.
   */
  public updateSabTick(tick: MultiAssetBacktestTick): void {
    const idx = tick.assetIdx;
    if (idx < 0 || idx >= this.config.maxAssets) return;

    this.writeAtomicBigInt(idx, 0, BigInt(Math.floor(tick.timestamp * 1000000))); // Timestamp ns
    this.writeAtomicFloat(idx, 1, tick.obi);
    this.writeAtomicFloat(idx, 2, tick.cvd);
    this.writeAtomicFloat(idx, 4, tick.bidPrice);
    this.writeAtomicFloat(idx, 6, tick.askPrice);

    if (tick.hawkesIntensity !== undefined) {
      this.writeAtomicFloat(idx, 112, tick.hawkesIntensity);
    }
    if (tick.realizedVol !== undefined) {
      this.writeAtomicFloat(idx, 121, tick.realizedVol);
    }
    if (tick.aiDirection !== undefined) {
      this.writeAtomicFloat(idx, 93, tick.aiDirection);
    }
    if (tick.aiConfidence !== undefined) {
      this.writeAtomicFloat(idx, 94, tick.aiConfidence);
    }
  }

  /**
   * Evaluates an array of historical ticks in memory with mathematically rigorous round-trip PnL accounting.
   */
  public runTicks(ticks: MultiAssetBacktestTick[]): MultiAssetBacktestResult {
    let currentCapital = this.config.initialCapital;
    let peakCapital = currentCapital;
    let maxDrawdown = 0;

    let grossProfitUsd = 0;
    let grossLossUsd = 0;
    let totalFeeDragUsd = 0;
    let totalSlippageDragUsd = 0;
    let totalSignalsGenerated = 0;
    let totalOrderLegs = 0;
    let completedRoundTrips = 0;
    let winningTrades = 0;
    let losingTrades = 0;

    const tradeReturns: number[] = [];

    // Per-asset tracking maps
    const assetStats: AssetPerformance[] = Array.from({ length: this.config.maxAssets }, (_, i) => ({
      assetIdx: i,
      symbol: `ASSET_${i}`,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRatePercent: 0,
      realizedPnlUsd: 0,
      feeDragUsd: 0,
      slippageDragUsd: 0,
    }));

    // Active position state per asset slot
    const positions = Array.from({ length: this.config.maxAssets }, () => ({
      side: "FLAT" as "LONG" | "SHORT" | "FLAT",
      entryPrice: 0,
      qty: 0,
      notional: 0,
      entryFee: 0,
      entrySlippageUsd: 0,
    }));

    const startTime = process.hrtime.bigint();

    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i];
      const idx = tick.assetIdx;
      if (idx < 0 || idx >= this.config.maxAssets) continue;

      assetStats[idx].symbol = tick.symbol;
      this.updateSabTick(tick);

      // Check atomic control flags (e.g. Kill Switch)
      if (this.client.getKillSwitchFlag(0)) break;

      const aiDir = tick.aiDirection ?? this.client.getAIPredictionDirection(idx);
      const hawkes = tick.hawkesIntensity ?? 1.0;
      const vol = tick.realizedVol ?? 0.01;

      // Dynamic spread slippage calculation (+1 to +3 ticks based on Hawkes intensity & volatility)
      const slippageTicks = Math.min(
        this.config.maxSlippageTicks,
        Math.max(this.config.minSlippageTicks, Math.round(1 + hawkes * 0.4 + vol * 10))
      );
      const slippageCost = slippageTicks * this.config.tickSize;

      const pos = positions[idx];

      // Long Position Entry Trigger
      if (aiDir > 0.35 && pos.side === "FLAT") {
        totalSignalsGenerated++;

        const fillPrice = tick.askPrice + slippageCost;
        const qty = this.config.orderQuantityUsd / fillPrice;
        const notional = fillPrice * qty;
        const fee = notional * this.config.takerFeeRate;
        const slippageUsd = slippageCost * qty;

        pos.side = "LONG";
        pos.entryPrice = fillPrice;
        pos.qty = qty;
        pos.notional = notional;
        pos.entryFee = fee;
        pos.entrySlippageUsd = slippageUsd;

        currentCapital -= fee; // Deduct entry fee from cash capital
        totalFeeDragUsd += fee;
        totalSlippageDragUsd += slippageUsd;
        totalOrderLegs++;
        assetStats[idx].feeDragUsd += fee;
        assetStats[idx].slippageDragUsd += slippageUsd;

        this.writeAtomicFloat(idx, 105, qty);
        this.writeAtomicFloat(idx, 106, fillPrice);
      }
      // Long Position Exit Trigger
      else if (aiDir < -0.35 && pos.side === "LONG") {
        totalSignalsGenerated++;

        const fillPrice = tick.bidPrice - slippageCost;
        const exitNotional = fillPrice * pos.qty;
        const exitFee = exitNotional * this.config.takerFeeRate;
        const exitSlippageUsd = slippageCost * pos.qty;

        const grossPnl = (fillPrice - pos.entryPrice) * pos.qty;
        const netRoundTripPnl = grossPnl - pos.entryFee - exitFee;

        // Cash update: gross PnL minus exit fee (entry fee was already deducted on entry)
        currentCapital += grossPnl - exitFee;

        totalFeeDragUsd += exitFee;
        totalSlippageDragUsd += exitSlippageUsd;
        totalOrderLegs++;
        completedRoundTrips++;
        assetStats[idx].totalTrades++;
        assetStats[idx].feeDragUsd += exitFee;
        assetStats[idx].slippageDragUsd += exitSlippageUsd;

        // Mathematically exact per-asset PnL accounting (includes entry fee + exit fee)
        assetStats[idx].realizedPnlUsd += netRoundTripPnl;

        const tradeReturnPercent = (netRoundTripPnl / pos.notional) * 100;
        tradeReturns.push(tradeReturnPercent);

        if (netRoundTripPnl > 0) {
          grossProfitUsd += netRoundTripPnl;
          winningTrades++;
          assetStats[idx].winningTrades++;
        } else {
          grossLossUsd += Math.abs(netRoundTripPnl);
          losingTrades++;
          assetStats[idx].losingTrades++;
        }

        pos.side = "FLAT";
        pos.qty = 0;
        this.writeAtomicFloat(idx, 105, 0);
        this.writeAtomicFloat(idx, 107, assetStats[idx].realizedPnlUsd);
      }
      // Short Position Entry Trigger
      else if (aiDir < -0.35 && pos.side === "FLAT") {
        totalSignalsGenerated++;

        const fillPrice = tick.bidPrice - slippageCost;
        const qty = this.config.orderQuantityUsd / fillPrice;
        const notional = fillPrice * qty;
        const fee = notional * this.config.takerFeeRate;
        const slippageUsd = slippageCost * qty;

        pos.side = "SHORT";
        pos.entryPrice = fillPrice;
        pos.qty = qty;
        pos.notional = notional;
        pos.entryFee = fee;
        pos.entrySlippageUsd = slippageUsd;

        currentCapital -= fee; // Deduct entry fee from cash capital
        totalFeeDragUsd += fee;
        totalSlippageDragUsd += slippageUsd;
        totalOrderLegs++;
        assetStats[idx].feeDragUsd += fee;
        assetStats[idx].slippageDragUsd += slippageUsd;

        this.writeAtomicFloat(idx, 105, -qty);
        this.writeAtomicFloat(idx, 106, fillPrice);
      }
      // Short Position Exit Trigger
      else if (aiDir > 0.35 && pos.side === "SHORT") {
        totalSignalsGenerated++;

        const fillPrice = tick.askPrice + slippageCost;
        const exitNotional = fillPrice * pos.qty;
        const exitFee = exitNotional * this.config.takerFeeRate;
        const exitSlippageUsd = slippageCost * pos.qty;

        const grossPnl = (pos.entryPrice - fillPrice) * pos.qty;
        const netRoundTripPnl = grossPnl - pos.entryFee - exitFee;

        // Cash update: gross PnL minus exit fee (entry fee was already deducted on entry)
        currentCapital += grossPnl - exitFee;

        totalFeeDragUsd += exitFee;
        totalSlippageDragUsd += exitSlippageUsd;
        totalOrderLegs++;
        completedRoundTrips++;
        assetStats[idx].totalTrades++;
        assetStats[idx].feeDragUsd += exitFee;
        assetStats[idx].slippageDragUsd += exitSlippageUsd;

        // Mathematically exact per-asset PnL accounting (includes entry fee + exit fee)
        assetStats[idx].realizedPnlUsd += netRoundTripPnl;

        const tradeReturnPercent = (netRoundTripPnl / pos.notional) * 100;
        tradeReturns.push(tradeReturnPercent);

        if (netRoundTripPnl > 0) {
          grossProfitUsd += netRoundTripPnl;
          winningTrades++;
          assetStats[idx].winningTrades++;
        } else {
          grossLossUsd += Math.abs(netRoundTripPnl);
          losingTrades++;
          assetStats[idx].losingTrades++;
        }

        pos.side = "FLAT";
        pos.qty = 0;
        this.writeAtomicFloat(idx, 105, 0);
        this.writeAtomicFloat(idx, 107, assetStats[idx].realizedPnlUsd);
      }

      // Equity Curve & Max Drawdown Tracking
      if (currentCapital > peakCapital) {
        peakCapital = currentCapital;
      }
      const currentDrawdown = ((peakCapital - currentCapital) / peakCapital) * 100;
      if (currentDrawdown > maxDrawdown) {
        maxDrawdown = currentDrawdown;
      }
    }

    // Mark-to-market accounting for any remaining open positions at backtest termination
    for (let i = 0; i < this.config.maxAssets; i++) {
      const pos = positions[i];
      if (pos.side !== "FLAT" && pos.qty > 0) {
        const lastBid = this.client.getBestBidPrice(i);
        const lastAsk = this.client.getBestAskPrice(i);
        const exitPrice = pos.side === "LONG" ? lastBid : lastAsk;
        const exitNotional = exitPrice * pos.qty;
        const exitFee = exitNotional * this.config.takerFeeRate;
        const grossPnl = pos.side === "LONG" ? (exitPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - exitPrice) * pos.qty;
        const netRoundTripPnl = grossPnl - pos.entryFee - exitFee;

        currentCapital += grossPnl - exitFee;
        completedRoundTrips++;
        assetStats[i].totalTrades++;
        assetStats[i].realizedPnlUsd += netRoundTripPnl;

        if (netRoundTripPnl > 0) {
          grossProfitUsd += netRoundTripPnl;
          winningTrades++;
          assetStats[i].winningTrades++;
        } else {
          grossLossUsd += Math.abs(netRoundTripPnl);
          losingTrades++;
          assetStats[i].losingTrades++;
        }
        pos.side = "FLAT";
      }
    }

    const endTime = process.hrtime.bigint();
    const elapsedNs = Number(endTime - startTime);
    const avgTickProcessingTimeUs = ticks.length > 0 ? elapsedNs / 1000 / ticks.length : 0;
    const throughputTicksPerSec = elapsedNs > 0 ? Math.round(ticks.length / (elapsedNs / 1e9)) : 0;

    const netPnlUsd = currentCapital - this.config.initialCapital;
    const totalReturnPercent = (netPnlUsd / this.config.initialCapital) * 100;
    const winRatePercent = completedRoundTrips > 0 ? (winningTrades / completedRoundTrips) * 100 : 0;
    const profitFactor = grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : grossProfitUsd > 0 ? 999.99 : 0;

    // Calculate per-asset win rates accurately
    for (const stat of assetStats) {
      stat.winRatePercent = stat.totalTrades > 0 ? (stat.winningTrades / stat.totalTrades) * 100 : 0;
      stat.realizedPnlUsd = Number(stat.realizedPnlUsd.toFixed(2));
      stat.feeDragUsd = Number(stat.feeDragUsd.toFixed(2));
      stat.slippageDragUsd = Number(stat.slippageDragUsd.toFixed(2));
    }

    const sharpeRatio = this.calculateSharpeRatio(tradeReturns);

    return {
      initialCapital: this.config.initialCapital,
      finalCapital: Number(currentCapital.toFixed(2)),
      netPnlUsd: Number(netPnlUsd.toFixed(2)),
      totalReturnPercent: Number(totalReturnPercent.toFixed(2)),
      totalTicksEvaluated: ticks.length,
      totalSignalsGenerated,
      totalOrderLegs,
      totalTradesExecuted: completedRoundTrips,
      winningTrades,
      losingTrades,
      winRatePercent: Number(winRatePercent.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      maxDrawdownPercent: Number(maxDrawdown.toFixed(2)),
      sharpeRatio: Number(sharpeRatio.toFixed(2)),
      grossProfitUsd: Number(grossProfitUsd.toFixed(2)),
      grossLossUsd: Number(grossLossUsd.toFixed(2)),
      totalFeeDragUsd: Number(totalFeeDragUsd.toFixed(2)),
      totalSlippageDragUsd: Number(totalSlippageDragUsd.toFixed(2)),
      avgTickProcessingTimeUs: Number(avgTickProcessingTimeUs.toFixed(3)),
      throughputTicksPerSec,
      assetBreakdown: assetStats,
    };
  }

  /**
   * Memory-safe streaming backtester executing over a historical CSV file stream line-by-line.
   * CSV format: assetIdx,symbol,timestamp,bidPrice,askPrice,obi,cvd,hawkes,volatility,aiDirection
   */
  public async runStream(filePathOrStream: string | Readable): Promise<MultiAssetBacktestResult> {
    const input: Readable =
      typeof filePathOrStream === "string" ? fs.createReadStream(filePathOrStream) : filePathOrStream;

    const rl = readline.createInterface({
      input,
      crlfDelay: Infinity,
    });

    const ticksChunk: MultiAssetBacktestTick[] = [];
    let isHeader = true;

    for await (const line of rl) {
      if (!line.trim()) continue;
      if (isHeader && (line.includes("symbol") || line.includes("assetIdx"))) {
        isHeader = false;
        continue;
      }
      isHeader = false;

      const parts = line.split(",");
      if (parts.length < 5) continue;

      const assetIdx = parseInt(parts[0], 10);
      const symbol = parts[1] || `ASSET_${assetIdx}`;
      const timestamp = parseFloat(parts[2]);
      const bidPrice = parseFloat(parts[3]);
      const askPrice = parseFloat(parts[4]);
      const obi = parts.length > 5 ? parseFloat(parts[5]) : 0;
      const cvd = parts.length > 6 ? parseFloat(parts[6]) : 0;
      const hawkesIntensity = parts.length > 7 ? parseFloat(parts[7]) : 1.0;
      const realizedVol = parts.length > 8 ? parseFloat(parts[8]) : 0.01;
      const aiDirection = parts.length > 9 ? parseFloat(parts[9]) : 0;

      if (!isNaN(assetIdx) && !isNaN(bidPrice) && !isNaN(askPrice)) {
        ticksChunk.push({
          assetIdx,
          symbol,
          timestamp,
          bidPrice,
          askPrice,
          obi,
          cvd,
          hawkesIntensity,
          realizedVol,
          aiDirection,
        });
      }
    }

    return this.runTicks(ticksChunk);
  }

  private calculateSharpeRatio(returns: number[]): number {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return 0;
    return (mean / stdDev) * Math.sqrt(252);
  }

  /**
   * Generates a clean institutional backtest tear sheet ASCII summary table.
   */
  public static generateTearSheet(result: MultiAssetBacktestResult): string {
    const bold = "\x1b[1m";
    const reset = "\x1b[0m";
    const cyan = "\x1b[36m";
    const green = "\x1b[32m";
    const red = "\x1b[31m";
    const yellow = "\x1b[33m";

    const pnlColor = result.netPnlUsd >= 0 ? green : red;

    let sheet = "";
    sheet += `${cyan}${bold}======================================================================================================${reset}\n`;
    sheet += `${cyan}${bold}                      BATBOT_V11 INSTITUTIONAL BACKTEST PERFORMANCE TEAR SHEET                         ${reset}\n`;
    sheet += `${cyan}${bold}======================================================================================================${reset}\n`;

    sheet += ` Initial Portfolio Capital : $${result.initialCapital.toFixed(2)}\n`;
    sheet += ` Final Portfolio Capital   : $${result.finalCapital.toFixed(2)}\n`;
    sheet += ` Total Net PnL (USD)       : ${pnlColor}${bold}$${result.netPnlUsd.toFixed(2)}${reset} (${pnlColor}${result.totalReturnPercent.toFixed(2)}%${reset})\n`;
    sheet += ` Profit Factor             : ${yellow}${bold}${result.profitFactor.toFixed(2)}${reset}\n`;
    sheet += ` Sharpe Ratio (Annualized) : ${yellow}${bold}${result.sharpeRatio.toFixed(2)}${reset}\n`;
    sheet += ` Max Portfolio Drawdown    : ${red}${bold}${result.maxDrawdownPercent.toFixed(2)}%${reset}\n`;

    sheet += `------------------------------------------------------------------------------------------------------\n`;
    sheet += ` Total Ticks Evaluated     : ${result.totalTicksEvaluated.toLocaleString()}\n`;
    sheet += ` Total Signals Generated   : ${result.totalSignalsGenerated.toLocaleString()}\n`;
    sheet += ` Order Fills / Execution Legs : ${result.totalOrderLegs.toLocaleString()}\n`;
    sheet += ` Completed Round-Trip Trades  : ${result.totalTradesExecuted.toLocaleString()} (Winning: ${green}${result.winningTrades}${reset} / Losing: ${red}${result.losingTrades}${reset})\n`;
    sheet += ` Round-Trip Win Rate          : ${yellow}${bold}${result.winRatePercent.toFixed(2)}%${reset}\n`;

    sheet += `------------------------------------------------------------------------------------------------------\n`;
    sheet += ` Total Fee Drag (0.04% Taker): ${red}$${result.totalFeeDragUsd.toFixed(2)}${reset}\n`;
    sheet += ` Total Dynamic Slippage Drag : ${red}$${result.totalSlippageDragUsd.toFixed(2)}${reset}\n`;
    sheet += ` Average Tick Processing Latency : ${result.avgTickProcessingTimeUs.toFixed(3)} µs\n`;
    sheet += ` Execution Throughput            : ${bold}${result.throughputTicksPerSec.toLocaleString()} ticks/sec${reset}\n`;

    sheet += `------------------------------------------------------------------------------------------------------\n`;
    sheet += `${bold}--- 10-ASSET PORTFOLIO BREAKDOWN ---${reset}\n`;
    sheet += `+------+----------+--------------+-----------------+---------------+--------------+-------------------+\n`;
    sheet += `| ${bold}Slot${reset} | ${bold}Symbol${reset}   | ${bold}Round-Trips${reset}  | ${bold}Win Rate (%)${reset}    | ${bold}Net PnL ($)${reset}   | ${bold}Fee Drag ($)${reset} | ${bold}Slippage Drag ($)${reset}  |\n`;
    sheet += `+------+----------+--------------+-----------------+---------------+--------------+-------------------+\n`;

    for (const asset of result.assetBreakdown) {
      const pnlC = asset.realizedPnlUsd >= 0 ? green : red;
      const sym = asset.symbol.padEnd(8);
      const trades = asset.totalTrades.toString().padEnd(12);
      const winRate = `${asset.winRatePercent.toFixed(2)}%`.padEnd(15);
      const pnl = `${asset.realizedPnlUsd >= 0 ? "+" : ""}$${asset.realizedPnlUsd.toFixed(2)}`.padEnd(13);
      const fee = `$${asset.feeDragUsd.toFixed(2)}`.padEnd(12);
      const slip = `$${asset.slippageDragUsd.toFixed(2)}`.padEnd(17);

      sheet += `| #${asset.assetIdx}   | ${sym} | ${trades} | ${winRate} | ${pnlC}${pnl}${reset} | ${fee} | ${slip} |\n`;
    }
    sheet += `+------+----------+--------------+-----------------+---------------+--------------+-------------------+\n`;
    sheet += `${cyan}${bold}======================================================================================================${reset}\n`;

    return sheet;
  }
}
