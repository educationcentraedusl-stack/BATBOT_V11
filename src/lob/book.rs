use crossbeam_queue::ArrayQueue;
use std::sync::Arc;

use super::metrics::{calculate_obi, calculate_spread_velocity, update_cvd, MicrostructureMetrics};

pub const LOB_DEPTH: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PriceLevel {
    pub price: f64,
    pub quantity: f64,
}

impl Default for PriceLevel {
    fn default() -> Self {
        Self {
            price: 0.0,
            quantity: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub enum MarketUpdateEvent {
    DepthUpdate {
        bids: [(f64, f64); LOB_DEPTH],
        asks: [(f64, f64); LOB_DEPTH],
        timestamp_ns: u64,
    },
    TradeEvent {
        price: f64,
        quantity: f64,
        is_buyer_maker: bool,
        timestamp_ns: u64,
    },
    LiquidationEvent {
        symbol: String,
        side: String,
        price: f64,
        quantity: f64,
        timestamp_ns: u64,
    },
}

#[derive(Clone)]
pub struct LockFreeSpscQueue {
    queue: Arc<ArrayQueue<MarketUpdateEvent>>,
}

impl LockFreeSpscQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            queue: Arc::new(ArrayQueue::new(capacity)),
        }
    }

    pub fn push(&self, event: MarketUpdateEvent) -> Result<(), MarketUpdateEvent> {
        self.queue.push(event)
    }

    pub fn pop(&self) -> Option<MarketUpdateEvent> {
        self.queue.pop()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
}

pub struct LimitOrderBook {
    pub bids: [(f64, f64); LOB_DEPTH],
    pub asks: [(f64, f64); LOB_DEPTH],
    pub metrics: MicrostructureMetrics,
    pub last_update_ns: u64,
}

impl LimitOrderBook {
    pub fn new() -> Self {
        Self {
            bids: [(0.0, 0.0); LOB_DEPTH],
            asks: [(0.0, 0.0); LOB_DEPTH],
            metrics: MicrostructureMetrics::default(),
            last_update_ns: 0,
        }
    }

    pub fn update_depth(
        &mut self,
        new_bids: &[(f64, f64); LOB_DEPTH],
        new_asks: &[(f64, f64); LOB_DEPTH],
        timestamp_ns: u64,
    ) {
        self.bids.copy_from_slice(new_bids);
        self.asks.copy_from_slice(new_asks);

        let previous_spread = self.metrics.last_spread;
        let current_spread = if self.asks[0].0 > 0.0 && self.bids[0].0 > 0.0 {
            self.asks[0].0 - self.bids[0].0
        } else {
            0.0
        };

        let elapsed_seconds = if self.last_update_ns > 0 && timestamp_ns > self.last_update_ns {
            (timestamp_ns - self.last_update_ns) as f64 / 1_000_000_000.0
        } else {
            0.0
        };

        let spread_vel = calculate_spread_velocity(current_spread, previous_spread, elapsed_seconds);
        let obi_val = calculate_obi(&self.bids, &self.asks);

        self.metrics.obi = obi_val;
        self.metrics.spread_velocity = spread_vel;
        self.metrics.last_spread = current_spread;
        self.metrics.last_timestamp_ns = timestamp_ns;
        self.last_update_ns = timestamp_ns;
    }

    pub fn process_trade(&mut self, price: f64, quantity: f64, is_buyer_maker: bool) {
        self.metrics.cvd = update_cvd(self.metrics.cvd, price, quantity, is_buyer_maker);
    }

    pub fn process_event(&mut self, event: MarketUpdateEvent) {
        match event {
            MarketUpdateEvent::DepthUpdate {
                bids,
                asks,
                timestamp_ns,
            } => {
                self.update_depth(&bids, &asks, timestamp_ns);
            }
            MarketUpdateEvent::TradeEvent {
                price,
                quantity,
                is_buyer_maker,
                ..
            } => {
                self.process_trade(price, quantity, is_buyer_maker);
            }
            MarketUpdateEvent::LiquidationEvent { .. } => {
                // Liquidation events tracked for order flow analytics
            }
        }
    }
}
