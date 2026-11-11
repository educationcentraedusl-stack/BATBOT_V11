"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const marketDataClient_1 = require("./marketDataClient");
const risk_1 = require("./strategy/risk");
const binance_1 = require("./execution/binance");
const engine_1 = require("./strategy/engine");
async function runDefect1Test() {
    console.log("=================================================");
    console.log("DEFECT 1 REMEDIATION VERIFICATION SUITE");
    console.log("Testing Unhandled Promise Rejection Hazard...");
    console.log("=================================================");
    const sab = new SharedArrayBuffer(1024 * 1024);
    const bigIntView = new BigInt64Array(sab);
    const client = new marketDataClient_1.MarketDataClient(sab);
    // Seed fresh nanosecond timestamp (Slot 0), sequence (Slot 92), and healthy rolling IC (Slot 101)
    Atomics.store(bigIntView, 0, BigInt(Date.now()) * 1000000n);
    client.setSequenceNum(1n, 0);
    client.setRollingIC(0.05, 0);
    client.setHawkesIntensity(1.0, 0);
    client.setHurstExponent(0.65, 0);
    client.setLOBEntropy(0.50, 0);
    client.setGarmanKlassRV(0.0001, 0);
    client.writeAtomicFloat64Asset(0, 99, 1.0); // Latency Penalty Coefficient
    // Tick 0 neutral LCI baseline
    client.writeAtomicFloat64Asset(0, 1, 0.0); // OBI
    client.writeAtomicFloat64Asset(0, 2, 0.0); // CVD
    client.writeAtomicFloat64Asset(0, 3, 0.0); // Spread Velocity
    client.writeAtomicFloat64Asset(0, 4, 60000.0); // Best Bid Price
    client.writeAtomicFloat64Asset(0, 5, 5.0); // Best Bid Qty
    client.writeAtomicFloat64Asset(0, 6, 60000.1); // Best Ask Price
    client.writeAtomicFloat64Asset(0, 7, 5.0); // Best Ask Qty
    client.writeAtomicFloat64Asset(0, 93, 0.0); // AI Direction neutral
    client.writeAtomicFloat64Asset(0, 94, 0.0); // AI Confidence neutral
    const riskGuard = new risk_1.RiskGuard({ minCooldownMs: 0 });
    const executionClient = new binance_1.BinanceExecutionClient({
        apiKey: "dummy_key",
        apiSecret: "dummy_secret",
    });
    // Override funding stream & placeOrder to isolate REST rejection handling cleanly offline
    executionClient.ensureFundingRateStream = () => Promise.resolve();
    executionClient.placeOrder = () => Promise.reject(new Error("SIMULATED_BINANCE_API_NETWORK_TIMEOUT (-1001: Internal error; unable to process request)"));
    const engine = new engine_1.StrategyEngine(client, riskGuard, executionClient, {
        symbol: "BTCUSDT",
        tradeSizeUsdt: 60,
        minNotionalUsdt: 5,
        cooldownMs: 0,
    });
    try {
        // Establish Tick 0 LCI baseline
        const warmupResult = engine.evaluateTick();
        if (warmupResult.signalType !== "NONE") {
            throw new Error(`FAIL: Expected Tick 0 baseline to yield NONE, got ${warmupResult.signalType}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
        // Tick 1 directional BUY pulse
        Atomics.store(bigIntView, 0, BigInt(Date.now()) * 1000000n);
        client.setSequenceNum(2n, 0);
        client.writeAtomicFloat64Asset(0, 1, 0.85); // OBI
        client.writeAtomicFloat64Asset(0, 2, 1000.0); // CVD
        client.writeAtomicFloat64Asset(0, 3, 0.1); // Spread Velocity
        client.writeAtomicFloat64Asset(0, 4, 60000.0); // Best Bid Price
        client.writeAtomicFloat64Asset(0, 5, 25.0); // Best Bid Qty
        client.writeAtomicFloat64Asset(0, 6, 60000.1); // Best Ask Price
        client.writeAtomicFloat64Asset(0, 7, 2.0); // Best Ask Qty
        client.writeAtomicFloat64Asset(0, 93, 1.0); // AI Direction BUY (+1.0)
        client.writeAtomicFloat64Asset(0, 94, 0.95); // AI Confidence (95%)
        console.log("\n[STEP 1] Evaluating tick to trigger entry order signal under API failure simulation...");
        const signalResult = engine.evaluateTick();
        if (signalResult.signalType !== "BUY") {
            throw new Error(`FAIL: Expected BUY signal, got ${signalResult.signalType}`);
        }
        if (!signalResult.executionPromise) {
            throw new Error("FAIL: Execution promise was not created.");
        }
        console.log("  ✓ Signal triggered: BUY order submitted to placeOrder.");
        console.log("  ✓ executionPromise generated. Awaiting resolution...");
        // Await the executionPromise. It should resolve to null (handled error) without throwing an exception!
        let res = undefined;
        let uncaughtError = null;
        try {
            res = await signalResult.executionPromise;
        }
        catch (err) {
            uncaughtError = err;
        }
        if (uncaughtError !== null) {
            const errDetail = uncaughtError instanceof Error ? uncaughtError.message : JSON.stringify(uncaughtError);
            throw new Error(`FAIL: Execution promise threw an uncaught error: ${errDetail}`);
        }
        if (res !== null) {
            throw new Error(`FAIL: Expected executionPromise to resolve to null, got ${JSON.stringify(res)}`);
        }
        console.log("  ✓ executionPromise resolved to null gracefully without throwing an exception.");
        // Verify public recovery invariants without private field access:
        // 1. Optimistic pending reservation rolled back to FLAT
        if (engine.hasAnyPendingEntry() || engine.getHedgeLedger().getCoreLong().isOccupied) {
            throw new Error("FAIL: Pending entry reservation was not rolled back after order rejection.");
        }
        // 2. Subsequent tick dispatch works cleanly (proves internal in-flight mutex reset in finally block)
        client.setLongCooldownLock(0, 0);
        engine.resetLciBaseline();
        Atomics.store(bigIntView, 0, BigInt(Date.now()) * 1000000n);
        client.setSequenceNum(3n, 0);
        client.writeAtomicFloat64Asset(0, 1, 0.0);
        client.writeAtomicFloat64Asset(0, 2, 0.0);
        client.writeAtomicFloat64Asset(0, 5, 5.0);
        client.writeAtomicFloat64Asset(0, 7, 5.0);
        client.writeAtomicFloat64Asset(0, 93, 0.0);
        client.writeAtomicFloat64Asset(0, 94, 0.0);
        engine.evaluateTick();
        await new Promise((resolve) => setTimeout(resolve, 15));
        Atomics.store(bigIntView, 0, BigInt(Date.now()) * 1000000n);
        client.setSequenceNum(4n, 0);
        client.writeAtomicFloat64Asset(0, 1, 0.85);
        client.writeAtomicFloat64Asset(0, 2, 1000.0);
        client.writeAtomicFloat64Asset(0, 5, 25.0);
        client.writeAtomicFloat64Asset(0, 7, 2.0);
        client.writeAtomicFloat64Asset(0, 93, 1.0);
        client.writeAtomicFloat64Asset(0, 94, 0.95);
        const followUpSignal = engine.evaluateTick();
        if (followUpSignal.signalType !== "BUY" || !followUpSignal.executionPromise) {
            throw new Error(`FAIL: Engine remained locked after order failure (signalType=${followUpSignal.signalType}).`);
        }
        const followUpRes = await followUpSignal.executionPromise;
        if (followUpRes !== null) {
            throw new Error("FAIL: Expected follow-up rejected order promise to resolve to null.");
        }
        console.log("  ✓ Post-rejection lock cleared cleanly and subsequent BUY dispatch recovered.");
        console.log("\n=================================================");
        console.log("✅ DEFECT 1 VERIFICATION SUCCESSFUL:");
        console.log("Node.js process survived severe API rejection cleanly without UnhandledPromiseRejection!");
        console.log("=================================================");
    }
    finally {
        engine.destroy();
        executionClient.destroy();
    }
}
runDefect1Test().catch((err) => {
    console.error("Fatal test runner error:", err);
    process.exit(1);
});
