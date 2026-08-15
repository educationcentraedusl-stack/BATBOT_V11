"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAssetStrategyEngine = exports.StrategyEngine = void 0;
exports.getSymbolQuantityPrecision = getSymbolQuantityPrecision;
exports.formatQuantityForSymbol = formatQuantityForSymbol;
const risk_1 = require("./risk");
const positionLedger_1 = require("./positionLedger");
const dynamicRiskEngine_1 = require("./dynamicRiskEngine");
const microstructureHazardEngine_1 = require("./microstructureHazardEngine");
const volatilitySurfaceEngine_1 = require("./volatilitySurfaceEngine");
const hjbReservationEngine_1 = require("./hjbReservationEngine");
const userDataStream_1 = require("../execution/userDataStream");
const symbolPrecision_1 = require("../config/symbolPrecision");
const tradingSymbols_1 = require("../config/tradingSymbols");
const recalibrationWorker_1 = require("../ai/recalibrationWorker");
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
    hazardEngine;
    hjbEngine;
    volEngine;
    userDataStream = null;
    lastProcessedSequence = -1n;
    state = "LIVE_ACTIVE";
    assetIndex = 0;
    isOrderInFlight = false;
    slSyncLocks = new Set();
    pendingSlSyncTargets = new Map();
    pendingEntryOrders = new Map();
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
        const envMaxSpreadAlt = process.env.MAX_SPREAD_ALT ? parseFloat(process.env.MAX_SPREAD_ALT) : NaN;
        const envMinNotionalUsdt = process.env.MIN_NOTIONAL_USDT ? parseFloat(process.env.MIN_NOTIONAL_USDT) : NaN;
        const envCooldownMs = process.env.COOLDOWN_MS ? parseInt(process.env.COOLDOWN_MS, 10) : NaN;
        const envVpinThreshold = process.env.VPIN_THRESHOLD ? parseFloat(process.env.VPIN_THRESHOLD) : NaN;
        const envVpinBucketVolume = process.env.VPIN_BUCKET_VOLUME ? parseFloat(process.env.VPIN_BUCKET_VOLUME) : NaN;
        const defaultLongTp = !isNaN(envLongTp) ? envLongTp : 1.0;
        const defaultLongSl = !isNaN(envLongSl) ? envLongSl : 0.50;
        const defaultShortTp = !isNaN(envShortTp) ? envShortTp : 1.0;
        const defaultShortSl = !isNaN(envShortSl) ? envShortSl : 0.50;
        const defaultProfitLock = !isNaN(envProfitLock) ? envProfitLock : 10.0;
        const defaultMaxShortSlots = !isNaN(envMaxShortSlots) ? envMaxShortSlots : 3;
        const defaultMinAiConfidence = !isNaN(envMinAiConfidence) ? envMinAiConfidence : 0.653;
        const defaultAggressiveConfidence = !isNaN(envAggressiveConfidence) ? envAggressiveConfidence : 0.750;
        const defaultObiBuy = !isNaN(envObiBuy) ? envObiBuy : 0.35;
        const defaultObiSell = !isNaN(envObiSell) ? envObiSell : -0.35;
        const defaultCvdBuy = !isNaN(envCvdBuy) ? envCvdBuy : 0.0;
        const defaultCvdSell = !isNaN(envCvdSell) ? envCvdSell : 0.0;
        const defaultMaxSpreadVelocity = !isNaN(envMaxSpreadVelocity) ? envMaxSpreadVelocity : 5.0;
        const defaultMaxSpreadEth = !isNaN(envMaxSpreadEth) ? envMaxSpreadEth : 0.50;
        const defaultMaxSpreadBtc = !isNaN(envMaxSpreadBtc) ? envMaxSpreadBtc : 50.0;
        const defaultMaxSpreadAlt = !isNaN(envMaxSpreadAlt) ? envMaxSpreadAlt : 1.0;
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
            maxSpreadAlt: config?.maxSpreadAlt ?? defaultMaxSpreadAlt,
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
        this.hazardEngine = new microstructureHazardEngine_1.MicrostructureHazardEngine(this.config.symbol);
        this.hjbEngine = new hjbReservationEngine_1.HJBReservationEngine(this.config.symbol);
        this.volEngine = new volatilitySurfaceEngine_1.VolatilitySurfaceEngine(this.config.symbol);
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
    syncSabPositionState(currentMarkPrice = 0) {
        const summary = this.hedgeLedger.getSummary(currentMarkPrice);
        const sideCode = summary.side === "BOTH" ? 3.0 : summary.side === "LONG" ? 1.0 : summary.side === "SHORT" ? 2.0 : 0.0;
        this.client.setOmsPositionQty(summary.netQuantity, this.assetIndex);
        this.client.setOmsPositionSide(sideCode, this.assetIndex);
        this.client.setOmsLongPositionQty(summary.longQuantity, this.assetIndex);
        this.client.setOmsShortPositionQty(summary.shortQuantity, this.assetIndex);
        this.client.setOmsAvgEntryPrice(summary.averageEntryPrice, this.assetIndex);
        this.client.setOmsLongAvgEntryPrice(summary.longAverageEntryPrice, this.assetIndex);
        this.client.setOmsShortAvgEntryPrice(summary.shortAverageEntryPrice, this.assetIndex);
        this.client.setOmsLongUnrealizedPnl(summary.longUnrealizedPnl, this.assetIndex);
        this.client.setOmsShortUnrealizedPnl(summary.shortUnrealizedPnl, this.assetIndex);
        this.client.setOmsRealizedPnl(summary.cumulativeRealizedPnl, this.assetIndex);
        this.client.setOmsUnrealizedPnl(summary.unrealizedPnl, this.assetIndex);
        this.client.setOmsLeverage(this.config.leverageMultiplier, this.assetIndex);
        this.client.setOmsTotalTrades(summary.totalTrades, this.assetIndex);
        this.client.setOmsWinningTrades(summary.winningTrades, this.assetIndex);
        this.client.setOmsLosingTrades(summary.losingTrades, this.assetIndex);
    }
    setLeverageMultiplier(leverage) {
        if (Number.isFinite(leverage) && leverage > 0) {
            this.config.leverageMultiplier = leverage;
            this.positionLedger.setLeverage(leverage);
            this.hedgeLedger.setLeverage(leverage);
            this.client.setOmsLeverage(leverage, this.assetIndex);
        }
    }
    getLeverageMultiplier() {
        return this.config.leverageMultiplier;
    }
    hasPendingEntryForSlot(slotId) {
        for (const pending of this.pendingEntryOrders.values()) {
            if (pending.slotId === slotId) {
                return true;
            }
        }
        return false;
    }
    clearPendingEntryOrders() {
        for (const pending of this.pendingEntryOrders.values()) {
            if (pending.timeoutTimer) {
                clearTimeout(pending.timeoutTimer);
            }
        }
        this.pendingEntryOrders.clear();
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
        // 3. Tier 3: Immediate Zero-Latency SAB Position State Sync
        this.syncSabPositionState(0);
        console.log(`[COOLDOWN_SYNC][${params.isCloseOrder ? "EXIT" : "ENTRY"}] Completed ${params.positionSide} ${params.side} on ${params.symbol}. Qty: ${params.executedQty} @ $${params.executedPrice.toFixed(2)}. Cooldown active for ${this.config.cooldownMs}ms (until ${cooldownExpiry}). PnL: $${(params.realizedPnl ?? 0).toFixed(2)}`);
    }
    async initUserDataStream() {
        if (!this.executionClient.isConfigured())
            return false;
        this.userDataStream = new userDataStream_1.BinanceUserDataStream(this.executionClient);
        this.userDataStream.subscribeOrderUpdates((update) => {
            this.handleWsOrderUpdate(update);
        });
        this.userDataStream.subscribeAccountUpdates((accUpdate) => {
            for (const pos of accUpdate.positions) {
                if (pos.symbol === this.config.symbol) {
                    this.handleWsAccountPositionUpdate(pos);
                }
            }
        });
        return this.userDataStream.start();
    }
    handleConfirmedEntryFill(orderId, slotId, posSide, slotIndex, execQty, execPx) {
        const pending = this.pendingEntryOrders.get(orderId);
        if (pending?.timeoutTimer) {
            clearTimeout(pending.timeoutTimer);
        }
        this.pendingEntryOrders.delete(orderId);
        const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
        const volEstimate = garmanKlassRV > 0.000001 ? Math.sqrt(garmanKlassRV) : 0.005;
        const dynamicSlPct = Math.max(0.005, volEstimate * 2.0);
        const dynamicSlPercent = dynamicSlPct * 100;
        if (posSide === "LONG") {
            this.hedgeLedger.occupyCoreLong(execQty, execPx, this.config.longTakeProfitPercent, dynamicSlPercent);
            const slot = this.hedgeLedger.getCoreLong();
            this.dispatchBatchPostOnlyTpOrders("CORE_LONG", execPx, execQty, "LONG").catch((err) => {
                console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
            });
            this.dispatchExchangeStopLossOrder("CORE_LONG", execPx, execQty, "LONG", slot.stopLossPrice).catch((err) => {
                console.error(`[EXCHANGE_SL_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
            });
        }
        else if (posSide === "SHORT") {
            const targetIdx = slotIndex !== undefined ? slotIndex : (this.hedgeLedger.getAvailableShortSlotIndex() >= 0 ? this.hedgeLedger.getAvailableShortSlotIndex() : 0);
            const targetSlotId = `SHORT_SLOT_${targetIdx}`;
            this.hedgeLedger.occupyShortSlot(targetIdx, execQty, execPx, this.config.shortTakeProfitPercent, dynamicSlPercent);
            const slot = this.hedgeLedger.getShortSlots()[targetIdx];
            this.dispatchBatchPostOnlyTpOrders(targetSlotId, execPx, execQty, "SHORT").catch((err) => {
                console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
            });
            if (slot) {
                this.dispatchExchangeStopLossOrder(targetSlotId, execPx, execQty, "SHORT", slot.stopLossPrice).catch((err) => {
                    console.error(`[EXCHANGE_SL_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
                });
            }
        }
        this.onExecutionCompleted({
            symbol: this.config.symbol,
            assetIndex: this.assetIndex,
            side: posSide === "LONG" ? "BUY" : "SELL",
            positionSide: posSide,
            isCloseOrder: false,
            executedQty: execQty,
            executedPrice: execPx,
            fillTimestampMs: Date.now(),
        });
        this.syncSabPositionState();
    }
    handleWsAccountPositionUpdate(posUpdate) {
        if (posUpdate.symbol !== this.config.symbol)
            return;
        const amt = posUpdate.positionAmt;
        const entryPx = posUpdate.entryPrice;
        const summary = this.hedgeLedger.getSummary();
        const absQty = Math.abs(amt);
        if (absQty === 0) {
            if ((posUpdate.positionSide === "LONG" || posUpdate.positionSide === "BOTH") && summary.longQuantity > 1e-6) {
                console.log(`[BinanceExecution][WS_ACCOUNT_UPDATE] Exchange LONG position FLAT for ${this.config.symbol}. Clearing local coreLong slot.`);
                this.hedgeLedger.releaseCoreLong();
                this.syncSabPositionState(0);
            }
            if ((posUpdate.positionSide === "SHORT" || posUpdate.positionSide === "BOTH") && summary.shortQuantity > 1e-6) {
                console.log(`[BinanceExecution][WS_ACCOUNT_UPDATE] Exchange SHORT position FLAT for ${this.config.symbol}. Clearing local shortSlots.`);
                for (let i = 0; i < this.config.maxShortSlots; i++) {
                    this.hedgeLedger.releaseShortSlot(i);
                }
                this.syncSabPositionState(0);
            }
        }
        else if (absQty > 0 && entryPx > 0) {
            const targetSide = posUpdate.positionSide === "LONG" || (posUpdate.positionSide === "BOTH" && amt > 0) ? "LONG" : "SHORT";
            const isTracked = (targetSide === "LONG" && Math.abs(summary.longQuantity - absQty) < 1e-5) ||
                (targetSide === "SHORT" && Math.abs(summary.shortQuantity - absQty) < 1e-5);
            if (!isTracked) {
                console.warn(`[BinanceExecution][WS_ACCOUNT_UPDATE_DESYNC] Reconciling active ${targetSide} position for ${this.config.symbol}: ${absQty} @ $${entryPx}`);
                if (targetSide === "LONG") {
                    this.hedgeLedger.occupyCoreLong(absQty, entryPx, this.config.longTakeProfitPercent, this.config.longStopLossPercent);
                    if (posUpdate.positionSide === "BOTH") {
                        for (let i = 0; i < this.config.maxShortSlots; i++) {
                            this.hedgeLedger.releaseShortSlot(i);
                        }
                    }
                }
                else {
                    const availIdx = this.hedgeLedger.getAvailableShortSlotIndex();
                    const slotIdx = availIdx >= 0 ? availIdx : 0;
                    this.hedgeLedger.occupyShortSlot(slotIdx, absQty, entryPx, this.config.shortTakeProfitPercent, this.config.shortStopLossPercent);
                    if (posUpdate.positionSide === "BOTH") {
                        this.hedgeLedger.releaseCoreLong();
                    }
                }
                this.syncSabPositionState(0);
            }
        }
    }
    handleWsOrderUpdate(update) {
        const { order } = update;
        if (order.symbol !== this.config.symbol)
            return; // Strict asset symbol filter for zero cross-asset state pollution
        const orderId = order.orderId;
        if (order.orderStatus === "FILLED" || order.orderStatus === "PARTIALLY_FILLED") {
            // 1. Check if this is a pending ENTRY order confirmation from Binance
            if (this.pendingEntryOrders.has(orderId)) {
                const pending = this.pendingEntryOrders.get(orderId);
                const execPx = order.lastFilledPrice > 0 ? order.lastFilledPrice : (order.averagePrice > 0 ? order.averagePrice : pending.targetPrice);
                const execQty = order.cumulativeFilledQuantity > 0 ? order.cumulativeFilledQuantity : (order.lastFilledQuantity > 0 ? order.lastFilledQuantity : pending.qty);
                console.log(`[BinanceExecution][WS_ENTRY_FILL_CONFIRMED] OrderId #${orderId} FILLED on Binance! Occupying local slot ${pending.slotId}. Qty: ${execQty} @ $${execPx}`);
                this.handleConfirmedEntryFill(orderId, pending.slotId, pending.posSide, pending.slotIndex, execQty, execPx);
                return;
            }
            // 2. Check if this is a TP limit order fill or exit order fill
            if (order.orderType === "LIMIT" || order.isMaker) {
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
                    console.log(`[MAKER_TP_ENGINE][WS_FILL_NOTIFIED] OrderId #${order.orderId} filled as ${order.isMaker ? "MAKER" : "TAKER"}. Qty: ${order.lastFilledQuantity} @ $${order.lastFilledPrice}`);
                    const res = this.hedgeLedger.processTpLimitFill(targetSlotId, order.orderId, order.lastFilledQuantity, order.lastFilledPrice, order.isMaker);
                    console.log(`[MAKER_TP_ENGINE][RECONCILED] Slot ${targetSlotId} updated. Closed: ${res.isPositionClosed}, RemQty: ${res.remainingQuantity}, NewSL: $${res.newStopLossPrice}`);
                    if (res.isPositionClosed) {
                        const slId = this.hedgeLedger.getActiveStopLossOrderId(targetSlotId);
                        if (slId) {
                            this.executionClient.cancelOrder(this.config.symbol, slId).catch((err) => {
                                console.warn(`[EXCHANGE_SL_ENGINE][CANCEL_WARN] Unable to cancel resting SL on position close #${slId}: ${err.message}`);
                            });
                            this.hedgeLedger.registerActiveStopLossOrderId(targetSlotId, 0);
                        }
                    }
                    else if (res.remainingQuantity > 0 && res.newStopLossPrice > 0) {
                        this.syncExchangeStopLossOrder(targetSlotId, res.remainingQuantity, posSide, res.newStopLossPrice).catch((err) => {
                            console.error(`[EXCHANGE_SL_ENGINE][RATCHET_ERR] ${err?.message || String(err)}`);
                        });
                    }
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
                    this.syncSabPositionState();
                    return;
                }
            }
            // 3. Fallback: Untracked WebSocket fill classification & execution
            const activeSummary = this.hedgeLedger.getSummary();
            const rawPosSide = order.positionSide;
            let isExitSide = false;
            let isEntrySide = false;
            let targetPosSide = "LONG";
            if (rawPosSide === "LONG") {
                if (order.side === "BUY") {
                    isEntrySide = true;
                    targetPosSide = "LONG";
                }
                else {
                    isExitSide = true;
                    targetPosSide = "LONG";
                }
            }
            else if (rawPosSide === "SHORT") {
                if (order.side === "SELL") {
                    isEntrySide = true;
                    targetPosSide = "SHORT";
                }
                else {
                    isExitSide = true;
                    targetPosSide = "SHORT";
                }
            }
            else {
                // Both or Undefined (One-Way Mode or missing positionSide WS attribute)
                const isReduce = order.reduceOnly === true;
                if (isReduce) {
                    if (order.side === "SELL") {
                        isExitSide = true;
                        targetPosSide = "LONG";
                    }
                    else {
                        isExitSide = true;
                        targetPosSide = "SHORT";
                    }
                }
                else {
                    if (order.side === "SELL") {
                        if (activeSummary.longQuantity > 1e-9 && activeSummary.shortQuantity <= 1e-9) {
                            isExitSide = true;
                            targetPosSide = "LONG";
                        }
                        else {
                            isEntrySide = true;
                            targetPosSide = "SHORT";
                        }
                    }
                    else {
                        // order.side === "BUY"
                        if (activeSummary.shortQuantity > 1e-9 && activeSummary.longQuantity <= 1e-9) {
                            isExitSide = true;
                            targetPosSide = "SHORT";
                        }
                        else {
                            isEntrySide = true;
                            targetPosSide = "LONG";
                        }
                    }
                }
            }
            const execPx = order.lastFilledPrice > 0 ? order.lastFilledPrice : (order.averagePrice > 0 ? order.averagePrice : order.originalPrice);
            const execQty = order.lastFilledQuantity > 0 ? order.lastFilledQuantity : order.cumulativeFilledQuantity;
            if (execPx > 0 && execQty > 0) {
                if (isEntrySide) {
                    console.log(`[BinanceExecution][UNTRACKED_ENTRY_FILL] OrderId #${orderId} filled for ${this.config.symbol} ${targetPosSide}! Occupying/accumulating slot. Qty: ${execQty} @ $${execPx}`);
                    const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
                    const volEstimate = garmanKlassRV > 0.000001 ? Math.sqrt(garmanKlassRV) : 0.005;
                    const dynamicSlPercent = Math.max(targetPosSide === "LONG" ? this.config.longStopLossPercent : this.config.shortStopLossPercent, Math.min(2.0, volEstimate * 2.0 * 100));
                    if (targetPosSide === "LONG") {
                        this.hedgeLedger.occupyCoreLong(execQty, execPx, this.config.longTakeProfitPercent, dynamicSlPercent);
                        const slot = this.hedgeLedger.getCoreLong();
                        this.dispatchBatchPostOnlyTpOrders("CORE_LONG", execPx, execQty, "LONG").catch((err) => {
                            console.error(`[BinanceExecution][UNTRACKED_TP_DISPATCH_ERROR] ${err?.message || String(err)}`);
                        });
                        this.dispatchExchangeStopLossOrder("CORE_LONG", execPx, execQty, "LONG", slot.stopLossPrice).catch((err) => {
                            console.error(`[BinanceExecution][UNTRACKED_SL_DISPATCH_ERROR] ${err?.message || String(err)}`);
                        });
                    }
                    else {
                        const slotIdx = this.hedgeLedger.getAvailableShortSlotIndex();
                        const targetIdx = slotIdx >= 0 ? slotIdx : 0;
                        const slotId = `SHORT_SLOT_${targetIdx}`;
                        this.hedgeLedger.occupyShortSlot(targetIdx, execQty, execPx, this.config.shortTakeProfitPercent, dynamicSlPercent);
                        const slot = this.hedgeLedger.getShortSlots()[targetIdx];
                        this.dispatchBatchPostOnlyTpOrders(slotId, execPx, execQty, "SHORT").catch((err) => {
                            console.error(`[BinanceExecution][UNTRACKED_TP_DISPATCH_ERROR] ${err?.message || String(err)}`);
                        });
                        if (slot) {
                            this.dispatchExchangeStopLossOrder(slotId, execPx, execQty, "SHORT", slot.stopLossPrice).catch((err) => {
                                console.error(`[BinanceExecution][UNTRACKED_SL_DISPATCH_ERROR] ${err?.message || String(err)}`);
                            });
                        }
                    }
                    this.onExecutionCompleted({
                        symbol: this.config.symbol,
                        assetIndex: this.assetIndex,
                        side: order.side,
                        positionSide: targetPosSide,
                        isCloseOrder: false,
                        executedQty: execQty,
                        executedPrice: execPx,
                        fillTimestampMs: Date.now(),
                    });
                    this.syncSabPositionState();
                }
                else if (isExitSide) {
                    console.log(`[BinanceExecution][UNTRACKED_EXIT_FILL] OrderId #${orderId} filled for ${this.config.symbol} ${targetPosSide}! Deducting/releasing slot. Qty: ${execQty} @ $${execPx}`);
                    if (targetPosSide === "LONG") {
                        this.hedgeLedger.deductCoreLongQuantity(execQty, execPx, this.hedgeLedger.getSizingCalculator().getTakerFeeRate(), "EXTERNAL_EXIT");
                    }
                    else {
                        let remainingQtyToDeduct = execQty;
                        const slots = this.hedgeLedger.getShortSlots();
                        for (let sIdx = 0; sIdx < slots.length && remainingQtyToDeduct > 1e-9; sIdx++) {
                            const slot = slots[sIdx];
                            if (slot.isOccupied && slot.quantity > 0) {
                                const closedFromSlot = Math.min(slot.quantity, remainingQtyToDeduct);
                                this.hedgeLedger.deductShortSlotQuantity(sIdx, closedFromSlot, execPx, this.hedgeLedger.getSizingCalculator().getTakerFeeRate(), "EXTERNAL_EXIT");
                                remainingQtyToDeduct -= closedFromSlot;
                            }
                        }
                    }
                    this.onExecutionCompleted({
                        symbol: this.config.symbol,
                        assetIndex: this.assetIndex,
                        side: order.side,
                        positionSide: targetPosSide,
                        isCloseOrder: true,
                        executedQty: execQty,
                        executedPrice: execPx,
                        fillTimestampMs: Date.now(),
                    });
                    this.syncSabPositionState();
                }
            }
        }
        else if (order.orderStatus === "CANCELED" || order.orderStatus === "EXPIRED" || order.orderStatus === "REJECTED") {
            if (this.pendingEntryOrders.has(orderId)) {
                const pending = this.pendingEntryOrders.get(orderId);
                if (pending?.timeoutTimer)
                    clearTimeout(pending.timeoutTimer);
                console.warn(`[BinanceExecution][WS_ENTRY_CANCELLED] Pending entry OrderId #${orderId} was ${order.orderStatus} on Binance. Local slot remains FLAT.`);
                this.pendingEntryOrders.delete(orderId);
            }
        }
    }
    async dispatchBatchPostOnlyTpOrders(slotId, entryPrice, quantity, side) {
        let intents = [];
        try {
            intents = this.hedgeLedger.generateBatchTpOrderIntents(slotId, entryPrice, quantity, side);
            if (intents.length === 0)
                return;
            console.log(`[MAKER_TP_ENGINE][DISPATCHING] Submitting ${intents.length} POST_ONLY limit TP orders for ${slotId} via batchOrders...`);
            const resList = await this.executionClient.placeBatchOrders(intents);
            if (Array.isArray(resList) && resList.length > 0) {
                const validOrderIds = [];
                const rejectedIntents = [];
                resList.forEach((res, idx) => {
                    if (res && res.orderId) {
                        validOrderIds.push(res.orderId);
                    }
                    else if (res && (res.code === -5022 || (res.msg && String(res.msg).includes("-5022")))) {
                        if (intents[idx])
                            rejectedIntents.push({ intent: intents[idx], code: res.code });
                    }
                });
                if (validOrderIds.length > 0) {
                    this.hedgeLedger.registerActiveTpOrderIds(slotId, validOrderIds);
                    console.log(`[MAKER_TP_ENGINE][SUCCESS] Registered ${validOrderIds.length} POST_ONLY TP limit order IDs on Binance orderbook: [${validOrderIds.join(", ")}]`);
                }
                // Retry any individual -5022 rejections within the batch response with 1-tick price shift
                for (const rej of rejectedIntents) {
                    try {
                        const tickSize = symbolPrecision_1.SymbolPrecisionRegistry.getTickSize(rej.intent.symbol);
                        const currentPx = rej.intent.price || entryPrice;
                        const adjustedPx = rej.intent.side === "BUY" ? currentPx - tickSize : currentPx + tickSize;
                        const newPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(rej.intent.symbol, adjustedPx);
                        console.warn(`[MAKER_TP_ENGINE][-5022 ITEM RETRY] Retrying rejected TP order 1 tick away @ ${newPrice}...`);
                        const retryRes = await this.executionClient.placeOrder({
                            ...rej.intent,
                            price: newPrice,
                        });
                        if (retryRes && retryRes.orderId) {
                            this.hedgeLedger.registerActiveTpOrderIds(slotId, [retryRes.orderId]);
                        }
                    }
                    catch (retryErr) {
                        console.error(`[MAKER_TP_ENGINE][-5022 ITEM RETRY FAILED] ${retryErr.message}`);
                    }
                }
            }
        }
        catch (err) {
            if (err.message && (err.message.includes("-5022") || err.message.includes("5022"))) {
                console.warn(`[MAKER_TP_ENGINE][-5022 BATCH REJECTION] Entire TP batch rejected with -5022. Retrying target orders individually with 1-tick price shift...`);
                for (const intent of intents) {
                    try {
                        const tickSize = symbolPrecision_1.SymbolPrecisionRegistry.getTickSize(intent.symbol);
                        const currentPx = intent.price || entryPrice;
                        const adjustedPx = intent.side === "BUY" ? currentPx - tickSize : currentPx + tickSize;
                        const newPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(intent.symbol, adjustedPx);
                        const retryRes = await this.executionClient.placeOrder({
                            ...intent,
                            price: newPrice,
                        });
                        if (retryRes && retryRes.orderId) {
                            this.hedgeLedger.registerActiveTpOrderIds(slotId, [retryRes.orderId]);
                        }
                    }
                    catch (retryErr) {
                        console.error(`[MAKER_TP_ENGINE][-5022 INDIVIDUAL RETRY FAILED] ${retryErr.message}`);
                    }
                }
            }
            else {
                console.error(`[MAKER_TP_ENGINE][ERROR] Failed to submit batch POST_ONLY TP orders: ${err.message}`);
            }
        }
    }
    async dispatchExchangeStopLossOrder(slotId, entryPrice, quantity, side, stopLossPrice) {
        if (stopLossPrice <= 0 || quantity <= 0)
            return undefined;
        const exitSide = side === "LONG" ? "SELL" : "BUY";
        const formattedSlPx = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.config.symbol, stopLossPrice);
        const formattedQty = symbolPrecision_1.SymbolPrecisionRegistry.formatQuantity(this.config.symbol, quantity);
        if (formattedQty <= 0)
            return undefined;
        try {
            console.log(`[EXCHANGE_SL_ENGINE][DISPATCHING] Submitting resting STOP_MARKET order on Binance for ${slotId}: ${exitSide} ${formattedQty} @ stopPrice $${formattedSlPx}...`);
            const res = await this.executionClient.placeOrder({
                symbol: this.config.symbol,
                side: exitSide,
                type: "STOP_MARKET",
                quantity: formattedQty,
                stopPrice: formattedSlPx,
                positionSide: side,
            });
            if (res && res.orderId) {
                this.hedgeLedger.registerActiveStopLossOrderId(slotId, res.orderId);
                console.log(`[EXCHANGE_SL_ENGINE][SUCCESS] Registered resting Exchange STOP_MARKET OrderId #${res.orderId} for ${slotId}`);
                return res.orderId;
            }
        }
        catch (err) {
            console.error(`[EXCHANGE_SL_ENGINE][ERROR] Failed to dispatch exchange STOP_MARKET order: ${err.message}`);
        }
        return undefined;
    }
    async syncExchangeStopLossOrder(slotId, quantity, side, newStopLossPrice) {
        if (this.slSyncLocks.has(slotId)) {
            this.pendingSlSyncTargets.set(slotId, { quantity, side, price: newStopLossPrice });
            console.log(`[EXCHANGE_SL_ENGINE][LOCKED] Sync for ${slotId} is already in-flight. Queued latest target SL $${newStopLossPrice}.`);
            return;
        }
        this.slSyncLocks.add(slotId);
        try {
            let currentTargetPrice = newStopLossPrice;
            let currentQty = quantity;
            let currentSide = side;
            while (true) {
                this.pendingSlSyncTargets.delete(slotId);
                const slot = slotId === "CORE_LONG" ? this.hedgeLedger.getCoreLong() : this.hedgeLedger.getShortSlots().find((s) => s.slotId === slotId);
                if (!slot || !slot.isOccupied || slot.quantity <= 0) {
                    console.log(`[EXCHANGE_SL_ENGINE][SKIP] Slot ${slotId} is not occupied. Skipping SL placement.`);
                    return;
                }
                const existingSlId = this.hedgeLedger.getActiveStopLossOrderId(slotId);
                if (existingSlId) {
                    this.hedgeLedger.registerActiveStopLossOrderId(slotId, 0);
                    try {
                        console.log(`[EXCHANGE_SL_ENGINE][RATCHET_CANCEL] Cancelling previous resting Exchange STOP_MARKET OrderId #${existingSlId} for ${slotId}...`);
                        await this.executionClient.cancelOrder(this.config.symbol, existingSlId);
                    }
                    catch (err) {
                        console.warn(`[EXCHANGE_SL_ENGINE][CANCEL_WARN] Unable to cancel previous SL order #${existingSlId}: ${err.message}`);
                    }
                }
                // Re-verify slot is still occupied after awaiting order cancellation
                if (!slot.isOccupied || slot.quantity <= 0) {
                    console.log(`[EXCHANGE_SL_ENGINE][SKIP] Slot ${slotId} closed during cancellation. Skipping new SL order.`);
                    return;
                }
                const targetQty = slot.quantity > 0 ? slot.quantity : currentQty;
                const placedOrderId = await this.dispatchExchangeStopLossOrder(slotId, slot.entryPrice, targetQty, currentSide, currentTargetPrice);
                if (placedOrderId) {
                    this.hedgeLedger.updateLastSyncedSlPrice(slotId, currentTargetPrice);
                }
                // If a subsequent ratchet target was queued while the network request was in-flight, process it immediately
                if (this.pendingSlSyncTargets.has(slotId)) {
                    const queued = this.pendingSlSyncTargets.get(slotId);
                    if (queued.price !== currentTargetPrice || queued.quantity !== targetQty) {
                        currentTargetPrice = queued.price;
                        currentQty = queued.quantity;
                        currentSide = queued.side;
                        continue;
                    }
                }
                break;
            }
        }
        finally {
            this.slSyncLocks.delete(slotId);
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
    /**
    /**
     * Phase 3 Emergency Remediation: State Hydration & Orphaned Position Guard.
     * Hydrates position state from caller-supplied Binance positionRisk & openOrders arrays.
     */
    async syncExchangeStateWithData(positions, openOrders) {
        try {
            const symbolPositions = (Array.isArray(positions) ? positions : []).filter((pos) => pos.symbol === this.config.symbol);
            // Ingest live exchange leverage setting for this symbol (even if position is currently FLAT)
            const matchingPosWithLev = symbolPositions.find((p) => parseFloat(p.leverage || "0") > 0);
            if (matchingPosWithLev) {
                const liveLev = parseFloat(matchingPosWithLev.leverage);
                this.setLeverageMultiplier(liveLev);
            }
            const activePositions = symbolPositions.filter((pos) => Math.abs(parseFloat(pos.positionAmt || "0")) > 0);
            const symbolOpenOrders = Array.isArray(openOrders)
                ? openOrders.filter((o) => o.symbol === this.config.symbol)
                : [];
            if (activePositions.length === 0) {
                console.log(`[StrategyEngine][StateSync] Binance position state: FLAT (0.0000) for ${this.config.symbol} (Leverage: ${this.config.leverageMultiplier}x).`);
                this.hedgeLedger.syncStartupPositions([], this.config.longTakeProfitPercent, this.config.longStopLossPercent, this.config.shortTakeProfitPercent, this.config.shortStopLossPercent, this.config.leverageMultiplier);
                this.client.setOmsPositionQty(0, this.assetIndex);
                this.client.setOmsPositionSide(0, this.assetIndex);
                this.client.setOmsAvgEntryPrice(0, this.assetIndex);
                this.client.setOmsLeverage(this.config.leverageMultiplier, this.assetIndex);
                return;
            }
            // Reconcile active position(s) into internal ledgers (strictly overwrites and assigns exact Binance position size)
            this.reconcileStartupPositions(activePositions);
            // Map position metrics into SharedArrayBuffer slots
            this.syncSabPositionState(0);
            // ORPHANED POSITION GUARD: Inject dynamic SL/TP if position lacks exchange orders
            for (const pos of activePositions) {
                const qty = Math.abs(parseFloat(pos.positionAmt || "0"));
                const entryPx = parseFloat(pos.entryPrice || "0");
                if (qty <= 0 || entryPx <= 0)
                    continue;
                const posSide = pos.positionSide === "LONG" || (pos.positionSide === "BOTH" && parseFloat(pos.positionAmt || "0") > 0)
                    ? "LONG"
                    : "SHORT";
                const exitSide = posSide === "LONG" ? "SELL" : "BUY";
                const hasSlTpOrder = symbolOpenOrders.some((ord) => {
                    const isMatchSide = ord.side === exitSide;
                    const isSlTpType = ord.type === "STOP_MARKET" ||
                        ord.type === "TAKE_PROFIT_MARKET" ||
                        ord.type === "LIMIT" ||
                        ord.reduceOnly === true;
                    return isMatchSide && isSlTpType;
                });
                if (!hasSlTpOrder) {
                    console.warn(`[ORPHAN_GUARD] Active ${posSide} position on ${this.config.symbol} (${qty} @ $${entryPx}) is UNPROTECTED on exchange!`);
                    // Dynamic Volatility-Based SL/TP (Phase 2 Formulas)
                    const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
                    const volEstimate = garmanKlassRV > 0.000001 ? Math.sqrt(garmanKlassRV) : 0.005;
                    const dynamicSlPct = Math.max(0.005, volEstimate * 2.0);
                    const dynamicSlPercent = dynamicSlPct * 100;
                    const dynamicTpPercent = posSide === "LONG" ? this.config.longTakeProfitPercent : this.config.shortTakeProfitPercent;
                    const slotId = posSide === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0";
                    // NOTE: reconcileStartupPositions() above already reset and occupied the position slot with the exact Binance quantity.
                    // We MUST NOT call occupyCoreLong / occupyShortSlot here because calling occupy on an already occupied slot triggers quantity accumulation (doubling the position size).
                    const slPrice = posSide === "LONG" ? entryPx * (1.0 - dynamicSlPct) : entryPx * (1.0 + dynamicSlPct);
                    const formattedSlPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.config.symbol, slPrice);
                    // 1. Attach and dispatch protective POST_ONLY TP limit order batch to Binance
                    await this.dispatchBatchPostOnlyTpOrders(slotId, entryPx, qty, posSide);
                    // 2. Explicitly dispatch LIVE STOP_MARKET Stop-Loss order to Binance exchange
                    try {
                        const slOrder = await this.executionClient.placeOrder({
                            symbol: this.config.symbol,
                            side: exitSide,
                            type: "STOP_MARKET",
                            quantity: qty,
                            stopPrice: formattedSlPrice,
                            positionSide: posSide,
                        });
                        console.log(`[ORPHAN_GUARD][DISPATCHED] Live STOP_MARKET order #${slOrder.orderId} confirmed on Binance for ${this.config.symbol} ${posSide}: stopPrice=$${formattedSlPrice}`);
                    }
                    catch (slErr) {
                        console.error(`[ORPHAN_GUARD][ERROR] Failed to dispatch live STOP_MARKET order to Binance for ${this.config.symbol} ${posSide}: ${slErr.message}`);
                    }
                    console.log(`[ORPHAN_GUARD][DISPATCHED] Dynamic Volatility SL/TP attached to ${this.config.symbol} ${posSide} position: SL=$${formattedSlPrice} (${dynamicSlPercent.toFixed(2)}%), TP=${dynamicTpPercent.toFixed(2)}%`);
                }
                else {
                    console.log(`[ORPHAN_GUARD] Active ${posSide} position on ${this.config.symbol} has active exchange protective order(s).`);
                }
            }
            // Final synchronization of SharedArrayBuffer OMS slots
            this.syncSabPositionState(0);
        }
        catch (err) {
            console.error(`[StrategyEngine][StateSync][ERROR] Failed to sync exchange state for ${this.config.symbol}: ${err.message}`);
        }
    }
    async syncExchangeState() {
        if (!this.executionClient.isConfigured()) {
            console.log(`[StrategyEngine][StateSync] BinanceExecutionClient unconfigured for ${this.config.symbol}. Skipping state sync.`);
            return;
        }
        try {
            console.log(`[StrategyEngine][StateSync] Syncing exchange state & open orders for ${this.config.symbol}...`);
            const [positions, openOrders] = await Promise.all([
                this.executionClient.getPositionRisk(this.config.symbol),
                this.executionClient.getOpenOrders(this.config.symbol),
            ]);
            await this.syncExchangeStateWithData(positions, openOrders);
        }
        catch (err) {
            console.error(`[StrategyEngine][StateSync][ERROR] Failed to sync exchange state for ${this.config.symbol}: ${err.message}`);
        }
    }
    reconcileStartupPositions(rawPositions) {
        if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
            console.log(`[StrategyEngine][StateRecovery] No active positions returned from Binance REST API for ${this.config.symbol}.`);
            return;
        }
        const matchingPosWithLev = rawPositions.find((p) => p.symbol === this.config.symbol && parseFloat(p.leverage || "0") > 0);
        if (matchingPosWithLev) {
            const liveLev = parseFloat(matchingPosWithLev.leverage);
            this.setLeverageMultiplier(liveLev);
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
            // Binance REST /fapi/v2/positionRisk returns `updateTime` (Unix ms) — the last time this position
            // was opened or modified. Used to restore CAD-DTLM position age across restarts.
            const originalOpenTime = pos.updateTime && pos.updateTime > 0 ? pos.updateTime : 0;
            recovered.push({
                side,
                quantity: Math.abs(amt),
                entryPrice: entryPx,
                originalOpenTime,
            });
        }
        if (recovered.length > 0) {
            this.hedgeLedger.syncStartupPositions(recovered, this.config.longTakeProfitPercent, this.config.longStopLossPercent, this.config.shortTakeProfitPercent, this.config.shortStopLossPercent, this.config.leverageMultiplier);
            console.log(`[StrategyEngine][StateRecovery] Successfully recovered ${recovered.length} open position(s) from Binance REST API for ${this.config.symbol} at ${this.config.leverageMultiplier}x leverage.`);
        }
        else {
            console.log(`[StrategyEngine][StateRecovery] Binance position state: FLAT (0.0000) for ${this.config.symbol} at ${this.config.leverageMultiplier}x leverage.`);
        }
        this.syncSabPositionState(0);
    }
    /**
     * High-frequency tick evaluation loop.
     * Reads scalar metrics directly from SharedArrayBuffer via MarketDataClient getters.
     * Zero GC heap allocation when no trade signals are generated.
     */
    evaluateTick() {
        let finalizedSignalVal = 0.0;
        try {
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
            // SPREAD & TICK GUARD: Immediately reject invalid tick data (bid <= 0, ask <= 0, bid > ask) or excessive spread BEFORE evaluating dynamic exits or signals
            const isTickValid = askPrice > 0 && bidPrice > 0 && askPrice >= bidPrice;
            const currentSpread = isTickValid ? askPrice - bidPrice : Infinity;
            let maxSpreadAllowed;
            if (this.config.symbol.includes("BTC")) {
                maxSpreadAllowed = Math.max(this.config.maxSpreadBtc, askPrice * 0.0015);
            }
            else if (this.config.symbol.includes("ETH")) {
                maxSpreadAllowed = Math.max(this.config.maxSpreadEth, askPrice * 0.0015);
            }
            else {
                maxSpreadAllowed = Math.max(this.config.maxSpreadAlt, askPrice * 0.0020);
            }
            if (!isTickValid || currentSpread > maxSpreadAllowed) {
                const reasonCode = !isTickValid ? "INVALID_TICK_DATA" : "REJECTED_LIQUIDITY_SWEEP_TRAP";
                const message = !isTickValid
                    ? `Tick evaluation rejected: invalid tick prices (bid: ${bidPrice}, ask: ${askPrice})`
                    : `Tick evaluation rejected: current spread (${currentSpread.toFixed(2)} USDT) > ${maxSpreadAllowed.toFixed(2)} USDT threshold`;
                if (seq % 500n === 0n || !isTickValid) {
                    console.warn(`[StrategyEngine][SPREAD_GUARD_REJECT] Seq #${seq} | ${message}`);
                }
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
            // Read AI predictions & latency metrics from SAB (Sanitized for NaN & magnitude non-negativity)
            const rawDir = this.client.getAIPredictionDirection(this.assetIndex);
            const rawConf = this.client.getAIPredictionConfidence(this.assetIndex);
            const aiDirection = Number.isFinite(rawDir) ? rawDir : 0.0;
            const rawAiConfidence = Number.isFinite(rawConf) ? Math.max(0.0, Math.min(1.0, rawConf)) : 0.0;
            // Dual-redundant safety guard: enforce zero AI confidence if SAB indicates drift OR if background training (CfC or T-KAN) is active.
            // During active training or drift, forcing aiConfidence=0.0 guarantees zero signal execution on stale/invalid models.
            const isDriftedSab = this.client.getIsModelDrifted(this.assetIndex);
            const autoRecal = recalibrationWorker_1.AutoRecalibrationManager.getInstance();
            const isTrainingActive = isDriftedSab || autoRecal.getStatus().isRecalibrating || autoRecal.isTkanTrainingActive();
            const aiConfidence = isTrainingActive ? 0.0 : rawAiConfidence;
            const aiDirectionMag = Math.abs(aiDirection);
            const latencyPenalty = this.client.getLatencyPenaltyCoefficient(this.assetIndex);
            const penaltyCoeff = latencyPenalty > 0 ? Math.max(0.75, latencyPenalty) : 1.0;
            // 1. Dynamic Monitoring: Evaluate Microstructure, Volatility & Dynamic Exit Boundaries
            const markPrice = askPrice > 0 ? (askPrice + bidPrice) / 2 : bidPrice;
            // Feed live orderbook & price ticks into SOTA microstructure & volatility engines
            const bestBidQty = this.client.getBestBidQuantity(this.assetIndex);
            const bestAskQty = this.client.getBestAskQuantity(this.assetIndex);
            this.hazardEngine.updateOrderBook(bidPrice, bestBidQty, askPrice, bestAskQty);
            this.volEngine.updatePrice(markPrice);
            const summary = this.hedgeLedger.getSummary(markPrice > 0 ? markPrice : 0);
            const activePosSide = summary.side === "SHORT" ? "SHORT" : "LONG";
            let holdingDurationMs = 0;
            const coreLong = this.hedgeLedger.getCoreLong();
            const coreLongDuration = coreLong.isOccupied && coreLong.openTime > 0 ? Math.max(0, Date.now() - coreLong.openTime) : 0;
            let shortDuration = 0;
            const shortSlots = this.hedgeLedger.getShortSlots();
            for (const slot of shortSlots) {
                if (slot.isOccupied && slot.openTime > 0) {
                    const dur = Math.max(0, Date.now() - slot.openTime);
                    if (dur > shortDuration)
                        shortDuration = dur;
                }
            }
            holdingDurationMs = Math.max(coreLongDuration, shortDuration);
            const hazardMetrics = this.hazardEngine.getHazardMetrics(activePosSide, aiConfidence, holdingDurationMs);
            const volMetrics = this.volEngine.getVolatilitySurfaceMetrics();
            const signedInventory = summary.netQuantity;
            const hjbResPrice = this.hjbEngine.calculateReservationPrice(markPrice, signedInventory, holdingDurationMs, volMetrics.garmanKlass1s);
            // Atomically sync SAB Telemetry Slots 138-141 for Live TUI Monitor & OMS
            this.client.setOFI(hazardMetrics.ofi, this.assetIndex);
            this.client.setHJBReservationPrice(hjbResPrice, this.assetIndex);
            this.client.setSurvivalProbability(hazardMetrics.survivalProbability, this.assetIndex);
            const hasActivePos = summary.netQuantity > 0 || summary.side !== "FLAT";
            const dynamicSlPx = hasActivePos
                ? (summary.side === "LONG"
                    ? summary.averageEntryPrice * (1.0 - this.config.longStopLossPercent / 100)
                    : summary.averageEntryPrice * (1.0 + this.config.shortStopLossPercent / 100))
                : 0;
            this.client.setDynamicStopLossPrice(dynamicSlPx, this.assetIndex);
            // Sync active position state to SharedArrayBuffer for TUI Table telemetry
            if (markPrice > 0) {
                this.syncSabPositionState(markPrice);
            }
            if (markPrice > 0) {
                const hurstExponent = this.client.getHurstExponent(this.assetIndex);
                // Priority 1: Evaluate SOTA Dynamic Exits (MS-SOPC, CAD-DTLM, Cox Hazard Survival Flush, HJB Liquidation Boundary)
                const sotaTriggers = hasActivePos
                    ? this.hedgeLedger.evaluateSotaDynamicExits(bidPrice, askPrice, hazardMetrics, this.hjbEngine, volMetrics, Date.now(), hurstExponent)
                    : [];
                // Priority 2: Evaluate Hedge Slot Dynamic TP/SL Fallback (Fixed/Trailing TP/SL, Profit Lock)
                const hawkesIntensity = this.client.getHawkesIntensity(this.assetIndex);
                const hedgeTriggers = (hasActivePos && sotaTriggers.length === 0)
                    ? this.hedgeLedger.evaluateHedgeDynamicTpSl(markPrice, aiDirection, aiConfidence, hazardMetrics.vpin, hawkesIntensity, volMetrics.garmanKlass1s, hazardMetrics.ofi, Date.now())
                    : [];
                const activeTriggers = sotaTriggers.length > 0 ? sotaTriggers : hedgeTriggers;
                // Check for Stop-Loss Ratchet Shifts that require Exchange-Native STOP_MARKET cancel-replace sync
                if (activeTriggers.length === 0) {
                    const coreLong = this.hedgeLedger.getCoreLong();
                    if (coreLong.isOccupied && coreLong.quantity > 0 && coreLong.stopLossPrice > 0) {
                        if (coreLong.lastSyncedSlPrice === undefined || coreLong.lastSyncedSlPrice === 0 || coreLong.stopLossPrice > coreLong.lastSyncedSlPrice) {
                            this.syncExchangeStopLossOrder("CORE_LONG", coreLong.quantity, "LONG", coreLong.stopLossPrice).catch((err) => {
                                console.error(`[EXCHANGE_SL_ENGINE][SYNC_ERR] Core Long SL ratchet sync failed: ${err.message}`);
                            });
                        }
                    }
                    for (const s of this.hedgeLedger.getShortSlots()) {
                        if (s.isOccupied && s.quantity > 0 && s.stopLossPrice > 0) {
                            if (s.lastSyncedSlPrice === undefined || s.lastSyncedSlPrice === 0 || s.stopLossPrice < s.lastSyncedSlPrice) {
                                this.syncExchangeStopLossOrder(s.slotId, s.quantity, "SHORT", s.stopLossPrice).catch((err) => {
                                    console.error(`[EXCHANGE_SL_ENGINE][SYNC_ERR] ${s.slotId} SL ratchet sync failed: ${err.message}`);
                                });
                            }
                        }
                    }
                }
                if (activeTriggers.length > 0) {
                    const trigger = activeTriggers[0];
                    const exitSide = trigger.side === "LONG" ? "SELL" : "BUY";
                    const isHardStopTrigger = trigger.reason.includes("HAZARD") ||
                        trigger.reason.includes("HJB") ||
                        trigger.reason.includes("MS_SOPC") ||
                        trigger.reason.includes("MVA_TS") ||
                        trigger.reason === "STOP_LOSS" ||
                        trigger.reason === "BREAK_EVEN_STOP_LOSS" ||
                        trigger.reason === "LONG_HOLD_PROFIT_HARVEST" ||
                        trigger.reason === "CAD_TERMINAL_HORIZON_KILL" ||
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
                                    // Ledger Delta Pattern (Defect #10 Fix):
                                    // Capture ledger PnL BEFORE deduct/release. The deduct/release calls trigger
                                    // recordRealizedExit() internally, which is the single source of truth for PnL.
                                    // We derive realizedPnl as the ledger delta — zero redundant arithmetic,
                                    // zero fee formula divergence between RiskGuard and HedgePositionLedger.
                                    const pnlBefore = this.hedgeLedger.getCumulativeRealizedPnl();
                                    if (trigger.isPartialClose && trigger.quantity > 0) {
                                        if (trigger.side === "LONG") {
                                            this.hedgeLedger.deductCoreLongQuantity(trigger.quantity, execPx, takerFeeRate, trigger.reason);
                                        }
                                        else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                                            const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                                            this.hedgeLedger.deductShortSlotQuantity(sIdx, trigger.quantity, execPx, takerFeeRate, trigger.reason);
                                        }
                                    }
                                    else if (!trigger.isPartialClose) {
                                        if (trigger.side === "LONG") {
                                            this.hedgeLedger.releaseCoreLong(execPx, takerFeeRate, trigger.reason);
                                        }
                                        else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                                            const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                                            this.hedgeLedger.releaseShortSlot(sIdx, execPx, takerFeeRate, trigger.reason);
                                        }
                                    }
                                    // Delta = exactly what recordRealizedExit recorded \u2014 single source of truth for RiskGuard
                                    const realizedPnl = this.hedgeLedger.getCumulativeRealizedPnl() - pnlBefore;
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
                    finalizedSignalVal = riskResult.passed ? (exitSide === "BUY" ? 1.0 : exitSide === "SELL" ? 2.0 : 0.0) : 0.0;
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
            // Dynamic Environment Ingestion (Zero-Hardcoding Protocol)
            const minNetAlpha = this.hedgeLedger.getSizingCalculator().getMinNetAlpha();
            const makerFeeRate = this.hedgeLedger.getSizingCalculator().getMakerFeeRate();
            const takerFeeRate = this.hedgeLedger.getSizingCalculator().getTakerFeeRate();
            const midPrice = askPrice > 0 && bidPrice > 0 && Number.isFinite(askPrice) && Number.isFinite(bidPrice)
                ? (bidPrice + askPrice) / 2.0
                : 1.0;
            const rawHalfSpread = midPrice > 0 && askPrice >= bidPrice && Number.isFinite(askPrice) && Number.isFinite(bidPrice)
                ? (askPrice - bidPrice) / (2.0 * midPrice)
                : 0.0001;
            const halfSpreadBps = Number.isFinite(rawHalfSpread) && rawHalfSpread >= 0 ? rawHalfSpread : 0.0001;
            const safeGarmanKlass = Number.isFinite(garmanKlassRV) && garmanKlassRV > 0.000001 ? garmanKlassRV : 0;
            const volEstimate = safeGarmanKlass > 0 ? Math.sqrt(safeGarmanKlass) : 0.005;
            const safeHawkes = Number.isFinite(hawkesIntensity) && hawkesIntensity > 0 ? hawkesIntensity : 0;
            const hawkesMultiplier = 1.0 + 0.15 * Math.log(1.0 + safeHawkes);
            // SOTA Alpha-to-Friction Barrier Model (August 2026)
            // E[alpha] = |aiDirection| * volEstimate * sqrt(horizon_s) * hawkesMultiplier
            // Total Friction = 2 * MakerFee + HalfSpread + SlippageEst
            const horizonSec = 5.0;
            const expectedAlpha = aiDirectionMag * volEstimate * Math.sqrt(horizonSec / 60.0) * hawkesMultiplier;
            const estimatedSlippage = (spreadVelocity > 0 ? Math.min(0.0002, (spreadVelocity / 50.0) * 0.0001) : 0.0);
            const totalFrictionBarrier = (2.0 * makerFeeRate) + halfSpreadBps + estimatedSlippage;
            const expectedNetAlpha = expectedAlpha - totalFrictionBarrier;
            // SOTA Volatility, Toxicity & Drawdown Adjusted Dynamic Conviction Floor (theta_conf)
            // Strict base confidence constraint locked to exactly 0.653 (65.3%)
            const baseMinConfidence = this.config.minAiConfidence;
            let effectiveMinConfidence = baseMinConfidence;
            const sessionPnl = this.riskGuard.getCumulativeDailyRealizedPnl();
            const isDrawdown = sessionPnl < -5.0; // Enforce drawdown penalty only on significant drawdowns (> $5)
            // Dynamic Regime Conviction: Modulate confidence with bounded proportional scaling rather than rigid +800 bps spikes
            if (volEstimate < 0.0015) {
                effectiveMinConfidence = Math.min(0.75, effectiveMinConfidence + 0.02);
            }
            else if (hurstExponent > 0.55 && safeGarmanKlass > 0.001) {
                // Strong trend regime: allow frictionless capture down to base floor
                effectiveMinConfidence = Math.max(baseMinConfidence, effectiveMinConfidence - 0.02);
            }
            // Microstructure Toxicity Surcharge: Scaled proportionally with VPIN severity
            const vpinVal = this.client.getVPIN(this.assetIndex);
            if (vpinVal >= 0.90) {
                effectiveMinConfidence = Math.min(0.75, effectiveMinConfidence + 0.03);
            }
            // Drawdown Surcharge: Apply moderate protection during deep drawdown
            if (isDrawdown) {
                effectiveMinConfidence = Math.min(0.75, effectiveMinConfidence + 0.03);
            }
            // Strict bounding around base conviction floor
            effectiveMinConfidence = Math.min(0.85, Math.max(baseMinConfidence, effectiveMinConfidence));
            // 50-25-25 Weighted Composite Signal Engine & High-Confidence AI Override
            const obiScore = Math.max(-1.0, Math.min(1.0, obi));
            const cvdScore = cvd > 0 ? 1.0 : cvd < 0 ? -1.0 : 0.0;
            const aiScore = Math.max(-1.0, Math.min(1.0, aiDirection * aiConfidence));
            const compositeScore = 0.50 * aiScore + 0.25 * obiScore + 0.25 * cvdScore;
            const isHighConfidenceAi = aiConfidence >= Math.max(this.config.aggressiveConfidenceThreshold, effectiveMinConfidence);
            // Volatility-Standardized Z-Score of the signal
            const safeVol = Number.isFinite(volEstimate) && volEstimate >= 0.0001 ? volEstimate : 0.005;
            const rawZScore = aiDirectionMag / safeVol;
            const zScore = Number.isFinite(rawZScore) ? rawZScore : 0.0;
            // Dynamic Conviction Authorization: Require Alpha-to-Friction Barrier clearance AND Z-Score >= 1.5 (2.0 during drawdown)
            const minZScoreThreshold = isDrawdown ? 2.0 : 1.5;
            const isAlphaFrictionPassed = expectedNetAlpha >= minNetAlpha;
            const isConvictionValid = isAlphaFrictionPassed && zScore >= minZScoreThreshold && aiConfidence >= effectiveMinConfidence;
            let isBuySignal = false;
            let isSellSignal = false;
            if (isConvictionValid) {
                if (isHighConfidenceAi) {
                    // AI-Override Rule: High-confidence AI must satisfy strict OBI directional pressure (+/- 0.35)
                    isBuySignal = aiDirection > 0 && obi >= this.config.obiBuyThreshold;
                    isSellSignal = aiDirection < 0 && obi <= this.config.obiSellThreshold;
                    if (isBuySignal || isSellSignal) {
                        console.log(`[StrategyEngine][${this.config.symbol}][HIGH_CONFIDENCE] Seq #${seq} | Dir: ${aiDirection.toFixed(4)} (NetAlpha: ${(expectedNetAlpha * 10000).toFixed(1)} bps >= ${(minNetAlpha * 10000).toFixed(1)} bps), Conf: ${(aiConfidence * 100).toFixed(1)}% (Floor: ${(effectiveMinConfidence * 100).toFixed(1)}%), OBI: ${obi.toFixed(4)}, BuySignal: ${isBuySignal}, SellSignal: ${isSellSignal}`);
                    }
                }
                else {
                    // Weighted Composite Rule with dynamic effective confidence thresholding
                    isBuySignal = compositeScore > 0.12 && aiConfidence >= effectiveMinConfidence && obi >= this.config.obiBuyThreshold;
                    isSellSignal = compositeScore < -0.12 && aiConfidence >= effectiveMinConfidence && obi <= this.config.obiSellThreshold;
                }
            }
            else if (seq % 1000n === 0n) {
                const netAlphaBps = (expectedNetAlpha * 10000).toFixed(1);
                const hurdleBps = (minNetAlpha * 10000).toFixed(1);
                const confPct = (aiConfidence * 100).toFixed(1);
                const floorPct = (effectiveMinConfidence * 100).toFixed(1);
                const alphaOp = isAlphaFrictionPassed ? ">=" : "<";
                const confOp = aiConfidence >= effectiveMinConfidence ? ">=" : "<";
                const zOp = zScore >= minZScoreThreshold ? ">=" : "<";
                console.log(`[StrategyEngine][${this.config.symbol}][CONVICTION_FLOOR_GATE] Seq #${seq} | Dir: ${aiDirection.toFixed(4)} ` +
                    `(NetAlpha: ${netAlphaBps} bps ${alphaOp} Hurdle: ${hurdleBps} bps [${isAlphaFrictionPassed ? "PASS" : "FAIL"}], ` +
                    `Conf: ${confPct}% ${confOp} Floor: ${floorPct}% [${aiConfidence >= effectiveMinConfidence ? "PASS" : "FAIL"}], ` +
                    `Z: ${zScore.toFixed(2)} ${zOp} ${minZScoreThreshold.toFixed(1)} [${zScore >= minZScoreThreshold ? "PASS" : "FAIL"}]) -> Signals Filtered`);
            }
            // BUY -> Core Long Entry (allowed if Core Long is FLAT & temporal cooldown expired)
            const isCoreLongOccupied = this.hedgeLedger.getCoreLong().isOccupied;
            const hasPendingCoreLong = this.hasPendingEntryForSlot("CORE_LONG");
            const isCooldownCleared = nowMs >= longCooldownLock;
            if (!isCoreLongOccupied && !hasPendingCoreLong && !isCooldownCleared) {
                console.log(`[StrategyEngine][${this.config.symbol}][COOLDOWN_BLOCK] Seq #${seq} | nowMs: ${nowMs}, longCooldownLock: ${longCooldownLock}, diff: ${longCooldownLock - nowMs}ms`);
            }
            if (isBuySignal &&
                (isHighConfidenceAi || spreadVelocity < this.config.maxSpreadVelocity) &&
                askPrice > 0 &&
                !isCoreLongOccupied &&
                !hasPendingCoreLong &&
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
                    const slotId = `SHORT_SLOT_${slotEval.slotIndex}`;
                    if (!this.hasPendingEntryForSlot(slotId)) {
                        signalType = "SELL";
                        targetPosSide = "SHORT";
                        targetSlotIndex = slotEval.slotIndex;
                        targetSlotId = slotId;
                        targetSizeDecayCoeff = slotEval.sizeDecayCoeff;
                    }
                }
            }
            if (signalType === "NONE") {
                if (seq % 500n === 0n) {
                    console.log(`[StrategyEngine][${this.config.symbol}][SignalGate] Seq #${seq} | Composite: ${compositeScore.toFixed(4)} | AI: (dir=${aiDirection.toFixed(2)}, conf=${(aiConfidence * 100).toFixed(0)}%) | OBI: ${obi.toFixed(2)} | CVD: ${cvd.toFixed(0)} | Status: NO SIGNAL TRIGGERED`);
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
            const basePrice = signalType === "BUY" ? askPrice : bidPrice;
            // 100% SOTA Maker-Dominant Execution Architecture (POST_ONLY GTX Order Routing)
            // Completely eradicates MARKET/IOC taker fee dispatches for entry signals.
            // Forces limit orders directly on the order book at best bid (BUY) and best ask (SELL), guaranteeing zero spread loss & Maker fee execution.
            let orderType = "LIMIT";
            const timeInForce = "GTX";
            let targetPrice = signalType === "BUY" ? bidPrice : askPrice;
            // SOTA August 2026 Alpha-Gated Dynamic Kelly Recovery Sizing (AG-DKRS)
            let finalQuantity = 0.001;
            if (basePrice > 0) {
                const baseNotional = this.config.tradeSizeUsdt > 0 ? this.config.tradeSizeUsdt : 60.0;
                const maxDailyLoss = this.riskGuard.getConfig().maxDailyLossUsdt;
                const sizingRes = this.hedgeLedger.getSizingCalculator().calculateAlphaGatedRecoverySize(baseNotional, sessionPnl, maxDailyLoss, aiConfidence, zScore, hurstExponent);
                let targetNotionalUsdt = sizingRes.targetNotionalUsdt;
                // Cap single order target notional against RiskGuard max position size limit
                const maxPosSizeUsdt = this.riskGuard.getConfig().maxPositionSizeUsdt;
                if (maxPosSizeUsdt > 0 && targetNotionalUsdt > maxPosSizeUsdt) {
                    targetNotionalUsdt = maxPosSizeUsdt;
                }
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
            const riskProfile = this.dynamicRiskEngine.evaluateDynamicRisk(targetPrice, targetPosSide === "LONG" ? "LONG" : "SHORT", microMetrics, Math.abs(askPrice - bidPrice), isDrawdown);
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
                if (seq % 1000n === 0n) {
                    console.log(`[StrategyEngine][${this.config.symbol}][RISK_REJECTED] Seq #${seq} | Reason: ${riskResult.reasonCode} - ${riskResult.message}`);
                }
            }
            else {
                finalizedSignalVal = signalType === "BUY" ? 1.0 : signalType === "SELL" ? 2.0 : 0.0;
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
                        const executedQty = parseFloat(res.executedQty || "0");
                        const isFilled = res.status === "FILLED" || executedQty > 0;
                        const isPending = res.status === "NEW";
                        console.log(`[BinanceExecution][RESPONSE] OrderId: ${res.orderId}, Status: ${res.status}, ExecQty: ${executedQty}, Price: ${execPx}`);
                        if (isFilled) {
                            // Confirmed Fill on REST Response! Occupy slot immediately
                            this.onExecutionCompleted({
                                symbol: this.config.symbol,
                                assetIndex: this.assetIndex,
                                side: res.side,
                                positionSide: targetPosSide,
                                isCloseOrder: false,
                                executedQty: executedQty > 0 ? executedQty : finalQuantity,
                                executedPrice: execPx,
                                fillTimestampMs: Date.now(),
                            });
                            const garmanKlassRV = this.client.getGarmanKlassRV(this.assetIndex);
                            const volEstimate = garmanKlassRV > 0.000001 ? Math.sqrt(garmanKlassRV) : 0.005;
                            const dynamicSlPct = Math.max(0.005, volEstimate * 2.0);
                            const dynamicSlPercent = dynamicSlPct * 100;
                            if (targetPosSide === "LONG") {
                                this.hedgeLedger.occupyCoreLong(finalQuantity, execPx, this.config.longTakeProfitPercent, dynamicSlPercent);
                                const slot = this.hedgeLedger.getCoreLong();
                                this.dispatchBatchPostOnlyTpOrders("CORE_LONG", execPx, finalQuantity, "LONG").catch((err) => {
                                    console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
                                });
                                this.dispatchExchangeStopLossOrder("CORE_LONG", execPx, finalQuantity, "LONG", slot.stopLossPrice).catch((err) => {
                                    console.error(`[EXCHANGE_SL_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
                                });
                            }
                            else if (targetPosSide === "SHORT" && targetSlotIndex !== undefined) {
                                const slotId = `SHORT_SLOT_${targetSlotIndex}`;
                                this.hedgeLedger.occupyShortSlot(targetSlotIndex, finalQuantity, execPx, this.config.shortTakeProfitPercent, dynamicSlPercent);
                                const slot = this.hedgeLedger.getShortSlots()[targetSlotIndex];
                                this.dispatchBatchPostOnlyTpOrders(slotId, execPx, finalQuantity, "SHORT").catch((err) => {
                                    console.error(`[MAKER_TP_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
                                });
                                if (slot) {
                                    this.dispatchExchangeStopLossOrder(slotId, execPx, finalQuantity, "SHORT", slot.stopLossPrice).catch((err) => {
                                        console.error(`[EXCHANGE_SL_ENGINE][UNHANDLED_DISPATCH_ERR] ${err?.message || String(err)}`);
                                    });
                                }
                            }
                        }
                        else if (isPending && res.orderId) {
                            // Pending Limit / Post-Only Order placed on Binance orderbook: DO NOT occupy slot until WS fill confirmation
                            const numericOrderId = typeof res.orderId === "number" ? res.orderId : parseInt(String(res.orderId), 10);
                            if (!isNaN(numericOrderId)) {
                                const fallbackTimer = setTimeout(async () => {
                                    if (this.pendingEntryOrders.has(numericOrderId)) {
                                        console.log(`[BinanceExecution][PENDING_FALLBACK_CHECK] Auditing pending OrderId #${numericOrderId} for ${this.config.symbol}...`);
                                        try {
                                            const orderCheck = await this.executionClient.getOrder(this.config.symbol, numericOrderId);
                                            // Race Condition Defense: Verify order wasn't already filled by WebSocket during the getOrder await
                                            if (!this.pendingEntryOrders.has(numericOrderId)) {
                                                return;
                                            }
                                            if (orderCheck && (orderCheck.status === "FILLED" || parseFloat(orderCheck.executedQty || "0") > 0)) {
                                                const execQty = parseFloat(orderCheck.executedQty || "0") || finalQuantity;
                                                const execPx = parseFloat(orderCheck.avgPrice || orderCheck.price || "0") || targetPrice;
                                                console.log(`[BinanceExecution][FALLBACK_FILL_CONFIRMED] OrderId #${numericOrderId} confirmed FILLED via REST audit!`);
                                                this.handleConfirmedEntryFill(numericOrderId, targetSlotId, targetPosSide, targetSlotIndex, execQty, execPx);
                                            }
                                            else if (orderCheck && (orderCheck.status === "CANCELED" || orderCheck.status === "EXPIRED" || orderCheck.status === "REJECTED")) {
                                                console.warn(`[BinanceExecution][FALLBACK_CLEANUP] OrderId #${numericOrderId} was ${orderCheck.status}. Removing from pending.`);
                                                this.pendingEntryOrders.delete(numericOrderId);
                                            }
                                        }
                                        catch (err) {
                                            if (this.pendingEntryOrders.has(numericOrderId)) {
                                                console.error(`[BinanceExecution][FALLBACK_AUDIT_ERROR] Failed to audit order #${numericOrderId}: ${err?.message || String(err)}`);
                                                this.syncExchangeState().catch((syncErr) => {
                                                    console.error(`[BinanceExecution][FALLBACK_SYNC_ERROR] ${syncErr?.message || String(syncErr)}`);
                                                });
                                            }
                                        }
                                    }
                                }, 2500);
                                this.pendingEntryOrders.set(numericOrderId, {
                                    slotId: targetSlotId,
                                    posSide: targetPosSide,
                                    slotIndex: targetSlotIndex,
                                    qty: finalQuantity,
                                    targetPrice: execPx,
                                    timeoutTimer: fallbackTimer,
                                });
                                console.log(`[BinanceExecution][PENDING_FILL] Registered pending entry OrderId #${numericOrderId} for slot ${targetSlotId}. Slot WILL NOT be occupied until WS fill confirmation (2.5s fallback active).`);
                            }
                        }
                        else {
                            console.warn(`[BinanceExecution][UNFILLED_ORDER] Order placement returned status "${res.status}". Local slot ${targetSlotId} remains FLAT.`);
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
        catch (err) {
            finalizedSignalVal = 0.0;
            console.error(`[ENGINE_EVALUATE_TICK_ERROR][Asset #${this.assetIndex}] Exception in evaluateTick: ${err.message}`);
            this.staticResult.sequenceNum = this.lastProcessedSequence;
            this.staticResult.signalType = "NONE";
            this.staticResult.riskResult = {
                passed: false,
                reasonCode: "CRITICAL_EVALUATION_EXCEPTION",
                message: err.message || "Unhandled exception during tick evaluation",
            };
            this.staticResult.executionPromise = undefined;
            return this.staticResult;
        }
        finally {
            // NON-NEGOTIABLE SAFETY INVARIANT: Enforce atomic SAB Slot 137 synchronization across ALL exit paths
            this.client.setFinalizedSignal(finalizedSignalVal, this.assetIndex);
        }
    }
    getConfig() {
        return this.config;
    }
}
exports.StrategyEngine = StrategyEngine;
var multiEngine_1 = require("./multiEngine");
Object.defineProperty(exports, "MultiAssetStrategyEngine", { enumerable: true, get: function () { return multiEngine_1.MultiAssetStrategyEngine; } });
