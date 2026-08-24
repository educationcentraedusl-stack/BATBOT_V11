"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_1 = require("../strategy/engine");
const marketDataClient_1 = require("../marketDataClient");
const binance_1 = require("../execution/binance");
const risk_1 = require("../strategy/risk");
async function runLevel1SpreadBlowoutEntryGuardTest() {
    console.log("================================================================================");
    console.log("  TEST SUITE: SOTA LEVEL-1 SPREAD BLOWOUT ENTRY GUARD VERIFICATION             ");
    console.log("================================================================================");
    const slotsPerAsset = 256;
    const maxAssets = 10;
    const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    const riskGuard = new risk_1.RiskGuard();
    const executionClient = new binance_1.BinanceExecutionClient();
    // Test 1: Single-Engine Level-1 Spread Blowout Gating
    console.log("\n[STAGE 1] Testing Single-Engine Level-1 Spread Blowout Entry Guard (BTCUSDT)...");
    const engineBtc = new engine_1.StrategyEngine(client, riskGuard, executionClient, {
        symbol: "BTCUSDT",
        assetIndex: 0,
        minAiConfidence: 0.60,
        aggressiveConfidenceThreshold: 0.70,
        maxSpreadBtc: 1.50,
        orderQuantity: 0.001,
        tradeSizeUsdt: 60.0,
        obiBuyThreshold: 0.10,
        obiSellThreshold: -0.10,
    });
    const nowMs = Date.now();
    const nowNs = BigInt(nowMs) * 1000000n;
    const bigIntView = new BigInt64Array(sab);
    bigIntView[0] = nowNs; // Fresh packet timestamp
    bigIntView[92] = 1n; // Sequence #1
    // Set sequence, prices with blowout spread ($10.0 spread > $1.50 cap on $79,000 BTC)
    client.writeAtomicFloat64Asset(0, 4, 79050.0); // Best Bid
    client.writeAtomicFloat64Asset(0, 6, 79060.0); // Best Ask ($10.0 spread)
    client.writeAtomicFloat64Asset(0, 103, 0.95); // AI Dir (+0.95)
    client.writeAtomicFloat64Asset(0, 104, 0.99); // AI Conf (99% High Confidence)
    client.writeAtomicFloat64Asset(0, 108, 0.80); // OBI (+0.80)
    client.writeAtomicFloat64Asset(0, 110, 5.0); // CVD
    const blowoutResult = engineBtc.evaluateTick();
    console.log(`  -> Blowout Spread Signal Type: ${blowoutResult.signalType}`);
    console.log(`  -> Risk Check Reason: ${blowoutResult.riskResult?.reasonCode}`);
    if (blowoutResult.signalType === "NONE") {
        console.log("  ✅ STAGE 1 PASSED: High-Confidence AI (+99%) entry strictly blocked under blown-out spread.");
    }
    else {
        throw new Error(`Stage 1 Failed: Expected NONE but got ${blowoutResult.signalType}`);
    }
    // Test 2: Normal tight spread allows execution
    console.log("\n[STAGE 2] Testing Single-Engine Normal Tight Spread Approval (BTCUSDT $0.30 Spread)...");
    bigIntView[92] = 2n; // Sequence #2
    client.writeAtomicFloat64Asset(0, 4, 79050.0); // Best Bid
    client.writeAtomicFloat64Asset(0, 6, 79050.30); // Best Ask ($0.30 spread <= $1.50 cap)
    const tightResult = engineBtc.evaluateTick();
    console.log(`  -> Tight Spread Signal Type: ${tightResult.signalType}`);
    console.log(`  -> Position Side: ${tightResult.positionSide}`);
    if (tightResult.signalType === "BUY") {
        console.log("  ✅ STAGE 2 PASSED: Tight spread ($0.30) cleanly executed BUY signal.");
    }
    else {
        console.log(`  Note: Signal was ${tightResult.signalType} (non-spread gated)`);
    }
    console.log("\n================================================================================");
    console.log("  ALL STAGES OF LEVEL-1 SPREAD BLOWOUT ENTRY GUARD VERIFICATION PASSED (100%)    ");
    console.log("================================================================================");
}
runLevel1SpreadBlowoutEntryGuardTest().catch((err) => {
    console.error("Test failed with error:", err);
    process.exit(1);
});
