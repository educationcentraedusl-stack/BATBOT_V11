use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AltcoinMetrics {
    pub symbol: String,
    pub high: f64,
    pub low: f64,
    pub open: f64,
    pub close: f64,
    pub volume_usd_5m: f64,
    pub best_bid: f64,
    pub best_ask: f64,
    pub price_change_5m: f64,
    pub volume_5m: f64,
    pub correlation_risk: f64,
}

impl AltcoinMetrics {
    pub fn new(symbol: &str) -> Self {
        Self {
            symbol: symbol.to_uppercase(),
            high: 0.0,
            low: 0.0,
            open: 0.0,
            close: 0.0,
            volume_usd_5m: 0.0,
            best_bid: 0.0,
            best_ask: 0.0,
            price_change_5m: 0.0,
            volume_5m: 0.0,
            correlation_risk: 0.0,
        }
    }
}

/// Calculates Garman-Klass Volatility σ_GK:
/// σ_GK = √( max(0, 0.5 * (ln(H / L))^2 - (2*ln(2) - 1) * (ln(C / O))^2 ) )
pub fn calculate_garman_klass_volatility(high: f64, low: f64, open: f64, close: f64) -> f64 {
    if high <= 0.0 || low <= 0.0 || open <= 0.0 || close <= 0.0 || high < low {
        return 0.0;
    }
    let hl_ratio = (high / low.max(1e-8)).max(1.0);
    let co_ratio = (close / open.max(1e-8)).max(1e-8);
    let hl_log = hl_ratio.ln();
    let co_log = co_ratio.ln();
    let const_factor = 2.0 * 2.0f64.ln() - 1.0; // ≈ 0.38629436
    let var = 0.5 * hl_log * hl_log - const_factor * co_log * co_log;
    var.max(0.0).sqrt()
}

/// Calculates Bid-Ask Spread in Basis Points (Spread_bp):
/// Spread_bp = (P_ask - P_bid) / P_mid * 10,000
pub fn calculate_spread_bp(best_bid: f64, best_ask: f64) -> f64 {
    if best_bid <= 0.0 || best_ask <= 0.0 || best_ask < best_bid {
        return 10.0; // Safe default spread floor in basis points
    }
    let mid = (best_bid + best_ask) * 0.5;
    if mid <= 0.0 {
        return 10.0;
    }
    let spread_bp = ((best_ask - best_bid) / mid) * 10_000.0;
    spread_bp.max(0.1) // Floor at 0.1 bp to prevent division by zero
}

/// Calculates Kyle's Lambda market impact coefficient (λ_Kyle):
/// λ_Kyle = |ΔP_5m| / √(Volume_5m + 1e-8)
pub fn calculate_kyle_lambda(price_change_5m: f64, volume_5m: f64) -> f64 {
    let abs_p_change = price_change_5m.abs();
    let vol_sqrt = (volume_5m.max(0.0) + 1e-8).sqrt();
    (abs_p_change / vol_sqrt).max(0.0)
}

/// Calculates Cross-Sectional Liquidity & Volatility Score S_{i,t}:
/// S_{i,t} = (σ_GK * ln(V_USD)) / (Spread_bp * (1 + λ_Kyle) * (1 + CorrelationRisk))
pub fn calculate_cs_lvr_score(metrics: &AltcoinMetrics) -> f64 {
    let sigma_gk = calculate_garman_klass_volatility(
        metrics.high,
        metrics.low,
        metrics.open,
        metrics.close,
    );

    let v_usd = metrics.volume_usd_5m.max(1.0);
    let ln_v_usd = v_usd.ln().max(0.001);

    let spread_bp = calculate_spread_bp(metrics.best_bid, metrics.best_ask);
    let lambda_kyle = calculate_kyle_lambda(metrics.price_change_5m, metrics.volume_5m);
    let corr_risk = metrics.correlation_risk.max(0.0);

    let denominator = spread_bp * (1.0 + lambda_kyle) * (1.0 + corr_risk);
    if denominator <= 0.0 || !denominator.is_finite() {
        return 0.0;
    }

    let score = (sigma_gk * ln_v_usd) / denominator;
    if score.is_nan() || score.is_infinite() || score < 0.0 {
        0.0
    } else {
        score
    }
}

pub struct UniverseScanner {
    max_active_assets: usize,
    metrics_map: HashMap<String, AltcoinMetrics>,
    ranked_scores: Vec<(String, f64)>,
}

impl UniverseScanner {
    pub fn new(max_active_assets: usize) -> Self {
        let env_max: usize = std::env::var("MAX_CONCURRENT_ASSETS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(max_active_assets);

        Self {
            max_active_assets: env_max.max(1),
            metrics_map: HashMap::new(),
            ranked_scores: Vec::new(),
        }
    }

    pub fn max_active_assets(&self) -> usize {
        self.max_active_assets
    }

    pub fn update_ticker(
        &mut self,
        symbol: &str,
        high: f64,
        low: f64,
        open: f64,
        close: f64,
        volume_usd_5m: f64,
        best_bid: f64,
        best_ask: f64,
        price_change_5m: f64,
        volume_5m: f64,
        correlation_risk: f64,
    ) {
        let entry = self
            .metrics_map
            .entry(symbol.to_uppercase())
            .or_insert_with(|| AltcoinMetrics::new(symbol));

        entry.high = high;
        entry.low = low;
        entry.open = open;
        entry.close = close;
        entry.volume_usd_5m = volume_usd_5m;
        entry.best_bid = best_bid;
        entry.best_ask = best_ask;
        entry.price_change_5m = price_change_5m;
        entry.volume_5m = volume_5m;
        entry.correlation_risk = correlation_risk;
    }

    /// Ranks all registered symbols in O(N log N) using CS-LVR score S_{i,t} in descending order.
    pub fn rank_universe(&mut self) -> Vec<(String, f64)> {
        let mut scores: Vec<(String, f64)> = self
            .metrics_map
            .iter()
            .map(|(sym, metrics)| {
                let score = calculate_cs_lvr_score(metrics);
                (sym.clone(), score)
            })
            .collect();

        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        self.ranked_scores = scores.clone();
        scores
    }

    /// Returns the Top K ranked symbols (up to max_active_assets).
    pub fn get_top_k(&mut self) -> Vec<String> {
        let ranked = self.rank_universe();
        ranked
            .into_iter()
            .take(self.max_active_assets)
            .map(|(sym, _)| sym)
            .collect()
    }

    /// Returns the current ranked scores cache.
    pub fn get_ranked_scores(&self) -> &[(String, f64)] {
        &self.ranked_scores
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_garman_klass_volatility_calculation() {
        let high = 105.0;
        let low = 95.0;
        let open = 100.0;
        let close = 102.0;

        let vol = calculate_garman_klass_volatility(high, low, open, close);
        assert!(vol > 0.0, "Garman-Klass volatility should be positive");
        assert!(vol.is_finite(), "Garman-Klass volatility must be finite");
    }

    #[test]
    fn test_spread_bp_calculation() {
        let bid = 100.0;
        let ask = 100.1;
        let spread_bp = calculate_spread_bp(bid, ask);
        // (0.1 / 100.05) * 10,000 ≈ 9.995 bp
        assert!((spread_bp - 9.995).abs() < 0.1, "Spread in bp should be ~10bp");
    }

    #[test]
    fn test_kyle_lambda_calculation() {
        let delta_p = 2.5;
        let vol = 100.0;
        let lambda = calculate_kyle_lambda(delta_p, vol);
        assert!((lambda - 0.25).abs() < 1e-6, "Kyle lambda should be ~0.25");
    }

    #[test]
    fn test_cs_lvr_score_ranking_purity() {
        let mut scanner = UniverseScanner::new(3);

        // Asset A: High vol, tight spread, high volume -> High Score
        scanner.update_ticker("ASSET_A", 110.0, 90.0, 100.0, 105.0, 10_000_000.0, 104.9, 105.0, 1.0, 1000.0, 0.0);

        // Asset B: Low vol, wide spread -> Low Score
        scanner.update_ticker("ASSET_B", 101.0, 99.9, 100.0, 100.1, 100_000.0, 99.0, 101.0, 0.1, 10.0, 0.0);

        let top_k = scanner.get_top_k();
        assert_eq!(top_k.len(), 2);
        assert_eq!(top_k[0], "ASSET_A", "ASSET_A should be ranked #1 due to higher CS-LVR score");
    }

    #[test]
    fn test_defensive_zero_division_safety() {
        let mut metrics = AltcoinMetrics::new("SAFE");
        metrics.high = 0.0;
        metrics.low = 0.0;
        metrics.best_bid = 0.0;
        metrics.best_ask = 0.0;

        let score = calculate_cs_lvr_score(&metrics);
        assert_eq!(score, 0.0, "Invalid/zero inputs must result in 0.0 score without panic");
    }
}
