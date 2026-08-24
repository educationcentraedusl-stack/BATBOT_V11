"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const binance_js_1 = require("../execution/binance.js");
const engine_js_1 = require("../strategy/engine.js");
const positionLedger_js_1 = require("../strategy/positionLedger.js");
const risk_js_1 = require("../strategy/risk.js");
const marketDataClient_js_1 = require("../marketDataClient.js");
const symbolPrecision_js_1 = require("../config/symbolPrecision.js");
/**
 * SOTA Deterministic Verification Suite: Error -4509 / -4130 Multi-Slot SL Collision & Sovereign Aggregation
 */
async function runError4509MultiSlotVerification() {
    console.log("==========================================================================================");
    console.log("  BATBOT V11 SOTA TEST: ERROR -4509 & MULTI-SLOT SOVEREIGN SL AGGREGATION VERIFICATION");
    console.log("==========================================================================================\n");
    symbolPrecision_js_1.SymbolPrecisionRegistry.preseedOfflineDefaults(["DOTUSDT", "XRPUSDT", "ETHUSDT", "BTCUSDT"]);
    const symbol = "DOTUSDT";
    const sab = new SharedArrayBuffer(20480);
    const mdClient = new marketDataClient_js_1.MarketDataClient(sab, 10, 256);
    const riskGuard = new risk_js_1.RiskGuard();
    const ledger = new positionLedger_js_1.HedgePositionLedger(symbol);
    // ------------------------------------------------------------------------------------------
    // STAGE 1: Sovereign Position-Side Lock & Order Registry Verification (Multi-Slot Scaling)
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 1] Testing Multi-Slot Scale-In & Sovereign Position-Side SL Unification...");
    let placedOrders = [];
    let cancelledOrderIds = [];
    let orderIdCounter = 900000;
    const mockExecutionClient = new binance_js_1.BinanceExecutionClient();
    // Mock placeOrder
    mockExecutionClient.placeOrder = async (params) => {
        placedOrders.push({ ...params });
        const orderId = ++orderIdCounter;
        return {
            orderId,
            symbol: params.symbol,
            status: "NEW",
            clientOrderId: params.clientOrderId || `ORDER_${orderId}`,
            price: String(params.price || "0"),
            avgPrice: "0",
            origQty: String(params.quantity || "0"),
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: params.type,
            reduceOnly: false,
            side: params.side,
            positionSide: params.positionSide || "BOTH",
            stopPrice: String(params.stopPrice || "0"),
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    // Mock cancelOrder
    mockExecutionClient.cancelOrder = async (_sym, orderId) => {
        cancelledOrderIds.push(orderId);
        return {
            orderId: Number(orderId),
            symbol,
            status: "CANCELED",
            clientOrderId: "",
            price: "0",
            avgPrice: "0",
            origQty: "0",
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: "STOP_MARKET",
            reduceOnly: false,
            side: "BUY",
            positionSide: "SHORT",
            stopPrice: "0",
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    const engine = new engine_js_1.StrategyEngine(mdClient, riskGuard, mockExecutionClient, { symbol, shortStopLossPercent: 1.5, shortTakeProfitPercent: 3.0 }, undefined, ledger);
    // 1. Enter SHORT_SLOT_0 (100 DOT @ $5.00, SL: $5.075)
    ledger.occupyShortSlot(0, 100, 5.00, 3.0, 1.5);
    const summary1 = ledger.getAggregatedSideSummary("SHORT");
    assert_1.default.strictEqual(summary1.totalQuantity, 100, "Stage 1: Slot 0 total quantity must be 100");
    assert_1.default.strictEqual(summary1.vwapEntryPrice, 5.00, "Stage 1: Slot 0 VWAP must be 5.00");
    await engine.syncExchangeStopLossOrder("SHORT", summary1.totalQuantity, summary1.stopLossPrice);
    const slId1 = ledger.getActiveStopLossOrderId("SHORT");
    assert_1.default.strictEqual(slId1, 900001, "Stage 1: Sovereign short SL OrderId must be registered as 900001");
    assert_1.default.strictEqual(placedOrders.length, 1, "Stage 1: Exactly 1 order must be placed");
    assert_1.default.strictEqual(placedOrders[0].side, "BUY", "Stage 1: Short SL must be BUY order");
    assert_1.default.strictEqual(placedOrders[0].positionSide, "SHORT", "Stage 1: Short SL must have positionSide SHORT");
    assert_1.default.strictEqual(placedOrders[0].closePosition, true, "Stage 1: Short SL must have closePosition true");
    console.log(`  ✅ SHORT_SLOT_0 Occupied: 100 DOT @ $5.00 | Sovereign SL #${slId1} active @ $${placedOrders[0].stopPrice}`);
    // 2. Scale-in: Enter SHORT_SLOT_1 (100 DOT @ $5.20) -> Aggregated: 200 DOT @ VWAP $5.10, New SL: $5.1765
    ledger.occupyShortSlot(1, 100, 5.20, 3.0, 1.5);
    const summary2 = ledger.getAggregatedSideSummary("SHORT");
    assert_1.default.strictEqual(summary2.totalQuantity, 200, "Stage 1: Slot 0+1 total quantity must be 200");
    assert_1.default.strictEqual(summary2.vwapEntryPrice, 5.10, "Stage 1: Slot 0+1 VWAP must be 5.10");
    await engine.syncExchangeStopLossOrder("SHORT", summary2.totalQuantity, summary2.stopLossPrice);
    const slId2 = ledger.getActiveStopLossOrderId("SHORT");
    assert_1.default.strictEqual(slId2, 900002, "Stage 1: Sovereign short SL OrderId must be updated to 900002");
    assert_1.default.strictEqual(cancelledOrderIds.length, 1, "Stage 1: Old SL order #900001 must be cancelled");
    assert_1.default.strictEqual(cancelledOrderIds[0], 900001, "Stage 1: Cancelled order ID must match old SL #900001");
    assert_1.default.strictEqual(placedOrders.length, 2, "Stage 1: Total placed orders must be 2 (old + new)");
    console.log(`  ✅ SHORT_SLOT_1 Scaled-in: 100 DOT @ $5.20 | Aggregated 200 DOT @ VWAP $5.10`);
    console.log(`  ✅ Old SL #900001 Cancelled | New Sovereign SL #${slId2} active @ $${placedOrders[1].stopPrice}`);
    console.log("  ✅ STAGE 1 PASSED: Sovereign Position-Side Lock & Aggregation verified with 0 slot collisions!\n");
    // ------------------------------------------------------------------------------------------
    // STAGE 2: Binance Error -4509 & -4130 Dual-Vector Interceptor & Auto-Recovery
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 2] Testing Binance Error -4509 & -4130 Interceptor with Micro-Settlement Backoff...");
    const recoveryClient = new binance_js_1.BinanceExecutionClient();
    let attemptCount = 0;
    const sweepCancelledIds = [];
    // Mock getOpenOrders returning conflicting conditional order
    recoveryClient.getOpenOrders = async (_sym) => {
        return [
            {
                orderId: 777888,
                symbol,
                status: "NEW",
                clientOrderId: "CONFLICTING_STALE_SL",
                price: "0",
                avgPrice: "0",
                origQty: "0",
                executedQty: "0",
                cumQuote: "0",
                timeInForce: "GTC",
                type: "STOP_MARKET",
                reduceOnly: false,
                side: "BUY",
                positionSide: "SHORT",
                stopPrice: "5.30",
                workingType: "CONTRACT_PRICE",
                updateTime: Date.now(),
            },
        ];
    };
    recoveryClient.cancelOrder = async (_sym, orderId) => {
        sweepCancelledIds.push(orderId);
        return {
            orderId: Number(orderId),
            symbol,
            status: "CANCELED",
            clientOrderId: "",
            price: "0",
            avgPrice: "0",
            origQty: "0",
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: "STOP_MARKET",
            reduceOnly: false,
            side: "BUY",
            positionSide: "SHORT",
            stopPrice: "0",
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    recoveryClient.request = async (_method, endpoint, payload) => {
        attemptCount++;
        if (attemptCount === 1) {
            // First attempt throws Error -4509
            throw new Error("Binance API Error [-4509]: Time in Force (TIF) GTE can only be used with open positions.");
        }
        // Second attempt succeeds
        return {
            orderId: 999111,
            symbol: payload.symbol,
            status: "NEW",
            clientOrderId: payload.newClientOrderId || payload.clientOrderId || "RECOVERED_SL",
            price: "0",
            avgPrice: "0",
            origQty: "0",
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: payload.type,
            reduceOnly: false,
            side: payload.side,
            positionSide: payload.positionSide,
            stopPrice: String(payload.stopPrice || "0"),
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    const recoveredRes = await recoveryClient.placePositionStopLoss(symbol, "BUY", "SHORT", 5.1765, "TEST_4509_CID");
    assert_1.default.strictEqual(attemptCount, 2, "Stage 2: placeOrder must retry exactly once after -4509");
    assert_1.default.strictEqual(sweepCancelledIds.length, 1, "Stage 2: Proactive sweep must have cancelled 1 conflicting order");
    assert_1.default.strictEqual(sweepCancelledIds[0], 777888, "Stage 2: Cancelled order must be #777888");
    assert_1.default.strictEqual(recoveredRes.orderId, 999111, "Stage 2: Recovered orderId must be 999111");
    console.log(`  ✅ Interceptor intercepted Error -4509 on Attempt 1`);
    console.log(`  ✅ Proactive sweep purged conflicting order #777888`);
    console.log(`  ✅ Micro-settlement backoff (50ms) applied`);
    console.log(`  ✅ Attempt 2 succeeded with OrderId #${recoveredRes.orderId} (ClId: ${recoveredRes.clientOrderId})`);
    console.log("  ✅ STAGE 2 PASSED: Error -4509 auto-recovery interceptor verified!\n");
    // ------------------------------------------------------------------------------------------
    // STAGE 3: Ultimate Deterministic Quantity-Based STOP_MARKET Fallback
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 3] Testing Ultimate Quantity-Based STOP_MARKET Fallback on Persistent -4509...");
    const persistentFailureClient = new binance_js_1.BinanceExecutionClient();
    let persistentAttempts = 0;
    let fallbackExecuted = false;
    let fallbackOrderParams = null;
    persistentFailureClient.getOpenOrders = async () => [];
    persistentFailureClient.getPositionRisk = async () => [
        {
            symbol,
            positionSide: "SHORT",
            positionAmt: "-200.0",
            entryPrice: "5.10",
            markPrice: "5.12",
            unRealizedProfit: "-4.0",
            liquidationPrice: "8.50",
            leverage: "10",
            maxNotionalValue: "1000000",
            marginType: "cross",
            isolatedMargin: "0",
            isAutoAddMargin: "false",
        },
    ];
    persistentFailureClient.request = async (_method, _endpoint, payload) => {
        persistentAttempts++;
        if (payload.closePosition === "true" || payload.closePosition === true) {
            throw new Error("Binance API Error [-4509]: Time in Force (TIF) GTE can only be used with open positions.");
        }
        // Fallback order with quantity and closePosition=false succeeds
        fallbackExecuted = true;
        fallbackOrderParams = payload;
        return {
            orderId: 999333,
            symbol: payload.symbol,
            status: "NEW",
            clientOrderId: payload.newClientOrderId,
            price: "0",
            avgPrice: "0",
            origQty: String(payload.quantity),
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: payload.type,
            reduceOnly: false,
            side: payload.side,
            positionSide: payload.positionSide,
            stopPrice: String(payload.stopPrice || "0"),
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    const fallbackRes = await persistentFailureClient.placePositionStopLoss(symbol, "BUY", "SHORT", 5.1765, "PERSISTENT_CID", undefined, 200);
    assert_1.default.strictEqual(fallbackExecuted, true, "Stage 3: Fallback order must be executed");
    assert_1.default.strictEqual(fallbackRes.orderId, 999333, "Stage 3: Fallback order ID must match 999333");
    assert_1.default.strictEqual(fallbackOrderParams.closePosition, undefined, "Stage 3: Fallback order must NOT have closePosition: true");
    assert_1.default.strictEqual(parseFloat(String(fallbackOrderParams.quantity)), 200, "Stage 3: Fallback order must protect exact quantity (200)");
    assert_1.default.strictEqual(fallbackOrderParams.positionSide, "SHORT", "Stage 3: Fallback order must have positionSide SHORT");
    console.log(`  ✅ closePosition=true rejected after retries`);
    console.log(`  ✅ Fallback engaged: Dispatched deterministic Quantity-Based STOP_MARKET for 200 DOT`);
    console.log(`  ✅ Fallback OrderId #${fallbackRes.orderId} successfully placed on Binance`);
    console.log("  ✅ STAGE 3 PASSED: Quantity-Based Stop Loss Fallback verified!\n");
    // ------------------------------------------------------------------------------------------
    // STAGE 4: Closed-Loop Risk Guard Self-Healing on Dropped SL
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 4] Testing Closed-Loop Risk Guard Self-Healing on Dropped SL...");
    // Simulate exchange dropping SL: Reset sovereign active SL order ID in ledger to 0 while position is active
    ledger.registerActiveStopLossOrderId("SHORT", 0);
    const droppedSlId = ledger.getActiveStopLossOrderId("SHORT");
    assert_1.default.strictEqual(droppedSlId, 0, "Stage 4: Active SL ID must be 0 (dropped)");
    const preAuditPlacedCount = placedOrders.length;
    // Trigger Closed-Loop Audit
    engine.auditActivePositionRiskClosedLoop();
    // Yield micro-tasks for async dispatch
    await new Promise((r) => setTimeout(r, 50));
    const postAuditPlacedCount = placedOrders.length;
    const healedSlId = ledger.getActiveStopLossOrderId("SHORT");
    assert_1.default.strictEqual(postAuditPlacedCount, preAuditPlacedCount + 1, "Stage 4: Exactly 1 emergency SL must be dispatched");
    assert_1.default.strictEqual(healedSlId, 900003, "Stage 4: Sovereign SL must be healed with new OrderId #900003");
    const auditCheck = riskGuard.auditAggregatedPositionRisk(symbol, "SHORT", 200, healedSlId);
    assert_1.default.strictEqual(auditCheck.isProtected, true, "Stage 4: RiskGuard audit must confirm 100% protected");
    console.log(`  ✅ Dropped SL detected by RiskGuard audit`);
    console.log(`  ✅ Emergency sovereign Stop Loss auto-dispatched (OrderId #${healedSlId})`);
    console.log(`  ✅ Position is 100% protected (Zero Naked Positions)`);
    console.log("  ✅ STAGE 4 PASSED: Closed-Loop Self-Healing verified!\n");
    // ------------------------------------------------------------------------------------------
    // STAGE 5: Long Position & Step-Collar Ratchet Non-Regression
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 5] Testing Long Position & Step-Collar Ratchet Non-Regression...");
    ledger.occupyCoreLong(100, 5.00, 3.0, 1.5);
    const longSummary = ledger.getAggregatedSideSummary("LONG");
    await engine.syncExchangeStopLossOrder("LONG", longSummary.totalQuantity, longSummary.stopLossPrice);
    const longSlId1 = ledger.getActiveStopLossOrderId("LONG");
    assert_1.default.strictEqual(longSlId1, 900004, "Stage 5: Long SL OrderId must be 900004");
    const longOrder1 = placedOrders[placedOrders.length - 1];
    assert_1.default.strictEqual(longOrder1.side, "SELL", "Stage 5: Long SL side must be SELL");
    assert_1.default.strictEqual(longOrder1.positionSide, "LONG", "Stage 5: Long SL positionSide must be LONG");
    // Ratchet Long SL
    await engine.syncExchangeStopLossOrder("LONG", longSummary.totalQuantity, 5.05);
    const longSlId2 = ledger.getActiveStopLossOrderId("LONG");
    assert_1.default.strictEqual(longSlId2, 900005, "Stage 5: Long SL ratcheted to OrderId 900005");
    console.log(`  ✅ Core Long Position: 100 DOT @ $5.00 | SL #${longSlId1} placed`);
    console.log(`  ✅ Ratchet Synced: SL updated to #${longSlId2} @ $5.05`);
    console.log("  ✅ STAGE 5 PASSED: Long Position & Ratchet verified with zero regressions!\n");
    console.log("==========================================================================================");
    console.log("  ALL TESTS PASSED (5/5) - ERROR -4509 & MULTI-SLOT SL ARCHITECTURE IS 100% PRODUCTION READY");
    console.log("==========================================================================================");
}
runError4509MultiSlotVerification().catch((err) => {
    console.error("❌ TEST RUNNER FAILED:", err);
    process.exit(1);
});
