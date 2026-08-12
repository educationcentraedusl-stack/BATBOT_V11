"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAssetCLIDashboard = exports.DEFAULT_ASSET_SYMBOLS = void 0;
const tradingSymbols_1 = require("../config/tradingSymbols");
exports.DEFAULT_ASSET_SYMBOLS = (0, tradingSymbols_1.getTradingSymbols)();
class MultiAssetCLIDashboard {
    client;
    enabled;
    renderIntervalMs = 150; // ~6.6Hz refresh rate for zero-flicker sub-millisecond telemetry
    lastRenderTimestamp = 0;
    focusedAssetIdx = 0;
    assetSymbols;
    notificationLog = [];
    maxLogEntries = 5;
    cachedMemMb = "0.00";
    renderCount = 0;
    // Pre-allocated static buffers for zero-allocation L2 depth reading
    bidBuffer = new Float64Array(40); // 20 price/qty pairs
    askBuffer = new Float64Array(40); // 20 price/qty pairs
    // Static pre-rendered Mini-Bar lookup table (0 to 10 filled blocks) to avoid .repeat() heap allocations on hot-path
    static MINI_BAR_CACHE = Array.from({ length: 11 }, (_, filled) => {
        const empty = 10 - filled;
        return "\x1b[32m" + "=".repeat(filled) + "\x1b[90m" + "-".repeat(empty) + "\x1b[0m";
    });
    // Static pre-rendered ANSI UI dividers cached to eliminate hot-path string allocations in render loop
    static BORDER = "\x1b[36m\x1b[1m===================================================================================================================\x1b[0m\x1b[K\n";
    static SUB_DIVIDER = "\x1b[90m-------------------------------------------------------------------------------------------------------------------\x1b[0m\x1b[K\n";
    static TABLE_DIVIDER = "\x1b[90m+------+----------+-----------+-----------+--------+--------------+------------+----------+--------------+-------+-------+--------+\x1b[0m\x1b[K\n";
    static TRADES_DIVIDER = "\x1b[90m+------+----------+--------+-----------+-------------+--------------+----------+----------+----------------------+\x1b[0m\x1b[K\n";
    constructor(client, enabled = true, customSymbols = (0, tradingSymbols_1.getTradingSymbols)()) {
        this.client = client;
        this.enabled = enabled;
        this.assetSymbols = customSymbols;
        // Listen for terminal resize event to cleanly clear and re-render frame
        if (process.stdout.isTTY) {
            process.stdout.on("resize", () => {
                this.clear();
            });
        }
    }
    /**
     * Sets current focused asset index slot (0 to maxAssets-1) for detailed L2 view.
     */
    setFocusedAsset(assetIdx) {
        if (assetIdx >= 0 && assetIdx < this.client.maxAssets) {
            this.focusedAssetIdx = assetIdx;
        }
    }
    getFocusedAsset() {
        return this.focusedAssetIdx;
    }
    /**
     * Appends notification message to TUI event log buffer.
     */
    pushNotification(message) {
        const timestamp = new Date().toISOString().substring(11, 19);
        this.notificationLog.push(`[${timestamp}] ${message}`);
        if (this.notificationLog.length > this.maxLogEntries) {
            this.notificationLog.shift();
        }
    }
    /**
     * Zero-allocation render loop fetching telemetry directly from SAB via Atomics.load.
     * Outputs double-buffered ANSI frame to stdout using cursor top-left repositioning (\x1b[H).
     */
    render() {
        if (!this.enabled)
            return;
        const now = Date.now();
        if (now - this.lastRenderTimestamp < this.renderIntervalMs) {
            return;
        }
        this.lastRenderTimestamp = now;
        this.renderCount++;
        // ANSI escape sequences
        const reset = "\x1b[0m";
        const bold = "\x1b[1m";
        const cyan = "\x1b[36m";
        const yellow = "\x1b[33m";
        const green = "\x1b[32m";
        const red = "\x1b[31m";
        const gray = "\x1b[90m";
        const clearLine = "\x1b[K";
        // Read system-wide status from SAB asset 0
        const isKilled = this.client.getKillSwitchFlag(0);
        const isCloseAll = this.client.getCloseAllPositionsFlag(0);
        const isPaused = this.client.getEnginePausedFlag(0);
        const isRecalibrating = this.client.getTriggerRecalibrationFlag(0);
        let statusStr = `${green}${bold}[LIVE ACTIVE]${reset}`;
        if (isKilled) {
            statusStr = `${red}${bold}[KILLED - EMERGENCY STOP]${reset}`;
        }
        else if (isCloseAll) {
            statusStr = `${yellow}${bold}[PANIC CLOSE ALL]${reset}`;
        }
        else if (isRecalibrating) {
            statusStr = `${yellow}${bold}[RECALIBRATING]${reset}`;
        }
        else if (isPaused) {
            statusStr = `${yellow}${bold}[PAUSED]${reset}`;
        }
        // Throttle memory usage check to once every 10 frames (~1.5s) to eliminate V8 process.memoryUsage() allocations
        if (this.renderCount % 10 === 1) {
            this.cachedMemMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        }
        const memMb = this.cachedMemMb;
        const seqNum = this.client.getSequenceNum(this.focusedAssetIdx);
        // Aggregate portfolio metrics across all asset slots
        let totalUnrealizedPnl = 0;
        let totalRealizedPnl = 0;
        let totalTrades = 0n;
        let totalWinningTrades = 0n;
        let totalLosingTrades = 0n;
        let activePositionCount = 0;
        for (let i = 0; i < this.client.maxAssets; i++) {
            totalUnrealizedPnl += this.client.getOmsUnrealizedPnl(i);
            totalRealizedPnl += this.client.getOmsRealizedPnl(i);
            totalTrades += this.client.getOmsTotalTrades(i);
            totalWinningTrades += this.client.getOmsWinningTrades(i);
            totalLosingTrades += this.client.getOmsLosingTrades(i);
            if (Math.abs(this.client.getOmsPositionQty(i)) > 1e-6) {
                activePositionCount++;
            }
        }
        const numTrades = Number(totalTrades);
        const numWins = Number(totalWinningTrades);
        const winRatePct = numTrades > 0 ? (numWins / numTrades) * 100 : 0;
        let out = "\x1b[H"; // Move cursor top-left
        out += MultiAssetCLIDashboard.BORDER;
        out += `${cyan}${bold}                           BATBOT_V11 MULTI-ASSET HFT TELEMETRY & COMMAND MONITOR (${this.client.maxAssets} ASSETS)                              ${reset}${clearLine}\n`;
        out += MultiAssetCLIDashboard.BORDER;
        const availBalance = this.client.getAvailableBalance(0);
        out += ` Engine Status: ${statusStr} | Memory: ${memMb} MB | Seq: #${seqNum.toString()} | Active Pos: ${activePositionCount}/${this.client.maxAssets}${clearLine}\n`;
        out += ` Avail Bal: ${green}${bold}$${availBalance.toFixed(2)}${reset} | Unr PnL: ${totalUnrealizedPnl >= 0 ? green : red}${bold}$${totalUnrealizedPnl.toFixed(2)}${reset} | Real PnL: ${totalRealizedPnl >= 0 ? green : red}${bold}$${totalRealizedPnl.toFixed(2)}${reset} | Trades: ${totalTrades} | Win: ${green}${bold}${totalWinningTrades}${reset} | Loss: ${red}${bold}${totalLosingTrades}${reset} | Win Rate: ${yellow}${bold}${winRatePct.toFixed(1)}%${reset}${clearLine}\n`;
        out += MultiAssetCLIDashboard.SUB_DIVIDER;
        out += `${bold}--- ${this.client.maxAssets}-ASSET CONCURRENCY REAL-TIME MATRIX ---${reset}${clearLine}\n`;
        out += MultiAssetCLIDashboard.TABLE_DIVIDER;
        out += `| ${bold}Slot${reset} | ${bold}Symbol${reset}   | ${bold}Best Bid${reset}  | ${bold}Best Ask${reset}  | ${bold}Spread${reset}   | ${bold}OBI (-1..+1)${reset} | ${bold}CVD${reset}        | ${bold}Hawkes${reset}   | ${bold}Garman-Klass${reset} | ${bold}Dir${reset}   | ${bold}Conf%${reset} | ${bold}Signal${reset}   |${clearLine}\n`;
        out += MultiAssetCLIDashboard.TABLE_DIVIDER;
        for (let i = 0; i < this.client.maxAssets; i++) {
            const symName = this.assetSymbols[i] || `ASSET_${i}`;
            const symStr = " " + symName.padEnd(8) + " ";
            const bid = this.client.getBestBidPrice(i);
            const ask = this.client.getBestAskPrice(i);
            const bidStr = " " + (bid > 0 ? bid.toFixed(2) : "0.00").padStart(9) + " ";
            const askStr = " " + (ask > 0 ? ask.toFixed(2) : "0.00").padStart(9) + " ";
            const spreadVal = (ask > 0 && bid > 0 && ask >= bid) ? (ask - bid).toFixed(2) : "0.00";
            const spreadStr = " " + spreadVal.padStart(6) + " ";
            const obi = this.client.getOBI(i);
            const obiBar = this.getFastMiniBar(obi, -1, 1);
            const obiStr = " [" + obiBar + "] ";
            const cvd = this.client.getCVD(i);
            let rawCvd = (cvd >= 0 ? "+" : "") + cvd.toFixed(1);
            if (rawCvd.length > 10) {
                rawCvd = rawCvd.substring(0, 10);
            }
            const cvdStr = " " + rawCvd.padStart(10) + " ";
            const hawkes = this.client.getHawkesIntensity(i);
            const hawkesStr = " " + hawkes.toFixed(3).padStart(8) + " ";
            const gkRv = this.client.getGarmanKlassRV(i);
            const gkStr = " " + gkRv.toFixed(5).padStart(12) + " ";
            const aiDir = this.client.getAIPredictionDirection(i);
            let rawDir = (aiDir >= 0 ? "+" : "") + aiDir.toFixed(2);
            if (rawDir.length > 5)
                rawDir = rawDir.substring(0, 5);
            const dirColor = aiDir > 0.05 ? green : aiDir < -0.05 ? red : gray;
            const dirStr = " " + dirColor + rawDir.padStart(5) + reset + " ";
            const aiConf = this.client.getAIPredictionConfidence(i);
            let rawConf = (aiConf * 100).toFixed(1) + "%";
            if (rawConf.length > 5)
                rawConf = rawConf.substring(0, 5);
            const confColor = aiConf >= 0.75 ? green + bold : aiConf >= 0.65 ? yellow : aiConf >= 0.55 ? cyan : gray;
            const confStr = " " + confColor + rawConf.padStart(5) + reset + " ";
            const obiBuyThreshold = 0.35;
            const obiSellThreshold = -0.35;
            let signalText = "NONE";
            let signalColor = gray;
            if (aiConf >= 0.75) {
                if (aiDir > 0 && obi >= obiBuyThreshold) {
                    signalText = "BUY";
                    signalColor = green + bold;
                }
                else if (aiDir < 0 && obi <= obiSellThreshold) {
                    signalText = "SELL";
                    signalColor = red + bold;
                }
            }
            else {
                const aiScore = Math.max(-1.0, Math.min(1.0, aiDir * aiConf));
                const obiScore = Math.max(-1.0, Math.min(1.0, obi));
                const cvdScore = cvd > 0 ? 1.0 : cvd < 0 ? -1.0 : 0.0;
                const compScore = 0.50 * aiScore + 0.25 * obiScore + 0.25 * cvdScore;
                if (compScore > 0.12 && aiConf >= 0.52 && obi >= obiBuyThreshold) {
                    signalText = "BUY";
                    signalColor = green;
                }
                else if (compScore < -0.12 && aiConf >= 0.52 && obi <= obiSellThreshold) {
                    signalText = "SELL";
                    signalColor = red;
                }
            }
            const signalStr = " " + signalColor + signalText.padEnd(6) + reset + " ";
            const slotStr = i === this.focusedAssetIdx
                ? "  " + yellow + bold + "#" + i + reset + "  "
                : "  #" + i + "  ";
            out += "|" + slotStr + "|" + symStr + "|" + bidStr + "|" + askStr + "|" + spreadStr + "|" + obiStr + "|" + cvdStr + "|" + hawkesStr + "|" + gkStr + "|" + dirStr + "|" + confStr + "|" + signalStr + "|" + clearLine + "\n";
        }
        out += MultiAssetCLIDashboard.TABLE_DIVIDER;
        // Focused Asset Deep Microstructure & L2 View
        const fIdx = this.focusedAssetIdx;
        const fSym = this.assetSymbols[fIdx] || `ASSET_${fIdx}`;
        this.client.fillTopBids(this.bidBuffer, 5, fIdx);
        this.client.fillTopAsks(this.askBuffer, 5, fIdx);
        const fObi = this.client.getOBI(fIdx);
        const fCvd = this.client.getCVD(fIdx);
        const fHawkes = this.client.getHawkesIntensity(fIdx);
        const fVpin = this.client.getVPIN(fIdx);
        const fHurst = this.client.getHurstExponent(fIdx);
        const fAiDir = this.client.getAIPredictionDirection(fIdx);
        const fAiConf = (this.client.getAIPredictionConfidence(fIdx) * 100).toFixed(1);
        const fInfLat = (Number(this.client.getAIInferenceLatencyNs(fIdx)) / 1000).toFixed(1);
        out += `${bold}--- FOCUSED ASSET METRICS & LEVEL-2 BOOK (#${fIdx} - ${fSym}) ---${reset}${clearLine}\n`;
        out += ` OBI: ${fObi >= 0 ? "+" : ""}${fObi.toFixed(4)}  |  CVD: ${fCvd >= 0 ? "+" : ""}${fCvd.toFixed(2)}  |  Hawkes: ${fHawkes.toFixed(4)}  |  VPIN: ${fVpin.toFixed(4)}  |  Hurst: ${fHurst.toFixed(4)}${clearLine}\n`;
        out += ` AI Prediction Direction: ${fAiDir >= 0 ? green : red}${fAiDir >= 0 ? "+" : ""}${fAiDir.toFixed(4)}${reset}  |  Confidence: ${yellow}${fAiConf}%${reset}  |  Inference Latency: ${fInfLat} µs${clearLine}\n`;
        out += ` Top 3 Bids: [1] $${this.bidBuffer[0].toFixed(2)} (${this.bidBuffer[1].toFixed(3)})  [2] $${this.bidBuffer[2].toFixed(2)} (${this.bidBuffer[3].toFixed(3)})  [3] $${this.bidBuffer[4].toFixed(2)} (${this.bidBuffer[5].toFixed(3)})${clearLine}\n`;
        out += ` Top 3 Asks: [1] $${this.askBuffer[0].toFixed(2)} (${this.askBuffer[1].toFixed(3)})  [2] $${this.askBuffer[2].toFixed(2)} (${this.askBuffer[3].toFixed(3)})  [3] $${this.askBuffer[4].toFixed(2)} (${this.askBuffer[5].toFixed(3)})${clearLine}\n`;
        out += MultiAssetCLIDashboard.SUB_DIVIDER;
        out += `${bold}--- MULTI-ASSET ACTIVE POSITIONS (${this.client.maxAssets} OMS SLOTS) ---${reset}${clearLine}\n`;
        out += MultiAssetCLIDashboard.TRADES_DIVIDER;
        out += `| ${bold}Slot${reset} | ${bold}Symbol${reset}   | ${bold}Side${reset}   | ${bold}Position${reset}  | ${bold}Avg Entry${reset}   | ${bold}Mark Price${reset}   | ${bold}Leverage${reset} | ${bold}Realized${reset} | ${bold}Unrealized PnL ($)${reset}  |${clearLine}\n`;
        out += MultiAssetCLIDashboard.TRADES_DIVIDER;
        let hasActivePosition = false;
        for (let i = 0; i < this.client.maxAssets; i++) {
            const qty = this.client.getOmsPositionQty(i);
            if (Math.abs(qty) > 1e-6) {
                hasActivePosition = true;
                const sym = (this.assetSymbols[i] || `ASSET_${i}`).padEnd(8);
                const side = qty > 0 ? `${green}LONG ${reset}` : `${red}SHORT${reset}`;
                const entry = this.client.getOmsAvgEntryPrice(i);
                const mark = this.client.getBestBidPrice(i);
                const lev = `${this.client.getOmsLeverage(i).toFixed(0)}x`.padEnd(8);
                const rPnl = this.client.getOmsRealizedPnl(i);
                const uPnl = this.client.getOmsUnrealizedPnl(i);
                const uPnlColor = uPnl >= 0 ? green : red;
                const uPnlStr = `${uPnl >= 0 ? "+" : ""}$${uPnl.toFixed(2)}`.padEnd(20);
                out += `| #${i}   | ${sym} | ${side} | ${qty.toFixed(4).padEnd(9)} | $${entry.toFixed(2).padEnd(10)} | $${mark.toFixed(2).padEnd(11)} | ${lev} | $${rPnl.toFixed(2).padEnd(7)} | ${uPnlColor}${bold}${uPnlStr}${reset} |${clearLine}\n`;
            }
        }
        if (!hasActivePosition) {
            out += `| ${yellow}` + `NO ACTIVE OPEN POSITIONS ACROSS ALL ${this.client.maxAssets} ASSET SLOTS (ALL POSITIONS FLAT)`.padEnd(112) + `${reset} |${clearLine}\n`;
        }
        out += MultiAssetCLIDashboard.TRADES_DIVIDER;
        // Command Feedback & Real-Time Event Log
        out += `${bold}--- INTERACTIVE COMMAND FEEDBACK & NOTIFICATION LOG ---${reset}${clearLine}\n`;
        if (this.notificationLog.length === 0) {
            out += ` ${gray}[SYSTEM READY] Listening for raw keyboard controls...${reset}${clearLine}\n`;
        }
        else {
            for (const logLine of this.notificationLog) {
                out += ` ${logLine}${clearLine}\n`;
            }
        }
        out += MultiAssetCLIDashboard.BORDER;
        process.stdout.write(out);
    }
    /**
     * Zero-allocation O(1) mini-bar string lookup from pre-rendered static MINI_BAR_CACHE.
     */
    getFastMiniBar(val, min, max) {
        const clamped = Math.max(min, Math.min(max, val));
        const norm = (clamped - min) / (max - min);
        const idx = Math.round(norm * 10);
        return MultiAssetCLIDashboard.MINI_BAR_CACHE[idx] || MultiAssetCLIDashboard.MINI_BAR_CACHE[5];
    }
    clear() {
        if (this.enabled) {
            process.stdout.write("\x1b[2J\x1b[H");
        }
    }
}
exports.MultiAssetCLIDashboard = MultiAssetCLIDashboard;
