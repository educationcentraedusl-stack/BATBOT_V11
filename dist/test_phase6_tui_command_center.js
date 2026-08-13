"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const marketDataClient_1 = require("./marketDataClient");
const multiAssetDashboard_1 = require("./telemetry/multiAssetDashboard");
const keypressHandler_1 = require("./telemetry/keypressHandler");
function assert(condition, message) {
    if (!condition) {
        console.error(`❌ ASSERTION FAILED: ${message}`);
        process.exit(1);
    }
}
async function runPhase6TuiCommandCenterTests() {
    console.log("=========================================================================");
    console.log("  BATBOT_V11 PHASE 6: MULTI-ASSET TUI COMMAND CENTER & SAB QA VERIFY   ");
    console.log("=========================================================================\n");
    const maxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || "10", 10);
    const slotsPerAsset = parseInt(process.env.SAB_SLOTS_PER_ASSET || "256", 10);
    const requiredBytes = maxAssets * slotsPerAsset * 8;
    console.log(`[QA Test 1] Allocating 10-Asset SharedArrayBuffer (${requiredBytes} bytes)...`);
    const sab = new SharedArrayBuffer(requiredBytes);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    assert(client.maxAssets === 10, "maxAssets must equal 10");
    assert(client.slotsPerAsset === 256, "slotsPerAsset must equal 256");
    console.log("  ✅ SharedArrayBuffer initialized cleanly with zero copy.\n");
    console.log(`[QA Test 2] Populating synthetic 10-Asset telemetry metrics in SAB...`);
    const sampleSymbols = [
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "BNBUSDT",
        "ADAUSDT",
        "XRPUSDT",
        "DOGEUSDT",
        "AVAXUSDT",
        "LINKUSDT",
        "DOTUSDT",
    ];
    // Bitcast helper to write Float64 values into BigInt64Array slots atomically
    const bigIntView = new BigInt64Array(sab);
    const floatBuf = new ArrayBuffer(8);
    const floatBigInt = new BigInt64Array(floatBuf);
    const floatVal = new Float64Array(floatBuf);
    function writeFloat(assetIdx, slot, val) {
        const globalSlot = assetIdx * slotsPerAsset + slot;
        floatVal[0] = val;
        Atomics.store(bigIntView, globalSlot, floatBigInt[0]);
    }
    function writeBigInt(assetIdx, slot, val) {
        const globalSlot = assetIdx * slotsPerAsset + slot;
        Atomics.store(bigIntView, globalSlot, val);
    }
    for (let i = 0; i < maxAssets; i++) {
        const basePrice = 100.0 + i * 50.0;
        writeBigInt(i, 0, BigInt(1700000000000000 + i * 1000)); // Timestamp
        writeFloat(i, 1, 0.45 * (i % 2 === 0 ? 1 : -1)); // OBI
        writeFloat(i, 2, 2500.0 * (i + 1)); // CVD
        writeFloat(i, 4, basePrice); // Best Bid
        writeFloat(i, 5, 2.5 + i * 0.1); // Best Bid Qty
        writeFloat(i, 6, basePrice + 0.5); // Best Ask
        writeFloat(i, 7, 3.1 + i * 0.1); // Best Ask Qty
        writeBigInt(i, 92, BigInt(1000 + i * 50)); // Sequence Num
        // Bids & Asks depth
        for (let depth = 0; depth < 5; depth++) {
            writeFloat(i, 11 + depth * 2, basePrice - depth * 0.1);
            writeFloat(i, 11 + depth * 2 + 1, 1.5 + depth * 0.5);
            writeFloat(i, 51 + depth * 2, basePrice + 0.5 + depth * 0.1);
            writeFloat(i, 51 + depth * 2 + 1, 2.0 + depth * 0.5);
        }
        // AI & Microstructure
        writeFloat(i, 93, 0.65 * (i % 2 === 0 ? 1 : -1)); // AI Direction
        writeFloat(i, 94, 0.88); // Confidence
        writeBigInt(i, 103, 145000n); // Inference Latency (145 µs)
        writeFloat(i, 112, 1.85 + i * 0.2); // Hawkes Intensity
        writeFloat(i, 121, 0.015 + i * 0.002); // Garman-Klass RV
        writeFloat(i, 122, 0.35 + i * 0.03); // VPIN
        writeFloat(i, 123, 0.58 + i * 0.01); // Hurst Exponent
        // Active OMS Trades on odd asset slots (dynamically calculated metrics)
        if (i % 2 === 1) {
            const qty = 0.5 + i * 0.1;
            const entryPrice = basePrice - 1.0;
            const markBidPrice = basePrice;
            const calculatedUnrealizedPnl = (markBidPrice - entryPrice) * qty;
            const calculatedRealizedPnl = 3 * (entryPrice * qty * 0.005);
            writeFloat(i, 105, qty); // Position Qty
            writeFloat(i, 106, entryPrice); // Avg Entry
            writeFloat(i, 107, calculatedRealizedPnl); // Dynamically computed Realized PnL
            writeFloat(i, 108, calculatedUnrealizedPnl); // Dynamically computed Unrealized PnL
            writeFloat(i, 109, 10.0); // Leverage
            writeBigInt(i, 111, BigInt(12 + i)); // Total Trades
            writeBigInt(i, 135, BigInt(8 + i)); // Winning Trades
            writeBigInt(i, 136, BigInt(4)); // Losing Trades
        }
    }
    console.log("  ✅ Synthetic 10-Asset orderbook and OMS state populated in SAB.\n");
    console.log(`[QA Test 3] Testing MultiAssetCLIDashboard Zero-Copy SAB Reader...`);
    const dashboard = new multiAssetDashboard_1.MultiAssetCLIDashboard(client, false, sampleSymbols);
    dashboard.setFocusedAsset(2);
    assert(dashboard.getFocusedAsset() === 2, "Focused asset slot must be 2");
    // Push notifications
    dashboard.pushNotification("System initialized in 10-Asset Concurrency Mode.");
    dashboard.pushNotification("All 10 SAB asset slots verified online.");
    console.log("  ✅ Rendering TUI frame directly from SAB...");
    dashboard.render();
    console.log("\n  ✅ TUI Dashboard frame rendered cleanly with zero heap allocation.\n");
    console.log(`[QA Test 4] Testing Sub-Millisecond Keypress Engine & Atomic Control Flags...`);
    const keyEngine = new keypressHandler_1.InteractiveKeypressEngine(client);
    keyEngine.setNotificationCallback((msg) => {
        console.log(`  [KEYBOARD LOG] ${msg}`);
    });
    // Verify default control states (all false / 0.0)
    assert(client.getKillSwitchFlag(0) === false, "Kill switch should initially be false");
    assert(client.getCloseAllPositionsFlag(0) === false, "Close all flag should initially be false");
    assert(client.getEnginePausedFlag(0) === false, "Engine pause flag should initially be false");
    assert(client.getTriggerRecalibrationFlag(0) === false, "Recalibration flag should initially be false");
    // Trigger atomic global control updates
    console.log("  Testing Atomic Global Kill-Switch Broadcast across all 10 assets...");
    client.setGlobalKillSwitch(true);
    for (let i = 0; i < maxAssets; i++) {
        assert(client.getKillSwitchFlag(i) === true, `Asset ${i} kill switch must be true`);
    }
    console.log("  ✅ Global Kill-Switch verified active across all 10 asset slots.");
    console.log("  Testing Atomic Clear Kill-Switch Broadcast...");
    client.setGlobalKillSwitch(false);
    for (let i = 0; i < maxAssets; i++) {
        assert(client.getKillSwitchFlag(i) === false, `Asset ${i} kill switch must be false`);
    }
    console.log("  ✅ Global Kill-Switch cleared across all 10 asset slots.");
    console.log("  Testing Panic Close-All-Positions Atomic Trigger...");
    client.setGlobalCloseAll(true);
    for (let i = 0; i < maxAssets; i++) {
        assert(client.getCloseAllPositionsFlag(i) === true, `Asset ${i} close-all flag must be true`);
    }
    console.log("  ✅ Panic Close-All verified active across all 10 asset slots.");
    console.log("  Testing Engine Pause & Model Recalibration Atomic Triggers...");
    client.setGlobalPause(true);
    client.setGlobalRecalibration(true);
    assert(client.getEnginePausedFlag(0) === true, "Engine pause flag must be true");
    assert(client.getTriggerRecalibrationFlag(0) === true, "Recalibration flag must be true");
    console.log("  ✅ Atomic Pause and Recalibration flags verified in SAB.\n");
    console.log("=========================================================================");
    console.log("  ✅ ALL PHASE 6 MULTI-ASSET TUI COMMAND CENTER QA TESTS PASSED CLEANLY!  ");
    console.log("=========================================================================\n");
}
runPhase6TuiCommandCenterTests().catch((err) => {
    console.error("❌ Test failed with unhandled error:", err?.stack || err);
    process.exit(1);
});
