#[cfg(test)]
mod tests {
    use batbot_v11_core::lob::{
        calculate_obi, calculate_spread_velocity, update_cvd, LimitOrderBook, LockFreeSpscQueue,
        MarketUpdateEvent, LOB_DEPTH,
    };

    #[test]
    fn test_obi_calculation() {
        let mut bids = [(0.0, 0.0); LOB_DEPTH];
        let mut asks = [(0.0, 0.0); LOB_DEPTH];

        bids[0] = (100.0, 10.0);
        asks[0] = (100.5, 5.0);

        let obi = calculate_obi(&bids, &asks);
        // (10 - 5) / (10 + 5) = 5 / 15 = 0.3333333333333333
        assert!((obi - 0.3333333333333333).abs() < 1e-6);
    }

    #[test]
    fn test_cvd_calculation() {
        let cvd_start = 1000.0;
        // Aggressive buy (buyer is not maker) -> CVD increases
        let cvd_after_buy = update_cvd(cvd_start, 100.0, 2.0, false);
        assert_eq!(cvd_after_buy, 1200.0);

        // Aggressive sell (buyer is maker) -> CVD decreases
        let cvd_after_sell = update_cvd(cvd_after_buy, 100.0, 1.0, true);
        assert_eq!(cvd_after_sell, 1100.0);
    }

    #[test]
    fn test_spread_velocity() {
        let prev_spread = 0.5;
        let curr_spread = 1.5;
        let elapsed_secs = 0.1; // 100 ms

        let vel = calculate_spread_velocity(curr_spread, prev_spread, elapsed_secs);
        // (1.5 - 0.5) / 0.1 = 10.0 spread velocity per second
        assert!((vel - 10.0).abs() < 1e-6);
    }

    #[test]
    fn test_limit_order_book_lock_free_spsc() {
        let queue = LockFreeSpscQueue::new(100);
        let mut bids = [(0.0, 0.0); LOB_DEPTH];
        let mut asks = [(0.0, 0.0); LOB_DEPTH];

        bids[0] = (50000.0, 1.5);
        asks[0] = (50001.0, 2.5);

        let push_res = queue.push(MarketUpdateEvent::DepthUpdate {
            bids,
            asks,
            timestamp_ns: 1_000_000_000,
        });
        assert!(push_res.is_ok());

        let pop_evt = queue.pop();
        assert!(pop_evt.is_some());

        let mut lob = LimitOrderBook::new();
        if let Some(evt) = pop_evt {
            lob.process_event(evt);
        }

        assert_eq!(lob.bids[0].0, 50000.0);
        assert_eq!(lob.asks[0].0, 50001.0);
        assert!(lob.metrics.obi < 0.0); // Asks vol 2.5 > Bids vol 1.5 -> Negative OBI
    }

    #[test]
    fn test_liquidation_event_processing() {
        let mut lob = LimitOrderBook::new();
        let liq_evt = MarketUpdateEvent::new_liquidation("BTCUSDT", "BUY", 60000.0, 2.0, 1_000_000);
        lob.process_event(liq_evt);

        assert_eq!(lob.metrics.total_liquidation_vol, 120000.0);
        assert_eq!(lob.metrics.buy_liquidation_vol, 120000.0);
        assert_eq!(lob.metrics.sell_liquidation_vol, 0.0);

        let liq_sell = MarketUpdateEvent::new_liquidation("BTCUSDT", "SELL", 50000.0, 1.0, 2_000_000);
        lob.process_event(liq_sell);

        assert_eq!(lob.metrics.total_liquidation_vol, 170000.0);
        assert_eq!(lob.metrics.sell_liquidation_vol, 50000.0);
    }

    #[test]
    fn test_queue_overflow_drop_counter() {
        let small_queue = LockFreeSpscQueue::new(2);
        let evt1 = MarketUpdateEvent::TradeEvent { price: 100.0, quantity: 1.0, is_buyer_maker: false, timestamp_ns: 1 };
        let evt2 = MarketUpdateEvent::TradeEvent { price: 101.0, quantity: 1.0, is_buyer_maker: false, timestamp_ns: 2 };
        let evt3 = MarketUpdateEvent::TradeEvent { price: 102.0, quantity: 1.0, is_buyer_maker: false, timestamp_ns: 3 };

        assert!(small_queue.push(evt1).is_ok());
        assert!(small_queue.push(evt2).is_ok());
        assert!(small_queue.push(evt3).is_err());

        assert!(LockFreeSpscQueue::dropped_count() > 0);
    }
}

