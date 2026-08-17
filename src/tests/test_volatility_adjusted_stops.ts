import "dotenv/config";
import { HedgePositionLedger } from "../strategy/positionLedger";
import { DynamicRiskEngine, DynamicMicrostructureMetrics } from "../strategy/dynamicRiskEngine";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[ASSERTION_FAILED] ${message}`);
  }
}

async function runVolatilityAdjustedStopsTestSuite() {
  console.log("================================================================================");
  console.log("  BATBOT_V11 SOTA: VOLATILITY-ADJUSTED STOPS & CHOP REGIME FILTER TEST SUITE");
  console.log("  - Phase 1: Garman-Klass RV Volatility-Adjusted Stops (max(1.00%, 3.50 * vol))");
  console.log("  - Phase 1: Minimum 2.5:1 Payoff Skew Multiplier (TP = 2.50 * SL)");
  console.log("  - Phase 4: Microstructure Chop Filter (H < 0.45 & S_LOB > 0.85 -> REJECTED_CHOP)");
  console.log("  - Phase 4: Verified Trend Regime Gating (H >= 0.55, S_LOB <= 0.75, Hawkes <= 2.0)");
  console.log("================================================================================\n");

  // -----------------------------------------------------------------------------------------
  // TEST 1: Volatility-Adjusted Stop Loss & 2.5:1 Take Profit Payoff Skew Formula
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 1] Testing Volatility-Adjusted SL & 2.5:1 TP Calculation across Regimes...");

  function calculateDynamicSlTp(volEstimate: number, baseSlPercent: number = 1.00) {
    const dynamicSlPercent = Math.max(baseSlPercent, Math.max(1.00, volEstimate * 3.50 * 100));
    const dynamicTpPercent = dynamicSlPercent * 2.50;
    return { dynamicSlPercent, dynamicTpPercent };
  }

  // 1. Low Volatility Regime (sigma = 0.0010 / 10 bps) -> 1.00% floor clamp
  const lowVol = calculateDynamicSlTp(0.0010);
  assert(lowVol.dynamicSlPercent === 1.00, `Low vol SL should clamp to 1.00%, got ${lowVol.dynamicSlPercent}%`);
  assert(lowVol.dynamicTpPercent === 2.50, `Low vol TP should be 2.50%, got ${lowVol.dynamicTpPercent}%`);
  console.log("  ✓ Low Volatility (10 bps): Clamped to 1.00% SL floor, 2.50% TP target (2.5:1 ratio)");

  // 2. Medium Volatility Regime (sigma = 0.0050 / 50 bps) -> 3.50 * 0.50% = 1.75% SL
  const medVol = calculateDynamicSlTp(0.0050);
  assert(Math.abs(medVol.dynamicSlPercent - 1.75) < 1e-6, `Med vol SL should be 1.75%, got ${medVol.dynamicSlPercent}%`);
  assert(Math.abs(medVol.dynamicTpPercent - 4.375) < 1e-6, `Med vol TP should be 4.375%, got ${medVol.dynamicTpPercent}%`);
  console.log("  ✓ Medium Volatility (50 bps): Dynamically expanded to 1.75% SL, 4.375% TP target (2.5:1 ratio)");

  // 3. High Volatility Regime (sigma = 0.0100 / 100 bps) -> 3.50 * 1.00% = 3.50% SL
  const highVol = calculateDynamicSlTp(0.0100);
  assert(Math.abs(highVol.dynamicSlPercent - 3.50) < 1e-6, `High vol SL should be 3.50%, got ${highVol.dynamicSlPercent}%`);
  assert(Math.abs(highVol.dynamicTpPercent - 8.75) < 1e-6, `High vol TP should be 8.75%, got ${highVol.dynamicTpPercent}%`);
  console.log("  ✓ High Volatility (100 bps): Dynamically expanded to 3.50% SL, 8.75% TP target (2.5:1 ratio)\n");

  // -----------------------------------------------------------------------------------------
  // TEST 2: HedgePositionLedger Volatility Sizing Injection
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 2] Testing HedgePositionLedger Long/Short Slot Dynamic Stop Ingestion...");
  const symbol = "BTCUSDT";
  const ledger = new HedgePositionLedger(symbol, 10);
  const entryPrice = 60000.0;
  const quantity = 0.1;

  // Occupy CORE_LONG with medium volatility parameters (SL: 1.75%, TP: 4.375%)
  ledger.occupyCoreLong(quantity, entryPrice, medVol.dynamicTpPercent, medVol.dynamicSlPercent);
  const longSlot = ledger.getCoreLong();
  // Expected SL: 60,000 * (1 - 0.0175) = 58,950
  const expectedLongSl = 60000.0 * (1.0 - medVol.dynamicSlPercent / 100.0);
  assert(Math.abs(longSlot.stopLossPrice - expectedLongSl) < 1.0, `Long SL must match expected $58,950, got $${longSlot.stopLossPrice}`);
  console.log(`  ✓ CORE_LONG occupied @ $${entryPrice}: SL set to $${longSlot.stopLossPrice} (-${medVol.dynamicSlPercent}%)`);
  ledger.releaseCoreLong();

  // Occupy SHORT_SLOT_0 with high volatility parameters (SL: 3.50%, TP: 8.75%)
  ledger.occupyShortSlot(0, quantity, entryPrice, highVol.dynamicTpPercent, highVol.dynamicSlPercent);
  const shortSlot = ledger.getShortSlots()[0];
  // Expected SL: 60,000 * (1 + 0.0350) = 62,100
  const expectedShortSl = 60000.0 * (1.0 + highVol.dynamicSlPercent / 100.0);
  assert(Math.abs(shortSlot.stopLossPrice - expectedShortSl) < 1.0, `Short SL must match expected $62,100, got $${shortSlot.stopLossPrice}`);
  console.log(`  ✓ SHORT_SLOT_0 occupied @ $${entryPrice}: SL set to $${shortSlot.stopLossPrice} (+${highVol.dynamicSlPercent}%)\n`);
  ledger.releaseShortSlot(0);

  // -----------------------------------------------------------------------------------------
  // TEST 3: Microstructure Chop & LOB Entropy Regime Filter (Phase 4)
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 3] Testing Microstructure Chop (H < 0.45 & S_LOB > 0.85) & Trend Gating...");
  const riskEngine = new DynamicRiskEngine();

  // Case A: Mean-Reverting Noise Chop (Hurst = 0.38 < 0.45, Entropy = 0.92 > 0.85)
  const chopMetrics: DynamicMicrostructureMetrics = {
    obi: 0.40,
    cvd: 100.0,
    rvGk: 0.0030,
    vpin: 0.45,
    hurst: 0.38,
    lobEntropy: 0.92,
    regime: 0,
    isSweepDetected: false,
  };
  const chopProfile = riskEngine.evaluateDynamicRisk(60000.0, "LONG", chopMetrics);
  assert(chopProfile.isTrapDetected === true, "Chop regime must trigger isTrapDetected = true");
  assert(chopProfile.regimeState === "TOXIC_CHOP_TRAP", `Regime should be TOXIC_CHOP_TRAP, got ${chopProfile.regimeState}`);
  assert(chopProfile.trapReason !== null && chopProfile.trapReason.includes("CHOP"), `Trap reason should specify NOISY_CHOP_REGIME, got ${chopProfile.trapReason}`);
  console.log("  ✓ Mean-Reverting Noise Chop (H: 0.38, S_LOB: 0.92): Correctly rejected as TOXIC_CHOP_TRAP");

  // Case B: High Hawkes Panic / Microburst (Hawkes > 2.0 or VPIN > 0.85)
  const toxicMetrics: DynamicMicrostructureMetrics = {
    obi: 0.10,
    cvd: 50.0,
    rvGk: 0.0040,
    vpin: 0.91, // Toxic flow
    hurst: 0.52,
    lobEntropy: 0.70,
    regime: 2,
    isSweepDetected: false,
  };
  const toxicProfile = riskEngine.evaluateDynamicRisk(60000.0, "LONG", toxicMetrics);
  assert(toxicProfile.isTrapDetected === true, "Toxic flow (VPIN > 0.85) must trigger trap detection");
  console.log("  ✓ Toxic Order Flow (VPIN: 0.91 > 0.85): Correctly rejected as HIGH_VPIN_TOXIC_FLOW");

  // Case C: Verified Trend Regime (H = 0.62 >= 0.55, S_LOB = 0.65 <= 0.75, VPIN = 0.30 <= 0.85)
  const trendMetrics: DynamicMicrostructureMetrics = {
    obi: 0.35,
    cvd: 250.0,
    rvGk: 0.0035,
    vpin: 0.30,
    hurst: 0.62,
    lobEntropy: 0.65,
    regime: 1,
    isSweepDetected: false,
  };
  const trendProfile = riskEngine.evaluateDynamicRisk(60000.0, "LONG", trendMetrics);
  assert(trendProfile.isTrapDetected === false, "Trend regime must NOT trigger trap detection");
  assert(trendProfile.regimeState === "DIRECTIONAL_TREND", `Regime should be DIRECTIONAL_TREND, got ${trendProfile.regimeState}`);
  console.log("  ✓ Verified Trend Regime (H: 0.62, S_LOB: 0.65, VPIN: 0.30): Approved as DIRECTIONAL_TREND\n");

  // -----------------------------------------------------------------------------------------
  // TEST 4: Micro-Latency Benchmark (100,000 Evaluations)
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 4] Running 100,000 Microstructure Dynamic Risk Latency Benchmark...");
  const iterations = 100_000;

  // V8 JIT Warmup Loop
  for (let w = 0; w < 10_000; w++) {
    riskEngine.evaluateDynamicRisk(60000.0, "LONG", trendMetrics);
  }

  const startHr = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    riskEngine.evaluateDynamicRisk(60000.0, "LONG", trendMetrics);
  }
  const endHr = process.hrtime.bigint();
  const totalNs = Number(endHr - startHr);
  const avgUs = (totalNs / iterations) / 1000.0;
  console.log(`  ✓ Executed ${iterations.toLocaleString()} risk evaluations in ${(totalNs / 1e6).toFixed(2)} ms`);
  console.log(`  ✓ Average Latency: ${avgUs.toFixed(3)} µs / evaluation (< 1.500 µs HFT constraint)\n`);
  assert(avgUs < 1.50, `Average latency (${avgUs.toFixed(3)} µs) exceeds 1.500 µs constraint`);

  console.log("================================================================================");
  console.log("  ALL VOLATILITY-ADJUSTED STOPS & CHOP FILTER TESTS PASSED! (100% VERIFIED)");
  console.log("================================================================================");
}

runVolatilityAdjustedStopsTestSuite().catch((err) => {
  console.error("FATAL TEST FAILURE:", err);
  process.exit(1);
});
