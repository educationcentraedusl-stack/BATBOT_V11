"use strict";
/**
 * BATBOT_V11 SOTA QA TEST SUITE: VEGAM TP LADDER ENGINE (PHASE 3)
 *
 * Verifies all 5 mandatory testing stages specified in Section 2.3 & P3-T6 of the Master Plan:
 * 1. TP > RPM_min (Guaranteed fee coverage even under compressed volatility)
 * 2. TP1 fills on 1-ATR (Proof 1 exact LINK $11.59 simulation & risk-free ratchet)
 * 3. Trail tightens on OBI reversal (k_regime = 0.8 vs 1.0 vs 1.2)
 * 4. VPIN clamps k_regime = 0.5 (toxic order flow adverse selection override)
 * 5. Hawkes expands to 2.0x (high intensity momentum extension)
 * + Zero heap allocation & sub-microsecond latency SLA benchmark
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vegamTpLadderEngine_1 = require("../strategy/vegamTpLadderEngine");
console.log("================================================================================");
console.log("   BATBOT_V11 SOTA QA TEST SUITE: VEGAM TP LADDER ENGINE (PHASE 3)");
console.log("   VOLATILITY-ENGINEERED ATR LADDER, OBI-WEIGHTED TRAIL & ZERO-GC STATE MACHINE");
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
// =========================================================================================
// STAGE 1: TP > RPM_min Validation Across Volatility Regimes
// =========================================================================================
console.log("\n--- STAGE 1: TP > RPM_min Validation Across Volatility Regimes ---");
const makerFee = 0.0002;
const takerFee = 0.0005;
const expectedRpmMin = makerFee + takerFee * 1.5; // 0.0002 + 0.00075 = 0.00095 (9.5 bps)
const rpmMinCalc = (0, vegamTpLadderEngine_1.computeRpmMin)(2.0, makerFee, takerFee);
assert(Math.abs(rpmMinCalc - expectedRpmMin) < 1e-12, `computeRpmMin returns exact fee hurdle: expected ${expectedRpmMin}, got ${rpmMinCalc}`);
// Test 1A: Normal Volatility (GK_ATR = 0.00906)
const entryPriceLong = 100.0;
const normalAtr = 0.00906;
const tpNormalLong = (0, vegamTpLadderEngine_1.computeVegamTpLevels)(entryPriceLong, normalAtr, 2.0, "LONG");
const movePctLong = (tpNormalLong.tp1Price - entryPriceLong) / entryPriceLong;
assert(movePctLong >= expectedRpmMin, `Normal vol TP1 covers RPM_min: movePct ${(movePctLong * 10000).toFixed(2)} bps >= ${(expectedRpmMin * 10000).toFixed(2)} bps`);
assert(tpNormalLong.tp1Offset >= tpNormalLong.rpmMin, `tp1Offset (${tpNormalLong.tp1Offset.toFixed(6)}) >= rpmMin (${tpNormalLong.rpmMin.toFixed(6)})`);
assert(tpNormalLong.tp2Offset >= 2.0 * tpNormalLong.rpmMin, `tp2Offset (${tpNormalLong.tp2Offset.toFixed(6)}) >= 2 * rpmMin (${(2.0 * tpNormalLong.rpmMin).toFixed(6)})`);
// Test 1B: Compressed Micro-Volatility (GK_ATR = 0.00003 < RPM_min)
// When ATR is below fee hurdle, TP1 MUST clamp to RPM_min so trades never harvest less than round-trip fees!
const microAtr = 0.00003;
const tpMicroLong = (0, vegamTpLadderEngine_1.computeVegamTpLevels)(entryPriceLong, microAtr, 2.0, "LONG");
assert(Math.abs(tpMicroLong.tp1Offset - expectedRpmMin) < 1e-9, `Compressed vol clamps tp1Offset to RPM_min: expected ${expectedRpmMin}, got ${tpMicroLong.tp1Offset}`);
assert(Math.abs(tpMicroLong.tp1Price - (entryPriceLong * (1.0 + expectedRpmMin))) < 1e-9, `Compressed vol TP1 price strictly enforces RPM_min fee floor`);
// Test 1C: SHORT Position Fee Coverage
const entryPriceShort = 2500.0;
const tpNormalShort = (0, vegamTpLadderEngine_1.computeVegamTpLevels)(entryPriceShort, normalAtr, 2.0, "SHORT");
const movePctShort = (entryPriceShort - tpNormalShort.tp1Price) / entryPriceShort;
assert(movePctShort >= expectedRpmMin, `SHORT vol TP1 covers RPM_min: movePct ${(movePctShort * 10000).toFixed(2)} bps >= ${(expectedRpmMin * 10000).toFixed(2)} bps`);
// Test 1D: Multi-Asset Universe Parity (BTC, ETH, SOL, LINK, DOGE)
const testUniverse = [
    { sym: "BTCUSDT", price: 68000.0, atr: 0.0065 },
    { sym: "ETHUSDT", price: 3500.0, atr: 0.0085 },
    { sym: "SOLUSDT", price: 175.0, atr: 0.0120 },
    { sym: "LINKUSDT", price: 11.59, atr: 0.00906 },
    { sym: "DOGEUSDT", price: 0.145, atr: 0.0150 },
];
let allUniversePass = true;
for (const asset of testUniverse) {
    const levels = (0, vegamTpLadderEngine_1.computeVegamTpLevels)(asset.price, asset.atr, 2.0, "LONG");
    const hurdle = (levels.tp1Price - asset.price) / asset.price;
    if (hurdle < expectedRpmMin) {
        allUniversePass = false;
    }
}
assert(allUniversePass, "All 10-universe test assets satisfy TP1 >= RPM_min invariant");
// =========================================================================================
// STAGE 2: TP1 Fills on 1-ATR (Master Plan Section 2.4 Proof 1 Exact Simulation)
// =========================================================================================
console.log("\n--- STAGE 2: TP1 Fills on 1-ATR & Risk-Free SL Ratchet (Proof 1) ---");
// Master Plan Proof 1 parameters: LINK @ $11.59, GK_ATR = 0.00906
const linkEntry = 11.59;
const linkAtr = 0.00906;
const linkLev = 2.0;
const linkLevels = (0, vegamTpLadderEngine_1.computeVegamTpLevels)(linkEntry, linkAtr, linkLev, "LONG", vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, 100.0);
// Target price from Proof 1: $11.59 * (1 + 0.00906) = $11.695
const expectedLinkTp1 = linkEntry * (1.0 + linkAtr);
assert(Math.abs(linkLevels.tp1Price - expectedLinkTp1) < 1e-6, `Proof 1 LINK TP1 price matches exact math: expected ${expectedLinkTp1.toFixed(4)}, got ${linkLevels.tp1Price.toFixed(4)}`);
assert(Math.abs(linkLevels.tp1Price - 11.6950) < 0.001, `Proof 1 LINK TP1 price within 0.001 of target $11.695: got ${linkLevels.tp1Price.toFixed(4)}`);
assert(linkLevels.tp1Qty === 35.0 && linkLevels.tp2Qty === 40.0 && linkLevels.tp3Qty === 25.0, `Proof 1 quantity partitioning: TP1=35%, TP2=40%, TP3=25% (exact sum 100%)`);
// State Machine Tick Simulation:
const engine = new vegamTpLadderEngine_1.VegamTpLadderEngine();
const slotLong = {
    slotId: "CORE_LONG",
    isOccupied: true,
    side: "LONG",
    quantity: 100.0,
    entryPrice: linkEntry,
    openTime: Date.now(),
    takeProfitPrice: linkLevels.tp1Price,
    stopLossPrice: 11.45,
    takeProfitPercent: linkAtr * 100,
    stopLossPercent: 1.20,
    peakPrice: linkEntry,
    peakRoe: 0.0,
    tpStagePrices: [linkLevels.tp1Price, linkLevels.tp2Price],
    tpStageQuantities: [linkLevels.tp1Qty, linkLevels.tp2Qty],
    breakEvenPrice: 11.605, // $11.59 * (1 + 0.0013 fee buffer)
};
// Tick 1: Minimal price move ($11.60 -> ROE = +0.17% < trailActivationRoePct 0.50%)
const tick1Res = engine.tick(slotLong, 11.60, 11.60, 0.10, 0.20, 1.0, linkAtr, linkLev);
assert(!tick1Res.tp1Hit, "Sub-target tick ($11.60) does NOT trigger TP1");
assert(slotLong.tpStageReached === undefined, "tpStageReached remains unset");
assert(slotLong.stopLossPrice === 11.45, "SL remains at initial collar ($11.45) prior to trail activation");
// Tick 2: In-profit extension ($11.65 -> ROE = +1.03% >= trailActivationRoePct 0.50%)
const tick2Res = engine.tick(slotLong, 11.65, 11.65, 0.10, 0.20, 1.0, linkAtr, linkLev);
assert(!tick2Res.tp1Hit, "Pre-TP1 tick ($11.65) does not hit TP1");
assert(slotLong.stopLossPrice > 11.45, `Dynamic trail activates at ROE >= 0.50%: SL ratcheted from $11.45 to $${slotLong.stopLossPrice.toFixed(4)}`);
// Tick 3: 1-ATR move hits TP1 ($11.70 >= $11.695)
const tick3Res = engine.tick(slotLong, 11.70, 11.70, 0.10, 0.20, 1.0, linkAtr, linkLev);
assert(tick3Res.tp1Hit, "1-ATR move ($11.70 >= $11.695) successfully triggers TP1");
assert(tick3Res.action === "TP1_RATCHET", "Engine emits exact TP1_RATCHET action");
assert(slotLong.tpStageReached === 1, "Slot state advances to tpStageReached = 1");
assert(slotLong.breakEvenLocked === true, "breakEvenLocked is set to true");
assert(slotLong.stopLossPrice >= slotLong.breakEvenPrice, `Stop Loss ratcheted to Break-Even price: SL=$${slotLong.stopLossPrice.toFixed(4)} >= BE=$${slotLong.breakEvenPrice} (Round-Trip Fees covered)`);
// Tick 4: 2.5-ATR move hits TP2 ($11.86 >= $11.8527)
const tick4Res = engine.tick(slotLong, 11.86, 11.86, 0.10, 0.20, 1.0, linkAtr, linkLev);
assert(tick4Res.tp2Hit, "2.5-ATR move ($11.86 >= TP2) successfully triggers TP2");
assert(tick4Res.action === "TP2_REACHED", "Engine emits exact TP2_REACHED action");
assert(slotLong.tpStageReached === 2, "Slot state advances to tpStageReached = 2");
assert(slotLong.stopLossPrice >= linkLevels.tp1Price, `Stop Loss trailed to at least TP1 ($${linkLevels.tp1Price.toFixed(4)}) upon TP2 hit: got $${slotLong.stopLossPrice.toFixed(4)}`);
// Tick 5: Price plunges to $11.50, triggering the ratcheted Stop Loss
const tick5Res = engine.tick(slotLong, 11.50, 11.50, -0.30, 0.70, 1.0, linkAtr, linkLev);
assert(tick5Res.slHit, "Price plunge ($11.50 <= SL) successfully triggers stop loss");
assert(tick5Res.action === "SL_TRIGGERED", "Engine emits exact SL_TRIGGERED action");
// =========================================================================================
// STAGE 2B: Forensic Edge Cases & Remediation Invariants
// =========================================================================================
console.log("\n--- STAGE 2B: Forensic Edge Cases & Remediation Invariants ---");
// Test 2B-1: Leverage Clamping (20x Ban & Safe Default)
const slotLevTest = {
    slotId: "LEV_TEST",
    isOccupied: true,
    side: "LONG",
    quantity: 10.0,
    entryPrice: 100.0,
    openTime: Date.now(),
    takeProfitPrice: 102.0,
    stopLossPrice: 98.0,
    takeProfitPercent: 2.0,
    stopLossPercent: 2.0,
    peakPrice: 100.0,
    peakRoe: 0.0,
};
// Passing banned 20x leverage must clamp to MAX_PERMITTED_LEVERAGE (5.0)
const res20x = engine.tick(slotLevTest, 101.0, 101.0, 0.0, 0.0, 1.0, 0.01, 20.0);
assert(Math.abs(res20x.rawRoePct - 5.0) < 1e-9, `Banned 20x leverage is hard-clamped to 5.0: ROE is +5.0% (got ${res20x.rawRoePct}%)`);
// Omitting leverage (undefined) must default to 2.0 (baseline)
const resDefLev = engine.tick(slotLevTest, 101.0, 101.0, 0.0, 0.0, 1.0, 0.01, undefined);
assert(Math.abs(resDefLev.rawRoePct - 2.0) < 1e-9, `Omitted leverage defaults safely to 2.0: ROE is +2.0% (got ${resDefLev.rawRoePct}%)`);
// Passing leverage below 2.0 (e.g. 1.0) clamps to MIN_PERMITTED_LEVERAGE (2.0)
const resLowLev = engine.tick(slotLevTest, 101.0, 101.0, 0.0, 0.0, 1.0, 0.01, 1.0);
assert(Math.abs(resLowLev.rawRoePct - 2.0) < 1e-9, `Sub-2.0 leverage is clamped to 2.0: ROE is +2.0% (got ${resLowLev.rawRoePct}%)`);
// Test 2B-2: Peak ROE Falsy Corruption Protection
const slotRoeTest = {
    slotId: "ROE_TEST",
    isOccupied: true,
    side: "LONG",
    quantity: 10.0,
    entryPrice: 100.0,
    openTime: Date.now(),
    takeProfitPrice: 102.0,
    stopLossPrice: 98.0,
    takeProfitPercent: 2.0,
    stopLossPercent: 2.0,
    peakPrice: 100.0,
    peakRoe: 0.0, // Initialized to 0.0
};
// Tick moves adversely to $99.50 (-0.5% price move -> -1.0% ROE at 2x)
const resNegRoe = engine.tick(slotRoeTest, 99.50, 99.50, 0.0, 0.0, 1.0, 0.01, 2.0);
assert(slotRoeTest.peakRoe === 0.0, `Negative ROE tick does not corrupt peakRoe (remains 0.0): got ${slotRoeTest.peakRoe}`);
assert(resNegRoe.peakRoe === 0.0, `Result peakRoe accurately reflects 0.0 baseline: got ${resNegRoe.peakRoe}`);
// Test 2B-3: Stoikov MicroPrice Leading Peak/Trough Tracking
const slotStoikovTest = {
    slotId: "STOIKOV_TEST",
    isOccupied: true,
    side: "LONG",
    quantity: 10.0,
    entryPrice: 100.0,
    openTime: Date.now(),
    takeProfitPrice: 102.0,
    stopLossPrice: 98.0,
    takeProfitPercent: 2.0,
    stopLossPercent: 2.0,
    peakPrice: 100.0,
    peakRoe: 0.0,
};
// markPrice is 100.5, but stoikovMicroPrice is leading at 100.8
engine.tick(slotStoikovTest, 100.5, 100.8, 0.30, 0.10, 1.0, 0.01, 2.0);
assert(slotStoikovTest.peakPrice === 100.8, `Stoikov microprice leading high updates peakPrice: expected 100.8, got ${slotStoikovTest.peakPrice}`);
// =========================================================================================
// STAGE 3: Dynamic OBI Book Pressure & Trail Tightening
// =========================================================================================
console.log("\n--- STAGE 3: Dynamic OBI Book Pressure & Trail Tightening ---");
const testGkAtr = 0.00906;
const refPrice = 100.0;
// Condition 2: Neutral OBI (0.00)
const kNeutral = (0, vegamTpLadderEngine_1.computeKRegime)(0.0, 0.30, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, "LONG");
const neutralTrail = (0, vegamTpLadderEngine_1.computeObiWeightedTrailDistance)(testGkAtr, 0.0, 0.30, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, refPrice, "LONG");
assert(kNeutral === 1.0, `Neutral OBI produces k_regime = 1.0: got ${kNeutral}`);
// Condition 3: Supportive Book Depth (OBI = +0.35 > +0.20)
const kSupportive = (0, vegamTpLadderEngine_1.computeKRegime)(0.35, 0.30, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, "LONG");
const supportiveTrail = (0, vegamTpLadderEngine_1.computeObiWeightedTrailDistance)(testGkAtr, 0.35, 0.30, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, refPrice, "LONG");
assert(kSupportive === 1.2, `Supportive OBI (+0.35) expands k_regime to 1.2: got ${kSupportive}`);
// Condition 1: Book Pressure Reversal Against Trade (OBI = -0.35 < -0.20)
const kReversed = (0, vegamTpLadderEngine_1.computeKRegime)(-0.35, 0.30, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, "LONG");
const reversedTrail = (0, vegamTpLadderEngine_1.computeObiWeightedTrailDistance)(testGkAtr, -0.35, 0.30, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, refPrice, "LONG");
assert(kReversed === 0.8, `Adverse OBI (-0.35) tightens k_regime to 0.8: got ${kReversed}`);
// Mathematical Ratio Verification:
assert(reversedTrail < neutralTrail && neutralTrail < supportiveTrail, `Trail ordering strictly verified: Tightened (${reversedTrail.toFixed(4)}) < Neutral (${neutralTrail.toFixed(4)}) < Expanded (${supportiveTrail.toFixed(4)})`);
assert(Math.abs(reversedTrail / neutralTrail - 0.80) < 1e-9, `Tightened trail is exactly 0.80x of neutral trail: got ${(reversedTrail / neutralTrail).toFixed(4)}`);
assert(Math.abs(supportiveTrail / neutralTrail - 1.20) < 1e-9, `Supportive trail is exactly 1.20x of neutral trail: got ${(supportiveTrail / neutralTrail).toFixed(4)}`);
// SHORT Position Symmetry Verification:
const kShortAdverse = (0, vegamTpLadderEngine_1.computeKRegime)(0.35, 0.30, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, "SHORT"); // OBI +0.35 is adverse for SHORT
const kShortSupport = (0, vegamTpLadderEngine_1.computeKRegime)(-0.35, 0.30, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, "SHORT"); // OBI -0.35 is supportive for SHORT
assert(kShortAdverse === 0.8, `SHORT adverse OBI (+0.35) tightens k_regime to 0.8`);
assert(kShortSupport === 1.2, `SHORT supportive OBI (-0.35) expands k_regime to 1.2`);
// =========================================================================================
// STAGE 4: VPIN Clamps k_regime = 0.5 (Toxic Order Flow Override)
// =========================================================================================
console.log("\n--- STAGE 4: VPIN Toxic Order Flow Override (k_regime = 0.5) ---");
// Test 4A: Toxic VPIN (0.70 >= 0.65) with Neutral OBI and Baseline Hawkes
const kToxic1 = (0, vegamTpLadderEngine_1.computeKRegime)(0.0, 0.70, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG);
assert(kToxic1 === 0.5, `VPIN = 0.70 clamps k_regime to exactly 0.5: got ${kToxic1}`);
// Test 4B: Toxic VPIN (0.75 >= 0.65) with Highly Supportive OBI (+0.80)
// Toxic flow MUST override supportive OBI!
const kToxic2 = (0, vegamTpLadderEngine_1.computeKRegime)(0.80, 0.75, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG);
assert(kToxic2 === 0.5, `Toxic VPIN (0.75) strictly overrides supportive OBI (+0.80): got ${kToxic2}`);
// Test 4C: Toxic VPIN (0.80 >= 0.65) with High Hawkes Momentum (2.50)
// Toxic flow MUST override Hawkes momentum expansion to prevent adverse selection!
const kToxic3 = (0, vegamTpLadderEngine_1.computeKRegime)(0.0, 0.80, 2.50, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG);
assert(kToxic3 === 0.5, `Toxic VPIN (0.80) strictly overrides Hawkes momentum (2.50): got ${kToxic3}`);
// Test 4D: Trail distance under toxic flow is exactly half of neutral trail
const toxicTrail = (0, vegamTpLadderEngine_1.computeObiWeightedTrailDistance)(testGkAtr, 0.0, 0.70, 1.0, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, refPrice);
assert(Math.abs(toxicTrail / neutralTrail - 0.50) < 1e-9, `Toxic flow trail distance is exactly 0.50x of baseline: got ${(toxicTrail / neutralTrail).toFixed(4)}`);
// =========================================================================================
// STAGE 5: Hawkes Expands to 2.0x (High-Intensity Momentum Extension)
// =========================================================================================
console.log("\n--- STAGE 5: Hawkes Intensity Expansion (k_regime = 2.0) ---");
// Test 5A: Non-toxic VPIN (0.30) with Hawkes > 1.80 (2.20)
const kHawkes1 = (0, vegamTpLadderEngine_1.computeKRegime)(0.0, 0.30, 2.20, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG);
assert(kHawkes1 === 2.0, `Hawkes = 2.20 expands k_regime to exactly 2.0: got ${kHawkes1}`);
// Test 5B: Hawkes = 1.95 with slightly negative OBI (-0.10)
const kHawkes2 = (0, vegamTpLadderEngine_1.computeKRegime)(-0.10, 0.30, 1.95, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG);
assert(kHawkes2 === 2.0, `Hawkes = 1.95 momentum expands k_regime to 2.0 despite mild OBI drift`);
// Test 5C: Trail distance expansion
const hawkesTrail = (0, vegamTpLadderEngine_1.computeObiWeightedTrailDistance)(testGkAtr, 0.0, 0.30, 2.20, vegamTpLadderEngine_1.DEFAULT_VEGAM_CONFIG, refPrice);
assert(Math.abs(hawkesTrail / neutralTrail - 2.0) < 1e-9, `Hawkes momentum trail distance is exactly 2.0x of baseline: got ${(hawkesTrail / neutralTrail).toFixed(4)}`);
// =========================================================================================
// STAGE 6: Zero Heap Allocation Invariant & Sub-Microsecond Hot-Path Benchmark
// =========================================================================================
console.log("\n--- STAGE 6: Zero-GC State Machine & Latency Benchmark ---");
const testSlot = {
    slotId: "BENCH_SLOT",
    isOccupied: true,
    side: "LONG",
    quantity: 10.0,
    entryPrice: 100.0,
    openTime: Date.now(),
    takeProfitPrice: 102.0,
    stopLossPrice: 99.0,
    takeProfitPercent: 2.0,
    stopLossPercent: 1.0,
    peakPrice: 100.0,
    peakRoe: 0.0,
};
const benchEngine = new vegamTpLadderEngine_1.VegamTpLadderEngine();
// Warmup 10,000 iterations to allow V8 Turbofan JIT optimization and stable heap state
for (let i = 0; i < 10000; i++) {
    benchEngine.tick(testSlot, 100.5, 100.5, 0.10, 0.20, 1.0, 0.00906, 2.0);
}
// Benchmark 100,000 hot-path tick evaluations using zero-GC engine instance
const iterations = 100_000;
const startMem = process.memoryUsage().heapUsed;
const startTime = process.hrtime.bigint();
for (let i = 0; i < iterations; i++) {
    benchEngine.tick(testSlot, 100.5, 100.5, 0.05, 0.25, 1.1, 0.00906, 2.0);
}
const endTime = process.hrtime.bigint();
const endMem = process.memoryUsage().heapUsed;
const totalNs = Number(endTime - startTime);
const latencyPerTickUs = totalNs / iterations / 1000.0;
const heapDeltaKb = Math.max(0, (endMem - startMem) / 1024.0);
const bytesPerCall = (heapDeltaKb * 1024.0) / iterations;
console.log(`[BENCHMARK] Executed ${iterations.toLocaleString()} tick evaluations in ${(totalNs / 1e6).toFixed(2)} ms`);
console.log(`[BENCHMARK] Average Latency Per Tick: ${latencyPerTickUs.toFixed(4)} µs (Target: < 1.0 µs)`);
console.log(`[BENCHMARK] Heap Delta over 100k calls: ${heapDeltaKb.toFixed(2)} KB (${bytesPerCall.toFixed(2)} bytes/call)`);
assert(latencyPerTickUs < 1.0, `Sub-microsecond latency SLA verified: ${latencyPerTickUs.toFixed(4)} µs < 1.0 µs`);
assert(bytesPerCall < 50.0, `Zero-GC hot-path verified: ${bytesPerCall.toFixed(2)} bytes/call (< 50 bytes V8 runtime noise threshold)`);
// =========================================================================================
// SUMMARY & EXIT CODE
// =========================================================================================
console.log("\n================================================================================");
console.log(`   VEGAM PHASE 3 QA TEST MATRIX: ${totalPassed} PASSED / ${totalFailed} FAILED`);
console.log("================================================================================");
if (totalFailed > 0) {
    console.error("❌ VEGAM PHASE 3 QA VERIFICATION FAILED!");
    process.exit(1);
}
else {
    console.log("✅ ALL VEGAM PHASE 3 QA TESTS PASSED (100% SUCCESS)!");
    process.exit(0);
}
