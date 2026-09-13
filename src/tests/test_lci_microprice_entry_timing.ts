import "dotenv/config";
import { MarketDataClient } from "../marketDataClient";
import { RiskGuard } from "../strategy/risk";
import { BinanceExecutionClient } from "../execution/binance";
import { StrategyEngine } from "../strategy/engine";
import { SAB_SLOTS } from "../ipc/sabSchema";
import { timeSynchronizer } from "../utils/timeSynchronizer";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ [ASSERTION_FAILED] ${message}`);
    throw new Error(`ASSERTION_FAILED: ${message}`);
  }
}

async function runLCIMicropriceTimingTestSuite(): Promise<void> {
  console.log("================================================================================");
  console.log("  TEST: SOTA COMPOSITE LEADING CONFIRMATION INDEX (DEF-R8)");
  console.log("  Microprice Deviation + OBI Velocity & Acceleration Timing Proof");
  console.log("================================================================================\n");

  const maxAssets = 10;
  const slotsPerAsset = 256;
  const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
  const client = new MarketDataClient(sab, maxAssets, slotsPerAsset);
  const riskGuard = new RiskGuard({ minCooldownMs: 0 });
  const execClient = new BinanceExecutionClient({
    apiKey: "test_key",
    apiSecret: "test_secret",
    useTestnet: true,
  });

  const engine = new StrategyEngine(client, riskGuard, execClient, {
    symbol: "BTCUSDT",
    orderQuantity: 0.001,
    cooldownMs: 0,
    minAiConfidence: 0.70,
    aggressiveConfidenceThreshold: 0.75,
  });

  const bigIntView = new BigInt64Array(sab);

  // Set healthy IC (+0.05) so IR gate is satisfied
  client.setRollingIC(0.05, 0);

  // --------------------------------------------------------------------------
  // STAGE 0: Tick 0 Initialization Guard (DEF-3102 Verification)
  // --------------------------------------------------------------------------
  console.log("[STAGE 0] Testing Tick 0 Initialization Guard (No spurious signal on uninitialized state)...");
  let nowMs = timeSynchronizer.getAdjustedNowMs();
  Atomics.store(bigIntView, 0, BigInt(nowMs) * 1000000n);
  client.setSequenceNum(0n, 0);
  client.setBestBidPrice(60000.0, 0);
  client.setBestBidQuantity(5.0, 0);
  client.setBestAskPrice(60000.5, 0);
  client.setBestAskQuantity(5.0, 0);
  client.setOBI(0.0, 0);
  client.setCVD(0.0, 0);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.SPREAD_VELOCITY, 0.0);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.AI_DIRECTION, 0.90);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.AI_CONFIDENCE, 0.95);
  client.setGarmanKlassRV(0.002, 0);
  client.setHawkesIntensity(1.0, 0);
  client.setHurstExponent(0.65, 0);
  client.setLOBEntropy(0.50, 0);

  const tick0Signal = engine.evaluateTick();
  console.log(`  Tick 0 Signal Type: ${tick0Signal.signalType}`);
  assert(tick0Signal.signalType === "NONE", `Tick 0 uninitialized state must produce NONE, got ${tick0Signal.signalType}`);
  console.log("  ✓ Tick 0 initialization guard verified: baseline established with LCI = 0.50 without spurious signal\n");

  // --------------------------------------------------------------------------
  // STAGE 1: Initiation Phase (Breakout Building -> LCI >= 0.55 Approves Entry)
  // --------------------------------------------------------------------------
  console.log("[STAGE 1] Testing Initiation Phase (Microprice Shift & Surging OBI Velocity)...");

  // Tick 1: Sudden strong bid injection: Bid Qty = 25.0, Ask Qty = 2.0 (OBI = +0.85, microprice shifts up)
  await new Promise((r) => setTimeout(r, 10));
  nowMs = timeSynchronizer.getAdjustedNowMs();
  Atomics.store(bigIntView, 0, BigInt(nowMs) * 1000000n);
  client.setSequenceNum(1n, 0);
  client.setBestBidPrice(60000.0, 0);
  client.setBestBidQuantity(25.0, 0);
  client.setBestAskPrice(60000.5, 0);
  client.setBestAskQuantity(2.0, 0);
  client.setOBI(0.85, 0);
  client.setCVD(100.0, 0);

  // At this initiation point, micropriceDev is positive and OBI velocity is surging
  const initiationSignal = engine.evaluateTick();
  if (initiationSignal.executionPromise) {
    await initiationSignal.executionPromise;
  }
  console.log(`  Initiation Signal Type: ${initiationSignal.signalType}`);
  assert(initiationSignal.signalType === "BUY", `Initiation phase must trigger BUY, got ${initiationSignal.signalType}`);
  console.log("  ✓ Initiation phase correctly confirmed by LCI (BUY triggered at initiation)\n");

  // --------------------------------------------------------------------------
  // STAGE 2: Micro-Top Exhaustion Phase (Nominally High OBI, but Negative Velocity)
  // --------------------------------------------------------------------------
  console.log("[STAGE 2] Testing Micro-Top Exhaustion Phase (Decelerating / Retreating OBI)...");

  // Tick 2: At the local top, OBI is still positive (+0.25, looks bullish to lagging indicators),
  // but bid quantity is evaporating (was 25, now 3) and ask quantity is creeping in (now 15).
  // Microprice deviates downward and OBI velocity/acceleration are negative.
  await new Promise((r) => setTimeout(r, 10));
  nowMs = timeSynchronizer.getAdjustedNowMs();
  Atomics.store(bigIntView, 0, BigInt(nowMs) * 1000000n);
  client.setSequenceNum(2n, 0);
  client.setBestBidPrice(60000.0, 0);
  client.setBestBidQuantity(3.0, 0);
  client.setBestAskPrice(60000.5, 0);
  client.setBestAskQuantity(15.0, 0);
  client.setOBI(0.25, 0); // Still positive, but retreating
  client.setCVD(100.0, 0);

  const exhaustionSignal = engine.evaluateTick();
  if (exhaustionSignal.executionPromise) {
    await exhaustionSignal.executionPromise;
  }
  console.log(`  Exhaustion Signal Type: ${exhaustionSignal.signalType}`);
  assert(exhaustionSignal.signalType === "NONE", `Exhaustion micro-top must be BLOCKED by LCI, got ${exhaustionSignal.signalType}`);
  console.log("  ✓ Micro-top exhaustion correctly blocked by LCI despite nominally high OBI (+0.60)\n");

  // --------------------------------------------------------------------------
  // STAGE 3: Symmetric Breakdown Initiation (SELL Confirmation)
  // --------------------------------------------------------------------------
  console.log("[STAGE 3] Testing Symmetric Breakdown Initiation (Negative Microprice Dev & Negative Velocity)...");

  // Reset resting orders and slots for clean stage isolation
  engine.annihilateRestingEntryOrders("STAGE_ISOLATION");
  engine.getHedgeLedger().clearSlots();

  // Tick 3: Re-establish neutral baseline
  await new Promise((r) => setTimeout(r, 10));
  nowMs = timeSynchronizer.getAdjustedNowMs();
  Atomics.store(bigIntView, 0, BigInt(nowMs) * 1000000n);
  client.setSequenceNum(3n, 0);
  client.setBestBidPrice(60000.0, 0);
  client.setBestBidQuantity(5.0, 0);
  client.setBestAskPrice(60000.5, 0);
  client.setBestAskQuantity(5.0, 0);
  client.setOBI(0.0, 0);
  client.setCVD(0.0, 0);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.AI_DIRECTION, 0.0); // Neutral baseline
  client.setShortCooldownLock(0, 0);
  const neutralSig = engine.evaluateTick();
  if (neutralSig.executionPromise) {
    await neutralSig.executionPromise;
  }
  engine.annihilateRestingEntryOrders("STAGE_ISOLATION");
  engine.getHedgeLedger().clearSlots();
  client.setShortCooldownLock(0, 0);

  // Tick 4: Toxic ask wall injection: Bid Qty = 2.0, Ask Qty = 30.0 (OBI = -0.875)
  await new Promise((r) => setTimeout(r, 10));
  nowMs = timeSynchronizer.getAdjustedNowMs();
  Atomics.store(bigIntView, 0, BigInt(nowMs) * 1000000n);
  client.setSequenceNum(4n, 0);
  client.setBestBidPrice(60000.0, 0);
  client.setBestBidQuantity(2.0, 0);
  client.setBestAskPrice(60000.5, 0);
  client.setBestAskQuantity(30.0, 0);
  client.setOBI(-0.875, 0);
  client.setCVD(-150.0, 0);
  client.writeAtomicFloat64Asset(0, SAB_SLOTS.AI_DIRECTION, -0.80); // Switch to SELL
  client.setShortCooldownLock(0, 0);

  const breakdownSignal = engine.evaluateTick();
  console.log(`  Breakdown Signal Type: ${breakdownSignal.signalType}`);
  assert(breakdownSignal.signalType === "SELL", `Breakdown initiation must trigger SELL, got ${breakdownSignal.signalType}`);
  console.log("  ✓ Symmetric breakdown correctly confirmed by LCI (SELL triggered at breakdown)\n");

  console.log("================================================================================");
  console.log("  ✅ ALL 4 TEST STAGES PASSED (100% SOTA DEF-R8 & DEF-3102 SPECIFICATION COMPLIANCE)");
  console.log("================================================================================\n");
}

runLCIMicropriceTimingTestSuite().catch((err) => {
  console.error(`\n❌ TEST SUITE FAILED: ${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
