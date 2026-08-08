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
exports.MultiAssetBacktestEngine = void 0;
const fs = __importStar(require("fs"));
const readline = __importStar(require("readline"));
const marketDataClient_1 = require("../marketDataClient");
class MultiAssetBacktestEngine {
    config;
    client;
    // Pre-allocated static conversion buffers for atomic SAB writes
    bigIntView;
    floatBuf = new ArrayBuffer(8);
    floatBigInt = new BigInt64Array(this.floatBuf);
    floatVal = new Float64Array(this.floatBuf);
    constructor(sab, config) {
        this.client = new marketDataClient_1.MarketDataClient(sab, config?.maxAssets ?? 10, 256);
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
    writeAtomicFloat(assetIdx, slot, val) {
        const globalSlot = assetIdx * this.client.slotsPerAsset + slot;
        this.floatVal[0] = val;
        Atomics.store(this.bigIntView, globalSlot, this.floatBigInt[0]);
    }
    writeAtomicBigInt(assetIdx, slot, val) {
        const globalSlot = assetIdx * this.client.slotsPerAsset + slot;
        Atomics.store(this.bigIntView, globalSlot, val);
    }
    /**
     * Updates SharedArrayBuffer state slots for a single multi-asset tick atomically.
     */
    updateSabTick(tick) {
        const idx = tick.assetIdx;
        if (idx < 0 || idx >= this.config.maxAssets)
            return;
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
    // State persistence variables for incremental chunked backtesting
    currentCapital = 100000.0;
    peakCapital = 100000.0;
    maxDrawdown = 0;
    grossProfitUsd = 0;
    grossLossUsd = 0;
    totalFeeDragUsd = 0;
    totalSlippageDragUsd = 0;
    totalSignalsGenerated = 0;
    totalOrderLegs = 0;
    completedRoundTrips = 0;
    winningTrades = 0;
    losingTrades = 0;
    totalTicksEvaluated = 0;
    tradeReturns = [];
    assetStats = [];
    positions = [];
    startTimeNs = 0n;
    firstTickTimestampMs = 0;
    lastTickTimestampMs = 0;
    /**
     * Resets engine backtest accounting state variables for a new run.
     */
    resetState() {
        this.currentCapital = this.config.initialCapital;
        this.peakCapital = this.currentCapital;
        this.maxDrawdown = 0;
        this.grossProfitUsd = 0;
        this.grossLossUsd = 0;
        this.totalFeeDragUsd = 0;
        this.totalSlippageDragUsd = 0;
        this.totalSignalsGenerated = 0;
        this.totalOrderLegs = 0;
        this.completedRoundTrips = 0;
        this.winningTrades = 0;
        this.losingTrades = 0;
        this.totalTicksEvaluated = 0;
        this.tradeReturns = [];
        this.firstTickTimestampMs = 0;
        this.lastTickTimestampMs = 0;
        this.assetStats = Array.from({ length: this.config.maxAssets }, (_, i) => ({
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
        this.positions = Array.from({ length: this.config.maxAssets }, () => ({
            side: "FLAT",
            entryPrice: 0,
            qty: 0,
            notional: 0,
            entryFee: 0,
            entrySlippageUsd: 0,
        }));
        this.startTimeNs = process.hrtime.bigint();
    }
    /**
     * Processes a slice or chunk of historical ticks incrementally against persistent engine state.
     */
    processTicksChunk(ticks) {
        for (let i = 0; i < ticks.length; i++) {
            const tick = ticks[i];
            const idx = tick.assetIdx;
            if (idx < 0 || idx >= this.config.maxAssets)
                continue;
            if (this.firstTickTimestampMs === 0) {
                this.firstTickTimestampMs = tick.timestamp;
            }
            this.lastTickTimestampMs = tick.timestamp;
            this.assetStats[idx].symbol = tick.symbol;
            this.updateSabTick(tick);
            this.totalTicksEvaluated++;
            // Check atomic control flags (e.g. Kill Switch)
            if (this.client.getKillSwitchFlag(0))
                break;
            const aiDir = tick.aiDirection ?? this.client.getAIPredictionDirection(idx);
            const hawkes = tick.hawkesIntensity ?? 1.0;
            const vol = tick.realizedVol ?? 0.01;
            // Dynamic spread slippage calculation (+1 to +3 ticks based on Hawkes intensity & volatility)
            const slippageTicks = Math.min(this.config.maxSlippageTicks, Math.max(this.config.minSlippageTicks, Math.round(1 + hawkes * 0.4 + vol * 10)));
            const slippageCost = slippageTicks * this.config.tickSize;
            const pos = this.positions[idx];
            // Long Position Entry Trigger
            if (aiDir > 0.35 && pos.side === "FLAT") {
                this.totalSignalsGenerated++;
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
                this.currentCapital -= fee; // Deduct entry fee from cash capital
                this.totalFeeDragUsd += fee;
                this.totalSlippageDragUsd += slippageUsd;
                this.totalOrderLegs++;
                this.assetStats[idx].feeDragUsd += fee;
                this.assetStats[idx].slippageDragUsd += slippageUsd;
                this.writeAtomicFloat(idx, 105, qty);
                this.writeAtomicFloat(idx, 106, fillPrice);
            }
            // Long Position Exit Trigger
            else if (aiDir < -0.35 && pos.side === "LONG") {
                this.totalSignalsGenerated++;
                const fillPrice = tick.bidPrice - slippageCost;
                const exitNotional = fillPrice * pos.qty;
                const exitFee = exitNotional * this.config.takerFeeRate;
                const exitSlippageUsd = slippageCost * pos.qty;
                const grossPnl = (fillPrice - pos.entryPrice) * pos.qty;
                const netRoundTripPnl = grossPnl - pos.entryFee - exitFee;
                // Cash update: gross PnL minus exit fee (entry fee was already deducted on entry)
                this.currentCapital += grossPnl - exitFee;
                this.totalFeeDragUsd += exitFee;
                this.totalSlippageDragUsd += exitSlippageUsd;
                this.totalOrderLegs++;
                this.completedRoundTrips++;
                this.assetStats[idx].totalTrades++;
                this.assetStats[idx].feeDragUsd += exitFee;
                this.assetStats[idx].slippageDragUsd += exitSlippageUsd;
                // Mathematically exact per-asset PnL accounting (includes entry fee + exit fee)
                this.assetStats[idx].realizedPnlUsd += netRoundTripPnl;
                const tradeReturnPercent = (netRoundTripPnl / pos.notional) * 100;
                this.tradeReturns.push(tradeReturnPercent);
                if (netRoundTripPnl > 0) {
                    this.grossProfitUsd += netRoundTripPnl;
                    this.winningTrades++;
                    this.assetStats[idx].winningTrades++;
                }
                else {
                    this.grossLossUsd += Math.abs(netRoundTripPnl);
                    this.losingTrades++;
                    this.assetStats[idx].losingTrades++;
                }
                pos.side = "FLAT";
                pos.qty = 0;
                this.writeAtomicFloat(idx, 105, 0);
                this.writeAtomicFloat(idx, 108, 0);
                this.writeAtomicFloat(idx, 107, this.assetStats[idx].realizedPnlUsd);
            }
            // Short Position Entry Trigger
            else if (aiDir < -0.35 && pos.side === "FLAT") {
                this.totalSignalsGenerated++;
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
                this.currentCapital -= fee; // Deduct entry fee from cash capital
                this.totalFeeDragUsd += fee;
                this.totalSlippageDragUsd += slippageUsd;
                this.totalOrderLegs++;
                this.assetStats[idx].feeDragUsd += fee;
                this.assetStats[idx].slippageDragUsd += slippageUsd;
                this.writeAtomicFloat(idx, 105, -qty);
                this.writeAtomicFloat(idx, 106, fillPrice);
            }
            // Short Position Exit Trigger
            else if (aiDir > 0.35 && pos.side === "SHORT") {
                this.totalSignalsGenerated++;
                const fillPrice = tick.askPrice + slippageCost;
                const exitNotional = fillPrice * pos.qty;
                const exitFee = exitNotional * this.config.takerFeeRate;
                const exitSlippageUsd = slippageCost * pos.qty;
                const grossPnl = (pos.entryPrice - fillPrice) * pos.qty;
                const netRoundTripPnl = grossPnl - pos.entryFee - exitFee;
                // Cash update: gross PnL minus exit fee (entry fee was already deducted on entry)
                this.currentCapital += grossPnl - exitFee;
                this.totalFeeDragUsd += exitFee;
                this.totalSlippageDragUsd += exitSlippageUsd;
                this.totalOrderLegs++;
                this.completedRoundTrips++;
                this.assetStats[idx].totalTrades++;
                this.assetStats[idx].feeDragUsd += exitFee;
                this.assetStats[idx].slippageDragUsd += exitSlippageUsd;
                // Mathematically exact per-asset PnL accounting (includes entry fee + exit fee)
                this.assetStats[idx].realizedPnlUsd += netRoundTripPnl;
                const tradeReturnPercent = (netRoundTripPnl / pos.notional) * 100;
                this.tradeReturns.push(tradeReturnPercent);
                if (netRoundTripPnl > 0) {
                    this.grossProfitUsd += netRoundTripPnl;
                    this.winningTrades++;
                    this.assetStats[idx].winningTrades++;
                }
                else {
                    this.grossLossUsd += Math.abs(netRoundTripPnl);
                    this.losingTrades++;
                    this.assetStats[idx].losingTrades++;
                }
                pos.side = "FLAT";
                pos.qty = 0;
                this.writeAtomicFloat(idx, 105, 0);
                this.writeAtomicFloat(idx, 108, 0);
                this.writeAtomicFloat(idx, 107, this.assetStats[idx].realizedPnlUsd);
            }
            // Calculate and write mark-to-market Unrealized PnL to SAB Slot 108 for telemetry
            const uPnl = pos.side === "LONG"
                ? (tick.bidPrice - pos.entryPrice) * pos.qty
                : pos.side === "SHORT"
                    ? (pos.entryPrice - tick.askPrice) * pos.qty
                    : 0;
            this.writeAtomicFloat(idx, 108, uPnl);
            // Equity Curve & Max Drawdown Tracking
            if (this.currentCapital > this.peakCapital) {
                this.peakCapital = this.currentCapital;
            }
            const currentDrawdown = ((this.peakCapital - this.currentCapital) / this.peakCapital) * 100;
            if (currentDrawdown > this.maxDrawdown) {
                this.maxDrawdown = currentDrawdown;
            }
        }
    }
    /**
     * Finalizes backtest accounting metrics after tick stream completion.
     */
    finalizeResult() {
        // Mark-to-market accounting for any remaining open positions at backtest termination
        for (let i = 0; i < this.config.maxAssets; i++) {
            const pos = this.positions[i];
            if (pos.side !== "FLAT" && pos.qty > 0) {
                const lastBid = this.client.getBestBidPrice(i);
                const lastAsk = this.client.getBestAskPrice(i);
                const exitPrice = pos.side === "LONG" ? lastBid : lastAsk;
                const exitNotional = exitPrice * pos.qty;
                const exitFee = exitNotional * this.config.takerFeeRate;
                const terminalExitSlippageUsd = this.config.minSlippageTicks * this.config.tickSize * pos.qty;
                const grossPnl = pos.side === "LONG" ? (exitPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - exitPrice) * pos.qty;
                const netRoundTripPnl = grossPnl - pos.entryFee - exitFee;
                this.currentCapital += grossPnl - exitFee;
                this.totalFeeDragUsd += exitFee;
                this.totalSlippageDragUsd += terminalExitSlippageUsd;
                this.totalOrderLegs++;
                this.completedRoundTrips++;
                this.assetStats[i].totalTrades++;
                this.assetStats[i].feeDragUsd += exitFee;
                this.assetStats[i].slippageDragUsd += terminalExitSlippageUsd;
                this.assetStats[i].realizedPnlUsd += netRoundTripPnl;
                if (netRoundTripPnl > 0) {
                    this.grossProfitUsd += netRoundTripPnl;
                    this.winningTrades++;
                    this.assetStats[i].winningTrades++;
                }
                else {
                    this.grossLossUsd += Math.abs(netRoundTripPnl);
                    this.losingTrades++;
                    this.assetStats[i].losingTrades++;
                }
                pos.side = "FLAT";
                this.writeAtomicFloat(i, 105, 0);
                this.writeAtomicFloat(i, 108, 0);
                this.writeAtomicFloat(i, 107, this.assetStats[i].realizedPnlUsd);
            }
        }
        const endTime = process.hrtime.bigint();
        const elapsedNs = Number(endTime - this.startTimeNs);
        const avgTickProcessingTimeUs = this.totalTicksEvaluated > 0 ? elapsedNs / 1000 / this.totalTicksEvaluated : 0;
        const throughputTicksPerSec = elapsedNs > 0 ? Math.round(this.totalTicksEvaluated / (elapsedNs / 1e9)) : 0;
        const netPnlUsd = this.currentCapital - this.config.initialCapital;
        const totalReturnPercent = (netPnlUsd / this.config.initialCapital) * 100;
        const winRatePercent = this.completedRoundTrips > 0 ? (this.winningTrades / this.completedRoundTrips) * 100 : 0;
        const profitFactor = this.grossLossUsd > 0 ? this.grossProfitUsd / this.grossLossUsd : this.grossProfitUsd > 0 ? 999.99 : 0;
        // Calculate per-asset win rates accurately
        for (const stat of this.assetStats) {
            stat.winRatePercent = stat.totalTrades > 0 ? (stat.winningTrades / stat.totalTrades) * 100 : 0;
            stat.realizedPnlUsd = Number(stat.realizedPnlUsd.toFixed(2));
            stat.feeDragUsd = Number(stat.feeDragUsd.toFixed(2));
            stat.slippageDragUsd = Number(stat.slippageDragUsd.toFixed(2));
        }
        const durationSeconds = this.lastTickTimestampMs > this.firstTickTimestampMs
            ? (this.lastTickTimestampMs - this.firstTickTimestampMs) / 1000
            : elapsedNs / 1e9;
        const sharpeRatio = this.calculateSharpeRatio(this.tradeReturns, durationSeconds);
        return {
            initialCapital: this.config.initialCapital,
            finalCapital: Number(this.currentCapital.toFixed(2)),
            netPnlUsd: Number(netPnlUsd.toFixed(2)),
            totalReturnPercent: Number(totalReturnPercent.toFixed(2)),
            totalTicksEvaluated: this.totalTicksEvaluated,
            totalSignalsGenerated: this.totalSignalsGenerated,
            totalOrderLegs: this.totalOrderLegs,
            totalTradesExecuted: this.completedRoundTrips,
            winningTrades: this.winningTrades,
            losingTrades: this.losingTrades,
            winRatePercent: Number(winRatePercent.toFixed(2)),
            profitFactor: Number(profitFactor.toFixed(2)),
            maxDrawdownPercent: Number(this.maxDrawdown.toFixed(2)),
            sharpeRatio: Number(sharpeRatio.toFixed(2)),
            grossProfitUsd: Number(this.grossProfitUsd.toFixed(2)),
            grossLossUsd: Number(this.grossLossUsd.toFixed(2)),
            totalFeeDragUsd: Number(this.totalFeeDragUsd.toFixed(2)),
            totalSlippageDragUsd: Number(this.totalSlippageDragUsd.toFixed(2)),
            avgTickProcessingTimeUs: Number(avgTickProcessingTimeUs.toFixed(3)),
            throughputTicksPerSec,
            assetBreakdown: this.assetStats,
        };
    }
    /**
     * Evaluates an array of historical ticks in memory with mathematically rigorous round-trip PnL accounting.
     */
    runTicks(ticks) {
        this.resetState();
        this.processTicksChunk(ticks);
        return this.finalizeResult();
    }
    /**
     * Memory-safe streaming backtester executing over a historical CSV file stream line-by-line.
     * Processes ticks in dynamically flushed chunks (chunkSize = 10,000) to keep memory usage at O(chunkSize).
     * CSV format: assetIdx,symbol,timestamp,bidPrice,askPrice,obi,cvd,hawkes,volatility,aiDirection
     */
    async runStream(filePathOrStream, chunkSize = 10000) {
        this.resetState();
        const input = typeof filePathOrStream === "string" ? fs.createReadStream(filePathOrStream) : filePathOrStream;
        const rl = readline.createInterface({
            input,
            crlfDelay: Infinity,
        });
        const ticksChunk = [];
        let isHeader = true;
        for await (const line of rl) {
            if (!line.trim())
                continue;
            if (isHeader && (line.includes("symbol") || line.includes("assetIdx"))) {
                isHeader = false;
                continue;
            }
            isHeader = false;
            const parts = line.split(",");
            if (parts.length < 5)
                continue;
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
                if (ticksChunk.length >= chunkSize) {
                    this.processTicksChunk(ticksChunk);
                    ticksChunk.length = 0; // Empty chunk array immediately to free RAM
                }
            }
        }
        if (ticksChunk.length > 0) {
            this.processTicksChunk(ticksChunk);
            ticksChunk.length = 0;
        }
        return this.finalizeResult();
    }
    calculateSharpeRatio(returns, durationSeconds) {
        if (returns.length < 2 || durationSeconds <= 0)
            return 0;
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
        const stdDev = Math.sqrt(variance);
        if (stdDev === 0)
            return 0;
        // HFT Annualized Sharpe Ratio: scale by sqrt(tradesPerYear) based on exact tick stream duration
        const secondsInYear = 365.25 * 86400; // 31,557,600 seconds per year
        const tradesPerSecond = returns.length / durationSeconds;
        const tradesPerYear = tradesPerSecond * secondsInYear;
        const annualizationFactor = Math.sqrt(tradesPerYear);
        return (mean / stdDev) * annualizationFactor;
    }
    /**
     * Generates a clean institutional backtest tear sheet ASCII summary table.
     */
    static generateTearSheet(result) {
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
exports.MultiAssetBacktestEngine = MultiAssetBacktestEngine;
