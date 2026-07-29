"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategyEngine = void 0;
const positionLedger_1 = require("./positionLedger");
class StrategyEngine {
    client;
    riskGuard;
    executionClient;
    positionLedger;
    config;
    lastProcessedSequence = -1n;
    // Pre-allocated order intent structure to avoid GC-thrashing on signal triggers
    reusableOrderIntent = {
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: 0.001,
        price: 0,
    };
    // Reusable static result object for NONE signals to achieve zero GC-heap allocation in hot path
    staticResult = {
        sequenceNum: 0n,
        signalType: "NONE",
        obi: 0,
        cvd: 0,
        spreadVelocity: 0,
        bidPrice: 0,
        askPrice: 0,
    };
    constructor(client, riskGuard, executionClient, config, positionLedger) {
        this.client = client;
        this.riskGuard = riskGuard;
        this.executionClient = executionClient;
        const envTp = process.env.TAKE_PROFIT_PERCENT ? parseFloat(process.env.TAKE_PROFIT_PERCENT) : NaN;
        const envSl = process.env.STOP_LOSS_PERCENT ? parseFloat(process.env.STOP_LOSS_PERCENT) : NaN;
        const defaultTp = !isNaN(envTp) ? envTp : 1.5;
        const defaultSl = !isNaN(envSl) ? envSl : 1.0;
        this.config = {
            symbol: config?.symbol ?? "BTCUSDT",
            orderQuantity: config?.orderQuantity ?? 0.001,
            obiBuyThreshold: config?.obiBuyThreshold ?? 0.25,
            obiSellThreshold: config?.obiSellThreshold ?? -0.25,
            cvdBuyThreshold: config?.cvdBuyThreshold ?? 50.0,
            cvdSellThreshold: config?.cvdSellThreshold ?? -50.0,
            maxSpreadVelocity: config?.maxSpreadVelocity ?? 0.1,
            minAiConfidence: config?.minAiConfidence ?? 0.6,
            aggressiveConfidenceThreshold: config?.aggressiveConfidenceThreshold ?? 0.85,
            tickSize: config?.tickSize ?? 0.1,
            takeProfitPercent: config?.takeProfitPercent ?? defaultTp,
            stopLossPercent: config?.stopLossPercent ?? defaultSl,
        };
        this.positionLedger = positionLedger ?? new positionLedger_1.PositionLedger(this.config.symbol);
        this.reusableOrderIntent.symbol = this.config.symbol;
        this.reusableOrderIntent.quantity = this.config.orderQuantity;
    }
    getPositionLedger() {
        return this.positionLedger;
    }
    /**
     * High-frequency tick evaluation loop.
     * Reads scalar metrics directly from SharedArrayBuffer via MarketDataClient getters.
     * Zero GC heap allocation when no trade signals are generated.
     */
    evaluateTick() {
        const seq = this.client.getSequenceNum();
        if (seq === this.lastProcessedSequence) {
            this.staticResult.sequenceNum = seq;
            this.staticResult.signalType = "NONE";
            return this.staticResult;
        }
        this.lastProcessedSequence = seq;
        // Read scalar metrics atomically from SAB
        const obi = this.client.getOBI();
        const cvd = this.client.getCVD();
        const spreadVelocity = this.client.getSpreadVelocity();
        const bidPrice = this.client.getBestBidPrice();
        const askPrice = this.client.getBestAskPrice();
        // Read AI predictions & latency metrics from SAB
        const aiDirection = this.client.getAIPredictionDirection();
        const aiConfidence = this.client.getAIPredictionConfidence();
        const latencyPenalty = this.client.getLatencyPenaltyCoefficient();
        const penaltyCoeff = latencyPenalty > 0 ? latencyPenalty : 1.0;
        const slippageTicks = this.client.getDynamicSlippageTicks();
        // 1. Dynamic Monitoring: Evaluate Unrealized PnL against dynamic TP/SL thresholds
        const markPrice = askPrice > 0 ? (askPrice + bidPrice) / 2 : bidPrice;
        if (markPrice > 0) {
            const posSummary = this.positionLedger.getSummary(markPrice);
            if (posSummary.side !== "FLAT" && posSummary.netQuantity > 0 && posSummary.averageEntryPrice > 0) {
                const unrealizedPnl = posSummary.unrealizedPnl;
                const initialNotional = posSummary.netQuantity * posSummary.averageEntryPrice;
                const pnlPercent = initialNotional > 0 ? (unrealizedPnl / initialNotional) * 100 : 0;
                let dynamicTrigger = null;
                if (pnlPercent >= this.config.takeProfitPercent) {
                    dynamicTrigger = "TAKE_PROFIT";
                }
                else if (pnlPercent <= -this.config.stopLossPercent) {
                    dynamicTrigger = "STOP_LOSS";
                }
                if (dynamicTrigger !== null) {
                    const exitSide = posSummary.side === "LONG" ? "SELL" : "BUY";
                    console.log(`[DYNAMIC_MONITORING] ${dynamicTrigger} TRIGGERED! Side: ${posSummary.side}, PnL: $${unrealizedPnl.toFixed(4)} (${pnlPercent.toFixed(2)}%), TP Threshold: ${this.config.takeProfitPercent}%, SL Threshold: ${this.config.stopLossPercent}%. Dispatching dynamic MARKET close.`);
                    this.reusableOrderIntent.symbol = this.config.symbol;
                    this.reusableOrderIntent.side = exitSide;
                    this.reusableOrderIntent.quantity = posSummary.netQuantity;
                    this.reusableOrderIntent.price = markPrice;
                    this.reusableOrderIntent.currentPositionSide = posSummary.side;
                    const isConfigured = this.executionClient.isConfigured();
                    const riskResult = this.riskGuard.validateOrder(this.reusableOrderIntent, isConfigured, posSummary.side);
                    let executionPromise = undefined;
                    if (riskResult.passed) {
                        executionPromise = this.executionClient
                            .placeOrder({
                            symbol: this.config.symbol,
                            side: exitSide,
                            type: "MARKET",
                            quantity: posSummary.netQuantity,
                            reduceOnly: true,
                        })
                            .catch((err) => {
                            console.error(`[DYNAMIC_MONITORING_ERROR] Dynamic ${dynamicTrigger} MARKET order failed: ${err.message}`);
                            return null;
                        });
                    }
                    return {
                        sequenceNum: seq,
                        signalType: exitSide,
                        obi,
                        cvd,
                        spreadVelocity,
                        bidPrice,
                        askPrice,
                        riskResult,
                        executionPromise,
                    };
                }
            }
        }
        let signalType = "NONE";
        // Enhanced Signal Evaluation Logic: OBI/CVD combined with AI direction and AI confidence gating
        if (obi > this.config.obiBuyThreshold &&
            cvd > this.config.cvdBuyThreshold &&
            spreadVelocity < this.config.maxSpreadVelocity &&
            askPrice > 0 &&
            aiDirection > 0 &&
            aiConfidence >= this.config.minAiConfidence) {
            signalType = "BUY";
        }
        else if (obi < this.config.obiSellThreshold &&
            cvd < this.config.cvdSellThreshold &&
            spreadVelocity < this.config.maxSpreadVelocity &&
            bidPrice > 0 &&
            aiDirection < 0 &&
            aiConfidence >= this.config.minAiConfidence) {
            signalType = "SELL";
        }
        if (signalType === "NONE") {
            this.staticResult.sequenceNum = seq;
            this.staticResult.signalType = "NONE";
            this.staticResult.obi = obi;
            this.staticResult.cvd = cvd;
            this.staticResult.spreadVelocity = spreadVelocity;
            this.staticResult.bidPrice = bidPrice;
            this.staticResult.askPrice = askPrice;
            this.staticResult.riskResult = undefined;
            this.staticResult.executionPromise = undefined;
            return this.staticResult;
        }
        // TASK 4.3: Apply latency penalty coefficient to orderQuantity BEFORE RiskGuard check
        const scaledQuantity = Number((this.config.orderQuantity * penaltyCoeff).toFixed(4));
        let finalQuantity = Math.max(0.0001, scaledQuantity);
        // TASK 4.3 & 4.4: Dynamic Taker Fallback (>75% Confidence) & 1-Tick Post-Only Offset (<=75%)
        const effectiveSlippage = Math.max(2, slippageTicks);
        const priceAdjustment = effectiveSlippage * this.config.tickSize;
        const basePrice = signalType === "BUY" ? askPrice : bidPrice;
        const isHighConfidence = aiConfidence > 0.75;
        const isAggressive = aiConfidence >= this.config.aggressiveConfidenceThreshold;
        let targetPrice;
        let orderType;
        let timeInForce;
        if (isHighConfidence) {
            console.log("[EXECUTION] High Confidence (>75%) - Bypassing Post-Only for Guaranteed Fill");
            orderType = isAggressive ? "MARKET" : "LIMIT";
            timeInForce = isAggressive ? "IOC" : "GTC";
            targetPrice = signalType === "BUY" ? askPrice + priceAdjustment : bidPrice - priceAdjustment;
        }
        else {
            // Standard confidence (<= 0.75): retain Post-Only (GTX) with safe 1-tick non-crossing maker placement
            orderType = "LIMIT";
            timeInForce = "GTX";
            targetPrice = signalType === "BUY" ? bidPrice : askPrice;
        }
        // Binance Futures Min Notional Guard: ensure order notional >= 55 USDT
        if (basePrice > 0) {
            const minNotionalUsdt = 55.0;
            if (finalQuantity * basePrice < minNotionalUsdt) {
                finalQuantity = Number((minNotionalUsdt / basePrice).toFixed(4));
            }
        }
        // Populate pre-allocated intent
        this.reusableOrderIntent.symbol = this.config.symbol;
        this.reusableOrderIntent.side = signalType;
        this.reusableOrderIntent.quantity = finalQuantity;
        this.reusableOrderIntent.price = Number(targetPrice.toFixed(2));
        this.reusableOrderIntent.currentPositionSide = this.positionLedger.getSummary().side;
        // Pass through Risk Management Guard with current position side
        const isConfigured = this.executionClient.isConfigured();
        const riskResult = this.riskGuard.validateOrder(this.reusableOrderIntent, isConfigured, this.reusableOrderIntent.currentPositionSide);
        let executionPromise = undefined;
        if (riskResult.passed) {
            const notional = this.reusableOrderIntent.price * this.reusableOrderIntent.quantity;
            this.riskGuard.recordExecutionSuccess(notional);
            // Execute order with safe exception handler to prevent unhandled promise rejections
            executionPromise = this.executionClient
                .placeOrder({
                symbol: this.reusableOrderIntent.symbol,
                side: this.reusableOrderIntent.side,
                type: orderType,
                quantity: this.reusableOrderIntent.quantity,
                price: orderType === "LIMIT" ? this.reusableOrderIntent.price : undefined,
                timeInForce: timeInForce,
            })
                .catch((err) => {
                console.error(`[CRITICAL_EXECUTION_ERROR] Order placement failed: ${err.message}`);
                return null;
            });
        }
        return {
            sequenceNum: seq,
            signalType,
            obi,
            cvd,
            spreadVelocity,
            bidPrice,
            askPrice,
            riskResult,
            executionPromise,
        };
    }
    getConfig() {
        return this.config;
    }
}
exports.StrategyEngine = StrategyEngine;
