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

export type ConnectionStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR";

export type TelemetryWorkerInboundMessage =
  | { type: "CONNECT"; url?: string }
  | { type: "SEND_COMMAND"; command?: ControlCommand }
  | { type: "DISCONNECT" };

export type TelemetryWorkerOutboundMessage =
  | { type: "STATUS"; status: ConnectionStatus }
  | { type: "FRAME_BATCH"; frame: WorkerFrameData; recentCount: number };

interface TelemetryWorkerScope {
  postMessage: (message: TelemetryWorkerOutboundMessage) => void;
  onmessage: ((e: MessageEvent<TelemetryWorkerInboundMessage>) => void) | null;
}

let socket: WebSocket | null = null;
let latestFrame: WorkerFrameData | null = null;
let frameQueue: WorkerFrameData[] = [];
let batchInterval: ReturnType<typeof setInterval> | null = null;

function ctx(): TelemetryWorkerScope {
  return globalThis;
}

ctx().onmessage = (e: MessageEvent<TelemetryWorkerInboundMessage>) => {
  const msg = e.data;

  if (msg.type === "CONNECT") {
    connectWebSocket(msg.url ?? "ws://localhost:8080");
  } else if (msg.type === "SEND_COMMAND") {
    if (socket && socket.readyState === WebSocket.OPEN && msg.command) {
      const binaryCmd = encodeControlCommand(msg.command);
      socket.send(binaryCmd);
    }
  } else {
    if (socket) socket.close();
  }
};

function connectWebSocket(url: string): void {
  if (socket) {
    try {
      socket.close();
    } catch (closeErr: unknown) {
      const msg = closeErr instanceof Error ? closeErr.message : String(closeErr);
      console.warn(`[telemetry.worker] Socket close warning during reconnect: ${msg}`);
    }
  }

  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    ctx().postMessage({ type: "STATUS", status: "CONNECTED" });
  };

  socket.onmessage = (event: MessageEvent<unknown>) => {
    try {
      if (event.data instanceof ArrayBuffer) {
        const decodedFrame = decodeTelemetryFrame(new Uint8Array(event.data));
        const workerFrame: WorkerFrameData = {
          ...decodedFrame,
          sequenceNum: decodedFrame.sequenceNum.toString(),
          aiInferenceLatencyNs: (decodedFrame.aiInferenceLatencyNs ?? 0n).toString(),
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
    } catch (decodeErr: unknown) {
      const errMsg = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
      console.warn(`[telemetry.worker] Frame decode warning: ${errMsg}`);
    }
  };

  socket.onclose = () => {
    ctx().postMessage({ type: "STATUS", status: "DISCONNECTED" });
    setTimeout(() => { connectWebSocket(url); }, 2000);
  };

  socket.onerror = () => {
    ctx().postMessage({ type: "STATUS", status: "ERROR" });
  };

  if (batchInterval !== null) clearInterval(batchInterval);
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
