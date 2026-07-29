import * as fs from "fs";
import * as path from "path";

export interface ClosedTradeRecord {
  timestamp?: number;
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  durationMs: number;
  roePercent: number;
  pnlUsdt: number;
}

export class CsvTradeLogger {
  private filePath: string;
  private isInitialized: boolean = false;

  constructor(outputDir: string = "data", fileName: string = "trade_history.csv") {
    const dir = path.resolve(process.cwd(), outputDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, fileName);
    this.ensureHeader();
  }

  private ensureHeader(): void {
    if (!fs.existsSync(this.filePath)) {
      const headers = "Time,Symbol,Side,Size,Entry Price,Exit Price,Exit Reason,Duration,ROE %,PnL USDT\n";
      try {
        fs.writeFileSync(this.filePath, headers, "utf8");
      } catch (err: any) {
        console.error(`[CsvTradeLogger] Error initializing CSV header: ${err.message}`);
      }
    }
    this.isInitialized = true;
  }

  /**
   * Non-blocking async append of a completely closed trade row.
   * Format: Time,Symbol,Side,Size,Entry Price,Exit Price,Exit Reason,Duration,ROE %,PnL USDT
   */
  public logClosedTrade(record: ClosedTradeRecord): void {
    const timeStr = formatDate(record.timestamp ?? Date.now());
    const durationStr = formatDuration(record.durationMs);
    const row = [
      timeStr,
      record.symbol,
      record.side,
      record.size.toFixed(4),
      record.entryPrice.toFixed(2),
      record.exitPrice.toFixed(2),
      record.exitReason,
      durationStr,
      record.roePercent.toFixed(2),
      record.pnlUsdt.toFixed(4),
    ].join(",") + "\n";

    // Non-blocking async appendFile to avoid blocking HFT execution loop
    fs.appendFile(this.filePath, row, "utf8", (err) => {
      if (err) {
        console.error(`[CsvTradeLogger] Error appending closed trade row: ${err.message}`);
      }
    });
  }

  public getFilePath(): string {
    return this.filePath;
  }
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.max(0, durationMs)}ms`;
  }
  const sec = (durationMs / 1000).toFixed(1);
  return `${sec}s`;
}
