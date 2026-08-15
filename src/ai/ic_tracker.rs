use std::collections::VecDeque;
use crate::ipc::shared_memory::AtomicSharedMemoryBridge;

pub const DEFAULT_IC_WINDOW_SIZE: usize = 1000;
pub const MODEL_DRIFT_FLOOR: f64 = 0.0100;
pub const MIN_SAMPLES_FOR_DRIFT: usize = 100;

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
    min_samples_for_drift: usize,
}

impl ICTracker {
    pub fn new(window_size: usize) -> Self {
        let min_samples_for_drift = if window_size <= 100 { 30 } else { MIN_SAMPLES_FOR_DRIFT };
        Self {
            window_size,
            pairs: VecDeque::with_capacity(window_size),
            current_ic: 0.0,
            ewma_ic: 0.0,
            ewma_var: 0.0,
            adaptive_threshold: MODEL_DRIFT_FLOOR,
            is_drifted: false,
            alpha: 0.05,
            min_samples_for_drift,
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

    /// Add an observation and write IC to the correct per-asset SAB slot.
    /// For the global (asset_idx=0) tracker, slot 101/102 is written.
    /// For per-asset trackers (asset_idx>0), the same relative slot 101/102 is written
    /// into that asset's SAB region via store_f64_asset.
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

        // Update EWMA mean & variance of IC for volatility-adjusted dynamic thresholding
        if self.pairs.len() >= 10 {
            if self.ewma_ic == 0.0 && self.ewma_var == 0.0 {
                self.ewma_ic = ic;
                self.ewma_var = 0.0025; // Baseline variance initial estimate
            } else {
                let delta = ic - self.ewma_ic;
                self.ewma_ic += self.alpha * delta;
                self.ewma_var = (1.0 - self.alpha) * (self.ewma_var + self.alpha * delta * delta);
            }
        }

        let std_dev = self.ewma_var.sqrt();
        // Dynamic thresholding: EWMA - 2.0 * std_dev, bounded between 0.0100 and 0.0500
        let dynamic_thresh = (self.ewma_ic - 2.0 * std_dev).clamp(MODEL_DRIFT_FLOOR, 0.0500);
        self.adaptive_threshold = dynamic_thresh;

        // Adaptive drift trigger condition:
        // Requires at least min_samples_for_drift (100) observations
        // and IC falling below the dynamic threshold AND below absolute floor 0.0200
        if self.pairs.len() >= self.min_samples_for_drift && ic < dynamic_thresh && ic < 0.0200 {
            if !self.is_drifted {
                self.is_drifted = true;
                eprintln!(
                    "[BATBOT_V11][IC Tracker ADAPTIVE DRIFT] Dynamic IC Threshold breached! IC: {:.4} < Dynamic Threshold: {:.4} (EWMA: {:.4}, Std: {:.4}) over {} pairs.",
                    ic, dynamic_thresh, self.ewma_ic, std_dev, self.pairs.len()
                );
            }
        } else if ic >= dynamic_thresh + 0.03 || ic >= 0.0500 {
            self.is_drifted = false;
        }

        // CRITICAL FIX (BUG-2b): Use per-asset store_f64_asset so multi-asset inference
        // for asset_idx > 0 does NOT corrupt asset-0's SAB slots 101/102.
        // The global IC displayed in the telemetry reads from asset_idx=0, slot 101.
        if let Some(bridge) = sab {
            bridge.store_f64_asset(asset_idx, 101, ic);
            bridge.store_f64_asset(asset_idx, 102, if self.is_drifted { 1.0 } else { 0.0 });
        }

        ic
    }

    pub fn reset(&mut self) {
        self.pairs.clear();
        self.current_ic = 0.0;
        self.ewma_ic = 0.0;
        self.ewma_var = 0.0;
        self.adaptive_threshold = MODEL_DRIFT_FLOOR;
        self.is_drifted = false;
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
        // Average rank for ties (1-based index sum)
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
        let mut tracker = ICTracker::new(100);
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
        let mut tracker = ICTracker::new(100);
        for i in 1..=50 {
            let val = i as f64;
            tracker.add_observation(val, -val, None);
        }
        let ic = tracker.current_ic();
        assert!((ic - (-1.0)).abs() < 1e-4, "Expected IC ~ -1.0, got {}", ic);
        assert!(tracker.is_drifted());
    }

    #[test]
    fn test_rolling_window_capacity() {
        let mut tracker = ICTracker::new(10);
        for i in 1..=20 {
            tracker.add_observation(i as f64, i as f64, None);
        }
        assert_eq!(tracker.len(), 10);
    }

    #[test]
    fn test_sab_slot_101_write() {
        let mut buffer = vec![0u8; 2048];
        let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len()).unwrap();
        let mut tracker = ICTracker::new(100);

        for i in 1..=50 {
            tracker.add_observation(i as f64, i as f64, Some(&bridge));
        }

        let sab_ic = bridge.load_f64(101);
        let sab_drift = bridge.load_f64(102);
        assert!((sab_ic - 1.0).abs() < 1e-4, "SAB slot 101 expected ~ 1.0, got {}", sab_ic);
        assert_eq!(sab_drift, 0.0);
    }

    #[test]
    fn test_ic_tracker_reset_and_drift_slot() {
        let mut buffer = vec![0u8; 2048];
        let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len()).unwrap();
        let mut tracker = ICTracker::new(100);

        for i in 1..=50 {
            tracker.add_observation(i as f64, - (i as f64), Some(&bridge));
        }

        assert!(tracker.is_drifted());
        assert_eq!(bridge.load_f64(102), 1.0);

        tracker.reset();
        assert!(!tracker.is_drifted());
        assert_eq!(tracker.len(), 0);
        assert_eq!(tracker.current_ic(), 0.0);
    }
}
