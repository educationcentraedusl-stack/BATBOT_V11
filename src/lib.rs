#[macro_use]
extern crate napi_derive;

pub mod ai;
pub mod ipc;
pub mod lob;
pub mod ws;

use std::sync::{Arc, RwLock};
use lazy_static::lazy_static;

use ipc::bridge::IngestionBridge;
use ipc::shared_memory::AtomicSharedMemoryBridge;
use lob::{LimitOrderBook, LockFreeSpscQueue};
use ws::manager::{ConnectionManager, ExchangeType};
use napi::bindgen_prelude::Buffer;
use napi::Error;

lazy_static! {
    static ref GLOBAL_LOB: RwLock<LimitOrderBook> = RwLock::new(LimitOrderBook::new());
    static ref GLOBAL_RUNTIME: tokio::runtime::Runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to initialize Tokio runtime for HFT ingestion");
}

#[napi]
pub fn init_core() -> String {
    "BATBOT_V11_CORE_INITIALIZED".to_string()
}

#[napi]
pub fn create_lob_engine() -> bool {
    let mut lob_guard = GLOBAL_LOB.write().unwrap_or_else(|e| e.into_inner());
    *lob_guard = LimitOrderBook::new();
    true
}

#[napi]
pub fn start_ingestion(sab_buffer: Buffer) -> napi::Result<bool> {
    let raw_ptr = sab_buffer.as_ptr() as *mut u8;
    let len = sab_buffer.len();

    let atomic_bridge = AtomicSharedMemoryBridge::new(raw_ptr, len)
        .map_err(|err| Error::from_reason(err.to_string()))?;

    let queue = LockFreeSpscQueue::new(4096);
    let bridge = Arc::new(IngestionBridge::new(atomic_bridge));
    let bridge_clone = bridge.clone();
    let queue_consumer = queue.clone();

    // Spawn consumer loop on Tokio runtime
    GLOBAL_RUNTIME.spawn(async move {
        bridge_clone.start_consumer_loop(queue_consumer);
    });

    // Spawn WebSocket Connection Manager on Tokio runtime
    let symbol = std::env::var("SYMBOL").unwrap_or_else(|_| "BTCUSDT".to_string());
    let conn_mgr = Arc::new(ConnectionManager::new(&symbol, ExchangeType::Binance));
    let queue_producer = queue.clone();

    GLOBAL_RUNTIME.spawn(async move {
        println!("[BATBOT_V11] Starting Binance Futures WebSocket Ingestion Stream for {}...", symbol);
        if let Err(e) = conn_mgr.run_rotation_loop(queue_producer).await {
            eprintln!("[BATBOT_V11][WS Manager Error] Rotation loop error: {}", e);
        }
    });

    // Spawn Latency Monitor background task on Tokio runtime
    ai::spawn_latency_monitor(atomic_bridge);

    Ok(true)
}

