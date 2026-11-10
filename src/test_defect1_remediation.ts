import { MarketDataClient } from "./marketDataClient";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient, BinanceOrderResponse } from "./execution/binance";
import { StrategyEngine } from "./strategy/engine";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function runDefect1Test() {
  console.log("=================================================");
  console.log("DEFECT 1 REMEDIATION VERIFICATION SUITE");
  console.log("Testing Unhandled Promise Rejection Hazard...");
  console.log("=================================================");

  const sab = new SharedArrayBuffer(1024 * 1024);
  const client = new MarketDataClient(sab);

  // Write market data & AI prediction metrics to SAB via MarketDataClient
  client.writeAtomicFloat64Asset(0, 1, 0.85);    // OBI
  client.writeAtomicFloat64Asset(0, 2, 1000.0);  // CVD
  client.writeAtomicFloat64Asset(0, 3, 0.1);     // Spread Velocity
  client.writeAtomicFloat64Asset(0, 4, 60000.0); // Best Bid Price
  client.writeAtomicFloat64Asset(0, 6, 60000.1); // Best Ask Price
  client.writeAtomicFloat64Asset(0, 93, 1.0);    // AI Direction BUY (+1.0)
  client.writeAtomicFloat64Asset(0, 94, 0.95);   // AI Confidence (95%)

  const riskGuard = new RiskGuard();
  const executionClient = new BinanceExecutionClient({
    apiKey: "dummy_key",
    apiSecret: "dummy_secret",
  });

  // Mock placeOrder to simulate a severe Binance REST API network failure / timeout
  executionClient.placeOrder = () =>
    Promise.reject(
      new Error("SIMULATED_BINANCE_API_NETWORK_TIMEOUT (-1001: Internal error; unable to process request)")
    );

  const engine = new StrategyEngine(client, riskGuard, executionClient, {
    symbol: "BTCUSDT",
    tradeSizeUsdt: 60,
    minNotionalUsdt: 5,
  });

  try {
    console.log("\n[STEP 1] Evaluating tick to trigger entry order signal under API failure simulation...");
    const signalResult = engine.evaluateTick();

    if (signalResult.signalType !== "BUY") {
      throw new Error(`FAIL: Expected BUY signal, got ${signalResult.signalType}`);
    }

    if (!signalResult.executionPromise) {
      throw new Error("FAIL: Execution promise was not created.");
    }

    console.log("  ✓ Signal triggered: BUY order submitted to placeOrder.");
    console.log("  ✓ executionPromise generated. Awaiting resolution...");

    // Await the executionPromise. It should resolve to null (handled error) without throwing an exception!
    let res: BinanceOrderResponse | null | undefined = undefined;
    let uncaughtError: unknown = null;

    try {
      res = await signalResult.executionPromise;
    } catch (err: unknown) {
      uncaughtError = err;
    }

    if (uncaughtError !== null) {
      console.error("  ❌ FAIL: Execution promise threw an uncaught error!", uncaughtError);
      process.exit(1);
    }

    if (res !== null) {
      console.error(`  ❌ FAIL: Expected executionPromise to resolve to null, but got:`, res);
      process.exit(1);
    }

    console.log("  ✓ executionPromise resolved to null gracefully without throwing an exception.");

    // Verify that isOrderInFlight is reset to false
    const engineView: unknown = engine;
    const inFlight: unknown = isObjectRecord(engineView) ? engineView["isOrderInFlight"] : undefined;
    if (inFlight !== false) {
      console.error(`  ❌ FAIL: Expected isOrderInFlight to be false, got ${String(inFlight)}`);
      process.exit(1);
    }
    console.log("  ✓ Engine state 'isOrderInFlight' successfully reset to false in finally block.");

    console.log("\n=================================================");
    console.log("✅ DEFECT 1 VERIFICATION SUCCESSFUL:");
    console.log("Node.js process survived severe API rejection cleanly without UnhandledPromiseRejection!");
    console.log("=================================================");
  } finally {
    engine.destroy();
  }
}

runDefect1Test().catch((err: unknown) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
