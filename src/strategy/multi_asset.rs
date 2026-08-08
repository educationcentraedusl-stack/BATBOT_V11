use serde::{Deserialize, Serialize};
use crate::ipc::shared_memory::AtomicSharedMemoryBridge;
use crate::lob::MicrostructureMetrics;

pub const MAX_ACTIVE_ASSETS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SignalType {
    None,
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RejectReason {
    Approved,
    LiquidityVacuum,
    ToxicPumpSweep,
    CounterTrendRegime,
    LowSignalConfidence,
    HighSpreadVelocity,
    InvalidMetrics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetSignal {
    pub asset_index: usize,
    pub symbol: String,
    pub signal_type: SignalType,
    pub confidence: f64,
    pub obi: f64,
    pub cvd: f64,
    pub hurst: f64,
    pub hawkes_intensity: f64,
    pub vpin: f64,
    pub depth_depletion_rate: f64,
    pub reject_reason: RejectReason,
    pub is_approved: bool,
}

impl Default for AssetSignal {
    fn default() -> Self {
        Self {
            asset_index: 0,
            symbol: String::new(),
            signal_type: SignalType::None,
            confidence: 0.0,
            obi: 0.0,
            cvd: 0.0,
            hurst: 0.5,
            hawkes_intensity: 0.0,
            vpin: 0.0,
            depth_depletion_rate: 0.0,
            reject_reason: RejectReason::Approved,
            is_approved: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiAssetSignalResult {
    pub timestamp_ms: u64,
    pub signals: Vec<AssetSignal>,
}

pub struct MultiAssetSignalEngine {
    obi_threshold: f64,
    min_hurst_threshold: f64,
    max_depletion_threshold: f64,
    max_vpin_threshold: f64,
}

impl Default for MultiAssetSignalEngine {
    fn default() -> Self {
        Self {
            obi_threshold: 0.35,
            min_hurst_threshold: 0.45,
            max_depletion_threshold: 0.60,
            max_vpin_threshold: 0.75,
        }
    }
}

impl MultiAssetSignalEngine {
    pub fn new(
        obi_threshold: Option<f64>,
        min_hurst_threshold: Option<f64>,
        max_depletion_threshold: Option<f64>,
        max_vpin_threshold: Option<f64>,
    ) -> Self {
        Self {
            obi_threshold: obi_threshold.unwrap_or(0.35),
            min_hurst_threshold: min_hurst_threshold.unwrap_or(0.45),
            max_depletion_threshold: max_depletion_threshold.unwrap_or(0.60),
            max_vpin_threshold: max_vpin_threshold.unwrap_or(0.75),
        }
    }

    /// Evaluates signal for a single asset based on its microstructure metrics
    pub fn evaluate_asset(
        &self,
        asset_index: usize,
        symbol: &str,
        metrics: &MicrostructureMetrics,
        hawkes_buy_intensity: f64,
        hawkes_sell_intensity: f64,
        depth_depletion_rate: f64,
    ) -> AssetSignal {
        let mut signal = AssetSignal {
            asset_index,
            symbol: symbol.to_string(),
            signal_type: SignalType::None,
            confidence: 0.0,
            obi: metrics.obi,
            cvd: metrics.cvd,
            hurst: metrics.hurst,
            hawkes_intensity: hawkes_buy_intensity.max(hawkes_sell_intensity),
            vpin: metrics.vpin,
            depth_depletion_rate,
            reject_reason: RejectReason::Approved,
            is_approved: false,
        };

        // 1. Trap Check: Depth Depletion (Flash Liquidity Vacuum)
        if depth_depletion_rate > self.max_depletion_threshold {
            signal.reject_reason = RejectReason::LiquidityVacuum;
            return signal;
        }

        // 2. Trap Check: Hasbrouck Flow Toxicity & VPIN
        if metrics.vpin > self.max_vpin_threshold || metrics.is_sweep_detected {
            signal.reject_reason = RejectReason::ToxicPumpSweep;
            return signal;
        }

        // 3. Trap Check: Counter-Trend / Chaotic Noise Regime (Hurst < 0.40)
        if metrics.hurst < self.min_hurst_threshold {
            signal.reject_reason = RejectReason::CounterTrendRegime;
            return signal;
        }

        // 4. Alpha Signal Evaluation
        let is_buy_obi = metrics.obi >= self.obi_threshold;
        let is_sell_obi = metrics.obi <= -self.obi_threshold;
        let is_buy_hawkes = hawkes_buy_intensity > hawkes_sell_intensity * 1.35;
        let is_sell_hawkes = hawkes_sell_intensity > hawkes_buy_intensity * 1.35;

        if is_buy_obi && is_buy_hawkes && metrics.cvd >= 0.0 {
            let conf = ((metrics.obi.abs() * 0.4) + (metrics.hurst * 0.3) + ((hawkes_buy_intensity / (hawkes_sell_intensity + 1e-4)).min(2.0) * 0.15)).clamp(0.5, 0.99);
            signal.signal_type = SignalType::Buy;
            signal.confidence = conf;
            signal.is_approved = true;
        } else if is_sell_obi && is_sell_hawkes && metrics.cvd <= 0.0 {
            let conf = ((metrics.obi.abs() * 0.4) + (metrics.hurst * 0.3) + ((hawkes_sell_intensity / (hawkes_buy_intensity + 1e-4)).min(2.0) * 0.15)).clamp(0.5, 0.99);
            signal.signal_type = SignalType::Sell;
            signal.confidence = conf;
            signal.is_approved = true;
        } else {
            signal.reject_reason = RejectReason::LowSignalConfidence;
        }

        signal
    }

    /// Evaluates multi-asset signals directly from SharedArrayBuffer bridge
    pub fn evaluate_sab_matrix(
        &self,
        bridge: &AtomicSharedMemoryBridge,
        symbols: &[String; MAX_ACTIVE_ASSETS],
    ) -> MultiAssetSignalResult {
        let mut signals = Vec::with_capacity(MAX_ACTIVE_ASSETS);
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        for k in 0..MAX_ACTIVE_ASSETS {
            let symbol = &symbols[k];
            if symbol.is_empty() {
                continue;
            }

            // Read SAB slot metrics for asset k matching shared_memory.rs and marketDataClient.ts
            let obi = bridge.load_f64_asset(k, 1);
            let cvd = bridge.load_f64_asset(k, 2);
            let spread_vel = bridge.load_f64_asset(k, 3);
            let hawkes_intensity = bridge.load_f64_asset(k, 112);
            let microburst_score = bridge.load_f64_asset(k, 113);
            let _realized_vol = bridge.load_f64_asset(k, 114);
            let rv_gk = bridge.load_f64_asset(k, 121);
            let vpin = bridge.load_f64_asset(k, 122);
            let hurst = bridge.load_f64_asset(k, 123);
            let lob_entropy = bridge.load_f64_asset(k, 124);
            let regime_code = bridge.load_f64_asset(k, 125) as u8;
            let is_sweep_flag = bridge.load_f64_asset(k, 126) > 0.5;

            let metrics = MicrostructureMetrics {
                obi,
                cvd,
                spread_velocity: spread_vel,
                total_liquidation_vol: 0.0,
                buy_liquidation_vol: 0.0,
                sell_liquidation_vol: 0.0,
                rv_gk,
                vpin,
                hurst: if hurst > 0.0 { hurst } else { 0.5 },
                lob_entropy: if lob_entropy > 0.0 { lob_entropy } else { 1.0 },
                regime: if regime_code > 0 { regime_code } else { 1 },
                is_sweep_detected: is_sweep_flag || vpin > 0.85,
                ..Default::default()
            };

            let hawkes_buy = if obi >= 0.0 { hawkes_intensity * 1.5 } else { hawkes_intensity * 0.5 };
            let hawkes_sell = if obi <= 0.0 { hawkes_intensity * 1.5 } else { hawkes_intensity * 0.5 };
            let depletion = microburst_score;

            let sig = self.evaluate_asset(k, symbol, &metrics, hawkes_buy, hawkes_sell, depletion);
            signals.push(sig);
        }

        MultiAssetSignalResult {
            timestamp_ms: now_ms,
            signals,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_depth_depletion_trap() {
        let engine = MultiAssetSignalEngine::default();
        let metrics = MicrostructureMetrics::default();
        
        let signal = engine.evaluate_asset(0, "ETHUSDT", &metrics, 2.0, 0.5, 0.75); // Depletion 0.75 > 0.60
        assert_eq!(signal.signal_type, SignalType::None);
        assert_eq!(signal.reject_reason, RejectReason::LiquidityVacuum);
        assert!(!signal.is_approved);
    }

    #[test]
    fn test_valid_buy_signal() {
        let engine = MultiAssetSignalEngine::default();
        let metrics = MicrostructureMetrics {
            obi: 0.60,
            cvd: 15.0,
            rv_gk: 0.02,
            vpin: 0.20,
            hurst: 0.65,
            lob_entropy: 0.5,
            regime: 1,
            is_sweep_detected: false,
            ..Default::default()
        };

        let signal = engine.evaluate_asset(0, "SOLUSDT", &metrics, 3.0, 1.0, 0.10);
        assert_eq!(signal.signal_type, SignalType::Buy);
        assert_eq!(signal.reject_reason, RejectReason::Approved);
        assert!(signal.is_approved);
        assert!(signal.confidence >= 0.5);
    }
}
