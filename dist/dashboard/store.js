"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initTelemetryWorker = initTelemetryWorker;
exports.sendRpcCommand = sendRpcCommand;
exports.subscribeTelemetry = subscribeTelemetry;
exports.getTelemetrySnapshot = getTelemetrySnapshot;
exports.useTelemetryStore = useTelemetryStore;
const react_1 = require("react");
const defaultState = {
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
let currentState = { ...defaultState };
const listeners = new Set();
let worker = null;
function notifyListeners() {
    for (const listener of listeners) {
        listener();
    }
}
function initTelemetryWorker(wsUrl = "ws://localhost:8080") {
    if (worker || typeof window === "undefined")
        return;
    try {
        const metaUrl = typeof window !== "undefined" && window.location ? window.location.href : "http://localhost:8080";
        worker = new Worker(new URL("./telemetry.worker.ts", metaUrl), { type: "module" });
        worker.onmessage = (e) => {
            const { type, status, frame } = e.data;
            if (type === "STATUS") {
                currentState = { ...currentState, connectionStatus: status };
                notifyListeners();
            }
            else if (type === "FRAME_BATCH" && frame) {
                const now = frame.timestamp || Date.now();
                // Maintain sliding window history (max 300 points for charts)
                const h = currentState.history;
                const maxPts = 300;
                const newTimestamps = [...h.timestamps, now / 1000].slice(-maxPts);
                const newPrices = [...h.prices, frame.bidPrice || frame.askPrice || 0].slice(-maxPts);
                const newObis = [...h.obis, frame.obi || 0].slice(-maxPts);
                const newCvds = [...h.cvds, frame.cvd || 0].slice(-maxPts);
                const newPnl = [...h.pnl, frame.stats?.realizedPnl || 0].slice(-maxPts);
                // Genuine CfC cell hidden state norm calculated directly from raw AI directional & confidence telemetry
                const stateNorm = Math.abs(frame.aiDirection || 0) * 1.5 + (frame.aiConfidence || 0) * 0.5;
                const newStateNorms = [...h.stateNorms, stateNorm].slice(-maxPts);
                // Append execution if trade count or executions logged increased
                let newExecutions = currentState.executions;
                if (frame.stats && frame.stats.totalExecutionsLogged > (currentState.latestFrame?.stats?.totalExecutionsLogged || 0)) {
                    const execSide = (frame.lastSignal === "SELL" || frame.lastSignal === "BUY")
                        ? frame.lastSignal
                        : (frame.stats.positionSide === "SHORT" ? "SELL" : "BUY");
                    const execQty = frame.stats.netQuantity > 0 ? frame.stats.netQuantity : 0.001;
                    const newExec = {
                        id: `EXEC-${frame.sequenceNum}-${Date.now().toString().slice(-4)}`,
                        timestamp: now,
                        symbol: frame.symbol || "BTCUSDT",
                        side: execSide,
                        price: execSide === "BUY" ? (frame.askPrice || frame.bidPrice) : (frame.bidPrice || frame.askPrice),
                        qty: execQty,
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
function useTelemetryStore() {
    return (0, react_1.useSyncExternalStore)(subscribeTelemetry, getTelemetrySnapshot, getTelemetrySnapshot);
}
