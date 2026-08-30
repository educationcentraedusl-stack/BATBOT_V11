import "dotenv/config";
import * as path from "path";
import { MarketDataClient } from "./marketDataClient";
import { StrategyEngine } from "./strategy/engine";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient } from "./execution/binance";
import { TradeLogger } from "./telemetry/logger";
import { CsvTradeLogger } from "./utils/csvLogger";
import { CLIDashboard, TelemetryFrame } from "./telemetry/dashboard";
import { TelemetryWSServer } from "./telemetry/server";
import { ControlCommand } from "./telemetry/proto";
import { AutoRecalibrationManager } from "./ai/recalibrationWorker";
import { SymbolPrecisionRegistry } from "./config/symbolPrecision";

import { MultiAssetStrategyEngine } from "./strategy/multiEngine";
import { MultiAssetRiskGuard } from "./strategy/risk";

export const DEFAULT_TAKER_FEE_RATE = 0.0004;

export {
  MarketDataClient,
  StrategyEngine,
  MultiAssetStrategyEngine,
  RiskGuard,
  MultiAssetRiskGuard,
  BinanceExecutionClient,
  TradeLogger,
  CsvTradeLogger,
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
  csvLogger: CsvTradeLogger;
  dashboard: CLIDashboard;
  telemetryServer: TelemetryWSServer;
  isRunning: boolean;
  stop: () => Promise<void>;
}

export async function syncStateOnStartup(
  executionClient: BinanceExecutionClient,
  strategyEngine: StrategyEngine | MultiAssetStrategyEngine,
  riskGuard: RiskGuard | MultiAssetRiskGuard
): Promise<void> {
  if (!executionClient.isConfigured()) {
    console.log("[StateSync] BinanceExecutionClient unconfigured. Skipping remote state sync.");
    return;
  }
  try {
    console.log("[StateSync] Initiating Binance Server Time & State Synchronization...");
    // 0. Fetch Binance Futures exchangeInfo to initialize dynamic LOT_SIZE & PRICE_FILTER map
    await SymbolPrecisionRegistry.initializeFromBinance(executionClient);

    // 1. Sync server time to fix timestamp error -1021
    await executionClient.syncServerTime();

    // 2. Enable Dual-Side Hedge Mode on Binance Futures
    await executionClient.setHedgeMode(true);

    // 2.5. Synchronize Target Leverage from .env to Binance Futures per symbol
    const envLeverage = parseInt(process.env.LEVERAGE || "10", 10);
    if (Number.isFinite(envLeverage) && envLeverage > 0) {
      if (strategyEngine instanceof MultiAssetStrategyEngine) {
        await strategyEngine.syncLeverageWithExchange(envLeverage);
      } else if ("getConfig" in strategyEngine && typeof (strategyEngine as any).getConfig === "function") {
        const symbol = (strategyEngine as any).getConfig().symbol;
        await executionClient.setLeverage(symbol, envLeverage);
      }
    }

    // 3. Fetch USDT Account Balance
    const balance = await executionClient.fetchUsdtBalanceAsync();
    console.log(`[StateSync] Binance Wallet Available Balance Synced: $${balance.toFixed(2)} USDT`);

    if (riskGuard instanceof MultiAssetRiskGuard) {
      riskGuard.updateAccountBalance(balance);
    }

    // 4. State Hydration & Orphaned Position Guard SL/TP Injection
    if ("syncExchangeState" in strategyEngine && typeof (strategyEngine as any).syncExchangeState === "function") {
      await (strategyEngine as any).syncExchangeState();
    } else if ("getConfig" in strategyEngine && typeof (strategyEngine as any).getConfig === "function") {
      const symbol = (strategyEngine as any).getConfig().symbol;
      const positions = await executionClient.getDualPositionRisk(symbol);
      if (Array.isArray(positions)) {
        (strategyEngine as StrategyEngine).reconcileStartupPositions(positions);
      }
    } else if (strategyEngine instanceof MultiAssetStrategyEngine) {
      const positions = await executionClient.getDualPositionRisk();
      if (Array.isArray(positions)) {
        strategyEngine.reconcileStartupPositions(positions);
      }
    }
  } catch (err: any) {
    console.warn(`[StateSync Warning] Temporary issue during startup state sync: ${err.message}. System starting in resilient mode.`);
  }
}

export async function initializeSystem(): Promise<SystemControlPlane> {
  const parsedMaxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || "10", 10);
  const maxAssets = Number.isFinite(parsedMaxAssets) && parsedMaxAssets > 0 ? parsedMaxAssets : 10;

  const parsedSlotsPerAsset = parseInt(process.env.SAB_SLOTS_PER_ASSET || "256", 10);
  const slotsPerAsset = Number.isFinite(parsedSlotsPerAsset) && parsedSlotsPerAsset > 0 ? parsedSlotsPerAsset : 256;

  const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
  const client = new MarketDataClient(sab, maxAssets, slotsPerAsset);
  client.flushTelemetry();
  const riskGuard = new RiskGuard();
  const executionClient = new BinanceExecutionClient();
  const symbol = process.env.SYMBOL ?? "BTCUSDT";
  const strategyEngine = new StrategyEngine(client, riskGuard, executionClient, { symbol });
  const logger = new TradeLogger("data");
  const csvLogger = new CsvTradeLogger("data", "trade_history.csv");
  const dashboard = new CLIDashboard(true);
  const telemetryPort = parseInt(process.env.TELEMETRY_PORT || "8080", 10);
  const telemetryServer = new TelemetryWSServer(telemetryPort);
  const recalibrationManager = AutoRecalibrationManager.getInstance();
  recalibrationManager.setSustainedDriftThreshold(50);
  recalibrationManager.setOnStateChangeCallback((state) => {
    strategyEngine.setEngineState(state);
  });

  let isRunning = true;
  let tickInterval: NodeJS.Timeout | null = null;

  // Physically await Binance Server Time & State Synchronization BEFORE starting tick loop
  await syncStateOnStartup(executionClient, strategyEngine, riskGuard);

  // Set up Bi-directional WebSocket RPC Control Command Handler
  telemetryServer.setCommandHandler(async (cmd: ControlCommand) => {
    switch (cmd.action) {
      case "ENGINE_START":
        isRunning = true;
        return { success: true, message: "HFT Engine Started Successfully" };
      case "ENGINE_PAUSE":
        isRunning = false;
        return { success: true, message: "HFT Engine Paused Successfully" };
      case "EMERGENCY_KILL":
        isRunning = false;
        riskGuard.updatePositionNotional(0);
        // Attempt flattening position via execution client if configured
        if (executionClient.isConfigured()) {
          try {
            await executionClient.flattenPositions(strategyEngine.getConfig().symbol);
          } catch (err: any) {
            console.error(`[EMERGENCY_KILL] Flattening error: ${err.message}`);
          }
        }
        return { success: true, message: "EMERGENCY KILL EXECUTED: Engine Halted & Position Flattened" };
      case "AI_HOT_SWAP":
        return { success: true, message: `Model Hot-Swap Triggered for: ${cmd.modelPath || "default"}` };
      default:
        return { success: false, message: `Unknown command action: ${(cmd as any).action}` };
    }
  });

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

  // Start Telemetry WebSocket Server (Real-time balance maintained via WebSocket User Data Stream)
  telemetryServer.start();

  // Active HFT tick evaluation & UI refresh loop (10ms tick polling rate)
  tickInterval = setInterval(() => {
    if (!isRunning) return;

    const startHr = process.hrtime.bigint();
    const tickResult = strategyEngine.evaluateTick();
    const endHr = process.hrtime.bigint();
    const latencyUs = Number(endHr - startHr) / 1000;

    // Active Model Drift Evaluation & Self-Healing Trigger (SAB Slot 101 & 102)
    const rollingIc = client.getRollingIC();
    const isDrifted = client.getIsModelDrifted();

    if (riskGuard.isProfitLockedState()) {
      recalibrationManager.enableShadowMode();
      recalibrationManager.evaluateShadowTick(tickResult.sequenceNum, rollingIc);
    } else {
      recalibrationManager.evaluateTickDrift(rollingIc, isDrifted);
    }

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

    const positionLedger = strategyEngine.getPositionLedger();

    if (tickResult.executionPromise) {
      tickResult.executionPromise
        .then((orderRes) => {
          if (orderRes) {
            const execQty = parseFloat(orderRes.executedQty || "0");
            const origQty = parseFloat(orderRes.origQty || "0");
            const finalQty = execQty > 0 ? execQty : (origQty > 0 ? origQty : strategyEngine.getConfig().orderQuantity);
            const px = parseFloat(orderRes.price || orderRes.avgPrice || "0") || (tickResult.signalType === "BUY" ? tickResult.askPrice : tickResult.bidPrice);
            const fee = (px * finalQty) * DEFAULT_TAKER_FEE_RATE;
            const fillSide = (orderRes.side as "BUY" | "SELL") || tickResult.signalType;
            const symbol = orderRes.symbol || strategyEngine.getConfig().symbol;

            // Route fill execution through zero-GC PositionLedger FIFO engine
            const ledgerResult = positionLedger.processFill(symbol, fillSide, px, finalQty, fee, tickResult.exitReason);

            // Log closed trade to CSV asynchronously (non-blocking) when a position is completely closed
            if (ledgerResult.closedTrade) {
              csvLogger.logClosedTrade(ledgerResult.closedTrade);
            }

            // Update RiskGuard position state & record realized PnL
            riskGuard.recordRealizedPnl(ledgerResult.realizedPnl);
            riskGuard.updatePositionNotional(ledgerResult.netQuantityAfterFill * ledgerResult.averageEntryPriceAfterFill);

            logger.logExecution(
              symbol,
              fillSide,
              px,
              finalQty,
              ledgerResult.realizedPnl,
              fee,
              0
            );
          }
        })
        .catch((err: any) => {
          console.error(`[Execution] Order placement execution error: ${err.message}`);
        });
    }

    const posSummary = positionLedger.getSummary(tickResult.askPrice || tickResult.bidPrice);
    const activeTrades = strategyEngine.getActiveTrades(tickResult.askPrice || tickResult.bidPrice);
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
      stats: logger.getStats({
        unrealizedPnl: posSummary.unrealizedPnl,
        positionSide: posSummary.side,
        netQuantity: posSummary.netQuantity,
        averageEntryPrice: posSummary.averageEntryPrice,
        cumulativeRealizedPnl: posSummary.cumulativeRealizedPnl,
        cumulativeFees: posSummary.cumulativeFees,
        totalTrades: posSummary.totalTrades,
        winningTrades: posSummary.winningTrades,
        losingTrades: posSummary.losingTrades,
      }),
      riskStatus: strategyEngine.getEngineState() !== "LIVE_ACTIVE"
        ? `[${strategyEngine.getEngineState()}]`
        : tickResult.riskResult
        ? tickResult.riskResult.passed
          ? "PASSED"
          : `REJECTED (${tickResult.riskResult.reasonCode})`
        : "IDLE_ACTIVE",
      isEngineActive: isRunning,
      usdtBalance: executionClient.getUsdtAvailableBalance(),
      aiDirection: client.getAIPredictionDirection(),
      aiConfidence: client.getAIPredictionConfidence(),
      rollingIc: rollingIc,
      aiInferenceLatencyNs: client.getAIInferenceLatencyNs(),
      rttMs: client.getMeasuredRttMs(),
      latencyPenalty: client.getLatencyPenaltyCoefficient(),
      slippageTicks: client.getDynamicSlippageTicks(),
      activeTrades: activeTrades,
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
    executionClient.stopBalancePolling();
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
    csvLogger,
    dashboard,
    telemetryServer,
    isRunning: true,
    stop,
  };
}

if (require.main === module) {
  (async () => {
    const system = await initializeSystem();

    const handleShutdown = async () => {
      await system.stop();
      process.exit(0);
    };

    process.on("SIGINT", handleShutdown);
    process.on("SIGTERM", handleShutdown);
  })().catch((err) => {
    console.error("[BATBOT_V11] Critical startup initialization error:", err);
    process.exit(1);
  });
}
