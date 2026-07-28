"use strict";
// Telemetry WebWorker for Off-Main-Thread Processing & 60Hz Batching
Object.defineProperty(exports, "__esModule", { value: true });
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
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(command));
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
            if (typeof event.data === "string") {
                const json = JSON.parse(event.data);
                if (json.type === "INIT") {
                    ctx().postMessage({ type: "INIT_MESSAGE", message: json.message });
                    return;
                }
            }
            // Handle binary or JSON frame
            let frame;
            if (event.data instanceof ArrayBuffer) {
                // Fast text/json or binary parsing fallback
                const str = new TextDecoder().decode(event.data);
                const parsed = JSON.parse(str);
                frame = parsed.data || parsed;
            }
            else {
                frame = JSON.parse(event.data);
            }
            latestFrame = frame;
            frameQueue.push(frame);
            if (frameQueue.length > 500) {
                frameQueue.shift();
            }
        }
        catch (err) {
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
