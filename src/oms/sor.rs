use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use crate::oms::types::{OrderIntent, OrderSide, OrderType, TimeInForce};

pub struct SmartOrderRouter {
    min_confidence_threshold: f64,
    aggressive_confidence_threshold: f64,
    max_horizon_for_sweep_ms: f64,
    tick_size: f64,
    order_seq: AtomicU64,
}

impl SmartOrderRouter {
    pub fn new(
        min_confidence_threshold: f64,
        aggressive_confidence_threshold: f64,
        max_horizon_for_sweep_ms: f64,
        tick_size: f64,
    ) -> Self {
        Self {
            min_confidence_threshold,
            aggressive_confidence_threshold,
            max_horizon_for_sweep_ms,
            tick_size,
            order_seq: AtomicU64::new(1),
        }
    }

    pub fn default_hft() -> Self {
        Self::new(0.60, 0.85, 50.0, 0.10)
    }

    pub fn tick_size(&self) -> f64 {
        self.tick_size
    }

    pub fn route_order(
        &self,
        symbol: &str,
        asset_idx: usize,
        direction: f64,
        confidence: f64,
        horizon_ms: f64,
        best_bid: f64,
        best_ask: f64,
        spread_vel: f64,
        v_depletion: f64,
        flow_toxicity: f64,
        slippage_ticks: f64,
        tick_size: f64,
        quantity: f64,
        creation_ns: u64,
    ) -> Option<OrderIntent> {
        if !direction.is_finite()
            || !confidence.is_finite()
            || !horizon_ms.is_finite()
            || !best_bid.is_finite()
            || !best_ask.is_finite()
            || !spread_vel.is_finite()
            || !v_depletion.is_finite()
            || !flow_toxicity.is_finite()
            || !slippage_ticks.is_finite()
            || !tick_size.is_finite()
            || !quantity.is_finite()
        {
            return None;
        }

        if confidence < self.min_confidence_threshold
            || direction.abs() < 1e-5
            || quantity <= 0.0
            || best_bid <= 0.0
            || best_ask <= 0.0
        {
            return None;
        }

        let effective_tick = if tick_size > 0.0 { tick_size } else { self.tick_size };

        let side = if direction > 0.0 {
            OrderSide::Buy
        } else {
            OrderSide::Sell
        };

        // Determine aggressive taker sweep vs post-only maker
        let is_aggressive_sweep = (confidence >= self.aggressive_confidence_threshold
            && horizon_ms <= self.max_horizon_for_sweep_ms
            && spread_vel.abs() > 0.5)
            || (v_depletion > 0.60 && flow_toxicity < 0.70);

        let (price, time_in_force, post_only) = if is_aggressive_sweep {
            let offset = slippage_ticks.max(1.0) * effective_tick;
            let sweep_price = match side {
                OrderSide::Buy => best_ask + offset,
                OrderSide::Sell => (best_bid - offset).max(effective_tick),
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

        // Stack-allocated buffer for zero-heap client_order_id formatting
        let mut id_buf = [0u8; 64];
        let id_len = {
            let mut cursor = std::io::Cursor::new(&mut id_buf[..]);
            let ts_mod = creation_ns % 1_000_000_000;
            let _ = write!(cursor, "BAT_{}_{}_{}", asset_idx, ts_mod, seq);
            cursor.position() as usize
        };

        let client_order_id = match std::str::from_utf8(&id_buf[..id_len]) {
            Ok(s) => String::from(s),
            Err(_) => String::from("BAT_0_0_0"),
        };
        let symbol_str = String::from(symbol);

        Some(
            OrderIntent::new(
                client_order_id,
                symbol_str,
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
            )
            .with_asset_idx(asset_idx),
        )
    }
}

