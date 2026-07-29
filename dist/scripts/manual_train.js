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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
/**
 * Dynamically resolve the Python binary executable path, prioritizing the project's virtual environment.
 */
function getPythonExecutable(projectRoot) {
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
function runCommand(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, {
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
            }
            else {
                reject(new Error(`Process exited with code ${code ?? "null"} (signal: ${signal ?? "none"})`));
            }
        });
    });
}
async function main() {
    const projectRoot = process.cwd();
    const pythonCmd = getPythonExecutable(projectRoot);
    console.log("=".repeat(75));
    console.log("BATBOT_V11 MANUAL AI RECALIBRATION PIPELINE ORCHESTRATOR");
    console.log("=".repeat(75));
    console.log(`[BATBOT_V11] Resolved Python Virtualenv Runtime: '${pythonCmd}'`);
    const prepScript = path.join(projectRoot, "training", "prepare_data.py");
    const trainScript = path.join(projectRoot, "training", "train_cfc.py");
    try {
        console.log("\n[BATBOT_V11] STEP 1/2: Extracting T-KAN & CfC Features (prepare_data.py)...");
        console.log("-".repeat(75));
        await runCommand(pythonCmd, [prepScript], projectRoot);
        console.log("\n[BATBOT_V11] STEP 2/2: Training CfC Liquid Neural Network (train_cfc.py)...");
        console.log("-".repeat(75));
        await runCommand(pythonCmd, [trainScript], projectRoot);
        console.log("\n" + "=".repeat(75));
        console.log("[BATBOT_V11] SUCCESS: New weights exported and ready for zero-lock hot-swap!");
        console.log("=".repeat(75));
    }
    catch (err) {
        console.error("\n" + "!".repeat(75));
        console.error(`[BATBOT_V11] MANUAL RECALIBRATION FAILED: ${err instanceof Error ? err.message : String(err)}`);
        console.error("!".repeat(75));
        process.exit(1);
    }
}
void main();
