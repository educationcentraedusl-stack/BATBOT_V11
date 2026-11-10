import { useSyncExternalStore, useRef } from "react";
import type { ControlCommand } from "../telemetry/proto";
import {
  type WorkerFrameData,
  type ConnectionStatus,
  type TelemetryWorkerOutboundMessage,
} from "./telemetry.types";

export type { WorkerFrameData, ConnectionStatus } from "./telemetry.types";

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
  connectionStatus: ConnectionStatus;
  isEngineActive: boolean;
  latestFrame: WorkerFrameData | null;
  history: HistoryRingBuffer;
  executions: SystemExecution[];
  totalExecutionsCount: number;
}

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
): void {
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
const listeners = new Set<() => void>();
let worker: Worker | null = null;
let notifyRafId: number | null = null;

function scheduleNotify(): void {
  if (notifyRafId !== null || typeof window === "undefined") return;
  notifyRafId = requestAnimationFrame(() => {
    notifyRafId = null;
    for (const listener of listeners) {
      listener();
    }
  });
}

export function initTelemetryWorker(wsUrl: string = "ws://localhost:8080"): void {
  if (worker || typeof window === "undefined") return;

  try {
    worker = new Worker(new URL("./telemetry.worker.ts", import.meta.url), { type: "module" });

    worker.onmessage = (e: MessageEvent<TelemetryWorkerOutboundMessage>) => {
      const msg = e.data;

      if (msg.type === "STATUS") {
        if (currentState.connectionStatus !== msg.status) {
          currentState = { ...currentState, connectionStatus: msg.status };
          scheduleNotify();
        }
      } else {
        const frame = msg.frame;
        latestFrameSnapshot = frame;

        const hasValidTs = Number.isFinite(frame.timestamp) && frame.timestamp > 0;
        const price =
          Number.isFinite(frame.bidPrice) && frame.bidPrice > 0
            ? frame.bidPrice
            : frame.askPrice;
        const obi = frame.obi;
        const cvd = frame.cvd;
        const pnl = frame.stats.realizedPnl;
        const stateNorm = Math.abs(frame.aiDirection) * 1.5 + frame.aiConfidence * 0.5;

        if (
          hasValidTs &&
          Number.isFinite(price) &&
          price > 0 &&
          Number.isFinite(obi) &&
          Number.isFinite(cvd) &&
          Number.isFinite(pnl) &&
          Number.isFinite(stateNorm)
        ) {
          pushHistoryPoint(frame.timestamp / 1000, price, obi, cvd, pnl, stateNorm);
        }

        const newActive = frame.isEngineActive;
        const isEngineActiveChanged = newActive !== currentState.isEngineActive;

        const prevExecCount = currentState.totalExecutionsCount;
        const newExecCount = frame.stats.totalExecutionsLogged;
        const hasNewExecution = newExecCount > prevExecCount;

        let newExecutions = currentState.executions;
        if (hasNewExecution) {
          const trimmedSymbol = frame.symbol.trim();
          const execSide: "BUY" | "SELL" | null =
            frame.lastSignal === "SELL" || frame.lastSignal === "BUY"
              ? frame.lastSignal
              : frame.stats.positionSide === "SHORT"
                ? "SELL"
                : frame.stats.positionSide === "LONG"
                  ? "BUY"
                  : null;

          const execQty = frame.stats.netQuantity;
          const rawPrice =
            execSide === "BUY"
              ? Number.isFinite(frame.askPrice) && frame.askPrice > 0
                ? frame.askPrice
                : frame.bidPrice
              : Number.isFinite(frame.bidPrice) && frame.bidPrice > 0
                ? frame.bidPrice
                : frame.askPrice;

          if (
            trimmedSymbol.length === 0 ||
            execSide === null ||
            !hasValidTs ||
            !Number.isFinite(execQty) ||
            execQty < 0 ||
            !Number.isFinite(rawPrice) ||
            rawPrice <= 0 ||
            !Number.isFinite(frame.stats.realizedPnl) ||
            !Number.isFinite(frame.stats.totalFees)
          ) {
            console.error(
              `[store] Ignoring malformed execution telemetry frame (seq=${frame.sequenceNum}, symbol="${frame.symbol}", qty=${String(execQty)}, price=${String(rawPrice)}, ts=${String(frame.timestamp)})`
            );
          } else {
            const newExec: SystemExecution = {
              id: `EXEC-${frame.sequenceNum}-${String(frame.timestamp)}`,
              timestamp: frame.timestamp,
              symbol: trimmedSymbol,
              side: execSide,
              price: rawPrice,
              qty: execQty,
              realizedPnl: frame.stats.realizedPnl,
              fee: frame.stats.totalFees,
            };
            newExecutions = [newExec, ...currentState.executions].slice(0, 200);
          }
        }

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
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[store] WebWorker initialization error: ${errMsg}`);
  }
}

export function sendRpcCommand(action: ControlCommand["action"], modelPath?: string): void {
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

export function useTelemetrySelector<T>(
  selector: (state: SystemStoreState) => T,
  equalityFn: (a: T, b: T) => boolean = (a, b) => Object.is(a, b)
): T {
  const lastSelectedRef = useRef<T | undefined>(undefined);

  const getSubSnapshot = (): T => {
    const nextSelected = selector(currentState);
    if (lastSelectedRef.current !== undefined && equalityFn(lastSelectedRef.current, nextSelected)) {
      return lastSelectedRef.current;
    }
    lastSelectedRef.current = nextSelected;
    return nextSelected;
  };

  return useSyncExternalStore(subscribeTelemetry, getSubSnapshot, getSubSnapshot);
}
