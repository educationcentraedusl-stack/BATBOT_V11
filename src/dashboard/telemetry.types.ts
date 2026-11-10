import type { ControlCommand } from "../telemetry/proto";

export interface WorkerFrameData {
  symbol: string;
  sequenceNum: string;
  bidPrice: number;
  askPrice: number;
  obi: number;
  cvd: number;
  spreadVelocity: number;
  lastSignal: string;
  tickEvaluationLatencyUs: number;
  riskStatus: string;
  isEngineActive: boolean;
  usdtBalance: number;
  aiDirection: number;
  aiConfidence: number;
  rollingIc: number;
  aiInferenceLatencyNs: string;
  rttMs: number;
  latencyPenalty: number;
  slippageTicks: number;
  timestamp: number;
  stats: {
    realizedPnl: number;
    unrealizedPnl: number;
    totalFees: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRatePercent: number;
    positionSide: string;
    netQuantity: number;
    averageEntryPrice: number;
    totalSignalsLogged: number;
    totalExecutionsLogged: number;
    avgTickLatencyUs: number;
    bufferQueueDepth: number;
  };
}

export type ConnectionStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR";

export type TelemetryWorkerInboundMessage =
  | { type: "CONNECT"; url?: string }
  | { type: "SEND_COMMAND"; command?: ControlCommand }
  | { type: "DISCONNECT" };

export type TelemetryWorkerOutboundMessage =
  | { type: "STATUS"; status: ConnectionStatus }
  | { type: "FRAME_BATCH"; frame: WorkerFrameData; recentCount: number };

