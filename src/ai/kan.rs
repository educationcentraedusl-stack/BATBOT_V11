use std::fs::File;
use std::io::Read;
use std::path::Path;

pub const LUT_SIZE: usize = 4096;

#[derive(Debug, Clone)]
pub struct BSplineLUT {
    pub lut: Vec<f64>,
    pub min_val: f64,
    pub max_val: f64,
}

impl BSplineLUT {
    pub fn new(lut: Vec<f64>, min_val: f64, max_val: f64) -> Self {
        assert!(
            lut.len() >= 2,
            "BSplineLUT size must be at least 2 for interpolation"
        );
        assert!(
            max_val > min_val,
            "max_val must be strictly greater than min_val"
        );
        Self {
            lut,
            min_val,
            max_val,
        }
    }

    pub fn default_identity(min_val: f64, max_val: f64) -> Self {
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
    pub fn evaluate(&self, input: f64) -> f64 {
        let clamped = input.clamp(self.min_val, self.max_val);
        let norm = (clamped - self.min_val) / (self.max_val - self.min_val);
        let idx_f = norm * (self.lut.len() - 1) as f64;
        let i0 = idx_f.floor() as usize;
        let i1 = (i0 + 1).min(self.lut.len() - 1);
        let frac = idx_f - i0 as f64;

        (1.0 - frac) * self.lut[i0] + frac * self.lut[i1]
    }
}

#[derive(Debug, Clone)]
pub struct TKANLayer {
    pub edges: Vec<BSplineLUT>,
    pub input_dim: usize,
    pub output_dim: usize,
}

impl TKANLayer {
    pub fn new(edges: Vec<BSplineLUT>, input_dim: usize, output_dim: usize) -> Self {
        assert_eq!(
            edges.len(),
            input_dim * output_dim,
            "Number of edges must equal input_dim * output_dim"
        );
        Self {
            edges,
            input_dim,
            output_dim,
        }
    }

    pub fn default_40_to_16() -> Self {
        let input_dim = 40;
        let output_dim = 16;
        let total_edges = input_dim * output_dim;
        let mut edges = Vec::with_capacity(total_edges);

        for _ in 0..total_edges {
            edges.push(BSplineLUT::default_identity(-1000.0, 1000.0));
        }

        Self::new(edges, input_dim, output_dim)
    }

    pub fn load_from_binary<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let path_ref = path.as_ref();
        let mut file = File::open(path_ref).map_err(|e| format!("Failed to open LUT binary file {}: {}", path_ref.display(), e))?;

        let mut header_buf = [0u8; 24];
        file.read_exact(&mut header_buf).map_err(|e| format!("Failed to read LUT header from {}: {}", path_ref.display(), e))?;

        let num_edges = u32::from_le_bytes(
            header_buf[0..4]
                .try_into()
                .map_err(|_| format!("Failed to parse num_edges slice from {}", path_ref.display()))?,
        ) as usize;
        let lut_size = u32::from_le_bytes(
            header_buf[4..8]
                .try_into()
                .map_err(|_| format!("Failed to parse lut_size slice from {}", path_ref.display()))?,
        ) as usize;
        let min_val = f64::from_le_bytes(
            header_buf[8..16]
                .try_into()
                .map_err(|_| format!("Failed to parse min_val slice from {}", path_ref.display()))?,
        );
        let max_val = f64::from_le_bytes(
            header_buf[16..24]
                .try_into()
                .map_err(|_| format!("Failed to parse max_val slice from {}", path_ref.display()))?,
        );

        if num_edges != 640 || lut_size < 2 {
            return Err(format!(
                "Invalid LUT dimensions in {}: num_edges={}, lut_size={}",
                path_ref.display(),
                num_edges,
                lut_size
            ));
        }

        if max_val <= min_val {
            return Err(format!(
                "Invalid LUT range in {}: max_val ({}) must be strictly greater than min_val ({})",
                path_ref.display(),
                max_val,
                min_val
            ));
        }

        let input_dim = 40;
        let output_dim = 16;

        let total_floats = num_edges * lut_size;
        let mut data_buf = vec![0u8; total_floats * 8];
        file.read_exact(&mut data_buf).map_err(|e| format!("Failed to read LUT payload data from {}: {}", path_ref.display(), e))?;

        let mut edges = Vec::with_capacity(num_edges);
        for edge_idx in 0..num_edges {
            let start = edge_idx * lut_size * 8;
            let mut lut = Vec::with_capacity(lut_size);
            for i in 0..lut_size {
                let offset = start + i * 8;
                let slice = data_buf
                    .get(offset..offset + 8)
                    .ok_or_else(|| format!("LUT data buffer index out of bounds at offset {} in {}", offset, path_ref.display()))?;
                let val_bytes: [u8; 8] = slice
                    .try_into()
                    .map_err(|_| format!("Failed to parse f64 slice at offset {} in {}", offset, path_ref.display()))?;
                let val = f64::from_le_bytes(val_bytes);
                lut.push(val);
            }
            edges.push(BSplineLUT::new(lut, min_val, max_val));
        }

        println!(
            "[BATBOT_V11][T-KAN] Successfully loaded {} edge B-spline LUTs from {}.",
            num_edges,
            path_ref.display()
        );
        Ok(Self::new(edges, input_dim, output_dim))
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
        for j in 0..self.output_dim {
            let mut sum = 0.0f64;
            for i in 0..self.input_dim {
                let edge_idx = i * self.output_dim + j;
                sum += self.edges[edge_idx].evaluate(input[i]);
            }
            output[j] = sum;
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bspline_lut_evaluation() {
        let lut = BSplineLUT::default_identity(-1.0, 1.0);
        let val_mid = lut.evaluate(0.0);
        assert!((val_mid - 0.0).abs() < 1e-3);

        let val_high = lut.evaluate(10.0); // Clamped to 1.0 -> tanh(1.0) ~ 0.7615
        assert!((val_high - 1.0f64.tanh()).abs() < 1e-3);
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
        assert_eq!(tkan.edges.len(), 640);
        let input = [0.1f64; 40];
        let out = tkan.forward(&input);
        assert_eq!(out.len(), 16);
    }

    #[test]
    fn test_tkan_binary_invalid_range_validation() {
        let temp_dir = std::env::temp_dir();
        let test_path = temp_dir.join("invalid_range_lut.bin");

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

