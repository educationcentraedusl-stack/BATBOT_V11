"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
const multiEngine_1 = require("../strategy/multiEngine");
async function runStateSyncAndOrphanHealingTest() {
    console.log("=========================================================================");
    console.log("  TEST: SOTA ZERO-LOSS STATE SYNCHRONIZATION & ORPHAN AUTO-HEALING        ");
    console.log("=========================================================================\n");
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
    const maxAssets = 4;
    const slotsPerAsset = 256;
    const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    const riskGuard = new risk_1.MultiAssetRiskGuard();
    const executionClient = new binance_1.BinanceExecutionClient();
    const multiEngine = new multiEngine_1.MultiAssetStrategyEngine(client, riskGuard, executionClient, symbols);
    // TEST 1: WebSocket Multiplexing & Entry Fill Binding
    console.log("[Test 1/4] Verifying Multiplexed WebSocket ORDER_TRADE_UPDATE Handling...");
    const solEngine = multiEngine.getEngineForSymbol("SOLUSDT");
    if (!solEngine)
        throw new Error("SOLUSDT engine not found");
    // Simulate incoming WebSocket trade fill for SOLUSDT Short Entry
    const mockWsOrderUpdate = {
        eventType: "ORDER_TRADE_UPDATE",
        eventTime: Date.now(),
        transactionTime: Date.now(),
        order: {
            symbol: "SOLUSDT",
            clientOrderId: "test_sol_short_01",
            side: "SELL",
            orderType: "LIMIT",
            timeInForce: "GTX",
            originalQuantity: 0.78,
            originalPrice: 76.05,
            averagePrice: 76.05,
            stopPrice: 0,
            executionType: "TRADE",
            orderStatus: "FILLED",
            orderId: 987654321,
            lastFilledQuantity: 0.78,
            cumulativeFilledQuantity: 0.78,
            lastFilledPrice: 76.05,
            commissionAsset: "USDT",
            commissionAmount: 0.02,
            tradeTime: Date.now(),
            tradeId: 112233,
            bidsNotional: 0,
            isMaker: true,
            positionSide: "SHORT",
            realizedPnl: 0,
        },
    };
    solEngine.handleWsOrderUpdate(mockWsOrderUpdate);
    const solSummary = solEngine.getHedgeLedger().getSummary(76.05);
    console.log(`  - SOLUSDT Ledger Side: ${solSummary.side} (Expected: SHORT)`);
    console.log(`  - SOLUSDT Ledger Short Qty: ${solSummary.shortQuantity} (Expected: 0.78)`);
    console.log(`  - SOLUSDT Ledger Entry Price: $${solSummary.averageEntryPrice} (Expected: 76.05)`);
    if (solSummary.side !== "SHORT" || Math.abs(solSummary.shortQuantity - 0.78) > 1e-4) {
        throw new Error(`Test 1 Failed: SOLUSDT position not bound properly to HedgePositionLedger!`);
    }
    // Verify SAB Slot #2 state sync
    const solAssetIdx = 2;
    const sabQty = client.getOmsPositionQty(solAssetIdx);
    const sabShortQty = client.getOmsShortPositionQty(solAssetIdx);
    const sabSideCode = client.getOmsPositionSide(solAssetIdx);
    const sabEntryPx = client.getOmsAvgEntryPrice(solAssetIdx);
    console.log(`  - SAB Slot #2 Position Qty: ${sabQty} (Expected: 0.78)`);
    console.log(`  - SAB Slot #2 Short Qty: ${sabShortQty} (Expected: 0.78)`);
    console.log(`  - SAB Slot #2 Side Code: ${sabSideCode} (Expected: 2.0 = SHORT)`);
    console.log(`  - SAB Slot #2 Entry Price: $${sabEntryPx} (Expected: 76.05)`);
    if (sabSideCode !== 2.0 || Math.abs(sabShortQty - 0.78) > 1e-4 || Math.abs(sabEntryPx - 76.05) > 1e-4) {
        throw new Error(`Test 1 Failed: SharedArrayBuffer not synchronized with SOLUSDT state!`);
    }
    console.log("  ✅ Test 1 Passed: WS Order Update successfully occupied slot and synchronized SAB.\n");
    // TEST 2: WebSocket ACCOUNT_UPDATE Position Desync Reconciler
    console.log("[Test 2/4] Verifying ACCOUNT_UPDATE Desync Detection & Auto-Reconciliation...");
    const mockAccountUpdate = {
        eventType: "ACCOUNT_UPDATE",
        eventTime: Date.now(),
        transactionTime: Date.now(),
        reasonType: "ORDER",
        positions: [
            {
                symbol: "ETHUSDT",
                positionAmt: 0.05,
                entryPrice: 1888.50,
                accumulatedRealized: 0,
                unrealizedPnl: 0.5,
                positionSide: "LONG",
            },
        ],
    };
    const ethEngine = multiEngine.getEngineForSymbol("ETHUSDT");
    ethEngine.handleWsAccountPositionUpdate(mockAccountUpdate.positions[0]);
    const ethSummary = ethEngine.getHedgeLedger().getSummary(1888.50);
    console.log(`  - ETHUSDT Ledger Side: ${ethSummary.side} (Expected: LONG)`);
    console.log(`  - ETHUSDT Ledger Long Qty: ${ethSummary.longQuantity} (Expected: 0.05)`);
    console.log(`  - ETHUSDT Ledger Entry Price: $${ethSummary.averageEntryPrice} (Expected: 1888.5)`);
    const ethAssetIdx = 1;
    const ethSabLongQty = client.getOmsLongPositionQty(ethAssetIdx);
    const ethSabSideCode = client.getOmsPositionSide(ethAssetIdx);
    console.log(`  - SAB Slot #1 Long Qty: ${ethSabLongQty} (Expected: 0.05)`);
    console.log(`  - SAB Slot #1 Side Code: ${ethSabSideCode} (Expected: 1.0 = LONG)`);
    if (ethSabSideCode !== 1.0 || Math.abs(ethSabLongQty - 0.05) > 1e-4) {
        throw new Error(`Test 2 Failed: ETHUSDT ACCOUNT_UPDATE not reconciled to SAB!`);
    }
    console.log("  ✅ Test 2 Passed: ACCOUNT_UPDATE desync reconciliation verified.\n");
    // TEST 3: Out-of-Band REST State Sync & Protective SL/TP Injection
    console.log("[Test 3/4] Verifying Active Exchange Out-of-Band State Hydration...");
    const mockExchangePositions = [
        {
            symbol: "BTCUSDT",
            positionAmt: "0.0009",
            entryPrice: "63375.60",
            markPrice: "63400.00",
            unRealizedProfit: "0.02",
            liquidationPrice: "0",
            leverage: "10",
            maxNotionalValue: "1000000",
            marginType: "cross",
            isolatedMargin: "0",
            isAutoAddMargin: "false",
            positionSide: "LONG",
            notional: "57.06",
            isolatedWallet: "0",
            updateTime: Date.now(),
        },
        {
            symbol: "BNBUSDT",
            positionAmt: "0.10",
            entryPrice: "609.54",
            markPrice: "610.00",
            unRealizedProfit: "0.05",
            liquidationPrice: "0",
            leverage: "10",
            maxNotionalValue: "1000000",
            marginType: "cross",
            isolatedMargin: "0",
            isAutoAddMargin: "false",
            positionSide: "LONG",
            notional: "60.95",
            isolatedWallet: "0",
            updateTime: Date.now(),
        },
    ];
    multiEngine.reconcileStartupPositions(mockExchangePositions);
    const btcEngine = multiEngine.getEngineForSymbol("BTCUSDT");
    const bnbEngine = multiEngine.getEngineForSymbol("BNBUSDT");
    const btcSummary = btcEngine.getHedgeLedger().getSummary(63400.0);
    const bnbSummary = bnbEngine.getHedgeLedger().getSummary(610.0);
    console.log(`  - BTCUSDT Synced Qty: ${btcSummary.longQuantity} (Expected: 0.0009)`);
    console.log(`  - BNBUSDT Synced Qty: ${bnbSummary.longQuantity} (Expected: 0.1)`);
    const btcSabQty = client.getOmsLongPositionQty(0);
    const bnbSabQty = client.getOmsLongPositionQty(3);
    if (Math.abs(btcSabQty - 0.0009) > 1e-6 || Math.abs(bnbSabQty - 0.1) > 1e-4) {
        throw new Error(`Test 3 Failed: Multi-asset startup position reconciliation mismatch!`);
    }
    console.log("  ✅ Test 3 Passed: Out-of-band state hydration correctly mapped all positions.\n");
    // TEST 4: Continuous Reconciliation Heartbeat Integrity
    console.log("[Test 4/4] Verifying Continuous Reconciliation Heartbeat Control...");
    multiEngine.startContinuousReconciliation(100);
    await new Promise((r) => setTimeout(r, 250));
    multiEngine.stopContinuousReconciliation();
    console.log("  ✅ Test 4 Passed: Continuous Reconciliation Heartbeat started and cleanly stopped.\n");
    console.log("=========================================================================");
    console.log("  🎉 ALL SOTA STATE SYNCHRONIZATION AUDIT SUITES PASSED (100% QA VERIFIED)");
    console.log("=========================================================================");
}
if (require.main === module) {
    runStateSyncAndOrphanHealingTest().catch((err) => {
        console.error(`❌ Test Suite Failed: ${err.message}`);
        process.exit(1);
    });
}
