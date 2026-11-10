import "dotenv/config";
import { BinanceExecutionClient } from "../execution/binance";
import { getTradingSymbols } from "../config/tradingSymbols";

class ForensicFetchClient extends BinanceExecutionClient {
  public fetchSignedEndpoint<T>(
    endpoint: string,
    params: Record<string, string | number | boolean>
  ): Promise<T> {
    return this.request<T>("GET", endpoint, params, true);
  }
}

async function main() {
  const client = new ForensicFetchClient();
  const symbols = getTradingSymbols();
  console.log("=========================================================================");
  console.log("              BATBOT_V11 LIVE TRADE AUDIT EXTRACTION TOOL                ");
  console.log("=========================================================================");

  // 1. Fetch Income History (Realized PnL & Commission)
  try {
    const income = await client.fetchSignedEndpoint<unknown[]>("/fapi/v1/income", { limit: 30 });
    console.log("\n>>> RECENT INCOME / REALIZED PNL / COMMISSION HISTORY <<<");
    console.log(JSON.stringify(income, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Income fetch error:", msg);
  }

  // 2. Fetch User Trades for all active symbols
  console.log("\n>>> USER TRADES ACROSS ACTIVE SYMBOLS <<<");
  for (const sym of symbols) {
    try {
      const trades = await client.fetchSignedEndpoint<unknown[]>("/fapi/v1/userTrades", { symbol: sym, limit: 20 });
      if (Array.isArray(trades) && trades.length > 0) {
        console.log(`\n--- Symbol: ${sym} (${String(trades.length)} trades found) ---`);
        console.log(JSON.stringify(trades, null, 2));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`UserTrades fetch error for ${sym}:`, msg);
    }
  }

  // 3. Fetch All Orders for all active symbols
  console.log("\n>>> ALL ORDERS ACROSS ACTIVE SYMBOLS <<<");
  for (const sym of symbols) {
    try {
      const orders = await client.fetchSignedEndpoint<unknown[]>("/fapi/v1/allOrders", { symbol: sym, limit: 15 });
      if (Array.isArray(orders) && orders.length > 0) {
        console.log(`\n--- Orders for ${sym} (${String(orders.length)} orders found) ---`);
        console.log(JSON.stringify(orders, null, 2));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`AllOrders fetch error for ${sym}:`, msg);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
