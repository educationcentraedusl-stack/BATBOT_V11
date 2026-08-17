import "dotenv/config";
import { MarketDataClient } from "../marketDataClient";
import { RiskGuard, MultiAssetRiskGuard, OrderIntent } from "../strategy/risk";
import { BinanceExecutionClient } from "../execution/binance";
import { StrategyEngine } from "../strategy/engine";
import { SAB_SLOTS } from "../ipc/sabSchema";

async function runPhase3Phase4TestSuite() {
  console.log("================================================================================");
  console.log("  BATBOT_V11: PHASE 3 & PHASE 4 COMPREHENSIVE VERIFICATION TEST SUITE");
  console.log("  - Phase 3: Consecutive-Loss Circuit Breaker & Exponential Pacing");
  console.log("  - Phase 4: Microstructure Chop & LOB Entropy Regime Filter");
  console.log("================================================================================\n");

  // ============================================================================
  // TEST 1: Phase 3 Consecutive-Loss Tracking & Net ROE (+0.20%) Reset Threshold
  // ============================================================================
  console.log("[TEST 1] Testing Consecutive Loss Tracking & +0.20% Net ROE Reset Threshold...");
  const riskGuard = new RiskGuard();
  const symbol = "BTCUSDT";

  if (riskGuard.getConsecutiveLosses(symbol) !== 0) {
    throw new Error(`FAIL: Initial consecutive losses must be 0, got ${riskGuard.getConsecutiveLosses(symbol)}`);
  }

  // 1st Loss: -$0.50 PnL, -1.0% ROE -> consecutive losses = 1
  let losses = riskGuard.recordTradeOutcome(symbol, -0.50, -1.0);
  if (losses !== 1 || riskGuard.getConsecutiveLosses(symbol) !== 1) {
    throw new Error(`FAIL: Consecutive losses after 1st loss should be 1, got ${losses}`);
  }
  console.log("  ✓ 1st loss (-$0.50, -1.0% ROE) -> consecutive losses: 1");

  // 2nd Loss: -$1.20 PnL, -2.4% ROE -> consecutive losses = 2
  losses = riskGuard.recordTradeOutcome(symbol, -1.20, -2.4);
  if (losses !== 2 || riskGuard.getConsecutiveLosses(symbol) !== 2) {
    throw new Error(`FAIL: Consecutive losses after 2nd loss should be 2, got ${losses}`);
  }
  console.log("  ✓ 2nd loss (-$1.20, -2.4% ROE) -> consecutive losses: 2");

  // Scratch trade: +$0.02 PnL, +0.05% Net ROE (<= +0.20% threshold) -> should NOT reset consecutive losses
  losses = riskGuard.recordTradeOutcome(symbol, 0.02, 0.05);
  if (losses !== 2 || riskGuard.getConsecutiveLosses(symbol) !== 2) {
    throw new Error(`FAIL: Scratch trade (+0.05% ROE <= +0.20%) must NOT reset consecutive losses, got ${losses}`);
  }
  console.log("  ✓ Scratch exit (+0.05% Net ROE <= +0.20%) -> consecutive losses remain: 2 (no reset)");

  // Realized winning exit: +$1.50 PnL, +1.20% Net ROE (> +0.20% threshold) -> MUST reset consecutive losses to 0
  losses = riskGuard.recordTradeOutcome(symbol, 1.50, 1.20);
  if (losses !== 0 || riskGuard.getConsecutiveLosses(symbol) !== 0) {
    throw new Error(`FAIL: Realized winning exit (+1.20% ROE > +0.20%) must reset consecutive losses to 0, got ${losses}`);
  }
  console.log("  ✓ Realized winning exit (+1.20% Net ROE > +0.20%) -> consecutive losses reset to 0\n");

  // ============================================================================
  // TEST 2: Phase 3 Exponential Backoff Pacing (15s, 60s, 180s, 900s Circuit Breaker)
  // ============================================================================
  console.log("[TEST 2] Testing Exponential Backoff Cooldown Durations...");

  // 0 losses -> 0ms
  if (RiskGuard.calculateExponentialLossCooldownMs(0) !== 0) {
    throw new Error(`FAIL: 0 losses cooldown should be 0ms, got ${RiskGuard.calculateExponentialLossCooldownMs(0)}ms`);
  }

  // 1 loss -> 15s (15,000ms)
  if (RiskGuard.calculateExponentialLossCooldownMs(1) !== 15_000) {
    throw new Error(`FAIL: 1 loss cooldown should be 15,000ms (15s), got ${RiskGuard.calculateExponentialLossCooldownMs(1)}ms`);
  }
  console.log("  ✓ 1 loss  -> 15s cooldown (15,000ms)");

  // 2 losses -> 60s (60,000ms)
  if (RiskGuard.calculateExponentialLossCooldownMs(2) !== 60_000) {
    throw new Error(`FAIL: 2 losses cooldown should be 60,000ms (60s), got ${RiskGuard.calculateExponentialLossCooldownMs(2)}ms`);
  }
  console.log("  ✓ 2 losses -> 60s cooldown (60,000ms)");

  // 3 losses -> 180s (180,000ms)
  if (RiskGuard.calculateExponentialLossCooldownMs(3) !== 180_000) {
    throw new Error(`FAIL: 3 losses cooldown should be 180,000ms (180s), got ${RiskGuard.calculateExponentialLossCooldownMs(3)}ms`);
  }
  console.log("  ✓ 3 losses -> 180s cooldown (180,000ms)");

  // 5 losses -> 900s (900,000ms / 15 min hard symbol circuit breaker halt)
  if (RiskGuard.calculateExponentialLossCooldownMs(5) !== 900_000) {
    throw new Error(`FAIL: 5 losses cooldown should be 900,000ms (15 min), got ${RiskGuard.calculateExponentialLossCooldownMs(5)}ms`);
  }
  console.log("  ✓ 5 losses -> 900s hard symbol circuit breaker halt (900,000ms / 15 min)\n");

  // ============================================================================
  // TEST 3: Order Validation Under Exponential Cooldown & Circuit Breaker
  // ============================================================================
  console.log("[TEST 3] Testing RiskGuard Order Validation Under Circuit Breakers...");
  const ethSymbol = "ETHUSDT";
  const dummyIntent: OrderIntent = {
    symbol: ethSymbol,
    side: "BUY",
    quantity: 0.1,
    price: 3000.0,
    stopLossPrice: 2950.0,
    takeProfitPrice: 3150.0,
  };

  // Simulate 1 loss on ETH
  riskGuard.recordExitExecution(300.0, -2.50, "SELL", ethSymbol, -1.0);
  const check1 = riskGuard.validateOrder(dummyIntent, true);
  if (check1.passed || check1.reasonCode !== "COOLDOWN_ACTIVE") {
    throw new Error(`FAIL: Expected COOLDOWN_ACTIVE after 1 loss, got ${check1.reasonCode} (passed: ${check1.passed})`);
  }
  console.log(`  ✓ 1 loss on ETH: Order rejected with reason '${check1.reasonCode}'`);

  // Simulate 4 more losses to reach 5 consecutive losses
  riskGuard.recordExitExecution(300.0, -2.50, "SELL", ethSymbol, -1.0);
  riskGuard.recordExitExecution(300.0, -2.50, "SELL", ethSymbol, -1.0);
  riskGuard.recordExitExecution(300.0, -2.50, "SELL", ethSymbol, -1.0);
  riskGuard.recordExitExecution(300.0, -2.50, "SELL", ethSymbol, -1.0);

  if (riskGuard.getConsecutiveLosses(ethSymbol) !== 5) {
    throw new Error(`FAIL: Expected 5 consecutive losses on ETH, got ${riskGuard.getConsecutiveLosses(ethSymbol)}`);
  }
  if (!riskGuard.isCircuitBreakerActive(ethSymbol)) {
    throw new Error("FAIL: Circuit breaker should be active on ETH after 5 consecutive losses");
  }

  const check5 = riskGuard.validateOrder(dummyIntent, true);
  if (check5.passed || check5.reasonCode !== "CIRCUIT_BREAKER_ACTIVE") {
    throw new Error(`FAIL: Expected CIRCUIT_BREAKER_ACTIVE after 5 losses, got ${check5.reasonCode} (passed: ${check5.passed})`);
  }
  console.log(`  ✓ 5 losses on ETH: Order rejected with reason '${check5.reasonCode}' (15m Circuit Breaker Halt)`);

  // Emergency close order must bypass circuit breaker
  const closeIntent: OrderIntent = {
    symbol: ethSymbol,
    side: "SELL",
    quantity: 0.1,
    price: 3000.0,
    isCloseOrder: true,
  };
  const closeCheck = riskGuard.validateOrder(closeIntent, true);
  if (!closeCheck.passed) {
    throw new Error(`FAIL: Emergency position close order must bypass circuit breaker, got rejected: ${closeCheck.message}`);
  }
  console.log("  ✓ Emergency close order successfully bypassed circuit breaker.\n");

  // ============================================================================
  // TEST 4: Phase 4 SAB Slots 123 (Hurst) & 124 (LOB Entropy) Zero-Copy Read/Write
  // ============================================================================
  console.log("[TEST 4] Testing SAB Slots 123 (Hurst) & 124 (LOB Entropy) Bitcasting...");
  const maxAssets = 10;
  const slotsPerAsset = 256;
  const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
  const client = new MarketDataClient(sab, maxAssets, slotsPerAsset);

  client.setHurstExponent(0.625, 0);
  client.setLOBEntropy(0.710, 0);

  const readHurst = client.getHurstExponent(0);
  const readEntropy = client.getLOBEntropy(0);

  if (Math.abs(readHurst - 0.625) > 1e-6) {
    throw new Error(`FAIL: Slot 123 (Hurst) read mismatch: expected 0.625, got ${readHurst}`);
  }
  if (Math.abs(readEntropy - 0.710) > 1e-6) {
    throw new Error(`FAIL: Slot 124 (LOB Entropy) read mismatch: expected 0.710, got ${readEntropy}`);
  }
  console.log(`  ✓ SAB Slot 123 (Hurst: ${readHurst.toFixed(3)}) & Slot 124 (LOB Entropy: ${readEntropy.toFixed(3)}) verified.\n`);

  // ============================================================================
  // TEST 5: Phase 4 Mean-Reverting Noise Chop Regime Filter (H < 0.45 & S_LOB > 0.85)
  // ============================================================================
  console.log("[TEST 5] Testing Mean-Reverting Noise Chop Regime Filter...");
  const dummyExecClient = new BinanceExecutionClient({
    apiKey: "test_key",
    apiSecret: "test_secret",
    useTestnet: true,
  });

  const testRiskGuard = new RiskGuard({ minCooldownMs: 0 });
  const engine = new StrategyEngine(client, testRiskGuard, dummyExecClient, {
    symbol: "BTCUSDT",
    orderQuantity: 0.001,
    cooldownMs: 0,
    minAiConfidence: 0.50,
    aggressiveConfidenceThreshold: 0.55,
  });

  const bigIntView = new BigInt64Array(sab);

  // Setup market data for strong BUY signal conditions (OBI = +0.80, CVD = +500, AI Dir = +0.80, Conf = 0.95)
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.BEST_BID_PRICE, 60000.0);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.BEST_BID_QTY, 5.0);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.BEST_ASK_PRICE, 60001.0);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.BEST_ASK_QTY, 5.0);
  client.setOBI(0.80, 0);
  client.setCVD(500.0, 0);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.SPREAD_VELOCITY, 0.0);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.AI_DIRECTION, 0.80);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.AI_DIRECTION_MAGNITUDE, 0.80);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.AI_CONFIDENCE, 0.95);
  client.setGarmanKlassRV(0.002, 0);
  client.setHawkesIntensity(1.0, 0);

  // Inject Mean-Reverting Noise Chop (H = 0.40 < 0.45 and S_LOB = 0.90 > 0.85)
  client.setHurstExponent(0.40, 0);
  client.setLOBEntropy(0.90, 0);
  Atomics.store(bigIntView, 92, 1n);

  const chopSignal = engine.evaluateTick();
  if (chopSignal.signalType !== "NONE") {
    throw new Error(`FAIL: Mean-reverting noise chop (H=0.40, S_LOB=0.90) must be filtered out! Got signal: ${chopSignal.signalType}`);
  }
  console.log(`  ✓ Mean-Reverting Noise Chop (H: 0.40 < 0.45, S_LOB: 0.90 > 0.85) successfully filtered directional signal -> NONE`);

  // ============================================================================
  // TEST 6: Phase 4 Trend Regime Gating (Requires H >= 0.55, S_LOB <= 0.75, Hawkes <= 2.0)
  // ============================================================================
  console.log("\n[TEST 6] Testing Trend Regime Gating for Directional Entries...");

  // Non-trend case A: High Entropy (H = 0.60 >= 0.55, but S_LOB = 0.82 > 0.75)
  client.setHurstExponent(0.60, 0);
  client.setLOBEntropy(0.82, 0);
  client.setHawkesIntensity(1.0, 0);
  Atomics.store(bigIntView, 92, 2n);

  const nonTrendSignalA = engine.evaluateTick();
  if (nonTrendSignalA.signalType !== "NONE") {
    throw new Error(`FAIL: High Entropy (S_LOB=0.82 > 0.75) must restrict directional entry! Got: ${nonTrendSignalA.signalType}`);
  }
  console.log(`  ✓ High Entropy restriction (S_LOB: 0.82 > 0.75) -> directional entry blocked`);

  // Non-trend case B: High Hawkes (H = 0.60 >= 0.55, S_LOB = 0.65 <= 0.75, but Hawkes = 3.5 > 2.0)
  client.setHurstExponent(0.60, 0);
  client.setLOBEntropy(0.65, 0);
  client.setHawkesIntensity(3.5, 0);
  Atomics.store(bigIntView, 92, 3n);

  const nonTrendSignalB = engine.evaluateTick();
  if (nonTrendSignalB.signalType !== "NONE") {
    throw new Error(`FAIL: High Hawkes (Hawkes=3.5 > 2.0) must restrict directional entry! Got: ${nonTrendSignalB.signalType}`);
  }
  console.log(`  ✓ High Hawkes restriction (Hawkes: 3.5 > 2.0) -> directional entry blocked`);

  // Verified Trend Regime: (H = 0.65 >= 0.55, S_LOB = 0.60 <= 0.75, Hawkes = 1.2 <= 2.0)
  client.setHurstExponent(0.65, 0);
  client.setLOBEntropy(0.60, 0);
  client.setHawkesIntensity(1.2, 0);
  Atomics.store(bigIntView, 92, 4n);

  const trendSignal = engine.evaluateTick();
  if (trendSignal.signalType !== "BUY") {
    throw new Error(`FAIL: Verified trend regime (H=0.65, S_LOB=0.60, Hawkes=1.2) must generate BUY signal! Got: ${trendSignal.signalType}`);
  }
  console.log(`  ✓ Verified Trend Regime (H: 0.65 >= 0.55, S_LOB: 0.60 <= 0.75, Hawkes: 1.2 <= 2.0) -> BUY signal generated!`);

  // ============================================================================
  // TEST 7: StrategyEngine End-to-End onExecutionCompleted Pacing & Circuit Breaker
  // ============================================================================
  console.log("\n[TEST 7] Testing StrategyEngine onExecutionCompleted Pacing & Circuit Breaker...");

  // Simulate fill sequence with 5 consecutive losses via engine internal handler
  // 1st loss exit: -$0.50 PnL -> 15s cooldown
  const now = Date.now();
  (engine as any).onExecutionCompleted({
    symbol: "BTCUSDT",
    assetIndex: 0,
    side: "SELL",
    positionSide: "LONG",
    isCloseOrder: true,
    executedQty: 0.001,
    executedPrice: 60000.0,
    realizedPnl: -0.50,
    fillTimestampMs: now,
  });

  const longLock1 = client.getLongCooldownLock(0);
  if (longLock1 < now + 14_000) {
    throw new Error(`FAIL: Expected SAB long cooldown lock >= now + 14s, got diff ${longLock1 - now}ms`);
  }
  console.log(`  ✓ 1st loss onExecutionCompleted -> SAB Long cooldown lock set to +15s`);

  // Simulate 4 more losses to trigger the 15-minute hard symbol circuit breaker
  for (let i = 2; i <= 5; i++) {
    (engine as any).onExecutionCompleted({
      symbol: "BTCUSDT",
      assetIndex: 0,
      side: "SELL",
      positionSide: "LONG",
      isCloseOrder: true,
      executedQty: 0.001,
      executedPrice: 60000.0,
      realizedPnl: -0.50,
      fillTimestampMs: now,
    });
  }

  const longLock5 = client.getLongCooldownLock(0);
  if (longLock5 < now + 890_000) {
    throw new Error(`FAIL: Expected SAB long cooldown lock >= now + 890s (15 min), got diff ${longLock5 - now}ms`);
  }
  console.log(`  ✓ 5th loss onExecutionCompleted -> SAB Long cooldown lock set to +900s (15 min Circuit Breaker Halt)`);

  // Next tick evaluation must be blocked by cooldown lock
  Atomics.store(bigIntView, 92, 5n);
  const blockedSignal = engine.evaluateTick();
  if (blockedSignal.signalType !== "NONE") {
    throw new Error(`FAIL: Signal must be blocked during active circuit breaker lock! Got: ${blockedSignal.signalType}`);
  }
  console.log(`  ✓ Engine evaluateTick during 15 min circuit breaker -> Signal blocked (NONE)`);

  // Realized winning exit (> +0.20% Net ROE) resets consecutive losses to 0
  (engine as any).onExecutionCompleted({
    symbol: "BTCUSDT",
    assetIndex: 0,
    side: "SELL",
    positionSide: "LONG",
    isCloseOrder: true,
    executedQty: 0.001,
    executedPrice: 60000.0,
    realizedPnl: 1.50,
    fillTimestampMs: now,
  });

  if (testRiskGuard.getConsecutiveLosses("BTCUSDT") !== 0) {
    throw new Error(`FAIL: Winning exit must reset consecutive losses to 0, got ${testRiskGuard.getConsecutiveLosses("BTCUSDT")}`);
  }
  console.log(`  ✓ Realized winning exit onExecutionCompleted -> Consecutive losses reset to 0`);

  console.log("\n================================================================================");
  console.log("  ✅ ALL 7 TEST STAGES PASSED (100% SPECIFICATION COMPLIANCE)");
  console.log("  - Phase 3: Consecutive-Loss Circuit Breaker & Exponential Pacing: VERIFIED");
  console.log("  - Phase 4: Microstructure Chop & LOB Entropy Regime Filter: VERIFIED");
  console.log("================================================================================\n");
}

runPhase3Phase4TestSuite().catch((err) => {
  console.error(`\n❌ TEST SUITE FAILED: ${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
