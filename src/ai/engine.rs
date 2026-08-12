use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use candle_core::{DType, Device, Error, Result, Tensor};

use crate::ai::cfc::CfCCell;
use crate::ai::ic_tracker::ICTracker;
use crate::ai::kan::TKANLayer;
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

        for i in 0..40 {
            let val = raw_features[i];
            let window = &mut self.feature_windows[i];
            if window.len() == 1000 {
                let old = window.pop_back().unwrap();
                self.feature_sums[i] -= old;
                self.feature_sum_sqs[i] -= old * old;
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
            if i == 21 { cvd_z = z.abs(); }
            if i == 24 { vel_z = z.abs(); }
            if i == 2 { micro_z = z.abs(); }

            norm_features[i] = (z / 3.0).tanh();
        }

        let snr_score = 1.0 + 0.6 * (obi_z + 0.8 * cvd_z + 0.5 * vel_z + 0.5 * micro_z).min(8.0);

        Ok((norm_features, snr_score))
    }
}

pub struct AIEngine {
    pub tkan: TKANLayer,
    pub cell: Option<CfCCell>,
    pub hidden_state: Mutex<Tensor>,
    pub status: AiEngineStatus,
    pub calibration_params: crate::ai::weights::CalibrationParams,
    pub last_inference_ns: AtomicU64,
    pub inference_seq: AtomicU64,
    pub ic_tracker: Mutex<ICTracker>,
    pub last_mid_price: AtomicU64,
    pub last_prediction_dir: AtomicU64,
    pub feature_pipeline: Mutex<StreamingFeaturePipeline>,
}

impl AIEngine {
    pub fn new() -> Self {
        Self::load_from_file("./models/cfc_weights.safetensors")
    }

    pub fn load_from_paths(cfc_path: &str, tkan_path: &str) -> Self {
        let device = Device::Cpu;
        let tkan = TKANLayer::load_from_binary_or_default(tkan_path);
        let hidden_state = Tensor::zeros((1, 32), DType::F32, &device)
            .unwrap_or_else(|_| Tensor::zeros((1, 32), DType::F32, &Device::Cpu).unwrap());

        let weights_engine = AiEngine::load_from_file(cfc_path);

        Self {
            tkan,
            cell: weights_engine.cell,
            hidden_state: Mutex::new(hidden_state),
            status: weights_engine.status,
            calibration_params: weights_engine.calibration_params,
            last_inference_ns: AtomicU64::new(0),
            inference_seq: AtomicU64::new(0),
            ic_tracker: Mutex::new(ICTracker::default_1000()),
            last_mid_price: AtomicU64::new(0.0f64.to_bits()),
            last_prediction_dir: AtomicU64::new(0.0f64.to_bits()),
            feature_pipeline: Mutex::new(StreamingFeaturePipeline::new()),
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
        self.status = new_engine.status;
        self.calibration_params = new_engine.calibration_params;
        if let Ok(new_hs) = new_engine.hidden_state.into_inner() {
            if let Ok(mut hs) = self.hidden_state.lock() {
                *hs = new_hs;
            }
        }
        calibrated
    }

    pub fn is_calibrated(&self) -> bool {
        self.status == AiEngineStatus::Calibrated && self.cell.is_some()
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
        if self.status != AiEngineStatus::Calibrated || self.cell.is_none() {
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
        let (lob_features, snr_score) = {
            let mut pipeline = self.feature_pipeline.lock().unwrap_or_else(|e| e.into_inner());
            pipeline.update_and_normalize_with_snr_asset(sab, lat_us_val, asset_idx)?
        };

        let last_mid = f64::from_bits(self.last_mid_price.load(Ordering::Relaxed));
        let last_pred = f64::from_bits(self.last_prediction_dir.load(Ordering::Relaxed));

        if last_mid > 0.0 && current_mid > 0.0 && last_pred != 0.0 {
            let realized_return = (current_mid - last_mid) / last_mid;
            if let Ok(mut tracker) = self.ic_tracker.lock() {
                tracker.add_observation(last_pred, realized_return, Some(sab));
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

        let mut hidden_guard = self.hidden_state.lock().unwrap_or_else(|e| e.into_inner());
        let (output_tensor, next_hidden) = if let Some(cell) = &self.cell {
            cell.forward(&tkan_tensor, &*hidden_guard, delta_t)?
        } else {
            return Ok(());
        };
        *hidden_guard = next_hidden;

        let flat_out = output_tensor.flatten_all()?;
        let num_elems = flat_out.elem_count();
        let raw_direction = if num_elems > 0 { flat_out.get(0)?.to_scalar::<f32>()? as f64 } else { 0.0 };
        let _raw_confidence = if num_elems > 1 { flat_out.get(1)?.to_scalar::<f32>()? as f64 } else { raw_direction.abs() };
        let horizon_ms = if num_elems > 2 { flat_out.get(2)?.to_scalar::<f32>()? as f64 } else { 100.0 };
        let direction = raw_direction.tanh();
        let direction_magnitude = direction.abs();

        // Garman-Klass Volatility & Signal Z-Score (Z_signal)
        let gk_rv = sab.load_f64_asset(asset_idx, 121);
        let gk_vol = if gk_rv > 0.000001 { gk_rv.sqrt() } else { 0.005 };
        let z_score = direction_magnitude / gk_vol.max(0.0001);

        // Temperature Scaling (T) & SOTA Dynamic Platt SNR Calibration Formula:
        // calibrated_logit = (alpha * z_score + beta * snr + obi_align + offset) / temperature
        let sab_temp = sab.load_f64_asset(asset_idx, 127);
        let sab_scale = sab.load_f64_asset(asset_idx, 128);
        let sab_offset = sab.load_f64_asset(asset_idx, 129);

        let temp = if sab_temp > 0.05 { sab_temp } else { self.calibration_params.temperature };
        let scale = if sab_scale > 0.001 { sab_scale } else { self.calibration_params.platt_scale };
        let offset = sab_offset;

        let alpha = scale.max(1.0);
        let beta = 0.8;
        let obi = sab.load_f64_asset(asset_idx, 1);
        let obi_align = obi * direction.signum();

        let calibrated_logit: f64 = ((alpha * z_score + beta * snr_score + obi_align * 0.5 + offset) / temp.max(0.05)).clamp(0.0, 4.6);
        let confidence: f64 = (1.0f64 / (1.0f64 + (-calibrated_logit).exp())).clamp(0.50f64, 0.99f64);

        let end_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let latency_ns = end_ns.saturating_sub(start_ns);

        let spread_vel = sab.load_f64_asset(asset_idx, 3);
        let slippage_ticks = (2.0 + (spread_vel.abs() / 0.5).floor()).min(20.0);

        self.last_mid_price.store(current_mid.to_bits(), Ordering::Relaxed);
        self.last_prediction_dir.store(direction.to_bits(), Ordering::Relaxed);

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

    pub fn inherit_hidden_state(&self, other: &AIEngine) {
        if let Ok(other_hs) = other.hidden_state.lock() {
            if let Ok(mut self_hs) = self.hidden_state.lock() {
                *self_hs = other_hs.clone();
            }
        }
    }

    pub fn run_shadow_inference(
        &self,
        sab: &AtomicSharedMemoryBridge,
    ) -> Result<(f64, f64, f64, u64, f64)> {
        if self.status != AiEngineStatus::Calibrated || self.cell.is_none() {
            return Ok((0.0, 0.0, 0.0, 0, 0.0));
        }

        let start_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;

        let best_bid = sab.load_f64(4);
        let best_ask = sab.load_f64(6);
        if best_bid <= 0.0 || best_ask <= 0.0 {
            return Err(Error::Msg("ORDERBOOK_COLLAPSE_DETECTED".to_string()));
        }

        let lat_us_val = sab.load_f64(98) * 1000.0;
        let lob_features = {
            let mut pipeline = self.feature_pipeline.lock().unwrap_or_else(|e| e.into_inner());
            pipeline.update_and_normalize(sab, lat_us_val)?
        };

        let tkan_out = self.tkan.forward(&lob_features);
        let tkan_f32: [f32; 16] = std::array::from_fn(|i| tkan_out[i] as f32);
        let tkan_tensor = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu)?;

        let prev_ns = self.last_inference_ns.swap(start_ns, Ordering::Relaxed);
        let delta_t = if prev_ns == 0 {
            0.001
        } else {
            ((start_ns.saturating_sub(prev_ns) as f64) / 1e9).max(0.0001)
        };

        let mut hidden_guard = self.hidden_state.lock().unwrap_or_else(|e| e.into_inner());
        let (output_tensor, next_hidden) = if let Some(cell) = &self.cell {
            cell.forward(&tkan_tensor, &*hidden_guard, delta_t)?
        } else {
            return Ok((0.0, 0.0, 0.0, 0, 0.0));
        };
        *hidden_guard = next_hidden;

        let flat_out = output_tensor.flatten_all()?;
        let num_elems = flat_out.elem_count();
        let raw_direction = if num_elems > 0 { flat_out.get(0)?.to_scalar::<f32>()? as f64 } else { 0.0 };
        let raw_confidence = if num_elems > 1 { flat_out.get(1)?.to_scalar::<f32>()? as f64 } else { raw_direction.abs() };
        let horizon_ms = if num_elems > 2 { flat_out.get(2)?.to_scalar::<f32>()? as f64 } else { 100.0 };
        let direction = raw_direction.tanh();

        // Temperature Scaling (T) & Mathematically Sound Platt Calibration Transformation (No Inflation Multipliers)
        let sab_temp = sab.load_f64(127);
        let sab_scale = sab.load_f64(128);
        let sab_offset = sab.load_f64(129);

        let temp = if sab_temp > 0.05 { sab_temp } else { self.calibration_params.temperature };
        let scale = if sab_scale > 0.001 { sab_scale } else { self.calibration_params.platt_scale };
        let offset = sab_offset;

        let calibrated_logit: f64 = ((scale * raw_confidence + offset) / temp.max(0.05)).clamp(0.0, 4.6);
        let confidence: f64 = (1.0f64 / (1.0f64 + (-calibrated_logit).exp())).clamp(0.50f64, 0.99f64);

        let end_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let latency_ns = end_ns.saturating_sub(start_ns);

        let hidden_norm = hidden_guard
            .sqr()?
            .sum_all()?
            .to_scalar::<f32>()?
            .sqrt() as f64;

        self.inference_seq.fetch_add(1, Ordering::Relaxed);

        Ok((direction, confidence, horizon_ms, latency_ns, hidden_norm))
    }

    pub fn evaluate_features(&self, features: &[f64; 40]) -> (f64, f64) {
        if self.status != AiEngineStatus::Calibrated || self.cell.is_none() {
            let obi = features[8];
            let relative_spread = features[1];
            let cvd_delta = features[16];
            let raw_signal = obi * 0.6 + cvd_delta.signum() * 0.4;
            let direction = raw_signal.clamp(-1.0, 1.0);
            let confidence = (raw_signal.abs() * 0.8 + relative_spread * 0.2).clamp(0.0, 1.0);
            return (direction, confidence);
        }

        let tkan_out = self.tkan.forward(features);
        let tkan_f32: [f32; 16] = std::array::from_fn(|i| tkan_out[i] as f32);
        if let Ok(tkan_tensor) = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu) {
            if let Ok(mut hidden_guard) = self.hidden_state.lock() {
                if let Some(cell) = &self.cell {
                    if let Ok((output_tensor, next_hidden)) = cell.forward(&tkan_tensor, &*hidden_guard, 0.001) {
                        *hidden_guard = next_hidden;
                        if let Ok(flat_out) = output_tensor.flatten_all() {
                            let num_elems = flat_out.elem_count();
                            let raw_direction = if num_elems > 0 { flat_out.get(0).ok().and_then(|t| t.to_scalar::<f32>().ok()).unwrap_or(0.0) as f64 } else { 0.0 };
                            let raw_confidence = if num_elems > 1 { flat_out.get(1).ok().and_then(|t| t.to_scalar::<f32>().ok()).unwrap_or(raw_direction.abs() as f32) as f64 } else { raw_direction.abs() };
                            let direction = raw_direction.tanh();
                            let calibrated_logit: f64 = ((self.calibration_params.platt_scale * raw_confidence + self.calibration_params.platt_offset) / self.calibration_params.temperature.max(0.05)).clamp(0.0, 4.6);
                            let confidence: f64 = (1.0f64 / (1.0f64 + (-calibrated_logit).exp())).clamp(0.50f64, 0.99f64);
                            return (direction, confidence);
                        }
                    }
                }
            }
        }
        (0.0, 0.0)
    }
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

        // Best bid = 0.0, Best ask = 0.0 -> ORDERBOOK_COLLAPSE_DETECTED
        let res = engine.run_inference(&bridge);
        assert!(res.is_err());
        let err_str = res.err().unwrap().to_string();
        assert!(err_str.contains("ORDERBOOK_COLLAPSE_DETECTED"));
    }

    #[test]
    fn test_streaming_feature_pipeline_normalization() {
        let mut buffer = vec![0u8; 2048];
        let bridge = AtomicSharedMemoryBridge::new(buffer.as_mut_ptr(), buffer.len()).unwrap();
        bridge.store_f64(4, 50000.0); // Best bid price
        bridge.store_f64(5, 1.5);     // Best bid qty
        bridge.store_f64(6, 50001.0); // Best ask price
        bridge.store_f64(7, 2.5);     // Best ask qty

        let mut pipeline = StreamingFeaturePipeline::new();
        let features = pipeline.update_and_normalize(&bridge, 150.0).unwrap();
        assert_eq!(features.len(), 40);
        for f in features.iter() {
            assert!(*f >= -1.0 && *f <= 1.0);
        }
    }
}

