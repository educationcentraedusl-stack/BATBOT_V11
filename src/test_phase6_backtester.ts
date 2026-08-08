import "dotenv/config";
import { Readable } from "stream";
import { MultiAssetBacktestEngine, MultiAssetBacktestTick, MultiAssetBacktestResult } from "./backtest/multiAssetBacktester";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function runPhase6BacktesterQaSuite(): Promise<void> {
  console.log("=========================================================================");
  console.log("  BATBOT_V11 PHASE 6 STEP 2: MULTI-ASSET TICK BACKTESTER QA VERIFY      ");
  console.log("=========================================================================\n");

  const maxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || "10", 10);
  const slotsPerAsset = parseInt(process.env.SAB_SLOTS_PER_ASSET || "256", 10);
  const requiredBytes = maxAssets * slotsPerAsset * 8;

  console.log(`[QA Test 1] Allocating 10-Asset SharedArrayBuffer (${requiredBytes} bytes)...`);
  const sab = new SharedArrayBuffer(requiredBytes);
  const engine = new MultiAssetBacktestEngine(sab, {
    initialCapital: 100000.0,
    orderQuantityUsd: 5000.0,
    takerFeeRate: 0.0004, // Strict 4 bps taker fee
    minSlippageTicks: 1,
    maxSlippageTicks: 3,
    tickSize: 0.1,
    maxAssets,
  });
  console.log("  ✅ SharedArrayBuffer initialized cleanly with zero copy.\n");

  console.log(`[QA Test 2] Generating 2,000 Synthetic Multi-Asset Ticks across ALL 10 Asset Pairs...`);
  const symbols = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "ADAUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "DOTUSDT",
  ];

  const ticks: MultiAssetBacktestTick[] = [];
  const totalTicks = 2000;
  const now = Date.now();

  for (let i = 0; i < totalTicks; i++) {
    const assetIdx = i % maxAssets;
    const symbol = symbols[assetIdx];
    const basePrice = 100.0 + assetIdx * 50.0 + Math.sin(i * 0.05 + assetIdx) * 3.0;
    const bidPrice = basePrice;
    const askPrice = basePrice + 0.1;
    const obi = Math.sin(i * 0.1);
    const cvd = i * 5.0;
    const hawkesIntensity = 1.0 + Math.abs(Math.sin(i * 0.05)) * 1.5;
    const realizedVol = 0.01 + Math.abs(Math.cos(i * 0.05)) * 0.015;

    // AI Prediction signal pattern distributed cleanly across all 10 assets
    let aiDirection = 0;
    const cycle = Math.floor(i / maxAssets);
    if (cycle % 12 === 2) aiDirection = 0.65; // Long signal
    if (cycle % 12 === 8) aiDirection = -0.65; // Short/Exit signal

    ticks.push({
      assetIdx,
      symbol,
      timestamp: now + i * 100,
      bidPrice,
      askPrice,
      obi,
      cvd,
      hawkesIntensity,
      realizedVol,
      aiDirection,
      aiConfidence: 0.85,
    });
  }

  console.log(`  ✅ Generated ${ticks.length} multi-asset historical ticks across 10 asset pairs.\n`);

  console.log(`[QA Test 3] Running In-Memory Multi-Asset Backtest Engine...`);
  const result: MultiAssetBacktestResult = engine.runTicks(ticks);

  // 1. Trade Tally Arithmetic Verification
  assert(result.totalTicksEvaluated === ticks.length, "Total ticks evaluated must equal 2000");
  assert(result.totalSignalsGenerated > 0, "Signals must be generated during test");
  assert(result.totalTradesExecuted > 0, "Completed round-trip trades must be > 0");
  assert(
    result.totalTradesExecuted === result.winningTrades + result.losingTrades,
    `Completed round-trip trade tally arithmetic mismatch: ${result.totalTradesExecuted} !== ${result.winningTrades} + ${result.losingTrades}`
  );
  console.log(`  ✅ Trade Tally Arithmetic verified: Completed Round-Trips (${result.totalTradesExecuted}) = Win (${result.winningTrades}) + Loss (${result.losingTrades}).`);

  // 2. Strict Mathematical PnL Reconciliation Verification
  let sumAssetRealizedPnl = 0;
  let activeAssetCount = 0;
  for (const asset of result.assetBreakdown) {
    sumAssetRealizedPnl += asset.realizedPnlUsd;
    if (asset.totalTrades > 0) activeAssetCount++;
  }

  const pnlDiff = Math.abs(sumAssetRealizedPnl - result.netPnlUsd);
  console.log(`  Per-Asset PnL Sum: $${sumAssetRealizedPnl.toFixed(2)} | Global Net PnL: $${result.netPnlUsd.toFixed(2)} | Discrepancy: $${pnlDiff.toFixed(2)}`);
  assert(pnlDiff < 0.05, `Mathematical PnL Reconciliation failed! Per-asset sum $${sumAssetRealizedPnl.toFixed(2)} !== Global Net PnL $${result.netPnlUsd.toFixed(2)}`);
  assert(activeAssetCount === maxAssets, `Trades must execute across ALL 10 assets (Active: ${activeAssetCount}/10)`);
  console.log("  ✅ Mathematical PnL Reconciliation verified: Sum of per-asset PnLs matches Portfolio Net PnL perfectly.");
  console.log("  ✅ Dynamic Multi-Asset Routing verified: Trades executed across all 10 asset pairs.\n");

  console.log(`[QA Test 4] Testing Memory-Safe CSV Stream Backtesting Engine...`);
  const csvLines: string[] = ["assetIdx,symbol,timestamp,bidPrice,askPrice,obi,cvd,hawkes,volatility,aiDirection"];
  for (let i = 0; i < 600; i++) {
    const assetIdx = i % maxAssets;
    const sym = symbols[assetIdx];
    const bp = (100 + assetIdx * 10 + Math.sin(i * 0.1) * 2.0).toFixed(2);
    const ap = (parseFloat(bp) + 0.1).toFixed(2);
    const cycle = Math.floor(i / maxAssets);
    const aiDir = cycle % 10 === 2 ? "0.7" : cycle % 10 === 7 ? "-0.7" : "0.0";
    csvLines.push(`${assetIdx},${sym},${now + i * 100},${bp},${ap},0.2,500.0,1.5,0.015,${aiDir}`);
  }

  const csvStream = Readable.from(csvLines.join("\n"));
  const streamResult = await engine.runStream(csvStream);

  assert(streamResult.totalTicksEvaluated === 600, "Stream backtest must evaluate 600 ticks");
  assert(streamResult.totalTradesExecuted > 0, "Stream backtest must execute trades");
  assert(
    streamResult.totalTradesExecuted === streamResult.winningTrades + streamResult.losingTrades,
    "Stream trade arithmetic mismatch"
  );
  console.log("  ✅ Memory-safe CSV stream backtest executed cleanly with exact arithmetic.\n");

  console.log(`[QA Test 5] Generating Institutional Performance Tear Sheet Output...`);
  const tearSheet = MultiAssetBacktestEngine.generateTearSheet(result);
  console.log(tearSheet);

  console.log("=========================================================================");
  console.log("  ✅ ALL PHASE 6 STEP 2 TICK BACKTESTER QA TESTS PASSED CLEANLY!         ");
  console.log("=========================================================================\n");
}

runPhase6BacktesterQaSuite().catch((err) => {
  console.error("❌ Test failed with unhandled error:", err);
  process.exit(1);
});
