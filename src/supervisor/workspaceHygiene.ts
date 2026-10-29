/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * SOTA 2026 NATIVE AUTONOMOUS PROCESS SUPERVISOR
 * 
 * Workspace Hygiene Engine: Autonomous detection and unlinking of residual lockfiles,
 * progress files, and orphaned subprocesses before launching Generation N+1.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export class WorkspaceHygiene {
  private readonly defaultLockpaths: readonly string[] = [
    "training/.training.lock",
    ".training.lock",
    "training/training_progress.json"
  ];

  /**
   * Sweeps and unlinks all residual lockfiles and progress markers from the workspace.
   * Returns list of purged file paths.
   */
  public purgeResidualLockfiles(customPaths?: readonly string[]): string[] {
    const targets = customPaths && customPaths.length > 0 ? customPaths : this.defaultLockpaths;
    const purged: string[] = [];

    for (const relPath of targets) {
      try {
        const fullPath = path.resolve(process.cwd(), relPath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          purged.push(relPath);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `\x1b[33m[WORKSPACE_HYGIENE_WARN]\x1b[0m Failed unlinking lockfile '${relPath}': ${msg}\n`
        );
      }
    }

    if (purged.length > 0) {
      process.stdout.write(
        `\x1b[32m[WORKSPACE_HYGIENE]\x1b[0m Purged ${purged.length} stale artifact(s): ${purged.join(", ")}\n`
      );
    }

    return purged;
  }

  /**
   * Identifies and terminates orphaned Python trainer child processes that may have
   * survived a sudden Node.js crash.
   */
  public terminateOrphanTrainerProcesses(): void {
    if (process.platform === "win32") {
      try {
        // Find python processes running local_async_trainer.py and terminate
        const output = execSync(
          'wmic process where "name=\'python.exe\' and commandline like \'%local_async_trainer%\'" get processid',
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        );
        const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          const pid = parseInt(line, 10);
          if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
            try {
              process.kill(pid, "SIGTERM");
              process.stdout.write(
                `\x1b[32m[WORKSPACE_HYGIENE]\x1b[0m Terminated orphaned Python trainer PID: ${pid}\n`
              );
            } catch {
              // Ignore if already dead
            }
          }
        }
      } catch {
        // WMIC query might fail if no matching processes exist or on restricted permissions; non-fatal
      }
    } else {
      try {
        execSync("pkill -f local_async_trainer.py || true", { stdio: "ignore" });
      } catch {
        // Safe no-op
      }
    }
  }

  /**
   * Executes complete pre-flight de-contamination sweep.
   */
  public decontaminate(customPaths?: readonly string[]): string[] {
    const purged = this.purgeResidualLockfiles(customPaths);
    this.terminateOrphanTrainerProcesses();
    return purged;
  }
}

