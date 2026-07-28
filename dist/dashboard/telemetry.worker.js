"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Telemetry WebWorker for Off-Main-Thread Processing & 60Hz Batching
const proto_1 = require("../telemetry/proto");
let socket = null;
let latestFrame = null;
let frameQueue = [];
let batchInterval = null;
ctx().onmessage = (e) => {
    const { type, url, command } = e.data;
    if (type === "CONNECT") {
        connectWebSocket(url || "ws://localhost:8080");
    }
    else if (type === "SEND_COMMAND") {
        if (socket && socket.readyState === WebSocket.OPEN && command) {
            // Direct Protobuf binary command encoding
            const binaryCmd = (0, proto_1.encodeControlCommand)(command);
            socket.send(binaryCmd);
        }
    }
    else if (type === "DISCONNECT") {
        if (socket)
            socket.close();
    }
};
function ctx() {
    return self;
}
function connectWebSocket(url) {
    if (socket) {
        try {
            socket.close();
        }
        catch { }
    }
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
        ctx().postMessage({ type: "STATUS", status: "CONNECTED" });
    };
    socket.onmessage = (event) => {
        try {
            if (event.data instanceof ArrayBuffer) {
                // Strict binary Protobuf telemetry frame deserialization
                const decodedFrame = (0, proto_1.decodeTelemetryFrame)(new Uint8Array(event.data));
                const workerFrame = {
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
        }
        catch (err) {
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
    if (batchInterval)
        clearInterval(batchInterval);
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
