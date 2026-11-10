"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.initProtobuf = initProtobuf;
exports.encodeTelemetryFrame = encodeTelemetryFrame;
exports.decodeTelemetryFrame = decodeTelemetryFrame;
exports.encodeControlCommand = encodeControlCommand;
exports.decodeControlCommand = decodeControlCommand;
exports.encodeControlResponse = encodeControlResponse;
const protobuf = __importStar(require("protobufjs"));
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
let cachedTypes = null;
function getProtoTypes() {
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
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(obj, key, fallback) {
    const val = obj[key];
    return typeof val === "string" && val.length > 0 ? val : fallback;
}
function readOptionalString(obj, key) {
    const val = obj[key];
    return typeof val === "string" ? val : undefined;
}
function readNumber(obj, key, fallback) {
    const val = obj[key];
    return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}
function readOptionalNumber(obj, key) {
    const val = obj[key];
    return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}
function readBoolean(obj, key) {
    return Boolean(obj[key]);
}
function readBigInt(obj, key) {
    const val = obj[key];
    if (typeof val === "bigint")
        return val;
    if (typeof val === "number" && Number.isFinite(val))
        return BigInt(Math.trunc(val));
    if (typeof val === "string" && /^\d+$/.test(val))
        return BigInt(val);
    return 0n;
}
function initProtobuf() {
    getProtoTypes();
}
function encodeTelemetryFrame(frame, timestamp = Date.now()) {
    const { telemetryFrame } = getProtoTypes();
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
        aiInferenceLatencyNs: frame.aiInferenceLatencyNs !== undefined ? Number(frame.aiInferenceLatencyNs) : 0,
        rttMs: frame.rttMs ?? 0,
        latencyPenalty: frame.latencyPenalty ?? 1.0,
        slippageTicks: frame.slippageTicks ?? 2,
        timestamp,
    };
    const err = telemetryFrame.verify(payload);
    if (err) {
        throw new Error(`Protobuf verification failed: ${err}`);
    }
    const message = telemetryFrame.create(payload);
    return telemetryFrame.encode(message).finish();
}
function decodeTelemetryFrame(buffer) {
    const { telemetryFrame } = getProtoTypes();
    const decoded = telemetryFrame.decode(buffer);
    const rawObj = telemetryFrame.toObject(decoded, { longs: Number, enums: String, defaults: true });
    const obj = isRecord(rawObj) ? rawObj : {};
    const statsRaw = obj["stats"];
    const statsObj = isRecord(statsRaw) ? statsRaw : {};
    const rawSignal = readString(obj, "lastSignal", "NONE");
    const lastSignal = rawSignal === "BUY" || rawSignal === "SELL" ? rawSignal : "NONE";
    const rawSide = readString(statsObj, "positionSide", "FLAT");
    const positionSide = rawSide === "LONG" || rawSide === "SHORT" || rawSide === "BOTH" ? rawSide : "FLAT";
    return {
        symbol: readString(obj, "symbol", "BTCUSDT"),
        sequenceNum: readBigInt(obj, "sequenceNum"),
        bidPrice: readNumber(obj, "bidPrice", 0),
        askPrice: readNumber(obj, "askPrice", 0),
        obi: readNumber(obj, "obi", 0),
        cvd: readNumber(obj, "cvd", 0),
        spreadVelocity: readNumber(obj, "spreadVelocity", 0),
        lastSignal,
        tickEvaluationLatencyUs: readNumber(obj, "tickEvaluationLatencyUs", 0),
        stats: {
            realizedPnl: readNumber(statsObj, "realizedPnl", 0),
            unrealizedPnl: readNumber(statsObj, "unrealizedPnl", 0),
            totalFees: readNumber(statsObj, "totalFees", 0),
            totalTrades: readNumber(statsObj, "totalTrades", 0),
            winningTrades: readNumber(statsObj, "winningTrades", 0),
            losingTrades: readNumber(statsObj, "losingTrades", 0),
            winRatePercent: readNumber(statsObj, "winRatePercent", 0),
            positionSide,
            netQuantity: readNumber(statsObj, "netQuantity", 0),
            averageEntryPrice: readNumber(statsObj, "averageEntryPrice", 0),
            totalSignalsLogged: readNumber(statsObj, "totalSignalsLogged", 0),
            totalExecutionsLogged: readNumber(statsObj, "totalExecutionsLogged", 0),
            avgTickLatencyUs: readNumber(statsObj, "avgTickLatencyUs", 0),
            bufferQueueDepth: readNumber(statsObj, "bufferQueueDepth", 0),
        },
        riskStatus: readString(obj, "riskStatus", "PASSED"),
        isEngineActive: readBoolean(obj, "isEngineActive"),
        usdtBalance: readNumber(obj, "usdtBalance", 0),
        aiDirection: readNumber(obj, "aiDirection", 0),
        aiConfidence: readNumber(obj, "aiConfidence", 0),
        rollingIc: readNumber(obj, "rollingIc", 0),
        aiInferenceLatencyNs: readBigInt(obj, "aiInferenceLatencyNs"),
        rttMs: readNumber(obj, "rttMs", 0),
        latencyPenalty: readNumber(obj, "latencyPenalty", 1.0),
        slippageTicks: readNumber(obj, "slippageTicks", 0),
    };
}
function encodeControlCommand(cmd) {
    const { controlCommand } = getProtoTypes();
    const payload = {
        action: cmd.action,
        modelPath: cmd.modelPath || "",
        timestamp: cmd.timestamp || Date.now(),
    };
    const message = controlCommand.create(payload);
    return controlCommand.encode(message).finish();
}
function decodeControlCommand(buffer) {
    const { controlCommand } = getProtoTypes();
    const message = controlCommand.decode(buffer);
    const rawObj = controlCommand.toObject(message, { enums: String, defaults: true });
    const object = isRecord(rawObj) ? rawObj : {};
    const rawAction = readString(object, "action", "ENGINE_PAUSE");
    const validAction = rawAction === "ENGINE_START" ||
        rawAction === "ENGINE_PAUSE" ||
        rawAction === "EMERGENCY_KILL" ||
        rawAction === "AI_HOT_SWAP"
        ? rawAction
        : "ENGINE_PAUSE";
    return {
        action: validAction,
        modelPath: readOptionalString(object, "modelPath"),
        timestamp: readOptionalNumber(object, "timestamp"),
    };
}
function encodeControlResponse(success, action, messageStr) {
    const { controlResponse } = getProtoTypes();
    const payload = {
        success,
        action,
        message: messageStr,
        timestamp: Date.now(),
    };
    const message = controlResponse.create(payload);
    return controlResponse.encode(message).finish();
}
