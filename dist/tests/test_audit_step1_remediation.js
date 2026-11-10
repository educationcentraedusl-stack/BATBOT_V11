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
const marketDataClient_1 = require("../marketDataClient");
const positionLedger_1 = require("../strategy/positionLedger");
const path = __importStar(require("path"));
const native = __importStar(require("../../index"));
function runStep1ForensicVerification() {
    console.log("================================================================================");
    console.log("     FORENSIC ZERO-TRUST AUDIT: STEP 1 REMEDIATION VERIFICATION SUITE           ");
    console.log("================================================================================");
    // 1. Initialize Physical SharedArrayBuffer
    console.log("\n[STAGE 1] Allocating Physical SharedArrayBuffer and MarketDataClient...");
    const maxAssets = 10;
    const slotsPerAsset = 256;
    const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    const sabBuffer = Buffer.from(sab);
    // 2. Initialize physical AI Model
    console.log("\n[STAGE 2] Loading Physical AI Engine & Model Weights...");
    const weightsPath = path.resolve(__dirname, "../../models/cfc_weights.safetensors");
    const tkanPath = path.resolve(__dirname, "../../models/tkan_luts.bin");
    const loaded = native.loadAiModelFull(weightsPath, tkanPath, sabBuffer);
    if (!loaded) {
        throw new Error("Failed to load native AI model full weights!");
    }
    native.resetIcTracker();
    console.log("  [PASS] Physical AI Engine initialized and IC Tracker reset.");
    const assetIdx = 0;
    console.log(`  Initial SAB Slot 101 (ROLLING_IC): ${String(client.getRollingIC(assetIdx))}`);
    console.log(`  Initial SAB Slot 102 (IS_MODEL_DRIFTED): ${String(client.getIsModelDrifted(assetIdx))}`);
    // 3. Test Direct N-API recordTradeIc with sabBuffer
    console.log("\n[STAGE 3] Testing Direct N-API record_trade_ic with sabBuffer pass-through...");
    const initialCall = native.recordTradeIc(1.0, 0.02, assetIdx, sabBuffer);
    if (!initialCall) {
        throw new Error("native.recordTradeIc returned false!");
    }
    const sampleCount1 = new Float64Array(sab)[assetIdx * slotsPerAsset + 155];
    console.log(`  After 1 call: Sample Count (Slot 155): ${String(sampleCount1)}`);
    if (sampleCount1 !== 1.0) {
        throw new Error(`Expected Slot 155 to be 1.0, got ${String(sampleCount1)}`);
    }
    console.log("  [PASS] Direct sab_buffer pass-through successfully wrote to SAB Slot 155.");
    // 4. Test GLOBAL_SAB_BRIDGE caching (omitting sabBuffer)
    console.log("\n[STAGE 4] Testing GLOBAL_SAB_BRIDGE caching when sabBuffer is omitted...");
    const secondCall = native.recordTradeIc(1.0, 0.03, assetIdx, undefined);
    if (!secondCall) {
        throw new Error("native.recordTradeIc without sabBuffer returned false!");
    }
    const sampleCount2 = new Float64Array(sab)[assetIdx * slotsPerAsset + 155];
    console.log(`  After 2nd call (no sabBuffer): Sample Count (Slot 155): ${String(sampleCount2)}`);
    if (sampleCount2 !== 2.0) {
        throw new Error(`Expected Slot 155 to be 2.0 via cached GLOBAL_SAB_BRIDGE, got ${String(sampleCount2)}`);
    }
    console.log("  [PASS] Cached GLOBAL_SAB_BRIDGE successfully maintained SAB synchronization without argument.");
    // 5. Test Mathematical Sign Inversion: Profitable Short & Long Trades
    console.log("\n[STAGE 5] Testing Mathematical Sign Inversion Correctness...");
    native.resetIcTracker();
    // Populate 30 profitable LONG trades: Prediction = +1.0, Market Return = +0.01 to +0.03
    for (let i = 0; i < 30; i++) {
        const ret = 0.01 + (i * 0.001); // Market price rose
        native.recordTradeIc(1.0, ret, assetIdx, sabBuffer);
    }
    // Populate 30 profitable SHORT trades: Prediction = -1.0, Market Return = -0.01 to -0.03
    for (let i = 0; i < 30; i++) {
        const ret = -0.01 - (i * 0.001); // Market price fell (profitable for short!)
        native.recordTradeIc(-1.0, ret, assetIdx, sabBuffer);
    }
    const rollingIc = client.getRollingIC(assetIdx);
    const sampleCount = new Float64Array(sab)[assetIdx * slotsPerAsset + 155];
    const isDrifted = client.getIsModelDrifted(assetIdx);
    console.log(`  Sample Count after 60 observations: ${String(sampleCount)}`);
    console.log(`  Rolling IC (Slot 101): ${String(rollingIc)}`);
    console.log(`  Is Model Drifted (Slot 102): ${String(isDrifted)}`);
    if (sampleCount !== 60) {
        throw new Error(`Expected 60 samples in Slot 155, got ${String(sampleCount)}`);
    }
    // In a system where BOTH profitable longs and profitable shorts occurred,
    // the correlation between (pred, marketReturn) MUST BE STRICTLY POSITIVE (+1.0)!
    // If the sign was inverted for shorts, the short pairs (-1.0, -ret) would have been passed as (-1.0, +ret)
    // which would produce a negative correlation!
    if (rollingIc <= 0.80) {
        throw new Error(`Sign inversion defect detected! Expected Spearman IC >= +0.80, got ${String(rollingIc)}`);
    }
    console.log(`  [PASS] Spearman IC is ${rollingIc.toFixed(4)} >= +0.80. Profitable shorts correlate POSITIVELY with negative market returns!`);
    // 6. Test Inversion on Losing Trades
    console.log("\n[STAGE 6] Testing Discordant Sign on Losing Trades...");
    native.resetIcTracker();
    // 30 losing LONG trades: Pred = +1.0, Market Return = -0.01 to -0.03 (price fell)
    for (let i = 0; i < 30; i++) {
        const ret = -0.01 - (i * 0.001);
        native.recordTradeIc(1.0, ret, assetIdx, sabBuffer);
    }
    // 30 losing SHORT trades: Pred = -1.0, Market Return = +0.01 to +0.03 (price rose)
    for (let i = 0; i < 30; i++) {
        const ret = 0.01 + (i * 0.001);
        native.recordTradeIc(-1.0, ret, assetIdx, sabBuffer);
    }
    const losingIc = client.getRollingIC(assetIdx);
    console.log(`  Losing trades Rolling IC: ${String(losingIc)}`);
    if (losingIc >= -0.80) {
        throw new Error(`Expected Spearman IC <= -0.80 for losing trades, got ${String(losingIc)}`);
    }
    console.log(`  [PASS] Spearman IC is ${losingIc.toFixed(4)} <= -0.80. Losing trades correlate NEGATIVELY!`);
    // 7. Full Integration Test via HedgePositionLedger.recordRealizedExit
    console.log("\n[STAGE 7] Testing HedgePositionLedger.recordRealizedExit integration...");
    native.resetIcTracker();
    const ledger = new positionLedger_1.HedgePositionLedger("BTCUSDT", 3, client, assetIdx);
    // Simulate 35 Long exits (Buy at 60000, Sell at 61000 => Market Return = +1.666%)
    for (let i = 0; i < 35; i++) {
        ledger.recordRealizedExit("LONG", 60000, 61000 + i * 10, 0.1, 0.0004, "TP_EXIT");
    }
    // Simulate 35 Short exits (Sell to open at 60000, Buy to close at 59000 => Market Return = -1.666%)
    for (let i = 0; i < 35; i++) {
        ledger.recordRealizedExit("SHORT", 60000, 59000 - i * 10, 0.1, 0.0004, "TP_EXIT");
    }
    const ledgerIc = client.getRollingIC(assetIdx);
    const ledgerSamples = new Float64Array(sab)[assetIdx * slotsPerAsset + 155];
    console.log(`  HedgePositionLedger Exit Test: Samples = ${String(ledgerSamples)}, Rolling IC = ${String(ledgerIc)}`);
    if (ledgerSamples !== 70) {
        throw new Error(`Expected 70 samples from HedgePositionLedger, got ${String(ledgerSamples)}`);
    }
    if (ledgerIc <= 0.80) {
        throw new Error(`Expected Spearman IC >= +0.80 from HedgePositionLedger exits, got ${String(ledgerIc)}`);
    }
    console.log(`  [PASS] HedgePositionLedger exits produced perfect concordant IC ${ledgerIc.toFixed(4)} across 70 trades!`);
    // 8. Multi-Asset Isolation Test
    console.log("\n[STAGE 8] Testing Multi-Asset Slot Isolation (Asset 0 vs Asset 1)...");
    const asset1 = 1;
    // Send 30 losing long trades and 30 losing short trades for Asset 1
    for (let i = 0; i < 30; i++) {
        const ret = -0.01 - (i * 0.001);
        native.recordTradeIc(1.0, ret, asset1, sabBuffer);
    }
    for (let i = 0; i < 30; i++) {
        const ret = 0.01 + (i * 0.001);
        native.recordTradeIc(-1.0, ret, asset1, sabBuffer);
    }
    const asset0Ic = client.getRollingIC(0);
    const asset1Ic = client.getRollingIC(1);
    const asset0Samples = new Float64Array(sab)[0 * slotsPerAsset + 155];
    const asset1Samples = new Float64Array(sab)[1 * slotsPerAsset + 155];
    console.log(`  Asset 0: Samples=${String(asset0Samples)}, IC=${asset0Ic.toFixed(4)}`);
    console.log(`  Asset 1: Samples=${String(asset1Samples)}, IC=${asset1Ic.toFixed(4)}`);
    if (asset0Samples !== 70 || asset0Ic <= 0.80) {
        throw new Error("Asset 0 corrupted by Asset 1 update!");
    }
    if (asset1Samples !== 60 || asset1Ic >= -0.80) {
        throw new Error("Asset 1 did not record losing IC independently!");
    }
    console.log("  [PASS] Multi-Asset isolation verified. Slots 101, 102, 155 are completely orthogonal.");
    console.log("\n================================================================================");
    console.log(" [SUCCESS] ALL 8 STAGES OF STEP 1 FORENSIC VERIFICATION PASSED 100%");
    console.log("================================================================================");
}
try {
    runStep1ForensicVerification();
}
catch (err) {
    console.error("\n[CRITICAL FAILURE IN STEP 1 FORENSIC AUDIT]:", err);
    process.exit(1);
}
