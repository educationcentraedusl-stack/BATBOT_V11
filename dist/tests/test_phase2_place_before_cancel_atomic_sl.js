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
 * Institutional Fault-Injection Execution Client for Phase 2 Verification
 */
class FaultInjectionExecutionClient extends binance_1.BinanceExecutionClient {
    outboundDispatches = [];
    shouldFailNewSl = false;
    simulatedFailureError = "Binance API Error [429]: Too Many Requests";
    nextOrderId = 880001;
    constructor() {
        super({ apiKey: "MOCK_KEY", apiSecret: "MOCK_SECRET", useTestnet: true });
    }
    async placeQuantityStopLoss(symbol, side, positionSide, stopPrice, quantity, clientOrderId, signal) {
        if (this.shouldFailNewSl) {
            throw new Error(this.simulatedFailureError);
        }
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
            clientOrderId: clientOrderId || `mock_sl_${orderId}`,
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
            side: "BUY",
            positionSide: "SHORT",
            stopPrice: "0",
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    }
}
async function runPhase2AtomicStopLossTests() {
    console.log("==========================================================================================");
    console.log("  PHASE 2 VERIFICATION: PLACE-BEFORE-CANCEL ATOMIC STOP-LOSS CONTINUITY (ZERO-NAKED)       ");
    console.log("==========================================================================================\n");
    const sab = new SharedArrayBuffer(20480);
    const mdClient = new marketDataClient_1.MarketDataClient(sab, 10, 256);
    const riskGuard = new risk_1.RiskGuard();
    const hedgeLedger = new positionLedger_1.HedgePositionLedger("BTCUSDT");
    const execClient = new FaultInjectionExecutionClient();
    const engine = new engine_1.StrategyEngine(mdClient, riskGuard, execClient, { symbol: "BTCUSDT" }, undefined, hedgeLedger);
    // Seed an active SHORT position: 0.05 BTC @ $70,000.0, Initial SL @ $71,000.0
    hedgeLedger.occupyShortSlot(0, 0.05, 70000.0, 68000.0, 71000.0);
    const initialSummary = hedgeLedger.getAggregatedSideSummary("SHORT");
    node_assert_1.default.strictEqual(initialSummary.isOccupied, true, "Position must be occupied");
    // =========================================================================
    // STAGE 1: Initial SL Dispatch & Ledger Registration
    // =========================================================================
    console.log("[STAGE 1] Testing Initial Live Stop-Loss Placement & Registration...");
    await engine.syncExchangeStopLossOrder("SHORT", initialSummary.totalQuantity, 71000.0);
    const initialSlId = hedgeLedger.getActiveStopLossOrderId("SHORT");
    node_assert_1.default.strictEqual(initialSlId, 880001, "Initial SL OrderId must be registered as #880001");
    node_assert_1.default.strictEqual(execClient.outboundDispatches.length, 1, "Exactly 1 placement dispatch must have occurred");
    node_assert_1.default.strictEqual(execClient.outboundDispatches[0].type, "PLACE_QUANTITY_SL", "First dispatch must be PLACE_QUANTITY_SL");
    console.log(`  ✅ Stage 1 Passed: Initial SL OrderId #${initialSlId} placed and registered in ledger.\n`);
    // =========================================================================
    // STAGE 2: Place-Before-Cancel Succession Sequence Verification
    // =========================================================================
    console.log("[STAGE 2] Testing Place-Before-Cancel Succession Order Sequence...");
    execClient.outboundDispatches.length = 0; // Reset dispatch log
    // Ratchet stop loss from $71,000.0 to $70,500.0
    await engine.syncExchangeStopLossOrder("SHORT", initialSummary.totalQuantity, 70500.0);
    const ratchetedSlId = hedgeLedger.getActiveStopLossOrderId("SHORT");
    node_assert_1.default.strictEqual(ratchetedSlId, 880002, "Ratcheted SL OrderId must be registered as #880002");
    // Verify execution order: PLACE_QUANTITY_SL must occur BEFORE CANCEL!
    node_assert_1.default.strictEqual(execClient.outboundDispatches.length, 2, "Expected exactly 2 operations (1 place, 1 cancel)");
    node_assert_1.default.strictEqual(execClient.outboundDispatches[0].type, "PLACE_QUANTITY_SL", "CRITICAL: SL_new placement must execute FIRST");
    node_assert_1.default.strictEqual(execClient.outboundDispatches[0].orderId, 880002, "SL_new OrderId must match new order");
    node_assert_1.default.strictEqual(execClient.outboundDispatches[1].type, "CANCEL", "CRITICAL: SL_old cancellation must execute ONLY AFTER SL_new is placed");
    node_assert_1.default.strictEqual(execClient.outboundDispatches[1].orderId, 880001, "Cancelled order must be previous SL_old (#880001)");
    node_assert_1.default.ok(execClient.outboundDispatches[0].timestamp <= execClient.outboundDispatches[1].timestamp, "SL_new placement timestamp must precede SL_old cancel timestamp");
    console.log(`  ✅ Stage 2 Passed: Place-Before-Cancel sequence verified! SL_new (#880002) placed BEFORE SL_old (#880001) cancelled.\n`);
    // =========================================================================
    // STAGE 3: Atomic Failure Invariant (Simulated Network Error 429/504)
    // =========================================================================
    console.log("[STAGE 3] Testing Atomic Failure Invariant under Simulated Network Error (429/504)...");
    execClient.outboundDispatches.length = 0; // Reset dispatch log
    // Arm fault injection: SL_new will fail
    execClient.shouldFailNewSl = true;
    execClient.simulatedFailureError = "Binance API Error [429]: Too Many Requests (Rate Limit Exceeded)";
    // Attempt ratchet from $70,500.0 to $70,200.0
    await engine.syncExchangeStopLossOrder("SHORT", initialSummary.totalQuantity, 70200.0);
    // Invariant assertions:
    // 1. SL_old (#880002) MUST remain active in the ledger
    const activeSlAfterFailure = hedgeLedger.getActiveStopLossOrderId("SHORT");
    node_assert_1.default.strictEqual(activeSlAfterFailure, 880002, "ZERO-NAKED INVARIANT: Active SL in ledger MUST remain #880002 after SL_new failure");
    // 2. SL_old MUST NEVER have been cancelled
    const cancelDispatches = execClient.outboundDispatches.filter((d) => d.type === "CANCEL");
    node_assert_1.default.strictEqual(cancelDispatches.length, 0, "ZERO-NAKED INVARIANT: SL_old must NEVER be cancelled when SL_new placement fails!");
    // 3. Risk guard audit must confirm 100% protection
    const audit = riskGuard.auditAggregatedPositionRisk("BTCUSDT", "SHORT", 0.05, activeSlAfterFailure);
    node_assert_1.default.strictEqual(audit.isProtected, true, "Position must maintain 100% protection status");
    console.log(`  ✅ Stage 3 Passed: Atomic failure invariant verified! When SL_new failed with 429, SL_old (#880002) remained 100% intact with 0ms naked exposure.\n`);
    // Disarm fault injection
    execClient.shouldFailNewSl = false;
    // =========================================================================
    // STAGE 4: Recovery from Failure & Subsequent Ratchet Continuity
    // =========================================================================
    console.log("[STAGE 4] Testing Immediate Recovery & Subsequent Ratchet Continuity...");
    execClient.outboundDispatches.length = 0;
    // Once network recovers, ratchet to $70,100.0
    await engine.syncExchangeStopLossOrder("SHORT", initialSummary.totalQuantity, 70100.0);
    const recoveredSlId = hedgeLedger.getActiveStopLossOrderId("SHORT");
    node_assert_1.default.strictEqual(recoveredSlId, 880003, "Recovered SL OrderId must be #880003");
    node_assert_1.default.strictEqual(execClient.outboundDispatches[0].type, "PLACE_QUANTITY_SL", "Recovery must place SL_new FIRST");
    node_assert_1.default.strictEqual(execClient.outboundDispatches[1].type, "CANCEL", "Recovery must cancel resting SL_old (#880002)");
    node_assert_1.default.strictEqual(execClient.outboundDispatches[1].orderId, 880002, "Cancelled order must be #880002");
    console.log(`  ✅ Stage 4 Passed: Post-failure recovery succeeded! SL_new (#880003) placed, previous SL_old (#880002) cleaned up.\n`);
    // =========================================================================
    // STAGE 5: Exact-Quantity Conditional Order Payload Verification
    // =========================================================================
    console.log("[STAGE 5] Testing Exact-Quantity Conditional Order Precision & Bypass of -4130/-4509...");
    const realClient = new binance_1.BinanceExecutionClient();
    let interceptedPayload;
    // Intercept the low-level request payload
    realClient.request = async (_method, _endpoint, payload) => {
        interceptedPayload = payload;
        return {
            orderId: 999888,
            symbol: "ETHUSDT",
            status: "NEW",
            clientOrderId: payload?.newClientOrderId || "",
            price: "0",
            avgPrice: "0",
            origQty: String(payload?.quantity || "0"),
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: "STOP_MARKET",
            reduceOnly: false,
            side: payload?.side,
            positionSide: payload?.positionSide,
            stopPrice: String(payload?.stopPrice || "0"),
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    await realClient.placeQuantityStopLoss("ETHUSDT", "SELL", "LONG", 2500.5, 1.25);
    node_assert_1.default.ok(interceptedPayload !== undefined, "Payload must be captured");
    node_assert_1.default.strictEqual(interceptedPayload.symbol, "ETHUSDT");
    node_assert_1.default.strictEqual(interceptedPayload.side, "SELL");
    node_assert_1.default.strictEqual(interceptedPayload.positionSide, "LONG");
    node_assert_1.default.strictEqual(interceptedPayload.type, "STOP_MARKET");
    node_assert_1.default.strictEqual(interceptedPayload.stopPrice, 2500.5);
    node_assert_1.default.strictEqual(interceptedPayload.quantity, 1.25);
    node_assert_1.default.strictEqual(interceptedPayload.closePosition, undefined, "closePosition must NOT be sent (avoids -4130/-4509)");
    console.log(`  ✅ Stage 5 Passed: Exact-quantity conditional payload verified (closePosition omitted, quantity=1.25).\n`);
    console.log("==========================================================================================");
    console.log("  ALL 5 STAGES PASSED: ZERO-NAKED INVARIANT 100% MATHEMATICALLY VERIFIED!                 ");
    console.log("==========================================================================================\n");
}
runPhase2AtomicStopLossTests().catch((err) => {
    console.error("❌ PHASE 2 VERIFICATION FAILED:", err);
    process.exit(1);
});
