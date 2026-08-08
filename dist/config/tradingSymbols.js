"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TRADING_SYMBOLS = void 0;
exports.getTradingSymbols = getTradingSymbols;
require("dotenv/config");
/**
 * Default fallback trading symbols list used if TRADING_SYMBOLS environment variable is absent.
 */
exports.DEFAULT_TRADING_SYMBOLS = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "ADAUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "DOTUSDT",
];
/**
 * Dynamically resolves active trading symbols from environment variable `TRADING_SYMBOLS` (comma-delimited),
 * gracefully falling back to default configurable symbol list if unspecified or empty.
 *
 * @param maxCount Optional maximum cap on returned symbols matching MAX_CONCURRENT_ASSETS capacity.
 */
function getTradingSymbols(maxCount) {
    const envSymbolsRaw = process.env.TRADING_SYMBOLS;
    let symbols = [];
    if (envSymbolsRaw && envSymbolsRaw.trim().length > 0) {
        symbols = envSymbolsRaw
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter((s) => s.length > 0);
    }
    if (symbols.length === 0) {
        symbols = [...exports.DEFAULT_TRADING_SYMBOLS];
    }
    const envMaxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || "", 10);
    const cap = maxCount ?? (Number.isFinite(envMaxAssets) && envMaxAssets > 0 ? envMaxAssets : symbols.length);
    return symbols.slice(0, cap);
}
