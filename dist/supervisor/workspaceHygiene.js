"use strict";
/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * SOTA 2026 NATIVE AUTONOMOUS PROCESS SUPERVISOR
 *
 * Workspace Hygiene Engine: Autonomous detection and unlinking of residual lockfiles,
 * progress files, and orphaned subprocesses before launching Generation N+1.
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
exports.WorkspaceHygiene = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
class WorkspaceHygiene {
    defaultLockpaths = [
        "training/.training.lock",
        ".training.lock",
        "training/training_progress.json"
    ];
    /**
     * Sweeps and unlinks all residual lockfiles and progress markers from the workspace.
     * Returns list of purged file paths.
     */
    purgeResidualLockfiles(customPaths) {
        const targets = customPaths && customPaths.length > 0 ? customPaths : this.defaultLockpaths;
        const purged = [];
        for (const relPath of targets) {
            try {
                const fullPath = path.resolve(process.cwd(), relPath);
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                    purged.push(relPath);
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`\x1b[33m[WORKSPACE_HYGIENE_WARN]\x1b[0m Failed unlinking lockfile '${relPath}': ${msg}\n`);
            }
        }
        if (purged.length > 0) {
            process.stdout.write(`\x1b[32m[WORKSPACE_HYGIENE]\x1b[0m Purged ${purged.length} stale artifact(s): ${purged.join(", ")}\n`);
        }
        return purged;
    }
    /**
     * Identifies and terminates orphaned Python trainer child processes that may have
     * survived a sudden Node.js crash.
     */
    terminateOrphanTrainerProcesses() {
        if (process.platform === "win32") {
            try {
                // Find python processes running local_async_trainer.py and terminate
                const output = (0, node_child_process_1.execSync)('wmic process where "name=\'python.exe\' and commandline like \'%local_async_trainer%\'" get processid', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
                const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                for (const line of lines) {
                    const pid = parseInt(line, 10);
                    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
                        try {
                            process.kill(pid, "SIGTERM");
                            process.stdout.write(`\x1b[32m[WORKSPACE_HYGIENE]\x1b[0m Terminated orphaned Python trainer PID: ${pid}\n`);
                        }
                        catch {
                            // Ignore if already dead
                        }
                    }
                }
            }
            catch {
                // WMIC query might fail if no matching processes exist or on restricted permissions; non-fatal
            }
        }
        else {
            try {
                (0, node_child_process_1.execSync)("pkill -f local_async_trainer.py || true", { stdio: "ignore" });
            }
            catch {
                // Safe no-op
            }
        }
    }
    /**
     * Executes complete pre-flight de-contamination sweep.
     */
    decontaminate(customPaths) {
        const purged = this.purgeResidualLockfiles(customPaths);
        this.terminateOrphanTrainerProcesses();
        return purged;
    }
}
exports.WorkspaceHygiene = WorkspaceHygiene;
