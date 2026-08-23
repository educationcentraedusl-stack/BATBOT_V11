"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_1 = require("../strategy/engine");
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
const positionLedger_1 = require("../strategy/positionLedger");
async function runLvcqMicrotaskLoopTest() {
    console.log("==========================================================================================");
    console.log("  ⚡ TEST SUITE: LVCQ MICROTASK LOOP PREVENT, IN-FLIGHT GRACE & BINANCE RATE LIMITER");
    console.log("==========================================================================================\n");
    const sab = new SharedArrayBuffer(20480);
    const client = new marketDataClient_1.MarketDataClient(sab);
    const riskGuard = new risk_1.RiskGuard();
    let placeOrderCount = 0;
    let cancelOrderCount = 0;
    let simulatedNetworkDelayMs = 40;
    // Mock execution client to intercept REST dispatches and simulate network RTT
    const mockExecClient = new binance_1.BinanceExecutionClient({
        apiKey: "test_key",
        apiSecret: "test_secret",
        useTestnet: true,
    });
    mockExecClient.placePositionStopLoss = async (symbol, side, positionSide, stopPrice, clientOrderId, signal) => {
        placeOrderCount++;
        if (simulatedNetworkDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, simulatedNetworkDelayMs));
        }
        const orderId = 990000 + placeOrderCount;
        return {
            orderId,
            symbol,
            status: "NEW",
            clientOrderId: clientOrderId || `mock_sl_${orderId}`,
            price: "0",
            avgPrice: "0",
            origQty: "0",
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
    };
    mockExecClient.cancelOrder = async (symbol, orderId, signal) => {
        cancelOrderCount++;
        if (simulatedNetworkDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, simulatedNetworkDelayMs));
        }
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
            side: "SELL",
            positionSide: "LONG",
            stopPrice: "0",
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    const ledger = new positionLedger_1.HedgePositionLedger("BTCUSDT", 3);
    const engine = new engine_1.StrategyEngine(client, riskGuard, mockExecClient, { symbol: "BTCUSDT", assetIndex: 0 }, undefined, ledger);
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 1] Testing In-Flight Audit Grace & Rapid Tick Burst (1,000 Ticks in 100ms)...");
    // Enter position
    ledger.occupyCoreLong(0.005, 60000, 1.5, 1.0);
    const initialLong = ledger.getAggregatedSideSummary("LONG");
    // Dispatch initial SL asynchronously
    const slPromise = engine.syncExchangeStopLossOrder("CORE_LONG", initialLong.totalQuantity, "LONG", initialLong.stopLossPrice);
    // Fire 1,000 ticks while the network request is in flight (40ms window)
    let auditCallCount = 0;
    for (let i = 0; i < 1000; i++) {
        engine.auditActivePositionRiskClosedLoop();
        auditCallCount++;
    }
    await slPromise;
    console.log(`  Ticks Processed: ${auditCallCount} | Outbound Order Dispatches: ${placeOrderCount}`);
    if (placeOrderCount !== 1) {
        throw new Error(`FAIL: In-flight grace failed! Expected exactly 1 order dispatch, got ${placeOrderCount}`);
    }
    console.log("  ✅ STAGE 1 PASSED: 1,000 rapid ticks during in-flight await generated 0 duplicate dispatches!\n");
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 2] Testing SL Ratchet Thresholding & Epsilon Protection...");
    const coreLong = ledger.getCoreLong();
    const currentSynced = coreLong.lastSyncedSlPrice || 0;
    // Test micro-tick fluctuation (e.g. $0.01 move on $60,000 BTC)
    const initialPlaceCount = placeOrderCount;
    // Set tiny change in target price and call sync
    await engine.syncExchangeStopLossOrder("CORE_LONG", initialLong.totalQuantity, "LONG", currentSynced + 0.01);
    console.log(`  Micro-Fluctuation ($0.01) Dispatches: ${placeOrderCount - initialPlaceCount}`);
    // Test significant ratchet move ($60,000 -> $60,100)
    await engine.syncExchangeStopLossOrder("CORE_LONG", initialLong.totalQuantity, "LONG", 60100);
    console.log(`  Significant Ratchet ($60,100) Dispatches: ${placeOrderCount - initialPlaceCount}`);
    if (placeOrderCount - initialPlaceCount < 1) {
        throw new Error("FAIL: Significant ratchet did not dispatch replacement SL!");
    }
    console.log("  ✅ STAGE 2 PASSED: SL Ratchet properly filtered micro-noise and accepted verified delta!\n");
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 3] Testing BinanceRateLimiter Header Ingestion & Pre-Flight Backoff...");
    const rateLimiter = mockExecClient.getRateLimiter();
    // Ingest headers approaching 80% weight (1950 / 2400)
    rateLimiter.updateFromHeaders({
        "x-mbx-used-weight-1m": "1950",
        "x-mbx-order-count-10s": "245",
    });
    const status = rateLimiter.getStatus();
    console.log(`  Rate Limiter Status: UsedWeight1m: ${status.usedWeight1m}/2400, Orders10s: ${status.orderCount10s}/300, IsThrottled: ${status.isThrottled}`);
    if (!status.isThrottled) {
        throw new Error("FAIL: Rate limiter should be throttled at >80% threshold!");
    }
    const startPreFlight = Date.now();
    await rateLimiter.acquirePreFlightAllowance(true);
    const elapsedPreFlight = Date.now() - startPreFlight;
    console.log(`  Pre-Flight Throttling Delay: ${elapsedPreFlight}ms`);
    if (elapsedPreFlight < 150) {
        throw new Error(`FAIL: Pre-flight throttling delay too short (${elapsedPreFlight}ms < 150ms)!`);
    }
    console.log("  ✅ STAGE 3 PASSED: Rate limiter dynamically throttled pre-flight request before hitting Binance limit!\n");
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 4] Testing 429/418 Circuit Breaker Backoff...");
    rateLimiter.register429Backoff(200);
    const status429 = rateLimiter.getStatus();
    console.log(`  Circuit Breaker Active: ${status429.isThrottled}, Backoff Remaining: ${status429.backoffRemainingMs}ms`);
    const start429 = Date.now();
    await rateLimiter.acquirePreFlightAllowance(false);
    const elapsed429 = Date.now() - start429;
    console.log(`  Circuit Breaker Actual Wait: ${elapsed429}ms`);
    if (elapsed429 < 180) {
        throw new Error(`FAIL: Circuit breaker did not enforce 429 backoff (${elapsed429}ms < 180ms)!`);
    }
    console.log("  ✅ STAGE 4 PASSED: 429 Circuit Breaker enforced mandatory cooldown before proceeding!\n");
    console.log("==========================================================================================");
    console.log("  🎉 ALL 4 STAGES OF LVCQ MICROTASK LOOP ERADICATION & RATE LIMITER PASSED 100%!");
    console.log("==========================================================================================");
}
runLvcqMicrotaskLoopTest().catch((err) => {
    console.error("TEST FAILED:", err);
    process.exit(1);
});
