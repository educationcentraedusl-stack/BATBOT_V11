"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const marketDataClient_1 = require("./marketDataClient");
const engine_1 = require("./strategy/engine");
const positionLedger_1 = require("./strategy/positionLedger");
const risk_1 = require("./strategy/risk");
const binance_1 = require("./execution/binance");
const BITCAST_BUF = new ArrayBuffer(8);
const BITCAST_BIGINT = new BigInt64Array(BITCAST_BUF);
const BITCAST_FLOAT = new Float64Array(BITCAST_BUF);
function storeAtomicFloat64(view, slot, value) {
    BITCAST_FLOAT[0] = value;
    const rawBits = BITCAST_BIGINT[0];
    Atomics.store(view, slot, rawBits);
}
async function runMicroburstMitigationTests() {
    console.log("=================================================");
    console.log("BATBOT_V11 MICRO-BURST EXECUTION MITIGATION SUITE");
    console.log("=================================================");
    // -------------------------------------------------------------------
    // TEST 1: Volatility-Adjusted Dynamic Grid Spacing (VADGS)
    // -------------------------------------------------------------------
    console.log("\n[TEST 1] Testing Volatility-Adjusted Dynamic Grid Spacing (VADGS)...");
    const ledger = new positionLedger_1.HedgePositionLedger("BTCUSDT", 3);
    const price = 67000.0;
    const tickSize = 0.1;
    const vol = 0.005;
    const hawkes = 2.0;
    // Slot 0 allocation
    const alloc0 = ledger.evaluateDispersedShortSlotAllocation(price, tickSize, vol, hawkes, 0, 1000);
    if (!alloc0 || alloc0.slotIndex !== 0 || alloc0.sizeDecayCoeff !== 1.0) {
        throw new Error("FAIL: Slot 0 allocation failed or size decay coefficient incorrect!");
    }
    console.log("  ✓ Slot 0 allocated with 1.0x sizing.");
    // Occupy Slot 0 at 67000.0
    ledger.occupyShortSlot(0, 0.01, price, 1.5, 1.0);
    // Attempt Slot 1 allocation at EXACT SAME price 67000.0 (co-location collision)
    const alloc1SamePrice = ledger.evaluateDispersedShortSlotAllocation(price, tickSize, vol, hawkes, 0, 1001);
    if (alloc1SamePrice !== null) {
        throw new Error("FAIL: Spatial co-location collision allowed multi-slot fill at identical price!");
    }
    console.log("  ✓ Multi-slot co-location fill at identical price SUCCESSFULLY BLOCKED!");
    // Attempt Slot 1 allocation with sufficient dynamic spacing (e.g. at 67010.0)
    const alloc1SpacedPrice = ledger.evaluateDispersedShortSlotAllocation(67010.0, tickSize, vol, hawkes, 0, 1001);
    if (!alloc1SpacedPrice || alloc1SpacedPrice.slotIndex !== 1 || alloc1SpacedPrice.sizeDecayCoeff !== 0.75) {
        throw new Error("FAIL: Dynamic spacing allocation for Slot 1 failed!");
    }
    console.log("  ✓ Slot 1 allocated at spaced price with 0.75x sizing decay.");
    // -------------------------------------------------------------------
    // TEST 2: Time-Weighted Cooldown Hysteresis Lockout (TWCHL)
    // -------------------------------------------------------------------
    console.log("\n[TEST 2] Testing Time-Weighted Cooldown Hysteresis Lockout (TWCHL)...");
    const lockExpiryMs = 5000;
    const allocLocked = ledger.evaluateDispersedShortSlotAllocation(price, 0.1, 0.001, 0, lockExpiryMs, 4000);
    if (allocLocked !== null) {
        throw new Error("FAIL: Temporal hysteresis cooldown lock failed to block execution!");
    }
    console.log("  ✓ Temporal lock active: execution correctly blocked.");
    const allocUnlocked = ledger.evaluateDispersedShortSlotAllocation(67020.0, 0.1, 0.001, 0, lockExpiryMs, 5001);
    if (!allocUnlocked || allocUnlocked.slotIndex !== 1) {
        throw new Error("FAIL: Allocation failed after temporal lock expiration!");
    }
    console.log("  ✓ Lock expired: execution correctly allowed.");
    // -------------------------------------------------------------------
    // TEST 3: Strategy Engine Sub-Millisecond Microburst Suppression
    // -------------------------------------------------------------------
    console.log("\n[TEST 3] Testing Strategy Engine Sub-Millisecond Microburst Suppression...");
    const sab = new SharedArrayBuffer(2048);
    const bigIntView = new BigInt64Array(sab);
    const client = new marketDataClient_1.MarketDataClient(sab);
    const riskGuard = new risk_1.RiskGuard();
    const execClient = new binance_1.BinanceExecutionClient({ apiKey: "", apiSecret: "" });
    const engine = new engine_1.StrategyEngine(client, riskGuard, execClient, {
        symbol: "BTCUSDT",
        orderQuantity: 0.01,
        tickSize: 0.1,
        obiBuyThreshold: 0.2,
        obiSellThreshold: -0.2,
        cvdBuyThreshold: 10.0,
        cvdSellThreshold: -10.0,
        maxSpreadVelocity: 0.05,
        minAiConfidence: 0.5,
        aggressiveConfidenceThreshold: 0.85,
        takeProfitPercent: 1.5,
        stopLossPercent: 1.0,
        longTakeProfitPercent: 1.5,
        longStopLossPercent: 1.0,
        shortTakeProfitPercent: 1.5,
        shortStopLossPercent: 1.0,
        dailyProfitLockUsdt: 50.0,
        maxShortSlots: 3,
        leverageMultiplier: 5,
    });
    // Populate SAB to simulate strong SELL signal during microburst
    Atomics.store(bigIntView, 92, 100n);
    storeAtomicFloat64(bigIntView, 1, -0.6); // OBI = -0.6
    storeAtomicFloat64(bigIntView, 2, -50.0); // CVD = -50.0
    storeAtomicFloat64(bigIntView, 3, 0.01);
    storeAtomicFloat64(bigIntView, 4, 67000.0); // Best Bid
    storeAtomicFloat64(bigIntView, 6, 67000.1); // Best Ask
    storeAtomicFloat64(bigIntView, 93, -1.0); // AI Direction = SHORT
    storeAtomicFloat64(bigIntView, 94, 0.85); // AI Confidence
    // Tick 1: Expect SELL signal for SHORT_SLOT_0
    const res1 = engine.evaluateTick();
    if (res1.signalType !== "SELL" || res1.slotId !== "SHORT_SLOT_0") {
        throw new Error(`FAIL: Tick 1 expected SELL signal for SHORT_SLOT_0, got ${res1.signalType} (${res1.slotId})`);
    }
    console.log("  ✓ Tick 1: Generated SELL signal for SHORT_SLOT_0.");
    // Occupy SHORT_SLOT_0 in engine's position ledger
    engine.getHedgeLedger().occupyShortSlot(0, 0.01, 67000.0, 1.5, 1.0);
    // Tick 2 (microburst microsecond tick at exact same bid price 67000.0)
    Atomics.store(bigIntView, 92, 101n);
    const res2 = engine.evaluateTick();
    if (res2.signalType !== "NONE") {
        throw new Error(`FAIL: Tick 2 microburst fill should be suppressed, got signal ${res2.signalType}`);
    }
    console.log("  ✓ Tick 2: Microburst co-located fill at identical price SUCCESSFULLY SUPPRESSED!");
    console.log("\n=================================================");
    console.log("✅ ALL MICRO-BURST MITIGATION VERIFICATION TESTS PASSED!");
    console.log("=================================================");
}
runMicroburstMitigationTests().catch((err) => {
    console.error(err);
    process.exit(1);
});
