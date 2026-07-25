use crate::lob::LockFreeSpscQueue;
use crate::ws::binance::BinanceWsStream;
use crate::ws::bybit::BybitWsStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::time::{sleep, Duration, Instant};

pub enum ExchangeType {
    Binance,
    Bybit,
}

pub struct ConnectionManager {
    symbol: String,
    exchange: ExchangeType,
    is_active: Arc<AtomicBool>,
    rotation_interval_secs: u64,
    overlap_duration_secs: u64,
}

impl ConnectionManager {
    pub fn new(symbol: &str, exchange: ExchangeType) -> Self {
        Self {
            symbol: symbol.to_string(),
            exchange,
            is_active: Arc::new(AtomicBool::new(false)),
            rotation_interval_secs: 84600, // 23.5 hours
            overlap_duration_secs: 1800,   // 30 minutes overlap (until 24.0 hours)
        }
    }

    pub fn stop(&self) {
        self.is_active.store(false, Ordering::Relaxed);
    }

    pub async fn run_rotation_loop(&self, queue: LockFreeSpscQueue) -> Result<(), String> {
        self.is_active.store(true, Ordering::Relaxed);

        while self.is_active.load(Ordering::Relaxed) {
            let start_time = Instant::now();

            // Spawn primary socket listener
            let primary_active = Arc::new(AtomicBool::new(true));
            let primary_active_clone = primary_active.clone();
            let symbol_clone = self.symbol.clone();
            match self.exchange {
                ExchangeType::Binance => {
                    let binance_stream = Arc::new(BinanceWsStream::new(&symbol_clone));
                    let bs_clone = binance_stream.clone();
                    let q_clone = queue.clone();

                    tokio::spawn(async move {
                        let _ = bs_clone.connect_and_listen(q_clone).await;
                    });
                }
                ExchangeType::Bybit => {
                    let bybit_stream = Arc::new(BybitWsStream::new(&symbol_clone));
                    let bs_clone = bybit_stream.clone();
                    let q_clone = queue.clone();

                    tokio::spawn(async move {
                        let _ = bs_clone.connect_and_listen(q_clone).await;
                    });
                }
            }

            // Sleep until 23.5 hours mark
            let rotation_duration = Duration::from_secs(self.rotation_interval_secs);
            let mut elapsed = Duration::from_secs(0);

            while elapsed < rotation_duration && self.is_active.load(Ordering::Relaxed) {
                sleep(Duration::from_secs(10)).await;
                elapsed = start_time.elapsed();
            }

            if !self.is_active.load(Ordering::Relaxed) {
                break;
            }

            // 23.5-hour threshold reached: Initiate secondary connection overlap
            let secondary_queue = LockFreeSpscQueue::new(10000);
            match self.exchange {
                ExchangeType::Binance => {
                    let sec_stream = Arc::new(BinanceWsStream::new(&self.symbol));
                    let sec_clone = sec_stream.clone();

                    tokio::spawn(async move {
                        let _ = sec_clone.connect_and_listen(secondary_queue).await;
                    });
                }
                ExchangeType::Bybit => {
                    let sec_stream = Arc::new(BybitWsStream::new(&self.symbol));
                    let sec_clone = sec_stream.clone();

                    tokio::spawn(async move {
                        let _ = sec_clone.connect_and_listen(secondary_queue).await;
                    });
                }
            }

            // Maintain overlap for 30 minutes before shutting down legacy primary socket
            sleep(Duration::from_secs(self.overlap_duration_secs)).await;
            primary_active_clone.store(false, Ordering::Relaxed);
        }

        Ok(())
    }
}
