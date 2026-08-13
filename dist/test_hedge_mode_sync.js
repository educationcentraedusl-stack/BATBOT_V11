"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const marketDataClient_1 = require("./marketDataClient");
const engine_1 = require("./strategy/engine");
const risk_1 = require("./strategy/risk");
const binance_1 = require("./execution/binance");
async function testHedgeModeSync() {
    console.log("=========================================================================");
    console.log("RUNNING HEDGE MODE DUAL-DIRECTIONAL POSITION SYNC VERIFICATION TEST");
    console.log("=========================================================================");
    const sab = new SharedArrayBuffer(20480);
    const client = new marketDataClient_1.MarketDataClient(sab);
    const riskGuard = new risk_1.RiskGuard();
    const executionClient = new binance_1.BinanceExecutionClient();
    const strategyEngine = new engine_1.StrategyEngine(client, riskGuard, executionClient, {
        symbol: "ETHUSDT",
        assetIndex: 1,
        orderQuantity: 0.032,
        longTakeProfitPercent: 0.35,
        longStopLossPercent: 0.25,
    });
    // Mock Binance positionRisk response representing Binance in Hedge Mode with BOTH a Long and Short position on ETHUSDT
    const mockPositions = [
        {
            symbol: "ETHUSDT",
            positionAmt: "0.032",
            entryPrice: "1874.45",
            markPrice: "1874.45",
            unRealizedProfit: "0.00",
            liquidationPrice: "0",
            leverage: "10",
            maxNotionalValue: "1000000",
            marginType: "cross",
            isolatedMargin: "0.00000000",
            isAutoAddMargin: "false",
            positionSide: "LONG",
            notional: "59.98",
            isolatedWallet: "0",
            updateTime: Date.now(),
        },
        {
            symbol: "ETHUSDT",
            positionAmt: "-0.032",
            entryPrice: "1874.45",
            markPrice: "1874.45",
            unRealizedProfit: "0.00",
            liquidationPrice: "0",
            leverage: "10",
            maxNotionalValue: "1000000",
            marginType: "cross",
            isolatedMargin: "0.00000000",
            isAutoAddMargin: "false",
            positionSide: "SHORT",
            notional: "59.98",
            isolatedWallet: "0",
            updateTime: Date.now(),
        },
    ];
    // 1. Reconcile startup positions
    strategyEngine.reconcileStartupPositions(mockPositions);
    // 2. Verify both coreLong and shortSlots are occupied simultaneously
    const coreLong = strategyEngine.getHedgeLedger().getCoreLong();
    const shortSlots = strategyEngine.getHedgeLedger().getShortSlots();
    if (!coreLong.isOccupied || coreLong.quantity !== 0.032) {
        throw new Error(`FAIL: Core Long not occupied or quantity mismatched! Got: ${coreLong.quantity}`);
    }
    if (!shortSlots[0].isOccupied || shortSlots[0].quantity !== 0.032) {
        throw new Error(`FAIL: Short Slot #0 not occupied or quantity mismatched! Got: ${shortSlots[0].quantity}`);
    }
    console.log("✓ Test 1 Passed: Both Core Long (0.032) and Short Slot #0 (0.032) occupied in local HedgePositionLedger.");
    // 3. Verify position ledger summary
    const summary = strategyEngine.getHedgeLedger().getSummary(1874.45);
    console.log(`Position Summary -> Side: ${summary.side}, NetQty: ${summary.netQuantity}, LongQty: ${summary.longQuantity}, ShortQty: ${summary.shortQuantity}, GrossQty: ${summary.grossQuantity}, AvgEntry: $${summary.averageEntryPrice}`);
    if (summary.side !== "BOTH") {
        throw new Error(`FAIL: PositionLedger summary side must be 'BOTH', got '${summary.side}'`);
    }
    if (Math.abs(summary.netQuantity) > 1e-5) {
        throw new Error(`FAIL: PositionLedger netQuantity must be 0.0 for delta-neutral hedge, got ${summary.netQuantity}`);
    }
    if (Math.abs(summary.grossQuantity - 0.064) > 1e-5) {
        throw new Error(`FAIL: PositionLedger grossQuantity must be 0.064, got ${summary.grossQuantity}`);
    }
    console.log("✓ Test 2 Passed: HedgePositionLedger summary correctly identifies 'BOTH' side, 0.0 net quantity, and 0.064 gross quantity.");
    // 4. Verify SAB Position State Synchronization
    strategyEngine.syncSabPositionState(1874.45);
    const omsNetQty = client.getOmsPositionQty(1);
    const omsLongQty = client.getOmsLongPositionQty(1);
    const omsShortQty = client.getOmsShortPositionQty(1);
    const omsSideCode = client.getOmsPositionSide(1);
    console.log(`SAB Metrics -> NetQty: ${omsNetQty}, LongQty: ${omsLongQty}, ShortQty: ${omsShortQty}, SideCode: ${omsSideCode}`);
    if (Math.abs(omsNetQty) > 1e-5) {
        throw new Error(`FAIL: SAB OMS Net Position Quantity (Slot 105) must be 0.0, got ${omsNetQty}`);
    }
    if (Math.abs(omsLongQty - 0.032) > 1e-5) {
        throw new Error(`FAIL: SAB OMS Long Position Quantity (Slot 143) must be 0.032, got ${omsLongQty}`);
    }
    if (Math.abs(omsShortQty - 0.032) > 1e-5) {
        throw new Error(`FAIL: SAB OMS Short Position Quantity (Slot 144) must be 0.032, got ${omsShortQty}`);
    }
    if (omsSideCode !== 3.0) {
        throw new Error(`FAIL: SAB OMS Position Side Code (Slot 142) must be 3.0 (BOTH), got ${omsSideCode}`);
    }
    console.log("✓ Test 3 Passed: SAB memory state correctly populated with 0.0 Net Qty (Slot 105), 0.032 Long Qty (Slot 143), 0.032 Short Qty (Slot 144), and 3.0 (BOTH) side code.");
    // 5. Verify Active Trades array contains 2 distinct active slots (1 LONG, 1 SHORT)
    const activeTradeSlots = strategyEngine.getActiveTrades(1874.45);
    console.log(`Active Trade Slots count: ${activeTradeSlots.length}`);
    if (activeTradeSlots.length !== 2) {
        throw new Error(`FAIL: Expected 2 active trade slots (1 LONG, 1 SHORT), got ${activeTradeSlots.length}`);
    }
    console.log(`Slot 1: ${activeTradeSlots[0].side} ${activeTradeSlots[0].size} @ $${activeTradeSlots[0].entryPrice}`);
    console.log(`Slot 2: ${activeTradeSlots[1].side} ${activeTradeSlots[1].size} @ $${activeTradeSlots[1].entryPrice}`);
    console.log("✓ Test 4 Passed: StrategyEngine returns 2 distinct active trade slots for execution & telemetry monitoring.");
    console.log("=========================================================================");
    console.log("✅ HEDGE MODE DUAL-DIRECTIONAL POSITION SYNC TEST PASSED PERFECTLY!");
    console.log("=========================================================================");
}
testHedgeModeSync().catch((err) => {
    console.error("❌ TEST FAILED:", err);
    process.exit(1);
});
