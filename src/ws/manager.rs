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

enum ActiveStream {
    Binance(Arc<BinanceWsStream>),
    Bybit(Arc<BybitWsStream>),
}

impl ActiveStream {
    fn stop(&self) {
        match self {
            ActiveStream::Binance(s) => s.stop(),
            ActiveStream::Bybit(s) => s.stop(),
        }
    }
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

    fn spawn_stream(&self, queue: LockFreeSpscQueue) -> ActiveStream {
        match self.exchange {
            ExchangeType::Binance => {
                let stream = Arc::new(BinanceWsStream::new(&self.symbol));
                let s_clone = stream.clone();
                tokio::spawn(async move {
                    let _ = s_clone.connect_and_listen(queue).await;
                });
                ActiveStream::Binance(stream)
            }
            ExchangeType::Bybit => {
                let stream = Arc::new(BybitWsStream::new(&self.symbol));
                let s_clone = stream.clone();
                tokio::spawn(async move {
                    let _ = s_clone.connect_and_listen(queue).await;
                });
                ActiveStream::Bybit(stream)
            }
        }
    }

    pub async fn run_rotation_loop(&self, queue: LockFreeSpscQueue) -> Result<(), String> {
        self.is_active.store(true, Ordering::Relaxed);

        // Spawn initial primary stream
        let mut primary_stream = self.spawn_stream(queue.clone());

        while self.is_active.load(Ordering::Relaxed) {
            let start_time = Instant::now();

            // Sleep until 23.5 hours mark
            let rotation_duration = Duration::from_secs(self.rotation_interval_secs);
            while start_time.elapsed() < rotation_duration && self.is_active.load(Ordering::Relaxed) {
                sleep(Duration::from_secs(10)).await;
            }

            if !self.is_active.load(Ordering::Relaxed) {
                primary_stream.stop();
                break;
            }

            // 23.5-hour threshold reached: Initiate secondary connection overlap using main queue
            let secondary_stream = self.spawn_stream(queue.clone());

            // Maintain overlap for 30 minutes before shutting down legacy primary socket
            let overlap_start = Instant::now();
            let overlap_duration = Duration::from_secs(self.overlap_duration_secs);
            while overlap_start.elapsed() < overlap_duration && self.is_active.load(Ordering::Relaxed) {
                sleep(Duration::from_secs(5)).await;
            }

            // Cleanly shut down legacy primary socket
            primary_stream.stop();

            // Promote secondary stream to primary for next rotation cycle
            primary_stream = secondary_stream;
        }

        primary_stream.stop();
        Ok(())
    }
}

