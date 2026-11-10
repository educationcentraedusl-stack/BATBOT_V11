"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelemetryWSServer = void 0;
const ws_1 = __importStar(require("ws"));
const proto_1 = require("./proto");
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isControlAction(value) {
    return (value === "ENGINE_START" ||
        value === "ENGINE_PAUSE" ||
        value === "EMERGENCY_KILL" ||
        value === "AI_HOT_SWAP");
}
function rawDataToBuffer(data) {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data);
    }
    return Buffer.from(data);
}
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
    async handleClientMessage(ws, data) {
        try {
            let cmd;
            const rawBuf = rawDataToBuffer(data);
            const isJson = rawBuf.length > 0 && rawBuf[0] === 123; /* '{' */
            if (isJson) {
                const parsedJson = JSON.parse(rawBuf.toString("utf8"));
                if (!isRecord(parsedJson) || !isControlAction(parsedJson["action"])) {
                    throw new Error("Invalid JSON control command payload");
                }
                const rawModelPath = parsedJson["modelPath"];
                const rawTimestamp = parsedJson["timestamp"];
                cmd = {
                    action: parsedJson["action"],
                    modelPath: typeof rawModelPath === "string" ? rawModelPath : undefined,
                    timestamp: typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp)
                        ? rawTimestamp
                        : undefined,
                };
            }
            else {
                const buf = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
                // Strict binary Protobuf control command decoding
                cmd = (0, proto_1.decodeControlCommand)(buf);
            }
            if (this.commandHandler) {
                const res = await this.commandHandler(cmd);
                if (ws.readyState === ws_1.default.OPEN) {
                    if (isJson) {
                        ws.send(JSON.stringify({ success: res.success, action: cmd.action, message: res.message, timestamp: Date.now() }));
                    }
                    else {
                        const responseBuf = (0, proto_1.encodeControlResponse)(res.success, cmd.action, res.message);
                        ws.send(responseBuf);
                    }
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[TelemetryWSServer] RPC processing error: ${msg}`);
        }
    }
    start() {
        if (this.wss)
            return;
        try {
            this.wss = new ws_1.WebSocketServer({ port: this.port });
            this.wss.on("connection", (ws) => {
                this.clients.add(ws);
                ws.on("message", (data) => {
                    void this.handleClientMessage(ws, data);
                });
                ws.on("close", () => {
                    this.clients.delete(ws);
                });
                ws.on("error", (err) => {
                    console.error(`[TelemetryWSServer] Client socket error: ${err.message}`);
                    this.clients.delete(ws);
                });
                // Send initial JSON handshake message
                if (ws.readyState === ws_1.default.OPEN) {
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
            console.error(`[TelemetryWSServer] Failed to start server on port ${String(this.port)}: ${msg}`);
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
                if (client.readyState === ws_1.default.OPEN) {
                    client.send(binaryPayload, (err) => {
                        if (err) {
                            this.clients.delete(client);
                        }
                    });
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[TelemetryWSServer] Frame broadcast encoding error: ${msg}`);
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
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`[TelemetryWSServer] Client socket close notice: ${msg}`);
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
