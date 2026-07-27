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
    pub hidden_state: Tensor,
    pub status: AiEngineStatus,
    pub last_inference_ns: u64,
    pub inference_seq: u64,
    pub ic_tracker: ICTracker,
    pub last_mid_price: f64,
    pub last_prediction_dir: f64,
}

impl AIEngine {
    pub fn new() -> Self {
        Self::load_from_file("./models/cfc_weights.safetensors")
    }

    pub fn load_from_file(path: &str) -> Self {
        let device = Device::Cpu;
        let tkan = TKANLayer::default_40_to_16();
        let hidden_state = Tensor::zeros((1, 32), DType::F32, &device)
            .unwrap_or_else(|_| Tensor::zeros((1, 32), DType::F32, &Device::Cpu).unwrap());

        let weights_engine = AiEngine::load_from_file(path);

        Self {
            tkan,
            cell: weights_engine.cell,
            hidden_state,
            status: weights_engine.status,
            last_inference_ns: 0,
            inference_seq: 0,
            ic_tracker: ICTracker::default_1000(),
            last_mid_price: 0.0,
            last_prediction_dir: 0.0,
        }
    }

    pub fn reload_weights(&mut self, path: &str) -> bool {
        let weights_engine = AiEngine::load_from_file(path);
        self.status = weights_engine.status;
        self.cell = weights_engine.cell;
        if self.cell.is_some() {
            // Reset hidden state on new model load
            let device = Device::Cpu;
            if let Ok(hs) = Tensor::zeros((1, 32), DType::F32, &device) {
                self.hidden_state = hs;
            }
        }
        self.is_calibrated()
    }

    pub fn is_calibrated(&self) -> bool {
        self.status == AiEngineStatus::Calibrated && self.cell.is_some()
    }

    pub fn run_inference(&mut self, sab: &AtomicSharedMemoryBridge) -> Result<()> {
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

        if self.last_mid_price > 0.0 && current_mid > 0.0 && self.last_prediction_dir != 0.0 {
            let realized_return = (current_mid - self.last_mid_price) / self.last_mid_price;
            self.ic_tracker.add_observation(
                self.last_prediction_dir,
                realized_return,
                Some(sab),
            );
        }

        // 2. Execute T-KAN forward pass (40 -> 16 spatial encoding)
        let tkan_out = self.tkan.forward(&lob_features);
        let tkan_f32: Vec<f32> = tkan_out.iter().map(|&v| v as f32).collect();
        let tkan_tensor = Tensor::from_slice(&tkan_f32, (1, 16), &Device::Cpu)?;

        // 3. Compute delta_t from system time
        let delta_t = if self.last_inference_ns == 0 {
            0.001
        } else {
            (start_ns.saturating_sub(self.last_inference_ns) as f64) / 1e9
        };
        self.last_inference_ns = start_ns;

        // 4. Execute CfC cell forward pass
        let cell = self.cell.as_ref().unwrap();
        let (output_tensor, next_hidden) = cell.forward(&tkan_tensor, &self.hidden_state, delta_t)?;
        self.hidden_state = next_hidden;

        // Extract predictions
        let output_vec = output_tensor.flatten_all()?.to_vec1::<f32>()?;
        let raw_direction = output_vec.get(0).copied().unwrap_or(0.0) as f64;
        let direction = raw_direction.tanh(); // Clamped -1.0 to +1.0
        let raw_confidence = output_vec.get(1).copied().unwrap_or(1.0) as f64;
        let confidence = (1.0 / (1.0 + (-raw_confidence).exp())).clamp(0.0, 1.0); // Sigmoid 0.0 to 1.0
        let horizon_ms = output_vec.get(2).copied().unwrap_or(500.0) as f64;

        let end_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let latency_ns = end_ns.saturating_sub(start_ns);

        let hidden_norm = self
            .hidden_state
            .sqr()?
            .sum_all()?
            .to_scalar::<f32>()?
            .sqrt() as f64;

        // Compute dynamic slippage buffer: 2 + floor(spread_velocity / 0.5)
        let spread_vel = sab.load_f64(3);
        let slippage_ticks = 2.0 + (spread_vel.abs() / 0.5).floor();

        // Save last state for IC tracker step
        self.last_mid_price = current_mid;
        self.last_prediction_dir = direction;

        // 5. Write predictions to SAB slots 93..103
        sab.store_f64(93, direction);
        sab.store_f64(94, confidence);
        sab.store_f64(95, horizon_ms);
        sab.store_u64(96, start_ns);
        sab.store_f64(97, hidden_norm);
        sab.store_f64(100, slippage_ticks);
        sab.store_u64(102, latency_ns);
        sab.store_u64(103, self.inference_seq);

        self.inference_seq = self.inference_seq.wrapping_add(1);

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
        let mut engine = AIEngine::load_from_file("./models/non_existent_weights.safetensors");
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
