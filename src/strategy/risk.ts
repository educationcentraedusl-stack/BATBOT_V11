import { DynamicRiskProfile } from "./dynamicRiskEngine";

export interface RiskConfig {
  maxPositionSizeUsdt: number;
  minCooldownMs: number;
  maxDailyLossUsdt: number;
  maxPriceSlippagePercent: number;
  dailyProfitLockTargetUsdt: number;
  minRiskRewardRatio: number;
  minNetAlpha: number;
  minAiConfidence?: number;
  makerFeeRate?: number;
  takerFeeRate?: number;
}

export interface OrderIntent {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  currentPositionSide?: "FLAT" | "LONG" | "SHORT";
  isCloseOrder?: boolean;
  isHardStop?: boolean;
  riskProfile?: DynamicRiskProfile;
}

export interface RiskCheckResult {
  passed: boolean;
  reasonCode:
    | "APPROVED"
    | "COOLDOWN_ACTIVE"
    | "CIRCUIT_BREAKER_ACTIVE"
    | "EXCEEDS_MAX_POSITION"
    | "EXCEEDS_DAILY_LOSS"
    | "PROFIT_LOCKED_ACTIVE"
    | "INVALID_PRICE"
    | "UNCONFIGURED_CREDENTIALS"
    | "INVALID_STOP_LOSS"
    | "INVALID_RISK_REWARD"
    | "REJECTED_TOXIC_FLOW"
    | "REJECTED_LIQUIDITY_SWEEP_TRAP"
    | "REJECTED_MAX_SPREAD_BLOWOUT"
    | "REJECTED_STALE_ORDERBOOK"
    | "REJECTED_COUNTER_TREND_REGIME"
    | "REJECTED_CHOP_REGIME"
    | "REJECTED_FRICTION_GUARD"
    | "REJECTED_OVER_TRADING"
    | "TRAINING_LOCK_ACTIVE"
    | "RECALIBRATING_ACTIVE"
    | "ENGINE_PAUSED"
    | "INVALID_TICK_DATA"
    | "CRITICAL_EVALUATION_EXCEPTION";
  message: string;
}

export const RISK_PASSED: RiskCheckResult = Object.freeze({
  passed: true,
  reasonCode: "APPROVED",
  message: "Risk checks passed successfully.",
});

export const RISK_REJECTED_UNCONFIGURED: RiskCheckResult = Object.freeze({
  passed: false,
  reasonCode: "UNCONFIGURED_CREDENTIALS",
  message: "Binance Execution Client is not configured with valid API credentials.",
});

export const RISK_REJECTED_COOLDOWN: RiskCheckResult = Object.freeze({
  passed: false,
  reasonCode: "COOLDOWN_ACTIVE",
  message: "Order rejected due to active cooldown window.",
});

export const RISK_REJECTED_DAILY_LOSS: RiskCheckResult = Object.freeze({
  passed: false,
  reasonCode: "EXCEEDS_DAILY_LOSS",
  message: "Order rejected: daily cumulative loss limit reached.",
});

export const RISK_REJECTED_PROFIT_LOCKED: RiskCheckResult = Object.freeze({
  passed: false,
  reasonCode: "PROFIT_LOCKED_ACTIVE",
  message: "Order rejected: Daily profit target reached. System in Profit Lock Shadow Mode.",
});

export class RiskGuard {
  private config: RiskConfig;
  private lastExecutionTimestampMs: number = 0;
  private cumulativeDailyLossUsdt: number = 0;
  private cumulativeDailyRealizedPnl: number = 0;
  private isProfitLocked: boolean = false;
  private currentPositionNotionalUsdt: number = 0;
  protected symbolExecutionHistory: Map<string, number[]> = new Map();
  protected consecutiveLosses: Map<string, number> = new Map();
  protected symbolCooldownExpiries: Map<string, number> = new Map();

  constructor(config?: Partial<RiskConfig>) {
    const envDailyProfitLock = process.env.DAILY_PROFIT_LOCK_USDT ? parseFloat(process.env.DAILY_PROFIT_LOCK_USDT) : NaN;
    const defaultProfitLock = !isNaN(envDailyProfitLock) ? envDailyProfitLock : 10.0;

    const envMinRrRatio = process.env.MIN_RISK_REWARD_RATIO ? parseFloat(process.env.MIN_RISK_REWARD_RATIO) : NaN;
    const defaultMinRrRatio = !isNaN(envMinRrRatio) ? envMinRrRatio : 2.0;

    const envMaxPosition = process.env.MAX_POSITION_SIZE_USDT ? parseFloat(process.env.MAX_POSITION_SIZE_USDT) : NaN;
    const defaultMaxPosition = !isNaN(envMaxPosition) ? envMaxPosition : 10000.0;

    const envMinNetAlpha = process.env.MIN_NET_ALPHA ? parseFloat(process.env.MIN_NET_ALPHA) : NaN;
    const envMakerFee = process.env.MAKER_FEE_RATE ? parseFloat(process.env.MAKER_FEE_RATE) : NaN;
    const envTakerFee = process.env.TAKER_FEE_RATE ? parseFloat(process.env.TAKER_FEE_RATE) : NaN;
    const envMinAiConfidence = process.env.MIN_AI_CONFIDENCE ? parseFloat(process.env.MIN_AI_CONFIDENCE) : NaN;

    this.config = {
      maxPositionSizeUsdt: config?.maxPositionSizeUsdt ?? defaultMaxPosition,
      minCooldownMs: config?.minCooldownMs ?? 0,
      maxDailyLossUsdt: config?.maxDailyLossUsdt ?? 500.0,
      maxPriceSlippagePercent: config?.maxPriceSlippagePercent ?? 0.5,
      dailyProfitLockTargetUsdt: config?.dailyProfitLockTargetUsdt ?? defaultProfitLock,
      minRiskRewardRatio: config?.minRiskRewardRatio ?? defaultMinRrRatio,
      minNetAlpha: config?.minNetAlpha ?? (!isNaN(envMinNetAlpha) ? envMinNetAlpha : 0.0015),
      minAiConfidence: config?.minAiConfidence ?? (!isNaN(envMinAiConfidence) ? envMinAiConfidence : 0.700),
      makerFeeRate: config?.makerFeeRate ?? (!isNaN(envMakerFee) ? envMakerFee : 0.00018),
      takerFeeRate: config?.takerFeeRate ?? (!isNaN(envTakerFee) ? envTakerFee : 0.00045),
    };
  }

  public getConfig(): Readonly<RiskConfig> {
    return this.config;
  }

  /**
   * Calculates exponential backoff cooldown duration (in ms) based on consecutive loss count.
   * 1 loss -> 15s pause (15,000ms)
   * 2 losses -> 60s pause (60,000ms)
   * 3 losses -> 180s pause (180,000ms)
   * 5+ losses -> 900s (15 min / 900,000ms) hard symbol circuit breaker halt
   */
  public static calculateExponentialLossCooldownMs(consecutiveLosses: number): number {
    if (consecutiveLosses >= 5) {
      return 900_000; // 900s (15 min) hard symbol circuit breaker halt
    } else if (consecutiveLosses >= 3) {
      return 180_000; // 3 losses -> 180s pause (also applies to 4 losses)
    } else if (consecutiveLosses === 2) {
      return 60_000; // 2 losses -> 60s pause
    } else if (consecutiveLosses === 1) {
      return 15_000; // 1 loss -> 15s pause
    }
    return 0;
  }

  /**
   * Tracks consecutive realized losses per symbol and calculates exponential cooldown pacing.
   * Resets consecutive loss counter to 0 upon any realized winning exit (> +0.20% Net ROE).
   * Returns the updated consecutive loss count.
   */
  public recordTradeOutcome(
    symbol: string,
    realizedPnl: number,
    netRoePercent?: number
  ): number {
    const sym = symbol || "DEFAULT";
    const currentLosses = this.consecutiveLosses.get(sym) ?? 0;

    // A true winning trade (> +0.20% Net ROE) resets the consecutive loss counter to 0
    const isWinningExit = realizedPnl > 0 && (netRoePercent !== undefined ? netRoePercent > 0.20 : true);

    if (isWinningExit) {
      this.consecutiveLosses.set(sym, 0);
      return 0;
    } else if (realizedPnl < 0 || (realizedPnl >= 0 && (netRoePercent !== undefined && netRoePercent <= 0.20))) {
      // Realized loss or scratch trade not clearing +0.20% Net ROE threshold
      const newLosses = realizedPnl < 0 ? currentLosses + 1 : (realizedPnl === 0 ? currentLosses + 1 : currentLosses);
      this.consecutiveLosses.set(sym, newLosses);
      return newLosses;
    }

    return currentLosses;
  }

  public getConsecutiveLosses(symbol?: string): number {
    const sym = symbol || "DEFAULT";
    return this.consecutiveLosses.get(sym) ?? 0;
  }

  public resetConsecutiveLosses(symbol?: string): void {
    if (symbol) {
      this.consecutiveLosses.set(symbol, 0);
    } else {
      this.consecutiveLosses.clear();
    }
  }

  public getSymbolCooldownExpiry(symbol: string): number {
    return this.symbolCooldownExpiries.get(symbol) ?? 0;
  }

  public setSymbolCooldownExpiry(symbol: string, expiryMs: number): void {
    this.symbolCooldownExpiries.set(symbol, expiryMs);
  }

  public isCircuitBreakerActive(symbol: string, nowMs: number = Date.now()): boolean {
    const losses = this.getConsecutiveLosses(symbol);
    const expiry = this.getSymbolCooldownExpiry(symbol);
    return losses >= 5 && expiry > nowMs;
  }

  public isSymbolHalted(symbol?: string, nowMs: number = Date.now()): boolean {
    const sym = symbol || "DEFAULT";
    const losses = this.getConsecutiveLosses(sym);
    if (losses >= 5) {
      return true; // STRICT CIRCUIT BREAKER HALT
    }
    const expiry = this.getSymbolCooldownExpiry(sym);
    if (expiry > nowMs) {
      return true; // Exponential loss cooldown backoff active
    }
    return false;
  }

  private static readonly PROTECTED_RESULT = Object.freeze({ isProtected: true });

  /**
   * Continuous Closed-Loop Invariant Guard: Verifies that 100% of an aggregated active position
   * has an active exchange-native stop loss order protecting it.
   */
  public auditAggregatedPositionRisk(
    symbol: string,
    side: "LONG" | "SHORT",
    aggregatedQuantity: number,
    activeStopLossOrderId?: number
  ): { isProtected: boolean; reason?: string } {
    if (aggregatedQuantity <= 0) {
      return RiskGuard.PROTECTED_RESULT;
    }

    if (!activeStopLossOrderId || activeStopLossOrderId <= 0) {
      return {
        isProtected: false,
        reason: `UNPROTECTED_EXPOSURE: ${symbol} ${side} position ${aggregatedQuantity} has NO active exchange-native stop loss order!`,
      };
    }

    return RiskGuard.PROTECTED_RESULT;
  }

  public validateOrder(
    intent: OrderIntent,
    isClientConfigured: boolean,
    currentPositionSide: "FLAT" | "LONG" | "SHORT" = "FLAT"
  ): RiskCheckResult {
    if (!isClientConfigured) {
      return RISK_REJECTED_UNCONFIGURED;
    }

    // EMERGENCY HARD STOP & POSITION CLOSE OVERRIDE:
    // Position exit orders and hard stop executions MUST ALWAYS be approved regardless of cooldown, profit lock, toxic flow, or daily loss limits.
    if (intent.isCloseOrder === true || intent.isHardStop === true) {
      return RISK_PASSED;
    }

    const now = Date.now();

    // 1. Cooldown & Consecutive-Loss Circuit Breaker Enforcement
    if (intent.symbol) {
      const expiry = this.getSymbolCooldownExpiry(intent.symbol);
      if (expiry > now) {
        const isCircuitBreaker = this.getConsecutiveLosses(intent.symbol) >= 5;
        const remainingSec = Math.ceil((expiry - now) / 1000);
        return {
          passed: false,
          reasonCode: isCircuitBreaker ? "CIRCUIT_BREAKER_ACTIVE" : "COOLDOWN_ACTIVE",
          message: isCircuitBreaker
            ? `Order rejected: Hard symbol circuit breaker active for ${intent.symbol} (${remainingSec}s remaining after ${this.getConsecutiveLosses(intent.symbol)} consecutive losses).`
            : `Order rejected: Exponential loss cooldown active for ${intent.symbol} (${remainingSec}s remaining).`,
        };
      }
    }

    if (now - this.lastExecutionTimestampMs < this.config.minCooldownMs) {
      return RISK_REJECTED_COOLDOWN;
    }

    // 2. Profit Lock Enforcement (Only allow position close orders when profit locked)
    if (this.isProfitLocked && !intent.isCloseOrder) {
      return RISK_REJECTED_PROFIT_LOCKED;
    }

    // 2.1 Rolling Trade Frequency Limit: Max 5 trades per 5-minute (300,000ms) rolling window per symbol
    if (intent.symbol && !intent.isCloseOrder && !intent.isHardStop) {
      const history = this.symbolExecutionHistory.get(intent.symbol) ?? [];
      const windowStart = now - 300000;
      const recentTrades = history.filter((t) => t >= windowStart);
      if (recentTrades.length >= 5) {
        return {
          passed: false,
          reasonCode: "REJECTED_OVER_TRADING",
          message: `Order rejected: Execution frequency cap reached for ${intent.symbol} (5 trades per 5min window).`,
        };
      }
    }

    // 2.2 SOTA Dynamic Alpha-to-Friction Barrier Guard: Target Return >= Total Friction + MIN_NET_ALPHA
    if (!intent.isCloseOrder && !intent.isHardStop && intent.price > 0) {
      const minNetAlpha = this.config.minNetAlpha;
      const makerFee = this.config.makerFeeRate ?? 0.00018;
      const takerFee = this.config.takerFeeRate ?? 0.00045;
      const minFrictionFloorPct = (makerFee + takerFee) + minNetAlpha;

      if (intent.takeProfitPrice !== undefined && intent.takeProfitPrice > 0) {
        const returnPct = Math.abs(intent.takeProfitPrice - intent.price) / intent.price;
        if (returnPct < minFrictionFloorPct - 1e-6) {
          return {
            passed: false,
            reasonCode: "REJECTED_FRICTION_GUARD",
            message: `Order rejected: Expected profit margin (${(returnPct * 100).toFixed(3)}%) is below mandatory friction defense floor (${(minFrictionFloorPct * 100).toFixed(3)}% = fees ${((makerFee + takerFee) * 100).toFixed(3)}% + alpha ${(minNetAlpha * 100).toFixed(3)}%).`,
          };
        }
      }
    }

    // 3. Dynamic Microstructure Trap & Toxic Flow Enforcement
    // High-confidence AI signals (>= minAiConfidence floor) bypass VPIN toxic flow traps
    const minConfidenceFloor = this.config.minAiConfidence ?? 0.700;
    const isAiHighConfidence = intent.riskProfile && (
      intent.riskProfile.isHighConfidenceAi === true ||
      (intent.riskProfile.aiConfidence !== undefined && intent.riskProfile.aiConfidence >= minConfidenceFloor)
    );
    if (intent.riskProfile && !intent.isCloseOrder && !isAiHighConfidence) {
      if (intent.riskProfile.isTrapDetected) {
        const reason = intent.riskProfile.trapReason ?? "TRAP_DETECTED";
        if (reason.includes("SWEEP")) {
          return {
            passed: false,
            reasonCode: "REJECTED_LIQUIDITY_SWEEP_TRAP",
            message: `Order rejected: ${reason}`,
          };
        } else if (reason.includes("VPIN") || reason.includes("TOXIC")) {
          return {
            passed: false,
            reasonCode: "REJECTED_TOXIC_FLOW",
            message: `Order rejected: ${reason}`,
          };
        } else if (reason.includes("CHOP")) {
          return {
            passed: false,
            reasonCode: "REJECTED_CHOP_REGIME",
            message: `Order rejected: ${reason}`,
          };
        } else {
          return {
            passed: false,
            reasonCode: "REJECTED_COUNTER_TREND_REGIME",
            message: `Order rejected due to unstable regime: ${reason}`,
          };
        }
      }
    }

    // 4. Daily Loss Threshold
    if (this.cumulativeDailyLossUsdt >= this.config.maxDailyLossUsdt) {
      return RISK_REJECTED_DAILY_LOSS;
    }

    // 5. Price & Quantity Sanity
    if (intent.price <= 0 || intent.quantity <= 0) {
      return {
        passed: false,
        reasonCode: "INVALID_PRICE",
        message: `Invalid order price (${intent.price}) or quantity (${intent.quantity}).`,
      };
    }

    // 6. Max Position Size Limit (Evaluated per symbol)
    const proposedOrderNotional = intent.price * intent.quantity;
    const posSide = intent.currentPositionSide ?? currentPositionSide;

    const currentSymbolNotional = (intent.symbol && this instanceof MultiAssetRiskGuard)
      ? (this as MultiAssetRiskGuard).getSymbolNotional(intent.symbol)
      : this.currentPositionNotionalUsdt;

    let netResultingNotional = proposedOrderNotional;
    if (posSide === "LONG") {
      if (intent.side === "BUY") {
        netResultingNotional = currentSymbolNotional + proposedOrderNotional;
      } else {
        netResultingNotional = Math.max(0, currentSymbolNotional - proposedOrderNotional);
      }
    } else if (posSide === "SHORT") {
      if (intent.side === "SELL") {
        netResultingNotional = currentSymbolNotional + proposedOrderNotional;
      } else {
        netResultingNotional = Math.max(0, currentSymbolNotional - proposedOrderNotional);
      }
    } else {
      netResultingNotional = proposedOrderNotional;
    }

    if (netResultingNotional > this.config.maxPositionSizeUsdt) {
      return {
        passed: false,
        reasonCode: "EXCEEDS_MAX_POSITION",
        message: `Proposed net position value ($${netResultingNotional.toFixed(2)}) exceeds max position size limit ($${this.config.maxPositionSizeUsdt.toFixed(2)}).`,
      };
    }

    // 7. Stop Loss Sanity Check
    if (intent.stopLossPrice !== undefined) {
      if (intent.side === "BUY" && intent.stopLossPrice >= intent.price) {
        return {
          passed: false,
          reasonCode: "INVALID_STOP_LOSS",
          message: `Buy order Stop-Loss ($${intent.stopLossPrice}) must be below order price ($${intent.price}).`,
        };
      }
      if (intent.side === "SELL" && intent.stopLossPrice <= intent.price) {
        return {
          passed: false,
          reasonCode: "INVALID_STOP_LOSS",
          message: `Sell order Stop-Loss ($${intent.stopLossPrice}) must be above order price ($${intent.price}).`,
        };
      }
    }

    // 8. SOTA Drawdown-Aware Asymmetric Payoff Skew Expansion (APSE)
    if (!intent.isCloseOrder && intent.takeProfitPrice !== undefined && intent.stopLossPrice !== undefined && intent.price > 0) {
      let rewardDistance = 0;
      let riskDistance = 0;
      if (intent.side === "BUY") {
        rewardDistance = intent.takeProfitPrice - intent.price;
        riskDistance = intent.price - intent.stopLossPrice;
      } else {
        rewardDistance = intent.price - intent.takeProfitPrice;
        riskDistance = intent.stopLossPrice - intent.price;
      }

      if (riskDistance > 0) {
        const rrRatio = rewardDistance / riskDistance;
        const baseMin = this.config.minRiskRewardRatio ?? 2.0;
        const requiredMin = baseMin;
        if (rrRatio < requiredMin - 1e-4) {
          return {
            passed: false,
            reasonCode: "INVALID_RISK_REWARD",
            message: `Order rejected: Risk/Reward ratio (${rrRatio.toFixed(2)}) is below mandatory floor (${requiredMin.toFixed(2)}).`,
          };
        }
      }
    }

    return RISK_PASSED;
  }

  public recordExecutionSuccess(
    notionalUsdt: number,
    side: "BUY" | "SELL" = "BUY",
    symbol?: string,
    isCloseOrder: boolean = false
  ): void {
    const now = Date.now();
    this.lastExecutionTimestampMs = now;
    if (symbol && !isCloseOrder) {
      const history = this.symbolExecutionHistory.get(symbol) ?? [];
      const windowStart = now - 300000;
      const updated = history.filter((t) => t >= windowStart);
      updated.push(now);
      this.symbolExecutionHistory.set(symbol, updated);
    }
  }

  public recordExitExecution(
    notionalUsdt: number,
    realizedPnl: number = 0,
    side: "BUY" | "SELL" = "BUY",
    symbol?: string,
    netRoePercent?: number
  ): number {
    this.recordExecutionSuccess(notionalUsdt, side, symbol, true);
    if (realizedPnl !== 0) {
      this.recordRealizedPnl(realizedPnl);
    }
    const sym = symbol || "DEFAULT";
    const losses = this.recordTradeOutcome(sym, realizedPnl, netRoePercent);
    const cooldownMs = RiskGuard.calculateExponentialLossCooldownMs(losses);
    if (cooldownMs > 0) {
      this.setSymbolCooldownExpiry(sym, Date.now() + cooldownMs);
    }
    return losses;
  }

  public getLastExecutionTimestampMs(): number {
    return this.lastExecutionTimestampMs;
  }

  public recordRealizedPnl(pnlUsdt: number): void {
    this.cumulativeDailyRealizedPnl += pnlUsdt;
    if (pnlUsdt < 0) {
      this.cumulativeDailyLossUsdt += Math.abs(pnlUsdt);
    }
    if (this.cumulativeDailyRealizedPnl >= this.config.dailyProfitLockTargetUsdt) {
      if (!this.isProfitLocked) {
        this.isProfitLocked = true;
        console.log(
          `[RiskGuard][PROFIT_LOCK] Daily profit lock target reached ($${this.cumulativeDailyRealizedPnl.toFixed(
            2
          )} / $${this.config.dailyProfitLockTargetUsdt.toFixed(2)} USDT). Halting new live entries.`
        );
      }
    }
  }

  public isProfitLockedState(): boolean {
    return this.isProfitLocked;
  }

  public getCumulativeDailyRealizedPnl(): number {
    return this.cumulativeDailyRealizedPnl;
  }

  public updatePositionNotional(notionalUsdt: number): void {
    this.currentPositionNotionalUsdt = Math.max(0, notionalUsdt);
  }

  public resetDailyStats(): void {
    this.cumulativeDailyLossUsdt = 0;
    this.cumulativeDailyRealizedPnl = 0;
    this.isProfitLocked = false;
  }
}

export interface MultiAssetRiskConfig extends RiskConfig {
  maxPortfolioLeverage: number;
  maxAssetCorrelation: number;
  accountBalanceUsdt: number;
  maxActivePositions?: number;
}

export class MultiAssetRiskGuard extends RiskGuard {
  private activeSymbolNotionals: Map<string, number> = new Map();
  private symbolExecutionTimestamps: Map<string, number> = new Map();
  private accountBalanceUsdt: number;
  private maxPortfolioLeverage: number;
  private maxAssetCorrelation: number;
  private maxActivePositions: number;

  constructor(config?: Partial<MultiAssetRiskConfig>) {
    super(config);
    this.accountBalanceUsdt = config?.accountBalanceUsdt ?? 100_000.0;
    this.maxPortfolioLeverage = config?.maxPortfolioLeverage ?? 3.0;
    this.maxAssetCorrelation = config?.maxAssetCorrelation ?? 0.85;
    this.maxActivePositions = config?.maxActivePositions ?? 10;
  }

  public override recordExecutionSuccess(
    notionalUsdt: number,
    side: "BUY" | "SELL" = "BUY",
    symbol?: string,
    isCloseOrder: boolean = false
  ): void {
    super.recordExecutionSuccess(notionalUsdt, side, symbol, isCloseOrder);
    if (symbol) {
      this.symbolExecutionTimestamps.set(symbol, Date.now());
      if (isCloseOrder) {
        this.activeSymbolNotionals.delete(symbol);
      } else if (notionalUsdt > 0) {
        this.activeSymbolNotionals.set(symbol, notionalUsdt);
      }
    }
  }

  public getSymbolExecutionTimestamp(symbol: string): number {
    return this.symbolExecutionTimestamps.get(symbol) ?? 0;
  }

  public updateAccountBalance(balanceUsdt: number): void {
    if (balanceUsdt > 0) {
      this.accountBalanceUsdt = balanceUsdt;
    }
  }

  public resetSymbolNotionals(): void {
    this.activeSymbolNotionals.clear();
  }

  public getSymbolNotional(symbol: string): number {
    return this.activeSymbolNotionals.get(symbol) ?? 0;
  }

  public getActiveSymbolCount(): number {
    return this.activeSymbolNotionals.size;
  }

  public updateSymbolNotional(symbol: string, notionalUsdt: number): void {
    if (notionalUsdt <= 0) {
      this.activeSymbolNotionals.delete(symbol);
    } else {
      this.activeSymbolNotionals.set(symbol, notionalUsdt);
    }
  }

  public getGrossPortfolioNotional(): number {
    let total = 0;
    for (const notional of this.activeSymbolNotionals.values()) {
      total += notional;
    }
    return total;
  }

  public getPortfolioLeverage(): number {
    if (this.accountBalanceUsdt <= 0) return 0;
    return this.getGrossPortfolioNotional() / this.accountBalanceUsdt;
  }

  public override validateOrder(
    intent: OrderIntent,
    isClientConfigured: boolean,
    currentPositionSide: "FLAT" | "LONG" | "SHORT" = "FLAT"
  ): RiskCheckResult {
    if (intent.isCloseOrder === true || intent.isHardStop === true) {
      return RISK_PASSED;
    }

    // Isolated Per-Asset Cooldown Enforcement
    if (intent.symbol) {
      const lastExec = this.symbolExecutionTimestamps.get(intent.symbol);
      if (lastExec !== undefined) {
        const now = Date.now();
        if (now - lastExec < this.getConfig().minCooldownMs) {
          return RISK_REJECTED_COOLDOWN;
        }
      }
    }

    return super.validateOrder(intent, isClientConfigured, currentPositionSide);
  }

  public validateMultiAssetOrder(
    intent: OrderIntent,
    isClientConfigured: boolean
  ): RiskCheckResult {
    const baseResult = this.validateOrder(intent, isClientConfigured);
    if (!baseResult.passed) {
      return baseResult;
    }

    if (intent.isCloseOrder || intent.isHardStop) {
      return RISK_PASSED;
    }

    // SOTA 10-SLOT PORTFOLIO HARD CAP: Block new asset entry if portfolio reached max capacity
    const isNewSymbolEntry = !this.activeSymbolNotionals.has(intent.symbol);
    if (isNewSymbolEntry && this.activeSymbolNotionals.size >= this.maxActivePositions) {
      return {
        passed: false,
        reasonCode: "EXCEEDS_MAX_POSITION",
        message: `Order rejected: Maximum portfolio capacity of ${this.maxActivePositions} active positions reached (${this.activeSymbolNotionals.size}/${this.maxActivePositions}).`,
      };
    }

    const proposedNotional = intent.price * intent.quantity;
    const currentGross = this.getGrossPortfolioNotional();
    const existingSymbolNotional = this.activeSymbolNotionals.get(intent.symbol) ?? 0;
    const newGross = currentGross - existingSymbolNotional + proposedNotional;
    const proposedLeverage = this.accountBalanceUsdt > 0 ? newGross / this.accountBalanceUsdt : 0;

    if (proposedLeverage > this.maxPortfolioLeverage + 1e-4) {
      return {
        passed: false,
        reasonCode: "EXCEEDS_MAX_POSITION",
        message: `Order rejected: Proposed portfolio gross leverage (${proposedLeverage.toFixed(2)}x) exceeds max portfolio cap (${this.maxPortfolioLeverage.toFixed(2)}x).`,
      };
    }

    return RISK_PASSED;
  }
}

