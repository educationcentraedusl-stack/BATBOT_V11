// Telemetry WebWorker for Off-Main-Thread Processing & 60Hz Batching
import { decodeTelemetryFrame, encodeControlCommand, ControlCommand } from "../telemetry/proto";

export interface WorkerFrameData {
  symbol: string;
  sequenceNum: string;
  bidPrice: number;
  askPrice: number;
  obi: number;
  cvd: number;
  spreadVelocity: number;
  lastSignal: string;
  tickEvaluationLatencyUs: number;
  riskStatus: string;
  isEngineActive: boolean;
  usdtBalance: number;
  aiDirection: number;
  aiConfidence: number;
  rollingIc: number;
  aiInferenceLatencyNs: string;
  rttMs: number;
  latencyPenalty: number;
  slippageTicks: number;
  timestamp: number;
  stats: {
    realizedPnl: number;
    unrealizedPnl: number;
    totalFees: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRatePercent: number;
    positionSide: string;
    netQuantity: number;
    averageEntryPrice: number;
    totalSignalsLogged: number;
    totalExecutionsLogged: number;
    avgTickLatencyUs: number;
    bufferQueueDepth: number;
  };
}

let socket: WebSocket | null = null;
let latestFrame: WorkerFrameData | null = null;
let frameQueue: WorkerFrameData[] = [];
let batchInterval: any = null;

ctx().onmessage = (e: MessageEvent) => {
  const { type, url, command } = e.data;

  if (type === "CONNECT") {
    connectWebSocket(url || "ws://localhost:8080");
  } else if (type === "SEND_COMMAND") {
    if (socket && socket.readyState === WebSocket.OPEN && command) {
      // Direct Protobuf binary command encoding
      const binaryCmd = encodeControlCommand(command as ControlCommand);
      socket.send(binaryCmd);
    }
  } else if (type === "DISCONNECT") {
    if (socket) socket.close();
  }
};

function ctx(): Worker {
  return self as any;
}

function connectWebSocket(url: string) {
  if (socket) {
    try { socket.close(); } catch {}
  }

  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    ctx().postMessage({ type: "STATUS", status: "CONNECTED" });
  };

  socket.onmessage = (event: MessageEvent) => {
    try {
      if (event.data instanceof ArrayBuffer) {
        // Strict binary Protobuf telemetry frame deserialization
        const decodedFrame = decodeTelemetryFrame(new Uint8Array(event.data));
        const workerFrame: WorkerFrameData = {
          ...decodedFrame,
          sequenceNum: decodedFrame.sequenceNum.toString(),
          aiInferenceLatencyNs: (decodedFrame.aiInferenceLatencyNs || 0n).toString(),
          aiDirection: decodedFrame.aiDirection ?? 0,
          aiConfidence: decodedFrame.aiConfidence ?? 0,
          rollingIc: decodedFrame.rollingIc ?? 0,
          rttMs: decodedFrame.rttMs ?? 0,
          latencyPenalty: decodedFrame.latencyPenalty ?? 1.0,
          slippageTicks: decodedFrame.slippageTicks ?? 2,
          timestamp: Date.now(),
        };

        latestFrame = workerFrame;
        frameQueue.push(workerFrame);
        if (frameQueue.length > 500) {
          frameQueue.shift();
        }
      }
    } catch (err) {
      // Ignore partial/corrupted frames
    }
  };

  socket.onclose = () => {
    ctx().postMessage({ type: "STATUS", status: "DISCONNECTED" });
    // Auto reconnect after 2 seconds
    setTimeout(() => connectWebSocket(url), 2000);
  };

  socket.onerror = () => {
    ctx().postMessage({ type: "STATUS", status: "ERROR" });
  };

  // Start 60Hz (16.6ms) batch flush to main thread
  if (batchInterval) clearInterval(batchInterval);
  batchInterval = setInterval(() => {
    if (latestFrame) {
      ctx().postMessage({
        type: "FRAME_BATCH",
        frame: latestFrame,
        recentCount: frameQueue.length,
      });
      frameQueue = [];
    }
  }, 16);
}

