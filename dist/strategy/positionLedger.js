"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAssetPositionLedger = exports.HedgePositionLedger = exports.PositionLedger = void 0;
exports.calculatePartialExitChunk = calculatePartialExitChunk;
const dynamicSizing_1 = require("./dynamicSizing");
const DEFAULT_MAX_LOTS = 1024;
class PositionLedger {
    symbol;
    lots;
    lotHead = 0;
    lotTail = 0;
    lotCount = 0;
    maxCapacity;
    side = "FLAT";
    netQuantity = 0;
    averageEntryPrice = 0;
    positionOpenTime = 0;
    cumulativeRealizedPnl = 0;
    cumulativeFees = 0;
    totalTrades = 0;
    winningTrades = 0;
    losingTrades = 0;
    // Pre-allocated summary object for zero-GC per-tick telemetry
    cachedSummary;
    // Pre-allocated result object for zero-GC hot path return
    reconciliationResult = {
        symbol: "",
        fillSide: "BUY",
        fillPrice: 0,
        fillQuantity: 0,
        fee: 0,
        closedQuantity: 0,
        realizedPnl: 0,
        positionSideAfterFill: "FLAT",
        netQuantityAfterFill: 0,
        averageEntryPriceAfterFill: 0,
        closedTrade: undefined,
    };
    constructor(symbol = "BTCUSDT", maxCapacity = DEFAULT_MAX_LOTS) {
        this.symbol = symbol;
        this.maxCapacity = maxCapacity;
        this.lots = new Array(this.maxCapacity);
        for (let i = 0; i < this.maxCapacity; i++) {
            this.lots[i] = { price: 0, quantity: 0, timestamp: 0 };
        }
        this.reconciliationResult.symbol = symbol;
        this.cachedSummary = {
            symbol: this.symbol,
            side: "FLAT",
            netQuantity: 0,
            averageEntryPrice: 0,
            unrealizedPnl: 0,
            cumulativeRealizedPnl: 0,
            cumulativeFees: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
        };
    }
    /**
     * Synchronizes an existing active position from Binance REST API on startup.
     * Directly sets side, netQuantity, averageEntryPrice and initial FIFO lot without generating synthetic realized trade PnL.
     */
    syncActivePosition(side, netQuantity, averageEntryPrice) {
        this.reset();
        if (netQuantity > 0 && averageEntryPrice > 0) {
            this.side = side;
            this.netQuantity = netQuantity;
            this.averageEntryPrice = averageEntryPrice;
            this.positionOpenTime = Date.now();
            this.pushLot(averageEntryPrice, netQuantity);
            console.log(`[PositionLedger] Position state synced on startup: ${side} ${netQuantity} @ $${averageEntryPrice}`);
        }
    }
    /**
     * Processes a filled order execution using FIFO lot matching.
     * Calculates closed lot Realized PnL, updates average cost basis, and returns reconciliation details.
     * Zero heap allocations during fill processing.
     */
    processFill(symbol, fillSide, fillPrice, fillQuantity, fee, exitReason) {
        this.cumulativeFees += fee;
        this.reconciliationResult.closedTrade = undefined;
        let remainingFillQty = fillQuantity;
        let totalClosedQty = 0;
        let realizedPnlDelta = 0;
        const prevSide = this.side;
        const prevEntryPrice = this.averageEntryPrice;
        const prevOpenTime = this.positionOpenTime;
        if (this.side === "FLAT") {
            // Open new position
            this.side = fillSide === "BUY" ? "LONG" : "SHORT";
            this.netQuantity = fillQuantity;
            this.averageEntryPrice = fillPrice;
            this.positionOpenTime = Date.now();
            this.pushLot(fillPrice, fillQuantity);
        }
        else if ((this.side === "LONG" && fillSide === "BUY") ||
            (this.side === "SHORT" && fillSide === "SELL")) {
            // Adding to existing position on the same side
            const currentNotional = this.netQuantity * this.averageEntryPrice;
            const newNotional = fillQuantity * fillPrice;
            this.netQuantity += fillQuantity;
            this.averageEntryPrice = (currentNotional + newNotional) / this.netQuantity;
            this.pushLot(fillPrice, fillQuantity);
        }
        else {
            // Opposing side fill: closing or reducing existing position via FIFO lot matching
            while (remainingFillQty > 0 && this.lotCount > 0) {
                const lotSlot = this.lots[this.lotTail];
                const matchQty = Math.min(remainingFillQty, lotSlot.quantity);
                const lotPnl = this.side === "LONG"
                    ? (fillPrice - lotSlot.price) * matchQty
                    : (lotSlot.price - fillPrice) * matchQty;
                realizedPnlDelta += lotPnl;
                totalClosedQty += matchQty;
                remainingFillQty -= matchQty;
                lotSlot.quantity -= matchQty;
                if (lotSlot.quantity <= 1e-9) {
                    // Lot fully closed: advance tail
                    lotSlot.quantity = 0;
                    this.lotTail = (this.lotTail + 1) % this.maxCapacity;
                    this.lotCount--;
                }
            }
            this.netQuantity -= totalClosedQty;
            const isCompletelyClosed = this.netQuantity <= 1e-9;
            const wasPositionFlipped = remainingFillQty > 1e-9;
            if (isCompletelyClosed) {
                // Position fully closed
                this.netQuantity = 0;
                this.averageEntryPrice = 0;
                this.side = "FLAT";
                this.lotHead = 0;
                this.lotTail = 0;
                this.lotCount = 0;
                // If fill quantity exceeded closed lots, open position on opposite side with leftover quantity
                if (wasPositionFlipped) {
                    this.side = fillSide === "BUY" ? "LONG" : "SHORT";
                    this.netQuantity = remainingFillQty;
                    this.averageEntryPrice = fillPrice;
                    this.positionOpenTime = Date.now();
                    this.pushLot(fillPrice, remainingFillQty);
                }
                else {
                    this.positionOpenTime = 0;
                }
            }
            // Pro-rate fee for closed lot portion to maintain precise PnL accounting during lot flips
            const closedFee = fillQuantity > 0 ? fee * (totalClosedQty / fillQuantity) : 0;
            const netRealizedTradePnl = realizedPnlDelta - closedFee;
            this.cumulativeRealizedPnl += netRealizedTradePnl;
            this.totalTrades++;
            if (netRealizedTradePnl > 0) {
                this.winningTrades++;
            }
            else if (netRealizedTradePnl < 0) {
                this.losingTrades++;
            }
            // If the trade was completely closed (or flipped), record closed trade info for CSV logger
            if (totalClosedQty > 0 && (isCompletelyClosed || wasPositionFlipped) && prevSide !== "FLAT") {
                const durationMs = prevOpenTime > 0 ? Math.max(0, Date.now() - prevOpenTime) : 0;
                const roePercent = prevEntryPrice > 0
                    ? (((fillPrice - prevEntryPrice) / prevEntryPrice) * 100) * (prevSide === "LONG" ? 1 : -1)
                    : 0;
                this.reconciliationResult.closedTrade = {
                    timestamp: Date.now(),
                    symbol,
                    side: prevSide,
                    size: totalClosedQty,
                    entryPrice: prevEntryPrice,
                    exitPrice: fillPrice,
                    exitReason: exitReason || "SIGNAL_EXIT",
                    durationMs,
                    roePercent,
                    pnlUsdt: netRealizedTradePnl,
                };
            }
        }
        // Populate static result structure
        const fillClosedFee = fillQuantity > 0 ? fee * (totalClosedQty / fillQuantity) : 0;
        this.reconciliationResult.symbol = symbol;
        this.reconciliationResult.fillSide = fillSide;
        this.reconciliationResult.fillPrice = fillPrice;
        this.reconciliationResult.fillQuantity = fillQuantity;
        this.reconciliationResult.fee = fee;
        this.reconciliationResult.closedQuantity = totalClosedQty;
        this.reconciliationResult.realizedPnl = totalClosedQty > 0 ? realizedPnlDelta - fillClosedFee : 0;
        this.reconciliationResult.positionSideAfterFill = this.side;
        this.reconciliationResult.netQuantityAfterFill = this.netQuantity;
        this.reconciliationResult.averageEntryPriceAfterFill = this.averageEntryPrice;
        return this.reconciliationResult;
    }
    pushLot(price, quantity) {
        const slot = this.lots[this.lotHead];
        slot.price = price;
        slot.quantity = quantity;
        slot.timestamp = Date.now();
        this.lotHead = (this.lotHead + 1) % this.maxCapacity;
        if (this.lotCount < this.maxCapacity) {
            this.lotCount++;
        }
        else {
            // Buffer full: drop oldest lot
            this.lotTail = (this.lotTail + 1) % this.maxCapacity;
        }
    }
    /**
     * Computes floating Mark-to-Market Unrealized PnL.
     */
    getUnrealizedPnl(currentMarkPrice) {
        if (this.side === "FLAT" || this.netQuantity === 0 || currentMarkPrice <= 0) {
            return 0;
        }
        if (this.side === "LONG") {
            return (currentMarkPrice - this.averageEntryPrice) * this.netQuantity;
        }
        else {
            return (this.averageEntryPrice - currentMarkPrice) * this.netQuantity;
        }
    }
    getSummary(currentMarkPrice = 0) {
        this.cachedSummary.symbol = this.symbol;
        this.cachedSummary.side = this.side;
        this.cachedSummary.netQuantity = Number(this.netQuantity.toFixed(6));
        this.cachedSummary.averageEntryPrice = Number(this.averageEntryPrice.toFixed(4));
        this.cachedSummary.unrealizedPnl = Number(this.getUnrealizedPnl(currentMarkPrice).toFixed(4));
        this.cachedSummary.cumulativeRealizedPnl = Number(this.cumulativeRealizedPnl.toFixed(4));
        this.cachedSummary.cumulativeFees = Number(this.cumulativeFees.toFixed(4));
        this.cachedSummary.totalTrades = this.totalTrades;
        this.cachedSummary.winningTrades = this.winningTrades;
        this.cachedSummary.losingTrades = this.losingTrades;
        return this.cachedSummary;
    }
    getSide() {
        return this.side;
    }
    getNetQuantity() {
        return this.netQuantity;
    }
    getAverageEntryPrice() {
        return this.averageEntryPrice;
    }
    getPositionOpenTime() {
        return this.positionOpenTime;
    }
    reset() {
        this.lotHead = 0;
        this.lotTail = 0;
        this.lotCount = 0;
        this.side = "FLAT";
        this.netQuantity = 0;
        this.averageEntryPrice = 0;
        this.positionOpenTime = 0;
        this.cumulativeRealizedPnl = 0;
        this.cumulativeFees = 0;
        this.totalTrades = 0;
        this.winningTrades = 0;
        this.losingTrades = 0;
    }
}
exports.PositionLedger = PositionLedger;
/**
 * Calculates a partial exit chunk quantity for Binance Futures.
 * Rounds down strictly to `stepSize`.
 * FATAL GUARD: If rounded chunk is < `minQty` or notional < `minNotional`,
 * dynamically merges the chunk into higher TP tiers or returns 0 until cumulative size is valid.
 */
function calculatePartialExitChunk(currentSlotQuantity, initialSlotQuantity, percent, stepSize = 0.001, minQty = 0.001, minNotional = 5.0, markPrice = 60000.0) {
    if (currentSlotQuantity <= 0 || initialSlotQuantity <= 0)
        return 0;
    const rawChunk = initialSlotQuantity * (percent / 100.0);
    const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
    const factor = Math.pow(10, precision);
    let roundedChunk = Number((Math.floor(rawChunk * factor + 1e-9) / factor).toFixed(precision));
    roundedChunk = Math.min(roundedChunk, currentSlotQuantity);
    const notional = roundedChunk * markPrice;
    if (roundedChunk < minQty || notional < minNotional) {
        const fullNotional = currentSlotQuantity * markPrice;
        if (currentSlotQuantity >= minQty && fullNotional >= minNotional) {
            return Number(currentSlotQuantity.toFixed(precision));
        }
        return 0;
    }
    return Number(roundedChunk.toFixed(precision));
}
class HedgePositionLedger {
    symbol;
    coreLong;
    shortSlots;
    maxShortSlots;
    legacyLedger;
    sizingCalc;
    constructor(symbol = "BTCUSDT", maxShortSlots = 3) {
        this.symbol = symbol;
        this.maxShortSlots = maxShortSlots;
        this.legacyLedger = new PositionLedger(symbol);
        this.sizingCalc = new dynamicSizing_1.DynamicSizingCalculator();
        this.coreLong = {
            slotId: "CORE_LONG",
            isOccupied: false,
            side: "LONG",
            quantity: 0,
            entryPrice: 0,
            openTime: 0,
            takeProfitPrice: 0,
            stopLossPrice: 0,
            takeProfitPercent: 0,
            stopLossPercent: 0,
            activeTpOrderIds: [],
            tpStagePrices: [],
            tpStageQuantities: [],
        };
        this.shortSlots = new Array(maxShortSlots);
        for (let i = 0; i < maxShortSlots; i++) {
            this.shortSlots[i] = {
                slotId: `SHORT_SLOT_${i}`,
                isOccupied: false,
                side: "SHORT",
                quantity: 0,
                entryPrice: 0,
                openTime: 0,
                takeProfitPrice: 0,
                stopLossPrice: 0,
                takeProfitPercent: 0,
                stopLossPercent: 0,
                activeTpOrderIds: [],
                tpStagePrices: [],
                tpStageQuantities: [],
            };
        }
    }
    getSummary(currentMarkPrice = 0) {
        return this.legacyLedger.getSummary(currentMarkPrice);
    }
    /**
     * Generates batch POST_ONLY (GTX) limit TP order intents for an occupied position slot.
     * Dynamically formats 3-stage or 2-stage partial TP limit orders using DynamicSizingCalculator.
     */
    generateBatchTpOrderIntents(slotId, entryPrice, quantity, side) {
        const slot = slotId === "CORE_LONG" ? this.coreLong : this.shortSlots.find((s) => s.slotId === slotId);
        if (!slot || entryPrice <= 0 || quantity <= 0)
            return [];
        const dynamicRes = this.sizingCalc.calculateDynamicTpChunks(quantity, entryPrice);
        if (dynamicRes.chunks.length === 0)
            return [];
        const isLong = side === "LONG";
        const exitSide = isLong ? "SELL" : "BUY";
        const orderParamsList = [];
        const tpStagePrices = [];
        const tpStageQuantities = [];
        // Micro-scalp target offsets: Stage 1 = 0.25%, Stage 2 = 0.50%, Stage 3 = 1.00%
        const tpOffsets = isLong ? [0.0025, 0.0050, 0.0100] : [-0.0025, -0.0050, -0.0100];
        for (let i = 0; i < dynamicRes.chunks.length; i++) {
            const chunk = dynamicRes.chunks[i];
            const offset = tpOffsets[i] !== undefined ? tpOffsets[i] : (isLong ? 0.0025 * (i + 1) : -0.0025 * (i + 1));
            const targetPrice = Number((entryPrice * (1.0 + offset)).toFixed(2));
            tpStagePrices.push(targetPrice);
            tpStageQuantities.push(chunk.quantity);
            orderParamsList.push({
                symbol: this.symbol,
                side: exitSide,
                type: "LIMIT",
                quantity: chunk.quantity,
                price: targetPrice,
                timeInForce: "GTX", // Post-Only guarantee
                positionSide: side,
            });
        }
        slot.tpStagePrices = tpStagePrices;
        slot.tpStageQuantities = tpStageQuantities;
        slot.activeTpOrderIds = [];
        return orderParamsList;
    }
    /**
     * Registers assigned order IDs returned from Binance REST batchOrder execution into slot state.
     */
    registerActiveTpOrderIds(slotId, orderIds) {
        const slot = slotId === "CORE_LONG" ? this.coreLong : this.shortSlots.find((s) => s.slotId === slotId);
        if (slot) {
            slot.activeTpOrderIds = orderIds;
        }
    }
    /**
     * Processes a filled WebSocket POST_ONLY limit TP order update.
     * Advances tpStageReached and updates fee-adjusted Break-Even / Trailing Stop-Loss price.
     */
    processTpLimitFill(slotId, orderId, fillQuantity, fillPrice, isMaker = true) {
        const slot = slotId === "CORE_LONG" ? this.coreLong : this.shortSlots.find((s) => s.slotId === slotId);
        if (!slot || !slot.isOccupied) {
            return { isPositionClosed: true, remainingQuantity: 0, newStopLossPrice: 0 };
        }
        if (slot.activeTpOrderIds) {
            slot.activeTpOrderIds = slot.activeTpOrderIds.filter((id) => id !== orderId);
        }
        slot.quantity = Math.max(0, Number((slot.quantity - fillQuantity).toFixed(3)));
        const currentStage = (slot.tpStageReached || 0) + 1;
        slot.tpStageReached = currentStage;
        const isLong = slot.side === "LONG";
        // Advance Trailing Stop Loss
        if (currentStage === 1) {
            slot.breakEvenLocked = true;
            const makerFee = this.sizingCalc.getMakerFeeRate();
            const takerFee = this.sizingCalc.getTakerFeeRate();
            const feeBuffer = (makerFee + takerFee) * 2.5; // Fee-adjusted Break-Even
            slot.breakEvenPrice = isLong ? slot.entryPrice * (1 + feeBuffer) : slot.entryPrice * (1 - feeBuffer);
            slot.stopLossPrice = slot.breakEvenPrice;
        }
        else if (currentStage === 2 && slot.tpStagePrices && slot.tpStagePrices.length >= 1) {
            slot.stopLossPrice = slot.tpStagePrices[0];
        }
        else if (currentStage >= 3 && slot.tpStagePrices && slot.tpStagePrices.length >= 2) {
            slot.stopLossPrice = slot.tpStagePrices[1];
        }
        const isClosed = slot.quantity <= 0;
        if (isClosed) {
            if (slotId === "CORE_LONG") {
                this.releaseCoreLong();
            }
            else if (slotId.startsWith("SHORT_SLOT_")) {
                const sIdx = parseInt(slotId.replace("SHORT_SLOT_", ""), 10);
                this.releaseShortSlot(sIdx);
            }
        }
        return {
            isPositionClosed: isClosed,
            remainingQuantity: slot.quantity,
            newStopLossPrice: slot.stopLossPrice,
        };
    }
    getCoreLong() {
        return this.coreLong;
    }
    getShortSlots() {
        return this.shortSlots;
    }
    getAvailableShortSlotIndex() {
        for (let i = 0; i < this.maxShortSlots; i++) {
            if (!this.shortSlots[i].isOccupied) {
                return i;
            }
        }
        return -1;
    }
    /**
     * Tier-1 Institutional Micro-Burst Mitigation & Dynamic Slot Dispersion Engine.
     * Evaluates slot allocation eligibility using Volatility-Adjusted Dynamic Grid Spacing (VADGS)
     * and Time-Weighted Cooldown Hysteresis Lockouts (TWCHL).
     */
    evaluateDispersedShortSlotAllocation(currentPrice, tickSize = 0.1, realizedVol = 0.001, hawkesIntensity = 0, cooldownLockMs = 0, nowMs = Date.now()) {
        // 1. Enforce Temporal Cooldown Hysteresis Lockout
        if (nowMs < cooldownLockMs) {
            return null;
        }
        // 2. Locate first unoccupied slot index
        let targetIdx = -1;
        for (let i = 0; i < this.maxShortSlots; i++) {
            if (!this.shortSlots[i].isOccupied) {
                targetIdx = i;
                break;
            }
        }
        if (targetIdx === -1) {
            return null;
        }
        // First slot (k = 0) has no previous slot collision constraint
        if (targetIdx === 0) {
            return { slotIndex: 0, requiredMinSpacing: 0, sizeDecayCoeff: 1.0 };
        }
        // 3. Calculate Volatility-Adjusted Dynamic Grid Spacing ΔP_min(k)
        // ΔP_min = TickSize * max(BaseTicks, BaseTicks * VolFactor * sqrt(k) * HawkesFactor)
        const baseTicks = 5;
        const volFactor = Math.max(1.0, 1.0 + realizedVol * 100.0);
        const hawkesFactor = 1.0 + 0.25 * Math.min(10.0, hawkesIntensity);
        const requiredTicks = Math.max(baseTicks, baseTicks * volFactor * Math.sqrt(targetIdx) * hawkesFactor);
        const minSpacing = requiredTicks * tickSize;
        // 4. Verify spatial separation from all occupied short slots
        for (let i = 0; i < targetIdx; i++) {
            if (this.shortSlots[i].isOccupied) {
                const fillPrice = this.shortSlots[i].entryPrice;
                const priceDelta = Math.abs(currentPrice - fillPrice);
                if (priceDelta < minSpacing) {
                    // Spatial co-location collision! Reject multi-slot fill at identical price.
                    return null;
                }
            }
        }
        // 5. Position Sizing Decay Coefficient per slot index depth
        const decayCoeff = targetIdx === 1
            ? 0.75
            : targetIdx === 2
                ? 0.50
                : Math.max(0.25, 0.50 ** (targetIdx - 1));
        return {
            slotIndex: targetIdx,
            requiredMinSpacing: minSpacing,
            sizeDecayCoeff: decayCoeff,
        };
    }
    getActiveShortCount() {
        let count = 0;
        for (let i = 0; i < this.maxShortSlots; i++) {
            if (this.shortSlots[i].isOccupied)
                count++;
        }
        return count;
    }
    occupyCoreLong(quantity, entryPrice, tpPercent, slPercent) {
        this.coreLong.isOccupied = true;
        this.coreLong.quantity = quantity;
        this.coreLong.initialQuantity = quantity;
        this.coreLong.entryPrice = entryPrice;
        this.coreLong.openTime = Date.now();
        this.coreLong.takeProfitPercent = tpPercent;
        this.coreLong.stopLossPercent = slPercent;
        this.coreLong.tpStageReached = 0;
        this.coreLong.breakEvenLocked = false;
        const makerFee = this.sizingCalc.getMakerFeeRate();
        const takerFee = this.sizingCalc.getTakerFeeRate();
        const feeMultiplier = (makerFee + takerFee) * 2.5; // Fee-adjusted zero-loss buffer loaded from .env
        this.coreLong.breakEvenPrice = entryPrice * (1.0 + feeMultiplier);
        this.coreLong.takeProfitPrice = entryPrice * (1 + tpPercent / 100);
        this.coreLong.stopLossPrice = entryPrice * (1 - slPercent / 100);
        // 5-Stage TP Micro-Ladder Targets: 0.25%, 0.50%, 1.00%, 1.50%, 2.50% price moves (tpPercent * 1.0, 2.0, 4.0, 6.0, 10.0)
        const tp1Pct = Math.min(2.0, tpPercent * 1.0);
        const tp2Pct = Math.min(3.0, tpPercent * 2.0);
        const tp3Pct = Math.min(5.0, tpPercent * 4.0);
        const tp4Pct = Math.min(8.0, tpPercent * 6.0);
        const tp5Pct = Math.min(12.0, tpPercent * 10.0);
        this.coreLong.tpPrices = [
            entryPrice * (1 + tp1Pct / 100),
            entryPrice * (1 + tp2Pct / 100),
            entryPrice * (1 + tp3Pct / 100),
            entryPrice * (1 + tp4Pct / 100),
            entryPrice * (1 + tp5Pct / 100),
        ];
    }
    syncStartupPositions(recoveredPositions, longTpPct, longSlPct, shortTpPct, shortSlPct) {
        this.releaseCoreLong();
        for (let i = 0; i < this.maxShortSlots; i++) {
            this.releaseShortSlot(i);
        }
        let netQty = 0;
        let weightedPxSum = 0;
        let primarySide = "FLAT";
        for (const pos of recoveredPositions) {
            if (pos.quantity <= 0 || pos.entryPrice <= 0)
                continue;
            if (pos.side === "LONG") {
                this.occupyCoreLong(pos.quantity, pos.entryPrice, longTpPct, longSlPct);
                netQty += pos.quantity;
                weightedPxSum += pos.entryPrice * pos.quantity;
                primarySide = "LONG";
                console.log(`[HedgePositionLedger] Recovered Core Long Position: ${pos.quantity} @ $${pos.entryPrice.toFixed(2)} (TP: $${this.coreLong.takeProfitPrice.toFixed(2)}, SL: $${this.coreLong.stopLossPrice.toFixed(2)})`);
            }
            else if (pos.side === "SHORT") {
                const slotIdx = this.getAvailableShortSlotIndex();
                if (slotIdx >= 0) {
                    this.occupyShortSlot(slotIdx, pos.quantity, pos.entryPrice, shortTpPct, shortSlPct);
                    netQty += pos.quantity;
                    weightedPxSum += pos.entryPrice * pos.quantity;
                    primarySide = "SHORT";
                    console.log(`[HedgePositionLedger] Recovered Short Slot #${slotIdx} Position: ${pos.quantity} @ $${pos.entryPrice.toFixed(2)} (TP: $${this.shortSlots[slotIdx].takeProfitPrice.toFixed(2)}, SL: $${this.shortSlots[slotIdx].stopLossPrice.toFixed(2)})`);
                }
            }
        }
        if (primarySide !== "FLAT" && netQty > 0) {
            const avgPx = weightedPxSum / netQty;
            this.legacyLedger.syncActivePosition(primarySide, netQty, avgPx);
        }
    }
    releaseCoreLong() {
        this.coreLong.isOccupied = false;
        this.coreLong.quantity = 0;
        this.coreLong.initialQuantity = 0;
        this.coreLong.entryPrice = 0;
        this.coreLong.openTime = 0;
        this.coreLong.takeProfitPrice = 0;
        this.coreLong.stopLossPrice = 0;
        this.coreLong.tpStageReached = 0;
        this.coreLong.breakEvenLocked = false;
        this.coreLong.breakEvenPrice = 0;
        this.coreLong.tpPrices = [];
    }
    occupyShortSlot(slotIndex, quantity, entryPrice, tpPercent, slPercent) {
        if (slotIndex < 0 || slotIndex >= this.maxShortSlots)
            return false;
        const slot = this.shortSlots[slotIndex];
        if (slot.isOccupied)
            return false;
        slot.isOccupied = true;
        slot.quantity = quantity;
        slot.initialQuantity = quantity;
        slot.entryPrice = entryPrice;
        slot.openTime = Date.now();
        slot.takeProfitPercent = tpPercent;
        slot.stopLossPercent = slPercent;
        slot.tpStageReached = 0;
        slot.breakEvenLocked = false;
        const makerFee = this.sizingCalc.getMakerFeeRate();
        const takerFee = this.sizingCalc.getTakerFeeRate();
        const feeMultiplier = (makerFee + takerFee) * 2.5; // Fee-adjusted zero-loss buffer loaded from .env
        slot.breakEvenPrice = entryPrice * (1.0 - feeMultiplier);
        slot.takeProfitPrice = entryPrice * (1 - tpPercent / 100);
        slot.stopLossPrice = entryPrice * (1 + slPercent / 100);
        const tp1Pct = Math.min(2.0, tpPercent * 1.0);
        const tp2Pct = Math.min(3.0, tpPercent * 2.0);
        const tp3Pct = Math.min(5.0, tpPercent * 4.0);
        const tp4Pct = Math.min(8.0, tpPercent * 6.0);
        const tp5Pct = Math.min(12.0, tpPercent * 10.0);
        slot.tpPrices = [
            entryPrice * (1 - tp1Pct / 100),
            entryPrice * (1 - tp2Pct / 100),
            entryPrice * (1 - tp3Pct / 100),
            entryPrice * (1 - tp4Pct / 100),
            entryPrice * (1 - tp5Pct / 100),
        ];
        return true;
    }
    releaseShortSlot(slotIndex) {
        if (slotIndex < 0 || slotIndex >= this.maxShortSlots)
            return;
        const slot = this.shortSlots[slotIndex];
        slot.isOccupied = false;
        slot.quantity = 0;
        slot.initialQuantity = 0;
        slot.entryPrice = 0;
        slot.openTime = 0;
        slot.takeProfitPrice = 0;
        slot.stopLossPrice = 0;
        slot.tpStageReached = 0;
        slot.breakEvenLocked = false;
        slot.breakEvenPrice = 0;
        slot.tpPrices = [];
    }
    deductCoreLongQuantity(qty) {
        if (this.coreLong.isOccupied && qty > 0) {
            this.coreLong.quantity = Math.max(0, Number((this.coreLong.quantity - qty).toFixed(6)));
            if (this.coreLong.quantity <= 1e-6) {
                this.releaseCoreLong();
            }
        }
    }
    deductShortSlotQuantity(slotIndex, qty) {
        if (slotIndex >= 0 && slotIndex < this.maxShortSlots) {
            const slot = this.shortSlots[slotIndex];
            if (slot.isOccupied && qty > 0) {
                slot.quantity = Math.max(0, Number((slot.quantity - qty).toFixed(6)));
                if (slot.quantity <= 1e-6) {
                    this.releaseShortSlot(slotIndex);
                }
            }
        }
    }
    evaluateHedgeDynamicTpSl(markPrice, nowMs = Date.now()) {
        const triggers = [];
        if (markPrice <= 0)
            return triggers;
        const evalSlot = (slot) => {
            if (!slot.isOccupied || slot.entryPrice <= 0 || slot.quantity <= 0)
                return;
            const initialQty = slot.initialQuantity && slot.initialQuantity > 0 ? slot.initialQuantity : slot.quantity;
            const stage = slot.tpStageReached || 0;
            const isLong = slot.side === "LONG";
            const tpPrices = slot.tpPrices && slot.tpPrices.length === 5 ? slot.tpPrices : [];
            const hasActiveLimitOrders = slot.activeTpOrderIds && slot.activeTpOrderIds.length > 0;
            // 0. Evaluate 4-Tier Institutional Time-Decay Profit Lock & Harvest Timeout
            const openTime = slot.openTime && slot.openTime > 0 ? slot.openTime : nowMs;
            const holdingTimeMs = Math.max(0, nowMs - openTime);
            const makerFee = this.sizingCalc.getMakerFeeRate();
            const takerFee = this.sizingCalc.getTakerFeeRate();
            const feeBuffer = (makerFee + takerFee) * 2.5;
            // Tier 4: Hard Harvest Timeout (t >= 1800s / 30 min)
            if (holdingTimeMs >= 1800000) {
                triggers.push({
                    slotId: slot.slotId,
                    side: slot.side,
                    reason: "LONG_HOLD_PROFIT_HARVEST",
                    quantity: slot.quantity,
                    entryPrice: slot.entryPrice,
                    markPrice,
                    isPartialClose: false,
                    cancelOrderIds: slot.activeTpOrderIds ? [...slot.activeTpOrderIds] : [],
                });
                return;
            }
            // Tier 3: Guaranteed Profit Lock (t >= 600s / 10 min) -> SL = Entry + Fee + 0.12%
            if (holdingTimeMs >= 600000) {
                const lockOffset = feeBuffer + 0.0012;
                const lockedSl = isLong ? slot.entryPrice * (1.0 + lockOffset) : slot.entryPrice * (1.0 - lockOffset);
                if (isLong ? lockedSl > slot.stopLossPrice : lockedSl < slot.stopLossPrice) {
                    slot.stopLossPrice = lockedSl;
                    slot.breakEvenLocked = true;
                    slot.timeDecayTier = 3;
                }
            }
            // Tier 2: Micro-Profit Guard (t >= 180s / 3 min) -> SL = Entry + Fee + 0.05%
            else if (holdingTimeMs >= 180000) {
                const lockOffset = feeBuffer + 0.0005;
                const lockedSl = isLong ? slot.entryPrice * (1.0 + lockOffset) : slot.entryPrice * (1.0 - lockOffset);
                if (isLong ? lockedSl > slot.stopLossPrice : lockedSl < slot.stopLossPrice) {
                    slot.stopLossPrice = lockedSl;
                    slot.breakEvenLocked = true;
                    slot.timeDecayTier = 2;
                }
            }
            // Tier 1: Breakeven Lock (t >= 30s) -> SL = Entry + Fee (0 Loss)
            else if (holdingTimeMs >= 30000) {
                const lockOffset = feeBuffer;
                const lockedSl = isLong ? slot.entryPrice * (1.0 + lockOffset) : slot.entryPrice * (1.0 - lockOffset);
                if (isLong ? lockedSl > slot.stopLossPrice : lockedSl < slot.stopLossPrice) {
                    slot.stopLossPrice = lockedSl;
                    slot.breakEvenLocked = true;
                    slot.timeDecayTier = 1;
                }
            }
            // 1. Evaluate 5-Stage Partial Take Profits (ONLY if no active exchange limit TP orders are registered)
            if (!hasActiveLimitOrders && tpPrices.length === 5) {
                // TP1 (+20% ROI Target)
                if (stage < 1 && ((isLong && markPrice >= tpPrices[0]) || (!isLong && markPrice <= tpPrices[0]))) {
                    slot.tpStageReached = 1;
                    slot.breakEvenLocked = true;
                    if (slot.breakEvenPrice && slot.breakEvenPrice > 0) {
                        slot.stopLossPrice = slot.breakEvenPrice;
                    }
                    const chunk = calculatePartialExitChunk(slot.quantity, initialQty, 20, 0.001, 0.001, 5.0, markPrice);
                    if (chunk > 0) {
                        triggers.push({
                            slotId: slot.slotId,
                            side: slot.side,
                            reason: "TAKE_PROFIT_TP1",
                            quantity: chunk,
                            entryPrice: slot.entryPrice,
                            markPrice,
                            isPartialClose: chunk < slot.quantity,
                            tpStage: 1,
                        });
                        return;
                    }
                }
                // TP2 (+30% ROI Target) -> Trail SL to TP1 price
                if (stage < 2 && ((isLong && markPrice >= tpPrices[1]) || (!isLong && markPrice <= tpPrices[1]))) {
                    slot.tpStageReached = 2;
                    slot.stopLossPrice = tpPrices[0]; // Trail SL to TP1 level
                    const chunk = calculatePartialExitChunk(slot.quantity, initialQty, 20, 0.001, 0.001, 5.0, markPrice);
                    if (chunk > 0) {
                        triggers.push({
                            slotId: slot.slotId,
                            side: slot.side,
                            reason: "TAKE_PROFIT_TP2",
                            quantity: chunk,
                            entryPrice: slot.entryPrice,
                            markPrice,
                            isPartialClose: chunk < slot.quantity,
                            tpStage: 2,
                        });
                        return;
                    }
                }
                // TP3 (+50% ROI Target) -> Trail SL to TP2 price
                if (stage < 3 && ((isLong && markPrice >= tpPrices[2]) || (!isLong && markPrice <= tpPrices[2]))) {
                    slot.tpStageReached = 3;
                    slot.stopLossPrice = tpPrices[1]; // Trail SL to TP2 level
                    const chunk = calculatePartialExitChunk(slot.quantity, initialQty, 20, 0.001, 0.001, 5.0, markPrice);
                    if (chunk > 0) {
                        triggers.push({
                            slotId: slot.slotId,
                            side: slot.side,
                            reason: "TAKE_PROFIT_TP3",
                            quantity: chunk,
                            entryPrice: slot.entryPrice,
                            markPrice,
                            isPartialClose: chunk < slot.quantity,
                            tpStage: 3,
                        });
                        return;
                    }
                }
                // TP4 (+80% ROI Target) -> Trail SL to TP3 price
                if (stage < 4 && ((isLong && markPrice >= tpPrices[3]) || (!isLong && markPrice <= tpPrices[3]))) {
                    slot.tpStageReached = 4;
                    slot.stopLossPrice = tpPrices[2]; // Trail SL to TP3 level
                    const chunk = calculatePartialExitChunk(slot.quantity, initialQty, 20, 0.001, 0.001, 5.0, markPrice);
                    if (chunk > 0) {
                        triggers.push({
                            slotId: slot.slotId,
                            side: slot.side,
                            reason: "TAKE_PROFIT_TP4",
                            quantity: chunk,
                            entryPrice: slot.entryPrice,
                            markPrice,
                            isPartialClose: chunk < slot.quantity,
                            tpStage: 4,
                        });
                        return;
                    }
                }
                // TP5 (+120%+ ROI Target) -> Close remaining position
                if (stage < 5 && ((isLong && markPrice >= tpPrices[4]) || (!isLong && markPrice <= tpPrices[4]))) {
                    slot.tpStageReached = 5;
                    triggers.push({
                        slotId: slot.slotId,
                        side: slot.side,
                        reason: "TAKE_PROFIT_TP5",
                        quantity: slot.quantity,
                        entryPrice: slot.entryPrice,
                        markPrice,
                        isPartialClose: false,
                        tpStage: 5,
                    });
                    return;
                }
            }
            // 2. Evaluate Stop Loss / Fee-Adjusted Break-Even SL (ALWAYS ACTIVE)
            const isSlTriggered = isLong
                ? markPrice <= slot.stopLossPrice
                : markPrice >= slot.stopLossPrice;
            if (isSlTriggered) {
                const reason = slot.breakEvenLocked ? "BREAK_EVEN_STOP_LOSS" : "STOP_LOSS";
                triggers.push({
                    slotId: slot.slotId,
                    side: slot.side,
                    reason,
                    quantity: slot.quantity,
                    entryPrice: slot.entryPrice,
                    markPrice,
                    isPartialClose: false,
                    cancelOrderIds: slot.activeTpOrderIds ? [...slot.activeTpOrderIds] : [],
                });
                return;
            }
            // 3. Fallback Standard TP Percent Check (ONLY if no active exchange limit TP orders are registered)
            if (!hasActiveLimitOrders) {
                const pnlPct = isLong
                    ? ((markPrice - slot.entryPrice) / slot.entryPrice) * 100
                    : ((slot.entryPrice - markPrice) / slot.entryPrice) * 100;
                if (pnlPct >= slot.takeProfitPercent) {
                    triggers.push({
                        slotId: slot.slotId,
                        side: slot.side,
                        reason: "TAKE_PROFIT",
                        quantity: slot.quantity,
                        entryPrice: slot.entryPrice,
                        markPrice,
                        isPartialClose: false,
                    });
                }
            }
        };
        evalSlot(this.coreLong);
        for (let i = 0; i < this.maxShortSlots; i++) {
            evalSlot(this.shortSlots[i]);
        }
        return triggers;
    }
    getLegacyLedger() {
        return this.legacyLedger;
    }
    getUnrealizedPnl(markPrice) {
        let totalPnl = 0;
        if (markPrice <= 0)
            return 0;
        if (this.coreLong.isOccupied && this.coreLong.entryPrice > 0) {
            totalPnl += (markPrice - this.coreLong.entryPrice) * this.coreLong.quantity;
        }
        for (let i = 0; i < this.maxShortSlots; i++) {
            const slot = this.shortSlots[i];
            if (slot.isOccupied && slot.entryPrice > 0) {
                totalPnl += (slot.entryPrice - markPrice) * slot.quantity;
            }
        }
        return totalPnl;
    }
    getActiveTradeSlots(currentPrice = 0, leverage = 10, longTpPct = 2.5, longSlPct = 1.2, shortTpPct = 0.6, shortSlPct = 0.5) {
        const slots = [];
        const now = Date.now();
        // 1. Core Long
        if (this.coreLong.isOccupied && this.coreLong.quantity > 0) {
            const entryPx = this.coreLong.entryPrice;
            const px = currentPrice > 0 ? currentPrice : entryPx;
            const pnl = (px - entryPx) * this.coreLong.quantity;
            const durationMs = this.coreLong.openTime > 0 ? Math.max(0, now - this.coreLong.openTime) : 0;
            const tp = this.coreLong.takeProfitPrice > 0 ? this.coreLong.takeProfitPrice : entryPx * (1 + longTpPct / 100);
            const sl = this.coreLong.stopLossPrice > 0 ? this.coreLong.stopLossPrice : entryPx * (1 - longSlPct / 100);
            slots.push({
                symbol: this.symbol,
                side: "BUY/LONG",
                size: this.coreLong.quantity,
                entryPrice: entryPx,
                currentPrice: px,
                tpPrice: tp,
                slPrice: sl,
                leverage,
                unrealizedPnl: pnl,
                durationMs,
            });
        }
        // 2. Short Slots
        for (let i = 0; i < this.maxShortSlots; i++) {
            const slot = this.shortSlots[i];
            if (slot.isOccupied && slot.quantity > 0) {
                const entryPx = slot.entryPrice;
                const px = currentPrice > 0 ? currentPrice : entryPx;
                const pnl = (entryPx - px) * slot.quantity;
                const durationMs = slot.openTime > 0 ? Math.max(0, now - slot.openTime) : 0;
                const tp = slot.takeProfitPrice > 0 ? slot.takeProfitPrice : entryPx * (1 - shortTpPct / 100);
                const sl = slot.stopLossPrice > 0 ? slot.stopLossPrice : entryPx * (1 + shortSlPct / 100);
                slots.push({
                    symbol: this.symbol,
                    side: "SELL/SHORT",
                    size: slot.quantity,
                    entryPrice: entryPx,
                    currentPrice: px,
                    tpPrice: tp,
                    slPrice: sl,
                    leverage,
                    unrealizedPnl: pnl,
                    durationMs,
                });
            }
        }
        // 3. Fallback to legacy position ledger if core/short slots are empty but position exists
        if (slots.length === 0 && this.legacyLedger.getSide() !== "FLAT" && this.legacyLedger.getNetQuantity() > 0) {
            const legacySide = this.legacyLedger.getSide();
            const entryPx = this.legacyLedger.getAverageEntryPrice();
            const px = currentPrice > 0 ? currentPrice : entryPx;
            const size = this.legacyLedger.getNetQuantity();
            const pnl = this.legacyLedger.getUnrealizedPnl(px);
            const openTime = this.legacyLedger.getPositionOpenTime();
            const durationMs = openTime > 0 ? Math.max(0, now - openTime) : 0;
            const isLong = legacySide === "LONG";
            const tpPct = isLong ? longTpPct : shortTpPct;
            const slPct = isLong ? longSlPct : shortSlPct;
            const tp = isLong ? entryPx * (1 + tpPct / 100) : entryPx * (1 - tpPct / 100);
            const sl = isLong ? entryPx * (1 - slPct / 100) : entryPx * (1 + slPct / 100);
            slots.push({
                symbol: this.symbol,
                side: isLong ? "BUY/LONG" : "SELL/SHORT",
                size,
                entryPrice: entryPx,
                currentPrice: px,
                tpPrice: tp,
                slPrice: sl,
                leverage,
                unrealizedPnl: pnl,
                durationMs,
            });
        }
        return slots;
    }
}
exports.HedgePositionLedger = HedgePositionLedger;
class MultiAssetPositionLedger {
    ledgers = new Map();
    accountBalanceUsdt;
    constructor(symbols = [], accountBalanceUsdt = 100_000.0) {
        this.accountBalanceUsdt = accountBalanceUsdt;
        for (const sym of symbols) {
            if (sym && !this.ledgers.has(sym)) {
                this.ledgers.set(sym, new HedgePositionLedger(sym));
            }
        }
    }
    getOrCreateLedger(symbol) {
        let ledger = this.ledgers.get(symbol);
        if (!ledger) {
            ledger = new HedgePositionLedger(symbol);
            this.ledgers.set(symbol, ledger);
        }
        return ledger;
    }
    updateAccountBalance(balanceUsdt) {
        if (balanceUsdt > 0) {
            this.accountBalanceUsdt = balanceUsdt;
        }
    }
    getPortfolioSnapshot(currentPrices) {
        let totalGrossNotional = 0;
        let totalUnrealized = 0;
        let totalRealized = 0;
        const summaries = new Map();
        for (const [sym, ledger] of this.ledgers.entries()) {
            const price = currentPrices.get(sym) ?? 0;
            const summary = ledger.getSummary(price);
            summaries.set(sym, summary);
            if (summary.side !== "FLAT") {
                totalGrossNotional += summary.netQuantity * (price > 0 ? price : summary.averageEntryPrice);
                totalUnrealized += summary.unrealizedPnl;
            }
            totalRealized += summary.cumulativeRealizedPnl;
        }
        const leverage = this.accountBalanceUsdt > 0 ? totalGrossNotional / this.accountBalanceUsdt : 0;
        return {
            timestamp: Date.now(),
            totalActiveSymbols: this.ledgers.size,
            totalGrossNotionalUsdt: totalGrossNotional,
            totalUnrealizedPnlUsdt: totalUnrealized,
            totalRealizedPnlUsdt: totalRealized,
            portfolioLeverage: leverage,
            perSymbolSummaries: summaries,
        };
    }
}
exports.MultiAssetPositionLedger = MultiAssetPositionLedger;
