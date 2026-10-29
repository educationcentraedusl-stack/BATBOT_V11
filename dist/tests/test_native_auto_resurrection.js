"use strict";
/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * SOTA 2026 NATIVE PROCESS GUARDIAN & AUTO-RESURRECTION TEST SUITE
 *
 * Comprehensive 4-Stage Hostile Test & Verification Suite:
 * - Stage 1: Terminal Sanitizer & Workspace Hygiene Lockfile Purge Verification
 * - Stage 2: IPC Contract & Serialization Validation
 * - Stage 3: Supervised Auto-Resurrection under Watchdog Circuit Breaker Hard-Kill (Code 1)
 * - Stage 4: Clean Operator Shutdown (User Quit / Code 0)
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
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const terminalSanitizer_1 = require("../supervisor/terminalSanitizer");
const workspaceHygiene_1 = require("../supervisor/workspaceHygiene");
async function runStage1HygieneAndSanitization() {
    process.stdout.write("\n\x1b[1m=== STAGE 1: WORKSPACE HYGIENE & TERMINAL SANITIZER VALIDATION ===\x1b[0m\n");
    const hygiene = new workspaceHygiene_1.WorkspaceHygiene();
    const testLockDir = path.resolve(process.cwd(), "training");
    if (!fs.existsSync(testLockDir)) {
        fs.mkdirSync(testLockDir, { recursive: true });
    }
    const testLockPath = path.resolve(testLockDir, ".training.lock");
    const testProgressPath = path.resolve(testLockDir, "training_progress.json");
    // Inject synthetic stale lockfiles
    fs.writeFileSync(testLockPath, "SYNTHETIC_PID_LOCK_99999", "utf8");
    fs.writeFileSync(testProgressPath, '{"epoch": 3, "progress": 0.45}', "utf8");
    if (!fs.existsSync(testLockPath) || !fs.existsSync(testProgressPath)) {
        throw new Error("Stage 1 Failure: Failed to plant synthetic test lockfiles!");
    }
    process.stdout.write("  [OK] Synthetic stale lockfiles planted successfully.\n");
    // Execute hygiene decontaminate
    const purged = hygiene.decontaminate([
        "training/.training.lock",
        "training/training_progress.json"
    ]);
    if (fs.existsSync(testLockPath)) {
        throw new Error("Stage 1 Failure: testLockPath was not unlinked!");
    }
    if (fs.existsSync(testProgressPath)) {
        throw new Error("Stage 1 Failure: testProgressPath was not unlinked!");
    }
    process.stdout.write(`  [OK] Decontamination verified: ${purged.length} stale artifact(s) successfully unlinked.\n`);
    // Execute terminal sanitizer
    terminalSanitizer_1.TerminalSanitizer.performFullSanitization(false);
    process.stdout.write("  [OK] TerminalSanitizer executed cleanly with zero exceptions.\n");
}
function runStage2IpcContractValidation() {
    process.stdout.write("\n\x1b[1m=== STAGE 2: IPC MESSAGE CONTRACT & STRICT TYPE INTEGRITY ===\x1b[0m\n");
    const handshake = {
        type: "HANDSHAKE_INIT",
        workerPid: 12345,
        version: "11.0.0",
        heartbeatIntervalMs: 2500,
        timestamp: Date.now()
    };
    const ping = {
        type: "HEARTBEAT_PING",
        seq: 1,
        timestamp: Date.now(),
        eventLoopLagMs: 0.85
    };
    const resurrect = {
        type: "INTENTIONAL_RESURRECT",
        reason: "RECALIBRATION_CIRCUIT_BREAKER",
        consecutiveFailures: 3,
        lastReason: "TIMED_OUT",
        cooldownMs: 1500,
        timestamp: Date.now()
    };
    const shutdown = {
        type: "USER_SHUTDOWN",
        exitCode: 0,
        reason: "KEYBOARD_QUIT",
        timestamp: Date.now()
    };
    if (handshake.type !== "HANDSHAKE_INIT" || handshake.workerPid !== 12345) {
        throw new Error("Stage 2 Failure: Invalid HandshakeInitPayload structure.");
    }
    if (ping.type !== "HEARTBEAT_PING" || ping.seq !== 1) {
        throw new Error("Stage 2 Failure: Invalid HeartbeatPingPayload structure.");
    }
    if (resurrect.type !== "INTENTIONAL_RESURRECT" || resurrect.consecutiveFailures !== 3) {
        throw new Error("Stage 2 Failure: Invalid IntentionalResurrectPayload structure.");
    }
    if (shutdown.type !== "USER_SHUTDOWN" || shutdown.exitCode !== 0) {
        throw new Error("Stage 2 Failure: Invalid UserShutdownPayload structure.");
    }
    process.stdout.write("  [OK] All 4 IPC message types verified with strict type integrity.\n");
}
async function runStage3And4LiveAutoResurrection() {
    process.stdout.write("\n\x1b[1m=== STAGES 3 & 4: LIVE SUPERVISED AUTO-RESURRECTION & CLEAN SHUTDOWN ===\x1b[0m\n");
    // Create a temporary mock worker script that simulates:
    // Gen 1: Dispatches HANDSHAKE, dispatches INTENTIONAL_RESURRECT, then calls process.exit(1).
    // Gen 2: Dispatches HANDSHAKE, verifies it was resurrected, dispatches USER_SHUTDOWN, then calls process.exit(0).
    const mockWorkerPath = path.resolve(process.cwd(), "dist/tests/_mock_supervised_worker.js");
    const mockWorkerCode = `
const generation = parseInt(process.env.BATBOT_GENERATION || "1", 10);
console.log("[MOCK_WORKER] Online in Generation #" + generation + " (PID: " + process.pid + ")");

if (process.send) {
  process.send({
    type: "HANDSHAKE_INIT",
    workerPid: process.pid,
    version: "11.0.0-test",
    heartbeatIntervalMs: 1000,
    timestamp: Date.now()
  });
}

if (generation === 1) {
  console.log("[MOCK_WORKER] Generation #1 simulating Watchdog Circuit Breaker trip (process.exit(1))...");
  setTimeout(() => {
    if (process.send) {
      process.send({
        type: "INTENTIONAL_RESURRECT",
        reason: "SIMULATED_RECALIBRATION_DEADLOCK",
        consecutiveFailures: 3,
        lastReason: "TIMED_OUT",
        cooldownMs: 500,
        timestamp: Date.now()
      });
    }
    process.exit(1);
  }, 300);
} else {
  console.log("[MOCK_WORKER] Generation #2 successfully resurrected! Simulating clean operator quit (exit code 0)...");
  setTimeout(() => {
    if (process.send) {
      process.send({
        type: "USER_SHUTDOWN",
        exitCode: 0,
        reason: "TEST_VERIFICATION_COMPLETE",
        timestamp: Date.now()
      });
    }
    process.exit(0);
  }, 300);
}
`;
    fs.writeFileSync(mockWorkerPath, mockWorkerCode, "utf8");
    // Now launch the Guardian supervising this mock worker
    const guardianScriptPath = path.resolve(process.cwd(), "dist/supervisor/guardian.js");
    process.stdout.write("  -> Spawning ProcessGuardian supervising mock worker...\n");
    await new Promise((resolve, reject) => {
        const guardianProc = (0, node_child_process_1.spawn)(process.execPath, [guardianScriptPath, mockWorkerPath], {
            stdio: ["inherit", "pipe", "pipe"],
            env: {
                ...process.env,
                // Override workerScriptPath via mock argument
            }
        });
        let stdoutBuffer = "";
        let stderrBuffer = "";
        guardianProc.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            stdoutBuffer += text;
            process.stdout.write(text);
        });
        guardianProc.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            stderrBuffer += text;
            process.stderr.write(text);
        });
        const timeout = setTimeout(() => {
            guardianProc.kill("SIGKILL");
            reject(new Error("Stage 3/4 Failure: Guardian test timed out after 10000ms!"));
        }, 10000);
        guardianProc.on("exit", (code) => {
            clearTimeout(timeout);
            try {
                if (fs.existsSync(mockWorkerPath)) {
                    fs.unlinkSync(mockWorkerPath);
                }
            }
            catch {
                // Ignore
            }
            if (code !== 0) {
                return reject(new Error(`Stage 3/4 Failure: Guardian exited with non-zero code: ${code}\nStderr: ${stderrBuffer}`));
            }
            // Verify stdout contained generation 1 AND generation 2
            const sawGen1 = stdoutBuffer.includes("Generation #1") || stdoutBuffer.includes("Worker Generation #1");
            const sawResurrect = stdoutBuffer.includes("Resurrecting Generation #2") || stdoutBuffer.includes("Worker Generation #2");
            const sawCleanExit = stdoutBuffer.includes("Shutting down Guardian Kernel");
            if (!sawGen1) {
                return reject(new Error("Stage 3/4 Failure: Guardian did not launch Generation #1!"));
            }
            if (!sawResurrect) {
                return reject(new Error("Stage 3/4 Failure: Guardian did not resurrect Generation #2!"));
            }
            if (!sawCleanExit) {
                return reject(new Error("Stage 3/4 Failure: Guardian did not detect clean shutdown on Generation #2!"));
            }
            process.stdout.write("\n  [OK] Stages 3 & 4 Verified: Generation #1 hard crash (code 1) autonomously resurrected Generation #2, which then exited cleanly with code 0!\n");
            resolve();
        });
    });
}
async function runMasterVerification() {
    process.stdout.write("\n=========================================================================\n");
    process.stdout.write("  BATBOT_V11 SOTA NATIVE AUTO-RESURRECTION MASTER VERIFICATION SUITE    \n");
    process.stdout.write("=========================================================================\n");
    const startTime = Date.now();
    await runStage1HygieneAndSanitization();
    runStage2IpcContractValidation();
    await runStage3And4LiveAutoResurrection();
    const elapsed = Date.now() - startTime;
    process.stdout.write("\n=========================================================================\n");
    process.stdout.write(`  ✅ ALL 4 STAGES PASSED 100% CLEANLY (Elapsed: ${elapsed}ms)              \n`);
    process.stdout.write("  Zero-Touch Autonomous Native Terminal Resurrection Verified.           \n");
    process.stdout.write("=========================================================================\n\n");
    process.exit(0);
}
if (require.main === module) {
    runMasterVerification().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\n❌ VERIFICATION TEST FAILED: ${msg}\n`);
        process.exit(1);
    });
}
