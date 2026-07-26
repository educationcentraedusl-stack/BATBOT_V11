#[cfg(test)]
mod tests {
    use batbot_v11_core::ipc::{AtomicSharedMemoryBridge, SHARED_MEMORY_BYTES};
    use batbot_v11_core::lob::{LockFreeSpscQueue, MarketUpdateEvent, LOB_DEPTH};
    use std::thread;

    #[test]
    fn test_atomic_shared_memory_alignment_and_bounds() {
        let mut raw_buffer = vec![0u8; SHARED_MEMORY_BYTES];
        let bridge_res = AtomicSharedMemoryBridge::new(raw_buffer.as_mut_ptr(), raw_buffer.len());
        assert!(bridge_res.is_ok());

        let bridge = bridge_res.unwrap();
        bridge.store_f64(1, 0.42);
        assert_eq!(bridge.load_f64(1), 0.42);

        bridge.store_u64(0, 1_600_000_000);
        assert_eq!(bridge.load_u64(0), 1_600_000_000);
    }

    #[test]
    fn test_atomic_shared_memory_small_buffer_error() {
        let mut small_buffer = vec![0u8; 512];
        let bridge_res = AtomicSharedMemoryBridge::new(small_buffer.as_mut_ptr(), small_buffer.len());
        assert!(bridge_res.is_err());
    }

    #[test]
    fn test_concurrent_lock_free_ipc_writes() {
        let mut raw_buffer = vec![0u8; SHARED_MEMORY_BYTES];
        let bridge = AtomicSharedMemoryBridge::new(raw_buffer.as_mut_ptr(), raw_buffer.len()).unwrap();

        let mut bids = [(0.0, 0.0); LOB_DEPTH];
        let mut asks = [(0.0, 0.0); LOB_DEPTH];
        bids[0] = (65000.0, 5.0);
        asks[0] = (65001.0, 3.0);

        bridge.write_lob_snapshot(
            &bids,
            &asks,
            0.25,
            1500.0,
            2.5,
            50000.0,
            30000.0,
            20000.0,
            1_700_000_000,
            0,
            1,
        );

        assert_eq!(bridge.load_u64(0), 1_700_000_000);
        assert_eq!(bridge.load_f64(1), 0.25);
        assert_eq!(bridge.load_f64(2), 1500.0);
        assert_eq!(bridge.load_f64(3), 2.5);
        assert_eq!(bridge.load_f64(4), 65000.0);
        assert_eq!(bridge.load_f64(5), 5.0);
        assert_eq!(bridge.load_f64(6), 65001.0);
        assert_eq!(bridge.load_f64(7), 3.0);
        assert_eq!(bridge.load_f64(8), 50000.0);
        assert_eq!(bridge.load_f64(9), 30000.0);
        assert_eq!(bridge.load_f64(10), 20000.0);
        assert_eq!(bridge.load_u64(92), 1);
    }
}
