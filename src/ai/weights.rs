use std::path::Path;
use candle_core::{Device, safetensors::MmapedSafetensors};
use crate::ai::cfc::CfCCell;
use crate::ai::mamba::Mamba2Cell;

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
            platt_scale: 1.5,
            platt_offset: 0.0,
        }
    }
}

pub struct AiEngine {
    pub cell: Option<CfCCell>,
    pub mamba: Option<Mamba2Cell>,
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
                mamba: None,
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
                    mamba: None,
                    status: AiEngineStatus::Uncalibrated,
                    calibration_params: CalibrationParams::default(),
                };
            }
        };

        // Check for SOTA Mamba-2 SSM tensors first
        let m_w_in = mmaped.load("w_in", &device).ok();
        let m_b_in = mmaped.load("b_in", &device).ok();
        let m_a_log = mmaped.load("a_log", &device).ok();
        let m_w_b = mmaped.load("w_b", &device).ok();
        let m_b_b = mmaped.load("b_b", &device).ok();
        let m_w_c = mmaped.load("w_c", &device).ok();
        let m_b_c = mmaped.load("b_c", &device).ok();
        let m_w_out = mmaped.load("w_out", &device).ok();
        let m_b_out = mmaped.load("b_out", &device).ok();
        let m_d_skip = mmaped.load("d_skip", &device).ok();
        let m_w_heads = mmaped.load("w_heads", &device).ok();
        let m_b_heads = mmaped.load("b_heads", &device).ok();

        // Check for Liquid CfC continuous-time tensors
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

        // If Mamba-2 tensors are present
        if let (
            Some(w_in),
            Some(b_in),
            Some(a_log),
            Some(w_b),
            Some(b_b),
            Some(w_c),
            Some(b_c),
            Some(w_out),
            Some(b_out),
            Some(d_skip),
            Some(w_heads),
            Some(b_heads),
        ) = (
            m_w_in, m_b_in, m_a_log, m_w_b, m_b_b, m_w_c, m_b_c, m_w_out, m_b_out, m_d_skip,
            m_w_heads, m_b_heads,
        ) {
            let input_dim = w_in.dims()[0];
            let d_inner = w_in.dims()[1];
            let d_state = w_b.dims()[1];
            let mamba_cell = Mamba2Cell::new(
                w_in, b_in, a_log, w_b, b_b, w_c, b_c, w_out, b_out, d_skip, w_heads, b_heads,
                input_dim, d_inner, d_state,
            );
            println!(
                "[BATBOT_V11][AI Engine Zero-Copy] Loaded SOTA Mamba-2 SSM weights from {} via mmap. Status: CALIBRATED (Mamba-2: in={}, inner={}, state={}).",
                path_ref.display(),
                input_dim,
                d_inner,
                d_state
            );
            Self {
                cell: None,
                mamba: Some(mamba_cell),
                status: AiEngineStatus::Calibrated,
                calibration_params,
            }
        } else if let (Some(w_a), Some(b_a), Some(w_b), Some(b_b), Some(w_o), Some(b_o)) =
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
                mamba: None,
                status: AiEngineStatus::Calibrated,
                calibration_params,
            }
        } else {
            eprintln!(
                "[BATBOT_V11][AI Engine] Incomplete tensors in {}. Status: UNCALIBRATED (Bypassing inference safely).",
                path_ref.display()
            );
            Self {
                cell: None,
                mamba: None,
                status: AiEngineStatus::Uncalibrated,
                calibration_params: CalibrationParams::default(),
            }
        }
    }

    pub fn is_calibrated(&self) -> bool {
        self.status == AiEngineStatus::Calibrated && (self.cell.is_some() || self.mamba.is_some())
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
        assert!(engine.mamba.is_none());
        assert!(!engine.is_calibrated());
    }
}
