import * as fs from "fs";

function detailedAudit() {
  const logContent = fs.readFileSync("C:/Users/SMART PLUS/.gemini/antigravity-ide/brain/3f60ccb6-1145-44a0-a4a7-c544bfb2e603/.system_generated/tasks/task-69.log", "utf8");

  // Extract all user trade JSON arrays
  const tradeMatches = logContent.matchAll(/--- Symbol: (\w+) \(\d+ trades found\) ---\s*(\[\s*[\s\S]*?\])\s*(?=--- Symbol:|\n>>> ALL ORDERS)/g);
  const allTrades: any[] = [];
  for (const match of tradeMatches) {
    try {
      const parsed = JSON.parse(match[2]);
      allTrades.push(...parsed);
    } catch (e) {}
  }

  // Extract all orders
  const orderMatches = logContent.matchAll(/--- Orders for (\w+) \(\d+ orders found\) ---\s*(\[\s*[\s\S]*?\])\s*(?=--- Orders for|$)/g);
  const allOrders: any[] = [];
  for (const match of orderMatches) {
    try {
      const parsed = JSON.parse(match[2]);
      allOrders.push(...parsed);
    } catch (e) {}
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
