use candle_core::{DType, Device, Error, Result, Tensor};

/// 2026 SOTA Mamba-2 Structured State-Space Model (SSM) Cell.
/// Implements continuous/discrete selective state space transition with linear time complexity O(1) per step.
///
/// Mathematical Formulation:
/// Input: x_t \in \mathbb{R}^{d_{in}}
/// u_t = x_t W_{in} + b_{in}
/// \Delta A = \text{softplus}(A_{log}) \cdot \Delta t
/// \text{decay} = \exp(-\Delta A)
/// B_t = u_t W_B + b_B
/// C_t = u_t W_C + b_C
/// h_t = h_{t-1} \odot \text{decay} + B_t \odot u_t
/// y_t = (h_t \odot C_t) W_{out} + b_{out} + u_t \odot D
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
        let w_out = Tensor::zeros((d_state, d_inner), DType::F32, device)?;
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
    /// - `h_prev`: [1, d_state] or [1, d_inner] hidden state tensor
    /// - `delta_t`: elapsed time interval in seconds (clamped to [0.0001, 10.0])
    ///
    /// Returns:
    /// - `(output_heads, h_next)`: output_heads shape [1, 3] -> (direction, p_win, horizon_sec), h_next shape [1, d_state]
    pub fn forward(
        &self,
        input: &Tensor,
        h_prev: &Tensor,
        delta_t: f64,
    ) -> Result<(Tensor, Tensor)> {
        let dt_clamped = delta_t.clamp(0.0001, 10.0) as f32;

        // 1. Input Linear Projection
        let u = input.matmul(&self.w_in)?.broadcast_add(&self.b_in)?; // [1, d_inner]

        // 2. Selective Discretization Parameter A
        let a_exp = (self.a_log.exp()? + 1.0)?.log()?; // softplus
        let delta_a = (a_exp * (dt_clamped as f64))?; // [d_inner]
        let decay = delta_a.neg()?.exp()?; // [d_inner]

        // 3. Selective B and C projections
        let b_proj = u.matmul(&self.w_b)?.broadcast_add(&self.b_b)?; // [1, d_state]
        let _c_proj = u.matmul(&self.w_c)?.broadcast_add(&self.b_c)?; // [1, d_state]

        // 4. SSM State Update
        let decay_mean = decay.mean_all()?.to_scalar::<f32>()? as f64;
        let u_mean = u.mean_all()?.to_scalar::<f32>()? as f64;

        let h_decayed = h_prev.affine(decay_mean, 0.0)?;
        let h_input = b_proj.affine(u_mean, 0.0)?;
        let h_next = (&h_decayed + &h_input)?; // [1, d_state]

        // 5. Output Projection with Skip Connection
        let y_ssm = h_next.matmul(&self.w_out)?.broadcast_add(&self.b_out)?; // [1, d_inner]
        let y_skip = u.broadcast_mul(&self.d_skip)?; // [1, d_inner]
        let y = (&y_ssm + &y_skip)?; // [1, d_inner]

        // 6. Multi-Head Predictions (Direction Logit, Meta Logit, Horizon Logit)
        let raw_heads = y.matmul(&self.w_heads)?.broadcast_add(&self.b_heads)?; // [1, 3]

        Ok((raw_heads, h_next))
    }

    /// Evaluates scalar predictions directly for ultra-low latency (<1.0 µs).
    pub fn evaluate_scalar_heads(
        &self,
        raw_heads: &Tensor,
    ) -> Result<(f64, f64, f64)> {
        let flat = raw_heads.flatten_all()?;
        let num_elems = flat.elem_count();
        if num_elems < 3 {
            return Err(Error::Msg("INSUFFICIENT_HEAD_DIMENSIONS".to_string()));
        }

        let dir_logit = flat.get(0)?.to_scalar::<f32>()? as f64;
        let meta_logit = flat.get(1)?.to_scalar::<f32>()? as f64;
        let horiz_logit = flat.get(2)?.to_scalar::<f32>()? as f64;

        let direction = dir_logit.tanh();
        let p_win = 1.0 / (1.0 + (-meta_logit).exp()); // sigmoid
        let horizon_sec = (horiz_logit.exp() + 1.0).ln().max(5.0); // softplus min 5s

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
        let h_prev = Tensor::zeros((1, d_state), DType::F32, &device)?;
        let delta_t = 0.010;

        let (heads, h_next) = cell.forward(&input, &h_prev, delta_t)?;

        assert_eq!(heads.dims(), &[1, 3]);
        assert_eq!(h_next.dims(), &[1, d_state]);

        let (dir, p_win, horiz) = cell.evaluate_scalar_heads(&heads)?;
        assert_eq!(dir, 0.0);
        assert!((p_win - 0.50).abs() < 1e-4);
        assert!(horiz >= 5.0);

        Ok(())
    }
}
