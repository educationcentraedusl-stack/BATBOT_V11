import { useSyncExternalStore } from "react";
import { WorkerFrameData } from "./telemetry.worker";

export const HISTORY_CAPACITY = 300;

export interface HistoryRingBuffer {
  count: number;
  timestamps: Float64Array;
  prices: Float64Array;
  obis: Float64Array;
  cvds: Float64Array;
  pnl: Float64Array;
  stateNorms: Float64Array;
}

export interface SystemExecution {
  id: string;
  timestamp: number;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  realizedPnl: number;
  fee: number;
}

export interface SystemStoreState {
  connectionStatus: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR";
  latestFrame: WorkerFrameData | null;
  history: HistoryRingBuffer;
  executions: SystemExecution[];
}

// Pre-allocate typed arrays to eliminate V8 heap allocation on hot path
const historyBuffer: HistoryRingBuffer = {
  count: 0,
  timestamps: new Float64Array(HISTORY_CAPACITY),
  prices: new Float64Array(HISTORY_CAPACITY),
  obis: new Float64Array(HISTORY_CAPACITY),
  cvds: new Float64Array(HISTORY_CAPACITY),
  pnl: new Float64Array(HISTORY_CAPACITY),
  stateNorms: new Float64Array(HISTORY_CAPACITY),
};

function pushHistoryPoint(
  ts: number,
  price: number,
  obi: number,
  cvd: number,
  pnl: number,
  stateNorm: number
) {
  const h = historyBuffer;
  if (h.count < HISTORY_CAPACITY) {
    const idx = h.count;
    h.timestamps[idx] = ts;
    h.prices[idx] = price;
    h.obis[idx] = obi;
    h.cvds[idx] = cvd;
    h.pnl[idx] = pnl;
    h.stateNorms[idx] = stateNorm;
    h.count++;
  } else {
    // Fast in-place zero-allocation shift
    h.timestamps.copyWithin(0, 1);
    h.prices.copyWithin(0, 1);
    h.obis.copyWithin(0, 1);
    h.cvds.copyWithin(0, 1);
    h.pnl.copyWithin(0, 1);
    h.stateNorms.copyWithin(0, 1);

    const last = HISTORY_CAPACITY - 1;
    h.timestamps[last] = ts;
    h.prices[last] = price;
    h.obis[last] = obi;
    h.cvds[last] = cvd;
    h.pnl[last] = pnl;
    h.stateNorms[last] = stateNorm;
  }
}

const defaultState: SystemStoreState = {
  connectionStatus: "DISCONNECTED",
  latestFrame: null,
  history: historyBuffer,
  executions: [],
};

let currentState: SystemStoreState = { ...defaultState };
const listeners: Set<() => void> = new Set();
let worker: Worker | null = null;
let notifyRafId: number | null = null;

// Batch listener notifications using requestAnimationFrame to prevent 60Hz DOM thrashing
function scheduleNotify() {
  if (notifyRafId !== null || typeof window === "undefined") return;
  notifyRafId = requestAnimationFrame(() => {
    notifyRafId = null;
    for (const listener of listeners) {
      listener();
    }
  });
}

export function initTelemetryWorker(wsUrl: string = "ws://localhost:8080") {
  if (worker || typeof window === "undefined") return;

  try {
    // PHASE 1 FIX: Strict Vite Module Worker Instantiation
    worker = new Worker(new URL("./telemetry.worker.ts", import.meta.url), { type: "module" });

    worker.onmessage = (e: MessageEvent) => {
      const { type, status, frame } = e.data;

      if (type === "STATUS") {
        currentState = { ...currentState, connectionStatus: status };
        scheduleNotify();
      } else if (type === "FRAME_BATCH" && frame) {
        const nowSec = (frame.timestamp || Date.now()) / 1000;
        const price = frame.bidPrice || frame.askPrice || 0;
        const obi = frame.obi || 0;
        const cvd = frame.cvd || 0;
        const pnl = frame.stats?.realizedPnl || 0;
        const stateNorm = Math.abs(frame.aiDirection || 0) * 1.5 + (frame.aiConfidence || 0) * 0.5;

        // Zero-GC in-place typed array push
        pushHistoryPoint(nowSec, price, obi, cvd, pnl, stateNorm);

        // Append execution if trade count or executions logged increased
        let newExecutions = currentState.executions;
        const prevExecCount = currentState.latestFrame?.stats?.totalExecutionsLogged || 0;
        if (frame.stats && frame.stats.totalExecutionsLogged > prevExecCount) {
          const execSide: "BUY" | "SELL" = (frame.lastSignal === "SELL" || frame.lastSignal === "BUY")
            ? frame.lastSignal
            : (frame.stats.positionSide === "SHORT" ? "SELL" : "BUY");

          const execQty = frame.stats.netQuantity > 0 ? frame.stats.netQuantity : 0.001;

          const newExec: SystemExecution = {
            id: `EXEC-${frame.sequenceNum}-${Date.now().toString().slice(-4)}`,
            timestamp: frame.timestamp || Date.now(),
            symbol: frame.symbol || "BTCUSDT",
            side: execSide,
            price: execSide === "BUY" ? (frame.askPrice || frame.bidPrice) : (frame.bidPrice || frame.askPrice),
            qty: execQty,
            realizedPnl: frame.stats.realizedPnl,
            fee: frame.stats.totalFees,
          };
          newExecutions = [newExec, ...currentState.executions].slice(0, 200);
        }

        currentState = {
          ...currentState,
          latestFrame: frame,
          executions: newExecutions,
        };

        scheduleNotify();
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

// Selector hook with fallback snapshot comparison for optimized sub-component subscriptions
export function useTelemetrySelector<T>(selector: (state: SystemStoreState) => T): T {
  const getSubSnapshot = () => selector(currentState);
  return useSyncExternalStore(subscribeTelemetry, getSubSnapshot, getSubSnapshot);
}
