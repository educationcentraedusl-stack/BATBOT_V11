use std::path::Path;
use candle_core::{Device, safetensors::load};
use crate::ai::cfc::CfCCell;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiEngineStatus {
    Calibrated,
    Uncalibrated,
}

pub struct AiEngine {
    pub cell: Option<CfCCell>,
    pub status: AiEngineStatus,
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
            };
        }

        let device = Device::Cpu;
        match load(path_ref, &device) {
            Ok(mut tensors) => {
                let w_alpha = tensors.remove("w_alpha");
                let b_alpha = tensors.remove("b_alpha");
                let w_beta = tensors.remove("w_beta");
                let b_beta = tensors.remove("b_beta");
                let w_output = tensors.remove("w_output");
                let b_output = tensors.remove("b_output");

                if let (Some(w_a), Some(b_a), Some(w_b), Some(b_b), Some(w_o), Some(b_o)) =
                    (w_alpha, b_alpha, w_beta, b_beta, w_output, b_output)
                {
                    let cell = CfCCell::new(w_a, b_a, w_b, b_b, w_o, b_o);
                    println!(
                        "[BATBOT_V11][AI Engine] Loaded pre-trained CfC weights from {}. Status: CALIBRATED.",
                        path_ref.display()
                    );
                    Self {
                        cell: Some(cell),
                        status: AiEngineStatus::Calibrated,
                    }
                } else {
                    eprintln!(
                        "[BATBOT_V11][AI Engine] Incomplete tensors in {}. Required: w_alpha, b_alpha, w_beta, b_beta, w_output, b_output. Status: UNCALIBRATED (Bypassing inference safely).",
                        path_ref.display()
                    );
                    Self {
                        cell: None,
                        status: AiEngineStatus::Uncalibrated,
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "[BATBOT_V11][AI Engine] Failed to load safetensors file {}: {}. Status: UNCALIBRATED (Bypassing inference safely).",
                    path_ref.display(),
                    e
                );
                Self {
                    cell: None,
                    status: AiEngineStatus::Uncalibrated,
                }
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
