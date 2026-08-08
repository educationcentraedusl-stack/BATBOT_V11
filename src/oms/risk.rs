use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

use crate::oms::types::{OrderIntent, OrderSide};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum OmsRiskError {
    RateLimitExceeded(String),
    MaxNotionalExceeded { notional: f64, limit: f64 },
    PriceCollarExceeded { price: f64, mid_price: f64, deviation_pct: f64 },
    MaxPositionDriftExceeded { net_position_usd: f64, limit_usd: f64 },
    CorrelationSpikeEmergency { correlation: f64, limit: f64 },
    LeverageCapExceeded { leverage: f64, limit: f64 },
    InvalidOrderParameters(String),
}

impl std::fmt::Display for OmsRiskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OmsRiskError::RateLimitExceeded(msg) => write!(f, "Rate Limit Exceeded: {}", msg),
            OmsRiskError::MaxNotionalExceeded { notional, limit } => {
                write!(f, "Max Notional Exceeded: ${:.2} > limit ${:.2}", notional, limit)
            }
            OmsRiskError::PriceCollarExceeded { price, mid_price, deviation_pct } => write!(
                f,
                "Price Collar Violation: Price ${:.4} deviates from Mid ${:.4} by {:.2}%",
                price, mid_price, deviation_pct
            ),
            OmsRiskError::MaxPositionDriftExceeded { net_position_usd, limit_usd } => write!(
                f,
                "Max Position Drift Exceeded: Net USD ${:.2} > limit ${:.2}",
                net_position_usd, limit_usd
            ),
            OmsRiskError::CorrelationSpikeEmergency { correlation, limit } => write!(
                f,
                "Correlation Spike Emergency: Portfolio avg corr {:.3} > limit {:.3}",
                correlation, limit
            ),
            OmsRiskError::LeverageCapExceeded { leverage, limit } => write!(
                f,
                "Leverage Cap Exceeded: Gross Leverage {:.2}x > Cap {:.2}x",
                leverage, limit
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
    pub max_gross_leverage: f64,
    pub max_correlation_threshold: f64,
}

impl Default for RiskConfig {
    fn default() -> Self {
        Self {
            max_notional_per_order: 50_000.0,    // $50k max order
            max_portfolio_notional: 250_000.0,   // $250k max net portfolio
            max_price_deviation_pct: 1.0,        // 1% max distance from mid price
            max_orders_per_10s: 300,             // Binance order rate limit
            max_weight_per_min: 1200,            // Binance request weight limit
            max_gross_leverage: 3.0,             // 3.0x max portfolio gross leverage
            max_correlation_threshold: 0.85,     // 0.85 correlation emergency cap
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
        self.validate_multi_asset_order(intent, mid_price, current_position_qty, 0.0, 0.0)
    }

    pub fn validate_multi_asset_order(
        &self,
        intent: &OrderIntent,
        mid_price: f64,
        current_position_qty: f64,
        projected_portfolio_leverage: f64,
        avg_correlation: f64,
    ) -> Result<(), OmsRiskError> {
        // 0. Non-finite / NaN Poisoning Check
        if !intent.quantity.is_finite()
            || !intent.price.is_finite()
            || !intent.ai_confidence.is_finite()
            || !intent.ai_direction.is_finite()
            || !intent.target_horizon_ms.is_finite()
            || !mid_price.is_finite()
            || !current_position_qty.is_finite()
            || !projected_portfolio_leverage.is_finite()
            || !avg_correlation.is_finite()
        {
            return Err(OmsRiskError::InvalidOrderParameters(
                "Non-finite numeric values (NaN or Infinity) rejected".to_string(),
            ));
        }

        // 0. Parameter Validation
        if intent.quantity <= 0.0 || intent.price <= 0.0 {
            return Err(OmsRiskError::InvalidOrderParameters(
                "Order quantity and price must be strictly positive".to_string(),
            ));
        }

        if mid_price <= 0.0 {
            return Err(OmsRiskError::InvalidOrderParameters(
                "Mid price must be strictly positive".to_string(),
            ));
        }

        // 1. Rate Limiting Check (10-second sliding window inspection without polluting budget)
        let now = Self::now_ns();
        let window_duration_ns = 10_000_000_000u64; // 10 seconds in nanoseconds
        let last_reset = self.last_window_reset_ns.load(Ordering::Acquire);
        if now.saturating_sub(last_reset) > window_duration_ns {
            let _ = self.last_window_reset_ns.compare_exchange_weak(
                last_reset,
                now,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            if self.last_window_reset_ns.load(Ordering::Acquire) == now {
                self.order_count_window.store(0, Ordering::Release);
            }
        }

        let current_count = self.order_count_window.load(Ordering::Acquire);
        if current_count >= self.config.max_orders_per_10s as u64 {
            return Err(OmsRiskError::RateLimitExceeded(format!(
                "Sliding 10s order count {} exceeded limit {}",
                current_count, self.config.max_orders_per_10s
            )));
        }

        // 2. Correlation Emergency Brake
        if avg_correlation > self.config.max_correlation_threshold {
            return Err(OmsRiskError::CorrelationSpikeEmergency {
                correlation: avg_correlation,
                limit: self.config.max_correlation_threshold,
            });
        }

        // 3. Gross Leverage Cap Guard
        if projected_portfolio_leverage > self.config.max_gross_leverage {
            return Err(OmsRiskError::LeverageCapExceeded {
                leverage: projected_portfolio_leverage,
                limit: self.config.max_gross_leverage,
            });
        }

        // 4. Max Notional Per Order Collar
        let order_notional = intent.notional_value();
        if order_notional > self.config.max_notional_per_order {
            return Err(OmsRiskError::MaxNotionalExceeded {
                notional: order_notional,
                limit: self.config.max_notional_per_order,
            });
        }

        // 5. Price Collar Guard
        let dev_pct = ((intent.price - mid_price).abs() / mid_price) * 100.0;
        if dev_pct > self.config.max_price_deviation_pct {
            return Err(OmsRiskError::PriceCollarExceeded {
                price: intent.price,
                mid_price,
                deviation_pct: dev_pct,
            });
        }

        // 6. Position Max Drift Collar (Exempt reduce_only & position-reducing orders for emergency stop-loss safety)
        let fill_qty = if intent.side == OrderSide::Buy {
            intent.quantity
        } else {
            -intent.quantity
        };
        let current_pos_usd = (current_position_qty * mid_price).abs();
        let projected_pos_qty = current_position_qty + fill_qty;
        let projected_pos_usd = (projected_pos_qty * mid_price).abs();

        let is_reducing_exposure = intent.reduce_only || (projected_pos_usd <= current_pos_usd);

        if !is_reducing_exposure && projected_pos_usd > self.config.max_portfolio_notional {
            return Err(OmsRiskError::MaxPositionDriftExceeded {
                net_position_usd: projected_pos_usd,
                limit_usd: self.config.max_portfolio_notional,
            });
        }

        // Increment sliding window order counter ONLY after all checks have passed successfully
        self.order_count_window.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
}

