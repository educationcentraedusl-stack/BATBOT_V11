export interface RiskConfig {
  maxPositionSizeUsdt: number;
  minCooldownMs: number;
  maxDailyLossUsdt: number;
  maxPriceSlippagePercent: number;
}

export interface OrderIntent {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
}

export interface RiskCheckResult {
  passed: boolean;
  reasonCode: "APPROVED" | "COOLDOWN_ACTIVE" | "EXCEEDS_MAX_POSITION" | "EXCEEDS_DAILY_LOSS" | "INVALID_PRICE" | "UNCONFIGURED_CREDENTIALS" | "INVALID_STOP_LOSS";
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

export class RiskGuard {
  private config: RiskConfig;
  private lastExecutionTimestampMs: number = 0;
  private cumulativeDailyLossUsdt: number = 0;
  private currentPositionNotionalUsdt: number = 0;

  constructor(config?: Partial<RiskConfig>) {
    this.config = {
      maxPositionSizeUsdt: config?.maxPositionSizeUsdt ?? 1000.0,
      minCooldownMs: config?.minCooldownMs ?? 1000,
      maxDailyLossUsdt: config?.maxDailyLossUsdt ?? 500.0,
      maxPriceSlippagePercent: config?.maxPriceSlippagePercent ?? 0.5,
    };
  }

  public getConfig(): Readonly<RiskConfig> {
    return this.config;
  }

  public validateOrder(intent: OrderIntent, isClientConfigured: boolean): RiskCheckResult {
    if (!isClientConfigured) {
      return RISK_REJECTED_UNCONFIGURED;
    }

    const now = Date.now();

    // 1. Cooldown Enforcement
    if (now - this.lastExecutionTimestampMs < this.config.minCooldownMs) {
      return RISK_REJECTED_COOLDOWN;
    }

    // 2. Daily Loss Threshold
    if (this.cumulativeDailyLossUsdt >= this.config.maxDailyLossUsdt) {
      return RISK_REJECTED_DAILY_LOSS;
    }

    // 3. Price & Quantity Sanity
    if (intent.price <= 0 || intent.quantity <= 0) {
      return {
        passed: false,
        reasonCode: "INVALID_PRICE",
        message: `Invalid order price (${intent.price}) or quantity (${intent.quantity}).`,
      };
    }

    // 4. Max Position Size Limit
    const proposedOrderNotional = intent.price * intent.quantity;
    if (this.currentPositionNotionalUsdt + proposedOrderNotional > this.config.maxPositionSizeUsdt) {
      return {
        passed: false,
        reasonCode: "EXCEEDS_MAX_POSITION",
        message: `Proposed order value ($${proposedOrderNotional.toFixed(2)}) exceeds max position size limit ($${this.config.maxPositionSizeUsdt.toFixed(2)}).`,
      };
    }

    // 5. Stop Loss Sanity Check
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

    return RISK_PASSED;
  }

  public recordExecutionSuccess(notionalUsdt: number, side: "BUY" | "SELL" = "BUY"): void {
    this.lastExecutionTimestampMs = Date.now();
  }

  public recordRealizedPnl(pnlUsdt: number): void {
    if (pnlUsdt < 0) {
      this.cumulativeDailyLossUsdt += Math.abs(pnlUsdt);
    }
  }

  public updatePositionNotional(notionalUsdt: number): void {
    this.currentPositionNotionalUsdt = Math.max(0, notionalUsdt);
  }

  public resetDailyLoss(): void {
    this.cumulativeDailyLossUsdt = 0;
  }
}
