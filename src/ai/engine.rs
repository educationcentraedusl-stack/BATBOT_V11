use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use candle_core::{DType, Device, Result, Tensor};

use crate::ai::cfc::CfCCell;
use crate::ai::ic_tracker::ICTracker;
use crate::ai::kan::TKANLayer;
use crate::ai::weights::{AiEngine, AiEngineStatus};
use crate::ipc::shared_memory::AtomicSharedMemoryBridge;

pub struct AIEngine {
    pub tkan: TKANLayer,
    pub cell: Option<CfCCell>,
    pub hidden_state: Mutex<Tensor>,
    pub status: AiEngineStatus,
    pub last_inference_ns: AtomicU64,
    pub inference_seq: AtomicU64,
    pub ic_tracker: Mutex<ICTracker>,
    pub last_mid_price: AtomicU64,
    pub last_prediction_dir: AtomicU64,
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
            last_inference_ns: AtomicU64::new(0),
            inference_seq: AtomicU64::new(0),
            ic_tracker: Mutex::new(ICTracker::default_1000()),
            last_mid_price: AtomicU64::new(0.0f64.to_bits()),
            last_prediction_dir: AtomicU64::new(0.0f64.to_bits()),
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

    pub fn run_inference(&self, sab: &AtomicSharedMemoryBridge) -> Result<()> {
        if self.status != AiEngineStatus::Calibrated || self.cell.is_none() {
            // Zero-thrashing graceful fallback: return instantly if engine is uncalibrated
            return Ok(());
        }

        let start_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;

        // 1. Read 40 LOB features from SAB slots 11..90
        let mut lob_features = [0.0f64; 40];
        // Read 20 bid features (slots 11..30) & 20 ask features (slots 51..70)
        for i in 0..20 {
            lob_features[i] = sab.load_f64(11 + i);
            lob_features[20 + i] = sab.load_f64(51 + i);
        }

        // Calculate current mid price for IC tracking realized return calculation
        let best_bid = sab.load_f64(4);
        let best_ask = sab.load_f64(6);
        let current_mid = if best_bid > 0.0 && best_ask > 0.0 {
            (best_bid + best_ask) / 2.0
        } else {
            0.0
        };

        let last_mid = f64::from_bits(self.last_mid_price.load(Ordering::Relaxed));
        let last_pred = f64::from_bits(self.last_prediction_dir.load(Ordering::Relaxed));

        if last_mid > 0.0 && current_mid > 0.0 && last_pred != 0.0 {
            let realized_return = (current_mid - last_mid) / last_mid;
            if let Ok(mut tracker) = self.ic_tracker.lock() {
                tracker.add_observation(last_pred, realized_return, Some(sab));
            }
        }

        // 2. Execute T-KAN forward pass (40 -> 16 spatial encoding)
        let tkan_out = self.tkan.forward(&lob_features);
        let tkan_f32: [f32; 16] = std::array::from_fn(|i| tkan_out[i] as f32);
        let tkan_tensor = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu)?;

        // 3. Compute delta_t from system time
        let prev_ns = self.last_inference_ns.swap(start_ns, Ordering::Relaxed);
        let delta_t = if prev_ns == 0 {
            0.001
        } else {
            (start_ns.saturating_sub(prev_ns) as f64) / 1e9
        };

        // 4. Execute CfC cell forward pass
        let mut hidden_guard = self.hidden_state.lock().unwrap_or_else(|e| e.into_inner());
        let (output_tensor, next_hidden) = if let Some(cell) = &self.cell {
            cell.forward(&tkan_tensor, &*hidden_guard, delta_t)?
        } else {
            return Ok(());
        };
        *hidden_guard = next_hidden;

        // Extract predictions
        let flat_out = output_tensor.flatten_all()?;
        let raw_direction = flat_out.get(0)?.to_scalar::<f32>()? as f64;
        let raw_confidence = flat_out.get(1)?.to_scalar::<f32>()? as f64;
        let horizon_ms = flat_out.get(2)?.to_scalar::<f32>()? as f64;
        let direction = raw_direction.tanh(); // Clamped -1.0 to +1.0
        let confidence = (1.0 / (1.0 + (-raw_confidence).exp())).clamp(0.0, 1.0); // Sigmoid 0.0 to 1.0


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

        // Compute dynamic slippage buffer: 2 + floor(spread_velocity / 0.5)
        let spread_vel = sab.load_f64(3);
        let slippage_ticks = 2.0 + (spread_vel.abs() / 0.5).floor();

        // Save last state for IC tracker step
        self.last_mid_price.store(current_mid.to_bits(), Ordering::Relaxed);
        self.last_prediction_dir.store(direction.to_bits(), Ordering::Relaxed);

        let seq = self.inference_seq.fetch_add(1, Ordering::Relaxed);

        // 5. Write predictions to SAB slots 93..103
        sab.store_f64(93, direction);
        sab.store_f64(94, confidence);
        sab.store_f64(95, horizon_ms);
        sab.store_u64(96, start_ns);
        sab.store_f64(97, hidden_norm);
        sab.store_f64(100, slippage_ticks);
        sab.store_u64(102, latency_ns);
        sab.store_u64(103, seq);

        Ok(())
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
}
