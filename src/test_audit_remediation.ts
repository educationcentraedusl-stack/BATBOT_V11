import { StrategyEngine } from "./strategy/engine";
import { MarketDataClient } from "./marketDataClient";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient } from "./execution/binance";

class MockMarketDataClient extends MarketDataClient {
  constructor() {
    super(new SharedArrayBuffer(20480));
  }

  private seq: bigint = 0n;
  private obiVal: number = 0.50;
  private cvdVal: number = 100;
  private bidVal: number = 3000.0;
  private askVal: number = 3000.2;
  private aiDir: number = 1.0;
  private aiConf: number = 0.85;

  public setPrices(bid: number, ask: number) {
    this.bidVal = bid;
    this.askVal = ask;
  }

  public setSequence(seq: bigint) {
    this.seq = seq;
  }

  public override getSequenceNum(): bigint {
    return this.seq;
  }

  public override getOBI(): number {
    return this.obiVal;
  }

  public override getCVD(): number {
    return this.cvdVal;
  }

  public override getBestBidPrice(): number {
    return this.bidVal;
  }

  public override getBestAskPrice(): number {
    return this.askVal;
  }

  public override getAIPredictionDirection(): number {
    return this.aiDir;
  }

  public override getAIPredictionConfidence(): number {
    return this.aiConf;
  }

  public override getSpreadVelocity(): number {
    return 0;
  }

  public override getLatencyPenaltyCoefficient(): number {
    return 1.0;
  }

  public override getDynamicSlippageTicks(): number {
    return 1;
  }

  public override getShortCooldownLock(): number {
    return 0;
  }

  public override getLongCooldownLock(): number {
    return 0;
  }
}

async function runAuditRemediationTest() {
  console.log("=================================================");
  console.log("RUNNING HOSTILE AUDIT REMEDIATION VERIFICATION");
  console.log("=================================================");

  const client = new MockMarketDataClient();
  const riskGuard = new RiskGuard({});
  const executionClient = new BinanceExecutionClient();

  // Test 1: Env variable config ingestion without overrides
  process.env.ORDER_QUANTITY = "0.05";
  process.env.MAX_SPREAD_ETH = "0.50";
  process.env.MAX_SPREAD_BTC = "5.0";
  process.env.MIN_NOTIONAL_USDT = "55.0";
  process.env.COOLDOWN_MS = "250";

  const engineBtc = new StrategyEngine(client, riskGuard, executionClient, { symbol: "BTCUSDT" });
  const configBtc = engineBtc.getConfig();

  if (configBtc.orderQuantity !== 0.05) {
    throw new Error(`FAIL: BTC orderQuantity should be 0.05 from .env, got ${configBtc.orderQuantity}`);
  }
  console.log("✓ Test 1 Passed: BTC orderQuantity strictly trusts .env (0.05) without hardcoded override.");

  if (configBtc.maxSpreadEth !== 0.50 || configBtc.maxSpreadBtc !== 5.0 || configBtc.minNotionalUsdt !== 55.0 || configBtc.cooldownMs !== 250) {
    throw new Error("FAIL: Environment variables for spread, min notional, or cooldown were not ingested correctly.");
  }
  console.log("✓ Test 2 Passed: MAX_SPREAD_ETH, MAX_SPREAD_BTC, MIN_NOTIONAL_USDT, and COOLDOWN_MS ingested correctly.");

  // Test 2: Invalid tick data handling in Spread Guard (bid <= 0 or ask <= 0)
  client.setPrices(0, 3000.2); // Bid is 0
  client.setSequence(100n);
  const result1 = engineBtc.evaluateTick();

  if (result1.riskResult?.reasonCode !== "INVALID_TICK_DATA") {
    throw new Error(`FAIL: Invalid tick data (bid=0) should return INVALID_TICK_DATA, got ${result1.riskResult?.reasonCode}`);
  }
  console.log("✓ Test 3 Passed: Invalid tick data (bid=0) evaluated spread to Infinity and rejected with INVALID_TICK_DATA.");

  // Test 3: Crossed orderbook (bid > ask)
  client.setPrices(3005.0, 3000.0); // Bid > Ask
  client.setSequence(101n);
  const result2 = engineBtc.evaluateTick();

  if (result2.riskResult?.reasonCode !== "INVALID_TICK_DATA") {
    throw new Error(`FAIL: Crossed orderbook (bid > ask) should return INVALID_TICK_DATA, got ${result2.riskResult?.reasonCode}`);
  }
  console.log("✓ Test 4 Passed: Crossed orderbook evaluated spread to Infinity and rejected with INVALID_TICK_DATA.");

  // Test 4: Spread exceeding threshold
  const engineEth = new StrategyEngine(client, riskGuard, executionClient, { symbol: "ETHUSDT" });
  client.setPrices(3000.0, 3001.0); // Spread = 1.0 USDT (> 0.50 ETH limit)
  client.setSequence(102n);
  const result3 = engineEth.evaluateTick();

  if (result3.riskResult?.reasonCode !== "REJECTED_LIQUIDITY_SWEEP_TRAP") {
    throw new Error(`FAIL: Spread 1.0 > 0.50 should reject with REJECTED_LIQUIDITY_SWEEP_TRAP, got ${result3.riskResult?.reasonCode}`);
  }
  console.log("✓ Test 5 Passed: Spread 1.0 USDT > 0.50 USDT correctly blocked MARKET order with REJECTED_LIQUIDITY_SWEEP_TRAP.");

  console.log("=================================================");
  console.log("✅ ALL AUDIT REMEDIATION VERIFICATION TESTS PASSED!");
  console.log("=================================================");
}

runAuditRemediationTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
