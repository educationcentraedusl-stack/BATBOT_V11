"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BinanceExecutionClient = exports.RiskGuard = exports.StrategyEngine = exports.MarketDataClient = void 0;
exports.initializeSystem = initializeSystem;
const marketDataClient_1 = require("./marketDataClient");
Object.defineProperty(exports, "MarketDataClient", { enumerable: true, get: function () { return marketDataClient_1.MarketDataClient; } });
const engine_1 = require("./strategy/engine");
Object.defineProperty(exports, "StrategyEngine", { enumerable: true, get: function () { return engine_1.StrategyEngine; } });
const risk_1 = require("./strategy/risk");
Object.defineProperty(exports, "RiskGuard", { enumerable: true, get: function () { return risk_1.RiskGuard; } });
const binance_1 = require("./execution/binance");
Object.defineProperty(exports, "BinanceExecutionClient", { enumerable: true, get: function () { return binance_1.BinanceExecutionClient; } });
function initializeSystem() {
    const sab = new SharedArrayBuffer(1024);
    const client = new marketDataClient_1.MarketDataClient(sab);
    const riskGuard = new risk_1.RiskGuard();
    const executionClient = new binance_1.BinanceExecutionClient();
    const strategyEngine = new engine_1.StrategyEngine(client, riskGuard, executionClient);
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
