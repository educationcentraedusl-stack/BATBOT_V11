use std::collections::VecDeque;
use crate::ipc::shared_memory::AtomicSharedMemoryBridge;

pub const DEFAULT_IC_WINDOW_SIZE: usize = 1000;
pub const MODEL_DRIFT_THRESHOLD: f64 = 0.03;
pub const MIN_SAMPLES_FOR_DRIFT: usize = 30;

#[derive(Debug, Clone)]
pub struct ICTracker {
    window_size: usize,
    pairs: VecDeque<(f64, f64)>,
    current_ic: f64,
    is_drifted: bool,
}

impl ICTracker {
    pub fn new(window_size: usize) -> Self {
        Self {
            window_size,
            pairs: VecDeque::with_capacity(window_size),
            current_ic: 0.0,
            is_drifted: false,
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
        if self.pairs.len() >= self.window_size {
            self.pairs.pop_front();
        }
        self.pairs.push_back((prediction, realized_return));

        let ic = self.compute_spearman_ic();
        self.current_ic = ic;

        if self.pairs.len() >= MIN_SAMPLES_FOR_DRIFT && ic < MODEL_DRIFT_THRESHOLD {
            if !self.is_drifted {
                self.is_drifted = true;
                eprintln!(
                    "[BATBOT_V11][IC Tracker WARNING] MODEL_DRIFT detected! Rolling Spearman IC: {:.4} < {:.4} threshold over {} pairs.",
                    ic, MODEL_DRIFT_THRESHOLD, self.pairs.len()
                );
            }
        } else {
            self.is_drifted = false;
        }

        if let Some(bridge) = sab {
            bridge.store_f64(101, ic);
            bridge.store_f64(102, if self.is_drifted { 1.0 } else { 0.0 });
        }

        ic
    }

    pub fn reset(&mut self) {
        self.pairs.clear();
        self.current_ic = 0.0;
        self.is_drifted = false;
    }

    pub fn current_ic(&self) -> f64 {
        self.current_ic
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
