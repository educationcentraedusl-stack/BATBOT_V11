use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

use crate::oms::types::{OrderIntent, OrderSide};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OmsRiskError {
    RateLimitExceeded(String),
    MaxNotionalExceeded { notional: u64, limit: u64 },
    PriceCollarExceeded { price: u64, mid_price: u64, deviation_pct: u64 },
    MaxPositionDriftExceeded { net_position_usd: u64, limit_usd: u64 },
    InvalidOrderParameters(String),
}

impl std::fmt::Display for OmsRiskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OmsRiskError::RateLimitExceeded(msg) => write!(f, "Rate Limit Exceeded: {}", msg),
            OmsRiskError::MaxNotionalExceeded { notional, limit } => {
                write!(f, "Max Notional Exceeded: ${} > limit ${}", notional, limit)
            }
            OmsRiskError::PriceCollarExceeded { price, mid_price, deviation_pct } => write!(
                f,
                "Price Collar Violation: Price ${} deviates from Mid ${} by {}%",
                price, mid_price, deviation_pct
            ),
            OmsRiskError::MaxPositionDriftExceeded { net_position_usd, limit_usd } => write!(
                f,
                "Max Position Drift Exceeded: Net USD ${} > limit ${}",
                net_position_usd, limit_usd
            ),
            OmsRiskError::InvalidOrderParameters(msg) => write!(f, "Invalid Order Params: {}", msg),
        }
    }
}

impl std::error::Error for OmsRiskError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskConfig {
    pub max_notional_per_order: f64,
    pub max_portfolio_notional: f64,
    pub max_price_deviation_pct: f64,
    pub max_orders_per_10s: u32,
    pub max_weight_per_min: u32,
}

impl Default for RiskConfig {
    fn default() -> Self {
        Self {
            max_notional_per_order: 50_000.0,    // $50k max order
            max_portfolio_notional: 250_000.0,   // $250k max net portfolio
            max_price_deviation_pct: 1.0,        // 1% max distance from mid price
            max_orders_per_10s: 300,             // Binance order rate limit
            max_weight_per_min: 1200,            // Binance request weight limit
        }
    }
}

pub struct OmsRiskGuard {
    config: RiskConfig,
    order_count_window: AtomicU64,
    last_window_reset_ns: AtomicU64,
}

impl OmsRiskGuard {
    pub fn new(config: RiskConfig) -> Self {
        let now_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;

        Self {
            config,
            order_count_window: AtomicU64::new(0),
            last_window_reset_ns: AtomicU64::new(now_ns),
        }
    }

    pub fn with_default_config() -> Self {
        Self::new(RiskConfig::default())
    }

    fn now_ns() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64
    }

    pub fn validate_order(
        &self,
        intent: &OrderIntent,
        mid_price: f64,
        current_position_qty: f64,
    ) -> Result<(), OmsRiskError> {
        // 0. Parameter Validation
        if intent.quantity <= 0.0 || intent.price <= 0.0 {
            return Err(OmsRiskError::InvalidOrderParameters(
                "Order quantity and price must be strictly positive".to_string(),
            ));
        }

        // 1. Rate Limiting Check (10-second sliding window)
        let now = Self::now_ns();
        let last_reset = self.last_window_reset_ns.load(Ordering::Relaxed);
        let window_duration_ns = 10_000_000_000u64; // 10 seconds in nanoseconds

        if now.saturating_sub(last_reset) > window_duration_ns {
            self.order_count_window.store(1, Ordering::Relaxed);
            self.last_window_reset_ns.store(now, Ordering::Relaxed);
        } else {
            let current_count = self.order_count_window.fetch_add(1, Ordering::Relaxed);
            if current_count >= self.config.max_orders_per_10s as u64 {
                return Err(OmsRiskError::RateLimitExceeded(format!(
                    "Sliding 10s order count {} exceeded limit {}",
                    current_count, self.config.max_orders_per_10s
                )));
            }
        }

        // 2. Max Notional Per Order Collar
        let order_notional = intent.notional_value();
        if order_notional > self.config.max_notional_per_order {
            return Err(OmsRiskError::MaxNotionalExceeded {
                notional: order_notional as u64,
                limit: self.config.max_notional_per_order as u64,
            });
        }

        // 3. Price Collar Guard
        if mid_price > 0.0 {
            let dev_pct = ((intent.price - mid_price).abs() / mid_price) * 100.0;
            if dev_pct > self.config.max_price_deviation_pct {
                return Err(OmsRiskError::PriceCollarExceeded {
                    price: intent.price as u64,
                    mid_price: mid_price as u64,
                    deviation_pct: dev_pct as u64,
                });
            }
        }

        // 4. Position Max Drift Collar
        let fill_qty = if intent.side == OrderSide::Buy {
            intent.quantity
        } else {
            -intent.quantity
        };
        let projected_pos_qty = current_position_qty + fill_qty;
        let projected_pos_usd = (projected_pos_qty * mid_price).abs();

        if projected_pos_usd > self.config.max_portfolio_notional {
            return Err(OmsRiskError::MaxPositionDriftExceeded {
                net_position_usd: projected_pos_usd as u64,
                limit_usd: self.config.max_portfolio_notional as u64,
            });
        }

        Ok(())
    }
}
