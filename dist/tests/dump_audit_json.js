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
require("dotenv/config");
const binance_1 = require("../execution/binance");
const tradingSymbols_1 = require("../config/tradingSymbols");
const fs = __importStar(require("fs"));
async function main() {
    const client = new binance_1.BinanceExecutionClient();
    const symbols = (0, tradingSymbols_1.getTradingSymbols)();
    // 1. Fetch Income History
    const income = await client.request("GET", "/fapi/v1/income", { limit: 50 }, true);
    // 2. Fetch User Trades
    const allTrades = [];
    for (const sym of symbols) {
        try {
            const trades = await client.request("GET", "/fapi/v1/userTrades", { symbol: sym, limit: 30 }, true);
            if (trades && trades.length > 0) {
                allTrades.push(...trades);
            }
        }
        catch (err) { }
    }
    allTrades.sort((a, b) => a.time - b.time);
    // 3. Fetch All Orders
    const allOrders = [];
    for (const sym of symbols) {
        try {
            const orders = await client.request("GET", "/fapi/v1/allOrders", { symbol: sym, limit: 30 }, true);
            if (orders && orders.length > 0) {
                allOrders.push(...orders);
            }
        }
        catch (err) { }
    }
    allOrders.sort((a, b) => a.time - b.time);
    const report = {
        income,
        allTrades,
        allOrders,
    };
    fs.writeFileSync("d:/AI Trading Bot/Trading Bot Virsions/BATBOT_V11-Antigravity/BATBOT_V11/data/live_forensic_audit_dump.json", JSON.stringify(report, null, 2));
    console.log(`Saved ${allTrades.length} trades, ${allOrders.length} orders, and ${income.length} income events to live_forensic_audit_dump.json`);
}
main().catch(console.error);
