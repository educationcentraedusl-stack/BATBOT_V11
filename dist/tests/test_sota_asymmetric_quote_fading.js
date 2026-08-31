"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * SOTA VERIFICATION TEST: Cartea-Jaimungal Drift-Adjusted Quote Fading & Winner's Curse Protection (DEF-06 & DEF-3004)
 * Validates that adverse order flow (OFI/TFI/CVD) physically causes StrategyEngine to fade limit entry quotes
 * by 1 tick deeper into the book, while quoting at the top of book during neutral/favorable flow.
 */
require("dotenv/config");
const engine_1 = require("../strategy/engine");
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
function createMockExecutionClient() {
    const capturedOrders = [];
    const client = new binance_1.BinanceExecutionClient();
    client.isConfigured = () => true;
    client.placeOrder = async (params) => {
        capturedOrders.push({ params });
        return {
            orderId: 100001 + capturedOrders.length,
            symbol: params.symbol,
            status: "NEW",
            clientOrderId: params.clientOrderId || "MOCK_CID",
            price: params.price ? String(params.price) : "0",
            avgPrice: "0",
            origQty: String(params.quantity),
            executedQty: "0",
            cumQuote: "0",
            timeInForce: params.timeInForce || "GTX",
            type: params.type || "LIMIT",
            side: params.side,
            reduceOnly: params.reduceOnly || false,
            positionSide: params.positionSide || "BOTH",
            stopPrice: params.stopPrice ? String(params.stopPrice) : "0",
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    client.cancelOrder = async () => ({
        orderId: 0,
        symbol: "BTCUSDT",
        status: "CANCELED",
        clientOrderId: "MOCK",
        price: "0",
        avgPrice: "0",
        origQty: "0",
        executedQty: "0",
        cumQuote: "0",
        timeInForce: "GTC",
        type: "LIMIT",
        side: "BUY",
        reduceOnly: false,
        positionSide: "SHORT",
        stopPrice: "0",
        workingType: "CONTRACT_PRICE",
        updateTime: Date.now(),
    });
    client.cancelBatchOrders = async () => [];
    client.placePositionStopLoss = async () => ({
        orderId: 999999,
        symbol: "BTCUSDT",
        status: "NEW",
        clientOrderId: "MOCK_SL",
        price: "0",
        avgPrice: "0",
        origQty: "0",
        executedQty: "0",
        cumQuote: "0",
        timeInForce: "GTC",
        type: "STOP_MARKET",
        side: "SELL",
        reduceOnly: false,
        positionSide: "LONG",
        stopPrice: "0",
        workingType: "CONTRACT_PRICE",
        updateTime: Date.now(),
    });
    client.getDualPositionRisk = async () => [];
    client.getOpenOrders = async () => [];
    client.getUserTrades = async () => [];
    client.subscribeIncomeUpdates = () => () => { };
    client.subscribeUserTradeUpdates = () => () => { };
    return { client, capturedOrders };
}
async function runQuoteFadingTest() {
    console.log("================================================================================");
    console.log("  BATBOT_V11 SOTA: CARTEA-JAIMUNGAL DRIFT-ADJUSTED QUOTE FADING (DEF-3004)");
    console.log("================================================================================\n");
    const sab = new SharedArrayBuffer(10 * 256 * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, 10, 256);
    const riskConfig = {
        maxPositionSizeUsdt: 10000,
        minCooldownMs: 0,
        maxDailyLossUsdt: 100,
        maxPriceSlippagePercent: 1.0,
        dailyProfitLockTargetUsdt: 1000,
        minRiskRewardRatio: 2.0,
        minNetAlpha: 0.0004,
        takerFeeRate: 0.00045,
        makerFeeRate: 0.00018,
    };
    const riskGuard = new risk_1.RiskGuard(riskConfig);
    const { client: mockExec, capturedOrders } = createMockExecutionClient();
    const btcConfig = {
        symbol: "BTCUSDT",
        tradeSizeUsdt: 60,
        minAiConfidence: 0.60,
        aggressiveConfidenceThreshold: 0.70,
        obiBuyThreshold: 0.10,
        obiSellThreshold: -0.10,
        cooldownMs: 0,
        tickSize: 0.10,
        maxShortSlots: 3,
    };
    const engine = new engine_1.StrategyEngine(client, riskGuard, mockExec, btcConfig);
    const bigIntView = new BigInt64Array(sab);
    let seqNum = 100n;
    // --------------------------------------------------------------------------------
    // [CASE 1] Neutral / Favorable Flow -> Limit Bid Placed at Top of Book ($77,000.0)
    // --------------------------------------------------------------------------------
    console.log("[CASE 1] Testing Favorable/Neutral Order Flow...");
    {
        capturedOrders.length = 0;
        // Seed SAB Orderbook
        client.writeAtomicFloat64Asset(0, 4, 77000.0); // Best Bid
        client.writeAtomicFloat64Asset(0, 5, 10.0); // Best Bid Qty
        client.writeAtomicFloat64Asset(0, 6, 77001.0); // Best Ask
        client.writeAtomicFloat64Asset(0, 7, 10.0); // Best Ask Qty
        client.writeAtomicFloat64Asset(0, 1, 0.15); // OBI (+0.15)
        client.writeAtomicFloat64Asset(0, 2, 100.0); // CVD
        client.writeAtomicFloat64Asset(0, 112, 0.10); // Hawkes
        client.writeAtomicFloat64Asset(0, 121, 0.001); // Vol
        client.writeAtomicFloat64Asset(0, 123, 0.50); // Hurst
        client.writeAtomicFloat64Asset(0, 124, 0.50); // Entropy
        client.writeAtomicFloat64Asset(0, 93, 1.0); // AI Direction BUY (+1.0)
        client.writeAtomicFloat64Asset(0, 94, 0.85); // AI Confidence 85%
        // Update Hazard Engine with balanced book states
        engine.getHazardEngine().updateOrderBook(77000.0, 10.0, 77001.0, 10.0);
        engine.getHazardEngine().updateTrade(77000.5, 1.0, false); // Buyer trade (+TFI)
        seqNum += 1n;
        Atomics.store(bigIntView, 92, seqNum);
        const res = engine.evaluateTick();
        if (res.executionPromise) {
            await res.executionPromise;
        }
        if (capturedOrders.length === 0) {
            throw new Error("Case 1 Failed: Expected BUY order to be dispatched!");
        }
        const placedOrder = capturedOrders[0].params;
        console.log(`  - Quoted Side: ${placedOrder.side}, Type: ${placedOrder.type}, TIF: ${placedOrder.timeInForce}`);
        console.log(`  - Quoted Price: $${placedOrder.price} (Expected: $77000.0 Top of Book)`);
        if (placedOrder.price !== 77000.0) {
            throw new Error(`Case 1 Failed: Expected quoted price 77000.0, got ${placedOrder.price}`);
        }
        console.log("  ✓ Case 1 Passed: Neutral order flow quotes at Top of Book with zero fading.\n");
    }
    // --------------------------------------------------------------------------------
    // [CASE 2] Adverse Toxic Sell Flow -> Fades BUY Limit Quote by 1 Tick ($76,999.9)
    // --------------------------------------------------------------------------------
    console.log("[CASE 2] Testing Adverse Toxic Sell Flow (Aggressive Sellers Sweeping Book)...");
    {
        capturedOrders.length = 0;
        // Reset ledger to flat and clear in-flight pending entry states
        engine.getHedgeLedger().reset();
        engine.clearPendingEntryOrders();
        engine.getHazardEngine().reset();
        // Simulate aggressive toxic selling pressure in HazardEngine:
        for (let i = 0; i < 20; i++) {
            engine.getHazardEngine().updateTrade(77000.0, 50.0, true); // Aggressive sell trades
            engine.getHazardEngine().updateOrderBook(77000.0 - i * 0.01, 2.0, 77001.0, 50.0);
        }
        // Set CVD velocity to negative selling flow
        const nowMs = Date.now();
        client.writeAtomicFloat64Asset(0, 2, -5000.0);
        client.getCVDVelocity(0, 5000, nowMs);
        // Keep Bid = 77000.0, Ask = 77001.0 with positive AI signal
        client.writeAtomicFloat64Asset(0, 4, 77000.0);
        client.writeAtomicFloat64Asset(0, 5, 2.0);
        client.writeAtomicFloat64Asset(0, 6, 77001.0);
        client.writeAtomicFloat64Asset(0, 7, 50.0);
        client.writeAtomicFloat64Asset(0, 1, 0.15); // Favorable OBI
        client.writeAtomicFloat64Asset(0, 93, 1.0); // AI BUY Signal
        client.writeAtomicFloat64Asset(0, 94, 0.85); // 85% Confidence
        seqNum += 1n;
        Atomics.store(bigIntView, 92, seqNum);
        const res = engine.evaluateTick();
        if (res.executionPromise) {
            await res.executionPromise;
        }
        if (capturedOrders.length === 0) {
            throw new Error("Case 2 Failed: Expected BUY order to be dispatched!");
        }
        const placedOrder = capturedOrders[0].params;
        console.log(`  - Quoted Side: ${placedOrder.side}, Type: ${placedOrder.type}, TIF: ${placedOrder.timeInForce}`);
        console.log(`  - Quoted Price: $${placedOrder.price} (Expected: $76999.9 Faded by 1 tick = $0.10)`);
        if (placedOrder.price !== 76999.9) {
            throw new Error(`Case 2 Failed: Expected faded bid quote 76999.9, got ${placedOrder.price}`);
        }
        console.log("  ✓ Case 2 Passed: Adverse toxic sell flow successfully faded BUY quote 1 tick deeper into the book!\n");
    }
    // --------------------------------------------------------------------------------
    // [CASE 3] Adverse Toxic Buy Flow -> Fades SELL Limit Quote by 1 Tick ($77,001.1)
    // --------------------------------------------------------------------------------
    console.log("[CASE 3] Testing Adverse Toxic Buy Flow on SELL Signal...");
    {
        capturedOrders.length = 0;
        // Reset ledger to flat and clear in-flight pending entry states
        engine.getHedgeLedger().reset();
        engine.clearPendingEntryOrders();
        engine.getHazardEngine().reset();
        // Simulate aggressive toxic buying pressure in HazardEngine:
        for (let i = 0; i < 20; i++) {
            engine.getHazardEngine().updateTrade(77000.0 + i * 0.05, 50.0, false); // Aggressive taker buy trades
            engine.getHazardEngine().updateOrderBook(77000.0, 50.0, 77000.80 + i * 0.01, 2.0);
        }
        // Set CVD velocity to positive buying flow
        const nowMs = Date.now();
        client.writeAtomicFloat64Asset(0, 2, 5000.0);
        client.getCVDVelocity(0, 5000, nowMs);
        // Keep Bid = 77000.0, Ask = 77001.0 with negative AI signal
        client.writeAtomicFloat64Asset(0, 4, 77000.0);
        client.writeAtomicFloat64Asset(0, 5, 50.0);
        client.writeAtomicFloat64Asset(0, 6, 77001.0);
        client.writeAtomicFloat64Asset(0, 7, 2.0);
        client.writeAtomicFloat64Asset(0, 1, -0.15); // Negative OBI
        client.writeAtomicFloat64Asset(0, 93, -1.0); // AI SELL Signal (-1.0)
        client.writeAtomicFloat64Asset(0, 94, 0.85); // 85% Confidence
        seqNum += 1n;
        Atomics.store(bigIntView, 92, seqNum);
        const res = engine.evaluateTick();
        if (res.executionPromise) {
            await res.executionPromise;
        }
        if (capturedOrders.length === 0) {
            throw new Error("Case 3 Failed: Expected SELL order to be dispatched!");
        }
        const placedOrder = capturedOrders[0].params;
        console.log(`  - Quoted Side: ${placedOrder.side}, Type: ${placedOrder.type}, TIF: ${placedOrder.timeInForce}`);
        console.log(`  - Quoted Price: $${placedOrder.price} (Expected: $77001.1 Faded by 1 tick = $0.10)`);
        if (placedOrder.price !== 77001.1) {
            throw new Error(`Case 3 Failed: Expected faded ask quote 77001.1, got ${placedOrder.price}`);
        }
        console.log("  ✓ Case 3 Passed: Adverse toxic buy flow successfully faded SELL quote 1 tick higher into the book!\n");
    }
    console.log("================================================================================");
    console.log("  ✅ ALL SOTA QUOTE FADING TESTS PASSED VIA PHYSICAL STRATEGY ENGINE EXECUTION");
    console.log("================================================================================\n");
}
runQuoteFadingTest().catch((err) => {
    console.error("FATAL TEST ERROR:", err);
    process.exit(1);
});
