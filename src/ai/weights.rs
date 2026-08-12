use std::path::Path;
use candle_core::{Device, safetensors::MmapedSafetensors};
use crate::ai::cfc::CfCCell;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiEngineStatus {
    Calibrated,
    Uncalibrated,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalibrationParams {
    pub temperature: f64,
    pub platt_scale: f64,
    pub platt_offset: f64,
}

impl Default for CalibrationParams {
    fn default() -> Self {
        Self {
            temperature: 1.0,
            platt_scale: 1.0,
            platt_offset: 0.0,
        }
    }
}

pub struct AiEngine {
    pub cell: Option<CfCCell>,
    pub status: AiEngineStatus,
    pub calibration_params: CalibrationParams,
}

impl AiEngine {
    pub fn new() -> Self {
        Self::load_from_file("./models/cfc_weights.safetensors")
    }

    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Self {
        let path_ref = path.as_ref();

        if !path_ref.exists() {
            println!(
                "[BATBOT_V11][AI Engine] Weights file not found at path: {}. Status: UNCALIBRATED (Bypassing inference safely).",
                path_ref.display()
            );
            return Self {
                cell: None,
                status: AiEngineStatus::Uncalibrated,
                calibration_params: CalibrationParams::default(),
            };
        }

        let device = Device::Cpu;
        let mmaped = match unsafe { MmapedSafetensors::new(path_ref) } {
            Ok(m) => m,
            Err(e) => {
                eprintln!(
                    "[BATBOT_V11][AI Engine] Failed to mmap safetensors file {}: {}. Status: UNCALIBRATED (Bypassing inference safely).",
                    path_ref.display(),
                    e
                );
                return Self {
                    cell: None,
                    status: AiEngineStatus::Uncalibrated,
                    calibration_params: CalibrationParams::default(),
                };
            }
        };

        let w_alpha = mmaped.load("w_alpha", &device).ok();
        let b_alpha = mmaped.load("b_alpha", &device).ok();
        let w_beta = mmaped.load("w_beta", &device).ok();
        let b_beta = mmaped.load("b_beta", &device).ok();
        let w_output = mmaped.load("w_output", &device).ok();
        let b_output = mmaped.load("b_output", &device).ok();

        let temp_val = mmaped
            .load("temperature", &device)
            .ok()
            .and_then(|t| t.flatten_all().ok())
            .and_then(|t| t.get(0).ok())
            .and_then(|t| t.to_scalar::<f32>().ok())
            .map(|v| v as f64)
            .unwrap_or(1.0);

        let scale_val = mmaped
            .load("platt_scale", &device)
            .ok()
            .and_then(|t| t.flatten_all().ok())
            .and_then(|t| t.get(0).ok())
            .and_then(|t| t.to_scalar::<f32>().ok())
            .map(|v| v as f64)
            .unwrap_or(1.0);

        let offset_val = mmaped
            .load("platt_offset", &device)
            .ok()
            .and_then(|t| t.flatten_all().ok())
            .and_then(|t| t.get(0).ok())
            .and_then(|t| t.to_scalar::<f32>().ok())
            .map(|v| v as f64)
            .unwrap_or(0.0);

        let calibration_params = CalibrationParams {
            temperature: temp_val,
            platt_scale: scale_val,
            platt_offset: offset_val,
        };

        if let (Some(w_a), Some(b_a), Some(w_b), Some(b_b), Some(w_o), Some(b_o)) =
            (w_alpha, b_alpha, w_beta, b_beta, w_output, b_output)
        {
            let cell = CfCCell::new(w_a, b_a, w_b, b_b, w_o, b_o);
            println!(
                "[BATBOT_V11][AI Engine Zero-Copy] Loaded pre-trained CfC weights from {} via mmap. Status: CALIBRATED (A={:.4}, B={:.4}, T={:.4}).",
                path_ref.display(),
                calibration_params.platt_scale,
                calibration_params.platt_offset,
                calibration_params.temperature
            );
            Self {
                cell: Some(cell),
                status: AiEngineStatus::Calibrated,
                calibration_params,
            }
        } else {
            eprintln!(
                "[BATBOT_V11][AI Engine] Incomplete tensors in {}. Required: w_alpha, b_alpha, w_beta, b_beta, w_output, b_output. Status: UNCALIBRATED (Bypassing inference safely).",
                path_ref.display()
            );
            Self {
                cell: None,
                status: AiEngineStatus::Uncalibrated,
                calibration_params: CalibrationParams::default(),
            }
        }
    }

    pub fn is_calibrated(&self) -> bool {
        self.status == AiEngineStatus::Calibrated
    }
}

impl Default for AiEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_missing_weights_fallback_graceful() {
        let engine = AiEngine::load_from_file("./models/non_existent_weights.safetensors");
        assert_eq!(engine.status, AiEngineStatus::Uncalibrated);
        assert!(engine.cell.is_none());
        assert!(!engine.is_calibrated());
    }
}
