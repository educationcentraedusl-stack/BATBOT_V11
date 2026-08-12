import { DynamicRiskProfile } from "./dynamicRiskEngine";

export interface RiskConfig {
  maxPositionSizeUsdt: number;
  minCooldownMs: number;
  maxDailyLossUsdt: number;
  maxPriceSlippagePercent: number;
  dailyProfitLockTargetUsdt: number;
  minRiskRewardRatio: number;
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
    | "EXCEEDS_MAX_POSITION"
    | "EXCEEDS_DAILY_LOSS"
    | "PROFIT_LOCKED_ACTIVE"
    | "INVALID_PRICE"
    | "UNCONFIGURED_CREDENTIALS"
    | "INVALID_STOP_LOSS"
    | "INVALID_RISK_REWARD"
    | "REJECTED_TOXIC_FLOW"
    | "REJECTED_LIQUIDITY_SWEEP_TRAP"
    | "REJECTED_COUNTER_TREND_REGIME"
    | "REJECTED_FRICTION_GUARD"
    | "REJECTED_OVER_TRADING"
    | "TRAINING_LOCK_ACTIVE"
    | "RECALIBRATING_ACTIVE"
    | "ENGINE_PAUSED"
    | "INVALID_TICK_DATA";
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

  constructor(config?: Partial<RiskConfig>) {
    const envDailyProfitLock = process.env.DAILY_PROFIT_LOCK_USDT ? parseFloat(process.env.DAILY_PROFIT_LOCK_USDT) : NaN;
    const defaultProfitLock = !isNaN(envDailyProfitLock) ? envDailyProfitLock : 10.0;

    const envMinRrRatio = process.env.MIN_RISK_REWARD_RATIO ? parseFloat(process.env.MIN_RISK_REWARD_RATIO) : NaN;
    const defaultMinRrRatio = !isNaN(envMinRrRatio) ? envMinRrRatio : 2.0;

    const envMaxPosition = process.env.MAX_POSITION_SIZE_USDT ? parseFloat(process.env.MAX_POSITION_SIZE_USDT) : NaN;
    const defaultMaxPosition = !isNaN(envMaxPosition) ? envMaxPosition : 10000.0;

    this.config = {
      maxPositionSizeUsdt: config?.maxPositionSizeUsdt ?? defaultMaxPosition,
      minCooldownMs: config?.minCooldownMs ?? 0,
      maxDailyLossUsdt: config?.maxDailyLossUsdt ?? 500.0,
      maxPriceSlippagePercent: config?.maxPriceSlippagePercent ?? 0.5,
      dailyProfitLockTargetUsdt: config?.dailyProfitLockTargetUsdt ?? defaultProfitLock,
      minRiskRewardRatio: config?.minRiskRewardRatio ?? defaultMinRrRatio,
    };
  }

  public getConfig(): Readonly<RiskConfig> {
    return this.config;
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

    // 1. Cooldown Enforcement
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

    // 2.2 Fee & Spread Friction Guard: Target Return >= 2.5 * (MakerFee + TakerFee)
    if (!intent.isCloseOrder && !intent.isHardStop && intent.price > 0) {
      const makerFee = 0.0002;
      const takerFee = 0.0004;
      const minFrictionFloorPct = 2.5 * (makerFee + takerFee); // 0.0015 (0.15%)

      if (intent.takeProfitPrice !== undefined && intent.takeProfitPrice > 0) {
        const returnPct = Math.abs(intent.takeProfitPrice - intent.price) / intent.price;
        if (returnPct < minFrictionFloorPct - 1e-6) {
          return {
            passed: false,
            reasonCode: "REJECTED_FRICTION_GUARD",
            message: `Order rejected: Expected profit margin (${(returnPct * 100).toFixed(3)}%) is below mandatory friction defense floor (${(minFrictionFloorPct * 100).toFixed(3)}%).`,
          };
        }
      }
    }

    // 3. Dynamic Microstructure Trap & Toxic Flow Enforcement
    // High-confidence AI signals (>= 65% confidence) bypass VPIN toxic flow traps
    const isAiHighConfidence = intent.riskProfile && (
      intent.riskProfile.isHighConfidenceAi === true ||
      (intent.riskProfile.aiConfidence !== undefined && intent.riskProfile.aiConfidence >= 0.65)
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

    // 6. Max Position Size Limit
    const proposedOrderNotional = intent.price * intent.quantity;
    const posSide = intent.currentPositionSide ?? currentPositionSide;

    let netResultingNotional = proposedOrderNotional;
    if (posSide === "LONG") {
      if (intent.side === "BUY") {
        netResultingNotional = this.currentPositionNotionalUsdt + proposedOrderNotional;
      } else {
        netResultingNotional = Math.max(0, this.currentPositionNotionalUsdt - proposedOrderNotional);
      }
    } else if (posSide === "SHORT") {
      if (intent.side === "SELL") {
        netResultingNotional = this.currentPositionNotionalUsdt + proposedOrderNotional;
      } else {
        netResultingNotional = Math.max(0, this.currentPositionNotionalUsdt - proposedOrderNotional);
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

    // 8. Strict Minimum Risk/Reward Ratio Enforcement (Floor: 2.0)
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
        const requiredMin = this.config.minRiskRewardRatio ?? 2.0;
        if (rrRatio < requiredMin - 1e-4) {
          return {
            passed: false,
            reasonCode: "INVALID_RISK_REWARD",
            message: `Order rejected: Risk/Reward ratio (${rrRatio.toFixed(2)}) is below mandatory minimum floor (${requiredMin.toFixed(2)}).`,
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
    symbol?: string
  ): void {
    this.recordExecutionSuccess(notionalUsdt, side, symbol, true);
    if (realizedPnl !== 0) {
      this.recordRealizedPnl(realizedPnl);
    }
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
}

export class MultiAssetRiskGuard extends RiskGuard {
  private activeSymbolNotionals: Map<string, number> = new Map();
  private symbolExecutionTimestamps: Map<string, number> = new Map();
  private accountBalanceUsdt: number;
  private maxPortfolioLeverage: number;
  private maxAssetCorrelation: number;

  constructor(config?: Partial<MultiAssetRiskConfig>) {
    super(config);
    this.accountBalanceUsdt = config?.accountBalanceUsdt ?? 100_000.0;
    this.maxPortfolioLeverage = config?.maxPortfolioLeverage ?? 3.0;
    this.maxAssetCorrelation = config?.maxAssetCorrelation ?? 0.85;
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
    // Isolated Per-Asset Cooldown Enforcement
    if (intent.symbol && !(intent.isCloseOrder === true || intent.isHardStop === true)) {
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

