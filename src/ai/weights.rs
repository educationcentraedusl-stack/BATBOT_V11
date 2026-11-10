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
    pub logit_scale: f64,
    pub meta_logit_scale: f64,
}

impl Default for CalibrationParams {
    fn default() -> Self {
        Self {
            temperature: 1.0,
            platt_scale: 1.0,
            platt_offset: 0.0,
            logit_scale: 1.0,
            meta_logit_scale: 1.0,
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
        match Self::try_load_from_file(path) {
            Ok(engine) => engine,
            Err(err) => {
                eprintln!(
                    "[BATBOT_V11][AI Engine] {}. Status: UNCALIBRATED (Bypassing inference safely).",
                    err
                );
                Self {
                    cell: None,
                    mamba: None,
                    status: AiEngineStatus::Uncalibrated,
                    calibration_params: CalibrationParams::default(),
                }
            }
        }
    }

    pub fn try_load_from_file<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let path_ref = path.as_ref();

        if !path_ref.exists() {
            return Err(format!("Weights file not found at path: {}", path_ref.display()));
        }

        let device = Device::Cpu;
        let mmaped = unsafe { MmapedSafetensors::new(path_ref) }
            .map_err(|e| format!("Failed to mmap safetensors file {}: {}", path_ref.display(), e))?;

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

        let logit_scale_val = mmaped
            .load("logit_scale", &device)
            .ok()
            .and_then(|t| t.flatten_all().ok())
            .and_then(|t| t.get(0).ok())
            .and_then(|t| t.to_scalar::<f32>().ok())
            .map(|v| v as f64)
            .unwrap_or(1.0);

        let meta_logit_scale_val = mmaped
            .load("meta_logit_scale", &device)
            .ok()
            .and_then(|t| t.flatten_all().ok())
            .and_then(|t| t.get(0).ok())
            .and_then(|t| t.to_scalar::<f32>().ok())
            .map(|v| v as f64)
            .unwrap_or(1.0);

        let calibration_params = CalibrationParams {
            temperature: temp_val,
            platt_scale: scale_val,
            platt_offset: offset_val,
            logit_scale: logit_scale_val,
            meta_logit_scale: meta_logit_scale_val,
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
            let (input_dim, d_inner, d_state) = match (w_in.dims(), w_b.dims()) {
                ([in_d, inner_d], [_, state_d]) if *in_d > 0 && *inner_d > 0 && *state_d > 0 => {
                    (*in_d, *inner_d, *state_d)
                }
                _ => {
                    return Err(format!(
                        "Invalid Mamba-2 tensor rank or zero dimension in {}: w_in={:?}, w_b={:?}",
                        path_ref.display(),
                        w_in.dims(),
                        w_b.dims()
                    ));
                }
            };
            let mut mamba_cell = Mamba2Cell::new(
                w_in, b_in, a_log, w_b, b_b, w_c, b_c, w_out, b_out, d_skip, w_heads, b_heads,
                input_dim, d_inner, d_state,
            )
            .map_err(|e| format!("Failed to construct Mamba-2 cell from {}: {:?}", path_ref.display(), e))?;

            mamba_cell.set_scales(logit_scale_val as f32, meta_logit_scale_val as f32);
            println!(
                "[BATBOT_V11][AI Engine Zero-Copy] Loaded SOTA Mamba-2 SSM weights from {} via mmap. Status: CALIBRATED (Mamba-2: in={}, inner={}, state={}, logit_scale={:.4}, meta_scale={:.4}).",
                path_ref.display(),
                input_dim,
                d_inner,
                d_state,
                logit_scale_val,
                meta_logit_scale_val
            );
            Ok(Self {
                cell: None,
                mamba: Some(mamba_cell),
                status: AiEngineStatus::Calibrated,
                calibration_params,
            })
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
            Ok(Self {
                cell: Some(cell),
                mamba: None,
                status: AiEngineStatus::Calibrated,
                calibration_params,
            })
        } else {
            Err(format!("Incomplete tensors in {}", path_ref.display()))
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

    #[test]
    fn test_try_load_from_file_returns_err_gracefully() {
        let res = AiEngine::try_load_from_file("./models/non_existent_weights.safetensors");
        assert!(res.is_err());

        let temp_path = std::env::temp_dir().join("corrupt_test_weights.safetensors");
        let _ = std::fs::write(&temp_path, b"not_valid_safetensors");
        let bad_res = AiEngine::try_load_from_file(&temp_path);
        assert!(bad_res.is_err());
        let _ = std::fs::remove_file(temp_path);
    }
}
