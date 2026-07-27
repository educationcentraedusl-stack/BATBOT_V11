"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionLedger = void 0;
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
     * Processes a filled order execution using FIFO lot matching.
     * Calculates closed lot Realized PnL, updates average cost basis, and returns reconciliation details.
     * Zero heap allocations during fill processing.
     */
    processFill(symbol, fillSide, fillPrice, fillQuantity, fee) {
        this.cumulativeFees += fee;
        let remainingFillQty = fillQuantity;
        let totalClosedQty = 0;
        let realizedPnlDelta = 0;
        if (this.side === "FLAT") {
            // Open new position
            this.side = fillSide === "BUY" ? "LONG" : "SHORT";
            this.netQuantity = fillQuantity;
            this.averageEntryPrice = fillPrice;
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
            if (this.netQuantity <= 1e-9) {
                // Position fully closed
                this.netQuantity = 0;
                this.averageEntryPrice = 0;
                this.side = "FLAT";
                this.lotHead = 0;
                this.lotTail = 0;
                this.lotCount = 0;
                // If fill quantity exceeded closed lots, open position on opposite side with leftover quantity
                if (remainingFillQty > 1e-9) {
                    this.side = fillSide === "BUY" ? "LONG" : "SHORT";
                    this.netQuantity = remainingFillQty;
                    this.averageEntryPrice = fillPrice;
                    this.pushLot(fillPrice, remainingFillQty);
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
    reset() {
        this.lotHead = 0;
        this.lotTail = 0;
        this.lotCount = 0;
        this.side = "FLAT";
        this.netQuantity = 0;
        this.averageEntryPrice = 0;
        this.cumulativeRealizedPnl = 0;
        this.cumulativeFees = 0;
        this.totalTrades = 0;
        this.winningTrades = 0;
        this.losingTrades = 0;
    }
}
exports.PositionLedger = PositionLedger;
