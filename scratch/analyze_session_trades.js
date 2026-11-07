require("dotenv").config();
const fs = require("fs");

// Let's parse all trade events from the session
// Start of session was approximately 1793890558000 (around 8:25:58 PM)
const sessionStart = 1793880000000; // Look back earlier too

const { BinanceExecutionClient } = require("../dist/execution/binance.js");

async function analyze() {
  const client = new BinanceExecutionClient();
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT"];
  
  const allTrades = [];
  const allOrders = [];
  const allIncome = [];

  for (const sym of symbols) {
    try {
      const trades = await client.getUserTrades(sym, 50);
      if (Array.isArray(trades)) allTrades.push(...trades);
      const orders = await client.request("GET", "/fapi/v1/allOrders", { symbol: sym, limit: 50 }, true);
      if (Array.isArray(orders)) allOrders.push(...orders);
      const income = await client.getIncomeHistory(sym, undefined, undefined, undefined, 50);
      if (Array.isArray(income)) allIncome.push(...income);
    } catch (e) {
      console.error(sym, e.message);
    }
  }

  // Filter to today's session
  const recentTrades = allTrades.sort((a, b) => a.time - b.time);
  const recentOrders = allOrders.sort((a, b) => a.time - b.time);
  const recentIncome = allIncome.sort((a, b) => a.time - b.time);

  console.log("=== RECENT ORDERS ===");
  recentOrders.forEach(o => {
    if (o.time > 1793860000000) {
      console.log(`[${new Date(o.time).toISOString()}] ${o.symbol} ${o.side} ${o.positionSide} ${o.type} qty=${o.origQty} px=${o.price} avgPx=${o.avgPrice} status=${o.status} clientOrderId=${o.clientOrderId} id=${o.orderId}`);
    }
  });

  console.log("\n=== RECENT TRADES ===");
  recentTrades.forEach(t => {
    if (t.time > 1793860000000) {
      console.log(`[${new Date(t.time).toISOString()}] ${t.symbol} ${t.side} ${t.positionSide} qty=${t.qty} px=${t.price} pnl=${t.realizedPnl} comm=${t.commission} orderId=${t.orderId} id=${t.id} maker=${t.maker}`);
    }
  });

  console.log("\n=== RECENT INCOME (REALIZED_PNL & COMMISSION) ===");
  recentIncome.forEach(inc => {
    if (inc.time > 1793860000000) {
      console.log(`[${new Date(inc.time).toISOString()}] ${inc.symbol} ${inc.incomeType} amount=${inc.income} info=${inc.info} tradeId=${inc.tradeId}`);
    }
  });
}

analyze().catch(console.error);

