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
exports.runProductionTuiLauncher = runProductionTuiLauncher;
require("dotenv/config");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const marketDataClient_1 = require("../marketDataClient");
const multiAssetDashboard_1 = require("../telemetry/multiAssetDashboard");
const keypressHandler_1 = require("../telemetry/keypressHandler");
const binance_1 = require("../execution/binance");
const tradingSymbols_1 = require("../config/tradingSymbols");
const multiEngine_1 = require("../strategy/multiEngine");
const risk_1 = require("../strategy/risk");
const index_1 = require("../index");
const symbolPrecision_1 = require("../config/symbolPrecision");
const recalibrationWorker_1 = require("../ai/recalibrationWorker");
const timeSynchronizer_1 = require("../utils/timeSynchronizer");
async function runProductionTuiLauncher() {
    console.log("=========================================================================");
    console.log("  BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM - PRODUCTION TUI LAUNCHER     ");
    console.log("=========================================================================\n");
    // Step 1: Pre-Flight Verification of Environment & Native N-API Binaries
    console.log("[Pre-Flight 1/3] Verifying environment configurations...");
    const activeSymbols = (0, tradingSymbols_1.getTradingSymbols)();
    const parsedMaxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || String(activeSymbols.length), 10);
    const maxAssets = Math.max(activeSymbols.length, Number.isFinite(parsedMaxAssets) && parsedMaxAssets > 0 ? parsedMaxAssets : activeSymbols.length);
    const parsedSlotsPerAsset = parseInt(process.env.SAB_SLOTS_PER_ASSET || "256", 10);
    const slotsPerAsset = Number.isFinite(parsedSlotsPerAsset) && parsedSlotsPerAsset > 0 ? parsedSlotsPerAsset : 256;
    const totalSABBytes = maxAssets * slotsPerAsset * 8;
    console.log(`  - Active Trading Symbols (${activeSymbols.length}): ${activeSymbols.join(", ")}`);
    console.log(`  - Concurrency Capacity: ${maxAssets} Asset Slots`);
    console.log(`  - Slots Per Asset: ${slotsPerAsset}`);
    console.log(`  - SharedArrayBuffer Size: ${totalSABBytes} bytes`);
    console.log("\n[Pre-Flight 2/3] Verifying Native Rust N-API Binary Module...");
    let platformBinary;
    switch (process.platform) {
        case "win32":
            platformBinary = `index.win32-${process.arch}-msvc.node`;
            break;
        case "darwin":
            platformBinary = `index.darwin-${process.arch}.node`;
            break;
        default:
            platformBinary = `index.linux-${process.arch}-gnu.node`;
            break;
    }
    const nativeBinaryPath = path.resolve(process.cwd(), platformBinary);
    const nativeIndexPath = path.resolve(process.cwd(), "index.js");
    let nativeModule = null;
    let isNativeVerified = false;
    if (fs.existsSync(nativeIndexPath)) {
        try {
            nativeModule = require(nativeIndexPath);
            if (nativeModule &&
                (typeof nativeModule.startIngestion === "function" || typeof nativeModule.initCore === "function")) {
                isNativeVerified = true;
                console.log(`  ✅ Native Rust N-API binary verified online (Zero-Copy IPC Ready: ${platformBinary}).`);
            }
            else {
                console.warn("  ⚠️ Native module loaded but missing expected export symbols.");
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`  ⚠️ Rust N-API binary loading notice: ${msg}`);
        }
    }
    else if (fs.existsSync(nativeBinaryPath)) {
        console.warn(`  ⚠️ Platform binary '${platformBinary}' detected but root 'index.js' binding entry is missing. Run 'npm run build:rust' to generate binding exports.`);
    }
    else {
        console.warn(`  ⚠️ Native N-API binary file ('${platformBinary}') not detected in root. Run 'npm run build:rust' if native acceleration is required.`);
    }
    // Step 2: Initialize SharedArrayBuffer & Market Data Client
    console.log("\n[Pre-Flight 3/3] Initializing Zero-Copy SharedArrayBuffer & Telemetry Engine...");
    const sab = new SharedArrayBuffer(totalSABBytes);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    // Initialize SOTA Time Synchronization Engine (NTP Drift Compensation & SAB Slot 100 Sync)
    timeSynchronizer_1.timeSynchronizer.subscribeOffsetUpdated((offset) => {
        client.setGlobalServerTimeOffsetMs(offset);
    });
    await timeSynchronizer_1.timeSynchronizer.start();
    // Attempt starting native zero-copy ingestion if available
    if (isNativeVerified && nativeModule && typeof nativeModule.startIngestion === "function") {
        try {
            const started = nativeModule.startIngestion(Buffer.from(sab), activeSymbols);
            if (started) {
                console.log(`  ✅ Rust Zero-Copy Multi-Asset Ingestion Workers Started (${activeSymbols.length} Coins Streaming).`);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`  ⚠️ Notice starting Rust ingestion worker: ${msg}`);
        }
    }
    console.log("  ✅ Zero-Copy SharedArrayBuffer Memory Layout Verified.");
    console.log("\n🚀 All Pre-Flight Checks Complete! Launching Multi-Asset TUI Command Center...\n");
    // Wait 1 second so pre-flight messages are readable before clearing terminal screen
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Step 3: Launch Multi-Asset TUI Dashboard & Keypress Control Engine
    const dashboard = new multiAssetDashboard_1.MultiAssetCLIDashboard(client, true, activeSymbols);
    const keyEngine = new keypressHandler_1.InteractiveKeypressEngine(client);
    const binanceClient = new binance_1.BinanceExecutionClient();
    const riskGuard = new risk_1.MultiAssetRiskGuard();
    // Pre-fetch Binance Futures exchangeInfo to build dynamic LOT_SIZE & PRICE_FILTER precision map
    try {
        await symbolPrecision_1.SymbolPrecisionRegistry.initializeFromBinance(binanceClient);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  ⚠️ [SymbolPrecisionRegistry] Initialization notice: ${msg}. Pre-seeding offline defaults.`);
        symbolPrecision_1.SymbolPrecisionRegistry.preseedOfflineDefaults(activeSymbols);
    }
    const multiEngine = new multiEngine_1.MultiAssetStrategyEngine(client, riskGuard, binanceClient, activeSymbols);
    if (binanceClient.isConfigured()) {
        dashboard.pushNotification("✅ Binance API credentials verified. WebSocket User Data Stream active.");
        // SOTA Centralized Account-Level User Data Stream Initialization
        multiEngine.initUserDataStream()
            .then((started) => {
            if (started) {
                dashboard.pushNotification("✅ Centralized Account-Level User Data Stream online (Fills & Account Updates).");
            }
        })
            .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            dashboard.pushNotification(`⚠️ [UserDataStream Notice] ${msg}`);
        });
        // Startup State Synchronization & SL/TP Bracket Injection
        (0, index_1.syncStateOnStartup)(binanceClient, multiEngine, riskGuard)
            .then(() => {
            dashboard.pushNotification(`✅ Multi-Asset state synchronized with Binance API for ${activeSymbols.length} coins.`);
            // SOTA Passive 60-Second Continuous Reconciliation Heartbeat (Anti-Orphan Guard)
            multiEngine.startContinuousReconciliation(60000);
            dashboard.pushNotification("✅ 60-Second Passive Continuous Reconciliation Heartbeat active.");
        })
            .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            dashboard.pushNotification(`⚠️ [StateSync Notice] ${msg}`);
        });
    }
    else {
        dashboard.pushNotification("⛔ [CRITICAL_WARNING] BINANCE API KEYS MISSING IN .env! TRADING IN SHADOW MODE ONLY.");
        dashboard.pushNotification("⛔ [CRITICAL_WARNING] Set BINANCE_API_KEY and BINANCE_API_SECRET in .env to enable live execution.");
    }
    dashboard.pushNotification("BATBOT_V11 Production Launch Sequence Complete.");
    dashboard.pushNotification(`${maxAssets}-Asset SharedArrayBuffer Active (${totalSABBytes} bytes).`);
    dashboard.pushNotification(`Multi-Asset Engine Live across ${activeSymbols.length} coins (10ms Parallel Tick Loop).`);
    dashboard.pushNotification("Keyboard active: 0-9 = Focus Asset, K = Kill, P = Pause, C = Close All, Q = Quit.");
    keyEngine.setAssetFocusCallback((idx) => {
        dashboard.setFocusedAsset(idx);
    });
    keyEngine.setNotificationCallback((msg) => {
        dashboard.pushNotification(msg);
    });
    keyEngine.start();
    // Initialize Local Asynchronous Auto-Recalibration Manager
    const recalibrationManager = recalibrationWorker_1.AutoRecalibrationManager.getInstance();
    recalibrationManager.setMarketDataClient(client, maxAssets);
    recalibrationManager.setSustainedDriftThreshold(50);
    recalibrationManager.setOnStateChangeCallback((state) => {
        dashboard.pushNotification(`[RECALIBRATION_STATE] State Transition: -> ${state}`);
    });
    // Active High-Frequency 10ms Vectorized Multi-Asset Strategy Engine Tick Loop
    let tickCounter = 0;
    const strategyInterval = setInterval(() => {
        try {
            tickCounter++;
            const batch = multiEngine.evaluateAllTicks();
            // Active Model Drift Evaluation & Self-Healing Trigger (SAB Slot 101 & 102)
            let rollingIc = client.getRollingIC();
            let isDrifted = client.getIsModelDrifted();
            let sampleCount = 0;
            if (nativeModule && typeof nativeModule.getIcStatus === "function") {
                try {
                    const rawJson = nativeModule.getIcStatus();
                    const parsed = JSON.parse(rawJson);
                    if (parsed && typeof parsed.ic === "number" && Number.isFinite(parsed.ic)) {
                        rollingIc = parsed.ic;
                    }
                    if (parsed && typeof parsed.is_drifted === "boolean") {
                        isDrifted = parsed.is_drifted;
                    }
                    if (parsed && typeof parsed.sample_count === "number" && Number.isFinite(parsed.sample_count)) {
                        sampleCount = parsed.sample_count;
                    }
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[TUI] Native IC status JSON parse notice: ${msg}`);
                }
            }
            // Physical Hard Gate: Clamp drift to false during warm-up period (< 1000 pairs)
            if (sampleCount < 1000) {
                isDrifted = false;
            }
            const seqNum = client.getSequenceNum(0);
            if (riskGuard.isProfitLockedState()) {
                recalibrationManager.enableShadowMode();
                if (sampleCount >= 1000) {
                    recalibrationManager.evaluateShadowTick(seqNum, rollingIc);
                }
            }
            else {
                recalibrationManager.evaluateTickDrift(rollingIc, isDrifted);
            }
            // Check scheduled offline T-KAN initialization (throttled to once every 1000 ticks / ~10s and gated by 1000-pair warm-up)
            if (tickCounter % 1000 === 0 && sampleCount >= 1000) {
                recalibrationManager.checkAndRunScheduledTkan()
                    .then((executed) => {
                    if (executed) {
                        dashboard.pushNotification("✅ [T-KAN_SCHEDULER] Periodic T-KAN spatial initialization completed & hot-swapped.");
                    }
                })
                    .catch((err) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    dashboard.pushNotification(`⚠️ [T-KAN_SCHEDULER_ERROR] ${msg}`);
                });
            }
            for (const [symbol, result] of batch.results.entries()) {
                if (result.signalType !== "NONE") {
                    dashboard.pushNotification(`[STRATEGY_SIGNAL] ${result.signalType} | Sym: ${symbol} | Seq #${result.sequenceNum} | Bid: $${result.bidPrice.toFixed(2)} / Ask: $${result.askPrice.toFixed(2)}`);
                    if (result.riskResult && !result.riskResult.passed) {
                        dashboard.pushNotification(`[RISK_BLOCK] ${symbol} ${result.signalType} Blocked: [${result.riskResult.reasonCode}] ${result.riskResult.message}`);
                    }
                    if (result.executionPromise) {
                        result.executionPromise
                            .then((res) => {
                            if (res && res.orderId) {
                                const rawQty = parseFloat(res.executedQty || "0") > 0 ? res.executedQty : (res.origQty || "0");
                                const avgPx = parseFloat(res.avgPrice || "0");
                                const px = parseFloat(res.price || "0");
                                const cumQuote = parseFloat(res.cumQuote || "0");
                                const qtyNum = parseFloat(rawQty);
                                const displayPrice = avgPx > 0 ? avgPx : (px > 0 ? px : (cumQuote > 0 && qtyNum > 0 ? cumQuote / qtyNum : (result.bidPrice || result.askPrice)));
                                const priceDecimals = symbolPrecision_1.SymbolPrecisionRegistry.getPrecisionRule(res.symbol).priceDecimals;
                                const isFilled = res.status === "FILLED" || parseFloat(res.executedQty || "0") > 0;
                                if (isFilled) {
                                    dashboard.pushNotification(`[ORDER_FILLED] ${res.side} ${res.symbol} | OrderID #${res.orderId} | Qty: ${rawQty} @ $${displayPrice.toFixed(priceDecimals)}`);
                                }
                                else {
                                    dashboard.pushNotification(`[ORDER_SUBMITTED] ${res.side} ${res.symbol} | OrderID #${res.orderId} | Qty: ${rawQty} @ $${displayPrice.toFixed(priceDecimals)} (${res.timeInForce || "POST_ONLY"})`);
                                }
                            }
                        })
                            .catch((err) => {
                            const errorMsg = err instanceof Error ? err.message : String(err);
                            let userAlert = `[EXECUTION_ERROR] ${symbol} ${result.signalType} Failed: ${errorMsg}`;
                            if (errorMsg.includes("-4059") || errorMsg.includes("position side")) {
                                userAlert = `⛔ [CRITICAL_API_ALERT] Error -4059: HEDGE MODE REQUIRED! Go to Binance Futures -> Preferences -> Position Mode -> Enable "Hedge Mode".`;
                            }
                            else if (errorMsg.includes("-1013") || errorMsg.includes("MIN_NOTIONAL") || errorMsg.includes("Filter failure")) {
                                userAlert = `⛔ [CRITICAL_API_ALERT] Error -1013: MIN NOTIONAL TOO LOW! Order value is below $55 USDT minimum notional threshold.`;
                            }
                            else if (errorMsg.includes("-2019") || errorMsg.includes("Margin is insufficient")) {
                                userAlert = `⛔ [CRITICAL_API_ALERT] Error -2019: INSUFFICIENT MARGIN! Account balance is too low for this order size.`;
                            }
                            else if (errorMsg.includes("-2015") || errorMsg.includes("Invalid API-key")) {
                                userAlert = `⛔ [CRITICAL_API_ALERT] Error -2015: INVALID API KEY / PERMISSIONS! Verify API Key and enable Futures Trading in Binance.`;
                            }
                            else if (errorMsg.includes("-1021") || errorMsg.includes("Timestamp")) {
                                userAlert = `⛔ [CRITICAL_API_ALERT] Error -1021: SYSTEM CLOCK DESYNC! Local machine time is out of sync with Binance server time.`;
                            }
                            dashboard.pushNotification(userAlert);
                        });
                    }
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            dashboard.pushNotification(`⚠️ [STRATEGY_TICK_ERROR] ${msg}`);
        }
    }, 10);
    // Active double-buffered ANSI refresh loop (~6.6 Hz / 150ms interval)
    const renderInterval = setInterval(() => {
        if (binanceClient.isConfigured()) {
            client.setAvailableBalance(binanceClient.getUsdtAvailableBalance());
        }
        dashboard.render();
    }, 150);
    // Clean signal handling & terminal teardown
    let isShuttingDown = false;
    const handleShutdown = (signal) => {
        if (isShuttingDown)
            return;
        isShuttingDown = true;
        multiEngine.stopContinuousReconciliation();
        binanceClient.stopBalancePolling();
        clearInterval(strategyInterval);
        clearInterval(renderInterval);
        keyEngine.stop();
        dashboard.clear();
        process.stdout.write(`\n[BATBOT_V11] System shutdown cleanly via signal ${signal}.\n`);
        process.exit(0);
    };
    keyEngine.setExitCallback(() => {
        handleShutdown("KEYBOARD_QUIT");
    });
    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
}
if (require.main === module) {
    runProductionTuiLauncher().catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`❌ Critical error launching BATBOT_V11 TUI Command Center: ${errorMsg}`);
        process.exit(1);
    });
}
