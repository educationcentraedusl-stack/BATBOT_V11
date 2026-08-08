use crate::oms::types::OrderIntent;

#[derive(Debug, Clone, Copy)]
pub struct ExecutionSlicerConfig {
    pub max_depth_participation_pct: f64, // e.g. 0.02 (2% of top-5 level book depth)
    pub min_slice_notional_usd: f64,     // e.g. $10.00
    pub max_slice_count: usize,          // e.g. 5 slices
}

impl Default for ExecutionSlicerConfig {
    fn default() -> Self {
        Self {
            max_depth_participation_pct: 0.02,
            min_slice_notional_usd: 10.0,
            max_slice_count: 5,
        }
    }
}

pub struct ExecutionSlicer {
    config: ExecutionSlicerConfig,
}

impl ExecutionSlicer {
    pub fn new(config: ExecutionSlicerConfig) -> Self {
        Self { config }
    }

    pub fn default_hft() -> Self {
        Self::new(ExecutionSlicerConfig::default())
    }

    /// Fast scalar quantization to step size (e.g. 0.001) without string allocations.
    #[inline(always)]
    pub fn quantize_qty(qty: f64, step_size: f64) -> f64 {
        if step_size <= 0.0 || !step_size.is_finite() || !qty.is_finite() {
            return qty;
        }
        let steps = ((qty / step_size) + 1e-9).floor();
        let res = steps * step_size;
        if res.is_finite() { res } else { qty }
    }

    /// Fast scalar quantization to tick size (e.g. 0.01) without string allocations.
    #[inline(always)]
    pub fn quantize_price(price: f64, tick_size: f64) -> f64 {
        if tick_size <= 0.0 || !tick_size.is_finite() || !price.is_finite() {
            return price;
        }
        let ticks = ((price / tick_size) + 1e-9).floor();
        let res = ticks * tick_size;
        if res.is_finite() { res } else { price }
    }

    /// Determines if an order intent exceeds the max participation threshold relative to book depth.
    pub fn should_slice(&self, intent: &OrderIntent, top5_depth_usd: f64) -> bool {
        if top5_depth_usd <= 0.0 || !top5_depth_usd.is_finite() {
            return false;
        }
        let intent_notional = intent.notional_value();
        let max_allowed_notional = top5_depth_usd * self.config.max_depth_participation_pct;
        intent_notional > max_allowed_notional && intent_notional >= (self.config.min_slice_notional_usd * 2.0)
    }

    /// Splits a large OrderIntent into micro-slices, respecting step_size and tick_size.
    pub fn slice_intent(
        &self,
        intent: &OrderIntent,
        top5_depth_usd: f64,
        step_size: f64,
        tick_size: f64,
    ) -> Vec<OrderIntent> {
        if !self.should_slice(intent, top5_depth_usd) {
            let mut single = intent.clone();
            single.quantity = Self::quantize_qty(single.quantity, step_size);
            single.price = Self::quantize_price(single.price, tick_size);
            return vec![single];
        }

        let max_slice_notional = (top5_depth_usd * self.config.max_depth_participation_pct)
            .max(self.config.min_slice_notional_usd);
        
        let price = Self::quantize_price(intent.price, tick_size);
        if price <= 0.0 {
            return vec![intent.clone()];
        }

        let max_slice_qty = Self::quantize_qty(max_slice_notional / price, step_size);
        if max_slice_qty <= 0.0 {
            return vec![intent.clone()];
        }

        let needed_slices = ((intent.quantity * price) / max_slice_notional).ceil() as usize;
        let num_slices = needed_slices.clamp(2, self.config.max_slice_count);
        let per_slice_qty = Self::quantize_qty(intent.quantity / num_slices as f64, step_size);

        let mut remaining_qty = Self::quantize_qty(intent.quantity, step_size);
        let mut slices = Vec::with_capacity(num_slices);

        for i in 0..num_slices {
            if remaining_qty <= 0.0 {
                break;
            }
            let current_slice_qty = if i == num_slices - 1 {
                remaining_qty
            } else {
                per_slice_qty.min(remaining_qty)
            };

            let quantized_slice_qty = Self::quantize_qty(current_slice_qty, step_size);
            if quantized_slice_qty <= 0.0 {
                break;
            }

            let suffix = format!("_s{}", i + 1);
            let max_base_len = 64usize.saturating_sub(suffix.len());
            let base_cid = if intent.client_order_id.len() > max_base_len {
                &intent.client_order_id[..max_base_len]
            } else {
                &intent.client_order_id
            };
            let slice_cid = format!("{}{}", base_cid, suffix);
            let slice_intent = OrderIntent {
                client_order_id: slice_cid,
                symbol: intent.symbol.clone(),
                asset_idx: intent.asset_idx,
                side: intent.side,
                order_type: intent.order_type,
                time_in_force: intent.time_in_force,
                quantity: quantized_slice_qty,
                price,
                reduce_only: intent.reduce_only,
                post_only: intent.post_only,
                target_horizon_ms: intent.target_horizon_ms,
                ai_confidence: intent.ai_confidence,
                ai_direction: intent.ai_direction,
                creation_ns: intent.creation_ns,
            };

            slices.push(slice_intent);
            let diff = remaining_qty - quantized_slice_qty;
            remaining_qty = if diff.max(0.0) <= 1e-9 { 0.0 } else { Self::quantize_qty(diff, step_size) };
        }

        if slices.is_empty() {
            vec![intent.clone()]
        } else {
            slices
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oms::types::{OrderSide, OrderType, TimeInForce};

    #[test]
    fn test_quantization_and_slicing() {
        let slicer = ExecutionSlicer::default_hft();
        let intent = OrderIntent::new(
            "test_ord_1".to_string(),
            "BTCUSDT".to_string(),
            OrderSide::Buy,
            OrderType::Limit,
            TimeInForce::Gtx,
            5.0,
            60000.0,
            false,
            true,
            100.0,
            0.9,
            1.0,
            1000,
        );

        let top5_depth = 100000.0;
        let slices = slicer.slice_intent(&intent, top5_depth, 0.001, 0.1);
        assert!(!slices.is_empty());
        assert!(slices.len() <= 5);
        let total_qty: f64 = slices.iter().map(|s| s.quantity).sum();
        assert!((total_qty - 5.0).abs() < 1e-9);
    }
}

