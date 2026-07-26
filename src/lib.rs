#[macro_use]
extern crate napi_derive;

pub mod ipc;
pub mod lob;
pub mod ws;

use std::sync::RwLock;
use lazy_static::lazy_static;

use ipc::bridge::IngestionBridge;
use ipc::shared_memory::AtomicSharedMemoryBridge;
use lob::{LimitOrderBook, LockFreeSpscQueue};
use napi::bindgen_prelude::Buffer;
use napi::Error;

lazy_static! {
    static ref GLOBAL_LOB: RwLock<LimitOrderBook> = RwLock::new(LimitOrderBook::new());
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
    let bridge = IngestionBridge::new(atomic_bridge);
    bridge.start_consumer_loop(queue);

    Ok(true)
}
