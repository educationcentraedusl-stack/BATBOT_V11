"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const engine_1 = require("../strategy/engine");
const binance_1 = require("../execution/binance");
const positionLedger_1 = require("../strategy/positionLedger");
/**
 * Institutional Mock Execution Client for Phase 3 Sovereign Order State Machine Verification
 */
class SovereignTestExecutionClient extends binance_1.BinanceExecutionClient {
    outboundDispatches = [];
    nextOrderId = 880001;
    constructor() {
        super({ apiKey: "MOCK_KEY", apiSecret: "MOCK_SECRET", useTestnet: true });
    }
    async placePositionStopLoss(symbol, side, positionSide, stopPrice, clientOrderId, signal, quantity) {
        const orderId = this.nextOrderId++;
        this.outboundDispatches.push({
            type: "PLACE_POSITION_SL",
            orderId,
            stopPrice,
            quantity,
            clientOrderId,
            timestamp: Date.now(),
        });
        return {
            orderId,
            symbol,
            status: "NEW",
            clientOrderId: clientOrderId || `mock_pos_sl_${orderId}`,
            price: "0",
            avgPrice: "0",
            origQty: String(quantity || 0.05),
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: "STOP_MARKET",
            reduceOnly: false,
            side,
            positionSide,
            stopPrice: String(stopPrice),
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    }
    async placeQuantityStopLoss(symbol, side, positionSide, stopPrice, quantity, clientOrderId, signal) {
        const orderId = this.nextOrderId++;
        this.outboundDispatches.push({
            type: "PLACE_QUANTITY_SL",
            orderId,
            stopPrice,
            quantity,
            clientOrderId,
            timestamp: Date.now(),
        });
        return {
            orderId,
            symbol,
            status: "NEW",
            clientOrderId: clientOrderId || `mock_qty_sl_${orderId}`,
            price: "0",
            avgPrice: "0",
            origQty: String(quantity),
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: "STOP_MARKET",
            reduceOnly: false,
            side,
            positionSide,
            stopPrice: String(stopPrice),
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    }
    async placeBatchOrders(orders, signal) {
        const responses = [];
        for (const ord of orders) {
            const orderId = this.nextOrderId++;
            this.outboundDispatches.push({
                type: "PLACE_BATCH",
                orderId,
                quantity: ord.quantity,
                clientOrderId: ord.clientOrderId,
                timestamp: Date.now(),
            });
            responses.push({
                orderId,
                symbol: ord.symbol,
                status: "NEW",
                clientOrderId: ord.clientOrderId || `mock_tp_${orderId}`,
                price: String(ord.price || 0),
                avgPrice: "0",
                origQty: String(ord.quantity),
                executedQty: "0",
                cumQuote: "0",
                timeInForce: ord.timeInForce || "GTC",
                type: ord.type,
                reduceOnly: ord.reduceOnly || false,
                side: ord.side,
                positionSide: ord.positionSide || "BOTH",
                stopPrice: "0",
                workingType: "CONTRACT_PRICE",
                updateTime: Date.now(),
            });
        }
        return responses;
    }
    async cancelOrder(symbol, orderId, signal) {
        this.outboundDispatches.push({
            type: "CANCEL",
            orderId,
            timestamp: Date.now(),
        });
        return {
            orderId: Number(orderId),
            symbol,
            status: "CANCELED",
            clientOrderId: `cancel_${orderId}`,
            price: "0",
            avgPrice: "0",
            origQty: "0",
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: "STOP_MARKET",
            reduceOnly: false,
            side: "SELL",
            positionSide: "LONG",
            stopPrice: "0",
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    }
}
function wrapWsUpdate(order) {
    return {
        eventType: "ORDER_TRADE_UPDATE",
        eventTime: Date.now(),
        transactionTime: Date.now(),
        order,
    };
}
async function runPhase3SovereignOrderStateMachineTests() {
    console.log("==========================================================================================");
    console.log("  PHASE 3 VERIFICATION: SOVEREIGN ORDER STATE MACHINE & REACTIVE WS INVALIDATION          ");
    console.log("==========================================================================================\n");
    const sab = new SharedArrayBuffer(20480);
    const mdClient = new marketDataClient_1.MarketDataClient(sab, 10, 256);
    const riskGuard = new risk_1.RiskGuard();
    const hedgeLedger = new positionLedger_1.HedgePositionLedger("BTCUSDT");
    const execClient = new SovereignTestExecutionClient();
    const engine = new engine_1.StrategyEngine(mdClient, riskGuard, execClient, { symbol: "BTCUSDT" }, undefined, hedgeLedger);
    // =========================================================================
    // STAGE 1: Strict Type Partitioning Test
    // =========================================================================
    console.log("[STAGE 1] Testing Strict Type Partitioning (Maker TP LIMIT orders excluded from SL protection)...");
    const mockOpenOrders = [
        {
            orderId: 50001,
            symbol: "BTCUSDT",
            status: "NEW",
            clientOrderId: "tp_limit_50001",
            price: "72000.0",
            avgPrice: "0",
            origQty: "0.05",
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: "LIMIT",
            reduceOnly: true,
            side: "SELL",
            positionSide: "LONG",
            stopPrice: "0",
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        },
        {
            orderId: 50002,
            symbol: "BTCUSDT",
            status: "NEW",
            clientOrderId: "tp_mkt_50002",
            price: "73000.0",
            avgPrice: "0",
            origQty: "0.05",
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: "TAKE_PROFIT_MARKET",
            reduceOnly: true,
            side: "SELL",
            positionSide: "LONG",
            stopPrice: "73000.0",
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        },
    ];
    // 1a: auditAggregatedPositionRisk must reject LIMIT order
    const auditLimit = riskGuard.auditAggregatedPositionRisk("BTCUSDT", "LONG", 0.05, 50001, mockOpenOrders);
    node_assert_1.default.strictEqual(auditLimit.isProtected, false, "Audit must fail when orderId is a LIMIT order");
    node_assert_1.default.ok(auditLimit.reason && auditLimit.reason.includes("INVALID_ORDER_TYPE"), `Reason must mention INVALID_ORDER_TYPE, got: ${auditLimit.reason}`);
    // 1b: auditAggregatedPositionRisk must reject TAKE_PROFIT_MARKET order
    const auditTpMkt = riskGuard.auditAggregatedPositionRisk("BTCUSDT", "LONG", 0.05, 50002, mockOpenOrders);
    node_assert_1.default.strictEqual(auditTpMkt.isProtected, false, "Audit must fail when orderId is a TAKE_PROFIT_MARKET order");
    node_assert_1.default.ok(auditTpMkt.reason && auditTpMkt.reason.includes("INVALID_ORDER_TYPE"), `Reason must mention INVALID_ORDER_TYPE, got: ${auditTpMkt.reason}`);
    // 1c: syncExchangeStateWithData with only LIMIT order must NOT satisfy SL protection and must dispatch STOP_MARKET
    const mockPositions = [
        {
            symbol: "BTCUSDT",
            positionAmt: "0.05",
            entryPrice: "70000.0",
            markPrice: "70000.0",
            unRealizedProfit: "0",
            liquidationPrice: "40000.0",
            leverage: "10",
            maxNotionalValue: "1000000",
            marginType: "cross",
            isolatedMargin: "0",
            isAutoAddMargin: "false",
            positionSide: "LONG",
            notional: "3500.0",
            isolatedWallet: "0",
            updateTime: Date.now(),
        },
    ];
    const preDispatchCount = execClient.outboundDispatches.length;
    await engine.syncExchangeStateWithData(mockPositions, mockOpenOrders);
    // Must have dispatched a STOP_MARKET order because LIMIT orders are strictly excluded
    const slDispatches = execClient.outboundDispatches.filter((d, idx) => idx >= preDispatchCount && (d.type === "PLACE_POSITION_SL" || d.type === "PLACE_QUANTITY_SL"));
    node_assert_1.default.strictEqual(slDispatches.length, 1, "Must have dispatched exactly 1 emergency STOP_MARKET order");
    const registeredSlId = hedgeLedger.getActiveStopLossOrderId("LONG");
    node_assert_1.default.ok(registeredSlId !== undefined && registeredSlId > 0, "Ledger must have registered active Stop Loss order ID");
    console.log(`  ✅ Stage 1 Passed: LIMIT/TP orders strictly rejected for SL protection. Emergency SL #${registeredSlId} dispatched.\n`);
    // =========================================================================
    // STAGE 2: Reactive WS Invalidation Test (CANCELED)
    // =========================================================================
    console.log("[STAGE 2] Testing Reactive WS Invalidation on CANCELED event...");
    const activeSlId = hedgeLedger.getActiveStopLossOrderId("LONG");
    node_assert_1.default.ok(activeSlId > 0, "Pre-condition: Active SL order ID must be set");
    const cancelDispatchesStart = execClient.outboundDispatches.length;
    // Simulate Binance WebSocket executionReport with CANCELED status for the active SL order
    const wsCancelUpdate = {
        symbol: "BTCUSDT",
        clientOrderId: `mock_pos_sl_${activeSlId}`,
        side: "SELL",
        orderType: "STOP_MARKET",
        timeInForce: "GTC",
        originalQuantity: 0.05,
        originalPrice: 0,
        averagePrice: 0,
        stopPrice: 69000,
        executionType: "CANCELED",
        orderStatus: "CANCELED",
        orderId: activeSlId,
        lastFilledQuantity: 0,
        cumulativeFilledQuantity: 0,
        lastFilledPrice: 0,
        commissionAmount: 0,
        commissionAsset: "USDT",
        tradeTime: Date.now(),
        tradeId: 0,
        bidsNotional: 0,
        isMaker: false,
        positionSide: "LONG",
        realizedPnl: 0,
        reduceOnly: false,
    };
    engine.handleWsOrderUpdate(wrapWsUpdate(wsCancelUpdate));
    // Allow microtasks / fast-path dispatch to execute
    await new Promise((resolve) => setTimeout(resolve, 50));
    const postCancelSlId = hedgeLedger.getActiveStopLossOrderId("LONG");
    node_assert_1.default.ok(postCancelSlId !== undefined && postCancelSlId !== activeSlId, `Ledger must have cleared old SL #${activeSlId} and registered new emergency replacement SL #${postCancelSlId}`);
    const emergencyDispatches = execClient.outboundDispatches.filter((d, idx) => idx >= cancelDispatchesStart && (d.type === "PLACE_POSITION_SL" || d.type === "PLACE_QUANTITY_SL"));
    node_assert_1.default.ok(emergencyDispatches.length >= 1, "Fast-path emergency Stop-Loss replacement must have been dispatched to Binance");
    console.log(`  ✅ Stage 2 Passed: CANCELED SL #${activeSlId} reactively healed with replacement SL #${postCancelSlId}.\n`);
    // =========================================================================
    // STAGE 3: Reactive WS Invalidation Test (EXPIRED & REJECTED)
    // =========================================================================
    console.log("[STAGE 3] Testing Reactive WS Invalidation on EXPIRED and REJECTED events...");
    // 3a: Test EXPIRED
    const currentSlBeforeExpire = hedgeLedger.getActiveStopLossOrderId("LONG");
    const wsExpireUpdate = {
        ...wsCancelUpdate,
        orderId: currentSlBeforeExpire,
        orderStatus: "EXPIRED",
        executionType: "EXPIRED",
    };
    const expireDispatchesStart = execClient.outboundDispatches.length;
    engine.handleWsOrderUpdate(wrapWsUpdate(wsExpireUpdate));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const postExpireSlId = hedgeLedger.getActiveStopLossOrderId("LONG");
    node_assert_1.default.ok(postExpireSlId !== undefined && postExpireSlId !== currentSlBeforeExpire, `Ledger must clear expired SL #${currentSlBeforeExpire} and replace with #${postExpireSlId}`);
    console.log(`  ✅ Stage 3a Passed: EXPIRED SL #${currentSlBeforeExpire} replaced with #${postExpireSlId}.`);
    // 3b: Test REJECTED
    const currentSlBeforeReject = postExpireSlId;
    const wsRejectUpdate = {
        ...wsCancelUpdate,
        orderId: currentSlBeforeReject,
        orderStatus: "REJECTED",
        executionType: "REJECTED",
    };
    engine.handleWsOrderUpdate(wrapWsUpdate(wsRejectUpdate));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const postRejectSlId = hedgeLedger.getActiveStopLossOrderId("LONG");
    node_assert_1.default.ok(postRejectSlId !== undefined && postRejectSlId !== currentSlBeforeReject, `Ledger must clear rejected SL #${currentSlBeforeReject} and replace with #${postRejectSlId}`);
    console.log(`  ✅ Stage 3b Passed: REJECTED SL #${currentSlBeforeReject} replaced with #${postRejectSlId}.\n`);
    // =========================================================================
    // STAGE 4: TP Invalidation & Ledger Pruning
    // =========================================================================
    console.log("[STAGE 4] Testing TP Invalidation & Ledger Pruning on CANCELED and FILLED events...");
    // Register active TP order IDs in coreLong
    hedgeLedger.registerActiveTpOrderIds("CORE_LONG", [60001, 60002, 60003]);
    const initialTpIds = hedgeLedger.getCoreLong().activeTpOrderIds;
    node_assert_1.default.deepStrictEqual(initialTpIds, [60001, 60002, 60003], "CoreLong must have 3 TP order IDs registered");
    // 4a: Simulate WS CANCELED on TP order #60002
    const wsTpCancelUpdate = {
        ...wsCancelUpdate,
        orderId: 60002,
        orderType: "LIMIT",
        side: "SELL",
        positionSide: "LONG",
        orderStatus: "CANCELED",
        executionType: "CANCELED",
    };
    engine.handleWsOrderUpdate(wrapWsUpdate(wsTpCancelUpdate));
    const remainingTpIdsAfterCancel = hedgeLedger.getCoreLong().activeTpOrderIds;
    node_assert_1.default.deepStrictEqual(remainingTpIdsAfterCancel, [60001, 60003], "Order #60002 must be cleanly pruned from activeTpOrderIds on CANCELED");
    console.log(`  ✅ Stage 4a Passed: CANCELED TP Order #60002 pruned. Remaining: [${remainingTpIdsAfterCancel.join(", ")}].`);
    // 4b: Simulate WS FILLED on TP order #60001 (deducts position & prunes TP order ID)
    const wsTpFillUpdate = {
        ...wsCancelUpdate,
        orderId: 60001,
        orderType: "LIMIT",
        side: "SELL",
        positionSide: "LONG",
        orderStatus: "FILLED",
        executionType: "TRADE",
        lastFilledQuantity: 0.02,
        cumulativeFilledQuantity: 0.02,
        lastFilledPrice: 72000.0,
        isMaker: true,
    };
    engine.handleWsOrderUpdate(wrapWsUpdate(wsTpFillUpdate));
    const remainingTpIdsAfterFill = hedgeLedger.getCoreLong().activeTpOrderIds;
    node_assert_1.default.ok(!remainingTpIdsAfterFill.includes(60001), "Order #60001 must be pruned from activeTpOrderIds on fill");
    console.log(`  ✅ Stage 4b Passed: FILLED TP Order #60001 pruned from activeTpOrderIds.\n`);
    // Allow in-flight ratcheting SL dispatch from partial exit to settle before Stage 5
    await new Promise((resolve) => setTimeout(resolve, 100));
    // =========================================================================
    // STAGE 5: Continuous Reconciliation Consensus Test
    // =========================================================================
    console.log("[STAGE 5] Testing Continuous Reconciliation Consensus (Binance physical order adoption & vanished order healing)...");
    // 5a: Physical order adoption into ledger
    // Reset local ledger SL reference to 0
    hedgeLedger.clearActiveStopLossOrderId("LONG");
    node_assert_1.default.strictEqual(hedgeLedger.hasActiveStopLossOrder("LONG"), false, "Ledger SL must be cleared");
    const physicalSlOrders = [
        {
            orderId: 99001,
            symbol: "BTCUSDT",
            status: "NEW",
            clientOrderId: "binance_sl_99001",
            price: "0",
            avgPrice: "0",
            origQty: "0.03",
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: "STOP_MARKET",
            reduceOnly: false,
            side: "SELL",
            positionSide: "LONG",
            stopPrice: "68500.0",
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        },
    ];
    await engine.syncExchangeStateWithData(mockPositions, physicalSlOrders);
    const adoptedSlId = hedgeLedger.getActiveStopLossOrderId("LONG");
    node_assert_1.default.strictEqual(adoptedSlId, 99001, "Reconciliation heartbeat must adopt physical Binance STOP_MARKET Order #99001");
    console.log(`  ✅ Stage 5a Passed: Physical Binance STOP_MARKET Order #99001 adopted into ledger.`);
    // 5b: Vanished order detection and immediate emergency dispatch
    // Ledger holds #99001, but Binance open orders returns empty []
    const preHealingDispatches = execClient.outboundDispatches.length;
    await engine.syncExchangeStateWithData(mockPositions, []);
    const healedSlId = hedgeLedger.getActiveStopLossOrderId("LONG");
    node_assert_1.default.ok(healedSlId !== undefined && healedSlId !== 99001, `Vanished order #99001 must be cleared and replaced with a newly dispatched SL, got: #${healedSlId}`);
    const healingDispatches = execClient.outboundDispatches.filter((d, idx) => idx >= preHealingDispatches && (d.type === "PLACE_POSITION_SL" || d.type === "PLACE_QUANTITY_SL"));
    node_assert_1.default.strictEqual(healingDispatches.length, 1, "Exactly 1 emergency healing SL must be dispatched to Binance");
    console.log(`  ✅ Stage 5b Passed: Vanished SL #99001 detected, desync cleared, emergency SL #${healedSlId} dispatched.\n`);
    console.log("==========================================================================================");
    console.log("  ALL 5 STAGES PASSED: SOVEREIGN ORDER STATE MACHINE & REACTIVE WS HEALING VERIFIED 100%  ");
    console.log("==========================================================================================");
    process.exit(0);
}
runPhase3SovereignOrderStateMachineTests().catch((err) => {
    console.error("❌ Phase 3 Sovereign Order State Machine Test Suite FAILED:", err);
    process.exit(1);
});
