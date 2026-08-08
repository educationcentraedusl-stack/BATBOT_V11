use arc_swap::ArcSwap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const MAX_ACTIVE_ASSETS: usize = 10;
pub const GLOBAL_LEVERAGE_CAP: f64 = 3.0;
pub const MAX_SINGLE_ASSET_FRACTION: f64 = 0.50;
pub const KELLY_FRACTIONAL_FACTOR: f64 = 0.15;
pub const DEFAULT_DECAY_ALPHA: f64 = 0.05; // EWMC smoothing factor

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortfolioRiskLimits {
    pub max_portfolio_leverage: f64,
    pub max_asset_correlation: f64,
    pub max_drawdown_limit_pct: f64,
    pub min_risk_reward_ratio: f64,
}

impl Default for PortfolioRiskLimits {
    fn default() -> Self {
        Self {
            max_portfolio_leverage: GLOBAL_LEVERAGE_CAP,
            max_asset_correlation: 0.85,
            max_drawdown_limit_pct: 0.10, // 10% max portfolio drawdown
            min_risk_reward_ratio: 2.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KellyPositionSize {
    pub asset_index: usize,
    pub fraction: f64,
    pub notional_usd: f64,
    pub contract_quantity: f64,
    pub slippage_penalty: f64,
    pub correlation_penalty: f64,
    pub is_approved: bool,
    pub rejection_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CovarianceSnapshot {
    pub sample_count: u64,
    pub means: [f64; MAX_ACTIVE_ASSETS],
    pub variances: [f64; MAX_ACTIVE_ASSETS],
    pub covariance_matrix: [[f64; MAX_ACTIVE_ASSETS]; MAX_ACTIVE_ASSETS],
    pub correlation_matrix: [[f64; MAX_ACTIVE_ASSETS]; MAX_ACTIVE_ASSETS],
}

impl Default for CovarianceSnapshot {
    fn default() -> Self {
        let mut cov = [[0.0; MAX_ACTIVE_ASSETS]; MAX_ACTIVE_ASSETS];
        let mut corr = [[0.0; MAX_ACTIVE_ASSETS]; MAX_ACTIVE_ASSETS];
        for i in 0..MAX_ACTIVE_ASSETS {
            cov[i][i] = 1e-4; // Default initial variance 0.01^2
            corr[i][i] = 1.0;
        }
        Self {
            sample_count: 0,
            means: [0.0; MAX_ACTIVE_ASSETS],
            variances: [1e-4; MAX_ACTIVE_ASSETS],
            covariance_matrix: cov,
            correlation_matrix: corr,
        }
    }
}

pub struct CovarianceRiskGuard {
    limits: PortfolioRiskLimits,
    snapshot: ArcSwap<CovarianceSnapshot>,
    decay_alpha: f64,
}

impl CovarianceRiskGuard {
    pub fn new(limits: Option<PortfolioRiskLimits>, decay_alpha: Option<f64>) -> Self {
        Self {
            limits: limits.unwrap_or_default(),
            snapshot: ArcSwap::new(Arc::new(CovarianceSnapshot::default())),
            decay_alpha: decay_alpha.unwrap_or(DEFAULT_DECAY_ALPHA).clamp(0.001, 0.5),
        }
    }

    pub fn snapshot(&self) -> Arc<CovarianceSnapshot> {
        self.snapshot.load_full()
    }

    /// Online update of rolling returns for all 10 assets using Exponentially Weighted Moving Covariance (EWMC).
    /// Safe for concurrent calls without blocking.
    pub fn update_returns(&self, new_returns: &[f64; MAX_ACTIVE_ASSETS]) {
        // Sanitize inputs: drop update if any return value is non-finite (NaN/Inf)
        for &ret in new_returns.iter() {
            if !ret.is_finite() {
                return;
            }
        }

        let current = self.snapshot.load();
        let mut next = (**current).clone();

        next.sample_count += 1;
        let alpha = self.decay_alpha;
        let one_minus_alpha = 1.0 - alpha;

        // 1. Update Exponentially Weighted Means
        let mut diffs = [0.0; MAX_ACTIVE_ASSETS];
        for i in 0..MAX_ACTIVE_ASSETS {
            let ret = new_returns[i];
            diffs[i] = ret - next.means[i];
            next.means[i] += alpha * diffs[i];
        }

        // 2. Update Exponentially Weighted Covariance Matrix
        for i in 0..MAX_ACTIVE_ASSETS {
            for j in 0..MAX_ACTIVE_ASSETS {
                let prev_cov = next.covariance_matrix[i][j];
                let incremental_cov = diffs[i] * diffs[j];
                let updated_cov = one_minus_alpha * prev_cov + alpha * incremental_cov;
                next.covariance_matrix[i][j] = updated_cov;
            }
        }

        // 3. Extract Variances and Derive Correlation Matrix
        for i in 0..MAX_ACTIVE_ASSETS {
            let var = next.covariance_matrix[i][i].max(1e-8);
            next.variances[i] = var;
        }

        for i in 0..MAX_ACTIVE_ASSETS {
            let std_i = next.variances[i].sqrt();
            for j in 0..MAX_ACTIVE_ASSETS {
                if i == j {
                    next.correlation_matrix[i][j] = 1.0;
                } else {
                    let std_j = next.variances[j].sqrt();
                    let denom = (std_i * std_j).max(1e-8);
                    let corr = (next.covariance_matrix[i][j] / denom).clamp(-1.0, 1.0);
                    next.correlation_matrix[i][j] = corr;
                }
            }
        }

        self.snapshot.store(Arc::new(next));
    }

    /// Single asset return update for asset_index 0..9
    pub fn update_single_asset_return(&self, asset_index: usize, return_val: f64) {
        if asset_index >= MAX_ACTIVE_ASSETS || !return_val.is_finite() {
            return;
        }
        let current = self.snapshot.load();
        let mut returns = current.means;
        returns[asset_index] = return_val;
        self.update_returns(&returns);
    }

    /// Calculate asset correlation risk penalty score:
    /// CorrelationRisk_i = (1 / (K - 1)) * sum_{j != i} |rho_{ij}|
    pub fn get_correlation_risk(&self, asset_index: usize) -> f64 {
        if asset_index >= MAX_ACTIVE_ASSETS {
            return 0.0;
        }
        let snap = self.snapshot.load();
        let mut sum_corr = 0.0;
        for j in 0..MAX_ACTIVE_ASSETS {
            if j != asset_index {
                sum_corr += snap.correlation_matrix[asset_index][j].abs();
            }
        }
        sum_corr / ((MAX_ACTIVE_ASSETS - 1) as f64)
    }

    /// Calculates Covariance-Adjusted Dynamic Fractional Kelly (CC-DFK) position size.
    pub fn calculate_cc_dfk_size(
        &self,
        asset_index: usize,
        expected_return: f64,
        gk_volatility: f64,
        bid_ask_spread_bp: f64,
        account_balance: f64,
        current_price: f64,
        active_weights: &[f64],
    ) -> KellyPositionSize {
        if asset_index >= active_weights.len()
            || !account_balance.is_finite()
            || account_balance <= 0.0
            || !current_price.is_finite()
            || current_price <= 0.0
            || !expected_return.is_finite()
            || !gk_volatility.is_finite()
            || gk_volatility <= 0.0
            || !bid_ask_spread_bp.is_finite()
            || bid_ask_spread_bp < 0.0
        {
            return KellyPositionSize {
                asset_index,
                fraction: 0.0,
                notional_usd: 0.0,
                contract_quantity: 0.0,
                slippage_penalty: 0.0,
                correlation_penalty: 0.0,
                is_approved: false,
                rejection_reason: Some("Invalid non-finite or out-of-bounds input parameters".to_string()),
            };
        }

        for &w in active_weights.iter() {
            if !w.is_finite() {
                return KellyPositionSize {
                    asset_index,
                    fraction: 0.0,
                    notional_usd: 0.0,
                    contract_quantity: 0.0,
                    slippage_penalty: 0.0,
                    correlation_penalty: 0.0,
                    is_approved: false,
                    rejection_reason: Some("Non-finite weight parameter encountered".to_string()),
                };
            }
        }

        let snap = self.snapshot.load();
        let var_i = (gk_volatility * gk_volatility).max(1e-6);

        // 1. Calculate Correlation Penalty Factor: (1 + sum_{j != i} rho_{ij} * (w_j / w_i))
        let current_w_i = active_weights[asset_index].max(0.01);
        let mut cross_corr_sum = 0.0;
        let num_assets = active_weights.len();
        for j in 0..num_assets {
            if j != asset_index {
                let rho_ij = if asset_index < MAX_ACTIVE_ASSETS && j < MAX_ACTIVE_ASSETS {
                    snap.correlation_matrix[asset_index][j]
                } else {
                    0.0
                };
                let w_j = active_weights[j];
                cross_corr_sum += rho_ij * (w_j / current_w_i);
            }
        }
        let correlation_penalty = (1.0 + cross_corr_sum).max(0.5);

        // 2. Calculate Slippage Penalty: (1 + Spread_bp / 5.0)
        let slippage_penalty = 1.0 + (bid_ask_spread_bp / 5.0).max(0.0);

        // 3. Raw Kelly Fraction: (mu_i - r_f) / (sigma_i^2 * correlation_penalty)
        // Assume risk-free rate r_f = 0 for high-frequency intraday horizon
        let raw_kelly = expected_return / (var_i * correlation_penalty);

        // 4. Apply Fractional Kelly Safety Factor (15%) and Slippage Adjustment
        let fractional_kelly = KELLY_FRACTIONAL_FACTOR * (raw_kelly / slippage_penalty);

        // 5. Cap single asset fraction to MAX_SINGLE_ASSET_FRACTION (50%)
        let clamped_fraction = fractional_kelly.clamp(0.0, MAX_SINGLE_ASSET_FRACTION);

        // 6. Check Global Portfolio Exposure Limit (Cap at 3.0x total balance)
        let mut total_portfolio_weight: f64 = active_weights.iter().sum();
        total_portfolio_weight = total_portfolio_weight - active_weights[asset_index] + clamped_fraction;

        if total_portfolio_weight > self.limits.max_portfolio_leverage {
            let allowable_fraction = (self.limits.max_portfolio_leverage - (total_portfolio_weight - clamped_fraction)).max(0.0);
            let notional = allowable_fraction * account_balance;
            let qty = notional / current_price;
            return KellyPositionSize {
                asset_index,
                fraction: allowable_fraction,
                notional_usd: notional,
                contract_quantity: qty,
                slippage_penalty,
                correlation_penalty,
                is_approved: allowable_fraction > 0.001,
                rejection_reason: Some(format!(
                    "Portfolio gross leverage cap ({:.1}x) reached. Scaled fraction to {:.4}",
                    self.limits.max_portfolio_leverage, allowable_fraction
                )),
            };
        }

        let notional = clamped_fraction * account_balance;
        let qty = notional / current_price;

        KellyPositionSize {
            asset_index,
            fraction: clamped_fraction,
            notional_usd: notional,
            contract_quantity: qty,
            slippage_penalty,
            correlation_penalty,
            is_approved: clamped_fraction > 0.001,
            rejection_reason: None,
        }
    }

    /// Calculate dynamic volatility-adjusted Stop-Loss and Take-Profit collars.
    pub fn calculate_dynamic_collars(
        &self,
        entry_price: f64,
        gk_volatility: f64,
        is_long: bool,
    ) -> (f64, f64) {
        if !entry_price.is_finite() || entry_price <= 0.0 || !gk_volatility.is_finite() || gk_volatility <= 0.0 {
            return (0.0, 0.0);
        }

        let sl_pct = (1.5 * gk_volatility).clamp(0.005, 0.05); // 0.5% to 5.0%
        let tp_pct = (3.0 * gk_volatility).clamp(0.010, 0.10); // 1.0% to 10.0%

        if is_long {
            let sl = entry_price * (1.0 - sl_pct);
            let tp = entry_price * (1.0 + tp_pct);
            (sl, tp)
        } else {
            let sl = entry_price * (1.0 + sl_pct);
            let tp = entry_price * (1.0 - tp_pct);
            (sl, tp)
        }
    }

    pub fn verify_pretrade_risk(
        &self,
        notional_usd: f64,
        current_drawdown: f64,
        current_exposure: f64,
    ) -> bool {
        if notional_usd <= 0.0 || !notional_usd.is_finite() {
            return false;
        }
        if current_drawdown > self.limits.max_drawdown_limit_pct {
            return false;
        }
        if current_exposure + notional_usd > 100_000.0 {
            return false;
        }
        true
    }
}

// Implement ArcSwap from_utf8_or_panic replacement helper: ArcSwap::new
impl CovarianceRiskGuard {
    pub fn new_arc(limits: Option<PortfolioRiskLimits>, decay_alpha: Option<f64>) -> Self {
        Self {
            limits: limits.unwrap_or_default(),
            snapshot: ArcSwap::new(Arc::new(CovarianceSnapshot::default())),
            decay_alpha: decay_alpha.unwrap_or(DEFAULT_DECAY_ALPHA).clamp(0.001, 0.5),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_covariance_matrix_updates() {
        let guard = CovarianceRiskGuard::new_arc(None, Some(0.1));
        
        let returns1 = [0.01, -0.01, 0.02, 0.005, -0.005, 0.01, 0.0, 0.002, -0.001, 0.003];
        let returns2 = [0.02, -0.02, 0.03, 0.010, -0.010, 0.02, 0.0, 0.004, -0.002, 0.006];

        guard.update_returns(&returns1);
        guard.update_returns(&returns2);

        let snap = guard.snapshot();
        assert_eq!(snap.sample_count, 2);
        assert!(snap.correlation_matrix[0][1] < 0.0, "Assets 0 and 1 should have negative correlation");
        assert!(snap.correlation_matrix[0][2] > 0.0, "Assets 0 and 2 should have positive correlation");
    }

    #[test]
    fn test_cc_dfk_position_sizing() {
        let guard = CovarianceRiskGuard::new_arc(None, None);
        let active_weights = [0.0; MAX_ACTIVE_ASSETS];
        
        let sizing = guard.calculate_cc_dfk_size(
            0,
            0.005,  // 0.5% expected return
            0.015,  // 1.5% GK Volatility
            2.0,    // 2.0 bps spread
            100_000.0, // $100,000 balance
            100.0,     // $100 entry price
            &active_weights,
        );

        assert!(sizing.is_approved);
        assert!(sizing.fraction > 0.0 && sizing.fraction <= MAX_SINGLE_ASSET_FRACTION);
        assert!(sizing.notional_usd > 0.0);
        assert!(sizing.contract_quantity > 0.0);
    }

    #[test]
    fn test_dynamic_collars() {
        let guard = CovarianceRiskGuard::new_arc(None, None);
        let (sl, tp) = guard.calculate_dynamic_collars(100.0, 0.02, true);
        assert!(sl < 100.0);
        assert!(tp > 100.0);
        assert!((100.0 - sl) > 0.0);
        assert!((tp - 100.0) > (100.0 - sl)); // Risk/reward >= 2.0
    }

    #[test]
    fn test_nan_sanitization() {
        let guard = CovarianceRiskGuard::new_arc(None, None);

        // 1. Non-finite return update should be dropped without state poisoning
        let nan_returns = [f64::NAN, 0.01, 0.02, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        guard.update_returns(&nan_returns);
        assert_eq!(guard.snapshot().sample_count, 0, "NaN return update must be dropped");

        guard.update_single_asset_return(0, f64::INFINITY);
        assert_eq!(guard.snapshot().sample_count, 0, "Infinity return update must be dropped");

        // 2. Non-finite CC-DFK sizing inputs should return rejected position size
        let active_weights = [0.0; MAX_ACTIVE_ASSETS];
        let sizing_nan = guard.calculate_cc_dfk_size(
            0,
            f64::NAN,
            0.015,
            2.0,
            100_000.0,
            100.0,
            &active_weights,
        );
        assert!(!sizing_nan.is_approved);
        assert_eq!(sizing_nan.fraction, 0.0);

        let sizing_inf_vol = guard.calculate_cc_dfk_size(
            0,
            0.005,
            f64::INFINITY,
            2.0,
            100_000.0,
            100.0,
            &active_weights,
        );
        assert!(!sizing_inf_vol.is_approved);
        assert_eq!(sizing_inf_vol.fraction, 0.0);
    }
}
