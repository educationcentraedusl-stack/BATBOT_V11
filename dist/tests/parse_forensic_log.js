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
function parseLog() {
    const logContent = fs.readFileSync("C:/Users/SMART PLUS/.gemini/antigravity-ide/brain/3f60ccb6-1145-44a0-a4a7-c544bfb2e603/.system_generated/tasks/task-69.log", "utf8");
    // Extract income section
    const incomeMatch = logContent.match(/>>> RECENT INCOME \/ REALIZED PNL \/ COMMISSION HISTORY <<<\s*(\[\s*[\s\S]*?\])\s*>>>/);
    const income = incomeMatch ? JSON.parse(incomeMatch[1]) : [];
    // Extract all user trade JSON arrays
    const tradeMatches = logContent.matchAll(/--- Symbol: (\w+) \(\d+ trades found\) ---\s*(\[\s*[\s\S]*?\])\s*(?=--- Symbol:|\n>>> ALL ORDERS)/g);
    const allTrades = [];
    for (const match of tradeMatches) {
        try {
            const parsed = JSON.parse(match[2]);
            allTrades.push(...parsed);
        }
        catch (e) { }
    }
    // Extract all orders
    const orderMatches = logContent.matchAll(/--- Orders for (\w+) \(\d+ orders found\) ---\s*(\[\s*[\s\S]*?\])\s*(?=--- Orders for|$)/g);
    const allOrders = [];
    for (const match of orderMatches) {
        try {
            const parsed = JSON.parse(match[2]);
            allOrders.push(...parsed);
        }
        catch (e) { }
    }
    // Sort trades by timestamp
    allTrades.sort((a, b) => a.time - b.time);
    allOrders.sort((a, b) => a.time - b.time);
    console.log(`Parsed ${income.length} income items, ${allTrades.length} trades, ${allOrders.length} orders.`);
    // Get the most recent 20 trades
    const recentTrades = allTrades.slice(-25);
    console.log("\n================ RECENT TRADES (CHRONOLOGICAL) ================");
    for (const t of recentTrades) {
        const d = new Date(t.time).toISOString();
        console.log(`[${d}] ${t.symbol.padEnd(8)} | Side: ${t.side.padEnd(4)} | PosSide: ${t.positionSide.padEnd(5)} | Px: ${String(t.price).padEnd(10)} | Qty: ${String(t.qty).padEnd(8)} | RealizedPnL: ${String(t.realizedPnl).padEnd(12)} | Comm: ${String(t.commission).padEnd(10)} | Maker: ${t.maker} | OrderId: ${t.orderId}`);
    }
    // Correlate with recent income
    console.log("\n================ RECENT INCOME / PNL EVENTS ================");
    for (const inc of income.slice(-25)) {
        const d = new Date(inc.time).toISOString();
        console.log(`[${d}] ${inc.symbol.padEnd(8)} | Type: ${inc.incomeType.padEnd(14)} | Amount: ${String(inc.income).padEnd(12)} | Info: ${inc.info}`);
    }
    // Recent orders
    console.log("\n================ RECENT ORDERS ================");
    for (const o of allOrders.slice(-25)) {
        const d = new Date(o.time).toISOString();
        console.log(`[${d}] ${o.symbol.padEnd(8)} | Side: ${o.side.padEnd(4)} | PosSide: ${o.positionSide.padEnd(5)} | Type: ${o.type.padEnd(10)} | OrigType: ${o.origType.padEnd(10)} | Px: ${String(o.price).padEnd(8)} | AvgPx: ${String(o.avgPrice).padEnd(8)} | Qty: ${String(o.origQty).padEnd(6)} | ExecQty: ${String(o.executedQty).padEnd(6)} | Status: ${o.status.padEnd(8)} | TIF: ${o.timeInForce} | OrderId: ${o.orderId}`);
    }
}
parseLog();
