import { SymbolPrecisionRegistry } from "../config/symbolPrecision";
import { formatQuantityForSymbol, getSymbolQuantityPrecision } from "../strategy/engine";

async function runPrecisionRegistryTest() {
  console.log("=========================================================================");
  console.log("  BATBOT_V11 DYNAMIC EXCHANGE-INFO PRECISION REGISTRY TEST SUITE         ");
  console.log("=========================================================================\n");

  // Step 1: Pre-seed & test parse filter rules
  console.log("[Test 1/4] Pre-seeding symbols (BTCUSDT, ETHUSDT, SUIUSDT, PEPEUSDT, DOGEUSDT)...");
  SymbolPrecisionRegistry.preseedOfflineDefaults(["BTCUSDT", "ETHUSDT", "SUIUSDT", "PEPEUSDT", "DOGEUSDT"]);

  // Test SUIUSDT precision (previously unmapped flaw)
  const suiRule = SymbolPrecisionRegistry.getPrecisionRule("SUIUSDT");
  console.log(`  - SUIUSDT Rule: qtyDecimals=${suiRule.qtyDecimals}, stepSize=${suiRule.stepSize}, minNotional=${suiRule.minNotional}`);
  if (suiRule.qtyDecimals !== 1 || suiRule.stepSize !== 0.1) {
    throw new Error(`❌ SUIUSDT precision test failed! Expected decimals=1, stepSize=0.1, got decimals=${suiRule.qtyDecimals}, stepSize=${suiRule.stepSize}`);
  }
  console.log("  ✅ SUIUSDT precision rule verified (1 decimal, stepSize 0.1).");

  // Step 2: Test Quantity Formatting & Truncation
  console.log("\n[Test 2/4] Testing Quantity Truncation vs MinNotional Ceiling Guard...");
  const rawQty = 12.34567;
  const formattedStandard = formatQuantityForSymbol("SUIUSDT", rawQty, false);
  const formattedMinNotional = formatQuantityForSymbol("SUIUSDT", rawQty, true);

  console.log(`  - Raw Qty: ${rawQty}`);
  console.log(`  - Standard Formatted (Floor): ${formattedStandard}`);
  console.log(`  - MinNotional Formatted (Ceiling): ${formattedMinNotional}`);

  if (formattedStandard !== 12.3) {
    throw new Error(`❌ Standard floor quantity formatting failed! Expected 12.3, got ${formattedStandard}`);
  }
  if (formattedMinNotional !== 12.4) {
    throw new Error(`❌ MinNotional ceiling quantity formatting failed! Expected 12.4, got ${formattedMinNotional}`);
  }
  console.log("  ✅ Quantity formatting math verified (Floor=12.3, Ceiling=12.4).");

  // Step 3: Test MinNotional ETH proof case
  console.log("\n[Test 3/4] Verifying ETHUSDT $55 MinNotional Guard Proof Case...");
  const ethPrice = 3000.0;
  const minNotionalUsdt = 55.0;
  const requiredQty = minNotionalUsdt / ethPrice; // 0.018333333333333333
  const ethQty = formatQuantityForSymbol("ETHUSDT", requiredQty, true);
  const resultingNotional = ethQty * ethPrice;

  console.log(`  - ETH Price: $${ethPrice}, Required Qty: ${requiredQty}`);
  console.log(`  - Formatted ETH Qty (MinNotional Guard): ${ethQty}`);
  console.log(`  - Resulting Order Notional: $${resultingNotional.toFixed(2)} USDT`);

  if (resultingNotional < minNotionalUsdt) {
    throw new Error(`❌ MinNotional guard failed! Resulting notional $${resultingNotional} < required $${minNotionalUsdt}`);
  }
  console.log(`  ✅ MinNotional guard verified! Resulting notional $${resultingNotional} >= $${minNotionalUsdt} USDT threshold.`);

  // Step 4: Test Safe Default Fallback for Unmapped Symbol
  console.log("\n[Test 4/4] Testing Safe Fallback Rule for Unmapped Symbol...");
  const fallbackRule = SymbolPrecisionRegistry.getPrecisionRule("UNKNOWN_COIN_XYZ");
  if (!fallbackRule || fallbackRule.qtyDecimals !== 2 || fallbackRule.stepSize !== 0.01 || fallbackRule.minNotional !== 5.0) {
    throw new Error(`❌ Safe fallback failed! Unexpected fallback rule: ${JSON.stringify(fallbackRule)}`);
  }
  console.log(`  ✅ Safe fallback default rule generated successfully: decimals=${fallbackRule.qtyDecimals}, stepSize=${fallbackRule.stepSize}, minNotional=${fallbackRule.minNotional}`);

  console.log("\n=========================================================================");
  console.log("  ✅ ALL DYNAMIC PRECISION REGISTRY UNIT TESTS PASSED DETERMINISTICALLY!   ");
  console.log("=========================================================================\n");
}

runPrecisionRegistryTest().catch((err) => {
  console.error("❌ Precision Registry Test Suite Failed:", err);
  process.exit(1);
});
