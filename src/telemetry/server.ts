import { WebSocketServer, WebSocket } from "ws";
import { TelemetryFrame } from "./dashboard";

export class TelemetryWSServer {
  private wss: WebSocketServer | null = null;
  private port: number;
  private clients: Set<WebSocket> = new Set();
  private lastBroadcastTime = 0;
  private broadcastIntervalMs = 100; // Throttle broadcasts to 10Hz max

  constructor(port: number = 8080) {
    this.port = port;
  }

  public start(): void {
    if (this.wss) return;

    try {
      this.wss = new WebSocketServer({ port: this.port });

      this.wss.on("connection", (ws: WebSocket) => {
        this.clients.add(ws);

        ws.on("close", () => {
          this.clients.delete(ws);
        });

        ws.on("error", (err) => {
          console.error(`[TelemetryWSServer] Client socket error: ${err.message}`);
          this.clients.delete(ws);
        });

        // Send initial handshake message
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "INIT",
              message: "BATBOT_V11 Telemetry Stream Connected",
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
   * Non-blocking broadcast of telemetry frame to connected clients.
   */
  public broadcast(frame: TelemetryFrame): void {
    if (!this.wss || this.clients.size === 0) return;

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
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload, (err) => {
          if (err) {
            this.clients.delete(client);
          }
        });
      }
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
