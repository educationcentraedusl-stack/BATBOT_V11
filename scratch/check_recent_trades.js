require("dotenv").config();
const { BinanceExecutionClient } = require("../dist/execution/binance.js");

async function checkRecentTrades() {
  const client = new BinanceExecutionClient();
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT"];
  const startTime = 1793880000000; // 13:20 UTC

  console.log(`Querying all trades since ${new Date(startTime).toISOString()}...`);
  for (const sym of symbols) {
    try {
      const trades = await client.getUserTrades(sym, 100, startTime);
      const orders = await client.request("GET", "/fapi/v1/allOrders", { symbol: sym, limit: 100, startTime }, true);
      const income = await client.getIncomeHistory(sym, undefined, startTime, undefined, 100);

      if (trades.length > 0 || orders.length > 0) {
        console.log(`\n====================================== ${sym} ======================================`);
        console.log(`>>> TRADES (${trades.length}):`);
        trades.forEach(t => {
          console.log(`  Trade #${t.id} | Order #${t.orderId} | ${t.side} ${t.positionSide} | Qty: ${t.qty} @ ${t.price} | PnL: ${t.realizedPnl} | Comm: ${t.commission} | Maker: ${t.maker} | Time: ${new Date(t.time).toISOString()}`);
        });

        console.log(`>>> ORDERS (${orders.length}):`);
        orders.forEach(o => {
          console.log(`  Order #${o.orderId} | ${o.side} ${o.positionSide} ${o.type} | Qty: ${o.origQty} (Exec: ${o.executedQty}) | Price: ${o.price} (Avg: ${o.avgPrice}) | Status: ${o.status} | CID: ${o.clientOrderId} | Time: ${new Date(o.time).toISOString()}`);
        });

        console.log(`>>> INCOME (${income.length}):`);
        income.forEach(i => {
          console.log(`  Income: ${i.incomeType} | Amount: ${i.income} USDT | TradeId: ${i.tradeId} | Time: ${new Date(i.time).toISOString()}`);
        });
      }
    } catch (e) {
      console.error(`Error querying ${sym}:`, e.message);
    }
  }
}

checkRecentTrades().catch(console.error);
