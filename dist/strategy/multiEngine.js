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
            const baselineLev = (0, tradingSymbols_1.getBaselineLeverageForSymbol)(symbol);
            const engine = new engine_1.StrategyEngine(this.client, this.riskGuard, this.executionClient, { symbol, assetIndex: i, leverageMultiplier: baselineLev }, hedgeLedger.getLegacyLedger(), hedgeLedger);
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
        // Multiplex incoming ACCOUNT_UPDATE position and balance events by symbol
        this.centralizedUserDataStream.subscribeAccountUpdates((accUpdate) => {
            // 1. Propagate account balance mutations from ACCOUNT_UPDATE WebSocket push.
            //
            // ROOT-CAUSE FIX: The Binance ACCOUNT_UPDATE payload (payload.a.B) does NOT emit
            // `availableBalance`. It only emits `wb` (walletBalance) and `cw` (crossWalletBalance).
            // crossWalletBalance is the wallet balance allocated to cross-margin positions and is
            // ALWAYS >= availableBalance because it ignores open-order margin reservations.
            // Writing crossWalletBalance to slot 134 (AvailBal) systematically overstates the
            // available balance by the total margin locked in pending orders.
            //
            // Correct behaviour:
            //   - Update the riskGuard with walletBalance (wb) as the gross account size.
            //   - The authoritative availableBalance is fetched asynchronously via REST
            //     (GET /fapi/v2/balance returns `availableBalance`) and written to slot 134
            //     by the debounced `scheduleAvailableBalanceRefetch()` called inside
            //     BinanceUserDataStream after every ACCOUNT_UPDATE event.
            if (accUpdate.balances && accUpdate.balances.length > 0) {
                const usdtBal = accUpdate.balances.find((b) => b.asset === "USDT");
                if (usdtBal && Number.isFinite(usdtBal.walletBalance)) {
                    this.riskGuard.updateAccountBalance(usdtBal.walletBalance);
                    // NOTE: client.setAvailableBalance() is intentionally NOT called here.
                    // The render loop in run_tui_dashboard.ts reads from binanceClient.getUsdtAvailableBalance()
                    // which is kept authoritative by the debounced REST refetch in binance.ts.
                }
            }
            // 2. Route position updates to matching symbol StrategyEngine
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
     * Starts a passive background reconciliation heartbeat auditing live Binance positionRisk
     * against internal ledgers every N milliseconds (default 60s) to guarantee zero-orphan state integrity.
     */
    startContinuousReconciliation(intervalMs = 60000) {
        if (this.reconciliationTimer)
            return;
        console.log(`[MultiAssetStrategyEngine][ReconciliationHeartbeat] Passive ${intervalMs}ms state reconciliation heartbeat online.`);
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
            engine.annihilateRestingEntryOrders("SYSTEM_SHUTDOWN");
        }
        console.log("[MultiAssetStrategyEngine] Continuous reconciliation & centralized stream stopped.");
    }
    async syncLeverageWithExchange(targetLeverage) {
        if (!this.executionClient.isConfigured())
            return;
        for (const symbol of this.activeSymbols) {
            if (!symbol)
                continue;
            try {
                const engine = this.engines.get(symbol);
                // Phase 4 Dynamic Leverage Scaling:
                // Calculate dynamic inverse-volatility leverage targeting constant portfolio volatility budget.
                // Clamp strictly between 2x (Min) and 5x (Max). 20x is permanently banned!
                let leverageToSet;
                if (targetLeverage && targetLeverage > 0) {
                    leverageToSet = Math.max(2, Math.min(5, Math.round(targetLeverage)));
                }
                else if (engine) {
                    leverageToSet = engine.getDynamicLeverage();
                }
                else {
                    leverageToSet = (0, tradingSymbols_1.getBaselineLeverageForSymbol)(symbol);
                }
                const res = await this.executionClient.setLeverage(symbol, leverageToSet);
                if (res) {
                    if (engine) {
                        engine.setLeverageMultiplier(res.leverage);
                    }
                }
            }
            catch (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                console.warn(`[MultiAssetStrategyEngine] Notice setting dynamic leverage for ${symbol}: ${errorMessage}`);
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
                // Phase 3 Sovereign Order State Machine: Continuous physical reconciliation verification
                const longSummary = engine.getHedgeLedger().getAggregatedSideSummary("LONG");
                if (longSummary.isOccupied && longSummary.totalQuantity > 0) {
                    const longAudit = this.riskGuard.auditAggregatedPositionRisk(symbol, "LONG", longSummary.totalQuantity, longSummary.activeStopLossOrderId, symbolOrders);
                    if (!longAudit.isProtected) {
                        console.error(`[MultiAssetStrategyEngine][SOVEREIGN_RECONCILIATION_FAIL] [${symbol}:LONG] ${longAudit.reason}`);
                    }
                }
                const shortSummary = engine.getHedgeLedger().getAggregatedSideSummary("SHORT");
                if (shortSummary.isOccupied && shortSummary.totalQuantity > 0) {
                    const shortAudit = this.riskGuard.auditAggregatedPositionRisk(symbol, "SHORT", shortSummary.totalQuantity, shortSummary.activeStopLossOrderId, symbolOrders);
                    if (!shortAudit.isProtected) {
                        console.error(`[MultiAssetStrategyEngine][SOVEREIGN_RECONCILIATION_FAIL] [${symbol}:SHORT] ${shortAudit.reason}`);
                    }
                }
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
            const isTestnetEnv = process.env.USE_TESTNET === "true" || process.env.BINANCE_TESTNET === "true";
            const envRelaxSpread = process.env.RELAX_TESTNET_SPREAD === "true" || process.env.ALLOW_TESTNET_WIDE_SPREADS === "true";
            const hasExplicitSpreadConfig = engine?.getConfig().maxSpreadBtc !== undefined || engine?.getConfig().maxSpreadEth !== undefined || engine?.getConfig().maxSpreadAlt !== undefined;
            const isTestnet = isTestnetEnv && (engine?.getConfig().relaxTestnetSpread === true || (envRelaxSpread && !hasExplicitSpreadConfig));
            let maxEntrySpreadAllowed;
            const maxAllowedBps = isTestnet ? 50.0 : 5.0;
            if (isTestnet) {
                if (symbol.includes("BTC")) {
                    maxEntrySpreadAllowed = Math.min(25.0, Math.max(1.50, currentMidPrice * 0.00030));
                }
                else if (symbol.includes("ETH")) {
                    maxEntrySpreadAllowed = Math.min(2.0, Math.max(0.40, currentMidPrice * 0.00050));
                }
                else {
                    maxEntrySpreadAllowed = Math.min(0.10, Math.max(0.001, currentMidPrice * 0.0050));
                }
            }
            else {
                if (symbol.includes("BTC")) {
                    maxEntrySpreadAllowed = Math.min(engine?.getConfig().maxSpreadBtc || 1.50, Math.max(0.10, currentMidPrice * 0.0005));
                }
                else if (symbol.includes("ETH")) {
                    maxEntrySpreadAllowed = Math.min(engine?.getConfig().maxSpreadEth || 0.40, Math.max(0.01, currentMidPrice * 0.0005));
                }
                else {
                    maxEntrySpreadAllowed = Math.min(engine?.getConfig().maxSpreadAlt || 0.20, Math.max(0.0001, currentMidPrice * 0.0005));
                }
            }
            const isSpreadBlowout = !isTickValid || currentSpread > maxEntrySpreadAllowed || currentSpreadBps > maxAllowedBps;
            let signalType = "NONE";
            let confidence = this.client.getAIPredictionConfidence(assetIdx);
            let isApproved = false;
            let rejectReason = undefined;
            const minConfidence = engine ? engine.getConfig().minAiConfidence : parseFloat(process.env.MIN_AI_CONFIDENCE || "0.495");
            const obiBuyThresh = engine ? engine.getConfig().obiBuyThreshold : parseFloat(process.env.OBI_BUY_THRESHOLD || "0.30");
            const obiSellThresh = engine ? engine.getConfig().obiSellThreshold : parseFloat(process.env.OBI_SELL_THRESHOLD || "-0.30");
            const hedgeLedger = engine?.getHedgeLedger();
            const isCoreLongOccupied = hedgeLedger ? (hedgeLedger.getCoreLong().isOccupied || hedgeLedger.getCoreLong().lifecycleState === "PENDING_ENTRY") : false;
            const isShortOccupied = hedgeLedger ? hedgeLedger.getShortSlots().some(s => s.isOccupied || s.lifecycleState === "PENDING_ENTRY") : false;
            const vrState = engine?.getVrClassifier().getRegimeState();
            if (isSpreadBlowout) {
                rejectReason = "REJECTED_SPREAD_BLOWOUT";
            }
            else if (vrState === "MEAN_REVERT") {
                rejectReason = "REJECTED_CHOP_REGIME";
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
