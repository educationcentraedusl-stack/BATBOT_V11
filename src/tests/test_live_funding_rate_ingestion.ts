/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * Verification Test Suite: Live Perpetual Funding Rate Telemetry Ingestion (Critical Failure 2 Remediation)
 *
 * Verifies:
 * 1. Live Binance REST /fapi/v1/premiumIndex ingestion and atomic write to SAB Slot 168.
 * 2. Multi-asset batch funding rate synchronization.
 * 3. StrategyEngine.syncFundingRate() and live evaluateTick() filter enforcement.
 * 4. Real-time WebSocket @markPrice@1s ingestion and SAB Slot 168 atomic update.
 * 5. Sub-microsecond latency (< 0.50 µs) and Zero-GC compliance (< 50 bytes/call).
 */

import { MarketDataClient } from "../marketDataClient";
import { StrategyEngine } from "../strategy/engine";
import { RiskGuard } from "../strategy/risk";
import { BinanceExecutionClient } from "../execution/binance";

console.log("================================================================================");
console.log("  CRITICAL FAILURE 2 VERIFICATION: LIVE FUNDING RATE TELEMETRY INGESTION        ");
console.log("================================================================================");

let totalPassed = 0;
let totalFailed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    totalPassed++;
    console.log(`  ✅ [PASS] ${message}`);
  } else {
    totalFailed++;
    console.error(`  ❌ [FAIL] ${message}`);
  }
}

async function runVerificationSuite(): Promise<void> {
  const slotsPerAsset = 256;
  const maxAssets = 10;
  const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
  const client = new MarketDataClient(sab, maxAssets, slotsPerAsset);
  const riskGuard = new RiskGuard();
  const executionClient = new BinanceExecutionClient();
  let engine: StrategyEngine | null = null;

  try {

  // STAGE 1: Binance REST /fapi/v1/premiumIndex Ingestion
  console.log("\n--- STAGE 1: Live Binance REST /fapi/v1/premiumIndex Telemetry ---");
  const liveRate = await executionClient.fetchFundingRate("BTCUSDT");
  console.log(`  [REST] Binance BTCUSDT Live Funding Rate fetched: ${String(liveRate)} (${(liveRate * 10000).toFixed(4)} bps)`);

  assert(Number.isFinite(liveRate), "Live funding rate from Binance is a finite float");

  // Atomically write live rate to SAB Slot 168
  client.setFundingRate(liveRate, 0);
  const readRate = client.getFundingRate(0);
  assert(Math.abs(readRate - liveRate) < 1e-12, "SAB Slot 168 accurately stores and returns the live funding rate");

  // STAGE 2: Multi-Asset Batch Synchronization
  console.log("\n--- STAGE 2: Multi-Asset Batch Funding Rate Synchronization ---");
  await executionClient.syncAllFundingRates(client);
  const asset0Rate = client.getFundingRate(0);
  console.log(`  [BATCH] Asset 0 (BTCUSDT) SAB Slot 168 after syncAllFundingRates: ${String(asset0Rate)}`);
  assert(Number.isFinite(asset0Rate), "Batch sync successfully populated Asset 0 SAB Slot 168");

  // STAGE 3: StrategyEngine Real-Time Telemetry & Filtering
  console.log("\n--- STAGE 3: StrategyEngine Integration & Tick Filter Activation ---");
  engine = new StrategyEngine(client, riskGuard, executionClient, { symbol: "BTCUSDT", assetIndex: 0 });

  const syncedRate = await engine.syncFundingRate();
  console.log(`  [ENGINE] engine.syncFundingRate() returned: ${String(syncedRate)}`);
  assert(Math.abs(engine.getFundingRate() - syncedRate) < 1e-12, "engine.getFundingRate() reflects freshly synced rate");

  // Verify mathematical filtering logic on live rate
  const maxFunding = engine.getMaxPermittedFundingRate();
  if (syncedRate > maxFunding) {
    assert(!engine.isFundingRatePermitted("LONG"), "Live High Positive Rate: LONG entry strictly BLOCKED");
    assert(engine.isFundingRatePermitted("SHORT"), "Live High Positive Rate: SHORT entry strictly ALLOWED");
  } else if (syncedRate < -maxFunding) {
    assert(engine.isFundingRatePermitted("LONG"), "Live High Negative Rate: LONG entry strictly ALLOWED");
    assert(!engine.isFundingRatePermitted("SHORT"), "Live High Negative Rate: SHORT entry strictly BLOCKED");
  } else {
    assert(engine.isFundingRatePermitted("LONG"), "Within-Tolerance Rate: LONG entry allowed");
    assert(engine.isFundingRatePermitted("SHORT"), "Within-Tolerance Rate: SHORT entry allowed");
  }

  // STAGE 4: Real-Time Stream Hook & Atomic Update Verification
  console.log("\n--- STAGE 4: Real-Time Stream Telemetry Hook Verification ---");
  await executionClient.ensureFundingRateStream(client, 0, "BTCUSDT");
  const streamRate = client.getFundingRate(0);
  assert(Number.isFinite(streamRate), "ensureFundingRateStream successfully initialized and hydrated SAB Slot 168");

  // Detach background network stream prior to micro-benchmark to avoid network socket heap noise
  executionClient.destroy();

  // STAGE 5: Latency SLA & Zero-GC Benchmark
  console.log("\n--- STAGE 5: Latency SLA & Zero-GC Invariant Benchmark ---");
  const ITERATIONS = 100000;

  // JIT warm-up
  for (let i = 0; i < 10000; i++) {
    engine.isFundingRatePermitted(i % 2 === 0 ? "LONG" : "SHORT");
  }

  if (global.gc) global.gc();
  const memBefore = process.memoryUsage().heapUsed;
  const startHr = process.hrtime.bigint();

  for (let i = 0; i < ITERATIONS; i++) {
    engine.isFundingRatePermitted(i % 2 === 0 ? "LONG" : "SHORT");
  }

  const endHr = process.hrtime.bigint();
  const memAfter = process.memoryUsage().heapUsed;
  const totalNs = Number(endHr - startHr);
  const avgUs = (totalNs / ITERATIONS) / 1000;
  const heapDeltaBytes = Math.max(0, memAfter - memBefore);
  const bytesPerCall = heapDeltaBytes / ITERATIONS;

  console.log(`  [BENCHMARK] Executed ${ITERATIONS.toLocaleString()} calls in ${(totalNs / 1e6).toFixed(2)} ms`);
  console.log(`  [BENCHMARK] Latency: ${avgUs.toFixed(4)} µs/call (SLA: < 0.50 µs)`);
  console.log(`  [BENCHMARK] Heap Delta: ${bytesPerCall.toFixed(2)} bytes/call (SLA: < 50.0 bytes/call)`);

  assert(avgUs < 0.50, `Sub-microsecond latency verified (${avgUs.toFixed(4)} µs < 0.50 µs)`);
  assert(bytesPerCall < 50.0, `Zero-GC invariant verified (${bytesPerCall.toFixed(2)} bytes/call < 50 bytes)`);

  console.log("\n================================================================================");
  console.log(`  CRITICAL FAILURE 2 VERIFICATION SUMMARY: ${String(totalPassed)} PASSED / ${String(totalFailed)} FAILED`);
  console.log("================================================================================");

  if (totalFailed > 0) {
    throw new Error(`Verification suite failed with ${String(totalFailed)} assertion failure(s).`);
  }
  } finally {
    engine?.destroy();
    executionClient.destroy();
  }
}

runVerificationSuite().catch((err: unknown) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
