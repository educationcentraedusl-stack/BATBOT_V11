use crate::lob::LockFreeSpscQueue;
use crate::ws::binance::BinanceWsStream;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::time::{sleep, Duration, Instant};

pub struct ConnectionManager {
    symbol: String,
    is_active: Arc<AtomicBool>,
    rotation_interval_secs: u64,
    overlap_duration_secs: u64,
}

impl ConnectionManager {
    pub fn new(symbol: &str) -> Self {
        Self {
            symbol: symbol.to_string(),
            is_active: Arc::new(AtomicBool::new(false)),
            rotation_interval_secs: 84600, // 23.5 hours
            overlap_duration_secs: 1800,   // 30 minutes overlap (until 24.0 hours)
        }
    }

    pub fn stop(&self) {
        self.is_active.store(false, Ordering::Relaxed);
    }

    fn spawn_stream(&self, queue: LockFreeSpscQueue) -> Arc<BinanceWsStream> {
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
                            "[Binance WS] Stream disconnected cleanly. Reconnecting in 1s..."
                        );
                        backoff_secs = 1;
                    }
                    Err(e) => {
                        if s_clone.is_shutdown_requested() {
                            break;
                        }
                        eprintln!(
                            "[Binance WS] Connection failed: {}. Retrying in {}s...",
                            e, backoff_secs
                        );
                        backoff_secs = (backoff_secs * 2).min(30);
                    }
                }
                let shutdown_notify = s_clone.shutdown_notify();
                tokio::select! {
                    _ = shutdown_notify.notified() => {
                        break;
                    }
                    _ = sleep(Duration::from_secs(backoff_secs)) => {}
                }
            }
        });
        stream
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
    is_active: Arc<AtomicBool>,
    streams: Arc<Mutex<HashMap<String, (usize, Arc<BinanceWsStream>)>>>,
    queues: Vec<LockFreeSpscQueue>,
}

impl MultiStreamManager {
    pub fn new(max_active_assets: usize) -> Self {
        let env_max: usize = std::env::var("MAX_CONCURRENT_ASSETS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(max_active_assets);

        let final_max = env_max.max(1);
        let queues: Vec<LockFreeSpscQueue> = (0..final_max)
            .map(|_| LockFreeSpscQueue::new(4096))
            .collect();

        Self {
            max_active_assets: final_max,
            is_active: Arc::new(AtomicBool::new(true)),
            streams: Arc::new(Mutex::new(HashMap::new())),
            queues,
        }
    }

    pub fn max_active_assets(&self) -> usize {
        self.max_active_assets
    }

    pub fn is_active(&self) -> bool {
        self.is_active.load(Ordering::Relaxed)
    }

    pub fn queues(&self) -> &[LockFreeSpscQueue] {
        &self.queues
    }

    pub fn queue_at(&self, slot: usize) -> Option<LockFreeSpscQueue> {
        self.queues.get(slot).cloned()
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
                        // VULN-03 FIX: Flush residual stale events from SPSC queue in this slot to guarantee zero cross-talk
                        if let Some(q) = self.queues.get(asset_idx) {
                            let mut flushed = 0usize;
                            while q.pop().is_some() {
                                flushed += 1;
                            }
                            if flushed > 0 {
                                println!(
                                    "[MultiStreamManager] Flushed {} stale events from queue slot {}",
                                    flushed, asset_idx
                                );
                            }
                        }
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
                    if slot >= self.queues.len() {
                        eprintln!(
                            "[MultiStreamManager Warning] Slot {} exceeds internal queues length {}",
                            slot, self.queues.len()
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

        // 4. Spawn connection tasks for reserved streams using internal persistent queues
        for (sym, slot, stream) in streams_to_spawn {
            println!(
                "[MultiStreamManager] Spawning connection task for symbol {} in slot {}",
                sym, slot
            );
            let s_clone = stream.clone();
            let queue_clone = self.queues[slot].clone();

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
                                "[MultiStreamManager WS][Slot {}] Stream disconnected cleanly. Reconnecting in 1s...",
                                slot
                            );
                            backoff_secs = 1;
                        }
                        Err(e) => {
                            if s_clone.is_shutdown_requested() {
                                break;
                            }
                            eprintln!(
                                "[MultiStreamManager WS Error][Slot {}] Connection error: {}. Retrying in {}s...",
                                slot, e, backoff_secs
                            );
                            backoff_secs = (backoff_secs * 2).min(30);
                        }
                    }
                    let shutdown_notify = s_clone.shutdown_notify();
                    tokio::select! {
                        _ = shutdown_notify.notified() => {
                            break;
                        }
                        _ = sleep(Duration::from_secs(backoff_secs)) => {}
                    }
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

