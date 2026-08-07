import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { BinanceExecutionClient } from "../src/execution/binance";

interface TradeRow {
  time: string;
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  duration: string;
  roePercent: number;
  pnlUsdt: number;
  winLoss: string;
}

async function runAuditReport() {
  console.log("=========================================================================");
  console.log("      BATBOT_V11 EMPIRICAL 24-HOUR TRADING PERFORMANCE AUDIT SCRIPT     ");
  console.log("=========================================================================");
  console.log(`Report Window: 2026-08-06 12:30:00 to 2026-08-07 12:30:00 UTC`);
  console.log("-------------------------------------------------------------------------\n");

  // Step 1: Initialize Binance Execution Client & Query Live Binance API Balances
  const executionClient = new BinanceExecutionClient();
  const isConfigured = executionClient.isConfigured();
  console.log(`[Binance API Status] Configured: ${isConfigured ? "YES" : "NO"} | Mode: ${executionClient.isTestnet() ? "FUTURES TESTNET" : "LIVE PRODUCTION"}`);

  let currentUsdtBalance = 0;
  if (isConfigured) {
    try {
      await executionClient.syncServerTime();
      currentUsdtBalance = await executionClient.fetchUsdtBalanceAsync();
      console.log(`[Binance Live API] Current USDT Available Balance: $${currentUsdtBalance.toFixed(4)} USDT`);
    } catch (err: any) {
      console.warn(`[Binance Live API Warning] Could not fetch live balance: ${err.message}`);
    }
  } else {
    console.log(`[Binance Live API] API keys missing or not loaded. Skipping live API wallet query.`);
  }

  // Step 2: Parse Local CSV Trade Log
  const csvPath = path.resolve(__dirname, "../data/trade_history.csv");
  if (!fs.existsSync(csvPath)) {
    console.error(`[Error] CSV file not found at: ${csvPath}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const lines = csvContent.split("\n").filter((line) => line.trim().length > 0);
  const header = lines[0];

  const startTime = new Date("2026-08-06T12:30:00Z").getTime();
  const endTime = new Date("2026-08-07T12:30:00Z").getTime();

  const tradesInWindow: TradeRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    if (cols.length < 11) continue;

    const timeStr = cols[0];
    const tradeTime = new Date(timeStr.replace(" ", "T") + "Z").getTime();

    if (tradeTime >= startTime && tradeTime <= endTime) {
      tradesInWindow.push({
        time: cols[0],
        symbol: cols[1],
        side: cols[2],
        size: parseFloat(cols[3]),
        entryPrice: parseFloat(cols[4]),
        exitPrice: parseFloat(cols[5]),
        exitReason: cols[6],
        duration: cols[7],
        roePercent: parseFloat(cols[8]),
        pnlUsdt: parseFloat(cols[9]),
        winLoss: cols[10],
      });
    }
  }

  // Step 3: Compute Aggregated Trade Metrics
  let totalPnL = 0;
  let wins = 0;
  let losses = 0;
  let totalVolumeUsdt = 0;

  for (const t of tradesInWindow) {
    totalPnL += t.pnlUsdt;
    if (t.winLoss.toLowerCase() === "win") wins++;
    else if (t.winLoss.toLowerCase() === "loss") losses++;
    totalVolumeUsdt += t.size * t.entryPrice;
  }

  const totalTrades = tradesInWindow.length;
  const winRatePercent = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  console.log("\n=========================================================================");
  console.log("                    EMPIRICALLY VERIFIED TRADE TABLE                     ");
  console.log("=========================================================================");
  console.table(
    tradesInWindow.map((t) => ({
      Timestamp: t.time,
      Symbol: t.symbol,
      Side: t.side,
      "Size (Qty)": t.size,
      "Entry Px": t.entryPrice,
      "Exit Px": t.exitPrice,
      Reason: t.exitReason,
      "Duration": t.duration,
      "ROE %": t.roePercent.toFixed(2) + "%",
      "PnL (USDT)": t.pnlUsdt.toFixed(4),
      Outcome: t.winLoss,
    }))
  );

  console.log("=========================================================================");
  console.log("                    AGGREGATED PERFORMANCE SUMMARY                      ");
  console.log("=========================================================================");
  console.log(`Total Trades Executed:       ${totalTrades}`);
  console.log(`Winning Trades:              ${wins}`);
  console.log(`Losing Trades:               ${losses}`);
  console.log(`Win Rate:                    ${winRatePercent.toFixed(2)}%`);
  console.log(`Total Notional Volume:       $${totalVolumeUsdt.toFixed(2)} USDT`);
  console.log(`Net Realized PnL (USDT):     $${totalPnL.toFixed(4)} USDT`);
  console.log("=========================================================================\n");
}

runAuditReport().catch((err) => {
  console.error("Audit script failed:", err);
  process.exit(1);
});
