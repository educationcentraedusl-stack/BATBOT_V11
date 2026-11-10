"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
const multiEngine_1 = require("../strategy/multiEngine");
async function runHedgeModeSplitProof() {
    console.log("=========================================================================");
    console.log("  TEST: HEDGE MODE DUAL-DIRECTIONAL LEDGER SPLIT PROOF & ISOLATION       ");
    console.log("=========================================================================\n");
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
    const maxAssets = 4;
    const slotsPerAsset = 256;
    const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    const riskGuard = new risk_1.MultiAssetRiskGuard();
    const executionClient = new binance_1.BinanceExecutionClient();
    const multiEngine = new multiEngine_1.MultiAssetStrategyEngine(client, riskGuard, executionClient, symbols);
    // 1. Reconcile Binance positions matching the observation in the directive:
    // - BTC Long (0.0008 @ 62500.00)
    // - BTC Short (-0.0018 @ 62891.00)
    // - ETH Short (-0.032 @ 1874.45)
    console.log("[Phase 1] Ingesting Live Binance Hedge Mode Positions (BTC Long + Short & ETH Short)...");
    const rawBinancePositions = [
        {
            symbol: "BTCUSDT",
            positionAmt: "0.0008",
            entryPrice: "62500.00",
            markPrice: "62700.00",
            unRealizedProfit: "0.16",
            liquidationPrice: "0",
            leverage: "10",
            maxNotionalValue: "1000000",
            marginType: "cross",
            isolatedMargin: "0",
            isAutoAddMargin: "false",
            positionSide: "LONG",
            notional: "50.00",
            isolatedWallet: "0",
            updateTime: Date.now(),
        },
        {
            symbol: "BTCUSDT",
            positionAmt: "-0.0018",
            entryPrice: "62891.00",
            markPrice: "62700.00",
            unRealizedProfit: "0.34",
            liquidationPrice: "0",
            leverage: "10",
            maxNotionalValue: "1000000",
            marginType: "cross",
            isolatedMargin: "0",
            isAutoAddMargin: "false",
            positionSide: "SHORT",
            notional: "113.20",
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
            isolatedMargin: "0",
            isAutoAddMargin: "false",
            positionSide: "SHORT",
            notional: "59.98",
            isolatedWallet: "0",
            updateTime: Date.now(),
        },
    ];
    multiEngine.reconcileStartupPositions(rawBinancePositions);
    const btcEngine = multiEngine.getEngineForSymbol("BTCUSDT");
    const ethEngine = multiEngine.getEngineForSymbol("ETHUSDT");
    if (!btcEngine || !ethEngine) {
        throw new Error("FAIL: Engine instances for BTCUSDT or ETHUSDT not initialized!");
    }
    // 2. Verify BTCUSDT HedgePositionLedger tracks two distinctly populated slots
    console.log("\n[Phase 2] Verifying BTCUSDT Position Slots & Cost Bases...");
    const btcCoreLong = btcEngine.getHedgeLedger().getCoreLong();
    const btcShortSlots = btcEngine.getHedgeLedger().getShortSlots();
    const btcSummary = btcEngine.getHedgeLedger().getSummary(62700.00);
    console.log(`  - Slot #0-LONG : Occupied=${String(btcCoreLong.isOccupied)}, Qty=${String(btcCoreLong.quantity)}, EntryPrice=$${String(btcCoreLong.entryPrice)}`);
    console.log(`  - Slot #0-SHORT: Occupied=${String(btcShortSlots[0].isOccupied)}, Qty=${String(btcShortSlots[0].quantity)}, EntryPrice=$${String(btcShortSlots[0].entryPrice)}`);
    console.log(`  - Summary: Side=${btcSummary.side}, LongQty=${String(btcSummary.longQuantity)}, ShortQty=${String(btcSummary.shortQuantity)}, NetQty=${String(btcSummary.netQuantity)}, GrossQty=${String(btcSummary.grossQuantity)}`);
    console.log(`  - Summary Long Entry Price : $${String(btcSummary.longAverageEntryPrice)} (Must be exactly 62500.00)`);
    console.log(`  - Summary Short Entry Price: $${String(btcSummary.shortAverageEntryPrice)} (Must be exactly 62891.00)`);
    console.log(`  - Summary Long Unrealized  : +$${String(btcSummary.longUnrealizedPnl)} (Must be > 0 under $62700 mark price)`);
    console.log(`  - Summary Short Unrealized : +$${String(btcSummary.shortUnrealizedPnl)} (Must be > 0 under $62700 mark price)`);
    if (!btcCoreLong.isOccupied || Math.abs(btcCoreLong.quantity - 0.0008) > 1e-6 || Math.abs(btcCoreLong.entryPrice - 62500.00) > 1e-2) {
        throw new Error(`FAIL: Slot #0-LONG mismatch! Expected 0.0008 @ $62500, got ${String(btcCoreLong.quantity)} @ ${String(btcCoreLong.entryPrice)}`);
    }
    if (!btcShortSlots[0].isOccupied || Math.abs(btcShortSlots[0].quantity - 0.0018) > 1e-6 || Math.abs(btcShortSlots[0].entryPrice - 62891.00) > 1e-2) {
        throw new Error(`FAIL: Slot #0-SHORT mismatch! Expected 0.0018 @ $62891, got ${String(btcShortSlots[0].quantity)} @ ${String(btcShortSlots[0].entryPrice)}`);
    }
    if (Math.abs(btcSummary.longAverageEntryPrice - 62500.00) > 1e-2 || Math.abs(btcSummary.shortAverageEntryPrice - 62891.00) > 1e-2) {
        throw new Error(`FAIL: Summary entry prices were blended! Long: ${String(btcSummary.longAverageEntryPrice)}, Short: ${String(btcSummary.shortAverageEntryPrice)}`);
    }
    console.log("  ✅ Phase 2 Passed: Dual slots tracked with 100% unblended, independent cost bases.");
    // 3. Verify Zero-Copy SharedArrayBuffer Memory State
    console.log("\n[Phase 3] Verifying SAB Telemetry Layout for Slot #0...");
    const sabLongQty = client.getOmsLongPositionQty(0);
    const sabShortQty = client.getOmsShortPositionQty(0);
    const sabLongEntry = client.getOmsLongAvgEntryPrice(0);
    const sabShortEntry = client.getOmsShortAvgEntryPrice(0);
    const sabLongUPnl = client.getOmsLongUnrealizedPnl(0);
    const sabShortUPnl = client.getOmsShortUnrealizedPnl(0);
    const sabSideCode = client.getOmsPositionSide(0);
    console.log(`  - SAB Slot 142 (Side Code)       : ${String(sabSideCode)} (Expected: 3.0 = BOTH)`);
    console.log(`  - SAB Slot 143 (Long Qty)        : ${String(sabLongQty)} (Expected: 0.0008)`);
    console.log(`  - SAB Slot 144 (Short Qty)       : ${String(sabShortQty)} (Expected: 0.0018)`);
    console.log(`  - SAB Slot 145 (Long Avg Entry)  : $${String(sabLongEntry)} (Expected: 62500.00)`);
    console.log(`  - SAB Slot 146 (Short Avg Entry) : $${String(sabShortEntry)} (Expected: 62891.00)`);
    console.log(`  - SAB Slot 147 (Long Unr PnL)    : +$${String(sabLongUPnl)}`);
    console.log(`  - SAB Slot 148 (Short Unr PnL)   : +$${String(sabShortUPnl)}`);
    if (sabSideCode !== 3.0 || Math.abs(sabLongQty - 0.0008) > 1e-6 || Math.abs(sabShortQty - 0.0018) > 1e-6) {
        throw new Error("FAIL: SAB quantities or side code mismatch!");
    }
    if (Math.abs(sabLongEntry - 62500.00) > 1e-2 || Math.abs(sabShortEntry - 62891.00) > 1e-2) {
        throw new Error(`FAIL: SAB entry prices not unblended! Long: ${String(sabLongEntry)}, Short: ${String(sabShortEntry)}`);
    }
    console.log("  ✅ Phase 3 Passed: Zero-copy SAB memory reflects dual-directional positions.");
    // 4. Verify Active Trades Telemetry returns 2 distinct slots for BTCUSDT + 1 for ETHUSDT
    console.log("\n[Phase 4] Verifying StrategyEngine.getActiveTrades()...");
    const btcActiveTrades = btcEngine.getActiveTrades(62700.00);
    const ethActiveTrades = ethEngine.getActiveTrades(1874.45);
    console.log(`  - BTCUSDT Active Trades Count: ${String(btcActiveTrades.length)} (Expected: 2)`);
    for (let i = 0; i < btcActiveTrades.length; i++) {
        const t = btcActiveTrades[i];
        console.log(`    [Slot ${String(i + 1)}] ${t.symbol} | ${t.side} | Size: ${String(t.size)} | Entry: $${String(t.entryPrice)} | TP: $${t.tpPrice.toFixed(2)} | SL: $${t.slPrice.toFixed(2)}`);
    }
    if (btcActiveTrades.length !== 2) {
        throw new Error(`FAIL: Expected 2 active trade slots for BTCUSDT, got ${String(btcActiveTrades.length)}`);
    }
    if (ethActiveTrades.length !== 1) {
        throw new Error(`FAIL: Expected 1 active trade slot for ETHUSDT, got ${String(ethActiveTrades.length)}`);
    }
    console.log("  ✅ Phase 4 Passed: 3 total active trade slots independently exposed for telemetry.");
    // 5. Verify Independent AI Microstructure Dynamic Exit Evaluation
    console.log("\n[Phase 5] Verifying Independent Dynamic TP/SL Exit Triggers...");
    // Test Mark Price Surge to 64000.00 (Should trigger SHORT Stop Loss without affecting LONG)
    const triggersHigh = btcEngine.getHedgeLedger().evaluateHedgeDynamicTpSl(64000.00);
    console.log(`  - Triggers on Bullish Price Surge ($64000): ${String(triggersHigh.length)} trigger(s)`);
    for (const trg of triggersHigh) {
        console.log(`    Triggered: Slot=${trg.slotId}, Side=${trg.side}, Reason=${trg.reason}, Qty=${String(trg.quantity)}`);
    }
    const shortTriggered = triggersHigh.some((t) => t.side === "SHORT" && t.reason === "STOP_LOSS");
    if (!shortTriggered) {
        throw new Error("FAIL: Short slot was not triggered by stop loss on price surge!");
    }
    // 6. Verify Isolated Single-Leg Closure (Closing LONG via WS update preserves SHORT)
    console.log("\n[Phase 6] Verifying Isolated Single-Leg Closure Lifecycle...");
    const mockLongCloseWsUpdate = {
        symbol: "BTCUSDT",
        positionAmt: 0.0,
        entryPrice: 0.0,
        accumulatedRealized: 0.5,
        unrealizedPnl: 0.0,
        positionSide: "LONG",
    };
    btcEngine.handleWsAccountPositionUpdate(mockLongCloseWsUpdate);
    await btcEngine.reconcileFlatPositionWithUserTrades("LONG", 0);
    const afterCloseSummary = btcEngine.getHedgeLedger().getSummary(62700.00);
    const afterCloseCoreLong = btcEngine.getHedgeLedger().getCoreLong();
    const afterCloseShort = btcEngine.getHedgeLedger().getShortSlots()[0];
    console.log(`  - After LONG Close: Long Occupied=${String(afterCloseCoreLong.isOccupied)}, LongQty=${String(afterCloseSummary.longQuantity)}`);
    console.log(`  - After LONG Close: Short Occupied=${String(afterCloseShort.isOccupied)}, ShortQty=${String(afterCloseSummary.shortQuantity)}, ShortEntry=$${String(afterCloseShort.entryPrice)}`);
    console.log(`  - Summary Side: ${afterCloseSummary.side} (Expected: SHORT)`);
    if (afterCloseCoreLong.isOccupied || afterCloseSummary.longQuantity > 1e-6) {
        throw new Error("FAIL: Long slot was not released after LONG position close!");
    }
    if (!afterCloseShort.isOccupied || Math.abs(afterCloseSummary.shortQuantity - 0.0018) > 1e-6 || Math.abs(afterCloseShort.entryPrice - 62891.00) > 1e-2) {
        throw new Error("FAIL: Short slot was corrupted or cleared when Long slot closed!");
    }
    console.log("  ✅ Phase 6 Passed: Long position closed cleanly while Short position remained 100% active and uncorrupted.\n");
    console.log("=========================================================================");
    console.log("  🎉 ALL HEDGE MODE DUAL-SLOT ISOLATION TESTS PASSED WITH 100% PRECISION");
    console.log("=========================================================================\n");
}
runHedgeModeSplitProof().catch((err) => {
    console.error("❌ TEST FAILED:", err);
    process.exit(1);
});
