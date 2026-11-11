// Telemetry WebWorker for Off-Main-Thread Processing & 60Hz Batching
import { decodeTelemetryFrame, encodeControlCommand, type ControlCommand } from "../telemetry/proto";
import type {
  WorkerFrameData,
  TelemetryWorkerInboundMessage,
  TelemetryWorkerOutboundMessage,
} from "./telemetry.types";

export type {
  WorkerFrameData,
  ConnectionStatus,
  TelemetryWorkerInboundMessage,
  TelemetryWorkerOutboundMessage,
} from "./telemetry.types";

let socket: WebSocket | null = null;
let latestFrame: WorkerFrameData | null = null;
let frameQueue: WorkerFrameData[] = [];
let batchInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ctx(): DedicatedWorkerGlobalScope {
  return self;
}

function postOutbound(message: TelemetryWorkerOutboundMessage): void {
  ctx().postMessage(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseControlCommand(raw: unknown): ControlCommand | undefined {
  if (!isRecord(raw)) return undefined;
  const action = raw["action"];
  if (
    action !== "ENGINE_START" &&
    action !== "ENGINE_PAUSE" &&
    action !== "EMERGENCY_KILL" &&
    action !== "AI_HOT_SWAP"
  ) {
    return undefined;
  }
  const modelPath = typeof raw["modelPath"] === "string" ? raw["modelPath"] : undefined;
  const timestamp = typeof raw["timestamp"] === "number" ? raw["timestamp"] : undefined;
  return { action, modelPath, timestamp };
}

function parseInboundMessage(raw: unknown): TelemetryWorkerInboundMessage | null {
  if (!isRecord(raw)) return null;
  const msgType = raw["type"];
  if (msgType === "CONNECT") {
    const url = typeof raw["url"] === "string" ? raw["url"] : undefined;
    return { type: "CONNECT", url };
  }
  if (msgType === "SEND_COMMAND") {
    const command = parseControlCommand(raw["command"]);
    return { type: "SEND_COMMAND", command };
  }
  if (msgType === "DISCONNECT") {
    return { type: "DISCONNECT" };
  }
  return null;
}

ctx().onmessage = (e: MessageEvent<unknown>): void => {
  const msg = parseInboundMessage(e.data);
  if (!msg) return;

  if (msg.type === "CONNECT") {
    if (typeof msg.url !== "string" || msg.url.trim().length === 0) {
      console.error("[telemetry.worker] Rejected CONNECT request without a valid WebSocket URL.");
      postOutbound({ type: "STATUS", status: "ERROR" });
      return;
    }
    connectWebSocket(msg.url);
  } else if (msg.type === "SEND_COMMAND") {
    if (socket && socket.readyState === WebSocket.OPEN && msg.command) {
      const binaryCmd = encodeControlCommand(msg.command);
      socket.send(binaryCmd);
    }
  } else {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (batchInterval !== null) {
      clearInterval(batchInterval);
      batchInterval = null;
    }
    if (socket) {
      socket.close();
      socket = null;
    }
  }
};

function connectWebSocket(url: string): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

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
    postOutbound({ type: "STATUS", status: "CONNECTED" });
  };

  socket.onmessage = (event: MessageEvent<unknown>) => {
    try {
      if (event.data instanceof ArrayBuffer) {
        const decodedFrame = decodeTelemetryFrame(new Uint8Array(event.data));
        const workerFrame: WorkerFrameData = {
          ...decodedFrame,
          sequenceNum: decodedFrame.sequenceNum.toString(),
          aiInferenceLatencyNs: decodedFrame.aiInferenceLatencyNs.toString(),
          aiDirection: decodedFrame.aiDirection,
          aiConfidence: decodedFrame.aiConfidence,
          rollingIc: decodedFrame.rollingIc,
          rttMs: decodedFrame.rttMs,
          latencyPenalty: decodedFrame.latencyPenalty,
          slippageTicks: decodedFrame.slippageTicks,
          timestamp: decodedFrame.timestamp,
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
    postOutbound({ type: "STATUS", status: "DISCONNECTED" });
    reconnectTimer = setTimeout(() => {
      connectWebSocket(url);
    }, 2000);
  };

  socket.onerror = () => {
    postOutbound({ type: "STATUS", status: "ERROR" });
  };

  if (batchInterval !== null) clearInterval(batchInterval);
  batchInterval = setInterval(() => {
    if (latestFrame) {
      postOutbound({
        type: "FRAME_BATCH",
        frame: latestFrame,
        recentCount: frameQueue.length,
      });
      frameQueue = [];
    }
  }, 16);
}
