"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAssetStrategyEngine = exports.StrategyEngine = void 0;
exports.getSymbolQuantityPrecision = getSymbolQuantityPrecision;
exports.formatQuantityForSymbol = formatQuantityForSymbol;
const risk_1 = require("./risk");
const positionLedger_1 = require("./positionLedger");
const dynamicRiskEngine_1 = require("./dynamicRiskEngine");
const userDataStream_1 = require("../execution/userDataStream");
const symbolPrecision_1 = require("../config/symbolPrecision");
const tradingSymbols_1 = require("../config/tradingSymbols");
function getSymbolQuantityPrecision(symbol) {
    const rule = symbolPrecision_1.SymbolPrecisionRegistry.getPrecisionRule(symbol);
    return {
        decimals: rule.qtyDecimals,
        stepSize: rule.stepSize,
        minNotional: rule.minNotional,
    };
}
function formatQuantityForSymbol(symbol, rawQty, isMinNotionalGuard = false) {
    return symbolPrecision_1.SymbolPrecisionRegistry.formatQuantity(symbol, rawQty, isMinNotionalGuard);
}
class StrategyEngine {
    client;
    riskGuard;
    executionClient;
    positionLedger;
    hedgeLedger;
    config;
    dynamicRiskEngine = new dynamicRiskEngine_1.DynamicRiskEngine();
    userDataStream = null;
    lastProcessedSequence = -1n;
    state = "LIVE_ACTIVE";
    assetIndex = 0;
    isOrderInFlight = false;
    reusableOrderIntent;
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
    constructor(client, riskGuard, executionClient, config, positionLedger, hedgeLedger) {
        this.client = client;
        this.riskGuard = riskGuard;
        this.executionClient = executionClient;
        const envLongTp = process.env.LONG_TAKE_PROFIT_PERCENT ? parseFloat(process.env.LONG_TAKE_PROFIT_PERCENT) : NaN;
        const envLongSl = process.env.LONG_STOP_LOSS_PERCENT ? parseFloat(process.env.LONG_STOP_LOSS_PERCENT) : NaN;
        const envShortTp = process.env.SHORT_TAKE_PROFIT_PERCENT ? parseFloat(process.env.SHORT_TAKE_PROFIT_PERCENT) : NaN;
        const envShortSl = process.env.SHORT_STOP_LOSS_PERCENT ? parseFloat(process.env.SHORT_STOP_LOSS_PERCENT) : NaN;
        const envProfitLock = process.env.DAILY_PROFIT_LOCK_USDT ? parseFloat(process.env.DAILY_PROFIT_LOCK_USDT) : NaN;
        const envMaxShortSlots = process.env.MAX_SHORT_SLOTS ? parseInt(process.env.MAX_SHORT_SLOTS, 10) : NaN;
        const envMinAiConfidence = process.env.MIN_AI_CONFIDENCE ? parseFloat(process.env.MIN_AI_CONFIDENCE) : NaN;
        const envAggressiveConfidence = process.env.AGGRESSIVE_CONFIDENCE_THRESHOLD ? parseFloat(process.env.AGGRESSIVE_CONFIDENCE_THRESHOLD) : NaN;
        const envObiBuy = process.env.OBI_BUY_THRESHOLD ? parseFloat(process.env.OBI_BUY_THRESHOLD) : NaN;
        const envObiSell = process.env.OBI_SELL_THRESHOLD ? parseFloat(process.env.OBI_SELL_THRESHOLD) : NaN;
        const envCvdBuy = process.env.CVD_BUY_THRESHOLD ? parseFloat(process.env.CVD_BUY_THRESHOLD) : NaN;
        const envCvdSell = process.env.CVD_SELL_THRESHOLD ? parseFloat(process.env.CVD_SELL_THRESHOLD) : NaN;
        const envMaxSpreadVelocity = process.env.MAX_SPREAD_VELOCITY ? parseFloat(process.env.MAX_SPREAD_VELOCITY) : NaN;
        const envOrderQty = process.env.ORDER_QUANTITY ? parseFloat(process.env.ORDER_QUANTITY) : NaN;
        const envLeverage = process.env.LEVERAGE ? parseInt(process.env.LEVERAGE, 10) : NaN;
        const envMaxSpreadEth = process.env.MAX_SPREAD_ETH ? parseFloat(process.env.MAX_SPREAD_ETH) : NaN;
        const envMaxSpreadBtc = process.env.MAX_SPREAD_BTC ? parseFloat(process.env.MAX_SPREAD_BTC) : NaN;
        const envMinNotionalUsdt = process.env.MIN_NOTIONAL_USDT ? parseFloat(process.env.MIN_NOTIONAL_USDT) : NaN;
        const envCooldownMs = process.env.COOLDOWN_MS ? parseInt(process.env.COOLDOWN_MS, 10) : NaN;
        const envVpinThreshold = process.env.VPIN_THRESHOLD ? parseFloat(process.env.VPIN_THRESHOLD) : NaN;
        const envVpinBucketVolume = process.env.VPIN_BUCKET_VOLUME ? parseFloat(process.env.VPIN_BUCKET_VOLUME) : NaN;
        const defaultLongTp = !isNaN(envLongTp) ? envLongTp : 0.45;
        const defaultLongSl = !isNaN(envLongSl) ? envLongSl : 0.15;
        const defaultShortTp = !isNaN(envShortTp) ? envShortTp : 0.45;
        const defaultShortSl = !isNaN(envShortSl) ? envShortSl : 0.15;
        const defaultProfitLock = !isNaN(envProfitLock) ? envProfitLock : 10.0;
        const defaultMaxShortSlots = !isNaN(envMaxShortSlots) ? envMaxShortSlots : 3;
        const defaultMinAiConfidence = !isNaN(envMinAiConfidence) ? envMinAiConfidence : 0.65;
        const defaultAggressiveConfidence = !isNaN(envAggressiveConfidence) ? envAggressiveConfidence : 0.75;
        const defaultObiBuy = !isNaN(envObiBuy) ? envObiBuy : 0.35;
        const defaultObiSell = !isNaN(envObiSell) ? envObiSell : -0.35;
        const defaultCvdBuy = !isNaN(envCvdBuy) ? envCvdBuy : 0.0;
        const defaultCvdSell = !isNaN(envCvdSell) ? envCvdSell : 0.0;
        const defaultMaxSpreadVelocity = !isNaN(envMaxSpreadVelocity) ? envMaxSpreadVelocity : 5.0;
        const defaultMaxSpreadEth = !isNaN(envMaxSpreadEth) ? envMaxSpreadEth : 0.50;
        const defaultMaxSpreadBtc = !isNaN(envMaxSpreadBtc) ? envMaxSpreadBtc : 5.0;
        const defaultMinNotionalUsdt = !isNaN(envMinNotionalUsdt) ? envMinNotionalUsdt : 55.0;
        const defaultCooldownMs = !isNaN(envCooldownMs) ? envCooldownMs : 250;
        const defaultVpinThreshold = !isNaN(envVpinThreshold) ? envVpinThreshold : 0.85;
        const defaultVpinBucketVolume = !isNaN(envVpinBucketVolume) ? envVpinBucketVolume : 50000.0;
        const targetSymbol = config?.symbol ?? process.env.SYMBOL ?? "BTCUSDT";
        const defaultOrderQty = !isNaN(envOrderQty)
            ? envOrderQty
            : (targetSymbol.includes("ETH") ? 0.05 : 0.001);
        const defaultLeverage = !isNaN(envLeverage) ? envLeverage : 10;
        const envTradeSizeUsdt = process.env.TRADE_SIZE_USDT ? parseFloat(process.env.TRADE_SIZE_USDT) : NaN;
        const defaultTradeSizeUsdt = !isNaN(envTradeSizeUsdt) ? envTradeSizeUsdt : 60.0;
        this.config = {
            symbol: targetSymbol,
            orderQuantity: config?.orderQuantity ?? defaultOrderQty,
            tradeSizeUsdt: config?.tradeSizeUsdt ?? defaultTradeSizeUsdt,
            obiBuyThreshold: config?.obiBuyThreshold ?? defaultObiBuy,
            obiSellThreshold: config?.obiSellThreshold ?? defaultObiSell,
            cvdBuyThreshold: config?.cvdBuyThreshold ?? defaultCvdBuy,
            cvdSellThreshold: config?.cvdSellThreshold ?? defaultCvdSell,
            maxSpreadVelocity: config?.maxSpreadVelocity ?? defaultMaxSpreadVelocity,
            minAiConfidence: config?.minAiConfidence ?? defaultMinAiConfidence,
            aggressiveConfidenceThreshold: config?.aggressiveConfidenceThreshold ?? defaultAggressiveConfidence,
            tickSize: config?.tickSize ?? 0.1,
            takeProfitPercent: config?.takeProfitPercent ?? defaultLongTp,
            stopLossPercent: config?.stopLossPercent ?? defaultLongSl,
            longTakeProfitPercent: config?.longTakeProfitPercent ?? defaultLongTp,
            longStopLossPercent: config?.longStopLossPercent ?? defaultLongSl,
            shortTakeProfitPercent: config?.shortTakeProfitPercent ?? defaultShortTp,
            shortStopLossPercent: config?.shortStopLossPercent ?? defaultShortSl,
            dailyProfitLockUsdt: config?.dailyProfitLockUsdt ?? defaultProfitLock,
            maxShortSlots: config?.maxShortSlots ?? defaultMaxShortSlots,
            leverageMultiplier: config?.leverageMultiplier ?? defaultLeverage,
            maxSpreadEth: config?.maxSpreadEth ?? defaultMaxSpreadEth,
            maxSpreadBtc: config?.maxSpreadBtc ?? defaultMaxSpreadBtc,
            minNotionalUsdt: config?.minNotionalUsdt ?? defaultMinNotionalUsdt,
            cooldownMs: config?.cooldownMs ?? defaultCooldownMs,
            vpinThreshold: config?.vpinThreshold ?? defaultVpinThreshold,
            vpinBucketVolume: config?.vpinBucketVolume ?? defaultVpinBucketVolume,
        };
        this.dynamicRiskEngine = new dynamicRiskEngine_1.DynamicRiskEngine(this.config.vpinThreshold);
        if (typeof config?.assetIndex === "number" && config.assetIndex >= 0) {
            this.assetIndex = config.assetIndex;
        }
        else {
            const activeSymbols = (0, tradingSymbols_1.getTradingSymbols)();
            const symIdx = activeSymbols.indexOf(this.config.symbol);
            this.assetIndex = symIdx >= 0 ? symIdx : 0;
        }
        this.hedgeLedger = hedgeLedger ?? new positionLedger_1.HedgePositionLedger(this.config.symbol, this.config.maxShortSlots);
        this.positionLedger = positionLedger ?? this.hedgeLedger.getLegacyLedger();
        this.reusableOrderIntent = {
            symbol: this.config.symbol,
            side: "BUY",
            quantity: this.config.orderQuantity,
            price: 0,
        };
    }
    /**
     * Pure Zero-GC Mutator Method for reusableOrderIntent.
     * Enforces strict constructor-bound symbol invariance and resets all transient fields
     * across evaluation ticks to prevent cross-asset or cross-tick intent state pollution.
     */
    prepareOrderIntent(side, quantity, price, currentPositionSide, isCloseOrder, isHardStop, riskProfile, stopLossPrice, takeProfitPrice) {
        this.reusableOrderIntent.symbol = this.config.symbol;
        this.reusableOrderIntent.side = side;
        this.reusableOrderIntent.quantity = quantity;
        this.reusableOrderIntent.price = price;
        this.reusableOrderIntent.currentPositionSide = currentPositionSide;
        this.reusableOrderIntent.isCloseOrder = isCloseOrder;
        this.reusableOrderIntent.isHardStop = isHardStop ?? false;
        this.reusableOrderIntent.riskProfile = riskProfile;
        this.reusableOrderIntent.stopLossPrice = stopLossPrice;
        this.reusableOrderIntent.takeProfitPrice = takeProfitPrice;
        return this.reusableOrderIntent;
    }
    /**
     * Centralized fill lifecycle observer for both ENTRY and EXIT executions.
     * Enforces dual-tier cooldown synchronization across RiskGuard (software state)
     * and SharedArrayBuffer (zero-copy shared memory state).
     */
    onExecutionCompleted(params) {
        const fillTime = params.fillTimestampMs ?? Date.now();
        const notionalUsdt = params.executedQty * params.executedPrice;
        const cooldownExpiry = fillTime + this.config.cooldownMs;
        // 1. Tier 1: RiskGuard Software State & Realized PnL Synchronization
        if (this.riskGuard instanceof risk_1.MultiAssetRiskGuard) {
            this.riskGuard.recordExecutionSuccess(notionalUsdt, params.side, params.symbol, params.isCloseOrder);
        }
        else {
            this.riskGuard.recordExecutionSuccess(notionalUsdt, params.side, params.symbol, params.isCloseOrder);
        }
        if (params.realizedPnl && params.realizedPnl !== 0) {
            this.riskGuard.recordRealizedPnl(params.realizedPnl);
        }
        // 2. Tier 2: Atomic SharedArrayBuffer Cooldown Synchronization
        // Enforce post-trade execution cooldown per asset and side on SAB for both entries and exits
        if (params.positionSide === "LONG") {
            this.client.setLongCooldownLock(cooldownExpiry, params.assetIndex);
            this.client.setLastLongFillPrice(params.executedPrice, params.assetIndex);
        }
        else if (params.positionSide === "SHORT") {
            this.client.setShortCooldownLock(cooldownExpiry, params.assetIndex);
            this.client.setLastShortFillPrice(params.executedPrice, params.assetIndex);
        }
        console.log(`[COOLDOWN_SYNC][${params.isCloseOrder ? "EXIT" : "ENTRY"}] Completed ${params.positionSide} ${params.side} on ${params.symbol}. Qty: ${params.executedQty} @ $${params.executedPrice.toFixed(2)}. Cooldown active for ${this.config.cooldownMs}ms (until ${cooldownExpiry}). PnL: $${(params.realizedPnl ?? 0).toFixed(2)}`);
    }
    async initUserDataStream() {
        if (!this.executionClient.isConfigured())
            return false;
        this.userDataStream = new userDataStream_1.BinanceUserDataStream(this.executionClient);
        this.userDataStream.subscribeOrderUpdates((update) => {
            const { order } = update;
            if (order.orderStatus === "FILLED" || order.orderStatus === "PARTIALLY_FILLED") {
                if (order.orderType === "LIMIT" || order.isMaker) {
                    console.log(`[MAKER_TP_ENGINE][WS_FILL_NOTIFIED] OrderId #${order.orderId} filled as ${order.isMaker ? "MAKER" : "TAKER"}. Qty: ${order.lastFilledQuantity} @ $${order.lastFilledPrice}`);
                    const coreLong = this.hedgeLedger.getCoreLong();
                    const shortSlots = this.hedgeLedger.getShortSlots();
                    let targetSlotId = null;
                    let posSide = "LONG";
                    let entryPx = 0;
                    if (coreLong.isOccupied && coreLong.activeTpOrderIds?.includes(order.orderId)) {
                        targetSlotId = "CORE_LONG";
                        posSide = "LONG";
                        entryPx = coreLong.entryPrice;
                    }
                    else {
                        for (const s of shortSlots) {
                            if (s.isOccupied && s.activeTpOrderIds?.includes(order.orderId)) {
                                targetSlotId = s.slotId;
                                posSide = "SHORT";
                                entryPx = s.entryPrice;
                                break;
                            }
                        }
                    }
                    if (targetSlotId) {
                        const res = this.hedgeLedger.processTpLimitFill(targetSlotId, order.orderId, order.lastFilledQuantity, order.lastFilledPrice, order.isMaker);
                        console.log(`[MAKER_TP_ENGINE][RECONCILED] Slot ${targetSlotId} updated. Closed: ${res.isPositionClosed}, RemQty: ${res.remainingQuantity}, NewSL: $${res.newStopLossPrice}`);
                        let realizedPnl = 0;
                        if (entryPx > 0) {
                            const makerFee = this.hedgeLedger.getSizingCalculator().getMakerFeeRate();
                            const takerFee = this.hedgeLedger.getSizingCalculator().getTakerFeeRate();
                            const feeRate = order.isMaker ? makerFee : takerFee;
                            const grossPnl = posSide === "LONG"
                                ? (order.lastFilledPrice - entryPx) * order.lastFilledQuantity
                                : (entryPx - order.lastFilledPrice) * order.lastFilledQuantity;
                            const totalFees = (entryPx * order.lastFilledQuantity * takerFee) + (order.lastFilledPrice * order.lastFilledQuantity * feeRate);
                            realizedPnl = grossPnl - totalFees;
                        }
                        const fillSide = order.side;
                        this.onExecutionCompleted({
                            symbol: this.config.symbol,
                            assetIndex: this.assetIndex,
                            side: fillSide,
                            positionSide: posSide,
                            isCloseOrder: true,
                            executedQty: order.lastFilledQuantity,
                            executedPrice: order.lastFilledPrice,
                            realizedPnl,
                            fillTimestampMs: Date.now(),
                        });
                    }
                }
            }
        });
        return this.userDataStream.start();
    }
    async dispatchBatchPostOnlyTpOrders(slotId, entryPrice, quantity, side) {
        const isPostOnlyTpEnabled = process.env.ENABLE_POST_ONLY_TP !== "false";
        if (!isPostOnlyTpEnabled)
            return;
        const intents = this.hedgeLedger.generateBatchTpOrderIntents(slotId, entryPrice, quantity, side);
        if (intents.length === 0)
            return;
        console.log(`[MAKER_TP_ENGINE][DISPATCHING] Submitting ${intents.length} POST_ONLY limit TP orders for ${slotId} via batchOrders...`);
        try {
            const resList = await this.executionClient.placeBatchOrders(intents);
            if (Array.isArray(resList) && resList.length > 0) {
                const orderIds = resList
                    .map((r) => r.orderId)
                    .filter((id) => typeof id === "number" || typeof id === "string");
                this.hedgeLedger.registerActiveTpOrderIds(slotId, orderIds);
                console.log(`[MAKER_TP_ENGINE][SUCCESS] Registered ${orderIds.length} POST_ONLY TP limit order IDs on Binance orderbook: [${orderIds.join(", ")}]`);
            }
        }
        catch (err) {
            console.error(`[MAKER_TP_ENGINE][ERROR] Failed to submit batch POST_ONLY TP orders: ${err.message}`);
        }
    }
    getEngineState() {
        return this.state;
    }
    setEngineState(newState) {
        const oldState = this.state;
        this.state = newState;
        if (oldState !== newState) {
            console.log(`[ENGINE_STATE] State Transition: ${oldState} -> ${newState}`);
        }
    }
    getPositionLedger() {
        return this.positionLedger;
    }
    getHedgeLedger() {
        return this.hedgeLedger;
    }
    getActiveTrades(currentPrice = 0) {
        return this.hedgeLedger.getActiveTradeSlots(currentPrice, this.config.leverageMultiplier, this.config.longTakeProfitPercent, this.config.longStopLossPercent, this.config.shortTakeProfitPercent, this.config.shortStopLossPercent);
    }
    reconcileStartupPositions(rawPositions) {
        if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
            console.log(`[StrategyEngine][StateRecovery] No active positions returned from Binance REST API for ${this.config.symbol}.`);
            return;
        }
        const recovered = [];
        for (const pos of rawPositions) {
            if (pos.symbol !== this.config.symbol)
                continue;
            const amt = parseFloat(pos.positionAmt || "0");
            const entryPx = parseFloat(pos.entryPrice || "0");
            if (Math.abs(amt) <= 0 || entryPx <= 0)
                continue;
            const side = pos.positionSide === "LONG" || (pos.positionSide === "BOTH" && amt > 0) ? "LONG" : "SHORT";
            recovered.push({
                side,
                quantity: Math.abs(amt),
                entryPrice: entryPx,
            });
        }
        if (recovered.length > 0) {
            this.hedgeLedger.syncStartupPositions(recovered, this.config.longTakeProfitPercent, this.config.longStopLossPercent, this.config.shortTakeProfitPercent, this.config.shortStopLossPercent);
            console.log(`[StrategyEngine][StateRecovery] Successfully recovered ${recovered.length} open position(s) from Binance REST API for ${this.config.symbol}.`);
        }
        else {
            console.log(`[StrategyEngine][StateRecovery] Binance position state: FLAT (0.0000) for ${this.config.symbol}.`);
        }
    }
    /**
     * High-frequency tick evaluation loop.
     * Reads scalar metrics directly from SharedArrayBuffer via MarketDataClient getters.
     * Zero GC heap allocation when no trade signals are generated.
     */
    evaluateTick() {
        const seq = this.client.getSequenceNum(this.assetIndex);
        if (seq === this.lastProcessedSequence || this.isOrderInFlight) {
            this.staticResult.sequenceNum = seq;
            this.staticResult.signalType = "NONE";
            this.staticResult.riskResult = undefined;
            this.staticResult.executionPromise = undefined;
            return this.staticResult;
        }
        this.lastProcessedSequence = seq;
        // Read scalar metrics atomically from SAB
        const obi = this.client.getOBI(this.assetIndex);
        const cvd = this.client.getCVD(this.assetIndex);
        const spreadVelocity = this.client.getSpreadVelocity(this.assetIndex);
        const bidPrice = this.client.getBestBidPrice(this.assetIndex);
        const askPrice = this.client.getBestAskPrice(this.assetIndex);
        // Read AI predictions & latency metrics from SAB
        const aiDirection = this.client.getAIPredictionDirection(this.assetIndex);
        const aiConfidence = this.client.getAIPredictionConfidence(this.assetIndex);
        const aiDirectionMag = this.client.getAIDirectionMagnitude(this.assetIndex) || Math.abs(aiDirection);
        const latencyPenalty = this.client.getLatencyPenaltyCoefficient(this.assetIndex);
        const penaltyCoeff = latencyPenalty > 0 ? Math.max(0.75, latencyPenalty) : 1.0;
        const slippageTicks = this.client.getDynamicSlippageTicks(this.assetIndex);
        // 1. Dynamic Monitoring: Evaluate Unrealized PnL against dynamic TP/SL thresholds across Hedge Slots
        const markPrice = askPrice > 0 ? (askPrice + bidPrice) / 2 : bidPrice;
        // Sync active position state to SharedArrayBuffer for TUI Table telemetry
        if (markPrice > 0) {
            const summary = this.hedgeLedger.getSummary(markPrice);
            const netSignedQty = summary.side === "SHORT" ? -summary.netQuantity : summary.netQuantity;
            this.client.setOmsPositionQty(netSignedQty, this.assetIndex);
            this.client.setOmsAvgEntryPrice(summary.averageEntryPrice, this.assetIndex);
            this.client.setOmsRealizedPnl(summary.cumulativeRealizedPnl, this.assetIndex);
            this.client.setOmsUnrealizedPnl(summary.unrealizedPnl, this.assetIndex);
            this.client.setOmsLeverage(this.config.leverageMultiplier, this.assetIndex);
            this.client.setOmsTotalTrades(summary.totalTrades, this.assetIndex);
            this.client.setOmsWinningTrades(summary.winningTrades, this.assetIndex);
            this.client.setOmsLosingTrades(summary.losingTrades, this.assetIndex);
        }
        if (markPrice > 0) {
            const hedgeTriggers = this.hedgeLedger.evaluateHedgeDynamicTpSl(markPrice);
            if (hedgeTriggers.length > 0) {
                const trigger = hedgeTriggers[0];
                const exitSide = trigger.side === "LONG" ? "SELL" : "BUY";
                const isHardStopTrigger = trigger.reason === "STOP_LOSS" ||
                    trigger.reason === "BREAK_EVEN_STOP_LOSS" ||
                    trigger.reason === "LONG_HOLD_PROFIT_HARVEST" ||
                    trigger.reason === "TIME_DECAY_PROFIT_LOCK";
                console.log(`[HEDGE_DYNAMIC_MONITORING] Slot ${trigger.slotId} ${trigger.reason} TRIGGERED! Side: ${trigger.side}, Entry: $${trigger.entryPrice.toFixed(2)}, Mark: $${markPrice.toFixed(2)}. Dispatching MARKET close with positionSide: ${trigger.side}.${isHardStopTrigger ? " [RUTHLESS HARD STOP OVERRIDE ACTIVE]" : ""}`);
                this.prepareOrderIntent(exitSide, trigger.quantity, markPrice, trigger.side, true, isHardStopTrigger);
                const isConfigured = this.executionClient.isConfigured();
                const riskResult = (this.riskGuard instanceof risk_1.MultiAssetRiskGuard)
                    ? this.riskGuard.validateMultiAssetOrder(this.reusableOrderIntent, isConfigured)
                    : this.riskGuard.validateOrder(this.reusableOrderIntent, isConfigured, trigger.side);
                let executionPromise = undefined;
                if (riskResult.passed) {
                    this.isOrderInFlight = true;
                    executionPromise = (async () => {
                        if (trigger.cancelOrderIds && trigger.cancelOrderIds.length > 0) {
                            console.log(`[MAKER_TP_ENGINE][EMERGENCY_CANCEL] Cancelling ${trigger.cancelOrderIds.length} open POST_ONLY limit TP orders for ${trigger.slotId} before MARKET SL dispatch...`);
                            try {
                                await this.executionClient.cancelBatchOrders(this.config.symbol, trigger.cancelOrderIds);
                                console.log(`[MAKER_TP_ENGINE][EMERGENCY_CANCEL] Batch order cancellation confirmed by exchange.`);
                            }
                            catch (err) {
                                console.warn(`[MAKER_TP_ENGINE][CANCEL_WARN] Batch order cancellation warning: ${err.message}`);
                            }
                        }
                        return this.executionClient
                            .placeOrder({
                            symbol: this.config.symbol,
                            side: exitSide,
                            type: "MARKET",
                            quantity: trigger.quantity,
                            positionSide: trigger.side,
                        })
                            .then((res) => {
                            if (res) {
                                const execPx = parseFloat(res.price || res.avgPrice || "0") || markPrice;
                                const takerFeeRate = this.hedgeLedger.getSizingCalculator().getTakerFeeRate();
                                let realizedPnl = 0;
                                if (trigger.isPartialClose && trigger.quantity > 0) {
                                    if (trigger.side === "LONG") {
                                        const entryPx = this.hedgeLedger.getCoreLong().entryPrice;
                                        const closedQty = Math.min(this.hedgeLedger.getCoreLong().quantity, trigger.quantity);
                                        if (entryPx > 0) {
                                            const grossPnl = (execPx - entryPx) * closedQty;
                                            const fees = (entryPx * closedQty + execPx * closedQty) * takerFeeRate;
                                            realizedPnl = grossPnl - fees;
                                        }
                                        this.hedgeLedger.deductCoreLongQuantity(trigger.quantity, execPx, takerFeeRate, trigger.reason);
                                    }
                                    else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                                        const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                                        const slot = this.hedgeLedger.getShortSlots().find((s) => s.slotId === trigger.slotId);
                                        if (slot && slot.entryPrice > 0) {
                                            const entryPx = slot.entryPrice;
                                            const closedQty = Math.min(slot.quantity, trigger.quantity);
                                            const grossPnl = (entryPx - execPx) * closedQty;
                                            const fees = (entryPx * closedQty + execPx * closedQty) * takerFeeRate;
                                            realizedPnl = grossPnl - fees;
                                        }
                                        this.hedgeLedger.deductShortSlotQuantity(sIdx, trigger.quantity, execPx, takerFeeRate, trigger.reason);
                                    }
                                }
                                else if (!trigger.isPartialClose) {
                                    if (trigger.side === "LONG") {
                                        const coreLong = this.hedgeLedger.getCoreLong();
                                        if (coreLong.isOccupied && coreLong.entryPrice > 0) {
                                            const entryPx = coreLong.entryPrice;
                                            const qty = coreLong.quantity;
                                            const grossPnl = (execPx - entryPx) * qty;
                                            const fees = (entryPx * qty + execPx * qty) * takerFeeRate;
                                            realizedPnl = grossPnl - fees;
                                        }
                                        this.hedgeLedger.releaseCoreLong(execPx, takerFeeRate, trigger.reason);
                                    }
                                    else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                                        const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                                        const slot = this.hedgeLedger.getShortSlots().find((s) => s.slotId === trigger.slotId);
                                        if (slot && slot.isOccupied && slot.entryPrice > 0) {
                                            const entryPx = slot.entryPrice;
                                            const qty = slot.quantity;
                                            const grossPnl = (entryPx - execPx) * qty;
                                            const fees = (entryPx * qty + execPx * qty) * takerFeeRate;
                                            realizedPnl = grossPnl - fees;
                                        }
                                        this.hedgeLedger.releaseShortSlot(sIdx, execPx, takerFeeRate, trigger.reason);
                                    }
                                }
                                // Dual-tier cooldown & risk sync for dynamic MARKET exit executions
                                this.onExecutionCompleted({
                                    symbol: this.config.symbol,
                                    assetIndex: this.assetIndex,
                                    side: exitSide,
                                    positionSide: trigger.side,
                                    isCloseOrder: true,
                                    executedQty: trigger.quantity,
                                    executedPrice: execPx,
                                    realizedPnl,
                                    fillTimestampMs: Date.now(),
                                });
                            }
                            return res;
                        })
                            .catch((err) => {
                            console.error(`[DYNAMIC_MONITORING_ERROR] Hedge ${trigger.reason} MARKET order failed: ${err.message}`);
                            if (err.message &&
                                (err.message.includes("-2022") ||
                                    err.message.includes("ReduceOnly") ||
                                    err.message.includes("-2011") ||
                                    err.message.includes("not configured"))) {
                                console.warn(`[DYNAMIC_MONITORING_WARN] Clearing local slot ${trigger.slotId} due to exchange release/error: ${err.message}`);
                                if (trigger.side === "LONG") {
                                    this.hedgeLedger.releaseCoreLong();
                                }
                                else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                                    const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                                    this.hedgeLedger.releaseShortSlot(sIdx);
                                }
                            }
                            return null;
                        });
                    })().finally(() => {
                        this.isOrderInFlight = false;
                    });
                }
                return {
                    sequenceNum: seq,
                    signalType: exitSide,
                    positionSide: trigger.side,
                    slotId: trigger.slotId,
                    obi,
                    cvd,
                    spreadVelocity,
                    bidPrice,
                    askPrice,
                    riskResult,
                    executionPromise,
                    exitReason: trigger.reason,
                };
            }
        }
        // Safety Clamp: Suppress new signal generation when engine is in TRAINING_LOCK, RECALIBRATING, PAUSED or EMERGENCY_HALT state
        if (this.state === "TRAINING_LOCK" || this.state === "RECALIBRATING" || this.state === "PAUSED" || this.state === "EMERGENCY_HALT") {
            if (seq % 500n === 0n) {
                console.log(`[StrategyEngine][StateLock] Seq #${seq} | Engine locked in [${this.state}] state. Signal evaluation suppressed.`);
            }
            const reasonCode = this.state === "TRAINING_LOCK" ? "TRAINING_LOCK_ACTIVE" : this.state === "RECALIBRATING" ? "RECALIBRATING_ACTIVE" : "ENGINE_PAUSED";
            this.staticResult.sequenceNum = seq;
            this.staticResult.signalType = "NONE";
            this.staticResult.obi = obi;
            this.staticResult.cvd = cvd;
            this.staticResult.spreadVelocity = spreadVelocity;
            this.staticResult.bidPrice = bidPrice;
            this.staticResult.askPrice = askPrice;
            this.staticResult.riskResult = {
                passed: false,
                reasonCode,
                message: `Engine signal evaluation paused due to state: ${this.state}`,
            };
            this.staticResult.executionPromise = undefined;
            return this.staticResult;
        }
        let signalType = "NONE";
        let targetPosSide = undefined;
        let targetSlotId = undefined;
        let targetSlotIndex = undefined;
        // Auto-reconcile hedge ledger slots if local position ledger is flat
        if (this.positionLedger.getSide() === "FLAT" || this.positionLedger.getNetQuantity() === 0) {
            if (this.hedgeLedger.getCoreLong().isOccupied && (!this.hedgeLedger.getCoreLong().quantity || this.hedgeLedger.getCoreLong().quantity <= 0)) {
                this.hedgeLedger.releaseCoreLong();
            }
        }
        // Read Hawkes & Microburst Metrics from SAB
        const hawkesIntensity = this.client.getHawkesIntensity(this.assetIndex);
        const realizedVol = this.client.getRealizedVolatility(this.assetIndex);
        const rawShortCooldownLock = this.client.getShortCooldownLock(this.assetIndex);
        const rawLongCooldownLock = this.client.getLongCooldownLock(this.assetIndex);
        const hurstExponent = this.client.getHurstExponent(this.assetIndex);
        const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
        const nowMs = Date.now();
        // Defensive ceiling guard: if cooldown lock is set to a future timestamp > 60s, reset lock to 0
        const longCooldownLock = rawLongCooldownLock > nowMs + 60000 ? 0 : rawLongCooldownLock;
        const shortCooldownLock = rawShortCooldownLock > nowMs + 60000 ? 0 : rawShortCooldownLock;
        let targetSizeDecayCoeff = 1.0;
        // 50-25-25 Weighted Composite Signal Engine & High-Confidence AI Override
        const obiScore = Math.max(-1.0, Math.min(1.0, obi));
        const cvdScore = cvd > 0 ? 1.0 : cvd < 0 ? -1.0 : 0.0;
        const aiScore = Math.max(-1.0, Math.min(1.0, aiDirection * aiConfidence));
        // Regime-aware AI confidence threshold adaptation:
        // In strong trend regime (Hurst > 0.55), lower required minAiConfidence to 0.52 for fast momentum capture.
        let effectiveMinConfidence = this.config.minAiConfidence;
        if (hurstExponent > 0.55 && garmanKlassRV > 0.001) {
            effectiveMinConfidence = Math.max(0.50, this.config.minAiConfidence - 0.15);
        }
        // Weights: AI Model = 50% (0.50), OBI = 25% (0.25), CVD = 25% (0.25)
        const compositeScore = 0.50 * aiScore + 0.25 * obiScore + 0.25 * cvdScore;
        const isHighConfidenceAi = aiConfidence >= this.config.aggressiveConfidenceThreshold;
        let isBuySignal = false;
        let isSellSignal = false;
        // SOTA Dynamic Volatility-Normalized Conviction Floor Gate (K_conviction)
        // Eradicates static 0.15 floor. Uses Garman-Klass volatility, Bid-Ask Half-Spread, and Hawkes Intensity.
        const midPrice = askPrice > 0 && bidPrice > 0 ? (bidPrice + askPrice) / 2.0 : 1.0;
        const halfSpreadBps = midPrice > 0 ? ((askPrice - bidPrice) / (2.0 * midPrice)) : 0.0001;
        const volEstimate = garmanKlassRV > 0.000001 ? Math.sqrt(garmanKlassRV) : 0.005;
        const hawkesMultiplier = 1.0 + 0.2 * Math.log(1.0 + Math.max(0, hawkesIntensity));
        // Dynamic Conviction Floor: K_conviction(t)
        const dynamicConvictionFloor = Math.max(halfSpreadBps, 0.5 * volEstimate * hawkesMultiplier);
        // Volatility-Standardized Z-Score of the signal
        const zScore = aiDirectionMag / Math.max(volEstimate, 0.0001);
        // Dynamic Conviction Authorization: Require BOTH dynamicConvictionFloor AND Z-Score >= 1.5
        const minZScoreThreshold = 1.5;
        const isConvictionValid = aiDirectionMag >= dynamicConvictionFloor && zScore >= minZScoreThreshold;
        if (isConvictionValid) {
            if (isHighConfidenceAi) {
                // AI-Override Rule: High-confidence AI must also satisfy strict OBI directional pressure threshold (+/- 0.35)
                isBuySignal = aiDirection > 0 && obi >= this.config.obiBuyThreshold;
                isSellSignal = aiDirection < 0 && obi <= this.config.obiSellThreshold;
                if (isBuySignal || isSellSignal) {
                    console.log(`[StrategyEngine][HIGH_CONFIDENCE] Seq #${seq} | Dir: ${aiDirection.toFixed(4)} (Mag: ${aiDirectionMag.toFixed(4)}), Conf: ${(aiConfidence * 100).toFixed(1)}%, OBI: ${obi.toFixed(4)}, BuySignal: ${isBuySignal}, SellSignal: ${isSellSignal}`);
                }
            }
            else {
                // Weighted Composite Rule with dynamic effective confidence thresholding
                isBuySignal = compositeScore > 0.12 && aiConfidence >= effectiveMinConfidence && obi >= this.config.obiBuyThreshold;
                isSellSignal = compositeScore < -0.12 && aiConfidence >= effectiveMinConfidence && obi <= this.config.obiSellThreshold;
            }
        }
        else if (seq % 1000n === 0n) {
            console.log(`[StrategyEngine][CONVICTION_FLOOR_GATE] Seq #${seq} | Dir: ${aiDirection.toFixed(4)} (Mag: ${aiDirectionMag.toFixed(4)} < DynamicFloor: ${dynamicConvictionFloor.toFixed(4)}, Z-Score: ${zScore.toFixed(2)} < 1.5) -> Signals Filtered`);
        }
        // BUY -> Core Long Entry (allowed if Core Long is FLAT & temporal cooldown expired)
        const isCoreLongOccupied = this.hedgeLedger.getCoreLong().isOccupied;
        const isCooldownCleared = nowMs >= longCooldownLock;
        if (!isCoreLongOccupied && !isCooldownCleared) {
            console.log(`[StrategyEngine][COOLDOWN_BLOCK] Seq #${seq} | nowMs: ${nowMs}, longCooldownLock: ${longCooldownLock}, diff: ${longCooldownLock - nowMs}ms`);
        }
        if (isBuySignal &&
            (isHighConfidenceAi || spreadVelocity < this.config.maxSpreadVelocity) &&
            askPrice > 0 &&
            !isCoreLongOccupied &&
            isCooldownCleared) {
            signalType = "BUY";
            targetPosSide = "LONG";
            targetSlotId = "CORE_LONG";
        }
        // SELL -> Short Slot Entry (Evaluated via Tier-1 Dynamic Slot Dispersion Engine)
        else if (isSellSignal &&
            (isHighConfidenceAi || spreadVelocity < this.config.maxSpreadVelocity) &&
            bidPrice > 0) {
            const slotEval = this.hedgeLedger.evaluateDispersedShortSlotAllocation(bidPrice, this.config.tickSize, realizedVol, hawkesIntensity, shortCooldownLock, nowMs);
            if (slotEval !== null) {
                signalType = "SELL";
                targetPosSide = "SHORT";
                targetSlotIndex = slotEval.slotIndex;
                targetSlotId = `SHORT_SLOT_${slotEval.slotIndex}`;
                targetSizeDecayCoeff = slotEval.sizeDecayCoeff;
            }
        }
        if (signalType === "NONE") {
            this.client.setFinalizedSignal(0.0, this.assetIndex);
            if (seq % 500n === 0n) {
                console.log(`[StrategyEngine][SignalGate] Seq #${seq} | Composite: ${compositeScore.toFixed(4)} | AI: (dir=${aiDirection.toFixed(2)}, conf=${(aiConfidence * 100).toFixed(0)}%) | OBI: ${obi.toFixed(2)} | CVD: ${cvd.toFixed(0)} | Status: NO SIGNAL TRIGGERED`);
            }
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
        // Dynamic Taker Fallback (>75% Confidence) & 1-Tick Post-Only Offset (<=75%)
        const effectiveSlippage = Math.max(2, slippageTicks);
        const priceAdjustment = effectiveSlippage * this.config.tickSize;
        const basePrice = signalType === "BUY" ? askPrice : bidPrice;
        // 100% SOTA Maker-Dominant Execution Architecture (POST_ONLY GTX Order Routing)
        // Completely eradicates MARKET/IOC taker fee dispatches for entry signals.
        // Forces limit orders directly on the order book at best bid (BUY) and best ask (SELL), guaranteeing zero spread loss & Maker fee execution.
        let orderType = "LIMIT";
        const timeInForce = "GTX";
        let targetPrice = signalType === "BUY" ? bidPrice : askPrice;
        // Dynamic .env driven USDT Sizing & LOT_SIZE Precision Rounding (Unlocks All 10 Assets)
        let finalQuantity = 0.001;
        if (basePrice > 0) {
            const targetNotionalUsdt = this.config.tradeSizeUsdt > 0 ? this.config.tradeSizeUsdt : 60.0;
            const rawQty = (targetNotionalUsdt / basePrice) * penaltyCoeff * targetSizeDecayCoeff;
            finalQuantity = formatQuantityForSymbol(this.config.symbol, rawQty, false);
            // Binance Futures Min Notional Guard: ensure order notional >= effectiveMinNotional using conservative price
            const symbolRule = symbolPrecision_1.SymbolPrecisionRegistry.getPrecisionRule(this.config.symbol);
            const effectiveMinNotional = Math.max(this.config.minNotionalUsdt, symbolRule.minNotional);
            const effectivePrice = Math.min(basePrice, targetPrice);
            if (effectivePrice > 0 && finalQuantity * effectivePrice < effectiveMinNotional) {
                const requiredQty = effectiveMinNotional / effectivePrice;
                finalQuantity = formatQuantityForSymbol(this.config.symbol, requiredQty, true);
            }
        }
        // SPREAD GUARD: Explicitly block MARKET executions if spread is invalid or exceeds configured max threshold
        const isTickValid = askPrice > 0 && bidPrice > 0 && askPrice >= bidPrice;
        const currentSpread = isTickValid ? askPrice - bidPrice : Infinity;
        const maxSpreadAllowed = this.config.symbol.includes("ETH") ? this.config.maxSpreadEth : this.config.maxSpreadBtc;
        if (orderType === "MARKET" &&
            currentSpread > maxSpreadAllowed &&
            !this.reusableOrderIntent.isCloseOrder &&
            !this.reusableOrderIntent.isHardStop) {
            this.client.setFinalizedSignal(0.0, this.assetIndex);
            const reasonCode = !isTickValid ? "INVALID_TICK_DATA" : "REJECTED_LIQUIDITY_SWEEP_TRAP";
            const message = !isTickValid
                ? `Market execution blocked: invalid tick prices (bid: ${bidPrice}, ask: ${askPrice})`
                : `Market execution blocked: current spread (${currentSpread.toFixed(2)} USDT) > ${maxSpreadAllowed.toFixed(2)} USDT threshold`;
            console.log(`[StrategyEngine][SPREAD_GUARD_BLOCK] Seq #${seq} | ${message}`);
            this.staticResult.sequenceNum = seq;
            this.staticResult.signalType = "NONE";
            this.staticResult.obi = obi;
            this.staticResult.cvd = cvd;
            this.staticResult.spreadVelocity = spreadVelocity;
            this.staticResult.bidPrice = bidPrice;
            this.staticResult.askPrice = askPrice;
            this.staticResult.riskResult = {
                passed: false,
                reasonCode,
                message,
            };
            this.staticResult.executionPromise = undefined;
            return this.staticResult;
        }
        // Avellaneda-Stoikov Inventory Shift: Skew sell target higher for deeper short slots
        if (signalType === "SELL" && targetSlotIndex !== undefined && targetSlotIndex > 0) {
            targetPrice = targetPrice + targetSlotIndex * 2.0 * this.config.tickSize;
        }
        // Evaluate Dynamic Risk & Microstructure Trap Avoidance Profile
        const microMetrics = {
            obi,
            cvd,
            rvGk: this.client.getGarmanKlassRV(this.assetIndex),
            vpin: this.client.getVPIN(this.assetIndex),
            hurst: this.client.getHurstExponent(this.assetIndex),
            lobEntropy: this.client.getLOBEntropy(this.assetIndex),
            regime: this.client.getRegimeStateCode(this.assetIndex),
            isSweepDetected: this.client.getIsSweepDetected(this.assetIndex),
        };
        const riskProfile = this.dynamicRiskEngine.evaluateDynamicRisk(targetPrice, targetPosSide === "LONG" ? "LONG" : "SHORT", microMetrics, Math.abs(askPrice - bidPrice));
        riskProfile.isHighConfidenceAi = isHighConfidenceAi;
        riskProfile.aiConfidence = aiConfidence;
        // Populate pre-allocated intent via Zero-GC Mutator
        this.prepareOrderIntent(signalType, finalQuantity, symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.config.symbol, targetPrice), targetPosSide, false, false, riskProfile, symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.config.symbol, riskProfile.stopLossPrice), symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.config.symbol, riskProfile.takeProfitPrice));
        // Pass through Risk Management Guard with target position side
        const isConfigured = this.executionClient.isConfigured();
        const riskResult = (this.riskGuard instanceof risk_1.MultiAssetRiskGuard)
            ? this.riskGuard.validateMultiAssetOrder(this.reusableOrderIntent, isConfigured)
            : this.riskGuard.validateOrder(this.reusableOrderIntent, isConfigured, targetPosSide);
        if (!riskResult.passed) {
            this.client.setFinalizedSignal(0.0, this.assetIndex);
            if (seq % 1000n === 0n) {
                console.log(`[StrategyEngine][RISK_REJECTED] Seq #${seq} | Reason: ${riskResult.reasonCode} - ${riskResult.message}`);
            }
        }
        else {
            const sigVal = signalType === "BUY" ? 1.0 : signalType === "SELL" ? 2.0 : 0.0;
            this.client.setFinalizedSignal(sigVal, this.assetIndex);
        }
        let executionPromise = undefined;
        if (riskResult.passed) {
            this.isOrderInFlight = true;
            // Set atomic SAB hysteresis lockout (cooldown per side) to suppress microburst sweeps
            if (targetPosSide === "SHORT") {
                this.client.setShortCooldownLock(Date.now() + this.config.cooldownMs, this.assetIndex);
                this.client.setLastShortFillPrice(this.reusableOrderIntent.price, this.assetIndex);
            }
            else if (targetPosSide === "LONG") {
                this.client.setLongCooldownLock(Date.now() + this.config.cooldownMs, this.assetIndex);
                this.client.setLastLongFillPrice(this.reusableOrderIntent.price, this.assetIndex);
            }
            const notional = this.reusableOrderIntent.price * this.reusableOrderIntent.quantity;
            console.log(`[BinanceExecution][DISPATCHING] Submitting ${orderType} ${this.reusableOrderIntent.side} order for ${this.reusableOrderIntent.quantity} ${this.reusableOrderIntent.symbol} to Binance Futures...`);
            const orderParams = {
                symbol: this.reusableOrderIntent.symbol,
                side: this.reusableOrderIntent.side,
                type: orderType,
                quantity: this.reusableOrderIntent.quantity,
                positionSide: targetPosSide,
            };
            if (orderType === "LIMIT") {
                orderParams.price = this.reusableOrderIntent.price;
                orderParams.timeInForce = timeInForce;
            }
            executionPromise = this.executionClient
                .placeOrder(orderParams)
                .then((res) => {
                if (res) {
                    const execPx = parseFloat(res.price || res.avgPrice || "0") || targetPrice;
                    this.onExecutionCompleted({
                        symbol: this.config.symbol,
                        assetIndex: this.assetIndex,
                        side: res.side,
                        positionSide: targetPosSide,
                        isCloseOrder: false,
                        executedQty: finalQuantity,
                        executedPrice: execPx,
                        fillTimestampMs: Date.now(),
                    });
                    console.log(`[BinanceExecution][SUCCESS] Order Executed on Binance! OrderId: ${res.orderId}, Status: ${res.status}, ExecQty: ${res.executedQty}`);
                    if (targetPosSide === "LONG") {
                        this.hedgeLedger.occupyCoreLong(finalQuantity, execPx, this.config.longTakeProfitPercent, this.config.longStopLossPercent);
                        this.dispatchBatchPostOnlyTpOrders("CORE_LONG", execPx, finalQuantity, "LONG");
                    }
                    else if (targetPosSide === "SHORT" && targetSlotIndex !== undefined) {
                        const slotId = `SHORT_SLOT_${targetSlotIndex}`;
                        this.hedgeLedger.occupyShortSlot(targetSlotIndex, finalQuantity, execPx, this.config.shortTakeProfitPercent, this.config.shortStopLossPercent);
                        this.dispatchBatchPostOnlyTpOrders(slotId, execPx, finalQuantity, "SHORT");
                    }
                }
                return res;
            })
                .catch((err) => {
                console.error(`[BinanceExecution][REJECTED] Order Placement Failed: ${err.message}`);
                return null;
            })
                .finally(() => {
                this.isOrderInFlight = false;
            });
        }
        return {
            sequenceNum: seq,
            signalType,
            positionSide: targetPosSide,
            slotId: targetSlotId,
            targetSlotIndex,
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
var multiEngine_1 = require("./multiEngine");
Object.defineProperty(exports, "MultiAssetStrategyEngine", { enumerable: true, get: function () { return multiEngine_1.MultiAssetStrategyEngine; } });
