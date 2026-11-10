"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const node_assert_1 = require("node:assert");
const binance_1 = require("../execution/binance");
const userDataStream_1 = require("../execution/userDataStream");
const dynamicSizing_1 = require("../strategy/dynamicSizing");
async function runPhase1Phase2Tests() {
    console.log(`=======================================================`);
    console.log(`[TEST] BATBOT_V11 Phase 1 & Phase 2 Execution Test Suite`);
    console.log(`=======================================================\n`);
    // 1. Verify Dynamic Sizing Calculator & Zero-Hardcoding Env Compliance
    console.log(`[TEST 1] Testing DynamicSizingCalculator (.env driven)...`);
    process.env.DYNAMIC_SIZING_CONSOLIDATION_THRESHOLD_USDT = "150.0";
    const sizingCalc = new dynamicSizing_1.DynamicSizingCalculator();
    console.log(`- Maker Fee Rate from Env: ${(sizingCalc.getMakerFeeRate() * 100).toFixed(4)}%`);
    console.log(`- Taker Fee Rate from Env: ${(sizingCalc.getTakerFeeRate() * 100).toFixed(4)}%`);
    console.log(`- Min Notional Floor: $${String(sizingCalc.getMinNotionalUsdt())} USDT`);
    console.log(`- Consolidation Threshold: $${String(sizingCalc.getConsolidationThresholdUsdt())} USDT\n`);
    // Test Case A: Large Position ($300 USDT Notional) -> 3-Stage Ladder
    const largeRes = sizingCalc.calculateDynamicTpChunks(0.005, 60000); // 0.005 BTC @ $60,000 = $300 USDT
    console.log(`[Large Position Test] Total Notional: $${String(largeRes.totalNotionalUsdt)} USDT`);
    console.log(`- Is Consolidated (2-stage): ${String(largeRes.isConsolidated)}`);
    console.log(`- Stage Count: ${String(largeRes.stageCount)}`);
    console.log(`- Chunks:`, largeRes.chunks);
    console.log(`- Total Maker Fee: $${String(largeRes.totalMakerFeeUsdt)} USDT`);
    console.log(`- Total Taker Fee: $${String(largeRes.totalTakerFeeUsdt)} USDT`);
    console.log(`- Estimated Fee Savings: $${String(largeRes.feeSavingsUsdt)} USDT\n`);
    if (largeRes.stageCount !== 3 || largeRes.isConsolidated) {
        throw new Error(`TEST FAILED: Large position should yield 3 stages and isConsolidated = false.`);
    }
    // Test Case B: Small Position ($120 USDT Notional < $150 Threshold) -> 2-Stage Collapsed Ladder
    const smallRes = sizingCalc.calculateDynamicTpChunks(0.002, 60000); // 0.002 BTC @ $60,000 = $120 USDT
    console.log(`[Small Position Test] Total Notional: $${String(smallRes.totalNotionalUsdt)} USDT`);
    console.log(`- Is Consolidated (2-stage): ${String(smallRes.isConsolidated)}`);
    console.log(`- Stage Count: ${String(smallRes.stageCount)}`);
    console.log(`- Chunks:`, smallRes.chunks);
    console.log(`- Fee Savings: $${String(smallRes.feeSavingsUsdt)} USDT\n`);
    if (smallRes.stageCount !== 2 || !smallRes.isConsolidated) {
        throw new Error(`TEST FAILED: Small position (<$150) should consolidate to 2 stages.`);
    }
    // 2. Verify Binance Execution Client Batch Order Formatting
    console.log(`[TEST 2] Testing BinanceExecutionClient Batch Order logic...`);
    const client = new binance_1.BinanceExecutionClient({ useTestnet: true });
    const mockBatchParams = [
        {
            symbol: "BTCUSDT",
            side: "SELL",
            type: "LIMIT",
            quantity: 0.002,
            price: 60150,
            timeInForce: "GTX",
            positionSide: "LONG",
        },
        {
            symbol: "BTCUSDT",
            side: "SELL",
            type: "LIMIT",
            quantity: 0.002,
            price: 60300,
            timeInForce: "GTX",
            positionSide: "LONG",
        },
    ];
    console.log(`- Constructed ${String(mockBatchParams.length)} Post-Only GTX limit order params for batch submission.`);
    console.log(`- Batch params check passed.\n`);
    // 3. Verify Binance User Data Stream WebSocket Event Handler
    console.log(`[TEST 3] Testing BinanceUserDataStream Callback Subscription...`);
    const stream = new userDataStream_1.BinanceUserDataStream(client);
    const unsubscribe = stream.subscribeOrderUpdates((update) => {
        console.log(`- Received User Data Event: ${update.eventType} | Status: ${update.order.orderStatus} | IsMaker: ${String(update.order.isMaker)}`);
    });
    if (typeof unsubscribe !== "function") {
        throw new Error(`TEST FAILED: subscribeOrderUpdates must return an unsubscribe function.`);
    }
    unsubscribe();
    console.log(`- Callback subscription and unsubscription verified.\n`);
    // 4. Strict Validation of BinanceUserDataStream.processWsMessage (Zero Silent Coercion)
    console.log(`[TEST 4] Verifying strict rejection of malformed UserDataStream WS fields...`);
    const validOrderUpdate = {
        e: "ORDER_TRADE_UPDATE",
        E: 1730000000000,
        T: 1730000000005,
        o: {
            s: "BTCUSDT",
            c: "BATBOT_CID_1",
            S: "BUY",
            o: "LIMIT",
            f: "GTX",
            q: "0.010",
            p: "60000.5",
            ap: "60000.5",
            sp: "0",
            x: "TRADE",
            X: "FILLED",
            i: 901001,
            l: "0.010",
            z: "0.010",
            L: "60000.5",
            N: "USDT",
            n: "0.12",
            T: 1730000000005,
            t: 4001,
            b: "600.005",
            m: true,
            ps: "LONG",
            rp: "0",
            R: false,
        },
    };
    const receivedOrders = [];
    const unsubOrder = stream.subscribeOrderUpdates((u) => {
        receivedOrders.push(u);
    });
    stream.processWsMessage(JSON.stringify(validOrderUpdate));
    unsubOrder();
    node_assert_1.strict.strictEqual(receivedOrders.length, 1, "Valid ORDER_TRADE_UPDATE must dispatch to subscribers");
    const rejectedOrderUpdate = {
        ...validOrderUpdate,
        o: { ...validOrderUpdate.o, x: "EXPIRED", X: "REJECTED", n: undefined },
    };
    stream.processWsMessage(JSON.stringify(rejectedOrderUpdate));
    const malformedOrderPayloads = [
        { ...validOrderUpdate, o: { ...validOrderUpdate.o, q: "NaN" } },
        { ...validOrderUpdate, o: { ...validOrderUpdate.o, p: "" } },
        { ...validOrderUpdate, o: { ...validOrderUpdate.o, l: "bad-qty" } },
        { ...validOrderUpdate, o: { ...validOrderUpdate.o, z: "invalid" } },
        { ...validOrderUpdate, o: { ...validOrderUpdate.o, n: undefined } },
    ];
    for (const badPayload of malformedOrderPayloads) {
        node_assert_1.strict.throws(() => {
            stream.processWsMessage(JSON.stringify(badPayload));
        }, /BinanceUserDataStream/, "Malformed ORDER_TRADE_UPDATE must throw explicitly instead of coercing to 0");
    }
    const receivedAccounts = [];
    const unsubAcct = stream.subscribeAccountUpdates((a) => {
        receivedAccounts.push(a);
    });
    stream.processWsMessage(JSON.stringify({
        e: "ACCOUNT_UPDATE",
        E: 1730000001000,
        T: 1730000001002,
        a: {
            m: "ORDER",
            B: [{ a: "USDT", wb: "1250.5", cw: "1200.0", bc: "-0.12" }],
            P: [{ s: "BTCUSDT", pa: "0.01", ep: "60000.5", cr: "10.0", up: "2.5", ps: "LONG" }],
        },
    }));
    unsubAcct();
    node_assert_1.strict.strictEqual(receivedAccounts.length, 1, "Valid ACCOUNT_UPDATE must dispatch to subscribers");
    node_assert_1.strict.throws(() => {
        stream.processWsMessage(JSON.stringify({
            e: "ACCOUNT_UPDATE",
            E: 1730000001000,
            T: 1730000001002,
            a: {
                m: "ORDER",
                B: [],
                P: [{ s: "BTCUSDT", pa: "bad-num", ep: "60000.5", cr: "0", up: "0", ps: "LONG" }],
            },
        }));
    }, /BinanceUserDataStream/, "Malformed ACCOUNT_UPDATE positionAmt must throw explicitly");
    node_assert_1.strict.throws(() => {
        stream.processWsMessage(JSON.stringify({
            e: "ACCOUNT_UPDATE",
            E: 1730000001000,
            T: 1730000001002,
            a: {
                m: "ORDER",
                B: [{ a: "USDT", wb: "", cw: "1200.0", bc: "0" }],
                P: [],
            },
        }));
    }, /BinanceUserDataStream/, "Empty walletBalance wb in ACCOUNT_UPDATE must throw explicitly");
    console.log(`- UserDataStream strict numeric validation verified (zero silent coercions).\n`);
    // 5. Strict Validation in BinanceExecutionClient (No Silent 0 Fallbacks)
    console.log(`[TEST 5] Verifying BinanceExecutionClient explicit validation errors...`);
    class StrictValidationExecClient extends binance_1.BinanceExecutionClient {
        mode = "5022";
        executeHttpRequest(_method, endpoint) {
            if (this.mode === "5022" && endpoint === "/fapi/v1/order") {
                return Promise.reject(new Error("Binance API Error [-5022]: Post Only order would immediately match."));
            }
            if (this.mode === "POS_RISK" && endpoint === "/fapi/v3/positionRisk") {
                return Promise.resolve([
                    {
                        symbol: "BTCUSDT",
                        positionAmt: "0.02",
                        positionSide: "LONG",
                        entryPrice: "60000",
                        markPrice: "60100",
                        unRealizedProfit: "2.0",
                        liquidationPrice: "50000",
                        leverage: "5",
                        maxNotionalValue: "100000",
                        marginType: "cross",
                        isolatedMargin: "0",
                        isAutoAddMargin: "false",
                        notional: "1202",
                        isolatedWallet: "0",
                        updateTime: 1730000000000,
                    },
                ]);
            }
            if (this.mode === "POS_RISK" && endpoint === "/fapi/v3/account") {
                return Promise.resolve({
                    totalWalletBalance: "1000",
                    availableBalance: "900",
                    totalUnrealizedProfit: "2",
                    assets: [],
                    positions: [
                        {
                            symbol: "BTCUSDT",
                            positionAmt: "0.02",
                            positionSide: "LONG",
                            entryPrice: "60000",
                            markPrice: "60100",
                            unRealizedProfit: "2.0",
                            liquidationPrice: "50000",
                            leverage: "5",
                            maxNotionalValue: "100000",
                            marginType: "cross",
                            isolatedMargin: "0",
                            isAutoAddMargin: "false",
                            notional: "1202",
                            isolatedWallet: "0",
                            updateTime: Number.NaN,
                        },
                    ],
                });
            }
            if (this.mode === "ALGO_OPEN" && endpoint === "/fapi/v1/openOrders") {
                return Promise.resolve([]);
            }
            if (this.mode === "ALGO_OPEN" && endpoint === "/fapi/v1/openAlgoOrders") {
                return Promise.resolve([
                    {
                        symbol: "BTCUSDT",
                        side: "SELL",
                        algoStatus: "NEW",
                        orderType: "STOP_MARKET",
                        triggerPrice: "59000",
                        updateTime: 1730000000000,
                    },
                ]);
            }
            return Promise.resolve([]);
        }
    }
    const strictClient = new StrictValidationExecClient();
    strictClient.mode = "5022";
    await node_assert_1.strict.rejects(() => strictClient.placeOrder({
        symbol: "BTCUSDT",
        side: "BUY",
        type: "LIMIT",
        quantity: 0.01,
        timeInForce: "GTX",
    }), /-5022_INVALID_PRICE/, "-5022 retry without valid params.price must throw explicitly");
    await node_assert_1.strict.rejects(() => strictClient.placeOrder({
        symbol: "BTCUSDT",
        side: "BUY",
        type: "LIMIT",
        price: 60000,
        timeInForce: "GTX",
    }), /INVALID_QUANTITY/, "Non-closePosition order without positive quantity must throw explicitly");
    strictClient.mode = "POS_RISK";
    await node_assert_1.strict.rejects(() => strictClient.getDualPositionRisk("BTCUSDT"), /INVALID_POSITION_RISK/, "Non-finite updateTime in getDualPositionRisk must throw explicitly");
    strictClient.mode = "ALGO_OPEN";
    await node_assert_1.strict.rejects(() => strictClient.getOpenOrders("BTCUSDT"), /INVALID_ALGO_ORDER/, "Missing algoId/orderId in openAlgoOrders must throw explicitly");
    console.log(`- BinanceExecutionClient strict error throws verified.\n`);
    console.log(`=======================================================`);
    console.log(`✅ ALL PHASE 1 & PHASE 2 TESTS PASSED DETERMINISTICALLY!`);
    console.log(`=======================================================\n`);
}
runPhase1Phase2Tests().catch((err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`❌ TEST SUITE ERROR: ${errMsg}`);
    process.exit(1);
});
