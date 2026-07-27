"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLIDashboard = void 0;
class CLIDashboard {
    enabled;
    lastRenderTimestamp = 0;
    renderIntervalMs = 200; // 5Hz UI refresh rate to save CPU/GPU
    constructor(enabled = true) {
        this.enabled = enabled;
    }
    /**
     * Renders real-time HFT telemetry frame directly to stdout using ANSI control codes.
     */
    render(frame) {
        if (!this.enabled)
            return;
        const now = Date.now();
        if (now - this.lastRenderTimestamp < this.renderIntervalMs) {
            return;
        }
        this.lastRenderTimestamp = now;
        const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        const spread = (frame.askPrice - frame.bidPrice).toFixed(2);
        const obiBar = this.formatProgressBar(frame.obi, -1, 1, 20);
        const unrealizedColor = frame.stats.unrealizedPnl >= 0 ? "\x1b[32m" : "\x1b[31m";
        const pnlColor = frame.stats.realizedPnl >= 0 ? "\x1b[32m" : "\x1b[31m";
        const signalColor = frame.lastSignal === "BUY" ? "\x1b[32m" : frame.lastSignal === "SELL" ? "\x1b[31m" : "\x1b[90m";
        const posSideColor = frame.stats.positionSide === "LONG" ? "\x1b[32m" : frame.stats.positionSide === "SHORT" ? "\x1b[31m" : "\x1b[33m";
        const reset = "\x1b[0m";
        const cyan = "\x1b[36m";
        const yellow = "\x1b[33m";
        const bold = "\x1b[1m";
        const green = "\x1b[32m";
        const clearLine = "\x1b[K";
        let output = "";
        output += "\x1b[H"; // Move cursor to top-left (0,0) without full screen erase to eliminate flicker
        output += `${cyan}${bold}================================================================================${reset}${clearLine}\n`;
        output += `${cyan}${bold}            BATBOT_V11 HFT ENGINE TELEMETRY & COMMAND MONITOR                   ${reset}${clearLine}\n`;
        output += `${cyan}${bold}================================================================================${reset}${clearLine}\n`;
        output += ` Status: ${frame.isEngineActive ? "\x1b[32m[LIVE ACTIVE]\x1b[0m" : "\x1b[33m[IDLE/PAUSED]\x1b[0m"}  |  Memory: ${memMb} MB  |  Sequence: #${frame.sequenceNum.toString()}${clearLine}\n`;
        output += ` Tick Latency: ${yellow}${frame.tickEvaluationLatencyUs.toFixed(3)} µs${reset}  |  Avg Latency: ${frame.stats.avgTickLatencyUs.toFixed(3)} µs  |  Queue Depth: ${frame.stats.bufferQueueDepth}${clearLine}\n`;
        output += `--------------------------------------------------------------------------------${clearLine}\n`;
        output += `${bold}--- ORDER BOOK & MICROSTRUCTURE METRICS (${frame.symbol}) ---${reset}${clearLine}\n`;
        output += ` Best Bid: ${frame.bidPrice.toFixed(2)}  |  Best Ask: ${frame.askPrice.toFixed(2)}  |  Spread: ${spread}${clearLine}\n`;
        output += ` OBI (-1..+1): [${obiBar}]  Val: ${frame.obi >= 0 ? "+" : ""}${frame.obi.toFixed(4)}${clearLine}\n`;
        output += ` CVD: ${frame.cvd >= 0 ? "+" : ""}${frame.cvd.toFixed(2)}  |  Spread Velocity: ${frame.spreadVelocity.toFixed(4)}${clearLine}\n`;
        output += `--------------------------------------------------------------------------------${clearLine}\n`;
        output += `${bold}--- STRATEGY & RISK STATUS ---${reset}${clearLine}\n`;
        output += ` Active Signal: ${signalColor}${bold}${frame.lastSignal}${reset}  |  Risk Gate: ${frame.riskStatus}${clearLine}\n`;
        output += ` Logged Signals: ${frame.stats.totalSignalsLogged}  |  Executions Logged: ${frame.stats.totalExecutionsLogged}${clearLine}\n`;
        output += `--------------------------------------------------------------------------------${clearLine}\n`;
        output += `${bold}--- TRADING PERFORMANCE, INVENTORY & PnL ---${reset}${clearLine}\n`;
        output += ` Position: ${posSideColor}${bold}${frame.stats.positionSide}${reset} (${frame.stats.netQuantity.toFixed(4)})  |  Avg Entry: $${frame.stats.averageEntryPrice.toFixed(2)}  |  Unrealized PnL: ${unrealizedColor}${bold}$${frame.stats.unrealizedPnl.toFixed(2)}${reset}${clearLine}\n`;
        output += ` Available Balance: ${green}${bold}$${frame.usdtBalance.toFixed(2)}${reset}  |  Realized PnL: ${pnlColor}${bold}$${frame.stats.realizedPnl.toFixed(2)}${reset}  |  Fees: $${frame.stats.totalFees.toFixed(2)}${clearLine}\n`;
        output += ` Win Rate: ${yellow}${frame.stats.winRatePercent.toFixed(2)}%${reset}  |  Total Trades: ${frame.stats.totalTrades} (W: ${frame.stats.winningTrades} / L: ${frame.stats.losingTrades})${clearLine}\n`;
        output += `${cyan}${bold}================================================================================${reset}${clearLine}\n`;
        process.stdout.write(output);
    }
    formatProgressBar(val, min, max, length) {
        const clamped = Math.max(min, Math.min(max, val));
        const norm = (clamped - min) / (max - min);
        const filled = Math.round(norm * length);
        const empty = length - filled;
        return "\x1b[32m" + "=".repeat(filled) + "\x1b[90m" + "-".repeat(empty) + "\x1b[0m";
    }
    clear() {
        if (this.enabled) {
            process.stdout.write("\x1b[2J\x1b[H");
        }
    }
}
exports.CLIDashboard = CLIDashboard;
