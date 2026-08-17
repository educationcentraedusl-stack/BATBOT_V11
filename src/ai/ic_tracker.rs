use std::collections::VecDeque;
use crate::ipc::shared_memory::AtomicSharedMemoryBridge;

pub const DEFAULT_IC_WINDOW_SIZE: usize = 1000;
pub const MODEL_DRIFT_FLOOR: f64 = 0.0100;
pub const MIN_SAMPLES_FOR_DRIFT: usize = 100;
pub const DEFAULT_RECALIB_COOLDOWN_NS: u64 = 1500_000_000_000; // 25 minutes cooldown floor (strictly 1-2x/hour)

/// Page's Cumulative Sum (CUSUM) Structural Break Detector for Predictive Alphas.
/// Monitors cumulative squared residual errors: S_t = max(0, S_{t-1} + (z_t^2 - 1.0 - \kappa)).
/// Triggers drift alert when S_t >= h_drift and mandatory cooldown floor has elapsed.
#[derive(Debug, Clone)]
pub struct CusumDriftDetector {
    pub s_pos: f64,
    pub s_neg: f64,
    pub kappa: f64,
    pub threshold: f64,
    pub residual_mean: f64,
    pub residual_var: f64,
    pub sample_count: usize,
    pub is_drifted: bool,
    pub last_recalib_ts_ns: u64,
    pub cooldown_ns: u64,
}

impl CusumDriftDetector {
    pub fn new(threshold: f64, kappa: f64, cooldown_ns: u64) -> Self {
        Self {
            s_pos: 0.0,
            s_neg: 0.0,
            kappa,
            threshold,
            residual_mean: 0.0,
            residual_var: 0.0001,
            sample_count: 0,
            is_drifted: false,
            last_recalib_ts_ns: 0,
            cooldown_ns,
        }
    }

    pub fn default_hft() -> Self {
        Self::new(8.0, 0.50, DEFAULT_RECALIB_COOLDOWN_NS)
    }

    /// Updates CUSUM statistics with a new prediction residual e = y_realized - y_pred.
    /// Returns true if a structural break is confirmed and cooldown has elapsed.
    pub fn update(&mut self, residual: f64, current_ts_ns: u64) -> bool {
        self.sample_count += 1;

        // Online Welford update of residual mean and variance
        let delta = residual - self.residual_mean;
        self.residual_mean += delta / (self.sample_count as f64);
        let delta2 = residual - self.residual_mean;
        self.residual_var += delta * delta2;

        let var = if self.sample_count > 1 {
            self.residual_var / ((self.sample_count - 1) as f64)
        } else {
            0.0001
        };
        let std_dev = var.sqrt().max(1e-6);

        // Standardized residual score
        let z = (residual - self.residual_mean) / std_dev;
        let z_sq = z * z;

        // CUSUM Accumulator on standardized variance shift:
        // E[z^2] = 1 under H0. Score term is (z^2 - 1.0 - kappa).
        let term = z_sq - 1.0 - self.kappa;
        self.s_pos = (self.s_pos + term).max(0.0);

        // Cooldown enforcement: must be at least cooldown_ns since last recalibration
        let is_cooldown_satisfied = self.last_recalib_ts_ns == 0
            || current_ts_ns >= self.last_recalib_ts_ns + self.cooldown_ns;

        if self.sample_count >= 20 && self.s_pos >= self.threshold && is_cooldown_satisfied {
            self.is_drifted = true;
        } else if self.s_pos < self.threshold * 0.3 {
            self.is_drifted = false;
        }

        self.is_drifted
    }

    pub fn record_recalibration(&mut self, ts_ns: u64) {
        self.last_recalib_ts_ns = ts_ns;
        self.s_pos = 0.0;
        self.s_neg = 0.0;
        self.is_drifted = false;
    }

    pub fn reset(&mut self) {
        self.s_pos = 0.0;
        self.s_neg = 0.0;
        self.residual_mean = 0.0;
        self.residual_var = 0.0001;
        self.sample_count = 0;
        self.is_drifted = false;
    }
}

#[derive(Debug, Clone)]
pub struct ICTracker {
    window_size: usize,
    pairs: VecDeque<(f64, f64)>,
    current_ic: f64,
    ewma_ic: f64,
    ewma_var: f64,
    adaptive_threshold: f64,
    is_drifted: bool,
    alpha: f64,
    pub cusum: CusumDriftDetector,
}

impl ICTracker {
    pub fn new(window_size: usize) -> Self {
        Self {
            window_size,
            pairs: VecDeque::with_capacity(window_size),
            current_ic: 0.0,
            ewma_ic: 0.0,
            ewma_var: 0.0,
            adaptive_threshold: MODEL_DRIFT_FLOOR,
            is_drifted: false,
            alpha: 0.05,
            cusum: CusumDriftDetector::default_hft(),
        }
    }

    pub fn default_1000() -> Self {
        Self::new(DEFAULT_IC_WINDOW_SIZE)
    }

    pub fn add_observation(
        &mut self,
        prediction: f64,
        realized_return: f64,
        sab: Option<&AtomicSharedMemoryBridge>,
    ) -> f64 {
        self.add_observation_asset(prediction, realized_return, sab, 0)
    }

    /// Add an observation and write IC/drift status to SAB slots 101/102.
    pub fn add_observation_asset(
        &mut self,
        prediction: f64,
        realized_return: f64,
        sab: Option<&AtomicSharedMemoryBridge>,
        asset_idx: usize,
    ) -> f64 {
        if self.pairs.len() >= self.window_size {
            self.pairs.pop_front();
        }
        self.pairs.push_back((prediction, realized_return));

        let ic = self.compute_spearman_ic();
        self.current_ic = ic;

        // Warm-up grace period
        if self.pairs.len() < self.window_size {
            self.is_drifted = false;
            if let Some(bridge) = sab {
                bridge.store_f64_asset(asset_idx, 101, ic);
                bridge.store_f64_asset(asset_idx, 102, 0.0);
                if asset_idx != 0 {
                    bridge.store_f64_asset(0, 101, ic);
                    bridge.store_f64_asset(0, 102, 0.0);
                }
            }
            return ic;
        }

        // EWMA update
        if self.ewma_ic == 0.0 && self.ewma_var == 0.0 {
            self.ewma_ic = ic;
            self.ewma_var = 0.0025;
        } else {
            let delta = ic - self.ewma_ic;
            self.ewma_ic += self.alpha * delta;
            self.ewma_var = (1.0 - self.alpha) * (self.ewma_var + self.alpha * delta * delta);
        }

        let std_dev = self.ewma_var.sqrt();
        let dynamic_thresh = (self.ewma_ic - 2.0 * std_dev).clamp(MODEL_DRIFT_FLOOR, 0.0500);
        self.adaptive_threshold = dynamic_thresh;

        // Combined Drift Evaluation: Spearman threshold or CUSUM structural break
        let cusum_drift = self.cusum.is_drifted;
        let spearman_drift = ic < dynamic_thresh && ic < 0.0200;

        if spearman_drift || cusum_drift {
            if !self.is_drifted {
                self.is_drifted = true;
                eprintln!(
                    "[BATBOT_V11][IC Tracker DRIFT] Alert! IC: {:.4} (Thresh: {:.4}), CUSUM: {}, Samples: {}",
                    ic, dynamic_thresh, cusum_drift, self.pairs.len()
                );
            }
        } else if ic >= dynamic_thresh + 0.03 || ic >= 0.0500 {
            self.is_drifted = false;
        }

        // Broadcast to SAB slots 101 and 102
        if let Some(bridge) = sab {
            bridge.store_f64_asset(asset_idx, 101, ic);
            bridge.store_f64_asset(asset_idx, 102, if self.is_drifted { 1.0 } else { 0.0 });
            if asset_idx != 0 {
                bridge.store_f64_asset(0, 101, ic);
                bridge.store_f64_asset(0, 102, if self.is_drifted { 1.0 } else { 0.0 });
            }
        }

        ic
    }

    /// Evaluates multi-minute residual and updates CUSUM structural break detector.
    pub fn update_cusum_residual(&mut self, residual: f64, current_ts_ns: u64, sab: Option<&AtomicSharedMemoryBridge>, asset_idx: usize) -> bool {
        let drifted = self.cusum.update(residual, current_ts_ns);
        if drifted {
            self.is_drifted = true;
            if let Some(bridge) = sab {
                bridge.store_f64_asset(asset_idx, 102, 1.0);
                if asset_idx != 0 {
                    bridge.store_f64_asset(0, 102, 1.0);
                }
            }
        }
        drifted
    }

    pub fn record_recalibration(&mut self, ts_ns: u64) {
        self.cusum.record_recalibration(ts_ns);
        self.is_drifted = false;
    }

    pub fn reset(&mut self) {
        self.pairs.clear();
        self.current_ic = 0.0;
        self.ewma_ic = 0.0;
        self.ewma_var = 0.0;
        self.adaptive_threshold = MODEL_DRIFT_FLOOR;
        self.is_drifted = false;
        self.cusum.reset();
    }

    pub fn current_ic(&self) -> f64 {
        self.current_ic
    }

    pub fn ewma_ic(&self) -> f64 {
        self.ewma_ic
    }

    pub fn adaptive_threshold(&self) -> f64 {
        self.adaptive_threshold
    }

    pub fn is_drifted(&self) -> bool {
        self.is_drifted
    }

    pub fn len(&self) -> usize {
        self.pairs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }

    pub fn compute_spearman_ic(&self) -> f64 {
        let n = self.pairs.len();
        if n < 2 {
            return 0.0;
        }

        let x: Vec<f64> = self.pairs.iter().map(|p| p.0).collect();
        let y: Vec<f64> = self.pairs.iter().map(|p| p.1).collect();

        let rx = compute_ranks(&x);
        let ry = compute_ranks(&y);

        compute_pearson_correlation(&rx, &ry)
    }
}

impl Default for ICTracker {
    fn default() -> Self {
        Self::default_1000()
    }
}

fn compute_ranks(values: &[f64]) -> Vec<f64> {
    let n = values.len();
    if n == 0 {
        return Vec::new();
    }

    let mut indices: Vec<usize> = (0..n).collect();
    indices.sort_by(|&a, &b| {
        values[a]
            .partial_cmp(&values[b])
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut ranks = vec![0.0f64; n];
    let mut i = 0;

    while i < n {
        let mut j = i + 1;
        while j < n && (values[indices[j]] - values[indices[i]]).abs() < 1e-12 {
            j += 1;
        }
        let rank_sum: f64 = ((i + 1)..=j).map(|r| r as f64).sum();
        let avg_rank = rank_sum / (j - i) as f64;

        for k in i..j {
            ranks[indices[k]] = avg_rank;
        }
        i = j;
    }

    ranks
}

fn compute_pearson_correlation(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len();
    if n < 2 {
        return 0.0;
    }

    let mean_x = x.iter().sum::<f64>() / n as f64;
    let mean_y = y.iter().sum::<f64>() / n as f64;

    let mut cov = 0.0f64;
    let mut var_x = 0.0f64;
    let mut var_y = 0.0f64;

    for i in 0..n {
        let dx = x[i] - mean_x;
        let dy = y[i] - mean_y;
        cov += dx * dy;
        var_x += dx * dx;
        var_y += dy * dy;
    }

    if var_x < 1e-12 || var_y < 1e-12 {
        0.0
    } else {
        (cov / (var_x.sqrt() * var_y.sqrt())).clamp(-1.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_perfect_positive_correlation() {
        let mut tracker = ICTracker::new(50);
        for i in 1..=50 {
            let val = i as f64;
            tracker.add_observation(val, val * 2.0, None);
        }
        let ic = tracker.current_ic();
        assert!((ic - 1.0).abs() < 1e-4, "Expected IC ~ 1.0, got {}", ic);
        assert!(!tracker.is_drifted());
    }

    #[test]
    fn test_perfect_negative_correlation() {
        let mut tracker = ICTracker::new(50);
        for i in 1..=50 {
            let val = i as f64;
            tracker.add_observation(val, -val, None);
        }
        let ic = tracker.current_ic();
        assert!((ic - (-1.0)).abs() < 1e-4, "Expected IC ~ -1.0, got {}", ic);
        assert!(tracker.is_drifted());
    }

    #[test]
    fn test_cusum_drift_detection_and_cooldown() {
        let mut detector = CusumDriftDetector::new(5.0, 0.2, 100_000_000); // 100ms cooldown for test
        let ts_base = 1_000_000_000u64;

        // Ingest series of normal residuals
        for i in 0..60 {
            detector.update(0.01 * ((i % 5) as f64), ts_base + i * 1_000_000);
        }
        assert!(!detector.is_drifted, "Normal residuals should not trigger CUSUM drift");

        // Ingest large abnormal residual spike (structural break)
        for i in 60..80 {
            detector.update(10.0, ts_base + i * 1_000_000);
        }
        assert!(detector.is_drifted, "CUSUM should flag structural break on persistent large errors");

        // Record recalibration to reset state
        detector.record_recalibration(ts_base + 90_000_000);
        assert!(!detector.is_drifted);
    }
}
