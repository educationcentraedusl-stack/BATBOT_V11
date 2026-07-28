use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SizerConfig {
    pub kelly_fraction: f64,
    pub default_win_loss_ratio: f64,
    pub max_leverage: f64,
    pub min_order_qty: f64,
    pub max_order_qty: f64,
    pub max_volatility_threshold: f64,
    pub taker_fee_rate: f64,
}

impl Default for SizerConfig {
    fn default() -> Self {
        Self {
            kelly_fraction: 0.20, // Quarter-Kelly for conservative draw-down containment
            default_win_loss_ratio: 1.5,
            max_leverage: 5.0,
            min_order_qty: 0.001,
            max_order_qty: 10.0,
            max_volatility_threshold: 0.05,
            taker_fee_rate: 0.0004, // 0.04% Binance Futures Taker Fee
        }
    }
}

pub struct KellySizer {
    config: SizerConfig,
}

impl KellySizer {
    pub fn new(config: SizerConfig) -> Self {
        Self { config }
    }

    pub fn with_default_config() -> Self {
        Self::new(SizerConfig::default())
    }

    pub fn compute_order_quantity(
        &self,
        direction: f64,
        confidence: f64,
        horizon_ms: f64,
        latency_ns: u64,
        mid_price: f64,
        spread_vel: f64,
        account_balance: f64,
        current_position: f64,
        realized_volatility: f64,
    ) -> f64 {
        if mid_price <= 0.0 || account_balance <= 0.0 || confidence <= 0.0 || direction.abs() < 1e-6 {
            return 0.0;
        }

        // 1. Compute Execution Latency Exponential Decay Factor: gamma = exp(-latency_ms / horizon_ms)
        let latency_ms = (latency_ns as f64) / 1e6;
        let safe_horizon = horizon_ms.max(1.0);
        let gamma_lat = (-latency_ms / safe_horizon).exp().clamp(0.0, 1.0);

        // 2. Map Win Probability via Sigmoid output
        let k_factor = 2.5;
        let win_prob = 1.0 / (1.0 + (-k_factor * direction.abs() * confidence).exp());

        // 3. Compute Latency and Fee/Slippage adjusted Win/Loss ratio 'b'
        let expected_drift = direction.abs() * confidence * mid_price * 0.001;
        let expected_cost = mid_price * self.config.taker_fee_rate + spread_vel.abs() * 0.1;
        let win_loss_ratio = if expected_cost > 0.0 {
            ((expected_drift - expected_cost) / expected_cost).max(0.1)
        } else {
            self.config.default_win_loss_ratio
        };

        // 4. Calculate Full Kelly Fraction: f* = (p * b - (1 - p)) / b
        let raw_kelly = (win_prob * win_loss_ratio - (1.0 - win_prob)) / win_loss_ratio;
        if raw_kelly <= 0.0 {
            return 0.0;
        }

        // 5. Apply Volatility Scaling Factor
        let vol_scaler = if self.config.max_volatility_threshold > 0.0 {
            (1.0 - (realized_volatility / self.config.max_volatility_threshold)).clamp(0.0, 1.0)
        } else {
            1.0
        };

        // 6. Compute Latency-Decayed Fractional Kelly Target Position
        let adjusted_kelly = raw_kelly * self.config.kelly_fraction * gamma_lat * vol_scaler;
        let target_notional = (adjusted_kelly * account_balance * self.config.max_leverage).max(0.0);
        let target_position_qty = target_notional / mid_price;

        // 7. Determine Net Delta needed from current position
        let desired_total_pos = if direction > 0.0 {
            target_position_qty
        } else {
            -target_position_qty
        };

        let raw_order_qty = desired_total_pos - current_position;
        let order_side_qty = raw_order_qty.abs();

        if order_side_qty < self.config.min_order_qty {
            return 0.0;
        }

        order_side_qty.min(self.config.max_order_qty)
    }
}
