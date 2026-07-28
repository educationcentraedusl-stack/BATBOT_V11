"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HISTORY_CAPACITY = void 0;
exports.initTelemetryWorker = initTelemetryWorker;
exports.sendRpcCommand = sendRpcCommand;
exports.subscribeTelemetry = subscribeTelemetry;
exports.getTelemetrySnapshot = getTelemetrySnapshot;
exports.getLatestFrameSnapshot = getLatestFrameSnapshot;
exports.getHistorySnapshot = getHistorySnapshot;
exports.useTelemetryStore = useTelemetryStore;
exports.useTelemetrySelector = useTelemetrySelector;
const react_1 = require("react");
exports.HISTORY_CAPACITY = 300;
// Pre-allocate typed arrays to eliminate V8 heap allocation on hot path
const historyBuffer = {
    count: 0,
    timestamps: new Float64Array(exports.HISTORY_CAPACITY),
    prices: new Float64Array(exports.HISTORY_CAPACITY),
    obis: new Float64Array(exports.HISTORY_CAPACITY),
    cvds: new Float64Array(exports.HISTORY_CAPACITY),
    pnl: new Float64Array(exports.HISTORY_CAPACITY),
    stateNorms: new Float64Array(exports.HISTORY_CAPACITY),
};
function pushHistoryPoint(ts, price, obi, cvd, pnl, stateNorm) {
    const h = historyBuffer;
    if (h.count < exports.HISTORY_CAPACITY) {
        const idx = h.count;
        h.timestamps[idx] = ts;
        h.prices[idx] = price;
        h.obis[idx] = obi;
        h.cvds[idx] = cvd;
        h.pnl[idx] = pnl;
        h.stateNorms[idx] = stateNorm;
        h.count++;
    }
    else {
        // Fast in-place zero-allocation shift
        h.timestamps.copyWithin(0, 1);
        h.prices.copyWithin(0, 1);
        h.obis.copyWithin(0, 1);
        h.cvds.copyWithin(0, 1);
        h.pnl.copyWithin(0, 1);
        h.stateNorms.copyWithin(0, 1);
        const last = exports.HISTORY_CAPACITY - 1;
        h.timestamps[last] = ts;
        h.prices[last] = price;
        h.obis[last] = obi;
        h.cvds[last] = cvd;
        h.pnl[last] = pnl;
        h.stateNorms[last] = stateNorm;
    }
}
let latestFrameSnapshot = null;
const defaultState = {
    connectionStatus: "DISCONNECTED",
    isEngineActive: false,
    latestFrame: null,
    history: historyBuffer,
    executions: [],
    totalExecutionsCount: 0,
};
let currentState = { ...defaultState };
const listeners = new Set();
let worker = null;
let notifyRafId = null;
// Batch listener notifications using requestAnimationFrame to prevent 60Hz DOM thrashing
function scheduleNotify() {
    if (notifyRafId !== null || typeof window === "undefined")
        return;
    notifyRafId = requestAnimationFrame(() => {
        notifyRafId = null;
        for (const listener of listeners) {
            listener();
        }
    });
}
function initTelemetryWorker(wsUrl = "ws://localhost:8080") {
    if (worker || typeof window === "undefined")
        return;
    try {
        // Vite Module Worker Instantiation
        worker = new Worker(new URL("./telemetry.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (e) => {
            const { type, status, frame } = e.data;
            if (type === "STATUS") {
                if (currentState.connectionStatus !== status) {
                    currentState = { ...currentState, connectionStatus: status };
                    scheduleNotify();
                }
            }
            else if (type === "FRAME_BATCH" && frame) {
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
                    const execSide = (frame.lastSignal === "SELL" || frame.lastSignal === "BUY")
                        ? frame.lastSignal
                        : (frame.stats.positionSide === "SHORT" ? "SELL" : "BUY");
                    const execQty = frame.stats.netQuantity > 0 ? frame.stats.netQuantity : 0.001;
                    const newExec = {
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
    }
    catch (err) {
        console.error(`[store] WebWorker initialization error: ${err.message}`);
    }
}
function sendRpcCommand(action, modelPath) {
    if (worker) {
        worker.postMessage({
            type: "SEND_COMMAND",
            command: { action, modelPath, timestamp: Date.now() },
        });
    }
}
function subscribeTelemetry(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
function getTelemetrySnapshot() {
    return currentState;
}
function getLatestFrameSnapshot() {
    return latestFrameSnapshot;
}
function getHistorySnapshot() {
    return historyBuffer;
}
function useTelemetryStore() {
    return (0, react_1.useSyncExternalStore)(subscribeTelemetry, getTelemetrySnapshot, getTelemetrySnapshot);
}
// Fine-grained selector hook with customizable equality guard to eliminate redundant component re-renders
function useTelemetrySelector(selector, equalityFn = (a, b) => Object.is(a, b)) {
    const lastSelectedRef = (0, react_1.useRef)(undefined);
    const getSubSnapshot = () => {
        const nextSelected = selector(currentState);
        if (lastSelectedRef.current !== undefined && equalityFn(lastSelectedRef.current, nextSelected)) {
            return lastSelectedRef.current;
        }
        lastSelectedRef.current = nextSelected;
        return nextSelected;
    };
    return (0, react_1.useSyncExternalStore)(subscribeTelemetry, getSubSnapshot, getSubSnapshot);
}
