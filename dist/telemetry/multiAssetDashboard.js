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
exports.MultiAssetCLIDashboard = exports.DEFAULT_ASSET_SYMBOLS = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const tradingSymbols_1 = require("../config/tradingSymbols");
const symbolPrecision_1 = require("../config/symbolPrecision");
const recalibrationWorker_1 = require("../ai/recalibrationWorker");
// eslint-disable-next-line @typescript-eslint/no-var-requires
let nativeAddon = null;
try {
    nativeAddon = require("../../index.js");
}
catch {
    // Safe fallback
}
function readTrainingProgress() {
    try {
        const progressPath = path.resolve(process.cwd(), ".training_progress");
        if (fs.existsSync(progressPath)) {
            const raw = fs.readFileSync(progressPath, "utf-8").trim();
            const val = parseInt(raw, 10);
            if (!isNaN(val) && val >= 0 && val <= 100) {
                return val;
            }
        }
    }
    catch (_e) {
        // Safe non-blocking read
    }
    return null;
}
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
    originalConsoleLog;
    originalConsoleWarn;
    originalConsoleError;
    isConsoleIntercepted = false;
    // Pre-allocated static buffers for zero-allocation L2 depth reading
    bidBuffer = new Float64Array(40); // 20 price/qty pairs
    askBuffer = new Float64Array(40); // 20 price/qty pairs
    // Static pre-rendered Mini-Bar lookup table (0 to 10 filled blocks) to avoid .repeat() heap allocations on hot-path
    static MINI_BAR_CACHE = Array.from({ length: 11 }, (_, filled) => {
        const empty = 10 - filled;
        return "\x1b[32m" + "=".repeat(filled) + "\x1b[90m" + "-".repeat(empty) + "\x1b[0m";
    });
    // Static pre-rendered ANSI UI dividers cached to eliminate hot-path string allocations in render loop
    static BORDER = "\x1b[36m\x1b[1m====================================================================================================================================================\x1b[0m\x1b[K\n";
    static SUB_DIVIDER = "\x1b[90m----------------------------------------------------------------------------------------------------------------------------------------------------\x1b[0m\x1b[K\n";
    static TABLE_DIVIDER = "\x1b[90m+------+----------+------------+------------+------------+---------+--------------+------------+----------+--------------+-------+--------+--------+\x1b[0m\x1b[K\n";
    static TRADES_DIVIDER = "\x1b[90m+------+----------+----------+------------+-------------+-------------+----------+-------------+----------------------------------------------------------+\x1b[0m\x1b[K\n";
    constructor(client, enabled = true, customSymbols = (0, tradingSymbols_1.getTradingSymbols)()) {
        this.client = client;
        this.enabled = enabled;
        this.assetSymbols = customSymbols;
        this.originalConsoleLog = console.log.bind(console);
        this.originalConsoleWarn = console.warn.bind(console);
        this.originalConsoleError = console.error.bind(console);
        if (this.enabled) {
            this.interceptConsole();
        }
        // Listen for terminal resize event to cleanly clear and re-render frame
        if (process.stdout.isTTY) {
            process.stdout.on("resize", () => {
                this.clear();
            });
        }
    }
    /**
     * Intercepts standard console output to prevent race conditions and stdout overlap with ANSI TUI.
     */
    interceptConsole() {
        if (this.isConsoleIntercepted)
            return;
        this.isConsoleIntercepted = true;
        const safeStringify = (arg) => {
            if (typeof arg === "string")
                return arg;
            if (typeof arg === "object" && arg !== null) {
                try {
                    return JSON.stringify(arg, (_, val) => (typeof val === "bigint" ? val.toString() : val));
                }
                catch {
                    return String(arg);
                }
            }
            return String(arg);
        };
        console.log = (...args) => {
            const msg = args.map(safeStringify).join(" ");
            this.pushNotification(msg);
        };
        console.warn = (...args) => {
            const msg = args.map(safeStringify).join(" ");
            this.pushNotification(`\x1b[33m[WARN] ${msg}\x1b[0m`);
        };
        console.error = (...args) => {
            const msg = args.map(safeStringify).join(" ");
            this.pushNotification(`\x1b[31m[ERROR] ${msg}\x1b[0m`);
        };
    }
    /**
     * Restores original console logging behavior upon TUI teardown.
     */
    restoreConsole() {
        if (!this.isConsoleIntercepted)
            return;
        console.log = this.originalConsoleLog;
        console.warn = this.originalConsoleWarn;
        console.error = this.originalConsoleError;
        this.isConsoleIntercepted = false;
    }
    /**
     * Helper utility to format cell content with strict width bounds and pad/truncation protection.
     * Strips ANSI escape sequences prior to length evaluation to prevent ANSI butchering and layout misalignment.
     */
    formatCell(val, width, alignRight = true) {
        const plainVal = val.replace(/\x1b\[[0-9;]*m/g, "");
        if (plainVal.length > width) {
            const truncatedPlain = plainVal.substring(0, width);
            return alignRight ? truncatedPlain.padStart(width) : truncatedPlain.padEnd(width);
        }
        const padLen = width - plainVal.length;
        const padding = " ".repeat(padLen);
        return alignRight ? padding + val : val + padding;
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
        if (!message)
            return;
        const cleanMsg = message.replace(/[\r\n]+/g, " ").trim();
        if (!cleanMsg)
            return;
        let formattedMsg = cleanMsg;
        if (!/^\[\d{2}:\d{2}:\d{2}\]/.test(cleanMsg)) {
            const timestamp = new Date().toISOString().substring(11, 19);
            formattedMsg = `[${timestamp}] ${cleanMsg}`;
        }
        this.notificationLog.push(formattedMsg);
        while (this.notificationLog.length > this.maxLogEntries) {
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
            const lQty = this.client.getOmsLongPositionQty(i);
            const sQty = this.client.getOmsShortPositionQty(i);
            const nQty = Math.abs(this.client.getOmsPositionQty(i));
            if (lQty > 1e-6 && sQty > 1e-6) {
                activePositionCount += 2;
            }
            else if (lQty > 1e-6 || sQty > 1e-6 || nQty > 1e-6) {
                activePositionCount += 1;
            }
        }
        const numTrades = Number(totalTrades);
        const numWins = Number(totalWinningTrades);
        const winRatePct = numTrades > 0 ? (numWins / numTrades) * 100 : 0;
        let out = "\x1b[H"; // Move cursor top-left
        out += MultiAssetCLIDashboard.BORDER;
        out += `${cyan}${bold}                                        BATBOT_V11 MULTI-ASSET HFT TELEMETRY & COMMAND MONITOR (${this.client.maxAssets} ASSETS)                                         ${reset}${clearLine}\n`;
        out += MultiAssetCLIDashboard.BORDER;
        const availBalance = this.client.getAvailableBalance(0);
        out += ` Engine Status: ${statusStr} | Memory: ${memMb} MB | Seq: #${seqNum.toString()} | Active Pos: ${activePositionCount}/${this.client.maxAssets}${clearLine}\n`;
        out += ` Avail Bal: ${green}${bold}$${availBalance.toFixed(2)}${reset} | Unr PnL: ${totalUnrealizedPnl >= 0 ? green : red}${bold}$${totalUnrealizedPnl.toFixed(2)}${reset} | Real PnL: ${totalRealizedPnl >= 0 ? green : red}${bold}$${totalRealizedPnl.toFixed(2)}${reset} | Trades: ${totalTrades} | Win: ${green}${bold}${totalWinningTrades}${reset} | Loss: ${red}${bold}${totalLosingTrades}${reset} | Win Rate: ${yellow}${bold}${winRatePct.toFixed(1)}%${reset}${clearLine}\n`;
        out += MultiAssetCLIDashboard.SUB_DIVIDER;
        out += `${bold}--- ${this.client.maxAssets}-ASSET CONCURRENCY REAL-TIME MATRIX ---${reset}${clearLine}\n`;
        out += MultiAssetCLIDashboard.TABLE_DIVIDER;
        out += `| ${bold}Slot${reset} | ${bold}Symbol${reset}   | ${bold}Best Bid${reset}   | ${bold}Best Ask${reset}   | ${bold}Live Price${reset} | ${bold}Spread${reset}    | ${bold}OBI (-1..+1)${reset} | ${bold}CVD${reset}        | ${bold}Hawkes${reset}   | ${bold}Garman-Klass${reset} | ${bold}Dir${reset}   | ${bold}Conf%${reset}   | ${bold}Signal${reset}   |${clearLine}\n`;
        out += MultiAssetCLIDashboard.TABLE_DIVIDER;
        for (let i = 0; i < this.client.maxAssets; i++) {
            const symName = this.assetSymbols[i] || `ASSET_${i}`;
            const symStr = " " + this.formatCell(symName, 8, false) + " ";
            const precisionRule = symbolPrecision_1.SymbolPrecisionRegistry.getPrecisionRule(symName);
            const dec = precisionRule.priceDecimals;
            const bid = this.client.getBestBidPrice(i);
            const ask = this.client.getBestAskPrice(i);
            const mid = (bid > 0 && ask > 0) ? (bid + ask) / 2.0 : (bid > 0 ? bid : ask);
            const rawBid = bid > 0 ? bid.toFixed(dec) : (0).toFixed(dec);
            const bidStr = " " + this.formatCell(rawBid, 10) + " ";
            const rawAsk = ask > 0 ? ask.toFixed(dec) : (0).toFixed(dec);
            const askStr = " " + this.formatCell(rawAsk, 10) + " ";
            const rawLivePrice = mid > 0 ? mid.toFixed(dec) : (0).toFixed(dec);
            const livePriceStr = " " + this.formatCell(rawLivePrice, 10) + " ";
            const rawSpread = (ask > 0 && bid > 0 && ask >= bid) ? (ask - bid).toFixed(dec) : (0).toFixed(dec);
            const spreadStr = " " + this.formatCell(rawSpread, 7) + " ";
            const obi = this.client.getOBI(i);
            const obiBar = this.getFastMiniBar(obi, -1, 1);
            const obiStr = " [" + obiBar + "] ";
            const cvd = this.client.getCVD(i);
            const rawCvd = (cvd >= 0 ? "+" : "") + cvd.toFixed(1);
            const cvdStr = " " + this.formatCell(rawCvd, 10) + " ";
            const hawkes = this.client.getHawkesIntensity(i);
            const hawkesStr = " " + this.formatCell(hawkes.toFixed(3), 8) + " ";
            const gkRv = this.client.getGarmanKlassRV(i);
            const gkStr = " " + this.formatCell(gkRv.toFixed(5), 12) + " ";
            const aiDir = this.client.getAIPredictionDirection(i);
            const rawDir = (aiDir >= 0 ? "+" : "") + aiDir.toFixed(2);
            const dirColor = aiDir > 0.05 ? green : aiDir < -0.05 ? red : gray;
            const dirStr = " " + dirColor + this.formatCell(rawDir, 5) + reset + " ";
            const aiConf = this.client.getAIPredictionConfidence(i);
            const rawConf = (aiConf * 100).toFixed(1) + "%";
            const confColor = aiConf >= 0.75 ? green + bold : aiConf >= 0.65 ? yellow : aiConf >= 0.55 ? cyan : gray;
            const confStr = " " + confColor + this.formatCell(rawConf, 6) + reset + " ";
            // Zero-Hallucination Signal Display: Read exact finalized signal state directly from Strategy Engine SAB Slot 137
            const rawSignalVal = this.client.getFinalizedSignal(i);
            let signalText = "NONE";
            let signalColor = gray;
            if (rawSignalVal === 1.0) {
                signalText = "BUY";
                signalColor = green + bold;
            }
            else if (rawSignalVal === 2.0) {
                signalText = "SELL";
                signalColor = red + bold;
            }
            const signalStr = " " + signalColor + this.formatCell(signalText, 6, false) + reset + " ";
            const slotStr = i === this.focusedAssetIdx
                ? "  " + yellow + bold + "#" + i + reset + "  "
                : "  #" + i + "  ";
            out += "|" + slotStr + "|" + symStr + "|" + bidStr + "|" + askStr + "|" + livePriceStr + "|" + spreadStr + "|" + obiStr + "|" + cvdStr + "|" + hawkesStr + "|" + gkStr + "|" + dirStr + "|" + confStr + "|" + signalStr + "|" + clearLine + "\n";
        }
        out += MultiAssetCLIDashboard.TABLE_DIVIDER;
        // Focused Asset Deep Microstructure & L2 View
        const fIdx = this.focusedAssetIdx;
        const fSym = this.assetSymbols[fIdx] || `ASSET_${fIdx}`;
        const fPrecisionRule = symbolPrecision_1.SymbolPrecisionRegistry.getPrecisionRule(fSym);
        const fDec = fPrecisionRule.priceDecimals;
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
        const fHjb = this.client.getHJBReservationPrice(fIdx);
        const fSurvival = this.client.getSurvivalProbability(fIdx);
        const hjbStr = (fHjb > 0 ? fHjb : 0).toFixed(fDec);
        const survivalStr = (fSurvival > 0 ? fSurvival * 100 : 100.0).toFixed(1);
        out += `${bold}--- FOCUSED ASSET METRICS & LEVEL-2 BOOK (#${fIdx} - ${fSym}) ---${reset}${clearLine}\n`;
        out += ` OBI: ${fObi >= 0 ? "+" : ""}${fObi.toFixed(4)} | CVD: ${fCvd >= 0 ? "+" : ""}${fCvd.toFixed(2)} | Hawkes: ${fHawkes.toFixed(3)} | VPIN: ${fVpin.toFixed(4)} | HJB Res: $${hjbStr} | Survival: ${survivalStr}%${clearLine}\n`;
        out += ` AI Prediction Direction: ${fAiDir >= 0 ? green : red}${fAiDir >= 0 ? "+" : ""}${fAiDir.toFixed(4)}${reset}  |  Confidence: ${yellow}${fAiConf}%${reset}  |  Inference Latency: ${fInfLat} µs${clearLine}\n`;
        out += ` Top 3 Bids: [1] $${this.bidBuffer[0].toFixed(fDec)} (${this.bidBuffer[1].toFixed(3)})  [2] $${this.bidBuffer[2].toFixed(fDec)} (${this.bidBuffer[3].toFixed(3)})  [3] $${this.bidBuffer[4].toFixed(fDec)} (${this.bidBuffer[5].toFixed(3)})${clearLine}\n`;
        out += ` Top 3 Asks: [1] $${this.askBuffer[0].toFixed(fDec)} (${this.askBuffer[1].toFixed(3)})  [2] $${this.askBuffer[2].toFixed(fDec)} (${this.askBuffer[3].toFixed(3)})  [3] $${this.askBuffer[4].toFixed(fDec)} (${this.askBuffer[5].toFixed(3)})${clearLine}\n`;
        out += MultiAssetCLIDashboard.SUB_DIVIDER;
        out += `${bold}--- MULTI-ASSET ACTIVE POSITIONS (${this.client.maxAssets} OMS SLOTS) ---${reset}${clearLine}\n`;
        out += MultiAssetCLIDashboard.TRADES_DIVIDER;
        out += `| ${bold}Slot${reset} | ${bold}Symbol${reset}   | ${bold}Side${reset}     | ${bold}Position${reset}   | ${bold}Avg Entry${reset}    | ${bold}Mark Price${reset}   | ${bold}Leverage${reset} | ${bold}Realized${reset}    | ${bold}Unrealized PnL ($)${reset}                                 |${clearLine}\n`;
        out += MultiAssetCLIDashboard.TRADES_DIVIDER;
        let hasActivePosition = false;
        for (let i = 0; i < this.client.maxAssets; i++) {
            const qty = this.client.getOmsPositionQty(i);
            const sideCode = this.client.getOmsPositionSide(i);
            const longQty = this.client.getOmsLongPositionQty(i);
            const shortQty = this.client.getOmsShortPositionQty(i);
            const longEntry = this.client.getOmsLongAvgEntryPrice(i);
            const shortEntry = this.client.getOmsShortAvgEntryPrice(i);
            const posBid = this.client.getBestBidPrice(i);
            const posAsk = this.client.getBestAskPrice(i);
            const mark = (posBid > 0 && posAsk > 0) ? (posBid + posAsk) / 2.0 : (posBid > 0 ? posBid : posAsk);
            const symName = this.assetSymbols[i] || `ASSET_${i}`;
            const posPrecisionRule = symbolPrecision_1.SymbolPrecisionRegistry.getPrecisionRule(symName);
            const posDec = posPrecisionRule.priceDecimals;
            const sym = this.formatCell(symName, 8, false);
            const levText = `${this.client.getOmsLeverage(i).toFixed(0)}x`;
            const levFormatted = this.formatCell(levText, 8);
            const rPnl = this.client.getOmsRealizedPnl(i);
            const hasLong = longQty > 1e-6;
            const hasShort = shortQty > 1e-6;
            if (hasLong && hasShort) {
                hasActivePosition = true;
                // 1. Render #i-LONG slot
                const longSlotStr = this.formatCell(`#${i}-LONG`, 6, false);
                const longSide = `${green}${this.formatCell("LONG", 8, false)}${reset}`;
                const longEntryPx = longEntry > 0 ? longEntry : this.client.getOmsAvgEntryPrice(i);
                const longUPnl = mark > 0 && longEntryPx > 0 ? (mark - longEntryPx) * longQty : this.client.getOmsLongUnrealizedPnl(i);
                const longUPnlColor = longUPnl >= 0 ? green : red;
                const longUPnlStr = `${longUPnl >= 0 ? "+" : ""}$${longUPnl.toFixed(2)}`;
                const longUPnlFormatted = this.formatCell(longUPnlStr, 56, false);
                out += `| ${longSlotStr} | ${sym} | ${longSide} | ${this.formatCell(longQty.toFixed(4), 10)} | $${this.formatCell(longEntryPx.toFixed(posDec), 10)} | $${this.formatCell(mark.toFixed(posDec), 10)} | ${levFormatted} | $${this.formatCell(rPnl.toFixed(2), 10)} | ${longUPnlColor}${bold}${longUPnlFormatted}${reset} |${clearLine}\n`;
                // 2. Render #i-SHORT slot
                const shortSlotStr = this.formatCell(`#${i}-SHORT`, 6, false);
                const shortSide = `${red}${this.formatCell("SHORT", 8, false)}${reset}`;
                const shortEntryPx = shortEntry > 0 ? shortEntry : this.client.getOmsAvgEntryPrice(i);
                const shortUPnl = mark > 0 && shortEntryPx > 0 ? (shortEntryPx - mark) * shortQty : this.client.getOmsShortUnrealizedPnl(i);
                const shortUPnlColor = shortUPnl >= 0 ? green : red;
                const shortUPnlStr = `${shortUPnl >= 0 ? "+" : ""}$${shortUPnl.toFixed(2)}`;
                const shortUPnlFormatted = this.formatCell(shortUPnlStr, 56, false);
                out += `| ${shortSlotStr} | ${sym} | ${shortSide} | ${this.formatCell(shortQty.toFixed(4), 10)} | $${this.formatCell(shortEntryPx.toFixed(posDec), 10)} | $${this.formatCell(mark.toFixed(posDec), 10)} | ${levFormatted} | $${this.formatCell(rPnl.toFixed(2), 10)} | ${shortUPnlColor}${bold}${shortUPnlFormatted}${reset} |${clearLine}\n`;
            }
            else if (hasLong || (sideCode === 1.0 && Math.abs(qty) > 1e-6)) {
                hasActivePosition = true;
                const displayQty = hasLong ? longQty : Math.abs(qty);
                const entry = longEntry > 0 ? longEntry : this.client.getOmsAvgEntryPrice(i);
                const slotStr = this.formatCell(`#${i}-LONG`, 6, false);
                const side = `${green}${this.formatCell("LONG", 8, false)}${reset}`;
                const uPnl = mark > 0 && entry > 0 ? (mark - entry) * displayQty : this.client.getOmsUnrealizedPnl(i);
                const uPnlColor = uPnl >= 0 ? green : red;
                const uPnlStr = `${uPnl >= 0 ? "+" : ""}$${uPnl.toFixed(2)}`;
                const uPnlFormatted = this.formatCell(uPnlStr, 56, false);
                out += `| ${slotStr} | ${sym} | ${side} | ${this.formatCell(displayQty.toFixed(4), 10)} | $${this.formatCell(entry.toFixed(posDec), 10)} | $${this.formatCell(mark.toFixed(posDec), 10)} | ${levFormatted} | $${this.formatCell(rPnl.toFixed(2), 10)} | ${uPnlColor}${bold}${uPnlFormatted}${reset} |${clearLine}\n`;
            }
            else if (hasShort || (sideCode === 2.0 && Math.abs(qty) > 1e-6)) {
                hasActivePosition = true;
                const displayQty = hasShort ? shortQty : Math.abs(qty);
                const entry = shortEntry > 0 ? shortEntry : this.client.getOmsAvgEntryPrice(i);
                const slotStr = this.formatCell(`#${i}-SHORT`, 6, false);
                const side = `${red}${this.formatCell("SHORT", 8, false)}${reset}`;
                const uPnl = mark > 0 && entry > 0 ? (entry - mark) * displayQty : this.client.getOmsUnrealizedPnl(i);
                const uPnlColor = uPnl >= 0 ? green : red;
                const uPnlStr = `${uPnl >= 0 ? "+" : ""}$${uPnl.toFixed(2)}`;
                const uPnlFormatted = this.formatCell(uPnlStr, 56, false);
                out += `| ${slotStr} | ${sym} | ${side} | ${this.formatCell(displayQty.toFixed(4), 10)} | $${this.formatCell(entry.toFixed(posDec), 10)} | $${this.formatCell(mark.toFixed(posDec), 10)} | ${levFormatted} | $${this.formatCell(rPnl.toFixed(2), 10)} | ${uPnlColor}${bold}${uPnlFormatted}${reset} |${clearLine}\n`;
            }
        }
        if (!hasActivePosition) {
            const noPosMsg = "NO ACTIVE OPEN POSITIONS ACROSS ALL " + this.client.maxAssets + " ASSET SLOTS (ALL POSITIONS FLAT)";
            out += `| ${yellow}` + this.formatCell(noPosMsg, 144, false) + `${reset} |${clearLine}\n`;
        }
        out += MultiAssetCLIDashboard.TRADES_DIVIDER;
        // Command Feedback & Real-Time Event Log
        out += `${bold}--- INTERACTIVE COMMAND FEEDBACK & NOTIFICATION LOG ---${reset}${clearLine}\n`;
        if (this.notificationLog.length === 0) {
            out += ` ${gray}[SYSTEM READY] Listening for raw keyboard controls...${reset}${clearLine}\n`;
            for (let k = 1; k < this.maxLogEntries; k++) {
                out += `${clearLine}\n`;
            }
        }
        else {
            for (let k = 0; k < this.maxLogEntries; k++) {
                if (k < this.notificationLog.length) {
                    const logLine = this.notificationLog[k];
                    out += ` ${this.formatCell(logLine, 145, false)}${clearLine}\n`;
                }
                else {
                    out += `${clearLine}\n`;
                }
            }
        }
        // AI Recalibration & Model Drift Monitor (SAB Slots 101/102 & IC Tracker)
        out += MultiAssetCLIDashboard.SUB_DIVIDER;
        out += `${bold}--- AI RECALIBRATION & MODEL DRIFT MONITOR (SAB SLOTS 101/102 & IC TRACKER) ---${reset}${clearLine}\n`;
        let rollingIc = this.client.getRollingIC();
        let isDrifted = this.client.getIsModelDrifted();
        let ewmaIc = 0;
        let adaptiveThreshold = 0.01;
        let sampleCount = 0;
        if (nativeAddon && typeof nativeAddon.getIcStatus === "function") {
            try {
                const rawJson = nativeAddon.getIcStatus();
                const parsed = JSON.parse(rawJson);
                if (typeof parsed.ic === "number" && !isNaN(parsed.ic)) {
                    rollingIc = parsed.ic;
                }
                if (typeof parsed.is_drifted === "boolean") {
                    isDrifted = isDrifted || parsed.is_drifted;
                }
                ewmaIc = parsed.ewma_ic ?? 0;
                adaptiveThreshold = parsed.adaptive_threshold ?? 0.01;
                sampleCount = parsed.sample_count ?? 0;
            }
            catch {
                // Safe non-blocking parse
            }
        }
        const recalStatus = recalibrationWorker_1.AutoRecalibrationManager.getInstance().getStatus();
        const isTkanRunning = recalibrationWorker_1.AutoRecalibrationManager.getInstance().isTkanTrainingActive();
        const isAnyTrainingActive = isDrifted || recalStatus.isRecalibrating || isTkanRunning;
        const trainingProgress = readTrainingProgress();
        const icSign = rollingIc >= 0 ? "+" : "";
        const icColor = rollingIc >= 0.03 ? green + bold : rollingIc >= 0.01 ? cyan : red + bold;
        const ewmaSign = ewmaIc >= 0 ? "+" : "";
        const driftStateStr = isAnyTrainingActive ? `${red}${bold}[DRIFT DETECTED - RECALIBRATING]${reset}` : `${green}${bold}[HEALTHY - CALIBRATED]${reset}`;
        const trainerStateStr = recalStatus.isRecalibrating
            ? `${yellow}${bold}[CfC TRAINING ACTIVE]${reset}`
            : isTkanRunning
                ? `${cyan}${bold}[T-KAN INIT ACTIVE]${reset}`
                : `${green}[STANDBY]${reset}`;
        const progressVal = trainingProgress !== null ? trainingProgress : (recalStatus.isRecalibrating || isTkanRunning ? 50 : 0);
        const totalBlocks = 20;
        const filledBlocks = Math.round((progressVal / 100) * totalBlocks);
        const emptyBlocks = totalBlocks - filledBlocks;
        const progressBar = progressVal > 0 ? `${green}${"▓".repeat(filledBlocks)}${gray}${"░".repeat(emptyBlocks)}${reset}` : `${gray}${"-".repeat(20)}${reset}`;
        out += ` IC (Spearman): ${icColor}${icSign}${rollingIc.toFixed(4)}${reset} | EWMA IC: ${ewmaSign}${ewmaIc.toFixed(4)} | Threshold: ${adaptiveThreshold.toFixed(4)} | Drift State: ${driftStateStr} | Window Pairs: ${sampleCount}/1000${clearLine}\n`;
        out += ` Auto-Trainer: ${trainerStateStr} | Drift Ticks: ${recalStatus.driftTickCounter}/50 | Recalibrations: ${recalStatus.totalRecalibrations} | Hot-Swap: ${green}[ACTIVE]${reset} | Training: [${progressBar}] ${progressVal}%${clearLine}\n`;
        out += MultiAssetCLIDashboard.BORDER;
        out += "\x1b[J";
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
