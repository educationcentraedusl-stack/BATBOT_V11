import * as fs from "fs";

interface ParsedIncomeEvent {
  time: number;
  symbol: string;
  incomeType: string;
  income: string;
  info: string;
}

interface ParsedTradeEvent {
  time: number;
  symbol: string;
  side: string;
  positionSide: string;
  price: string;
  qty: string;
  realizedPnl: string;
  commission: string;
  maker: boolean;
  orderId: number;
}

interface ParsedOrderEvent {
  time: number;
  symbol: string;
  side: string;
  positionSide: string;
  type: string;
  origType: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  status: string;
  timeInForce: string;
  orderId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIncomeEvent(v: unknown): v is ParsedIncomeEvent {
  return isRecord(v) && typeof v["time"] === "number" && typeof v["symbol"] === "string" && typeof v["incomeType"] === "string";
}

function isTradeEvent(v: unknown): v is ParsedTradeEvent {
  return isRecord(v) && typeof v["time"] === "number" && typeof v["symbol"] === "string" && typeof v["orderId"] === "number";
}

function isOrderEvent(v: unknown): v is ParsedOrderEvent {
  return isRecord(v) && typeof v["time"] === "number" && typeof v["symbol"] === "string" && typeof v["type"] === "string" && typeof v["orderId"] === "number";
}

function parseLog() {
  const logContent = fs.readFileSync("C:/Users/SMART PLUS/.gemini/antigravity-ide/brain/3f60ccb6-1145-44a0-a4a7-c544bfb2e603/.system_generated/tasks/task-69.log", "utf8");

  // Extract income section
  const incomeMatch = logContent.match(/>>> RECENT INCOME \/ REALIZED PNL \/ COMMISSION HISTORY <<<\s*(\[\s*[\s\S]*?\])\s*>>>/);
  const parsedIncomeRaw: unknown = incomeMatch ? JSON.parse(incomeMatch[1]) : [];
  const income: ParsedIncomeEvent[] = Array.isArray(parsedIncomeRaw) ? parsedIncomeRaw.filter(isIncomeEvent) : [];

  // Extract all user trade JSON arrays
  const tradeMatches = logContent.matchAll(/--- Symbol: (\w+) \(\d+ trades found\) ---\s*(\[\s*[\s\S]*?\])\s*(?=--- Symbol:|\n>>> ALL ORDERS)/g);
  const allTrades: ParsedTradeEvent[] = [];
  for (const match of tradeMatches) {
    try {
      const parsed: unknown = JSON.parse(match[2]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isTradeEvent(item)) allTrades.push(item);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[parseLog] Failed parsing trades block: ${msg}`);
    }
  }

  // Extract all orders
  const orderMatches = logContent.matchAll(/--- Orders for (\w+) \(\d+ orders found\) ---\s*(\[\s*[\s\S]*?\])\s*(?=--- Orders for|$)/g);
  const allOrders: ParsedOrderEvent[] = [];
  for (const match of orderMatches) {
    try {
      const parsed: unknown = JSON.parse(match[2]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isOrderEvent(item)) allOrders.push(item);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[parseLog] Failed parsing orders block: ${msg}`);
    }
  }

  // Sort trades by timestamp
  allTrades.sort((a, b) => a.time - b.time);
  allOrders.sort((a, b) => a.time - b.time);

  console.log(`Parsed ${String(income.length)} income items, ${String(allTrades.length)} trades, ${String(allOrders.length)} orders.`);

  // Get the most recent 20 trades
  const recentTrades = allTrades.slice(-25);
  console.log("\n================ RECENT TRADES (CHRONOLOGICAL) ================");
  for (const t of recentTrades) {
    const d = new Date(t.time).toISOString();
    console.log(`[${d}] ${t.symbol.padEnd(8)} | Side: ${t.side.padEnd(4)} | PosSide: ${t.positionSide.padEnd(5)} | Px: ${t.price.padEnd(10)} | Qty: ${t.qty.padEnd(8)} | RealizedPnL: ${t.realizedPnl.padEnd(12)} | Comm: ${t.commission.padEnd(10)} | Maker: ${String(t.maker)} | OrderId: ${String(t.orderId)}`);
  }

  // Correlate with recent income
  console.log("\n================ RECENT INCOME / PNL EVENTS ================");
  for (const inc of income.slice(-25)) {
    const d = new Date(inc.time).toISOString();
    console.log(`[${d}] ${inc.symbol.padEnd(8)} | Type: ${inc.incomeType.padEnd(14)} | Amount: ${inc.income.padEnd(12)} | Info: ${inc.info}`);
  }

  // Recent orders
  console.log("\n================ RECENT ORDERS ================");
  for (const o of allOrders.slice(-25)) {
    const d = new Date(o.time).toISOString();
    console.log(`[${d}] ${o.symbol.padEnd(8)} | Side: ${o.side.padEnd(4)} | PosSide: ${o.positionSide.padEnd(5)} | Type: ${o.type.padEnd(10)} | OrigType: ${o.origType.padEnd(10)} | Px: ${o.price.padEnd(8)} | AvgPx: ${o.avgPrice.padEnd(8)} | Qty: ${o.origQty.padEnd(6)} | ExecQty: ${o.executedQty.padEnd(6)} | Status: ${o.status.padEnd(8)} | TIF: ${o.timeInForce} | OrderId: ${String(o.orderId)}`);
  }
}

parseLog();
