import * as protobuf from "protobufjs";
import * as path from "path";
import * as fs from "fs";
import { TelemetryFrame } from "./dashboard";

let root: protobuf.Root | null = null;
let TelemetryFrameMsg: protobuf.Type | null = null;
let ControlCommandMsg: protobuf.Type | null = null;
let ControlResponseMsg: protobuf.Type | null = null;

export function initProtobuf(): void {
  if (root) return;
  
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

export interface ControlCommand {
  action: "ENGINE_START" | "ENGINE_PAUSE" | "EMERGENCY_KILL" | "AI_HOT_SWAP";
  modelPath?: string;
  timestamp?: number;
}

export function decodeControlCommand(buffer: Uint8Array): ControlCommand {
  if (!ControlCommandMsg) initProtobuf();
  const message = ControlCommandMsg!.decode(buffer);
  const object = ControlCommandMsg!.toObject(message, { enums: String });
  return {
    action: object.action as any,
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
