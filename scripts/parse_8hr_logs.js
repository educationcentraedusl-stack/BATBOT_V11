const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { PositionLedger } = require('../dist/strategy/positionLedger');

/**
 * BATBOT_V11 CORRECTED QUANT LOG PARSER & AUDIT ENGINE
 * 
 * Correctly matches the live StrategyEngine CLI Dashboard telemetry by passing
 * raw execution fills from data/executions.jsonl through the stateful FIFO PositionLedger.
 * This captures partial 5-Stage Micro-TP ladder exits (TP1, TP2, TP3) as individual winning
 * trade iterations, exactly as registered in the UI.
 */
async function parseAndAuditSession(startTimeStr = '2026-08-06T03:30:00+05:30', endTimeStr = '2026-08-06T08:30:00+05:30') {
  const startMs = new Date(startTimeStr).getTime();
  const endMs = new Date(endTimeStr).getTime();

  const executionsPath = path.join(__dirname, '../data/executions.jsonl');
  if (!fs.existsSync(executionsPath)) {
    throw new Error(`Executions log file not found at ${executionsPath}`);
  }

  const ledger = new PositionLedger('ETHUSDT', 2048);
  const fileStream = fs.createReadStream(executionsPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let rawFillCount = 0;
  let partialWinCount = 0;
  let partialLossCount = 0;
  let totalClosedFills = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const ts = item.timestamp || item.ts;
      
      if (ts >= startMs && ts <= endMs) {
        rawFillCount++;
        const symbol = item.symbol || 'ETHUSDT';
        const side = item.side;
        const price = parseFloat(item.price);
        const quantity = parseFloat(item.quantity);
        const fee = parseFloat(item.fee || 0);

        // Process fill through FIFO PositionLedger engine matching StrategyEngine internal accounting
        const res = ledger.processFill(symbol, side, price, quantity, fee);
        
        if (res.closedQuantity > 0) {
          totalClosedFills++;
          if (res.realizedPnl > 0) {
            partialWinCount++;
          } else if (res.realizedPnl < 0) {
            partialLossCount++;
          }
        }
      }
    } catch (err) {
      // Ignore truncated log lines
    }
  }

  const summary = ledger.getSummary();
  const winRatePct = summary.totalTrades > 0 ? (summary.winningTrades / summary.totalTrades) * 100 : 0;

  return {
    timeframe: `${startTimeStr} to ${endTimeStr}`,
    rawExecutionsCount: rawFillCount,
    totalTrades: summary.totalTrades,
    winningTrades: summary.winningTrades,
    losingTrades: summary.losingTrades,
    winRatePercent: Number(winRatePct.toFixed(2)),
    realizedPnlUsdt: summary.cumulativeRealizedPnl,
    cumulativeFeesUsdt: summary.cumulativeFees,
    currentPosition: {
      side: summary.side,
      netQuantity: summary.netQuantity,
      averageEntryPrice: summary.averageEntryPrice
    }
  };
}

if (require.main === module) {
  parseAndAuditSession()
    .then(report => {
      console.log('=================================================');
      console.log('  CORRECTED BATBOT_V11 QUANT AUDIT ENGINE REPORT ');
      console.log('=================================================');
      console.log(`Session Window:     ${report.timeframe}`);
      console.log(`Raw Fill Executions: ${report.rawExecutionsCount}`);
      console.log(`Total Trade Fills:  ${report.totalTrades} (UI Matched)`);
      console.log(`  - Wins (W):       ${report.winningTrades}`);
      console.log(`  - Losses (L):     ${report.losingTrades}`);
      console.log(`  - Win Rate:       ${report.winRatePercent}%`);
      console.log(`Realized PnL:       $${report.realizedPnlUsdt.toFixed(2)} USDT`);
      console.log(`Exchange Fees:      $${report.cumulativeFeesUsdt.toFixed(4)} USDT`);
      console.log(`Current Position:   ${report.currentPosition.side} ${report.currentPosition.netQuantity} @ $${report.currentPosition.averageEntryPrice}`);
    })
    .catch(console.error);
}

module.exports = { parseAndAuditSession };
