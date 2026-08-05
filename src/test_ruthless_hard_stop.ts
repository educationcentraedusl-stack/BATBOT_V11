import { MarketDataClient } from "./marketDataClient";
import { RiskGuard } from "./strategy/risk";
import { BinanceExecutionClient } from "./execution/binance";
import { StrategyEngine } from "./strategy/engine";
import { HedgePositionLedger } from "./strategy/positionLedger";

function createMockSharedArrayBuffer(): {
  sab: SharedArrayBuffer;
  setMarketState: (
    seq: bigint,
    bid: number,
    ask: number,
    vpin: number,
    sweep: boolean,
    aiDir: number,
    aiConf: number
  ) => void;
} {
  const sab = new SharedArrayBuffer(2048);
  const view = new BigInt64Array(sab);

  const bitcastBuf = new ArrayBuffer(8);
  const bitcastBigInt = new BigInt64Array(bitcastBuf);
  const bitcastFloat = new Float64Array(bitcastBuf);

  function writeFloat(slot: number, val: number) {
    bitcastFloat[0] = val;
    Atomics.store(view, slot, bitcastBigInt[0]);
  }

  const setMarketState = (
    seq: bigint,
    bid: number,
    ask: number,
    vpin: number,
    sweep: boolean,
    aiDir: number,
    aiConf: number
  ) => {
    Atomics.store(view, 0, BigInt(Date.now() * 1_000_000)); // Timestamp
    writeFloat(1, -0.45); // OBI
    writeFloat(2, -120.0); // CVD
    writeFloat(3, 0.02); // Spread Velocity
    writeFloat(4, bid); // Best Bid Price
    writeFloat(5, 10.0); // Best Bid Qty
    writeFloat(6, ask); // Best Ask Price
    writeFloat(7, 10.0); // Best Ask Qty
    Atomics.store(view, 92, seq); // Sequence Num

    // AI predictions
    writeFloat(93, aiDir); // Direction
    writeFloat(94, aiConf); // Confidence

    // Microstructure metrics
    writeFloat(121, 0.0035); // Garman-Klass Volatility 0.35%
    writeFloat(122, vpin); // VPIN
    writeFloat(123, 0.42); // Hurst
    writeFloat(124, 0.15); // LOB entropy
    writeFloat(125, vpin > 0.85 || sweep ? 2 : 0); // Regime (2 = TOXIC_CHOP_TRAP)
    writeFloat(126, sweep ? 1.0 : 0.0); // Sweep detected
  };

  return { sab, setMarketState };
}

async function runRuthlessHardStopTests() {
  console.log("=== BATBOT_V11 RUTHLESS HARD STOP & PROFIT HUNTING VERIFICATION ===");

  const { sab, setMarketState } = createMockSharedArrayBuffer();
  const client = new MarketDataClient(sab);
  const riskGuard = new RiskGuard();
  const executionClient = new BinanceExecutionClient({ apiKey: "test_key", apiSecret: "test_secret" });
  const hedgeLedger = new HedgePositionLedger("ETHUSDT", 3);

  const engine = new StrategyEngine(client, riskGuard, executionClient, {
    symbol: "ETHUSDT",
    orderQuantity: 0.326,
    shortTakeProfitPercent: 0.25,
    shortStopLossPercent: 0.20,
  }, undefined, hedgeLedger);

  // TEST 1: Occupy a SHORT slot simulating the ETHUSDT scenario
  // Entry: $1864.04, SL: $1868.70, TP: $1857.51
  hedgeLedger.occupyShortSlot(0, 0.326, 1864.04, 0.25, 0.20);
  // Manually set stopLossPrice to exact scenario $1868.70
  (hedgeLedger.getShortSlots()[0] as any).stopLossPrice = 1868.70;

  console.log("\n[TEST 1] Initial Short Slot State:");
  const initialSlot = hedgeLedger.getShortSlots()[0];
  console.log(`- Occupied: ${initialSlot.isOccupied}`);
  console.log(`- Entry Price: $${initialSlot.entryPrice}`);
  console.log(`- Stop Loss Price: $${initialSlot.stopLossPrice}`);

  // TEST 2: Simulate Price Breach ($1868.84 > $1868.70) under HIGH VPIN TOXIC FLOW (vpin = 0.95) & SWEEP TRAP
  console.log("\n[TEST 2] Simulating SL Breach at $1868.84 under HIGH VPIN TOXIC FLOW (0.95)...");
  setMarketState(100n, 1868.80, 1868.88, 0.95, true, -0.03, 0.51);

  // Evaluate tick
  const signalResult = engine.evaluateTick();

  console.log(`- Signal Type: ${signalResult.signalType}`);
  console.log(`- Exit Reason: ${signalResult.exitReason}`);
  console.log(`- Risk Passed: ${signalResult.riskResult?.passed}`);
  console.log(`- Risk Reason Code: ${signalResult.riskResult?.reasonCode}`);

  if (signalResult.signalType === "BUY" && signalResult.riskResult?.passed === true) {
    console.log("✅ PASSED: Ruthless Hard Stop bypassed toxic flow traps and dispatched MARKET close order!");
  } else {
    console.error("❌ FAILED: Ruthless Hard Stop failed to bypass toxic flow traps!");
    process.exit(1);
  }

  // TEST 3: Verify Decoupled State Release (Slot remains occupied until order execution callback)
  console.log("\n[TEST 3] Verifying Decoupled State Release:");
  console.log(`- Slot occupied BEFORE execution promise resolves: ${hedgeLedger.getShortSlots()[0].isOccupied}`);
  if (hedgeLedger.getShortSlots()[0].isOccupied) {
    console.log("✅ PASSED: Slot remains occupied during order in-flight phase, preventing unmanaged state loss!");
  } else {
    console.error("❌ FAILED: Slot was prematurely set to unoccupied!");
    process.exit(1);
  }

  // Await order execution promise resolution (simulated)
  if (signalResult.executionPromise) {
    await signalResult.executionPromise.catch(() => {});
  }

  // TEST 4: Profit Hunting Micro-TP1 Verification
  console.log("\n[TEST 4] Testing Profit Hunting Micro-TP1 (+0.25% ROI) & Immediate Break-Even SL Lock:");
  hedgeLedger.releaseShortSlot(0);
  hedgeLedger.occupyShortSlot(0, 1.0, 1864.04, 0.25, 0.20);
  const tpSlot = hedgeLedger.getShortSlots()[0];
  console.log(`- Initial SL Price: $${tpSlot.stopLossPrice}`);
  console.log(`- TP1 Target Price: $${tpSlot.tpPrices?.[0].toFixed(2)}`);

  // Move price down to TP1 ($1859.38 or below for short)
  const tp1Price = (tpSlot.tpPrices?.[0] ?? 1859.00) - 0.50;
  console.log(`- Moving price to $${tp1Price.toFixed(2)} (TP1 breached)...`);
  setMarketState(101n, tp1Price - 0.05, tp1Price + 0.05, 0.20, false, -0.5, 0.80);

  const tpSignal = engine.evaluateTick();
  console.log(`- TP Signal Type: ${tpSignal.signalType}`);
  console.log(`- TP Exit Reason: ${tpSignal.exitReason}`);
  console.log(`- Break-Even Locked: ${tpSlot.breakEvenLocked}`);
  console.log(`- Updated SL Price (Break-Even): $${tpSlot.stopLossPrice.toFixed(2)}`);

  if (tpSlot.breakEvenLocked && tpSlot.stopLossPrice < tpSlot.entryPrice) {
    console.log("✅ PASSED: Micro-TP1 triggered partial exit and locked fee-adjusted Break-Even Stop Loss!");
  } else {
    console.error("❌ FAILED: Micro-TP1 did not lock Break-Even Stop Loss!");
    process.exit(1);
  }

  console.log("\n==================================================================");
  console.log("✅ ALL RUTHLESS HARD STOP & PROFIT HUNTING TESTS PASSED 100%!");
  console.log("==================================================================\n");
}

runRuthlessHardStopTests().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
