"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategyEngine = void 0;
const positionLedger_1 = require("./positionLedger");
const dynamicRiskEngine_1 = require("./dynamicRiskEngine");
class StrategyEngine {
    client;
    riskGuard;
    executionClient;
    positionLedger;
    hedgeLedger;
    config;
    dynamicRiskEngine = new dynamicRiskEngine_1.DynamicRiskEngine();
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
        const envOrderQty = process.env.ORDER_QUANTITY ? parseFloat(process.env.ORDER_QUANTITY) : NaN;
        const envLeverage = process.env.LEVERAGE ? parseInt(process.env.LEVERAGE, 10) : NaN;
        const defaultLongTp = !isNaN(envLongTp) ? envLongTp : 2.5;
        const defaultLongSl = !isNaN(envLongSl) ? envLongSl : 1.2;
        const defaultShortTp = !isNaN(envShortTp) ? envShortTp : 0.6;
        const defaultShortSl = !isNaN(envShortSl) ? envShortSl : 0.5;
        const defaultProfitLock = !isNaN(envProfitLock) ? envProfitLock : 10.0;
        const defaultMaxShortSlots = !isNaN(envMaxShortSlots) ? envMaxShortSlots : 3;
        const defaultMinAiConfidence = !isNaN(envMinAiConfidence) ? envMinAiConfidence : 0.6;
        const defaultAggressiveConfidence = !isNaN(envAggressiveConfidence) ? envAggressiveConfidence : 0.85;
        const defaultObiBuy = !isNaN(envObiBuy) ? envObiBuy : 0.25;
        const defaultObiSell = !isNaN(envObiSell) ? envObiSell : -0.25;
        const defaultCvdBuy = !isNaN(envCvdBuy) ? envCvdBuy : 0.0;
        const defaultCvdSell = !isNaN(envCvdSell) ? envCvdSell : 0.0;
        const defaultOrderQty = !isNaN(envOrderQty) ? envOrderQty : 0.001;
        const defaultLeverage = !isNaN(envLeverage) ? envLeverage : 10;
        this.config = {
            symbol: config?.symbol ?? "BTCUSDT",
            orderQuantity: config?.orderQuantity ?? defaultOrderQty,
            obiBuyThreshold: config?.obiBuyThreshold ?? defaultObiBuy,
            obiSellThreshold: config?.obiSellThreshold ?? defaultObiSell,
            cvdBuyThreshold: config?.cvdBuyThreshold ?? defaultCvdBuy,
            cvdSellThreshold: config?.cvdSellThreshold ?? defaultCvdSell,
            maxSpreadVelocity: config?.maxSpreadVelocity ?? 0.1,
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
        };
        this.hedgeLedger = hedgeLedger ?? new positionLedger_1.HedgePositionLedger(this.config.symbol, this.config.maxShortSlots);
        this.positionLedger = positionLedger ?? this.hedgeLedger.getLegacyLedger();
        this.reusableOrderIntent.symbol = this.config.symbol;
        this.reusableOrderIntent.quantity = this.config.orderQuantity;
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
        // 1. Dynamic Monitoring: Evaluate Unrealized PnL against dynamic TP/SL thresholds across Hedge Slots
        const markPrice = askPrice > 0 ? (askPrice + bidPrice) / 2 : bidPrice;
        if (markPrice > 0) {
            const hedgeTriggers = this.hedgeLedger.evaluateHedgeDynamicTpSl(markPrice);
            if (hedgeTriggers.length > 0) {
                const trigger = hedgeTriggers[0];
                const exitSide = trigger.side === "LONG" ? "SELL" : "BUY";
                console.log(`[HEDGE_DYNAMIC_MONITORING] Slot ${trigger.slotId} ${trigger.reason} TRIGGERED! Side: ${trigger.side}, Entry: $${trigger.entryPrice.toFixed(2)}, Mark: $${markPrice.toFixed(2)}. Dispatching MARKET close with positionSide: ${trigger.side}.`);
                this.reusableOrderIntent.symbol = this.config.symbol;
                this.reusableOrderIntent.side = exitSide;
                this.reusableOrderIntent.quantity = trigger.quantity;
                this.reusableOrderIntent.price = markPrice;
                this.reusableOrderIntent.currentPositionSide = trigger.side;
                this.reusableOrderIntent.isCloseOrder = true;
                const isConfigured = this.executionClient.isConfigured();
                const riskResult = this.riskGuard.validateOrder(this.reusableOrderIntent, isConfigured, trigger.side);
                let executionPromise = undefined;
                if (riskResult.passed) {
                    executionPromise = this.executionClient
                        .placeOrder({
                        symbol: this.config.symbol,
                        side: exitSide,
                        type: "MARKET",
                        quantity: trigger.quantity,
                        positionSide: trigger.side,
                    })
                        .then((res) => {
                        if (res) {
                            if (trigger.side === "LONG") {
                                this.hedgeLedger.releaseCoreLong();
                            }
                            else if (trigger.slotId.startsWith("SHORT_SLOT_")) {
                                const sIdx = parseInt(trigger.slotId.replace("SHORT_SLOT_", ""), 10);
                                this.hedgeLedger.releaseShortSlot(sIdx);
                            }
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
        let signalType = "NONE";
        let targetPosSide = undefined;
        let targetSlotId = undefined;
        let targetSlotIndex = undefined;
        // Auto-reconcile hedge ledger slots if local position ledger is flat
        if (this.positionLedger.getSide() === "FLAT" || this.positionLedger.getNetQuantity() === 0) {
            if (this.hedgeLedger.getCoreLong().isOccupied) {
                this.hedgeLedger.releaseCoreLong();
            }
        }
        // Read Hawkes & Microburst Metrics from SAB
        const hawkesIntensity = this.client.getHawkesIntensity();
        const realizedVol = this.client.getRealizedVolatility();
        const rawShortCooldownLock = this.client.getShortCooldownLock();
        const rawLongCooldownLock = this.client.getLongCooldownLock();
        const nowMs = Date.now();
        // Defensive ceiling guard: if cooldown lock is set to a future timestamp > 60s, reset lock to 0
        const longCooldownLock = rawLongCooldownLock > nowMs + 60000 ? 0 : rawLongCooldownLock;
        const shortCooldownLock = rawShortCooldownLock > nowMs + 60000 ? 0 : rawShortCooldownLock;
        let targetSizeDecayCoeff = 1.0;
        // BUY -> Core Long Entry (allowed if Core Long is FLAT & temporal cooldown expired)
        if (obi > this.config.obiBuyThreshold &&
            cvd >= this.config.cvdBuyThreshold &&
            spreadVelocity < this.config.maxSpreadVelocity &&
            askPrice > 0 &&
            aiDirection > 0 &&
            aiConfidence >= this.config.minAiConfidence &&
            !this.hedgeLedger.getCoreLong().isOccupied &&
            nowMs >= longCooldownLock) {
            signalType = "BUY";
            targetPosSide = "LONG";
            targetSlotId = "CORE_LONG";
        }
        // SELL -> Short Slot Entry (Evaluated via Tier-1 Dynamic Slot Dispersion Engine)
        else if (obi < this.config.obiSellThreshold &&
            cvd <= this.config.cvdSellThreshold &&
            spreadVelocity < this.config.maxSpreadVelocity &&
            bidPrice > 0 &&
            aiDirection < 0 &&
            aiConfidence >= this.config.minAiConfidence) {
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
        // Apply latency penalty & slot-index decay coefficients to orderQuantity BEFORE RiskGuard check
        const scaledQuantity = Number((this.config.orderQuantity * penaltyCoeff * targetSizeDecayCoeff).toFixed(4));
        let finalQuantity = Math.max(0.0001, scaledQuantity);
        // Dynamic Taker Fallback (>75% Confidence) & 1-Tick Post-Only Offset (<=75%)
        const effectiveSlippage = Math.max(2, slippageTicks);
        const priceAdjustment = effectiveSlippage * this.config.tickSize;
        const basePrice = signalType === "BUY" ? askPrice : bidPrice;
        const isHighConfidence = aiConfidence > 0.75;
        const isAggressive = aiConfidence >= this.config.aggressiveConfidenceThreshold;
        let targetPrice;
        let orderType;
        let timeInForce;
        if (isHighConfidence) {
            orderType = isAggressive ? "MARKET" : "LIMIT";
            timeInForce = isAggressive ? "IOC" : "GTC";
            targetPrice = signalType === "BUY" ? askPrice + priceAdjustment : bidPrice - priceAdjustment;
        }
        else {
            orderType = "LIMIT";
            timeInForce = "GTX";
            targetPrice = signalType === "BUY" ? bidPrice : askPrice;
        }
        // Avellaneda-Stoikov Inventory Shift: Skew sell target higher for deeper short slots
        if (signalType === "SELL" && targetSlotIndex !== undefined && targetSlotIndex > 0) {
            targetPrice = targetPrice + targetSlotIndex * 2.0 * this.config.tickSize;
        }
        // Binance Futures Min Notional Guard: ensure order notional >= 55 USDT
        if (basePrice > 0) {
            const minNotionalUsdt = 55.0;
            if (finalQuantity * basePrice < minNotionalUsdt) {
                finalQuantity = Number((minNotionalUsdt / basePrice).toFixed(4));
            }
        }
        // Evaluate Dynamic Risk & Microstructure Trap Avoidance Profile
        const microMetrics = {
            obi,
            cvd,
            rvGk: this.client.getGarmanKlassRV(),
            vpin: this.client.getVPIN(),
            hurst: this.client.getHurstExponent(),
            lobEntropy: this.client.getLOBEntropy(),
            regime: this.client.getRegimeStateCode(),
            isSweepDetected: this.client.getIsSweepDetected(),
        };
        const riskProfile = this.dynamicRiskEngine.evaluateDynamicRisk(basePrice, targetPosSide === "LONG" ? "LONG" : "SHORT", microMetrics, Math.abs(askPrice - bidPrice));
        // Populate pre-allocated intent
        this.reusableOrderIntent.symbol = this.config.symbol;
        this.reusableOrderIntent.side = signalType;
        this.reusableOrderIntent.quantity = finalQuantity;
        this.reusableOrderIntent.price = Number(targetPrice.toFixed(2));
        this.reusableOrderIntent.currentPositionSide = targetPosSide;
        this.reusableOrderIntent.isCloseOrder = false;
        this.reusableOrderIntent.riskProfile = riskProfile;
        this.reusableOrderIntent.stopLossPrice = riskProfile.stopLossPrice;
        this.reusableOrderIntent.takeProfitPrice = riskProfile.takeProfitPrice;
        // Pass through Risk Management Guard with target position side
        const isConfigured = this.executionClient.isConfigured();
        const riskResult = this.riskGuard.validateOrder(this.reusableOrderIntent, isConfigured, targetPosSide);
        let executionPromise = undefined;
        if (riskResult.passed) {
            // Set atomic SAB hysteresis lockout (250ms cooldown per side) to suppress microburst sweeps
            if (targetPosSide === "SHORT") {
                this.client.setShortCooldownLock(Date.now() + 250);
                this.client.setLastShortFillPrice(this.reusableOrderIntent.price);
            }
            else if (targetPosSide === "LONG") {
                this.client.setLongCooldownLock(Date.now() + 250);
                this.client.setLastLongFillPrice(this.reusableOrderIntent.price);
            }
            const notional = this.reusableOrderIntent.price * this.reusableOrderIntent.quantity;
            this.riskGuard.recordExecutionSuccess(notional);
            executionPromise = this.executionClient
                .placeOrder({
                symbol: this.reusableOrderIntent.symbol,
                side: this.reusableOrderIntent.side,
                type: orderType,
                quantity: this.reusableOrderIntent.quantity,
                price: orderType === "LIMIT" ? this.reusableOrderIntent.price : undefined,
                timeInForce: timeInForce,
                positionSide: targetPosSide,
            })
                .then((res) => {
                if (res) {
                    const execPx = parseFloat(res.price || res.avgPrice || "0") || targetPrice;
                    if (targetPosSide === "LONG") {
                        this.hedgeLedger.occupyCoreLong(finalQuantity, execPx, this.config.longTakeProfitPercent, this.config.longStopLossPercent);
                    }
                    else if (targetPosSide === "SHORT" && targetSlotIndex !== undefined) {
                        this.hedgeLedger.occupyShortSlot(targetSlotIndex, finalQuantity, execPx, this.config.shortTakeProfitPercent, this.config.shortStopLossPercent);
                    }
                }
                return res;
            })
                .catch((err) => {
                console.error(`[CRITICAL_EXECUTION_ERROR] Order placement failed: ${err.message}`);
                return null;
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
