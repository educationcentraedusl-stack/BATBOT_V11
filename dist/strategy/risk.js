"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskGuard = exports.RISK_REJECTED_DAILY_LOSS = exports.RISK_REJECTED_COOLDOWN = exports.RISK_REJECTED_UNCONFIGURED = exports.RISK_PASSED = void 0;
exports.RISK_PASSED = Object.freeze({
    passed: true,
    reasonCode: "APPROVED",
    message: "Risk checks passed successfully.",
});
exports.RISK_REJECTED_UNCONFIGURED = Object.freeze({
    passed: false,
    reasonCode: "UNCONFIGURED_CREDENTIALS",
    message: "Binance Execution Client is not configured with valid API credentials.",
});
exports.RISK_REJECTED_COOLDOWN = Object.freeze({
    passed: false,
    reasonCode: "COOLDOWN_ACTIVE",
    message: "Order rejected due to active cooldown window.",
});
exports.RISK_REJECTED_DAILY_LOSS = Object.freeze({
    passed: false,
    reasonCode: "EXCEEDS_DAILY_LOSS",
    message: "Order rejected: daily cumulative loss limit reached.",
});
class RiskGuard {
    config;
    lastExecutionTimestampMs = 0;
    cumulativeDailyLossUsdt = 0;
    currentPositionNotionalUsdt = 0;
    constructor(config) {
        this.config = {
            maxPositionSizeUsdt: config?.maxPositionSizeUsdt ?? 1000.0,
            minCooldownMs: config?.minCooldownMs ?? 1000,
            maxDailyLossUsdt: config?.maxDailyLossUsdt ?? 500.0,
            maxPriceSlippagePercent: config?.maxPriceSlippagePercent ?? 0.5,
        };
    }
    getConfig() {
        return this.config;
    }
    validateOrder(intent, isClientConfigured) {
        if (!isClientConfigured) {
            return exports.RISK_REJECTED_UNCONFIGURED;
        }
        const now = Date.now();
        // 1. Cooldown Enforcement
        if (now - this.lastExecutionTimestampMs < this.config.minCooldownMs) {
            return exports.RISK_REJECTED_COOLDOWN;
        }
        // 2. Daily Loss Threshold
        if (this.cumulativeDailyLossUsdt >= this.config.maxDailyLossUsdt) {
            return exports.RISK_REJECTED_DAILY_LOSS;
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
        return exports.RISK_PASSED;
    }
    recordExecutionSuccess(notionalUsdt) {
        this.lastExecutionTimestampMs = Date.now();
        this.currentPositionNotionalUsdt += notionalUsdt;
    }
    recordRealizedPnl(pnlUsdt) {
        if (pnlUsdt < 0) {
            this.cumulativeDailyLossUsdt += Math.abs(pnlUsdt);
        }
    }
    updatePositionNotional(notionalUsdt) {
        this.currentPositionNotionalUsdt = Math.max(0, notionalUsdt);
    }
    resetDailyLoss() {
        this.cumulativeDailyLossUsdt = 0;
    }
}
exports.RiskGuard = RiskGuard;
