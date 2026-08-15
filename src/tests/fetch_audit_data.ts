import "dotenv/config";
import { BinanceExecutionClient } from "../execution/binance";
import { getTradingSymbols } from "../config/tradingSymbols";

async function main() {
  const client = new BinanceExecutionClient();
  const symbols = getTradingSymbols();
  console.log("=========================================================================");
  console.log("              BATBOT_V11 LIVE TRADE AUDIT EXTRACTION TOOL                ");
  console.log("=========================================================================");

  // 1. Fetch Income History (Realized PnL & Commission)
  try {
    const income = await (client as any).request("GET", "/fapi/v1/income", { limit: 30 }, true);
    console.log("\n>>> RECENT INCOME / REALIZED PNL / COMMISSION HISTORY <<<");
    console.log(JSON.stringify(income, null, 2));
  } catch (err: any) {
    console.error("Income fetch error:", err.message);
  }

  // 2. Fetch User Trades for all active symbols
  console.log("\n>>> USER TRADES ACROSS ACTIVE SYMBOLS <<<");
  for (const sym of symbols) {
    try {
      const trades = await (client as any).request("GET", "/fapi/v1/userTrades", { symbol: sym, limit: 20 }, true);
      if (trades && trades.length > 0) {
        console.log(`\n--- Symbol: ${sym} (${trades.length} trades found) ---`);
        console.log(JSON.stringify(trades, null, 2));
      }
    } catch (err: any) {
      console.error(`UserTrades fetch error for ${sym}:`, err.message);
    }
  }

  // 3. Fetch All Orders for all active symbols
  console.log("\n>>> ALL ORDERS ACROSS ACTIVE SYMBOLS <<<");
  for (const sym of symbols) {
    try {
      const orders = await (client as any).request("GET", "/fapi/v1/allOrders", { symbol: sym, limit: 15 }, true);
      if (orders && orders.length > 0) {
        console.log(`\n--- Orders for ${sym} (${orders.length} orders found) ---`);
        console.log(JSON.stringify(orders, null, 2));
      }
    } catch (err: any) {
      console.error(`AllOrders fetch error for ${sym}:`, err.message);
    }
  }
}

main().catch(console.error);
