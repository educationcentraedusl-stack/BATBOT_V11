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
exports.decodeControlCommand = decodeControlCommand;
exports.encodeControlResponse = encodeControlResponse;
const protobuf = __importStar(require("protobufjs"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
let root = null;
let TelemetryFrameMsg = null;
let ControlCommandMsg = null;
let ControlResponseMsg = null;
function initProtobuf() {
    if (root)
        return;
    const possiblePaths = [
        path.resolve(__dirname, "telemetry.proto"),
        path.resolve(__dirname, "../../src/telemetry/telemetry.proto"),
        path.resolve(process.cwd(), "src/telemetry/telemetry.proto"),
        path.resolve(process.cwd(), "dist/telemetry/telemetry.proto"),
    ];
    let protoPath = possiblePaths.find((p) => fs.existsSync(p));
    if (!protoPath) {
        throw new Error(`telemetry.proto file not found in paths: ${possiblePaths.join(", ")}`);
    }
    root = protobuf.loadSync(protoPath);
    TelemetryFrameMsg = root.lookupType("batbot.telemetry.TelemetryFrameProto");
    ControlCommandMsg = root.lookupType("batbot.telemetry.ControlCommandProto");
    ControlResponseMsg = root.lookupType("batbot.telemetry.ControlResponseProto");
}
function encodeTelemetryFrame(frame, timestamp = Date.now()) {
    if (!TelemetryFrameMsg)
        initProtobuf();
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
    const err = TelemetryFrameMsg.verify(payload);
    if (err) {
        throw new Error(`Protobuf verification failed: ${err}`);
    }
    const message = TelemetryFrameMsg.create(payload);
    return TelemetryFrameMsg.encode(message).finish();
}
function decodeControlCommand(buffer) {
    if (!ControlCommandMsg)
        initProtobuf();
    const message = ControlCommandMsg.decode(buffer);
    const object = ControlCommandMsg.toObject(message, { enums: String });
    return {
        action: object.action,
        modelPath: object.modelPath,
        timestamp: object.timestamp,
    };
}
function encodeControlResponse(success, action, messageStr) {
    if (!ControlResponseMsg)
        initProtobuf();
    const payload = {
        success,
        action,
        message: messageStr,
        timestamp: Date.now(),
    };
    const message = ControlResponseMsg.create(payload);
    return ControlResponseMsg.encode(message).finish();
}
