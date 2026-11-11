import * as protobuf from "protobufjs";
import type { TelemetryFrame } from "./types";

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

interface ProtoTypes {
  telemetryFrame: protobuf.Type;
  controlCommand: protobuf.Type;
  controlResponse: protobuf.Type;
}

let cachedTypes: ProtoTypes | null = null;

function getProtoTypes(): ProtoTypes {
  if (cachedTypes !== null) {
    return cachedTypes;
  }
  const parsed = protobuf.parse(TELEMETRY_PROTO_SCHEMA);
  const loadedRoot = parsed.root;
  cachedTypes = {
    telemetryFrame: loadedRoot.lookupType("batbot.telemetry.TelemetryFrameProto"),
    controlCommand: loadedRoot.lookupType("batbot.telemetry.ControlCommandProto"),
    controlResponse: loadedRoot.lookupType("batbot.telemetry.ControlResponseProto"),
  };
  return cachedTypes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  context: string
): string {
  const val = obj[key];
  if (typeof val !== "string" || val.trim().length === 0) {
    throw new Error(`[TelemetryProto] Missing or empty string field "${key}" in ${context}`);
  }
  return val;
}

function readOptionalNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  context: string
): string | undefined {
  const val = obj[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== "string") {
    throw new Error(`[TelemetryProto] Expected string for optional field "${key}" in ${context}`);
  }
  return val.length > 0 ? val : undefined;
}

function requireFiniteNumber(
  obj: Record<string, unknown>,
  key: string,
  context: string
): number {
  const val = obj[key];
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new Error(`[TelemetryProto] Missing or non-finite numeric field "${key}" in ${context}`);
  }
  return val;
}

function requirePositiveNumber(
  obj: Record<string, unknown>,
  key: string,
  context: string
): number {
  const val = requireFiniteNumber(obj, key, context);
  if (val <= 0) {
    throw new Error(`[TelemetryProto] Expected positive numeric field "${key}" > 0 in ${context}, got ${String(val)}`);
  }
  return val;
}

function readOptionalPositiveNumber(
  obj: Record<string, unknown>,
  key: string,
  context: string
): number | undefined {
  const val = obj[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
    throw new Error(`[TelemetryProto] Invalid optional numeric field "${key}" in ${context}`);
  }
  return val > 0 ? val : undefined;
}

function requireBoolean(
  obj: Record<string, unknown>,
  key: string,
  context: string
): boolean {
  const val = obj[key];
  if (typeof val !== "boolean") {
    throw new Error(`[TelemetryProto] Missing or non-boolean field "${key}" in ${context}`);
  }
  return val;
}

function requireBigInt(
  obj: Record<string, unknown>,
  key: string,
  context: string
): bigint {
  const val = obj[key];
  if (typeof val === "bigint") {
    return val;
  }
  if (typeof val === "number" && Number.isFinite(val) && Number.isInteger(val) && val >= 0) {
    return BigInt(val);
  }
  if (typeof val === "string" && /^\d+$/.test(val)) {
    return BigInt(val);
  }
  throw new Error(`[TelemetryProto] Missing or invalid bigint field "${key}" in ${context}`);
}

export interface DecodedTelemetryFrame extends TelemetryFrame {
  timestamp: number;
  aiDirection: number;
  aiConfidence: number;
  rollingIc: number;
  aiInferenceLatencyNs: bigint;
  rttMs: number;
  latencyPenalty: number;
  slippageTicks: number;
}

export function initProtobuf(): void {
  getProtoTypes();
}

export function encodeTelemetryFrame(frame: TelemetryFrame, timestamp?: number): Uint8Array {
  const { telemetryFrame } = getProtoTypes();
  const resolvedTimestamp = timestamp ?? frame.timestamp;
  if (typeof resolvedTimestamp !== "number" || !Number.isFinite(resolvedTimestamp) || resolvedTimestamp <= 0) {
    throw new Error(
      `[TelemetryProto] encodeTelemetryFrame requires a positive finite timestamp, got ${String(resolvedTimestamp)}`
    );
  }
  if (frame.symbol.trim().length === 0) {
    throw new Error("[TelemetryProto] encodeTelemetryFrame requires a non-empty symbol");
  }
  if (frame.riskStatus.trim().length === 0) {
    throw new Error("[TelemetryProto] encodeTelemetryFrame requires a non-empty riskStatus");
  }

  const payload: Record<string, unknown> = {
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
    timestamp: resolvedTimestamp,
  };

  if (frame.aiDirection !== undefined) {
    if (!Number.isFinite(frame.aiDirection)) {
      throw new Error("[TelemetryProto] Non-finite aiDirection in encodeTelemetryFrame");
    }
    payload["aiDirection"] = frame.aiDirection;
  }
  if (frame.aiConfidence !== undefined) {
    if (!Number.isFinite(frame.aiConfidence)) {
      throw new Error("[TelemetryProto] Non-finite aiConfidence in encodeTelemetryFrame");
    }
    payload["aiConfidence"] = frame.aiConfidence;
  }
  if (frame.rollingIc !== undefined) {
    if (!Number.isFinite(frame.rollingIc)) {
      throw new Error("[TelemetryProto] Non-finite rollingIc in encodeTelemetryFrame");
    }
    payload["rollingIc"] = frame.rollingIc;
  }
  if (frame.aiInferenceLatencyNs !== undefined) {
    payload["aiInferenceLatencyNs"] = Number(frame.aiInferenceLatencyNs);
  }
  if (frame.rttMs !== undefined) {
    if (!Number.isFinite(frame.rttMs)) {
      throw new Error("[TelemetryProto] Non-finite rttMs in encodeTelemetryFrame");
    }
    payload["rttMs"] = frame.rttMs;
  }
  if (frame.latencyPenalty !== undefined) {
    if (!Number.isFinite(frame.latencyPenalty)) {
      throw new Error("[TelemetryProto] Non-finite latencyPenalty in encodeTelemetryFrame");
    }
    payload["latencyPenalty"] = frame.latencyPenalty;
  }
  if (frame.slippageTicks !== undefined) {
    if (!Number.isFinite(frame.slippageTicks)) {
      throw new Error("[TelemetryProto] Non-finite slippageTicks in encodeTelemetryFrame");
    }
    payload["slippageTicks"] = frame.slippageTicks;
  }

  const err = telemetryFrame.verify(payload);
  if (err) {
    throw new Error(`Protobuf verification failed: ${err}`);
  }

  const message = telemetryFrame.create(payload);
  return telemetryFrame.encode(message).finish();
}

export function decodeTelemetryFrame(buffer: Uint8Array): DecodedTelemetryFrame {
  const { telemetryFrame } = getProtoTypes();
  const decoded = telemetryFrame.decode(buffer);
  const rawObj = telemetryFrame.toObject(decoded, { longs: Number, enums: String, defaults: true }) as unknown;
  const ctx = "TelemetryFrameProto";
  if (!isRecord(rawObj)) {
    throw new Error(`[TelemetryProto] Decoded ${ctx} payload is not an object`);
  }
  const obj = rawObj;
  const statsRaw = obj["stats"];
  const statsCtx = `${ctx}.stats`;
  if (!isRecord(statsRaw)) {
    throw new Error(`[TelemetryProto] Missing or malformed nested ${statsCtx}`);
  }
  const statsObj = statsRaw;

  const rawSignal = requireNonEmptyString(obj, "lastSignal", ctx);
  if (rawSignal !== "NONE" && rawSignal !== "BUY" && rawSignal !== "SELL") {
    throw new Error(`[TelemetryProto] Invalid lastSignal "${rawSignal}" in ${ctx}`);
  }
  const lastSignal: TelemetryFrame["lastSignal"] = rawSignal;

  const rawSide = requireNonEmptyString(statsObj, "positionSide", statsCtx);
  if (rawSide !== "FLAT" && rawSide !== "LONG" && rawSide !== "SHORT" && rawSide !== "BOTH") {
    throw new Error(`[TelemetryProto] Invalid positionSide "${rawSide}" in ${statsCtx}`);
  }
  const positionSide: TelemetryFrame["stats"]["positionSide"] = rawSide;

  return {
    symbol: requireNonEmptyString(obj, "symbol", ctx),
    sequenceNum: requireBigInt(obj, "sequenceNum", ctx),
    bidPrice: requireFiniteNumber(obj, "bidPrice", ctx),
    askPrice: requireFiniteNumber(obj, "askPrice", ctx),
    obi: requireFiniteNumber(obj, "obi", ctx),
    cvd: requireFiniteNumber(obj, "cvd", ctx),
    spreadVelocity: requireFiniteNumber(obj, "spreadVelocity", ctx),
    lastSignal,
    tickEvaluationLatencyUs: requireFiniteNumber(obj, "tickEvaluationLatencyUs", ctx),
    stats: {
      realizedPnl: requireFiniteNumber(statsObj, "realizedPnl", statsCtx),
      unrealizedPnl: requireFiniteNumber(statsObj, "unrealizedPnl", statsCtx),
      totalFees: requireFiniteNumber(statsObj, "totalFees", statsCtx),
      totalTrades: requireFiniteNumber(statsObj, "totalTrades", statsCtx),
      winningTrades: requireFiniteNumber(statsObj, "winningTrades", statsCtx),
      losingTrades: requireFiniteNumber(statsObj, "losingTrades", statsCtx),
      winRatePercent: requireFiniteNumber(statsObj, "winRatePercent", statsCtx),
      positionSide,
      netQuantity: requireFiniteNumber(statsObj, "netQuantity", statsCtx),
      averageEntryPrice: requireFiniteNumber(statsObj, "averageEntryPrice", statsCtx),
      totalSignalsLogged: requireFiniteNumber(statsObj, "totalSignalsLogged", statsCtx),
      totalExecutionsLogged: requireFiniteNumber(statsObj, "totalExecutionsLogged", statsCtx),
      avgTickLatencyUs: requireFiniteNumber(statsObj, "avgTickLatencyUs", statsCtx),
      bufferQueueDepth: requireFiniteNumber(statsObj, "bufferQueueDepth", statsCtx),
    },
    riskStatus: requireNonEmptyString(obj, "riskStatus", ctx),
    isEngineActive: requireBoolean(obj, "isEngineActive", ctx),
    usdtBalance: requireFiniteNumber(obj, "usdtBalance", ctx),
    aiDirection: requireFiniteNumber(obj, "aiDirection", ctx),
    aiConfidence: requireFiniteNumber(obj, "aiConfidence", ctx),
    rollingIc: requireFiniteNumber(obj, "rollingIc", ctx),
    aiInferenceLatencyNs: requireBigInt(obj, "aiInferenceLatencyNs", ctx),
    rttMs: requireFiniteNumber(obj, "rttMs", ctx),
    latencyPenalty: requireFiniteNumber(obj, "latencyPenalty", ctx),
    slippageTicks: requireFiniteNumber(obj, "slippageTicks", ctx),
    timestamp: requirePositiveNumber(obj, "timestamp", ctx),
  };
}

export interface ControlCommand {
  action: "ENGINE_START" | "ENGINE_PAUSE" | "EMERGENCY_KILL" | "AI_HOT_SWAP";
  modelPath?: string;
  timestamp?: number;
}

export function encodeControlCommand(cmd: ControlCommand): Uint8Array {
  const { controlCommand } = getProtoTypes();
  const payload: Record<string, unknown> = {
    action: cmd.action,
  };
  if (cmd.modelPath !== undefined) {
    payload["modelPath"] = cmd.modelPath;
  }
  if (cmd.timestamp !== undefined) {
    if (!Number.isFinite(cmd.timestamp) || cmd.timestamp <= 0) {
      throw new Error(
        `[TelemetryProto] Invalid timestamp (${String(cmd.timestamp)}) in encodeControlCommand`
      );
    }
    payload["timestamp"] = cmd.timestamp;
  }
  const verifyErr = controlCommand.verify(payload);
  if (verifyErr) {
    throw new Error(`[TelemetryProto] ControlCommand verification failed: ${verifyErr}`);
  }
  const message = controlCommand.create(payload);
  return controlCommand.encode(message).finish();
}

export function decodeControlCommand(buffer: Uint8Array): ControlCommand {
  const { controlCommand } = getProtoTypes();
  const message = controlCommand.decode(buffer);
  const rawObj = controlCommand.toObject(message, { longs: Number, enums: String, defaults: true }) as unknown;
  const ctx = "ControlCommandProto";
  if (!isRecord(rawObj)) {
    throw new Error(`[TelemetryProto] Decoded ${ctx} payload is not an object`);
  }
  const rawAction = requireNonEmptyString(rawObj, "action", ctx);
  if (
    rawAction !== "ENGINE_START" &&
    rawAction !== "ENGINE_PAUSE" &&
    rawAction !== "EMERGENCY_KILL" &&
    rawAction !== "AI_HOT_SWAP"
  ) {
    throw new Error(`[TelemetryProto] Invalid ControlCommand action "${rawAction}" in ${ctx}`);
  }

  return {
    action: rawAction,
    modelPath: readOptionalNonEmptyString(rawObj, "modelPath", ctx),
    timestamp: readOptionalPositiveNumber(rawObj, "timestamp", ctx),
  };
}

export function encodeControlResponse(
  success: boolean,
  action: string,
  messageStr: string,
  timestamp: number
): Uint8Array {
  const { controlResponse } = getProtoTypes();
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error(
      `[TelemetryProto] Invalid timestamp (${String(timestamp)}) in encodeControlResponse`
    );
  }
  const payload = {
    success,
    action,
    message: messageStr,
    timestamp,
  };
  const message = controlResponse.create(payload);
  return controlResponse.encode(message).finish();
}
