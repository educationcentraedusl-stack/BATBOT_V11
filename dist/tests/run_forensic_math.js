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
function runFullForensicMath() {
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
    allTrades.sort((a, b) => a.time - b.time);
    allOrders.sort((a, b) => a.time - b.time);
    console.log("=== COMPREHENSIVE FORENSIC MATH RECONCILIATION ===");
    // Find all trades associated with recent orders
    // 1. AVAXUSDT (Entry Order 515006680 -> Exits 515021714 & 515021715)
    // 2. DOGEUSDT (Entry Order 2319054799 -> Exits 2319218369 & 2319289539)
    // 3. LINKUSDT (Entry Order 1027919225 -> Exit 1027923541)
    // 4. BNBUSDT (Exits 2623882453, 2623882454, 2623882455)
    // 5. DOTUSDT / BTCUSDT / ETHUSDT
    // Let's filter orders and trades for each of these cycles
    const relevantSymbols = ["DOGEUSDT", "BNBUSDT", "AVAXUSDT", "LINKUSDT", "BTCUSDT", "ETHUSDT", "DOTUSDT"];
    for (const sym of relevantSymbols) {
        const symOrders = allOrders.filter((o) => o.symbol === sym);
        const symTrades = allTrades.filter((t) => t.symbol === sym);
        const symIncome = income.filter((i) => i.symbol === sym);
        console.log(`\n======================================================`);
        console.log(`SYMBOL: ${sym}`);
        console.log(`Orders (Last 6):`);
        for (const o of symOrders.slice(-6)) {
            console.log(`  Order #${o.orderId} | ${o.side} ${o.positionSide} | Type: ${o.type}/${o.origType} | Px: ${o.price}, AvgPx: ${o.avgPrice}, ExecQty: ${o.executedQty}, TIF: ${o.timeInForce}, Status: ${o.status}, Time: ${new Date(o.time).toISOString()}`);
        }
        console.log(`Trades (Last 6):`);
        for (const t of symTrades.slice(-6)) {
            console.log(`  Trade #${t.id} (Order #${t.orderId}) | ${t.side} ${t.positionSide} | Px: ${t.price}, Qty: ${t.qty}, QuoteQty: ${t.quoteQty}, RealizedPnL: ${t.realizedPnl}, Comm: ${t.commission} ${t.commissionAsset}, Maker: ${t.maker}, Time: ${new Date(t.time).toISOString()}`);
        }
        console.log(`Income (Last 6):`);
        for (const i of symIncome.slice(-6)) {
            console.log(`  Income Type: ${i.incomeType} | Amount: ${i.income} ${i.asset} | TradeId: ${i.tradeId}, Time: ${new Date(i.time).toISOString()}`);
        }
    }
}
runFullForensicMath();
