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
    state = "LIVE_ACTIVE";
    reusableOrderIntent = {
        symbol: process.env.SYMBOL ?? "BTCUSDT",
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
        const envMaxSpreadVelocity = process.env.MAX_SPREAD_VELOCITY ? parseFloat(process.env.MAX_SPREAD_VELOCITY) : NaN;
        const envOrderQty = process.env.ORDER_QUANTITY ? parseFloat(process.env.ORDER_QUANTITY) : NaN;
        const envLeverage = process.env.LEVERAGE ? parseInt(process.env.LEVERAGE, 10) : NaN;
        const defaultLongTp = !isNaN(envLongTp) ? envLongTp : 0.35;
        const defaultLongSl = !isNaN(envLongSl) ? envLongSl : 0.25;
        const defaultShortTp = !isNaN(envShortTp) ? envShortTp : 0.35;
        const defaultShortSl = !isNaN(envShortSl) ? envShortSl : 0.25;
        const defaultProfitLock = !isNaN(envProfitLock) ? envProfitLock : 10.0;
        const defaultMaxShortSlots = !isNaN(envMaxShortSlots) ? envMaxShortSlots : 3;
        const defaultMinAiConfidence = !isNaN(envMinAiConfidence) ? envMinAiConfidence : 0.65;
        const defaultAggressiveConfidence = !isNaN(envAggressiveConfidence) ? envAggressiveConfidence : 0.75;
        const defaultObiBuy = !isNaN(envObiBuy) ? envObiBuy : 0.35;
        const defaultObiSell = !isNaN(envObiSell) ? envObiSell : -0.35;
        const defaultCvdBuy = !isNaN(envCvdBuy) ? envCvdBuy : 0.0;
        const defaultCvdSell = !isNaN(envCvdSell) ? envCvdSell : 0.0;
        const defaultMaxSpreadVelocity = !isNaN(envMaxSpreadVelocity) ? envMaxSpreadVelocity : 5.0;
        const targetSymbol = config?.symbol ?? process.env.SYMBOL ?? "BTCUSDT";
        const defaultOrderQty = !isNaN(envOrderQty)
            ? (targetSymbol.includes("BTC") && envOrderQty > 0.01 ? 0.001 : envOrderQty)
            : (targetSymbol.includes("ETH") ? 0.05 : 0.001);
        const defaultLeverage = !isNaN(envLeverage) ? envLeverage : 10;
        this.config = {
            symbol: targetSymbol,
            orderQuantity: config?.orderQuantity ?? defaultOrderQty,
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
        };
        this.hedgeLedger = hedgeLedger ?? new positionLedger_1.HedgePositionLedger(this.config.symbol, this.config.maxShortSlots);
        this.positionLedger = positionLedger ?? this.hedgeLedger.getLegacyLedger();
        this.reusableOrderIntent.symbol = this.config.symbol;
        this.reusableOrderIntent.quantity = this.config.orderQuantity;
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
        const penaltyCoeff = latencyPenalty > 0 ? Math.max(0.75, latencyPenalty) : 1.0;
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
            return this.staticResult;
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
        // 50-25-25 Weighted Composite Signal Engine & High-Confidence AI Override
        const obiScore = Math.max(-1.0, Math.min(1.0, obi));
        const cvdScore = cvd > 0 ? 1.0 : cvd < 0 ? -1.0 : 0.0;
        const aiScore = Math.max(-1.0, Math.min(1.0, aiDirection * aiConfidence));
        // Weights: AI Model = 50% (0.50), OBI = 25% (0.25), CVD = 25% (0.25)
        const compositeScore = 0.50 * aiScore + 0.25 * obiScore + 0.25 * cvdScore;
        const isHighConfidenceAi = aiConfidence >= this.config.aggressiveConfidenceThreshold;
        let isBuySignal = false;
        let isSellSignal = false;
        if (isHighConfidenceAi) {
            // AI-Override Rule: High-confidence AI must also satisfy strict OBI directional pressure threshold (+/- 0.35)
            isBuySignal = aiDirection > 0 && obi >= this.config.obiBuyThreshold;
            isSellSignal = aiDirection < 0 && obi <= this.config.obiSellThreshold;
            if (isBuySignal || isSellSignal) {
                console.log(`[StrategyEngine][HIGH_CONFIDENCE] Seq #${seq} | Dir: ${aiDirection.toFixed(4)}, Conf: ${(aiConfidence * 100).toFixed(1)}%, OBI: ${obi.toFixed(4)}, BuySignal: ${isBuySignal}, SellSignal: ${isSellSignal}`);
            }
        }
        else {
            // Weighted Composite Rule with strict OBI directional pressure (+/- 0.35)
            isBuySignal = compositeScore > 0.12 && aiConfidence >= this.config.minAiConfidence && obi >= this.config.obiBuyThreshold;
            isSellSignal = compositeScore < -0.12 && aiConfidence >= this.config.minAiConfidence && obi <= this.config.obiSellThreshold;
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
        // Apply latency penalty & slot-index decay coefficients to orderQuantity BEFORE RiskGuard check
        const scaledQuantity = Number((this.config.orderQuantity * penaltyCoeff * targetSizeDecayCoeff).toFixed(3));
        let finalQuantity = Math.max(0.001, scaledQuantity);
        // Dynamic Taker Fallback (>75% Confidence) & 1-Tick Post-Only Offset (<=75%)
        const effectiveSlippage = Math.max(2, slippageTicks);
        const priceAdjustment = effectiveSlippage * this.config.tickSize;
        const basePrice = signalType === "BUY" ? askPrice : bidPrice;
        const isHighConfidence = aiConfidence >= this.config.aggressiveConfidenceThreshold;
        const isAggressive = isHighConfidence;
        let targetPrice;
        let orderType;
        let timeInForce;
        if (isHighConfidence) {
            orderType = "MARKET";
            timeInForce = "IOC";
            targetPrice = signalType === "BUY" ? askPrice + priceAdjustment : bidPrice - priceAdjustment;
        }
        else {
            orderType = "LIMIT";
            timeInForce = "GTX";
            targetPrice = signalType === "BUY" ? bidPrice : askPrice;
        }
        // SPREAD GUARD: Explicitly block MARKET executions if current spread > 0.50 USDT (for ETHUSDT)
        const currentSpread = askPrice > 0 && bidPrice > 0 ? Math.abs(askPrice - bidPrice) : 0;
        const maxSpreadAllowed = this.config.symbol.includes("ETH") ? 0.50 : 5.0;
        if (orderType === "MARKET" && currentSpread > maxSpreadAllowed) {
            console.log(`[StrategyEngine][SPREAD_GUARD_BLOCK] Seq #${seq} | Current Spread: ${currentSpread.toFixed(2)} USDT > ${maxSpreadAllowed.toFixed(2)} USDT threshold. MARKET execution blocked.`);
            this.staticResult.sequenceNum = seq;
            this.staticResult.signalType = "NONE";
            this.staticResult.obi = obi;
            this.staticResult.cvd = cvd;
            this.staticResult.spreadVelocity = spreadVelocity;
            this.staticResult.bidPrice = bidPrice;
            this.staticResult.askPrice = askPrice;
            this.staticResult.riskResult = {
                passed: false,
                reasonCode: "REJECTED_LIQUIDITY_SWEEP_TRAP",
                message: `Market execution blocked: current spread (${currentSpread.toFixed(2)} USDT) > ${maxSpreadAllowed.toFixed(2)} USDT threshold`,
            };
            this.staticResult.executionPromise = undefined;
            return this.staticResult;
        }
        // Avellaneda-Stoikov Inventory Shift: Skew sell target higher for deeper short slots
        if (signalType === "SELL" && targetSlotIndex !== undefined && targetSlotIndex > 0) {
            targetPrice = targetPrice + targetSlotIndex * 2.0 * this.config.tickSize;
        }
        // Binance Futures Min Notional Guard: ensure order notional >= 55 USDT
        if (basePrice > 0) {
            const minNotionalUsdt = 55.0;
            if (finalQuantity * basePrice < minNotionalUsdt) {
                finalQuantity = Number((minNotionalUsdt / basePrice).toFixed(3));
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
        riskProfile.isHighConfidenceAi = isHighConfidenceAi;
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
        if (!riskResult.passed) {
            console.log(`[StrategyEngine][RISK_REJECTED] Seq #${seq} | Reason: ${riskResult.reasonCode} - ${riskResult.message}`);
        }
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
                    this.riskGuard.recordExecutionSuccess(notional);
                    console.log(`[BinanceExecution][SUCCESS] Order Executed on Binance! OrderId: ${res.orderId}, Status: ${res.status}, ExecQty: ${res.executedQty}`);
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
                console.error(`[BinanceExecution][REJECTED] Order Placement Failed: ${err.message}`);
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
