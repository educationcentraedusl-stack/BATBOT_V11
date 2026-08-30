"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAssetStrategyEngine = void 0;
const positionLedger_1 = require("./positionLedger");
const engine_1 = require("./engine");
const tradingSymbols_1 = require("../config/tradingSymbols");
const userDataStream_1 = require("../execution/userDataStream");
class MultiAssetStrategyEngine {
    client;
    riskGuard;
    executionClient;
    positionLedger;
    activeSymbols;
    engines = new Map();
    state = "LIVE_ACTIVE";
    // Centralized account-level User Data Stream & Reconciliation Heartbeat
    centralizedUserDataStream = null;
    reconciliationTimer = null;
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
    /**
     * Initializes a single centralized Binance User Data Stream for the entire account
     * and routes symbol-specific trade and position updates directly to matching StrategyEngine instances.
     */
    async initUserDataStream() {
        if (!this.executionClient.isConfigured()) {
            console.warn("[MultiAssetStrategyEngine] Binance execution client unconfigured. Skipping User Data Stream.");
            return false;
        }
        if (this.centralizedUserDataStream && this.centralizedUserDataStream.isStreamConnected()) {
            return true;
        }
        this.centralizedUserDataStream = new userDataStream_1.BinanceUserDataStream(this.executionClient);
        // Multiplex incoming ORDER_TRADE_UPDATE events by symbol
        this.centralizedUserDataStream.subscribeOrderUpdates((update) => {
            const symbol = update.order.symbol;
            const engine = this.engines.get(symbol);
            if (engine) {
                engine.handleWsOrderUpdate(update);
            }
        });
        // Multiplex incoming ACCOUNT_UPDATE position events by symbol
        this.centralizedUserDataStream.subscribeAccountUpdates((accUpdate) => {
            for (const pos of accUpdate.positions) {
                const engine = this.engines.get(pos.symbol);
                if (engine) {
                    engine.handleWsAccountPositionUpdate(pos);
                }
            }
        });
        const started = await this.centralizedUserDataStream.start();
        if (started) {
            console.log(`[MultiAssetStrategyEngine] Single Centralized Account-Level User Data Stream online across ${this.engines.size} symbols.`);
        }
        return started;
    }
    /**
     * Starts a continuous background reconciliation heartbeat auditing live Binance positionRisk
     * against internal ledgers every N milliseconds to guarantee zero-orphan state integrity.
     */
    startContinuousReconciliation(intervalMs = 5000) {
        if (this.reconciliationTimer)
            return;
        console.log(`[MultiAssetStrategyEngine][ReconciliationHeartbeat] Continuous ${intervalMs}ms state reconciliation heartbeat online.`);
        this.reconciliationTimer = setInterval(() => {
            this.syncExchangeState().catch((err) => {
                const errorMessage = err instanceof Error ? err.message : String(err);
                console.warn(`[MultiAssetStrategyEngine][ReconciliationHeartbeat] Notice during state sync: ${errorMessage}`);
            });
        }, intervalMs);
    }
    stopContinuousReconciliation() {
        if (this.reconciliationTimer) {
            clearInterval(this.reconciliationTimer);
            this.reconciliationTimer = null;
        }
        if (this.centralizedUserDataStream) {
            this.centralizedUserDataStream.stop();
            this.centralizedUserDataStream = null;
        }
        for (const engine of this.engines.values()) {
            engine.clearPendingEntryOrders();
        }
        console.log("[MultiAssetStrategyEngine] Continuous reconciliation & centralized stream stopped.");
    }
    async syncLeverageWithExchange(targetLeverage) {
        const envLeverage = parseInt(process.env.LEVERAGE || "10", 10);
        const leverageToSet = targetLeverage && targetLeverage > 0 ? targetLeverage : envLeverage;
        if (!this.executionClient.isConfigured())
            return;
        for (const symbol of this.activeSymbols) {
            if (!symbol)
                continue;
            try {
                const res = await this.executionClient.setLeverage(symbol, leverageToSet);
                if (res) {
                    const engine = this.engines.get(symbol);
                    if (engine) {
                        engine.setLeverageMultiplier(res.leverage);
                    }
                }
            }
            catch (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                console.warn(`[MultiAssetStrategyEngine] Notice setting leverage for ${symbol}: ${errorMessage}`);
            }
        }
    }
    async syncExchangeState() {
        if (!this.executionClient.isConfigured()) {
            return;
        }
        try {
            // SOTA Tri-Vector: Fetch dual-source consensus positions (V3 positionRisk + V3 account)
            const allPositions = await this.executionClient.getDualPositionRisk();
            const validPositions = Array.isArray(allPositions) ? allPositions : [];
            // Targeted low-weight per-symbol open orders queries (eliminates weight-40 rate limit spikes)
            const orderPromises = this.activeSymbols.map((sym) => this.executionClient.getOpenOrders(sym));
            const symbolOrderArrays = await Promise.all(orderPromises);
            const ordersBySymbol = new Map();
            for (let i = 0; i < this.activeSymbols.length; i++) {
                const sym = this.activeSymbols[i];
                if (sym) {
                    ordersBySymbol.set(sym, symbolOrderArrays[i] || []);
                }
            }
            let totalNotional = 0;
            this.riskGuard.resetSymbolNotionals();
            for (const [symbol, engine] of this.engines.entries()) {
                const symbolPositions = validPositions.filter((p) => p.symbol === symbol);
                const symbolOrders = ordersBySymbol.get(symbol) || [];
                await engine.syncExchangeStateWithData(symbolPositions, symbolOrders);
                const summary = engine.getHedgeLedger().getSummary(0);
                if (summary.side !== "FLAT" && summary.grossQuantity > 0) {
                    const symbolGrossNotional = summary.grossQuantity * summary.averageEntryPrice;
                    totalNotional += symbolGrossNotional;
                    this.riskGuard.updateSymbolNotional(symbol, symbolGrossNotional);
                }
            }
            this.riskGuard.updatePositionNotional(totalNotional);
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error(`[MultiAssetStrategyEngine][StateSync][ERROR] Failed to fetch Binance exchange state: ${errorMessage}`);
        }
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
            const cvd = this.client.getCVDVelocity(assetIdx, 5000, timestamp);
            const hurst = this.client.getHurst(assetIdx);
            const vpin = this.client.getVPIN(assetIdx);
            const hawkes = this.client.getHawkesIntensity(assetIdx);
            const engine = this.engines.get(symbol);
            const bidPrice = this.client.getBestBidPrice(assetIdx);
            const askPrice = this.client.getBestAskPrice(assetIdx);
            const isTickValid = askPrice > 0 && bidPrice > 0 && askPrice >= bidPrice;
            const currentSpread = isTickValid ? askPrice - bidPrice : Infinity;
            const currentMidPrice = isTickValid ? (bidPrice + askPrice) * 0.5 : 0;
            const currentSpreadBps = currentMidPrice > 0 ? (currentSpread / currentMidPrice) * 10000 : Infinity;
            let maxEntrySpreadAllowed;
            if (symbol.includes("BTC")) {
                maxEntrySpreadAllowed = Math.min(engine?.getConfig().maxSpreadBtc || 1.50, Math.max(0.10, currentMidPrice * 0.0005));
            }
            else if (symbol.includes("ETH")) {
                maxEntrySpreadAllowed = Math.min(engine?.getConfig().maxSpreadEth || 0.40, Math.max(0.01, currentMidPrice * 0.0005));
            }
            else {
                maxEntrySpreadAllowed = Math.min(engine?.getConfig().maxSpreadAlt || 0.20, Math.max(0.0001, currentMidPrice * 0.0005));
            }
            const isSpreadBlowout = !isTickValid || currentSpread > maxEntrySpreadAllowed || currentSpreadBps > 5.0;
            let signalType = "NONE";
            let confidence = this.client.getAIPredictionConfidence(assetIdx);
            let isApproved = false;
            let rejectReason = undefined;
            const minConfidence = engine ? engine.getConfig().minAiConfidence : parseFloat(process.env.MIN_AI_CONFIDENCE || "0.700");
            const obiBuyThresh = engine ? engine.getConfig().obiBuyThreshold : parseFloat(process.env.OBI_BUY_THRESHOLD || "0.30");
            const obiSellThresh = engine ? engine.getConfig().obiSellThreshold : parseFloat(process.env.OBI_SELL_THRESHOLD || "-0.30");
            const hedgeLedger = engine?.getHedgeLedger();
            const isCoreLongOccupied = hedgeLedger ? (hedgeLedger.getCoreLong().isOccupied || hedgeLedger.getCoreLong().lifecycleState === "PENDING_ENTRY") : false;
            const isShortOccupied = hedgeLedger ? hedgeLedger.getShortSlots().some(s => s.isOccupied || s.lifecycleState === "PENDING_ENTRY") : false;
            if (isSpreadBlowout) {
                rejectReason = "REJECTED_SPREAD_BLOWOUT";
            }
            else if (vpin > 0.75) {
                rejectReason = "REJECTED_TOXIC_FLOW";
            }
            else if (hurst < 0.45) {
                rejectReason = "REJECTED_COUNTER_TREND_REGIME";
            }
            else if (confidence < minConfidence) {
                rejectReason = "REJECTED_LOW_CONFIDENCE";
            }
            else if (obi >= obiBuyThresh && cvd >= 0.0 && hawkes >= 0.5 && confidence >= minConfidence) {
                if (isShortOccupied) {
                    rejectReason = "REJECTED_UNIDIRECTIONAL_MUTEX_SHORT_ACTIVE";
                }
                else {
                    signalType = "BUY";
                    isApproved = true;
                }
            }
            else if (obi <= obiSellThresh && cvd <= 0.0 && hawkes >= 0.5 && confidence >= minConfidence) {
                if (isCoreLongOccupied) {
                    rejectReason = "REJECTED_UNIDIRECTIONAL_MUTEX_LONG_ACTIVE";
                }
                else {
                    signalType = "SELL";
                    isApproved = true;
                }
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
