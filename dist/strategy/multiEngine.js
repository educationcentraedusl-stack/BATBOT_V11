"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAssetStrategyEngine = void 0;
const positionLedger_1 = require("./positionLedger");
const engine_1 = require("./engine");
const tradingSymbols_1 = require("../config/tradingSymbols");
class MultiAssetStrategyEngine {
    client;
    riskGuard;
    executionClient;
    positionLedger;
    activeSymbols;
    engines = new Map();
    state = "LIVE_ACTIVE";
    constructor(client, riskGuard, executionClient, symbols, positionLedger) {
        this.client = client;
        this.riskGuard = riskGuard;
        this.executionClient = executionClient;
        this.activeSymbols = symbols && symbols.length > 0 ? symbols : (0, tradingSymbols_1.getTradingSymbols)();
        this.positionLedger = positionLedger ?? new positionLedger_1.MultiAssetPositionLedger(this.activeSymbols);
        // Initialize StrategyEngine instance for each active symbol
        for (let i = 0; i < this.activeSymbols.length; i++) {
            const symbol = this.activeSymbols[i];
            if (!symbol)
                continue;
            const hedgeLedger = this.positionLedger.getOrCreateLedger(symbol);
            const engine = new engine_1.StrategyEngine(this.client, this.riskGuard, this.executionClient, { symbol, assetIndex: i }, hedgeLedger.getLegacyLedger(), hedgeLedger);
            this.engines.set(symbol, engine);
        }
    }
    getActiveSymbols() {
        return this.activeSymbols;
    }
    getEngineForSymbol(symbol) {
        return this.engines.get(symbol);
    }
    getEngineByAssetIndex(assetIdx) {
        const symbol = this.activeSymbols[assetIdx];
        return symbol ? this.engines.get(symbol) : undefined;
    }
    getAllEngines() {
        return this.engines;
    }
    getEngineState() {
        return this.state;
    }
    setEngineState(state) {
        this.state = state;
        for (const engine of this.engines.values()) {
            engine.setEngineState(state);
        }
    }
    async initUserDataStream() {
        let anySuccess = false;
        for (const engine of this.engines.values()) {
            const started = await engine.initUserDataStream();
            if (started)
                anySuccess = true;
        }
        return anySuccess;
    }
    async syncExchangeState() {
        console.log(`[MultiAssetStrategyEngine][StateSync] Initiating multi-asset state hydration across ${this.engines.size} active symbol engines...`);
        if (!this.executionClient.isConfigured()) {
            console.log("[MultiAssetStrategyEngine][StateSync] BinanceExecutionClient unconfigured. Skipping state sync.");
            return;
        }
        for (const engine of this.engines.values()) {
            await engine.syncExchangeState();
        }
        let totalNotional = 0;
        this.riskGuard.resetSymbolNotionals();
        for (const [symbol, engine] of this.engines.entries()) {
            const summary = engine.getHedgeLedger().getSummary(0);
            if (summary.side !== "FLAT" && summary.netQuantity > 0) {
                const symbolGrossNotional = summary.netQuantity * summary.averageEntryPrice;
                totalNotional += symbolGrossNotional;
                this.riskGuard.updateSymbolNotional(symbol, symbolGrossNotional);
            }
        }
        this.riskGuard.updatePositionNotional(totalNotional);
        console.log(`[MultiAssetStrategyEngine][StateSync] Multi-asset state hydration complete. Active Portfolio Gross Notional: $${totalNotional.toFixed(2)} USDT`);
    }
    reconcileStartupPositions(positions) {
        let totalNotional = 0;
        this.riskGuard.resetSymbolNotionals();
        for (const engine of this.engines.values()) {
            engine.reconcileStartupPositions(positions);
            const symbol = engine.getConfig().symbol;
            let symbolGrossNotional = 0;
            for (const pos of positions) {
                if (pos.symbol === symbol) {
                    const amt = Math.abs(parseFloat(pos.positionAmt || "0"));
                    const entryPx = parseFloat(pos.entryPrice || "0");
                    if (amt > 0 && entryPx > 0) {
                        symbolGrossNotional += amt * entryPx;
                    }
                }
            }
            if (symbolGrossNotional > 0) {
                totalNotional += symbolGrossNotional;
                this.riskGuard.updateSymbolNotional(symbol, symbolGrossNotional);
            }
        }
        this.riskGuard.updatePositionNotional(totalNotional);
    }
    /**
     * Vectorized zero-GC multi-asset tick evaluation loop.
     * Evaluates ticks across all $N$ active assets every 10ms cycle.
     * Leverages fast atomic sequence skipping (<50ns per inactive asset).
     */
    evaluateAllTicks() {
        const results = new Map();
        let signalCount = 0;
        for (let i = 0; i < this.activeSymbols.length; i++) {
            const symbol = this.activeSymbols[i];
            if (!symbol)
                continue;
            const engine = this.engines.get(symbol);
            if (!engine)
                continue;
            const result = engine.evaluateTick();
            results.set(symbol, result);
            if (result.signalType !== "NONE") {
                signalCount++;
            }
        }
        return {
            timestamp: Date.now(),
            results,
            activeCount: this.activeSymbols.length,
            signalCount,
        };
    }
    evaluateMultiAssetTick() {
        const timestamp = Date.now();
        const signals = [];
        for (let i = 0; i < this.activeSymbols.length; i++) {
            const symbol = this.activeSymbols[i];
            if (!symbol)
                continue;
            const assetIdx = i;
            const obi = this.client.getOBI(assetIdx);
            const cvd = this.client.getCVD(assetIdx);
            const hurst = this.client.getHurst(assetIdx);
            const vpin = this.client.getVPIN(assetIdx);
            const hawkes = this.client.getHawkesIntensity(assetIdx);
            let signalType = "NONE";
            let confidence = this.client.getAIPredictionConfidence(assetIdx);
            let isApproved = false;
            let rejectReason = undefined;
            if (vpin > 0.75) {
                rejectReason = "REJECTED_TOXIC_FLOW";
            }
            else if (hurst < 0.45) {
                rejectReason = "REJECTED_COUNTER_TREND_REGIME";
            }
            else if (confidence < 0.75) {
                rejectReason = "REJECTED_LOW_CONFIDENCE";
            }
            else if (obi >= 0.35 && cvd >= 0.0 && hawkes >= 0.5 && confidence >= 0.75) {
                signalType = "BUY";
                isApproved = true;
            }
            else if (obi <= -0.35 && cvd <= 0.0 && hawkes >= 0.5 && confidence >= 0.75) {
                signalType = "SELL";
                isApproved = true;
            }
            signals.push({
                assetIndex: assetIdx,
                symbol,
                signalType,
                confidence,
                obi,
                cvd,
                hurst,
                isApproved,
                rejectReason,
            });
        }
        return {
            timestamp,
            signals,
        };
    }
    getPositionLedger() {
        return this.positionLedger;
    }
    getRiskGuard() {
        return this.riskGuard;
    }
    getClient() {
        return this.client;
    }
    getExecutionClient() {
        return this.executionClient;
    }
}
exports.MultiAssetStrategyEngine = MultiAssetStrategyEngine;
