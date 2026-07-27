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
}
