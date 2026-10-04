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

        // Feature 17: OBI Pressure Ratio (aligns 1:1 with TKAN_FEATURE_NAMES[17])
        let obi_press_ratio = obi * spread;

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

        let trade_vel = sab.load_f64_asset(asset_idx, 3);
        let trade_vel_lag1 = *self.trade_vel_hist.get(0).unwrap_or(&trade_vel);
        let trade_vel_accel = trade_vel - trade_vel_lag1;

        let trade_vel_mean_10 = vec_mean(&self.trade_vel_hist, 10);
        let vpin_proxy_10 = cvd_delta_10.abs() / (trade_vel_mean_10 + 1e-5);

        let trade_vel_mean_50 = vec_mean(&self.trade_vel_hist, 50);
        let vpin_proxy_50 = cvd_delta_50.abs() / (trade_vel_mean_50 + 1e-5);

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
            obi_press_ratio,
            cvd_raw,
            cvd_delta_1,
            cvd_delta_5,
            cvd_delta_10,
            cvd_delta_50,
            cvd_delta_100,
            trade_vel,
            trade_vel_accel,
            vpin_proxy_10,
            vpin_proxy_50,
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
            let val = *raw_features.get(i)
                .ok_or_else(|| Error::Msg(format!("Missing raw_features[{}]", i)))?;
            let head = *self.feature_heads.get(i)
                .ok_or_else(|| Error::Msg(format!("Missing feature_heads[{}]", i)))?;
            let count = *self.feature_lens.get(i)
                .ok_or_else(|| Error::Msg(format!("Missing feature_lens[{}]", i)))?;
            let window_row = self.feature_windows.get_mut(i)
                .ok_or_else(|| Error::Msg(format!("Missing feature_windows[{}]", i)))?;
            let mean_ref = self.feature_means.get_mut(i)
                .ok_or_else(|| Error::Msg(format!("Missing feature_means[{}]", i)))?;
            let m2_ref = self.feature_m2s.get_mut(i)
                .ok_or_else(|| Error::Msg(format!("Missing feature_m2s[{}]", i)))?;
            let lens_ref = self.feature_lens.get_mut(i)
                .ok_or_else(|| Error::Msg(format!("Missing feature_lens[{}]", i)))?;
            let heads_ref = self.feature_heads.get_mut(i)
                .ok_or_else(|| Error::Msg(format!("Missing feature_heads[{}]", i)))?;

            let win_cell = window_row.get_mut(head)
                .ok_or_else(|| Error::Msg(format!("Window head index out of bounds: head={}", head)))?;

            if count < 1000 {
                // Expanding window: Online Welford (1962) recurrence
                let new_count = count + 1;
                *lens_ref = new_count;
                let k = new_count as f64;
                let delta = val - *mean_ref;
                *mean_ref += delta / k;
                let delta2 = val - *mean_ref;
                *m2_ref += delta * delta2;
                *win_cell = val;
                *heads_ref = (head + 1) % 1000;
            } else {
                // Fixed-length sliding window (N = 1000): Welford-West (1979) sliding recurrence
                let old = *win_cell;
                let n = 1000.0;
                let delta = val - old;
                let old_mean = *mean_ref;
                let new_mean = old_mean + delta / n;
                *mean_ref = new_mean;
                // M2 update: M2_new = M2_old + delta * ((val - new_mean) + (old - old_mean))
                let delta_m2 = delta * ((val - new_mean) + (old - old_mean));
                *m2_ref = (*m2_ref + delta_m2).max(0.0);
                *win_cell = val;
                let next_head = (head + 1) % 1000;
                *heads_ref = next_head;

                // Long-term numerical stability: re-center mean and M2 every full buffer cycle
                if next_head == 0 {
                    let mut m = 0.0;
                    let mut m2 = 0.0;
                    for (idx, &x) in window_row.iter().enumerate() {
                        let k = (idx + 1) as f64;
                        let d1 = x - m;
                        m += d1 / k;
                        let d2 = x - m;
                        m2 += d1 * d2;
                    }
                    *mean_ref = m;
                    *m2_ref = m2.max(0.0);
                }
            }

            let count_f = *lens_ref as f64;
            let variance = if count_f > 1.0 {
                *m2_ref / (count_f - 1.0)
            } else {
                0.0
            };
            let std_dev = variance.sqrt();
            let z = if *lens_ref < 5 || std_dev < 1e-6 {
                0.0
            } else {
                (val - *mean_ref) / (std_dev + 1e-8)
            };

            // DEF-R2: Store signed z-scores (NOT absolute z-scores)
            if i == 8 { obi_z = z; }
            if i == 17 { ofi_z = z; }
            if i == 21 { cvd_z = z; }
            if i == 24 { vel_z = z; }
            if i == 27 { hawkes_z = z; }
            if i == 2 { micro_z = z; }

            // Continuous C∞-differentiable soft-clip normalization strictly bounded in (-0.999, 0.999)
            // Uses 0.999 * z.tanh() to preserve gradient continuity
            if let Some(norm_slot) = norm_features.get_mut(i) {
                *norm_slot = 0.999 * z.tanh();
            }
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

fn safe_zero_hidden_tensor(device: &Device) -> Result<Tensor> {
    if let Ok(t) = Tensor::zeros((1, 32), DType::F32, device) {
        return Ok(t);
    }
    if let Ok(t) = Tensor::zeros((1, 32), DType::F32, &Device::Cpu) {
        return Ok(t);
    }
    if let Ok(t) = Tensor::from_slice(&[0.0f32; 32], (1, 32), &Device::Cpu) {
        return Ok(t);
    }
    Tensor::from_vec(vec![0.0f32; 32], (1, 32), &Device::Cpu)
}

impl AIEngine {
    pub fn new() -> Self {
        Self::load_from_file("./models/cfc_weights.safetensors")
    }

    pub fn try_load_from_paths(cfc_path: &str, tkan_path: &str) -> Result<Self> {
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
        let status = weights_engine.status;

        let mamba_dim = weights_engine.mamba.as_ref().map(|m| m.d_inner * m.d_state).unwrap_or(0);
        for _ in 0..num_assets {
            let hs = safe_zero_hidden_tensor(&device)?;
            asset_trackers.push(AssetTelemetryTracker::new());
            feature_pipelines.push(Mutex::new(StreamingFeaturePipeline::new()));
            hidden_states.push(Mutex::new(hs));
            mamba_hidden.push(Mutex::new(vec![0.0f32; mamba_dim]));
        }

        Ok(Self {
            tkan,
            cell: weights_engine.cell,
            mamba: weights_engine.mamba,
            hidden_states: RwLock::new(hidden_states),
            mamba_hidden: RwLock::new(mamba_hidden),
            status,
            calibration_params: weights_engine.calibration_params,
            last_inference_ns: AtomicU64::new(0),
            inference_seq: AtomicU64::new(0),
            ic_tracker: Mutex::new(ICTracker::default_1000()),
            asset_trackers: RwLock::new(asset_trackers),
            feature_pipelines: RwLock::new(feature_pipelines),
        })
    }

    pub fn load_from_paths(cfc_path: &str, tkan_path: &str) -> Self {
        match Self::try_load_from_paths(cfc_path, tkan_path) {
            Ok(engine) => engine,
            Err(e) => {
                eprintln!("[BATBOT_V11][AIEngine] Failed to load engine from paths: {:?}", e);
                let tkan = TKANLayer::load_from_binary_or_default(tkan_path);
                let weights_engine = AiEngine::load_from_file(cfc_path);
                Self {
                    tkan,
                    cell: weights_engine.cell,
                    mamba: weights_engine.mamba,
                    hidden_states: RwLock::new(Vec::new()),
                    mamba_hidden: RwLock::new(Vec::new()),
                    status: AiEngineStatus::Uncalibrated,
                    calibration_params: weights_engine.calibration_params,
                    last_inference_ns: AtomicU64::new(0),
                    inference_seq: AtomicU64::new(0),
                    ic_tracker: Mutex::new(ICTracker::default_1000()),
                    asset_trackers: RwLock::new(Vec::new()),
                    feature_pipelines: RwLock::new(Vec::new()),
                }
            }
        }
    }

    pub fn load_from_file(path: &str) -> Self {
        Self::load_from_paths(path, "./models/tkan_luts.bin")
    }

    pub fn reload_weights(&mut self, path: &str) -> bool {
        let new_engine = Self::load_from_file(path);
        let calibrated = new_engine.is_calibrated();
        if !calibrated {
            return false;
        }
        let Ok(new_hs_vec) = new_engine.hidden_states.into_inner() else {
            return false;
        };
        let Ok(mut hs_vec) = self.hidden_states.write() else {
            return false;
        };

        // Transactional allocation check: ensure all hidden states can be allocated before mutating engine
        while hs_vec.len() < new_hs_vec.len() {
            let hs = match safe_zero_hidden_tensor(&Device::Cpu) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[BATBOT_V11][hot_reload] Failed to allocate hidden tensor during reload: {:?}", e);
                    return false;
                }
            };
            hs_vec.push(Mutex::new(hs));
        }
        for (i, new_hs_mutex) in new_hs_vec.into_iter().enumerate() {
            if let Ok(new_hs) = new_hs_mutex.into_inner() {
                if let Some(hs_mutex) = hs_vec.get(i) {
                    if let Ok(mut hs) = hs_mutex.lock() {
                        *hs = new_hs;
                    }
                }
            }
        }
        self.tkan = new_engine.tkan;
        self.cell = new_engine.cell;
        self.mamba = new_engine.mamba;
        self.status = new_engine.status;
        self.calibration_params = new_engine.calibration_params;
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
            .map_err(|e| Error::Msg(format!("SYSTEM_CLOCK_SKEW_ERROR: {:?}", e)))?
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
            let pipeline_mutex = pipelines_guard.get(asset_idx)
                .ok_or_else(|| Error::Msg(format!("Pipeline missing for asset_idx {}", asset_idx)))?;
            let mut pipeline = pipeline_mutex.lock().unwrap_or_else(|e| e.into_inner());
            pipeline.update_and_normalize_with_snr_asset(sab, lat_us_val, asset_idx)?
        };

        let trackers_guard = self.asset_trackers.read().unwrap_or_else(|e| e.into_inner());
        let tracker = trackers_guard.get(asset_idx)
            .ok_or_else(|| Error::Msg(format!("Tracker missing for asset_idx {}", asset_idx)))?;

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
                            if let Some(slot) = popped_obs.get_mut(num_popped) {
                                *slot = (hist_pred, ret, residual);
                                num_popped += 1;
                            }
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
                            if let Some(slot) = popped_obs.get_mut(num_popped) {
                                *slot = (hist_pred, ret, residual);
                                num_popped += 1;
                            }
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
                            if let Some(slot) = popped_obs.get_mut(num_popped) {
                                *slot = (hist_pred, ret, residual);
                                num_popped += 1;
                            }
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
                    if let Some(&(pred, ret, res)) = popped_obs.get(i) {
                        ic_guard.push_observation_fast(pred, ret, res, start_ns);
                    }
                }
                ic_guard.maybe_recompute_spearman(Some(sab), asset_idx, start_ns);
            }
        }

        let tkan_out = self.tkan.forward(&lob_features);
        if tkan_out.len() < 16 {
            return Err(Error::Msg(format!("TKAN output insufficient: expected 16, got {}", tkan_out.len())));
        }
        let mut tkan_f32 = [0.0f32; 16];
        for i in 0..16 {
            let val = *tkan_out.get(i).ok_or_else(|| Error::Msg(format!("Missing tkan_out[{}]", i)))?;
            if let Some(slot) = tkan_f32.get_mut(i) {
                *slot = val as f32;
            }
        }
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
            let mh_mutex = mh_holder.get(asset_idx)
                .ok_or_else(|| Error::Msg(format!("Mamba hidden state missing for asset_idx {}", asset_idx)))?;
            let mut m_hidden_guard = mh_mutex.lock().unwrap_or_else(|e| e.into_inner());
            if m_hidden_guard.len() != mamba.d_inner * mamba.d_state {
                m_hidden_guard.resize(mamba.d_inner * mamba.d_state, 0.0f32);
            }

            let sab_scale = sab.load_f64_asset(asset_idx, 128);
            let sab_offset = sab.load_f64_asset(asset_idx, 129);
            let sab_temp = sab.load_f64_asset(asset_idx, 127);

            let temp = if sab_temp > 0.05 { sab_temp } else { self.calibration_params.temperature }.clamp(0.5, 5.0);
            let platt_scale = if sab_scale > 0.001 { sab_scale } else { self.calibration_params.platt_scale }.clamp(0.5, 5.0);
            let platt_offset = sab_offset.clamp(-2.0, 2.0);
            let obi = sab.load_f64_asset(asset_idx, 1);
            let ofi = sab.load_f64_asset(asset_idx, 138);
            let hawkes_asym = sab.load_f64_asset(asset_idx, 149);

            // QA-4204 FIX: Capture raw meta_logit from Mamba-2 head 1 for Platt-scaled confidence
            let (dir_raw, meta_logit, horiz_sec) = mamba.forward_and_evaluate_fast(&tkan_f32, &mut *m_hidden_guard, delta_t, temp);

            // DEF-R1: Balanced microstructure logit modulation & SINGLE outer tanh WITHOUT temperature divisor
            let composite_logit = dir_raw + 0.15 * obi + 0.10 * ofi + 0.05 * hawkes_asym;
            let mut dir = composite_logit.tanh();

            // DEF-R2: Signed Directional Concordance Index (SDCI) — INDEPENDENT GATE
            let snr_score = signed_z.compute_sdci(dir_raw);

            // QA-4204 SDCI GATE: If microstructure flow is discordant (SDCI < 0.50),
            // forcefully reject the trade by zeroing direction. This prevents discordant-flow
            // trades independent of the model's confidence.
            if snr_score < 0.50 {
                dir = 0.0;
            }

            // QA-4204 FIX: Platt-scaled meta-logit confidence replaces self-referential percentile rank.
            // conf = sigmoid(platt_scale * meta_logit + platt_offset)
            let conf = compute_platt_confidence(meta_logit, platt_scale, platt_offset);
            (dir, conf, horiz_sec * 1000.0)
        } else if let Some(cell) = &self.cell {
            if asset_idx >= self.hidden_states.read().unwrap_or_else(|e| e.into_inner()).len() {
                let mut hs_write = self.hidden_states.write().unwrap_or_else(|e| e.into_inner());
                while hs_write.len() <= asset_idx {
                    hs_write.push(Mutex::new(safe_zero_hidden_tensor(&Device::Cpu)?));
                }
            }
            let hs_holder = self.hidden_states.read().unwrap_or_else(|e| e.into_inner());
            let hs_mutex = hs_holder.get(asset_idx)
                .ok_or_else(|| Error::Msg(format!("Hidden state missing for asset_idx {}", asset_idx)))?;
            let mut hidden_guard = hs_mutex.lock().unwrap_or_else(|e| e.into_inner());
            let (output_tensor, next_hidden) = cell.forward(&tkan_tensor, &*hidden_guard, delta_t)?;
            *hidden_guard = next_hidden;
            let flat_out = output_tensor.flatten_all()?;
            let num_elems = flat_out.elem_count();
            let raw_direction = if num_elems > 0 { flat_out.get(0)?.to_scalar::<f32>()? as f64 } else { 0.0 };
            let horiz_ms = if num_elems > 2 { flat_out.get(2)?.to_scalar::<f32>()? as f64 } else { 100.0 };

            let mut dir = raw_direction.tanh();

            // CfC path: SDCI independent gate
            let snr_score = signed_z.compute_sdci(raw_direction);
            if snr_score < 0.50 {
                dir = 0.0;
            }

            // CfC model has no native meta-logit head — use neutral confidence 0.50
            let conf = 0.50;
            (dir, conf, horiz_ms)
        } else {
            return Ok(());
        };

        let direction_magnitude = direction.abs();

        let end_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(start_ns);
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

    pub fn evaluate_features(&self, features: &[f64; 40]) -> Result<(f64, f64)> {
        let tkan_out = self.tkan.forward(features);
        if tkan_out.len() < 16 {
            return Err(Error::Msg(format!("TKAN output insufficient: expected 16, got {}", tkan_out.len())));
        }
        let mut tkan_f32 = [0.0f32; 16];
        for i in 0..16 {
            let val = *tkan_out.get(i).ok_or_else(|| Error::Msg(format!("Missing tkan_out[{}]", i)))?;
            if let Some(slot) = tkan_f32.get_mut(i) {
                *slot = val as f32;
            }
        }
        let tkan_tensor = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu)?;
        let hs_holder = self.hidden_states.read().unwrap_or_else(|e| e.into_inner());
        let hs_mutex = hs_holder.get(0).ok_or_else(|| Error::Msg("Hidden state[0] missing".to_string()))?;
        let mut hidden_guard = hs_mutex.lock().unwrap_or_else(|e| e.into_inner());

        let signed_z = SignedZScores {
            obi_z: *features.get(8).ok_or_else(|| Error::Msg("Missing feature[8] for obi_z".to_string()))?,
            ofi_z: *features.get(17).ok_or_else(|| Error::Msg("Missing feature[17] for ofi_z".to_string()))?,
            cvd_z: *features.get(21).ok_or_else(|| Error::Msg("Missing feature[21] for cvd_z".to_string()))?,
            vel_z: *features.get(24).ok_or_else(|| Error::Msg("Missing feature[24] for vel_z".to_string()))?,
            hawkes_z: *features.get(27).ok_or_else(|| Error::Msg("Missing feature[27] for hawkes_z".to_string()))?,
            micro_z: *features.get(2).ok_or_else(|| Error::Msg("Missing feature[2] for micro_z".to_string()))?,
        };
        if let Some(mamba) = &self.mamba {
            let mh_holder = self.mamba_hidden.read().unwrap_or_else(|e| e.into_inner());
            let mh_mutex = mh_holder.get(0).ok_or_else(|| Error::Msg("Mamba hidden[0] missing".to_string()))?;
            let mut m_hidden_guard = mh_mutex.lock().unwrap_or_else(|e| e.into_inner());
            if m_hidden_guard.len() != mamba.d_inner * mamba.d_state {
                m_hidden_guard.resize(mamba.d_inner * mamba.d_state, 0.0f32);
            }
            let temp = self.calibration_params.temperature.clamp(0.5, 5.0);
            // QA-4204 FIX: Capture raw meta_logit for Platt-scaled confidence
            let (dir_raw, meta_logit, _) = mamba.forward_and_evaluate_fast(&tkan_f32, &mut *m_hidden_guard, 0.001, temp);
            let obi = *features.get(8).ok_or_else(|| Error::Msg("Missing feature[8] for obi".to_string()))?;
            let ofi = *features.get(17).ok_or_else(|| Error::Msg("Missing feature[17] for ofi".to_string()))?;
            let hawkes_asym = *features.get(27).ok_or_else(|| Error::Msg("Missing feature[27] for hawkes_asym".to_string()))?;
            let composite_logit = dir_raw + 0.15 * obi + 0.10 * ofi + 0.05 * hawkes_asym;
            let mut dir = composite_logit.tanh();
            // SDCI independent gate
            let snr_score = signed_z.compute_sdci(dir_raw);
            if snr_score < 0.50 {
                dir = 0.0;
            }
            let conf = compute_platt_confidence(
                meta_logit,
                self.calibration_params.platt_scale,
                self.calibration_params.platt_offset,
            );
            return Ok((dir, conf));
        } else if let Some(cell) = &self.cell {
            let (output_tensor, next_h) = cell.forward(&tkan_tensor, &*hidden_guard, 0.001)?;
            *hidden_guard = next_h;
            let flat = output_tensor.flatten_all()?;
            let raw_scalar = flat.get(0)?.to_scalar::<f32>()?;
            let mut raw_dir = (raw_scalar as f64).tanh();
            // CfC path: SDCI independent gate
            let snr_score = signed_z.compute_sdci(raw_dir);
            if snr_score < 0.50 {
                raw_dir = 0.0;
            }
            // CfC model has no native meta-logit head — use neutral confidence 0.50
            let conf = 0.50;
            return Ok((raw_dir, conf));
        }
        Err(Error::Msg("No active model (Mamba or CfC cell) calibrated".to_string()))
    }

    pub fn run_shadow_inference(&self, sab: &AtomicSharedMemoryBridge) -> Result<(f64, f64, f64, u64, f64)> {
        let timer_start = std::time::Instant::now();

        let best_bid = sab.load_f64_asset(0, 4);
        let best_ask = sab.load_f64_asset(0, 6);
        if best_bid <= 0.0 || best_ask <= 0.0 {
            return Err(Error::Msg("ORDERBOOK_COLLAPSE_DETECTED".to_string()));
        }

        let lat_us_val = sab.load_f64_asset(0, 98) * 1000.0;
        let (lob_features, signed_z) = {
            let pipelines = self.feature_pipelines.read().unwrap_or_else(|e| e.into_inner());
            let pipeline_mutex = pipelines.get(0)
                .ok_or_else(|| Error::Msg("Pipeline[0] missing for shadow inference".to_string()))?;
            let mut pipeline = pipeline_mutex.lock().unwrap_or_else(|e| e.into_inner());
            pipeline.update_and_normalize_with_snr_asset(sab, lat_us_val, 0)?
        };

        let (direction, confidence, horizon_ms, hidden_norm) = if let Some(mamba) = &self.mamba {
            let mh_holder = self.mamba_hidden.read().unwrap_or_else(|e| e.into_inner());
            let mh_mutex = mh_holder.get(0)
                .ok_or_else(|| Error::Msg("Mamba hidden[0] missing for shadow inference".to_string()))?;
            let mut m_hidden_guard = mh_mutex.lock().unwrap_or_else(|e| e.into_inner());
            if m_hidden_guard.len() != mamba.d_inner * mamba.d_state {
                m_hidden_guard.resize(mamba.d_inner * mamba.d_state, 0.0f32);
            }
            let temp = self.calibration_params.temperature.clamp(0.5, 5.0);

            let tkan_out = self.tkan.forward(&lob_features);
            if tkan_out.len() < 16 {
                return Err(Error::Msg(format!("TKAN output insufficient: expected 16, got {}", tkan_out.len())));
            }
            let mut tkan_f32 = [0.0f32; 16];
            for i in 0..16 {
                let val = *tkan_out.get(i).ok_or_else(|| Error::Msg(format!("Missing tkan_out[{}]", i)))?;
                if let Some(slot) = tkan_f32.get_mut(i) {
                    *slot = val as f32;
                }
            }
            // QA-4204 FIX: Capture raw meta_logit for Platt-scaled confidence
            let (dir_raw, meta_logit, horiz_sec) = mamba.forward_and_evaluate_fast(&tkan_f32, &mut *m_hidden_guard, 0.001, temp);

            let norm = m_hidden_guard.iter().map(|v| v * v).sum::<f32>().sqrt() as f64;
            let obi = sab.load_f64_asset(0, 1);
            let ofi = sab.load_f64_asset(0, 138);
            let hawkes_asym = sab.load_f64_asset(0, 149);
            let composite_logit = dir_raw + 0.15 * obi + 0.10 * ofi + 0.05 * hawkes_asym;
            let mut dir = composite_logit.tanh();

            // SDCI independent gate
            let snr_score = signed_z.compute_sdci(dir_raw);
            if snr_score < 0.50 {
                dir = 0.0;
            }

            let conf = compute_platt_confidence(
                meta_logit,
                self.calibration_params.platt_scale,
                self.calibration_params.platt_offset,
            );
            (dir, conf, horiz_sec * 1000.0, norm)
        } else if let Some(cell) = &self.cell {
            let hs_holder = self.hidden_states.read().unwrap_or_else(|e| e.into_inner());
            let hs_mutex = hs_holder.get(0)
                .ok_or_else(|| Error::Msg("Hidden state[0] missing for shadow CfC inference".to_string()))?;
            let mut hidden_guard = hs_mutex.lock().unwrap_or_else(|e| e.into_inner());

            let tkan_out = self.tkan.forward(&lob_features);
            if tkan_out.len() < 16 {
                return Err(Error::Msg(format!("TKAN output insufficient: expected 16, got {}", tkan_out.len())));
            }
            let mut tkan_f32 = [0.0f32; 16];
            for i in 0..16 {
                let val = *tkan_out.get(i).ok_or_else(|| Error::Msg(format!("Missing tkan_out[{}]", i)))?;
                if let Some(slot) = tkan_f32.get_mut(i) {
                    *slot = val as f32;
                }
            }
            let tkan_tensor = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu)?;
            let (output_tensor, next_h) = cell.forward(&tkan_tensor, &*hidden_guard, 0.001)?;

            let norm = next_h.sqr()?.sum_all()?.to_scalar::<f32>()?.sqrt() as f64;
            *hidden_guard = next_h;
            let flat_out = output_tensor.flatten_all()?;
            let raw_dir = flat_out.get(0)?.to_scalar::<f32>()? as f64;
            let horiz = if flat_out.elem_count() > 2 { flat_out.get(2)?.to_scalar::<f32>()? as f64 } else { 100.0 };
            let mut dir = raw_dir.tanh();
            // CfC path: SDCI independent gate
            let snr_score = signed_z.compute_sdci(raw_dir);
            if snr_score < 0.50 {
                dir = 0.0;
            }
            // CfC model has no native meta-logit head — neutral confidence 0.50
            let conf = 0.50;
            (dir, conf, horiz, norm)
        } else {
            return Err(Error::Msg("UNCALIBRATED".to_string()));
        };

        let latency_ns = timer_start.elapsed().as_nanos() as u64;
        #[cfg(test)]
        println!("[STEP 5 PROOF] Full Pipeline Latency (Features + DNN + Assembly + Calib): {} ns", latency_ns);

        Ok((direction, confidence, horizon_ms, latency_ns, hidden_norm))
    }

    pub fn inherit_hidden_state(&self, other: &AIEngine) -> Result<()> {
        let other_guard = other.hidden_states.read().unwrap_or_else(|e| e.into_inner());
        let mut self_guard = self.hidden_states.write().unwrap_or_else(|e| e.into_inner());
        while self_guard.len() < other_guard.len() {
            let hs = safe_zero_hidden_tensor(&Device::Cpu)?;
            self_guard.push(Mutex::new(hs));
        }
        for (i, other_mutex) in other_guard.iter().enumerate() {
            if let Ok(other_hs) = other_mutex.lock() {
                if let Some(self_hs_mutex) = self_guard.get(i) {
                    if let Ok(mut self_hs) = self_hs_mutex.lock() {
                        *self_hs = other_hs.clone();
                    }
                }
            }
        }
        let other_mh = other.mamba_hidden.read().unwrap_or_else(|e| e.into_inner());
        let mut self_mh = self.mamba_hidden.write().unwrap_or_else(|e| e.into_inner());
        while self_mh.len() < other_mh.len() {
            let next_idx = self_mh.len();
            let state_len = other_mh.get(next_idx)
                .and_then(|mutex| mutex.lock().ok())
                .map(|val| val.len())
                .or_else(|| self.mamba.as_ref().map(|m| m.d_inner * m.d_state))
                .or_else(|| other.mamba.as_ref().map(|m| m.d_inner * m.d_state))
                .ok_or_else(|| Error::Msg(format!("Cannot determine dynamic state length for Mamba slot {}", next_idx)))?;
            self_mh.push(Mutex::new(vec![0.0f32; state_len]));
        }
        for (i, other_mutex) in other_mh.iter().enumerate() {
            if let Ok(other_val) = other_mutex.lock() {
                if let Some(self_mh_mutex) = self_mh.get(i) {
                    if let Ok(mut self_val) = self_mh_mutex.lock() {
                        *self_val = other_val.clone();
                    }
                }
            }
        }
        Ok(())
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
                if let Some(self_pipe_mutex) = self_pipes.get(i) {
                    if let Ok(mut self_pipe) = self_pipe_mutex.lock() {
                        *self_pipe = other_pipe.clone();
                    }
                }
            }
        }

        if let Ok(other_ic) = other.ic_tracker.lock() {
            if let Ok(mut self_ic) = self.ic_tracker.lock() {
                *self_ic = other_ic.clone();
                // CRITICAL: Reset drift state on the inherited tracker to prevent
                // new models from instantly re-latching to MODEL_BROKEN due to
                // stale CUSUM accumulators and is_drifted flags from the old model.
                if let Ok(d) = SystemTime::now().duration_since(UNIX_EPOCH) {
                    let now_ns = d.as_nanos() as u64;
                    self_ic.cusum.reset();
                    self_ic.record_recalibration(now_ns);
                } else {
                    eprintln!("[BATBOT_V11][inherit_telemetry] SystemTime clock skew detected; resetting CUSUM without recalibration timestamp");
                    self_ic.cusum.reset();
                }
            }
        }
    }
}

/// QA-4204 FIX: Platt-Scaled Meta-Logit Confidence
/// Directly applies standard Platt scaling to the model's native meta-logit output.
/// conf = sigmoid(platt_scale * meta_logit + platt_offset)
///
/// This replaces the mathematically flawed self-referential percentile rank confidence
/// that computed `effective_conviction = direction_magnitude * snr_score * psi_vol`
/// and then ranked it against its own 2000-sample rolling history.
/// The meta-logit is trained with focal loss on the meta-label target ("significant move")
/// and represents the model's genuine probabilistic assessment of trade significance.
#[inline(always)]
pub fn compute_platt_confidence(
    meta_logit: f64,
    platt_scale: f64,
    platt_offset: f64,
) -> f64 {
    let s = platt_scale.clamp(0.1, 10.0);
    let calibrated_logit = (s * meta_logit + platt_offset).clamp(-60.0, 60.0);
    let sig = 1.0 / (1.0 + (-calibrated_logit).exp());
    sig.clamp(1e-7, 1.0 - 1e-7)
}

impl Default for AIEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_bridge(buf: &mut [u8]) -> Result<AtomicSharedMemoryBridge> {
        match AtomicSharedMemoryBridge::new(buf.as_mut_ptr(), buf.len()) {
            Ok(b) => Ok(b),
            Err(e) => Err(Error::Msg(e.to_string())),
        }
    }

    #[test]
    fn test_ai_engine_uncalibrated_graceful_inference() -> Result<()> {
        let engine = AIEngine::load_from_file("./models/non_existent_weights.safetensors");
        let mut buffer = vec![0u8; 2048];
        let bridge = create_test_bridge(&mut buffer)?;

        let res = engine.run_inference(&bridge);
        assert!(res.is_ok());
        assert!(!engine.is_calibrated());
        Ok(())
    }

    #[test]
    fn test_reload_weights() {
        let mut engine = AIEngine::new();
        assert!(!engine.reload_weights("./models/non_existent_weights.safetensors"));
    }

    #[test]
    fn test_orderbook_collapse_detection() -> Result<()> {
        let mut engine = AIEngine::new();
        engine.status = AiEngineStatus::Calibrated;
        let dev = Device::Cpu;
        let c0 = Tensor::zeros((48, 32), DType::F32, &dev)?;
        let c1 = Tensor::zeros((32,), DType::F32, &dev)?;
        let c2 = Tensor::zeros((48, 32), DType::F32, &dev)?;
        let c3 = Tensor::zeros((32,), DType::F32, &dev)?;
        let c4 = Tensor::zeros((32, 1), DType::F32, &dev)?;
        let c5 = Tensor::zeros((1,), DType::F32, &dev)?;
        let cell = CfCCell::new(c0, c1, c2, c3, c4, c5);
        engine.cell = Some(cell);
        let mut buffer = vec![0u8; 2048];
        let bridge = create_test_bridge(&mut buffer)?;

        let res = engine.run_inference(&bridge);
        assert!(res.is_err());
        let err_str = match res {
            Err(e) => e.to_string(),
            Ok(_) => String::new(),
        };
        assert!(err_str.contains("ORDERBOOK_COLLAPSE_DETECTED"));
        Ok(())
    }

    #[test]
    fn test_streaming_feature_pipeline_normalization() -> Result<()> {
        let mut buffer = vec![0u8; 2048];
        let bridge = create_test_bridge(&mut buffer)?;
        bridge.store_f64(4, 50000.0);
        bridge.store_f64(5, 1.5);
        bridge.store_f64(6, 50001.0);
        bridge.store_f64(7, 2.5);

        let mut pipeline = StreamingFeaturePipeline::new();
        let features = pipeline.update_and_normalize(&bridge, 150.0)?;
        assert_eq!(features.len(), 40);
        for f in features.iter() {
            assert!(*f >= -1.0 && *f <= 1.0);
        }
        Ok(())
    }

    #[test]
    fn test_mamba2_inference_dispatch() -> Result<()> {
        let mut engine = AIEngine::new();
        let dev = Device::Cpu;
        let mamba = Mamba2Cell::default_cell(16, 32, 16, &dev)?;
        engine.mamba = Some(mamba);
        engine.status = AiEngineStatus::Calibrated;

        let mut buffer = vec![0u8; 2048];
        let bridge = create_test_bridge(&mut buffer)?;
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
        Ok(())
    }

    #[test]
    fn test_live_weights_inference() -> Result<()> {
        let engine = AIEngine::load_from_paths("./models/cfc_weights.safetensors", "./models/tkan_luts.bin");
        println!("Loaded engine calibrated: {}", engine.is_calibrated());
        if let Some(mamba) = &engine.mamba {
            if let Ok(b_heads) = mamba.b_heads.to_vec1::<f32>() {
                println!("b_heads: {:?}", b_heads);
            }
            if let Ok(b_out) = mamba.b_out.to_vec1::<f32>() {
                println!("b_out (first 10): {:?}", b_out.get(0..10.min(b_out.len())).unwrap_or_default());
            }
            if let Ok(w_heads_t) = mamba.w_heads.t() {
                if let Ok(w_head_0) = w_heads_t.get(0) {
                    if let Ok(w_heads_col0) = w_head_0.to_vec1::<f32>() {
                        println!("w_heads col 0 (dir) sum: {:.4}, mean: {:.4}, vals: {:?}",
                            w_heads_col0.iter().sum::<f32>(),
                            w_heads_col0.iter().sum::<f32>() / w_heads_col0.len() as f32,
                            w_heads_col0.get(0..10.min(w_heads_col0.len())).unwrap_or_default()
                        );
                    }
                }
            }
            if let Ok(w_out_flat_t) = mamba.w_out.flatten_all() {
                if let Ok(w_out_flat) = w_out_flat_t.to_vec1::<f32>() {
                    println!("w_out sum: {:.4}, mean: {:.4}, min: {:.4}, max: {:.4}",
                        w_out_flat.iter().sum::<f32>(),
                        w_out_flat.iter().sum::<f32>() / w_out_flat.len() as f32,
                        w_out_flat.iter().cloned().fold(f32::INFINITY, f32::min),
                        w_out_flat.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
                    );
                }
            }
        }
        let mut buffer = vec![0u8; 4096];
        let bridge = create_test_bridge(&mut buffer)?;
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
        let bull_dir = bridge.load_f64(93);
        let bull_conf = bridge.load_f64(94);
        assert!(bull_dir.is_finite(), "bull_dir must be finite");
        assert!(bull_conf.is_finite() && bull_conf >= 0.0 && bull_conf <= 1.0, "bull_conf must be in [0, 1]");

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
        let bear_dir = bridge.load_f64(93);
        let bear_conf = bridge.load_f64(94);
        assert!(bear_dir.is_finite(), "bear_dir must be finite");
        assert!(bear_conf.is_finite() && bear_conf >= 0.0 && bear_conf <= 1.0, "bear_conf must be in [0, 1]");
        assert!(
            bull_dir > bear_dir,
            "Bullish stream direction ({:.4}) must be greater than bearish stream direction ({:.4})",
            bull_dir, bear_dir
        );

        Ok(())
    }

    #[test]
    fn test_inference_latency_benchmark() -> Result<()> {
        let engine = AIEngine::load_from_paths("./models/cfc_weights.safetensors", "./models/tkan_luts.bin");
        assert!(engine.is_calibrated(), "AIEngine must be calibrated with valid model weights for physical benchmark");
        let mut buffer = vec![0u8; 4096];
        let bridge = create_test_bridge(&mut buffer)?;
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

        // Execute full pipeline shadow inference to physically verify Gate 4 latency SLA and emit forced telemetry proof
        let (_, _, _, shadow_latency_ns, _) = match engine.run_shadow_inference(&bridge) {
            Ok(res) => res,
            Err(e) => {
                eprintln!("[Test] Shadow inference pipeline failed: {:?}", e);
                return Err(e);
            }
        };
        assert!(shadow_latency_ns < 200_000, "Full pipeline shadow latency must be < 200,000 ns (200 µs), got {} ns", shadow_latency_ns);
        Ok(())
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
    fn test_platt_confidence_calibration() {
        // QA-4204: Platt-scaled confidence directly from model's meta-logit.
        // No rolling history, no percentile rank, no warmup needed.

        // Zero meta_logit with zero offset → sigmoid(0) = 0.50
        let conf_zero = compute_platt_confidence(0.0, 1.0, 0.0);
        assert!(
            (conf_zero - 0.50).abs() < 1e-6,
            "Zero meta_logit must produce 0.50 confidence, got {}",
            conf_zero
        );

        // Positive meta_logit → confidence > 0.50
        let conf_pos = compute_platt_confidence(1.0, 1.0, 0.0);
        assert!(
            conf_pos > 0.50 && conf_pos < 1.0,
            "Positive meta_logit must yield confidence > 0.50, got {}",
            conf_pos
        );
        // sigmoid(1.0) ≈ 0.7311
        assert!(
            (conf_pos - 0.7311).abs() < 0.001,
            "sigmoid(1.0) ≈ 0.7311, got {}",
            conf_pos
        );

        // Negative meta_logit → confidence < 0.50
        let conf_neg = compute_platt_confidence(-1.0, 1.0, 0.0);
        assert!(
            conf_neg < 0.50 && conf_neg > 0.0,
            "Negative meta_logit must yield confidence < 0.50, got {}",
            conf_neg
        );

        // Platt scale amplifies: higher scale → more extreme confidence
        let conf_high_scale = compute_platt_confidence(1.0, 3.0, 0.0);
        assert!(
            conf_high_scale > conf_pos,
            "Higher platt_scale must amplify confidence: {} > {}",
            conf_high_scale, conf_pos
        );

        // Platt offset shifts the decision boundary
        let conf_with_offset = compute_platt_confidence(0.0, 1.0, 1.0);
        assert!(
            conf_with_offset > 0.50,
            "Positive offset must shift confidence above 0.50 at zero logit, got {}",
            conf_with_offset
        );

        // All outputs must be strictly in (0, 1)
        let conf_extreme_pos = compute_platt_confidence(100.0, 10.0, 0.0);
        let conf_extreme_neg = compute_platt_confidence(-100.0, 10.0, 0.0);
        assert!(conf_extreme_pos > 0.0 && conf_extreme_pos < 1.0);
        assert!(conf_extreme_neg > 0.0 && conf_extreme_neg < 1.0);
    }

    #[test]
    fn test_rcu_telemetry_history_inheritance() {
        let engine_old = AIEngine::new();
        // Seed engine_old with telemetry data (horizon history + atomic prices)
        {
            let trackers = engine_old.asset_trackers.read().unwrap_or_else(|e| e.into_inner());
            if let Some(tracker) = trackers.get(0) {
                if let Ok(mut h5) = tracker.horizon_5s.lock() {
                    h5.push_back((1000, 50000.0, 0.5));
                }
                tracker.last_mid_price.store(50000.0f64.to_bits(), Ordering::Relaxed);
            }
        }

        let engine_new = AIEngine::new();
        engine_new.inherit_telemetry_history(&engine_old);

        // Verify telemetry was inherited perfectly
        {
            let trackers_new = engine_new.asset_trackers.read().unwrap_or_else(|e| e.into_inner());
            if let Some(tracker_new) = trackers_new.get(0) {
                if let Ok(h5_new) = tracker_new.horizon_5s.lock() {
                    assert_eq!(h5_new.len(), 1);
                    assert_eq!(h5_new.get(0).map(|item| item.1), Some(50000.0));
                }

                assert_eq!(
                    f64::from_bits(tracker_new.last_mid_price.load(Ordering::Relaxed)),
                    50000.0
                );
            }
        }
    }

    #[test]
    fn test_feature_normalization_bounds_and_logits() -> Result<()> {
        let mut buffer = vec![0u8; 2048];
        let bridge = create_test_bridge(&mut buffer)?;

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
            let (feats, _) = pipeline.update_and_normalize_with_snr_asset(&bridge, mid, 0)?;

            // After warmup (tick >= 10), all features must be strictly within (-0.999, 0.999)
            if tick >= 10 {
                for (idx, &f) in feats.iter().enumerate() {
                    assert!(
                        f >= -0.999 && f <= 0.999,
                        "Feature {} at tick {} escaped soft-clip bound (-0.999, 0.999): {}",
                        idx, tick, f
                    );
                }
            }
        }

        // Phase 2: Feed extreme spike data and verify soft-clip holds
        bridge.store_f64(4, 1_000_000.0);
        bridge.store_f64(6, 1_000_001.0);
        bridge.store_f64(3, 999_999.0);
        bridge.store_f64(1, 1.0);
        bridge.store_f64(98, 99_999.0);
        let (extreme_feats, _) = pipeline.update_and_normalize_with_snr_asset(&bridge, 1_000_000.5, 0)?;
        for (idx, &f) in extreme_feats.iter().enumerate() {
            assert!(
                f >= -0.999 && f <= 0.999,
                "Feature {} exceeded soft-clip limit on extreme data: {}",
                idx, f
            );
        }
        Ok(())
    }

    #[test]
    fn test_platt_confidence_mathematical_properties() {
        // QA-4204: Verify mathematical correctness of Platt-scaled meta-logit confidence

        // Property 1: Monotonicity — higher meta_logit → higher confidence
        let conf_low = compute_platt_confidence(-2.0, 1.0, 0.0);
        let conf_mid = compute_platt_confidence(0.0, 1.0, 0.0);
        let conf_high = compute_platt_confidence(2.0, 1.0, 0.0);
        assert!(conf_low < conf_mid, "Monotonicity violated: {} < {}", conf_low, conf_mid);
        assert!(conf_mid < conf_high, "Monotonicity violated: {} < {}", conf_mid, conf_high);

        // Property 2: Symmetry — sigmoid(-x) = 1 - sigmoid(x)
        let conf_pos = compute_platt_confidence(1.5, 1.0, 0.0);
        let conf_neg = compute_platt_confidence(-1.5, 1.0, 0.0);
        assert!(
            (conf_pos + conf_neg - 1.0).abs() < 1e-10,
            "Symmetry violated: sigmoid(1.5) + sigmoid(-1.5) must equal 1.0, got {} + {} = {}",
            conf_pos, conf_neg, conf_pos + conf_neg
        );

        // Property 3: Scale clamping — platt_scale is clamped to [0.1, 10.0]
        let conf_tiny_scale = compute_platt_confidence(1.0, 0.001, 0.0);
        let conf_min_scale = compute_platt_confidence(1.0, 0.1, 0.0);
        assert!(
            (conf_tiny_scale - conf_min_scale).abs() < 1e-10,
            "Scale below 0.1 must clamp to 0.1"
        );

        // Property 4: Offset effectively shifts decision boundary
        // With offset = +2.0, even a zero meta_logit should have high confidence
        let conf_offset_pos = compute_platt_confidence(0.0, 1.0, 2.0);
        assert!(
            conf_offset_pos > 0.80,
            "Positive offset of 2.0 at zero logit must produce high confidence, got {}",
            conf_offset_pos
        );
        // sigmoid(2.0) ≈ 0.8808
        assert!(
            (conf_offset_pos - 0.8808).abs() < 0.001,
            "sigmoid(2.0) ≈ 0.8808, got {}",
            conf_offset_pos
        );

        // Property 5: Large negative meta_logit → low confidence < 0.10
        let conf_very_low = compute_platt_confidence(-5.0, 1.0, 0.0);
        assert!(conf_very_low < 0.01, "Large negative meta_logit must produce very low confidence, got {}", conf_very_low);
    }
}
