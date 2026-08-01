import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { RemoteRecalibrationClient } from "../ai/remoteRecalibrationClient";

/**
 * Dynamically resolve the Python binary executable path, prioritizing the project's virtual environment.
 */
function getPythonExecutable(projectRoot: string): string {
  const venvPythonWin = path.join(projectRoot, "training", ".venv", "Scripts", "python.exe");
  const venvPythonPosix = path.join(projectRoot, "training", ".venv", "bin", "python");

  if (fs.existsSync(venvPythonWin)) {
    return venvPythonWin;
  }
  if (fs.existsSync(venvPythonPosix)) {
    return venvPythonPosix;
  }

  return process.platform === "win32" ? "python" : "python3";
}

/**
 * Execute a child process with real-time inherited stdio streaming.
 */
function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: "inherit",
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code ?? "null"} (signal: ${signal ?? "none"})`));
      }
    });
  });
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const pythonCmd = getPythonExecutable(projectRoot);

  console.log("=".repeat(75));
  console.log("BATBOT_V11 MANUAL AI RECALIBRATION PIPELINE ORCHESTRATOR");
  console.log("=".repeat(75));
  console.log(`[BATBOT_V11] Resolved Python Virtualenv Runtime: '${pythonCmd}'`);

  const prepScript = path.join(projectRoot, "training", "prepare_data.py");

  try {
    console.log("\n[BATBOT_V11] STEP 1/2: Extracting T-KAN & CfC Features (prepare_data.py)...");
    console.log("-".repeat(75));
    await runCommand(pythonCmd, [prepScript], projectRoot);

    console.log("\n[BATBOT_V11] STEP 2/2: Training CfC Liquid Neural Network on Modal Serverless GPU...");
    console.log("-".repeat(75));
    const remoteClient = new RemoteRecalibrationClient();
    const success = await remoteClient.trainRemotely();

    if (!success) {
      throw new Error("Modal Cloud GPU training failed.");
    }

    console.log("\n" + "=".repeat(75));
    console.log("[BATBOT_V11] SUCCESS: New weights exported and ready for zero-lock hot-swap!");
    console.log("=".repeat(75));
  } catch (err: unknown) {
    console.error("\n" + "!".repeat(75));
    console.error(`[BATBOT_V11] MANUAL RECALIBRATION FAILED: ${err instanceof Error ? err.message : String(err)}`);
    console.error("!".repeat(75));
    process.exit(1);
  }
}

void main();

