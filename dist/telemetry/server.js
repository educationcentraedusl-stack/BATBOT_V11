"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelemetryWSServer = void 0;
const ws_1 = require("ws");
const proto_1 = require("./proto");
class TelemetryWSServer {
    wss = null;
    port;
    clients = new Set();
    lastBroadcastTime = 0;
    broadcastIntervalMs = 16; // 60Hz streaming (16.6ms) for ultra-low latency canvas updates
    commandHandler = null;
    constructor(port = 8080) {
        this.port = port;
    }
    setCommandHandler(handler) {
        this.commandHandler = handler;
    }
    start() {
        if (this.wss)
            return;
        try {
            this.wss = new ws_1.WebSocketServer({ port: this.port });
            this.wss.on("connection", (ws) => {
                this.clients.add(ws);
                ws.on("message", async (data) => {
                    try {
                        const buf = new Uint8Array(data);
                        // Strict binary Protobuf control command decoding
                        const cmd = (0, proto_1.decodeControlCommand)(buf);
                        if (this.commandHandler) {
                            const res = await this.commandHandler(cmd);
                            if (ws.readyState === ws_1.WebSocket.OPEN) {
                                const responseBuf = (0, proto_1.encodeControlResponse)(res.success, cmd.action, res.message);
                                ws.send(responseBuf);
                            }
                        }
                    }
                    catch (err) {
                        console.error(`[TelemetryWSServer] RPC processing error: ${err.message}`);
                    }
                });
                ws.on("close", () => {
                    this.clients.delete(ws);
                });
                ws.on("error", (err) => {
                    console.error(`[TelemetryWSServer] Client socket error: ${err.message}`);
                    this.clients.delete(ws);
                });
                // Send initial JSON handshake message
                if (ws.readyState === ws_1.WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: "INIT",
                        message: "BATBOT_V11 Protobuf Telemetry & Control Stream Connected",
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
     * High-frequency binary Protobuf broadcast to all connected clients.
     */
    broadcast(frame) {
        if (!this.wss || this.clients.size === 0)
            return;
        const now = Date.now();
        if (now - this.lastBroadcastTime < this.broadcastIntervalMs) {
            return;
        }
        this.lastBroadcastTime = now;
        try {
            const binaryPayload = (0, proto_1.encodeTelemetryFrame)(frame, now);
            for (const client of this.clients) {
                if (client.readyState === ws_1.WebSocket.OPEN) {
                    client.send(binaryPayload, (err) => {
                        if (err) {
                            this.clients.delete(client);
                        }
                    });
                }
            }
        }
        catch (err) {
            console.error(`[TelemetryWSServer] Frame broadcast encoding error: ${err.message}`);
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
