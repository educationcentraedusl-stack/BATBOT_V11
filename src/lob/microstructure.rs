use std::f64;

pub const TICK_WINDOW: usize = 100;
pub const HURST_WINDOW: usize = 128;
pub const VPIN_BUCKETS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MicroRegime {
    MeanReverting = 0,
    DirectionalTrend = 1,
    ToxicChopTrap = 2,
}

impl MicroRegime {
    pub fn from_u8(val: u8) -> Self {
        match val {
            0 => MicroRegime::MeanReverting,
            1 => MicroRegime::DirectionalTrend,
            _ => MicroRegime::ToxicChopTrap,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MicroBar {
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
}

impl Default for MicroBar {
    fn default() -> Self {
        Self {
            open: 0.0,
            high: 0.0,
            low: 0.0,
            close: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct VolumeBucket {
    pub buy_vol: f64,
    pub sell_vol: f64,
}

impl Default for VolumeBucket {
    fn default() -> Self {
        Self {
            buy_vol: 0.0,
            sell_vol: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MicrostructureAnalyzer {
    // Garman-Klass Volatility Ring Buffer
    bars: [MicroBar; TICK_WINDOW],
    bar_index: usize,
    bar_count: usize,
    current_bar: MicroBar,
    bar_tick_count: usize,

    // VPIN Volume Bucket Ring Buffer
    vpin_buckets: [VolumeBucket; VPIN_BUCKETS],
    vpin_bucket_index: usize,
    vpin_bucket_count: usize,
    current_bucket_buy: f64,
    current_bucket_sell: f64,
    bucket_target_volume: f64,

    // Price History Ring Buffer for Hurst Exponent
    price_history: [f64; HURST_WINDOW],
    price_index: usize,
    price_count: usize,

    // Depth Depletion Tracking
    last_top3_bid_depth: f64,
    last_top3_ask_depth: f64,
    last_depth_ts_ns: u64,
    depth_depletion_rate: f64,
    is_sweep_detected: bool,

    // Rolling Volume Adaptation for Dynamic VPIN Bucketing
    rolling_trade_volume: f64,

    // Cached Metrics
    cached_rv_gk: f64,
    cached_vpin: f64,
    cached_hurst: f64,
    cached_lob_entropy: f64,
    cached_micro_price: f64,
    cached_regime: MicroRegime,
}

impl Default for MicrostructureAnalyzer {
    fn default() -> Self {
        Self::new(50000.0) // Default 50000.0 USDT volume unit per bucket
    }
}

impl MicrostructureAnalyzer {
    pub fn new(bucket_target_volume: f64) -> Self {
        let target_vol = if bucket_target_volume > 1e-6 { bucket_target_volume } else { 50000.0 };
        Self {
            bars: [MicroBar::default(); TICK_WINDOW],
            bar_index: 0,
            bar_count: 0,
            current_bar: MicroBar::default(),
            bar_tick_count: 0,

            vpin_buckets: [VolumeBucket::default(); VPIN_BUCKETS],
            vpin_bucket_index: 0,
            vpin_bucket_count: 0,
            current_bucket_buy: 0.0,
            current_bucket_sell: 0.0,
            bucket_target_volume: target_vol,

            price_history: [0.0; HURST_WINDOW],
            price_index: 0,
            price_count: 0,

            last_top3_bid_depth: 0.0,
            last_top3_ask_depth: 0.0,
            last_depth_ts_ns: 0,
            depth_depletion_rate: 0.0,
            is_sweep_detected: false,

            rolling_trade_volume: target_vol / 20.0,

            cached_rv_gk: 0.0,
            cached_vpin: 0.0,
            cached_hurst: 0.5,
            cached_lob_entropy: 0.0,
            cached_micro_price: 0.0,
            cached_regime: MicroRegime::MeanReverting,
        }
    }

    /// On tick trade event, update Garman-Klass micro-bar, VPIN buckets, and price history for Hurst exponent.
    pub fn on_trade(&mut self, price: f64, quantity: f64, is_buyer_maker: bool) {
        if !price.is_finite() || !quantity.is_finite() || price <= 0.0 || quantity <= 0.0 {
            return;
        }

        // 1. Update Price History Ring Buffer
        self.price_history[self.price_index] = price;
        self.price_index = (self.price_index + 1) % HURST_WINDOW;
        if self.price_count < HURST_WINDOW {
            self.price_count += 1;
        }

        // 2. Update Micro-Bar (Aggregated 5 ticks per bar for GK Volatility)
        if self.bar_tick_count == 0 {
            self.current_bar.open = price;
            self.current_bar.high = price;
            self.current_bar.low = price;
            self.current_bar.close = price;
        } else {
            if price > self.current_bar.high {
                self.current_bar.high = price;
            }
            if price < self.current_bar.low {
                self.current_bar.low = price;
            }
            self.current_bar.close = price;
        }

        self.bar_tick_count += 1;
        if self.bar_tick_count >= 5 {
            self.bars[self.bar_index] = self.current_bar;
            self.bar_index = (self.bar_index + 1) % TICK_WINDOW;
            if self.bar_count < TICK_WINDOW {
                self.bar_count += 1;
            }
            self.bar_tick_count = 0;
            self.recalculate_rv_gk();
        }

        // 3. Update VPIN Volume Buckets with Dynamic Adaptive Target Volume & Remainder Volume Carry-Over
        // Taker buy: is_buyer_maker == false
        let total_trade_vol = price * quantity;

        if total_trade_vol > 0.0 && total_trade_vol.is_finite() {
            let mut rem_vol = total_trade_vol;

            while rem_vol > 0.0 {
                let current_filled = self.current_bucket_buy + self.current_bucket_sell;
                let needed = (self.bucket_target_volume - current_filled).max(0.0);

                if rem_vol >= needed && needed > 0.0 {
                    // Slice exact volume needed to complete the bucket
                    if is_buyer_maker {
                        self.current_bucket_sell += needed;
                    } else {
                        self.current_bucket_buy += needed;
                    }
                    rem_vol -= needed;

                    // Commit completed bucket (guaranteed buy_vol + sell_vol == bucket_target_volume)
                    self.vpin_buckets[self.vpin_bucket_index] = VolumeBucket {
                        buy_vol: self.current_bucket_buy,
                        sell_vol: self.current_bucket_sell,
                    };
                    self.vpin_bucket_index = (self.vpin_bucket_index + 1) % VPIN_BUCKETS;
                    if self.vpin_bucket_count < VPIN_BUCKETS {
                        self.vpin_bucket_count += 1;
                    }

                    // Update rolling trade volume and adapt bucket_target_volume ONLY upon bucket completion
                    self.rolling_trade_volume = self.rolling_trade_volume * 0.95 + total_trade_vol * 0.05;
                    let min_target = 100.0;
                    self.bucket_target_volume = (self.rolling_trade_volume * 20.0).clamp(min_target, 100000.0);

                    // Reset current bucket counters for next bucket
                    self.current_bucket_buy = 0.0;
                    self.current_bucket_sell = 0.0;
                    self.recalculate_vpin();
                } else {
                    // Accumulate remaining volume into current bucket and finish loop
                    if is_buyer_maker {
                        self.current_bucket_sell += rem_vol;
                    } else {
                        self.current_bucket_buy += rem_vol;
                    }
                    rem_vol = 0.0;
                }
            }
        }

        // 4. Update Regime
        self.recalculate_hurst_and_regime();
    }

    /// On LOB depth update event, calculate top-3 depth depletion, Micro-Price, and LOB entropy.
    pub fn on_depth_update(
        &mut self,
        bids: &[(f64, f64); 20],
        asks: &[(f64, f64); 20],
        timestamp_ns: u64,
    ) {
        let mut current_top3_bid = 0.0;
        let mut current_top3_ask = 0.0;

        let mut i = 0;
        while i < 3 {
            current_top3_bid += bids[i].1;
            current_top3_ask += asks[i].1;
            i += 1;
        }

        // Calculate Depth Depletion Rate
        if self.last_depth_ts_ns > 0 && timestamp_ns > self.last_depth_ts_ns {
            let dt_sec = (timestamp_ns - self.last_depth_ts_ns) as f64 / 1e9;
            if dt_sec > 1e-6 {
                let prev_total = self.last_top3_bid_depth + self.last_top3_ask_depth;
                let curr_total = current_top3_bid + current_top3_ask;
                if prev_total > 1e-6 {
                    let depth_decay = (prev_total - curr_total) / prev_total;
                    self.depth_depletion_rate = depth_decay / dt_sec;

                    // If top-3 depth collapses > 40% in < 50ms (rate > 8.0/sec), flag liquidity sweep
                    if depth_decay > 0.40 && dt_sec < 0.05 {
                        self.is_sweep_detected = true;
                    } else {
                        self.is_sweep_detected = false;
                    }
                }
            }
        }

        self.last_top3_bid_depth = current_top3_bid;
        self.last_top3_ask_depth = current_top3_ask;
        self.last_depth_ts_ns = timestamp_ns;

        // Calculate Micro-Price and LOB Entropy across top 10 levels
        self.cached_micro_price = crate::lob::metrics::calculate_micro_price(bids, asks);
        self.recalculate_lob_entropy(bids, asks);
    }

    /// Garman-Klass Realized Volatility calculation over rolling micro-bars.
    fn recalculate_rv_gk(&mut self) {
        if self.bar_count == 0 {
            self.cached_rv_gk = 0.0;
            return;
        }

        let mut sum_gk = 0.0;
        let const_ratio = 2.0 * 2.0f64.ln() - 1.0; // 2ln(2) - 1 ≈ 0.386294

        let mut i = 0;
        while i < self.bar_count {
            let b = &self.bars[i];
            if b.low > 1e-9 && b.open > 1e-9 && b.high >= b.low && b.close > 0.0 {
                let log_hl = (b.high / b.low).ln();
                let log_co = (b.close / b.open).ln();
                let term = 0.5 * log_hl * log_hl - const_ratio * log_co * log_co;
                if term > 0.0 {
                    sum_gk += term;
                }
            }
            i += 1;
        }

        let mean_gk = sum_gk / (self.bar_count as f64);
        self.cached_rv_gk = if mean_gk > 0.0 { mean_gk.sqrt() } else { 0.0 };
    }

    /// Volume-Synchronized Probability of Toxicity (VPIN) calculation.
    fn recalculate_vpin(&mut self) {
        if self.vpin_bucket_count == 0 {
            self.cached_vpin = 0.0;
            return;
        }

        let mut sum_imbalance = 0.0;
        let mut total_vol = 0.0;

        let mut i = 0;
        while i < self.vpin_bucket_count {
            let bucket = &self.vpin_buckets[i];
            let imbalance = (bucket.buy_vol - bucket.sell_vol).abs();
            let bucket_vol = bucket.buy_vol + bucket.sell_vol;
            sum_imbalance += imbalance;
            total_vol += bucket_vol;
            i += 1;
        }

        if total_vol <= 1e-9 {
            self.cached_vpin = 0.0;
        } else {
            self.cached_vpin = (sum_imbalance / total_vol).clamp(0.0, 1.0);
        }
    }

    /// Micro Hurst Exponent calculation using rescaled range analysis (R/S).
    fn recalculate_hurst_and_regime(&mut self) {
        if self.price_count < 32 {
            self.cached_hurst = 0.5;
            self.cached_regime = MicroRegime::MeanReverting;
            return;
        }

        // Fast zero-allocation R/S estimator over sub-window size N=16 and N=32
        let h16 = self.calculate_rs_subwindow(16);
        let h32 = self.calculate_rs_subwindow(32);

        if h16 > 1e-6 && h32 > 1e-6 {
            // Hurst H = log(RS_32 / RS_16) / log(32 / 16) = log(RS_32 / RS_16) / ln(2)
            let ratio = h32 / h16;
            if ratio > 0.0 {
                let h = (ratio.ln() / 2.0f64.ln()).clamp(0.1, 0.9);
                self.cached_hurst = h;
            }
        }

        // Classify Regime
        if self.cached_vpin > 0.85 || self.is_sweep_detected {
            self.cached_regime = MicroRegime::ToxicChopTrap;
        } else if self.cached_hurst > 0.55 {
            self.cached_regime = MicroRegime::DirectionalTrend;
        } else if self.cached_hurst < 0.45 {
            self.cached_regime = MicroRegime::MeanReverting;
        } else {
            self.cached_regime = MicroRegime::ToxicChopTrap;
        }
    }

    fn calculate_rs_subwindow(&self, window_size: usize) -> f64 {
        if self.price_count < window_size || window_size == 0 {
            return 1.0;
        }

        let mut sum = 0.0;
        let mut i = 0;
        let start_idx = (self.price_index + HURST_WINDOW - window_size) % HURST_WINDOW;

        while i < window_size {
            let idx = (start_idx + i) % HURST_WINDOW;
            sum += self.price_history[idx];
            i += 1;
        }
        let mean = sum / (window_size as f64);

        let mut cum_dev = 0.0;
        let mut min_dev = 0.0f64;
        let mut max_dev = 0.0f64;
        let mut sum_sq_dev = 0.0;

        i = 0;
        while i < window_size {
            let idx = (start_idx + i) % HURST_WINDOW;
            let dev = self.price_history[idx] - mean;
            cum_dev += dev;
            sum_sq_dev += dev * dev;

            if cum_dev < min_dev {
                min_dev = cum_dev;
            }
            if cum_dev > max_dev {
                max_dev = cum_dev;
            }
            i += 1;
        }

        let range = max_dev - min_dev;
        let stdev = (sum_sq_dev / (window_size as f64)).sqrt();

        if stdev <= 1e-9 {
            1.0
        } else {
            range / stdev
        }
    }

    /// Calculate Shannon Entropy across top 10 LOB levels.
    fn recalculate_lob_entropy(&mut self, bids: &[(f64, f64); 20], asks: &[(f64, f64); 20]) {
        let mut total_qty = 0.0;
        let mut i = 0;
        while i < 10 {
            total_qty += bids[i].1 + asks[i].1;
            i += 1;
        }

        if total_qty <= 1e-9 {
            self.cached_lob_entropy = 0.0;
            return;
        }

        let mut entropy = 0.0;
        i = 0;
        while i < 10 {
            let p_bid = bids[i].1 / total_qty;
            let p_ask = asks[i].1 / total_qty;

            if p_bid > 1e-9 {
                entropy -= p_bid * p_bid.ln();
            }
            if p_ask > 1e-9 {
                entropy -= p_ask * p_ask.ln();
            }
            i += 1;
        }

        self.cached_lob_entropy = entropy;
    }

    // Getters for Microstructure Metrics
    pub fn get_rv_gk(&self) -> f64 {
        self.cached_rv_gk
    }

    pub fn get_vpin(&self) -> f64 {
        self.cached_vpin
    }

    pub fn get_hurst(&self) -> f64 {
        self.cached_hurst
    }

    pub fn get_lob_entropy(&self) -> f64 {
        self.cached_lob_entropy
    }

    pub fn get_micro_price(&self) -> f64 {
        self.cached_micro_price
    }

    pub fn get_regime(&self) -> MicroRegime {
        self.cached_regime
    }

    pub fn is_sweep_detected(&self) -> bool {
        self.is_sweep_detected
    }

    pub fn get_depth_depletion_rate(&self) -> f64 {
        self.depth_depletion_rate
    }

    /// Calculate Dynamic Stop-Loss and Take-Profit prices based on live microstructure metrics.
    pub fn calculate_dynamic_collars(
        &self,
        entry_price: f64,
        position_side: &str, // "LONG" or "SHORT"
        obi: f64,
        spread: f64,
    ) -> (f64, f64) {
        if entry_price <= 0.0 {
            return (0.0, 0.0);
        }

        // Base Volatility Factor: Use max of Garman-Klass RV or minimum default 0.20% collar
        let vol_factor = self.cached_rv_gk.max(0.0020);
        let spread_factor = spread.max(entry_price * 0.0001); // min 1 bps spread

        // Clamp OBI signed in [-1.0, 1.0]
        let obi_signed = obi.clamp(-1.0, 1.0);

        if position_side == "LONG" {
            // Long position:
            // If OBI is negative (sell pressure against us), expand SL distance to prevent stop-hunt.
            // If OBI is positive (buy pressure), expand TP distance to capture trend runaway.
            let sl_distance = (vol_factor * 1.5 * (1.0 - 0.4 * obi_signed) * entry_price)
                .max(spread_factor * 2.0);
            let tp_distance = (vol_factor * 2.0 * (1.0 + 0.5 * obi_signed) * entry_price)
                .max(spread_factor * 3.0);

            let sl_price = entry_price - sl_distance;
            let tp_price = entry_price + tp_distance;
            (sl_price, tp_price)
        } else {
            // Short position:
            // If OBI is positive (buy pressure against us), expand SL distance.
            // If OBI is negative (sell pressure), expand TP distance.
            let sl_distance = (vol_factor * 1.5 * (1.0 + 0.4 * obi_signed) * entry_price)
                .max(spread_factor * 2.0);
            let tp_distance = (vol_factor * 2.0 * (1.0 - 0.5 * obi_signed) * entry_price)
                .max(spread_factor * 3.0);

            let sl_price = entry_price + sl_distance;
            let tp_price = entry_price - tp_distance;
            (sl_price, tp_price)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_microstructure_analyzer_initialization() {
        let analyzer = MicrostructureAnalyzer::new(50.0);
        assert_eq!(analyzer.get_vpin(), 0.0);
        assert_eq!(analyzer.get_rv_gk(), 0.0);
        assert_eq!(analyzer.get_hurst(), 0.5);
    }

    #[test]
    fn test_dynamic_collars_calculation() {
        let analyzer = MicrostructureAnalyzer::new(50.0);
        let entry_price = 50000.0;
        let (sl, tp) = analyzer.calculate_dynamic_collars(entry_price, "LONG", 0.5, 2.0);

        assert!(sl < entry_price, "Stop loss must be below entry price for LONG");
        assert!(tp > entry_price, "Take profit must be above entry price for LONG");
        assert!(sl > 0.0);
        assert!(tp > 0.0);
    }

    #[test]
    fn test_vpin_and_sweep_detection() {
        let mut analyzer = MicrostructureAnalyzer::new(10.0);

        for i in 0..20 {
            analyzer.on_trade(50000.0 + (i as f64), 0.001, true);
        }

        assert!(analyzer.get_vpin() > 0.5, "VPIN should be elevated for one-sided toxic sell flow");

        let mut bids = [(50000.0, 1.0); 20];
        let asks = [(50001.0, 1.0); 20];
        analyzer.on_depth_update(&bids, &asks, 100_000_000);

        bids[0] = (50000.0, 0.1);
        bids[1] = (49999.0, 0.1);
        bids[2] = (49998.0, 0.1);
        analyzer.on_depth_update(&bids, &asks, 110_000_000);

        assert!(analyzer.is_sweep_detected(), "Liquidity sweep should be flagged on rapid depth decay");
    }

    #[test]
    fn test_vpin_remainder_carry_over_and_nan_guard() {
        let mut analyzer = MicrostructureAnalyzer::new(100.0);
        // Test NaN guard
        analyzer.on_trade(f64::NAN, 1.0, true);
        analyzer.on_trade(50000.0, f64::NAN, true);
        assert_eq!(analyzer.current_bucket_sell, 0.0);

        // Test multi-bucket block trade remainder carry-over
        // Single trade of volume 250.0 into 100.0 initial bucket target:
        // Slices 100.0 to fill bucket 1, target adapts to 345.0, carries over 150.0 into current_bucket_buy
        analyzer.on_trade(100.0, 2.5, false); // 250.0 USDT volume taker buy
        assert_eq!(analyzer.vpin_bucket_count, 1);
        assert_eq!(analyzer.current_bucket_buy, 150.0);
    }
}

