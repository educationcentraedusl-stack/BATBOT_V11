pub mod bridge;
pub mod shared_memory;

pub use bridge::IngestionBridge;
pub use shared_memory::{AtomicSharedMemoryBridge, SHARED_MEMORY_BYTES, SHARED_MEMORY_SLOTS};
