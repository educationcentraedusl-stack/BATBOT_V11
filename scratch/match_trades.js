const fs = require("fs");

// Load the output.txt from forensic fetch
const raw = fs.readFileSync("C:\\Users\\SMART PLUS\\.gemini\\antigravity\\brain\\3798c0e1-8b28-4582-8e1a-52371ce1e007\\.system_generated\\steps\\65\\output.txt", "utf8");

// Parse trades, orders, income from output.txt
// Let's run a script that uses the Binance API client directly to get 100% full detail
require("dotenv").config();
const { BinanceExecutionClient } = require("../dist/execution/binance.js");

async function run() {
  const client = new BinanceExecutionClient();
  const symbols = ["BTCUSDT", "ETHUSDT", "DOGEUSDT", "XRPUSDT", "BNBUSDT"];

  for (const sym of symbols) {
    const trades = await client.getUserTrades(sym, 50);
    const orders = await client.request("GET", "/fapi/v1/allOrders", { symbol: sym, limit: 50 }, true);
    const income = await client.getIncomeHistory(sym, undefined, undefined, undefined, 50);

    // Filter to orders/trades since 1793880000000
    const filteredOrders = orders.filter(o => o.time >= 1793880000000 || o.updateTime >= 1793880000000);
    const filteredTrades = trades.filter(t => t.time >= 1793880000000);
    const filteredIncome = income.filter(i => i.time >= 1793880000000);

    if (filteredTrades.length > 0 || filteredOrders.length > 0) {
      console.log(`\n============================ ${sym} ============================`);
      console.log("--- ORDERS ---");
      filteredOrders.forEach(o => {
        console.log(`Order #${o.orderId} | ${o.side} ${o.positionSide} ${o.type} | Qty: ${o.origQty} (Exec: ${o.executedQty}) | Price: ${o.price} (Avg: ${o.avgPrice}) | Status: ${o.status} | Time: ${new Date(o.time).toISOString()} | Update: ${new Date(o.updateTime).toISOString()} | CID: ${o.clientOrderId}`);
      });

      console.log("--- TRADES (FILLS) ---");
      filteredTrades.forEach(t => {
        console.log(`Trade #${t.id} (Order #${t.orderId}) | ${t.side} ${t.positionSide} | Qty: ${t.qty} @ ${t.price} | Maker: ${t.maker} | PnL: ${t.realizedPnl} | Fee: ${t.commission} ${t.commissionAsset} | Time: ${new Date(t.time).toISOString()}`);
      });

      console.log("--- INCOME ---");
      filteredIncome.forEach(i => {
        console.log(`Income: ${i.incomeType} | Amount: ${i.income} USDT | Time: ${new Date(i.time).toISOString()} | TradeId: ${i.tradeId}`);
      });
    }
  }
}

run().catch(console.error);
