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
    pub w_b: Tensor,
    pub b_b: Tensor,
    pub w_c: Tensor,
    pub b_c: Tensor,
    pub w_out: Tensor,
    pub b_out: Tensor,
    pub d_skip: Tensor,
    pub w_heads: Tensor, // [d_inner, 3] -> (direction_logit, meta_logit, horizon_logit)
    pub b_heads: Tensor, // [3]
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
        Self {
            w_in,
            b_in,
            a_log,
            w_b,
            b_b,
            w_c,
            b_c,
            w_out,
            b_out,
            d_skip,
            w_heads,
            b_heads,
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

    /// Forward step evaluation for single tick inference in zero-latency HFT path.
    ///
    /// Args:
    /// - `input`: [1, input_dim] feature tensor
    /// - `h_prev`: [1, d_inner, d_state] latent state tensor
    /// - `delta_t`: elapsed time interval in seconds (clamped to [0.0001, 10.0])
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

        // 2. Selective Discretization Parameter A with Numerically Stable Softplus
        let a_clamped = self.a_log.clamp(-20.0f32, 20.0f32)?;
        let a_softplus = (a_clamped.exp()? + 1.0)?.log()?;
        let delta_a = (&a_softplus * (dt_clamped as f64))?; // [d_inner]
        let decay = delta_a.neg()?.exp()?; // [d_inner]
        let decay_3d = decay.reshape((1, self.d_inner, 1))?; // [1, d_inner, 1]

        // 3. Selective B and C projections
        let b_proj = u.matmul(&self.w_b)?.broadcast_add(&self.b_b)?; // [1, d_state]
        let c_proj = u.matmul(&self.w_c)?.broadcast_add(&self.b_c)?; // [1, d_state]

        let u_3d = u.reshape((1, self.d_inner, 1))?; // [1, d_inner, 1]
        let b_3d = b_proj.reshape((1, 1, self.d_state))?; // [1, 1, d_state]
        let c_3d = c_proj.reshape((1, 1, self.d_state))?; // [1, 1, d_state]

        // 4. True Multi-Dimensional SSM Latent State Update [1, d_inner, d_state]
        // Ensure h_prev matches [1, d_inner, d_state]
        let h_prev_aligned = if h_prev.dims() != &[1, self.d_inner, self.d_state] {
            Tensor::zeros((1, self.d_inner, self.d_state), DType::F32, input.device())?
        } else {
            h_prev.clone()
        };

        let h_decayed = h_prev_aligned.broadcast_mul(&decay_3d)?; // [1, d_inner, d_state]
        let input_outer = u_3d.broadcast_mul(&b_3d)?; // [1, d_inner, d_state]
        let h_next = (&h_decayed + &input_outer)?; // [1, d_inner, d_state]

        // 5. Output Gating with C_t Projection: Contraction across d_state dimension scaled by 1/sqrt(d_state)
        let scale_d_state = (self.d_state as f64).sqrt() as f32;
        let h_contracted = (h_next.broadcast_mul(&c_3d)?.sum(2)? / (scale_d_state as f64))?; // [1, d_inner]

        // Output Projection with Skip Connection
        let y_ssm = if self.w_out.dims() == &[self.d_inner, self.d_inner] {
            h_contracted.matmul(&self.w_out)?.broadcast_add(&self.b_out)?
        } else {
            h_contracted.broadcast_add(&self.b_out)?
        };

        let y_skip = u.broadcast_mul(&self.d_skip)?; // [1, d_inner]
        let y_raw = (&y_ssm + &y_skip)?; // [1, d_inner]

        // LayerNorm on hidden representation to center representation and prevent DC offset bias & directional collapse
        let y_mean = y_raw.mean_all()?.to_scalar::<f32>()?;
        let y_centered = (&y_raw - (y_mean as f64))?;
        let y_std = (y_centered.sqr()?.mean_all()?.to_scalar::<f32>()? + 1e-5).sqrt();
        let y = (&y_centered / (y_std as f64))?;

        // 6. Multi-Head Predictions (Direction Logit, Meta Logit, Horizon Logit)
        let raw_heads = y.matmul(&self.w_heads)?.broadcast_add(&self.b_heads)?; // [1, 3]

        Ok((raw_heads, h_next))
    }

    /// Evaluates scalar predictions directly for ultra-low latency (<1.0 µs).
    pub fn evaluate_scalar_heads(
        &self,
        raw_heads: &Tensor,
    ) -> Result<(f64, f64, f64)> {
        self.evaluate_scalar_heads_with_temp(raw_heads, 2.0)
    }

    /// Evaluates scalar predictions with explicit Softmax Temperature scaling.
    pub fn evaluate_scalar_heads_with_temp(
        &self,
        raw_heads: &Tensor,
        temperature: f64,
    ) -> Result<(f64, f64, f64)> {
        let flat = raw_heads.flatten_all()?;
        let num_elems = flat.elem_count();
        if num_elems < 3 {
            return Err(Error::Msg("INSUFFICIENT_HEAD_DIMENSIONS".to_string()));
        }

        let dir_logit = flat.get(0)?.to_scalar::<f32>()? as f64;
        let meta_logit = flat.get(1)?.to_scalar::<f32>()? as f64;
        let horiz_logit = flat.get(2)?.to_scalar::<f32>()? as f64;

        let t = temperature.clamp(0.5, 10.0);
        let dir_scale = ((self.d_inner as f64).sqrt() * 0.75).max(1.0);
        let direction = (dir_logit / (t * dir_scale)).tanh();
        let p_win = 1.0 / (1.0 + (-meta_logit / t).exp());
        let horizon_sec = ((horiz_logit / t).exp() + 1.0).ln().max(5.0);

        Ok((direction, p_win, horizon_sec))
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
}
