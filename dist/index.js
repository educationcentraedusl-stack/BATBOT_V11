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
exports.TelemetryWSServer = exports.CLIDashboard = exports.TradeLogger = exports.BinanceExecutionClient = exports.RiskGuard = exports.StrategyEngine = exports.MarketDataClient = void 0;
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
function initializeSystem() {
    const sab = new SharedArrayBuffer(1024);
    const client = new marketDataClient_1.MarketDataClient(sab);
    const riskGuard = new risk_1.RiskGuard();
    const executionClient = new binance_1.BinanceExecutionClient();
    const strategyEngine = new engine_1.StrategyEngine(client, riskGuard, executionClient);
    const logger = new logger_1.TradeLogger("data");
    const dashboard = new dashboard_1.CLIDashboard(true);
    const telemetryPort = parseInt(process.env.TELEMETRY_PORT || "8080", 10);
    const telemetryServer = new server_1.TelemetryWSServer(telemetryPort);
    let isRunning = true;
    let tickInterval = null;
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
    // Start Telemetry WebSocket Server
    telemetryServer.start();
    // Active HFT tick evaluation & UI refresh loop (10ms tick polling rate)
    tickInterval = setInterval(() => {
        if (!isRunning)
            return;
        const startHr = process.hrtime.bigint();
        const tickResult = strategyEngine.evaluateTick();
        const endHr = process.hrtime.bigint();
        const latencyUs = Number(endHr - startHr) / 1000;
        logger.logSignal(tickResult.sequenceNum, tickResult.signalType, tickResult.obi, tickResult.cvd, tickResult.spreadVelocity, tickResult.bidPrice, tickResult.askPrice, latencyUs);
        if (tickResult.executionPromise) {
            tickResult.executionPromise.then((orderRes) => {
                if (orderRes) {
                    logger.logExecution(orderRes.symbol, orderRes.side, parseFloat(orderRes.price || "0"), parseFloat(orderRes.executedQty || "0"), 0, 0, 0);
                }
            });
        }
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
    const stop = async () => {
        if (!isRunning)
            return;
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
