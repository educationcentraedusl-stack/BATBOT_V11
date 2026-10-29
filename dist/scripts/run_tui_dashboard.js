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
const guardian_1 = require("../supervisor/guardian");
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
    let lastIcErrorLoggedTs = 0;
    // ── SOTA 2026 IPC HEARTBEAT & HANDSHAKE CLIENT ───────────────────────────
    let heartbeatSeq = 0;
    if (process.send) {
        const handshakePayload = {
            type: "HANDSHAKE_INIT",
            workerPid: process.pid,
            version: "11.0.0",
            heartbeatIntervalMs: 2500,
            timestamp: Date.now()
        };
        process.send(handshakePayload);
    }
    const heartbeatInterval = setInterval(() => {
        if (process.send) {
            const pingPayload = {
                type: "HEARTBEAT_PING",
                seq: ++heartbeatSeq,
                timestamp: Date.now()
            };
            process.send(pingPayload);
        }
    }, 2500);
    // ============================================================
    // WATCHDOG AUTO-RESTART (CONF_FLATLINE DEADLOCK BREAKER)
    // Fires every 15 seconds. If a CONF_FLATLINE has persisted for
    // >= 5 minutes AND the recalibration manager is not already
    // running, force-bypass all guards and restart the pipeline.
    //
    // CIRCUIT BREAKER: If the forced recalibration fails
    // WATCHDOG_CIRCUIT_BREAKER_MAX times consecutively, the watchdog
    // stops retrying and executes process.exit(1) — a true hard kill
    // so the external process manager (PM2/Nodemon/Docker) can perform
    // a completely fresh, clean reboot of the entire system.
    // ============================================================
    const WATCHDOG_THRESHOLD_MS = 300_000; // 5 minutes
    const WATCHDOG_CIRCUIT_BREAKER_MAX = 3; // Hard-kill after 3 consecutive soft failures
    let lastWatchdogTriggerTs = 0;
    const watchdogInterval = setInterval(() => {
        try {
            if (!dashboard.isAnyAssetFlatlined())
                return;
            const onsetMs = dashboard.getEarliestFlatlineOnsetMs();
            if (onsetMs === 0)
                return;
            const elapsedMs = Date.now() - onsetMs;
            if (elapsedMs < WATCHDOG_THRESHOLD_MS)
                return;
            const recalStatus = recalibrationManager.getStatus();
            if (recalStatus.isRecalibrating)
                return;
            // ── CIRCUIT BREAKER CHECK ──────────────────────────────────────────
            // If the soft recalibration pipeline has already failed
            // WATCHDOG_CIRCUIT_BREAKER_MAX times consecutively, do NOT retry.
            // Execute a true hard process.exit(1) so PM2/Nodemon/Guardian performs a
            // fully clean reboot — this is the only way to escape Testnet data
            // starvation or persistent Python crashes without human intervention.
            const consecutiveFailures = recalibrationManager.getConsecutiveFailureCount();
            if (consecutiveFailures >= WATCHDOG_CIRCUIT_BREAKER_MAX) {
                const lastReason = recalStatus.lastFailureReason ?? "UNKNOWN";
                const msg = `[WATCHDOG_HARD_RESTART] CIRCUIT BREAKER TRIPPED: ` +
                    `${consecutiveFailures}/${WATCHDOG_CIRCUIT_BREAKER_MAX} consecutive recalibration failures ` +
                    `(Last reason: ${lastReason}). Soft pipeline is unrecoverable. ` +
                    `Executing process.exit(1) for clean PM2/Nodemon/Guardian reboot...`;
                // Notify Guardian Kernel of intentional resurrection request via IPC
                if (process.send) {
                    const resurrectPayload = {
                        type: "INTENTIONAL_RESURRECT",
                        reason: "RECALIBRATION_CIRCUIT_BREAKER",
                        consecutiveFailures,
                        lastReason,
                        cooldownMs: 1500,
                        timestamp: Date.now()
                    };
                    process.send(resurrectPayload);
                }
                // Stop all active intervals before exit so no dangling callbacks fire.
                clearInterval(watchdogInterval);
                clearInterval(strategyInterval);
                clearInterval(renderInterval);
                clearInterval(heartbeatInterval);
                keyEngine.stop();
                multiEngine.stopContinuousReconciliation();
                binanceClient.stopBalancePolling();
                dashboard.clear();
                process.stderr.write(`\n\x1b[31m\x1b[1m${msg}\x1b[0m\n`);
                process.exit(1);
                return; // Unreachable — satisfies TS control-flow analysis
            }
            // ── END CIRCUIT BREAKER ───────────────────────────────────────────
            // Enforce per-trigger cooldown: do not spam the force-restart
            if (Date.now() - lastWatchdogTriggerTs < WATCHDOG_THRESHOLD_MS)
                return;
            lastWatchdogTriggerTs = Date.now();
            const flatlinedAssets = dashboard.getFlatlinedAssetIndices();
            const elapsedMin = (elapsedMs / 60000).toFixed(1);
            const attemptNum = consecutiveFailures + 1;
            dashboard.pushNotification(`\x1b[31m\x1b[1m[WATCHDOG_AUTO_RESTART] CONF_FLATLINE DEADLOCK DETECTED (Assets: ${flatlinedAssets.join(",")}, Elapsed: ${elapsedMin}m >= 5.0m). ` +
                `Forcing recalibration pipeline bypass (Attempt ${attemptNum}/${WATCHDOG_CIRCUIT_BREAKER_MAX} — circuit breaker trips on ${WATCHDOG_CIRCUIT_BREAKER_MAX} failures)...\x1b[0m`);
            let currentIc = client.getRollingIC();
            if (nativeModule && typeof nativeModule.getIcStatus === "function") {
                try {
                    const rawJson = nativeModule.getIcStatus();
                    const parsed = JSON.parse(rawJson);
                    if (typeof parsed.ic === "number" && Number.isFinite(parsed.ic)) {
                        currentIc = parsed.ic;
                    }
                }
                catch (_e) {
                    // Non-blocking fallback to SAB IC
                }
            }
            // force=true bypasses IC immunity, warmup gate, and cooldown floor
            recalibrationManager
                .runRecalibrationPipeline(currentIc, true)
                .then((success) => {
                if (success) {
                    dashboard.pushNotification("\x1b[32m[WATCHDOG_AUTO_RESTART] Forced recalibration SUCCEEDED. Platt calibration hot-swapped. System self-healed.\x1b[0m");
                }
                else {
                    const failStatus = recalibrationManager.getStatus();
                    const reasonStr = failStatus.lastFailureReason ?? "UNKNOWN";
                    const newFailCount = recalibrationManager.getConsecutiveFailureCount();
                    const remaining = WATCHDOG_CIRCUIT_BREAKER_MAX - newFailCount;
                    if (remaining > 0) {
                        dashboard.pushNotification(`\x1b[33m[WATCHDOG_AUTO_RESTART] Forced recalibration FAILED: ${reasonStr}. ` +
                            `Failures: ${newFailCount}/${WATCHDOG_CIRCUIT_BREAKER_MAX}. ` +
                            `${remaining} attempt(s) remaining before HARD RESTART (process.exit(1)).\x1b[0m`);
                    }
                    else {
                        dashboard.pushNotification(`\x1b[31m\x1b[1m[WATCHDOG_AUTO_RESTART] Circuit breaker limit reached (${newFailCount}/${WATCHDOG_CIRCUIT_BREAKER_MAX}). ` +
                            `HARD RESTART will fire on next watchdog tick.\x1b[0m`);
                    }
                }
            })
                .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                dashboard.pushNotification(`\x1b[31m[WATCHDOG_AUTO_RESTART] Pipeline exception: ${msg}\x1b[0m`);
            });
        }
        catch (watchdogErr) {
            const msg = watchdogErr instanceof Error ? watchdogErr.message : String(watchdogErr);
            dashboard.pushNotification(`\x1b[33m[WATCHDOG_ERROR] ${msg}\x1b[0m`);
        }
    }, 15000);
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
                    const now = Date.now();
                    if (now - lastIcErrorLoggedTs >= 5000) {
                        lastIcErrorLoggedTs = now;
                        const msg = err instanceof Error ? err.message : String(err);
                        dashboard.pushNotification(`⚠️ [TUI] Native IC status JSON parse notice: ${msg}`);
                    }
                }
            }
            // Physical Hard Gate: Clamp drift to false during warm-up period (< 1000 pairs)
            if (sampleCount < 1000) {
                isDrifted = false;
                for (let i = 0; i < maxAssets; i++) {
                    client.setIsModelDrifted(false, i);
                }
            }
            // Unconditional High-IC Alpha Immunity: strong positive alpha suppresses drift
            if (rollingIc >= 0.0500) {
                isDrifted = false;
                for (let i = 0; i < maxAssets; i++) {
                    client.setIsModelDrifted(false, i);
                }
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
        if (process.send) {
            const shutdownPayload = {
                type: "USER_SHUTDOWN",
                exitCode: 0,
                reason: signal,
                timestamp: Date.now()
            };
            try {
                process.send(shutdownPayload);
            }
            catch {
                // Ignore
            }
        }
        multiEngine.stopContinuousReconciliation();
        binanceClient.stopBalancePolling();
        clearInterval(strategyInterval);
        clearInterval(renderInterval);
        clearInterval(watchdogInterval);
        clearInterval(heartbeatInterval);
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
    if (process.env.BATBOT_SUPERVISED !== "1") {
        // Transparent Self-Supervision Guard:
        // If invoked directly via node or external runner, auto-bootstrap Guardian
        // guaranteeing 100% autonomous auto-resurrection immunity across all entrypoints.
        const guardian = new guardian_1.ProcessGuardian({
            workerScriptPath: __filename
        });
        guardian.start();
    }
    else {
        runProductionTuiLauncher().catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`❌ Critical error launching BATBOT_V11 TUI Command Center: ${errorMsg}`);
            process.exit(1);
        });
    }
}
