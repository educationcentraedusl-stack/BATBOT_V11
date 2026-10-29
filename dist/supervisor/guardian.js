"use strict";
/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * SOTA 2026 NATIVE AUTONOMOUS PROCESS SUPERVISOR & GUARDIAN KERNEL
 *
 * Indestructible Root Guardian: Runs directly in terminal, executes zero heavy logic,
 * supervises the HFT Worker with full TTY pass-through, listens for IPC heartbeats,
 * decontaminates workspace locks, and performs autonomous zero-touch resurrection.
 */
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
exports.ProcessGuardian = void 0;
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const terminalSanitizer_1 = require("./terminalSanitizer");
const workspaceHygiene_1 = require("./workspaceHygiene");
class ProcessGuardian {
    config;
    hygiene;
    activeWorker = null;
    generation = 0;
    consecutiveCrashes = 0;
    lastCrashWindowStartMs = 0;
    workerStartTimeMs = 0;
    lastHeartbeatTs = 0;
    heartbeatWatchdogTimer = null;
    isUserShutdownRequested = false;
    pendingIntentionalResurrectCooldownMs = 0;
    constructor(customConfig) {
        this.hygiene = new workspaceHygiene_1.WorkspaceHygiene();
        const cliTarget = process.argv[2] && (process.argv[2].endsWith(".js") || process.argv[2].endsWith(".ts"))
            ? path.resolve(process.cwd(), process.argv[2])
            : null;
        const defaultScript = cliTarget ?? path.resolve(process.cwd(), "dist/scripts/run_tui_dashboard.js");
        this.config = {
            workerScriptPath: customConfig?.workerScriptPath ?? defaultScript,
            heartbeatIntervalMs: customConfig?.heartbeatIntervalMs ?? 2500,
            heartbeatTimeoutMs: customConfig?.heartbeatTimeoutMs ?? 15000,
            crashWindowMs: customConfig?.crashWindowMs ?? 60000,
            maxCrashThreshold: customConfig?.maxCrashThreshold ?? 5,
            baseBackoffMs: customConfig?.baseBackoffMs ?? 1000,
            maxBackoffMs: customConfig?.maxBackoffMs ?? 15000,
            healthyRunResetThresholdMs: customConfig?.healthyRunResetThresholdMs ?? 90000,
            lockfilePaths: customConfig?.lockfilePaths ?? [
                "training/.training.lock",
                ".training.lock",
                "training/training_progress.json"
            ]
        };
        this.registerSignalHandlers();
    }
    /**
     * Starts the Guardian supervision loop.
     */
    start() {
        process.stdout.write(`\x1b[1m\x1b[32m[BATBOT_GUARDIAN_INIT]\x1b[0m Root Process Guardian online (Kernel PID: ${process.pid}).\n` +
            `  - Supervised Target: ${path.relative(process.cwd(), this.config.workerScriptPath)}\n` +
            `  - Resilience Mode: Zero-Touch Autonomous Self-Healing Active.\n\n`);
        this.spawnNextGeneration();
    }
    /**
     * Spawns Generation N+1 of the HFT Worker with full TTY pass-through and IPC channel.
     */
    spawnNextGeneration() {
        this.generation++;
        this.workerStartTimeMs = Date.now();
        this.lastHeartbeatTs = Date.now();
        this.pendingIntentionalResurrectCooldownMs = 0;
        // 1. Pre-Flight Workspace Decontamination
        this.hygiene.decontaminate(this.config.lockfilePaths);
        // 2. Terminal Sanitization
        terminalSanitizer_1.TerminalSanitizer.resetAttributes();
        process.stdout.write(`\x1b[35m[BATBOT_GUARDIAN]\x1b[0m Spawning Worker Generation #${this.generation}...\n`);
        // 3. Spawn child with stdio: [0: inherit, 1: inherit, 2: inherit, 3: ipc]
        // Inherited stdio guarantees 100% native TTY fidelity, raw mode input, and 60 FPS double-buffered TUI.
        const isTargetFromCli = process.argv[2] && path.resolve(process.cwd(), process.argv[2]) === this.config.workerScriptPath;
        const extraArgs = isTargetFromCli ? process.argv.slice(3) : process.argv.slice(2);
        const workerArgs = [this.config.workerScriptPath, ...extraArgs];
        const child = (0, node_child_process_1.spawn)(process.execPath, workerArgs, {
            stdio: ["inherit", "inherit", "inherit", "ipc"],
            env: {
                ...process.env,
                BATBOT_SUPERVISED: "1",
                BATBOT_GENERATION: String(this.generation),
                FORCE_COLOR: "1"
            },
            cwd: process.cwd()
        });
        this.activeWorker = child;
        this.setupWorkerIpcListeners(child);
        this.setupHeartbeatWatchdog(child);
        // 4. Handle worker exit
        child.once("exit", (code, signal) => {
            this.handleWorkerExit(code, signal);
        });
        child.once("error", (err) => {
            process.stderr.write(`\x1b[31m[BATBOT_GUARDIAN_ERROR]\x1b[0m Worker spawn fault: ${err.message}\n`);
        });
    }
    /**
     * Sets up bidirectional IPC messaging over File Descriptor 3.
     */
    setupWorkerIpcListeners(worker) {
        worker.on("message", (msg) => {
            if (!msg || typeof msg !== "object")
                return;
            const payload = msg;
            switch (payload.type) {
                case "HANDSHAKE_INIT": {
                    this.lastHeartbeatTs = Date.now();
                    process.stdout.write(`\x1b[32m[BATBOT_GUARDIAN]\x1b[0m Handshake confirmed with Worker (PID: ${payload.workerPid}, v${payload.version}).\n`);
                    break;
                }
                case "HEARTBEAT_PING": {
                    this.lastHeartbeatTs = Date.now();
                    const response = {
                        type: "HEARTBEAT_PONG",
                        ackSeq: payload.seq,
                        timestamp: Date.now()
                    };
                    if (worker.send) {
                        worker.send(response);
                    }
                    break;
                }
                case "INTENTIONAL_RESURRECT": {
                    process.stdout.write(`\n\x1b[33m\x1b[1m[BATBOT_GUARDIAN]\x1b[0m Intentional auto-resurrection requested by worker.\n` +
                        `  Reason: ${payload.reason}\n` +
                        `  Consecutive Failures: ${payload.consecutiveFailures}\n` +
                        `  Cooldown: ${payload.cooldownMs}ms\n`);
                    this.pendingIntentionalResurrectCooldownMs = Math.max(1000, payload.cooldownMs);
                    break;
                }
                case "USER_SHUTDOWN": {
                    this.isUserShutdownRequested = true;
                    process.stdout.write(`\x1b[36m[BATBOT_GUARDIAN]\x1b[0m User intentional shutdown flagged (Exit code: ${payload.exitCode}).\n`);
                    break;
                }
                case "WORKER_TELEMETRY": {
                    // Worker diagnostics snapshot
                    break;
                }
                default:
                    break;
            }
        });
    }
    /**
     * Watchdog timer monitoring event-loop responsiveness of the worker.
     */
    setupHeartbeatWatchdog(worker) {
        if (this.heartbeatWatchdogTimer) {
            clearInterval(this.heartbeatWatchdogTimer);
        }
        this.heartbeatWatchdogTimer = setInterval(() => {
            if (this.activeWorker !== worker)
                return;
            const elapsed = Date.now() - this.lastHeartbeatTs;
            if (elapsed > this.config.heartbeatTimeoutMs) {
                process.stderr.write(`\n\x1b[31m\x1b[1m[BATBOT_GUARDIAN_DEADLOCK_ALARM]\x1b[0m Worker unresponsive for ${elapsed}ms! ` +
                    `Event loop freeze detected. Terminating PID: ${worker.pid}...\n`);
                try {
                    worker.kill("SIGKILL");
                }
                catch {
                    // Ignore if process already died
                }
            }
        }, this.config.heartbeatIntervalMs);
    }
    /**
     * Handles child process exit, sanitizes terminal, cleans workspace, and triggers resurrection.
     */
    handleWorkerExit(code, signal) {
        if (this.heartbeatWatchdogTimer) {
            clearInterval(this.heartbeatWatchdogTimer);
            this.heartbeatWatchdogTimer = null;
        }
        this.activeWorker = null;
        const now = Date.now();
        const uptimeMs = now - this.workerStartTimeMs;
        // Terminal and workspace sanitization
        terminalSanitizer_1.TerminalSanitizer.performFullSanitization(false);
        // Check if shutdown was requested cleanly by user ('q' or exit code 0)
        if (this.isUserShutdownRequested || code === 0) {
            process.stdout.write(`\x1b[32m[BATBOT_GUARDIAN]\x1b[0m Worker terminated cleanly (Code: ${code}, Signal: ${signal}). ` +
                `Shutting down Guardian Kernel.\n`);
            process.exit(0);
            return;
        }
        // Evaluate Crash Window (Leaky Bucket)
        if (now - this.lastCrashWindowStartMs > this.config.crashWindowMs) {
            this.consecutiveCrashes = 1;
            this.lastCrashWindowStartMs = now;
        }
        else {
            this.consecutiveCrashes++;
        }
        // If worker ran healthily for > threshold, reset crash penalty
        if (uptimeMs >= this.config.healthyRunResetThresholdMs) {
            this.consecutiveCrashes = 1;
        }
        const isIntentional = this.pendingIntentionalResurrectCooldownMs > 0;
        // Crash Loop Protection Check
        if (!isIntentional && this.consecutiveCrashes > this.config.maxCrashThreshold) {
            process.stderr.write(`\n\x1b[31m\x1b[1m[BATBOT_GUARDIAN_EMERGENCY_HALT]\x1b[0m Exceeded ${this.config.maxCrashThreshold} ` +
                `unhandled crashes within ${this.config.crashWindowMs / 1000}s! Host protection engaged. Halting.\n`);
            process.exit(1);
            return;
        }
        // Calculate Backoff with Decorrelated Jitter
        let backoffDelayMs;
        if (isIntentional) {
            backoffDelayMs = this.pendingIntentionalResurrectCooldownMs;
        }
        else {
            const exponent = Math.min(this.consecutiveCrashes - 1, 5);
            const baseDelay = this.config.baseBackoffMs * Math.pow(2, exponent);
            const jitter = Math.floor(Math.random() * 500);
            backoffDelayMs = Math.min(baseDelay + jitter, this.config.maxBackoffMs);
        }
        const report = {
            generation: this.generation,
            crashTimestamp: now,
            exitCode: code,
            signal,
            intentional: isIntentional,
            reason: isIntentional ? "CIRCUIT_BREAKER_TRIPPED" : "UNHANDLED_EXCEPTION_OR_CRASH",
            consecutiveCrashesInWindow: this.consecutiveCrashes,
            backoffAppliedMs: backoffDelayMs,
            totalUptimeMs: uptimeMs
        };
        process.stdout.write(`\x1b[33m[BATBOT_GUARDIAN]\x1b[0m Worker Gen #${report.generation} exited ` +
            `(Code: ${report.exitCode}, Signal: ${report.signal}, Reason: ${report.reason}).\n` +
            `  - Zero-Touch Self-Healing: Resurrecting Generation #${this.generation + 1} ` +
            `in ${(backoffDelayMs / 1000).toFixed(1)}s...\n\n`);
        setTimeout(() => {
            this.spawnNextGeneration();
        }, backoffDelayMs);
    }
    /**
     * Forwards operating system signals to the active worker and ensures clean terminal state.
     */
    registerSignalHandlers() {
        const handleSignal = (sig) => {
            this.isUserShutdownRequested = true;
            if (this.activeWorker && !this.activeWorker.killed) {
                try {
                    this.activeWorker.kill(sig);
                }
                catch {
                    // Ignore
                }
            }
            setTimeout(() => {
                terminalSanitizer_1.TerminalSanitizer.performFullSanitization(false);
                process.exit(0);
            }, 500);
        };
        process.once("SIGINT", () => handleSignal("SIGINT"));
        process.once("SIGTERM", () => handleSignal("SIGTERM"));
        if (process.platform === "win32") {
            process.once("SIGBREAK", () => handleSignal("SIGBREAK"));
        }
    }
}
exports.ProcessGuardian = ProcessGuardian;
// Direct Execution Entrypoint
if (require.main === module) {
    const guardian = new ProcessGuardian();
    guardian.start();
}
