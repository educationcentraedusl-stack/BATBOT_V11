"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const positionLedger_1 = require("../strategy/positionLedger");
function assert(condition, message) {
    if (!condition) {
        throw new Error(`[ASSERTION_FAILED] ${message}`);
    }
}
async function runSotaStepCollarRoeRatchetTestSuite() {
    console.log("================================================================================");
    console.log("  BATBOT_V11 SOTA: STEP-COLLAR ROE RATCHET VERIFICATION TEST SUITE");
    console.log("  - Tier 1 (+8.0% Net ROE -> Lock Entry + Round-Trip Fees)");
    console.log("  - Tier 2 (+15.0% Net ROE -> Lock +10.0% Net ROE)");
    console.log("  - Tier 3 (>= +25.0% Net ROE -> Aggressive 70% Trailing Profit Collar)");
    console.log("  - Monotonic Ratchet Guarantee (Zero-Retreat Defense)");
    console.log("================================================================================\n");
    const symbol = "BTCUSDT";
    const ledger = new positionLedger_1.HedgePositionLedger(symbol, 3);
    ledger.setLeverage(10); // Enforce 10x leverage for precise ROE calculation
    // -----------------------------------------------------------------------------------------
    // TEST 1: LONG Position Multi-Tier ROE Ratchet & Monotonic Ratchet Guarantee
    // -----------------------------------------------------------------------------------------
    console.log("[TEST 1] Testing LONG Position Multi-Tier ROE Ratchet & Monotonic Ratchet...");
    const entryPrice = 60000.0;
    const quantity = 0.1;
    // Occupy CORE_LONG (initial SL 1.00%, initial TP 2.50%)
    ledger.occupyCoreLong(quantity, entryPrice, 2.50, 1.00);
    let summary = ledger.getSummary();
    assert(summary.longQuantity === quantity, "Long quantity should match initial entry");
    assert(summary.longAverageEntryPrice === entryPrice, "Long entry price should match");
    // Tick 1: Small profit (+2.0% ROE with 10x lev => +0.20% price move => $60,120)
    // Below Tier 1 (+8.0% ROE) -> No Step-Collar activation
    let triggers = ledger.evaluateHedgeDynamicTpSl(60120.0, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, Date.now());
    assert(triggers.length === 0, "No triggers should fire at +2.0% ROE");
    let slot = ledger.getCoreLong();
    assert(slot.isOccupied === true, "Core long slot must be active");
    assert(slot.stepCollarTier === undefined || slot.stepCollarTier === 0, "StepCollar tier should remain 0 below +8% ROE");
    console.log("  ✓ Tick 1 ($60,120, +2.0% ROE): Step-Collar un-triggered, position holding");
    // Tick 2: Trigger Tier 1 (+8.0% Net ROE => +0.80% price move => $60,480)
    triggers = ledger.evaluateHedgeDynamicTpSl(60480.0, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, Date.now());
    assert(triggers.length === 0, "Position should not exit at Tier 1 trigger");
    slot = ledger.getCoreLong();
    assert(slot.stepCollarTier === 1, `StepCollar tier should be 1, got ${slot.stepCollarTier}`);
    assert(slot.breakEvenLocked === true, "breakEvenLocked must be true at Tier 1");
    assert(slot.stopLossPrice > entryPrice, `Stop Loss ($${slot.stopLossPrice}) must be locked above entry ($${entryPrice})`);
    const tier1Sl = slot.stopLossPrice;
    console.log(`  ✓ Tick 2 ($60,480, +8.0% ROE): Tier 1 Active! SL ratcheted to $${tier1Sl.toFixed(2)} (Entry + Fees)`);
    // Tick 3: Trigger Tier 2 (+15.0% Net ROE => +1.50% price move => $60,900)
    triggers = ledger.evaluateHedgeDynamicTpSl(60900.0, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, Date.now());
    assert(triggers.length === 0, "Position should not exit at Tier 2 trigger");
    slot = ledger.getCoreLong();
    assert(slot.stepCollarTier === 2, `StepCollar tier should be 2, got ${slot.stepCollarTier}`);
    // Tier 2 locks in +10% ROE: 10% / 10x lev = 1.0% above entry => $60,600
    assert(slot.stopLossPrice >= 60600.0, `Stop Loss ($${slot.stopLossPrice}) must be >= $60,600 (+10% ROE lock)`);
    const tier2Sl = slot.stopLossPrice;
    console.log(`  ✓ Tick 3 ($60,900, +15.0% ROE): Tier 2 Active! SL ratcheted to $${tier2Sl.toFixed(2)} (+10.0% ROE locked)`);
    // Tick 4: Trigger Tier 3 (Peak +30.0% ROE => +3.00% price move => $61,800)
    triggers = ledger.evaluateHedgeDynamicTpSl(61800.0, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, Date.now());
    slot = ledger.getCoreLong();
    assert(slot.stepCollarTier === 3, `StepCollar tier should be 3, got ${slot.stepCollarTier}`);
    // 70% of +30.0% Peak ROE = +21.0% ROE lock => 2.10% above entry => $61,260
    assert(slot.stopLossPrice >= 61260.0, `Tier 3 SL ($${slot.stopLossPrice}) must trail at 70% of peak ROE (>= $61,260)`);
    const tier3Sl = slot.stopLossPrice;
    console.log(`  ✓ Tick 4 ($61,800, +30.0% ROE): Tier 3 Active! SL ratcheted to $${tier3Sl.toFixed(2)} (70% Peak Trail)`);
    // Tick 5: Monotonic Ratchet Guarantee (Price pulls back to $61,350, +22.5% ROE)
    triggers = ledger.evaluateHedgeDynamicTpSl(61350.0, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, Date.now());
    slot = ledger.getCoreLong();
    assert(slot.stopLossPrice === tier3Sl, `Stop Loss must remain strictly monotonically locked at $${tier3Sl}, got $${slot.stopLossPrice}`);
    console.log(`  ✓ Tick 5 ($61,350 pullback): Monotonic Ratchet verified! SL maintained at $${slot.stopLossPrice.toFixed(2)}`);
    // Tick 6: Stop Loss Execution when price drops to $61,250 (below $61,260 SL)
    triggers = ledger.evaluateHedgeDynamicTpSl(61250.0, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, Date.now());
    assert(triggers.length > 0, "Stop Loss trigger must fire when price breaches ratcheted SL");
    assert(triggers[0].reason === "STOP_LOSS" || triggers[0].reason === "BREAK_EVEN_STOP_LOSS", `Exit reason must be STOP_LOSS or BREAK_EVEN_STOP_LOSS, got ${triggers[0].reason}`);
    console.log(`  ✓ Tick 6 ($61,250): Stop-Loss triggered (${triggers[0].reason})! Protected Net Profit Realized with ROE Lock.\n`);
    ledger.releaseCoreLong();
    // -----------------------------------------------------------------------------------------
    // TEST 2: SHORT Position Symmetry & Step-Collar Multi-Tier Verification
    // -----------------------------------------------------------------------------------------
    console.log("[TEST 2] Testing SHORT Position Multi-Tier ROE Ratchet Symmetry...");
    ledger.occupyShortSlot(0, quantity, entryPrice, 2.50, 1.00);
    // Short Tier 1: Price drops to $59,520 (+8.0% ROE)
    triggers = ledger.evaluateHedgeDynamicTpSl(59520.0, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, Date.now());
    let shortSlot = ledger.getShortSlots()[0];
    assert(shortSlot.stepCollarTier === 1, `Short StepCollar tier should be 1, got ${shortSlot.stepCollarTier}`);
    assert(shortSlot.stopLossPrice < entryPrice, `Short SL ($${shortSlot.stopLossPrice}) must be locked below entry ($${entryPrice})`);
    console.log(`  ✓ Short Tier 1 ($59,520): SL locked at $${shortSlot.stopLossPrice.toFixed(2)} (Entry - Fees)`);
    // Short Tier 2: Price drops to $59,100 (+15.0% ROE)
    triggers = ledger.evaluateHedgeDynamicTpSl(59100.0, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, Date.now());
    shortSlot = ledger.getShortSlots()[0];
    assert(shortSlot.stepCollarTier === 2, `Short StepCollar tier should be 2, got ${shortSlot.stepCollarTier}`);
    assert(shortSlot.stopLossPrice <= 59400.0, `Short Tier 2 SL ($${shortSlot.stopLossPrice}) must lock +10% ROE (<= $59,400)`);
    console.log(`  ✓ Short Tier 2 ($59,100): SL locked at $${shortSlot.stopLossPrice.toFixed(2)} (+10% ROE Locked)`);
    // Short Tier 3: Price drops to $58,200 (+30.0% Peak ROE)
    triggers = ledger.evaluateHedgeDynamicTpSl(58200.0, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, Date.now());
    shortSlot = ledger.getShortSlots()[0];
    assert(shortSlot.stepCollarTier === 3, `Short StepCollar tier should be 3, got ${shortSlot.stepCollarTier}`);
    // 70% of +30.0% ROE = +21.0% ROE -> 2.10% below entry => $58,740
    assert(shortSlot.stopLossPrice <= 58740.0, `Short Tier 3 SL ($${shortSlot.stopLossPrice}) must trail at 70% of peak ROE`);
    const shortTier3Sl = shortSlot.stopLossPrice;
    console.log(`  ✓ Short Tier 3 ($58,200): SL ratcheted to $${shortTier3Sl.toFixed(2)} (70% Peak Trail)`);
    // Short Monotonic Ratchet Guarantee: Price bounces back up to $58,600
    triggers = ledger.evaluateHedgeDynamicTpSl(58600.0, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, Date.now());
    shortSlot = ledger.getShortSlots()[0];
    assert(shortSlot.stopLossPrice === shortTier3Sl, `Short SL must not retreat, expected $${shortTier3Sl}, got ${shortSlot.stopLossPrice}`);
    console.log(`  ✓ Short Bounce ($58,600): Monotonic Ratchet verified! SL maintained at $${shortSlot.stopLossPrice.toFixed(2)}\n`);
    ledger.releaseShortSlot(0);
    // -----------------------------------------------------------------------------------------
    // TEST 3: Micro-Latency Benchmark (100,000 Ticks)
    // -----------------------------------------------------------------------------------------
    console.log("[TEST 3] Running 100,000-Tick Step-Collar Evaluation Latency Benchmark...");
    ledger.occupyCoreLong(quantity, entryPrice, 2.50, 1.00);
    const iterations = 100_000;
    const nowMs = Date.now();
    // V8 JIT Warmup Loop
    for (let w = 0; w < 10_000; w++) {
        const syntheticPrice = 60000.0 + (w % 800);
        ledger.evaluateHedgeDynamicTpSl(syntheticPrice, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, nowMs);
    }
    const startHr = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        const syntheticPrice = 60000.0 + (i % 800);
        ledger.evaluateHedgeDynamicTpSl(syntheticPrice, 0.0, 0.5, 0.2, 0.5, 0.002, 0.0, nowMs);
    }
    const endHr = process.hrtime.bigint();
    const totalNs = Number(endHr - startHr);
    const avgUs = (totalNs / iterations) / 1000.0;
    console.log(`  ✓ Executed ${iterations.toLocaleString()} ticks in ${(totalNs / 1e6).toFixed(2)} ms`);
    console.log(`  ✓ Average Evaluation Latency: ${avgUs.toFixed(3)} µs / tick (< 1.500 µs HFT constraint)\n`);
    assert(avgUs < 1.50, `Average latency (${avgUs.toFixed(3)} µs) exceeds 1.500 µs HFT constraint`);
    ledger.releaseCoreLong();
    console.log("================================================================================");
    console.log("  ALL SOTA STEP-COLLAR ROE RATCHET TESTS PASSED SUCCESSFULLY! (100% VERIFIED)");
    console.log("================================================================================");
}
runSotaStepCollarRoeRatchetTestSuite().catch((err) => {
    console.error("FATAL TEST FAILURE:", err);
    process.exit(1);
});
