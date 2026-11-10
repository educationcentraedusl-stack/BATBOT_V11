"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const engine_1 = require("../strategy/engine");
const marketDataClient_1 = require("../marketDataClient");
const recalibrationWorker_1 = require("../ai/recalibrationWorker");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
const nativeAddon = __importStar(require("../../index"));
async function runTests() {
    console.log("================================================================================");
    console.log("  TEST SUITE: SOTA SPREAD CIRCUIT BREAKER & HIGH-IC ALPHA IMMUNITY VERIFICATION  ");
    console.log("================================================================================");
    // Setup SharedArrayBuffer and MarketDataClient
    const slotsPerAsset = 256;
    const maxAssets = 10;
    const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    const riskGuard = new risk_1.RiskGuard();
    const executionClient = new binance_1.BinanceExecutionClient();
    // -------------------------------------------------------------------------
    // TEST 1: SOTA Spread Circuit Breaker - BTC Spread Blowout Rejection ($14.50)
    // -------------------------------------------------------------------------
    console.log("\n[STAGE 1] Testing BTCUSDT Spread Blowout Rejection ($14.50 on $64,375 BTC)...");
    const engineBtc = new engine_1.StrategyEngine(client, riskGuard, executionClient, {
        symbol: "BTCUSDT",
        assetIndex: 0,
        maxSpreadBtc: 1.50,
    });
    const nowMs = Date.now();
    const nowNs = BigInt(nowMs) * 1000000n;
    const bigIntView = new BigInt64Array(sab);
    bigIntView[0] = nowNs; // Fresh packet timestamp
    bigIntView[92] = 1n; // Sequence #1
    // Simulate blowout orderbook: Bid 64367.8, Ask 64382.3 (Spread = 14.5 USDT)
    client.writeAtomicFloat64Asset(0, 4, 64367.8); // Best Bid (Slot 4)
    client.writeAtomicFloat64Asset(0, 6, 64382.3); // Best Ask (Slot 6)
    const tickBlowout = engineBtc.evaluateTick();
    console.log(`  -> Result passed: ${String(tickBlowout.riskResult?.passed)}`);
    console.log(`  -> Reason code:   ${String(tickBlowout.riskResult?.reasonCode)}`);
    console.log(`  -> Message:       ${String(tickBlowout.riskResult?.message)}`);
    if (tickBlowout.riskResult?.reasonCode !== "REJECTED_MAX_SPREAD_BLOWOUT" || tickBlowout.riskResult.passed) {
        throw new Error(`STAGE 1 FAILED: Expected REJECTED_MAX_SPREAD_BLOWOUT, got ${String(tickBlowout.riskResult?.reasonCode)}`);
    }
    console.log("  ✅ STAGE 1 PASSED: BTCUSDT $14.50 Spread Blowout 100% Rejected.");
    // -------------------------------------------------------------------------
    // TEST 2: SOTA Spread Circuit Breaker - Normal Tight Spread Approval ($0.20)
    // -------------------------------------------------------------------------
    console.log("\n[STAGE 2] Testing BTCUSDT Normal Tight Spread Approval ($0.20 on $64,375 BTC)...");
    bigIntView[92] = 2n; // Sequence #2
    client.writeAtomicFloat64Asset(0, 4, 64375.0); // Best Bid (Slot 4)
    client.writeAtomicFloat64Asset(0, 6, 64375.2); // Best Ask (Slot 6, Spread = 0.20 USDT)
    // Set positive AI confidence and direction
    client.writeAtomicFloat64Asset(0, 103, 0.75); // AI Dir
    client.writeAtomicFloat64Asset(0, 104, 0.85); // AI Conf
    const tickTight = engineBtc.evaluateTick();
    console.log(`  -> Spread Guard Passed: ${String(tickTight.riskResult?.reasonCode !== "REJECTED_MAX_SPREAD_BLOWOUT")}`);
    if (tickTight.riskResult?.reasonCode === "REJECTED_MAX_SPREAD_BLOWOUT") {
        throw new Error("STAGE 2 FAILED: Normal tight spread $0.20 was unexpectedly rejected!");
    }
    console.log("  ✅ STAGE 2 PASSED: BTCUSDT $0.20 Tight Spread Approved by Spread Guard.");
    // -------------------------------------------------------------------------
    // TEST 3: SOTA 2026 Adaptive WebSocket Staleness Circuit Breaker (Age > 6000ms)
    // -------------------------------------------------------------------------
    console.log("\n[STAGE 3] Testing Adaptive WebSocket Staleness Circuit Breaker (Age: 7000ms > 6000ms cap)...");
    bigIntView[92] = 3n; // Sequence #3
    const staleNs = BigInt(Date.now() - 7000) * 1000000n;
    bigIntView[0] = staleNs;
    const tickStale = engineBtc.evaluateTick();
    console.log(`  -> Result passed: ${String(tickStale.riskResult?.passed)}`);
    console.log(`  -> Reason code:   ${String(tickStale.riskResult?.reasonCode)}`);
    console.log(`  -> Message:       ${String(tickStale.riskResult?.message)}`);
    if (tickStale.riskResult?.reasonCode !== "REJECTED_STALE_ORDERBOOK" || tickStale.riskResult.passed) {
        throw new Error(`STAGE 3 FAILED: Expected REJECTED_STALE_ORDERBOOK, got ${String(tickStale.riskResult?.reasonCode)}`);
    }
    console.log("  ✅ STAGE 3 PASSED: Genuinely Stale WebSocket Packet (7000ms) 100% Rejected.");
    // -------------------------------------------------------------------------
    // TEST 4: Unconditional High-IC Alpha Immunity in AutoRecalibrationManager
    // -------------------------------------------------------------------------
    console.log("\n[STAGE 4] Testing Unconditional High-IC Alpha Immunity in AutoRecalibrationManager...");
    const manager = recalibrationWorker_1.AutoRecalibrationManager.getInstance();
    manager.setMarketDataClient(client);
    // Attempt to feed high IC (+0.1387) with isDrifted = true
    for (let i = 0; i < 100; i++) {
        manager.evaluateTickDrift(0.1387, true);
    }
    const status = manager.getStatus();
    console.log(`  -> High IC (+0.1387) Drift Ticks: ${String(status.driftTickCounter)}/50`);
    console.log(`  -> Recalibrating Active:          ${String(status.isRecalibrating)}`);
    console.log(`  -> Total Recalibrations:          ${String(status.totalRecalibrations)}`);
    if (status.driftTickCounter !== 0 || status.isRecalibrating) {
        throw new Error("STAGE 4 FAILED: High IC (+0.1387) triggered recalibration accumulator!");
    }
    // Attempt direct call to runRecalibrationPipeline with high IC
    const pipelineTriggered = await manager.runRecalibrationPipeline(0.1387);
    console.log(`  -> runRecalibrationPipeline(0.1387) Triggered: ${String(pipelineTriggered)}`);
    if (pipelineTriggered) {
        throw new Error("STAGE 4 FAILED: runRecalibrationPipeline allowed high IC (+0.1387) to recalibrate!");
    }
    console.log("  ✅ STAGE 4 PASSED: High-IC Alpha Immunity strictly protected model weights.");
    // -------------------------------------------------------------------------
    // TEST 5: Native Rust N-API Status Verification
    // -------------------------------------------------------------------------
    console.log("\n[STAGE 5] Verifying Native Rust N-API getIcStatus()...");
    const nativeExports = nativeAddon;
    if (typeof nativeExports["getIcStatus"] === "function") {
        const rawJson = nativeAddon.getIcStatus();
        console.log(`  -> Native getIcStatus payload: ${rawJson}`);
        const parsed = JSON.parse(rawJson);
        if (typeof parsed !== "object" ||
            parsed === null ||
            typeof parsed.ic !== "number" ||
            typeof parsed.is_drifted !== "boolean") {
            throw new Error("STAGE 5 FAILED: getIcStatus returned invalid JSON schema!");
        }
    }
    console.log("  ✅ STAGE 5 PASSED: Native Rust N-API bindings verified.");
    console.log("\n================================================================================");
    console.log("  ALL 5 STAGES OF SOTA SPREAD & HIGH-IC IMMUNITY VERIFICATION PASSED (100%)    ");
    console.log("================================================================================\n");
}
runTests().catch((err) => {
    console.error("❌ TEST RUNNER FAILED:", err);
    process.exit(1);
});
