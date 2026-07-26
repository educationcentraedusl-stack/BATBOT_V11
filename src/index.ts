import "dotenv/config";
import { MarketDataClient } from "./marketDataClient";
import { StrategyEngine } from "./strategy/engine";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient } from "./execution/binance";

export { MarketDataClient, StrategyEngine, RiskGuard, BinanceExecutionClient };

export interface SystemControlPlane {
  status: string;
  sab: SharedArrayBuffer;
  client: MarketDataClient;
  riskGuard: RiskGuard;
  executionClient: BinanceExecutionClient;
  strategyEngine: StrategyEngine;
}

export function initializeSystem(): SystemControlPlane {
  const sab = new SharedArrayBuffer(1024);
  const client = new MarketDataClient(sab);
  const riskGuard = new RiskGuard();
  const executionClient = new BinanceExecutionClient();
  const strategyEngine = new StrategyEngine(client, riskGuard, executionClient);

  return {
    status: "BATBOT_V11_CONTROL_PLANE_READY",
    sab,
    client,
    riskGuard,
    executionClient,
    strategyEngine,
  };
}

if (require.main === module) {
  const system = initializeSystem();
  process.stdout.write(`${system.status} | Binance Configured: ${system.executionClient.isConfigured()}\n`);
}
