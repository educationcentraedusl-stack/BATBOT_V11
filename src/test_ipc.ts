import { initializeSystem } from "./index";

const BITCAST_BUF = new ArrayBuffer(8);
const BITCAST_BIGINT = new BigInt64Array(BITCAST_BUF);
const BITCAST_FLOAT = new Float64Array(BITCAST_BUF);

function storeAtomicFloat64(bigIntView: BigInt64Array, slot: number, value: number): void {
  BITCAST_FLOAT[0] = value;
  Atomics.store(bigIntView, slot, BITCAST_BIGINT[0]);
}

async function runTest() {
  console.log("[TEST] Initializing BATBOT_V11 Control Plane...");
  const system = await initializeSystem();
  console.log(`[TEST] Status: ${system.status}`);

  const sab = system.sab;
  const client = system.client;

  console.log("[TEST] Checking initial memory layout...");
  console.log(`[TEST] Initial TimestampNs: ${client.getTimestampNs()}`);
  console.log(`[TEST] Initial OBI: ${client.getOBI()}`);

  console.log("[TEST] Simulating atomic shared memory write from V8 typed view...");
  const bigIntView = new BigInt64Array(sab);

  // Slot 0: Timestamp 1700000000ns
  Atomics.store(bigIntView, 0, BigInt(1700000000));
  // Slot 1: OBI 0.45
  storeAtomicFloat64(bigIntView, 1, 0.45);
  // Slot 2: CVD 2500.5
  storeAtomicFloat64(bigIntView, 2, 2500.5);
  // Slot 3: Spread Velocity 1.2
  storeAtomicFloat64(bigIntView, 3, 1.2);
  // Slot 4-5: Best Bid 65000.0, 4.5
  storeAtomicFloat64(bigIntView, 4, 65000.0);
  storeAtomicFloat64(bigIntView, 5, 4.5);
  // Slot 6-7: Best Ask 65001.0, 3.2
  storeAtomicFloat64(bigIntView, 6, 65001.0);
  storeAtomicFloat64(bigIntView, 7, 3.2);

  // Slot 11-12: Top Bid 0 (65000.0, 4.5)
  storeAtomicFloat64(bigIntView, 11, 65000.0);
  storeAtomicFloat64(bigIntView, 12, 4.5);

  console.log("[TEST] Verifying zero-copy MarketDataClient accessors...");
  console.log(`[TEST] OBI: ${client.getOBI()} (Expected: 0.45)`);
  console.log(`[TEST] CVD: ${client.getCVD()} (Expected: 2500.5)`);
  console.log(`[TEST] Spread Velocity: ${client.getSpreadVelocity()} (Expected: 1.2)`);
  console.log(`[TEST] Best Bid Price: ${client.getBestBidPrice()} (Expected: 65000.0)`);
  console.log(`[TEST] Best Bid Quantity: ${client.getBestBidQuantity()} (Expected: 4.5)`);
  console.log(`[TEST] Best Ask Price: ${client.getBestAskPrice()} (Expected: 65001.0)`);
  console.log(`[TEST] Best Ask Quantity: ${client.getBestAskQuantity()} (Expected: 3.2)`);

  const topBidsBuffer = new Float64Array(40);
  client.fillTopBids(topBidsBuffer, 1);
  console.log(`[TEST] Top Bid 0 Price via fillTopBids: ${topBidsBuffer[0]} (Expected: 65000.0)`);
  console.log(`[TEST] Top Bid 0 Quantity via fillTopBids: ${topBidsBuffer[1]} (Expected: 4.5)`);

  if (
    client.getOBI() === 0.45 &&
    client.getCVD() === 2500.5 &&
    client.getSpreadVelocity() === 1.2 &&
    client.getBestBidPrice() === 65000.0 &&
    client.getBestBidQuantity() === 4.5 &&
    client.getBestAskPrice() === 65001.0 &&
    client.getBestAskQuantity() === 3.2 &&
    topBidsBuffer[0] === 65000.0 &&
    topBidsBuffer[1] === 4.5
  ) {
    console.log("✅ [PASSED] Zero-Copy IPC SharedArrayBuffer Verification Passed!");
    await system.stop();
    process.exit(0);
  } else {
    console.error("❌ [FAILED] Verification failed.");
    await system.stop();
    process.exit(1);
  }
}

runTest();
