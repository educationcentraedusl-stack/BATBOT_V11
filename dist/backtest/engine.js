"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAssetBacktestEngine = exports.BacktestEngine = exports.MockMarketDataClient = void 0;
const engine_1 = require("../strategy/engine");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
const marketDataClient_1 = require("../marketDataClient");
class MockMarketDataClient extends marketDataClient_1.MarketDataClient {
    currentSeq = 0n;
    currentBid = 0;
    currentAsk = 0;
    currentObi = 0;
    currentCvd = 0;
    currentVel = 0;
    constructor() {
        // Pass empty buffer to base constructor
        super(new SharedArrayBuffer(2048));
    }
    updateState(tick) {
        this.currentSeq = tick.sequenceNum;
        this.currentBid = tick.bidPrice;
        this.currentAsk = tick.askPrice;
        this.currentObi = tick.obi;
        this.currentCvd = tick.cvd;
        this.currentVel = tick.spreadVelocity;
    }
    getSequenceNum() {
        return this.currentSeq;
    }
    getBestBidPrice() {
        return this.currentBid;
    }
    getBestAskPrice() {
        return this.currentAsk;
    }
    getOBI() {
        return this.currentObi;
    }
    getCVD() {
        return this.currentCvd;
    }
    getSpreadVelocity() {
        return this.currentVel;
    }
}
exports.MockMarketDataClient = MockMarketDataClient;
class BacktestEngine {
    config;
    constructor(config) {
        this.config = {
            initialCapital: config?.initialCapital ?? 10000.0,
            orderQuantity: config?.orderQuantity ?? 0.01,
            takerFeeRate: config?.takerFeeRate ?? 0.0004,
            slippageTicks: config?.slippageTicks ?? 1,
            tickSize: config?.tickSize ?? 0.1,
            strategyConfig: config?.strategyConfig,
        };
    }
    /**
     * Runs tick replay simulation over historical data ticks.
     */
    run(ticks) {
        const mockClient = new MockMarketDataClient();
        const riskGuard = new risk_1.RiskGuard({ maxDailyLossUsdt: 1000.0, maxPositionSizeUsdt: 50000.0, minCooldownMs: 0 });
        const executionClient = new binance_1.BinanceExecutionClient();
        const engine = new engine_1.StrategyEngine(mockClient, riskGuard, executionClient, {
            orderQuantity: this.config.orderQuantity,
            ...this.config.strategyConfig,
        });
        let currentCapital = this.config.initialCapital;
        let peakCapital = currentCapital;
        let maxDrawdown = 0;
        let position = "NONE";
        let entryPrice = 0;
        let entryQuantity = 0;
        let grossProfit = 0;
        let grossLoss = 0;
        let totalFeesPaid = 0;
        let winningTrades = 0;
        let losingTrades = 0;
        let totalSignalsGenerated = 0;
        let totalTradesExecuted = 0;
        const tradeReturns = [];
        const startTime = process.hrtime.bigint();
        for (let i = 0; i < ticks.length; i++) {
            const tick = ticks[i];
            mockClient.updateState(tick);
            const result = engine.evaluateTick();
            if (result.signalType !== "NONE") {
                totalSignalsGenerated++;
                const slippage = this.config.slippageTicks * this.config.tickSize;
                // Position Management & Execution Logic (Bidirectional Long & Short Support)
                if (result.signalType === "BUY" && position === "NONE") {
                    const fillPrice = tick.askPrice + slippage;
                    const notional = fillPrice * this.config.orderQuantity;
                    const fee = notional * this.config.takerFeeRate;
                    position = "LONG";
                    entryPrice = fillPrice;
                    entryQuantity = this.config.orderQuantity;
                    currentCapital -= fee;
                    totalFeesPaid += fee;
                    totalTradesExecuted++;
                }
                else if (result.signalType === "SELL" && position === "LONG") {
                    const fillPrice = tick.bidPrice - slippage;
                    const notional = fillPrice * entryQuantity;
                    const fee = notional * this.config.takerFeeRate;
                    const pnl = (fillPrice - entryPrice) * entryQuantity - fee;
                    currentCapital += pnl;
                    totalFeesPaid += fee;
                    totalTradesExecuted++;
                    riskGuard.recordRealizedPnl(pnl);
                    riskGuard.updatePositionNotional(0);
                    const tradeReturnPercent = (pnl / (entryPrice * entryQuantity)) * 100;
                    tradeReturns.push(tradeReturnPercent);
                    if (pnl > 0) {
                        grossProfit += pnl;
                        winningTrades++;
                    }
                    else {
                        grossLoss += Math.abs(pnl);
                        losingTrades++;
                    }
                    position = "NONE";
                }
                else if (result.signalType === "SELL" && position === "NONE") {
                    const fillPrice = tick.bidPrice - slippage;
                    const notional = fillPrice * this.config.orderQuantity;
                    const fee = notional * this.config.takerFeeRate;
                    position = "SHORT";
                    entryPrice = fillPrice;
                    entryQuantity = this.config.orderQuantity;
                    currentCapital -= fee;
                    totalFeesPaid += fee;
                    totalTradesExecuted++;
                }
                else if (result.signalType === "BUY" && position === "SHORT") {
                    const fillPrice = tick.askPrice + slippage;
                    const notional = fillPrice * entryQuantity;
                    const fee = notional * this.config.takerFeeRate;
                    const pnl = (entryPrice - fillPrice) * entryQuantity - fee;
                    currentCapital += pnl;
                    totalFeesPaid += fee;
                    totalTradesExecuted++;
                    riskGuard.recordRealizedPnl(pnl);
                    riskGuard.updatePositionNotional(0);
                    const tradeReturnPercent = (pnl / (entryPrice * entryQuantity)) * 100;
                    tradeReturns.push(tradeReturnPercent);
                    if (pnl > 0) {
                        grossProfit += pnl;
                        winningTrades++;
                    }
                    else {
                        grossLoss += Math.abs(pnl);
                        losingTrades++;
                    }
                    position = "NONE";
                }
                // Drawdown Tracking
                if (currentCapital > peakCapital) {
                    peakCapital = currentCapital;
                }
                const currentDrawdown = ((peakCapital - currentCapital) / peakCapital) * 100;
                if (currentDrawdown > maxDrawdown) {
                    maxDrawdown = currentDrawdown;
                }
            }
        }
        const endTime = process.hrtime.bigint();
        const totalElapsedNs = Number(endTime - startTime);
        const avgTickProcessingTimeUs = ticks.length > 0 ? (totalElapsedNs / 1000) / ticks.length : 0;
        const throughputTicksPerSec = totalElapsedNs > 0 ? Math.round((ticks.length / (totalElapsedNs / 1e9))) : 0;
        const netPnl = currentCapital - this.config.initialCapital;
        const totalReturnPercent = (netPnl / this.config.initialCapital) * 100;
        const winRatePercent = totalTradesExecuted > 0 ? (winningTrades / totalTradesExecuted) * 100 : 0;
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999.99 : 0;
        // Calculate Sharpe Ratio (annualized)
        const sharpeRatio = this.calculateSharpeRatio(tradeReturns);
        return {
            initialCapital: this.config.initialCapital,
            finalCapital: Number(currentCapital.toFixed(2)),
            netPnl: Number(netPnl.toFixed(2)),
            totalReturnPercent: Number(totalReturnPercent.toFixed(2)),
            totalTicksEvaluated: ticks.length,
            totalSignalsGenerated,
            totalTradesExecuted,
            winningTrades,
            losingTrades,
            winRatePercent: Number(winRatePercent.toFixed(2)),
            profitFactor: Number(profitFactor.toFixed(2)),
            maxDrawdownPercent: Number(maxDrawdown.toFixed(2)),
            sharpeRatio: Number(sharpeRatio.toFixed(2)),
            grossProfit: Number(grossProfit.toFixed(2)),
            grossLoss: Number(grossLoss.toFixed(2)),
            totalFeesPaid: Number(totalFeesPaid.toFixed(2)),
            avgTickProcessingTimeUs: Number(avgTickProcessingTimeUs.toFixed(3)),
            throughputTicksPerSec,
        };
    }
    calculateSharpeRatio(returns) {
        if (returns.length < 2)
            return 0;
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
        const stdDev = Math.sqrt(variance);
        if (stdDev === 0)
            return 0;
        return (mean / stdDev) * Math.sqrt(252);
    }
}
exports.BacktestEngine = BacktestEngine;
var multiAssetBacktester_1 = require("./multiAssetBacktester");
Object.defineProperty(exports, "MultiAssetBacktestEngine", { enumerable: true, get: function () { return multiAssetBacktester_1.MultiAssetBacktestEngine; } });
