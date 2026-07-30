import { useSyncExternalStore, useRef } from "react";
import { WorkerFrameData } from "./telemetry.worker";

export type { WorkerFrameData } from "./telemetry.worker";

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
  isEngineActive: boolean;
  latestFrame: WorkerFrameData | null;
  history: HistoryRingBuffer;
  executions: SystemExecution[];
  totalExecutionsCount: number;
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

let latestFrameSnapshot: WorkerFrameData | null = null;

const defaultState: SystemStoreState = {
  connectionStatus: "DISCONNECTED",
  isEngineActive: false,
  latestFrame: null,
  history: historyBuffer,
  executions: [],
  totalExecutionsCount: 0,
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
    // Vite Module Worker Instantiation
    worker = new Worker(new URL("./telemetry.worker.ts", import.meta.url), { type: "module" });

    worker.onmessage = (e: MessageEvent) => {
      const { type, status, frame } = e.data;

      if (type === "STATUS") {
        if (currentState.connectionStatus !== status) {
          currentState = { ...currentState, connectionStatus: status };
          scheduleNotify();
        }
      } else if (type === "FRAME_BATCH" && frame) {
        latestFrameSnapshot = frame;

        const nowSec = (frame.timestamp || Date.now()) / 1000;
        const price = frame.bidPrice || frame.askPrice || 0;
        const obi = frame.obi || 0;
        const cvd = frame.cvd || 0;
        const pnl = frame.stats?.realizedPnl || 0;
        const stateNorm = Math.abs(frame.aiDirection || 0) * 1.5 + (frame.aiConfidence || 0) * 0.5;

        // Zero-GC in-place typed array push (High frequency off-react data buffer)
        pushHistoryPoint(nowSec, price, obi, cvd, pnl, stateNorm);

        const newActive = frame.isEngineActive ?? false;
        const isEngineActiveChanged = newActive !== currentState.isEngineActive;

        const prevExecCount = currentState.totalExecutionsCount;
        const newExecCount = frame.stats?.totalExecutionsLogged || 0;
        const hasNewExecution = frame.stats && newExecCount > prevExecCount;

        let newExecutions = currentState.executions;
        if (hasNewExecution) {
          const execSide: "BUY" | "SELL" = (frame.lastSignal === "SELL" || frame.lastSignal === "BUY")
            ? frame.lastSignal
            : (frame.stats.positionSide === "SHORT" ? "SELL" : "BUY");

          const execQty = frame.stats.netQuantity > 0 ? frame.stats.netQuantity : 0.001;

          const newExec: SystemExecution = {
            id: `EXEC-${frame.sequenceNum}-${Date.now().toString().slice(-4)}`,
            timestamp: frame.timestamp || Date.now(),
            symbol: frame.symbol || process.env.SYMBOL || "BTCUSDT",
            side: execSide,
            price: execSide === "BUY" ? (frame.askPrice || frame.bidPrice) : (frame.bidPrice || frame.askPrice),
            qty: execQty,
            realizedPnl: frame.stats.realizedPnl,
            fee: frame.stats.totalFees,
          };
          newExecutions = [newExec, ...currentState.executions].slice(0, 200);
        }

        // ONLY notify structural state changes or actual new execution logs
        if (isEngineActiveChanged || hasNewExecution) {
          currentState = {
            ...currentState,
            isEngineActive: newActive,
            latestFrame: frame,
            executions: newExecutions,
            totalExecutionsCount: newExecCount,
          };
          scheduleNotify();
        }
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

export function getLatestFrameSnapshot(): WorkerFrameData | null {
  return latestFrameSnapshot;
}

export function getHistorySnapshot(): HistoryRingBuffer {
  return historyBuffer;
}

export function useTelemetryStore(): SystemStoreState {
  return useSyncExternalStore(subscribeTelemetry, getTelemetrySnapshot, getTelemetrySnapshot);
}

// Fine-grained selector hook with customizable equality guard to eliminate redundant component re-renders
export function useTelemetrySelector<T>(
  selector: (state: SystemStoreState) => T,
  equalityFn: (a: T, b: T) => boolean = (a, b) => Object.is(a, b)
): T {
  const lastSelectedRef = useRef<T | undefined>(undefined);

  const getSubSnapshot = () => {
    const nextSelected = selector(currentState);
    if (lastSelectedRef.current !== undefined && equalityFn(lastSelectedRef.current, nextSelected)) {
      return lastSelectedRef.current;
    }
    lastSelectedRef.current = nextSelected;
    return nextSelected;
  };

  return useSyncExternalStore(subscribeTelemetry, getSubSnapshot, getSubSnapshot);
}
