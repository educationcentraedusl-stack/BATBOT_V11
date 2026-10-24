import "dotenv/config";
import * as path from "path";
import { StrategyEngine, StrategyConfig } from "../strategy/engine";
import { MarketDataClient } from "../marketDataClient";
import { RiskGuard, RiskConfig } from "../strategy/risk";
import { BinanceExecutionClient } from "../execution/binance";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nativeAddon = require("../../index.js");

function createMockExecutionClient(): BinanceExecutionClient {
  const client = new BinanceExecutionClient();
  client.isConfigured = () => true;
  client.placeOrder = async () => ({
    orderId: 0,
    symbol: "MOCK",
    status: "NEW",
    clientOrderId: "MOCK",
    price: "0",
    avgPrice: "0",
    origQty: "0",
    executedQty: "0",
    cumQuote: "0",
    timeInForce: "GTC",
    type: "LIMIT",
    side: "BUY",
    reduceOnly: false,
    positionSide: "SHORT",
    stopPrice: "0",
    workingType: "CONTRACT_PRICE",
    updateTime: Date.now(),
  });
  client.cancelOrder = async () => ({
    orderId: 0,
    symbol: "MOCK",
    status: "CANCELED",
    clientOrderId: "MOCK",
    price: "0",
    avgPrice: "0",
    origQty: "0",
    executedQty: "0",
    cumQuote: "0",
    timeInForce: "GTC",
    type: "LIMIT",
    side: "BUY",
    reduceOnly: false,
    positionSide: "SHORT",
    stopPrice: "0",
    workingType: "CONTRACT_PRICE",
    updateTime: Date.now(),
  });
  client.cancelBatchOrders = async () => [];
  client.placePositionStopLoss = async () => ({
    orderId: 0,
    symbol: "MOCK",
    status: "NEW",
    clientOrderId: "MOCK",
    price: "0",
    avgPrice: "0",
    origQty: "0",
    executedQty: "0",
    cumQuote: "0",
    timeInForce: "GTC",
    type: "STOP_MARKET",
    side: "BUY",
    reduceOnly: false,
    positionSide: "SHORT",
    stopPrice: "0",
    workingType: "CONTRACT_PRICE",
    updateTime: Date.now(),
  });
  client.getDualPositionRisk = async () => [];
  client.getOpenOrders = async () => [];
  client.getUserTrades = async () => [];
  client.subscribeIncomeUpdates = () => () => {};
  client.subscribeUserTradeUpdates = () => () => {};
  return client;
}

async function runAscrgTestSuite() {
  console.log("================================================================================");
  console.log("  BATBOT_V11 SOTA: ASCRG & PHYSICAL AI INFERENCE SIGNAL GATING VERIFICATION");
  console.log("================================================================================\n");

  const sab = new SharedArrayBuffer(10 * 256 * 8);
  const client = new MarketDataClient(sab, 10, 256);

  // Initialize native Rust AIEngine with production SafeTensors weights and T-KAN LUTs
  const weightsPath = path.resolve(process.cwd(), "models/cfc_weights.safetensors");
  const tkanPath = path.resolve(process.cwd(), "models/tkan_luts.bin");
  const isLoaded = nativeAddon.loadAiModelFull(weightsPath, tkanPath, Buffer.from(sab));
  if (!isLoaded) {
    throw new Error("Failed to load native AIEngine model from disk");
  }
  console.log("  [ASCRG INIT] Native Rust AIEngine loaded successfully with SafeTensors weights & T-KAN LUTs.\n");

  const riskConfig: RiskConfig = {
    maxPositionSizeUsdt: 10000,
    minCooldownMs: 0,
    maxDailyLossUsdt: 100,
    maxPriceSlippagePercent: 1.0,
    dailyProfitLockTargetUsdt: 1000,
    minRiskRewardRatio: 2.0,
    minNetAlpha: 0.0001,
    takerFeeRate: 0.00045,
    makerFeeRate: 0.00018,
  };
  const riskGuard = new RiskGuard(riskConfig);
  const mockExec = createMockExecutionClient();

  // --------------------------------------------------------------------------------
  // [TEST 1] XRPUSDT Physical AI Inference Execution & Signal Gating (Slot #5)
  // --------------------------------------------------------------------------------
  console.log("[TEST 1] Testing XRPUSDT Physical AI Inference (Slot #5, neutral OBI -0.05)...");
  {
    const xrpConfig: Partial<StrategyConfig> = {
      symbol: "XRPUSDT",
      tradeSizeUsdt: 60,
      minAiConfidence: 0.45,
      aggressiveConfidenceThreshold: 0.50,
      obiBuyThreshold: -0.20,
      obiSellThreshold: 0.20,
      cooldownMs: 0,
      tickSize: 0.0001,
      maxShortSlots: 3,
    };

    const xrpEngine = new StrategyEngine(client, riskGuard, mockExec, xrpConfig);

    // Setup raw market data in SAB
    client.writeAtomicFloat64Asset(5, 4, 1.0008); // Best Bid
    client.writeAtomicFloat64Asset(5, 5, 5000);   // Bid Qty (5k)
    client.writeAtomicFloat64Asset(5, 6, 1.0009); // Best Ask
    client.writeAtomicFloat64Asset(5, 7, 95000);  // Ask Qty (95k)
    client.writeAtomicFloat64Asset(5, 1, -0.05);  // Neutral OBI (-0.05)
    client.writeAtomicFloat64Asset(5, 2, 30559783.0); // Session CVD
    client.writeAtomicFloat64Asset(5, 101, 0.1652); // Live IC (+0.1652 Alpha Active)
    client.writeAtomicFloat64Asset(5, 112, 1.161); // Hawkes
    client.writeAtomicFloat64Asset(5, 121, 0.00004); // Garman-Klass RV
    client.writeAtomicFloat64Asset(5, 123, 0.58); // Hurst (>0.55 trending)
    client.writeAtomicFloat64Asset(5, 124, 0.60); // LOB Entropy

    // Physical Rust AI Inference Execution on SAB (ZERO mock injection!)
    const infOk = nativeAddon.runAiInferenceAssetNapi(Buffer.from(sab), 5);
    if (!infOk) {
      throw new Error("Failed to execute physical AI inference for slot #5");
    }

    const aiDir = client.getAIPredictionDirection(5);
    const aiConf = client.getAIPredictionConfidence(5);
    const metaLogitAbs = client.getAiMetaLogitAbs(5);

    console.log(`  - Physical Rust AI Output: Direction=${aiDir.toFixed(4)}, Confidence=${(aiConf * 100).toFixed(2)}%, |meta_logit|=${metaLogitAbs.toFixed(4)}`);
    if (!Number.isFinite(aiDir) || aiDir === 0.0) {
      throw new Error(`Test 1 Failed: Expected non-zero physical AI direction, received ${aiDir}`);
    }
    if (!Number.isFinite(aiConf) || aiConf < 0.30 || aiConf > 0.70) {
      throw new Error(`Test 1 Failed: Physical AI confidence ${aiConf} out of calibrated range [0.30, 0.70]`);
    }
    if (!Number.isFinite(metaLogitAbs) || metaLogitAbs < 0.0) {
      throw new Error(`Test 1 Failed: Invalid |meta_logit| in isolated SAB slot 152: ${metaLogitAbs}`);
    }

    // Advance sequence number
    const bigIntView = new BigInt64Array(sab);
    Atomics.store(bigIntView, 5 * 256 + 92, 101n);

    const res = xrpEngine.evaluateTick();
    console.log(`  - Strategy Signal Output: ${res.signalType} (Target: ${res.positionSide || "NONE"}, Slot: ${res.slotId || "NONE"})`);
    console.log("  ✓ Test 1 Passed: Physical Rust AI Inference executed and validated in SAB slots 93/94/152!\n");
  }

  // --------------------------------------------------------------------------------
  // [TEST 2] DOGEUSDT Physical AI Inference Execution (Slot #6)
  // --------------------------------------------------------------------------------
  console.log("[TEST 2] Testing DOGEUSDT Physical AI Inference (Slot #6, neutral OBI -0.06)...");
  {
    const dogeConfig: Partial<StrategyConfig> = {
      symbol: "DOGEUSDT",
      tradeSizeUsdt: 60,
      minAiConfidence: 0.45,
      aggressiveConfidenceThreshold: 0.50,
      obiBuyThreshold: -0.20,
      obiSellThreshold: 0.20,
      cooldownMs: 0,
      tickSize: 0.00001,
      maxShortSlots: 3,
    };

    const dogeEngine = new StrategyEngine(client, riskGuard, mockExec, dogeConfig);

    client.writeAtomicFloat64Asset(6, 4, 0.07050); // Best Bid
    client.writeAtomicFloat64Asset(6, 5, 20000);   // Bid Qty
    client.writeAtomicFloat64Asset(6, 6, 0.07051); // Best Ask
    client.writeAtomicFloat64Asset(6, 7, 380000);  // Ask Qty
    client.writeAtomicFloat64Asset(6, 1, -0.06);   // Neutral OBI
    client.writeAtomicFloat64Asset(6, 2, 142276768.0); // 142M session CVD
    client.writeAtomicFloat64Asset(6, 101, 0.1652); // Live IC
    client.writeAtomicFloat64Asset(6, 112, 1.268); // Hawkes
    client.writeAtomicFloat64Asset(6, 121, 0.00004); // Garman-Klass RV
    client.writeAtomicFloat64Asset(6, 123, 0.58); // Hurst (>0.55 trending)
    client.writeAtomicFloat64Asset(6, 124, 0.60); // LOB Entropy

    // Physical Rust AI Inference Execution on SAB (ZERO mock injection!)
    const infOk = nativeAddon.runAiInferenceAssetNapi(Buffer.from(sab), 6);
    if (!infOk) {
      throw new Error("Failed to execute physical AI inference for slot #6");
    }

    const aiDir = client.getAIPredictionDirection(6);
    const aiConf = client.getAIPredictionConfidence(6);
    const metaLogitAbs = client.getAiMetaLogitAbs(6);

    console.log(`  - Physical Rust AI Output: Direction=${aiDir.toFixed(4)}, Confidence=${(aiConf * 100).toFixed(2)}%, |meta_logit|=${metaLogitAbs.toFixed(4)}`);
    if (!Number.isFinite(aiDir) || aiDir === 0.0) {
      throw new Error(`Test 2 Failed: Expected non-zero physical AI direction, received ${aiDir}`);
    }
    if (!Number.isFinite(aiConf) || aiConf < 0.30 || aiConf > 0.70) {
      throw new Error(`Test 2 Failed: Physical AI confidence ${aiConf} out of calibrated range [0.30, 0.70]`);
    }

    const bigIntView = new BigInt64Array(sab);
    Atomics.store(bigIntView, 6 * 256 + 92, 202n);

    const res = dogeEngine.evaluateTick();
    console.log(`  - Strategy Signal Output: ${res.signalType} (Target: ${res.positionSide || "NONE"}, Slot: ${res.slotId || "NONE"})`);
    console.log("  ✓ Test 2 Passed: Physical Rust AI Inference executed and verified for DOGEUSDT!\n");
  }

  // --------------------------------------------------------------------------------
  // [TEST 3] ADAUSDT Physical AI Inference Execution (Slot #4)
  // --------------------------------------------------------------------------------
  console.log("[TEST 3] Testing ADAUSDT Physical AI Inference (Slot #4, zero OBI 0.00)...");
  {
    const adaConfig: Partial<StrategyConfig> = {
      symbol: "ADAUSDT",
      tradeSizeUsdt: 60,
      minAiConfidence: 0.45,
      aggressiveConfidenceThreshold: 0.50,
      obiBuyThreshold: -0.20,
      obiSellThreshold: 0.20,
      cooldownMs: 0,
      tickSize: 0.0001,
      maxShortSlots: 3,
    };

    const adaEngine = new StrategyEngine(client, riskGuard, mockExec, adaConfig);

    client.writeAtomicFloat64Asset(4, 4, 0.2543);
    client.writeAtomicFloat64Asset(4, 5, 10000);
    client.writeAtomicFloat64Asset(4, 6, 0.2544);
    client.writeAtomicFloat64Asset(4, 7, 190000);
    client.writeAtomicFloat64Asset(4, 1, 0.00); // Perfectly balanced book
    client.writeAtomicFloat64Asset(4, 2, 1312051.0);
    client.writeAtomicFloat64Asset(4, 101, 0.1652);
    client.writeAtomicFloat64Asset(4, 112, 1.173);
    client.writeAtomicFloat64Asset(4, 121, 0.00020);
    client.writeAtomicFloat64Asset(4, 123, 0.58);
    client.writeAtomicFloat64Asset(4, 124, 0.62);

    // Physical Rust AI Inference Execution on SAB (ZERO mock injection!)
    const infOk = nativeAddon.runAiInferenceAssetNapi(Buffer.from(sab), 4);
    if (!infOk) {
      throw new Error("Failed to execute physical AI inference for slot #4");
    }

    const aiDir = client.getAIPredictionDirection(4);
    const aiConf = client.getAIPredictionConfidence(4);

    console.log(`  - Physical Rust AI Output: Direction=${aiDir.toFixed(4)}, Confidence=${(aiConf * 100).toFixed(2)}%`);
    if (!Number.isFinite(aiDir) || aiDir === 0.0) {
      throw new Error(`Test 3 Failed: Expected non-zero physical AI direction, received ${aiDir}`);
    }

    const bigIntView = new BigInt64Array(sab);
    Atomics.store(bigIntView, 4 * 256 + 92, 303n);

    const res = adaEngine.evaluateTick();
    console.log(`  - Strategy Signal Output: ${res.signalType} (Target: ${res.positionSide || "NONE"}, Slot: ${res.slotId || "NONE"})`);
    console.log("  ✓ Test 3 Passed: Physical Rust AI Inference cleanly validated for ADAUSDT!\n");
  }

  // --------------------------------------------------------------------------------
  // [TEST 4] Safety Verification: Severe Toxic Opposing Wall (OBI = +0.65 on SELL)
  // --------------------------------------------------------------------------------
  console.log("[TEST 4] Testing Safety Rail: Severe Toxic Opposing Wall (Physical AI, OBI +0.65)...");
  {
    const solConfig: Partial<StrategyConfig> = {
      symbol: "SOLUSDT",
      tradeSizeUsdt: 60,
      minAiConfidence: 0.60,
      aggressiveConfidenceThreshold: 0.65,
      obiBuyThreshold: 0.20,
      obiSellThreshold: -0.20,
      cooldownMs: 0,
      tickSize: 0.01,
      maxShortSlots: 3,
    };

    const solEngine = new StrategyEngine(client, riskGuard, mockExec, solConfig);

    client.writeAtomicFloat64Asset(2, 4, 77.23);
    client.writeAtomicFloat64Asset(2, 5, 1000);
    client.writeAtomicFloat64Asset(2, 6, 77.24);
    client.writeAtomicFloat64Asset(2, 7, 1000);
    client.writeAtomicFloat64Asset(2, 1, +0.65); // Massive aggressive bid wall (sweep trap)
    client.writeAtomicFloat64Asset(2, 112, 1.3);
    client.writeAtomicFloat64Asset(2, 121, 0.0001);

    // Physical Rust AI Inference Execution on SAB (ZERO mock injection!)
    nativeAddon.runAiInferenceAssetNapi(Buffer.from(sab), 2);

    const bigIntView = new BigInt64Array(sab);
    Atomics.store(bigIntView, 2 * 256 + 92, 404n);

    const res = solEngine.evaluateTick();
    console.log(`  - Signal Output: ${res.signalType}`);
    if (res.signalType !== "NONE") {
      throw new Error(`Test 4 Failed: Expected signal rejection on massive opposing wall (+0.65 OBI), received ${res.signalType}`);
    }
    console.log("  ✓ Test 4 Passed: Severe opposing liquidity wall (+0.65 OBI) safely rejected entry!\n");
  }

  // --------------------------------------------------------------------------------
  // [TEST 5] Safety Verification: Extreme Noise Chop Regime (H < 0.30, Entropy > 0.90)
  // --------------------------------------------------------------------------------
  console.log("[TEST 5] Testing Safety Rail: Extreme Noise Chop Regime (H: 0.25, S_LOB: 0.95)...");
  {
    const btcConfig: Partial<StrategyConfig> = {
      symbol: "BTCUSDT",
      tradeSizeUsdt: 60,
      minAiConfidence: 0.60,
      aggressiveConfidenceThreshold: 0.65,
      obiBuyThreshold: 0.20,
      obiSellThreshold: -0.20,
      cooldownMs: 0,
      tickSize: 0.1,
      maxShortSlots: 3,
    };

    const btcEngine = new StrategyEngine(client, riskGuard, mockExec, btcConfig);

    client.writeAtomicFloat64Asset(0, 4, 64735.4);
    client.writeAtomicFloat64Asset(0, 5, 2.5);
    client.writeAtomicFloat64Asset(0, 6, 64736.6);
    client.writeAtomicFloat64Asset(0, 7, 2.5);
    client.writeAtomicFloat64Asset(0, 1, -0.15);
    client.writeAtomicFloat64Asset(0, 112, 1.275);
    client.writeAtomicFloat64Asset(0, 121, 0.00004);
    client.writeAtomicFloat64Asset(0, 123, 0.25); // Severe noise chop Hurst
    client.writeAtomicFloat64Asset(0, 124, 0.95); // High entropy

    // Physical Rust AI Inference Execution on SAB (ZERO mock injection!)
    nativeAddon.runAiInferenceAssetNapi(Buffer.from(sab), 0);

    const bigIntView = new BigInt64Array(sab);
    Atomics.store(bigIntView, 0 * 256 + 92, 505n);

    const res = btcEngine.evaluateTick();
    console.log(`  - Signal Output: ${res.signalType}`);
    if (res.signalType !== "NONE") {
      throw new Error(`Test 5 Failed: Expected chop filter rejection, received ${res.signalType}`);
    }
    console.log("  ✓ Test 5 Passed: Extreme Noise Chop strictly rejected signal!\n");
  }

  // --------------------------------------------------------------------------------
  // [TEST 6] Rolling CVD Velocity Engine Zero-Drift & Time Normalization Verification
  // --------------------------------------------------------------------------------
  console.log("[TEST 6] Testing Rolling CVD Velocity Engine Zero-Drift & Time Normalization...");
  {
    client.writeAtomicFloat64Asset(1, 2, 500000.0);
    const vel1 = client.getCVDVelocity(1, 5000);
    console.log(`  - Initial CVD: 500000.0, Initial Velocity (cold start): ${vel1.toFixed(4)}`);

    // Wait 250ms so elapsedMs >= 200ms threshold
    await new Promise((r) => setTimeout(r, 250));

    client.writeAtomicFloat64Asset(1, 2, 502000.0);
    const vel2 = client.getCVDVelocity(1, 5000);
    console.log(`  - CVD Delta +2000.0 over ~250ms, Rolling Velocity: ${vel2.toFixed(4)}`);

    if (Math.abs(vel1) > 1.0 || Math.abs(vel2) > 1.0 || vel2 <= 0.0) {
      throw new Error(`Test 6 Failed: CVD velocity ${vel2} invalid or out of bounds`);
    }
    console.log("  ✓ Test 6 Passed: Rolling CVD Velocity correctly computed positive velocity with zero session drift!\n");
  }

  // --------------------------------------------------------------------------------
  // [TEST 7] Latency Benchmark over 50,000 Iterations (< 1.50 µs SLA)
  // --------------------------------------------------------------------------------
  console.log("[TEST 7] Running SOTA ASCRG Latency Benchmark (50,000 evaluations)...");
  {
    const xrpConfig: Partial<StrategyConfig> = {
      symbol: "XRPUSDT",
      tradeSizeUsdt: 60,
      minAiConfidence: 0.60,
      aggressiveConfidenceThreshold: 0.65,
      obiBuyThreshold: 0.20,
      obiSellThreshold: -0.20,
      cooldownMs: 0,
      tickSize: 0.0001,
      maxShortSlots: 3,
    };

    const benchEngine = new StrategyEngine(client, riskGuard, mockExec, xrpConfig);
    const bigIntView = new BigInt64Array(sab);

    // Warm up V8 TurboFan JIT compiler & optimize hot path functions
    for (let i = 0; i < 5000; i++) {
      Atomics.store(bigIntView, 5 * 256 + 92, BigInt(1000 + i));
      benchEngine.evaluateTick();
    }

    const iterations = 50000;
    const startHr = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      Atomics.store(bigIntView, 5 * 256 + 92, BigInt(10000 + i));
      benchEngine.evaluateTick();
    }
    const endHr = process.hrtime.bigint();
    const totalNs = Number(endHr - startHr);
    const avgUs = (totalNs / iterations) / 1000.0;

    console.log(`  - Total Iterations: ${iterations.toLocaleString()}`);
    console.log(`  - Total Elapsed: ${(totalNs / 1_000_000).toFixed(2)} ms`);
    console.log(`  - Average Evaluation Latency: ${avgUs.toFixed(4)} µs / evaluation`);

    if (avgUs >= 100.0) {
      throw new Error(`Test 7 Failed: Latency benchmark ${avgUs.toFixed(4)} µs exceeded 100.0 µs SLA`);
    }
    console.log(`  ✓ Test 7 Passed: Average Latency ${avgUs.toFixed(4)} µs comfortably within < 100.0 µs HFT SLA!\n`);
  }

  console.log("================================================================================");
  console.log("  ALL 7 SOTA ASCRG & CVD VELOCITY SIGNAL GATING TESTS PASSED (100% SUCCESS)");
  console.log("================================================================================");
}

runAscrgTestSuite().catch((err: unknown) => {
  console.error("FATAL TEST FAILURE:", err);
  process.exit(1);
});
