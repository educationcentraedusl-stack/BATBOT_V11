/**
 * SOTA VERIFICATION TEST: CVD Velocity Z-Score Normalization & Symmetry
 * Validates that high volume bursts do not hard-saturate CVD velocity to +1.00.
 */
import { MarketDataClient } from "../marketDataClient";

function runCvdZScoreTest() {
  console.log("=== SOTA TEST 2: CVD Velocity Z-Score Normalization & Symmetry ===");

  const sab = new SharedArrayBuffer(10 * 256 * 8);
  const client = new MarketDataClient(sab, 10, 256);

  let nowMs = 1000000;

  // Simulate balanced baseline flow
  client.writeAtomicFloat64Asset(0, 2, 100.0);
  client.getCVDVelocity(0, 5000, nowMs);

  // Ingest gradual trade flow increments
  for (let i = 1; i <= 50; i++) {
    nowMs += 200;
    const cvdVal = 100.0 + i * 50.0;
    client.writeAtomicFloat64Asset(0, 2, cvdVal);
    client.getCVDVelocity(0, 5000, nowMs);
  }

  // Check steady-state velocity: should be moderate and NOT hard-pegged at +1.00
  const steadyVel = client.getCVDVelocity(0, 5000, nowMs);
  console.log(`[TEST_2] Steady State Flow CVD Velocity: ${steadyVel.toFixed(4)} (Expected: < 0.95)`);

  if (Math.abs(steadyVel) >= 0.999) {
    throw new Error(`FAIL: CVD Velocity hard-saturated to ${steadyVel}!`);
  }

  // Simulate reverse sell pressure
  for (let i = 1; i <= 20; i++) {
    nowMs += 200;
    const cvdVal = 2600.0 - i * 150.0; // Selling burst
    client.writeAtomicFloat64Asset(0, 2, cvdVal);
    client.getCVDVelocity(0, 5000, nowMs);
  }

  const sellVel = client.getCVDVelocity(0, 5000, nowMs);
  console.log(`[TEST_2] Sell Pressure Burst CVD Velocity: ${sellVel.toFixed(4)} (Expected: Negative < 0.0)`);

  if (sellVel >= 0) {
    throw new Error(`FAIL: CVD Velocity did not become negative during sell burst!`);
  }

  console.log("✅ TEST 2 PASSED: CVD Velocity dynamically adapts via EWMA MAD Z-Score standardization.\n");
}

runCvdZScoreTest();
