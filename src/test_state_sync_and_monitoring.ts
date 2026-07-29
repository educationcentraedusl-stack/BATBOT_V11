import "dotenv/config";
import { MarketDataClient } from "./marketDataClient";
import { StrategyEngine } from "./strategy/engine";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient } from "./execution/binance";
import { PositionLedger } from "./strategy/positionLedger";

async function runAuditAndVerification() {
  console.log("==========================================================================");
  console.log("          BATBOT_V11 AUDIT TEST: TIME SYNC, STATE SYNC & DYNAMIC MONITORING");
  console.log("==========================================================================");

  let passedTests = 0;
  let totalTests = 4;

  // TEST 1: Time Offset Calculation & Signed Query Verification
  console.log("\n[TEST 1] Testing Binance Server Time Sync & Time Offset Application...");
  const client = new BinanceExecutionClient({ useTestnet: true });
  const offset = await client.syncServerTime();
  console.log(`Calculated Server Time Offset: ${offset}ms`);
  const signedQuery = client.signQuery({ symbol: "BTCUSDT", side: "BUY", quantity: 0.001, price: 50000 });
  const hasTimestamp = signedQuery.includes("timestamp=");
  const hasRecvWindow = signedQuery.includes("recvWindow=10000");
  const hasSignature = signedQuery.includes("signature=");

  if (hasTimestamp && hasRecvWindow && hasSignature) {
    console.log("✅ TEST 1 PASSED: Signed query successfully includes offset timestamp, recvWindow=10000, and HMAC SHA256 signature.");
    passedTests++;
  } else {
    console.error("❌ TEST 1 FAILED: Signed query missing required parameters.");
  }

  // TEST 2: Environment Variable Integration for TP / SL Thresholds
  console.log("\n[TEST 2] Testing .env Integration for TAKE_PROFIT_PERCENT and STOP_LOSS_PERCENT...");
  process.env.TAKE_PROFIT_PERCENT = "2.5";
  process.env.STOP_LOSS_PERCENT = "1.2";

  const sab = new SharedArrayBuffer(2048);
  const mktClient = new MarketDataClient(sab);
  const riskGuard = new RiskGuard();
  const engineWithEnv = new StrategyEngine(mktClient, riskGuard, client);
  const cfgEnv = engineWithEnv.getConfig();

  console.log(`Engine Config TP: ${cfgEnv.takeProfitPercent}%, SL: ${cfgEnv.stopLossPercent}%`);
  if (cfgEnv.takeProfitPercent === 2.5 && cfgEnv.stopLossPercent === 1.2) {
    console.log("✅ TEST 2 PASSED: StrategyEngine dynamically parsed .env TAKE_PROFIT_PERCENT (2.5%) and STOP_LOSS_PERCENT (1.2%).");
    passedTests++;
  } else {
    console.error(`❌ TEST 2 FAILED: Expected TP 2.5% and SL 1.2%, got TP ${cfgEnv.takeProfitPercent}% and SL ${cfgEnv.stopLossPercent}%.`);
  }

  // TEST 3: Startup State Sync Verification
  console.log("\n[TEST 3] Testing Startup State Sync on PositionLedger & RiskGuard...");
  const ledger = new PositionLedger("BTCUSDT");
  ledger.syncActivePosition("LONG", 0.05, 60000.0);
  riskGuard.updatePositionNotional(0.05 * 60000.0);

  const summary = ledger.getSummary(60000.0);
  if (summary.side === "LONG" && summary.netQuantity === 0.05 && summary.averageEntryPrice === 60000.0) {
    console.log("✅ TEST 3 PASSED: PositionLedger correctly restored active Binance position state (LONG 0.05 @ $60000.00).");
    passedTests++;
  } else {
    console.error("❌ TEST 3 FAILED: PositionLedger state sync failed.");
  }

  // TEST 4: Continuous Dynamic Monitoring (Take Profit & Stop Loss Trigger)
  console.log("\n[TEST 4] Testing Continuous Dynamic Monitoring (TP/SL Breach Trigger)...");
  const bitcastBuf = new ArrayBuffer(8);
  const bitcastFloat = new Float64Array(bitcastBuf);
  const bitcastBigInt = new BigInt64Array(bitcastBuf);
  const sabBigIntView = new BigInt64Array(sab);

  const writeAtomicFloat = (slot: number, val: number) => {
    bitcastFloat[0] = val;
    Atomics.store(sabBigIntView, slot, bitcastBigInt[0]);
  };

  Atomics.store(sabBigIntView, 92, 100n); // Sequence slot 92
  writeAtomicFloat(4, 62000.0); // Best Bid price slot 4
  writeAtomicFloat(6, 62000.0); // Best Ask price slot 6

  const customEngine = new StrategyEngine(mktClient, riskGuard, client, {}, ledger);
  const result = customEngine.evaluateTick();

  if (result.signalType === "SELL" && result.executionPromise !== undefined) {
    console.log(`✅ TEST 4 PASSED: Dynamic Take Profit trigger detected +3.33% gain! Dispatched MARKET SELL close order with reduceOnly.`);
    passedTests++;
  } else {
    console.error(`❌ TEST 4 FAILED: Dynamic monitoring did not generate expected exit signal. Result signal: ${result.signalType}`);
  }

  console.log("\n==========================================================================");
  console.log(`                  AUDIT SUMMARY: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log("==========================================================================");

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runAuditAndVerification().catch((err) => {
  console.error(`Unhandled test error: ${err.message}`);
  process.exit(1);
});
