import { useSyncExternalStore } from "react";
import { WorkerFrameData } from "./telemetry.worker";

export interface SystemStoreState {
  connectionStatus: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR";
  latestFrame: WorkerFrameData | null;
  history: {
    timestamps: number[];
    prices: number[];
    obis: number[];
    cvds: number[];
    pnl: number[];
    stateNorms: number[];
  };
  executions: Array<{
    id: string;
    timestamp: number;
    symbol: string;
    side: "BUY" | "SELL";
    price: number;
    qty: number;
    realizedPnl: number;
    fee: number;
  }>;
}

const defaultState: SystemStoreState = {
  connectionStatus: "DISCONNECTED",
  latestFrame: null,
  history: {
    timestamps: [],
    prices: [],
    obis: [],
    cvds: [],
    pnl: [],
    stateNorms: [],
  },
  executions: [],
};

let currentState: SystemStoreState = { ...defaultState };
const listeners: Set<() => void> = new Set();
let worker: Worker | null = null;

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

export function initTelemetryWorker(wsUrl: string = "ws://localhost:8080") {
  if (worker || typeof window === "undefined") return;

  try {
    const metaUrl = typeof window !== "undefined" && window.location ? window.location.href : "http://localhost:8080";
    worker = new Worker(new URL("./telemetry.worker.ts", metaUrl), { type: "module" });

    worker.onmessage = (e: MessageEvent) => {
      const { type, status, frame } = e.data;

      if (type === "STATUS") {
        currentState = { ...currentState, connectionStatus: status };
        notifyListeners();
      } else if (type === "FRAME_BATCH" && frame) {
        const now = frame.timestamp || Date.now();
        
        // Maintain sliding window history (max 300 points for charts)
        const h = currentState.history;
        const maxPts = 300;

        const newTimestamps = [...h.timestamps, now / 1000].slice(-maxPts);
        const newPrices = [...h.prices, frame.bidPrice || frame.askPrice || 0].slice(-maxPts);
        const newObis = [...h.obis, frame.obi || 0].slice(-maxPts);
        const newCvds = [...h.cvds, frame.cvd || 0].slice(-maxPts);
        const newPnl = [...h.pnl, frame.stats?.realizedPnl || 0].slice(-maxPts);
        // Simulated/calculated CfC hidden state norm stream
        const stateNorm = Math.abs(frame.aiDirection || 0) * 1.5 + (Math.sin(now / 500) * 0.1) + 0.85;
        const newStateNorms = [...h.stateNorms, stateNorm].slice(-maxPts);

        // Append execution if signal changed or trade count increased
        let newExecutions = currentState.executions;
        if (frame.stats && frame.stats.totalExecutionsLogged > (currentState.latestFrame?.stats?.totalExecutionsLogged || 0)) {
          const newExec = {
            id: `EXEC-${frame.sequenceNum}-${Date.now().toString().slice(-4)}`,
            timestamp: now,
            symbol: frame.symbol || "BTCUSDT",
            side: (frame.lastSignal as any) || "BUY",
            price: frame.askPrice || frame.bidPrice,
            qty: 0.01,
            realizedPnl: frame.stats.realizedPnl,
            fee: frame.stats.totalFees,
          };
          newExecutions = [newExec, ...currentState.executions].slice(0, 200); // Keep max 200 items in virtuoso list
        }

        currentState = {
          ...currentState,
          latestFrame: frame,
          history: {
            timestamps: newTimestamps,
            prices: newPrices,
            obis: newObis,
            cvds: newCvds,
            pnl: newPnl,
            stateNorms: newStateNorms,
          },
          executions: newExecutions,
        };

        notifyListeners();
      }
    };

    worker.postMessage({ type: "CONNECT", url: wsUrl });
  } catch (err: any) {
    console.error(`[store] WebWorker initialization error: ${err.message}`);
  }
}

export function sendRpcCommand(action: string, modelPath?: string) {
  if (worker) {
    worker.postMessage({
      type: "SEND_COMMAND",
      command: { action, modelPath, timestamp: Date.now() },
    });
  }
}

export function subscribeTelemetry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTelemetrySnapshot(): SystemStoreState {
  return currentState;
}

export function useTelemetryStore(): SystemStoreState {
  return useSyncExternalStore(subscribeTelemetry, getTelemetrySnapshot, getTelemetrySnapshot);
}
