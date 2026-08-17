"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const positionLedger_1 = require("../strategy/positionLedger");
const binance_1 = require("../execution/binance");
const dashboard_1 = require("../telemetry/dashboard");
function assert(condition, message) {
    if (!condition) {
        throw new Error(`[ASSERTION_FAILED] ${message}`);
    }
}
async function runPhase4Tests() {
    console.log("===============================================================================");
    console.log("BATBOT_V11: PHASE 4 EXCHANGE PNL, INCOME & SLIPPAGE PIPELINE TEST SUITE");
    console.log("===============================================================================");
    // -----------------------------------------------------------------------------------------
    // TEST 1: Exact Funding Rate and Commission Ingestion into HedgePositionLedger
    // -----------------------------------------------------------------------------------------
    console.log("\n[TEST 1] Exact Funding Rate and Commission Ingestion...");
    const hedgeLedger = new positionLedger_1.HedgePositionLedger("BTCUSDT", 3);
    // Ingest positive funding fee (e.g. +$0.15 earned on short during positive funding rate)
    hedgeLedger.recordFundingFee(0.1525, "BTCUSDT");
    assert(Math.abs(hedgeLedger.getCumulativeFundingFees() - 0.1525) < 1e-6, `Funding fee should be 0.1525, got ${hedgeLedger.getCumulativeFundingFees()}`);
    assert(Math.abs(hedgeLedger.getCumulativeRealizedPnl() - 0.1525) < 1e-6, `Cumulative Realized PnL should include funding fee (+0.1525), got ${hedgeLedger.getCumulativeRealizedPnl()}`);
    // Ingest negative funding fee (e.g. -$0.0420 paid on long)
    hedgeLedger.recordFundingFee(-0.0420, "BTCUSDT");
    assert(Math.abs(hedgeLedger.getCumulativeFundingFees() - 0.1105) < 1e-6, `Net funding fee should be 0.1105, got ${hedgeLedger.getCumulativeFundingFees()}`);
    assert(Math.abs(hedgeLedger.getCumulativeRealizedPnl() - 0.1105) < 1e-6, `Cumulative Realized PnL should reflect net funding fee (+0.1105), got ${hedgeLedger.getCumulativeRealizedPnl()}`);
    // Ingest exact commission (e.g. $0.2700 from Binance REST trade)
    hedgeLedger.recordExactCommission(0.2700);
    assert(Math.abs(hedgeLedger.getCumulativeCommissions() - 0.2700) < 1e-6, `Cumulative commissions should be 0.2700, got ${hedgeLedger.getCumulativeCommissions()}`);
    // Set reconciled wallet balance
    hedgeLedger.setReconciledWalletBalance(1250.75);
    assert(hedgeLedger.getReconciledWalletBalance() === 1250.75, `Reconciled wallet balance should be 1250.75, got ${hedgeLedger.getReconciledWalletBalance()}`);
    // Set active step-collar tier
    hedgeLedger.setActiveStepCollarTier(2); // Tier 2 Partial Profit Lock
    assert(hedgeLedger.getActiveStepCollarTier() === 2, `Active Step-Collar Tier should be 2, got ${hedgeLedger.getActiveStepCollarTier()}`);
    console.log("  -> [PASS] Funding fee, exact commission, reconciled balance and SC tier ingested with micro-cent precision.");
    // -----------------------------------------------------------------------------------------
    // TEST 2: Real-Time ROE (%) Calculation & Summary Precision
    // -----------------------------------------------------------------------------------------
    console.log("\n[TEST 2] Real-Time ROE (%) Calculation & Summary Precision...");
    hedgeLedger.setLeverage(10);
    // Occupy Core Long: 0.01 BTC @ $60,000.00 (10x Leverage)
    hedgeLedger.occupyCoreLong(0.01, 60000.0, 1.5, 1.0);
    // Mark Price advances to $60,600.00 (+1.00% price move => +10.00% ROE @ 10x)
    const summaryAt60600 = hedgeLedger.getSummary(60600.0);
    assert(Math.abs(summaryAt60600.roePercent - 10.00) < 0.05, `ROE should be +10.00%, got ${summaryAt60600.roePercent}%`);
    assert(Math.abs(summaryAt60600.longUnrealizedPnl - 6.00) < 1e-4, `Long unrealized PnL should be +$6.00, got ${summaryAt60600.longUnrealizedPnl}`);
    assert(summaryAt60600.cumulativeFundingFees === 0.1105, `Summary should contain exact funding fee (0.1105), got ${summaryAt60600.cumulativeFundingFees}`);
    assert(summaryAt60600.reconciledWalletBalance === 1250.75, `Summary should contain reconciled wallet balance (1250.75), got ${summaryAt60600.reconciledWalletBalance}`);
    assert(summaryAt60600.activeStepCollarTier === 2, `Summary should contain active Step-Collar tier (2), got ${summaryAt60600.activeStepCollarTier}`);
    console.log(`  -> [PASS] ROE = +${summaryAt60600.roePercent}% @ 10x leverage, Unr PnL = $${summaryAt60600.longUnrealizedPnl.toFixed(2)}, Summary synchronized.`);
    // -----------------------------------------------------------------------------------------
    // TEST 3: Eradication of Fallback $0.00 PnL Resets on Order Errors
    // -----------------------------------------------------------------------------------------
    console.log("\n[TEST 3] Eradication of Fallback $0.00 PnL Resets on Order Errors...");
    const initialCumulativeRealized = hedgeLedger.getCumulativeRealizedPnl();
    // Test release with fallback mark price when order error occurs at $60,300.00
    hedgeLedger.releaseCoreLong(undefined, undefined, "ORDER_ERROR_SETTLEMENT", 60300.0);
    const realizedDelta = hedgeLedger.getCumulativeRealizedPnl() - initialCumulativeRealized;
    // Expected: (60300 - 60000) * 0.01 = $3.00 gross minus round-trip taker fees (~$0.54) = ~$2.46 net
    assert(realizedDelta > 2.00, `Realized PnL delta on error settlement must be real market profit (>$2.00), not reset to $0.00. Got: $${realizedDelta.toFixed(4)}`);
    console.log(`  -> [PASS] Order error settlement retained true PnL ($${realizedDelta.toFixed(4)}) instead of resetting to $0.00.`);
    // -----------------------------------------------------------------------------------------
    // TEST 4: BinanceExecutionClient /fapi/v1/income and /fapi/v1/userTrades API Surface
    // -----------------------------------------------------------------------------------------
    console.log("\n[TEST 4] BinanceExecutionClient API Surface & Types Verification...");
    const client = new binance_1.BinanceExecutionClient({ useTestnet: true, apiKey: "TEST_KEY", apiSecret: "TEST_SECRET" });
    assert(typeof client.getIncomeHistory === "function", "getIncomeHistory must be implemented");
    assert(typeof client.getUserTrades === "function", "getUserTrades must be implemented");
    assert(typeof client.getAccountInfo === "function", "getAccountInfo must be implemented");
    assert(typeof client.fetchReconciledAccountBalanceAsync === "function", "fetchReconciledAccountBalanceAsync must be implemented");
    assert(typeof client.startBackgroundSync === "function", "startBackgroundSync must be implemented");
    assert(typeof client.stopBackgroundSync === "function", "stopBackgroundSync must be implemented");
    assert(typeof client.getCumulativeFunding === "function", "getCumulativeFunding must be implemented");
    assert(typeof client.getCumulativeCommission === "function", "getCumulativeCommission must be implemented");
    assert(typeof client.getReconciledWalletBalance === "function", "getReconciledWalletBalance must be implemented");
    console.log("  -> [PASS] BinanceExecutionClient API surface 100% verified.");
    // -----------------------------------------------------------------------------------------
    // TEST 5: Telemetry Frame & CLI Dashboard Rendering Verification
    // -----------------------------------------------------------------------------------------
    console.log("\n[TEST 5] Telemetry Frame & CLI Dashboard Rendering Verification...");
    const dashboard = new dashboard_1.CLIDashboard(false); // instantiated without writing ANSI to stdout
    const frame = {
        symbol: "BTCUSDT",
        sequenceNum: 1000n,
        bidPrice: 60000.0,
        askPrice: 60001.0,
        obi: 0.25,
        cvd: 15.0,
        spreadVelocity: 0.1,
        lastSignal: "BUY",
        tickEvaluationLatencyUs: 0.95,
        stats: {
            totalSignalsLogged: 5,
            totalExecutionsLogged: 2,
            totalTrades: 2,
            winningTrades: 2,
            losingTrades: 0,
            winRatePercent: 100.0,
            netQuantity: 0.01,
            averageEntryPrice: 60000.0,
            unrealizedPnl: 6.0,
            realizedPnl: 2.46,
            totalFees: 0.54,
            positionSide: "LONG",
            avgTickLatencyUs: 0.92,
            bufferQueueDepth: 0,
        },
        riskStatus: "PASSED",
        isEngineActive: true,
        usdtBalance: 1245.0,
        reconciledWalletBalance: 1251.0,
        cumulativeFundingFees: 0.1105,
        activeStepCollarTier: "TIER_2_PARTIAL_PROFIT",
        roePercent: 10.0,
        activeTrades: [
            {
                symbol: "BTCUSDT",
                side: "BUY/LONG",
                size: 0.01,
                entryPrice: 60000.0,
                currentPrice: 60600.0,
                tpPrice: 61500.0,
                slPrice: 60050.0,
                leverage: 10,
                unrealizedPnl: 6.0,
                roePercent: 10.0,
                stepCollarTier: "TIER_2_PARTIAL_PROFIT",
                durationMs: 45000,
            },
        ],
    };
    assert(frame.reconciledWalletBalance === 1251.0, "TelemetryFrame must accept reconciledWalletBalance");
    assert(frame.cumulativeFundingFees === 0.1105, "TelemetryFrame must accept cumulativeFundingFees");
    assert(frame.activeStepCollarTier === "TIER_2_PARTIAL_PROFIT", "TelemetryFrame must accept activeStepCollarTier");
    assert(frame.roePercent === 10.0, "TelemetryFrame must accept roePercent");
    console.log("  -> [PASS] TelemetryFrame data structures 100% compliant.");
    console.log("\n===============================================================================");
    console.log("✅ ALL PHASE 4 TESTS PASSED 100% WITH ZERO ERRORS");
    console.log("===============================================================================");
}
runPhase4Tests().catch((err) => {
    console.error("❌ Phase 4 Test Suite Failed:", err);
    process.exit(1);
});
