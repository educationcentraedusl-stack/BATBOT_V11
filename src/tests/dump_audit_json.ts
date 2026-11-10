import "dotenv/config";
import { BinanceExecutionClient } from "../execution/binance";
import { getTradingSymbols } from "../config/tradingSymbols";
import * as fs from "fs";

interface TimedAuditRecord {
  time: number;
}

class ForensicAuditClient extends BinanceExecutionClient {
  public fetchSignedEndpoint<T>(
    endpoint: string,
    params: Record<string, string | number | boolean>
  ): Promise<T> {
    return this.request<T>("GET", endpoint, params, true);
  }
}

async function main() {
  const client = new ForensicAuditClient();
  const symbols = getTradingSymbols();

  // 1. Fetch Income History
  const income = await client.fetchSignedEndpoint<TimedAuditRecord[]>("/fapi/v1/income", { limit: 50 });

  // 2. Fetch User Trades
  const allTrades: TimedAuditRecord[] = [];
  for (const sym of symbols) {
    try {
      const trades = await client.fetchSignedEndpoint<TimedAuditRecord[]>("/fapi/v1/userTrades", {
        symbol: sym,
        limit: 30,
      });
      if (Array.isArray(trades) && trades.length > 0) {
        allTrades.push(...trades);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[dump_audit_json] Failed fetching userTrades for ${sym}: ${msg}`);
    }
  }
  allTrades.sort((a, b) => a.time - b.time);

  // 3. Fetch All Orders
  const allOrders: TimedAuditRecord[] = [];
  for (const sym of symbols) {
    try {
      const orders = await client.fetchSignedEndpoint<TimedAuditRecord[]>("/fapi/v1/allOrders", {
        symbol: sym,
        limit: 30,
      });
      if (Array.isArray(orders) && orders.length > 0) {
        allOrders.push(...orders);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[dump_audit_json] Failed fetching allOrders for ${sym}: ${msg}`);
    }
  }
  allOrders.sort((a, b) => a.time - b.time);

  const report = {
    income,
    allTrades,
    allOrders,
  };

  fs.writeFileSync("d:/AI Trading Bot/Trading Bot Virsions/BATBOT_V11-Antigravity/BATBOT_V11/data/live_forensic_audit_dump.json", JSON.stringify(report, null, 2));
  console.log(`Saved ${String(allTrades.length)} trades, ${String(allOrders.length)} orders, and ${String(income.length)} income events to live_forensic_audit_dump.json`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
