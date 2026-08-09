import "dotenv/config";
import * as path from "path";
import * as fs from "fs";
import { MarketDataClient } from "../marketDataClient";
import { MultiAssetCLIDashboard } from "../telemetry/multiAssetDashboard";
import { InteractiveKeypressEngine } from "../telemetry/keypressHandler";
import { BinanceExecutionClient } from "../execution/binance";
import { getTradingSymbols } from "../config/tradingSymbols";
import { StrategyEngine } from "../strategy/engine";
import { RiskGuard } from "../strategy/risk";
import { syncStateOnStartup } from "../index";

export interface NativeIngestionModule {
  startIngestion?: (sabBuffer: Buffer, symbols?: string[]) => boolean;
  initCore?: (symbol: string, balance: number) => boolean;
  [key: string]: unknown;
}

export async function runProductionTuiLauncher(): Promise<void> {
  console.log("=========================================================================");
  console.log("  BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM - PRODUCTION TUI LAUNCHER     ");
  console.log("=========================================================================\n");

  // Step 1: Pre-Flight Verification of Environment & Native N-API Binaries
  console.log("[Pre-Flight 1/3] Verifying environment configurations...");
  const activeSymbols = getTradingSymbols();
  const parsedMaxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || String(activeSymbols.length), 10);
  const maxAssets = Math.max(
    activeSymbols.length,
    Number.isFinite(parsedMaxAssets) && parsedMaxAssets > 0 ? parsedMaxAssets : activeSymbols.length
  );

  const parsedSlotsPerAsset = parseInt(process.env.SAB_SLOTS_PER_ASSET || "256", 10);
  const slotsPerAsset = Number.isFinite(parsedSlotsPerAsset) && parsedSlotsPerAsset > 0 ? parsedSlotsPerAsset : 256;

  const totalSABBytes = maxAssets * slotsPerAsset * 8;
  console.log(`  - Active Trading Symbols (${activeSymbols.length}): ${activeSymbols.join(", ")}`);
  console.log(`  - Concurrency Capacity: ${maxAssets} Asset Slots`);
  console.log(`  - Slots Per Asset: ${slotsPerAsset}`);
  console.log(`  - SharedArrayBuffer Size: ${totalSABBytes} bytes`);


  console.log("\n[Pre-Flight 2/3] Verifying Native Rust N-API Binary Module...");
  let platformBinary: string;
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

  let nativeModule: NativeIngestionModule | null = null;
  let isNativeVerified = false;

  if (fs.existsSync(nativeIndexPath)) {
    try {
      nativeModule = require(nativeIndexPath) as NativeIngestionModule;
      if (
        nativeModule &&
        (typeof nativeModule.startIngestion === "function" || typeof nativeModule.initCore === "function")
      ) {
        isNativeVerified = true;
        console.log(`  ✅ Native Rust N-API binary verified online (Zero-Copy IPC Ready: ${platformBinary}).`);
      } else {
        console.warn("  ⚠️ Native module loaded but missing expected export symbols.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️ Rust N-API binary loading notice: ${msg}`);
    }
  } else if (fs.existsSync(nativeBinaryPath)) {
    console.warn(`  ⚠️ Platform binary '${platformBinary}' detected but root 'index.js' binding entry is missing. Run 'npm run build:rust' to generate binding exports.`);
  } else {
    console.warn(`  ⚠️ Native N-API binary file ('${platformBinary}') not detected in root. Run 'npm run build:rust' if native acceleration is required.`);
  }

  // Step 2: Initialize SharedArrayBuffer & Market Data Client
  console.log("\n[Pre-Flight 3/3] Initializing Zero-Copy SharedArrayBuffer & Telemetry Engine...");
  const sab = new SharedArrayBuffer(totalSABBytes);
  const client = new MarketDataClient(sab, maxAssets, slotsPerAsset);

  // Attempt starting native zero-copy ingestion if available
  if (isNativeVerified && nativeModule && typeof nativeModule.startIngestion === "function") {
    try {
      const started = nativeModule.startIngestion(Buffer.from(sab), activeSymbols);
      if (started) {
        console.log(`  ✅ Rust Zero-Copy Multi-Asset Ingestion Workers Started (${activeSymbols.length} Coins Streaming).`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️ Notice starting Rust ingestion worker: ${msg}`);
    }
  }

  console.log("  ✅ Zero-Copy SharedArrayBuffer Memory Layout Verified.");
  console.log("\n🚀 All Pre-Flight Checks Complete! Launching Multi-Asset TUI Command Center...\n");

  // Wait 1 second so pre-flight messages are readable before clearing terminal screen
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Step 3: Launch Multi-Asset TUI Dashboard & Keypress Control Engine
  const dashboard = new MultiAssetCLIDashboard(client, true, activeSymbols);

  const keyEngine = new InteractiveKeypressEngine(client);

  const binanceClient = new BinanceExecutionClient();
  const riskGuard = new RiskGuard();
  const primarySymbol = process.env.SYMBOL ?? activeSymbols[0] ?? "BTCUSDT";
  const strategyEngine = new StrategyEngine(client, riskGuard, binanceClient, { symbol: primarySymbol });

  if (binanceClient.isConfigured()) {
    binanceClient.startBalancePolling(5000);
    dashboard.pushNotification("✅ Binance API credentials verified. Balance polling active.");
    syncStateOnStartup(binanceClient, strategyEngine, riskGuard)
      .then(() => {
        dashboard.pushNotification(`✅ State synchronized with Binance API for ${primarySymbol}.`);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        dashboard.pushNotification(`⚠️ [StateSync Notice] ${msg}`);
      });
  } else {
    dashboard.pushNotification("⛔ [CRITICAL_WARNING] BINANCE API KEYS MISSING IN .env! TRADING IN SHADOW MODE ONLY.");
    dashboard.pushNotification("⛔ [CRITICAL_WARNING] Set BINANCE_API_KEY and BINANCE_API_SECRET in .env to enable live execution.");
  }

  dashboard.pushNotification("BATBOT_V11 Production Launch Sequence Complete.");
  dashboard.pushNotification(`${maxAssets}-Asset SharedArrayBuffer Active (${totalSABBytes} bytes).`);
  dashboard.pushNotification(`Strategy Engine Live on ${primarySymbol} (10ms High-Frequency Signal Loop).`);
  dashboard.pushNotification("Keyboard active: 0-9 = Focus Asset, K = Kill, P = Pause, C = Close All, Q = Quit.");

  keyEngine.setAssetFocusCallback((idx: number) => {
    dashboard.setFocusedAsset(idx);
  });

  keyEngine.setNotificationCallback((msg: string) => {
    dashboard.pushNotification(msg);
  });

  keyEngine.start();

  // Active High-Frequency 10ms Strategy Engine Tick Evaluation Loop
  const strategyInterval = setInterval(() => {
    try {
      const result = strategyEngine.evaluateTick();
      if (result.signalType !== "NONE") {
        dashboard.pushNotification(
          `[STRATEGY_SIGNAL] ${result.signalType} | Sym: ${primarySymbol} | Seq #${result.sequenceNum} | Bid: $${result.bidPrice.toFixed(2)} / Ask: $${result.askPrice.toFixed(2)}`
        );

        if (result.riskResult && !result.riskResult.passed) {
          dashboard.pushNotification(
            `[RISK_BLOCK] ${primarySymbol} ${result.signalType} Blocked: [${result.riskResult.reasonCode}] ${result.riskResult.message}`
          );
        }

        if (result.executionPromise) {
          result.executionPromise
            .then((res) => {
              if (res && res.orderId) {
                dashboard.pushNotification(
                  `[ORDER_FILLED] ${res.side} ${res.symbol} | OrderID #${res.orderId} | Qty: ${res.executedQty} @ $${res.avgPrice || res.price}`
                );
              }
            })
            .catch((err: unknown) => {
              const errorMsg = err instanceof Error ? err.message : String(err);
              let userAlert = `[EXECUTION_ERROR] ${primarySymbol} ${result.signalType} Failed: ${errorMsg}`;

              if (errorMsg.includes("-4059") || errorMsg.includes("position side")) {
                userAlert = `⛔ [CRITICAL_API_ALERT] Error -4059: HEDGE MODE REQUIRED! Go to Binance Futures -> Preferences -> Position Mode -> Enable "Hedge Mode".`;
              } else if (errorMsg.includes("-1013") || errorMsg.includes("MIN_NOTIONAL") || errorMsg.includes("Filter failure")) {
                userAlert = `⛔ [CRITICAL_API_ALERT] Error -1013: MIN NOTIONAL TOO LOW! Order value is below $55 USDT minimum notional threshold.`;
              } else if (errorMsg.includes("-2019") || errorMsg.includes("Margin is insufficient")) {
                userAlert = `⛔ [CRITICAL_API_ALERT] Error -2019: INSUFFICIENT MARGIN! Account balance is too low for this order size.`;
              } else if (errorMsg.includes("-2015") || errorMsg.includes("Invalid API-key")) {
                userAlert = `⛔ [CRITICAL_API_ALERT] Error -2015: INVALID API KEY / PERMISSIONS! Verify API Key and enable Futures Trading in Binance.`;
              } else if (errorMsg.includes("-1021") || errorMsg.includes("Timestamp")) {
                userAlert = `⛔ [CRITICAL_API_ALERT] Error -1021: SYSTEM CLOCK DESYNC! Local machine time is out of sync with Binance server time.`;
              }

              dashboard.pushNotification(userAlert);
            });
        }
      }
    } catch (err: unknown) {
      // Non-blocking tick error handling
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
  const handleShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

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
  runProductionTuiLauncher().catch((err: unknown) => {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Critical error launching BATBOT_V11 TUI Command Center: ${errorMsg}`);
    process.exit(1);
  });
}

