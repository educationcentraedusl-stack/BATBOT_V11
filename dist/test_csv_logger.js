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
const csvLogger_1 = require("./utils/csvLogger");
const positionLedger_1 = require("./strategy/positionLedger");
async function runCsvLoggerTests() {
    console.log("=================================================");
    console.log("BATBOT_V11 CSV TRADE LOGGER VERIFICATION SUITE");
    console.log("=================================================");
    const testDir = path.join(process.cwd(), "data_test_temp");
    const testCsvFile = path.join(testDir, "test_trade_history.csv");
    // Cleanup past test artifacts if present
    if (fs.existsSync(testCsvFile)) {
        fs.unlinkSync(testCsvFile);
    }
    // -------------------------------------------------------------------
    // TEST 1: CSV File & Header Generation
    // -------------------------------------------------------------------
    console.log("\n[TEST 1] Testing CSV File & Header Initialization...");
    const logger = new csvLogger_1.CsvTradeLogger("data_test_temp", "test_trade_history.csv");
    if (!fs.existsSync(testCsvFile)) {
        throw new Error("FAIL: CSV file was not created on initialization.");
    }
    const initialContent = fs.readFileSync(testCsvFile, "utf8");
    const expectedHeader = "Time,Symbol,Side,Size,Entry Price,Exit Price,Exit Reason,Duration,ROE %,PnL USDT,Win/Loss\n";
    if (initialContent !== expectedHeader) {
        throw new Error(`FAIL: Header mismatch.\nExpected: ${expectedHeader}\nReceived: ${initialContent}`);
    }
    console.log("  ✓ CSV file and exact header created successfully.");
    // -------------------------------------------------------------------
    // TEST 2: PositionLedger Closed Trade Calculation & Non-blocking CSV Logging
    // -------------------------------------------------------------------
    console.log("\n[TEST 2] Testing PositionLedger Closed Trade Calculation & CSV Logging...");
    const ledger = new positionLedger_1.PositionLedger("BTCUSDT");
    // Step A: Open LONG position: BUY 0.002 BTC @ $65,000.00
    const fill1 = ledger.processFill("BTCUSDT", "BUY", 65000.00, 0.002, 0.052);
    if (fill1.closedTrade) {
        throw new Error("FAIL: Opening trade should NOT generate closedTrade record.");
    }
    console.log("  ✓ Opening LONG position processed cleanly (no closed trade logged).");
    // Wait 10ms to simulate duration
    await new Promise((resolve) => setTimeout(resolve, 15));
    // Step B: Take Profit Exit: SELL 0.002 BTC @ $66,000.00 with exitReason "TAKE_PROFIT"
    const fill2 = ledger.processFill("BTCUSDT", "SELL", 66000.00, 0.002, 0.0528, "TAKE_PROFIT");
    if (!fill2.closedTrade) {
        throw new Error("FAIL: Full position exit should generate closedTrade record.");
    }
    const closed = fill2.closedTrade;
    if (closed.symbol !== "BTCUSDT" || closed.side !== "LONG" || closed.size !== 0.002) {
        throw new Error(`FAIL: Invalid closed trade dimensions: ${JSON.stringify(closed)}`);
    }
    if (closed.entryPrice !== 65000.00 || closed.exitPrice !== 66000.00) {
        throw new Error(`FAIL: Price mismatch in closed trade: Entry=${closed.entryPrice}, Exit=${closed.exitPrice}`);
    }
    if (closed.exitReason !== "TAKE_PROFIT") {
        throw new Error(`FAIL: Exit reason mismatch: Expected TAKE_PROFIT, got ${closed.exitReason}`);
    }
    // ROE % = ((66000 - 65000) / 65000) * 100 * 1 = 1.538% -> 1.54%
    const expectedRoe = ((66000 - 65000) / 65000) * 100;
    if (Math.abs(closed.roePercent - expectedRoe) > 0.01) {
        throw new Error(`FAIL: ROE calculation mismatch: ${closed.roePercent}% vs expected ${expectedRoe}%`);
    }
    // Realized PnL = (66000 - 65000) * 0.002 - fee (0.0528) = 2.00 - 0.0528 = 1.9472 USDT
    const expectedPnl = 2.0 - 0.0528;
    if (Math.abs(closed.pnlUsdt - expectedPnl) > 0.0001) {
        throw new Error(`FAIL: PnL USDT mismatch: ${closed.pnlUsdt} vs expected ${expectedPnl}`);
    }
    console.log(`  ✓ PositionLedger calculation verified: ROE=${closed.roePercent.toFixed(2)}%, PnL=$${closed.pnlUsdt.toFixed(4)} USDT, Duration=${closed.durationMs}ms`);
    // Log to CSV
    logger.logClosedTrade(closed);
    // Wait for background non-blocking I/O write
    await new Promise((resolve) => setTimeout(resolve, 50));
    const updatedContent = fs.readFileSync(testCsvFile, "utf8");
    const lines = updatedContent.trim().split("\n");
    if (lines.length !== 2) {
        throw new Error(`FAIL: Expected 2 lines in CSV (header + 1 row), found ${lines.length}. Content:\n${updatedContent}`);
    }
    const row = lines[1].split(",");
    if (row.length !== 11) {
        throw new Error(`FAIL: CSV row column count mismatch. Expected 11 columns, got ${row.length}: ${lines[1]}`);
    }
    // Check columns: Time,Symbol,Side,Size,Entry Price,Exit Price,Exit Reason,Duration,ROE %,PnL USDT,Win/Loss
    if (row[1] !== "BTCUSDT" || row[2] !== "LONG" || row[3] !== "0.0020") {
        throw new Error(`FAIL: CSV column values invalid: Symbol=${row[1]}, Side=${row[2]}, Size=${row[3]}`);
    }
    if (row[4] !== "65000.00" || row[5] !== "66000.00" || row[6] !== "TAKE_PROFIT") {
        throw new Error(`FAIL: CSV price/reason invalid: Entry=${row[4]}, Exit=${row[5]}, Reason=${row[6]}`);
    }
    if (row[8] !== "1.54" || row[9] !== "1.9472" || row[10] !== "Win") {
        throw new Error(`FAIL: CSV ROE/PnL/WinLoss invalid: ROE=${row[8]}, PnL=${row[9]}, WinLoss=${row[10]}`);
    }
    console.log(`  ✓ CSV Non-blocking async row logged correctly: "${lines[1]}"`);
    // -------------------------------------------------------------------
    // TEST 3: Short Trade & Stop Loss Exit Verification
    // -------------------------------------------------------------------
    console.log("\n[TEST 3] Testing SHORT Position & STOP_LOSS Exit...");
    ledger.processFill("BTCUSDT", "SELL", 65000.00, 0.001, 0.026);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const fillShortLoss = ledger.processFill("BTCUSDT", "BUY", 65500.00, 0.001, 0.0262, "STOP_LOSS");
    if (!fillShortLoss.closedTrade) {
        throw new Error("FAIL: Short position exit did not produce closedTrade record.");
    }
    const closedShort = fillShortLoss.closedTrade;
    if (closedShort.side !== "SHORT" || closedShort.exitReason !== "STOP_LOSS") {
        throw new Error(`FAIL: Short exit mismatch: Side=${closedShort.side}, Reason=${closedShort.exitReason}`);
    }
    logger.logClosedTrade(closedShort);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finalContent = fs.readFileSync(testCsvFile, "utf8");
    const finalLines = finalContent.trim().split("\n");
    if (finalLines.length !== 3) {
        throw new Error(`FAIL: Expected 3 lines in CSV, found ${finalLines.length}`);
    }
    const shortRow = finalLines[2].split(",");
    if (shortRow.length !== 11 || shortRow[10] !== "Loss") {
        throw new Error(`FAIL: Short loss trade Win/Loss column invalid: Expected Loss, got ${shortRow[10]}`);
    }
    console.log(`  ✓ Short STOP_LOSS trade logged correctly with Loss tag: "${finalLines[2]}"`);
    // Clean up test directory
    try {
        fs.unlinkSync(testCsvFile);
        fs.rmdirSync(testDir);
    }
    catch (_) { }
    console.log("\n=================================================");
    console.log("ALL CSV TRADE LOGGER VERIFICATION TESTS PASSED!");
    console.log("=================================================");
}
runCsvLoggerTests().catch((err) => {
    console.error("CRITICAL TEST FAILURE:", err);
    process.exit(1);
});
