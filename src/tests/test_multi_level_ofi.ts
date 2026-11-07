/**
 * BATBOT_V11 SOTA QA TEST SUITE: PHASE 3 (5-LEVEL AGGREGATED OFI)
 *
 * Verifies Cont-Kukanov-Stoikov (2023) 5-Level Aggregated Order Flow Imbalance (OFI)
 * with Exponential Depth Decay Weighting (w_l = e^(-0.5 * l)).
 *
 * Mathematical & Architectural Specifications:
 * 1. Exponential Depth Decay Weights:
 *    - w_l = e^(-0.5 * l) for l in [0..4] (lambda = 0.5).
 *    - w_0 = 1.000000, w_1 ≈ 0.606531, w_2 ≈ 0.367879, w_3 ≈ 0.223130, w_4 ≈ 0.135335.
 *    - Weight Sum W ≈ 2.332876.
 * 2. Cont-Kukanov-Stoikov Multi-Level Delta Q:
 *    - Bid: +Q_b(t) if P_b(t) > P_b(t-1); Q_b(t) - Q_b(t-1) if P_b(t) == P_b(t-1); -Q_b(t-1) if P_b(t) < P_b(t-1).
 *    - Ask: +Q_a(t) if P_a(t) < P_a(t-1); Q_a(t) - Q_a(t-1) if P_a(t) == P_a(t-1); -Q_a(t-1) if P_a(t) > P_a(t-1).
 * 3. Normalization & Denominator Guarantees:
 *    - OFI^(5) = ( sum_{l=0..4} w_l * ( dQ_bid^(l) - dQ_ask^(l) ) / meanDepth_l ) / W
 *    - Safe denominator: instant mean depth, fallback to previous depth, or 1.0.
 *    - Output clamped strictly to [-1.0, 1.0].
 * 4. Zero-GC Invariant & Performance:
 *    - Pre-allocated Float64Array(5) class properties.
 *    - Absolutely 0 heap allocations, < 50 bytes/call Heap Delta, < 2.0 µs per tick SLA.
 * 5. Atomic SAB Telemetry:
 *    - Slot 166 (MULTI_LEVEL_OFI): 5-level weighted OFI synchronized via BigInt64Array bitcast.
 *    - Reader methods: fillTop5Bids, fillTop5Asks, fillTop5Levels, getMultiLevelOfi, setMultiLevelOfi.
 */

import { MicrostructureHazardEngine } from "../strategy/microstructureHazardEngine";
import { MarketDataClient } from "../marketDataClient";
import { SAB_SLOTS, MULTI_LEVEL_OFI } from "../ipc/sabSchema";

console.log("================================================================================");
console.log("   BATBOT_V11 SOTA QA TEST SUITE: PHASE 3 (5-LEVEL AGGREGATED OFI)");
console.log("   CONT-KUKANOV-STOIKOV 2023 MICROSTRUCTURE MODEL & ZERO-GC BENCHMARK");
console.log("================================================================================");

let totalPassed = 0;
let totalFailed = 0;

function assert(condition: boolean, testName: string): void {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    totalPassed++;
  } else {
    console.error(`[FAIL] ${testName}`);
    totalFailed++;
    process.exitCode = 1;
  }
}

// =========================================================================================
// STAGE 1: Schema Telemetry & Constructor Weight Calibration Proof
// =========================================================================================
console.log("\n--- STAGE 1: Schema Telemetry & Constructor Weight Calibration Proof ---");

assert(SAB_SLOTS.MULTI_LEVEL_OFI === 166, `SAB_SLOTS.MULTI_LEVEL_OFI equals 166 (received ${SAB_SLOTS.MULTI_LEVEL_OFI})`);
assert(MULTI_LEVEL_OFI === 166, `Named export MULTI_LEVEL_OFI equals 166`);

const hazardEngine = new MicrostructureHazardEngine("BTCUSDT");
const weights = hazardEngine.getDepthWeights();

assert(weights.length === 5, `Depth weights array has length 5`);
assert(Math.abs(weights[0] - 1.0) < 1e-12, `Level 0 weight w_0 = e^0 = 1.0 (received ${weights[0]})`);
assert(Math.abs(weights[1] - Math.exp(-0.5)) < 1e-12, `Level 1 weight w_1 = e^-0.5 ≈ 0.606531 (received ${weights[1]})`);
assert(Math.abs(weights[2] - Math.exp(-1.0)) < 1e-12, `Level 2 weight w_2 = e^-1.0 ≈ 0.367879 (received ${weights[2]})`);
assert(Math.abs(weights[3] - Math.exp(-1.5)) < 1e-12, `Level 3 weight w_3 = e^-1.5 ≈ 0.223130 (received ${weights[3]})`);
assert(Math.abs(weights[4] - Math.exp(-2.0)) < 1e-12, `Level 4 weight w_4 = e^-2.0 ≈ 0.135335 (received ${weights[4]})`);

let expectedWeightSum = 0;
for (let l = 0; l < 5; l++) {
  expectedWeightSum += Math.exp(-0.5 * l);
}
assert(Math.abs(expectedWeightSum - 2.332875544269118) < 1e-10, `Sum of weights = 2.3328755... (verified: ${expectedWeightSum})`);

// =========================================================================================
// STAGE 2: Independent Hand-Calculated Cont-2023 Mathematical Parity
// =========================================================================================
console.log("\n--- STAGE 2: Independent Hand-Calculated Cont-2023 Mathematical Parity ---");

hazardEngine.reset();
assert(!hazardEngine.hasMultiLevelHistory(), `Cold start hasPrevMultiLevelBook is false after reset`);

// Pre-allocate scratch Float64Array(5) buffers
const bidPx = new Float64Array(5);
const bidQty = new Float64Array(5);
const askPx = new Float64Array(5);
const askQty = new Float64Array(5);

// Tick 0: Initial Order Book Snapshot
bidPx[0] = 60000.0; bidQty[0] = 10.0;
bidPx[1] = 59990.0; bidQty[1] = 20.0;
bidPx[2] = 59980.0; bidQty[2] = 30.0;
bidPx[3] = 59970.0; bidQty[3] = 40.0;
bidPx[4] = 59960.0; bidQty[4] = 50.0;

askPx[0] = 60010.0; askQty[0] = 10.0;
askPx[1] = 60020.0; askQty[1] = 20.0;
askPx[2] = 60030.0; askQty[2] = 30.0;
askPx[3] = 60040.0; askQty[3] = 40.0;
askPx[4] = 60050.0; askQty[4] = 50.0;

const tick0Ofi = hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);
assert(tick0Ofi === 0.0, `Tick 0 (Cold start) returns neutral OFI 0.0 (received ${tick0Ofi})`);
assert(hazardEngine.hasMultiLevelHistory(), `Tick 0 sets hasMultiLevelHistory to true`);

// Tick 1: Controlled Depth Mutation with Unchanged Prices
// Level 0: bid qty: 10 -> 15 (dQ_bid = +5), ask qty: 10 -> 5 (dQ_ask = -5), meanDepth = 10.0 -> OFI_0 = +1.0
// Level 1: bid qty: 20 -> 22 (dQ_bid = +2), ask qty: 20 -> 18 (dQ_ask = -2), meanDepth = 20.0 -> OFI_1 = +0.2
// Level 2: bid qty: 30 -> 30 (dQ_bid = 0), ask qty: 30 -> 30 (dQ_ask = 0), meanDepth = 30.0 -> OFI_2 = 0.0
// Level 3: bid qty: 40 -> 35 (dQ_bid = -5), ask qty: 40 -> 45 (dQ_ask = +5), meanDepth = 40.0 -> OFI_3 = -0.25
// Level 4: bid qty: 50 -> 50 (dQ_bid = 0), ask qty: 50 -> 50 (dQ_ask = 0), meanDepth = 50.0 -> OFI_4 = 0.0
bidQty[0] = 15.0; askQty[0] = 5.0;
bidQty[1] = 22.0; askQty[1] = 18.0;
bidQty[2] = 30.0; askQty[2] = 30.0;
bidQty[3] = 35.0; askQty[3] = 45.0;
bidQty[4] = 50.0; askQty[4] = 50.0;

// Independent Hand Calculation:
// ofiSum = w_0 * 1.0 + w_1 * 0.2 + w_2 * 0.0 + w_3 * (-0.25) + w_4 * 0.0
//        = 1.0 * 1.0 + 0.6065306597126334 * 0.2 + 0.22313016014842982 * (-0.25)
//        = 1.0 + 0.12130613194252668 - 0.055782540037107455 = 1.0655235919054192
// expectedOfi = 1.0655235919054192 / 2.332875544269118 ≈ 0.4567425787127637
const expectedOfiTick1 = 0.4567425787127637;
const actualOfiTick1 = hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);

assert(
  Math.abs(actualOfiTick1 - expectedOfiTick1) < 1e-12,
  `Tick 1 5-Level OFI matches independent hand calculation: expected ${expectedOfiTick1}, got ${actualOfiTick1}`
);
assert(
  Math.abs(hazardEngine.getLastMultiLevelOfi() - expectedOfiTick1) < 1e-12,
  `getLastMultiLevelOfi() reflects current computed OFI`
);

// Verify with custom rollingMeanDepths
const customDepths = new Float64Array([20.0, 20.0, 20.0, 20.0, 20.0]);
// Level 0: (5 - (-5)) / 20 = 10 / 20 = 0.5
// Level 1: (2 - (-2)) / 20 = 4 / 20 = 0.2
// Level 2: 0
// Level 3: (-5 - 5) / 20 = -10 / 20 = -0.5
// Level 4: 0
// ofiSum = 1.0 * 0.5 + w_1 * 0.2 + w_3 * (-0.5) = 0.5 + 0.12130613 - 0.11156508 = 0.50974105
// expected = 0.5097410518683118 / 2.332875544269118 ≈ 0.21850332012804047
hazardEngine.reset();
hazardEngine.computeMultiLevelOfi(bidPx, new Float64Array([10, 20, 30, 40, 50]), askPx, new Float64Array([10, 20, 30, 40, 50]), customDepths);
const ofiWithCustomDepths = hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty, customDepths);
const expectedCustomDepthsOfi = 0.21850332012804047;
assert(
  Math.abs(ofiWithCustomDepths - expectedCustomDepthsOfi) < 1e-12,
  `5-Level OFI with custom rollingMeanDepths matches hand calculation: expected ${expectedCustomDepthsOfi}, got ${ofiWithCustomDepths}`
);

// =========================================================================================
// STAGE 3: Bid Price Improvement & Bullish Aggressive Flow
// =========================================================================================
console.log("\n--- STAGE 3: Bid Price Improvement & Bullish Aggressive Flow ---");

hazardEngine.reset();
// Baseline book
bidPx[0] = 60000.0; bidQty[0] = 10.0;
askPx[0] = 60010.0; askQty[0] = 10.0;
for (let l = 1; l < 5; l++) {
  bidPx[l] = 60000.0 - l * 10.0; bidQty[l] = 10.0 * (l + 1);
  askPx[l] = 60010.0 + l * 10.0; askQty[l] = 10.0 * (l + 1);
}
hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);

// Bid price improvement: Level 0 bid steps up to 60005 with qty = 8.0
bidPx[0] = 60005.0; bidQty[0] = 8.0;
// ask remains unchanged at 60010 with qty = 10.0
// dQ_bid = 8.0 (improved price), dQ_ask = 0 (unchanged px & qty)
// meanDepth = (8 + 10) * 0.5 = 9.0
// Level 0 OFI = 8.0 / 9.0 ≈ 0.8888888888888888
// Levels 1..4 unchanged: dQ = 0
// expectedOfi = (w_0 * (8/9)) / W = (8/9) / 2.332875544269118 ≈ 0.38102713
const expectedBullishOfi = (8.0 / 9.0) / expectedWeightSum;
const actualBullishOfi = hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);

assert(
  Math.abs(actualBullishOfi - expectedBullishOfi) < 1e-12,
  `Bid price step-up creates positive bullish OFI: expected ${expectedBullishOfi.toFixed(6)}, got ${actualBullishOfi.toFixed(6)}`
);
assert(actualBullishOfi > 0, `Bullish OFI is strictly positive (${actualBullishOfi} > 0)`);

// =========================================================================================
// STAGE 4: Ask Price Improvement & Bearish Aggressive Flow
// =========================================================================================
console.log("\n--- STAGE 4: Ask Price Improvement & Bearish Aggressive Flow ---");

hazardEngine.reset();
// Baseline book
bidPx[0] = 60000.0; bidQty[0] = 10.0;
askPx[0] = 60010.0; askQty[0] = 10.0;
for (let l = 1; l < 5; l++) {
  bidPx[l] = 60000.0 - l * 10.0; bidQty[l] = 10.0 * (l + 1);
  askPx[l] = 60010.0 + l * 10.0; askQty[l] = 10.0 * (l + 1);
}
hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);

// Ask price improvement (bearish): Level 0 ask steps down into spread to 60004 with qty = 12.0
askPx[0] = 60004.0; askQty[0] = 12.0;
// bid remains unchanged at 60000 with qty = 10.0
// dQ_bid = 0, dQ_ask = 12.0 (improved ask price)
// meanDepth = (10 + 12) * 0.5 = 11.0
// Level 0 OFI = (0 - 12) / 11.0 = -12.0 / 11.0 ≈ -1.0909090909
// Levels 1..4 unchanged: dQ = 0
// expectedOfi = (w_0 * (-12/11)) / W = (-12/11) / 2.332875544269118 ≈ -0.46762412
const expectedBearishOfi = (-12.0 / 11.0) / expectedWeightSum;
const actualBearishOfi = hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);

assert(
  Math.abs(actualBearishOfi - expectedBearishOfi) < 1e-12,
  `Ask price step-down creates negative bearish OFI: expected ${expectedBearishOfi.toFixed(6)}, got ${actualBearishOfi.toFixed(6)}`
);
assert(actualBearishOfi < 0, `Bearish OFI is strictly negative (${actualBearishOfi} < 0)`);

// =========================================================================================
// STAGE 5: Depth Collapse, Zero Denominators & Resilience Guards
// =========================================================================================
console.log("\n--- STAGE 5: Depth Collapse, Zero Denominators & Resilience Guards ---");

hazardEngine.reset();
bidPx[0] = 60000.0; bidQty[0] = 10.0;
askPx[0] = 60010.0; askQty[0] = 10.0;
hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);

// Depth collapse: both bidQty and askQty drop to 0 at level 0
bidQty[0] = 0.0;
askQty[0] = 0.0;
// instantDepth = 0, falls back safely to prevDepth = 10.0
// dQ_bid = -10, dQ_ask = -10 -> dQ_bid - dQ_ask = 0
const collapseOfi = hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);
assert(Number.isFinite(collapseOfi), `Depth collapse produces finite OFI (received ${collapseOfi})`);
assert(!Number.isNaN(collapseOfi), `Depth collapse never produces NaN`);
assert(collapseOfi === 0.0, `Symmetric depth liquidation produces neutral 0.0 OFI`);

// Asymmetric depth collapse: bid vanished (cancelled), ask unchanged
hazardEngine.reset();
bidPx[0] = 60000.0; bidQty[0] = 10.0;
askPx[0] = 60010.0; askQty[0] = 10.0;
hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);

bidQty[0] = 0.0; // bid cancelled
bidPx[0] = 0.0;  // bid level vanished
// dQ_bid = -10.0, dQ_ask = 0, meanDepth = (0 + 10) * 0.5 = 5.0
// Level 0 OFI = -10 / 5.0 = -2.0
// OFI is strictly negative and safely bounded
const vanishedBidOfi = hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);
assert(Number.isFinite(vanishedBidOfi) && vanishedBidOfi < 0, `Vanished bid level produces negative OFI (${vanishedBidOfi})`);

// Extreme Outlier / Saturation Clamping Test [-1.0, 1.0]
hazardEngine.reset();
bidPx[0] = 60000.0; bidQty[0] = 1.0;
askPx[0] = 60010.0; askQty[0] = 1.0;
hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);

// Massive bid surge
bidQty[0] = 1000000.0;
const clampedOfi = hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);
assert(clampedOfi <= 1.0 && clampedOfi >= -1.0, `Extreme flow is strictly clamped within [-1.0, 1.0]: got ${clampedOfi}`);

// NaN / Infinity Injection Test
hazardEngine.reset();
bidPx[0] = NaN; bidQty[0] = Infinity;
askPx[0] = -Infinity; askQty[0] = NaN;
const nanGuardOfi = hazardEngine.computeMultiLevelOfi(bidPx, bidQty, askPx, askQty);
assert(Number.isFinite(nanGuardOfi) && !Number.isNaN(nanGuardOfi), `NaN/Infinity inputs sanitized to finite number: got ${nanGuardOfi}`);

// =========================================================================================
// STAGE 6: Missing Book Levels (Sparse Book Depth < 5) & Object Array Overload
// =========================================================================================
console.log("\n--- STAGE 6: Missing Book Levels (Sparse Book Depth < 5) & Object Array Overload ---");

hazardEngine.reset();
// Test sparse depth with only 2 levels
const sparseBidPx = new Float64Array([60000.0, 59990.0]);
const sparseBidQty = new Float64Array([10.0, 20.0]);
const sparseAskPx = new Float64Array([60010.0, 60020.0]);
const sparseAskQty = new Float64Array([10.0, 20.0]);

const sparse0 = hazardEngine.computeMultiLevelOfi(sparseBidPx, sparseBidQty, sparseAskPx, sparseAskQty);
assert(sparse0 === 0.0, `Sparse book tick 0 returns 0.0`);

// Mutate level 0 on sparse book
sparseBidQty[0] = 20.0; // dQ_bid = +10, dQ_ask = 0, meanDepth = 15.0
const sparse1 = hazardEngine.computeMultiLevelOfi(sparseBidPx, sparseBidQty, sparseAskPx, sparseAskQty);
const sparseWeightSum = 1.0 + Math.exp(-0.5); // w_0 + w_1
const expectedSparseOfi = (1.0 * (10.0 / 15.0)) / sparseWeightSum;

assert(
  Math.abs(sparse1 - expectedSparseOfi) < 1e-12,
  `Sparse depth (2 levels) correctly normalizes by available weight sum (expected ${expectedSparseOfi.toFixed(6)}, got ${sparse1.toFixed(6)})`
);

// Test Object Array compatibility overload: Array<{ price: number; qty: number }>
hazardEngine.reset();
const objBids0 = [
  { price: 60000, qty: 10 },
  { price: 59990, qty: 20 },
  { price: 59980, qty: 30 },
  { price: 59970, qty: 40 },
  { price: 59960, qty: 50 },
];
const objAsks0 = [
  { price: 60010, qty: 10 },
  { price: 60020, qty: 20 },
  { price: 60030, qty: 30 },
  { price: 60040, qty: 40 },
  { price: 60050, qty: 50 },
];
const obj0 = hazardEngine.computeMultiLevelOfi(objBids0, objAsks0);
assert(obj0 === 0.0, `Object array overload tick 0 returns 0.0`);

const objBids1 = [
  { price: 60000, qty: 15 },
  { price: 59990, qty: 22 },
  { price: 59980, qty: 30 },
  { price: 59970, qty: 35 },
  { price: 59960, qty: 50 },
];
const objAsks1 = [
  { price: 60010, qty: 5 },
  { price: 60020, qty: 18 },
  { price: 60030, qty: 30 },
  { price: 60040, qty: 45 },
  { price: 60050, qty: 50 },
];
const obj1 = hazardEngine.computeMultiLevelOfi(objBids1, objAsks1);
assert(
  Math.abs(obj1 - expectedOfiTick1) < 1e-12,
  `Object array overload produces identical mathematical result to Float64Array (${obj1} vs ${expectedOfiTick1})`
);

// Verify MicrostructureMetrics inclusion in getHazardMetrics
const hazardMetrics = hazardEngine.getHazardMetrics("LONG", 0.50, 1000);
assert(
  hazardMetrics.multiLevelOfi !== undefined && Math.abs(hazardMetrics.multiLevelOfi - expectedOfiTick1) < 1e-12,
  `hazardMetrics.multiLevelOfi correctly populated with latest 5-level OFI (${hazardMetrics.multiLevelOfi})`
);

// =========================================================================================
// STAGE 7: MarketDataClient L2 Depth Reader & SAB Telemetry Integration
// =========================================================================================
console.log("\n--- STAGE 7: MarketDataClient L2 Depth Reader & SAB Telemetry Integration ---");

const maxAssets = 10;
const slotsPerAsset = 256;
const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
const mdClient = new MarketDataClient(sab, maxAssets, slotsPerAsset);

const testAssetIdx = 2; // Test non-zero asset index to prove offset isolation

// Populate SAB slots 11..20 (bids 0..4) and 51..60 (asks 0..4)
const sampleBids = [
  [60100.5, 3.25],
  [60095.0, 7.50],
  [60090.0, 12.0],
  [60085.0, 18.75],
  [60080.0, 25.0],
];
const sampleAsks = [
  [60105.5, 2.50],
  [60110.0, 6.25],
  [60115.0, 11.0],
  [60120.0, 15.5],
  [60125.0, 22.0],
];

for (let i = 0; i < 5; i++) {
  // Bids at Slots 11 + i*2
  mdClient.writeAtomicFloat64Asset(testAssetIdx, 11 + i * 2, sampleBids[i][0]);
  mdClient.writeAtomicFloat64Asset(testAssetIdx, 11 + i * 2 + 1, sampleBids[i][1]);
  // Asks at Slots 51 + i*2
  mdClient.writeAtomicFloat64Asset(testAssetIdx, 51 + i * 2, sampleAsks[i][0]);
  mdClient.writeAtomicFloat64Asset(testAssetIdx, 51 + i * 2 + 1, sampleAsks[i][1]);
}

// 1. Test fillTop5Bids
const outBidPx = new Float64Array(5);
const outBidQty = new Float64Array(5);
mdClient.fillTop5Bids(outBidPx, outBidQty, testAssetIdx);
for (let i = 0; i < 5; i++) {
  assert(outBidPx[i] === sampleBids[i][0], `fillTop5Bids level ${i} price matches: ${outBidPx[i]} === ${sampleBids[i][0]}`);
  assert(outBidQty[i] === sampleBids[i][1], `fillTop5Bids level ${i} qty matches: ${outBidQty[i]} === ${sampleBids[i][1]}`);
}

// 2. Test fillTop5Asks
const outAskPx = new Float64Array(5);
const outAskQty = new Float64Array(5);
mdClient.fillTop5Asks(outAskPx, outAskQty, testAssetIdx);
for (let i = 0; i < 5; i++) {
  assert(outAskPx[i] === sampleAsks[i][0], `fillTop5Asks level ${i} price matches: ${outAskPx[i]} === ${sampleAsks[i][0]}`);
  assert(outAskQty[i] === sampleAsks[i][1], `fillTop5Asks level ${i} qty matches: ${outAskQty[i]} === ${sampleAsks[i][1]}`);
}

// 3. Test fillTop5Levels (Consolidated read)
const sweepBidPx = new Float64Array(5);
const sweepBidQty = new Float64Array(5);
const sweepAskPx = new Float64Array(5);
const sweepAskQty = new Float64Array(5);
mdClient.fillTop5Levels(sweepBidPx, sweepBidQty, sweepAskPx, sweepAskQty, testAssetIdx);

for (let i = 0; i < 5; i++) {
  assert(sweepBidPx[i] === sampleBids[i][0] && sweepBidQty[i] === sampleBids[i][1], `fillTop5Levels bid level ${i} verified`);
  assert(sweepAskPx[i] === sampleAsks[i][0] && sweepAskQty[i] === sampleAsks[i][1], `fillTop5Levels ask level ${i} verified`);
}

// 4. Test Single-Level Direct Accessors
assert(mdClient.getBidPriceAtLevel(0, testAssetIdx) === 60100.5, `getBidPriceAtLevel(0) = 60100.5`);
assert(mdClient.getBidQtyAtLevel(0, testAssetIdx) === 3.25, `getBidQtyAtLevel(0) = 3.25`);
assert(mdClient.getAskPriceAtLevel(4, testAssetIdx) === 60125.0, `getAskPriceAtLevel(4) = 60125.0`);
assert(mdClient.getAskQtyAtLevel(4, testAssetIdx) === 22.0, `getAskQtyAtLevel(4) = 22.0`);

// 5. Test Telemetry Slot 166: getMultiLevelOfi / setMultiLevelOfi
const testOfiValue = 0.4567425787127637;
mdClient.setMultiLevelOfi(testOfiValue, testAssetIdx);
const sabStoredOfi = mdClient.getMultiLevelOfi(testAssetIdx);
assert(
  Math.abs(sabStoredOfi - testOfiValue) < 1e-12,
  `Slot 166 atomic round-trip bitcast accurate: expected ${testOfiValue}, got ${sabStoredOfi}`
);

// Verify asset isolation in SAB
const asset0Ofi = mdClient.getMultiLevelOfi(0);
assert(asset0Ofi === 0.0, `Asset isolation confirmed: asset 0 Slot 166 remains 0.0 when asset 2 is written`);

// =========================================================================================
// STAGE 8: Zero-GC Hot-Path Performance Benchmark & Sub-2.0 µs Latency SLA
// =========================================================================================
console.log("\n--- STAGE 8: Zero-GC Hot-Path Performance Benchmark & Sub-2.0 µs Latency SLA ---");

const benchEngine = new MicrostructureHazardEngine("ETHUSDT");
const benchBidPx = new Float64Array([3000.0, 2999.0, 2998.0, 2997.0, 2996.0]);
const benchBidQty = new Float64Array([10.0, 20.0, 30.0, 40.0, 50.0]);
const benchAskPx = new Float64Array([3001.0, 3002.0, 3003.0, 3004.0, 3005.0]);
const benchAskQty = new Float64Array([10.0, 20.0, 30.0, 40.0, 50.0]);

// Cold-start initial tick
benchEngine.computeMultiLevelOfi(benchBidPx, benchBidQty, benchAskPx, benchAskQty);

const ITERATIONS = 100_000;

// Warm-up JIT compiler
for (let i = 0; i < 10_000; i++) {
  benchBidQty[0] = 10.0 + (i & 7);
  benchAskQty[0] = 10.0 + ((i + 3) & 7);
  benchEngine.computeMultiLevelOfi(benchBidPx, benchBidQty, benchAskPx, benchAskQty);
}

// Force GC if available
if (global.gc) {
  global.gc();
}

const memBefore = process.memoryUsage().heapUsed;
const startHr = process.hrtime.bigint();

for (let i = 0; i < ITERATIONS; i++) {
  benchBidQty[0] = 10.0 + (i & 7);
  benchAskQty[0] = 10.0 + ((i + 3) & 7);
  benchEngine.computeMultiLevelOfi(benchBidPx, benchBidQty, benchAskPx, benchAskQty);
}

const endHr = process.hrtime.bigint();
const memAfter = process.memoryUsage().heapUsed;

const totalNs = Number(endHr - startHr);
const avgUs = (totalNs / ITERATIONS) / 1000.0;
const bytesAllocated = Math.max(0, memAfter - memBefore);
const bytesPerCall = bytesAllocated / ITERATIONS;

console.log(`[BENCHMARK] Executed ${ITERATIONS.toLocaleString()} 5-level OFI evaluations in ${(totalNs / 1e6).toFixed(2)} ms`);
console.log(`[BENCHMARK] Average Latency Per Tick: ${avgUs.toFixed(4)} µs (SLA Target: < 2.0000 µs)`);
console.log(`[BENCHMARK] Heap Delta over 100k calls: ${(bytesAllocated / 1024).toFixed(2)} KB (${bytesPerCall.toFixed(2)} bytes/call)`);

assert(avgUs < 2.0, `SLA Latency Target Verified: ${avgUs.toFixed(4)} µs < 2.0000 µs`);
assert(bytesPerCall < 50.0, `Zero-GC Hot-Path Invariant Verified: ${bytesPerCall.toFixed(2)} bytes/call (< 50 bytes V8 noise threshold)`);

// =========================================================================================
// SUMMARY
// =========================================================================================
console.log("\n================================================================================");
console.log(`   PHASE 3 5-LEVEL OFI TEST MATRIX: ${totalPassed} PASSED / ${totalFailed} FAILED`);
console.log("================================================================================");

if (totalFailed === 0) {
  console.log("✅ ALL PHASE 3 5-LEVEL OFI TESTS PASSED (100% SUCCESS)!\n");
  process.exit(0);
} else {
  console.error("❌ PHASE 3 5-LEVEL OFI TESTS FAILED!\n");
  process.exit(1);
}

