"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAssetPositionLedger = exports.HedgePositionLedger = exports.PositionLedger = void 0;
exports.calculatePartialExitChunk = calculatePartialExitChunk;
const dynamicSizing_1 = require("./dynamicSizing");
const clientOrderIdGenerator_1 = require("../execution/clientOrderIdGenerator");
const symbolPrecision_1 = require("../config/symbolPrecision");
const tradingSymbols_1 = require("../config/tradingSymbols");
let nativeAddon = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    nativeAddon = require("../../index.js");
}
catch {
    // Safe fallback
}
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
    cumulativeFundingFees = 0;
    cumulativeCommissions = 0;
    reconciledWalletBalance = 0;
    activeStepCollarTier = 0;
    totalTrades = 0;
    winningTrades = 0;
    losingTrades = 0;
    leverage = parseInt(process.env.LEVERAGE || "10", 10);
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
        this.reset();
        this.cachedSummary = {
            symbol: this.symbol,
            side: "FLAT",
            netQuantity: 0,
            longQuantity: 0,
            shortQuantity: 0,
            grossQuantity: 0,
            averageEntryPrice: 0,
            longAverageEntryPrice: 0,
            shortAverageEntryPrice: 0,
            longUnrealizedPnl: 0,
            shortUnrealizedPnl: 0,
            unrealizedPnl: 0,
            cumulativeRealizedPnl: 0,
            cumulativeFees: 0,
            cumulativeFundingFees: 0,
            cumulativeCommissions: 0,
            reconciledWalletBalance: 0,
            activeStepCollarTier: 0,
            roePercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            leverage: this.leverage,
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
        this.cachedSummary.longQuantity = this.side === "LONG" ? Number(this.netQuantity.toFixed(6)) : 0;
        this.cachedSummary.shortQuantity = this.side === "SHORT" ? Number(this.netQuantity.toFixed(6)) : 0;
        this.cachedSummary.grossQuantity = Number(this.netQuantity.toFixed(6));
        this.cachedSummary.averageEntryPrice = Number(this.averageEntryPrice.toFixed(4));
        this.cachedSummary.longAverageEntryPrice = this.side === "LONG" ? Number(this.averageEntryPrice.toFixed(4)) : 0;
        this.cachedSummary.shortAverageEntryPrice = this.side === "SHORT" ? Number(this.averageEntryPrice.toFixed(4)) : 0;
        const uPnl = this.getUnrealizedPnl(currentMarkPrice);
        let roePercent = 0;
        if (this.netQuantity > 0 && this.averageEntryPrice > 0 && currentMarkPrice > 0) {
            if (this.side === "LONG") {
                roePercent = ((currentMarkPrice - this.averageEntryPrice) / this.averageEntryPrice) * this.leverage * 100;
            }
            else if (this.side === "SHORT") {
                roePercent = ((this.averageEntryPrice - currentMarkPrice) / this.averageEntryPrice) * this.leverage * 100;
            }
        }
        this.cachedSummary.longUnrealizedPnl = this.side === "LONG" ? Number(uPnl.toFixed(4)) : 0;
        this.cachedSummary.shortUnrealizedPnl = this.side === "SHORT" ? Number(uPnl.toFixed(4)) : 0;
        this.cachedSummary.unrealizedPnl = Number(uPnl.toFixed(4));
        this.cachedSummary.cumulativeRealizedPnl = Number(this.cumulativeRealizedPnl.toFixed(4));
        this.cachedSummary.cumulativeFees = Number(this.cumulativeFees.toFixed(4));
        this.cachedSummary.cumulativeFundingFees = Number(this.cumulativeFundingFees.toFixed(4));
        this.cachedSummary.cumulativeCommissions = Number(this.cumulativeCommissions.toFixed(4));
        this.cachedSummary.reconciledWalletBalance = Number(this.reconciledWalletBalance.toFixed(2));
        this.cachedSummary.activeStepCollarTier = this.activeStepCollarTier;
        this.cachedSummary.roePercent = Number(roePercent.toFixed(2));
        this.cachedSummary.totalTrades = this.totalTrades;
        this.cachedSummary.winningTrades = this.winningTrades;
        this.cachedSummary.losingTrades = this.losingTrades;
        this.cachedSummary.leverage = this.leverage;
        return this.cachedSummary;
    }
    recordFundingFee(amount, symbol) {
        if (!Number.isFinite(amount))
            return;
        this.cumulativeFundingFees += amount;
        this.cumulativeRealizedPnl += amount;
    }
    recordExactCommission(amount) {
        if (!Number.isFinite(amount) || amount < 0)
            return;
        this.cumulativeCommissions += amount;
    }
    setReconciledWalletBalance(balance) {
        if (Number.isFinite(balance)) {
            this.reconciledWalletBalance = balance;
        }
    }
    setActiveStepCollarTier(tier) {
        this.activeStepCollarTier = tier;
    }
    getCumulativeFundingFees() {
        return this.cumulativeFundingFees;
    }
    getCumulativeCommissions() {
        return this.cumulativeCommissions;
    }
    getReconciledWalletBalance() {
        return this.reconciledWalletBalance;
    }
    getActiveStepCollarTier() {
        return this.activeStepCollarTier;
    }
    setLeverage(leverage) {
        if (Number.isFinite(leverage) && leverage > 0) {
            this.leverage = leverage;
            this.cachedSummary.leverage = leverage;
        }
    }
    getLeverage() {
        return this.leverage;
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
 * Implements SOTA 5-Layer Mathematical Guard Architecture against IEEE 754 Zero-Division, NaN,
 * sub-normal step sizes, log exponent overflows, and non-power-of-10 tick sizes.
 */
function calculatePartialExitChunk(currentSlotQuantity, initialSlotQuantity, percent, stepSize = 0.001, minQty = 0.001, minNotional = 5.0, markPrice = 60000.0) {
    // Layer 1: Pre-Math Input Sanitization & Clamping Boundary
    if (!Number.isFinite(currentSlotQuantity) || currentSlotQuantity <= 0 ||
        !Number.isFinite(initialSlotQuantity) || initialSlotQuantity <= 0 ||
        !Number.isFinite(markPrice) || markPrice <= 0 ||
        !Number.isFinite(percent) || percent <= 0) {
        return 0;
    }
    const safePercent = Math.min(100.0, percent);
    const safeStepSize = (Number.isFinite(stepSize) && stepSize > 0) ? stepSize : 0.001;
    const safeMinQty = (Number.isFinite(minQty) && minQty > 0) ? minQty : safeStepSize;
    const safeMinNotional = (Number.isFinite(minNotional) && minNotional >= 0) ? minNotional : 5.0;
    // Layer 2: Safe Precision Derivation Engine (Guaranteed 0 <= precision <= 8)
    let precision = 3;
    if (Number.isFinite(safeStepSize) && safeStepSize > 0) {
        const str = safeStepSize.toString();
        if (str.includes("e") || str.includes("E")) {
            const ePos = str.toLowerCase().indexOf("e");
            const exp = parseInt(str.slice(ePos + 1), 10);
            if (exp < 0)
                precision = Math.min(8, Math.abs(exp));
        }
        else {
            const decimalIdx = str.indexOf(".");
            if (decimalIdx !== -1) {
                precision = Math.min(8, Math.max(0, str.length - decimalIdx - 1));
            }
            else {
                const logPrec = Math.round(-Math.log10(safeStepSize));
                precision = Math.min(8, Math.max(0, logPrec));
            }
        }
    }
    const factor = Math.pow(10, precision);
    // Layer 3: Exact Step-Size Quantization Math (Modulo/Division-Based Multiples)
    const rawChunk = initialSlotQuantity * (safePercent / 100.0);
    const units = Math.floor((rawChunk + 1e-12) / safeStepSize);
    const quantizedChunk = units * safeStepSize;
    let roundedChunk = Math.floor(quantizedChunk * factor + 1e-9) / factor;
    roundedChunk = Math.min(roundedChunk, currentSlotQuantity);
    // Layer 4: Binance Lot Size Trap & Merge Protection
    const notional = roundedChunk * markPrice;
    if (roundedChunk < safeMinQty || notional < safeMinNotional) {
        const fullNotional = currentSlotQuantity * markPrice;
        if (currentSlotQuantity >= safeMinQty && fullNotional >= safeMinNotional) {
            const mergedVal = Number(currentSlotQuantity.toFixed(precision));
            return Number.isFinite(mergedVal) && mergedVal > 0 ? mergedVal : 0;
        }
        return 0;
    }
    // Layer 5: Safe Fixed-Precision Output Formatting Boundary
    const finalResult = Number(roundedChunk.toFixed(precision));
    return Number.isFinite(finalResult) && finalResult >= 0 ? finalResult : 0;
}
class HedgePositionLedger {
    symbol;
    coreLong;
    shortSlots;
    maxShortSlots;
    legacyLedger;
    sizingCalc;
    cachedSummary;
    // Native zero-GC cumulative trade accounting counters
    cumulativeRealizedPnl = 0;
    cumulativeFees = 0;
    cumulativeFundingFees = 0;
    cumulativeCommissions = 0;
    reconciledWalletBalance = 0;
    activeStepCollarTier = 0;
    totalTrades = 0;
    winningTrades = 0;
    losingTrades = 0;
    leverage = parseInt(process.env.LEVERAGE || "10", 10);
    highWaterMarkPnl = 0;
    sessionDrawdownPnl = 0;
    // Zero-GC Pre-allocated Reusable SOTA Exit Triggers Array & Slots
    sotaTriggers = [];
    preallocatedTriggers = Array.from({ length: 8 }, () => ({
        slotId: "",
        side: "LONG",
        reason: "",
        quantity: 0,
        entryPrice: 0,
        markPrice: 0,
        isPartialClose: false,
        cancelOrderIds: undefined,
    }));
    priceTickSize;
    invPriceTickSize;
    priceFactor;
    feeMultiplier;
    cachedAggregatedLongSummary = {
        isOccupied: false,
        totalQuantity: 0,
        vwapEntryPrice: 0,
        stopLossPrice: 0,
        takeProfitPrice: 0,
        breakEvenPrice: 0,
        activeStopLossOrderId: 0,
        activeTpOrderIds: [],
        slotIds: ["CORE_LONG"],
    };
    cachedAggregatedShortSummary = {
        isOccupied: false,
        totalQuantity: 0,
        vwapEntryPrice: 0,
        stopLossPrice: 0,
        takeProfitPrice: 0,
        breakEvenPrice: 0,
        activeStopLossOrderId: 0,
        activeTpOrderIds: [],
        slotIds: [],
    };
    shortAggregatedStopLossOrderId = 0;
    shortAggregatedLastSyncedSlPrice = 0;
    constructor(symbol = "BTCUSDT", maxShortSlots = 3) {
        this.symbol = symbol;
        this.maxShortSlots = maxShortSlots;
        this.legacyLedger = new PositionLedger(symbol);
        this.sizingCalc = new dynamicSizing_1.DynamicSizingCalculator();
        const rule = symbolPrecision_1.SymbolPrecisionRegistry.getPrecisionRule(symbol);
        this.priceTickSize = rule.tickSize;
        this.invPriceTickSize = 1.0 / rule.tickSize;
        this.priceFactor = Math.pow(10, rule.priceDecimals);
        this.feeMultiplier = (this.sizingCalc.getMakerFeeRate() + this.sizingCalc.getTakerFeeRate()) * 2.5;
        this.cachedSummary = {
            symbol: this.symbol,
            side: "FLAT",
            netQuantity: 0,
            longQuantity: 0,
            shortQuantity: 0,
            grossQuantity: 0,
            averageEntryPrice: 0,
            longAverageEntryPrice: 0,
            shortAverageEntryPrice: 0,
            longUnrealizedPnl: 0,
            shortUnrealizedPnl: 0,
            unrealizedPnl: 0,
            cumulativeRealizedPnl: 0,
            cumulativeFees: 0,
            cumulativeFundingFees: 0,
            cumulativeCommissions: 0,
            reconciledWalletBalance: 0,
            activeStepCollarTier: 0,
            roePercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            leverage: this.leverage,
        };
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
    reset() {
        this.releaseCoreLong();
        for (let i = 0; i < this.maxShortSlots; i++) {
            this.releaseShortSlot(i);
        }
        this.legacyLedger.reset();
    }
    getSizingCalculator() {
        return this.sizingCalc;
    }
    /**
     * Centralized Zero-GC Trade Exit & Realized PnL Accounting Record.
     * Computes gross PnL, fee drag, updates win/loss tallies, and accumulates cumulative realized metrics.
     * When exactRealizedPnl and/or exactCommission are provided (from Binance REST userTrades),
     * applies exact micro-cent exchange reconciliation.
     */
    recordRealizedExit(slotSide, entryPrice, exitPrice, closedQty, exitFeeRate, exitReason = "SIGNAL_EXIT", exactRealizedPnl, exactCommission) {
        if (closedQty <= 0 || entryPrice <= 0 || exitPrice <= 0)
            return;
        const takerFee = this.sizingCalc.getTakerFeeRate();
        const feeRate = exitFeeRate !== undefined ? exitFeeRate : takerFee;
        const grossPnl = slotSide === "LONG"
            ? (exitPrice - entryPrice) * closedQty
            : (entryPrice - exitPrice) * closedQty;
        const entryFeeUsdt = entryPrice * closedQty * takerFee;
        const exitFeeUsdt = exitPrice * closedQty * feeRate;
        const computedFee = entryFeeUsdt + exitFeeUsdt;
        const totalFee = (exactCommission !== undefined && Number.isFinite(exactCommission) && exactCommission >= 0)
            ? exactCommission
            : computedFee;
        const netTradePnl = (exactRealizedPnl !== undefined && Number.isFinite(exactRealizedPnl))
            ? exactRealizedPnl
            : (grossPnl - totalFee);
        this.cumulativeRealizedPnl += netTradePnl;
        this.cumulativeFees += totalFee;
        this.totalTrades++;
        if (this.cumulativeRealizedPnl > this.highWaterMarkPnl) {
            this.highWaterMarkPnl = this.cumulativeRealizedPnl;
            this.sessionDrawdownPnl = 0;
        }
        else {
            this.sessionDrawdownPnl = this.highWaterMarkPnl - this.cumulativeRealizedPnl;
        }
        if (netTradePnl > 0) {
            this.winningTrades++;
        }
        else if (netTradePnl < 0) {
            this.losingTrades++;
        }
        try {
            if (nativeAddon && typeof nativeAddon.recordTradeIc === "function") {
                const realizedReturn = slotSide === "LONG"
                    ? (exitPrice - entryPrice) / entryPrice
                    : (entryPrice - exitPrice) / entryPrice;
                const dir = slotSide === "LONG" ? 1.0 : -1.0;
                const syms = (0, tradingSymbols_1.getTradingSymbols)();
                const assetIdx = Math.max(0, syms.indexOf(this.symbol));
                nativeAddon.recordTradeIc(dir, realizedReturn, assetIdx);
            }
        }
        catch {
            // Safe non-blocking execution
        }
    }
    getSessionDrawdown() {
        return this.sessionDrawdownPnl;
    }
    getHighWaterMark() {
        return this.highWaterMarkPnl;
    }
    getSummary(currentMarkPrice = 0) {
        let longQty = 0;
        let shortQty = 0;
        let longEntrySum = 0;
        let shortEntrySum = 0;
        if (this.coreLong.isOccupied && this.coreLong.quantity > 0) {
            longQty += this.coreLong.quantity;
            longEntrySum += this.coreLong.entryPrice * this.coreLong.quantity;
        }
        for (let i = 0; i < this.maxShortSlots; i++) {
            const slot = this.shortSlots[i];
            if (slot.isOccupied && slot.quantity > 0) {
                shortQty += slot.quantity;
                shortEntrySum += slot.entryPrice * slot.quantity;
            }
        }
        let side = "FLAT";
        if (longQty > 1e-9 && shortQty > 1e-9) {
            side = "BOTH";
        }
        else if (longQty > 1e-9) {
            side = "LONG";
        }
        else if (shortQty > 1e-9) {
            side = "SHORT";
        }
        const netQty = longQty - shortQty;
        const totalPosQty = longQty + shortQty;
        const longAvgEntry = longQty > 0 ? (this.coreLong.isOccupied ? this.coreLong.entryPrice : 0) : 0;
        const shortAvgEntry = shortQty > 0 ? shortEntrySum / shortQty : 0;
        const blendedAvgEntry = totalPosQty > 0 ? (longEntrySum + shortEntrySum) / totalPosQty : 0;
        let longUnrealized = 0;
        if (longQty > 0 && currentMarkPrice > 0 && longAvgEntry > 0) {
            longUnrealized = (currentMarkPrice - longAvgEntry) * longQty;
        }
        let shortUnrealized = 0;
        if (shortQty > 0 && currentMarkPrice > 0 && shortAvgEntry > 0) {
            shortUnrealized = (shortAvgEntry - currentMarkPrice) * shortQty;
        }
        const totalUnrealized = longUnrealized + shortUnrealized;
        let roePercent = 0;
        if (longQty > 0 && currentMarkPrice > 0 && longAvgEntry > 0) {
            roePercent = ((currentMarkPrice - longAvgEntry) / longAvgEntry) * this.leverage * 100;
        }
        else if (shortQty > 0 && currentMarkPrice > 0 && shortAvgEntry > 0) {
            roePercent = ((shortAvgEntry - currentMarkPrice) / shortAvgEntry) * this.leverage * 100;
        }
        this.cachedSummary.symbol = this.symbol;
        this.cachedSummary.side = side;
        this.cachedSummary.netQuantity = Number(netQty.toFixed(6));
        this.cachedSummary.longQuantity = Number(longQty.toFixed(6));
        this.cachedSummary.shortQuantity = Number(shortQty.toFixed(6));
        this.cachedSummary.grossQuantity = Number(totalPosQty.toFixed(6));
        this.cachedSummary.averageEntryPrice = Number(blendedAvgEntry.toFixed(4));
        this.cachedSummary.longAverageEntryPrice = Number(longAvgEntry.toFixed(4));
        this.cachedSummary.shortAverageEntryPrice = Number(shortAvgEntry.toFixed(4));
        this.cachedSummary.longUnrealizedPnl = Number(longUnrealized.toFixed(4));
        this.cachedSummary.shortUnrealizedPnl = Number(shortUnrealized.toFixed(4));
        this.cachedSummary.unrealizedPnl = Number(totalUnrealized.toFixed(4));
        this.cachedSummary.cumulativeRealizedPnl = Number(this.cumulativeRealizedPnl.toFixed(4));
        this.cachedSummary.cumulativeFees = Number(this.cumulativeFees.toFixed(4));
        this.cachedSummary.cumulativeFundingFees = Number(this.cumulativeFundingFees.toFixed(4));
        this.cachedSummary.cumulativeCommissions = Number(this.cumulativeCommissions.toFixed(4));
        this.cachedSummary.reconciledWalletBalance = Number(this.reconciledWalletBalance.toFixed(2));
        this.cachedSummary.activeStepCollarTier = this.activeStepCollarTier;
        this.cachedSummary.roePercent = Number(roePercent.toFixed(2));
        this.cachedSummary.totalTrades = this.totalTrades;
        this.cachedSummary.winningTrades = this.winningTrades;
        this.cachedSummary.losingTrades = this.losingTrades;
        this.cachedSummary.leverage = this.leverage;
        return this.cachedSummary;
    }
    recordFundingFee(amount, symbol) {
        if (!Number.isFinite(amount))
            return;
        this.cumulativeFundingFees += amount;
        this.cumulativeRealizedPnl += amount;
        if (this.cumulativeRealizedPnl > this.highWaterMarkPnl) {
            this.highWaterMarkPnl = this.cumulativeRealizedPnl;
            this.sessionDrawdownPnl = 0;
        }
        else {
            this.sessionDrawdownPnl = this.highWaterMarkPnl - this.cumulativeRealizedPnl;
        }
        this.legacyLedger.recordFundingFee(amount, symbol);
    }
    recordExactCommission(amount) {
        if (!Number.isFinite(amount) || amount < 0)
            return;
        this.cumulativeCommissions += amount;
        this.legacyLedger.recordExactCommission(amount);
    }
    setReconciledWalletBalance(balance) {
        if (Number.isFinite(balance)) {
            this.reconciledWalletBalance = balance;
            this.legacyLedger.setReconciledWalletBalance(balance);
        }
    }
    setActiveStepCollarTier(tier) {
        this.activeStepCollarTier = tier;
        this.legacyLedger.setActiveStepCollarTier(tier);
    }
    getCumulativeFundingFees() {
        return this.cumulativeFundingFees;
    }
    getCumulativeCommissions() {
        return this.cumulativeCommissions;
    }
    getReconciledWalletBalance() {
        return this.reconciledWalletBalance;
    }
    getActiveStepCollarTier() {
        return this.activeStepCollarTier;
    }
    setLeverage(leverage) {
        if (Number.isFinite(leverage) && leverage > 0) {
            this.leverage = leverage;
            this.cachedSummary.leverage = leverage;
            this.legacyLedger.setLeverage(leverage);
        }
    }
    getLeverage() {
        return this.leverage;
    }
    /**
     * Generates batch POST_ONLY (GTX) limit TP order intents for an occupied position slot.
     * Dynamically formats 3-stage or 2-stage partial TP limit orders using DynamicSizingCalculator.
     */
    generateBatchTpOrderIntents(slotId, entryPrice, quantity, side) {
        const slot = slotId === "CORE_LONG" ? this.coreLong : this.shortSlots.find((s) => s.slotId === slotId);
        if (!slot || entryPrice <= 0 || quantity <= 0)
            return [];
        const rule = symbolPrecision_1.SymbolPrecisionRegistry.getPrecisionRule(this.symbol);
        const dynamicRes = this.sizingCalc.calculateDynamicTpChunks(quantity, entryPrice, rule.qtyDecimals);
        if (dynamicRes.chunks.length === 0)
            return [];
        const isLong = side === "LONG";
        const exitSide = isLong ? "SELL" : "BUY";
        const orderParamsList = [];
        const tpStagePrices = [];
        const tpStageQuantities = [];
        // SOTA Dynamic Friction Clearance Offsets:
        // Stage 1 MUST clear round-trip fees (maker+taker or 2x maker) + MIN_NET_ALPHA.
        const minNetAlpha = this.sizingCalc.getMinNetAlpha();
        const makerFee = this.sizingCalc.getMakerFeeRate();
        const takerFee = this.sizingCalc.getTakerFeeRate();
        const stage1Offset = Math.max(0.0035, makerFee + takerFee + minNetAlpha);
        const stage2Offset = Math.max(0.0065, stage1Offset * 1.8);
        const stage3Offset = Math.max(0.0120, stage1Offset * 3.2);
        const tpOffsets = isLong
            ? [stage1Offset, stage2Offset, stage3Offset]
            : [-stage1Offset, -stage2Offset, -stage3Offset];
        const effectiveDecimals = Math.max(rule.qtyDecimals, (String(quantity).split(".")[1] || "").length);
        let allocatedQty = 0;
        for (let i = 0; i < dynamicRes.chunks.length; i++) {
            const chunk = dynamicRes.chunks[i];
            const isLast = i === dynamicRes.chunks.length - 1;
            const offset = tpOffsets[i] !== undefined ? tpOffsets[i] : (isLong ? stage1Offset * (i + 1) : -stage1Offset * (i + 1));
            const targetPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1.0 + offset));
            const chunkQty = isLast ? Number((quantity - allocatedQty).toFixed(effectiveDecimals)) : chunk.quantity;
            if (chunkQty <= 0)
                continue;
            allocatedQty = Number((allocatedQty + chunkQty).toFixed(effectiveDecimals));
            tpStagePrices.push(targetPrice);
            tpStageQuantities.push(chunkQty);
            const tpCid = clientOrderIdGenerator_1.ClientOrderIdGenerator.generate(this.symbol, slotId, `TP${i + 1}`);
            orderParamsList.push({
                symbol: this.symbol,
                side: exitSide,
                type: "LIMIT",
                quantity: chunkQty,
                price: targetPrice,
                timeInForce: "GTX", // Post-Only guarantee
                positionSide: side,
                clientOrderId: tpCid,
            });
        }
        slot.tpStagePrices = tpStagePrices;
        slot.tpStageQuantities = tpStageQuantities;
        slot.activeTpOrderIds = [];
        return orderParamsList;
    }
    /**
     * Generates batch Take-Profit limit order intents covering 100% of the aggregated position size
     * anchored to the true Volume-Weighted Average Entry Price (VWAP).
     */
    generateAggregatedBatchTpIntents(side, aggregatedQty, vwapEntryPrice, targetSlotId) {
        if (vwapEntryPrice <= 0 || aggregatedQty <= 0)
            return [];
        const primarySlotId = targetSlotId || (side === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0");
        const rule = symbolPrecision_1.SymbolPrecisionRegistry.getPrecisionRule(this.symbol);
        const dynamicRes = this.sizingCalc.calculateDynamicTpChunks(aggregatedQty, vwapEntryPrice, rule.qtyDecimals);
        if (dynamicRes.chunks.length === 0)
            return [];
        const isLong = side === "LONG";
        const exitSide = isLong ? "SELL" : "BUY";
        const orderParamsList = [];
        const tpStagePrices = [];
        const tpStageQuantities = [];
        const minNetAlpha = this.sizingCalc.getMinNetAlpha();
        const makerFee = this.sizingCalc.getMakerFeeRate();
        const takerFee = this.sizingCalc.getTakerFeeRate();
        const stage1Offset = Math.max(0.0035, makerFee + takerFee + minNetAlpha);
        const stage2Offset = Math.max(0.0065, stage1Offset * 1.8);
        const stage3Offset = Math.max(0.0120, stage1Offset * 3.2);
        const tpOffsets = isLong
            ? [stage1Offset, stage2Offset, stage3Offset]
            : [-stage1Offset, -stage2Offset, -stage3Offset];
        const effectiveDecimals = Math.max(rule.qtyDecimals, (String(aggregatedQty).split(".")[1] || "").length);
        let allocatedQty = 0;
        for (let i = 0; i < dynamicRes.chunks.length; i++) {
            const chunk = dynamicRes.chunks[i];
            const isLast = i === dynamicRes.chunks.length - 1;
            const offset = tpOffsets[i] !== undefined ? tpOffsets[i] : (isLong ? stage1Offset * (i + 1) : -stage1Offset * (i + 1));
            const targetPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, vwapEntryPrice * (1.0 + offset));
            const chunkQty = isLast ? Number((aggregatedQty - allocatedQty).toFixed(effectiveDecimals)) : chunk.quantity;
            if (chunkQty <= 0)
                continue;
            allocatedQty = Number((allocatedQty + chunkQty).toFixed(effectiveDecimals));
            tpStagePrices.push(targetPrice);
            tpStageQuantities.push(chunkQty);
            const tpCid = clientOrderIdGenerator_1.ClientOrderIdGenerator.generate(this.symbol, primarySlotId, `TP${i + 1}`);
            orderParamsList.push({
                symbol: this.symbol,
                side: exitSide,
                type: "LIMIT",
                quantity: chunkQty,
                price: targetPrice,
                timeInForce: "GTX", // Post-Only guarantee
                positionSide: side,
                clientOrderId: tpCid,
            });
        }
        if (side === "LONG") {
            this.coreLong.tpStagePrices = tpStagePrices;
            this.coreLong.tpStageQuantities = tpStageQuantities;
        }
        else {
            for (const s of this.shortSlots) {
                if (s.isOccupied) {
                    s.tpStagePrices = tpStagePrices;
                    s.tpStageQuantities = tpStageQuantities;
                }
            }
        }
        return orderParamsList;
    }
    /**
     * Retrieves the authoritative aggregated position summary across all occupied slots for a given side.
     * Calculates mathematically exact VWAP entry price and total aggregated quantity.
     */
    getAggregatedSideSummary(side) {
        if (side === "LONG") {
            const isOcc = this.coreLong.isOccupied && this.coreLong.quantity > 0;
            const res = this.cachedAggregatedLongSummary;
            res.isOccupied = isOcc;
            res.totalQuantity = isOcc ? this.coreLong.quantity : 0;
            res.vwapEntryPrice = isOcc ? this.coreLong.entryPrice : 0;
            res.stopLossPrice = isOcc ? (this.coreLong.stopLossPrice || 0) : 0;
            res.takeProfitPrice = isOcc ? (this.coreLong.takeProfitPrice || 0) : 0;
            res.breakEvenPrice = isOcc ? (this.coreLong.breakEvenPrice || 0) : 0;
            res.activeStopLossOrderId = isOcc ? (this.coreLong.activeStopLossOrderId || 0) : 0;
            res.activeTpOrderIds = isOcc ? (this.coreLong.activeTpOrderIds ? [...this.coreLong.activeTpOrderIds] : []) : [];
            return res;
        }
        else {
            let totalQty = 0;
            let totalNotional = 0;
            let primarySlOrderId = 0;
            let activeSlotCount = 0;
            let totalSlWeight = 0;
            let totalTpWeight = 0;
            const res = this.cachedAggregatedShortSummary;
            res.activeTpOrderIds = [];
            const slots = this.shortSlots;
            const len = slots.length;
            let tightestSlPrice = 0;
            for (let i = 0; i < len; i++) {
                const s = slots[i];
                if (s.isOccupied && s.quantity > 0) {
                    totalQty += s.quantity;
                    totalNotional += s.quantity * s.entryPrice;
                    totalSlWeight += s.quantity * (s.stopLossPercent > 0 ? s.stopLossPercent : 1.0);
                    totalTpWeight += s.quantity * (s.takeProfitPercent > 0 ? s.takeProfitPercent : 2.5);
                    res.slotIds[activeSlotCount++] = s.slotId;
                    if (s.activeStopLossOrderId && primarySlOrderId === 0) {
                        primarySlOrderId = s.activeStopLossOrderId;
                    }
                    if (s.stopLossPrice > 0) {
                        if (tightestSlPrice === 0 || s.stopLossPrice < tightestSlPrice) {
                            tightestSlPrice = s.stopLossPrice;
                        }
                    }
                    if (s.activeTpOrderIds && s.activeTpOrderIds.length > 0) {
                        for (const tpId of s.activeTpOrderIds) {
                            if (!res.activeTpOrderIds.includes(tpId)) {
                                res.activeTpOrderIds.push(tpId);
                            }
                        }
                    }
                }
            }
            res.slotIds.length = activeSlotCount;
            const isOcc = totalQty > 0;
            const vwap = isOcc ? totalNotional / totalQty : 0;
            const shortSlPct = isOcc && totalQty > 0 ? totalSlWeight / totalQty : (slots[0]?.stopLossPercent > 0 ? slots[0].stopLossPercent : 1.0);
            const shortTpPct = isOcc && totalQty > 0 ? totalTpWeight / totalQty : (slots[0]?.takeProfitPercent > 0 ? slots[0].takeProfitPercent : 2.5);
            const tickSize = this.priceTickSize;
            const invTick = this.invPriceTickSize;
            const priceFactor = this.priceFactor;
            const initialSlPx = isOcc ? Math.round(Math.round(vwap * (1.0 + shortSlPct * 0.01) * invTick) * tickSize * priceFactor) / priceFactor : 0;
            const tpPx = isOcc ? Math.round(Math.round(vwap * (1.0 - shortTpPct * 0.01) * invTick) * tickSize * priceFactor) / priceFactor : 0;
            const bePx = isOcc ? Math.round(Math.round(vwap * (1.0 - this.feeMultiplier) * invTick) * tickSize * priceFactor) / priceFactor : 0;
            const resolvedSlPx = (tightestSlPrice > 0) ? tightestSlPrice : initialSlPx;
            res.isOccupied = isOcc;
            res.totalQuantity = Math.round(totalQty * 1e6) / 1e6;
            res.vwapEntryPrice = vwap;
            res.stopLossPrice = isOcc ? resolvedSlPx : 0;
            res.takeProfitPrice = tpPx;
            res.breakEvenPrice = bePx;
            res.activeStopLossOrderId = isOcc ? (this.shortAggregatedStopLossOrderId || primarySlOrderId) : 0;
            return res;
        }
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
    getActiveTpOrderIds(slotId) {
        const slot = slotId === "CORE_LONG" ? this.coreLong : this.shortSlots.find((s) => s.slotId === slotId);
        return slot?.activeTpOrderIds ? [...slot.activeTpOrderIds] : [];
    }
    registerActiveStopLossOrderId(sideOrSlotId, orderId) {
        if (sideOrSlotId === "LONG" || sideOrSlotId === "CORE_LONG") {
            this.coreLong.activeStopLossOrderId = orderId;
        }
        else if (sideOrSlotId === "SHORT" || sideOrSlotId.startsWith("SHORT_SLOT")) {
            this.shortAggregatedStopLossOrderId = orderId;
            for (const s of this.shortSlots) {
                if (s.isOccupied) {
                    s.activeStopLossOrderId = orderId;
                }
            }
        }
    }
    getActiveStopLossOrderId(sideOrSlotId) {
        if (sideOrSlotId === "LONG" || sideOrSlotId === "CORE_LONG") {
            return this.coreLong.activeStopLossOrderId;
        }
        else if (sideOrSlotId === "SHORT" || sideOrSlotId.startsWith("SHORT_SLOT")) {
            return this.shortAggregatedStopLossOrderId;
        }
        return undefined;
    }
    updateLastSyncedSlPrice(sideOrSlotId, price) {
        if (sideOrSlotId === "LONG" || sideOrSlotId === "CORE_LONG") {
            this.coreLong.lastSyncedSlPrice = price;
        }
        else if (sideOrSlotId === "SHORT" || sideOrSlotId.startsWith("SHORT_SLOT")) {
            this.shortAggregatedLastSyncedSlPrice = price;
            for (const s of this.shortSlots) {
                if (s.isOccupied) {
                    s.lastSyncedSlPrice = price;
                }
            }
        }
    }
    getLastSyncedSlPrice(sideOrSlotId) {
        if (sideOrSlotId === "LONG" || sideOrSlotId === "CORE_LONG") {
            return this.coreLong.lastSyncedSlPrice || 0;
        }
        else if (sideOrSlotId === "SHORT" || sideOrSlotId.startsWith("SHORT_SLOT")) {
            return this.shortAggregatedLastSyncedSlPrice || 0;
        }
        return 0;
    }
    /**
     * ZERO-RETREAT MONOTONIC HARD LOCK (Zero-Retreat Invariant)
     * A ratcheted Stop Loss must NEVER move away from profit:
     * - LONG:  stopLossPrice can ONLY strictly increase (Math.max).
     * - SHORT: stopLossPrice can ONLY strictly decrease (Math.min).
     * - Initial assignment (slot.stopLossPrice === 0 or undefined) accepts calculatedSl.
     */
    applyMonotonicStopLoss(slot, calculatedSl) {
        if (calculatedSl <= 0 || !Number.isFinite(calculatedSl))
            return slot.stopLossPrice || 0;
        const formattedSl = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, calculatedSl);
        if (!slot.stopLossPrice || slot.stopLossPrice <= 0) {
            slot.stopLossPrice = formattedSl;
            return slot.stopLossPrice;
        }
        const isLong = slot.side === "LONG";
        slot.stopLossPrice = isLong
            ? Math.max(slot.stopLossPrice, formattedSl)
            : Math.min(slot.stopLossPrice, formattedSl);
        slot.stopLossPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, slot.stopLossPrice);
        return slot.stopLossPrice;
    }
    /**
     * Processes a filled WebSocket POST_ONLY limit TP order update.
     * Advances tpStageReached, records realized exit accounting, and updates fee-adjusted Break-Even / Trailing Stop-Loss price.
     */
    processTpLimitFill(slotId, orderId, fillQuantity, fillPrice, isMaker = true) {
        const slot = slotId === "CORE_LONG" ? this.coreLong : this.shortSlots.find((s) => s.slotId === slotId);
        if (!slot || !slot.isOccupied) {
            return { isPositionClosed: true, remainingQuantity: 0, newStopLossPrice: 0 };
        }
        if (slot.activeTpOrderIds) {
            slot.activeTpOrderIds = slot.activeTpOrderIds.filter((id) => id !== orderId);
        }
        const actualClosedQty = Math.min(slot.quantity, fillQuantity);
        const entryPx = slot.entryPrice;
        const slotSide = slot.side;
        const rule = symbolPrecision_1.SymbolPrecisionRegistry.getPrecisionRule(this.symbol);
        const effectiveDecimals = Math.max(rule.qtyDecimals, (String(slot.quantity).split(".")[1] || "").length, (String(fillQuantity).split(".")[1] || "").length);
        slot.quantity = Number(Math.max(0, slot.quantity - fillQuantity).toFixed(effectiveDecimals));
        const currentStage = (slot.tpStageReached || 0) + 1;
        slot.tpStageReached = currentStage;
        // Record realized trade accounting for the POST_ONLY limit fill
        const makerFee = this.sizingCalc.getMakerFeeRate();
        const feeRate = isMaker ? makerFee : this.sizingCalc.getTakerFeeRate();
        this.recordRealizedExit(slotSide, entryPx, fillPrice, actualClosedQty, feeRate, `MAKER_TP_STAGE_${currentStage}`);
        const isLong = slot.side === "LONG";
        // Advance Trailing Stop Loss with strict Breakeven ($0.00 Loss) floor
        const takerFee = this.sizingCalc.getTakerFeeRate();
        const feeBuffer = (makerFee + takerFee) * 2.5; // Fee-adjusted Break-Even
        const calcBePrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, isLong ? slot.entryPrice * (1 + feeBuffer) : slot.entryPrice * (1 - feeBuffer));
        if (!slot.breakEvenPrice || slot.breakEvenPrice <= 0) {
            slot.breakEvenPrice = calcBePrice;
        }
        if (currentStage === 1) {
            slot.breakEvenLocked = true;
            this.applyMonotonicStopLoss(slot, slot.breakEvenPrice);
        }
        else if (currentStage === 2 && slot.tpStagePrices && slot.tpStagePrices.length >= 1) {
            const targetSl = isLong
                ? Math.max(slot.tpStagePrices[0], slot.breakEvenPrice)
                : Math.min(slot.tpStagePrices[0], slot.breakEvenPrice);
            this.applyMonotonicStopLoss(slot, targetSl);
        }
        else if (currentStage >= 3 && slot.tpStagePrices && slot.tpStagePrices.length >= 2) {
            const targetSl = isLong
                ? Math.max(slot.tpStagePrices[1], slot.breakEvenPrice)
                : Math.min(slot.tpStagePrices[1], slot.breakEvenPrice);
            this.applyMonotonicStopLoss(slot, targetSl);
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
     * Tier-1 Optimistic Slot Reservation Protocol (August 2026 SOTA).
     * Synchronously transitions slot to PENDING_ENTRY before network packet dispatch,
     * completely eradicating execution race conditions and order spam.
     */
    reserveCoreLongPending(clientOrderId, targetPrice, targetQty) {
        if (this.coreLong.isOccupied || this.coreLong.lifecycleState === "PENDING_ENTRY") {
            return false;
        }
        this.coreLong.lifecycleState = "PENDING_ENTRY";
        this.coreLong.pendingClientOrderId = clientOrderId;
        this.coreLong.pendingOrderTimestamp = Date.now();
        this.coreLong.entryPrice = targetPrice;
        this.coreLong.quantity = targetQty;
        return true;
    }
    reserveShortSlotPending(slotIndex, clientOrderId, targetPrice, targetQty) {
        if (slotIndex < 0 || slotIndex >= this.maxShortSlots)
            return false;
        const slot = this.shortSlots[slotIndex];
        if (slot.isOccupied || slot.lifecycleState === "PENDING_ENTRY") {
            return false;
        }
        slot.lifecycleState = "PENDING_ENTRY";
        slot.pendingClientOrderId = clientOrderId;
        slot.pendingOrderTimestamp = Date.now();
        slot.entryPrice = targetPrice;
        slot.quantity = targetQty;
        return true;
    }
    rollbackPendingSlot(slotId, reason) {
        if (slotId === "CORE_LONG") {
            if (this.coreLong.lifecycleState === "PENDING_ENTRY" && !this.coreLong.isOccupied) {
                console.warn(`[OPTIMISTIC_MUTEX][ROLLBACK] Rolling back CORE_LONG from PENDING_ENTRY to FLAT due to: ${reason}`);
                this.coreLong.lifecycleState = "FLAT";
                this.coreLong.pendingClientOrderId = undefined;
                this.coreLong.pendingOrderTimestamp = undefined;
                this.coreLong.quantity = 0;
                this.coreLong.entryPrice = 0;
            }
            return;
        }
        if (slotId.startsWith("SHORT_SLOT_")) {
            const idx = parseInt(slotId.replace("SHORT_SLOT_", ""), 10);
            if (idx >= 0 && idx < this.maxShortSlots) {
                const slot = this.shortSlots[idx];
                if (slot.lifecycleState === "PENDING_ENTRY" && !slot.isOccupied) {
                    console.warn(`[OPTIMISTIC_MUTEX][ROLLBACK] Rolling back ${slotId} from PENDING_ENTRY to FLAT due to: ${reason}`);
                    slot.lifecycleState = "FLAT";
                    slot.pendingClientOrderId = undefined;
                    slot.pendingOrderTimestamp = undefined;
                    slot.quantity = 0;
                    slot.entryPrice = 0;
                }
            }
        }
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
        // 2. Locate first unoccupied and non-pending slot index
        let targetIdx = -1;
        for (let i = 0; i < this.maxShortSlots; i++) {
            if (!this.shortSlots[i].isOccupied && this.shortSlots[i].lifecycleState !== "PENDING_ENTRY") {
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
        // 4. Verify spatial separation from all occupied and pending short slots
        for (let i = 0; i < targetIdx; i++) {
            if (this.shortSlots[i].isOccupied || this.shortSlots[i].lifecycleState === "PENDING_ENTRY") {
                const fillPrice = this.shortSlots[i].entryPrice;
                if (fillPrice > 0) {
                    const priceDelta = Math.abs(currentPrice - fillPrice);
                    if (priceDelta < minSpacing) {
                        // Spatial co-location collision! Reject multi-slot fill at identical price.
                        return null;
                    }
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
            if (this.shortSlots[i].isOccupied || this.shortSlots[i].lifecycleState === "PENDING_ENTRY")
                count++;
        }
        return count;
    }
    occupyCoreLong(quantity, entryPrice, tpPercent, slPercent, isAuthoritativeSnapshot = false) {
        if (quantity <= 0 || entryPrice <= 0)
            return;
        if (isAuthoritativeSnapshot) {
            this.coreLong.isOccupied = true;
            this.coreLong.lifecycleState = "OCCUPIED";
            this.coreLong.quantity = quantity;
            this.coreLong.initialQuantity = quantity;
            this.coreLong.entryPrice = entryPrice;
            this.coreLong.takeProfitPercent = tpPercent;
            this.coreLong.stopLossPercent = slPercent;
            if (!this.coreLong.openTime || this.coreLong.openTime === 0) {
                this.coreLong.openTime = Date.now();
            }
            const makerFee = this.sizingCalc.getMakerFeeRate();
            const takerFee = this.sizingCalc.getTakerFeeRate();
            const feeMultiplier = (makerFee + takerFee) * 2.5;
            this.coreLong.breakEvenPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1.0 + feeMultiplier));
            this.coreLong.takeProfitPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tpPercent / 100));
            const rawSl = entryPrice * (1 - slPercent / 100);
            this.applyMonotonicStopLoss(this.coreLong, rawSl);
            this.coreLong.lastSyncedSlPrice = this.coreLong.stopLossPrice;
            const tp1Pct = Math.min(2.0, tpPercent * 1.0);
            const tp2Pct = Math.min(3.0, tpPercent * 2.0);
            const tp3Pct = Math.min(5.0, tpPercent * 4.0);
            const tp4Pct = Math.min(8.0, tpPercent * 6.0);
            const tp5Pct = Math.min(12.0, tpPercent * 10.0);
            this.coreLong.tpPrices = [
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tp1Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tp2Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tp3Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tp4Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tp5Pct / 100)),
            ];
            this.legacyLedger.syncActivePosition("LONG", quantity, entryPrice);
            return;
        }
        if (this.coreLong.isOccupied && this.coreLong.quantity > 0) {
            // Accumulate existing Core Long position and recalculate weighted average entry price
            const currentNotional = this.coreLong.quantity * this.coreLong.entryPrice;
            const addNotional = quantity * entryPrice;
            const newQty = Number((this.coreLong.quantity + quantity).toFixed(6));
            const newAvgEntry = (currentNotional + addNotional) / newQty;
            this.coreLong.quantity = newQty;
            this.coreLong.initialQuantity = Number(((this.coreLong.initialQuantity || this.coreLong.quantity) + quantity).toFixed(6));
            this.coreLong.entryPrice = newAvgEntry;
            this.coreLong.lifecycleState = "OCCUPIED";
            this.coreLong.pendingClientOrderId = undefined;
            this.coreLong.pendingOrderTimestamp = undefined;
            const makerFee = this.sizingCalc.getMakerFeeRate();
            const takerFee = this.sizingCalc.getTakerFeeRate();
            const feeMultiplier = (makerFee + takerFee) * 2.5;
            this.coreLong.breakEvenPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1.0 + feeMultiplier));
            this.coreLong.takeProfitPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 + tpPercent / 100));
            const rawSl = newAvgEntry * (1 - slPercent / 100);
            this.applyMonotonicStopLoss(this.coreLong, rawSl);
            this.coreLong.lastSyncedSlPrice = this.coreLong.stopLossPrice;
            const tp1Pct = Math.min(2.0, tpPercent * 1.0);
            const tp2Pct = Math.min(3.0, tpPercent * 2.0);
            const tp3Pct = Math.min(5.0, tpPercent * 4.0);
            const tp4Pct = Math.min(8.0, tpPercent * 6.0);
            const tp5Pct = Math.min(12.0, tpPercent * 10.0);
            this.coreLong.tpPrices = [
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 + tp1Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 + tp2Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 + tp3Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 + tp4Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 + tp5Pct / 100)),
            ];
            this.legacyLedger.syncActivePosition("LONG", newQty, newAvgEntry);
            return;
        }
        this.coreLong.isOccupied = true;
        this.coreLong.lifecycleState = "OCCUPIED";
        this.coreLong.pendingClientOrderId = undefined;
        this.coreLong.pendingOrderTimestamp = undefined;
        this.coreLong.quantity = quantity;
        this.coreLong.initialQuantity = quantity;
        this.coreLong.entryPrice = entryPrice;
        this.coreLong.openTime = Date.now();
        this.coreLong.takeProfitPercent = tpPercent;
        this.coreLong.stopLossPercent = slPercent;
        this.coreLong.tpStageReached = 0;
        this.coreLong.breakEvenLocked = false;
        this.coreLong.stepCollarTier = 0;
        this.coreLong.peakRoe = 0;
        this.coreLong.peakPrice = entryPrice;
        const makerFee = this.sizingCalc.getMakerFeeRate();
        const takerFee = this.sizingCalc.getTakerFeeRate();
        const feeMultiplier = (makerFee + takerFee) * 2.5; // Fee-adjusted zero-loss buffer loaded from .env
        this.coreLong.breakEvenPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1.0 + feeMultiplier));
        this.coreLong.takeProfitPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tpPercent / 100));
        const rawSl = entryPrice * (1 - slPercent / 100);
        this.applyMonotonicStopLoss(this.coreLong, rawSl);
        this.coreLong.lastSyncedSlPrice = this.coreLong.stopLossPrice;
        // 5-Stage TP Micro-Ladder Targets: 0.25%, 0.50%, 1.00%, 1.50%, 2.50% price moves (tpPercent * 1.0, 2.0, 4.0, 6.0, 10.0)
        const tp1Pct = Math.min(2.0, tpPercent * 1.0);
        const tp2Pct = Math.min(3.0, tpPercent * 2.0);
        const tp3Pct = Math.min(5.0, tpPercent * 4.0);
        const tp4Pct = Math.min(8.0, tpPercent * 6.0);
        const tp5Pct = Math.min(12.0, tpPercent * 10.0);
        this.coreLong.tpPrices = [
            symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tp1Pct / 100)),
            symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tp2Pct / 100)),
            symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tp3Pct / 100)),
            symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tp4Pct / 100)),
            symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 + tp5Pct / 100)),
        ];
        this.legacyLedger.syncActivePosition("LONG", quantity, entryPrice);
    }
    /**
     * Resets internal slot allocations without triggering trade exit accounting.
     * Reserved strictly for cold-start / startup position reconstruction.
     */
    clearSlots() {
        this.coreLong.isOccupied = false;
        this.coreLong.lifecycleState = "FLAT";
        this.coreLong.pendingClientOrderId = undefined;
        this.coreLong.pendingOrderTimestamp = undefined;
        this.coreLong.quantity = 0;
        this.coreLong.initialQuantity = 0;
        this.coreLong.entryPrice = 0;
        this.coreLong.openTime = 0;
        this.coreLong.takeProfitPrice = 0;
        this.coreLong.stopLossPrice = 0;
        this.coreLong.tpStageReached = 0;
        this.coreLong.breakEvenLocked = false;
        this.coreLong.breakEvenPrice = 0;
        this.coreLong.stepCollarTier = 0;
        this.coreLong.peakRoe = 0;
        this.coreLong.tpPrices = [];
        for (let i = 0; i < this.maxShortSlots; i++) {
            const slot = this.shortSlots[i];
            slot.isOccupied = false;
            slot.lifecycleState = "FLAT";
            slot.pendingClientOrderId = undefined;
            slot.pendingOrderTimestamp = undefined;
            slot.quantity = 0;
            slot.initialQuantity = 0;
            slot.entryPrice = 0;
            slot.openTime = 0;
            slot.takeProfitPrice = 0;
            slot.stopLossPrice = 0;
            slot.tpStageReached = 0;
            slot.breakEvenLocked = false;
            slot.breakEvenPrice = 0;
            slot.stepCollarTier = 0;
            slot.peakRoe = 0;
            slot.tpPrices = [];
        }
        this.shortAggregatedStopLossOrderId = 0;
        this.shortAggregatedLastSyncedSlPrice = 0;
        this.legacyLedger.reset();
    }
    syncStartupPositions(recoveredPositions, longTpPct, longSlPct, shortTpPct, shortSlPct, liveLeverage) {
        if (liveLeverage !== undefined && liveLeverage > 0) {
            this.setLeverage(liveLeverage);
        }
        this.clearSlots();
        let hasLong = false;
        let hasShort = false;
        let longQty = 0;
        let shortQty = 0;
        let longPxSum = 0;
        let shortPxSum = 0;
        for (const pos of recoveredPositions) {
            if (pos.quantity <= 0 || pos.entryPrice <= 0)
                continue;
            if (pos.side === "LONG") {
                this.occupyCoreLong(pos.quantity, pos.entryPrice, longTpPct, longSlPct);
                // Restore original open timestamp for CAD-DTLM clock continuity across restarts
                if (pos.originalOpenTime && pos.originalOpenTime > 0) {
                    this.coreLong.originalOpenTime = pos.originalOpenTime;
                    this.coreLong.openTime = pos.originalOpenTime;
                }
                hasLong = true;
                longQty += pos.quantity;
                longPxSum += pos.entryPrice * pos.quantity;
                console.log(`[HedgePositionLedger] Recovered Core Long Position: ${pos.quantity} @ $${pos.entryPrice.toFixed(2)} (TP: $${this.coreLong.takeProfitPrice.toFixed(2)}, SL: $${this.coreLong.stopLossPrice.toFixed(2)}) [originalOpenTime: ${pos.originalOpenTime ?? 0}]`);
            }
            else if (pos.side === "SHORT") {
                const slotIdx = this.getAvailableShortSlotIndex();
                if (slotIdx >= 0) {
                    this.occupyShortSlot(slotIdx, pos.quantity, pos.entryPrice, shortTpPct, shortSlPct);
                    // Restore original open timestamp for CAD-DTLM clock continuity across restarts
                    if (pos.originalOpenTime && pos.originalOpenTime > 0) {
                        this.shortSlots[slotIdx].originalOpenTime = pos.originalOpenTime;
                        this.shortSlots[slotIdx].openTime = pos.originalOpenTime;
                    }
                    hasShort = true;
                    shortQty += pos.quantity;
                    shortPxSum += pos.entryPrice * pos.quantity;
                    console.log(`[HedgePositionLedger] Recovered Short Slot #${slotIdx} Position: ${pos.quantity} @ $${pos.entryPrice.toFixed(2)} (TP: $${this.shortSlots[slotIdx].takeProfitPrice.toFixed(2)}, SL: $${this.shortSlots[slotIdx].stopLossPrice.toFixed(2)}) [originalOpenTime: ${pos.originalOpenTime ?? 0}]`);
                }
            }
        }
        if (hasLong && hasShort) {
            // In dual Hedge Mode, legacyLedger must not blend opposing directional positions.
            // Set net directional bias for legacy single-direction callers while preserving unblended coreLong & shortSlots.
            const netQty = longQty - shortQty;
            if (netQty > 1e-6 && longQty > 0) {
                this.legacyLedger.syncActivePosition("LONG", netQty, longPxSum / longQty);
            }
            else if (netQty < -1e-6 && shortQty > 0) {
                this.legacyLedger.syncActivePosition("SHORT", Math.abs(netQty), shortPxSum / shortQty);
            }
            else {
                this.legacyLedger.reset();
            }
        }
        else if (hasLong && longQty > 0) {
            const avgPx = longPxSum / longQty;
            this.legacyLedger.syncActivePosition("LONG", longQty, avgPx);
        }
        else if (hasShort && shortQty > 0) {
            const avgPx = shortPxSum / shortQty;
            this.legacyLedger.syncActivePosition("SHORT", shortQty, avgPx);
        }
    }
    releaseCoreLong(exitPrice, feeRate, exitReason = "SIGNAL_EXIT", fallbackMarkPrice, exactRealizedPnl, exactCommission) {
        if (this.coreLong.isOccupied && this.coreLong.quantity > 0) {
            let resolvedExitPrice = (exitPrice && exitPrice > 0) ? exitPrice : ((fallbackMarkPrice && fallbackMarkPrice > 0) ? fallbackMarkPrice : 0);
            if (resolvedExitPrice <= 0) {
                const peak = this.coreLong.peakPrice;
                resolvedExitPrice = (peak !== undefined && peak > 0) ? peak : this.coreLong.entryPrice;
            }
            if (resolvedExitPrice > 0) {
                const resolvedFeeRate = feeRate !== undefined ? feeRate : this.sizingCalc.getTakerFeeRate();
                this.recordRealizedExit("LONG", this.coreLong.entryPrice, resolvedExitPrice, this.coreLong.quantity, resolvedFeeRate, exitReason, exactRealizedPnl, exactCommission);
            }
        }
        this.coreLong.isOccupied = false;
        this.coreLong.lifecycleState = "FLAT";
        this.coreLong.pendingClientOrderId = undefined;
        this.coreLong.pendingOrderTimestamp = undefined;
        this.coreLong.quantity = 0;
        this.coreLong.initialQuantity = 0;
        this.coreLong.entryPrice = 0;
        this.coreLong.openTime = 0;
        this.coreLong.takeProfitPrice = 0;
        this.coreLong.stopLossPrice = 0;
        this.coreLong.tpStageReached = 0;
        this.coreLong.breakEvenLocked = false;
        this.coreLong.breakEvenPrice = 0;
        this.coreLong.activeStopLossOrderId = 0;
        this.coreLong.activeTpOrderIds = [];
        this.coreLong.lastSyncedSlPrice = 0;
        this.coreLong.tpPrices = [];
    }
    occupyShortSlot(slotIndex, quantity, entryPrice, tpPercent, slPercent, isAuthoritativeSnapshot = false) {
        if (slotIndex < 0 || slotIndex >= this.maxShortSlots || quantity <= 0 || entryPrice <= 0)
            return false;
        const slot = this.shortSlots[slotIndex];
        if (isAuthoritativeSnapshot) {
            slot.isOccupied = true;
            slot.lifecycleState = "OCCUPIED";
            slot.quantity = quantity;
            slot.initialQuantity = quantity;
            slot.entryPrice = entryPrice;
            slot.takeProfitPercent = tpPercent;
            slot.stopLossPercent = slPercent;
            if (!slot.openTime || slot.openTime === 0) {
                slot.openTime = Date.now();
            }
            const makerFee = this.sizingCalc.getMakerFeeRate();
            const takerFee = this.sizingCalc.getTakerFeeRate();
            const feeMultiplier = (makerFee + takerFee) * 2.5;
            slot.breakEvenPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1.0 - feeMultiplier));
            slot.takeProfitPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tpPercent / 100));
            const rawSl = entryPrice * (1 + slPercent / 100);
            this.applyMonotonicStopLoss(slot, rawSl);
            slot.lastSyncedSlPrice = slot.stopLossPrice;
            const tp1Pct = Math.min(2.0, tpPercent * 1.0);
            const tp2Pct = Math.min(3.0, tpPercent * 2.0);
            const tp3Pct = Math.min(5.0, tpPercent * 4.0);
            const tp4Pct = Math.min(8.0, tpPercent * 6.0);
            const tp5Pct = Math.min(12.0, tpPercent * 10.0);
            slot.tpPrices = [
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tp1Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tp2Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tp3Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tp4Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tp5Pct / 100)),
            ];
            this.legacyLedger.syncActivePosition("SHORT", quantity, entryPrice);
            return true;
        }
        if (slot.isOccupied && slot.quantity > 0) {
            // Accumulate existing short slot position and recalculate weighted average entry price
            const currentNotional = slot.quantity * slot.entryPrice;
            const addNotional = quantity * entryPrice;
            const newQty = Number((slot.quantity + quantity).toFixed(6));
            const newAvgEntry = (currentNotional + addNotional) / newQty;
            slot.quantity = newQty;
            slot.initialQuantity = Number(((slot.initialQuantity || slot.quantity) + quantity).toFixed(6));
            slot.entryPrice = newAvgEntry;
            slot.lifecycleState = "OCCUPIED";
            slot.pendingClientOrderId = undefined;
            slot.pendingOrderTimestamp = undefined;
            const makerFee = this.sizingCalc.getMakerFeeRate();
            const takerFee = this.sizingCalc.getTakerFeeRate();
            const feeMultiplier = (makerFee + takerFee) * 2.5;
            slot.breakEvenPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1.0 - feeMultiplier));
            slot.takeProfitPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 - tpPercent / 100));
            const rawSl = newAvgEntry * (1 + slPercent / 100);
            this.applyMonotonicStopLoss(slot, rawSl);
            slot.lastSyncedSlPrice = slot.stopLossPrice;
            const tp1Pct = Math.min(2.0, tpPercent * 1.0);
            const tp2Pct = Math.min(3.0, tpPercent * 2.0);
            const tp3Pct = Math.min(5.0, tpPercent * 4.0);
            const tp4Pct = Math.min(8.0, tpPercent * 6.0);
            const tp5Pct = Math.min(12.0, tpPercent * 10.0);
            slot.tpPrices = [
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 - tp1Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 - tp2Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 - tp3Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 - tp4Pct / 100)),
                symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, newAvgEntry * (1 - tp5Pct / 100)),
            ];
            this.legacyLedger.syncActivePosition("SHORT", newQty, newAvgEntry);
            return true;
        }
        slot.isOccupied = true;
        slot.lifecycleState = "OCCUPIED";
        slot.pendingClientOrderId = undefined;
        slot.pendingOrderTimestamp = undefined;
        slot.quantity = quantity;
        slot.initialQuantity = quantity;
        slot.entryPrice = entryPrice;
        slot.openTime = Date.now();
        slot.takeProfitPercent = tpPercent;
        slot.stopLossPercent = slPercent;
        slot.tpStageReached = 0;
        slot.breakEvenLocked = false;
        slot.stepCollarTier = 0;
        slot.peakRoe = 0;
        slot.troughPrice = entryPrice;
        const makerFee = this.sizingCalc.getMakerFeeRate();
        const takerFee = this.sizingCalc.getTakerFeeRate();
        const feeMultiplier = (makerFee + takerFee) * 2.5; // Fee-adjusted zero-loss buffer loaded from .env
        slot.breakEvenPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1.0 - feeMultiplier));
        slot.takeProfitPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tpPercent / 100));
        const rawSl = entryPrice * (1 + slPercent / 100);
        this.applyMonotonicStopLoss(slot, rawSl);
        slot.lastSyncedSlPrice = slot.stopLossPrice;
        const tp1Pct = Math.min(2.0, tpPercent * 1.0);
        const tp2Pct = Math.min(3.0, tpPercent * 2.0);
        const tp3Pct = Math.min(5.0, tpPercent * 4.0);
        const tp4Pct = Math.min(8.0, tpPercent * 6.0);
        const tp5Pct = Math.min(12.0, tpPercent * 10.0);
        slot.tpPrices = [
            symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tp1Pct / 100)),
            symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tp2Pct / 100)),
            symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tp3Pct / 100)),
            symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tp4Pct / 100)),
            symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, entryPrice * (1 - tp5Pct / 100)),
        ];
        this.legacyLedger.syncActivePosition("SHORT", quantity, entryPrice);
        return true;
    }
    releaseShortSlot(slotIndex, exitPrice, feeRate, exitReason = "SIGNAL_EXIT", fallbackMarkPrice, exactRealizedPnl, exactCommission) {
        if (slotIndex < 0 || slotIndex >= this.maxShortSlots)
            return;
        const slot = this.shortSlots[slotIndex];
        if (slot.isOccupied && slot.quantity > 0) {
            let resolvedExitPrice = (exitPrice && exitPrice > 0) ? exitPrice : ((fallbackMarkPrice && fallbackMarkPrice > 0) ? fallbackMarkPrice : 0);
            if (resolvedExitPrice <= 0) {
                const trough = slot.troughPrice;
                resolvedExitPrice = (trough !== undefined && trough > 0) ? trough : slot.entryPrice;
            }
            if (resolvedExitPrice > 0) {
                const resolvedFeeRate = feeRate !== undefined ? feeRate : this.sizingCalc.getTakerFeeRate();
                this.recordRealizedExit("SHORT", slot.entryPrice, resolvedExitPrice, slot.quantity, resolvedFeeRate, exitReason, exactRealizedPnl, exactCommission);
            }
        }
        slot.isOccupied = false;
        slot.lifecycleState = "FLAT";
        slot.pendingClientOrderId = undefined;
        slot.pendingOrderTimestamp = undefined;
        slot.quantity = 0;
        slot.initialQuantity = 0;
        slot.entryPrice = 0;
        slot.openTime = 0;
        slot.takeProfitPrice = 0;
        slot.stopLossPrice = 0;
        slot.tpStageReached = 0;
        slot.breakEvenLocked = false;
        slot.breakEvenPrice = 0;
        slot.activeStopLossOrderId = 0;
        slot.activeTpOrderIds = [];
        slot.lastSyncedSlPrice = 0;
        slot.tpPrices = [];
        let hasRemainingOccupied = false;
        for (let i = 0; i < this.maxShortSlots; i++) {
            if (this.shortSlots[i].isOccupied && this.shortSlots[i].quantity > 0) {
                hasRemainingOccupied = true;
                break;
            }
        }
        if (!hasRemainingOccupied) {
            this.shortAggregatedStopLossOrderId = 0;
            this.shortAggregatedLastSyncedSlPrice = 0;
        }
    }
    deductCoreLongQuantity(qty, exitPrice, feeRate, exitReason = "PARTIAL_EXIT") {
        if (this.coreLong.isOccupied && qty > 0) {
            const closedQty = Math.min(this.coreLong.quantity, qty);
            if (exitPrice !== undefined && exitPrice > 0) {
                this.recordRealizedExit("LONG", this.coreLong.entryPrice, exitPrice, closedQty, feeRate, exitReason);
            }
            this.coreLong.quantity = Math.max(0, Number((this.coreLong.quantity - closedQty).toFixed(6)));
            if (this.coreLong.quantity <= 1e-6) {
                this.releaseCoreLong(undefined, feeRate, exitReason, exitPrice);
            }
        }
    }
    deductShortSlotQuantity(slotIndex, qty, exitPrice, feeRate, exitReason = "PARTIAL_EXIT") {
        if (slotIndex >= 0 && slotIndex < this.maxShortSlots) {
            const slot = this.shortSlots[slotIndex];
            if (slot.isOccupied && qty > 0) {
                const closedQty = Math.min(slot.quantity, qty);
                if (exitPrice !== undefined && exitPrice > 0) {
                    this.recordRealizedExit("SHORT", slot.entryPrice, exitPrice, closedQty, feeRate, exitReason);
                }
                slot.quantity = Math.max(0, Number((slot.quantity - closedQty).toFixed(6)));
                if (slot.quantity <= 1e-6) {
                    this.releaseShortSlot(slotIndex, undefined, feeRate, exitReason, exitPrice);
                }
            }
        }
    }
    evaluateHedgeDynamicTpSl(markPrice, aiDirectionOrNowMs = 0, aiConfidence = 0, vpin = 0, hawkes = 0, garmanKlass = 0, ofi = 0, nowMs = Date.now()) {
        const triggers = [];
        if (markPrice <= 0)
            return triggers;
        const actualNowMs = aiDirectionOrNowMs > 1e11 ? aiDirectionOrNowMs : (nowMs > 1e11 ? nowMs : Date.now());
        const aiDirection = aiDirectionOrNowMs > 1e11 ? 0 : aiDirectionOrNowMs;
        const makerFee = this.sizingCalc.getMakerFeeRate();
        const takerFee = this.sizingCalc.getTakerFeeRate();
        const feeBuffer = (makerFee + takerFee) * 2.5;
        const effectiveLev = this.leverage > 0 ? this.leverage : 20.0;
        if (this.coreLong.isOccupied && this.coreLong.entryPrice > 0 && this.coreLong.quantity > 0) {
            this.evalHedgeSlot(this.coreLong, markPrice, actualNowMs, aiDirection, aiConfidence, vpin, hawkes, garmanKlass, ofi, feeBuffer, effectiveLev, triggers);
        }
        for (let i = 0; i < this.maxShortSlots; i++) {
            const slot = this.shortSlots[i];
            if (slot.isOccupied && slot.entryPrice > 0 && slot.quantity > 0) {
                this.evalHedgeSlot(slot, markPrice, actualNowMs, aiDirection, aiConfidence, vpin, hawkes, garmanKlass, ofi, feeBuffer, effectiveLev, triggers);
            }
        }
        return triggers;
    }
    evalHedgeSlot(slot, markPrice, actualNowMs, aiDirection, aiConfidence, vpin, hawkes, garmanKlass, ofi, feeBuffer, effectiveLev, triggers) {
        const initialQty = slot.initialQuantity && slot.initialQuantity > 0 ? slot.initialQuantity : slot.quantity;
        const stage = slot.tpStageReached || 0;
        const isLong = slot.side === "LONG";
        const tpPrices = slot.tpPrices && slot.tpPrices.length === 5 ? slot.tpPrices : [];
        const hasActiveLimitOrders = slot.activeTpOrderIds && slot.activeTpOrderIds.length > 0;
        const openTime = slot.openTime && slot.openTime > 0 ? slot.openTime : actualNowMs;
        const durationMs = Math.max(0, actualNowMs - openTime);
        const durationSec = durationMs / 1000;
        // 0A. Tick-by-Tick Dynamic Trailing SL & Early Profit Lock (Zero Time Delays)
        if (isLong) {
            slot.peakPrice = Math.max(slot.peakPrice ?? slot.entryPrice, markPrice);
        }
        else {
            slot.troughPrice = Math.min(slot.troughPrice && slot.troughPrice > 0 ? slot.troughPrice : slot.entryPrice, markPrice);
        }
        const rawRoePct = isLong
            ? ((markPrice - slot.entryPrice) / slot.entryPrice) * effectiveLev * 100.0
            : ((slot.entryPrice - markPrice) / slot.entryPrice) * effectiveLev * 100.0;
        if (rawRoePct > (slot.peakRoe ?? 0)) {
            slot.peakRoe = rawRoePct;
        }
        // Dynamic Continuous Tick-by-Tick Trailing SL (Locks past Entry Price as soon as in profit)
        const minVol = garmanKlass > 0.000001 ? Math.sqrt(garmanKlass) : 0.0020;
        const dynamicTrailDist = Math.max(this.priceTickSize * 3, slot.entryPrice * Math.max(0.0010, minVol * 1.0));
        if (!slot.breakEvenPrice || slot.breakEvenPrice <= 0) {
            slot.breakEvenPrice = this.formatPriceFast(isLong ? slot.entryPrice * (1.0 + feeBuffer) : slot.entryPrice * (1.0 - feeBuffer));
        }
        const maxLongSl = this.formatPriceFast(markPrice - this.priceTickSize * 2);
        const minShortSl = this.formatPriceFast(markPrice + this.priceTickSize * 2);
        // =========================================================================
        // LAYER 1: STANDARD STEP-COLLAR RATCHETS (MANDATORY >= +8.0% NET ROE GATE)
        // =========================================================================
        const currentPeakRoe = slot.peakRoe ?? rawRoePct;
        // Tier 1: +8.0% Net ROE -> Lock Entry + Round-Trip Fees
        if (rawRoePct >= 8.0 || currentPeakRoe >= 8.0) {
            const beOffset = feeBuffer + 0.0002;
            const rawTier1 = isLong ? slot.entryPrice * (1.0 + beOffset) : slot.entryPrice * (1.0 - beOffset);
            const targetTier1Sl = isLong ? Math.min(maxLongSl, this.formatPriceFast(rawTier1)) : Math.max(minShortSl, this.formatPriceFast(rawTier1));
            if (!slot.stepCollarTier || slot.stepCollarTier < 1) {
                slot.stepCollarTier = 1;
                slot.breakEvenLocked = true;
                slot.breakEvenPrice = targetTier1Sl;
            }
            this.applyMonotonicStopLoss(slot, targetTier1Sl);
        }
        // Tier 2: +15.0% Net ROE -> Lock +10.0% ROE
        if (rawRoePct >= 15.0 || currentPeakRoe >= 15.0) {
            const lockOffset = (10.0 / 100.0) / effectiveLev;
            const rawTier2 = isLong ? slot.entryPrice * (1.0 + lockOffset) : slot.entryPrice * (1.0 - lockOffset);
            const targetTier2Sl = isLong ? Math.min(maxLongSl, this.formatPriceFast(rawTier2)) : Math.max(minShortSl, this.formatPriceFast(rawTier2));
            if (!slot.stepCollarTier || slot.stepCollarTier < 2) {
                slot.stepCollarTier = 2;
                slot.breakEvenLocked = true;
            }
            this.applyMonotonicStopLoss(slot, targetTier2Sl);
        }
        // Tier 3: >= +25.0% Net ROE -> Aggressive 70% Trailing Profit Collar
        if (rawRoePct >= 25.0 || currentPeakRoe >= 25.0) {
            const trailRoe = currentPeakRoe * 0.70;
            const trailOffset = (trailRoe / 100.0) / effectiveLev;
            const rawTier3 = isLong ? slot.entryPrice * (1.0 + trailOffset) : slot.entryPrice * (1.0 - trailOffset);
            const targetTier3Sl = isLong ? Math.min(maxLongSl, this.formatPriceFast(rawTier3)) : Math.max(minShortSl, this.formatPriceFast(rawTier3));
            if (!slot.stepCollarTier || slot.stepCollarTier < 3) {
                slot.stepCollarTier = 3;
                slot.breakEvenLocked = true;
            }
            this.applyMonotonicStopLoss(slot, targetTier3Sl);
        }
        // Terminal Lifespan Harvest (30 Minutes Max Horizon)
        if (durationSec >= 1800.0) {
            if (!slot.timeDecayTier || slot.timeDecayTier < 4) {
                slot.timeDecayTier = 4;
                triggers.push({
                    slotId: slot.slotId,
                    side: slot.side,
                    reason: "LONG_HOLD_PROFIT_HARVEST",
                    quantity: slot.quantity,
                    entryPrice: slot.entryPrice,
                    markPrice,
                    isPartialClose: false,
                    cancelOrderIds: this.extractCancelOrderIds(slot),
                });
                return;
            }
        }
        // 0B. AI Conviction Hard-Reversal Exit Signal (100% Dynamic - Zero Timers)
        const isAiHardReversal = isLong
            ? (aiDirection <= -0.15 && aiConfidence >= 0.70)
            : (aiDirection >= 0.15 && aiConfidence >= 0.70);
        if (isAiHardReversal) {
            triggers.push({
                slotId: slot.slotId,
                side: slot.side,
                reason: `AI_REVERSAL_EXIT_${slot.side}`,
                quantity: slot.quantity,
                entryPrice: slot.entryPrice,
                markPrice,
                isPartialClose: false,
                cancelOrderIds: this.extractCancelOrderIds(slot),
            });
            return;
        }
        // =========================================================================
        // LAYER 2: MICROSTRUCTURE EMERGENCY RATCHETS (VPIN / HAWKES)
        // HARD GATE: peakRoe < +5.0% COMPLETELY DISABLES AND BYPASSES THIS SECTION
        // =========================================================================
        const isEmergencyGateOpen = currentPeakRoe >= 5.0;
        if (isEmergencyGateOpen) {
            const isToxicFlow = vpin >= 0.80 || (isLong ? ofi < -0.3 : ofi > 0.3);
            const isHawkesBurst = hawkes > 2.5;
            if (!slot.breakEvenPrice || slot.breakEvenPrice <= 0) {
                slot.breakEvenPrice = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, isLong ? slot.entryPrice * (1.0 + feeBuffer) : slot.entryPrice * (1.0 - feeBuffer));
            }
            if (slot.breakEvenPrice && slot.breakEvenPrice > 0 && (isToxicFlow || isHawkesBurst)) {
                let emergencyTargetSl = slot.breakEvenPrice;
                if (isToxicFlow) {
                    // Ratchet SL to Breakeven + 0.05% offset to lock profit under toxicity
                    const offset = feeBuffer + 0.0005;
                    emergencyTargetSl = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, isLong ? slot.entryPrice * (1.0 + offset) : slot.entryPrice * (1.0 - offset));
                }
                else if (isHawkesBurst) {
                    // Ratchet SL under order arrival velocity spike
                    const offset = feeBuffer + 0.0010;
                    emergencyTargetSl = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(this.symbol, isLong ? slot.entryPrice * (1.0 + offset) : slot.entryPrice * (1.0 - offset));
                }
                this.applyMonotonicStopLoss(slot, emergencyTargetSl);
            }
        }
        // 1. Symmetrical Immediate Take-Profit Evaluation (Zero Holding Time Hysteresis - Symmetrical to SL)
        if (!hasActiveLimitOrders && tpPrices.length === 5) {
            // TP1 (+20% ROI Target)
            if (stage < 1 && ((isLong && markPrice >= tpPrices[0]) || (!isLong && markPrice <= tpPrices[0]))) {
                slot.tpStageReached = 1;
                slot.breakEvenLocked = true;
                if (slot.breakEvenPrice && slot.breakEvenPrice > 0) {
                    this.applyMonotonicStopLoss(slot, slot.breakEvenPrice);
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
                this.applyMonotonicStopLoss(slot, tpPrices[0]);
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
                this.applyMonotonicStopLoss(slot, tpPrices[1]);
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
                this.applyMonotonicStopLoss(slot, tpPrices[2]);
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
                cancelOrderIds: this.extractCancelOrderIds(slot),
            });
            return;
        }
        // 3. Fallback Standard TP Percent Check (Symmetrical Immediate Exit - Zero Time Barrier)
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
    }
    extractCancelOrderIds(slot) {
        if (!slot.activeTpOrderIds?.length && !slot.activeStopLossOrderId) {
            return undefined;
        }
        const ids = [];
        if (slot.activeTpOrderIds && slot.activeTpOrderIds.length > 0) {
            ids.push(...slot.activeTpOrderIds);
        }
        if (slot.activeStopLossOrderId && slot.activeStopLossOrderId > 0) {
            ids.push(slot.activeStopLossOrderId);
        }
        return ids;
    }
    /**
     * Returns the current cumulative realized PnL (USDT) for this ledger.
     * Used by engine.ts to compute PnL deltas via the Ledger Delta Pattern,
     * eliminating redundant fee arithmetic and enforcing single-source-of-truth
     * for RiskGuard daily limit tracking (Defect #10 fix).
     */
    getCumulativeRealizedPnl() {
        return this.cumulativeRealizedPnl;
    }
    /**
     * SOTA August 2026 MS-SOPC & CAD-DTLM Continuous Microstructure Dynamic Exit Evaluator.
     *
     * Mathematical Frameworks:
     * 1. MS-SOPC (Microstructure-Informed Stochastic Optimal Profit Collaring):
     *    - True Stoikov Micro-Price: P_micro = P_mid + (OBI / 2) * Spread
     *    - Stochastic Collar Distance: Delta_collar = sigma_GK * exp(1.5 * (VPIN - 0.50)) * (2.0 - H_micro)
     *    - Asymmetric Peak/Trough Tracking anchored to P_micro.
     *
     * 2. CAD-DTLM (Continuous Alpha Decay & Dynamic Time-in-Market Management):
     *    - OU Half-Life Decay: alpha(tau) = alpha_0 * exp(-ln(2) * tau / t_half)
     *    - 4-Stage Liquidation Schedule:
     *      * Phase 1: Prime Alpha (tau < t_half)
     *      * Phase 2: Break-Even Ratchet (t_half <= tau < 2*t_half) -> Tier 1 Lock
     *      * Phase 3: Passive Maker Unwind (2*t_half <= tau < 4*t_half) -> Tier 2 Lock
     *      * Phase 4: Terminal Horizon Hard Kill (tau >= T_max) -> Force Liquidation
     */
    evaluateSotaDynamicExits(bestBidOrMark, bestAskOrHazard, hazardOrHjb, hjbOrVol, volMetricsOrNowMs, nowMs = Date.now(), hurstExponent = 0.50) {
        this.sotaTriggers.length = 0;
        let bestBid = 0;
        let bestAsk = 0;
        let hazardMetrics;
        let hjbEngine;
        let volSurfMetrics;
        let effectiveNowMs = nowMs;
        if (typeof bestAskOrHazard === "number") {
            bestBid = bestBidOrMark;
            bestAsk = bestAskOrHazard;
            hazardMetrics = hazardOrHjb;
            hjbEngine = hjbOrVol;
            volSurfMetrics = volMetricsOrNowMs;
        }
        else {
            // Single-price overload: evaluateSotaDynamicExits(markPx, hazardMetrics, hjbEngine, volMetrics, nowMs)
            // Degenerate Stoikov case: spread = 0, OBI term = 0, stoikovMicroPrice = midPrice exactly.
            // This is mathematically correct and avoids synthetic spread injection.
            const mark = bestBidOrMark;
            if (mark <= 0) {
                console.error("[MS-SOPC][GUARD] evaluateSotaDynamicExits: invalid mark price. Aborting.");
                return this.sotaTriggers;
            }
            bestBid = mark; // spread = 0 → OBI term = 0 → micro-price = mid (correct neutral Stoikov)
            bestAsk = mark;
            hazardMetrics = bestAskOrHazard;
            hjbEngine = hazardOrHjb;
            volSurfMetrics = hjbOrVol;
            if (typeof volMetricsOrNowMs === "number") {
                effectiveNowMs = volMetricsOrNowMs;
            }
        }
        const midPrice = (bestBid > 0 && bestAsk > 0) ? (bestBid + bestAsk) / 2.0 : Math.max(bestBid, bestAsk);
        const spread = (bestBid > 0 && bestAsk > 0 && bestAsk >= bestBid) ? bestAsk - bestBid : 0;
        // True Stoikov Micro-Price: P_micro = P_mid + (OBI / 2) * Spread
        // Uses hazardMetrics.obi (instantaneous L1 depth ratio) — NOT hazardMetrics.ofi (rolling OFI).
        // OBI = (Q_bid - Q_ask) / (Q_bid + Q_ask): correct static inventory pressure at the quote.
        // When spread=0 (single-price path), obi term = 0 and stoikovMicroPrice = midPrice.
        const obiVal = (hazardMetrics && Number.isFinite(hazardMetrics.obi))
            ? Math.max(-1.0, Math.min(1.0, hazardMetrics.obi))
            : 0;
        const stoikovMicroPrice = (midPrice > 0 && spread > 0)
            ? midPrice + (obiVal / 2.0) * spread
            : midPrice;
        // Pre-calculate per-tick invariant fee, decay and MS-SOPC constants once
        const makerFee = this.sizingCalc.getMakerFeeRate();
        const takerFee = this.sizingCalc.getTakerFeeRate();
        const minNetAlpha = this.sizingCalc.getMinNetAlpha();
        const roundTripFeeBuffer = (makerFee + takerFee) * 2.5;
        const safeHurst = Math.max(0.05, Math.min(0.95, hurstExponent));
        // Ornstein-Uhlenbeck half-life calibration (August 2026 SOTA):
        // t_half = -Δt × ln(2) / (2 × ln(H + 0.5)), Δt = 0.1s (100ms tick)
        // Hybrid: mean-reverting (H < 0.5) uses OU formula; trending (H ≥ 0.5) uses linear scaling.
        // Linear scaling: H=0.50 → 90s, H=0.75 → 495s, H=0.95 → 819s (captures alpha persistence gradient)
        // OU floor: 60s (sufficient for micro-trend to develop); OU ceiling: 900s (15-min alpha limit)
        let halfLifeSec;
        if (safeHurst < 0.5) {
            // Mean-reverting regime: OU formula, clamped to [60, 600]s
            const hurstShifted = safeHurst + 0.5; // maps [0.05, 0.50) → [0.55, 1.00)
            const lnHurstSafe = Math.max(Math.abs(Math.log(hurstShifted)), 0.001);
            const ouHalfLifeRaw = (0.1 * Math.LN2) / (2.0 * lnHurstSafe);
            halfLifeSec = Math.max(60.0, Math.min(600.0, ouHalfLifeRaw));
        }
        else {
            // Trending regime: linear interpolation 90s (H=0.50) → 900s (H=1.00)
            // Captures alpha signal persistence: more trending → longer edge half-life
            halfLifeSec = Math.max(90.0, Math.min(900.0, 90.0 + (safeHurst - 0.5) * 1620.0));
        }
        // Garman-Klass Volatility Warm-Up Gate (Defect #3 Fix):
        // GK variance requires >= 2 complete OHLC bars for statistical validity.
        // If not ready, volSurfMetrics.garmanKlass1s = 0.0 (VolatilitySurfaceEngine returns 0 for N < 2).
        // Silently using 0.002 hardcode corrupts the collar distance calculation.
        // Solution: detect unready state and short-circuit to CAD-DTLM only.
        const isVolReady = volSurfMetrics !== null && volSurfMetrics !== undefined
            && Number.isFinite(volSurfMetrics.garmanKlass1s)
            && volSurfMetrics.garmanKlass1s > 0;
        // Compute safeGkVol only when ready; used in collar distance below.
        const safeGkVol = isVolReady ? Math.max(0.001, volSurfMetrics.garmanKlass1s) : 0;
        const vpinVal = hazardMetrics ? Math.max(0.0, Math.min(1.0, hazardMetrics.vpin)) : 0.5;
        const vpinPenalty = vpinVal === 0.5 ? 1.0 : Math.exp(1.5 * (vpinVal - 0.50));
        const hurstMultiplier = Math.max(0.5, 2.0 - safeHurst);
        const volMultiplier = (isVolReady && Number.isFinite(volSurfMetrics.volatilityMultiplier) && volSurfMetrics.volatilityMultiplier > 0)
            ? volSurfMetrics.volatilityMultiplier
            : 1.0;
        const rawCollarDistancePct = safeGkVol * vpinPenalty * hurstMultiplier * volMultiplier;
        // When !isVolReady: rawCollarDistancePct = 0 → collarDistancePct = 0.0015 (floor, no-op collar)
        const collarDistancePct = Math.max(0.0015, Math.min(0.05, rawCollarDistancePct));
        this.evalSingleSlotSota(this.coreLong, midPrice, stoikovMicroPrice, hazardMetrics, hjbEngine, volSurfMetrics, effectiveNowMs, halfLifeSec, roundTripFeeBuffer, minNetAlpha, collarDistancePct);
        for (let i = 0; i < this.maxShortSlots; i++) {
            this.evalSingleSlotSota(this.shortSlots[i], midPrice, stoikovMicroPrice, hazardMetrics, hjbEngine, volSurfMetrics, effectiveNowMs, halfLifeSec, roundTripFeeBuffer, minNetAlpha, collarDistancePct);
        }
        return this.sotaTriggers;
    }
    evalSingleSlotSota(slot, markPrice, stoikovMicroPrice, hazardMetrics, hjbEngine, volMetrics, nowMs, halfLifeSec, roundTripFeeBuffer, minNetAlpha, collarDistancePct) {
        if (!slot.isOccupied || slot.quantity <= 0 || slot.entryPrice <= 0)
            return;
        const isLong = slot.side === "LONG";
        // Priority: originalOpenTime (survives restart) > openTime (set on entry) > conservative fallback
        // Conservative fallback: back-date by min(60s, halfLifeSec) + 1ms to trigger Tier 1 immediately
        // on the next tick for any position whose original open time was not persisted.
        const openTime = (slot.originalOpenTime && slot.originalOpenTime > 0)
            ? slot.originalOpenTime
            : (slot.openTime && slot.openTime > 0)
                ? slot.openTime
                : (nowMs - (Math.min(60.0, halfLifeSec) * 1000 + 1));
        const durationMs = Math.max(0, nowMs - openTime);
        const durationSec = durationMs / 1000;
        // -------------------------------------------------------------------------
        // 1. SOTA Dynamic Trailing SL & Early Profit Lock (Zero Time Delays)
        // -------------------------------------------------------------------------
        if (isLong) {
            slot.peakPrice = Math.max(slot.peakPrice ?? slot.entryPrice, markPrice);
        }
        else {
            slot.troughPrice = Math.min(slot.troughPrice && slot.troughPrice > 0 ? slot.troughPrice : slot.entryPrice, markPrice);
        }
        const effectiveLev = this.leverage > 0 ? this.leverage : 20.0;
        const rawRoePct = isLong
            ? ((markPrice - slot.entryPrice) / slot.entryPrice) * effectiveLev * 100.0
            : ((slot.entryPrice - markPrice) / slot.entryPrice) * effectiveLev * 100.0;
        if (rawRoePct > (slot.peakRoe ?? 0)) {
            slot.peakRoe = rawRoePct;
        }
        // Dynamic Continuous Tick-by-Tick Trailing SL (Locks past Entry Price as soon as in profit)
        const minVol = (volMetrics && volMetrics.garmanKlass1s > 0.000001) ? Math.sqrt(volMetrics.garmanKlass1s) : 0.0020;
        const dynamicTrailDist = Math.max(this.priceTickSize * 3, slot.entryPrice * Math.max(0.0010, minVol * 1.0));
        if (!slot.breakEvenPrice || slot.breakEvenPrice <= 0) {
            slot.breakEvenPrice = this.formatPriceFast(isLong ? slot.entryPrice * (1.0 + roundTripFeeBuffer) : slot.entryPrice * (1.0 - roundTripFeeBuffer));
        }
        const maxLongSl = this.formatPriceFast(markPrice - this.priceTickSize * 2);
        const minShortSl = this.formatPriceFast(markPrice + this.priceTickSize * 2);
        // Tier 1: +8.0% Net ROE -> Lock Entry + Round-Trip Fees
        if (rawRoePct >= 8.0) {
            const beOffset = roundTripFeeBuffer + 0.0002;
            const rawTier1 = isLong ? slot.entryPrice * (1.0 + beOffset) : slot.entryPrice * (1.0 - beOffset);
            const targetTier1Sl = isLong ? Math.min(maxLongSl, this.formatPriceFast(rawTier1)) : Math.max(minShortSl, this.formatPriceFast(rawTier1));
            if (!slot.stepCollarTier || slot.stepCollarTier < 1) {
                slot.stepCollarTier = 1;
                slot.breakEvenLocked = true;
                slot.breakEvenPrice = targetTier1Sl;
            }
            this.applyMonotonicStopLoss(slot, targetTier1Sl);
        }
        // Tier 2: +15.0% Net ROE -> Lock +10.0% ROE
        if (rawRoePct >= 15.0) {
            const lockOffset = (10.0 / 100.0) / effectiveLev;
            const rawTier2 = isLong ? slot.entryPrice * (1.0 + lockOffset) : slot.entryPrice * (1.0 - lockOffset);
            const targetTier2Sl = isLong ? Math.min(maxLongSl, this.formatPriceFast(rawTier2)) : Math.max(minShortSl, this.formatPriceFast(rawTier2));
            if (!slot.stepCollarTier || slot.stepCollarTier < 2) {
                slot.stepCollarTier = 2;
                slot.breakEvenLocked = true;
            }
            this.applyMonotonicStopLoss(slot, targetTier2Sl);
        }
        // Tier 3: >= +25.0% Net ROE -> Aggressive 70% Trailing Profit Collar
        if (rawRoePct >= 25.0 || (slot.peakRoe && slot.peakRoe >= 25.0)) {
            const currentPeakRoe = slot.peakRoe ?? rawRoePct;
            const trailRoe = currentPeakRoe * 0.70;
            const trailOffset = (trailRoe / 100.0) / effectiveLev;
            const rawTier3 = isLong ? slot.entryPrice * (1.0 + trailOffset) : slot.entryPrice * (1.0 - trailOffset);
            const targetTier3Sl = isLong ? Math.min(maxLongSl, this.formatPriceFast(rawTier3)) : Math.max(minShortSl, this.formatPriceFast(rawTier3));
            if (!slot.stepCollarTier || slot.stepCollarTier < 3) {
                slot.stepCollarTier = 3;
                slot.breakEvenLocked = true;
            }
            this.applyMonotonicStopLoss(slot, targetTier3Sl);
        }
        // Phase 4B: Hard Terminal Horizon Timeout (duration >= 1800s / 30 Minutes Max Lifespan)
        // Idempotency guard: timeDecayTier < 4 prevents multi-tick trigger floods after 30 minutes.
        if (durationSec >= 1800.0) {
            if (!slot.timeDecayTier || slot.timeDecayTier < 4) {
                slot.timeDecayTier = 4;
                this.pushSotaTrigger(slot.slotId, slot.side, "LONG_HOLD_PROFIT_HARVEST", slot.quantity, slot.entryPrice, markPrice, false, slot.activeTpOrderIds, slot.activeStopLossOrderId);
            }
            return;
        }
        // -------------------------------------------------------------------------
        // 2. Cox Proportional Hazard Rate Survival Exit
        // -------------------------------------------------------------------------
        if (hazardMetrics && hazardMetrics.isHazardExitTriggered) {
            this.pushSotaTrigger(slot.slotId, slot.side, `HAZARD_FLUSH_EXIT_${slot.side}`, slot.quantity, slot.entryPrice, markPrice, false, slot.activeTpOrderIds, slot.activeStopLossOrderId);
            return;
        }
        // -------------------------------------------------------------------------
        // 3. Avellaneda-Stoikov HJB Optimal Stopping Liquidation Boundary
        // -------------------------------------------------------------------------
        if (hjbEngine && volMetrics) {
            const hjbEval = hjbEngine.getOptimalExitBoundary(slot.side, slot.entryPrice, stoikovMicroPrice, slot.quantity, durationMs, volMetrics.garmanKlass1s);
            if (hjbEval.isLiquidationTriggered) {
                this.pushSotaTrigger(slot.slotId, slot.side, hjbEval.exitReason, slot.quantity, slot.entryPrice, markPrice, false, slot.activeTpOrderIds, slot.activeStopLossOrderId);
                return;
            }
        }
        // -------------------------------------------------------------------------
        // 4. MS-SOPC (Microstructure-Informed Stochastic Optimal Profit Collaring)
        // -------------------------------------------------------------------------
        if (isLong) {
            // Tick-0 Initialization Protocol: anchor peakPrice at entryPrice
            if (!slot.peakPrice || slot.peakPrice <= 0) {
                slot.peakPrice = slot.entryPrice;
            }
            // Advance peak and ratchet collar stop only when in true profit (above entry + fee buffer + minNetAlpha)
            const minProfitFloorLong = slot.entryPrice * (1.0 + roundTripFeeBuffer + minNetAlpha);
            if (stoikovMicroPrice > 0 && stoikovMicroPrice > slot.peakPrice) {
                slot.peakPrice = stoikovMicroPrice;
                if (slot.peakPrice >= minProfitFloorLong) {
                    const collarOffsetUsdt = slot.peakPrice * collarDistancePct;
                    const msSopcStopPrice = this.formatPriceFast(slot.peakPrice - collarOffsetUsdt);
                    this.applyMonotonicStopLoss(slot, msSopcStopPrice);
                }
            }
        }
        else {
            // Tick-0 Initialization Protocol: anchor troughPrice at entryPrice
            if (!slot.troughPrice || slot.troughPrice <= 0) {
                slot.troughPrice = slot.entryPrice;
            }
            // Advance trough and ratchet collar stop only when in true profit (below entry - fee buffer - minNetAlpha)
            const minProfitFloorShort = slot.entryPrice * (1.0 - roundTripFeeBuffer - minNetAlpha);
            if (stoikovMicroPrice > 0 && stoikovMicroPrice < slot.troughPrice) {
                slot.troughPrice = stoikovMicroPrice;
                if (slot.troughPrice <= minProfitFloorShort) {
                    const collarOffsetUsdt = slot.troughPrice * collarDistancePct;
                    const msSopcStopPrice = this.formatPriceFast(slot.troughPrice + collarOffsetUsdt);
                    this.applyMonotonicStopLoss(slot, msSopcStopPrice);
                }
            }
        }
        // Check Trigger
        const isStopTriggered = isLong
            ? markPrice <= slot.stopLossPrice
            : markPrice >= slot.stopLossPrice;
        if (isStopTriggered) {
            const exitReason = slot.timeDecayTier && slot.timeDecayTier >= 1
                ? "BREAK_EVEN_STOP_LOSS"
                : `MVA_TRAILING_STOP_${slot.side}`;
            this.pushSotaTrigger(slot.slotId, slot.side, exitReason, slot.quantity, slot.entryPrice, markPrice, false, slot.activeTpOrderIds, slot.activeStopLossOrderId);
        }
    }
    formatPriceFast(rawPrice) {
        if (rawPrice <= 0)
            return 0;
        const rounded = Math.round(rawPrice / this.priceTickSize) * this.priceTickSize;
        return Math.round(rounded * this.priceFactor) / this.priceFactor;
    }
    pushSotaTrigger(slotId, side, reason, quantity, entryPrice, markPrice, isPartialClose, activeTpOrderIds, activeStopLossOrderId) {
        const idx = this.sotaTriggers.length;
        if (idx < this.preallocatedTriggers.length) {
            const trg = this.preallocatedTriggers[idx];
            trg.slotId = slotId;
            trg.side = side;
            trg.reason = reason;
            trg.quantity = quantity;
            trg.entryPrice = entryPrice;
            trg.markPrice = markPrice;
            trg.isPartialClose = isPartialClose;
            const cancelIds = [];
            if (activeTpOrderIds && activeTpOrderIds.length > 0) {
                cancelIds.push(...activeTpOrderIds);
            }
            if (activeStopLossOrderId && activeStopLossOrderId > 0) {
                cancelIds.push(activeStopLossOrderId);
            }
            trg.cancelOrderIds = cancelIds.length > 0 ? cancelIds : undefined;
            this.sotaTriggers.push(trg);
        }
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
    getActiveTradeSlots(currentPrice = 0, leverage = this.leverage, longTpPct = 2.5, longSlPct = 1.2, shortTpPct = 0.6, shortSlPct = 0.5) {
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
                totalGrossNotional += summary.grossQuantity * (price > 0 ? price : summary.averageEntryPrice);
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
