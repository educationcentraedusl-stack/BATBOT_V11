const fs = require("fs");
require("dotenv").config();
const { BinanceExecutionClient } = require("../dist/execution/binance.js");

async function checkAll() {
  const client = new BinanceExecutionClient();
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT"];
  
  const allTrades = [];
  const allOrders = [];
  const allIncome = [];

  for (const sym of symbols) {
    const trades = await client.getUserTrades(sym, 100);
    if (Array.isArray(trades)) allTrades.push(...trades);
    const orders = await client.request("GET", "/fapi/v1/allOrders", { symbol: sym, limit: 100 }, true);
    if (Array.isArray(orders)) allOrders.push(...orders);
    const income = await client.getIncomeHistory(sym, undefined, undefined, undefined, 100);
    if (Array.isArray(income)) allIncome.push(...income);
  }

  // Group fills by orderId
  const orderMap = new Map();
  allOrders.forEach(o => orderMap.set(o.orderId, o));

  console.log("=== ALL CLOSED POSITIONS (TODAY) ===");
  // Match entries and exits
  // Income records of type REALIZED_PNL
  const pnlIncomes = allIncome.filter(i => i.incomeType === "REALIZED_PNL").sort((a, b) => a.time - b.time);
  
  let cumRealized = 0;
  pnlIncomes.forEach((inc, idx) => {
    const trade = allTrades.find(t => String(t.id) === String(inc.tradeId) || String(t.id) === String(inc.info));
    const order = trade ? orderMap.get(trade.orderId) : null;
    const pnl = parseFloat(inc.income);
    cumRealized += pnl;
    console.log(`[#${idx + 1}] Time: ${new Date(inc.time).toISOString()} | Sym: ${inc.symbol} | Realized PnL: ${pnl.toFixed(4)} | Cum PnL: ${cumRealized.toFixed(4)} | TradeId: ${inc.tradeId} | OrderId: ${trade?.orderId} | CID: ${order?.clientOrderId} | Side: ${order?.side} ${order?.positionSide}`);
  });
}

checkAll().catch(console.error);

