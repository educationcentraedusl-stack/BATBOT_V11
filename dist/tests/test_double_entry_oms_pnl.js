"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_1 = require("../strategy/engine");
const marketDataClient_1 = require("../marketDataClient");
const binance_1 = require("../execution/binance");
const risk_1 = require("../strategy/risk");
const positionLedger_1 = require("../strategy/positionLedger");
console.log("================================================================================");
console.log("BATBOT_V11 SOTA QA TEST SUITE: DOUBLE-ENTRY OMS STATE RECONCILIATION & PNL PROOF");
console.log("================================================================================");
let totalPassed = 0;
let totalFailed = 0;
function assert(condition, testName) {
    if (condition) {
        console.log(`[PASS] ${testName}`);
        totalPassed++;
    }
    else {
        console.error(`[FAIL] ${testName}`);
        totalFailed++;
    }
}
// Set up SharedArrayBuffer and MarketDataClient
const sabBuffer = new SharedArrayBuffer(1024 * 1024 * 8);
const marketDataClient = new marketDataClient_1.MarketDataClient(sabBuffer, 10);
// Initialize mock execution client
const mockExecutionClient = new binance_1.BinanceExecutionClient({
    apiKey: "mock_api_key",
    apiSecret: "mock_api_secret",
});
const config = {
    symbol: "XRPUSDT",
    orderQuantity: 1000,
    tradeSizeUsdt: 2500,
    obiBuyThreshold: 0.15,
    obiSellThreshold: -0.15,
    cvdBuyThreshold: 0.10,
    cvdSellThreshold: -0.10,
    maxSpreadVelocity: 5.0,
    minAiConfidence: 0.65,
    aggressiveConfidenceThreshold: 0.85,
    tickSize: 0.0001,
    takeProfitPercent: 0.5,
    stopLossPercent: 0.5,
    longTakeProfitPercent: 0.5,
    longStopLossPercent: 0.5,
    shortTakeProfitPercent: 0.5,
    shortStopLossPercent: 0.5,
    dailyProfitLockUsdt: 100,
    maxShortSlots: 3,
    leverageMultiplier: 20,
    maxSpreadEth: 0.05,
    maxSpreadBtc: 0.05,
    maxSpreadAlt: 0.05,
    minNotionalUsdt: 5.0,
    cooldownMs: 5000,
    vpinThreshold: 0.8,
    assetIndex: 5,
};
const riskGuard = new risk_1.RiskGuard({
    maxPositionSizeUsdt: 5000,
    minCooldownMs: 100,
    maxDailyLossUsdt: 500,
    maxPriceSlippagePercent: 1.0,
    dailyProfitLockTargetUsdt: 200,
    minRiskRewardRatio: 2.0,
    minNetAlpha: 0.00045,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
});
const engine = new engine_1.StrategyEngine(marketDataClient, riskGuard, mockExecutionClient, config);
// Set live price for XRPUSDT (Slot 5) in SharedArrayBuffer
// Slot 4 = Best Bid ($2.5030), Slot 6 = Best Ask ($2.5032), Mid = $2.5031
marketDataClient.writeAtomicFloat64Asset(5, 4, 2.5030);
marketDataClient.writeAtomicFloat64Asset(5, 6, 2.5032);
// -----------------------------------------------------------------------------------------
// TEST 1: Long Position Entry & Zero Realized PnL Baseline
// -----------------------------------------------------------------------------------------
console.log("\n[TEST 1] Testing Long Position Entry & Zero Realized PnL Baseline...");
const ledger = engine.getHedgeLedger();
// Occupy 1,000 XRP @ $2.5000 entry price ($2,500 notional)
ledger.occupyCoreLong(1000, 2.5000, 0.5, 0.5);
engine.syncSabPositionState(2.5031);
assert(ledger.getCoreLong().isOccupied === true, "Core Long is occupied");
assert(marketDataClient.getOmsRealizedPnl(5) === 0, "Initial Realized PnL in SAB Slot 107 is exactly $0.00");
assert(marketDataClient.getOmsTotalTrades(5) === 0n, "Initial Total Trades in SAB Slot 111 is 0");
assert(marketDataClient.getOmsWinningTrades(5) === 0n, "Initial Winning Trades in SAB Slot 135 is 0");
assert(marketDataClient.getOmsLongPositionQty(5) === 1000, "SAB Slot 143 shows 1,000 LONG quantity");
// -----------------------------------------------------------------------------------------
// TEST 2: Exchange-Side Exit Reconciliation via handleWsAccountPositionUpdate (Anomaly 1 Replication)
// -----------------------------------------------------------------------------------------
console.log("\n[TEST 2] Replicating Anomaly 1: Exchange closes position and sends positionAmt: 0...");
// Simulate Binance executing TP/SL on exchange and sending WS position update with amount = 0
// Current price is $2.5031 -> Gross PnL = (2.5031 - 2.5000) * 1000 = $3.10
// Net PnL = $3.10 - total fees = +$0.849 (Winning Trade)
engine.handleWsAccountPositionUpdate({
    symbol: "XRPUSDT",
    positionAmt: 0,
    entryPrice: 0,
    accumulatedRealized: 0,
    unrealizedPnl: 0,
    positionSide: "LONG",
});
const pnlAfterWsExit = marketDataClient.getOmsRealizedPnl(5);
const tradesAfterWsExit = marketDataClient.getOmsTotalTrades(5);
const winsAfterWsExit = marketDataClient.getOmsWinningTrades(5);
const lossesAfterWsExit = marketDataClient.getOmsLosingTrades(5);
console.log(`  - Realized PnL in SAB (Slot 107): $${pnlAfterWsExit.toFixed(4)}`);
console.log(`  - Total Trades in SAB (Slot 111): ${tradesAfterWsExit}`);
console.log(`  - Winning Trades in SAB (Slot 135): ${winsAfterWsExit}`);
console.log(`  - Losing Trades in SAB (Slot 136): ${lossesAfterWsExit}`);
assert(ledger.getCoreLong().isOccupied === false, "Core Long slot is cleanly released");
assert(pnlAfterWsExit > 0, `Realized PnL is positive ($${pnlAfterWsExit.toFixed(4)}) and NOT $0.00 (Ghost PnL Eradicated)`);
assert(tradesAfterWsExit === 1n, "Total Trades in SAB properly incremented to 1");
assert(winsAfterWsExit === 1n, "Winning Trades in SAB properly incremented to 1");
// -----------------------------------------------------------------------------------------
// TEST 3: Short Position Exit Reconciliation via syncExchangeStateWithData (5-Second Polling)
// -----------------------------------------------------------------------------------------
console.log("\n[TEST 3] Testing Short Position Exit via periodic syncExchangeStateWithData...");
// Enter Short position: 1,000 XRP @ $2.5050
ledger.occupyShortSlot(0, 1000, 2.5050, 0.5, 0.5);
marketDataClient.writeAtomicFloat64Asset(5, 4, 2.5010);
marketDataClient.writeAtomicFloat64Asset(5, 6, 2.5012); // Mid = $2.5011 ($3.90 gross profit)
engine.syncSabPositionState(2.5011);
assert(ledger.getShortSlots()[0].isOccupied === true, "Short Slot #0 is occupied");
// Simulate 5000ms periodic reconciliation finding activePositions is empty (position closed on Binance)
engine.syncExchangeStateWithData([], []);
const pnlAfterSyncExit = marketDataClient.getOmsRealizedPnl(5);
const tradesAfterSyncExit = marketDataClient.getOmsTotalTrades(5);
const winsAfterSyncExit = marketDataClient.getOmsWinningTrades(5);
console.log(`  - Cumulative Realized PnL in SAB: $${pnlAfterSyncExit.toFixed(4)}`);
console.log(`  - Cumulative Total Trades: ${tradesAfterSyncExit}`);
console.log(`  - Cumulative Winning Trades: ${winsAfterSyncExit}`);
assert(ledger.getShortSlots()[0].isOccupied === false, "Short Slot #0 cleanly released");
assert(pnlAfterSyncExit > pnlAfterWsExit, `Cumulative Realized PnL increased from $${pnlAfterWsExit.toFixed(4)} to $${pnlAfterSyncExit.toFixed(4)}`);
assert(tradesAfterSyncExit === 2n, "Total Trades in SAB properly incremented to 2");
assert(winsAfterSyncExit === 2n, "Winning Trades in SAB properly incremented to 2");
// -----------------------------------------------------------------------------------------
// TEST 4: Cold-Start clearSlots() Safety
// -----------------------------------------------------------------------------------------
console.log("\n[TEST 4] Testing clearSlots() does not record ghost trades on startup recovery...");
const freshLedger = new positionLedger_1.HedgePositionLedger("DOTUSDT");
freshLedger.syncStartupPositions([], 0.5, 0.5, 0.5, 0.5, 20);
assert(freshLedger.getSummary().totalTrades === 0, "Cold-start syncStartupPositions on empty account leaves totalTrades at 0");
assert(freshLedger.getSummary().cumulativeRealizedPnl === 0, "Cold-start syncStartupPositions leaves realizedPnl at $0.00");
// -----------------------------------------------------------------------------------------
// FINAL SUMMARY
// -----------------------------------------------------------------------------------------
console.log("\n================================================================================");
console.log(`TEST SUITE COMPLETE: ${totalPassed} PASSED, ${totalFailed} FAILED`);
console.log("================================================================================");
if (totalFailed > 0) {
    process.exit(1);
}
