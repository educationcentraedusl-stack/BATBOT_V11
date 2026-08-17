use crossbeam_queue::ArrayQueue;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::metrics::{
    calculate_obi, calculate_spread_velocity, update_cvd, update_liquidation, MicrostructureMetrics,
};
use super::microstructure::MicrostructureAnalyzer;

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
    pub analyzer: MicrostructureAnalyzer,
    pub last_update_ns: u64,
}

impl LimitOrderBook {
    pub fn new() -> Self {
        Self {
            bids: [(0.0, 0.0); LOB_DEPTH],
            asks: [(0.0, 0.0); LOB_DEPTH],
            metrics: MicrostructureMetrics::default(),
            analyzer: MicrostructureAnalyzer::new(50000.0),
            last_update_ns: 0,
        }
    }

    pub fn update_depth(
        &mut self,
        new_bids: &[(f64, f64); LOB_DEPTH],
        new_asks: &[(f64, f64); LOB_DEPTH],
        timestamp_ns: u64,
    ) {
        // Condition 3: Fast SIMD-aligned memmove via ptr::copy_nonoverlapping
        unsafe {
            std::ptr::copy_nonoverlapping(new_bids.as_ptr(), self.bids.as_mut_ptr(), LOB_DEPTH);
            std::ptr::copy_nonoverlapping(new_asks.as_ptr(), self.asks.as_mut_ptr(), LOB_DEPTH);
        }

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

        self.analyzer.on_depth_update(&self.bids, &self.asks, timestamp_ns);

        self.metrics.obi = obi_val;
        self.metrics.spread_velocity = spread_vel;
        self.metrics.last_spread = current_spread;
        self.metrics.last_timestamp_ns = timestamp_ns;
        self.metrics.rv_gk = self.analyzer.get_rv_gk();
        self.metrics.vpin = self.analyzer.get_vpin();
        self.metrics.hurst = self.analyzer.get_hurst();
        self.metrics.lob_entropy = self.analyzer.get_lob_entropy();
        self.metrics.micro_price = self.analyzer.get_micro_price();
        self.metrics.regime = self.analyzer.get_regime() as u8;
        self.metrics.is_sweep_detected = self.analyzer.is_sweep_detected();
        self.metrics.multi_level_ofi = self.analyzer.get_multi_level_ofi();
        self.metrics.hawkes_asymmetry = self.analyzer.get_hawkes_asymmetry();
        self.last_update_ns = timestamp_ns;
    }

    /// Retrieve live top of book: (best_bid, best_ask, mid_price)
    pub fn get_top_of_book(&self) -> Option<(f64, f64, f64)> {
        let best_bid = self.bids[0].0;
        let best_ask = self.asks[0].0;

        if best_bid > 0.0 && best_ask > 0.0 && best_ask >= best_bid {
            let mid_price = (best_bid + best_ask) * 0.5;
            Some((best_bid, best_ask, mid_price))
        } else if best_bid > 0.0 {
            Some((best_bid, best_bid, best_bid))
        } else if best_ask > 0.0 {
            Some((best_ask, best_ask, best_ask))
        } else {
            None
        }
    }

    /// O(1) / memmove fast insertion or update of a bid level (sorted descending by price)
    #[inline(always)]
    pub fn update_bid_level_delta(&mut self, price: f64, quantity: f64) {
        if quantity == 0.0 {
            for i in 0..LOB_DEPTH {
                if (self.bids[i].0 - price).abs() < 1e-9 {
                    unsafe {
                        let ptr = self.bids.as_mut_ptr();
                        std::ptr::copy(ptr.add(i + 1), ptr.add(i), LOB_DEPTH - 1 - i);
                    }
                    self.bids[LOB_DEPTH - 1] = (0.0, 0.0);
                    break;
                }
            }
            return;
        }

        for i in 0..LOB_DEPTH {
            if (self.bids[i].0 - price).abs() < 1e-9 {
                self.bids[i].1 = quantity;
                return;
            } else if price > self.bids[i].0 {
                unsafe {
                    let ptr = self.bids.as_mut_ptr();
                    std::ptr::copy(ptr.add(i), ptr.add(i + 1), LOB_DEPTH - 1 - i);
                }
                self.bids[i] = (price, quantity);
                return;
            }
        }
    }

    /// O(1) / memmove fast insertion or update of an ask level (sorted ascending by price)
    #[inline(always)]
    pub fn update_ask_level_delta(&mut self, price: f64, quantity: f64) {
        if quantity == 0.0 {
            for i in 0..LOB_DEPTH {
                if (self.asks[i].0 - price).abs() < 1e-9 {
                    unsafe {
                        let ptr = self.asks.as_mut_ptr();
                        std::ptr::copy(ptr.add(i + 1), ptr.add(i), LOB_DEPTH - 1 - i);
                    }
                    self.asks[LOB_DEPTH - 1] = (0.0, 0.0);
                    break;
                }
            }
            return;
        }

        for i in 0..LOB_DEPTH {
            if (self.asks[i].0 - price).abs() < 1e-9 {
                self.asks[i].1 = quantity;
                return;
            } else if self.asks[i].0 == 0.0 || price < self.asks[i].0 {
                unsafe {
                    let ptr = self.asks.as_mut_ptr();
                    std::ptr::copy(ptr.add(i), ptr.add(i + 1), LOB_DEPTH - 1 - i);
                }
                self.asks[i] = (price, quantity);
                return;
            }
        }
    }

    pub fn process_trade(&mut self, price: f64, quantity: f64, is_buyer_maker: bool, timestamp_ns: u64) {
        self.metrics.cvd = update_cvd(self.metrics.cvd, price, quantity, is_buyer_maker);
        self.analyzer.on_trade_with_ts(price, quantity, is_buyer_maker, timestamp_ns);

        self.metrics.rv_gk = self.analyzer.get_rv_gk();
        self.metrics.vpin = self.analyzer.get_vpin();
        self.metrics.hurst = self.analyzer.get_hurst();
        self.metrics.regime = self.analyzer.get_regime() as u8;
        self.metrics.multi_level_ofi = self.analyzer.get_multi_level_ofi();
        self.metrics.hawkes_asymmetry = self.analyzer.get_hawkes_asymmetry();
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
                timestamp_ns,
            } => {
                self.process_trade(price, quantity, is_buyer_maker, timestamp_ns);
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

    pub fn calculate_dynamic_collars(
        &self,
        entry_price: f64,
        position_side: &str,
    ) -> (f64, f64) {
        self.analyzer.calculate_dynamic_collars(entry_price, position_side, self.metrics.obi, self.metrics.last_spread)
    }

    /// Single-lock batch update and evaluation method (eliminates redundant RwLock acquisitions)
    pub fn process_and_evaluate(&mut self, event: MarketUpdateEvent) -> (Option<(f64, f64, f64)>, MicrostructureMetrics) {
        self.process_event(event);
        let top_of_book = self.get_top_of_book();
        (top_of_book, self.metrics.clone())
    }
}

pub const MAX_CONCURRENT_ASSETS: usize = 10;

/// Lock-free Multi-Asset L2 Orderbook Manager with per-asset fine-grained RwLocks.
/// Manages up to 10 concurrent asset orderbooks in a dedicated synchronous unblocked OS thread.
pub struct MultiAssetLOBManager {
    books: [std::sync::RwLock<LimitOrderBook>; MAX_CONCURRENT_ASSETS],
    is_running: std::sync::atomic::AtomicBool,
}

impl MultiAssetLOBManager {
    pub fn new() -> Self {
        // Initialize 10 distinct per-asset fine-grained RwLock<LimitOrderBook> instances
        let books_array: [std::sync::RwLock<LimitOrderBook>; MAX_CONCURRENT_ASSETS] =
            std::array::from_fn(|_| std::sync::RwLock::new(LimitOrderBook::new()));
        Self {
            books: books_array,
            is_running: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::Relaxed);
    }

    /// Single-lock batch update and metric retrieval method taking RwLock write guard EXACTLY ONCE per tick.
    pub fn process_and_evaluate_asset(
        &self,
        asset_idx: usize,
        event: MarketUpdateEvent,
    ) -> Option<(Option<(f64, f64, f64)>, MicrostructureMetrics)> {
        if asset_idx >= MAX_CONCURRENT_ASSETS {
            return None;
        }
        if let Ok(mut book) = self.books[asset_idx].write() {
            Some(book.process_and_evaluate(event))
        } else {
            None
        }
    }

    pub fn process_event_for_asset(&self, asset_idx: usize, event: MarketUpdateEvent) {
        if asset_idx >= MAX_CONCURRENT_ASSETS {
            return;
        }
        if let Ok(mut book) = self.books[asset_idx].write() {
            book.process_event(event);
        }
    }

    pub fn get_metrics_for_asset(&self, asset_idx: usize) -> Option<MicrostructureMetrics> {
        if asset_idx >= MAX_CONCURRENT_ASSETS {
            return None;
        }
        self.books[asset_idx].read().ok().map(|b| b.metrics.clone())
    }

    pub fn get_top_of_book_for_asset(&self, asset_idx: usize) -> Option<(f64, f64, f64)> {
        if asset_idx >= MAX_CONCURRENT_ASSETS {
            return None;
        }
        self.books[asset_idx].read().ok().and_then(|b| b.get_top_of_book())
    }

    /// Condition 2: Synchronous dedicated processing loop running outside Tokio runtime.
    /// Spawns a dedicated OS thread pinned to consuming SPSC queue events synchronously.
    pub fn spawn_unblocked_processor(
        self: Arc<Self>,
        queues: Vec<LockFreeSpscQueue>,
    ) -> std::thread::JoinHandle<()> {
        self.is_running.store(true, Ordering::Relaxed);
        std::thread::Builder::new()
            .name("batbot-hft-l2-processor".to_string())
            .spawn(move || {
                println!("[MultiAssetLOBManager] Dedicated synchronous L2 processor thread active.");
                while self.is_running.load(Ordering::Relaxed) {
                    let mut processed_any = false;
                    for (asset_idx, q) in queues.iter().enumerate() {
                        while let Some(evt) = q.pop() {
                            self.process_event_for_asset(asset_idx, evt);
                            processed_any = true;
                        }
                    }
                    if !processed_any {
                        // Micro-spin / spin-loop pause to prevent CPU burning when queue is empty
                        std::hint::spin_loop();
                    }
                }
                println!("[MultiAssetLOBManager] Synchronous L2 processor thread terminated cleanly.");
            })
            .expect("Failed to spawn dedicated synchronous L2 processor thread")
    }
}

