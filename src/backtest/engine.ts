import { StrategyEngine, StrategyConfig } from "../strategy/engine";
import { RiskGuard } from "../strategy/risk";
import { BinanceExecutionClient } from "../execution/binance";
import { MarketDataClient } from "../marketDataClient";

export interface BacktestTick {
  sequenceNum: bigint;
  timestamp: number;
  bidPrice: number;
  askPrice: number;
  obi: number;
  cvd: number;
  spreadVelocity: number;
}

export interface BacktestConfig {
  initialCapital: number;
  orderQuantity: number;
  takerFeeRate: number; // e.g. 0.0004 for 0.04%
  slippageTicks: number; // Price slippage in ticks
  tickSize: number; // e.g. 0.1 for BTCUSDT
  strategyConfig?: Partial<StrategyConfig>;
}

export interface BacktestResult {
  initialCapital: number;
  finalCapital: number;
  netPnl: number;
  totalReturnPercent: number;
  totalTicksEvaluated: number;
  totalSignalsGenerated: number;
  totalTradesExecuted: number;
  winningTrades: number;
  losingTrades: number;
  winRatePercent: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  grossProfit: number;
  grossLoss: number;
  totalFeesPaid: number;
  avgTickProcessingTimeUs: number;
  throughputTicksPerSec: number;
}

export class MockMarketDataClient extends MarketDataClient {
  private currentSeq: bigint = 0n;
  private currentBid: number = 0;
  private currentAsk: number = 0;
  private currentObi: number = 0;
  private currentCvd: number = 0;
  private currentVel: number = 0;

  constructor() {
    // Pass empty buffer to base constructor
    super(new SharedArrayBuffer(1024));
  }

  public updateState(tick: BacktestTick): void {
    this.currentSeq = tick.sequenceNum;
    this.currentBid = tick.bidPrice;
    this.currentAsk = tick.askPrice;
    this.currentObi = tick.obi;
    this.currentCvd = tick.cvd;
    this.currentVel = tick.spreadVelocity;
  }

  public override getSequenceNum(): bigint {
    return this.currentSeq;
  }

  public override getBestBidPrice(): number {
    return this.currentBid;
  }

  public override getBestAskPrice(): number {
    return this.currentAsk;
  }

  public override getOBI(): number {
    return this.currentObi;
  }

  public override getCVD(): number {
    return this.currentCvd;
  }

  public override getSpreadVelocity(): number {
    return this.currentVel;
  }
}

export class BacktestEngine {
  private config: BacktestConfig;

  constructor(config?: Partial<BacktestConfig>) {
    this.config = {
      initialCapital: config?.initialCapital ?? 10000.0,
      orderQuantity: config?.orderQuantity ?? 0.01,
      takerFeeRate: config?.takerFeeRate ?? 0.0004,
      slippageTicks: config?.slippageTicks ?? 1,
      tickSize: config?.tickSize ?? 0.1,
      strategyConfig: config?.strategyConfig,
    };
  }

  /**
   * Runs tick replay simulation over historical data ticks.
   */
  public run(ticks: BacktestTick[]): BacktestResult {
    const mockClient = new MockMarketDataClient();
    const riskGuard = new RiskGuard({ maxDailyLossUsdt: 1000.0, maxPositionSizeUsdt: 50000.0, minCooldownMs: 0 });
    const executionClient = new BinanceExecutionClient();

    const engine = new StrategyEngine(mockClient, riskGuard, executionClient, {
      orderQuantity: this.config.orderQuantity,
      ...this.config.strategyConfig,
    });

    let currentCapital = this.config.initialCapital;
    let peakCapital = currentCapital;
    let maxDrawdown = 0;

    let position: "NONE" | "LONG" | "SHORT" = "NONE";
    let entryPrice = 0;
    let entryQuantity = 0;

    let grossProfit = 0;
    let grossLoss = 0;
    let totalFeesPaid = 0;
    let winningTrades = 0;
    let losingTrades = 0;
    let totalSignalsGenerated = 0;
    let totalTradesExecuted = 0;

    const tradeReturns: number[] = [];
    const startTime = process.hrtime.bigint();

    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i];
      mockClient.updateState(tick);

      const result = engine.evaluateTick();

      if (result.signalType !== "NONE") {
        totalSignalsGenerated++;

        const slippage = this.config.slippageTicks * this.config.tickSize;

        // Position Management & Execution Logic (Bidirectional Long & Short Support)
        if (result.signalType === "BUY" && position === "NONE") {
          const fillPrice = tick.askPrice + slippage;
          const notional = fillPrice * this.config.orderQuantity;
          const fee = notional * this.config.takerFeeRate;

          position = "LONG";
          entryPrice = fillPrice;
          entryQuantity = this.config.orderQuantity;
          currentCapital -= fee;
          totalFeesPaid += fee;
          totalTradesExecuted++;
        } else if (result.signalType === "SELL" && position === "LONG") {
          const fillPrice = tick.bidPrice - slippage;
          const notional = fillPrice * entryQuantity;
          const fee = notional * this.config.takerFeeRate;

          const pnl = (fillPrice - entryPrice) * entryQuantity - fee;
          currentCapital += pnl;
          totalFeesPaid += fee;
          totalTradesExecuted++;

          riskGuard.recordRealizedPnl(pnl);
          riskGuard.updatePositionNotional(0);

          const tradeReturnPercent = (pnl / (entryPrice * entryQuantity)) * 100;
          tradeReturns.push(tradeReturnPercent);

          if (pnl > 0) {
            grossProfit += pnl;
            winningTrades++;
          } else {
            grossLoss += Math.abs(pnl);
            losingTrades++;
          }

          position = "NONE";
        } else if (result.signalType === "SELL" && position === "NONE") {
          const fillPrice = tick.bidPrice - slippage;
          const notional = fillPrice * this.config.orderQuantity;
          const fee = notional * this.config.takerFeeRate;

          position = "SHORT";
          entryPrice = fillPrice;
          entryQuantity = this.config.orderQuantity;
          currentCapital -= fee;
          totalFeesPaid += fee;
          totalTradesExecuted++;
        } else if (result.signalType === "BUY" && position === "SHORT") {
          const fillPrice = tick.askPrice + slippage;
          const notional = fillPrice * entryQuantity;
          const fee = notional * this.config.takerFeeRate;

          const pnl = (entryPrice - fillPrice) * entryQuantity - fee;
          currentCapital += pnl;
          totalFeesPaid += fee;
          totalTradesExecuted++;

          riskGuard.recordRealizedPnl(pnl);
          riskGuard.updatePositionNotional(0);

          const tradeReturnPercent = (pnl / (entryPrice * entryQuantity)) * 100;
          tradeReturns.push(tradeReturnPercent);

          if (pnl > 0) {
            grossProfit += pnl;
            winningTrades++;
          } else {
            grossLoss += Math.abs(pnl);
            losingTrades++;
          }

          position = "NONE";
        }

        // Drawdown Tracking
        if (currentCapital > peakCapital) {
          peakCapital = currentCapital;
        }
        const currentDrawdown = ((peakCapital - currentCapital) / peakCapital) * 100;
        if (currentDrawdown > maxDrawdown) {
          maxDrawdown = currentDrawdown;
        }
      }
    }

    const endTime = process.hrtime.bigint();
    const totalElapsedNs = Number(endTime - startTime);
    const avgTickProcessingTimeUs = ticks.length > 0 ? (totalElapsedNs / 1000) / ticks.length : 0;
    const throughputTicksPerSec = totalElapsedNs > 0 ? Math.round((ticks.length / (totalElapsedNs / 1e9))) : 0;

    const netPnl = currentCapital - this.config.initialCapital;
    const totalReturnPercent = (netPnl / this.config.initialCapital) * 100;
    const winRatePercent = totalTradesExecuted > 0 ? (winningTrades / totalTradesExecuted) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999.99 : 0;

    // Calculate Sharpe Ratio (annualized)
    const sharpeRatio = this.calculateSharpeRatio(tradeReturns);

    return {
      initialCapital: this.config.initialCapital,
      finalCapital: Number(currentCapital.toFixed(2)),
      netPnl: Number(netPnl.toFixed(2)),
      totalReturnPercent: Number(totalReturnPercent.toFixed(2)),
      totalTicksEvaluated: ticks.length,
      totalSignalsGenerated,
      totalTradesExecuted,
      winningTrades,
      losingTrades,
      winRatePercent: Number(winRatePercent.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      maxDrawdownPercent: Number(maxDrawdown.toFixed(2)),
      sharpeRatio: Number(sharpeRatio.toFixed(2)),
      grossProfit: Number(grossProfit.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
      totalFeesPaid: Number(totalFeesPaid.toFixed(2)),
      avgTickProcessingTimeUs: Number(avgTickProcessingTimeUs.toFixed(3)),
      throughputTicksPerSec,
    };
  }

  private calculateSharpeRatio(returns: number[]): number {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return 0;
    // Assume risk-free rate of 0 for HFT intraday scale
    return (mean / stdDev) * Math.sqrt(252);
  }
}
