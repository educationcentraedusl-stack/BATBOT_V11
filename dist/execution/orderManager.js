"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderManager = void 0;
const binance_1 = require("./binance");
const risk_1 = require("./risk");
const clientOrderIdGenerator_1 = require("./clientOrderIdGenerator");
const symbolPrecision_1 = require("../config/symbolPrecision");
class OrderManager {
    executionClient;
    riskEngine;
    orderStates = new Map();
    maxLatencyMs;
    enableExchangeNativeSl;
    // Latency telemetry metrics
    totalTicks = 0;
    totalSlUpdates = 0;
    totalTpTriggers = 0;
    totalSlTriggers = 0;
    totalEmergencyExits = 0;
    totalEvalDurationNs = 0n;
    maxEvalLatencyUs = 0;
    constructor(config) {
        this.executionClient = config?.executionClient ?? new binance_1.BinanceExecutionClient();
        this.riskEngine = new risk_1.StepCollarRiskEngine(config?.riskConfig);
        this.maxLatencyMs = config?.maxLatencyMs ?? 2.0; // < 2ms HFT execution bound
        this.enableExchangeNativeSl = config?.enableExchangeNativeSl ?? true;
    }
    getRiskEngine() {
        return this.riskEngine;
    }
    getExecutionClient() {
        return this.executionClient;
    }
    /**
     * Registers a newly opened or active position for dynamic risk tracking.
     */
    trackPosition(symbol, side, entryPrice, quantity, initialStopLossPrice, targetTakeProfitPrice) {
        const posState = this.riskEngine.registerPosition(symbol, side, entryPrice, quantity, initialStopLossPrice, targetTakeProfitPrice);
        const key = this.getKey(symbol, side);
        const existing = this.orderStates.get(key);
        if (!existing) {
            this.orderStates.set(key, {
                symbol,
                side,
                activeStopLossOrderId: null,
                activeStopLossClientOrderId: null,
                lastSyncedStopPrice: posState.currentStopLossPrice,
                activeTakeProfitOrderId: null,
                activeTakeProfitClientOrderId: null,
                lastSyncedTakeProfitPrice: posState.targetTakeProfitPrice,
                inFlightUpdate: false,
                pendingSlTarget: null,
            });
        }
        else {
            existing.lastSyncedStopPrice = posState.currentStopLossPrice;
            existing.lastSyncedTakeProfitPrice = posState.targetTakeProfitPrice;
            existing.inFlightUpdate = false;
            existing.pendingSlTarget = null;
        }
        return posState;
    }
    /**
     * Untracks a closed position and clears managed order states.
     */
    untrackPosition(symbol, side) {
        this.riskEngine.removePosition(symbol, side);
        const key = this.getKey(symbol, side);
        this.orderStates.delete(key);
    }
    /**
     * Zero-GC High-Frequency Price Tick Ingestion & Action Dispatch (< 2ms execution budget).
     */
    onPriceTick(symbol, markPrice, positionSide) {
        const startNs = process.hrtime.bigint();
        const results = [];
        const sidesToEval = positionSide
            ? [positionSide]
            : ["LONG", "SHORT"];
        for (const side of sidesToEval) {
            const pos = this.riskEngine.getPosition(symbol, side);
            if (!pos)
                continue;
            const evalResult = this.riskEngine.evaluateTick(symbol, side, markPrice);
            this.totalTicks++;
            if (evalResult.isTakeProfitTriggered) {
                this.totalTpTriggers++;
                this.handleTakeProfitTrigger(symbol, side, pos.quantity, markPrice, evalResult.reason);
            }
            else if (evalResult.isStopLossTriggered) {
                this.totalSlTriggers++;
                this.handleStopLossTrigger(symbol, side, pos.quantity, markPrice, evalResult.reason);
            }
            else if (evalResult.shouldUpdateStopLoss) {
                this.totalSlUpdates++;
                this.handleDynamicStopLossUpdate(symbol, side, pos.quantity, evalResult.newStopLossPrice);
            }
            results.push({ ...evalResult });
        }
        const endNs = process.hrtime.bigint();
        const durationNs = endNs - startNs;
        this.totalEvalDurationNs += durationNs;
        const latencyUs = Number(durationNs) / 1000;
        if (latencyUs > this.maxEvalLatencyUs) {
            this.maxEvalLatencyUs = latencyUs;
        }
        return results;
    }
    /**
     * Updates resting / conditional Stop Loss order on the exchange.
     * Enforces asynchronous queue locking to maintain strict < 2ms latency bounds.
     */
    async updateStopLossOrder(symbol, side, quantity, newStopPrice) {
        const key = this.getKey(symbol, side);
        const state = this.orderStates.get(key);
        if (!state)
            return null;
        if (state.inFlightUpdate) {
            state.pendingSlTarget = newStopPrice;
            return null;
        }
        state.inFlightUpdate = true;
        try {
            // Exit side: LONG position -> SELL order; SHORT position -> BUY order
            const exitSide = side === "LONG" ? "SELL" : "BUY";
            const slotId = side === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0";
            const clientOrderId = clientOrderIdGenerator_1.ClientOrderIdGenerator.generate(symbol, slotId, "SL");
            // 1. Cancel previous resting Stop Loss order if present
            if (state.activeStopLossOrderId !== null) {
                try {
                    await this.executionClient.cancelOrder(symbol, state.activeStopLossOrderId);
                }
                catch (cancelErr) {
                    // Non-blocking catch for already filled / expired orders
                }
            }
            // 2. Dispatch new STOP_MARKET conditional order
            const formattedStop = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(symbol, newStopPrice);
            const params = {
                symbol,
                side: exitSide,
                type: "STOP_MARKET",
                quantity,
                stopPrice: formattedStop,
                positionSide: side,
                clientOrderId,
                closePosition: false,
            };
            const res = await this.executionClient.placeOrder(params);
            state.activeStopLossOrderId = res.orderId;
            state.activeStopLossClientOrderId = clientOrderId;
            state.lastSyncedStopPrice = formattedStop;
            return res;
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[OrderManager] Failed to update Stop Loss for ${symbol} ${side} @ ${newStopPrice}: ${errMsg}`);
            return null;
        }
        finally {
            state.inFlightUpdate = false;
            // Drain queued pending update if price moved during in-flight network dispatch
            if (state.pendingSlTarget !== null && state.pendingSlTarget !== state.lastSyncedStopPrice) {
                const queuedTarget = state.pendingSlTarget;
                state.pendingSlTarget = null;
                this.updateStopLossOrder(symbol, side, quantity, queuedTarget).catch(() => { });
            }
        }
    }
    /**
     * Submits a Take Profit limit/market exit order.
     */
    async updateTakeProfitOrder(symbol, side, quantity, newTpPrice) {
        const exitSide = side === "LONG" ? "SELL" : "BUY";
        const slotId = side === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0";
        const clientOrderId = clientOrderIdGenerator_1.ClientOrderIdGenerator.generate(symbol, slotId, "TP1");
        try {
            const formattedTp = symbolPrecision_1.SymbolPrecisionRegistry.formatPrice(symbol, newTpPrice);
            const params = {
                symbol,
                side: exitSide,
                type: "LIMIT",
                quantity,
                price: formattedTp,
                timeInForce: "GTX",
                positionSide: side,
                clientOrderId,
            };
            return await this.executionClient.placeOrder(params);
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[OrderManager] Failed to place TP order for ${symbol} ${side} @ ${newTpPrice}: ${errMsg}`);
            return null;
        }
    }
    /**
     * Executes an immediate Emergency Market Close for a position.
     */
    async executeEmergencyClose(symbol, side, quantity, reason) {
        this.totalEmergencyExits++;
        const exitSide = side === "LONG" ? "SELL" : "BUY";
        const slotId = side === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0";
        const clientOrderId = clientOrderIdGenerator_1.ClientOrderIdGenerator.generate(symbol, slotId, "EM");
        // Cancel all open orders for symbol
        try {
            await this.executionClient.cancelAllOrders(symbol);
        }
        catch (cancelErr) {
            // Proceed to emergency market close regardless
        }
        try {
            const params = {
                symbol,
                side: exitSide,
                type: "MARKET",
                quantity,
                positionSide: side,
                clientOrderId,
            };
            const res = await this.executionClient.placeOrder(params);
            this.untrackPosition(symbol, side);
            return res;
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[OrderManager][CRITICAL] Emergency market close failed for ${symbol} ${side} (${reason}): ${errMsg}`);
            return null;
        }
    }
    /**
     * Ingests Binance WebSocket User Data Stream Execution Reports.
     */
    handleExecutionReport(update) {
        if (!update || update.eventType !== "ORDER_TRADE_UPDATE")
            return;
        const ord = update.order;
        const parsedCid = clientOrderIdGenerator_1.ClientOrderIdGenerator.parse(ord.clientOrderId);
        if (ord.orderStatus === "FILLED") {
            const isClose = (parsedCid && (parsedCid.orderType.startsWith("TP") || parsedCid.orderType === "SL" || parsedCid.orderType === "EM"));
            if (isClose) {
                const side = ord.positionSide === "SHORT" ? "SHORT" : "LONG";
                this.untrackPosition(ord.symbol, side);
            }
        }
    }
    /**
     * Returns active position risk telemetry from Risk Engine.
     */
    getPositionRisk(symbol, side) {
        return this.riskEngine.getPosition(symbol, side);
    }
    /**
     * Returns all tracked position keys and states.
     */
    getAllTrackedPositions() {
        const states = [];
        for (const key of this.orderStates.keys()) {
            const [sym, side] = key.split("_");
            const pos = this.riskEngine.getPosition(sym, side);
            if (pos)
                states.push(pos);
        }
        return states;
    }
    /**
     * Returns real-time latency and throughput telemetry.
     */
    getMetrics() {
        const avgLatencyUs = this.totalTicks > 0
            ? Number(this.totalEvalDurationNs) / (this.totalTicks * 1000)
            : 0;
        return {
            totalTickEvaluations: this.totalTicks,
            totalStopLossUpdates: this.totalSlUpdates,
            totalTakeProfitTriggers: this.totalTpTriggers,
            totalStopLossTriggers: this.totalSlTriggers,
            totalEmergencyExits: this.totalEmergencyExits,
            avgEvaluationLatencyUs: avgLatencyUs,
            maxEvaluationLatencyUs: this.maxEvalLatencyUs,
            activeTrackedPositions: this.orderStates.size,
        };
    }
    // --- Private Handler Routines ---
    handleDynamicStopLossUpdate(symbol, side, quantity, newStopLossPrice) {
        if (!this.enableExchangeNativeSl)
            return;
        this.updateStopLossOrder(symbol, side, quantity, newStopLossPrice).catch((err) => {
            console.warn(`[OrderManager] Asynchronous SL ratchet dispatch error: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    handleTakeProfitTrigger(symbol, side, quantity, markPrice, reason) {
        const exitSide = side === "LONG" ? "SELL" : "BUY";
        const slotId = side === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0";
        const clientOrderId = clientOrderIdGenerator_1.ClientOrderIdGenerator.generate(symbol, slotId, "TP5");
        this.executionClient.placeOrder({
            symbol,
            side: exitSide,
            type: "MARKET",
            quantity,
            positionSide: side,
            clientOrderId,
        }).then(() => {
            this.untrackPosition(symbol, side);
        }).catch((err) => {
            console.error(`[OrderManager] Take Profit execution error for ${symbol} ${side}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    handleStopLossTrigger(symbol, side, quantity, markPrice, reason) {
        this.executeEmergencyClose(symbol, side, quantity, reason).catch((err) => {
            console.error(`[OrderManager] Stop Loss execution error for ${symbol} ${side}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    getKey(symbol, side) {
        return `${symbol.toUpperCase()}_${side.toUpperCase()}`;
    }
}
exports.OrderManager = OrderManager;
