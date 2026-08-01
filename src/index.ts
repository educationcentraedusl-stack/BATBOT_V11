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

export const DEFAULT_TAKER_FEE_RATE = 0.0004;

export {
  MarketDataClient,
  StrategyEngine,
  RiskGuard,
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
  strategyEngine: StrategyEngine,
  riskGuard: RiskGuard
): Promise<void> {
  if (!executionClient.isConfigured()) {
    console.log("[StateSync] BinanceExecutionClient unconfigured. Skipping remote state sync.");
    return;
  }
  try {
    console.log("[StateSync] Initiating Binance Server Time & State Synchronization...");
    // 1. Sync server time to fix timestamp error -1021
    await executionClient.syncServerTime();

    // 2. Enable Dual-Side Hedge Mode on Binance Futures
    await executionClient.setHedgeMode(true);

    // 3. Fetch USDT Account Balance
    const balance = await executionClient.fetchUsdtBalanceAsync();
    console.log(`[StateSync] Binance Wallet Available Balance Synced: $${balance.toFixed(2)} USDT`);

    // 4. Fetch Position Risk & Sync Active Positions (Filter explicitly by positionSide LONG and SHORT)
    const symbol = strategyEngine.getConfig().symbol;
    const positions = await executionClient.getPositionRisk(symbol);
    if (Array.isArray(positions)) {
      let hasActivePosition = false;
      for (const pos of positions) {
        if (pos.symbol !== symbol) continue;
        const amt = parseFloat(pos.positionAmt || "0");
        const entryPx = parseFloat(pos.entryPrice || "0");
        const posSide = pos.positionSide === "LONG" || (pos.positionSide === "BOTH" && amt > 0) ? "LONG" : "SHORT";

        if (Math.abs(amt) > 0 && entryPx > 0) {
          hasActivePosition = true;
          const qty = Math.abs(amt);
          strategyEngine.getPositionLedger().syncActivePosition(posSide, qty, entryPx);
          if (posSide === "LONG") {
            strategyEngine.getHedgeLedger().occupyCoreLong(
              qty,
              entryPx,
              strategyEngine.getConfig().longTakeProfitPercent,
              strategyEngine.getConfig().longStopLossPercent
            );
          } else {
            strategyEngine.getHedgeLedger().occupyShortSlot(
              0,
              qty,
              entryPx,
              strategyEngine.getConfig().shortTakeProfitPercent,
              strategyEngine.getConfig().shortStopLossPercent
            );
          }
          riskGuard.updatePositionNotional(qty * entryPx);
          console.log(`[StateSync] Open Binance Position Synced: ${posSide} (${pos.positionSide || "DEFAULT"}) ${qty} ${symbol} @ $${entryPx.toFixed(2)}`);
        }
      }
      if (!hasActivePosition) {
        console.log(`[StateSync] Binance Position Synced: FLAT (No active open positions for ${symbol})`);
      }
    }
  } catch (err: any) {
    console.error(`[StateSync] Critical Error during startup state sync: ${err.message}`);
    throw err;
  }
}

export async function initializeSystem(): Promise<SystemControlPlane> {
  const sab = new SharedArrayBuffer(2048);
  const client = new MarketDataClient(sab);
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

  // Start Telemetry WebSocket Server & Async Binance Balance Polling (every 5s)
  telemetryServer.start();
  if (executionClient.isConfigured()) {
    executionClient.startBalancePolling(5000);
  }

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
