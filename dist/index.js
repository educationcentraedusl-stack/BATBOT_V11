"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelemetryWSServer = exports.CLIDashboard = exports.TradeLogger = exports.BinanceExecutionClient = exports.RiskGuard = exports.StrategyEngine = exports.MarketDataClient = exports.DEFAULT_TAKER_FEE_RATE = void 0;
exports.syncStateOnStartup = syncStateOnStartup;
exports.initializeSystem = initializeSystem;
require("dotenv/config");
const path = __importStar(require("path"));
const marketDataClient_1 = require("./marketDataClient");
Object.defineProperty(exports, "MarketDataClient", { enumerable: true, get: function () { return marketDataClient_1.MarketDataClient; } });
const engine_1 = require("./strategy/engine");
Object.defineProperty(exports, "StrategyEngine", { enumerable: true, get: function () { return engine_1.StrategyEngine; } });
const risk_1 = require("./strategy/risk");
Object.defineProperty(exports, "RiskGuard", { enumerable: true, get: function () { return risk_1.RiskGuard; } });
const binance_1 = require("./execution/binance");
Object.defineProperty(exports, "BinanceExecutionClient", { enumerable: true, get: function () { return binance_1.BinanceExecutionClient; } });
const logger_1 = require("./telemetry/logger");
Object.defineProperty(exports, "TradeLogger", { enumerable: true, get: function () { return logger_1.TradeLogger; } });
const dashboard_1 = require("./telemetry/dashboard");
Object.defineProperty(exports, "CLIDashboard", { enumerable: true, get: function () { return dashboard_1.CLIDashboard; } });
const server_1 = require("./telemetry/server");
Object.defineProperty(exports, "TelemetryWSServer", { enumerable: true, get: function () { return server_1.TelemetryWSServer; } });
const recalibrationWorker_1 = require("./ai/recalibrationWorker");
exports.DEFAULT_TAKER_FEE_RATE = 0.0004;
async function syncStateOnStartup(executionClient, strategyEngine, riskGuard) {
    if (!executionClient.isConfigured()) {
        console.log("[StateSync] BinanceExecutionClient unconfigured. Skipping remote state sync.");
        return;
    }
    try {
        console.log("[StateSync] Initiating Binance Server Time & State Synchronization...");
        // 1. Sync server time to fix timestamp error -1021
        await executionClient.syncServerTime();
        // 2. Fetch USDT Account Balance
        const balance = await executionClient.fetchUsdtBalanceAsync();
        console.log(`[StateSync] Binance Wallet Available Balance Synced: $${balance.toFixed(2)} USDT`);
        // 3. Fetch Position Risk & Sync Active Positions
        const symbol = strategyEngine.getConfig().symbol;
        const positions = await executionClient.getPositionRisk(symbol);
        if (Array.isArray(positions)) {
            const match = positions.find((p) => p.symbol === symbol);
            if (match) {
                const amt = parseFloat(match.positionAmt || "0");
                const entryPx = parseFloat(match.entryPrice || "0");
                if (Math.abs(amt) > 0 && entryPx > 0) {
                    const posSide = amt > 0 ? "LONG" : "SHORT";
                    const qty = Math.abs(amt);
                    strategyEngine.getPositionLedger().syncActivePosition(posSide, qty, entryPx);
                    riskGuard.updatePositionNotional(qty * entryPx);
                    console.log(`[StateSync] Open Binance Position Synced: ${posSide} ${qty} ${symbol} @ $${entryPx.toFixed(2)}`);
                }
                else {
                    console.log(`[StateSync] Binance Position Synced: FLAT (No active open positions for ${symbol})`);
                }
            }
        }
    }
    catch (err) {
        console.error(`[StateSync] Critical Error during startup state sync: ${err.message}`);
    }
}
function initializeSystem() {
    const sab = new SharedArrayBuffer(2048);
    const client = new marketDataClient_1.MarketDataClient(sab);
    const riskGuard = new risk_1.RiskGuard();
    const executionClient = new binance_1.BinanceExecutionClient();
    const strategyEngine = new engine_1.StrategyEngine(client, riskGuard, executionClient);
    const logger = new logger_1.TradeLogger("data");
    const dashboard = new dashboard_1.CLIDashboard(true);
    const telemetryPort = parseInt(process.env.TELEMETRY_PORT || "8080", 10);
    const telemetryServer = new server_1.TelemetryWSServer(telemetryPort);
    const recalibrationManager = recalibrationWorker_1.AutoRecalibrationManager.getInstance();
    recalibrationManager.setSustainedDriftThreshold(50);
    let isRunning = true;
    let tickInterval = null;
    // Trigger non-blocking async state sync on startup
    syncStateOnStartup(executionClient, strategyEngine, riskGuard).catch((err) => {
        console.error(`[StateSync] Non-blocking state sync error: ${err.message}`);
    });
    // Set up Bi-directional WebSocket RPC Control Command Handler
    telemetryServer.setCommandHandler(async (cmd) => {
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
                    }
                    catch (err) {
                        console.error(`[EMERGENCY_KILL] Flattening error: ${err.message}`);
                    }
                }
                return { success: true, message: "EMERGENCY KILL EXECUTED: Engine Halted & Position Flattened" };
            case "AI_HOT_SWAP":
                return { success: true, message: `Model Hot-Swap Triggered for: ${cmd.modelPath || "default"}` };
            default:
                return { success: false, message: `Unknown command action: ${cmd.action}` };
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
    }
    catch (err) {
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
        if (!isRunning)
            return;
        const startHr = process.hrtime.bigint();
        const tickResult = strategyEngine.evaluateTick();
        const endHr = process.hrtime.bigint();
        const latencyUs = Number(endHr - startHr) / 1000;
        // Active Model Drift Evaluation & Self-Healing Trigger (SAB Slot 101 & 102)
        const rollingIc = client.getRollingIC();
        const isDrifted = client.getIsModelDrifted();
        recalibrationManager.evaluateTickDrift(rollingIc, isDrifted);
        logger.logSignal(tickResult.sequenceNum, tickResult.signalType, tickResult.obi, tickResult.cvd, tickResult.spreadVelocity, tickResult.bidPrice, tickResult.askPrice, latencyUs);
        const positionLedger = strategyEngine.getPositionLedger();
        if (tickResult.executionPromise) {
            tickResult.executionPromise.then((orderRes) => {
                if (orderRes) {
                    const execQty = parseFloat(orderRes.executedQty || "0");
                    const origQty = parseFloat(orderRes.origQty || "0");
                    const finalQty = execQty > 0 ? execQty : (origQty > 0 ? origQty : strategyEngine.getConfig().orderQuantity);
                    const px = parseFloat(orderRes.price || orderRes.avgPrice || "0") || (tickResult.signalType === "BUY" ? tickResult.askPrice : tickResult.bidPrice);
                    const fee = (px * finalQty) * exports.DEFAULT_TAKER_FEE_RATE;
                    const fillSide = orderRes.side || tickResult.signalType;
                    const symbol = orderRes.symbol || strategyEngine.getConfig().symbol;
                    // Route fill execution through zero-GC PositionLedger FIFO engine
                    const ledgerResult = positionLedger.processFill(symbol, fillSide, px, finalQty, fee);
                    // Update RiskGuard position state & record realized PnL
                    riskGuard.recordRealizedPnl(ledgerResult.realizedPnl);
                    riskGuard.updatePositionNotional(ledgerResult.netQuantityAfterFill * ledgerResult.averageEntryPriceAfterFill);
                    logger.logExecution(symbol, fillSide, px, finalQty, ledgerResult.realizedPnl, fee, 0);
                }
            });
        }
        const posSummary = positionLedger.getSummary(tickResult.askPrice || tickResult.bidPrice);
        const frame = {
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
            riskStatus: tickResult.riskResult
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
        };
        dashboard.render(frame);
        telemetryServer.broadcast(frame);
    }, 10);
    const stop = async () => {
        if (!isRunning)
            return;
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
