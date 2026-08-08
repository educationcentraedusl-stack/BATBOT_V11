use std::sync::atomic::{AtomicU64, Ordering};
use crate::oms::types::OrderIntent;

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

    pub fn route_packet(
        &self,
        pkt: &crate::oms::types::OrderIntentPacket,
        best_bid: f64,
        best_ask: f64,
        spread_vel: f64,
        v_depletion: f64,
        flow_toxicity: f64,
        slippage_ticks: f64,
        tick_size: f64,
    ) -> Option<crate::oms::types::OrderIntentPacket> {
        let direction = pkt.ai_direction as f64;
        let confidence = pkt.ai_confidence as f64;
        let horizon_ms = pkt.target_horizon_ms as f64;
        let quantity = pkt.quantity;

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
            || best_bid >= best_ask
        {
            return None;
        }

        let effective_tick = if tick_size > 0.0 { tick_size } else { self.tick_size };
        let inv_tick = 1.0 / effective_tick;

        let side_u8 = if direction > 0.0 { 0u8 } else { 1u8 };

        // Determine aggressive taker sweep vs post-only maker
        let is_aggressive_sweep = (confidence >= self.aggressive_confidence_threshold
            && horizon_ms <= self.max_horizon_for_sweep_ms
            && spread_vel.abs() > 0.5)
            || (v_depletion > 0.60 && flow_toxicity < 0.70);

        let (raw_price, time_in_force_u8, post_only) = if is_aggressive_sweep {
            let offset = slippage_ticks.max(1.0) * effective_tick;
            let sweep_price = if side_u8 == 0 {
                best_ask + offset
            } else {
                (best_bid - offset).max(effective_tick)
            };
            (sweep_price, 1u8, false)
        } else {
            let maker_price = if side_u8 == 0 { best_bid } else { best_ask };
            (maker_price, 3u8, true)
        };

        let target_price = if pkt.price > 0.0 { pkt.price } else { raw_price };

        let is_crossing = if side_u8 == 0 {
            target_price >= best_ask
        } else {
            target_price <= best_bid
        };

        let effective_post_only = if is_crossing { false } else { post_only };

        let unclamped_price = if effective_post_only {
            if side_u8 == 0 {
                ((target_price * inv_tick) + 1e-9).floor() * effective_tick
            } else {
                ((target_price * inv_tick) - 1e-9).ceil() * effective_tick
            }
        } else {
            if side_u8 == 0 {
                ((target_price * inv_tick) - 1e-9).ceil() * effective_tick
            } else {
                ((target_price * inv_tick) + 1e-9).floor() * effective_tick
            }
        };

        // Strict spread non-crossing protection for maker post-only orders
        let price = if effective_post_only {
            if side_u8 == 0 {
                unclamped_price.min((best_ask - effective_tick).max(effective_tick))
            } else {
                unclamped_price.max(best_bid + effective_tick)
            }
        } else {
            unclamped_price.max(effective_tick)
        };

        let mut routed = *pkt;
        routed.side = side_u8;
        routed.time_in_force = time_in_force_u8;
        routed.set_post_only(effective_post_only);
        routed.price = price;

        if routed.client_order_id_str().is_empty() {
            let seq = self.order_seq.fetch_add(1, Ordering::Relaxed);
            let mut cid_buf = [0u8; 64];
            let cid_str = format!("BAT_{}_{}_{}", pkt.asset_idx, pkt.creation_ns % 1_000_000_000, seq);
            let b = cid_str.as_bytes();
            let len = b.len().min(64);
            cid_buf[..len].copy_from_slice(&b[..len]);
            routed.client_order_id_bytes = cid_buf;
        }

        Some(routed)
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
        self.route_order_with_id(
            symbol,
            asset_idx,
            direction,
            confidence,
            horizon_ms,
            best_bid,
            best_ask,
            spread_vel,
            v_depletion,
            flow_toxicity,
            slippage_ticks,
            tick_size,
            quantity,
            creation_ns,
            None,
            None,
        )
    }

    pub fn route_order_with_id(
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
        custom_client_order_id: Option<&str>,
        requested_price: Option<f64>,
    ) -> Option<OrderIntent> {
        let mut pkt = crate::oms::types::OrderIntentPacket::default();
        pkt.asset_idx = asset_idx as u32;
        pkt.ai_direction = direction as f32;
        pkt.ai_confidence = confidence as f32;
        pkt.target_horizon_ms = horizon_ms as f32;
        pkt.quantity = quantity;
        pkt.price = requested_price.unwrap_or(0.0);
        pkt.creation_ns = creation_ns;
        pkt.set_symbol(symbol);
        if let Some(cid) = custom_client_order_id {
            pkt.set_client_order_id(cid);
        }

        let routed_pkt = self.route_packet(
            &pkt,
            best_bid,
            best_ask,
            spread_vel,
            v_depletion,
            flow_toxicity,
            slippage_ticks,
            tick_size,
        )?;

        Some(routed_pkt.to_intent())
    }
}

