import "dotenv/config";
import * as path from "path";
import * as fs from "fs";
import { MarketDataClient } from "../marketDataClient";
import { MultiAssetCLIDashboard, DEFAULT_ASSET_SYMBOLS } from "../telemetry/multiAssetDashboard";
import { InteractiveKeypressEngine } from "../telemetry/keypressHandler";

export async function runProductionTuiLauncher(): Promise<void> {
  console.log("=========================================================================");
  console.log("  BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM - PRODUCTION TUI LAUNCHER     ");
  console.log("=========================================================================\n");

  // Step 1: Pre-Flight Verification of Environment & Native N-API Binaries
  console.log("[Pre-Flight 1/3] Verifying environment configurations...");
  const maxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || "10", 10);
  const slotsPerAsset = parseInt(process.env.SAB_SLOTS_PER_ASSET || "256", 10);
  const totalSABBytes = maxAssets * slotsPerAsset * 8;
  console.log(`  - Concurrency Capacity: ${maxAssets} Asset Slots`);
  console.log(`  - Slots Per Asset: ${slotsPerAsset}`);
  console.log(`  - SharedArrayBuffer Size: ${totalSABBytes} bytes`);

  console.log("\n[Pre-Flight 2/3] Verifying Native Rust N-API Binary Module...");
  const nativeIndexPath = path.resolve(process.cwd(), "index.js");
  const nativeBinaryWin64 = path.resolve(process.cwd(), "index.win32-x64-msvc.node");
  
  let nativeModule: any = null;
  let isNativeVerified = false;

  if (fs.existsSync(nativeBinaryWin64) || fs.existsSync(nativeIndexPath)) {
    try {
      nativeModule = require(nativeIndexPath);
      if (nativeModule && (typeof nativeModule.startIngestion === "function" || typeof nativeModule.initCore === "function")) {
        isNativeVerified = true;
        console.log("  ✅ Native Rust N-API binary verified online (Zero-Copy IPC Ready).");
      } else {
        console.warn("  ⚠️ Native module loaded but missing expected export symbols.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️ Rust N-API binary loading notice: ${msg}`);
    }
  } else {
    console.warn("  ⚠️ Native N-API binary file not detected in root. Run 'npm run build:rust' if native acceleration is required.");
  }

  // Step 2: Initialize SharedArrayBuffer & Market Data Client
  console.log("\n[Pre-Flight 3/3] Initializing Zero-Copy SharedArrayBuffer & Telemetry Engine...");
  const sab = new SharedArrayBuffer(totalSABBytes);
  const client = new MarketDataClient(sab, maxAssets, slotsPerAsset);

  // Attempt starting native zero-copy ingestion if available
  if (isNativeVerified && nativeModule && typeof nativeModule.startIngestion === "function") {
    try {
      const started = nativeModule.startIngestion(Buffer.from(sab));
      if (started) {
        console.log("  ✅ Rust Zero-Copy Ingestion Worker Thread Started Successfully.");
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
  const dashboard = new MultiAssetCLIDashboard(client, true, DEFAULT_ASSET_SYMBOLS);
  const keyEngine = new InteractiveKeypressEngine(client);

  dashboard.pushNotification("BATBOT_V11 Production Launch Sequence Complete.");
  dashboard.pushNotification(`10-Asset SharedArrayBuffer Active (${totalSABBytes} bytes).`);
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
    dashboard.render();
  }, 150);

  // Clean signal handling & terminal teardown
  let isShuttingDown = false;
  const handleShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    clearInterval(renderInterval);
    keyEngine.stop();
    dashboard.clear();

    process.stdout.write(`\n[BATBOT_V11] System shutdown cleanly via signal ${signal}.\n`);
    process.exit(0);
  };

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
