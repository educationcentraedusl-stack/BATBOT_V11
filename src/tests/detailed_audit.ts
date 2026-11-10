import * as fs from "fs";

interface AuditTradeRecord {
  time: number;
  symbol: string;
  id: number;
  orderId: number;
  side: string;
  positionSide: string;
  price: string;
  qty: string;
  quoteQty: string;
  realizedPnl: string;
  commission: string;
  commissionAsset: string;
  maker: boolean;
  buyer: boolean;
}

interface AuditOrderRecord {
  time: number;
  symbol: string;
  orderId: number;
  clientOrderId: string;
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
  reduceOnly: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuditTradeRecord(value: unknown): value is AuditTradeRecord {
  return (
    isRecord(value) &&
    typeof value["time"] === "number" &&
    typeof value["symbol"] === "string" &&
    typeof value["id"] === "number" &&
    typeof value["orderId"] === "number"
  );
}

function isAuditOrderRecord(value: unknown): value is AuditOrderRecord {
  return (
    isRecord(value) &&
    typeof value["time"] === "number" &&
    typeof value["symbol"] === "string" &&
    typeof value["orderId"] === "number" &&
    typeof value["clientOrderId"] === "string"
  );
}

function detailedAudit() {
  const logContent = fs.readFileSync("C:/Users/SMART PLUS/.gemini/antigravity-ide/brain/3f60ccb6-1145-44a0-a4a7-c544bfb2e603/.system_generated/tasks/task-69.log", "utf8");

  // Extract all user trade JSON arrays
  const tradeMatches = logContent.matchAll(/--- Symbol: (\w+) \(\d+ trades found\) ---\s*(\[\s*[\s\S]*?\])\s*(?=--- Symbol:|\n>>> ALL ORDERS)/g);
  const allTrades: AuditTradeRecord[] = [];
  for (const match of tradeMatches) {
    try {
      const parsed: unknown = JSON.parse(match[2]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isAuditTradeRecord(item)) {
            allTrades.push(item);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[detailedAudit] Failed to parse trade JSON block: ${msg}`);
    }
  }

  // Extract all orders
  const orderMatches = logContent.matchAll(/--- Orders for (\w+) \(\d+ orders found\) ---\s*(\[\s*[\s\S]*?\])\s*(?=--- Orders for|$)/g);
  const allOrders: AuditOrderRecord[] = [];
  for (const match of orderMatches) {
    try {
      const parsed: unknown = JSON.parse(match[2]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isAuditOrderRecord(item)) {
            allOrders.push(item);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[detailedAudit] Failed to parse order JSON block: ${msg}`);
    }
  }

  allTrades.sort((a, b) => a.time - b.time);
  allOrders.sort((a, b) => a.time - b.time);

  // Group trades by closed position cycles
  console.log("ALL RECENT USER TRADES (Last 30):");
  for (const t of allTrades.slice(-30)) {
    const d = new Date(t.time).toISOString();
    console.log(JSON.stringify({
      time: d,
      symbol: t.symbol,
      id: t.id,
      orderId: t.orderId,
      side: t.side,
      posSide: t.positionSide,
      price: parseFloat(t.price),
      qty: parseFloat(t.qty),
      quoteQty: parseFloat(t.quoteQty),
      realizedPnl: parseFloat(t.realizedPnl),
      commission: parseFloat(t.commission),
      commissionAsset: t.commissionAsset,
      maker: t.maker,
      buyer: t.buyer
    }));
  }

  console.log("\nALL RECENT ORDERS (Last 30):");
  for (const o of allOrders.slice(-30)) {
    const d = new Date(o.time).toISOString();
    console.log(JSON.stringify({
      time: d,
      symbol: o.symbol,
      orderId: o.orderId,
      clientOrderId: o.clientOrderId,
      side: o.side,
      posSide: o.positionSide,
      type: o.type,
      origType: o.origType,
      price: parseFloat(o.price),
      avgPrice: parseFloat(o.avgPrice),
      origQty: parseFloat(o.origQty),
      executedQty: parseFloat(o.executedQty),
      status: o.status,
      timeInForce: o.timeInForce,
      reduceOnly: o.reduceOnly
    }));
  }
}

detailedAudit();
