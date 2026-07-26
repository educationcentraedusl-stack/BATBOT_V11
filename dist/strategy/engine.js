"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategyEngine = void 0;
class StrategyEngine {
    client;
    riskGuard;
    executionClient;
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
    constructor(client, riskGuard, executionClient, config) {
        this.client = client;
        this.riskGuard = riskGuard;
        this.executionClient = executionClient;
        this.config = {
            symbol: config?.symbol ?? "BTCUSDT",
            orderQuantity: config?.orderQuantity ?? 0.001,
            obiBuyThreshold: config?.obiBuyThreshold ?? 0.25,
            obiSellThreshold: config?.obiSellThreshold ?? -0.25,
            cvdBuyThreshold: config?.cvdBuyThreshold ?? 50.0,
            cvdSellThreshold: config?.cvdSellThreshold ?? -50.0,
            maxSpreadVelocity: config?.maxSpreadVelocity ?? 0.1,
        };
        this.reusableOrderIntent.symbol = this.config.symbol;
        this.reusableOrderIntent.quantity = this.config.orderQuantity;
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
        let signalType = "NONE";
        // Signal Evaluation Logic
        if (obi > this.config.obiBuyThreshold &&
            cvd > this.config.cvdBuyThreshold &&
            spreadVelocity < this.config.maxSpreadVelocity &&
            askPrice > 0) {
            signalType = "BUY";
        }
        else if (obi < this.config.obiSellThreshold &&
            cvd < this.config.cvdSellThreshold &&
            spreadVelocity < this.config.maxSpreadVelocity &&
            bidPrice > 0) {
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
        // Populate pre-allocated intent
        this.reusableOrderIntent.symbol = this.config.symbol;
        this.reusableOrderIntent.side = signalType;
        this.reusableOrderIntent.quantity = this.config.orderQuantity;
        this.reusableOrderIntent.price = signalType === "BUY" ? askPrice : bidPrice;
        // Pass through Risk Management Guard
        const isConfigured = this.executionClient.isConfigured();
        const riskResult = this.riskGuard.validateOrder(this.reusableOrderIntent, isConfigured);
        let executionPromise = undefined;
        if (riskResult.passed) {
            const notional = this.reusableOrderIntent.price * this.reusableOrderIntent.quantity;
            this.riskGuard.recordExecutionSuccess(notional);
            // Execute order with safe exception handler to prevent unhandled promise rejections
            executionPromise = this.executionClient
                .placeOrder({
                symbol: this.reusableOrderIntent.symbol,
                side: this.reusableOrderIntent.side,
                type: "LIMIT",
                quantity: this.reusableOrderIntent.quantity,
                price: this.reusableOrderIntent.price,
                timeInForce: "IOC",
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
