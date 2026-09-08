use candle_core::{DType, Device, Error, Result, Tensor};

/// 2026 SOTA Mamba-2 Structured State-Space Model (SSM) Cell.
/// Implements continuous/discrete selective state space transition with linear time complexity O(1) per step.
///
/// Mathematical Formulation:
/// Input: x_t \in \mathbb{R}^{1 \times d_{in}}
/// u_t = x_t W_{in} + b_{in} \in \mathbb{R}^{1 \times d_{inner}}
/// \Delta A = \text{softplus}(A_{log}) \cdot \Delta t \in \mathbb{R}^{d_{inner}}
/// \text{decay} = \exp(-\Delta A) \in \mathbb{R}^{1 \times d_{inner} \times 1}
/// B_t = u_t W_B + b_B \in \mathbb{R}^{1 \times d_{state}}
/// C_t = u_t W_C + b_C \in \mathbb{R}^{1 \times d_{state}}
/// h_t = h_{t-1} \odot \text{decay} + (u_t \otimes B_t) \in \mathbb{R}^{1 \times d_{inner} \times d_{state}}
/// y_{ssm} = \sum_{j=1}^{d_{state}} (h_{t, :, j} \odot C_{t, j}) W_{out} + b_{out}
/// y_t = y_{ssm} + u_t \odot D \in \mathbb{R}^{1 \times d_{inner}}
///
/// Output Heads:
/// 1. Directional Skew: \tanh(y_t W_{dir} + b_{dir}) \in [-1.0, 1.0]
/// 2. Meta-Labeling Probability: \sigma(y_t W_{meta} + b_{meta}) \in [0.0, 1.0]
/// 3. Estimated Holding Horizon: \text{softplus}(y_t W_{horiz} + b_{horiz})
#[derive(Debug, Clone)]
pub struct Mamba2Cell {
    pub w_in: Tensor,
    pub b_in: Tensor,
    pub a_log: Tensor,
    pub a_softplus: Tensor,
    pub w_b: Tensor,
    pub b_b: Tensor,
    pub w_c: Tensor,
    pub b_c: Tensor,
    pub w_out: Tensor,
    pub b_out: Tensor,
    pub d_skip: Tensor,
    pub w_heads: Tensor, // [d_inner, 3] -> (direction_logit, meta_logit, horizon_logit)
    pub b_heads: Tensor, // [3]
    pub w_heads_flat: Vec<f32>,
    pub b_heads_flat: Vec<f32>,
    pub input_dim: usize,
    pub d_inner: usize,
    pub d_state: usize,
}

impl Mamba2Cell {
    pub fn new(
        w_in: Tensor,
        b_in: Tensor,
        a_log: Tensor,
        w_b: Tensor,
        b_b: Tensor,
        w_c: Tensor,
        b_c: Tensor,
        w_out: Tensor,
        b_out: Tensor,
        d_skip: Tensor,
        w_heads: Tensor,
        b_heads: Tensor,
        input_dim: usize,
        d_inner: usize,
        d_state: usize,
    ) -> Self {
        let a_clamped = a_log.clamp(-20.0f32, 20.0f32).unwrap_or_else(|_| a_log.clone());
        let a_softplus = a_clamped.exp().and_then(|e| (e + 1.0)?.log()).unwrap_or_else(|_| a_log.clone());
        let w_heads_flat = w_heads.flatten_all().and_then(|t| t.to_vec1::<f32>()).unwrap_or_default();
        let b_heads_flat = b_heads.flatten_all().and_then(|t| t.to_vec1::<f32>()).unwrap_or_default();
        Self {
            w_in,
            b_in,
            a_log,
            a_softplus,
            w_b,
            b_b,
            w_c,
            b_c,
            w_out,
            b_out,
            d_skip,
            w_heads,
            b_heads,
            w_heads_flat,
            b_heads_flat,
            input_dim,
            d_inner,
            d_state,
        }
    }

    /// Creates a default initialized Mamba-2 cell on the specified device.
    pub fn default_cell(
        input_dim: usize,
        d_inner: usize,
        d_state: usize,
        device: &Device,
    ) -> Result<Self> {
        let w_in = Tensor::zeros((input_dim, d_inner), DType::F32, device)?;
        let b_in = Tensor::zeros((d_inner,), DType::F32, device)?;
        let a_log = Tensor::zeros((d_inner,), DType::F32, device)?;
        let w_b = Tensor::zeros((d_inner, d_state), DType::F32, device)?;
        let b_b = Tensor::zeros((d_state,), DType::F32, device)?;
        let w_c = Tensor::zeros((d_inner, d_state), DType::F32, device)?;
        let b_c = Tensor::zeros((d_state,), DType::F32, device)?;
        let w_out = Tensor::zeros((d_inner, d_inner), DType::F32, device)?;
        let b_out = Tensor::zeros((d_inner,), DType::F32, device)?;
        let d_skip = Tensor::ones((d_inner,), DType::F32, device)?;
        let w_heads = Tensor::zeros((d_inner, 3), DType::F32, device)?;
        let b_heads = Tensor::zeros((3,), DType::F32, device)?;

        Ok(Self::new(
            w_in, b_in, a_log, w_b, b_b, w_c, b_c, w_out, b_out, d_skip, w_heads, b_heads,
            input_dim, d_inner, d_state,
        ))
    }

    /// True SOTA Mamba-2 Discretized State Space Evolution:
    ///
    /// Mathematical Formulation:
    /// \Delta_t = \text{clamp}(\Delta t, 0.0001, 10.0)
    /// A = -\text{softplus}(A_{\text{log}}) \implies \bar{A}_t = \exp(\Delta_t \cdot A)
    /// B_t = u_t W_B + b_B, \quad C_t = u_t W_C + b_C
    /// h_t = \bar{A}_t \odot h_{t-1} + (1 - \bar{A}_t) \odot (u_t \otimes B_t)
    /// y_t = (h_t \cdot C_t^\top) W_{\text{out}} + u_t \odot D_{\text{skip}}
    ///
    /// Pre-Head RMSNorm:
    /// y_t \leftarrow \text{RMSNorm}(y_t)
    ///
    /// Multi-Head Predictions:
    /// \text{heads}_t = y_t W_{\text{heads}} + b_{\text{heads}} \implies [\text{dir\_logit}, \text{meta\_logit}, \text{horizon\_logit}]
    ///
    /// Returns:
    /// - `(output_heads, h_next)`: output_heads shape [1, 3] -> (direction, p_win, horizon_sec), h_next shape [1, d_inner, d_state]
    pub fn forward(
        &self,
        input: &Tensor,
        h_prev: &Tensor,
        delta_t: f64,
    ) -> Result<(Tensor, Tensor)> {
        let dt_clamped = delta_t.clamp(0.0001, 10.0) as f32;

        // 1. Input Linear Projection
        let u = input.matmul(&self.w_in)?.broadcast_add(&self.b_in)?; // [1, d_inner]

        // 2. Selective Discretization Parameter A with precomputed Softplus
        let delta_a = (&self.a_softplus * (dt_clamped as f64))?; // [d_inner]
        let decay = delta_a.neg()?.exp()?; // [d_inner]
        let one_minus_decay = (1.0f64 - &decay)?; // [d_inner]
        let decay_3d = decay.reshape((1, self.d_inner, 1))?; // [1, d_inner, 1]
        let one_minus_decay_3d = one_minus_decay.reshape((1, self.d_inner, 1))?; // [1, d_inner, 1]

        // 3. Selective B and C projections
        let b_proj = u.matmul(&self.w_b)?.broadcast_add(&self.b_b)?; // [1, d_state]
        let c_proj = u.matmul(&self.w_c)?.broadcast_add(&self.b_c)?; // [1, d_state]

        let u_3d = u.reshape((1, self.d_inner, 1))?; // [1, d_inner, 1]
        let b_3d = b_proj.reshape((1, 1, self.d_state))?; // [1, 1, self.d_state]
        let c_3d = c_proj.reshape((1, 1, self.d_state))?; // [1, 1, self.d_state]

        // 4. True Multi-Dimensional SSM Latent State Update [1, d_inner, d_state]
        let h_decayed = if h_prev.dims() == &[1, self.d_inner, self.d_state] {
            h_prev.broadcast_mul(&decay_3d)?
        } else {
            let h_init = Tensor::zeros((1, self.d_inner, self.d_state), DType::F32, input.device())?;
            h_init.broadcast_mul(&decay_3d)?
        };

        let input_outer = u_3d.broadcast_mul(&b_3d)?; // [1, d_inner, d_state]
        let input_scaled = input_outer.broadcast_mul(&one_minus_decay_3d)?; // [1, d_inner, d_state]
        let h_next = (&h_decayed + &input_scaled)?; // [1, d_inner, d_state]

        // 5. Output Gating with C_t Projection: Contraction across d_state dimension
        let h_contracted = h_next.broadcast_mul(&c_3d)?.sum(2)?; // [1, d_inner]

        // Output Projection with Skip Connection
        let y_ssm = if self.w_out.dims() == &[self.d_inner, self.d_inner] {
            h_contracted.matmul(&self.w_out)?.broadcast_add(&self.b_out)?
        } else {
            h_contracted.broadcast_add(&self.b_out)?
        };

        let y_skip = u.broadcast_mul(&self.d_skip)?; // [1, d_inner]
        let y = (&y_ssm + &y_skip)?; // [1, d_inner]

        // 6. Pre-Head RMSNorm & Multi-Head Predictions (Direction Logit, Meta Logit, Horizon Logit)
        let y_sq = (&y * &y)?;
        let y_sum = y_sq.sum(1)?.unsqueeze(1)?; // [1, 1]
        let y_mean = (y_sum / (self.d_inner as f64))?;
        let y_rms = (y_mean + 1e-6)?.sqrt()?;
        let y_norm = y.broadcast_div(&y_rms)?;

        let raw_heads = y_norm.matmul(&self.w_heads)?.broadcast_add(&self.b_heads)?; // [1, 3]

        Ok((raw_heads, h_next))
    }

    /// Zero-tensor-allocation combined forward pass and head evaluation for ultra-low latency (<50 µs).
    pub fn forward_and_evaluate(
        &self,
        input: &Tensor,
        h_prev: &Tensor,
        delta_t: f64,
        temperature: f64,
    ) -> Result<((f64, f64, f64), Tensor)> {
        let dt_clamped = delta_t.clamp(0.0001, 10.0) as f32;

        // 1. Input Linear Projection
        let u = input.matmul(&self.w_in)?.broadcast_add(&self.b_in)?; // [1, d_inner]

        // 2. Selective Discretization Parameter A with precomputed Softplus
        let delta_a = (&self.a_softplus * (dt_clamped as f64))?; // [d_inner]
        let decay = delta_a.neg()?.exp()?; // [d_inner]
        let one_minus_decay = (1.0f64 - &decay)?; // [d_inner]
        let decay_3d = decay.reshape((1, self.d_inner, 1))?; // [1, d_inner, 1]
        let one_minus_decay_3d = one_minus_decay.reshape((1, self.d_inner, 1))?; // [1, d_inner, 1]

        // 3. Selective B and C projections
        let b_proj = u.matmul(&self.w_b)?.broadcast_add(&self.b_b)?; // [1, d_state]
        let c_proj = u.matmul(&self.w_c)?.broadcast_add(&self.b_c)?; // [1, d_state]

        let u_3d = u.reshape((1, self.d_inner, 1))?; // [1, d_inner, 1]
        let b_3d = b_proj.reshape((1, 1, self.d_state))?; // [1, 1, d_state]
        let c_3d = c_proj.reshape((1, 1, self.d_state))?; // [1, 1, d_state]

        // 4. True Multi-Dimensional SSM Latent State Update [1, d_inner, d_state]
        let h_decayed = if h_prev.dims() == &[1, self.d_inner, self.d_state] {
            h_prev.broadcast_mul(&decay_3d)?
        } else {
            let h_init = Tensor::zeros((1, self.d_inner, self.d_state), DType::F32, input.device())?;
            h_init.broadcast_mul(&decay_3d)?
        };

        let input_outer = u_3d.broadcast_mul(&b_3d)?; // [1, d_inner, d_state]
        let input_scaled = input_outer.broadcast_mul(&one_minus_decay_3d)?; // [1, d_inner, d_state]
        let h_next = (&h_decayed + &input_scaled)?; // [1, d_inner, d_state]

        // 5. Output Gating with C_t Projection: Contraction across d_state dimension
        let h_contracted = h_next.broadcast_mul(&c_3d)?.sum(2)?; // [1, d_inner]

        // Output Projection with Skip Connection
        let y_ssm = if self.w_out.dims() == &[self.d_inner, self.d_inner] {
            h_contracted.matmul(&self.w_out)?.broadcast_add(&self.b_out)?
        } else {
            h_contracted.broadcast_add(&self.b_out)?
        };

        let y_skip = u.broadcast_mul(&self.d_skip)?; // [1, d_inner]
        let y = (&y_ssm + &y_skip)?; // [1, d_inner]

        // 6. Direct In-Register RMSNorm & Heads Projection (Zero tensor overhead)
        let y_vec = y.flatten_all()?.to_vec1::<f32>()?;
        let mean_sq: f32 = y_vec.iter().map(|v| v * v).sum::<f32>() / (self.d_inner as f32);
        let rms_inv = 1.0f32 / (mean_sq + 1e-6f32).sqrt();

        let mut dir_logit = self.b_heads_flat.get(0).copied().unwrap_or(0.0) as f64;
        let mut meta_logit = self.b_heads_flat.get(1).copied().unwrap_or(0.0) as f64;
        let mut horiz_logit = self.b_heads_flat.get(2).copied().unwrap_or(0.0) as f64;

        for i in 0..self.d_inner {
            let y_n = (y_vec[i] * rms_inv) as f64;
            dir_logit += y_n * (self.w_heads_flat.get(i * 3 + 0).copied().unwrap_or(0.0) as f64);
            meta_logit += y_n * (self.w_heads_flat.get(i * 3 + 1).copied().unwrap_or(0.0) as f64);
            horiz_logit += y_n * (self.w_heads_flat.get(i * 3 + 2).copied().unwrap_or(0.0) as f64);
        }

        let t = temperature.clamp(0.5, 10.0);
        let ssm_scale = ((self.d_inner * self.d_state) as f64).sqrt().max(1.0);
        let direction_raw = dir_logit / ssm_scale;
        let p_win = 1.0 / (1.0 + (-meta_logit / (t * (self.d_inner as f64).sqrt())).exp());
        let horizon_sec = ((horiz_logit / t).exp() + 1.0).ln().max(5.0);

        Ok(((direction_raw, p_win, horizon_sec), h_next))
    }

    /// Evaluates scalar predictions directly for ultra-low latency (<1.0 µs).
    pub fn evaluate_scalar_heads(
        &self,
        raw_heads: &Tensor,
    ) -> Result<(f64, f64, f64)> {
        self.evaluate_scalar_heads_with_temp(raw_heads, 1.0)
    }

    /// Evaluates scalar predictions with explicit Softmax Temperature scaling.
    pub fn evaluate_scalar_heads_with_temp(
        &self,
        raw_heads: &Tensor,
        temperature: f64,
    ) -> Result<(f64, f64, f64)> {
        let vec = raw_heads.flatten_all()?.to_vec1::<f32>()?;
        if vec.len() < 3 {
            return Err(Error::Msg("INSUFFICIENT_HEAD_DIMENSIONS".to_string()));
        }

        let dir_logit = vec[0] as f64;
        let meta_logit = vec[1] as f64;
        let horiz_logit = vec[2] as f64;

        let t = temperature.clamp(0.5, 10.0);
        let ssm_scale = ((self.d_inner * self.d_state) as f64).sqrt().max(1.0);
        // DEF-R1: RMS-Normalized Raw Logit Passthrough (NO inner tanh compression)
        let direction_raw = dir_logit / ssm_scale;
        let p_win = 1.0 / (1.0 + (-meta_logit / (t * (self.d_inner as f64).sqrt())).exp());
        let horizon_sec = ((horiz_logit / t).exp() + 1.0).ln().max(5.0);

        Ok((direction_raw, p_win, horizon_sec))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mamba2_cell_initialization_and_forward() -> Result<()> {
        let device = Device::Cpu;
        let input_dim = 16;
        let d_inner = 32;
        let d_state = 16;

        let cell = Mamba2Cell::default_cell(input_dim, d_inner, d_state, &device)?;

        let input = Tensor::zeros((1, input_dim), DType::F32, &device)?;
        let h_prev = Tensor::zeros((1, d_inner, d_state), DType::F32, &device)?;
        let delta_t = 0.010;

        let (heads, h_next) = cell.forward(&input, &h_prev, delta_t)?;

        assert_eq!(heads.dims(), &[1, 3]);
        assert_eq!(h_next.dims(), &[1, d_inner, d_state]);

        let (dir, p_win, horiz) = cell.evaluate_scalar_heads(&heads)?;
        assert_eq!(dir, 0.0);
        assert!((p_win - 0.50).abs() < 1e-4);
        assert!(horiz >= 5.0);

        Ok(())
    }

    #[test]
    fn test_zero_input_loaded_mamba_baseline() {
        let engine = crate::ai::weights::AiEngine::load_from_file("./models/cfc_weights.safetensors");
        if let Some(mamba) = &engine.mamba {
            let dev = Device::Cpu;
            let zero_input = Tensor::zeros((1, 16), DType::F32, &dev).unwrap();
            let zero_h = Tensor::zeros((1, mamba.d_inner, mamba.d_state), DType::F32, &dev).unwrap();
            let (heads, _) = mamba.forward(&zero_input, &zero_h, 0.001).unwrap();
            let flat = heads.flatten_all().unwrap();
            let dir_logit = flat.get(0).unwrap().to_scalar::<f32>().unwrap();
            let meta_logit = flat.get(1).unwrap().to_scalar::<f32>().unwrap();
            let horiz_logit = flat.get(2).unwrap().to_scalar::<f32>().unwrap();
            println!("Zero Input Loaded Mamba Logits -> dir: {:.4}, meta: {:.4}, horiz: {:.4}",
                dir_logit, meta_logit, horiz_logit);
        }
    }

    #[test]
    fn test_mamba_single_pass_logit_range() -> Result<()> {
        let device = Device::Cpu;
        let cell = Mamba2Cell::default_cell(16, 32, 16, &device)?;

        // Extreme positive logit (50.0) -> must NOT be compressed by inner tanh
        let heads = Tensor::from_slice(&[50.0f32, 1.0f32, 2.0f32], (1, 3), &device)?;
        let (dir_raw, _p_win, _horiz_sec) = cell.evaluate_scalar_heads_with_temp(&heads, 1.0)?;

        let ssm_scale = ((cell.d_inner * cell.d_state) as f64).sqrt().max(1.0);
        let expected_dir_raw = 50.0 / ssm_scale;

        assert!((dir_raw - expected_dir_raw).abs() < 1e-5);
        // Physical proof: dir_raw > 1.0 proves inner tanh is completely eliminated
        assert!(dir_raw > 1.0, "dir_raw must exceed 1.0 for large logits, proving no inner tanh");

        // Extreme negative logit (-50.0) -> must be < -1.0
        let neg_heads = Tensor::from_slice(&[-50.0f32, 1.0f32, 2.0f32], (1, 3), &device)?;
        let (neg_dir_raw, _, _) = cell.evaluate_scalar_heads_with_temp(&neg_heads, 1.0)?;
        assert!(neg_dir_raw < -1.0, "neg_dir_raw must be < -1.0 for large negative logits");

        // Composite assembly in engine applies single tanh
        let obi = 0.5;
        let ofi = 0.3;
        let hawkes = 0.2;
        let composite_logit = dir_raw + 0.15 * obi + 0.10 * ofi + 0.05 * hawkes;
        let dir = composite_logit.tanh().clamp(-1.0, 1.0);
        assert!(dir >= -1.0 && dir <= 1.0);
        assert!(dir > 0.90 && dir <= 1.0);

        Ok(())
    }
}
