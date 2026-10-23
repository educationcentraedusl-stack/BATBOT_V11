import "dotenv/config";
import { StrategyEngine, StrategyConfig } from "../src/strategy/engine";
import { MarketDataClient } from "../src/marketDataClient";
import { RiskGuard } from "../src/strategy/risk";
import { BinanceExecutionClient } from "../src/execution/binance";

const sab = new SharedArrayBuffer(10 * 256 * 8);
const client = new MarketDataClient(sab);
const riskGuard = new RiskGuard({ minCooldownMs: 0 });
const mockExec = new BinanceExecutionClient();
mockExec.isConfigured = () => true;

// Create 5 engines like in Tests 1-5
const eng1 = new StrategyEngine(client, riskGuard, mockExec, { symbol: "BTCUSDT" });
const eng2 = new StrategyEngine(client, riskGuard, mockExec, { symbol: "ETHUSDT" });
const eng3 = new StrategyEngine(client, riskGuard, mockExec, { symbol: "SOLUSDT" });
const eng4 = new StrategyEngine(client, riskGuard, mockExec, { symbol: "ADAUSDT" });
const eng5 = new StrategyEngine(client, riskGuard, mockExec, { symbol: "DOGEUSDT" });

const xrpConfig: Partial<StrategyConfig> = {
  symbol: "XRPUSDT",
  tradeSizeUsdt: 60,
  minAiConfidence: 0.60,
  aggressiveConfidenceThreshold: 0.65,
  obiBuyThreshold: 0.20,
  obiSellThreshold: -0.20,
  cooldownMs: 0,
  tickSize: 0.0001,
  maxShortSlots: 3,
};

client.writeAtomicFloat64Asset(5, 4, 1.0008);
client.writeAtomicFloat64Asset(5, 5, 5000);
client.writeAtomicFloat64Asset(5, 6, 1.0009);
client.writeAtomicFloat64Asset(5, 7, 95000);
client.writeAtomicFloat64Asset(5, 1, -0.05);
client.writeAtomicFloat64Asset(5, 2, 30559783.0);
client.writeAtomicFloat64Asset(5, 101, 0.1652);
client.writeAtomicFloat64Asset(5, 112, 1.161);
client.writeAtomicFloat64Asset(5, 121, 0.00004);
client.writeAtomicFloat64Asset(5, 123, 0.58);
client.writeAtomicFloat64Asset(5, 124, 0.60);
client.writeAtomicFloat64Asset(5, 93, 0.5427);
client.writeAtomicFloat64Asset(5, 94, 0.5036);

const benchEngine = new StrategyEngine(client, riskGuard, mockExec, xrpConfig);
const bigIntView = new BigInt64Array(sab);

// Warmup
for (let i = 0; i < 5000; i++) {
  Atomics.store(bigIntView, 5 * 256 + 92, BigInt(1000 + i));
  benchEngine.evaluateTick();
}

const iterations = 50000;
const startHr = process.hrtime.bigint();
for (let i = 0; i < iterations; i++) {
  Atomics.store(bigIntView, 5 * 256 + 92, BigInt(10000 + i));
  benchEngine.evaluateTick();
}
const endHr = process.hrtime.bigint();
const totalNs = Number(endHr - startHr);
const avgUs = (totalNs / iterations) / 1000.0;
console.log(`With 6 registered engines: ${avgUs.toFixed(4)} µs`);
