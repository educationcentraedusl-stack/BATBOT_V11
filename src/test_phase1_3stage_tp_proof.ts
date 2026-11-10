import "dotenv/config";
import { HedgePositionLedger } from "./strategy/positionLedger";
import { DynamicSizingCalculator } from "./strategy/dynamicSizing";

function runPhase1Proof(): void {
  console.log("==========================================================================================");
  console.log("  🔍 PHASE 1 PROOF: 3-STAGE PARTIAL TAKE-PROFIT ORDER SPLITTING VERIFICATION");
  console.log("==========================================================================================\n");

  const sizingCalc = new DynamicSizingCalculator();
  console.log(`[Config Audit] MIN_NOTIONAL_USDT: $${String(sizingCalc.getMinNotionalUsdt())}`);
  console.log(`[Config Audit] DYNAMIC_SIZING_CONSOLIDATION_THRESHOLD_USDT: $${String(sizingCalc.getConsolidationThresholdUsdt())}`);

  const testAssets = [
    { symbol: "SOLUSDT", entryPrice: 75.84, tradeNotionalUsdt: 60.0, qty: 0.79 },
    { symbol: "ETHUSDT", entryPrice: 1881.72, tradeNotionalUsdt: 60.0, qty: 0.032 },
    { symbol: "AVAXUSDT", entryPrice: 6.42, tradeNotionalUsdt: 60.0, qty: 9.34 },
  ];

  for (const asset of testAssets) {
    console.log(`\n------------------------------------------------------------------------------------------`);
    console.log(`[Test Trade Input] Symbol: ${asset.symbol} | Entry: $${String(asset.entryPrice)} | Qty: ${String(asset.qty)} (~$${String(asset.tradeNotionalUsdt)} USDT)`);
    
    const ledger = new HedgePositionLedger(asset.symbol);
    ledger.occupyCoreLong(asset.qty, asset.entryPrice, 0.40, 0.20);

    const intents = ledger.generateBatchTpOrderIntents("CORE_LONG", asset.entryPrice, asset.qty, "LONG", 0.00906);

    console.log(`[Execution Engine Output] Generated ${String(intents.length)} POST_ONLY limit TP order intents:`);

    let totalNotional = 0;
    intents.forEach((intent, idx) => {
      const notional = (intent.quantity || 0) * (intent.price || 0);
      totalNotional += notional;
      console.log(
        `  📌 Stage #${String(idx + 1)} TP Order -> Side: ${intent.side} | Type: ${intent.type} | Qty: ${String(intent.quantity)} ${asset.symbol} | Target Price: $${String(intent.price)} | Notional: $${notional.toFixed(2)} USDT | TIF: ${String(intent.timeInForce)} (POST_ONLY)`
      );
    });

    console.log(`[Verification Metrics] Total TP Order Notional: $${totalNotional.toFixed(2)} USDT`);

    if (intents.length !== 3) {
      throw new Error(`❌ PROOF FAILED for ${asset.symbol}: Expected 3 distinct TP stage orders, but got ${String(intents.length)}!`);
    }

    intents.forEach((intent) => {
      if (intent.timeInForce !== "GTX") {
        throw new Error(`❌ PROOF FAILED: Order timeInForce must be GTX (POST_ONLY). Got ${String(intent.timeInForce)}`);
      }
    });

    console.log(`✅ ${asset.symbol} Passed 3-Stage Split Verification!`);
  }

  console.log("\n==========================================================================================");
  console.log("  ✅ PHASE 1 PROOF PASSED: $60 Trades successfully split into 3 distinct POST_ONLY TP orders!");
  console.log("==========================================================================================\n");
}

try {
  runPhase1Proof();
} catch (err: unknown) {
  console.error("❌ Phase 1 Proof Execution Error:", err);
  process.exit(1);
}
