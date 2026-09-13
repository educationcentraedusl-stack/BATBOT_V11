use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use candle_core::{DType, Device, Error, Result, Tensor};

use crate::ai::cfc::CfCCell;
use crate::ai::ic_tracker::ICTracker;
use crate::ai::kan::TKANLayer;
use crate::ai::mamba::Mamba2Cell;
use crate::ai::weights::{AiEngine, AiEngineStatus};
use crate::ipc::shared_memory::AtomicSharedMemoryBridge;

fn vec_mean(v: &VecDeque<f64>, n: usize) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let count = n.min(v.len());
    let sum: f64 = v.iter().take(count).sum();
    sum / (count as f64)
}

fn vec_std(v: &VecDeque<f64>, n: usize) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let count = n.min(v.len());
    if count <= 1 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut sum_sq = 0.0;
    for &x in v.iter().take(count) {
        sum += x;
        sum_sq += x * x;
    }
    let count_f = count as f64;
    let mean = sum / count_f;
    let variance = (sum_sq / count_f - mean * mean).max(0.0);
    variance.sqrt()
}

/// DEF-R2: Signed Directional Concordance Index (SDCI)
/// Tracks signed z-score deviations for the 6 key microstructure features.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SignedZScores {
    pub obi_z: f64,
    pub cvd_z: f64,
    pub vel_z: f64,
    pub micro_z: f64,
    pub ofi_z: f64,
    pub hawkes_z: f64,
}

impl SignedZScores {
    #[inline(always)]
    pub fn compute_sdci(&self, dir_raw: f64) -> f64 {
        let pred_sign = if dir_raw > 0.0 { 1.0 } else if dir_raw < 0.0 { -1.0 } else { 0.0 };
        // Feature 24 (spread velocity) has INVERTED concordance: negative z (tighter) is bullish
        let spread_sign_flip = -1.0;

        let sdci = 1.0 * pred_sign * self.obi_z.clamp(-3.0, 3.0)
                 + 0.8 * pred_sign * self.cvd_z.clamp(-3.0, 3.0)
                 + 0.5 * pred_sign * spread_sign_flip * self.vel_z.clamp(-3.0, 3.0)
                 + 0.5 * pred_sign * self.micro_z.clamp(-3.0, 3.0)
                 + 0.6 * pred_sign * self.ofi_z.clamp(-3.0, 3.0)
                 + 0.6 * pred_sign * self.hawkes_z.clamp(-3.0, 3.0);

        // Normalize to [0, 1] range: 0 = total discordance, 1 = perfect concordance
        let sdci_norm = ((sdci / 4.0) + 1.0) * 0.5; // 4.0 = sum of weights (1.0 + 0.8 + 0.5 + 0.5 + 0.6 + 0.6)
        sdci_norm.clamp(0.10, 1.50)
    }
}

#[derive(Debug, Clone)]
pub struct StreamingFeaturePipeline {
    mid_prices: VecDeque<f64>,
    log_ret_1_hist: VecDeque<f64>,
    obi_hist: VecDeque<f64>,
    cvd_hist: VecDeque<f64>,
    trade_vel_hist: VecDeque<f64>,
    lat_us_hist: VecDeque<f64>,
    seq_hist: Option<u64>,

    obi_ema_5: Option<f64>,
    obi_ema_10: Option<f64>,
    obi_ema_25: Option<f64>,
    obi_ema_50: Option<f64>,
    obi_ema_100: Option<f64>,
    obi_ema_250: Option<f64>,

    feature_windows: Box<[[f64; 1000]; 40]>,
    feature_heads: [usize; 40],
    feature_lens: [usize; 40],
    feature_means: [f64; 40],
    feature_m2s: [f64; 40],
    pub signed_z_scores: SignedZScores,
}

impl StreamingFeaturePipeline {
    pub fn new() -> Self {
        Self {
            mid_prices: VecDeque::with_capacity(101),
            log_ret_1_hist: VecDeque::with_capacity(100),
            obi_hist: VecDeque::with_capacity(10),
            cvd_hist: VecDeque::with_capacity(101),
            trade_vel_hist: VecDeque::with_capacity(51),
            lat_us_hist: VecDeque::with_capacity(51),
            seq_hist: None,
            obi_ema_5: None,
            obi_ema_10: None,
            obi_ema_25: None,
            obi_ema_50: None,
            obi_ema_100: None,
            obi_ema_250: None,
            feature_windows: Box::new([[0.0f64; 1000]; 40]),
            feature_heads: [0; 40],
            feature_lens: [0; 40],
            feature_means: [0.0; 40],
            feature_m2s: [0.0; 40],
            signed_z_scores: SignedZScores::default(),
        }
    }

    fn update_ema(current: f64, prev_opt: Option<f64>, span: usize) -> f64 {
        let alpha = 2.0 / (span as f64 + 1.0);
        match prev_opt {
            Some(prev) => alpha * current + (1.0 - alpha) * prev,
            None => current,
        }
    }

    pub fn update_and_normalize(
        &mut self,
        sab: &AtomicSharedMemoryBridge,
        lat_us_val: f64,
    ) -> Result<[f64; 40]> {
        self.update_and_normalize_asset(sab, lat_us_val, 0)
    }

    pub fn update_and_normalize_asset(
        &mut self,
        sab: &AtomicSharedMemoryBridge,
        lat_us_val: f64,
        asset_idx: usize,
    ) -> Result<[f64; 40]> {
        self.update_and_normalize_with_snr_asset(sab, lat_us_val, asset_idx).map(|(f, _)| f)
    }

    pub fn update_and_normalize_with_snr(
        &mut self,
        sab: &AtomicSharedMemoryBridge,
        lat_us_val: f64,
    ) -> Result<([f64; 40], SignedZScores)> {
        self.update_and_normalize_with_snr_asset(sab, lat_us_val, 0)
    }

    pub fn update_and_normalize_with_snr_asset(
        &mut self,
        sab: &AtomicSharedMemoryBridge,
        lat_us_val: f64,
        asset_idx: usize,
    ) -> Result<([f64; 40], SignedZScores)> {
        let best_bid = sab.load_f64_asset(asset_idx, 4);
        let best_bid_qty = sab.load_f64_asset(asset_idx, 5);
        let best_ask = sab.load_f64_asset(asset_idx, 6);
        let best_ask_qty = sab.load_f64_asset(asset_idx, 7);

        if best_bid <= 0.0 || best_ask <= 0.0 {
            return Err(Error::Msg("ORDERBOOK_COLLAPSE_DETECTED".to_string()));
        }

        let mid_price = (best_bid + best_ask) / 2.0;
        let spread = best_ask - best_bid;
        let relative_spread = spread / (mid_price + 1e-8);

        let raw_obi = sab.load_f64_asset(asset_idx, 1);
        let obi = if raw_obi == 0.0 && (best_bid_qty + best_ask_qty) > 0.0 {
            (best_bid_qty - best_ask_qty) / (best_bid_qty + best_ask_qty)
        } else {
            raw_obi
        };

        let micro_price = (best_bid * (1.0 - obi) + best_ask * (1.0 + obi)) / 2.0;
        let micro_price_dev = micro_price - mid_price;

        let mid_price_lag1 = *self.mid_prices.get(0).unwrap_or(&mid_price);
        let mid_log_ret_1 = if mid_price_lag1 > 0.0 {
            (mid_price / mid_price_lag1).ln()
        } else {
            0.0
        };

        let mid_price_lag5 = *self.mid_prices.get(4).unwrap_or(&mid_price);
        let mid_log_ret_5 = if mid_price_lag5 > 0.0 {
            (mid_price / mid_price_lag5).ln()
        } else {
            0.0
        };

        let mid_price_lag10 = *self.mid_prices.get(9).unwrap_or(&mid_price);
        let mid_log_ret_10 = if mid_price_lag10 > 0.0 {
            (mid_price / mid_price_lag10).ln()
        } else {
            0.0
        };

        let mid_price_lag50 = *self.mid_prices.get(49).unwrap_or(&mid_price);
        let mid_log_ret_50 = if mid_price_lag50 > 0.0 {
            (mid_price / mid_price_lag50).ln()
        } else {
            0.0
        };

        let mid_price_lag100 = *self.mid_prices.get(99).unwrap_or(&mid_price);
        let mid_log_ret_100 = if mid_price_lag100 > 0.0 {
            (mid_price / mid_price_lag100).ln()
        } else {
            0.0
        };

        let obi_ema_5_val = Self::update_ema(obi, self.obi_ema_5, 5);
        let obi_ema_10_val = Self::update_ema(obi, self.obi_ema_10, 10);
        let obi_ema_25_val = Self::update_ema(obi, self.obi_ema_25, 25);
        let obi_ema_50_val = Self::update_ema(obi, self.obi_ema_50, 50);
        let obi_ema_100_val = Self::update_ema(obi, self.obi_ema_100, 100);
        let obi_ema_250_val = Self::update_ema(obi, self.obi_ema_250, 250);

        self.obi_ema_5 = Some(obi_ema_5_val);
        self.obi_ema_10 = Some(obi_ema_10_val);
        self.obi_ema_25 = Some(obi_ema_25_val);
        self.obi_ema_50 = Some(obi_ema_50_val);
        self.obi_ema_100 = Some(obi_ema_100_val);
        self.obi_ema_250 = Some(obi_ema_250_val);

        let obi_lag1 = *self.obi_hist.get(0).unwrap_or(&obi);
        let obi_vel_1 = obi - obi_lag1;

        let obi_lag5 = *self.obi_hist.get(4).unwrap_or(&obi);
        let obi_vel_5 = (obi - obi_lag5) / 5.0;

        // Ingest SOTA Multi-Level OFI and Bivariate Hawkes Asymmetry from SAB slots 138 and 149
        let multi_level_ofi = sab.load_f64_asset(asset_idx, 138).clamp(-1.0, 1.0);
        let hawkes_asymmetry = sab.load_f64_asset(asset_idx, 149).clamp(-1.0, 1.0);

        let cvd_raw = sab.load_f64_asset(asset_idx, 2);
        let cvd_lag1 = *self.cvd_hist.get(0).unwrap_or(&cvd_raw);
        let cvd_delta_1 = cvd_raw - cvd_lag1;

        let cvd_lag5 = *self.cvd_hist.get(4).unwrap_or(&cvd_raw);
        let cvd_delta_5 = cvd_raw - cvd_lag5;

        let cvd_lag10 = *self.cvd_hist.get(9).unwrap_or(&cvd_raw);
        let cvd_delta_10 = cvd_raw - cvd_lag10;

        let cvd_lag50 = *self.cvd_hist.get(49).unwrap_or(&cvd_raw);
        let cvd_delta_50 = cvd_raw - cvd_lag50;

        let cvd_lag100 = *self.cvd_hist.get(99).unwrap_or(&cvd_raw);
        let cvd_delta_100 = cvd_raw - cvd_lag100;

        // Bounded Tanh Normalization into strictly [-1.0, 1.0]
        let cvd_vel_10 = (cvd_delta_10 * 0.0005).tanh().clamp(-1.0, 1.0);
        let cvd_norm_1 = (cvd_delta_1 * 0.005).tanh().clamp(-1.0, 1.0);
        let cvd_norm_5 = (cvd_delta_5 * 0.001).tanh().clamp(-1.0, 1.0);
        let cvd_norm_10 = cvd_vel_10;
        let cvd_norm_50 = (cvd_delta_50 * 0.0001).tanh().clamp(-1.0, 1.0);
        let cvd_norm_100 = (cvd_delta_100 * 0.00005).tanh().clamp(-1.0, 1.0);

        let trade_vel = sab.load_f64_asset(asset_idx, 3);
        let trade_vel_lag1 = *self.trade_vel_hist.get(0).unwrap_or(&trade_vel);
        let trade_vel_accel = trade_vel - trade_vel_lag1;

        let trade_vel_mean_10 = vec_mean(&self.trade_vel_hist, 10);
        let vpin_proxy_10 = ((cvd_delta_10.abs() / (trade_vel_mean_10 + 1e-5)) * 0.05).tanh().clamp(0.0, 1.0);

        let lat_us = lat_us_val;
        let lat_us_lag1 = *self.lat_us_hist.get(0).unwrap_or(&lat_us);
        let lat_us_mean_50 = vec_mean(&self.lat_us_hist, 50);
        let lat_us_std_50 = vec_std(&self.lat_us_hist, 50);
        let lat_us_jitter = (lat_us - lat_us_lag1).abs();

        let seq_raw = sab.load_u64_asset(asset_idx, 92);
        let seq_gap = match self.seq_hist {
            Some(prev) => ((seq_raw.saturating_sub(prev) as f64) - 1.0).max(0.0).min(100.0),
            None => 0.0,
        };
        let execution_latency_ms = sab.load_f64_asset(asset_idx, 98);

        let vol_realized_10 = vec_std(&self.log_ret_1_hist, 10);
        let vol_realized_50 = vec_std(&self.log_ret_1_hist, 50);
        let vol_realized_100 = vec_std(&self.log_ret_1_hist, 100);
        let vol_parkinson_50 = spread * vol_realized_50;

        let mid_price_lag2 = *self.mid_prices.get(1).unwrap_or(&mid_price);
        let price_acceleration = mid_price - 2.0 * mid_price_lag1 + mid_price_lag2;

        let momentum_direction = if mid_log_ret_10 > 0.0 {
            1.0
        } else if mid_log_ret_10 < 0.0 {
            -1.0
        } else {
            0.0
        };

        let raw_features: [f64; 40] = [
            spread,
            relative_spread,
            micro_price_dev,
            mid_log_ret_1,
            mid_log_ret_5,
            mid_log_ret_10,
            mid_log_ret_50,
            mid_log_ret_100,
            obi,
            obi_ema_5_val,
            obi_ema_10_val,
            obi_ema_25_val,
            obi_ema_50_val,
            obi_ema_100_val,
            obi_ema_250_val,
            obi_vel_1,
            obi_vel_5,
            multi_level_ofi,
            cvd_vel_10,
            cvd_norm_1,
            cvd_norm_5,
            cvd_norm_10,
            cvd_norm_50,
            cvd_norm_100,
            trade_vel,
            trade_vel_accel,
            vpin_proxy_10,
            hawkes_asymmetry,
            lat_us,
            lat_us_mean_50,
            lat_us_std_50,
            lat_us_jitter,
            seq_gap,
            execution_latency_ms,
            vol_realized_10,
            vol_realized_50,
            vol_realized_100,
            vol_parkinson_50,
            price_acceleration,
            momentum_direction,
        ];

        self.mid_prices.push_front(mid_price);
        if self.mid_prices.len() > 101 {
            self.mid_prices.pop_back();
        }

        self.log_ret_1_hist.push_front(mid_log_ret_1);
        if self.log_ret_1_hist.len() > 100 {
            self.log_ret_1_hist.pop_back();
        }

        self.obi_hist.push_front(obi);
        if self.obi_hist.len() > 10 {
            self.obi_hist.pop_back();
        }

        self.cvd_hist.push_front(cvd_raw);
        if self.cvd_hist.len() > 101 {
            self.cvd_hist.pop_back();
        }

        self.trade_vel_hist.push_front(trade_vel);
        if self.trade_vel_hist.len() > 51 {
            self.trade_vel_hist.pop_back();
        }

        self.lat_us_hist.push_front(lat_us);
        if self.lat_us_hist.len() > 51 {
            self.lat_us_hist.pop_back();
        }

        self.seq_hist = Some(seq_raw);

        let mut norm_features = [0.0f64; 40];
        let mut obi_z = 0.0f64;
        let mut cvd_z = 0.0f64;
        let mut vel_z = 0.0f64;
        let mut micro_z = 0.0f64;
        let mut ofi_z = 0.0f64;
        let mut hawkes_z = 0.0f64;

        for i in 0..40 {
            let val = raw_features[i];
            let head = self.feature_heads[i];
            let count = self.feature_lens[i];

            if count < 1000 {
                // Expanding window: Online Welford (1962) recurrence
                let new_count = count + 1;
                self.feature_lens[i] = new_count;
                let k = new_count as f64;
                let delta = val - self.feature_means[i];
                self.feature_means[i] += delta / k;
                let delta2 = val - self.feature_means[i];
                self.feature_m2s[i] += delta * delta2;
                self.feature_windows[i][head] = val;
                self.feature_heads[i] = (head + 1) % 1000;
            } else {
                // Fixed-length sliding window (N = 1000): Welford-West (1979) sliding recurrence
                let old = self.feature_windows[i][head];
                let n = 1000.0;
                let delta = val - old;
                let old_mean = self.feature_means[i];
                let new_mean = old_mean + delta / n;
                self.feature_means[i] = new_mean;
                // M2 update: M2_new = M2_old + delta * ((val - new_mean) + (old - old_mean))
                let delta_m2 = delta * ((val - new_mean) + (old - old_mean));
                self.feature_m2s[i] = (self.feature_m2s[i] + delta_m2).max(0.0);
                self.feature_windows[i][head] = val;
                let next_head = (head + 1) % 1000;
                self.feature_heads[i] = next_head;

                // Long-term numerical stability: re-center mean and M2 every full buffer cycle
                if next_head == 0 {
                    let mut m = 0.0;
                    let mut m2 = 0.0;
                    for (idx, &x) in self.feature_windows[i].iter().enumerate() {
                        let k = (idx + 1) as f64;
                        let d1 = x - m;
                        m += d1 / k;
                        let d2 = x - m;
                        m2 += d1 * d2;
                    }
                    self.feature_means[i] = m;
                    self.feature_m2s[i] = m2.max(0.0);
                }
            }

            let count_f = self.feature_lens[i] as f64;
            let variance = if count_f > 1.0 {
                self.feature_m2s[i] / (count_f - 1.0)
            } else {
                0.0
            };
            let std_dev = variance.sqrt();
            let z = if self.feature_lens[i] < 5 || std_dev < 1e-6 {
                0.0
            } else {
                (val - self.feature_means[i]) / (std_dev + 1e-8)
            };

            // DEF-R2: Store signed z-scores (NOT absolute z-scores)
            if i == 8 { obi_z = z; }
            if i == 17 { ofi_z = z; }
            if i == 21 { cvd_z = z; }
            if i == 24 { vel_z = z; }
            if i == 27 { hawkes_z = z; }
            if i == 2 { micro_z = z; }

            // Continuous C∞-differentiable soft-clip normalization strictly bounded in (-0.999, 0.999)
            // Uses 0.999 * tanh(z) instead of tanh(z).clamp() to preserve gradient continuity
            norm_features[i] = 0.999 * z.tanh();
        }

        let signed_z = SignedZScores {
            obi_z,
            cvd_z,
            vel_z,
            micro_z,
            ofi_z,
            hawkes_z,
        };
        self.signed_z_scores = signed_z;

        Ok((norm_features, signed_z))
    }
}

#[derive(Debug)]
pub struct AssetTelemetryTracker {
    pub last_mid_price: AtomicU64,
    pub last_prediction_dir: AtomicU64,
    pub last_inference_ns: AtomicU64,
    pub horizon_5s: Mutex<VecDeque<(u64, f64, f64)>>,   // (timestamp_ns, mid_price, prediction) - 5s Micro-Scalp
    pub horizon_60s: Mutex<VecDeque<(u64, f64, f64)>>,  // (timestamp_ns, mid_price, prediction) - 60s Tactical Alpha
    pub horizon_300s: Mutex<VecDeque<(u64, f64, f64)>>, // (timestamp_ns, mid_price, prediction) - 300s Macro-Regime
    pub conviction_history: Mutex<VecDeque<f64>>,       // capacity 2000 - DEF-R3 Quantile Calibration
}

impl AssetTelemetryTracker {
    pub fn new() -> Self {
        Self {
            last_mid_price: AtomicU64::new(0.0f64.to_bits()),
            last_prediction_dir: AtomicU64::new(0.0f64.to_bits()),
            last_inference_ns: AtomicU64::new(0),
            horizon_5s: Mutex::new(VecDeque::with_capacity(3_600)),
            horizon_60s: Mutex::new(VecDeque::with_capacity(18_000)),
            horizon_300s: Mutex::new(VecDeque::with_capacity(36_000)),
            conviction_history: Mutex::new(VecDeque::with_capacity(2000)),
        }
    }
}

pub struct AIEngine {
    pub tkan: TKANLayer,
    pub cell: Option<CfCCell>,
    pub mamba: Option<Mamba2Cell>,
    pub hidden_states: RwLock<Vec<Mutex<Tensor>>>,
    pub mamba_hidden: RwLock<Vec<Mutex<Vec<f32>>>>,
    pub status: AiEngineStatus,
    pub calibration_params: crate::ai::weights::CalibrationParams,
    pub last_inference_ns: AtomicU64,
    pub inference_seq: AtomicU64,
    pub ic_tracker: Mutex<ICTracker>,
    pub asset_trackers: RwLock<Vec<AssetTelemetryTracker>>,
    pub feature_pipelines: RwLock<Vec<Mutex<StreamingFeaturePipeline>>>,
}

impl AIEngine {
    pub fn new() -> Self {
        Self::load_from_file("./models/cfc_weights.safetensors")
    }

    pub fn load_from_paths(cfc_path: &str, tkan_path: &str) -> Self {
        let device = Device::Cpu;
        let tkan = TKANLayer::load_from_binary_or_default(tkan_path);
        let weights_engine = AiEngine::load_from_file(cfc_path);

        let num_assets = if let Ok(symbols_str) = std::env::var("TRADING_SYMBOLS") {
            symbols_str.split(',').filter(|s| !s.trim().is_empty()).count().max(1)
        } else if let Ok(max_assets_str) = std::env::var("MAX_CONCURRENT_ASSETS") {
            max_assets_str.trim().parse::<usize>().unwrap_or(10).max(1)
        } else {
            10
        };

        let mut asset_trackers = Vec::with_capacity(num_assets);
        let mut feature_pipelines = Vec::with_capacity(num_assets);
        let mut hidden_states = Vec::with_capacity(num_assets);
        let mut mamba_hidden = Vec::with_capacity(num_assets);

        for _ in 0..num_assets {
            asset_trackers.push(AssetTelemetryTracker::new());
            feature_pipelines.push(Mutex::new(StreamingFeaturePipeline::new()));
            let hs = Tensor::zeros((1, 32), DType::F32, &device)
                .unwrap_or_else(|_| Tensor::zeros((1, 32), DType::F32, &Device::Cpu).unwrap());
            hidden_states.push(Mutex::new(hs));
            mamba_hidden.push(Mutex::new(vec![0.0f32; 512]));
        }

        Self {
            tkan,
            cell: weights_engine.cell,
            mamba: weights_engine.mamba,
            hidden_states: RwLock::new(hidden_states),
            mamba_hidden: RwLock::new(mamba_hidden),
            status: weights_engine.status,
            calibration_params: weights_engine.calibration_params,
            last_inference_ns: AtomicU64::new(0),
            inference_seq: AtomicU64::new(0),
            ic_tracker: Mutex::new(ICTracker::default_1000()),
            asset_trackers: RwLock::new(asset_trackers),
            feature_pipelines: RwLock::new(feature_pipelines),
        }
    }

    pub fn load_from_file(path: &str) -> Self {
        Self::load_from_paths(path, "./models/tkan_luts.bin")
    }

    pub fn reload_weights(&mut self, path: &str) -> bool {
        let new_engine = Self::load_from_file(path);
        let calibrated = new_engine.is_calibrated();
        self.tkan = new_engine.tkan;
        self.cell = new_engine.cell;
        self.mamba = new_engine.mamba;
        self.status = new_engine.status;
        self.calibration_params = new_engine.calibration_params;
        if let Ok(new_hs_vec) = new_engine.hidden_states.into_inner() {
            if let Ok(mut hs_vec) = self.hidden_states.write() {
                while hs_vec.len() < new_hs_vec.len() {
                    hs_vec.push(Mutex::new(Tensor::zeros((1, 32), DType::F32, &Device::Cpu).unwrap()));
                }
                for (i, new_hs_mutex) in new_hs_vec.into_iter().enumerate() {
                    if let Ok(new_hs) = new_hs_mutex.into_inner() {
                        if let Ok(mut hs) = hs_vec[i].lock() {
                            *hs = new_hs;
                        }
                    }
                }
            }
        }
        if let Ok(mut mh_vec) = self.mamba_hidden.write() {
            for mh_mutex in mh_vec.iter_mut() {
                if let Ok(mut mh) = mh_mutex.lock() {
                    mh.fill(0.0f32);
                }
            }
        }
        calibrated
    }

    pub fn is_calibrated(&self) -> bool {
        self.status == AiEngineStatus::Calibrated && (self.cell.is_some() || self.mamba.is_some())
    }

    pub fn reset_ic_tracker(&self) {
        if let Ok(mut tracker) = self.ic_tracker.lock() {
            tracker.reset();
        }
    }

    pub fn run_inference(&self, sab: &AtomicSharedMemoryBridge) -> Result<()> {
        self.run_inference_asset(sab, 0)
    }

    pub fn run_inference_asset(&self, sab: &AtomicSharedMemoryBridge, asset_idx: usize) -> Result<()> {
        if self.status != AiEngineStatus::Calibrated || (self.cell.is_none() && self.mamba.is_none()) {
            return Ok(());
        }

        let start_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;

        let best_bid = sab.load_f64_asset(asset_idx, 4);
        let best_ask = sab.load_f64_asset(asset_idx, 6);
        if best_bid <= 0.0 || best_ask <= 0.0 {
            return Err(Error::Msg("ORDERBOOK_COLLAPSE_DETECTED".to_string()));
        }
        let current_mid = (best_bid + best_ask) / 2.0;

        let lat_us_val = sab.load_f64_asset(asset_idx, 98) * 1000.0;

        // Auto-expand feature pipelines dynamically if asset_idx exceeds current capacity
        if asset_idx >= self.feature_pipelines.read().unwrap_or_else(|e| e.into_inner()).len() {
            let mut pipelines_mut = self.feature_pipelines.write().unwrap_or_else(|e| e.into_inner());
            while pipelines_mut.len() <= asset_idx {
                pipelines_mut.push(Mutex::new(StreamingFeaturePipeline::new()));
            }
        }

        // Auto-expand asset trackers dynamically if asset_idx exceeds current capacity
        if asset_idx >= self.asset_trackers.read().unwrap_or_else(|e| e.into_inner()).len() {
            let mut trackers_mut = self.asset_trackers.write().unwrap_or_else(|e| e.into_inner());
            while trackers_mut.len() <= asset_idx {
                trackers_mut.push(AssetTelemetryTracker::new());
            }
        }

        let pipelines_guard = self.feature_pipelines.read().unwrap_or_else(|e| e.into_inner());
        let (lob_features, signed_z) = {
            let mut pipeline = pipelines_guard[asset_idx].lock().unwrap_or_else(|e| e.into_inner());
            pipeline.update_and_normalize_with_snr_asset(sab, lat_us_val, asset_idx)?
        };

        let trackers_guard = self.asset_trackers.read().unwrap_or_else(|e| e.into_inner());
        let tracker = &trackers_guard[asset_idx];

        // SOTA Triple-Horizon Orthogonal Tensor Evaluation (5s, 60s, 300s) (DEF-3002):
        let gk_vol = sab.load_f64_asset(asset_idx, 121).max(0.0005);
        let mut popped_obs: [(f64, f64, f64); 30] = [(0.0, 0.0, 0.0); 30];
        let mut num_popped = 0;

        // 1. Micro-Scalp Horizon: 5.0s (5_000_000_000 ns)
        if let Ok(mut hist) = tracker.horizon_5s.lock() {
            let horizon_ns = 5_000_000_000u64;
            let vol_5s = gk_vol * 1.0;
            let mut count = 0;
            while let Some(front) = hist.front() {
                if start_ns.saturating_sub(front.0) >= horizon_ns {
                    if let Some((_, hist_mid, hist_pred)) = hist.pop_front() {
                        if hist_mid > 0.0 && current_mid > 0.0 && hist_pred != 0.0 && num_popped < 30 {
                            let ret = (current_mid - hist_mid) / hist_mid;
                            let target = (ret / (2.0 * vol_5s + 1e-6)).tanh();
                            let residual = target - hist_pred;
                            popped_obs[num_popped] = (hist_pred, ret, residual);
                            num_popped += 1;
                        }
                    }
                    count += 1;
                    if count >= 10 {
                        break;
                    }
                } else {
                    break;
                }
            }
        }

        // 2. Tactical Alpha Horizon: 60.0s (60_000_000_000 ns)
        if let Ok(mut hist) = tracker.horizon_60s.lock() {
            let horizon_ns = 60_000_000_000u64;
            let vol_60s = gk_vol * (60.0f64 / 5.0).sqrt();
            let mut count = 0;
            while let Some(front) = hist.front() {
                if start_ns.saturating_sub(front.0) >= horizon_ns {
                    if let Some((_, hist_mid, hist_pred)) = hist.pop_front() {
                        if hist_mid > 0.0 && current_mid > 0.0 && hist_pred != 0.0 && num_popped < 30 {
                            let ret = (current_mid - hist_mid) / hist_mid;
                            let target = (ret / (2.0 * vol_60s + 1e-6)).tanh();
                            let residual = target - hist_pred;
                            popped_obs[num_popped] = (hist_pred, ret, residual);
                            num_popped += 1;
                        }
                    }
                    count += 1;
                    if count >= 10 {
                        break;
                    }
                } else {
                    break;
                }
            }
        }

        // 3. Macro-Regime Horizon: 300.0s (300_000_000_000 ns)
        if let Ok(mut hist) = tracker.horizon_300s.lock() {
            let horizon_ns = 300_000_000_000u64;
            let vol_300s = gk_vol * (300.0f64 / 5.0).sqrt();
            let mut count = 0;
            while let Some(front) = hist.front() {
                if start_ns.saturating_sub(front.0) >= horizon_ns {
                    if let Some((_, hist_mid, hist_pred)) = hist.pop_front() {
                        if hist_mid > 0.0 && current_mid > 0.0 && hist_pred != 0.0 && num_popped < 30 {
                            let ret = (current_mid - hist_mid) / hist_mid;
                            let target = (ret / (2.0 * vol_300s + 1e-6)).tanh();
                            let residual = target - hist_pred;
                            popped_obs[num_popped] = (hist_pred, ret, residual);
                            num_popped += 1;
                        }
                    }
                    count += 1;
                    if count >= 10 {
                        break;
                    }
                } else {
                    break;
                }
            }
        }

        // Throttled Spearman IC recomputation in background / low frequency
        if num_popped > 0 {
            if let Ok(mut ic_guard) = self.ic_tracker.lock() {
                for i in 0..num_popped {
                    let (pred, ret, res) = popped_obs[i];
                    ic_guard.push_observation_fast(pred, ret, res, start_ns);
                }
                ic_guard.maybe_recompute_spearman(Some(sab), asset_idx, start_ns);
            }
        }

        let tkan_out = self.tkan.forward(&lob_features);
        let tkan_f32: [f32; 16] = std::array::from_fn(|i| tkan_out[i] as f32);
        let tkan_tensor = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu)?;

        // Isolated per-asset delta-time integration
        let prev_ns = tracker.last_inference_ns.swap(start_ns, Ordering::Relaxed);
        self.last_inference_ns.store(start_ns, Ordering::Relaxed);
        let delta_t = if prev_ns == 0 {
            0.001
        } else {
            ((start_ns.saturating_sub(prev_ns) as f64) / 1e9).clamp(0.0001, 10.0)
        };

        let (direction, confidence, horizon_ms) = if let Some(mamba) = &self.mamba {
            // Auto-expand mamba hidden dynamically if asset_idx exceeds current capacity
            if asset_idx >= self.mamba_hidden.read().unwrap_or_else(|e| e.into_inner()).len() {
                let mut mh_write = self.mamba_hidden.write().unwrap_or_else(|e| e.into_inner());
                while mh_write.len() <= asset_idx {
                    mh_write.push(Mutex::new(vec![0.0f32; mamba.d_inner * mamba.d_state]));
                }
            }
            let mh_holder = self.mamba_hidden.read().unwrap_or_else(|e| e.into_inner());
            let mut m_hidden_guard = mh_holder[asset_idx].lock().unwrap_or_else(|e| e.into_inner());
            if m_hidden_guard.len() != mamba.d_inner * mamba.d_state {
                m_hidden_guard.resize(mamba.d_inner * mamba.d_state, 0.0f32);
            }

            let gk_vol = sab.load_f64_asset(asset_idx, 121).max(0.0);
            let sab_temp = sab.load_f64_asset(asset_idx, 127);
            let sab_scale = sab.load_f64_asset(asset_idx, 128);
            let sab_offset = sab.load_f64_asset(asset_idx, 129);

            let temp = if sab_temp > 0.05 { sab_temp } else { self.calibration_params.temperature }.clamp(0.5, 5.0);
            let scale = if sab_scale > 0.001 { sab_scale } else { self.calibration_params.platt_scale }.clamp(0.5, 5.0);
            let offset = sab_offset.clamp(-2.0, 2.0);
            let obi = sab.load_f64_asset(asset_idx, 1);
            let ofi = sab.load_f64_asset(asset_idx, 138);
            let hawkes_asym = sab.load_f64_asset(asset_idx, 149);

            let (dir_raw, _p_win, horiz_sec) = mamba.forward_and_evaluate_fast(&tkan_f32, &mut *m_hidden_guard, delta_t, temp);

            // DEF-R1: Balanced microstructure logit modulation & SINGLE outer tanh WITHOUT temperature divisor
            let composite_logit = dir_raw + 0.15 * obi + 0.10 * ofi + 0.05 * hawkes_asym;
            let dir = composite_logit.tanh().clamp(-1.0, 1.0);
            let direction_magnitude = dir.abs();

            // DEF-R2: Signed Directional Concordance Index (SDCI)
            let snr_score = signed_z.compute_sdci(dir_raw);

            // DEF-R3: Online Adaptive Quantile Calibration
            let mut conv_hist = tracker.conviction_history.lock().unwrap_or_else(|e| e.into_inner());

            let conf = compute_calibrated_confidence(
                direction_magnitude,
                snr_score,
                gk_vol,
                obi,
                dir,
                temp,
                scale,
                offset,
                &mut *conv_hist,
            );
            (dir, conf, horiz_sec * 1000.0)
        } else if let Some(cell) = &self.cell {
            if asset_idx >= self.hidden_states.read().unwrap_or_else(|e| e.into_inner()).len() {
                let mut hs_write = self.hidden_states.write().unwrap_or_else(|e| e.into_inner());
                while hs_write.len() <= asset_idx {
                    hs_write.push(Mutex::new(Tensor::zeros((1, 32), DType::F32, &Device::Cpu).unwrap()));
                }
            }
            let hs_holder = self.hidden_states.read().unwrap_or_else(|e| e.into_inner());
            let mut hidden_guard = hs_holder[asset_idx].lock().unwrap_or_else(|e| e.into_inner());
            let (output_tensor, next_hidden) = cell.forward(&tkan_tensor, &*hidden_guard, delta_t)?;
            *hidden_guard = next_hidden;
            let flat_out = output_tensor.flatten_all()?;
            let num_elems = flat_out.elem_count();
            let raw_direction = if num_elems > 0 { flat_out.get(0)?.to_scalar::<f32>()? as f64 } else { 0.0 };
            let horiz_ms = if num_elems > 2 { flat_out.get(2)?.to_scalar::<f32>()? as f64 } else { 100.0 };

            let gk_vol = sab.load_f64_asset(asset_idx, 121).max(0.0);
            let sab_temp = sab.load_f64_asset(asset_idx, 127);
            let sab_scale = sab.load_f64_asset(asset_idx, 128);
            let sab_offset = sab.load_f64_asset(asset_idx, 129);

            let temp = if sab_temp > 0.05 { sab_temp } else { self.calibration_params.temperature }.clamp(0.5, 5.0);
            let scale = if sab_scale > 0.001 { sab_scale } else { self.calibration_params.platt_scale }.clamp(0.5, 5.0);
            let offset = sab_offset.clamp(-2.0, 2.0);
            let obi = sab.load_f64_asset(asset_idx, 1);

            let dir = raw_direction.tanh().clamp(-1.0, 1.0);
            let direction_magnitude = dir.abs();

            let snr_score = signed_z.compute_sdci(raw_direction);

            let mut conv_hist = tracker.conviction_history.lock().unwrap_or_else(|e| e.into_inner());

            let conf = compute_calibrated_confidence(
                direction_magnitude,
                snr_score,
                gk_vol,
                obi,
                dir,
                temp,
                scale,
                offset,
                &mut *conv_hist,
            );
            (dir, conf, horiz_ms)
        } else {
            return Ok(());
        };

        let direction_magnitude = direction.abs();

        let end_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let latency_ns = end_ns.saturating_sub(start_ns);

        let spread_vel = sab.load_f64_asset(asset_idx, 3);
        let slippage_ticks = (2.0 + (spread_vel.abs() / 0.5).floor()).min(20.0);

        // Store intra-asset telemetry and push prediction to horizon history buffer
        tracker.last_mid_price.store(current_mid.to_bits(), Ordering::Relaxed);
        tracker.last_prediction_dir.store(direction.to_bits(), Ordering::Relaxed);
        if let Ok(mut hist) = tracker.horizon_5s.lock() {
            hist.push_back((start_ns, current_mid, direction));
            if hist.len() > 3_600 {
                hist.pop_front();
            }
        }
        if let Ok(mut hist) = tracker.horizon_60s.lock() {
            hist.push_back((start_ns, current_mid, direction));
            if hist.len() > 18_000 {
                hist.pop_front();
            }
        }
        if let Ok(mut hist) = tracker.horizon_300s.lock() {
            hist.push_back((start_ns, current_mid, direction));
            if hist.len() > 36_000 {
                hist.pop_front();
            }
        }

        let seq = self.inference_seq.fetch_add(1, Ordering::Relaxed);

        sab.store_f64_asset(asset_idx, 93, direction);
        sab.store_f64_asset(asset_idx, 94, confidence);
        sab.store_f64_asset(asset_idx, 95, horizon_ms);
        sab.store_u64_asset(asset_idx, 96, start_ns);
        sab.store_f64_asset(asset_idx, 97, direction_magnitude);
        sab.store_f64_asset(asset_idx, 100, slippage_ticks);
        sab.store_u64_asset(asset_idx, 103, latency_ns);
        sab.store_u64_asset(asset_idx, 104, seq);

        Ok(())
    }

    pub fn evaluate_features(&self, features: &[f64; 40]) -> (f64, f64) {
        let tkan_out = self.tkan.forward(features);
        let tkan_f32: [f32; 16] = std::array::from_fn(|i| tkan_out[i] as f32);
        if let Ok(tkan_tensor) = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu) {
            let hs_holder = self.hidden_states.read().unwrap_or_else(|e| e.into_inner());
            if let Some(hs_mutex) = hs_holder.get(0) {
                if let Ok(mut hidden_guard) = hs_mutex.lock() {
                    let signed_z = SignedZScores {
                        obi_z: features[8],
                        ofi_z: features[17],
                        cvd_z: features[21],
                        vel_z: features[24],
                        hawkes_z: features[27],
                        micro_z: features[2],
                    };
                    let trackers_guard = self.asset_trackers.read().unwrap_or_else(|e| e.into_inner());
                    if let Some(mamba) = &self.mamba {
                        let mh_holder = self.mamba_hidden.read().unwrap_or_else(|e| e.into_inner());
                        if let Some(mh_mutex) = mh_holder.get(0) {
                            if let Ok(mut m_hidden_guard) = mh_mutex.lock() {
                                if m_hidden_guard.len() != mamba.d_inner * mamba.d_state {
                                    m_hidden_guard.resize(mamba.d_inner * mamba.d_state, 0.0f32);
                                }
                                let temp = self.calibration_params.temperature.clamp(0.5, 5.0);
                                let (dir_raw, _p_win, _) = mamba.forward_and_evaluate_fast(&tkan_f32, &mut *m_hidden_guard, 0.001, temp);
                                let obi = features[8];
                                let ofi = features[17];
                                let hawkes_asym = features[27];
                                let composite_logit = dir_raw + 0.15 * obi + 0.10 * ofi + 0.05 * hawkes_asym;
                                let dir = composite_logit.tanh().clamp(-1.0, 1.0);
                                let snr_score = signed_z.compute_sdci(dir_raw);
                                if let Some(tracker) = trackers_guard.get(0) {
                                    if let Ok(mut conv_hist) = tracker.conviction_history.lock() {
                                        let conf = compute_calibrated_confidence(
                                            dir.abs(),
                                            snr_score,
                                            0.0010,
                                            obi,
                                            dir,
                                            temp,
                                            self.calibration_params.platt_scale,
                                            self.calibration_params.platt_offset,
                                            &mut *conv_hist,
                                        );
                                        return (dir, conf);
                                    }
                                }
                            }
                        }
                    } else if let Some(cell) = &self.cell {
                        if let Ok((output_tensor, next_h)) = cell.forward(&tkan_tensor, &*hidden_guard, 0.001) {
                            *hidden_guard = next_h;
                            if let Ok(flat) = output_tensor.flatten_all() {
                                let temp = self.calibration_params.temperature.clamp(0.5, 5.0);
                                let raw_dir = flat.get(0).and_then(|t| t.to_scalar::<f32>()).map(|v| (v as f64).tanh().clamp(-1.0, 1.0)).unwrap_or(0.0);
                                let snr_score = signed_z.compute_sdci(raw_dir);
                                if let Some(tracker) = trackers_guard.get(0) {
                                    if let Ok(mut conv_hist) = tracker.conviction_history.lock() {
                                        let conf = compute_calibrated_confidence(
                                            raw_dir.abs(),
                                            snr_score,
                                            0.0010,
                                            0.0,
                                            raw_dir,
                                            temp,
                                            self.calibration_params.platt_scale,
                                            self.calibration_params.platt_offset,
                                            &mut *conv_hist,
                                        );
                                        return (raw_dir, conf);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        (0.0, 0.50)
    }

    pub fn run_shadow_inference(&self, sab: &AtomicSharedMemoryBridge) -> Result<(f64, f64, f64, u64, f64)> {
        let best_bid = sab.load_f64_asset(0, 4);
        let best_ask = sab.load_f64_asset(0, 6);
        if best_bid <= 0.0 || best_ask <= 0.0 {
            return Err(Error::Msg("ORDERBOOK_COLLAPSE_DETECTED".to_string()));
        }

        let lat_us_val = sab.load_f64_asset(0, 98) * 1000.0;
        let (lob_features, signed_z) = {
            let pipelines = self.feature_pipelines.read().unwrap_or_else(|e| e.into_inner());
            let mut pipeline = pipelines[0].lock().unwrap_or_else(|e| e.into_inner());
            pipeline.update_and_normalize_with_snr_asset(sab, lat_us_val, 0)?
        };

        let (direction, confidence, horizon_ms, hidden_norm, latency_ns) = if let Some(mamba) = &self.mamba {
            let mh_holder = self.mamba_hidden.read().unwrap_or_else(|e| e.into_inner());
            let mut m_hidden_guard = mh_holder[0].lock().unwrap_or_else(|e| e.into_inner());
            if m_hidden_guard.len() != mamba.d_inner * mamba.d_state {
                m_hidden_guard.resize(mamba.d_inner * mamba.d_state, 0.0f32);
            }
            let temp = self.calibration_params.temperature.clamp(0.5, 5.0);

            let dnn_start = std::time::Instant::now();
            let tkan_out = self.tkan.forward(&lob_features);
            let tkan_f32: [f32; 16] = std::array::from_fn(|i| tkan_out[i] as f32);
            let (dir_raw, _p_win, horiz_sec) = mamba.forward_and_evaluate_fast(&tkan_f32, &mut *m_hidden_guard, 0.001, temp);
            let dnn_latency_ns = dnn_start.elapsed().as_nanos() as u64;

            let norm = m_hidden_guard.iter().map(|v| v * v).sum::<f32>().sqrt() as f64;
            let gk_vol = sab.load_f64_asset(0, 121).max(0.0);
            let obi = sab.load_f64_asset(0, 1);
            let ofi = sab.load_f64_asset(0, 138);
            let hawkes_asym = sab.load_f64_asset(0, 149);
            let composite_logit = dir_raw + 0.15 * obi + 0.10 * ofi + 0.05 * hawkes_asym;
            let dir = composite_logit.tanh().clamp(-1.0, 1.0);
            let snr_score = signed_z.compute_sdci(dir_raw);

            let trackers_guard = self.asset_trackers.read().unwrap_or_else(|e| e.into_inner());
            let mut conv_hist = trackers_guard[0].conviction_history.lock().unwrap_or_else(|e| e.into_inner());

            let conf = compute_calibrated_confidence(
                dir.abs(),
                snr_score,
                gk_vol,
                obi,
                dir,
                temp,
                self.calibration_params.platt_scale,
                self.calibration_params.platt_offset,
                &mut *conv_hist,
            );
            (dir, conf, horiz_sec * 1000.0, norm, dnn_latency_ns)
        } else if let Some(cell) = &self.cell {
            let hs_holder = self.hidden_states.read().unwrap_or_else(|e| e.into_inner());
            let mut hidden_guard = hs_holder[0].lock().unwrap_or_else(|e| e.into_inner());
            let temp = self.calibration_params.temperature.clamp(0.5, 5.0);

            let dnn_start = std::time::Instant::now();
            let tkan_out = self.tkan.forward(&lob_features);
            let tkan_f32: [f32; 16] = std::array::from_fn(|i| tkan_out[i] as f32);
            let tkan_tensor = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu)?;
            let (output_tensor, next_h) = cell.forward(&tkan_tensor, &*hidden_guard, 0.001)?;
            let dnn_latency_ns = dnn_start.elapsed().as_nanos() as u64;

            let norm = next_h.sqr()?.sum_all()?.to_scalar::<f32>()?.sqrt() as f64;
            *hidden_guard = next_h;
            let flat_out = output_tensor.flatten_all()?;
            let raw_dir = flat_out.get(0)?.to_scalar::<f32>()? as f64;
            let horiz = if flat_out.elem_count() > 2 { flat_out.get(2)?.to_scalar::<f32>()? as f64 } else { 100.0 };
            let dir = raw_dir.tanh().clamp(-1.0, 1.0);
            let gk_vol = sab.load_f64_asset(0, 121).max(0.0);
            let obi = sab.load_f64_asset(0, 1);
            let snr_score = signed_z.compute_sdci(raw_dir);

            let trackers_guard = self.asset_trackers.read().unwrap_or_else(|e| e.into_inner());
            let mut conv_hist = trackers_guard[0].conviction_history.lock().unwrap_or_else(|e| e.into_inner());

            let conf = compute_calibrated_confidence(
                dir.abs(),
                snr_score,
                gk_vol,
                obi,
                dir,
                temp,
                self.calibration_params.platt_scale,
                self.calibration_params.platt_offset,
                &mut *conv_hist,
            );
            (dir, conf, horiz, norm, dnn_latency_ns)
        } else {
            return Err(Error::Msg("UNCALIBRATED".to_string()));
        };

        Ok((direction, confidence, horizon_ms, latency_ns, hidden_norm))
    }

    pub fn inherit_hidden_state(&self, other: &AIEngine) {
        let other_guard = other.hidden_states.read().unwrap_or_else(|e| e.into_inner());
        let mut self_guard = self.hidden_states.write().unwrap_or_else(|e| e.into_inner());
        while self_guard.len() < other_guard.len() {
            self_guard.push(Mutex::new(Tensor::zeros((1, 32), DType::F32, &Device::Cpu).unwrap()));
        }
        for (i, other_mutex) in other_guard.iter().enumerate() {
            if let Ok(other_hs) = other_mutex.lock() {
                if let Ok(mut self_hs) = self_guard[i].lock() {
                    *self_hs = other_hs.clone();
                }
            }
        }
        let other_mh = other.mamba_hidden.read().unwrap_or_else(|e| e.into_inner());
        let mut self_mh = self.mamba_hidden.write().unwrap_or_else(|e| e.into_inner());
        while self_mh.len() < other_mh.len() {
            self_mh.push(Mutex::new(vec![0.0f32; 512]));
        }
        for (i, other_mutex) in other_mh.iter().enumerate() {
            if let Ok(other_val) = other_mutex.lock() {
                if let Ok(mut self_val) = self_mh[i].lock() {
                    *self_val = other_val.clone();
                }
            }
        }
    }

    /// RCU Telemetry & History Inheritance: Preserves conviction history, horizons, and feature statistics across hot-swaps
    pub fn inherit_telemetry_history(&self, other: &AIEngine) {
        let other_guard = other.asset_trackers.read().unwrap_or_else(|e| e.into_inner());
        let mut self_guard = self.asset_trackers.write().unwrap_or_else(|e| e.into_inner());
        while self_guard.len() < other_guard.len() {
            self_guard.push(AssetTelemetryTracker::new());
        }
        for (i, other_tracker) in other_guard.iter().enumerate() {
            if let Some(self_tracker) = self_guard.get(i) {
                if let Ok(other_conv) = other_tracker.conviction_history.lock() {
                    if let Ok(mut self_conv) = self_tracker.conviction_history.lock() {
                        *self_conv = other_conv.clone();
                    }
                }
                if let Ok(other_5s) = other_tracker.horizon_5s.lock() {
                    if let Ok(mut self_5s) = self_tracker.horizon_5s.lock() {
                        *self_5s = other_5s.clone();
                    }
                }
                if let Ok(other_60s) = other_tracker.horizon_60s.lock() {
                    if let Ok(mut self_60s) = self_tracker.horizon_60s.lock() {
                        *self_60s = other_60s.clone();
                    }
                }
                if let Ok(other_300s) = other_tracker.horizon_300s.lock() {
                    if let Ok(mut self_300s) = self_tracker.horizon_300s.lock() {
                        *self_300s = other_300s.clone();
                    }
                }
                self_tracker.last_mid_price.store(other_tracker.last_mid_price.load(Ordering::Relaxed), Ordering::Relaxed);
                self_tracker.last_prediction_dir.store(other_tracker.last_prediction_dir.load(Ordering::Relaxed), Ordering::Relaxed);
                self_tracker.last_inference_ns.store(other_tracker.last_inference_ns.load(Ordering::Relaxed), Ordering::Relaxed);
            }
        }

        let other_pipes = other.feature_pipelines.read().unwrap_or_else(|e| e.into_inner());
        let mut self_pipes = self.feature_pipelines.write().unwrap_or_else(|e| e.into_inner());
        while self_pipes.len() < other_pipes.len() {
            self_pipes.push(Mutex::new(StreamingFeaturePipeline::new()));
        }
        for (i, other_pipe_mutex) in other_pipes.iter().enumerate() {
            if let Ok(other_pipe) = other_pipe_mutex.lock() {
                if let Ok(mut self_pipe) = self_pipes[i].lock() {
                    *self_pipe = other_pipe.clone();
                }
            }
        }

        if let Ok(other_ic) = other.ic_tracker.lock() {
            if let Ok(mut self_ic) = self.ic_tracker.lock() {
                *self_ic = other_ic.clone();
                // CRITICAL: Reset drift state on the inherited tracker to prevent
                // new models from instantly re-latching to MODEL_BROKEN due to
                // stale CUSUM accumulators and is_drifted flags from the old model.
                self_ic.cusum.reset();
                self_ic.record_recalibration(0);
            }
        }
    }
}

/// Dual-Regime Information-Theoretic Volatility Scaling
#[inline(always)]
pub fn compute_dual_regime_volatility_multiplier(gk_vol: f64) -> f64 {
    let vol = gk_vol.max(0.0);
    let psi_high = 1.0 / (1.0 + (vol / 0.0015).clamp(0.0, 3.0));
    let psi_low = (vol / (vol + 0.00008)).powf(0.35);
    (psi_high * psi_low).clamp(0.30, 1.00)
}

/// Continuous Bayesian Sample-Weighted Warmup & Platt-Calibrated Confidence Formulation (DEF-R3 SOTA)
#[inline(always)]
pub fn compute_calibrated_confidence(
    direction_magnitude: f64,
    snr_score: f64,
    gk_vol: f64,
    obi: f64,
    direction: f64,
    temp: f64,
    scale: f64,
    offset: f64,
    conviction_history: &mut VecDeque<f64>,
) -> f64 {
    let psi_vol = compute_dual_regime_volatility_multiplier(gk_vol);
    let effective_conviction = direction_magnitude * snr_score * psi_vol;

    // Update rolling buffer (capacity 2000)
    if conviction_history.len() >= 2000 {
        conviction_history.pop_back();
    }
    conviction_history.push_front(effective_conviction);

    let n = conviction_history.len();
    if n == 0 {
        return 0.50;
    }

    // Compute empirical percentile rank (O(n) where n <= 2000, ~2-4 µs)
    let count_below = conviction_history.iter().filter(|&&v| v <= effective_conviction).count();
    let percentile = count_below as f64 / n as f64;

    let direction_sign = if direction.abs() < 1e-6 { 0.0 } else { direction.signum() };
    let obi_align = obi * direction_sign;

    let t = temp.clamp(0.5, 5.0);
    let s = scale.clamp(0.5, 3.0);
    // Center at 50th percentile — INVARIANT
    let calibrated_logit: f64 = (s * (percentile - 0.50) * 2.0 + obi_align * 0.20 + offset) / t;
    let conf_calib = 1.0f64 / (1.0f64 + (-calibrated_logit).exp());

    // Continuous Bayesian Sample-Weighted Warmup:
    // w = min(1.0, N / 30.0). No discontinuous step function!
    let w = (n as f64 / 30.0).min(1.0);
    0.50 * (1.0 - w) + conf_calib * w
}

impl Default for AIEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ai_engine_uncalibrated_graceful_inference() {
        let engine = AIEngine::load_from_file("./models/non_existent_weights.safetensors");
        let mut buffer = vec![0u8; 2048];
        let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len()).unwrap();

        let res = engine.run_inference(&bridge);
        assert!(res.is_ok());
        assert!(!engine.is_calibrated());
    }

    #[test]
    fn test_reload_weights() {
        let mut engine = AIEngine::new();
        assert!(!engine.reload_weights("./models/non_existent_weights.safetensors"));
    }

    #[test]
    fn test_orderbook_collapse_detection() {
        let mut engine = AIEngine::new();
        engine.status = AiEngineStatus::Calibrated;
        let dev = Device::Cpu;
        let cell = CfCCell::new(
            Tensor::zeros((48, 32), DType::F32, &dev).unwrap(),
            Tensor::zeros((32,), DType::F32, &dev).unwrap(),
            Tensor::zeros((48, 32), DType::F32, &dev).unwrap(),
            Tensor::zeros((32,), DType::F32, &dev).unwrap(),
            Tensor::zeros((32, 1), DType::F32, &dev).unwrap(),
            Tensor::zeros((1,), DType::F32, &dev).unwrap(),
        );
        engine.cell = Some(cell);
        let mut buffer = vec![0u8; 2048];
        let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len()).unwrap();

        let res = engine.run_inference(&bridge);
        assert!(res.is_err());
        let err_str = res.err().unwrap().to_string();
        assert!(err_str.contains("ORDERBOOK_COLLAPSE_DETECTED"));
    }

    #[test]
    fn test_streaming_feature_pipeline_normalization() {
        let mut buffer = vec![0u8; 2048];
        let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len()).unwrap();
        bridge.store_f64(4, 50000.0);
        bridge.store_f64(5, 1.5);
        bridge.store_f64(6, 50001.0);
        bridge.store_f64(7, 2.5);

        let mut pipeline = StreamingFeaturePipeline::new();
        let features = pipeline.update_and_normalize(&bridge, 150.0).unwrap();
        assert_eq!(features.len(), 40);
        for f in features.iter() {
            assert!(*f >= -1.0 && *f <= 1.0);
        }
    }

    #[test]
    fn test_mamba2_inference_dispatch() {
        let mut engine = AIEngine::new();
        let dev = Device::Cpu;
        let mamba = Mamba2Cell::default_cell(16, 32, 16, &dev).unwrap();
        engine.mamba = Some(mamba);
        engine.status = AiEngineStatus::Calibrated;

        let mut buffer = vec![0u8; 2048];
        let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len()).unwrap();
        bridge.store_f64(4, 50000.0);
        bridge.store_f64(5, 1.5);
        bridge.store_f64(6, 50001.0);
        bridge.store_f64(7, 2.5);

        let res = engine.run_inference(&bridge);
        assert!(res.is_ok());
        assert!(engine.is_calibrated());

        let dir = bridge.load_f64(93);
        let conf = bridge.load_f64(94);
        assert!(dir >= -1.0 && dir <= 1.0);
        assert!(conf >= 0.0 && conf <= 1.0);
    }

    #[test]
    fn test_live_weights_inference() {
        let engine = AIEngine::load_from_paths("./models/cfc_weights.safetensors", "./models/tkan_luts.bin");
        println!("Loaded engine calibrated: {}", engine.is_calibrated());
        if let Some(mamba) = &engine.mamba {
            println!("b_heads: {:?}", mamba.b_heads.to_vec1::<f32>().unwrap());
            println!("b_out (first 10): {:?}", &mamba.b_out.to_vec1::<f32>().unwrap()[0..10]);
            let w_heads_col0 = mamba.w_heads.t().unwrap().get(0).unwrap().to_vec1::<f32>().unwrap();
            println!("w_heads col 0 (dir) sum: {:.4}, mean: {:.4}, vals: {:?}",
                w_heads_col0.iter().sum::<f32>(),
                w_heads_col0.iter().sum::<f32>() / w_heads_col0.len() as f32,
                &w_heads_col0[0..10]
            );
            let w_out_flat = mamba.w_out.flatten_all().unwrap().to_vec1::<f32>().unwrap();
            println!("w_out sum: {:.4}, mean: {:.4}, min: {:.4}, max: {:.4}",
                w_out_flat.iter().sum::<f32>(),
                w_out_flat.iter().sum::<f32>() / w_out_flat.len() as f32,
                w_out_flat.iter().cloned().fold(f32::INFINITY, f32::min),
                w_out_flat.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
            );
        }
        let mut buffer = vec![0u8; 4096];
        let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len()).unwrap();
        bridge.store_f64(4, 50000.0);
        bridge.store_f64(5, 1.5);
        bridge.store_f64(6, 50001.0);
        bridge.store_f64(7, 2.5);
        bridge.store_f64(1, 0.20); // OBI
        bridge.store_f64(2, 50.0); // CVD
        bridge.store_f64(3, 0.50); // Spread vel
        bridge.store_f64(121, 0.001); // RV GK

        // Feed 60 bullish ticks (rising price, high OBI, positive CVD)
        for tick in 0..60 {
            bridge.store_f64(4, 50000.0 + (tick as f64 * 10.0));
            bridge.store_f64(6, 50001.0 + (tick as f64 * 10.0));
            bridge.store_f64(1, 0.85); // Strong Bullish OBI
            bridge.store_f64(2, 500.0 + (tick as f64 * 50.0)); // Rising CVD
            bridge.store_f64(3, 0.10);
            bridge.store_f64(121, 0.002);
            bridge.store_f64(138, 0.80); // Strong positive Multi-Level OFI
            bridge.store_f64(149, 0.70); // Positive Hawkes Asymmetry
            let res = engine.run_inference(&bridge);
            assert!(res.is_ok());
            if tick % 15 == 0 {
                let dir = bridge.load_f64(93);
                let conf = bridge.load_f64(94);
                println!("Bullish Stream Tick {:02}: Dir = {:.4}, Conf = {:.4}", tick, dir, conf);
            }
        }

        // Feed 160 bearish ticks (falling price down to 48000, low OBI, crashing CVD)
        for tick in 0..160 {
            bridge.store_f64(4, 50600.0 - (tick as f64 * 25.0));
            bridge.store_f64(6, 50601.0 - (tick as f64 * 25.0));
            bridge.store_f64(1, -0.90); // Strong Bearish OBI
            bridge.store_f64(2, 3500.0 - (tick as f64 * 100.0)); // Crashing CVD
            bridge.store_f64(3, 0.10);
            bridge.store_f64(121, 0.002);
            bridge.store_f64(138, -0.90); // Strong negative OFI
            bridge.store_f64(149, -0.85); // Negative Hawkes Asymmetry
            let res = engine.run_inference(&bridge);
            assert!(res.is_ok());
            if tick % 30 == 0 || tick == 159 {
                let dir = bridge.load_f64(93);
                let conf = bridge.load_f64(94);
                println!("Bearish Stream Tick {:02}: Dir = {:.4}, Conf = {:.4}", tick, dir, conf);
            }
        }
    }

    #[test]
    fn test_inference_latency_benchmark() {
        let engine = AIEngine::load_from_paths("./models/cfc_weights.safetensors", "./models/tkan_luts.bin");
        if !engine.is_calibrated() {
            println!("Engine not calibrated; skipping physical benchmark");
            return;
        }
        let mut buffer = vec![0u8; 4096];
        let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len()).unwrap();
        bridge.store_f64(4, 50000.0);
        bridge.store_f64(5, 1.5);
        bridge.store_f64(6, 50001.0);
        bridge.store_f64(7, 2.5);

        // Warmup 50 iterations
        for _ in 0..50 {
            let _ = engine.run_inference(&bridge);
        }

        // Measure 1000 iterations
        let n_runs = 1000;
        let start = std::time::Instant::now();
        for _ in 0..n_runs {
            let _ = engine.run_inference(&bridge);
        }
        let elapsed = start.elapsed();
        let avg_us = elapsed.as_micros() as f64 / n_runs as f64;
        println!("[BENCHMARK] Total for {} inferences: {:?}, Mean per inference: {:.2} µs", n_runs, elapsed, avg_us);
        assert!(avg_us < 200.0, "Physical inference latency must be < 200 µs, got {:.2} µs", avg_us);
    }

    #[test]
    fn test_sdci_chop_produces_low_score() {
        // In chop / discordance: AI predicted BUY (dir_raw > 0), but order flow is bearish
        let z_discordant = SignedZScores {
            obi_z: -2.0,      // Bearish bid pressure
            cvd_z: -2.5,      // Net selling
            vel_z: 2.0,       // Spread widening (negative for buy because spread_sign_flip = -1.0)
            micro_z: -1.5,    // Bearish micro-price
            ofi_z: -2.0,      // Bearish OFI
            hawkes_z: -1.8,   // Bearish Hawkes asymmetry
        };

        let pred_dir_raw = 0.50; // AI says BUY
        let snr_score = z_discordant.compute_sdci(pred_dir_raw);

        // SDCI strictly bounds to [0.10, 1.50]
        assert!(snr_score >= 0.10 && snr_score <= 1.50);
        assert_eq!(snr_score, 0.10, "Discordant / chop features must clamp to minimum floor 0.10");

        // In pure neutral chop (all z ≈ 0)
        let z_neutral = SignedZScores::default();
        let snr_neutral = z_neutral.compute_sdci(pred_dir_raw);
        assert!((snr_neutral - 0.50).abs() < 1e-6, "Zero z-score chop must map to neutral 0.50");
    }

    #[test]
    fn test_sdci_trend_produces_high_score() {
        // In real trend / concordance: AI predicted BUY, and all features strongly confirm
        let z_concordant = SignedZScores {
            obi_z: 2.5,       // Strong bid pressure
            cvd_z: 3.0,       // Heavy net buying
            vel_z: -2.0,      // Tightening spread (spread_sign_flip * -2.0 = +2.0)
            micro_z: 2.0,     // Strong upward microprice
            ofi_z: 2.5,       // High positive OFI
            hawkes_z: 2.2,    // Positive Hawkes burst
        };

        let pred_dir_raw = 0.75; // AI says BUY
        let snr_score = z_concordant.compute_sdci(pred_dir_raw);

        assert!(snr_score >= 0.10 && snr_score <= 1.50);
        assert!(snr_score >= 1.20, "Concordant trend features must produce high SNR score >= 1.20, got {}", snr_score);
    }

    #[test]
    fn test_continuous_bayesian_calibration_warmup() {
        let mut conv_hist = VecDeque::with_capacity(2000);

        // Empty history test
        assert_eq!(conv_hist.len(), 0);

        // Warm-up is continuous Bayesian: at low sample counts, confidence is regularized toward 0.50
        // At N = 1, it smoothly incorporates evidence without step-function lockups
        let conf_1 = compute_calibrated_confidence(
            0.80, 1.20, 0.001, 0.50, 1.0, 1.0, 1.0, 0.0, &mut conv_hist,
        );
        assert!(conf_1 > 0.50 && conf_1 < 0.60, "Tick 1 must have smooth Bayesian shrinkage, got {}", conf_1);

        // Populate up to 30 ticks
        for _ in 1..30 {
            let _ = compute_calibrated_confidence(
                0.80, 1.20, 0.001, 0.50, 1.0, 1.0, 1.0, 0.0, &mut conv_hist,
            );
        }
        assert_eq!(conv_hist.len(), 30);

        // At N >= 30, weight reaches 1.0 (fully calibrated)
        let conf_30 = compute_calibrated_confidence(
            0.80, 1.20, 0.001, 0.50, 1.0, 1.0, 1.0, 0.0, &mut conv_hist,
        );
        assert!(conf_30 > 0.65, "At N >= 30, calibration is fully active, got {}", conf_30);
    }

    #[test]
    fn test_rcu_telemetry_history_inheritance() {
        let engine_old = AIEngine::new();
        // Seed engine_old with telemetry data
        {
            let trackers = engine_old.asset_trackers.read().unwrap();
            let mut conv = trackers[0].conviction_history.lock().unwrap();
            conv.push_back(0.75);
            conv.push_back(0.82);
            let mut h5 = trackers[0].horizon_5s.lock().unwrap();
            h5.push_back((1000, 50000.0, 0.5));
            trackers[0].last_mid_price.store(50000.0f64.to_bits(), Ordering::Relaxed);
        }

        let engine_new = AIEngine::new();
        engine_new.inherit_telemetry_history(&engine_old);

        // Verify telemetry was inherited perfectly
        {
            let trackers_new = engine_new.asset_trackers.read().unwrap();
            let conv_new = trackers_new[0].conviction_history.lock().unwrap();
            assert_eq!(conv_new.len(), 2);
            assert_eq!(conv_new[0], 0.75);
            assert_eq!(conv_new[1], 0.82);

            let h5_new = trackers_new[0].horizon_5s.lock().unwrap();
            assert_eq!(h5_new.len(), 1);
            assert_eq!(h5_new[0].1, 50000.0);

            assert_eq!(
                f64::from_bits(trackers_new[0].last_mid_price.load(Ordering::Relaxed)),
                50000.0
            );
        }
    }

    #[test]
    fn test_feature_normalization_bounds_and_logits() {
        let mut buffer = vec![0u8; 2048];
        let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len()).unwrap();

        let mut pipeline = StreamingFeaturePipeline::new();

        // Phase 1: Warm up with dynamic, high-variance data (NOT static zeros)
        // Simulate realistic volatile market conditions with extreme swings
        for tick in 0..200u64 {
            let phase = (tick as f64) * 0.17;
            let bid = 50000.0 + 5000.0 * phase.sin() + (tick as f64) * 3.7;
            let ask = bid + 0.50 + 2.0 * (phase * 1.3).cos().abs();
            let spread_vel = 100.0 * (phase * 0.7).sin();
            let obi = (phase * 0.5).sin();
            let rtt = 50000.0 + 40000.0 * (phase * 0.3).cos();

            bridge.store_f64(4, bid);
            bridge.store_f64(6, ask);
            bridge.store_f64(3, spread_vel);
            bridge.store_f64(1, obi);
            bridge.store_f64(98, rtt);

            // Populate LOB depth levels dynamically
            for i in 0..20 {
                bridge.store_f64(11 + i * 2, bid - (i as f64) * 0.10 * (1.0 + 0.5 * (phase + i as f64).sin()));
                bridge.store_f64(12 + i * 2, 1.0 + 10.0 * ((phase + i as f64) * 0.3).sin().abs());
                bridge.store_f64(51 + i * 2, ask + (i as f64) * 0.10 * (1.0 + 0.5 * (phase + i as f64).cos()));
                bridge.store_f64(52 + i * 2, 1.0 + 10.0 * ((phase + i as f64) * 0.4).cos().abs());
            }

            let mid = (bid + ask) / 2.0;
            let (feats, _) = pipeline.update_and_normalize_with_snr_asset(&bridge, mid, 0).unwrap();

            // After warmup (tick >= 10), all features must be strictly within (-0.999, 0.999)
            if tick >= 10 {
                for (idx, &f) in feats.iter().enumerate() {
                    assert!(
                        f >= -0.999 && f <= 0.999,
                        "Feature {} at tick {} escaped clamp bound (-0.999, 0.999): {}",
                        idx, tick, f
                    );
                }
            }
        }

        // Phase 2: Feed extreme spike data and verify clamp holds
        bridge.store_f64(4, 1_000_000.0);
        bridge.store_f64(6, 1_000_001.0);
        bridge.store_f64(3, 999_999.0);
        bridge.store_f64(1, 1.0);
        bridge.store_f64(98, 99_999.0);
        let (extreme_feats, _) = pipeline.update_and_normalize_with_snr_asset(&bridge, 1_000_000.5, 0).unwrap();
        for (idx, &f) in extreme_feats.iter().enumerate() {
            assert!(
                f >= -0.999 && f <= 0.999,
                "Feature {} exceeded soft-clip limit on extreme data: {}",
                idx, f
            );
        }
    }

    #[test]
    fn test_quantile_calibration_invariant_centering() {
        let mut conv_hist = VecDeque::with_capacity(2000);

        // Seed with 300 uniformly spaced samples in [0.10, 0.90]
        for i in 0..300 {
            let val = 0.10 + (i as f64 / 300.0) * 0.80;
            // Warm-up will finish at tick 200
            let _ = compute_calibrated_confidence(
                val,
                1.0,
                0.0,
                0.0,
                0.0,
                1.0,
                1.0,
                0.0,
                &mut conv_hist,
            );
        }

        assert_eq!(conv_hist.len(), 300);

        // Test median input (50th percentile) with zero OBI alignment and zero offset
        let median_val = 0.50;
        let conf_median = compute_calibrated_confidence(
            median_val,
            1.0,
            0.0,
            0.0,
            0.0,
            1.0,
            1.0,
            0.0,
            &mut conv_hist,
        );

        // Calibrated confidence at median should be centered at ~0.50 (within ±0.03)
        assert!(
            (conf_median - 0.50).abs() < 0.03,
            "Median input must produce ~0.50 calibrated confidence, got {}",
            conf_median
        );

        // High conviction input (e.g. 0.95, near top) should yield high confidence > 0.60
        let conf_high = compute_calibrated_confidence(
            0.95,
            1.5,
            0.001,
            0.5,
            1.0,
            1.0,
            1.0,
            0.0,
            &mut conv_hist,
        );
        assert!(conf_high > 0.60, "High conviction must exceed 0.60, got {}", conf_high);

        // Low conviction input should yield low confidence < 0.40
        let conf_low = compute_calibrated_confidence(
            0.05,
            0.10,
            0.001,
            -0.5,
            1.0,
            1.0,
            1.0,
            0.0,
            &mut conv_hist,
        );
        assert!(conf_low < 0.40, "Low conviction must be below 0.40, got {}", conf_low);
    }
}
