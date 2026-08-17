import "dotenv/config";
import { RiskGuard, MultiAssetRiskGuard, OrderIntent } from "../strategy/risk";
import { MarketDataClient } from "../marketDataClient";
import { SAB_SLOTS } from "../ipc/sabSchema";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[ASSERTION_FAILED] ${message}`);
  }
}

async function runConsecutiveLossCircuitBreakerTestSuite() {
  console.log("================================================================================");
  console.log("  BATBOT_V11 SOTA: CONSECUTIVE-LOSS CIRCUIT BREAKER & PACING TEST SUITE");
  console.log("  - Exponential Cooldown Escalation: 15s -> 60s -> 180s -> 900s (15m halt)");
  console.log("  - Realized ROE Reset Threshold: Net ROE > +0.20% resets loss count to 0");
  console.log("  - Scratch Exit Protection: Net ROE <= +0.20% preserves loss count");
  console.log("  - Emergency Order Bypass & Multi-Symbol Isolation");
  console.log("================================================================================\n");

  // -----------------------------------------------------------------------------------------
  // TEST 1: Loss Accumulation & Exponential Cooldown Calculation
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 1] Testing Exponential Cooldown Calculation & Loss Accumulation...");
  const riskGuard = new RiskGuard();
  const btcSymbol = "BTCUSDT";

  assert(riskGuard.getConsecutiveLosses(btcSymbol) === 0, "Initial consecutive losses must be 0");
  assert(RiskGuard.calculateExponentialLossCooldownMs(0) === 0, "0 losses cooldown should be 0ms");
  assert(RiskGuard.calculateExponentialLossCooldownMs(1) === 15_000, "1 loss cooldown should be 15,000ms (15s)");
  assert(RiskGuard.calculateExponentialLossCooldownMs(2) === 60_000, "2 losses cooldown should be 60,000ms (60s)");
  assert(RiskGuard.calculateExponentialLossCooldownMs(3) === 180_000, "3 losses cooldown should be 180,000ms (180s)");
  assert(RiskGuard.calculateExponentialLossCooldownMs(4) === 180_000, "4 losses cooldown should be 180,000ms (180s)");
  assert(RiskGuard.calculateExponentialLossCooldownMs(5) === 900_000, "5 losses cooldown should be 900,000ms (15m hard halt)");
  assert(RiskGuard.calculateExponentialLossCooldownMs(10) === 900_000, ">= 5 losses cooldown capped at 900,000ms");
  console.log("  ✓ All exponential cooldown escalation thresholds verified (15s, 60s, 180s, 900s)");

  // 1st Loss: -$0.60, -1.0% Net ROE
  let count = riskGuard.recordTradeOutcome(btcSymbol, -0.60, -1.0);
  assert(count === 1 && riskGuard.getConsecutiveLosses(btcSymbol) === 1, "Loss count should be 1");
  console.log("  ✓ 1st Loss (-$0.60, -1.0% ROE) -> consecutive losses: 1 (15s cooldown)");

  // 2nd Loss: -$1.50, -2.5% Net ROE
  count = riskGuard.recordTradeOutcome(btcSymbol, -1.50, -2.5);
  assert(count === 2 && riskGuard.getConsecutiveLosses(btcSymbol) === 2, "Loss count should be 2");
  console.log("  ✓ 2nd Loss (-$1.50, -2.5% ROE) -> consecutive losses: 2 (60s cooldown)");

  // 3rd Loss: -$0.80, -1.3% Net ROE
  count = riskGuard.recordTradeOutcome(btcSymbol, -0.80, -1.3);
  assert(count === 3 && riskGuard.getConsecutiveLosses(btcSymbol) === 3, "Loss count should be 3");
  console.log("  ✓ 3rd Loss (-$0.80, -1.3% ROE) -> consecutive losses: 3 (180s cooldown)\n");

  // -----------------------------------------------------------------------------------------
  // TEST 2: Scratch Exit Immunity & Winning Exit Reset (> +0.20% Net ROE)
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 2] Testing Scratch Exit Immunity & +0.20% Net ROE Reset Threshold...");
  
  // Scratch exit: +$0.05, +0.08% Net ROE (<= +0.20%) -> MUST NOT reset count
  count = riskGuard.recordTradeOutcome(btcSymbol, 0.05, 0.08);
  assert(count === 3 && riskGuard.getConsecutiveLosses(btcSymbol) === 3, "Scratch trade (<= +0.20% ROE) must NOT reset counter");
  console.log("  ✓ Scratch Exit (+0.08% Net ROE <= +0.20%): Consecutive losses remain locked at 3");

  // Scratch exit 2: +$0.02, +0.03% Net ROE (<= +0.20%) -> MUST NOT reset count
  count = riskGuard.recordTradeOutcome(btcSymbol, 0.02, 0.03);
  assert(count === 3 && riskGuard.getConsecutiveLosses(btcSymbol) === 3, "Scratch trade 2 must NOT reset counter");
  console.log("  ✓ Scratch Exit 2 (+0.03% Net ROE <= +0.20%): Consecutive losses remain locked at 3");

  // Realized Winning Exit: +$1.20, +1.50% Net ROE (> +0.20%) -> MUST reset count to 0
  count = riskGuard.recordTradeOutcome(btcSymbol, 1.20, 1.50);
  assert(count === 0 && riskGuard.getConsecutiveLosses(btcSymbol) === 0, "Winning trade (> +0.20% ROE) MUST reset counter to 0");
  console.log("  ✓ Realized Winning Exit (+1.50% Net ROE > +0.20%): Consecutive losses successfully reset to 0\n");

  // -----------------------------------------------------------------------------------------
  // TEST 3: Order Validation Under Active Cooldown & Emergency Bypass
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 3] Testing Order Validation Under Circuit Breaker & Emergency Bypass...");
  const ethSymbol = "ETHUSDT";
  const now = Date.now();

  // Set 60s cooldown lock on ETH
  riskGuard.setSymbolCooldownExpiry(ethSymbol, now + 60_000);

  const entryIntent: OrderIntent = {
    symbol: ethSymbol,
    side: "BUY",
    quantity: 0.5,
    price: 3000.0,
    stopLossPrice: 2970.0,
    takeProfitPrice: 3075.0,
  };

  const validationResult = riskGuard.validateOrder(entryIntent, true, "FLAT");
  assert(!validationResult.passed, "Entry order MUST be rejected when symbol is in cooldown");
  assert(validationResult.reasonCode === "COOLDOWN_ACTIVE", `Reason must be COOLDOWN_ACTIVE, got ${validationResult.reasonCode}`);
  console.log("  ✓ Entry order rejected under active cooldown (COOLDOWN_ACTIVE)");

  // Emergency Hard-Stop Exit Order MUST bypass cooldown immediately
  const hardStopIntent: OrderIntent = {
    symbol: ethSymbol,
    side: "SELL",
    quantity: 0.5,
    price: 2970.0,
    isHardStop: true,
  };
  const hardStopResult = riskGuard.validateOrder(hardStopIntent, true, "LONG");
  assert(hardStopResult.passed, "Hard stop exit order MUST bypass cooldown");
  console.log("  ✓ Hard-stop emergency exit passed cooldown bypass");

  // Emergency Close Order MUST bypass cooldown immediately
  const closeIntent: OrderIntent = {
    symbol: ethSymbol,
    side: "SELL",
    quantity: 0.5,
    price: 2970.0,
    isCloseOrder: true,
  };
  const closeResult = riskGuard.validateOrder(closeIntent, true, "LONG");
  assert(closeResult.passed, "Position close order MUST bypass cooldown");
  console.log("  ✓ Position close order passed cooldown bypass\n");

  // -----------------------------------------------------------------------------------------
  // TEST 4: Multi-Asset Symbol Isolation & SharedArrayBuffer Synchronization
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 4] Testing Multi-Asset Symbol Isolation & SharedArrayBuffer Sync...");
  const multiRiskGuard = new MultiAssetRiskGuard();
  const solSymbol = "SOLUSDT";

  // Simulate 5 consecutive losses on SOLUSDT (15-min circuit breaker halt)
  for (let i = 0; i < 5; i++) {
    multiRiskGuard.recordTradeOutcome(solSymbol, -2.0, -3.0);
  }
  assert(multiRiskGuard.getConsecutiveLosses(solSymbol) === 5, "SOLUSDT should have 5 consecutive losses");
  assert(multiRiskGuard.getConsecutiveLosses("BTCUSDT") === 0, "BTCUSDT must remain at 0 losses (isolated)");
  assert(multiRiskGuard.getConsecutiveLosses("ETHUSDT") === 0, "ETHUSDT must remain at 0 losses (isolated)");

  // Verify SAB atomic cooldown lock bitcasting
  const sab = new SharedArrayBuffer(10 * 256 * 8);
  const client = new MarketDataClient(sab, 10, 256);
  const solAssetIdx = 2; // SOLUSDT
  const btcAssetIdx = 0; // BTCUSDT

  const expiryMs = Date.now() + 900_000;
  client.setLongCooldownLock(expiryMs, solAssetIdx);
  client.setShortCooldownLock(expiryMs, solAssetIdx);

  assert(client.getLongCooldownLock(solAssetIdx) === expiryMs, "SAB long cooldown lock must match stored timestamp");
  assert(client.getShortCooldownLock(solAssetIdx) === expiryMs, "SAB short cooldown lock must match stored timestamp");
  assert(client.getLongCooldownLock(btcAssetIdx) === 0, "BTC asset SAB long cooldown lock must remain 0");
  console.log("  ✓ Multi-Asset symbol isolation and SAB atomic memory sync verified.\n");

  console.log("================================================================================");
  console.log("  ALL CONSECUTIVE-LOSS CIRCUIT BREAKER TESTS PASSED! (100% VERIFIED)");
  console.log("================================================================================");
}

runConsecutiveLossCircuitBreakerTestSuite().catch((err) => {
  console.error("FATAL TEST FAILURE:", err);
  process.exit(1);
});
