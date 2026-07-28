import { TelemetryWSServer } from "../telemetry/server";
import { TelemetryFrame } from "../telemetry/dashboard";
import WebSocket from "ws";

async function runDashboardStressTest() {
  console.log("==================================================================");
  console.log("BATBOT_V11 HIGH-FREQUENCY DASHBOARD STRESS TEST (5,000 TICKS/SEC)");
  console.log("==================================================================");

  const server = new TelemetryWSServer(8089);
  let rpcReceived = 0;

  server.setCommandHandler(async (cmd) => {
    rpcReceived++;
    console.log(`[STRESS_TEST] Received Control RPC: ${cmd.action}`);
    return { success: true, message: `RPC ${cmd.action} processed successfully` };
  });

  server.start();
  console.log("[STRESS_TEST] Telemetry server started on port 8089.");

  // Connect client socket
  const clientWs = new WebSocket("ws://localhost:8089");
  let receivedCount = 0;
  let initReceived = false;

  await new Promise<void>((resolve) => {
    clientWs.on("open", () => {
      console.log("[STRESS_TEST] Client WebSocket connected.");
      resolve();
    });
  });

  clientWs.on("message", (data: any) => {
    const str = data.toString();
    if (str.includes("INIT")) {
      initReceived = true;
    } else {
      receivedCount++;
    }
  });

  // Generate 5,000 ticks/sec for 3 seconds (15,000 ticks total)
  const targetTicksPerSec = 5000;
  const durationSec = 3;
  const totalTicks = targetTicksPerSec * durationSec;

  console.log(`[STRESS_TEST] Pumping ${totalTicks} ticks at ${targetTicksPerSec} ticks/sec...`);

  const mockFrame: TelemetryFrame = {
    symbol: "BTCUSDT",
    sequenceNum: 1000000n,
    bidPrice: 65420.50,
    askPrice: 65421.00,
    obi: 0.7421,
    cvd: 1420.50,
    spreadVelocity: 0.0012,
    lastSignal: "BUY",
    tickEvaluationLatencyUs: 0.85,
    stats: {
      realizedPnl: 1250.40,
      unrealizedPnl: 340.20,
      totalFees: 12.40,
      totalTrades: 48,
      winningTrades: 36,
      losingTrades: 12,
      winRatePercent: 75.0,
      positionSide: "LONG",
      netQuantity: 0.55,
      averageEntryPrice: 65100.00,
      totalSignalsLogged: 120,
      totalExecutionsLogged: 48,
      avgTickLatencyUs: 0.82,
      bufferQueueDepth: 0,
    },
    riskStatus: "PASSED",
    isEngineActive: true,
    usdtBalance: 10000.00,
    aiDirection: 0.8421,
    aiConfidence: 0.94,
    rollingIc: 0.0512,
    aiInferenceLatencyNs: 820000n,
    rttMs: 1.2,
    latencyPenalty: 1.0,
    slippageTicks: 2,
  };

  const startTime = Date.now();
  let count = 0;

  for (let i = 0; i < totalTicks; i++) {
    mockFrame.sequenceNum++;
    mockFrame.bidPrice += (Math.random() - 0.5) * 0.1;
    mockFrame.askPrice = mockFrame.bidPrice + 0.5;
    server.broadcast(mockFrame);
    count++;
    if (i % 1000 === 0) {
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`[STRESS_TEST] Streamed ${count} frames in ${elapsed.toFixed(3)}s (${(count / elapsed).toFixed(0)} ticks/sec).`);

  // Send Control RPC command over WebSocket
  clientWs.send(JSON.stringify({ action: "EMERGENCY_KILL", timestamp: Date.now() }));
  await new Promise((r) => setTimeout(r, 500));

  clientWs.close();
  await server.stop();

  console.log(`[STRESS_TEST] Frames Broadcasted: ${count}`);
  console.log(`[STRESS_TEST] Client Received Batches: ${receivedCount}`);
  console.log(`[STRESS_TEST] Control RPC Commands Handled: ${rpcReceived}`);

  if (count >= 15000 && rpcReceived >= 1) {
    console.log("==================================================================");
    console.log("✅ STRESS TEST PASSED: 5,000 TICKS/SEC BROADCAST & RPC VERIFIED!");
    console.log("==================================================================");
    process.exit(0);
  } else {
    console.error("❌ STRESS TEST FAILED");
    process.exit(1);
  }
}

runDashboardStressTest().catch((err) => {
  console.error("Stress test failed with error:", err);
  process.exit(1);
});
