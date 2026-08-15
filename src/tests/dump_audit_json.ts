import "dotenv/config";
import { BinanceExecutionClient } from "../execution/binance";
import { getTradingSymbols } from "../config/tradingSymbols";
import * as fs from "fs";

async function main() {
  const client = new BinanceExecutionClient();
  const symbols = getTradingSymbols();

  // 1. Fetch Income History
  const income = await (client as any).request("GET", "/fapi/v1/income", { limit: 50 }, true);

  // 2. Fetch User Trades
  const allTrades: any[] = [];
  for (const sym of symbols) {
    try {
      const trades = await (client as any).request("GET", "/fapi/v1/userTrades", { symbol: sym, limit: 30 }, true);
      if (trades && trades.length > 0) {
        allTrades.push(...trades);
      }
    } catch (err: any) {}
  }
  allTrades.sort((a, b) => a.time - b.time);

  // 3. Fetch All Orders
  const allOrders: any[] = [];
  for (const sym of symbols) {
    try {
      const orders = await (client as any).request("GET", "/fapi/v1/allOrders", { symbol: sym, limit: 30 }, true);
      if (orders && orders.length > 0) {
        allOrders.push(...orders);
      }
    } catch (err: any) {}
  }
  allOrders.sort((a, b) => a.time - b.time);

  const report = {
    income,
    allTrades,
    allOrders,
  };

  fs.writeFileSync("d:/AI Trading Bot/Trading Bot Virsions/BATBOT_V11-Antigravity/BATBOT_V11/data/live_forensic_audit_dump.json", JSON.stringify(report, null, 2));
  console.log(`Saved ${allTrades.length} trades, ${allOrders.length} orders, and ${income.length} income events to live_forensic_audit_dump.json`);
}

main().catch(console.error);
