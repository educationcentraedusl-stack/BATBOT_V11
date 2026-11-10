import * as fs from "fs";

interface PrintedTradeRecord {
  time: number;
}

function isPrintedTradeRecord(v: unknown): v is PrintedTradeRecord {
  return typeof v === "object" && v !== null && typeof (v as { time?: unknown }).time === "number";
}

function printUserTrades() {
  const logContent = fs.readFileSync("C:/Users/SMART PLUS/.gemini/antigravity-ide/brain/3f60ccb6-1145-44a0-a4a7-c544bfb2e603/.system_generated/tasks/task-69.log", "utf8");

  const tradeMatches = logContent.matchAll(/--- Symbol: (\w+) \(\d+ trades found\) ---\s*(\[\s*[\s\S]*?\])\s*(?=--- Symbol:|\n>>> ALL ORDERS)/g);
  const allTrades: PrintedTradeRecord[] = [];
  for (const match of tradeMatches) {
    try {
      const parsed: unknown = JSON.parse(match[2]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isPrintedTradeRecord(item)) allTrades.push(item);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[printUserTrades] Failed parsing trades block: ${msg}`);
    }
  }
  allTrades.sort((a, b) => a.time - b.time);

  console.log("LAST 15 TRADES:");
  for (const t of allTrades.slice(-15)) {
    console.log(JSON.stringify(t));
  }
}

printUserTrades();
