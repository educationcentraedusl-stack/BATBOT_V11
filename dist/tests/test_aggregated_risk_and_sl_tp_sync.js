"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const positionLedger_1 = require("../strategy/positionLedger");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
function assert(condition, message) {
    if (!condition) {
        throw new Error(`[ASSERTION_FAILED] ${message}`);
    }
}
async function runAggregatedRiskAndSlTpSyncTestSuite() {
    console.log("================================================================================");
    console.log("  BATBOT_V11 SOTA: GLOBAL AGGREGATED POSITION SIZING & SL/TP SYNCHRONIZATION TEST");
    console.log("================================================================================\n");
    const symbol = "BTCUSDT";
    const ledger = new positionLedger_1.HedgePositionLedger(symbol, 3);
    ledger.setLeverage(20);
    const riskGuard = new risk_1.RiskGuard();
    // Mock / Simulated Binance Execution Tracking Store
    const exchangeOrders = new Map();
    let orderIdCounter = 100000;
    // Intercept and record placed orders
    const mockExecutionClient = new binance_1.BinanceExecutionClient();
    mockExecutionClient.placeOrder = async (params) => {
        orderIdCounter++;
        const orderId = orderIdCounter;
        const isClosePos = params.closePosition === true || String(params.closePosition).toLowerCase() === "true";
        const record = {
            orderId,
            symbol: params.symbol,
            side: params.side,
            type: params.type,
            positionSide: params.positionSide,
            price: params.price ? String(params.price) : "0",
            stopPrice: params.stopPrice ? String(params.stopPrice) : "0",
            closePosition: isClosePos,
            clientOrderId: params.clientOrderId || "",
            status: "NEW",
        };
        if (!isClosePos) {
            record.quantity = params.quantity;
        }
        exchangeOrders.set(orderId, record);
        return {
            orderId,
            symbol: params.symbol,
            status: "NEW",
            clientOrderId: record.clientOrderId,
            price: record.price,
            avgPrice: "0",
            origQty: record.quantity ? String(record.quantity) : "0",
            executedQty: "0",
            cumQuote: "0",
            timeInForce: params.timeInForce || "GTC",
            type: params.type,
            reduceOnly: false,
            side: params.side,
            positionSide: params.positionSide || "BOTH",
            stopPrice: record.stopPrice,
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    mockExecutionClient.placeBatchOrders = async (orders) => {
        const results = [];
        for (const ord of orders) {
            const res = await mockExecutionClient.placeOrder(ord);
            results.push(res);
        }
        return results;
    };
    mockExecutionClient.cancelOrder = async (sym, orderId) => {
        if (exchangeOrders.has(orderId)) {
            const ord = exchangeOrders.get(orderId);
            ord.status = "CANCELED";
            return { symbol: sym, orderId, status: "CANCELED" };
        }
        return { symbol: sym, orderId, status: "CANCELED" };
    };
    // -----------------------------------------------------------------------------------------
    // STAGE 1: Single Entry Fill & Exchange-Native `closePosition: true` Verification
    // -----------------------------------------------------------------------------------------
    console.log("[STAGE 1] Testing Single Entry Fill & Exchange-Native closePosition: true Verification...");
    const fill1Qty = 0.0008;
    const fill1Px = 64250.0;
    const slPercent = 1.20;
    const tpPercent = 2.50;
    // Occupy Short Slot 0
    ledger.occupyShortSlot(0, fill1Qty, fill1Px, tpPercent, slPercent, false);
    const agg1 = ledger.getAggregatedSideSummary("SHORT");
    assert(agg1.isOccupied === true, "SHORT position must be occupied");
    assert(Math.abs(agg1.totalQuantity - 0.0008) < 1e-6, `Aggregated quantity must be 0.0008, got ${agg1.totalQuantity}`);
    assert(Math.abs(agg1.vwapEntryPrice - 64250.0) < 1e-2, `VWAP must be 64250.0, got ${agg1.vwapEntryPrice}`);
    // Dispatch Position Stop Loss with closePosition: true
    const sl1Res = await mockExecutionClient.placePositionStopLoss(symbol, "BUY", "SHORT", agg1.stopLossPrice);
    ledger.registerActiveStopLossOrderId("SHORT_SLOT_0", sl1Res.orderId);
    const placedSl1 = exchangeOrders.get(sl1Res.orderId);
    assert(placedSl1 !== undefined, "Stop Loss order must be recorded in exchange store");
    assert(placedSl1?.type === "STOP_MARKET", "Order type must be STOP_MARKET");
    assert(placedSl1?.closePosition === true, "closePosition MUST be strictly true");
    assert(placedSl1?.quantity === undefined, "Quantity MUST be omitted when closePosition=true");
    assert(placedSl1?.positionSide === "SHORT", "positionSide must be SHORT");
    console.log(`  ✓ Stage 1 Passed: Single fill 0.0008 BTC verified with closePosition=true SL OrderId #${sl1Res.orderId}`);
    // -----------------------------------------------------------------------------------------
    // STAGE 2: Pyramiding Fill (0.0008 -> 0.0016) & Atomic TP Cancel-Replace Verification
    // -----------------------------------------------------------------------------------------
    console.log("\n[STAGE 2] Testing Pyramiding Fill (0.0008 -> 0.0016) & Atomic TP Cancel-Replace...");
    // Dispatch initial TP ladder for 0.0008
    const initialTpIntents = ledger.generateAggregatedBatchTpIntents("SHORT", agg1.totalQuantity, agg1.vwapEntryPrice, "SHORT_SLOT_0");
    const initialTpResponses = await mockExecutionClient.placeBatchOrders(initialTpIntents);
    const initialTpOrderIds = initialTpResponses.map((r) => r.orderId);
    ledger.registerActiveTpOrderIds("SHORT_SLOT_0", initialTpOrderIds);
    console.log(`  Initial TP Order IDs placed: [${initialTpOrderIds.join(", ")}]`);
    // Second fill arrives: 0.0008 @ $64,300.0 (Averaging in)
    const fill2Qty = 0.0008;
    const fill2Px = 64300.0;
    ledger.occupyShortSlot(0, fill2Qty, fill2Px, tpPercent, slPercent, false);
    const agg2 = ledger.getAggregatedSideSummary("SHORT");
    const expectedVwap2 = (fill1Qty * fill1Px + fill2Qty * fill2Px) / (fill1Qty + fill2Qty); // 64275.0
    assert(Math.abs(agg2.totalQuantity - 0.0016) < 1e-6, `Aggregated quantity must be 0.0016, got ${agg2.totalQuantity}`);
    assert(Math.abs(agg2.vwapEntryPrice - expectedVwap2) < 1e-2, `VWAP must be exactly ${expectedVwap2}, got ${agg2.vwapEntryPrice}`);
    // Atomic TP Cancel: Cancel old TP orders
    for (const oldTpId of initialTpOrderIds) {
        await mockExecutionClient.cancelOrder(symbol, oldTpId);
        assert(exchangeOrders.get(oldTpId)?.status === "CANCELED", `Old TP order #${oldTpId} must be CANCELED`);
    }
    console.log("  ✓ Old resting TP orders successfully cancelled");
    // Atomic TP Replace: Dispatch new TP ladder sized to 100% of aggregated 0.0016
    const newTpIntents = ledger.generateAggregatedBatchTpIntents("SHORT", agg2.totalQuantity, agg2.vwapEntryPrice, "SHORT_SLOT_0");
    const newTpResponses = await mockExecutionClient.placeBatchOrders(newTpIntents);
    const newTpOrderIds = newTpResponses.map((r) => r.orderId);
    ledger.registerActiveTpOrderIds("SHORT_SLOT_0", newTpOrderIds);
    const sumNewTpQty = newTpIntents.reduce((acc, c) => acc + (c.quantity || 0), 0);
    assert(Math.abs(sumNewTpQty - 0.0016) < 1e-6, `Total new TP ladder quantity must equal 0.0016, got ${sumNewTpQty}`);
    // Re-sync Position SL anchored to new VWAP (64275.0)
    await mockExecutionClient.cancelOrder(symbol, sl1Res.orderId);
    const sl2Res = await mockExecutionClient.placePositionStopLoss(symbol, "BUY", "SHORT", agg2.stopLossPrice);
    ledger.registerActiveStopLossOrderId("SHORT_SLOT_0", sl2Res.orderId);
    const placedSl2 = exchangeOrders.get(sl2Res.orderId);
    assert(placedSl2?.closePosition === true, "SL order must maintain closePosition=true");
    assert(placedSl2?.quantity === undefined, "Quantity must be omitted for closePosition=true");
    console.log(`  ✓ Stage 2 Passed: Pyramiding fill aggregated to 0.0016 BTC. TP ladder recalculated for 0.0016 BTC. SL updated to OrderId #${sl2Res.orderId}`);
    // -----------------------------------------------------------------------------------------
    // STAGE 3: Third Fill (0.0016 -> 0.0032) & 100% Aggregated Protection
    // -----------------------------------------------------------------------------------------
    console.log("\n[STAGE 3] Testing Third Fill (0.0016 -> 0.0032) & 100% Aggregated Protection...");
    const fill3Qty = 0.0016;
    const fill3Px = 64350.0;
    ledger.occupyShortSlot(1, fill3Qty, fill3Px, tpPercent, slPercent, false);
    const agg3 = ledger.getAggregatedSideSummary("SHORT");
    const expectedVwap3 = (0.0016 * expectedVwap2 + fill3Qty * fill3Px) / 0.0032; // 64312.50
    assert(Math.abs(agg3.totalQuantity - 0.0032) < 1e-6, `Aggregated quantity must be 0.0032, got ${agg3.totalQuantity}`);
    assert(Math.abs(agg3.vwapEntryPrice - expectedVwap3) < 1e-2, `VWAP must be exactly ${expectedVwap3}, got ${agg3.vwapEntryPrice}`);
    // Generate and verify TP intents for full 0.0032
    const tpIntents3 = ledger.generateAggregatedBatchTpIntents("SHORT", agg3.totalQuantity, agg3.vwapEntryPrice, "SHORT_SLOT_0");
    const sumTp3Qty = tpIntents3.reduce((acc, c) => acc + (c.quantity || 0), 0);
    assert(Math.abs(sumTp3Qty - 0.0032) < 1e-6, `Aggregated TP ladder quantity must equal 0.0032, got ${sumTp3Qty}`);
    console.log(`  ✓ Stage 3 Passed: 0.0032 BTC fully aggregated across short slots with exact VWAP $${agg3.vwapEntryPrice.toFixed(2)}`);
    // -----------------------------------------------------------------------------------------
    // STAGE 4: WebSocket `ACCOUNT_UPDATE` True Snapshot Handling (Zero Additive Mutation)
    // -----------------------------------------------------------------------------------------
    console.log("\n[STAGE 4] Testing WebSocket ACCOUNT_UPDATE True Snapshot Handling...");
    // Simulate an incoming Binance WebSocket ACCOUNT_UPDATE with absolute positionAmt: -0.0032
    const wsPositionAmt = 0.0032;
    const wsEntryPrice = 64312.50;
    // With isAuthoritativeSnapshot = true, it must REPLACE, NOT ADD
    ledger.occupyShortSlot(0, wsPositionAmt, wsEntryPrice, tpPercent, slPercent, true);
    const postWsSlot = ledger.getShortSlots()[0];
    assert(Math.abs(postWsSlot.quantity - 0.0032) < 1e-6, `Slot quantity must strictly equal 0.0032 (NOT 0.0048 or 0.0064), got ${postWsSlot.quantity}`);
    console.log(`  ✓ Stage 4 Passed: Authoritative snapshot preserved exact position size ${postWsSlot.quantity} without phantom additive doubling`);
    // -----------------------------------------------------------------------------------------
    // STAGE 5: Partial TP Limit Fill Scale-Out & Residual Invariant
    // -----------------------------------------------------------------------------------------
    console.log("\n[STAGE 5] Testing Partial TP Limit Fill Scale-Out & Residual Invariant...");
    const partialFillQty = 0.0010;
    const partialFillPx = 63800.0;
    const tpFillRes = ledger.processTpLimitFill("SHORT_SLOT_0", newTpOrderIds[0] || 100001, partialFillQty, partialFillPx, true);
    assert(tpFillRes.isPositionClosed === false, "Position must not be closed on partial TP fill");
    assert(Math.abs(tpFillRes.remainingQuantity - 0.0022) < 1e-6, `Remaining quantity must be 0.0022, got ${tpFillRes.remainingQuantity}`);
    console.log(`  ✓ Stage 5 Passed: Scaled out 0.0010 BTC, remaining 0.0022 BTC continues to be shielded`);
    // -----------------------------------------------------------------------------------------
    // STAGE 6: Closed-Loop Zero-Naked Invariant Guard & Sub-1.5 µs Latency Benchmark
    // -----------------------------------------------------------------------------------------
    console.log("\n[STAGE 6] Testing Closed-Loop Zero-Naked Invariant Guard & Latency Benchmark...");
    // Test 6A: Invariant check detects unprotected active position
    const auditUnprotected = riskGuard.auditAggregatedPositionRisk(symbol, "SHORT", 0.0022, 0);
    assert(auditUnprotected.isProtected === false, "Audit must fail when activeStopLossOrderId is 0");
    assert(auditUnprotected.reason?.includes("UNPROTECTED_EXPOSURE") === true, "Reason must report UNPROTECTED_EXPOSURE");
    console.log(`  ✓ Invariant correctly caught unprotected exposure: ${auditUnprotected.reason}`);
    // Test 6B: Invariant check passes when activeStopLossOrderId is valid
    const auditProtected = riskGuard.auditAggregatedPositionRisk(symbol, "SHORT", 0.0022, 100050);
    assert(auditProtected.isProtected === true, "Audit must pass when activeStopLossOrderId > 0");
    console.log("  ✓ Invariant correctly validates protected position");
    // Test 6C: Sub-1.5 µs Invariant & VWAP Evaluation Latency Benchmark
    // JIT Warm-up: 5,000 iterations to allow V8 TurboFan to optimize the hot loop
    for (let w = 0; w < 5000; w++) {
        const s = ledger.getAggregatedSideSummary("SHORT");
        riskGuard.auditAggregatedPositionRisk(symbol, "SHORT", s.totalQuantity, s.activeStopLossOrderId);
    }
    const iterations = 50000;
    const startNs = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        const summary = ledger.getAggregatedSideSummary("SHORT");
        riskGuard.auditAggregatedPositionRisk(symbol, "SHORT", summary.totalQuantity, summary.activeStopLossOrderId);
    }
    const endNs = process.hrtime.bigint();
    const totalUs = Number(endNs - startNs) / 1000;
    const avgUsPerEval = totalUs / iterations;
    console.log(`\n  Latency Benchmark over ${iterations.toLocaleString()} iterations:`);
    console.log(`  - Total Duration: ${totalUs.toFixed(2)} µs (${(totalUs / 1000).toFixed(2)} ms)`);
    console.log(`  - Average Latency: ${avgUsPerEval.toFixed(4)} µs / evaluation`);
    assert(avgUsPerEval < 1.5, `Average latency (${avgUsPerEval.toFixed(4)} µs) must be strictly < 1.5 µs`);
    console.log(`  ✓ Latency Benchmark Passed: ${avgUsPerEval.toFixed(4)} µs < 1.5 µs SLA\n`);
    console.log("================================================================================");
    console.log("  ALL 6 STAGES OF AGGREGATED RISK & SL/TP SYNCHRONIZATION PASSED (100% SUCCESS)");
    console.log("================================================================================\n");
}
runAggregatedRiskAndSlTpSyncTestSuite().catch((err) => {
    console.error(`[TEST_SUITE_ERROR] ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
