use crate::lob::LockFreeSpscQueue;
use crate::ws::binance::BinanceWsStream;
use crate::ws::bybit::BybitWsStream;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::time::{sleep, Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
                    let mut backoff_secs = 1u64;
                    loop {
                        if s_clone.is_shutdown_requested() {
                            break;
                        }
                        match s_clone.connect_and_listen(queue.clone()).await {
                            Ok(()) => {
                                if s_clone.is_shutdown_requested() {
                                    break;
                                }
                                eprintln!(
                                    "[Binance WS] Stream disconnected. Reconnecting in {}s...",
                                    backoff_secs
                                );
                            }
                            Err(e) => {
                                if s_clone.is_shutdown_requested() {
                                    break;
                                }
                                eprintln!(
                                    "[Binance WS] Connection failed: {}. Retrying in {}s...",
                                    e, backoff_secs
                                );
                            }
                        }
                        let shutdown_notify = s_clone.shutdown_notify();
                        tokio::select! {
                            _ = shutdown_notify.notified() => {
                                break;
                            }
                            _ = sleep(Duration::from_secs(backoff_secs)) => {}
                        }
                        backoff_secs = (backoff_secs * 2).min(30);
                    }
                });
                ActiveStream::Binance(stream)
            }
            ExchangeType::Bybit => {
                let stream = Arc::new(BybitWsStream::new(&self.symbol));
                let s_clone = stream.clone();
                tokio::spawn(async move {
                    let mut backoff_secs = 1u64;
                    loop {
                        if s_clone.is_shutdown_requested() {
                            break;
                        }
                        match s_clone.connect_and_listen(queue.clone()).await {
                            Ok(()) => {
                                if s_clone.is_shutdown_requested() {
                                    break;
                                }
                                eprintln!(
                                    "[Bybit WS] Stream disconnected. Reconnecting in {}s...",
                                    backoff_secs
                                );
                            }
                            Err(e) => {
                                if s_clone.is_shutdown_requested() {
                                    break;
                                }
                                eprintln!(
                                    "[Bybit WS] Connection failed: {}. Retrying in {}s...",
                                    e, backoff_secs
                                );
                            }
                        }
                        let shutdown_notify = s_clone.shutdown_notify();
                        tokio::select! {
                            _ = shutdown_notify.notified() => {
                                break;
                            }
                            _ = sleep(Duration::from_secs(backoff_secs)) => {}
                        }
                        backoff_secs = (backoff_secs * 2).min(30);
                    }
                });
                ActiveStream::Bybit(stream)
            }
        }
    }

    pub async fn run_rotation_loop(&self, queue: LockFreeSpscQueue) -> Result<(), String> {
        self.is_active.store(true, Ordering::Relaxed);
        let mut primary_stream = self.spawn_stream(queue.clone());

        while self.is_active.load(Ordering::Relaxed) {
            let start_time = Instant::now();
            let rotation_duration = Duration::from_secs(self.rotation_interval_secs);
            while start_time.elapsed() < rotation_duration && self.is_active.load(Ordering::Relaxed) {
                sleep(Duration::from_secs(10)).await;
            }

            if !self.is_active.load(Ordering::Relaxed) {
                primary_stream.stop();
                break;
            }

            let secondary_stream = self.spawn_stream(queue.clone());
            let overlap_start = Instant::now();
            let overlap_duration = Duration::from_secs(self.overlap_duration_secs);
            while overlap_start.elapsed() < overlap_duration && self.is_active.load(Ordering::Relaxed) {
                sleep(Duration::from_secs(5)).await;
            }

            primary_stream.stop();
            primary_stream = secondary_stream;
        }

        primary_stream.stop();
        Ok(())
    }
}

/// Dynamic Multi-Stream Connection Manager Pool for Top K Altcoins.
/// Manages parallel WebSocket streams per symbol with dynamic hot-swapping and Binance rate-limit protection.
pub struct MultiStreamManager {
    max_active_assets: usize,
    exchange: ExchangeType,
    is_active: Arc<AtomicBool>,
    streams: Arc<Mutex<HashMap<String, (usize, Arc<BinanceWsStream>)>>>,
}

impl MultiStreamManager {
    pub fn new(max_active_assets: usize, exchange: ExchangeType) -> Self {
        let env_max: usize = std::env::var("MAX_CONCURRENT_ASSETS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(max_active_assets);

        Self {
            max_active_assets: env_max.max(1),
            exchange,
            is_active: Arc::new(AtomicBool::new(true)),
            streams: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn exchange(&self) -> ExchangeType {
        self.exchange
    }

    pub fn max_active_assets(&self) -> usize {
        self.max_active_assets
    }

    pub fn is_active(&self) -> bool {
        self.is_active.load(Ordering::Relaxed)
    }

    pub fn stop_all(&self) {
        self.is_active.store(false, Ordering::Relaxed);
        let mut guard = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        for (sym, (_, stream)) in guard.drain() {
            println!("[MultiStreamManager] Stopping stream for symbol: {}", sym);
            stream.stop();
        }
    }

    /// Dynamically hot-swaps active WebSocket connections for the target top K symbols.
    /// Retains unchanged active streams, cleanly stops dropped symbols, and connects added symbols.
    /// Applies rate-limit backoff (200ms per new connection) to respect Binance connection constraints.
    pub async fn update_subscriptions(
        &self,
        new_top_k: &[String],
        queues: &[LockFreeSpscQueue],
    ) -> Result<Vec<String>, String> {
        if !self.is_active.load(Ordering::Relaxed) {
            return Err("MultiStreamManager is stopped".to_string());
        }

        let target_symbols: Vec<String> = new_top_k
            .iter()
            .take(self.max_active_assets)
            .map(|s| s.to_uppercase())
            .collect();

        let mut streams_to_spawn: Vec<(String, usize, Arc<BinanceWsStream>)> = Vec::new();

        {
            let mut streams_guard = self.streams.lock().unwrap_or_else(|e| e.into_inner());

            // 1. Identify and stop symbols to remove
            let current_symbols: Vec<String> = streams_guard.keys().cloned().collect();
            for sym in &current_symbols {
                if !target_symbols.contains(sym) {
                    if let Some((asset_idx, stream)) = streams_guard.remove(sym) {
                        println!(
                            "[MultiStreamManager] Dynamic Hot-Swap: Removing symbol {} from slot {}",
                            sym, asset_idx
                        );
                        stream.stop();
                    }
                }
            }

            // 2. Identify available asset slots
            let used_slots: Vec<usize> = streams_guard.values().map(|(idx, _)| *idx).collect();
            let mut available_slots: Vec<usize> = (0..self.max_active_assets)
                .filter(|idx| !used_slots.contains(idx))
                .collect();

            // 3. Instantiate and reserve new symbols synchronously inside streams_guard
            for sym in &target_symbols {
                if streams_guard.contains_key(sym) {
                    continue;
                }

                if let Some(slot) = available_slots.pop() {
                    if slot >= queues.len() {
                        eprintln!(
                            "[MultiStreamManager Warning] Slot {} exceeds provided queues length {}",
                            slot, queues.len()
                        );
                        continue;
                    }

                    println!(
                        "[MultiStreamManager] Dynamic Hot-Swap: Reserving symbol {} in slot {}",
                        sym, slot
                    );

                    let stream = Arc::new(BinanceWsStream::new(sym));
                    streams_guard.insert(sym.clone(), (slot, stream.clone()));
                    streams_to_spawn.push((sym.clone(), slot, stream));
                } else {
                    eprintln!(
                        "[MultiStreamManager Warning] No available slots left for symbol {}",
                        sym
                    );
                }
            }
        } // Lock is explicitly dropped here after all slots & streams are firmly reserved!

        // 4. Spawn connection tasks for reserved streams and apply rate-limit backoff (NO MUTEX LOCK HELD across await!)
        for (sym, slot, stream) in streams_to_spawn {
            println!(
                "[MultiStreamManager] Spawning connection task for symbol {} in slot {}",
                sym, slot
            );
            let s_clone = stream.clone();
            let queue_clone = queues[slot].clone();

            tokio::spawn(async move {
                let mut backoff_secs = 1u64;
                loop {
                    if s_clone.is_shutdown_requested() {
                        break;
                    }
                    match s_clone.connect_and_listen(queue_clone.clone()).await {
                        Ok(()) => {
                            if s_clone.is_shutdown_requested() {
                                break;
                            }
                            eprintln!(
                                "[MultiStreamManager WS][Slot {}] Disconnected. Reconnecting in {}s...",
                                slot, backoff_secs
                            );
                        }
                        Err(e) => {
                            if s_clone.is_shutdown_requested() {
                                break;
                            }
                            eprintln!(
                                "[MultiStreamManager WS Error][Slot {}] Connection error: {}. Retrying in {}s...",
                                slot, e, backoff_secs
                            );
                        }
                    }
                    let shutdown_notify = s_clone.shutdown_notify();
                    tokio::select! {
                        _ = shutdown_notify.notified() => {
                            break;
                        }
                        _ = sleep(Duration::from_secs(backoff_secs)) => {}
                    }
                    backoff_secs = (backoff_secs * 2).min(30);
                }
            });

            // Binance Connection Rate-Limit Safety: Sleep 200ms between new WS connection bursts (NO LOCK HELD!)
            sleep(Duration::from_millis(200)).await;
        }

        Ok(self.active_symbols())
    }

    /// Returns current active dynamic symbol list.
    pub fn active_symbols(&self) -> Vec<String> {
        let guard = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        guard.keys().cloned().collect()
    }
}
