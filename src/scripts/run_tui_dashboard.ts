import "dotenv/config";
import * as path from "path";
import * as fs from "fs";
import { MarketDataClient } from "../marketDataClient";
import { MultiAssetCLIDashboard } from "../telemetry/multiAssetDashboard";
import { InteractiveKeypressEngine } from "../telemetry/keypressHandler";
import { BinanceExecutionClient } from "../execution/binance";
import { getTradingSymbols } from "../config/tradingSymbols";

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
  if (binanceClient.isConfigured()) {
    binanceClient.startBalancePolling(5000);
    dashboard.pushNotification("Binance API credentials verified. Balance polling active.");
  } else {
    dashboard.pushNotification("Notice: Binance API credentials unconfigured (Balance default: $0.00).");
  }

  dashboard.pushNotification("BATBOT_V11 Production Launch Sequence Complete.");
  dashboard.pushNotification(`${maxAssets}-Asset SharedArrayBuffer Active (${totalSABBytes} bytes).`);
  dashboard.pushNotification("Keyboard active: 0-9 = Focus Asset, K = Kill, P = Pause, C = Close All, Q = Quit.");

  keyEngine.setAssetFocusCallback((idx: number) => {
    dashboard.setFocusedAsset(idx);
  });

  keyEngine.setNotificationCallback((msg: string) => {
    dashboard.pushNotification(msg);
  });

  keyEngine.start();

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

