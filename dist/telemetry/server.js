"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelemetryWSServer = void 0;
const ws_1 = require("ws");
class TelemetryWSServer {
    wss = null;
    port;
    clients = new Set();
    lastBroadcastTime = 0;
    broadcastIntervalMs = 100; // Throttle broadcasts to 10Hz max
    constructor(port = 8080) {
        this.port = port;
    }
    start() {
        if (this.wss)
            return;
        try {
            this.wss = new ws_1.WebSocketServer({ port: this.port });
            this.wss.on("connection", (ws) => {
                this.clients.add(ws);
                ws.on("close", () => {
                    this.clients.delete(ws);
                });
                ws.on("error", (err) => {
                    console.error(`[TelemetryWSServer] Client socket error: ${err.message}`);
                    this.clients.delete(ws);
                });
                // Send initial handshake message
                if (ws.readyState === ws_1.WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: "INIT",
                        message: "BATBOT_V11 Telemetry Stream Connected",
                        timestamp: Date.now(),
                    }));
                }
            });
            this.wss.on("error", (err) => {
                console.error(`[TelemetryWSServer] Server error: ${err.message}`);
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[TelemetryWSServer] Failed to start server on port ${this.port}: ${msg}`);
        }
    }
    /**
     * Non-blocking broadcast of telemetry frame to connected clients.
     */
    broadcast(frame) {
        if (!this.wss || this.clients.size === 0)
            return;
        const now = Date.now();
        if (now - this.lastBroadcastTime < this.broadcastIntervalMs) {
            return;
        }
        this.lastBroadcastTime = now;
        // Convert BigInt to string for JSON serialization
        const payload = JSON.stringify({
            type: "TELEMETRY",
            data: {
                ...frame,
                sequenceNum: frame.sequenceNum.toString(),
            },
            timestamp: now,
        });
        for (const client of this.clients) {
            if (client.readyState === ws_1.WebSocket.OPEN) {
                client.send(payload, (err) => {
                    if (err) {
                        this.clients.delete(client);
                    }
                });
            }
        }
    }
    getConnectedClientCount() {
        return this.clients.size;
    }
    stop() {
        return new Promise((resolve) => {
            if (!this.wss) {
                resolve();
                return;
            }
            for (const client of this.clients) {
                try {
                    client.close();
                }
                catch {
                    // Ignore close errors
                }
            }
            this.clients.clear();
            this.wss.close(() => {
                this.wss = null;
                resolve();
            });
        });
    }
}
exports.TelemetryWSServer = TelemetryWSServer;
