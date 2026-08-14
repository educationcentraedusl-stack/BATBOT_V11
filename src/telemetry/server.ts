import { WebSocketServer, WebSocket } from "ws";
import { TelemetryFrame } from "./dashboard";
import { encodeTelemetryFrame, decodeControlCommand, ControlCommand, encodeControlResponse } from "./proto";

export type ControlCommandHandler = (cmd: ControlCommand) => Promise<{ success: boolean; message: string }>;

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

  public start(): void {
    if (this.wss) return;

    try {
      this.wss = new WebSocketServer({ port: this.port });

      this.wss.on("connection", (ws: WebSocket) => {
        this.clients.add(ws);

        ws.on("message", async (data: Buffer | ArrayBuffer) => {
          try {
            let cmd: ControlCommand;
            const isJson = typeof data === "string" || (Buffer.isBuffer(data) && data[0] === 123 /* '{' */);
            if (isJson) {
              const parsedJson = JSON.parse(data.toString());
              cmd = {
                action: parsedJson.action,
                modelPath: parsedJson.modelPath,
                timestamp: parsedJson.timestamp,
              };
            } else {
              const buf = new Uint8Array(data as ArrayBuffer);
              // Strict binary Protobuf control command decoding
              cmd = decodeControlCommand(buf);
            }

            if (this.commandHandler) {
              const res = await this.commandHandler(cmd);
              if (ws.readyState === WebSocket.OPEN) {
                if (isJson) {
                  ws.send(JSON.stringify({ success: res.success, action: cmd.action, message: res.message, timestamp: Date.now() }));
                } else {
                  const responseBuf = encodeControlResponse(res.success, cmd.action, res.message);
                  ws.send(responseBuf);
                }
              }
            }
          } catch (err: any) {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TelemetryWSServer] Failed to start server on port ${this.port}: ${msg}`);
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
    } catch (err: any) {
      console.error(`[TelemetryWSServer] Frame broadcast encoding error: ${err.message}`);
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
        } catch {
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
