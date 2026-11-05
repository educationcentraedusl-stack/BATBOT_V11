require("dotenv").config();
const { BinanceExecutionClient } = require("../dist/execution/binance.js");

const symbols = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT",
  "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT"
];

async function forensicScan() {
  const client = new BinanceExecutionClient();
  console.log("=== STARTING FORENSIC SCAN ON BINANCE API ===");
  console.log(`Configured: ${client.isConfigured()}, Testnet: ${client.getIsTestnet?.() ?? "N/A"}`);

  for (const sym of symbols) {
    try {
      const trades = await client.getUserTrades(sym, 20);
      const orders = await client.request("GET", "/fapi/v1/allOrders", { symbol: sym, limit: 20 }, true).catch(e => ({ error: e.message }));
      const income = await client.getIncomeHistory(sym, undefined, undefined, undefined, 20).catch(e => []);

      const hasTrades = Array.isArray(trades) && trades.length > 0;
      const hasOrders = Array.isArray(orders) && orders.length > 0;
      const hasIncome = Array.isArray(income) && income.length > 0;

      if (hasTrades || hasOrders || hasIncome) {
        console.log(`\n================== SYMBOL: ${sym} ==================`);
        if (hasTrades) {
          console.log(`>>> TRADES (${trades.length}):`);
          console.log(JSON.stringify(trades, null, 2));
        }
        if (hasOrders) {
          console.log(`>>> ORDERS (${orders.length}):`);
          console.log(JSON.stringify(orders, null, 2));
        }
        if (hasIncome) {
          console.log(`>>> INCOME (${income.length}):`);
          console.log(JSON.stringify(income, null, 2));
        }
      }
    } catch (err) {
      console.error(`Error querying ${sym}:`, err.message);
    }
  }

  // Also query global income history without symbol filter
  try {
    const globalIncome = await client.getIncomeHistory(undefined, undefined, undefined, undefined, 30);
    console.log("\n================== GLOBAL INCOME (LAST 30) ==================");
    console.log(JSON.stringify(globalIncome, null, 2));
  } catch (err) {
    console.error("Error querying global income:", err.message);
  }

  // Query position risk
  try {
    const pos = await client.getPositionRisk();
    const activePos = pos.filter(p => parseFloat(p.positionAmt) !== 0);
    console.log("\n================== ACTIVE POSITIONS ==================");
    console.log(JSON.stringify(activePos, null, 2));
  } catch (err) {
    console.error("Error querying positions:", err.message);
  }

  console.log("\n=== FORENSIC SCAN COMPLETE ===");
  process.exit(0);
}

forensicScan().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
