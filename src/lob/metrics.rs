#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MicrostructureMetrics {
    pub obi: f64,
    pub cvd: f64,
    pub spread_velocity: f64,
    pub last_spread: f64,
    pub micro_price: f64,
    pub last_timestamp_ns: u64,
    pub total_liquidation_vol: f64,
    pub buy_liquidation_vol: f64,
    pub sell_liquidation_vol: f64,
    pub rv_gk: f64,
    pub vpin: f64,
    pub hurst: f64,
    pub lob_entropy: f64,
    pub regime: u8,
    pub is_sweep_detected: bool,
}

impl Default for MicrostructureMetrics {
    fn default() -> Self {
        Self {
            obi: 0.0,
            cvd: 0.0,
            spread_velocity: 0.0,
            last_spread: 0.0,
            micro_price: 0.0,
            last_timestamp_ns: 0,
            total_liquidation_vol: 0.0,
            buy_liquidation_vol: 0.0,
            sell_liquidation_vol: 0.0,
            rv_gk: 0.0,
            vpin: 0.0,
            hurst: 0.5,
            lob_entropy: 0.0,
            regime: 0,
            is_sweep_detected: false,
        }
    }
}

pub fn calculate_obi(bids: &[(f64, f64); 20], asks: &[(f64, f64); 20]) -> f64 {
    let mut total_bid_vol = 0.0;
    let mut total_ask_vol = 0.0;

    let mut i = 0;
    while i < 20 {
        if bids[i].1.is_finite() && bids[i].1 > 0.0 {
            total_bid_vol += bids[i].1;
        }
        if asks[i].1.is_finite() && asks[i].1 > 0.0 {
            total_ask_vol += asks[i].1;
        }
        i += 1;
    }

    let denominator = total_bid_vol + total_ask_vol;
    if denominator.is_nan() || !denominator.is_finite() || denominator <= 1e-12 {
        0.0
    } else {
        ((total_bid_vol - total_ask_vol) / denominator).clamp(-1.0, 1.0)
    }
}

/// Calculate Volume-Weighted Micro-Price: P_micro = (Q_b * P_a + Q_a * P_b) / (Q_b + Q_a)
pub fn calculate_micro_price(bids: &[(f64, f64); 20], asks: &[(f64, f64); 20]) -> f64 {
    let pb = bids[0].0;
    let qb = bids[0].1;
    let pa = asks[0].0;
    let qa = asks[0].1;

    let pb_valid = pb.is_finite() && pb > 0.0;
    let pa_valid = pa.is_finite() && pa > 0.0;
    let qb_valid = qb.is_finite() && qb >= 0.0;
    let qa_valid = qa.is_finite() && qa >= 0.0;

    if !qb_valid || !qa_valid {
        return if pb_valid && pa_valid {
            (pb + pa) * 0.5
        } else if pb_valid {
            pb
        } else if pa_valid {
            pa
        } else {
            0.0
        };
    }

    let denominator = qb + qa;
    if denominator.is_nan() || !denominator.is_finite() || denominator <= 1e-12 {
        if pb_valid && pa_valid {
            (pb + pa) * 0.5
        } else if pb_valid {
            pb
        } else if pa_valid {
            pa
        } else {
            0.0
        }
    } else {
        let mp = (qb * pa + qa * pb) / denominator;
        if mp.is_nan() || !mp.is_finite() || mp <= 0.0 {
            if pb_valid && pa_valid {
                (pb + pa) * 0.5
            } else if pb_valid {
                pb
            } else if pa_valid {
                pa
            } else {
                0.0
            }
        } else {
            mp
        }
    }
}

pub fn update_cvd(current_cvd: f64, trade_price: f64, trade_qty: f64, is_buyer_maker: bool) -> f64 {
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

pub fn update_liquidation(
    metrics: &mut MicrostructureMetrics,
    price: f64,
    quantity: f64,
    is_buy: bool,
) {
    let vol = price * quantity;
    metrics.total_liquidation_vol += vol;
    if is_buy {
        metrics.buy_liquidation_vol += vol;
    } else {
        metrics.sell_liquidation_vol += vol;
    }
}

