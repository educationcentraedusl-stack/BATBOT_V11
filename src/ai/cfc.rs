use candle_core::{Result, Tensor};

#[derive(Debug, Clone)]
pub struct CfCCell {
    pub w_alpha: Tensor,
    pub b_alpha: Tensor,
    pub w_beta: Tensor,
    pub b_beta: Tensor,
    pub w_output: Tensor,
    pub b_output: Tensor,
    pub hidden_dim: usize,
}

impl CfCCell {
    pub fn new(
        w_alpha: Tensor,
        b_alpha: Tensor,
        w_beta: Tensor,
        b_beta: Tensor,
        w_output: Tensor,
        b_output: Tensor,
    ) -> Self {
        Self {
            w_alpha,
            b_alpha,
            w_beta,
            b_beta,
            w_output,
            b_output,
            hidden_dim: 32,
        }
    }

    /// Forward pass of the 2026 Closed-form Continuous-time (CfC) cell.
    ///
    /// Mathematical formulation:
    /// \chi = concat(input, z_prev)
    /// \alpha = softplus(W_\alpha \cdot \chi + b_\alpha)
    /// \beta = tanh(W_\beta \cdot \chi + b_\beta)
    /// z = \beta - (\beta - z_prev) \odot exp(-\alpha \cdot \Delta t)
    /// output = W_out \cdot z + b_out
    pub fn forward(
        &self,
        input: &Tensor,
        z_prev: &Tensor,
        delta_t: f64,
    ) -> Result<(Tensor, Tensor)> {
        let concat_dim = input.rank().saturating_sub(1);
        let chi = Tensor::cat(&[input, z_prev], concat_dim)?;

        // \alpha = softplus(W_\alpha \cdot \chi + b_\alpha)
        let alpha_linear = chi.matmul(&self.w_alpha)?.broadcast_add(&self.b_alpha)?;
        let alpha = (alpha_linear.exp()? + 1.0)?.log()?;

        // \beta = tanh(W_\beta \cdot \chi + b_\beta)
        let beta_linear = chi.matmul(&self.w_beta)?.broadcast_add(&self.b_beta)?;
        let beta = beta_linear.tanh()?;

        // z = \beta - (\beta - z_prev) \odot exp(-\alpha \cdot \Delta t)
        let decay_factor = (alpha * (-delta_t))?.exp()?;
        let z_diff = (&beta - z_prev)?;
        let z = (&beta - z_diff.mul(&decay_factor)?)?;

        // output = W_out \cdot z + b_out
        let output = z.matmul(&self.w_output)?.broadcast_add(&self.b_output)?;

        Ok((output, z))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candle_core::{Device, DType};

    #[test]
    fn test_cfc_cell_forward_pass() -> Result<()> {
        let device = Device::Cpu;
        let input_dim = 10;
        let hidden_dim = 32;
        let output_dim = 1;
        let concat_dim = input_dim + hidden_dim; // 42

        let w_alpha = Tensor::zeros((concat_dim, hidden_dim), DType::F32, &device)?;
        let b_alpha = Tensor::zeros((hidden_dim,), DType::F32, &device)?;

        let w_beta = Tensor::zeros((concat_dim, hidden_dim), DType::F32, &device)?;
        let b_beta = Tensor::zeros((hidden_dim,), DType::F32, &device)?;

        let w_output = Tensor::zeros((hidden_dim, output_dim), DType::F32, &device)?;
        let b_output = Tensor::zeros((output_dim,), DType::F32, &device)?;

        let cell = CfCCell::new(w_alpha, b_alpha, w_beta, b_beta, w_output, b_output);

        let input = Tensor::zeros((1, input_dim), DType::F32, &device)?;
        let z_prev = Tensor::zeros((1, hidden_dim), DType::F32, &device)?;
        let delta_t = 0.001;

        let (output, z_next) = cell.forward(&input, &z_prev, delta_t)?;

        assert_eq!(output.dims(), &[1, output_dim]);
        assert_eq!(z_next.dims(), &[1, hidden_dim]);

        Ok(())
    }
}
