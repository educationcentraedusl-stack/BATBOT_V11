"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYMBOL_LEVERAGE_CONFIG = exports.VOLATILITY_TARGET_DAILY = exports.PERMANENTLY_BANNED_LEVERAGE = exports.DEFAULT_BASELINE_LEVERAGE = exports.MAX_PERMITTED_LEVERAGE = exports.MIN_PERMITTED_LEVERAGE = exports.DEFAULT_TRADING_SYMBOLS = void 0;
exports.getTradingSymbols = getTradingSymbols;
exports.getBaselineLeverageForSymbol = getBaselineLeverageForSymbol;
exports.calculateInverseVolatilityLeverage = calculateInverseVolatilityLeverage;
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
exports.MIN_PERMITTED_LEVERAGE = 2;
exports.MAX_PERMITTED_LEVERAGE = 5;
exports.DEFAULT_BASELINE_LEVERAGE = 3;
exports.PERMANENTLY_BANNED_LEVERAGE = 20;
exports.VOLATILITY_TARGET_DAILY = 0.0125; // 1.25% daily / ~20% annualized portfolio volatility budget
exports.SYMBOL_LEVERAGE_CONFIG = {
    BTCUSDT: { symbol: "BTCUSDT", baselineLeverage: 5, minLeverage: 2, maxLeverage: 5 },
    ETHUSDT: { symbol: "ETHUSDT", baselineLeverage: 5, minLeverage: 2, maxLeverage: 5 },
    SOLUSDT: { symbol: "SOLUSDT", baselineLeverage: 4, minLeverage: 2, maxLeverage: 5 },
    BNBUSDT: { symbol: "BNBUSDT", baselineLeverage: 4, minLeverage: 2, maxLeverage: 5 },
    ADAUSDT: { symbol: "ADAUSDT", baselineLeverage: 3, minLeverage: 2, maxLeverage: 5 },
    XRPUSDT: { symbol: "XRPUSDT", baselineLeverage: 3, minLeverage: 2, maxLeverage: 5 },
    DOGEUSDT: { symbol: "DOGEUSDT", baselineLeverage: 2, minLeverage: 2, maxLeverage: 5 },
    AVAXUSDT: { symbol: "AVAXUSDT", baselineLeverage: 3, minLeverage: 2, maxLeverage: 5 },
    LINKUSDT: { symbol: "LINKUSDT", baselineLeverage: 3, minLeverage: 2, maxLeverage: 5 },
    DOTUSDT: { symbol: "DOTUSDT", baselineLeverage: 3, minLeverage: 2, maxLeverage: 5 },
};
/**
 * Returns the baseline leverage for a given trading symbol.
 * Defaults to 5x for BTC/ETH, 2x for DOGE, and 3x for general altcoins.
 * Strictly clamped to [2, 5]. 20x is permanently banned.
 */
function getBaselineLeverageForSymbol(symbol) {
    const upper = symbol.toUpperCase();
    if (exports.SYMBOL_LEVERAGE_CONFIG[upper]) {
        return exports.SYMBOL_LEVERAGE_CONFIG[upper].baselineLeverage;
    }
    if (upper.includes("BTC") || upper.includes("ETH")) {
        return 5;
    }
    if (upper.includes("DOGE")) {
        return 2;
    }
    return exports.DEFAULT_BASELINE_LEVERAGE;
}
/**
 * Computes continuous inverse-volatility leverage targeting a constant portfolio volatility budget.
 * Formula: L_i = clamp(round(volTarget / max(realizedVol, minVolFloor)), 2, 5)
 * 20x leverage is permanently banned.
 *
 * @param realizedVol Realized volatility (e.g. sqrt(Garman-Klass RV))
 * @param volTarget Daily portfolio volatility target (default 0.0125 = 1.25% daily / ~20% annualized)
 * @param roundToInt Whether to round to nearest integer for Binance Futures exchange margin requirement
 */
function calculateInverseVolatilityLeverage(realizedVol, volTarget = exports.VOLATILITY_TARGET_DAILY, roundToInt = true) {
    const minVolFloor = 0.0025; // Floor preventing division by zero or leverage > 5 before clamping
    const safeVol = Number.isFinite(realizedVol) && realizedVol > 0.000001 ? realizedVol : minVolFloor;
    const effectiveVol = Math.max(safeVol, minVolFloor);
    const rawLev = volTarget / effectiveVol;
    const clamped = Math.max(exports.MIN_PERMITTED_LEVERAGE, Math.min(exports.MAX_PERMITTED_LEVERAGE, rawLev));
    return roundToInt ? Math.round(clamped) : clamped;
}
