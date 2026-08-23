"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const binance_1 = require("../execution/binance");
const engine_1 = require("../strategy/engine");
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const symbolPrecision_1 = require("../config/symbolPrecision");
const positionLedger_1 = require("../strategy/positionLedger");
async function runHotfixTests() {
    console.log("=========================================================================");
    console.log("  TEST: ERROR -4130 SL DISPATCH DIRECTION & AUTO-RECOVERY VERIFICATION  ");
    console.log("=========================================================================\n");
    symbolPrecision_1.SymbolPrecisionRegistry.preseedOfflineDefaults(["XRPUSDT", "ETHUSDT", "BTCUSDT"]);
    // Test 1: Direct placePositionStopLoss Payload & Direction Verification
    console.log("[TEST 1] Verifying placePositionStopLoss strict direction and payload sanitization...");
    const capturedPayloads = [];
    const mockClient = new binance_1.BinanceExecutionClient();
    mockClient.request = async (_method, _path, payload) => {
        if (payload)
            capturedPayloads.push({ ...payload });
        return {
            orderId: 987654321,
            symbol: payload?.symbol || "XRPUSDT",
            status: "NEW",
            clientOrderId: payload?.newClientOrderId || "",
            price: "0",
            avgPrice: "0",
            origQty: "0",
            executedQty: "0",
            cumQuote: "0",
            timeInForce: "GTC",
            type: payload?.type || "STOP_MARKET",
            reduceOnly: false,
            side: payload?.side || "BUY",
            positionSide: payload?.positionSide || "SHORT",
            stopPrice: payload?.stopPrice || "1.5164",
            workingType: payload?.workingType || "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    // 1a: SHORT Position SL -> MUST be BUY order
    const shortSlRes = await mockClient.placePositionStopLoss("XRPUSDT", "BUY", "SHORT", 1.5164);
    assert_1.default.strictEqual(shortSlRes.orderId, 987654321, "Short SL orderId must be returned");
    const shortPayload = capturedPayloads[0];
    assert_1.default.strictEqual(shortPayload.symbol, "XRPUSDT", "Symbol must match");
    assert_1.default.strictEqual(shortPayload.side, "BUY", "Short position exit side MUST be BUY");
    assert_1.default.strictEqual(shortPayload.positionSide, "SHORT", "PositionSide MUST be SHORT");
    assert_1.default.strictEqual(shortPayload.type, "STOP_MARKET", "Order type MUST be STOP_MARKET");
    assert_1.default.strictEqual(shortPayload.closePosition, "true", "closePosition MUST be string 'true'");
    assert_1.default.strictEqual(shortPayload.quantity, undefined, "quantity MUST be undefined when closePosition is true");
    assert_1.default.strictEqual(shortPayload.reduceOnly, undefined, "reduceOnly MUST be undefined when closePosition is true");
    assert_1.default.strictEqual(shortPayload.price, undefined, "price MUST be undefined for STOP_MARKET");
    assert_1.default.strictEqual(shortPayload.timeInForce, undefined, "timeInForce MUST be undefined for STOP_MARKET");
    console.log("  ✅ 1a Passed: Short SL payload perfectly formed (side: BUY, positionSide: SHORT, closePosition: true).");
    // 1b: Misaligned SHORT Position SL (e.g. if caller passed SELL by mistake) -> Auto-Corrects to BUY
    const correctedSlRes = await mockClient.placePositionStopLoss("XRPUSDT", "SELL", "SHORT", 1.5164);
    const correctedPayload = capturedPayloads[1];
    assert_1.default.strictEqual(correctedPayload.side, "BUY", "Misaligned side 'SELL' on SHORT position MUST be corrected to 'BUY'");
    assert_1.default.strictEqual(correctedPayload.positionSide, "SHORT", "PositionSide MUST be SHORT");
    console.log("  ✅ 1b Passed: Misaligned Short SL side auto-corrected to BUY.");
    // 1c: LONG Position SL -> MUST be SELL order
    const longSlRes = await mockClient.placePositionStopLoss("ETHUSDT", "SELL", "LONG", 2423.83);
    const longPayload = capturedPayloads[2];
    assert_1.default.strictEqual(longPayload.symbol, "ETHUSDT", "Symbol must match");
    assert_1.default.strictEqual(longPayload.side, "SELL", "Long position exit side MUST be SELL");
    assert_1.default.strictEqual(longPayload.positionSide, "LONG", "PositionSide MUST be LONG");
    assert_1.default.strictEqual(longPayload.closePosition, "true", "closePosition MUST be 'true'");
    console.log("  ✅ 1c Passed: Long SL payload perfectly formed (side: SELL, positionSide: LONG, closePosition: true).");
    // Test 2: StrategyEngine dispatchExchangeStopLossOrder Verification
    console.log("\n[TEST 2] Verifying StrategyEngine.dispatchExchangeStopLossOrder direction mapping...");
    const sab = new SharedArrayBuffer(20480);
    const mdClient = new marketDataClient_1.MarketDataClient(sab, 10, 256);
    const riskGuard = new risk_1.RiskGuard();
    const hedgeLedger = new positionLedger_1.HedgePositionLedger("XRPUSDT");
    const engine = new engine_1.StrategyEngine(mdClient, riskGuard, mockClient, { symbol: "XRPUSDT" }, undefined, hedgeLedger);
    const engineSlOrderId = await engine.dispatchExchangeStopLossOrder("SHORT_SLOT_0", 1.5014, 29.9, "SHORT", 1.5164);
    assert_1.default.strictEqual(engineSlOrderId, 987654321, "Engine SL orderId must match mock response");
    const enginePayload = capturedPayloads[3];
    assert_1.default.strictEqual(enginePayload.side, "BUY", "Engine SHORT SL MUST pass side: BUY");
    assert_1.default.strictEqual(enginePayload.positionSide, "SHORT", "Engine SHORT SL MUST pass positionSide: SHORT");
    console.log("  ✅ 2 Passed: StrategyEngine successfully dispatched BUY STOP_MARKET for SHORT position.");
    // Test 3: Error -4130 Auto-Recovery Interceptor Verification
    console.log("\n[TEST 3] Verifying -4130 Auto-Recovery Interceptor in placeOrder...");
    let attemptCount = 0;
    const cancelledOrderIds = [];
    const recoveryClient = new binance_1.BinanceExecutionClient();
    recoveryClient.getOpenOrders = async (_sym) => {
        return [
            {
                orderId: 111222,
                symbol: "XRPUSDT",
                status: "NEW",
                clientOrderId: "OLD_STALE_SL",
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
                stopPrice: "1.5200",
                workingType: "CONTRACT_PRICE",
                updateTime: Date.now() - 10000,
            },
        ];
    };
    recoveryClient.cancelOrder = async (_sym, orderId) => {
        cancelledOrderIds.push(orderId);
        return {
            orderId: Number(orderId),
            symbol: "XRPUSDT",
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
    recoveryClient.request = async (_method, path, payload) => {
        if (path === "/fapi/v1/order") {
            attemptCount++;
            if (attemptCount === 1) {
                // Simulate Binance API Error -4130 on first attempt
                throw new Error("Binance API Error [-4130]: An open stop or take profit order with GTE and closePosition in the direction is existing.");
            }
            return {
                orderId: 999888777,
                symbol: payload?.symbol || "XRPUSDT",
                status: "NEW",
                clientOrderId: payload?.newClientOrderId || "",
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
                stopPrice: payload?.stopPrice || "1.5164",
                workingType: "CONTRACT_PRICE",
                updateTime: Date.now(),
            };
        }
        return {};
    };
    const recoveredRes = await recoveryClient.placePositionStopLoss("XRPUSDT", "BUY", "SHORT", 1.5164, "BAT_TEST_SL_001");
    assert_1.default.strictEqual(attemptCount, 2, "placeOrder must have retried after catching -4130");
    assert_1.default.strictEqual(cancelledOrderIds.length, 1, "Must have cancelled 1 conflicting order");
    assert_1.default.strictEqual(cancelledOrderIds[0], 111222, "Must have cancelled the conflicting stale SL order");
    assert_1.default.strictEqual(recoveredRes.orderId, 999888777, "Recovered order ID must be returned");
    console.log("  ✅ 3 Passed: -4130 caught, conflicting orders purged, and SL order cleanly placed on retry.");
    console.log("\n=========================================================================");
    console.log("  ALL TESTS PASSED: ERROR -4130 PERMANENTLY ERADICATED & VERIFIED!        ");
    console.log("=========================================================================\n");
}
runHotfixTests().catch((err) => {
    console.error("TEST FAILED:", err);
    process.exit(1);
});
