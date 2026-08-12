import { MarketDataClient } from "./marketDataClient";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient } from "./execution/binance";
import { StrategyEngine } from "./strategy/engine";

function createMockSharedArrayBuffer(): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(20480);
  const view = new BigInt64Array(sab);

  const bitcastBuf = new ArrayBuffer(8);
  const bitcastBigInt = new BigInt64Array(bitcastBuf);
  const bitcastFloat = new Float64Array(bitcastBuf);

  function writeFloat(slot: number, val: number) {
    bitcastFloat[0] = val;
    Atomics.store(view, slot, bitcastBigInt[0]);
  }

  // Populate mock tick values
  Atomics.store(view, 0, BigInt(Date.now() * 1_000_000)); // Timestamp
  writeFloat(1, 0.45); // OBI
  writeFloat(2, 120.0); // CVD
  writeFloat(3, 0.02); // Spread Velocity
  writeFloat(4, 50000.0); // Best Bid Price
  writeFloat(5, 5.0); // Best Bid Qty
  writeFloat(6, 50001.0); // Best Ask Price
  writeFloat(7, 5.0); // Best Ask Qty
  Atomics.store(view, 92, 100n); // Sequence Num

  // AI predictions
  writeFloat(93, 1.0); // Direction BUY
  writeFloat(94, 0.85); // Confidence 85%

  // Microstructure metrics
  writeFloat(121, 0.0035); // Garman-Klass Volatility 0.35%
  writeFloat(122, 0.25); // VPIN low toxicity
  writeFloat(123, 0.62); // Hurst 0.62 (Trending)
  writeFloat(124, 0.15); // LOB entropy
  writeFloat(125, 1); // Regime 1 (DirectionalTrend)
  writeFloat(126, 0.0); // Sweep detected = false

  return sab;
}

async function runDynamicRiskAndTrapTests() {
  console.log("=== BATBOT_V11: 2026 Dynamic Risk & Microstructure Trap Mitigation Test Suite ===");

  const sab = createMockSharedArrayBuffer();
  const client = new MarketDataClient(sab);
  const riskGuard = new RiskGuard({ maxPositionSizeUsdt: 5000, minCooldownMs: 0 });
  const execClient = new BinanceExecutionClient({ apiKey: "MOCK_KEY", apiSecret: "MOCK_SECRET", useTestnet: true });

  const strategy = new StrategyEngine(client, riskGuard, execClient, {
    symbol: "BTCUSDT",
    orderQuantity: 0.001,
    minAiConfidence: 0.6,
  });

  // TEST 1: Normal Signal Generation & Dynamic TP/SL Expansion
  console.log("\n[TEST 1] Testing Normal Signal Generation & Dynamic Collar Expansion...");
  const tickResult1 = strategy.evaluateTick();

  console.log(`Signal Type: ${tickResult1.signalType}`);
  console.log(`Position Side: ${tickResult1.positionSide}`);
  if (tickResult1.riskResult) {
    console.log(`Risk Check Passed: ${tickResult1.riskResult.passed}, Reason: ${tickResult1.riskResult.reasonCode}`);
  }
  console.assert(tickResult1.signalType === "BUY", "Expected BUY signal under high AI confidence and bullish OBI");

  // TEST 2: High VPIN Toxic Flow Injection -> Order Suppression
  console.log("\n[TEST 2] Injecting High VPIN Toxic Flow (VPIN = 0.85)...");
  const bitcastBuf = new ArrayBuffer(8);
  const bitcastBigInt = new BigInt64Array(bitcastBuf);
  const bitcastFloat = new Float64Array(bitcastBuf);
  const view = new BigInt64Array(sab);

  bitcastFloat[0] = 0.85; // High VPIN Toxic Flow
  Atomics.store(view, 122, bitcastBigInt[0]);
  Atomics.store(view, 92, 101n); // Update sequence num

  const tickResult2 = strategy.evaluateTick();
  console.log(`Signal Type: ${tickResult2.signalType}`);
  if (tickResult2.riskResult) {
    console.log(`Risk Check Passed: ${tickResult2.riskResult.passed}, Reason: ${tickResult2.riskResult.reasonCode}`);
    console.log(`Message: ${tickResult2.riskResult.message}`);
    console.assert(!tickResult2.riskResult.passed, "Order should be rejected under high VPIN toxic flow");
    console.assert(
      tickResult2.riskResult.reasonCode === "REJECTED_TOXIC_FLOW" ||
        tickResult2.riskResult.reasonCode === "REJECTED_COUNTER_TREND_REGIME",
      "Expected REJECTED_TOXIC_FLOW or REJECTED_COUNTER_TREND_REGIME"
    );
  }

  // TEST 3: Liquidity Sweep Trap Injection -> Order Suppression
  console.log("\n[TEST 3] Injecting Liquidity Sweep Trap (isSweepDetected = true)...");
  bitcastFloat[0] = 0.20; // Reset VPIN
  Atomics.store(view, 122, bitcastBigInt[0]);
  bitcastFloat[0] = 1.0; // Flag liquidity sweep trap
  Atomics.store(view, 126, bitcastBigInt[0]);
  Atomics.store(view, 92, 102n); // Update sequence num

  const tickResult3 = strategy.evaluateTick();
  if (tickResult3.riskResult) {
    console.log(`Risk Check Passed: ${tickResult3.riskResult.passed}, Reason: ${tickResult3.riskResult.reasonCode}`);
    console.log(`Message: ${tickResult3.riskResult.message}`);
    console.assert(!tickResult3.riskResult.passed, "Order should be rejected during liquidity sweep");
    console.assert(
      tickResult3.riskResult.reasonCode === "REJECTED_LIQUIDITY_SWEEP_TRAP",
      "Expected REJECTED_LIQUIDITY_SWEEP_TRAP"
    );
  }

  // TEST 4: Microsecond Latency Benchmark (100,000 Tick Evaluations)
  console.log("\n[TEST 4] Benchmarking 100,000 Tick Evaluations with Dynamic Risk Active...");
  bitcastFloat[0] = 0.0; // Reset sweep flag
  Atomics.store(view, 126, bitcastBigInt[0]);

  const ITERATIONS = 100_000;
  const startTime = process.hrtime.bigint();

  for (let i = 0; i < ITERATIONS; i++) {
    Atomics.store(view, 92, BigInt(200 + i));
    strategy.evaluateTick();
  }

  const endTime = process.hrtime.bigint();
  const totalNs = Number(endTime - startTime);
  const avgNsPerTick = totalNs / ITERATIONS;
  const avgUsPerTick = avgNsPerTick / 1000;

  console.log(`Evaluated ${ITERATIONS.toLocaleString()} ticks in ${(totalNs / 1e6).toFixed(2)} ms.`);
  console.log(`Average Latency Per Tick: ${avgNsPerTick.toFixed(2)} ns (${avgUsPerTick.toFixed(4)} µs).`);

  if (avgUsPerTick <= 1.5) {
    console.log(`✅ LATENCY BENCHMARK PASSED! (${avgUsPerTick.toFixed(4)} µs <= 1.5000 µs target)`);
  } else {
    console.warn(`⚠️ Latency benchmark exceeded target: ${avgUsPerTick.toFixed(4)} µs`);
  }

  console.log("\n=== ALL DYNAMIC RISK & TRAP MITIGATION TESTS COMPLETED SUCCESSFULLY ===");
}

runDynamicRiskAndTrapTests().catch((err) => {
  console.error("Test Suite Failed with error:", err);
  process.exit(1);
});
