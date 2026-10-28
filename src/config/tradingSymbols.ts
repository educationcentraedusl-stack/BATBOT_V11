import "dotenv/config";

/**
 * Default fallback trading symbols list used if TRADING_SYMBOLS environment variable is absent.
 */
export const DEFAULT_TRADING_SYMBOLS: string[] = [
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
export function getTradingSymbols(maxCount?: number): string[] {
  const envSymbolsRaw = process.env.TRADING_SYMBOLS;
  let symbols: string[] = [];

  if (envSymbolsRaw && envSymbolsRaw.trim().length > 0) {
    symbols = envSymbolsRaw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
  }

  if (symbols.length === 0) {
    symbols = [...DEFAULT_TRADING_SYMBOLS];
  }

  const envMaxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || "", 10);
  const cap = maxCount ?? (Number.isFinite(envMaxAssets) && envMaxAssets > 0 ? envMaxAssets : symbols.length);

  return symbols.slice(0, cap);
}

export interface SymbolRiskConfig {
  symbol: string;
  baselineLeverage: number;
  minLeverage: number;
  maxLeverage: number;
}

export const MIN_PERMITTED_LEVERAGE = 2;
export const MAX_PERMITTED_LEVERAGE = 5;
export const DEFAULT_BASELINE_LEVERAGE = 3;
export const PERMANENTLY_BANNED_LEVERAGE = 20;
export const VOLATILITY_TARGET_DAILY = 0.0125; // 1.25% daily / ~20% annualized portfolio volatility budget

export const SYMBOL_LEVERAGE_CONFIG: Record<string, SymbolRiskConfig> = {
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
export function getBaselineLeverageForSymbol(symbol: string): number {
  const upper = symbol.toUpperCase();
  if (SYMBOL_LEVERAGE_CONFIG[upper]) {
    return SYMBOL_LEVERAGE_CONFIG[upper].baselineLeverage;
  }
  if (upper.includes("BTC") || upper.includes("ETH")) {
    return 5;
  }
  if (upper.includes("DOGE")) {
    return 2;
  }
  return DEFAULT_BASELINE_LEVERAGE;
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
export function calculateInverseVolatilityLeverage(
  realizedVol: number,
  volTarget: number = VOLATILITY_TARGET_DAILY,
  roundToInt: boolean = true
): number {
  const minVolFloor = 0.0025; // Floor preventing division by zero or leverage > 5 before clamping
  const safeVol = Number.isFinite(realizedVol) && realizedVol > 0.000001 ? realizedVol : minVolFloor;
  const effectiveVol = Math.max(safeVol, minVolFloor);
  const rawLev = volTarget / effectiveVol;
  const clamped = Math.max(MIN_PERMITTED_LEVERAGE, Math.min(MAX_PERMITTED_LEVERAGE, rawLev));
  return roundToInt ? Math.round(clamped) : clamped;
}
