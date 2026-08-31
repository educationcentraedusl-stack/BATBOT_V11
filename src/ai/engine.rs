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
    let mean = vec_mean(v, count);
    let variance: f64 = v.iter().take(count).map(|x| (x - mean).powi(2)).sum::<f64>() / (count as f64);
    variance.sqrt()
}

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

    feature_windows: Vec<VecDeque<f64>>,
    feature_sums: [f64; 40],
    feature_sum_sqs: [f64; 40],
}

impl StreamingFeaturePipeline {
    pub fn new() -> Self {
        let mut feature_windows = Vec::with_capacity(40);
        for _ in 0..40 {
            feature_windows.push(VecDeque::with_capacity(1000));
        }
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
            feature_windows,
            feature_sums: [0.0; 40],
            feature_sum_sqs: [0.0; 40],
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

    pub fn update_and_normalize_with_snr_asset(
        &mut self,
        sab: &AtomicSharedMemoryBridge,
        lat_us_val: f64,
        asset_idx: usize,
    ) -> Result<([f64; 40], f64)> {
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
            let window = &mut self.feature_windows[i];
            if window.len() == 1000 {
                if let Some(old) = window.pop_back() {
                    self.feature_sums[i] -= old;
                    self.feature_sum_sqs[i] -= old * old;
                }
            }
            window.push_front(val);
            self.feature_sums[i] += val;
            self.feature_sum_sqs[i] += val * val;

            let count = window.len() as f64;
            let mean = self.feature_sums[i] / count;
            let variance = (self.feature_sum_sqs[i] / count - mean * mean).max(0.0);
            let std_dev = variance.sqrt();
            let z = (val - mean) / (std_dev + 1e-8);

            if i == 8 { obi_z = z.abs(); }
            if i == 17 { ofi_z = z.abs(); }
            if i == 21 { cvd_z = z.abs(); }
            if i == 24 { vel_z = z.abs(); }
            if i == 27 { hawkes_z = z.abs(); }
            if i == 2 { micro_z = z.abs(); }

            norm_features[i] = (z / 3.0).tanh();
        }

        let snr_score = 1.0 + 0.5 * (obi_z + 0.8 * cvd_z + 0.5 * vel_z + 0.5 * micro_z + 0.6 * ofi_z + 0.6 * hawkes_z).min(8.0);

        Ok((norm_features, snr_score))
    }
}

#[derive(Debug)]
pub struct AssetTelemetryTracker {
    pub last_mid_price: AtomicU64,
    pub last_prediction_dir: AtomicU64,
    pub horizon_history: Mutex<VecDeque<(u64, f64, f64)>>, // (timestamp_ns, mid_price, prediction)
}

impl AssetTelemetryTracker {
    pub fn new() -> Self {
        Self {
            last_mid_price: AtomicU64::new(0.0f64.to_bits()),
            last_prediction_dir: AtomicU64::new(0.0f64.to_bits()),
            horizon_history: Mutex::new(VecDeque::with_capacity(36_000)),
        }
    }
}

pub struct AIEngine {
    pub tkan: TKANLayer,
    pub cell: Option<CfCCell>,
    pub mamba: Option<Mamba2Cell>,
    pub hidden_states: RwLock<Vec<Mutex<Tensor>>>,
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

        for _ in 0..num_assets {
            asset_trackers.push(AssetTelemetryTracker::new());
            feature_pipelines.push(Mutex::new(StreamingFeaturePipeline::new()));
            let hs = Tensor::zeros((1, 32), DType::F32, &device)
                .unwrap_or_else(|_| Tensor::zeros((1, 32), DType::F32, &Device::Cpu).unwrap());
            hidden_states.push(Mutex::new(hs));
        }

        Self {
            tkan,
            cell: weights_engine.cell,
            mamba: weights_engine.mamba,
            hidden_states: RwLock::new(hidden_states),
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
        {
            let pipelines = self.feature_pipelines.read().unwrap_or_else(|e| e.into_inner());
            if asset_idx >= pipelines.len() {
                drop(pipelines);
                let mut pipelines_mut = self.feature_pipelines.write().unwrap_or_else(|e| e.into_inner());
                while pipelines_mut.len() <= asset_idx {
                    pipelines_mut.push(Mutex::new(StreamingFeaturePipeline::new()));
                }
            }
        }

        let (lob_features, snr_score) = {
            let pipelines = self.feature_pipelines.read().unwrap_or_else(|e| e.into_inner());
            let mut pipeline = pipelines[asset_idx].lock().unwrap_or_else(|e| e.into_inner());
            pipeline.update_and_normalize_with_snr_asset(sab, lat_us_val, asset_idx)?
        };

        // SOTA Tactical Alpha Horizon Alignment (60.0s observation evaluation):
        let matured_entries = {
            let trackers = self.asset_trackers.read().unwrap_or_else(|e| e.into_inner());
            if asset_idx < trackers.len() {
                if let Ok(mut hist) = trackers[asset_idx].horizon_history.lock() {
                    let horizon_ns = 60_000_000_000u64; // 60.0 seconds tactical horizon
                    let mut entries = Vec::new();
                    while let Some(front) = hist.front() {
                        if start_ns.saturating_sub(front.0) >= horizon_ns {
                            if let Some(item) = hist.pop_front() {
                                entries.push(item);
                            }
                            if entries.len() >= 10 {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    entries
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        };

        let gk_vol = sab.load_f64_asset(asset_idx, 121).max(0.0005);
        let horizon_vol = gk_vol * (60.0f64 / 5.0).sqrt(); // Scale 60s tactical vol

        for (_, hist_mid, hist_pred) in matured_entries {
            if hist_mid > 0.0 && current_mid > 0.0 && hist_pred != 0.0 {
                let realized_horizon_return = (current_mid - hist_mid) / hist_mid;
                let return_target = (realized_horizon_return / (2.0 * horizon_vol + 1e-6)).tanh();
                let residual = return_target - hist_pred;
                if let Ok(mut tracker) = self.ic_tracker.lock() {
                    tracker.add_observation_asset(hist_pred, realized_horizon_return, Some(sab), asset_idx);
                    tracker.update_cusum_residual(residual, start_ns, Some(sab), asset_idx);
                }
            }
        }

        let tkan_out = self.tkan.forward(&lob_features);
        let tkan_f32: [f32; 16] = std::array::from_fn(|i| tkan_out[i] as f32);
        let tkan_tensor = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu)?;

        let prev_ns = self.last_inference_ns.swap(start_ns, Ordering::Relaxed);
        let delta_t = if prev_ns == 0 {
            0.001
        } else {
            ((start_ns.saturating_sub(prev_ns) as f64) / 1e9).max(0.0001)
        };

        // Auto-expand hidden states dynamically if asset_idx exceeds current capacity
        {
            let hs_read = self.hidden_states.read().unwrap_or_else(|e| e.into_inner());
            if asset_idx >= hs_read.len() {
                drop(hs_read);
                let mut hs_write = self.hidden_states.write().unwrap_or_else(|e| e.into_inner());
                while hs_write.len() <= asset_idx {
                    hs_write.push(Mutex::new(Tensor::zeros((1, 32), DType::F32, &Device::Cpu).unwrap()));
                }
            }
        }

        let hs_holder = self.hidden_states.read().unwrap_or_else(|e| e.into_inner());
        let mut hidden_guard = hs_holder[asset_idx].lock().unwrap_or_else(|e| e.into_inner());

        let (direction, confidence, horizon_ms) = if let Some(mamba) = &self.mamba {
            if hidden_guard.dims() != &[1, mamba.d_inner, mamba.d_state] {
                *hidden_guard = Tensor::zeros((1, mamba.d_inner, mamba.d_state), DType::F32, &Device::Cpu)?;
            }
            let (heads, next_h) = mamba.forward(&tkan_tensor, &*hidden_guard, delta_t)?;
            *hidden_guard = next_h;

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

            let (mamba_dir, _p_win, horiz_sec) = mamba.evaluate_scalar_heads_with_temp(&heads, temp)?;
            // SOTA August 2026: Balanced microstructure logit modulation (neural mamba primacy)
            let composite_logit = mamba_dir + 0.15 * obi + 0.10 * ofi + 0.05 * hawkes_asym;
            let dir = (composite_logit / temp).tanh().clamp(-1.0, 1.0);
            let direction_magnitude = dir.abs();

            let conf = compute_calibrated_confidence(
                direction_magnitude,
                snr_score,
                gk_vol,
                obi,
                dir,
                temp,
                scale,
                offset,
            );
            (dir, conf, horiz_sec * 1000.0)
        } else if let Some(cell) = &self.cell {
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

            let dir = (raw_direction / (temp * 3.0)).tanh();
            let direction_magnitude = dir.abs();

            let conf = compute_calibrated_confidence(
                direction_magnitude,
                snr_score,
                gk_vol,
                obi,
                dir,
                temp,
                scale,
                offset,
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
        {
            let trackers = self.asset_trackers.read().unwrap_or_else(|e| e.into_inner());
            let trackers_ref = if asset_idx < trackers.len() {
                trackers
            } else {
                drop(trackers);
                {
                    let mut trackers_mut = self.asset_trackers.write().unwrap_or_else(|e| e.into_inner());
                    while trackers_mut.len() <= asset_idx {
                        trackers_mut.push(AssetTelemetryTracker::new());
                    }
                }
                self.asset_trackers.read().unwrap_or_else(|e| e.into_inner())
            };

            if let Some(tracker) = trackers_ref.get(asset_idx) {
                tracker.last_mid_price.store(current_mid.to_bits(), Ordering::Relaxed);
                tracker.last_prediction_dir.store(direction.to_bits(), Ordering::Relaxed);
                if let Ok(mut hist) = tracker.horizon_history.lock() {
                    hist.push_back((start_ns, current_mid, direction));
                    if hist.len() > 36_000 {
                        hist.pop_front();
                    }
                }
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
                    if let Some(mamba) = &self.mamba {
                        if hidden_guard.dims() != &[1, mamba.d_inner, mamba.d_state] {
                            if let Ok(new_h) = Tensor::zeros((1, mamba.d_inner, mamba.d_state), DType::F32, &Device::Cpu) {
                                *hidden_guard = new_h;
                            }
                        }
                        if let Ok((heads, next_h)) = mamba.forward(&tkan_tensor, &*hidden_guard, 0.001) {
                            *hidden_guard = next_h;
                            let temp = self.calibration_params.temperature.clamp(0.5, 5.0);
                            if let Ok((mamba_dir, _p_win, _)) = mamba.evaluate_scalar_heads_with_temp(&heads, temp) {
                                let obi = features[8];
                                let ofi = features[17];
                                let hawkes_asym = features[27];
                                let composite_logit = mamba_dir + 0.60 * obi + 0.40 * ofi + 0.25 * hawkes_asym;
                                let dir = (composite_logit / temp).tanh().clamp(-1.0, 1.0);
                                let conf = compute_calibrated_confidence(
                                    dir.abs(),
                                    1.0,
                                    0.0010,
                                    obi,
                                    dir,
                                    temp,
                                    self.calibration_params.platt_scale,
                                    self.calibration_params.platt_offset,
                                );
                                return (dir, conf);
                            }
                        }
                    } else if let Some(cell) = &self.cell {
                        if let Ok((output_tensor, next_h)) = cell.forward(&tkan_tensor, &*hidden_guard, 0.001) {
                            *hidden_guard = next_h;
                            if let Ok(flat) = output_tensor.flatten_all() {
                                let temp = self.calibration_params.temperature.clamp(0.5, 5.0);
                                let raw_dir = flat.get(0).and_then(|t| t.to_scalar::<f32>()).map(|v| (v as f64 / temp).tanh()).unwrap_or(0.0);
                                let conf = compute_calibrated_confidence(
                                    raw_dir.abs(),
                                    1.0,
                                    0.0010,
                                    0.0,
                                    raw_dir,
                                    temp,
                                    self.calibration_params.platt_scale,
                                    self.calibration_params.platt_offset,
                                );
                                return (raw_dir, conf);
                            }
                        }
                    }
                }
            }
        }
        (0.0, 0.0)
    }

    pub fn run_shadow_inference(&self, sab: &AtomicSharedMemoryBridge) -> Result<(f64, f64, f64, u64, f64)> {
        let start_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;

        let best_bid = sab.load_f64_asset(0, 4);
        let best_ask = sab.load_f64_asset(0, 6);
        if best_bid <= 0.0 || best_ask <= 0.0 {
            return Err(Error::Msg("ORDERBOOK_COLLAPSE_DETECTED".to_string()));
        }

        let lat_us_val = sab.load_f64_asset(0, 98) * 1000.0;
        let (lob_features, snr_score) = {
            let pipelines = self.feature_pipelines.read().unwrap_or_else(|e| e.into_inner());
            let mut pipeline = pipelines[0].lock().unwrap_or_else(|e| e.into_inner());
            pipeline.update_and_normalize_with_snr_asset(sab, lat_us_val, 0)?
        };

        let tkan_out = self.tkan.forward(&lob_features);
        let tkan_f32: [f32; 16] = std::array::from_fn(|i| tkan_out[i] as f32);
        let tkan_tensor = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu)?;

        let hs_holder = self.hidden_states.read().unwrap_or_else(|e| e.into_inner());
        let mut hidden_guard = hs_holder[0].lock().unwrap_or_else(|e| e.into_inner());

        let (direction, confidence, horizon_ms, hidden_norm) = if let Some(mamba) = &self.mamba {
            if hidden_guard.dims() != &[1, mamba.d_inner, mamba.d_state] {
                *hidden_guard = Tensor::zeros((1, mamba.d_inner, mamba.d_state), DType::F32, &Device::Cpu)?;
            }
            let (heads, next_h) = mamba.forward(&tkan_tensor, &*hidden_guard, 0.001)?;
            let norm = next_h.sqr()?.sum_all()?.to_scalar::<f32>()?.sqrt() as f64;
            *hidden_guard = next_h;
            let temp = self.calibration_params.temperature.clamp(0.5, 5.0);
            let (mamba_dir, _p_win, horiz_sec) = mamba.evaluate_scalar_heads_with_temp(&heads, temp)?;
            let gk_vol = sab.load_f64_asset(0, 121).max(0.0);
            let obi = sab.load_f64_asset(0, 1);
            let ofi = sab.load_f64_asset(0, 138);
            let hawkes_asym = sab.load_f64_asset(0, 149);
            let composite_logit = mamba_dir + 0.60 * obi + 0.40 * ofi + 0.25 * hawkes_asym;
            let dir = (composite_logit / temp).tanh().clamp(-1.0, 1.0);
            let conf = compute_calibrated_confidence(dir.abs(), snr_score, gk_vol, obi, dir, temp, self.calibration_params.platt_scale, self.calibration_params.platt_offset);
            (dir, conf, horiz_sec * 1000.0, norm)
        } else if let Some(cell) = &self.cell {
            let (output_tensor, next_h) = cell.forward(&tkan_tensor, &*hidden_guard, 0.001)?;
            let norm = next_h.sqr()?.sum_all()?.to_scalar::<f32>()?.sqrt() as f64;
            *hidden_guard = next_h;
            let flat_out = output_tensor.flatten_all()?;
            let temp = self.calibration_params.temperature.clamp(0.5, 5.0);
            let raw_dir = flat_out.get(0)?.to_scalar::<f32>()? as f64;
            let horiz = if flat_out.elem_count() > 2 { flat_out.get(2)?.to_scalar::<f32>()? as f64 } else { 100.0 };
            let dir = (raw_dir / temp).tanh();
            let gk_vol = sab.load_f64_asset(0, 121).max(0.0);
            let obi = sab.load_f64_asset(0, 1);
            let conf = compute_calibrated_confidence(dir.abs(), snr_score, gk_vol, obi, dir, temp, self.calibration_params.platt_scale, self.calibration_params.platt_offset);
            (dir, conf, horiz, norm)
        } else {
            return Err(Error::Msg("UNCALIBRATED".to_string()));
        };

        let end_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let latency_ns = end_ns.saturating_sub(start_ns);

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

/// Decoupled Isotonic Platt-Calibrated Confidence Formulation
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
) -> f64 {
    let psi_vol = compute_dual_regime_volatility_multiplier(gk_vol);
    let snr_norm = (snr_score / 3.0).clamp(0.50, 1.80);
    let effective_conviction = direction_magnitude * snr_norm * psi_vol;

    let direction_sign = if direction.abs() < 1e-6 { 0.0 } else { direction.signum() };
    let obi_align = obi * direction_sign;

    // Centered Platt calibration: neutral conviction (~0.45) maps to 50% confidence
    let t = temp.clamp(0.5, 5.0);
    let s = scale.clamp(0.5, 3.0);
    let calibrated_logit: f64 = (s * (effective_conviction - 0.45) * 2.0 + obi_align * 0.40 + offset) / t;
    1.0f64 / (1.0f64 + (-calibrated_logit).exp())
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

        // Feed 120 bearish ticks (falling price down to 48000, low OBI, crashing CVD)
        for tick in 0..120 {
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
            if tick % 30 == 0 || tick == 119 {
                let dir = bridge.load_f64(93);
                let conf = bridge.load_f64(94);
                println!("Bearish Stream Tick {:02}: Dir = {:.4}, Conf = {:.4}", tick, dir, conf);
            }
        }
    }
}
