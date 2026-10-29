/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * SOTA 2026 NATIVE AUTONOMOUS PROCESS SUPERVISOR & AUTO-RESURRECTION ARCHITECTURE
 * 
 * Strict TypeScript Protocol Definitions (Zero-Any Casting, noImplicitAny: true)
 */

export type WorkerMessageType =
  | "HANDSHAKE_INIT"
  | "HEARTBEAT_PING"
  | "INTENTIONAL_RESURRECT"
  | "USER_SHUTDOWN"
  | "WORKER_TELEMETRY";

export type SupervisorMessageType =
  | "HEARTBEAT_PONG"
  | "TERMINAL_RESET"
  | "FORCE_CLEANUP_ACK"
  | "SHUTDOWN_SIGNAL";

export interface HandshakeInitPayload {
  readonly type: "HANDSHAKE_INIT";
  readonly workerPid: number;
  readonly version: string;
  readonly heartbeatIntervalMs: number;
  readonly timestamp: number;
}

export interface HeartbeatPingPayload {
  readonly type: "HEARTBEAT_PING";
  readonly seq: number;
  readonly timestamp: number;
  readonly eventLoopLagMs?: number;
}

export interface IntentionalResurrectPayload {
  readonly type: "INTENTIONAL_RESURRECT";
  readonly reason: string;
  readonly consecutiveFailures: number;
  readonly lastReason?: string;
  readonly cooldownMs: number;
  readonly timestamp: number;
}

export interface UserShutdownPayload {
  readonly type: "USER_SHUTDOWN";
  readonly exitCode: number;
  readonly reason?: string;
  readonly timestamp: number;
}

export interface WorkerTelemetryPayload {
  readonly type: "WORKER_TELEMETRY";
  readonly memoryUsageMb: number;
  readonly activeAssetCount: number;
  readonly totalTrades: number;
  readonly timestamp: number;
}

export type WorkerMessage =
  | HandshakeInitPayload
  | HeartbeatPingPayload
  | IntentionalResurrectPayload
  | UserShutdownPayload
  | WorkerTelemetryPayload;

export interface HeartbeatPongPayload {
  readonly type: "HEARTBEAT_PONG";
  readonly ackSeq: number;
  readonly timestamp: number;
}

export interface TerminalResetPayload {
  readonly type: "TERMINAL_RESET";
  readonly timestamp: number;
}

export interface ForceCleanupAckPayload {
  readonly type: "FORCE_CLEANUP_ACK";
  readonly purgedFiles: readonly string[];
  readonly timestamp: number;
}

export interface ShutdownSignalPayload {
  readonly type: "SHUTDOWN_SIGNAL";
  readonly reason: string;
  readonly timestamp: number;
}

export type SupervisorMessage =
  | HeartbeatPongPayload
  | TerminalResetPayload
  | ForceCleanupAckPayload
  | ShutdownSignalPayload;

export interface SupervisorConfig {
  /** Path to the worker script file to execute */
  readonly workerScriptPath: string;
  /** Milliseconds between expected worker heartbeat pings */
  readonly heartbeatIntervalMs: number;
  /** Milliseconds without a heartbeat before assuming worker deadlock and forcefully terminating */
  readonly heartbeatTimeoutMs: number;
  /** Leaky-bucket sliding window to evaluate crash loops (ms) */
  readonly crashWindowMs: number;
  /** Maximum allowable rapid crashes within crashWindowMs before tripping hard failure circuit breaker */
  readonly maxCrashThreshold: number;
  /** Base backoff delay for crashes (ms) */
  readonly baseBackoffMs: number;
  /** Maximum backoff delay for crashes with jitter (ms) */
  readonly maxBackoffMs: number;
  /** Milliseconds worker must run continuously without crashing to reset crash counter */
  readonly healthyRunResetThresholdMs: number;
  /** Relative or absolute lockfile paths to cleanse prior to reboot */
  readonly lockfilePaths: readonly string[];
}

export interface CrashIncidentReport {
  readonly generation: number;
  readonly crashTimestamp: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly intentional: boolean;
  readonly reason: string;
  readonly consecutiveCrashesInWindow: number;
  readonly backoffAppliedMs: number;
  readonly totalUptimeMs: number;
}

