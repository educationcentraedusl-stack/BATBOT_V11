use std::sync::atomic::{AtomicU64, Ordering};
use crate::oms::types::{OrderIntent, OrderSide, OrderType, TimeInForce};

pub struct SmartOrderRouter {
    min_confidence_threshold: f64,
    aggressive_confidence_threshold: f64,
    max_horizon_for_sweep_ms: f64,
    order_seq: AtomicU64,
}

impl SmartOrderRouter {
    pub fn new(
        min_confidence_threshold: f64,
        aggressive_confidence_threshold: f64,
        max_horizon_for_sweep_ms: f64,
    ) -> Self {
        Self {
            min_confidence_threshold,
            aggressive_confidence_threshold,
            max_horizon_for_sweep_ms,
            order_seq: AtomicU64::new(1),
        }
    }

    pub fn default_hft() -> Self {
        Self::new(0.60, 0.85, 50.0)
    }

    pub fn route_order(
        &self,
        symbol: &str,
        direction: f64,
        confidence: f64,
        horizon_ms: f64,
        best_bid: f64,
        best_ask: f64,
        spread_vel: f64,
        slippage_ticks: f64,
        tick_size: f64,
        quantity: f64,
        creation_ns: u64,
    ) -> Option<OrderIntent> {
        if confidence < self.min_confidence_threshold
            || direction.abs() < 1e-5
            || quantity <= 0.0
            || best_bid <= 0.0
            || best_ask <= 0.0
        {
            return None;
        }

        let side = if direction > 0.0 {
            OrderSide::Buy
        } else {
            OrderSide::Sell
        };

        let is_aggressive_sweep = confidence >= self.aggressive_confidence_threshold
            && horizon_ms <= self.max_horizon_for_sweep_ms
            && spread_vel.abs() > 0.5;

        let (price, time_in_force, post_only) = if is_aggressive_sweep {
            let offset = slippage_ticks.max(1.0) * tick_size;
            let sweep_price = match side {
                OrderSide::Buy => best_ask + offset,
                OrderSide::Sell => (best_bid - offset).max(tick_size),
            };
            (sweep_price, TimeInForce::Ioc, false)
        } else {
            let maker_price = match side {
                OrderSide::Buy => best_bid,
                OrderSide::Sell => best_ask,
            };
            (maker_price, TimeInForce::Gtx, true)
        };

        let seq = self.order_seq.fetch_add(1, Ordering::Relaxed);
        let client_order_id = format!("BAT_{}_{}", creation_ns % 1_000_000_000, seq);

        Some(OrderIntent::new(
            client_order_id,
            symbol.to_string(),
            side,
            OrderType::Limit,
            time_in_force,
            quantity,
            price,
            false,
            post_only,
            horizon_ms,
            confidence,
            direction,
            creation_ns,
        ))
    }
}
