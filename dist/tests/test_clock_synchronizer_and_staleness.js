"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const timeSynchronizer_1 = require("../utils/timeSynchronizer");
const marketDataClient_1 = require("../marketDataClient");
const engine_1 = require("../strategy/engine");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
const positionLedger_1 = require("../strategy/positionLedger");
const BITCAST_BUF = new ArrayBuffer(8);
const BITCAST_BIGINT = new BigInt64Array(BITCAST_BUF);
const BITCAST_FLOAT = new Float64Array(BITCAST_BUF);
function storeAtomicFloat(bigIntView, slot, value) {
    BITCAST_FLOAT[0] = value;
    Atomics.store(bigIntView, slot, BITCAST_BIGINT[0]);
}
async function runClockSyncAndStalenessTests() {
    console.log("==========================================================================================");
    console.log("  ⚡ SOTA TEST SUITE: AUDIT 14.0 DEFECT REMEDIATION & TEMPORAL SYNCHRONIZATION");
    console.log("==========================================================================================\n");
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 1] Testing TimeSynchronizer Core, EWMA Smoother & Finite Traps (DEF-1401)...");
    const customSync = new timeSynchronizer_1.TimeSynchronizer({
        syncIntervalMs: 30000,
        maxAcceptableRttMs: 150,
        ewmaAlpha: 0.25,
    });
    // Test manual offset injection (+2390ms local clock drift)
    customSync.setManualOffsetMs(-2390);
    const offset = customSync.getOffsetMs();
    const adjustedNow = customSync.getAdjustedNowMs();
    const rawNow = Date.now();
    const diff = adjustedNow - rawNow;
    console.log(`  Raw Local Now: ${String(rawNow)}`);
    console.log(`  Offset: ${String(offset)}ms | Adjusted Now: ${String(adjustedNow)} (Diff: ${String(diff)}ms)`);
    if (Math.abs(diff - (-2390)) > 2) {
        throw new Error(`FAIL: AdjustedNow calculation incorrect! Expected diff ~ -2390ms, got ${String(diff)}ms`);
    }
    // Test AdjustedNowNs
    const adjustedNs = customSync.getAdjustedNowNs();
    const expectedNs = BigInt(adjustedNow) * 1000000n;
    if (Math.abs(Number((adjustedNs - expectedNs) / 1000000n)) > 2) {
        throw new Error("FAIL: getAdjustedNowNs mismatch!");
    }
    // Test DEF-1401: Number.isFinite protection against NaN and Infinity
    customSync.setManualOffsetMs(NaN);
    if (customSync.getOffsetMs() !== 0 || !Number.isFinite(customSync.getAdjustedNowMs())) {
        throw new Error("FAIL: NaN manual offset did not default safely to 0!");
    }
    customSync.setManualOffsetMs(Infinity);
    if (customSync.getOffsetMs() !== 0 || !Number.isFinite(customSync.getAdjustedNowMs())) {
        throw new Error("FAIL: Infinity manual offset did not default safely to 0!");
    }
    customSync.setManualOffsetMs(-2390); // Restore for downstream tests
    console.log("  ✅ STAGE 1 PASSED: TimeSynchronizer correctly adjusts epoch timestamp with Number.isFinite() protection!\n");
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 2] Testing SharedArrayBuffer Slot 150 vs Slot 100 Isolation (DEF-1403)...");
    const sab = new SharedArrayBuffer(20480);
    const client = new marketDataClient_1.MarketDataClient(sab, 10, 256);
    const bigIntView = new BigInt64Array(sab);
    // Set dynamic slippage on Slot 100
    client.setDynamicSlippageTicks(3.5, 0);
    // Set global server time offset on SAB Slot 150
    client.setGlobalServerTimeOffsetMs(-2390);
    for (let assetIdx = 0; assetIdx < 10; assetIdx++) {
        const readOffset = client.getServerTimeOffsetMs(assetIdx);
        if (Math.abs(readOffset - (-2390)) > 0.001) {
            throw new Error(`FAIL: SAB Slot 150 mismatch on asset ${String(assetIdx)}! Expected -2390, got ${String(readOffset)}`);
        }
    }
    // Verify Slot 100 was NOT overwritten or corrupted by Slot 150 write
    const readSlippage = client.getDynamicSlippageTicks(0);
    if (Math.abs(readSlippage - 3.5) > 0.001) {
        throw new Error(`FAIL: SAB Slot 100 corrupted by Slot 150 write! Expected 3.5, got ${String(readSlippage)}`);
    }
    console.log("  ✅ STAGE 2 PASSED: SAB Slot 150 and Slot 100 are completely isolated with zero memory collisions!\n");
    // ------------------------------------------------------------------------------------------
    console.log("[STAGE 3] Testing StrategyEngine Staleness & Temporal Cooldown (DEF-1404)...");
    // Simulate local OS clock being 2390ms ahead of Binance exchange server time
    timeSynchronizer_1.timeSynchronizer.setManualOffsetMs(-2390);
    const riskGuard = new risk_1.RiskGuard();
    const mockExecClient = new binance_1.BinanceExecutionClient({
        apiKey: "test_key",
        apiSecret: "test_secret",
        useTestnet: true,
    });
    mockExecClient.getOpenOrders = () => Promise.resolve([]);
    mockExecClient.cancelBatchOrders = () => Promise.resolve([]);
    mockExecClient.cancelOrder = (symbol, orderId) => Promise.resolve({
        orderId: Number(orderId),
        symbol,
        status: "CANCELED",
        clientOrderId: "test_cancel",
        price: "0",
        avgPrice: "0",
        origQty: "0",
        executedQty: "0",
        cumQuote: "0",
        timeInForce: "GTC",
        type: "STOP_MARKET",
        reduceOnly: false,
        side: "SELL",
        positionSide: "LONG",
        stopPrice: "0",
        workingType: "CONTRACT_PRICE",
        updateTime: timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs(),
    });
    mockExecClient.placeQuantityStopLoss = (symbol, side, positionSide, stopPrice, quantity) => Promise.resolve({
        orderId: 888222,
        symbol,
        status: "NEW",
        clientOrderId: "test_sl",
        price: "0",
        avgPrice: "0",
        origQty: String(quantity),
        executedQty: "0",
        cumQuote: "0",
        timeInForce: "GTC",
        type: "STOP_MARKET",
        reduceOnly: false,
        side,
        positionSide,
        stopPrice: String(stopPrice),
        workingType: "CONTRACT_PRICE",
        updateTime: timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs(),
    });
    mockExecClient.placeBatchOrders = () => Promise.resolve([]);
    mockExecClient.placeOrder = (params) => {
        const pxStr = typeof params.price === "number" && Number.isFinite(params.price) ? String(params.price) : "60000";
        const qtyStr = typeof params.quantity === "number" && Number.isFinite(params.quantity) ? String(params.quantity) : "0.001";
        const posSide = params.positionSide === "LONG" || params.positionSide === "SHORT" || params.positionSide === "BOTH"
            ? params.positionSide
            : "LONG";
        return Promise.resolve({
            orderId: 888111,
            symbol: params.symbol,
            status: "FILLED",
            clientOrderId: typeof params.clientOrderId === "string" && params.clientOrderId.length > 0 ? params.clientOrderId : "test_cid",
            price: pxStr,
            avgPrice: pxStr,
            origQty: qtyStr,
            executedQty: qtyStr,
            cumQuote: "60",
            timeInForce: "GTC",
            type: params.type,
            reduceOnly: false,
            side: params.side,
            positionSide: posSide,
            stopPrice: "0",
            workingType: "CONTRACT_PRICE",
            updateTime: timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs(),
        });
    };
    const ledger = new positionLedger_1.HedgePositionLedger("BTCUSDT", 3);
    const engine = new engine_1.StrategyEngine(client, riskGuard, mockExecClient, {
        symbol: "BTCUSDT",
        assetIndex: 0,
        minAiConfidence: 0.65,
        obiBuyThreshold: 0.20,
        obiSellThreshold: -0.20,
        maxSpreadVelocity: 50.0,
        maxSpreadBtc: 1.50,
        tickSize: 0.10,
        cooldownMs: 5000,
    }, undefined, ledger);
    try {
        // Seed regime/IC metrics and establish Tick 0 neutral LCI baseline (Seq 0) before BUY trigger (Seq 1)
        client.setRollingIC(0.05, 0);
        client.setHawkesIntensity(1.0, 0);
        client.setHurstExponent(0.65, 0);
        client.setLOBEntropy(0.50, 0);
        client.setGarmanKlassRV(0.0001, 0);
        storeAtomicFloat(bigIntView, 4, 60000.0);
        storeAtomicFloat(bigIntView, 5, 5.0);
        storeAtomicFloat(bigIntView, 6, 60000.5);
        storeAtomicFloat(bigIntView, 7, 5.0);
        storeAtomicFloat(bigIntView, 1, 0.0);
        storeAtomicFloat(bigIntView, 2, 0.0);
        storeAtomicFloat(bigIntView, 93, 0.0);
        storeAtomicFloat(bigIntView, 94, 0.5);
        Atomics.store(bigIntView, 0, BigInt(timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs() - 15) * 1000000n);
        Atomics.store(bigIntView, 92, 0n);
        engine.evaluateTick();
        await new Promise((resolve) => setTimeout(resolve, 15));
        // Setup bullish orderbook state in SAB (Asset 0) for Seq 1
        storeAtomicFloat(bigIntView, 4, 60000.0); // Best bid price
        storeAtomicFloat(bigIntView, 5, 25.0); // Best bid qty
        storeAtomicFloat(bigIntView, 6, 60000.5); // Best ask price
        storeAtomicFloat(bigIntView, 7, 2.0); // Best ask qty
        storeAtomicFloat(bigIntView, 1, 0.85); // OBI
        storeAtomicFloat(bigIntView, 2, 100.0); // CVD
        storeAtomicFloat(bigIntView, 93, 0.85); // AI Direction
        storeAtomicFloat(bigIntView, 94, 0.88); // AI Confidence
        // Simulate Binance emitting a fresh packet at Exchange Time T_exchange (AdjustedNow - 15ms network latency)
        const exchangeServerTimeMs = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs() - 15;
        const exchangePacketTimestampNs = BigInt(exchangeServerTimeMs) * 1000000n;
        Atomics.store(bigIntView, 0, exchangePacketTimestampNs);
        Atomics.store(bigIntView, 92, 1n); // Seq
        // Evaluate tick with TimeSynchronizer active
        const result = engine.evaluateTick();
        console.log(`  Tick Evaluation Result: Signal=${result.signalType}, RiskPassed=${String(result.riskResult?.passed)}, Reason=${result.riskResult?.reasonCode || "NONE"}`);
        if (result.executionPromise) {
            await result.executionPromise;
        }
        if (result.signalType !== "BUY") {
            throw new Error(`FAIL: Expected BUY signal to lock cooldown, got ${result.signalType}`);
        }
        if (result.riskResult?.reasonCode === "REJECTED_STALE_ORDERBOOK") {
            throw new Error("FAIL: Fresh packet was falsely rejected by Staleness Guard!");
        }
        // Verify cooldown lock in SAB was timestamped with timeSynchronizer.getAdjustedNowMs() + cooldownMs
        const longCooldownLock = client.getLongCooldownLock(0);
        const expectedLockTime = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs() + 5000;
        const lockDiff = Math.abs(longCooldownLock - expectedLockTime);
        console.log(`  Long Cooldown Lock: ${String(longCooldownLock)} | Expected: ${String(expectedLockTime)} (Diff: ${String(lockDiff)}ms)`);
        if (lockDiff > 300) {
            throw new Error(`FAIL: DEF-1404 cooldown desync! Lock ${String(longCooldownLock)} deviates from adjusted timestamp ${String(expectedLockTime)}`);
        }
        console.log("  ✅ Fresh tick with 15ms latency accepted cleanly & cooldown lock synchronized to exchange domain!");
        // Stress Test: 1,000 rapid ticks with jitter under clock desync
        let rejectedCount = 0;
        for (let i = 2; i <= 1000; i++) {
            const jitterMs = Math.floor(Math.random() * 30); // 0 to 30ms latency
            const freshExchangeTs = BigInt(timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs() - jitterMs) * 1000000n;
            Atomics.store(bigIntView, 0, freshExchangeTs);
            Atomics.store(bigIntView, 92, BigInt(i));
            const res = engine.evaluateTick();
            if (res.executionPromise) {
                await res.executionPromise;
            }
            if (res.riskResult?.reasonCode === "REJECTED_STALE_ORDERBOOK") {
                rejectedCount++;
            }
        }
        console.log(`  1,000 Rapid Ticks Stress Test: ${String(rejectedCount)} False Rejections`);
        if (rejectedCount > 0) {
            throw new Error(`FAIL: Staleness guard falsely rejected ${String(rejectedCount)}/1000 fresh ticks!`);
        }
        console.log("  ✅ STAGE 3 PASSED: 1,000 fresh ticks processed with 0 false-positive staleness rejections!\n");
        // ------------------------------------------------------------------------------------------
        console.log("[STAGE 4] Testing SOTA 2026 Adaptive Staleness Guard (EWMA Jitter Compensation)...");
        // Case A: Non-Colocated Packet (1500ms latency - MUST BE ACCEPTED under Adaptive Ceiling >= 2500ms)
        const nonColocatedTs = BigInt(timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs() - 1500) * 1000000n;
        Atomics.store(bigIntView, 0, nonColocatedTs);
        Atomics.store(bigIntView, 92, 1001n);
        const nonColocatedResult = engine.evaluateTick();
        console.log(`  Non-Colocated Packet (1500ms) Result: ReasonCode=${nonColocatedResult.riskResult?.reasonCode || "ACCEPTED"}`);
        if (nonColocatedResult.riskResult?.reasonCode === "REJECTED_STALE_ORDERBOOK") {
            throw new Error("FAIL: Non-colocated packet (1500ms) was falsely rejected by staleness guard!");
        }
        console.log("  ✅ Non-colocated packet (1500ms latency) accepted cleanly by Adaptive Staleness Guard (Ceiling >= 2500ms)!");
        // Case B: Genuinely Stale Packet (7000ms old > 6000ms MAX_HARD_CAP threshold)
        const staleExchangeTs = BigInt(timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs() - 7000) * 1000000n;
        Atomics.store(bigIntView, 0, staleExchangeTs);
        Atomics.store(bigIntView, 92, 1002n);
        const staleResult = engine.evaluateTick();
        console.log(`  Genuinely Stale (7000ms) Result: ReasonCode=${String(staleResult.riskResult?.reasonCode)}`);
        if (staleResult.riskResult?.reasonCode !== "REJECTED_STALE_ORDERBOOK") {
            throw new Error("FAIL: Genuinely stale packet (7000ms) was NOT rejected!");
        }
        console.log("  ✅ Genuinely stale packet (7000ms > 6000ms cap) correctly rejected by SOTA Adaptive Staleness Guard!");
        // Case C: Packet with slight future timestamp (-50ms due to timer granularity/clock jitter)
        const futureJitterTs = BigInt(timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs() + 50) * 1000000n;
        Atomics.store(bigIntView, 0, futureJitterTs);
        Atomics.store(bigIntView, 92, 1003n);
        const futureResult = engine.evaluateTick();
        console.log(`  Future Jitter (-50ms) Result: ReasonCode=${futureResult.riskResult?.reasonCode || "ACCEPTED"}`);
        if (futureResult.riskResult?.reasonCode === "REJECTED_STALE_ORDERBOOK") {
            throw new Error("FAIL: Packet within bounded negative jitter window (-50ms) was incorrectly rejected!");
        }
        console.log("  ✅ Packet within bounded negative jitter window (-50ms >= -250ms floor) accepted cleanly!");
        // Case D: Excessive Future Timestamp (+5000ms in future -> corrupt clock/packet)
        const corruptFutureTs = BigInt(timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs() + 5000) * 1000000n;
        Atomics.store(bigIntView, 0, corruptFutureTs);
        Atomics.store(bigIntView, 92, 1004n);
        const corruptResult = engine.evaluateTick();
        console.log(`  Corrupt Future (+5000ms) Result: ReasonCode=${String(corruptResult.riskResult?.reasonCode)}`);
        if (corruptResult.riskResult?.reasonCode !== "REJECTED_STALE_ORDERBOOK") {
            throw new Error("FAIL: Corrupt future packet (+5000ms) was NOT rejected!");
        }
        console.log("  ✅ Corrupt future packet (< -250ms floor) correctly rejected by SOTA Adaptive Staleness Guard!");
        console.log("  ✅ STAGE 4 PASSED: SOTA 2026 Adaptive Staleness Guard (EWMA Jitter) fully verified!\n");
        // ------------------------------------------------------------------------------------------
        console.log("[STAGE 5] Testing BinanceExecutionClient REST Signature & Falsy Trap Fix (DEF-1402)...");
        const queryString = mockExecClient.signQuery({ symbol: "BTCUSDT", side: "BUY" });
        const params = new URLSearchParams(queryString);
        const rawTimestamp = params.get("timestamp");
        if (!rawTimestamp) {
            throw new Error("FAIL: Signed query missing timestamp parameter!");
        }
        const queryTimestamp = parseInt(rawTimestamp, 10);
        const expectedTimestamp = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs();
        const signatureTimeDiff = Math.abs(queryTimestamp - expectedTimestamp);
        console.log(`  Signed Query Timestamp: ${String(queryTimestamp)}`);
        console.log(`  Expected Adjusted Now:  ${String(expectedTimestamp)} (Diff: ${String(signatureTimeDiff)}ms)`);
        if (signatureTimeDiff > 5) {
            throw new Error(`FAIL: Signed query timestamp deviates from TimeSynchronizer (${String(signatureTimeDiff)}ms > 5ms)!`);
        }
        // Test DEF-1402: Verify getTimeOffset() returns 0 when offset is 0 without falsy fallback
        timeSynchronizer_1.timeSynchronizer.setManualOffsetMs(0);
        const zeroOffset = mockExecClient.getTimeOffset();
        if (zeroOffset !== 0) {
            throw new Error(`FAIL: DEF-1402 falsy trap! Expected offset 0, got ${String(zeroOffset)}`);
        }
        timeSynchronizer_1.timeSynchronizer.setManualOffsetMs(-1500);
        const negativeOffset = mockExecClient.getTimeOffset();
        if (negativeOffset !== -1500) {
            throw new Error(`FAIL: Expected offset -1500, got ${String(negativeOffset)}`);
        }
        console.log("  ✅ STAGE 5 PASSED: REST API query signatures & 0ms offset falsy trap thoroughly verified!\n");
        console.log("==========================================================================================");
        console.log("  🎉 ALL 5 STAGES OF AUDIT 14.0 DEFECT REMEDIATION & TEMPORAL ENGINE PASSED 100%!");
        console.log("==========================================================================================");
    }
    finally {
        engine.destroy();
        mockExecClient.destroy();
    }
}
runClockSyncAndStalenessTests().catch((err) => {
    console.error("TEST FAILED:", err);
    process.exit(1);
});
