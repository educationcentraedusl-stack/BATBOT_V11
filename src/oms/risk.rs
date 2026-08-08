use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

use crate::oms::types::{OrderIntent, OrderIntentPacket};

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
    /// Bit-packed lock-free 64-bit rate limiter:
    /// Upper 32 bits: last_reset_sec (u32 timestamp in seconds)
    /// Lower 32 bits: count (u32 order count in current 10s window)
    window_state: AtomicU64,
}

impl OmsRiskGuard {
    pub fn new(config: RiskConfig) -> Self {
        let now_sec = (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()) as u32;

        let initial_state = (now_sec as u64) << 32;
        Self {
            config,
            window_state: AtomicU64::new(initial_state),
        }
    }

    pub fn with_default_config() -> Self {
        Self::new(RiskConfig::default())
    }

    #[inline(always)]
    fn check_and_increment_rate_limit(&self, creation_ns: u64) -> Result<(), OmsRiskError> {
        let now_sec = if creation_ns > 0 {
            creation_ns / 1_000_000_000
        } else {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        };

        let mut current = self.window_state.load(Ordering::Relaxed);
        loop {
            let last_reset_sec = (current >> 32) as u32;
            let count = (current & 0xFFFF_FFFF) as u32;

            let (new_reset_sec, new_count) = if (now_sec as u32).saturating_sub(last_reset_sec) >= 10 {
                (now_sec as u32, 1u32)
            } else {
                if count >= self.config.max_orders_per_10s {
                    return Err(OmsRiskError::RateLimitExceeded(
                        "Sliding 10s order limit exceeded".to_string(),
                    ));
                }
                (last_reset_sec, count + 1)
            };

            let new_state = ((new_reset_sec as u64) << 32) | (new_count as u64);
            match self.window_state.compare_exchange_weak(
                current,
                new_state,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Ok(()),
                Err(actual) => current = actual,
            }
        }
    }

    pub fn validate_order(
        &self,
        intent: &OrderIntent,
        mid_price: f64,
        current_position_qty: f64,
    ) -> Result<(), OmsRiskError> {
        self.validate_multi_asset_order(intent, mid_price, current_position_qty, 0.0, 0.0)
    }

    pub fn validate_multi_asset_packet(
        &self,
        pkt: &OrderIntentPacket,
        mid_price: f64,
        current_position_qty: f64,
        projected_portfolio_leverage: f64,
        avg_correlation: f64,
    ) -> Result<(), OmsRiskError> {
        // 0. Non-finite / NaN Poisoning Check
        if !pkt.quantity.is_finite()
            || !pkt.price.is_finite()
            || !pkt.ai_confidence.is_finite()
            || !pkt.ai_direction.is_finite()
            || !pkt.target_horizon_ms.is_finite()
            || !mid_price.is_finite()
            || !current_position_qty.is_finite()
            || !projected_portfolio_leverage.is_finite()
            || !avg_correlation.is_finite()
        {
            return Err(OmsRiskError::InvalidOrderParameters(
                "Non-finite numeric values (NaN or Infinity) rejected".to_string(),
            ));
        }

        if pkt.quantity <= 0.0 || pkt.price <= 0.0 || mid_price <= 0.0 {
            return Err(OmsRiskError::InvalidOrderParameters(
                "Order quantity, price, and mid price must be strictly positive".to_string(),
            ));
        }

        // 1. Lock-free Atomic Rate Limit Check & Increment
        self.check_and_increment_rate_limit(pkt.creation_ns)?;

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
        let order_notional = pkt.notional_value();
        if order_notional > self.config.max_notional_per_order {
            return Err(OmsRiskError::MaxNotionalExceeded {
                notional: order_notional,
                limit: self.config.max_notional_per_order,
            });
        }

        // 5. Price Collar Guard
        let dev_pct = ((pkt.price - mid_price).abs() / mid_price) * 100.0;
        if dev_pct > self.config.max_price_deviation_pct {
            return Err(OmsRiskError::PriceCollarExceeded {
                price: pkt.price,
                mid_price,
                deviation_pct: dev_pct,
            });
        }

        // 6. Position Max Drift Collar
        let fill_qty = if pkt.side == 0 { pkt.quantity } else { -pkt.quantity };
        let current_pos_usd = (current_position_qty * mid_price).abs();
        let projected_pos_qty = current_position_qty + fill_qty;
        let projected_pos_usd = (projected_pos_qty * mid_price).abs();

        let is_reducing_exposure = pkt.is_reduce_only() || (projected_pos_usd <= current_pos_usd);

        if !is_reducing_exposure && projected_pos_usd > self.config.max_portfolio_notional {
            return Err(OmsRiskError::MaxPositionDriftExceeded {
                net_position_usd: projected_pos_usd,
                limit_usd: self.config.max_portfolio_notional,
            });
        }

        Ok(())
    }

    pub fn validate_multi_asset_order(
        &self,
        intent: &OrderIntent,
        mid_price: f64,
        current_position_qty: f64,
        projected_portfolio_leverage: f64,
        avg_correlation: f64,
    ) -> Result<(), OmsRiskError> {
        let pkt = OrderIntentPacket::from_intent(intent);
        self.validate_multi_asset_packet(&pkt, mid_price, current_position_qty, projected_portfolio_leverage, avg_correlation)
    }
}
