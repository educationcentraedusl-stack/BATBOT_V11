use crossbeam_queue::ArrayQueue;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::metrics::{
    calculate_obi, calculate_spread_velocity, update_cvd, update_liquidation, MicrostructureMetrics,
};

pub const LOB_DEPTH: usize = 20;

pub static DROPPED_EVENTS_COUNT: AtomicU64 = AtomicU64::new(0);

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
        symbol: [u8; 16],
        symbol_len: usize,
        side: [u8; 8],
        side_len: usize,
        price: f64,
        quantity: f64,
        timestamp_ns: u64,
    },
}

impl MarketUpdateEvent {
    pub fn new_liquidation(
        sym: &str,
        side_str: &str,
        price: f64,
        quantity: f64,
        timestamp_ns: u64,
    ) -> Self {
        let mut symbol = [0u8; 16];
        let sym_bytes = sym.as_bytes();
        let sym_len = sym_bytes.len().min(16);
        symbol[..sym_len].copy_from_slice(&sym_bytes[..sym_len]);

        let mut side = [0u8; 8];
        let side_bytes = side_str.as_bytes();
        let side_len = side_bytes.len().min(8);
        side[..side_len].copy_from_slice(&side_bytes[..side_len]);

        MarketUpdateEvent::LiquidationEvent {
            symbol,
            symbol_len: sym_len,
            side,
            side_len,
            price,
            quantity,
            timestamp_ns,
        }
    }
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
        match self.queue.push(event) {
            Ok(()) => Ok(()),
            Err(evt) => {
                DROPPED_EVENTS_COUNT.fetch_add(1, Ordering::Relaxed);
                Err(evt)
            }
        }
    }

    pub fn pop(&self) -> Option<MarketUpdateEvent> {
        self.queue.pop()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn dropped_count() -> u64 {
        DROPPED_EVENTS_COUNT.load(Ordering::Relaxed)
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
            MarketUpdateEvent::LiquidationEvent {
                side,
                side_len,
                price,
                quantity,
                ..
            } => {
                let side_str = std::str::from_utf8(&side[..side_len]).unwrap_or("");
                let is_buy = side_str.eq_ignore_ascii_case("BUY");
                update_liquidation(&mut self.metrics, price, quantity, is_buy);
            }
        }
    }
}

