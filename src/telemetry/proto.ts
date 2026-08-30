import * as protobuf from "protobufjs";
import { TelemetryFrame } from "./dashboard";

const TELEMETRY_PROTO_SCHEMA = `
syntax = "proto3";
package batbot.telemetry;

message TradeLoggerStatsProto {
  double realized_pnl = 1;
  double unrealized_pnl = 2;
  double total_fees = 3;
  uint32 total_trades = 4;
  uint32 winning_trades = 5;
  uint32 losing_trades = 6;
  double win_rate_percent = 7;
  string position_side = 8;
  double net_quantity = 9;
  double average_entry_price = 10;
  uint32 total_signals_logged = 11;
  uint32 total_executions_logged = 12;
  double avg_tick_latency_us = 13;
  uint32 buffer_queue_depth = 14;
}

message TelemetryFrameProto {
  string symbol = 1;
  uint64 sequence_num = 2;
  double bid_price = 3;
  double ask_price = 4;
  double obi = 5;
  double cvd = 6;
  double spread_velocity = 7;
  string last_signal = 8;
  double tick_evaluation_latency_us = 9;
  TradeLoggerStatsProto stats = 10;
  string risk_status = 11;
  bool is_engine_active = 12;
  double usdt_balance = 13;
  double ai_direction = 14;
  double ai_confidence = 15;
  double rolling_ic = 16;
  uint64 ai_inference_latency_ns = 17;
  double rtt_ms = 18;
  double latency_penalty = 19;
  uint32 slippage_ticks = 20;
  int64 timestamp = 21;
}

message ControlCommandProto {
  enum Action {
    ENGINE_START = 0;
    ENGINE_PAUSE = 1;
    EMERGENCY_KILL = 2;
    AI_HOT_SWAP = 3;
  }
  Action action = 1;
  string model_path = 2;
  int64 timestamp = 3;
}

message ControlResponseProto {
  bool success = 1;
  string action = 2;
  string message = 3;
  int64 timestamp = 4;
}
`;

let root: protobuf.Root | null = null;
let TelemetryFrameMsg: protobuf.Type | null = null;
let ControlCommandMsg: protobuf.Type | null = null;
let ControlResponseMsg: protobuf.Type | null = null;

export function initProtobuf(): void {
  if (root) return;
  const parsed = protobuf.parse(TELEMETRY_PROTO_SCHEMA);
  root = parsed.root;
  TelemetryFrameMsg = root.lookupType("batbot.telemetry.TelemetryFrameProto");
  ControlCommandMsg = root.lookupType("batbot.telemetry.ControlCommandProto");
  ControlResponseMsg = root.lookupType("batbot.telemetry.ControlResponseProto");
}

export function encodeTelemetryFrame(frame: TelemetryFrame, timestamp: number = Date.now()): Uint8Array {
  if (!TelemetryFrameMsg) initProtobuf();
  
  const payload = {
    symbol: frame.symbol,
    sequenceNum: typeof frame.sequenceNum === "bigint" ? Number(frame.sequenceNum) : frame.sequenceNum,
    bidPrice: frame.bidPrice,
    askPrice: frame.askPrice,
    obi: frame.obi,
    cvd: frame.cvd,
    spreadVelocity: frame.spreadVelocity,
    lastSignal: frame.lastSignal,
    tickEvaluationLatencyUs: frame.tickEvaluationLatencyUs,
    stats: {
      realizedPnl: frame.stats.realizedPnl,
      unrealizedPnl: frame.stats.unrealizedPnl,
      totalFees: frame.stats.totalFees,
      totalTrades: frame.stats.totalTrades,
      winningTrades: frame.stats.winningTrades,
      losingTrades: frame.stats.losingTrades,
      winRatePercent: frame.stats.winRatePercent,
      positionSide: frame.stats.positionSide,
      netQuantity: frame.stats.netQuantity,
      averageEntryPrice: frame.stats.averageEntryPrice,
      totalSignalsLogged: frame.stats.totalSignalsLogged,
      totalExecutionsLogged: frame.stats.totalExecutionsLogged,
      avgTickLatencyUs: frame.stats.avgTickLatencyUs,
      bufferQueueDepth: frame.stats.bufferQueueDepth,
    },
    riskStatus: frame.riskStatus,
    isEngineActive: frame.isEngineActive,
    usdtBalance: frame.usdtBalance,
    aiDirection: frame.aiDirection ?? 0,
    aiConfidence: frame.aiConfidence ?? 0,
    rollingIc: frame.rollingIc ?? 0,
    aiInferenceLatencyNs: typeof frame.aiInferenceLatencyNs === "bigint" ? Number(frame.aiInferenceLatencyNs) : (frame.aiInferenceLatencyNs ?? 0),
    rttMs: frame.rttMs ?? 0,
    latencyPenalty: frame.latencyPenalty ?? 1.0,
    slippageTicks: frame.slippageTicks ?? 2,
    timestamp: timestamp,
  };

  const err = TelemetryFrameMsg!.verify(payload);
  if (err) {
    throw new Error(`Protobuf verification failed: ${err}`);
  }

  const message = TelemetryFrameMsg!.create(payload);
  return TelemetryFrameMsg!.encode(message).finish();
}

export function decodeTelemetryFrame(buffer: Uint8Array): TelemetryFrame {
  if (!TelemetryFrameMsg) initProtobuf();
  const decoded = TelemetryFrameMsg!.decode(buffer);
  const obj = TelemetryFrameMsg!.toObject(decoded, { longs: Number, enums: String, defaults: true });
  
  const statsObj = obj.stats || {};
  return {
    symbol: obj.symbol || process.env.SYMBOL || "BTCUSDT",
    sequenceNum: BigInt(obj.sequenceNum || 0),
    bidPrice: obj.bidPrice || 0,
    askPrice: obj.askPrice || 0,
    obi: obj.obi || 0,
    cvd: obj.cvd || 0,
    spreadVelocity: obj.spreadVelocity || 0,
    lastSignal: obj.lastSignal || "NONE",
    tickEvaluationLatencyUs: obj.tickEvaluationLatencyUs || 0,
    stats: {
      realizedPnl: statsObj.realizedPnl || 0,
      unrealizedPnl: statsObj.unrealizedPnl || 0,
      totalFees: statsObj.totalFees || 0,
      totalTrades: statsObj.totalTrades || 0,
      winningTrades: statsObj.winningTrades || 0,
      losingTrades: statsObj.losingTrades || 0,
      winRatePercent: statsObj.winRatePercent || 0,
      positionSide: statsObj.positionSide || "FLAT",
      netQuantity: statsObj.netQuantity || 0,
      averageEntryPrice: statsObj.averageEntryPrice || 0,
      totalSignalsLogged: statsObj.totalSignalsLogged || 0,
      totalExecutionsLogged: statsObj.totalExecutionsLogged || 0,
      avgTickLatencyUs: statsObj.avgTickLatencyUs || 0,
      bufferQueueDepth: statsObj.bufferQueueDepth || 0,
    },
    riskStatus: obj.riskStatus || "PASSED",
    isEngineActive: Boolean(obj.isEngineActive),
    usdtBalance: obj.usdtBalance || 0,
    aiDirection: obj.aiDirection || 0,
    aiConfidence: obj.aiConfidence || 0,
    rollingIc: obj.rollingIc || 0,
    aiInferenceLatencyNs: BigInt(obj.aiInferenceLatencyNs || 0),
    rttMs: obj.rttMs || 0,
    latencyPenalty: obj.latencyPenalty || 1.0,
    slippageTicks: obj.slippageTicks || 0,
  };
}

export interface ControlCommand {
  action: "ENGINE_START" | "ENGINE_PAUSE" | "EMERGENCY_KILL" | "AI_HOT_SWAP";
  modelPath?: string;
  timestamp?: number;
}

export function encodeControlCommand(cmd: ControlCommand): Uint8Array {
  if (!ControlCommandMsg) initProtobuf();
  const payload = {
    action: cmd.action,
    modelPath: cmd.modelPath || "",
    timestamp: cmd.timestamp || Date.now(),
  };
  const message = ControlCommandMsg!.create(payload);
  return ControlCommandMsg!.encode(message).finish();
}

export function decodeControlCommand(buffer: Uint8Array): ControlCommand {
  if (!ControlCommandMsg) initProtobuf();
  const message = ControlCommandMsg!.decode(buffer);
  const object = ControlCommandMsg!.toObject(message, { enums: String, defaults: true });
  const rawAction = typeof object.action === "string" ? object.action : "ENGINE_PAUSE";
  const validAction: ControlCommand["action"] =
    rawAction === "ENGINE_START" ||
    rawAction === "ENGINE_PAUSE" ||
    rawAction === "EMERGENCY_KILL" ||
    rawAction === "AI_HOT_SWAP"
      ? rawAction
      : "ENGINE_PAUSE";

  return {
    action: validAction,
    modelPath: object.modelPath,
    timestamp: object.timestamp,
  };
}

export function encodeControlResponse(success: boolean, action: string, messageStr: string): Uint8Array {
  if (!ControlResponseMsg) initProtobuf();
  const payload = {
    success,
    action,
    message: messageStr,
    timestamp: Date.now(),
  };
  const message = ControlResponseMsg!.create(payload);
  return ControlResponseMsg!.encode(message).finish();
}

