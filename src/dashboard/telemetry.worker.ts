// Telemetry WebWorker for Off-Main-Thread Processing & 60Hz Batching

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
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(command));
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
      if (typeof event.data === "string") {
        const json = JSON.parse(event.data);
        if (json.type === "INIT") {
          ctx().postMessage({ type: "INIT_MESSAGE", message: json.message });
          return;
        }
      }

      // Handle binary or JSON frame
      let frame: WorkerFrameData;
      if (event.data instanceof ArrayBuffer) {
        // Fast text/json or binary parsing fallback
        const str = new TextDecoder().decode(event.data);
        const parsed = JSON.parse(str);
        frame = parsed.data || parsed;
      } else {
        frame = JSON.parse(event.data);
      }

      latestFrame = frame;
      frameQueue.push(frame);
      if (frameQueue.length > 500) {
        frameQueue.shift();
      }
    } catch (err) {
      // Ignore transient decode errors on partial frames
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
