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
exports.CsvTradeLogger = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class CsvTradeLogger {
    filePath;
    isInitialized = false;
    constructor(outputDir = "data", fileName = "trade_history.csv") {
        const dir = path.resolve(process.cwd(), outputDir);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.filePath = path.join(dir, fileName);
        this.ensureHeader();
    }
    ensureHeader() {
        if (!fs.existsSync(this.filePath)) {
            const headers = "Time,Symbol,Side,Size,Entry Price,Exit Price,Exit Reason,Duration,ROE %,PnL USDT,Win/Loss\n";
            try {
                fs.writeFileSync(this.filePath, headers, "utf8");
            }
            catch (err) {
                console.error(`[CsvTradeLogger] Error initializing CSV header: ${err.message}`);
            }
        }
        this.isInitialized = true;
    }
    /**
     * Non-blocking async append of a completely closed trade row.
     * Format: Time,Symbol,Side,Size,Entry Price,Exit Price,Exit Reason,Duration,ROE %,PnL USDT,Win/Loss
     */
    logClosedTrade(record) {
        const timeStr = formatDate(record.timestamp ?? Date.now());
        const durationStr = formatDuration(record.durationMs);
        const winLoss = record.pnlUsdt > 0 ? "Win" : "Loss";
        const row = [
            timeStr,
            record.symbol,
            record.side,
            record.size.toFixed(4),
            record.entryPrice.toFixed(2),
            record.exitPrice.toFixed(2),
            record.exitReason,
            durationStr,
            record.roePercent.toFixed(2),
            record.pnlUsdt.toFixed(4),
            winLoss,
        ].join(",") + "\n";
        // Non-blocking async appendFile to avoid blocking HFT execution loop
        fs.appendFile(this.filePath, row, "utf8", (err) => {
            if (err) {
                console.error(`[CsvTradeLogger] Error appending closed trade row: ${err.message}`);
            }
        });
    }
    getFilePath() {
        return this.filePath;
    }
}
exports.CsvTradeLogger = CsvTradeLogger;
function formatDate(ts) {
    const d = new Date(ts);
    const pad = (n) => n.toString().padStart(2, "0");
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
function formatDuration(durationMs) {
    if (durationMs < 1000) {
        return `${Math.max(0, durationMs)}ms`;
    }
    const sec = (durationMs / 1000).toFixed(1);
    return `${sec}s`;
}
