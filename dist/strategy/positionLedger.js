"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HedgePositionLedger = exports.PositionLedger = void 0;
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
class HedgePositionLedger {
    symbol;
    coreLong;
    shortSlots;
    maxShortSlots;
    legacyLedger;
    constructor(symbol = "BTCUSDT", maxShortSlots = 3) {
        this.symbol = symbol;
        this.maxShortSlots = maxShortSlots;
        this.legacyLedger = new PositionLedger(symbol);
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
            };
        }
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
        this.coreLong.entryPrice = entryPrice;
        this.coreLong.openTime = Date.now();
        this.coreLong.takeProfitPercent = tpPercent;
        this.coreLong.stopLossPercent = slPercent;
        this.coreLong.takeProfitPrice = entryPrice * (1 + tpPercent / 100);
        this.coreLong.stopLossPrice = entryPrice * (1 - slPercent / 100);
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
        this.coreLong.entryPrice = 0;
        this.coreLong.openTime = 0;
        this.coreLong.takeProfitPrice = 0;
        this.coreLong.stopLossPrice = 0;
    }
    occupyShortSlot(slotIndex, quantity, entryPrice, tpPercent, slPercent) {
        if (slotIndex < 0 || slotIndex >= this.maxShortSlots)
            return false;
        const slot = this.shortSlots[slotIndex];
        if (slot.isOccupied)
            return false;
        slot.isOccupied = true;
        slot.quantity = quantity;
        slot.entryPrice = entryPrice;
        slot.openTime = Date.now();
        slot.takeProfitPercent = tpPercent;
        slot.stopLossPercent = slPercent;
        slot.takeProfitPrice = entryPrice * (1 - tpPercent / 100);
        slot.stopLossPrice = entryPrice * (1 + slPercent / 100);
        return true;
    }
    releaseShortSlot(slotIndex) {
        if (slotIndex < 0 || slotIndex >= this.maxShortSlots)
            return;
        const slot = this.shortSlots[slotIndex];
        slot.isOccupied = false;
        slot.quantity = 0;
        slot.entryPrice = 0;
        slot.openTime = 0;
        slot.takeProfitPrice = 0;
        slot.stopLossPrice = 0;
    }
    evaluateHedgeDynamicTpSl(markPrice) {
        const triggers = [];
        if (markPrice <= 0)
            return triggers;
        // 1. Evaluate Core Long
        if (this.coreLong.isOccupied && this.coreLong.entryPrice > 0) {
            const pnlPct = ((markPrice - this.coreLong.entryPrice) / this.coreLong.entryPrice) * 100;
            if (pnlPct >= this.coreLong.takeProfitPercent) {
                triggers.push({
                    slotId: this.coreLong.slotId,
                    side: "LONG",
                    reason: "TAKE_PROFIT",
                    quantity: this.coreLong.quantity,
                    entryPrice: this.coreLong.entryPrice,
                    markPrice,
                });
            }
            else if (pnlPct <= -this.coreLong.stopLossPercent) {
                triggers.push({
                    slotId: this.coreLong.slotId,
                    side: "LONG",
                    reason: "STOP_LOSS",
                    quantity: this.coreLong.quantity,
                    entryPrice: this.coreLong.entryPrice,
                    markPrice,
                });
            }
        }
        // 2. Evaluate Short Slots
        for (let i = 0; i < this.maxShortSlots; i++) {
            const slot = this.shortSlots[i];
            if (slot.isOccupied && slot.entryPrice > 0) {
                const pnlPct = ((slot.entryPrice - markPrice) / slot.entryPrice) * 100;
                if (pnlPct >= slot.takeProfitPercent) {
                    triggers.push({
                        slotId: slot.slotId,
                        side: "SHORT",
                        reason: "TAKE_PROFIT",
                        quantity: slot.quantity,
                        entryPrice: slot.entryPrice,
                        markPrice,
                    });
                }
                else if (pnlPct <= -slot.stopLossPercent) {
                    triggers.push({
                        slotId: slot.slotId,
                        side: "SHORT",
                        reason: "STOP_LOSS",
                        quantity: slot.quantity,
                        entryPrice: slot.entryPrice,
                        markPrice,
                    });
                }
            }
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
