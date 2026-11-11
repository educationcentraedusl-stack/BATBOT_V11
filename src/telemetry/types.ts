export interface TradeLoggerStats {
  totalSignalsLogged: number;
  totalExecutionsLogged: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  realizedPnl: number;
  unrealizedPnl: number;
  positionSide: "FLAT" | "LONG" | "SHORT" | "BOTH";
  netQuantity: number;
  averageEntryPrice: number;
  totalFees: number;
  winRatePercent: number;
  avgTickLatencyUs: number;
  bufferQueueDepth: number;
}

export interface TelemetryActiveTradeSlot {
  symbol: string;
  side: "BUY/LONG" | "SELL/SHORT" | "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  currentPrice: number;
  tpPrice: number;
  slPrice: number;
  leverage: number;
  unrealizedPnl: number;
  roePercent?: number;
  stepCollarTier?: string | number;
  fundingFees?: number;
  durationMs: number;
}

export interface TelemetryFrame {
  symbol: string;
  sequenceNum: bigint;
  bidPrice: number;
  askPrice: number;
  obi: number;
  cvd: number;
  spreadVelocity: number;
  lastSignal: "NONE" | "BUY" | "SELL";
  tickEvaluationLatencyUs: number;
  stats: TradeLoggerStats;
  riskStatus: string;
  isEngineActive: boolean;
  usdtBalance: number;
  reconciledWalletBalance?: number;
  cumulativeFundingFees?: number;
  activeStepCollarTier?: string | number;
  roePercent?: number;
  aiDirection?: number;
  aiConfidence?: number;
  rollingIc?: number;
  aiInferenceLatencyNs?: bigint;
  rttMs?: number;
  latencyPenalty?: number;
  slippageTicks?: number;
  timestamp?: number;
  activeTrades?: TelemetryActiveTradeSlot[];
}

