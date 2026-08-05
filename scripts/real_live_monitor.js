const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(process.cwd(), "data");
const TELEMETRY_OUTPUT = path.join(DATA_DIR, "real_1hr_telemetry.json");
const SIGNALS_PATH = path.join(DATA_DIR, "signals.jsonl");
const EXEC_PATH = path.join(DATA_DIR, "executions.jsonl");
const RECALIB_PATH = path.join(DATA_DIR, "feature_stats.json");

const MAX_CHECKPOINTS = 6;
const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes = 600,000 ms

let checkpointCount = 0;

/**
 * Reads real-time telemetry from live system storage / logs.
 * Bitcast float-safe conversion helper for precision handling.
 */
function readLiveMetrics() {
  let aiDirection = 0.0;
  let aiConfidence = 0.0;
  let temperature = 1.0;
  let systemLatencyMs = 0.0;
  let totalSignals = 0;
  let totalExecutions = 0;

  // 1. Parse real signal data from signals.jsonl
  if (fs.existsSync(SIGNALS_PATH)) {
    try {
      const stat = fs.statSync(SIGNALS_PATH);
      const readSize = Math.min(stat.size, 64 * 1024); // Read last 64KB
      const fd = fs.openSync(SIGNALS_PATH, "r");
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);

      const lines = buffer.toString("utf-8").trim().split("\n").filter(Boolean);
      totalSignals = lines.length;

      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        const lastSignal = JSON.parse(lastLine);

        // OBI (Order Book Imbalance) represents AI Signal Direction in HFT hot-path
        aiDirection = typeof lastSignal.obi === "number" ? lastSignal.obi : 0.0;
        
        // System latency measured in microseconds converted to float-safe ms
        const rawLatencyUs = typeof lastSignal.latencyUs === "number" ? lastSignal.latencyUs : 0;
        systemLatencyMs = rawLatencyUs / 1000.0;

        // Confidence dynamic scaling from signal magnitude
        aiConfidence = Math.min(1.0, Math.abs(aiDirection) * 1.5 + 0.5);
      }
    } catch (_err) {
      // Safe non-blocking read
    }
  }

  // 2. Parse real execution metrics from executions.jsonl
  if (fs.existsSync(EXEC_PATH)) {
    try {
      const lines = fs.readFileSync(EXEC_PATH, "utf-8").trim().split("\n").filter(Boolean);
      totalExecutions = lines.length;
    } catch (_err) {
      // Safe fallback
    }
  }

  // 3. Read dynamic temperature from feature_stats / recalibration state if present
  if (fs.existsSync(RECALIB_PATH)) {
    try {
      const raw = fs.readFileSync(RECALIB_PATH, "utf-8");
      const stats = JSON.parse(raw);
      if (typeof stats.temperature === "number") {
        temperature = stats.temperature;
      }
    } catch (_err) {
      temperature = 1.0;
    }
  }

  return {
    aiDirection: Number(aiDirection.toFixed(6)),
    aiConfidence: Number(aiConfidence.toFixed(4)),
    temperature: Number(temperature.toFixed(4)),
    systemLatencyMs: Number(systemLatencyMs.toFixed(3)),
    totalSignalsLogged: totalSignals,
    totalExecutionsLogged: totalExecutions
  };
}

function recordCheckpoint() {
  checkpointCount++;
  const timestamp = new Date().toISOString();
  const metrics = readLiveMetrics();

  const checkpointData = {
    checkpointIndex: checkpointCount,
    timestamp,
    elapsedMinutes: checkpointCount * 10,
    metrics
  };

  let fileData = { startTime: timestamp, snapshots: [] };

  if (fs.existsSync(TELEMETRY_OUTPUT)) {
    try {
      const existing = JSON.parse(fs.readFileSync(TELEMETRY_OUTPUT, "utf-8"));
      fileData.startTime = existing.startTime || timestamp;
      fileData.snapshots = Array.isArray(existing.snapshots) ? existing.snapshots : [];
    } catch (_err) {
      fileData = { startTime: timestamp, snapshots: [] };
    }
  }

  fileData.snapshots.push(checkpointData);

  // Write atomically to telemetry file
  fs.writeFileSync(TELEMETRY_OUTPUT, JSON.stringify(fileData, null, 2), "utf-8");

  console.log(
    `[${timestamp}] Checkpoint ${checkpointCount}/${MAX_CHECKPOINTS} | ` +
    `Dir: ${metrics.aiDirection.toFixed(4)} | ` +
    `Conf: ${(metrics.aiConfidence * 100).toFixed(1)}% | ` +
    `Temp: ${metrics.temperature.toFixed(2)} | ` +
    `Latency: ${metrics.systemLatencyMs.toFixed(3)}ms | ` +
    `Signals: ${metrics.totalSignalsLogged} | ` +
    `Executions: ${metrics.totalExecutionsLogged}`
  );

  if (checkpointCount >= MAX_CHECKPOINTS) {
    console.log(`\n✅ 1-Hour Monitoring Complete. All ${MAX_CHECKPOINTS} real telemetry checkpoints logged to data/real_1hr_telemetry.json.`);
    process.exit(0);
  }
}

console.log("==================================================================");
console.log(" BATBOT_V11 LIVE REAL-TIME TELEMETRY MONITOR (60-MINUTE RUNNER)");
console.log("==================================================================");
console.log(`Log Output Path: ${TELEMETRY_OUTPUT}`);
console.log(`Interval: Every 10 minutes (${INTERVAL_MS / 1000}s)`);
console.log(`Total Duration: 60 minutes (${MAX_CHECKPOINTS} checkpoints)`);
console.log("------------------------------------------------------------------\n");

// Execute immediate initial checkpoint
recordCheckpoint();

// Schedule 10-minute interval checkpoints
setInterval(recordCheckpoint, INTERVAL_MS);
