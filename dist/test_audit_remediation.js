"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_1 = require("./strategy/engine");
const marketDataClient_1 = require("./marketDataClient");
const risk_1 = require("./strategy/risk");
const binance_1 = require("./execution/binance");
class MockMarketDataClient extends marketDataClient_1.MarketDataClient {
    constructor() {
        super(new SharedArrayBuffer(20480));
    }
    seq = 0n;
    obiVal = 0.50;
    cvdVal = 100;
    bidVal = 3000.0;
    askVal = 3000.2;
    aiDir = 1.0;
    aiConf = 0.85;
    setPrices(bid, ask) {
        this.bidVal = bid;
        this.askVal = ask;
    }
    setSequence(seq) {
        this.seq = seq;
    }
    getSequenceNum() {
        return this.seq;
    }
    getOBI() {
        return this.obiVal;
    }
    getCVD() {
        return this.cvdVal;
    }
    getBestBidPrice() {
        return this.bidVal;
    }
    getBestAskPrice() {
        return this.askVal;
    }
    getAIPredictionDirection() {
        return this.aiDir;
    }
    getAIPredictionConfidence() {
        return this.aiConf;
    }
    getSpreadVelocity() {
        return 0;
    }
    getLatencyPenaltyCoefficient() {
        return 1.0;
    }
    getDynamicSlippageTicks() {
        return 1;
    }
    getShortCooldownLock() {
        return 0;
    }
    getLongCooldownLock() {
        return 0;
    }
}
async function runAuditRemediationTest() {
    console.log("=================================================");
    console.log("RUNNING HOSTILE AUDIT REMEDIATION VERIFICATION");
    console.log("=================================================");
    const client = new MockMarketDataClient();
    const riskGuard = new risk_1.RiskGuard({});
    const executionClient = new binance_1.BinanceExecutionClient();
    // Test 1: Env variable config ingestion without overrides
    process.env.ORDER_QUANTITY = "0.05";
    process.env.MAX_SPREAD_ETH = "0.50";
    process.env.MAX_SPREAD_BTC = "5.0";
    process.env.MIN_NOTIONAL_USDT = "55.0";
    process.env.COOLDOWN_MS = "250";
    const engineBtc = new engine_1.StrategyEngine(client, riskGuard, executionClient, { symbol: "BTCUSDT" });
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
    // Test 4: Spread exceeding dynamic BPS threshold
    const engineEth = new engine_1.StrategyEngine(client, riskGuard, executionClient, { symbol: "ETHUSDT" });
    client.setPrices(3000.0, 3010.0); // Spread = 10.0 USDT (> 4.515 USDT ETH dynamic BPS limit)
    client.setSequence(102n);
    const result3 = engineEth.evaluateTick();
    if (result3.riskResult?.reasonCode !== "REJECTED_LIQUIDITY_SWEEP_TRAP") {
        throw new Error(`FAIL: Spread 10.0 > dynamic BPS limit should reject with REJECTED_LIQUIDITY_SWEEP_TRAP, got ${result3.riskResult?.reasonCode}`);
    }
    console.log("✓ Test 5 Passed: Spread 10.0 USDT > dynamic BPS limit correctly blocked order with REJECTED_LIQUIDITY_SWEEP_TRAP.");
    console.log("=================================================");
    console.log("✅ ALL AUDIT REMEDIATION VERIFICATION TESTS PASSED!");
    console.log("=================================================");
}
runAuditRemediationTest().catch((err) => {
    console.error(err);
    process.exit(1);
});
