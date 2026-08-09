import { BinanceExecutionClient, BinanceSymbolInfo } from "../execution/binance";

export interface SymbolPrecisionRule {
  symbol: string;
  qtyDecimals: number;
  stepSize: number;
  priceDecimals: number;
  tickSize: number;
  minNotional: number;
}

export class SymbolPrecisionRegistryManager {
  private precisionMap: Map<string, SymbolPrecisionRule> = new Map();
  private isInitialized = false;

  public isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Helper to parse stepSize string into decimal count and step numeric value.
   * e.g. "0.001" -> { decimals: 3, stepSize: 0.001 }
   * e.g. "0.10" -> { decimals: 1, stepSize: 0.1 }
   * e.g. "1.00" -> { decimals: 0, stepSize: 1.0 }
   */
  public parseFilterStepSize(stepSizeStr: string | undefined, defaultDecimals: number): { decimals: number; stepSize: number } {
    if (!stepSizeStr) return { decimals: defaultDecimals, stepSize: Math.pow(10, -defaultDecimals) };
    const stepSize = parseFloat(stepSizeStr);
    if (isNaN(stepSize) || stepSize <= 0) return { decimals: defaultDecimals, stepSize: Math.pow(10, -defaultDecimals) };

    let decimals = 0;
    if (stepSizeStr.includes(".")) {
      const parts = stepSizeStr.replace(/0+$/, "").split(".");
      decimals = parts[1] ? parts[1].length : 0;
    }
    return { decimals, stepSize };
  }

  /**
   * Parses raw BinanceSymbolInfo object returned from /fapi/v1/exchangeInfo REST endpoint.
   * Extracts LOT_SIZE (qtyDecimals & stepSize), PRICE_FILTER (priceDecimals & tickSize), MIN_NOTIONAL (minNotional).
   */
  public parseSymbolInfo(symbolInfo: BinanceSymbolInfo): SymbolPrecisionRule {
    const symbol = symbolInfo.symbol.toUpperCase();
    let qtyDecimals = symbolInfo.quantityPrecision ?? 3;
    let stepSize = Math.pow(10, -qtyDecimals);
    let priceDecimals = symbolInfo.pricePrecision ?? 2;
    let tickSize = Math.pow(10, -priceDecimals);
    let minNotional = 5.0; // Standard Binance Futures min notional default

    if (Array.isArray(symbolInfo.filters)) {
      for (const filter of symbolInfo.filters) {
        if (filter.filterType === "LOT_SIZE" && filter.stepSize) {
          const parsed = this.parseFilterStepSize(filter.stepSize, qtyDecimals);
          qtyDecimals = parsed.decimals;
          stepSize = parsed.stepSize;
        } else if (filter.filterType === "PRICE_FILTER" && filter.tickSize) {
          const parsed = this.parseFilterStepSize(filter.tickSize, priceDecimals);
          priceDecimals = parsed.decimals;
          tickSize = parsed.stepSize;
        } else if (filter.filterType === "MIN_NOTIONAL" || filter.filterType === "NOTIONAL") {
          const rawNotional = filter.notional || filter.minNotional;
          if (rawNotional) {
            const val = parseFloat(rawNotional);
            if (!isNaN(val) && val > 0) {
              minNotional = val;
            }
          }
        }
      }
    }

    return {
      symbol,
      qtyDecimals,
      stepSize,
      priceDecimals,
      tickSize,
      minNotional,
    };
  }

  /**
   * Performs a single HTTP GET request to Binance Futures /fapi/v1/exchangeInfo
   * and populates the in-memory Precision Map for all active trading pairs.
   */
  public async initializeFromBinance(client?: BinanceExecutionClient): Promise<void> {
    try {
      const execClient = client || new BinanceExecutionClient();
      const exchangeInfo = await execClient.fetchExchangeInfo();
      if (exchangeInfo && Array.isArray(exchangeInfo.symbols)) {
        this.precisionMap.clear();
        for (const symInfo of exchangeInfo.symbols) {
          if (symInfo.symbol) {
            const rule = this.parseSymbolInfo(symInfo);
            this.precisionMap.set(symInfo.symbol.toUpperCase(), rule);
          }
        }
        this.isInitialized = true;
        console.log(`[SymbolPrecisionRegistry] ✅ Dynamic exchangeInfo LOT_SIZE & PRICE_FILTER rules cached for ${this.precisionMap.size} symbols.`);
      } else {
        throw new Error("Invalid response schema received from Binance Futures exchangeInfo endpoint.");
      }
    } catch (err: any) {
      console.warn(`[SymbolPrecisionRegistry] Notice fetching online Binance exchangeInfo: ${err.message}. Pre-seeding fallback precision rules.`);
      // Pre-seed default offline rules if network is offline or unconfigured
      this.preseedOfflineDefaults(["ETHUSDT", "BTCUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT"]);
    }
  }

  /**
   * Returns exact precision rules for a symbol.
   * SAFE FALLBACK: Throws an explicit error if a symbol is missing from exchangeInfo.
   */
  public getPrecisionRule(symbol: string): SymbolPrecisionRule {
    const sym = symbol.toUpperCase();
    const rule = this.precisionMap.get(sym);
    if (!rule) {
      // Auto pre-seed symbol with smart heuristic if missing, or throw error
      if (!this.isInitialized) {
        this.preseedOfflineDefaults([sym]);
        return this.precisionMap.get(sym)!;
      }
      throw new Error(`[CRITICAL_PRECISION_ERROR] Symbol '${symbol}' not found in Binance ExchangeInfo Precision Registry! Refusing to trade with unverified LOT_SIZE rules.`);
    }
    return rule;
  }

  /**
   * Formats raw quantity dynamically according to symbol LOT_SIZE rules.
   * Supports isMinNotionalGuard ceiling rounding (Math.ceil) to guarantee notional >= minNotional.
   */
  public formatQuantity(symbol: string, rawQty: number, isMinNotionalGuard: boolean = false): number {
    const rule = this.getPrecisionRule(symbol);
    const { qtyDecimals, stepSize } = rule;

    if (qtyDecimals === 0) {
      return isMinNotionalGuard ? Math.max(1, Math.ceil(rawQty)) : Math.max(1, Math.floor(rawQty));
    }

    const factor = Math.pow(10, qtyDecimals);
    if (isMinNotionalGuard) {
      // Ceiling rounding guarantees order notional is strictly >= minNotional
      const rounded = Math.ceil(rawQty * factor - 1e-9) / factor;
      return Math.max(stepSize, Number(rounded.toFixed(qtyDecimals)));
    } else {
      // Standard floor truncation to prevent INSUFFICIENT_BALANCE
      const rounded = Math.floor(rawQty * factor + 1e-9) / factor;
      return Math.max(stepSize, Number(rounded.toFixed(qtyDecimals)));
    }
  }

  /**
   * Formats raw price dynamically according to symbol PRICE_FILTER rules.
   */
  public formatPrice(symbol: string, rawPrice: number): number {
    const rule = this.getPrecisionRule(symbol);
    const { priceDecimals, tickSize } = rule;
    if (priceDecimals === 0) {
      return Math.max(tickSize, Math.round(rawPrice));
    }
    const factor = Math.pow(10, priceDecimals);
    const rounded = Math.round(rawPrice * factor) / factor;
    return Math.max(tickSize, Number(rounded.toFixed(priceDecimals)));
  }

  /**
   * Pre-seeds dynamic fallback rules for offline testing / execution.
   */
  public preseedOfflineDefaults(symbols: string[]): void {
    for (const symbol of symbols) {
      const sym = symbol.toUpperCase();
      if (this.precisionMap.has(sym)) continue;

      let qtyDecimals = 2;
      let stepSize = 0.01;
      let priceDecimals = 2;
      let tickSize = 0.01;
      let minNotional = 5.0;

      if (sym.includes("BTC") || sym.includes("ETH")) {
        qtyDecimals = 3; stepSize = 0.001; priceDecimals = 2; tickSize = 0.1;
      } else if (sym.includes("SOL") || sym.includes("BNB") || sym.includes("LINK")) {
        qtyDecimals = 2; stepSize = 0.01; priceDecimals = 2; tickSize = 0.01;
      } else if (sym.includes("XRP") || sym.includes("AVAX") || sym.includes("DOT") || sym.includes("SUI")) {
        qtyDecimals = 1; stepSize = 0.1; priceDecimals = 4; tickSize = 0.0001;
      } else if (sym.includes("ADA") || sym.includes("DOGE")) {
        qtyDecimals = 0; stepSize = 1.0; priceDecimals = 5; tickSize = 0.00001;
      }

      this.precisionMap.set(sym, {
        symbol: sym,
        qtyDecimals,
        stepSize,
        priceDecimals,
        tickSize,
        minNotional,
      });
    }
    this.isInitialized = true;
  }
}

export const SymbolPrecisionRegistry = new SymbolPrecisionRegistryManager();
