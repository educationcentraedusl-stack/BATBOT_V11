/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING ENGINE
 * Volatility Surface Engine (Garman-Klass & Parkinson Realized Volatility)
 *
 * Computes zero-GC Garman-Klass and Parkinson realized volatility metrics over
 * dynamic multi-window timeframes (100ms, 1s, 10s, 60s).
 * Provides dynamic volatility scaling multipliers for MVA-TS adaptive stop-loss bounds.
 */

export interface VolatilitySurfaceMetrics {
  garmanKlass1s: number;
  garmanKlass10s: number;
  garmanKlass60s: number;
  parkinson60s: number;
  volatilityMultiplier: number; // Ratio of fast vs macro volatility, scaled [0.50, 3.00]
}

export class VolatilitySurfaceEngine {
  private readonly symbol: string;

  // Constants
  private static readonly CONST_PARKINSON = 1.0 / (4.0 * Math.LN2); // ~0.36067376
  private static readonly CONST_GK_COEFF = 2.0 * Math.LN2 - 1.0;   // ~0.38629436

  // Circular Ring Buffers for OHLC data (100ms tick sampling frequency)
  private readonly capacity60s: number; // e.g. 600 slots for 60s at 100ms
  private readonly highRing: Float64Array;
  private readonly lowRing: Float64Array;
  private readonly openRing: Float64Array;
  private readonly closeRing: Float64Array;

  private ringIdx: number = 0;
  private sampleCount: number = 0;

  // Intraday Bar Aggregator
  private currentOpen: number = 0;
  private currentHigh: number = 0;
  private currentLow: number = 0;
  private currentClose: number = 0;
  private lastPrice: number = 0;
  private isBarInitialized: boolean = false;

  constructor(symbol: string, maxSamples60s: number = 600) {
    this.symbol = symbol;
    this.capacity60s = maxSamples60s;

    this.highRing = new Float64Array(this.capacity60s);
    this.lowRing = new Float64Array(this.capacity60s);
    this.openRing = new Float64Array(this.capacity60s);
    this.closeRing = new Float64Array(this.capacity60s);
  }

  /**
   * Ingests high-frequency tick price update and updates dynamic OHLC sampling bar
   */
  public updatePrice(price: number): void {
    if (price <= 0) return;

    if (!this.isBarInitialized) {
      this.currentOpen = price;
      this.currentHigh = price;
      this.currentLow = price;
      this.currentClose = price;
      this.lastPrice = price;
      this.isBarInitialized = true;
      return;
    }

    this.currentHigh = Math.max(this.currentHigh, price);
    this.currentLow = Math.min(this.currentLow, price);
    this.currentClose = price;
    this.lastPrice = price;
  }

  /**
   * Pushes completed sub-second OHLC bar into ring buffer (e.g. at 100ms intervals)
   */
  public pushBar(open: number, high: number, low: number, close: number): void {
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) return;

    this.openRing[this.ringIdx] = open;
    this.highRing[this.ringIdx] = high;
    this.lowRing[this.ringIdx] = low;
    this.closeRing[this.ringIdx] = close;

    this.ringIdx = (this.ringIdx + 1) % this.capacity60s;
    if (this.sampleCount < this.capacity60s) {
      this.sampleCount++;
    }

    // Reset current sampling bar
    this.currentOpen = close;
    this.currentHigh = close;
    this.currentLow = close;
    this.currentClose = close;
  }

  /**
   * Calculates Garman-Klass Realized Volatility over a specified sample window N
   */
  public getGarmanKlassVolatility(windowSize: number): number {
    const N = Math.min(windowSize, this.sampleCount);
    if (N < 2) return 0.0;

    let sumGK = 0;
    for (let i = 0; i < N; i++) {
      // Index backwards from current ring position
      const idx = (this.ringIdx - 1 - i + this.capacity60s) % this.capacity60s;
      const h = this.highRing[idx];
      const l = this.lowRing[idx];
      const o = this.openRing[idx];
      const c = this.closeRing[idx];

      if (l <= 0 || o <= 0) continue;

      const logHL = Math.log(h / l);
      const logCO = Math.log(c / o);

      const term1 = 0.5 * (logHL * logHL);
      const term2 = VolatilitySurfaceEngine.CONST_GK_COEFF * (logCO * logCO);

      sumGK += Math.max(0, term1 - term2);
    }

    const variance = sumGK / N;
    return Math.sqrt(Math.max(0, variance));
  }

  /**
   * Calculates Parkinson Realized Volatility over a specified sample window N
   */
  public getParkinsonVolatility(windowSize: number): number {
    const N = Math.min(windowSize, this.sampleCount);
    if (N < 2) return 0.0;

    let sumParkinson = 0;
    for (let i = 0; i < N; i++) {
      const idx = (this.ringIdx - 1 - i + this.capacity60s) % this.capacity60s;
      const h = this.highRing[idx];
      const l = this.lowRing[idx];

      if (l <= 0) continue;

      const logHL = Math.log(h / l);
      sumParkinson += logHL * logHL;
    }

    const variance = VolatilitySurfaceEngine.CONST_PARKINSON * (sumParkinson / N);
    return Math.sqrt(Math.max(0, variance));
  }

  /**
   * Computes comprehensive Volatility Surface metrics across fast, medium, and macro timeframes
   */
  public getVolatilitySurfaceMetrics(): VolatilitySurfaceMetrics {
    const gk1s = this.getGarmanKlassVolatility(10);   // 1s window (10 x 100ms bars)
    const gk10s = this.getGarmanKlassVolatility(100); // 10s window (100 x 100ms bars)
    const gk60s = this.getGarmanKlassVolatility(600); // 60s macro window
    const parkinson60s = this.getParkinsonVolatility(600);

    // Dynamic Volatility Multiplier: Fast (1s) vs Macro (60s) Realized Volatility Ratio
    let rawRatio = 1.0;
    if (gk60s > 0 && gk1s > 0) {
      rawRatio = gk1s / gk60s;
    }

    // Clamp multiplier to [0.50, 3.00] range
    const volatilityMultiplier = Math.max(0.50, Math.min(3.00, rawRatio));

    return {
      garmanKlass1s: gk1s,
      garmanKlass10s: gk10s,
      garmanKlass60s: gk60s,
      parkinson60s,
      volatilityMultiplier
    };
  }

  public getSymbol(): string {
    return this.symbol;
  }
}
