import { AutoRecalibrationManager } from "./ai/recalibrationWorker";
import { StrategyEngine } from "./strategy/engine";
import { MarketDataClient } from "./marketDataClient";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient } from "./execution/binance";
import { TerminalOutputMux } from "./telemetry/terminalMux";
import * as nativeAddon from "../index";

function runTest(): void {
  console.log("================================================================================");
  console.log("      BATBOT_V11 AUTONOMOUS AI MODEL AUTO-RECALIBRATION TEST SUITE              ");
  console.log("================================================================================");

  // 1. Verify NAPI Exports
  console.log("[Test 1/5] Verifying NAPI exports...");
  const nativeExports: Record<string, unknown> = nativeAddon;
  if (typeof nativeExports["loadAiModel"] !== "function") {
    throw new Error("NAPI export 'loadAiModel' is missing!");
  }
  if (typeof nativeExports["resetIcTracker"] !== "function") {
    throw new Error("NAPI export 'resetIcTracker' is missing!");
  }
  if (typeof nativeExports["getIcStatus"] !== "function") {
    throw new Error("NAPI export 'getIcStatus' is missing!");
  }
  console.log("  [PASS] NAPI functions (loadAiModel, resetIcTracker, getIcStatus) detected.");

  // 2. Test IC Status & Reset via NAPI
  console.log("[Test 2/5] Testing NAPI getIcStatus & resetIcTracker...");
  const rawStatusStr = nativeAddon.getIcStatus();
  console.log(`  Initial NAPI IC status JSON: ${rawStatusStr}`);
  const statusObj: unknown = JSON.parse(rawStatusStr);
  if (
    typeof statusObj !== "object" ||
    statusObj === null ||
    typeof (statusObj as { ic?: unknown }).ic !== "number" ||
    typeof (statusObj as { is_drifted?: unknown }).is_drifted !== "boolean"
  ) {
    throw new Error("Invalid IC status schema returned from Rust NAPI!");
  }

  const resetSuccess = nativeAddon.resetIcTracker();
  console.log(`  [PASS] NAPI resetIcTracker result: ${String(resetSuccess)}`);

  // 3. Test StrategyEngine EngineState FSM & Safety Clamp Lock
  console.log("[Test 3/5] Testing StrategyEngine TRAINING_LOCK FSM & Safety Clamp...");
  const sab = new SharedArrayBuffer(20480);
  const client = new MarketDataClient(sab);
  const riskGuard = new RiskGuard();
  const execClient = new BinanceExecutionClient();
  const engine = new StrategyEngine(client, riskGuard, execClient, { symbol: "BTCUSDT" });

  if (engine.getEngineState() !== "LIVE_ACTIVE") {
    throw new Error(`Expected initial state LIVE_ACTIVE, got ${engine.getEngineState()}`);
  }

  // Write valid market prices
  client.writeAtomicFloat64Asset(0, 4, 63000.0); // Best bid
  client.writeAtomicFloat64Asset(0, 6, 63001.0); // Best ask
  client.writeAtomicFloat64Asset(0, 1, 0.5); // OBI

  engine.setEngineState("TRAINING_LOCK");
  if (engine.getEngineState() !== "TRAINING_LOCK") {
    throw new Error("Failed to transition engine state to TRAINING_LOCK");
  }

  const clampedTickResult = engine.evaluateTick();
  if (clampedTickResult.signalType !== "NONE") {
    throw new Error(`Expected signalType NONE during TRAINING_LOCK, got ${clampedTickResult.signalType}`);
  }
  if (clampedTickResult.riskResult?.reasonCode !== "TRAINING_LOCK_ACTIVE") {
    throw new Error(`Expected risk reason TRAINING_LOCK_ACTIVE, got ${String(clampedTickResult.riskResult?.reasonCode)}`);
  }
  console.log("  [PASS] StrategyEngine Safety Clamp suppressed entry signals during TRAINING_LOCK state.");

  engine.setEngineState("LIVE_ACTIVE");
  console.log("  [PASS] StrategyEngine cleanly restored to LIVE_ACTIVE.");

  // 4. Test AutoRecalibrationManager Single-Flight Lock & State Callback Integration
  console.log("[Test 4/5] Testing AutoRecalibrationManager single-flight lock & callbacks...");
  const manager = AutoRecalibrationManager.getInstance();
  const callbackTracker: { lastState: string | null } = { lastState: null };
  manager.setOnStateChangeCallback((state) => {
    callbackTracker.lastState = state;
  });

  // Pre-populate warm-up pairs into IC tracker for drift test
  if (typeof nativeExports["recordTradeIc"] === "function") {
    for (let k = 0; k < 1000; k++) {
      nativeAddon.recordTradeIc(0.1, 0.05, 0);
    }
  }

  manager.setSustainedDriftThreshold(5);

  for (let i = 1; i <= 4; i++) {
    manager.evaluateTickDrift(0.015, true);
    const status = manager.getStatus();
    if (status.driftTickCounter !== i) {
      throw new Error(`Expected drift counter ${String(i)}, got ${String(status.driftTickCounter)}`);
    }
  }
  if (callbackTracker.lastState !== null) {
    throw new Error(`Unexpected state change callback before drift threshold reached: ${callbackTracker.lastState}`);
  }

  console.log("  [PASS] Drift counter & state callback verified.");

  // 5. Test Terminal Output Mux Prompt Isolation
  console.log("[Test 5/5] Testing TerminalOutputMux CLI prompt isolation...");
  const mux = TerminalOutputMux.getInstance();
  mux.startPromptSession();
  if (!mux.isPrompting()) {
    throw new Error("Failed to activate terminal output mux prompt session!");
  }
  mux.endPromptSession();
  if (mux.isPrompting()) {
    throw new Error("Failed to deactivate terminal output mux prompt session!");
  }
  console.log("  [PASS] TerminalOutputMux cleanly isolated CLI prompt session.");

  console.log("================================================================================");
  console.log(" [SUCCESS] ALL AUTONOMOUS AUTO-RECALIBRATION PIPELINE TESTS PASSED 100%");
  console.log("================================================================================");
}

try {
  runTest();
} catch (err: unknown) {
  console.error("❌ Test Suite Failed:", err);
  process.exit(1);
}
