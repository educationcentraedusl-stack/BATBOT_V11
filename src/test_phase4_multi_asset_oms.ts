import { MultiAssetExecutor } from "./execution/multi_asset_executor";
import { performance } from "perf_hooks";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error("❌ ASSERTION FAILED: " + message);
    process.exit(1);
  }
}

async function runPhase4MultiAssetOmsTest() {
  console.log("================================================================================");
  console.log("⚡ BATBOT_V11 PHASE 4: MULTI-ASSET OMS & EXECUTION ENGINE BENCHMARK HARNESS");
  console.log("================================================================================");

  const activeSymbols = [
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "XRPUSDT",
    "ADAUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "SUIUSDT",
    "NEARUSDT",
  ];

  const initialBalance = 100000.0;
  const executor = new MultiAssetExecutor({
    initialBalanceUsd: initialBalance,
    activeSymbols,
  });

  // Create 20,480-byte SharedArrayBuffer (10 assets * 256 slots * 8 bytes)
  const sab = new SharedArrayBuffer(20480);
  const sabBuffer = Buffer.from(sab);
  const floatsView = new Float64Array(sab);

  console.log("[Phase 4 Test] Initialized MultiAssetExecutor with 10 assets & 20,480-byte SAB.");

  // 1. Basic Intent Submission Test across all 10 assets
  console.log("\n[Test 1] Testing basic order intent submission across 10 asset slots...");
  for (let idx = 0; idx < activeSymbols.length; idx++) {
    const symbol = activeSymbols[idx];
    const midPrice = 100.0 + idx * 50.0;
    const res = executor.submitIntent(
      symbol,
      "BUY",
      "LIMIT",
      1.0,
      midPrice * 0.999,
      midPrice,
      50000.0,
      0.001,
      0.01,
      1.0,
      0.20
    );

    assert(res.status === "SUBMITTED", "Symbol " + symbol + " intent should be SUBMITTED but got " + res.status + " (" + res.reason + ")");
    assert(Array.isArray(res.slices) && res.slices.length > 0, "Symbol " + symbol + " should return slices array");
  }
  console.log("  ✅ Basic intent submission verified across all 10 assets.");

  // 2. Pre-Trade Risk Collar Rejection Verification
  console.log("\n[Test 2] Testing Pre-Trade Risk Guard rejection collars...");

  // 2A: Price Collar Violation (> 1.0% deviation)
  const priceCollarRes = executor.submitIntent(
    "ETHUSDT",
    "BUY",
    "LIMIT",
    1.0,
    3500.0,
    3000.0,
    50000.0,
    0.001,
    0.01,
    1.0,
    0.20
  );
  assert(priceCollarRes.status === "REJECTED", "Price collar violation should be REJECTED");
  assert(priceCollarRes.reason === "REJECTED_PRICE_COLLAR", "Expected REJECTED_PRICE_COLLAR got " + priceCollarRes.reason);
  console.log("  ✅ Price Collar Guard rejection verified.");

  // 2B: Gross Leverage Cap Violation (> 3.0x cap)
  const leverageCapRes = executor.submitIntent(
    "SOLUSDT",
    "BUY",
    "LIMIT",
    1.0,
    150.0,
    150.0,
    50000.0,
    0.001,
    0.01,
    3.5,
    0.20
  );
  assert(leverageCapRes.status === "REJECTED", "Gross leverage cap violation should be REJECTED");
  assert(leverageCapRes.reason === "REJECTED_LEVERAGE_CAP", "Expected REJECTED_LEVERAGE_CAP got " + leverageCapRes.reason);
  console.log("  ✅ Gross Leverage Cap Guard rejection verified.");

  // 2C: Correlation Emergency Brake (> 0.85 threshold)
  const correlationRes = executor.submitIntent(
    "BNBUSDT",
    "BUY",
    "LIMIT",
    1.0,
    500.0,
    500.0,
    50000.0,
    0.001,
    0.01,
    1.0,
    0.92
  );
  assert(correlationRes.status === "REJECTED", "Correlation emergency brake should be REJECTED");
  assert(correlationRes.reason === "REJECTED_CORRELATION_SPIKE", "Expected REJECTED_CORRELATION_SPIKE got " + correlationRes.reason);
  console.log("  ✅ Correlation Emergency Brake rejection verified.");

  // 3. Execution Slicing Verification (Order > 2% top-5 depth)
  console.log("\n[Test 3] Testing sub-second micro-slice TWAP / Iceberg execution slicer...");
  const largeOrderRes = executor.submitIntent(
    "XRPUSDT",
    "BUY",
    "LIMIT",
    50000.0,
    0.50,
    0.50,
    10000.0,
    0.1,
    0.0001,
    1.0,
    0.20
  );
  assert(largeOrderRes.status === "SUBMITTED", "Large sliced order should be SUBMITTED");
  assert(largeOrderRes.slices!.length > 1, "Large order should be sliced into multiple packets");
  console.log("  ✅ Large intent sliced into " + largeOrderRes.slices!.length + " micro-packets successfully.");

  // 4. Lock-Free SPSC Ring Buffer Queue Verification
  console.log("\n[Test 4] Testing SPSC Lock-Free Ring Buffer Intent Packet Popping...");
  let poppedCount = 0;
  let pkt: any = null;
  while ((pkt = executor.popNextPacket()) !== null) {
    poppedCount++;
    assert(pkt.asset_idx >= 0 && pkt.asset_idx < 10, "Popped packet must have valid asset_idx");
    assert(pkt.quantity > 0, "Popped packet must have valid quantity");
  }
  assert(poppedCount > 0, "Ring buffer should have popped queued packets");
  console.log("  ✅ Popped " + poppedCount + " intent packets from lock-free ring buffer queue cleanly.");

  // 5. Zero-Copy SAB Slot Synchronization Verification
  console.log("\n[Test 5] Testing SAB Slot Synchronization for Slots 181..200...");
  const syncSuccess = executor.syncSab(sabBuffer);
  assert(syncSuccess, "syncSab should return true");
  
  const asset0Submitted = floatsView[186];
  assert(asset0Submitted > 0, "SAB Slot 186 (Submitted Orders) for Asset 0 should be > 0, got " + asset0Submitted);
  console.log("  ✅ SAB Slot 186 (Submitted Orders) verified: " + asset0Submitted);

  // 6. High-Frequency Latency & Throughput Benchmark Harness (100,000 intents)
  console.log("\n[Test 6] Executing 100,000 synthetic multi-asset order intents stress benchmark...");
  const ITERATIONS = 100000;
  const startTime = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    const assetIdx = i % 10;
    const symbol = activeSymbols[assetIdx];
    const basePrice = 100.0 + assetIdx * 10;
    executor.submitIntent(
      symbol,
      i % 2 === 0 ? "BUY" : "SELL",
      "LIMIT",
      1.0,
      basePrice,
      basePrice,
      50000.0,
      0.001,
      0.01,
      0.5,
      0.10
    );

    if (i % 100 === 0) {
      executor.popNextPacket();
    }
  }

  const elapsedMs = performance.now() - startTime;
  const latencyPerTickUs = (elapsedMs * 1000) / ITERATIONS;
  const throughput = Math.round((ITERATIONS / elapsedMs) * 1000);

  console.log("\n================================================================================");
  console.log("📊 BENCHMARK RESULTS (100,000 MULTI-ASSET OMS INTENTS):");
  console.log("   - Total Execution Time : " + elapsedMs.toFixed(2) + " ms");
  console.log("   - Average Latency      : " + latencyPerTickUs.toFixed(3) + " us per intent");
  console.log("   - Engine Throughput    : " + throughput.toLocaleString() + " intents / sec");
  console.log("================================================================================");

  assert(latencyPerTickUs < 250.0, "Latency target < 250 us violated: " + latencyPerTickUs.toFixed(3) + " us");
  console.log("\n🎉 ALL PHASE 4 MULTI-ASSET OMS QA VERIFICATION TESTS PASSED SUCCESSFULLY!");
}

runPhase4MultiAssetOmsTest().catch((err) => {
  console.error("❌ Test Harness Error:", err);
  process.exit(1);
});
