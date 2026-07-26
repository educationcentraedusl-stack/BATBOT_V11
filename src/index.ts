import "dotenv/config";
import * as path from "path";
import { MarketDataClient } from "./marketDataClient";
import { StrategyEngine } from "./strategy/engine";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient } from "./execution/binance";
import { TradeLogger } from "./telemetry/logger";
import { CLIDashboard, TelemetryFrame } from "./telemetry/dashboard";
import { TelemetryWSServer } from "./telemetry/server";

export {
  MarketDataClient,
  StrategyEngine,
  RiskGuard,
  BinanceExecutionClient,
  TradeLogger,
  CLIDashboard,
  TelemetryWSServer,
};

export interface SystemControlPlane {
  status: string;
  sab: SharedArrayBuffer;
  client: MarketDataClient;
  riskGuard: RiskGuard;
  executionClient: BinanceExecutionClient;
  strategyEngine: StrategyEngine;
  logger: TradeLogger;
  dashboard: CLIDashboard;
  telemetryServer: TelemetryWSServer;
  isRunning: boolean;
  stop: () => Promise<void>;
}

export function initializeSystem(): SystemControlPlane {
  const sab = new SharedArrayBuffer(1024);
  const client = new MarketDataClient(sab);
  const riskGuard = new RiskGuard();
  const executionClient = new BinanceExecutionClient();
  const strategyEngine = new StrategyEngine(client, riskGuard, executionClient);
  const logger = new TradeLogger("data");
  const dashboard = new CLIDashboard(true);
  const telemetryPort = parseInt(process.env.TELEMETRY_PORT || "8080", 10);
  const telemetryServer = new TelemetryWSServer(telemetryPort);

  let isRunning = true;
  let tickInterval: NodeJS.Timeout | null = null;

  // Try loading native Rust N-API module and starting zero-copy data ingestion
  try {
    const nativePath = path.resolve(__dirname, "../index.js");
    const native = require(nativePath);
    if (native && typeof native.startIngestion === "function") {
      const started = native.startIngestion(Buffer.from(sab));
      if (started) {
        process.stdout.write("[BATBOT_V11] Rust zero-copy ingestion worker started.\n");
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`[BATBOT_V11] Ingestion binding notice: ${msg}\n`);
  }

  // Start Telemetry WebSocket Server
  telemetryServer.start();

  // Active HFT tick evaluation & UI refresh loop (10ms tick polling rate)
  tickInterval = setInterval(() => {
    if (!isRunning) return;

    const startHr = process.hrtime.bigint();
    const tickResult = strategyEngine.evaluateTick();
    const endHr = process.hrtime.bigint();
    const latencyUs = Number(endHr - startHr) / 1000;

    logger.logSignal(
      tickResult.sequenceNum,
      tickResult.signalType,
      tickResult.obi,
      tickResult.cvd,
      tickResult.spreadVelocity,
      tickResult.bidPrice,
      tickResult.askPrice,
      latencyUs
    );

    if (tickResult.executionPromise) {
      tickResult.executionPromise.then((orderRes) => {
        if (orderRes) {
          logger.logExecution(
            orderRes.symbol,
            orderRes.side as "BUY" | "SELL",
            parseFloat(orderRes.price || "0"),
            parseFloat(orderRes.executedQty || "0"),
            0,
            0,
            0
          );
        }
      });
    }

    const frame: TelemetryFrame = {
      symbol: strategyEngine.getConfig().symbol,
      sequenceNum: tickResult.sequenceNum,
      bidPrice: tickResult.bidPrice,
      askPrice: tickResult.askPrice,
      obi: tickResult.obi,
      cvd: tickResult.cvd,
      spreadVelocity: tickResult.spreadVelocity,
      lastSignal: tickResult.signalType,
      tickEvaluationLatencyUs: latencyUs,
      stats: logger.getStats(),
      riskStatus: tickResult.riskResult
        ? tickResult.riskResult.passed
          ? "PASSED"
          : `REJECTED (${tickResult.riskResult.reasonCode})`
        : "IDLE_ACTIVE",
      isEngineActive: isRunning,
    };

    dashboard.render(frame);
    telemetryServer.broadcast(frame);
  }, 10);

  const stop = async (): Promise<void> => {
    if (!isRunning) return;
    isRunning = false;
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    await logger.close();
    await telemetryServer.stop();
    dashboard.clear();
    process.stdout.write("[BATBOT_V11] System shutdown cleanly.\n");
  };

  return {
    status: "BATBOT_V11_CONTROL_PLANE_READY",
    sab,
    client,
    riskGuard,
    executionClient,
    strategyEngine,
    logger,
    dashboard,
    telemetryServer,
    isRunning: true,
    stop,
  };
}

if (require.main === module) {
  const system = initializeSystem();

  const handleShutdown = async () => {
    await system.stop();
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}

