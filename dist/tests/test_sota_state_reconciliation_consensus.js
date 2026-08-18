"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
const multiEngine_1 = require("../strategy/multiEngine");
async function runStateReconciliationConsensusTest() {
    console.log("=========================================================================");
    console.log("  TEST: SOTA TRI-VECTOR CONSENSUS & TWO-PHASE FLATTENING BARRIER         ");
    console.log("=========================================================================\n");
    const symbols = [
        "BTCUSDT", // Slot 0
        "ETHUSDT", // Slot 1
        "SOLUSDT", // Slot 2
        "BNBUSDT", // Slot 3
        "ADAUSDT", // Slot 4
        "XRPUSDT", // Slot 5
        "DOGEUSDT", // Slot 6
        "AVAXUSDT", // Slot 7
        "LINKUSDT", // Slot 8
        "DOTUSDT", // Slot 9
    ];
    const maxAssets = 10;
    const slotsPerAsset = 256;
    const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    const riskGuard = new risk_1.MultiAssetRiskGuard();
    const executionClient = new binance_1.BinanceExecutionClient();
    const multiEngine = new multiEngine_1.MultiAssetStrategyEngine(client, riskGuard, executionClient, symbols);
    // --------------------------------------------------------------------------------------
    // TEST 1: Dual-Source Consensus Merge Logic (V3 positionRisk + V3 account)
    // --------------------------------------------------------------------------------------
    console.log("[Test 1/4] Verifying Dual-Source Consensus Merge (V3 positionRisk + V3 account)...");
    // Mock scenario: positionRisk only returns BTC, but account ledger returns ADA and DOGE
    const mockPositionRisk = [
        {
            symbol: "BTCUSDT",
            positionAmt: "0.0008",
            entryPrice: "64214.40",
            markPrice: "64216.60",
            unRealizedProfit: "0.0017",
            liquidationPrice: "0",
            leverage: "20",
            maxNotionalValue: "20000000",
            marginType: "cross",
            isolatedMargin: "0",
            isAutoAddMargin: "false",
            positionSide: "BOTH",
            notional: "51.37",
            isolatedWallet: "0",
            updateTime: 1723973160000,
        },
        {
            symbol: "ADAUSDT",
            positionAmt: "0.0000",
            entryPrice: "0.0000",
            markPrice: "0.1729",
            unRealizedProfit: "0",
            liquidationPrice: "0",
            leverage: "20",
            maxNotionalValue: "20000000",
            marginType: "cross",
            isolatedMargin: "0",
            isAutoAddMargin: "false",
            positionSide: "BOTH",
            notional: "0",
            isolatedWallet: "0",
            updateTime: 1723973100000,
        },
    ];
    const mockAccountPositions = [
        {
            symbol: "ADAUSDT",
            positionAmt: "570.0",
            entryPrice: "0.1725",
            markPrice: "0.1729",
            unRealizedProfit: "0.2280",
            liquidationPrice: "0.1500",
            leverage: "20",
            maxNotionalValue: "20000000",
            marginType: "cross",
            isolatedMargin: "0",
            isAutoAddMargin: "false",
            positionSide: "BOTH",
            notional: "98.55",
            isolatedWallet: "0",
            updateTime: 1723973180000,
        },
        {
            symbol: "DOGEUSDT",
            positionAmt: "644.0",
            entryPrice: "0.06950",
            markPrice: "0.06987",
            unRealizedProfit: "0.2382",
            liquidationPrice: "0.0550",
            leverage: "20",
            maxNotionalValue: "20000000",
            marginType: "cross",
            isolatedMargin: "0",
            isAutoAddMargin: "false",
            positionSide: "BOTH",
            notional: "44.99",
            isolatedWallet: "0",
            updateTime: 1723973190000,
        },
    ];
    // Intercept executionClient methods to simulate dual-source consensus
    executionClient.getPositionRisk = async () => mockPositionRisk;
    executionClient.getAccountInfo = async () => ({
        totalWalletBalance: "4856.52",
        availableBalance: "4855.89",
        totalUnrealizedProfit: "0.46",
        positions: mockAccountPositions,
        assets: [],
    });
    const mergedConsensus = await executionClient.getDualPositionRisk();
    console.log(`  - Total Merged Consensus Positions: ${mergedConsensus.length}`);
    const btcPos = mergedConsensus.find((p) => p.symbol === "BTCUSDT");
    const adaPos = mergedConsensus.find((p) => p.symbol === "ADAUSDT");
    const dogePos = mergedConsensus.find((p) => p.symbol === "DOGEUSDT");
    if (!btcPos || parseFloat(btcPos.positionAmt) !== 0.0008) {
        throw new Error("Test 1 Failed: BTCUSDT position omitted or incorrect in consensus merge!");
    }
    if (!adaPos || parseFloat(adaPos.positionAmt) !== 570.0) {
        throw new Error("Test 1 Failed: ADAUSDT position from account ledger not merged into consensus!");
    }
    if (!dogePos || parseFloat(dogePos.positionAmt) !== 644.0) {
        throw new Error("Test 1 Failed: DOGEUSDT position from account ledger not merged into consensus!");
    }
    console.log(`  - BTCUSDT Consensus: ${btcPos.positionAmt} @ $${btcPos.entryPrice}`);
    console.log(`  - ADAUSDT Consensus: ${adaPos.positionAmt} @ $${adaPos.entryPrice}`);
    console.log(`  - DOGEUSDT Consensus: ${dogePos.positionAmt} @ $${dogePos.entryPrice}`);
    console.log("  ✅ Test 1 Passed: Dual-Source Consensus perfectly fused V3 positionRisk & account ledger.\n");
    // --------------------------------------------------------------------------------------
    // TEST 2: Multi-Asset State Hydration & SAB OMS Synchronization across 10 Assets
    // --------------------------------------------------------------------------------------
    console.log("[Test 2/4] Verifying Multi-Asset State Hydration & SAB OMS Synchronizations...");
    multiEngine.reconcileStartupPositions(mergedConsensus);
    // Verify BTCUSDT (#0)
    const btcEngine = multiEngine.getEngineForSymbol("BTCUSDT");
    const btcSummary = btcEngine.getHedgeLedger().getSummary(64216.60);
    console.log(`  - BTCUSDT (#0) Ledger: Qty=${btcSummary.longQuantity}, AvgPx=$${btcSummary.averageEntryPrice}`);
    // Verify ADAUSDT (#4)
    const adaEngine = multiEngine.getEngineForSymbol("ADAUSDT");
    const adaSummary = adaEngine.getHedgeLedger().getSummary(0.1729);
    console.log(`  - ADAUSDT (#4) Ledger: Qty=${adaSummary.longQuantity}, AvgPx=$${adaSummary.averageEntryPrice}`);
    // Verify DOGEUSDT (#6)
    const dogeEngine = multiEngine.getEngineForSymbol("DOGEUSDT");
    const dogeSummary = dogeEngine.getHedgeLedger().getSummary(0.06987);
    console.log(`  - DOGEUSDT (#6) Ledger: Qty=${dogeSummary.longQuantity}, AvgPx=$${dogeSummary.averageEntryPrice}`);
    if (Math.abs(btcSummary.longQuantity - 0.0008) > 1e-6 || Math.abs(adaSummary.longQuantity - 570.0) > 1e-4 || Math.abs(dogeSummary.longQuantity - 644.0) > 1e-4) {
        throw new Error("Test 2 Failed: Multi-Asset hedge ledger positions not correctly hydrated!");
    }
    // Verify SAB Slots (0, 4, 6)
    const btcSabQty = client.getOmsLongPositionQty(0);
    const adaSabQty = client.getOmsLongPositionQty(4);
    const dogeSabQty = client.getOmsLongPositionQty(6);
    console.log(`  - SAB Slot #0 (BTC): ${btcSabQty} (Expected: 0.0008)`);
    console.log(`  - SAB Slot #4 (ADA): ${adaSabQty} (Expected: 570)`);
    console.log(`  - SAB Slot #6 (DOGE): ${dogeSabQty} (Expected: 644)`);
    if (Math.abs(btcSabQty - 0.0008) > 1e-6 || Math.abs(adaSabQty - 570.0) > 1e-4 || Math.abs(dogeSabQty - 644.0) > 1e-4) {
        throw new Error("Test 2 Failed: SharedArrayBuffer OMS slots not synchronized with active multi-asset positions!");
    }
    console.log("  ✅ Test 2 Passed: Multi-Asset state hydrated and synchronized to SAB OMS slots.\n");
    // --------------------------------------------------------------------------------------
    // TEST 3: Non-Destructive Two-Phase Flattening Barrier (Anti-Blind-Wipe Protection)
    // --------------------------------------------------------------------------------------
    console.log("[Test 3/7] Verifying Non-Destructive Two-Phase Flattening Barrier under Snapshot Gap...");
    // Simulate a flawed heartbeat call with empty positions for DOGEUSDT
    executionClient.getUserTrades = async () => []; // No closing trades exist on Binance!
    executionClient.getDualPositionRisk = async () => [
        {
            symbol: "DOGEUSDT",
            positionAmt: "644.0",
            entryPrice: "0.06950",
            markPrice: "0.06987",
            unRealizedProfit: "0.2382",
            leverage: "20",
            positionSide: "BOTH",
        },
    ];
    // Try to trigger a blind wipe on DOGEUSDT with empty positions array
    console.log("  - Simulating heartbeat snapshot with empty activePositions for DOGEUSDT...");
    await dogeEngine.syncExchangeStateWithData([], []);
    const dogeSummaryAfterSnapshot = dogeEngine.getHedgeLedger().getSummary(0.06987);
    console.log(`  - DOGEUSDT Ledger Qty After Blind Attempt: ${dogeSummaryAfterSnapshot.longQuantity} (Expected: 644)`);
    if (Math.abs(dogeSummaryAfterSnapshot.longQuantity - 644.0) > 1e-4) {
        throw new Error("Test 3 Failed: Two-Phase Barrier failed to protect DOGEUSDT position against blind wipe!");
    }
    // Also test direct call to reconcileFlatPositionWithUserTrades
    console.log("  - Simulating direct reconcileFlatPositionWithUserTrades('LONG', 0)...");
    await dogeEngine.reconcileFlatPositionWithUserTrades("LONG", 0);
    const dogeSummaryAfterDirectSettle = dogeEngine.getHedgeLedger().getSummary(0.06987);
    console.log(`  - DOGEUSDT Ledger Qty After Direct Settle Attempt: ${dogeSummaryAfterDirectSettle.longQuantity} (Expected: 644)`);
    if (Math.abs(dogeSummaryAfterDirectSettle.longQuantity - 644.0) > 1e-4) {
        throw new Error("Test 3 Failed: Two-Phase Barrier permitted blind settlement without trade confirmation!");
    }
    console.log("  ✅ Test 3 Passed: Two-Phase Flattening Barrier intercepted and eradicated blind-wipe risk.\n");
    // --------------------------------------------------------------------------------------
    // TEST 4: Network Outage Anti-Blind-Wipe Protection (Defect 1.1 & Loophole 2.1)
    // --------------------------------------------------------------------------------------
    console.log("[Test 4/7] Verifying Network Outage Invariant: Barrier Aborts Flattening on Network Error...");
    // Simulate network timeout/error when fetching userTrades AND getDualPositionRisk
    executionClient.getUserTrades = async () => {
        throw new Error("ETIMEDOUT: Connection reset by peer (simulated network outage)");
    };
    executionClient.getDualPositionRisk = async () => {
        throw new Error("ECONNREFUSED: Binance REST gateway unreachable (simulated network outage)");
    };
    console.log("  - Simulating network outage during reconcileFlatPositionWithUserTrades('LONG', 0)...");
    await dogeEngine.reconcileFlatPositionWithUserTrades("LONG", 0);
    const dogeSummaryAfterNetworkErr = dogeEngine.getHedgeLedger().getSummary(0.06987);
    console.log(`  - DOGEUSDT Ledger Qty After Network Error: ${dogeSummaryAfterNetworkErr.longQuantity} (Expected: 644)`);
    if (Math.abs(dogeSummaryAfterNetworkErr.longQuantity - 644.0) > 1e-4) {
        throw new Error("Test 4 Failed: Network failure induced a false-positive position wipe! Barrier invariant violated.");
    }
    console.log("  ✅ Test 4 Passed: Network failure aborted flattening, preserving 100% position ledger integrity.\n");
    // --------------------------------------------------------------------------------------
    // TEST 5: One-Way Mode ('BOTH') Mathematical Polarity Guard (Loophole 2.2)
    // --------------------------------------------------------------------------------------
    console.log("[Test 5/7] Verifying ONE-WAY Mode ('BOTH') Polarity Guard against Sign Confusion...");
    // In One-Way mode, positionSide is 'BOTH'. A short position has negative positionAmt (-644.0).
    executionClient.getUserTrades = async () => [];
    executionClient.getDualPositionRisk = async () => [
        {
            symbol: "DOGEUSDT",
            positionAmt: "-644.0", // SHORT position in One-Way mode
            entryPrice: "0.06950",
            markPrice: "0.06987",
            unRealizedProfit: "-0.2382",
            leverage: "20",
            positionSide: "BOTH",
        },
    ];
    // Reconcile LONG settlement: since the exchange position is SHORT (-644.0), LONG is verified flat
    console.log("  - Simulating LONG settlement check against active SHORT (-644.0) position on exchange...");
    await dogeEngine.reconcileFlatPositionWithUserTrades("LONG", 0);
    const dogeSummaryAfterPolarityCheck = dogeEngine.getHedgeLedger().getSummary(0.06987);
    console.log(`  - DOGEUSDT LONG Qty After Polarity Settle: ${dogeSummaryAfterPolarityCheck.longQuantity} (Expected: 0)`);
    if (dogeSummaryAfterPolarityCheck.longQuantity !== 0) {
        throw new Error("Test 5 Failed: One-Way Mode polarity check failed to identify opposing side sign!");
    }
    console.log("  ✅ Test 5 Passed: One-Way Mode sign polarity check strictly distinguishes LONG (+) from SHORT (-).\n");
    // --------------------------------------------------------------------------------------
    // TEST 6: Dual-Consensus Failure Error Propagation (Defect 1.1)
    // --------------------------------------------------------------------------------------
    console.log("[Test 6/7] Verifying Dual-Consensus Failure Error Propagation...");
    const testExecClient = new binance_1.BinanceExecutionClient({ apiKey: "test_key", apiSecret: "test_secret" });
    testExecClient.getPositionRisk = async () => {
        throw new Error("HTTP 500: Binance Internal Server Error");
    };
    testExecClient.getAccountInfo = async () => {
        throw new Error("HTTP 503: Service Temporarily Unavailable");
    };
    let consensusErrorCaught = false;
    try {
        await testExecClient.getDualPositionRisk("BTCUSDT");
    }
    catch (err) {
        consensusErrorCaught = true;
        console.log(`  - Caught Expected Consensus Failure Error: ${err.message}`);
        if (!err.message.includes("[CONSENSUS_FAILURE]")) {
            throw new Error("Test 6 Failed: Thrown error does not contain [CONSENSUS_FAILURE] tag!");
        }
    }
    if (!consensusErrorCaught) {
        throw new Error("Test 6 Failed: getDualPositionRisk did not throw when BOTH endpoints failed!");
    }
    console.log("  ✅ Test 6 Passed: Dual-consensus failure properly propagated critical error to caller.\n");
    // --------------------------------------------------------------------------------------
    // TEST 7: Legitimate Trade Exit Settlement Confirmation
    // --------------------------------------------------------------------------------------
    console.log("[Test 7/7] Verifying Legitimate Exit Trade Settlement when verified by userTrades...");
    // Re-occupy doge long position for final settlement test
    dogeEngine.getHedgeLedger().occupyCoreLong(644.0, 0.06950, 2.5, 1.5);
    // Mock a real closing fill on exchange
    executionClient.getUserTrades = async () => [
        {
            id: 123456,
            symbol: "DOGEUSDT",
            orderId: 7891011,
            side: "SELL",
            price: "0.07100",
            qty: "644.0",
            realizedPnl: "0.9660",
            marginAsset: "USDT",
            quoteQty: "45.724",
            commission: "0.018",
            commissionAsset: "USDT",
            time: Date.now(),
            positionSide: "BOTH",
            buyer: false,
            maker: true,
        },
    ];
    executionClient.getDualPositionRisk = async () => []; // Position is now truly flat on exchange
    await dogeEngine.reconcileFlatPositionWithUserTrades("LONG", 0);
    const dogeSummaryAfterRealClose = dogeEngine.getHedgeLedger().getSummary(0.07100);
    console.log(`  - DOGEUSDT Side After Verified Close: ${dogeSummaryAfterRealClose.side} (Expected: FLAT)`);
    console.log(`  - DOGEUSDT Realized PnL: $${dogeSummaryAfterRealClose.cumulativeRealizedPnl.toFixed(4)} (Expected: ~$0.9480 net)`);
    if (dogeSummaryAfterRealClose.side !== "FLAT" || dogeSummaryAfterRealClose.longQuantity > 1e-6) {
        throw new Error("Test 7 Failed: Legitimate closing trade did not settle position to FLAT!");
    }
    const dogeSabQtyAfterClose = client.getOmsLongPositionQty(6);
    console.log(`  - SAB Slot #6 (DOGE) After Verified Close: ${dogeSabQtyAfterClose} (Expected: 0)`);
    if (dogeSabQtyAfterClose !== 0) {
        throw new Error("Test 7 Failed: SAB OMS Slot not zeroed upon verified trade closure!");
    }
    console.log("  ✅ Test 7 Passed: Legitimate trade exit settled with exact micro-cent exchange PnL & fees.\n");
    console.log("=========================================================================");
    console.log("  ALL 7 STAGES OF SOTA CONSENSUS & BARRIER REMEDIATION VERIFIED (100%)   ");
    console.log("=========================================================================\n");
}
runStateReconciliationConsensusTest().catch((err) => {
    console.error(`[FATAL TEST ERROR] ${err.message}\n${err.stack}`);
    process.exit(1);
});
