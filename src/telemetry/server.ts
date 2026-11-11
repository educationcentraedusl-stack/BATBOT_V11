import WebSocket, { WebSocketServer } from "ws";
import type { TelemetryFrame } from "./types";
import { encodeTelemetryFrame, decodeControlCommand, ControlCommand, encodeControlResponse } from "./proto";

export type ControlCommandHandler = (cmd: ControlCommand) => Promise<{ success: boolean; message: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlAction(value: unknown): value is ControlCommand["action"] {
  return (
    value === "ENGINE_START" ||
    value === "ENGINE_PAUSE" ||
    value === "EMERGENCY_KILL" ||
    value === "AI_HOT_SWAP"
  );
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

export class TelemetryWSServer {
  private wss: WebSocketServer | null = null;
  private port: number;
  private clients: Set<WebSocket> = new Set();
  private lastBroadcastTime = 0;
  private broadcastIntervalMs = 16; // 60Hz streaming (16.6ms) for ultra-low latency canvas updates
  private commandHandler: ControlCommandHandler | null = null;

  constructor(port: number = 8080) {
    this.port = port;
  }

  public setCommandHandler(handler: ControlCommandHandler): void {
    this.commandHandler = handler;
  }

  private async handleClientMessage(ws: WebSocket, data: WebSocket.RawData): Promise<void> {
    try {
      let cmd: ControlCommand;
      const rawBuf = rawDataToBuffer(data);
      const isJson = rawBuf.length > 0 && rawBuf[0] === 123; /* '{' */

      if (isJson) {
        const parsedJson: unknown = JSON.parse(rawBuf.toString("utf8"));
        if (!isRecord(parsedJson) || !isControlAction(parsedJson["action"])) {
          throw new Error("Invalid JSON control command payload");
        }
        const rawModelPath = parsedJson["modelPath"];
        const rawTimestamp = parsedJson["timestamp"];
        cmd = {
          action: parsedJson["action"],
          modelPath: typeof rawModelPath === "string" ? rawModelPath : undefined,
          timestamp:
            typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp)
              ? rawTimestamp
              : undefined,
        };
      } else {
        const buf = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
        // Strict binary Protobuf control command decoding
        cmd = decodeControlCommand(buf);
      }

      if (this.commandHandler) {
        const res = await this.commandHandler(cmd);
        if (ws.readyState === WebSocket.OPEN) {
          if (isJson) {
            ws.send(JSON.stringify({ success: res.success, action: cmd.action, message: res.message, timestamp: Date.now() }));
          } else {
            const responseBuf = encodeControlResponse(res.success, cmd.action, res.message, Date.now());
            ws.send(responseBuf);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TelemetryWSServer] RPC processing error: ${msg}`);
    }
  }

  public start(): void {
    if (this.wss) return;

    try {
      this.wss = new WebSocketServer({ port: this.port });

      this.wss.on("connection", (ws: WebSocket) => {
        this.clients.add(ws);

        ws.on("message", (data: WebSocket.RawData) => {
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
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "INIT",
              message: "BATBOT_V11 Protobuf Telemetry & Control Stream Connected",
              timestamp: Date.now(),
            })
          );
        }
      });

      this.wss.on("error", (err) => {
        console.error(`[TelemetryWSServer] Server error: ${err.message}`);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TelemetryWSServer] Failed to start server on port ${String(this.port)}: ${msg}`);
    }
  }

  /**
   * High-frequency binary Protobuf broadcast to all connected clients.
   */
  public broadcast(frame: TelemetryFrame): void {
    if (!this.wss || this.clients.size === 0) return;

    const now = Date.now();
    if (now - this.lastBroadcastTime < this.broadcastIntervalMs) {
      return;
    }
    this.lastBroadcastTime = now;

    try {
      const binaryPayload = encodeTelemetryFrame(frame, now);

      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(binaryPayload, (err) => {
            if (err) {
              this.clients.delete(client);
            }
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TelemetryWSServer] Frame broadcast encoding error: ${msg}`);
    }
  }

  public getConnectedClientCount(): number {
    return this.clients.size;
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      for (const client of this.clients) {
        try {
          client.close();
        } catch (err: unknown) {
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
