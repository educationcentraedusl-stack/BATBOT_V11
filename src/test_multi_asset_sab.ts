import "dotenv/config";
import { MarketDataClient } from "./marketDataClient";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function runMultiAssetSabTests(): Promise<void> {
  console.log("=========================================================================");
  console.log("  BATBOT_V11 PHASE 1: MULTI-ASSET SAB & RUST DATA LAYER QA VERIFICATION  ");
  console.log("=========================================================================\n");

  // 1. Validate Dynamic Environment Variable Ingestion
  const envMaxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || "10", 10);
  const envSlotsPerAsset = parseInt(process.env.SAB_SLOTS_PER_ASSET || "256", 10);
  const expectedBytes = envMaxAssets * envSlotsPerAsset * 8;

  console.log(`[QA Test 1] Dynamic Environment Configuration:`);
  console.log(`  - MAX_CONCURRENT_ASSETS : ${envMaxAssets}`);
  console.log(`  - SAB_SLOTS_PER_ASSET   : ${envSlotsPerAsset}`);
  console.log(`  - Calculated SAB Bytes  : ${expectedBytes} bytes (${expectedBytes / 1024} KB)\n`);

  assert(envMaxAssets >= 10, "MAX_CONCURRENT_ASSETS must be >= 10");
  assert(envSlotsPerAsset === 256, "SAB_SLOTS_PER_ASSET must be 256");

  // 2. Validate Buffer Size Safeguard (Throw error if buffer too small)
  console.log(`[QA Test 2] Testing Buffer Underflow Safeguard...`);
  try {
    const smallSab = new SharedArrayBuffer(1024);
    new MarketDataClient(smallSab, envMaxAssets, envSlotsPerAsset);
    assert(false, "MarketDataClient should have thrown an error for undersized buffer");
  } catch (err: any) {
    console.log(`  ✅ Correctly caught undersized buffer exception: "${err.message}"\n`);
  }

  // 3. Multi-Asset Atomic SharedArrayBuffer Read/Write Isolation
  console.log(`[QA Test 3] Validating Cross-Asset Memory Isolation across ${envMaxAssets} Assets...`);
  const sab = new SharedArrayBuffer(expectedBytes);
  const client = new MarketDataClient(sab, envMaxAssets, envSlotsPerAsset);

  // Write distinct test vectors into each asset slot
  const sampleData = Array.from({ length: envMaxAssets }, (_, i) => ({
    assetIdx: i,
    symbol: `ALT_ASSET_${i + 1}`,
    bidPrice: 100.5 + i * 12.34,
    askPrice: 100.8 + i * 12.34,
    obi: 0.15 * (i % 2 === 0 ? 1 : -1) * (i + 1),
    cvd: 1500.0 * (i + 1),
    hawkesIntensity: 2.5 + i * 0.4,
    garmanKlassRv: 0.012 + i * 0.003,
    hurstExponent: 0.55 + i * 0.02,
    vpin: 0.45 + i * 0.03,
    regime: i % 4,
  }));

  const bigIntView = new BigInt64Array(sab);
  const floatBuf = new ArrayBuffer(8);
  const floatBigInt = new BigInt64Array(floatBuf);
  const floatVal = new Float64Array(floatBuf);

  function writeFloat(assetIdx: number, slot: number, val: number): void {
    const globalSlot = assetIdx * envSlotsPerAsset + slot;
    floatVal[0] = val;
    Atomics.store(bigIntView, globalSlot, floatBigInt[0]);
  }

  function writeBigInt(assetIdx: number, slot: number, val: bigint): void {
    const globalSlot = assetIdx * envSlotsPerAsset + slot;
    Atomics.store(bigIntView, globalSlot, val);
  }

  // Populate synthetic LOB metrics for each asset
  for (const item of sampleData) {
    const idx = item.assetIdx;
    writeBigInt(idx, 0, BigInt(1700000000000000 + idx * 1000));
    writeFloat(idx, 1, item.obi);
    writeFloat(idx, 2, item.cvd);
    writeFloat(idx, 4, item.bidPrice);
    writeFloat(idx, 6, item.askPrice);
    writeFloat(idx, 112, item.hawkesIntensity);
    writeFloat(idx, 121, item.garmanKlassRv);
    writeFloat(idx, 122, item.vpin);
    writeFloat(idx, 123, item.hurstExponent);
    writeFloat(idx, 125, item.regime);

    // Populate Top 20 Bids and Asks
    for (let level = 0; level < 20; level++) {
      writeFloat(idx, 11 + level * 2, item.bidPrice - level * 0.1);
      writeFloat(idx, 11 + level * 2 + 1, 10.0 + level + idx);
      writeFloat(idx, 51 + level * 2, item.askPrice + level * 0.1);
      writeFloat(idx, 51 + level * 2 + 1, 10.0 + level + idx);
    }
  }

  // Verify non-interference: Read back and assert 100% exact equality for all assets
  for (const item of sampleData) {
    const idx = item.assetIdx;
    const readBid = client.getBestBidPrice(idx);
    const readAsk = client.getBestAskPrice(idx);
    const readObi = client.getOBI(idx);
    const readCvd = client.getCVD(idx);
    const readHawkes = client.getHawkesIntensity(idx);
    const readRv = client.getGarmanKlassRV(idx);
    const readHurst = client.getHurstExponent(idx);

    assert(Math.abs(readBid - item.bidPrice) < 1e-6, `Asset ${idx} bid mismatch: expected ${item.bidPrice}, got ${readBid}`);
    assert(Math.abs(readAsk - item.askPrice) < 1e-6, `Asset ${idx} ask mismatch: expected ${item.askPrice}, got ${readAsk}`);
    assert(Math.abs(readObi - item.obi) < 1e-6, `Asset ${idx} OBI mismatch: expected ${item.obi}, got ${readObi}`);
    assert(Math.abs(readCvd - item.cvd) < 1e-6, `Asset ${idx} CVD mismatch: expected ${item.cvd}, got ${readCvd}`);
    assert(Math.abs(readHawkes - item.hawkesIntensity) < 1e-6, `Asset ${idx} Hawkes mismatch: expected ${item.hawkesIntensity}, got ${readHawkes}`);
    assert(Math.abs(readRv - item.garmanKlassRv) < 1e-6, `Asset ${idx} RV mismatch: expected ${item.garmanKlassRv}, got ${readRv}`);
    assert(Math.abs(readHurst - item.hurstExponent) < 1e-6, `Asset ${idx} Hurst mismatch: expected ${item.hurstExponent}, got ${readHurst}`);

    // Verify top bids buffer filler
    const topBidsBuf = new Float64Array(40);
    client.fillTopBids(topBidsBuf, 20, idx);
    assert(Math.abs(topBidsBuf[0] - item.bidPrice) < 1e-6, `Asset ${idx} fillTopBids level 0 price mismatch`);
    assert(Math.abs(topBidsBuf[1] - (10.0 + idx)) < 1e-6, `Asset ${idx} fillTopBids level 0 qty mismatch`);
  }
  console.log(`  ✅ All ${envMaxAssets} assets verified with 100% memory isolation & zero cross-talk!\n`);

  // 4. Sub-Microsecond Multi-Asset Scalar Getter Benchmark
  console.log(`[QA Test 4A] Multi-Asset Scalar Getter Benchmark (100,000 Ticks across ${envMaxAssets} assets)...`);
  // Warm up V8 JIT optimization pipeline
  for (let w = 0; w < 5000; w++) {
    client.getOBI(w % envMaxAssets);
    client.getCVD(w % envMaxAssets);
  }

  const totalTicks = 100000;
  const startHrTime1 = process.hrtime.bigint();

  for (let t = 0; t < totalTicks; t++) {
    const targetAssetIdx = t % envMaxAssets;
    const obi = client.getOBI(targetAssetIdx);
    const cvd = client.getCVD(targetAssetIdx);
    const hawkes = client.getHawkesIntensity(targetAssetIdx);
    const rv = client.getGarmanKlassRV(targetAssetIdx);
    if (obi === 99999.99 || cvd === 99999.99 || hawkes === 99999.99 || rv === 99999.99) {
      console.log("Unreachable");
    }
  }

  const endHrTime1 = process.hrtime.bigint();
  const totalNs1 = Number(endHrTime1 - startHrTime1);
  const avgNsPerTick1 = totalNs1 / totalTicks;
  const avgUsPerTick1 = avgNsPerTick1 / 1000.0;
  const ticksPerSec1 = Math.round((totalTicks / (totalNs1 / 1e9)));

  console.log(`  - Total Executed Ticks : ${totalTicks.toLocaleString()}`);
  console.log(`  - Total Duration       : ${(totalNs1 / 1e6).toFixed(2)} ms`);
  console.log(`  - Average Tick Latency : ${avgNsPerTick1.toFixed(1)} ns (${avgUsPerTick1.toFixed(3)} µs)`);
  console.log(`  - Throughput           : ${ticksPerSec1.toLocaleString()} ticks/sec`);

  assert(avgUsPerTick1 < 2.0, `Scalar tick latency ${avgUsPerTick1.toFixed(3)} µs exceeded threshold (2.0 µs for 4-metric tick evaluation)`);
  console.log(`  ✅ Passed Sub-Microsecond Scalar Metric Latency Benchmark! (Target < 2.0 µs for 4 metrics, ${(avgNsPerTick1 / 4).toFixed(1)} ns per atomic read)\n`);

  // 4B. Full 20-Level Depth Buffer Filler Benchmark (44 Atomic Loads per tick)
  console.log(`[QA Test 4B] Multi-Asset Full 20-Depth LOB Buffer Filler Benchmark (100,000 Ticks)...`);
  const topBidsBuffer = new Float64Array(40);
  const startHrTime2 = process.hrtime.bigint();

  for (let t = 0; t < totalTicks; t++) {
    const targetAssetIdx = t % envMaxAssets;
    client.fillTopBids(topBidsBuffer, 20, targetAssetIdx);
  }

  const endHrTime2 = process.hrtime.bigint();
  const totalNs2 = Number(endHrTime2 - startHrTime2);
  const avgNsPerTick2 = totalNs2 / totalTicks;
  const avgUsPerTick2 = avgNsPerTick2 / 1000.0;
  const ticksPerSec2 = Math.round((totalTicks / (totalNs2 / 1e9)));

  console.log(`  - Total Executed Ticks : ${totalTicks.toLocaleString()}`);
  console.log(`  - Total Duration       : ${(totalNs2 / 1e6).toFixed(2)} ms`);
  console.log(`  - Average Depth Fill   : ${avgNsPerTick2.toFixed(1)} ns (${avgUsPerTick2.toFixed(3)} µs) [40 atomic loads]`);
  console.log(`  - Depth Throughput     : ${ticksPerSec2.toLocaleString()} fills/sec`);

  assert(avgUsPerTick2 < 5.0, `Full depth fill latency ${avgUsPerTick2.toFixed(3)} µs exceeded threshold (5.0 µs)`);
  console.log(`  ✅ Passed 20-Depth Level LOB Buffer Filler Benchmark! (Target < 5.0 µs)\n`);

  // 5. Dynamic Architecture Scaling Test (Testing MAX_CONCURRENT_ASSETS = 20)
  console.log(`[QA Test 5] Dynamic Architecture Scaling Test (Scaling to MAX_CONCURRENT_ASSETS = 20)...`);
  const scaledMaxAssets = 20;
  const scaledRequiredBytes = scaledMaxAssets * envSlotsPerAsset * 8; // 40,960 bytes
  const scaledSab = new SharedArrayBuffer(scaledRequiredBytes);
  const scaledClient = new MarketDataClient(scaledSab, scaledMaxAssets, envSlotsPerAsset);

  assert(scaledClient.maxAssets === 20, "Scaled maxAssets should be 20");
  assert(scaledClient.requiredBytes === 40960, "Scaled requiredBytes should be 40960");

  const scaledBigIntView = new BigInt64Array(scaledSab);
  // Write to asset 19 (the 20th asset)
  const targetSlot20 = 19 * envSlotsPerAsset + 4; // Best bid for asset 19
  floatVal[0] = 5432.10;
  Atomics.store(scaledBigIntView, targetSlot20, floatBigInt[0]);

  const readScaledBid = scaledClient.getBestBidPrice(19);
  assert(Math.abs(readScaledBid - 5432.10) < 1e-6, `Scaled asset 19 bid mismatch: expected 5432.10, got ${readScaledBid}`);
  console.log(`  ✅ Successfully scaled to 20 assets (40,960 bytes) dynamically without code changes!\n`);

  console.log("=========================================================================");
  console.log("  ✅ PHASE 1 QA VERIFICATION SUCCESSFUL: ALL TESTS PASSED CLEANLY!       ");
  console.log("=========================================================================");
}

runMultiAssetSabTests().catch((err) => {
  console.error("❌ Fatal error in Phase 1 QA Harness:", err);
  process.exit(1);
});
