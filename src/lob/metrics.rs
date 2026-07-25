#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MicrostructureMetrics {
    pub obi: f64,
    pub cvd: f64,
    pub spread_velocity: f64,
    pub last_spread: f64,
    pub last_timestamp_ns: u64,
}

impl Default for MicrostructureMetrics {
    fn default() -> Self {
        Self {
            obi: 0.0,
            cvd: 0.0,
            spread_velocity: 0.0,
            last_spread: 0.0,
            last_timestamp_ns: 0,
        }
    }
}

pub fn calculate_obi(bids: &[(f64, f64); 20], asks: &[(f64, f64); 20]) -> f64 {
    let mut total_bid_vol = 0.0;
    let mut total_ask_vol = 0.0;

    let mut i = 0;
    while i < 20 {
        total_bid_vol += bids[i].1;
        total_ask_vol += asks[i].1;
        i += 1;
    }

    let denominator = total_bid_vol + total_ask_vol;
    if denominator <= 1e-12 {
        0.0
    } else {
        (total_bid_vol - total_ask_vol) / denominator
    }
}

pub fn update_cvd(current_cvd: f64, trade_price: f64, trade_qty: f64, is_buyer_maker: bool) -> f64 {
    // If buyer is maker, then the taker was a seller (aggressive sell).
    // If buyer is not maker, taker was a buyer (aggressive buy).
    if is_buyer_maker {
        current_cvd - (trade_price * trade_qty)
    } else {
        current_cvd + (trade_price * trade_qty)
    }
}

pub fn calculate_spread_velocity(
    current_spread: f64,
    previous_spread: f64,
    elapsed_seconds: f64,
) -> f64 {
    if elapsed_seconds <= 1e-9 {
        0.0
    } else {
        (current_spread - previous_spread) / elapsed_seconds
    }
}
