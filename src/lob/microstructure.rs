use std::f64;

pub const TICK_WINDOW: usize = 100;
pub const HURST_WINDOW: usize = 128;
pub const VPIN_BUCKETS: usize = 20;
pub const LOB_DEPTH_LEVELS: usize = 10;

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

    // Multi-Level Order Flow Imbalance (OFI L1..L10)
    prev_bids: [(f64, f64); LOB_DEPTH_LEVELS],
    prev_asks: [(f64, f64); LOB_DEPTH_LEVELS],
    has_prev_lob: bool,
    cached_multi_level_ofi: f64,

    // Bivariate Hawkes Point Process Flow Dynamics
    hawkes_lambda_buy: f64,
    hawkes_lambda_sell: f64,
    last_trade_ts_ns: u64,
    cached_hawkes_asymmetry: f64,

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

            prev_bids: [(0.0, 0.0); LOB_DEPTH_LEVELS],
            prev_asks: [(0.0, 0.0); LOB_DEPTH_LEVELS],
            has_prev_lob: false,
            cached_multi_level_ofi: 0.0,

            hawkes_lambda_buy: 0.05,
            hawkes_lambda_sell: 0.05,
            last_trade_ts_ns: 0,
            cached_hawkes_asymmetry: 0.0,

            rolling_trade_volume: target_vol / 20.0,

            cached_rv_gk: 0.0,
            cached_vpin: 0.0,
            cached_hurst: 0.5,
            cached_lob_entropy: 0.0,
            cached_micro_price: 0.0,
            cached_regime: MicroRegime::MeanReverting,
        }
    }

    /// On tick trade event, update Garman-Klass micro-bar, VPIN buckets, Hawkes Point Process, and Hurst exponent.
    pub fn on_trade(&mut self, price: f64, quantity: f64, is_buyer_maker: bool) {
        self.on_trade_with_ts(price, quantity, is_buyer_maker, 0);
    }

    pub fn on_trade_with_ts(&mut self, price: f64, quantity: f64, is_buyer_maker: bool, ts_ns: u64) {
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

            while rem_vol > 0.0 || (self.current_bucket_buy + self.current_bucket_sell) >= self.bucket_target_volume {
                let current_filled = self.current_bucket_buy + self.current_bucket_sell;
                if current_filled >= self.bucket_target_volume {
                    self.vpin_buckets[self.vpin_bucket_index] = VolumeBucket {
                        buy_vol: self.current_bucket_buy,
                        sell_vol: self.current_bucket_sell,
                    };
                    self.vpin_bucket_index = (self.vpin_bucket_index + 1) % VPIN_BUCKETS;
                    if self.vpin_bucket_count < VPIN_BUCKETS {
                        self.vpin_bucket_count += 1;
                    }

                    self.rolling_trade_volume = self.rolling_trade_volume * 0.95 + total_trade_vol * 0.05;
                    let min_target = 100.0;
                    self.bucket_target_volume = (self.rolling_trade_volume * 20.0).clamp(min_target, 100000.0);

                    self.current_bucket_buy = 0.0;
                    self.current_bucket_sell = 0.0;
                    self.recalculate_vpin();
                    continue;
                }

                let needed = (self.bucket_target_volume - current_filled).max(0.0);

                if rem_vol >= needed && needed > 0.0 {
                    if is_buyer_maker {
                        self.current_bucket_sell += needed;
                    } else {
                        self.current_bucket_buy += needed;
                    }
                    rem_vol -= needed;

                    self.vpin_buckets[self.vpin_bucket_index] = VolumeBucket {
                        buy_vol: self.current_bucket_buy,
                        sell_vol: self.current_bucket_sell,
                    };
                    self.vpin_bucket_index = (self.vpin_bucket_index + 1) % VPIN_BUCKETS;
                    if self.vpin_bucket_count < VPIN_BUCKETS {
                        self.vpin_bucket_count += 1;
                    }

                    self.rolling_trade_volume = self.rolling_trade_volume * 0.95 + total_trade_vol * 0.05;
                    let min_target = 100.0;
                    self.bucket_target_volume = (self.rolling_trade_volume * 20.0).clamp(min_target, 100000.0);

                    self.current_bucket_buy = 0.0;
                    self.current_bucket_sell = 0.0;
                    self.recalculate_vpin();
                } else {
                    if is_buyer_maker {
                        self.current_bucket_sell += rem_vol;
                    } else {
                        self.current_bucket_buy += rem_vol;
                    }
                    rem_vol = 0.0;
                }
            }
        }

        // 4. Update Bivariate Hawkes Point Process
        self.update_hawkes(total_trade_vol, is_buyer_maker, ts_ns);

        // 5. Update Regime
        self.recalculate_hurst_and_regime();
    }

    /// Updates recursive continuous-time Bivariate Hawkes Point Process.
    fn update_hawkes(&mut self, trade_notional: f64, is_buyer_maker: bool, ts_ns: u64) {
        let mu_base = 0.05;
        let alpha = 0.40;
        let beta = 1.50; // Exponential decay rate per second

        let dt_sec = if self.last_trade_ts_ns > 0 && ts_ns > self.last_trade_ts_ns {
            ((ts_ns - self.last_trade_ts_ns) as f64 / 1e9).clamp(0.000001, 10.0)
        } else if self.last_trade_ts_ns == 0 && ts_ns > 0 {
            0.001
        } else {
            0.050 // Fallback interval
        };

        let decay = (-beta * dt_sec).exp();

        self.hawkes_lambda_buy = mu_base + (self.hawkes_lambda_buy - mu_base) * decay;
        self.hawkes_lambda_sell = mu_base + (self.hawkes_lambda_sell - mu_base) * decay;

        let excitation = alpha * (trade_notional / 1000.0).clamp(0.1, 5.0);
        if !is_buyer_maker {
            // Taker Buy
            self.hawkes_lambda_buy += excitation;
        } else {
            // Taker Sell
            self.hawkes_lambda_sell += excitation;
        }

        self.last_trade_ts_ns = if ts_ns > 0 { ts_ns } else { self.last_trade_ts_ns + 50_000_000 };

        let total_intensity = self.hawkes_lambda_buy + self.hawkes_lambda_sell + 1e-6;
        self.cached_hawkes_asymmetry = ((self.hawkes_lambda_buy - self.hawkes_lambda_sell) / total_intensity).clamp(-1.0, 1.0);
    }

    /// On LOB depth update event, calculate top-3 depth depletion, Multi-Level OFI (L1..L10), Micro-Price, and LOB entropy.
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

        // Calculate Multi-Level Order Flow Imbalance (OFI) across Top 10 Levels
        self.recalculate_multi_level_ofi(bids, asks);

        // Calculate Micro-Price and LOB Entropy across top 10 levels
        self.cached_micro_price = crate::lob::metrics::calculate_micro_price(bids, asks);
        self.recalculate_lob_entropy(bids, asks);
    }

    /// Calculate Multi-Level Order Flow Imbalance (OFI) across L1..L10 with exact price-level matching and depth exponential weights.
    fn recalculate_multi_level_ofi(
        &mut self,
        bids: &[(f64, f64); 20],
        asks: &[(f64, f64); 20],
    ) {
        if !self.has_prev_lob {
            for k in 0..LOB_DEPTH_LEVELS {
                self.prev_bids[k] = bids[k];
                self.prev_asks[k] = asks[k];
            }
            self.has_prev_lob = true;
            self.cached_multi_level_ofi = 0.0;
            return;
        }

        let mut weighted_ofi_sum = 0.0;
        let mut total_weight_depth = 0.0;

        for k in 0..LOB_DEPTH_LEVELS {
            let curr_bid_px = bids[k].0;
            let curr_bid_qty = bids[k].1;
            let weight = (-0.25 * (k as f64)).exp();

            // Match current bid price against previous bid levels to eliminate index-shift artifact
            let mut prev_bid_qty_opt = None;
            for j in 0..LOB_DEPTH_LEVELS {
                if (curr_bid_px - self.prev_bids[j].0).abs() < 1e-6 {
                    prev_bid_qty_opt = Some(self.prev_bids[j].1);
                    break;
                }
            }

            let delta_bid_qty = match prev_bid_qty_opt {
                Some(prev_qty) => curr_bid_qty - prev_qty,
                None => {
                    if curr_bid_px > self.prev_bids[0].0 {
                        curr_bid_qty // New higher bid level created
                    } else {
                        curr_bid_qty // Newly appeared deeper level
                    }
                }
            };

            let curr_ask_px = asks[k].0;
            let curr_ask_qty = asks[k].1;

            // Match current ask price against previous ask levels to eliminate index-shift artifact
            let mut prev_ask_qty_opt = None;
            for j in 0..LOB_DEPTH_LEVELS {
                if (curr_ask_px - self.prev_asks[j].0).abs() < 1e-6 {
                    prev_ask_qty_opt = Some(self.prev_asks[j].1);
                    break;
                }
            }

            let delta_ask_qty = match prev_ask_qty_opt {
                Some(prev_qty) => curr_ask_qty - prev_qty,
                None => {
                    if curr_ask_px < self.prev_asks[0].0 && self.prev_asks[0].0 > 0.0 {
                        curr_ask_qty // New lower ask level created
                    } else {
                        curr_ask_qty // Newly appeared deeper level
                    }
                }
            };

            let level_ofi = delta_bid_qty - delta_ask_qty;
            weighted_ofi_sum += weight * level_ofi;
            total_weight_depth += weight * (curr_bid_qty + curr_ask_qty + 1e-6);

            self.prev_bids[k] = bids[k];
            self.prev_asks[k] = asks[k];
        }

        if total_weight_depth > 1e-9 {
            self.cached_multi_level_ofi = (weighted_ofi_sum / total_weight_depth).clamp(-1.0, 1.0);
        } else {
            self.cached_multi_level_ofi = 0.0;
        }
    }

    /// Garman-Klass Realized Volatility calculation over rolling micro-bars.
    fn recalculate_rv_gk(&mut self) {
        if self.bar_count == 0 {
            self.cached_rv_gk = 0.0;
            return;
        }

        let mut sum_gk = 0.0;
        let const_ratio = 2.0 * 2.0f64.ln() - 1.0;

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

        let h16 = self.calculate_rs_subwindow(16);
        let h32 = self.calculate_rs_subwindow(32);

        if h16 > 1e-6 && h32 > 1e-6 {
            let ratio = h32 / h16;
            if ratio > 0.0 {
                let h = (ratio.ln() / 2.0f64.ln()).clamp(0.1, 0.9);
                self.cached_hurst = h;
            }
        }

        // Classify Regime with Hawkes and VPIN awareness
        if self.cached_vpin > 0.85 || self.is_sweep_detected {
            self.cached_regime = MicroRegime::ToxicChopTrap;
        } else if self.cached_hurst > 0.55 && self.cached_hawkes_asymmetry.abs() > 0.35 {
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

    pub fn get_multi_level_ofi(&self) -> f64 {
        self.cached_multi_level_ofi
    }

    pub fn get_hawkes_intensity_buy(&self) -> f64 {
        self.hawkes_lambda_buy
    }

    pub fn get_hawkes_intensity_sell(&self) -> f64 {
        self.hawkes_lambda_sell
    }

    pub fn get_hawkes_asymmetry(&self) -> f64 {
        self.cached_hawkes_asymmetry
    }

    /// Calculate Dynamic Stop-Loss and Take-Profit prices based on live microstructure metrics.
    pub fn calculate_dynamic_collars(
        &self,
        entry_price: f64,
        position_side: &str,
        obi: f64,
        spread: f64,
    ) -> (f64, f64) {
        if entry_price <= 0.0 {
            return (0.0, 0.0);
        }

        let vol_factor = self.cached_rv_gk.max(0.0020);
        let spread_factor = spread.max(entry_price * 0.0001);
        let obi_signed = obi.clamp(-1.0, 1.0);

        if position_side == "LONG" {
            let sl_distance = (vol_factor * 1.5 * (1.0 - 0.4 * obi_signed) * entry_price)
                .max(spread_factor * 2.0);
            let tp_distance = (vol_factor * 2.0 * (1.0 + 0.5 * obi_signed) * entry_price)
                .max(spread_factor * 3.0);

            let sl_price = entry_price - sl_distance;
            let tp_price = entry_price + tp_distance;
            (sl_price, tp_price)
        } else {
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
        assert_eq!(analyzer.get_multi_level_ofi(), 0.0);
        assert_eq!(analyzer.get_hawkes_asymmetry(), 0.0);
    }

    #[test]
    fn test_multi_level_ofi_calculation() {
        let mut analyzer = MicrostructureAnalyzer::new(50.0);
        let mut bids = [(50000.0, 1.0); 20];
        let asks = [(50001.0, 1.0); 20];

        analyzer.on_depth_update(&bids, &asks, 100_000_000);
        assert_eq!(analyzer.get_multi_level_ofi(), 0.0);

        // Simulate bid accumulation across top 5 levels
        for i in 0..5 {
            bids[i].1 = 5.0; // Increase bid depth
        }
        analyzer.on_depth_update(&bids, &asks, 150_000_000);
        assert!(analyzer.get_multi_level_ofi() > 0.0, "OFI must be positive for bid accumulation");
    }

    #[test]
    fn test_hawkes_intensity_and_asymmetry() {
        let mut analyzer = MicrostructureAnalyzer::new(50.0);
        let ts_base = 1_000_000_000u64;

        // Ingest series of aggressive taker buys
        for i in 0..10 {
            analyzer.on_trade_with_ts(50000.0, 0.10, false, ts_base + i * 50_000_000);
        }

        assert!(analyzer.get_hawkes_intensity_buy() > analyzer.get_hawkes_intensity_sell());
        assert!(analyzer.get_hawkes_asymmetry() > 0.30, "Hawkes asymmetry should be strongly positive for taker buys");
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
}
