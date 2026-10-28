import { StrategyEngine } from "../strategy/engine";
import { MarketDataClient } from "../marketDataClient";
import { RiskGuard } from "../strategy/risk";
import { BinanceExecutionClient } from "../execution/binance";

async function runAutoSwitchingSpreadGuardTest(): Promise<void> {
  console.log("================================================================================");
  console.log("  TEST SUITE: AUTO-SWITCHING SPREAD GUARD (TESTNET VS MAINNET)                   ");
  console.log("================================================================================");

  const slotsPerAsset = 256;
  const maxAssets = 10;
  const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
  const client = new MarketDataClient(sab, maxAssets, slotsPerAsset);
  const riskGuard = new RiskGuard();
  const executionClient = new BinanceExecutionClient();

  const nowMs = Date.now();
  const nowNs = BigInt(nowMs) * 1000000n;
  const bigIntView = new BigInt64Array(sab);
  bigIntView[0] = nowNs; // Fresh packet timestamp
  bigIntView[92] = 1n;   // Sequence #1

  // =========================================================================
  // TEST CASE 1: TESTNET ENVIRONMENT (USE_TESTNET = "true")
  // =========================================================================
  console.log("\n[STAGE 1] Testing Testnet Auto-Detection & Altcoin Relaxation (USE_TESTNET = 'true')...");
  process.env.USE_TESTNET = "true";

  // BNBUSDT on Testnet: Price = $747.99, Spread = $0.75 (10.02 bps)
  // In the legacy code, the $0.10 hard cap choked BNBUSDT (0.75 > 0.10).
  // With 50 bps relaxation, limit is $3.74 (50 bps) and BNB MUST PASS.
  const bnbEngine = new StrategyEngine(client, riskGuard, executionClient, {
    symbol: "BNBUSDT",
    assetIndex: 3,
  });

  if (!bnbEngine.getIsTestnet()) {
    throw new Error("STAGE 1 FAILED: Engine failed to auto-detect Testnet environment!");
  }
  console.log("  ✅ Auto-Detection confirmed: bnbEngine.getIsTestnet() === true");

  // Setup BNB live data: Bid 747.61, Ask 748.36 (Spread = 0.75 USDT)
  client.writeAtomicFloat64Asset(3, 4, 747.61); // Bid
  client.writeAtomicFloat64Asset(3, 6, 748.36); // Ask (Spread = 0.75 USDT, 10.02 bps)
  client.writeAtomicFloat64Asset(3, 103, 0.89); // AI Direction (+0.89)
  client.writeAtomicFloat64Asset(3, 104, 0.871); // AI Confidence (87.1%)

  const bnbResult = bnbEngine.evaluateTick();
  console.log(`  -> BNBUSDT (Spread $0.75 / 10.0 bps) Result Reason: ${bnbResult.riskResult?.reasonCode || "NONE"}`);
  if (bnbResult.riskResult?.reasonCode === "REJECTED_MAX_SPREAD_BLOWOUT") {
    throw new Error("STAGE 1 FAILED: BNBUSDT was unexpectedly rejected by spread guard under Testnet relaxation!");
  }
  console.log("  ✅ BNBUSDT $0.75 spread (10.0 bps) cleanly PASSED Testnet spread guard (no $0.10 cap choke).");

  // SOLUSDT on Testnet: Price = $100.61, Spread = $0.30 (29.8 bps)
  // In legacy code, 0.30 > 0.10 was rejected. In relaxed 50 bps, 0.30 <= 0.50 passes.
  const solEngine = new StrategyEngine(client, riskGuard, executionClient, {
    symbol: "SOLUSDT",
    assetIndex: 2,
  });
  client.writeAtomicFloat64Asset(2, 4, 100.46); // Bid
  client.writeAtomicFloat64Asset(2, 6, 100.76); // Ask (Spread = 0.30 USDT, 29.8 bps)
  const solResult = solEngine.evaluateTick();
  if (solResult.riskResult?.reasonCode === "REJECTED_MAX_SPREAD_BLOWOUT") {
    throw new Error("STAGE 1 FAILED: SOLUSDT was unexpectedly rejected by spread guard under Testnet relaxation!");
  }
  console.log("  ✅ SOLUSDT $0.30 spread (29.8 bps) cleanly PASSED Testnet spread guard.");

  // AVAXUSDT on Testnet: Price = $8.829, Spread = $0.068 (77.0 bps)
  // 77 bps > 50 bps cap. MUST BE SAFELY REJECTED.
  const avaxEngine = new StrategyEngine(client, riskGuard, executionClient, {
    symbol: "AVAXUSDT",
    assetIndex: 7,
  });
  client.writeAtomicFloat64Asset(7, 4, 8.795); // Bid
  client.writeAtomicFloat64Asset(7, 6, 8.863); // Ask (Spread = 0.068 USDT, 77.0 bps)
  const avaxResult = avaxEngine.evaluateTick();
  if (avaxResult.riskResult?.reasonCode !== "REJECTED_MAX_SPREAD_BLOWOUT") {
    throw new Error(`STAGE 1 FAILED: AVAXUSDT 77 bps spread should have been rejected! Got: ${avaxResult.riskResult?.reasonCode}`);
  }
  console.log("  ✅ AVAXUSDT 77.0 bps blowout (> 50.0 bps ceiling) was strictly REJECTED.");

  // =========================================================================
  // TEST CASE 2: LIVE MAINNET ENVIRONMENT (USE_TESTNET = "false")
  // =========================================================================
  console.log("\n[STAGE 2] Testing Live Mainnet Auto-Detection & Institutional Strictness (USE_TESTNET = 'false')...");
  process.env.USE_TESTNET = "false";

  const mainnetBnbEngine = new StrategyEngine(client, riskGuard, executionClient, {
    symbol: "BNBUSDT",
    assetIndex: 3,
  });

  if (mainnetBnbEngine.getIsTestnet()) {
    throw new Error("STAGE 2 FAILED: Engine failed to enforce Mainnet environment when USE_TESTNET='false'!");
  }
  console.log("  ✅ Auto-Detection confirmed: mainnetBnbEngine.getIsTestnet() === false");

  // On Mainnet, BNB with $0.75 spread (10.0 bps) MUST be rejected by strict 5.0 bps ceiling ($0.374)
  const mainnetBnbResult = mainnetBnbEngine.evaluateTick();
  if (mainnetBnbResult.riskResult?.reasonCode !== "REJECTED_MAX_SPREAD_BLOWOUT") {
    throw new Error("STAGE 2 FAILED: Mainnet BNB should have rejected 10 bps spread (> 5.0 bps limit)!");
  }
  console.log("  ✅ Mainnet BNBUSDT: 10.0 bps spread was strictly REJECTED under institutional 5.0 bps limit.");

  // Mainnet BTCUSDT: Spread $2.0 on $80,000 BTC. 2.0 > $1.50 hard cap.
  const mainnetBtcEngine = new StrategyEngine(client, riskGuard, executionClient, {
    symbol: "BTCUSDT",
    assetIndex: 0,
    maxSpreadBtc: 1.50,
  });
  client.writeAtomicFloat64Asset(0, 4, 80488.0);
  client.writeAtomicFloat64Asset(0, 6, 80490.0); // $2.0 spread > $1.50 cap
  const mainnetBtcResult = mainnetBtcEngine.evaluateTick();
  if (mainnetBtcResult.riskResult?.reasonCode !== "REJECTED_MAX_SPREAD_BLOWOUT") {
    throw new Error("STAGE 2 FAILED: Mainnet BTC should have rejected $2.0 spread (> $1.50 cap)!");
  }
  console.log("  ✅ Mainnet BTCUSDT: $2.0 spread strictly REJECTED under $1.50 institutional hard cap.");

  // Mainnet BTCUSDT: Tight spread $0.50 (< $1.50 cap). MUST PASS spread guard.
  client.writeAtomicFloat64Asset(0, 6, 80488.50); // $0.50 spread
  const tightBtcResult = mainnetBtcEngine.evaluateTick();
  if (tightBtcResult.riskResult?.reasonCode === "REJECTED_MAX_SPREAD_BLOWOUT") {
    throw new Error("STAGE 2 FAILED: Mainnet BTC tight spread $0.50 was unexpectedly rejected!");
  }
  console.log("  ✅ Mainnet BTCUSDT: $0.50 tight spread cleanly APPROVED.");

  console.log("\n================================================================================");
  console.log("  ALL AUTO-SWITCHING SPREAD GUARD VERIFICATION CHECKS PASSED (100%)              ");
  console.log("================================================================================");
}

runAutoSwitchingSpreadGuardTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  });

