pub mod book;
pub mod metrics;
pub mod microstructure;
pub mod universe_scanner;

pub use book::{LimitOrderBook, LockFreeSpscQueue, MarketUpdateEvent, PriceLevel, LOB_DEPTH};
pub use metrics::{calculate_obi, calculate_spread_velocity, update_cvd, MicrostructureMetrics};
pub use microstructure::{MicroRegime, MicrostructureAnalyzer};
pub use universe_scanner::{calculate_cs_lvr_score, AltcoinMetrics, UniverseScanner};

