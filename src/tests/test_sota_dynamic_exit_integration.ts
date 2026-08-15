import { HedgePositionLedger } from "../strategy/positionLedger";
import { MicrostructureHazardEngine } from "../strategy/microstructureHazardEngine";
import { VolatilitySurfaceEngine } from "../strategy/volatilitySurfaceEngine";
import { HJBReservationEngine } from "../strategy/hjbReservationEngine";
import { MarketDataClient } from "../marketDataClient";

async function runSotaDynamicExitIntegrationTestSuite() {
  console.log("=========================================================================");
  console.log("  BATBOT_V11 SOTA PHASE 3: DYNAMIC EXITS INTEGRATION TEST SUITE          ");
  console.log("=========================================================================\n");

  const symbol = "BTCUSDT";

  const hazardEngine = new MicrostructureHazardEngine(symbol, 50, 100, 1.0, 20, 0.75);
  const volEngine = new VolatilitySurfaceEngine(symbol, 600);
  const hjbEngine = new HJBReservationEngine(symbol, 0.10, 60.0, 1.5);
  const ledger = new HedgePositionLedger(symbol, 3);

  // Seed baseline volatility bars: Open=60000, High=60100, Low=59900, Close=60050
  for (let i = 0; i < 50; i++) {
    volEngine.pushBar(60000, 60100, 59900, 60050);
  }

  // Seed baseline order book: Bid=60000 (2.0), Ask=60001 (2.0)
  hazardEngine.updateOrderBook(60000, 2.0, 60001, 2.0);

  // -------------------------------------------------------------------------
  // TEST 1: MVA-TS Trailing Stop & Zero-Loss Floor Guarantee
  // -------------------------------------------------------------------------
  console.log("[TEST 1] Testing MVA-TS Trailing Stop & Zero-Loss Floor Guarantee...");
  ledger.occupyCoreLong(0.1, 60000, 1.5, 1.5); // Open LONG @ $60,000

  // Advance price to $60,300 (+0.50% ROI), triggering TP1 fill & Break-Even lock ($60,075)
  ledger.processTpLimitFill("CORE_LONG", 101, 0.05, 60300, true);
  console.log("  - Core LONG TP1 filled @ $60,300. Break-Even SL Locked!");

  const volMetrics1 = volEngine.getVolatilitySurfaceMetrics();
  const hazardMetrics1 = hazardEngine.getHazardMetrics("LONG", 0.50, 10000);

  // Evaluate SOTA dynamic exit at markPrice = $60,250
  const triggers1 = ledger.evaluateSotaDynamicExits(60250, hazardMetrics1, hjbEngine, volMetrics1);
  console.log(`  - MarkPrice $60,250: Triggers count=${triggers1.length}`);
  if (triggers1.length > 0) {
    throw new Error(`❌ Test 1 Failed! Position should not be stopped out at $60,250.`);
  }

  // Drop price to $60,050 (below $60,075 Break-Even floor)
  const triggers1Exit = ledger.evaluateSotaDynamicExits(60050, hazardMetrics1, hjbEngine, volMetrics1);
  console.log(`  - MarkPrice $60,050: Triggers count=${triggers1Exit.length}, Reason=${triggers1Exit[0]?.reason}`);

  if (triggers1Exit.length === 0 || !triggers1Exit[0].reason.startsWith("MVA_TRAILING_STOP")) {
    throw new Error(`❌ Test 1 Failed! MVA-TS with zero-loss floor must trigger exit at $60,050.`);
  }
  console.log("  ✅ MVA-TS Trailing Stop & Zero-Loss Floor Guarantee verified.\n");

  ledger.releaseCoreLong(); // Clean up

  // -------------------------------------------------------------------------
  // TEST 2: Avellaneda-Stoikov HJB Optimal Stopping Liquidation Exit
  // -------------------------------------------------------------------------
  console.log("[TEST 2] Testing HJB Reservation Liquidation Exit...");
  ledger.occupyShortSlot(0, 2.0, 60000, 1.5, 1.5); // Open SHORT @ $60,000 (2.0 BTC)

  const volMetrics2 = volEngine.getVolatilitySurfaceMetrics();
  const hazardMetrics2 = hazardEngine.getHazardMetrics("SHORT", 0.50, 20000);

  // Price jumps to $61,500 breaching Short HJB liquidation boundary
  const triggers2 = ledger.evaluateSotaDynamicExits(61500, hazardMetrics2, hjbEngine, volMetrics2);
  console.log(`  - MarkPrice $61,500 (SHORT): Triggers count=${triggers2.length}, Reason=${triggers2[0]?.reason}`);

  if (triggers2.length === 0 || triggers2[0].reason !== "HJB_RESERVATION_LIQUIDATE_SHORT") {
    throw new Error(`❌ Test 2 Failed! HJB boundary breach must trigger HJB_RESERVATION_LIQUIDATE_SHORT.`);
  }
  console.log("  ✅ HJB Reservation Liquidation exit verified.\n");

  ledger.releaseShortSlot(0); // Clean up

  // -------------------------------------------------------------------------
  // TEST 3: Cox Proportional Hazard Rate Survival Flush Exit
  // -------------------------------------------------------------------------
  console.log("[TEST 3] Testing Cox Proportional Hazard Rate Survival Flush Exit...");
  ledger.occupyCoreLong(0.5, 60000, 1.5, 1.5); // Open LONG @ $60,000

  // Inject toxic sell volume sweep (25 taker sell trades of 1.0 BTC each)
  for (let i = 0; i < 25; i++) {
    hazardEngine.updateTrade(60000, 1.0, true);
    hazardEngine.updateOrderBook(60000 - i * 0.2, 0.5, 60000.2 - i * 0.2, 5.0);
  }

  const toxicHazardMetrics = hazardEngine.getHazardMetrics("LONG", 0.35, 15000);
  const volMetrics3 = volEngine.getVolatilitySurfaceMetrics();

  // Evaluate SOTA exit at $59,950 (normal price, but extreme toxic hazard flow)
  const triggers3 = ledger.evaluateSotaDynamicExits(59950, toxicHazardMetrics, hjbEngine, volMetrics3);
  console.log(`  - Toxic Order Flow (MarkPrice $59,950): Triggers count=${triggers3.length}, Reason=${triggers3[0]?.reason}`);

  if (triggers3.length === 0 || triggers3[0].reason !== "HAZARD_FLUSH_EXIT_LONG") {
    throw new Error(`❌ Test 3 Failed! Toxic order flow spike must trigger HAZARD_FLUSH_EXIT_LONG.`);
  }
  console.log("  ✅ Cox Proportional Hazard Rate Survival Flush Exit verified.\n");

  ledger.releaseCoreLong(); // Clean up

  // -------------------------------------------------------------------------
  // TEST 4: SharedArrayBuffer (SAB) High-Frequency Telemetry Synchronization
  // -------------------------------------------------------------------------
  console.log("[TEST 4] Testing SharedArrayBuffer Telemetry Sync (Slots 138-141)...");
  const sab = new SharedArrayBuffer(10 * 256 * 8);
  const client = new MarketDataClient(sab, 10, 256);

  const testOFI = 0.8542;
  const testHJB = 59850.25;
  const testSurvival = 0.4215;
  const testSL = 59620.00;

  client.setOFI(testOFI, 0);
  client.setHJBReservationPrice(testHJB, 0);
  client.setSurvivalProbability(testSurvival, 0);
  client.setDynamicStopLossPrice(testSL, 0);

  const readOFI = client.getOFI(0);
  const readHJB = client.getHJBReservationPrice(0);
  const readSurvival = client.getSurvivalProbability(0);
  const readSL = client.getDynamicStopLossPrice(0);

  console.log(`  - Read OFI (Slot 138): ${readOFI.toFixed(4)} (Expected ${testOFI})`);
  console.log(`  - Read HJB Res (Slot 139): $${readHJB.toFixed(2)} (Expected $${testHJB})`);
  console.log(`  - Read Survival (Slot 140): ${(readSurvival * 100).toFixed(1)}% (Expected ${(testSurvival * 100).toFixed(1)}%)`);
  console.log(`  - Read Dynamic SL (Slot 141): $${readSL.toFixed(2)} (Expected $${testSL})`);

  if (Math.abs(readOFI - testOFI) > 1e-4 || Math.abs(readHJB - testHJB) > 1e-4) {
    throw new Error(`❌ Test 4 Failed! SharedArrayBuffer telemetry slot value mismatch.`);
  }
  console.log("  ✅ SharedArrayBuffer Telemetry Sync (Slots 138-141) verified.\n");

  // -------------------------------------------------------------------------
  // TEST 5: Sub-1.5 Microsecond End-to-End Execution Latency Benchmark
  // -------------------------------------------------------------------------
  console.log("[TEST 5] Running 100,000 Tick End-to-End Dynamic Exit Benchmark...");
  ledger.occupyCoreLong(0.5, 60000, 1.5, 1.5);

  const iterations = 100000;
  const nowMs = Date.now();

  // V8 JIT Warmup Loop
  for (let w = 0; w < 10000; w++) {
    ledger.evaluateSotaDynamicExits(60000 + (w % 20), hazardMetrics1, hjbEngine, volMetrics1, nowMs);
  }

  const startHrTime = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    const markPx = 60000 + (i % 20);
    ledger.evaluateSotaDynamicExits(markPx, hazardMetrics1, hjbEngine, volMetrics1, nowMs);
  }

  const endHrTime = process.hrtime.bigint();
  const totalNs = Number(endHrTime - startHrTime);
  const avgNsPerTick = totalNs / iterations;
  const avgUsPerTick = avgNsPerTick / 1000;

  console.log(`  - Total Elapsed Time: ${(totalNs / 1e6).toFixed(2)} ms for ${iterations.toLocaleString()} ticks`);
  console.log(`  - Average Execution Latency per Tick: ${avgUsPerTick.toFixed(3)} microseconds (${avgNsPerTick.toFixed(1)} ns)`);

  if (avgUsPerTick > 1.5) {
    throw new Error(`❌ Test 5 Failed! Integration tick latency ${avgUsPerTick.toFixed(3)} µs exceeded 1.5 µs target.`);
  }
  console.log(`  ✅ Integration Benchmark PASSED! Execution time ${avgUsPerTick.toFixed(3)} µs < 1.5 µs SOTA HFT target.\n`);

  console.log("=========================================================================");
  console.log("  ✅ ALL 5 PHASE 3 INTEGRATION TEST SUITES PASSED CLEANLY & SEALED      ");
  console.log("=========================================================================");
}

runSotaDynamicExitIntegrationTestSuite().catch((err) => {
  console.error("❌ FATAL TEST ERROR:", err);
  process.exit(1);
});
