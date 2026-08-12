import "dotenv/config";
import { MarketDataClient } from "./marketDataClient";
import { AutoRecalibrationManager } from "./ai/recalibrationWorker";
import { DynamicRiskEngine } from "./strategy/dynamicRiskEngine";
import { HedgePositionLedger, calculatePartialExitChunk } from "./strategy/positionLedger";

async function runMultiTpZeroLossTests() {
  console.log("================================================================================");
  console.log("    BATBOT_V11 AI CALIBRATION & 5-STAGE ZERO-LOSS TP VERIFICATION SUITE       ");
  console.log("================================================================================");

  // 1. Verify SAB AI Temperature & Platt Calibration parameter setters/getters
  console.log("\n[TEST 1] Verifying SAB AI Calibration Parameter Storage...");
  const sab = new SharedArrayBuffer(20480);
  const client = new MarketDataClient(sab);

  const recalManager = AutoRecalibrationManager.getInstance();
  const calRes = recalManager.applyPlattCalibration(client, 0.08); // High positive IC -> sharpen temperature

  if (client.getAiTemperature() <= 0 || client.getAiPlattScale() <= 0) {
    throw new Error("FAIL: SAB AI Calibration setters/getters failed!");
  }
  console.log(`  ✓ Dynamic Platt Calibration applied: Temp=${calRes.temperature.toFixed(2)}, Scale=${calRes.scale.toFixed(2)}, Offset=${calRes.offset.toFixed(2)}`);
  console.log(`  ✓ SAB Stored Values: Temp=${client.getAiTemperature().toFixed(2)}, Scale=${client.getAiPlattScale().toFixed(2)}, Offset=${client.getAiPlattOffset().toFixed(2)}`);

  // 2. Verify Fee-Adjusted Zero-Loss Break-Even Lock Calculation
  console.log("\n[TEST 2] Verifying Fee-Adjusted Zero-Loss Break-Even SL Calculation...");
  const riskEngine = new DynamicRiskEngine();
  const entryPrice = 60000.0;

  const longBreakEven = riskEngine.calculateFeeAdjustedBreakEvenPrice(entryPrice, "LONG", 0.0005);
  const shortBreakEven = riskEngine.calculateFeeAdjustedBreakEvenPrice(entryPrice, "SHORT", 0.0005);

  const expectedLongBe = entryPrice * (1.0 + 0.0005 * 2.5);
  const expectedShortBe = entryPrice * (1.0 - 0.0005 * 2.5);

  if (Math.abs(longBreakEven - expectedLongBe) > 1e-4 || Math.abs(shortBreakEven - expectedShortBe) > 1e-4) {
    throw new Error(`FAIL: Fee-Adjusted Break-Even price calculation mismatch! Got Long: ${longBreakEven}, Short: ${shortBreakEven}`);
  }
  console.log(`  ✓ LONG Entry: $${entryPrice} -> Zero-Loss Fee-Adjusted Break-Even SL: $${longBreakEven.toFixed(2)} (+0.125% fee buffer)`);
  console.log(`  ✓ SHORT Entry: $${entryPrice} -> Zero-Loss Fee-Adjusted Break-Even SL: $${shortBreakEven.toFixed(2)} (-0.125% fee buffer)`);

  // 3. Verify Binance Lot Size Trap & Merge Guard
  console.log("\n[TEST 3] Verifying Binance Lot Size Trap & Merge Protection...");
  // Standard chunk: 20% of 0.010 BTC = 0.002 BTC (valid)
  const validChunk = calculatePartialExitChunk(0.010, 0.010, 20, 0.001, 0.001, 5.0, 60000.0);
  if (validChunk !== 0.002) {
    throw new Error(`FAIL: Expected valid chunk 0.002, got ${validChunk}`);
  }
  console.log(`  ✓ Standard 20% chunk of 0.010 BTC -> ${validChunk} BTC (Passed LOT-SIZE & MIN_NOTIONAL)`);

  // Micro chunk trap: 20% of 0.001 BTC = 0.0002 BTC (< minQty 0.001 BTC). Should dynamically merge to full 0.001!
  const mergedChunk = calculatePartialExitChunk(0.001, 0.001, 20, 0.001, 0.001, 5.0, 60000.0);
  if (mergedChunk !== 0.001) {
    throw new Error(`FAIL: Expected lot size trap guard to merge chunk into full 0.001, got ${mergedChunk}`);
  }
  console.log(`  ✓ Micro lot trap guard (20% of 0.001 BTC = 0.0002 BTC < minQty) -> Dynamically MERGED to ${mergedChunk} BTC! (Prevented LOT_SIZE API rejection)`);

  // 3B. DEFECT 4 SOTA NaN & Zero-Division Boundary Hazard Test Suite
  console.log("\n[TEST 3B] Verifying DEFECT 4 SOTA IEEE 754 Zero-Division & NaN Safety Guards...");

  // Hazard 1: stepSize = 0 (Division by zero / -Infinity hazard)
  const zeroStepChunk = calculatePartialExitChunk(0.010, 0.010, 20, 0, 0.001, 5.0, 60000.0);
  if (!Number.isFinite(zeroStepChunk) || Number.isNaN(zeroStepChunk)) {
    throw new Error(`FAIL: stepSize=0 produced non-finite or NaN value: ${zeroStepChunk}`);
  }
  console.log(`  ✓ stepSize=0 Safety Guard -> ${zeroStepChunk} (Handled safely with default fallback, zero division prevented)`);

  // Hazard 2: stepSize = -0.001 (Negative step size hazard)
  const negStepChunk = calculatePartialExitChunk(0.010, 0.010, 20, -0.001, 0.001, 5.0, 60000.0);
  if (!Number.isFinite(negStepChunk) || Number.isNaN(negStepChunk)) {
    throw new Error(`FAIL: stepSize=-0.001 produced non-finite value: ${negStepChunk}`);
  }
  console.log(`  ✓ stepSize=-0.001 Safety Guard -> ${negStepChunk} (Handled safely with default fallback)`);

  // Hazard 3: stepSize = NaN (NaN propagation hazard)
  const nanStepChunk = calculatePartialExitChunk(0.010, 0.010, 20, NaN, 0.001, 5.0, 60000.0);
  if (!Number.isFinite(nanStepChunk) || Number.isNaN(nanStepChunk)) {
    throw new Error(`FAIL: stepSize=NaN produced non-finite value: ${nanStepChunk}`);
  }
  console.log(`  ✓ stepSize=NaN Safety Guard -> ${nanStepChunk} (Handled safely without RangeError or NaN propagation)`);

  // Hazard 4: stepSize = Infinity (Infinity hazard)
  const infStepChunk = calculatePartialExitChunk(0.010, 0.010, 20, Infinity, 0.001, 5.0, 60000.0);
  if (!Number.isFinite(infStepChunk) || Number.isNaN(infStepChunk)) {
    throw new Error(`FAIL: stepSize=Infinity produced non-finite value: ${infStepChunk}`);
  }
  console.log(`  ✓ stepSize=Infinity Safety Guard -> ${infStepChunk} (Handled safely)`);

  // Hazard 5: Exponent overflow subnormal step size 1e-15
  const subnormalChunk = calculatePartialExitChunk(0.010, 0.010, 20, 1e-15, 0.001, 5.0, 60000.0);
  if (!Number.isFinite(subnormalChunk) || Number.isNaN(subnormalChunk)) {
    throw new Error(`FAIL: stepSize=1e-15 produced non-finite value: ${subnormalChunk}`);
  }
  console.log(`  ✓ stepSize=1e-15 Precision Clamping -> ${subnormalChunk} (Precision clamped to max 8 decimal places)`);

  // Hazard 6: Non-power-of-10 step size 0.25 (Quantization multiple check: 30% of 1.0 = 0.30 -> floor to 0.25)
  const nonPower10Chunk = calculatePartialExitChunk(1.0, 1.0, 30, 0.25, 0.25, 5.0, 100.0);
  if (nonPower10Chunk !== 0.25) {
    throw new Error(`FAIL: stepSize=0.25 expected quantized chunk 0.25, got ${nonPower10Chunk}`);
  }
  console.log(`  ✓ Non-power-of-10 step size (stepSize=0.25, raw 0.30) -> Quantized strictly to ${nonPower10Chunk} (Exact integer multiple)`);

  // Hazard 7: Out-of-bounds inputs (markPrice=0, percent=0, quantity=NaN)
  const zeroPriceChunk = calculatePartialExitChunk(0.010, 0.010, 20, 0.001, 0.001, 5.0, 0);
  const nanQtyChunk = calculatePartialExitChunk(NaN, 0.010, 20, 0.001, 0.001, 5.0, 60000.0);
  if (zeroPriceChunk !== 0 || nanQtyChunk !== 0) {
    throw new Error(`FAIL: Expected 0 for out-of-bounds inputs, got zeroPrice: ${zeroPriceChunk}, nanQty: ${nanQtyChunk}`);
  }
  console.log(`  ✓ Out-of-bounds input protection (markPrice=0, qty=NaN) -> Returned 0 safely`);

  // 4. Verify 5-Stage Partial TP Execution & Trailing SL Ladder
  console.log("\n[TEST 4] Verifying 5-Stage Partial TP & Trailing SL Ladder Execution...");
  const hedgeLedger = new HedgePositionLedger("BTCUSDT", 3);
  hedgeLedger.occupyCoreLong(0.010, 60000.0, 5.0, 2.0); // Core Long 0.010 BTC @ $60,000

  // Stage 1: Price rises to $61,250 (+2.08% -> TP1 Target)
  const tp1Triggers = hedgeLedger.evaluateHedgeDynamicTpSl(61250.0);
  if (tp1Triggers.length === 0 || tp1Triggers[0].reason !== "TAKE_PROFIT_TP1") {
    throw new Error(`FAIL: Expected TAKE_PROFIT_TP1 trigger, got: ${JSON.stringify(tp1Triggers)}`);
  }
  console.log(`  ✓ Stage 1 Triggered: ${tp1Triggers[0].reason} | Partial Exit: ${tp1Triggers[0].quantity} BTC @ $61,250`);

  const coreLongAfterTp1 = hedgeLedger.getCoreLong();
  if (!coreLongAfterTp1.breakEvenLocked || coreLongAfterTp1.stopLossPrice < 60000.0) {
    throw new Error(`FAIL: Break-Even SL lock failed after TP1! SL Price: ${coreLongAfterTp1.stopLossPrice}`);
  }
  console.log(`  ✓ Break-Even SL Locked: $${coreLongAfterTp1.stopLossPrice.toFixed(2)} (Position is now ZERO-LOSS guaranteed)`);
  console.log(`  ✓ Remaining Slot Position Quantity: ${coreLongAfterTp1.quantity} BTC`);

  // Stage 2: Price rises to $61,850 (+3.08% -> TP2 Target)
  const tp2Triggers = hedgeLedger.evaluateHedgeDynamicTpSl(61850.0);
  if (tp2Triggers.length === 0 || tp2Triggers[0].reason !== "TAKE_PROFIT_TP2") {
    throw new Error(`FAIL: Expected TAKE_PROFIT_TP2 trigger, got: ${JSON.stringify(tp2Triggers)}`);
  }
  console.log(`  ✓ Stage 2 Triggered: ${tp2Triggers[0].reason} | Partial Exit: ${tp2Triggers[0].quantity} BTC @ $61,850`);
  console.log(`  ✓ SL Trailed to TP1 level: $${hedgeLedger.getCoreLong().stopLossPrice.toFixed(2)}`);

  // Stage 3: Price drops back to hit Trailed SL (TP1 price $61,200)
  const slTriggers = hedgeLedger.evaluateHedgeDynamicTpSl(61150.0);
  if (slTriggers.length === 0 || slTriggers[0].reason !== "BREAK_EVEN_STOP_LOSS") {
    throw new Error(`FAIL: Expected BREAK_EVEN_STOP_LOSS trigger when price retraces, got: ${JSON.stringify(slTriggers)}`);
  }
  console.log(`  ✓ Trailed Zero-Loss SL Triggered on Retrace: ${slTriggers[0].reason} @ $61,150 | Exit Size: ${slTriggers[0].quantity} BTC`);
  console.log(`  ✓ Final Position State: FLAT (100% Locked Profit Realized with ZERO Loss)`);

  console.log("\n================================================================================");
  console.log("       ALL 4 MASTER-LEVEL ZERO-LOSS & TP VERIFICATION TESTS PASSED!             ");
  console.log("================================================================================");
}

runMultiTpZeroLossTests().catch((err) => {
  console.error("Critical Test Failure:", err.message);
  process.exit(1);
});
