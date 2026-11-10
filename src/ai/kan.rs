use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use memmap2::Mmap;

pub const LUT_SIZE: usize = 4096;

#[derive(Debug, Clone)]
pub struct BSplineLUT {
    pub lut: Vec<f64>,
    pub min_val: f64,
    pub max_val: f64,
}

impl BSplineLUT {
    pub fn new(lut: Vec<f64>, min_val: f64, max_val: f64) -> Result<Self, String> {
        if lut.len() < 2 {
            return Err(format!(
                "BSplineLUT size must be at least 2 for interpolation (got {})",
                lut.len()
            ));
        }
        if !min_val.is_finite() || !max_val.is_finite() || max_val <= min_val {
            return Err(format!(
                "max_val ({}) must be finite and strictly greater than min_val ({})",
                max_val, min_val
            ));
        }
        Ok(Self {
            lut,
            min_val,
            max_val,
        })
    }

    pub fn default_identity(min_val: f64, max_val: f64) -> Result<Self, String> {
        if !min_val.is_finite() || !max_val.is_finite() || max_val <= min_val {
            return Err(format!(
                "default_identity requires finite range with max_val ({}) > min_val ({})",
                max_val, min_val
            ));
        }
        let mut lut = Vec::with_capacity(LUT_SIZE);
        let step = (max_val - min_val) / (LUT_SIZE - 1) as f64;
        for i in 0..LUT_SIZE {
            let x = min_val + i as f64 * step;
            // Default linear response scaling function with tanh saturation
            lut.push(x.tanh());
        }
        Self::new(lut, min_val, max_val)
    }

    #[inline]
    pub fn evaluate_from_slice(slice: &[f64], min_val: f64, max_val: f64, input: f64) -> f64 {
        if slice.len() < 2 || !input.is_finite() || !min_val.is_finite() || !max_val.is_finite() || max_val <= min_val {
            return 0.0;
        }
        let clamped = input.clamp(min_val, max_val);
        let norm = (clamped - min_val) / (max_val - min_val);
        let max_idx_f = (slice.len() - 1) as f64;
        let idx_f = (norm * max_idx_f).clamp(0.0, max_idx_f);
        let i0 = idx_f.floor() as usize;
        let i1 = (i0 + 1).min(slice.len() - 1);
        let frac = idx_f - i0 as f64;

        let v0 = slice.get(i0).copied().unwrap_or(0.0);
        let v1 = slice.get(i1).copied().unwrap_or(0.0);
        (1.0 - frac) * v0 + frac * v1
    }

    #[inline]
    pub fn evaluate(&self, input: f64) -> f64 {
        Self::evaluate_from_slice(&self.lut, self.min_val, self.max_val, input)
    }
}

#[derive(Debug, Clone)]
pub enum TKANStorage {
    Heap(Vec<BSplineLUT>),
    Mmap {
        mmap: Arc<Mmap>,
        num_edges: usize,
        lut_size: usize,
        min_val: f64,
        max_val: f64,
    },
}

#[derive(Debug, Clone)]
pub struct TKANLayer {
    pub storage: TKANStorage,
    pub input_dim: usize,
    pub output_dim: usize,
}

impl TKANLayer {
    pub fn new_heap(edges: Vec<BSplineLUT>, input_dim: usize, output_dim: usize) -> Result<Self, String> {
        let expected_edges = input_dim
            .checked_mul(output_dim)
            .ok_or_else(|| "TKANLayer dimension multiplication overflow".to_string())?;
        if edges.len() != expected_edges {
            return Err(format!(
                "Number of edges ({}) must equal input_dim * output_dim ({})",
                edges.len(),
                expected_edges
            ));
        }
        Ok(Self {
            storage: TKANStorage::Heap(edges),
            input_dim,
            output_dim,
        })
    }

    pub fn default_40_to_16() -> Self {
        let input_dim = 40;
        let output_dim = 16;
        let total_edges = input_dim * output_dim;
        let mut edges = Vec::with_capacity(total_edges);

        let template_edge = match BSplineLUT::default_identity(-1000.0, 1000.0) {
            Ok(edge) => edge,
            Err(err) => {
                eprintln!("[BATBOT_V11][T-KAN ERROR] Failed to construct identity B-spline LUT: {}", err);
                return Self {
                    storage: TKANStorage::Heap(Vec::new()),
                    input_dim: 0,
                    output_dim: 0,
                };
            }
        };

        for _ in 0..total_edges {
            edges.push(template_edge.clone());
        }

        match Self::new_heap(edges, input_dim, output_dim) {
            Ok(layer) => layer,
            Err(err) => {
                eprintln!("[BATBOT_V11][T-KAN ERROR] Failed to construct default 40->16 TKANLayer: {}", err);
                Self {
                    storage: TKANStorage::Heap(Vec::new()),
                    input_dim: 0,
                    output_dim: 0,
                }
            }
        }
    }

    pub fn load_from_binary<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let path_ref = path.as_ref();
        let file = File::open(path_ref)
            .map_err(|e| format!("Failed to open LUT binary file {}: {}", path_ref.display(), e))?;

        let mmap = unsafe {
            memmap2::MmapOptions::new()
                .map(&file)
                .map_err(|e| format!("Failed to mmap LUT binary file {}: {}", path_ref.display(), e))?
        };

        let header_slice = mmap.get(0..24).ok_or_else(|| {
            format!(
                "LUT binary file {} is too small for header (len={})",
                path_ref.display(),
                mmap.len()
            )
        })?;

        let num_edges = u32::from_le_bytes(
            header_slice
                .get(0..4)
                .and_then(|s| s.try_into().ok())
                .ok_or_else(|| format!("Failed to parse num_edges from {}", path_ref.display()))?,
        ) as usize;
        let lut_size = u32::from_le_bytes(
            header_slice
                .get(4..8)
                .and_then(|s| s.try_into().ok())
                .ok_or_else(|| format!("Failed to parse lut_size from {}", path_ref.display()))?,
        ) as usize;
        let min_val = f64::from_le_bytes(
            header_slice
                .get(8..16)
                .and_then(|s| s.try_into().ok())
                .ok_or_else(|| format!("Failed to parse min_val from {}", path_ref.display()))?,
        );
        let max_val = f64::from_le_bytes(
            header_slice
                .get(16..24)
                .and_then(|s| s.try_into().ok())
                .ok_or_else(|| format!("Failed to parse max_val from {}", path_ref.display()))?,
        );

        if num_edges != 640 || lut_size < 2 {
            return Err(format!(
                "Invalid LUT dimensions in {}: num_edges={}, lut_size={}",
                path_ref.display(),
                num_edges,
                lut_size
            ));
        }

        if !min_val.is_finite() || !max_val.is_finite() || max_val <= min_val {
            return Err(format!(
                "Invalid LUT range in {}: max_val ({}) must be strictly greater than min_val ({})",
                path_ref.display(),
                max_val,
                min_val
            ));
        }

        let total_floats = num_edges
            .checked_mul(lut_size)
            .ok_or_else(|| format!("LUT float count overflow in {}", path_ref.display()))?;
        let payload_bytes = total_floats
            .checked_mul(8)
            .ok_or_else(|| format!("LUT byte length overflow in {}", path_ref.display()))?;
        let expected_bytes = 24usize
            .checked_add(payload_bytes)
            .ok_or_else(|| format!("LUT total byte size overflow in {}", path_ref.display()))?;
        if mmap.len() < expected_bytes {
            return Err(format!(
                "Incomplete LUT payload in {}: file size {} bytes, required {} bytes",
                path_ref.display(),
                mmap.len(),
                expected_bytes
            ));
        }

        // Touch every 4096-byte page to pre-fault all LUT memory into the process working set,
        // eliminating page-fault latency spikes during real-time trading and preflight testing.
        let mut touch_acc = 0u64;
        for i in (0..mmap.len()).step_by(4096) {
            if let Some(&byte_val) = mmap.get(i) {
                touch_acc = touch_acc.wrapping_add(byte_val as u64);
            }
        }
        std::hint::black_box(touch_acc);

        println!(
            "[BATBOT_V11][T-KAN Zero-Copy] Memory-mapped {} edge B-spline LUTs from {}. Zero heap allocation.",
            num_edges,
            path_ref.display()
        );

        Ok(Self {
            storage: TKANStorage::Mmap {
                mmap: Arc::new(mmap),
                num_edges,
                lut_size,
                min_val,
                max_val,
            },
            input_dim: 40,
            output_dim: 16,
        })
    }

    pub fn load_from_binary_or_default<P: AsRef<Path>>(path: P) -> Self {
        let path_ref = path.as_ref();
        match Self::load_from_binary(path_ref) {
            Ok(layer) => layer,
            Err(e) => {
                println!(
                    "[BATBOT_V11][T-KAN WARNING] {}. Falling back to default identity TKANLayer.",
                    e
                );
                Self::default_40_to_16()
            }
        }
    }

    #[inline]
    pub fn forward(&self, input: &[f64; 40]) -> [f64; 16] {
        let mut output = [0.0f64; 16];
        let max_in = self.input_dim.min(input.len());
        let max_out = self.output_dim.min(output.len());

        match &self.storage {
            TKANStorage::Heap(edges) => {
                for (i, &inp) in input.iter().take(max_in).enumerate() {
                    let base = i * self.output_dim;
                    for (j, out_slot) in output.iter_mut().take(max_out).enumerate() {
                        if let Some(edge) = edges.get(base + j) {
                            *out_slot += edge.evaluate(inp);
                        }
                    }
                }
            }
            TKANStorage::Mmap {
                mmap,
                num_edges: _,
                lut_size,
                min_val,
                max_val,
            } => {
                if *lut_size < 2 || *max_val <= *min_val || !min_val.is_finite() || !max_val.is_finite() {
                    return output;
                }
                let max_mapped_floats = mmap.len().saturating_sub(24) / 8;
                let logical_floats = max_in.saturating_mul(self.output_dim).saturating_mul(*lut_size);
                let total_floats = logical_floats.min(max_mapped_floats);
                let ptr = unsafe { mmap.as_ptr().add(24) as *const f64 };

                let min_v = *min_val;
                let max_v = *max_val;
                let range = max_v - min_v;
                let lut_len_minus_1 = (*lut_size - 1) as f64;
                let inv_range = if range > 1e-12 { lut_len_minus_1 / range } else { 0.0 };

                for (i, &inp) in input.iter().take(max_in).enumerate() {
                    if !inp.is_finite() {
                        continue;
                    }
                    let clamped = inp.clamp(min_v, max_v);
                    let idx_f = ((clamped - min_v) * inv_range).clamp(0.0, lut_len_minus_1);
                    let i0 = idx_f.floor() as usize;
                    let i1 = (i0 + 1).min(*lut_size - 1);
                    let frac = idx_f - i0 as f64;
                    let w0 = 1.0 - frac;
                    let w1 = frac;

                    let base = i * self.output_dim;
                    for (j, out_slot) in output.iter_mut().take(max_out).enumerate() {
                        let start = (base + j) * *lut_size;
                        if start + i1 < total_floats {
                            unsafe {
                                let v0 = *ptr.add(start + i0);
                                let v1 = *ptr.add(start + i1);
                                *out_slot += w0 * v0 + w1 * v1;
                            }
                        }
                    }
                }
            }
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bspline_lut_evaluation() {
        let lut = match BSplineLUT::default_identity(-1.0, 1.0) {
            Ok(l) => l,
            Err(e) => panic!("Expected valid identity LUT, got Err: {}", e),
        };
        let val_mid = lut.evaluate(0.0);
        assert!((val_mid - 0.0).abs() < 1e-3);

        let val_high = lut.evaluate(10.0); // Clamped to 1.0 -> tanh(1.0) ~ 0.7615
        assert!((val_high - 1.0f64.tanh()).abs() < 1e-3);
    }

    #[test]
    fn test_bspline_lut_validation_returns_err() {
        let short_lut = BSplineLUT::new(vec![0.5], -1.0, 1.0);
        assert!(short_lut.is_err());

        let inverted_range = BSplineLUT::new(vec![0.0, 1.0], 5.0, -5.0);
        assert!(inverted_range.is_err());

        let identity_bad = BSplineLUT::default_identity(2.0, 2.0);
        assert!(identity_bad.is_err());
    }

    #[test]
    fn test_tkan_layer_new_heap_dimension_mismatch_returns_err() {
        let lut = match BSplineLUT::default_identity(-1.0, 1.0) {
            Ok(l) => l,
            Err(e) => panic!("Expected valid identity LUT, got Err: {}", e),
        };
        let bad_layer = TKANLayer::new_heap(vec![lut], 40, 16);
        assert!(bad_layer.is_err());
    }

    #[test]
    fn test_tkan_layer_forward() {
        let tkan = TKANLayer::default_40_to_16();
        let input = [0.5f64; 40];
        let output = tkan.forward(&input);

        assert_eq!(output.len(), 16);
        for &val in &output {
            assert!(val.is_finite());
        }
    }

    #[test]
    fn test_tkan_binary_missing_file_fallback() {
        let tkan = TKANLayer::load_from_binary_or_default("./models/non_existent_luts.bin");
        assert_eq!(tkan.input_dim, 40);
        assert_eq!(tkan.output_dim, 16);
        let input = [0.1f64; 40];
        let out = tkan.forward(&input);
        assert_eq!(out.len(), 16);
    }

    #[test]
    fn test_tkan_binary_mmap_invalid_range_validation() {
        let temp_dir = std::env::temp_dir();
        let test_path = temp_dir.join("invalid_range_lut_mmap.bin");

        // Write header with num_edges=640, lut_size=4096, min_val=10.0, max_val=-10.0
        let mut header = Vec::new();
        header.extend_from_slice(&640u32.to_le_bytes());
        header.extend_from_slice(&4096u32.to_le_bytes());
        header.extend_from_slice(&10.0f64.to_le_bytes());
        header.extend_from_slice(&(-10.0f64).to_le_bytes());
        let _ = std::fs::write(&test_path, header);

        let res = TKANLayer::load_from_binary(&test_path);
        assert!(res.is_err());
        let err_msg = res.unwrap_err();
        assert!(err_msg.contains("must be strictly greater than"));

        let _ = std::fs::remove_file(test_path);
    }
}
