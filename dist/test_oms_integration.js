"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("../index");
async function main() {
    console.log("=== BATBOT_V11 Rust OMS N-API Integration Verification ===");
    // 1. Initialize Core Engine
    const coreInit = (0, index_1.initCore)();
    console.log(`Core Initialization: ${coreInit}`);
    // 2. Initialize OMS Engine
    const omsStarted = (0, index_1.startOmsEngine)("BTCUSDT", 100000.0, "", "", true);
    console.log(`OMS Engine Started: ${omsStarted}`);
    // 3. Allocate SharedArrayBuffer (2048 bytes)
    const sab = new SharedArrayBuffer(2048);
    const f64View = new Float64Array(sab);
    const u64View = new BigUint64Array(sab);
    // Setup LOB & AI Prediction data in SAB
    f64View[3] = 0.65; // spread_vel
    f64View[4] = 90500.0; // best_bid
    f64View[6] = 90501.0; // best_ask
    f64View[93] = 1.0; // direction +1.0 (Long)
    f64View[94] = 0.92; // confidence 0.92
    f64View[95] = 40.0; // horizon 40ms
    f64View[100] = 2.0; // slippage 2 ticks
    u64View[103] = 1500000n; // latency 1.5ms
    u64View[104] = 101n; // sequence 101
    // 4. Evaluate OMS Tick
    const intentJson = (0, index_1.evaluateOmsTick)(Buffer.from(sab));
    console.log(`Evaluated Intent JSON: ${intentJson}`);
    // 5. Query OMS Metrics & Position Snapshot
    const metricsJson = (0, index_1.getOmsMetrics)();
    console.log(`OMS Metrics: ${metricsJson}`);
    const positionJson = (0, index_1.getPositionSnapshot)();
    console.log(`Position Snapshot: ${positionJson}`);
    if (intentJson !== "null") {
        console.log("✅ OMS N-API Integration Test PASSED 100%");
    }
    else {
        console.error("❌ OMS Evaluation Failed!");
        process.exit(1);
    }
}
main().catch((err) => {
    console.error("Fatal test error:", err);
    process.exit(1);
});
