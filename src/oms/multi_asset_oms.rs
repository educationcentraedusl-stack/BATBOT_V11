use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use crate::ipc::shared_memory::AtomicSharedMemoryBridge;
use crate::oms::position::PositionLedger;
use crate::oms::risk::{OmsRiskGuard, RiskConfig};
use crate::oms::slicing::ExecutionSlicer;
use crate::oms::sor::SmartOrderRouter;
use crate::oms::types::{
    ExecutionReport, OmsMetrics, OrderIntent, OrderIntentPacket, OrderStatus,
    RejectionReason,
};


pub const MAX_OMS_ASSETS: usize = 10;
pub const SAB_SLOTS_PER_ASSET: usize = 256;

// Ring buffer capacity (must be power of 2)
pub const INTENT_RING_CAPACITY: usize = 1024;

/// SPSC Lock-free Ring Buffer for high-frequency OrderIntentPackets
pub struct LockFreeIntentQueue {
    buffer: Vec<OrderIntentPacket>,
    head: AtomicU64,
    tail: AtomicU64,
}

impl LockFreeIntentQueue {
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.next_power_of_two();
        let mut buffer = Vec::with_capacity(cap);
        for _ in 0..cap {
            buffer.push(OrderIntentPacket::default());
        }
        Self {
            buffer,
            head: AtomicU64::new(0),
            tail: AtomicU64::new(0),
        }
    }

    pub fn push(&self, packet: OrderIntentPacket) -> bool {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        if head.wrapping_sub(tail) >= self.buffer.len() as u64 {
            return false; // Queue full
        }
        let idx = (head as usize) & (self.buffer.len() - 1);
        unsafe {
            let slot_ptr = self.buffer.as_ptr().add(idx) as *mut OrderIntentPacket;
            std::ptr::write_volatile(slot_ptr, packet);
        }
        self.head.store(head.wrapping_add(1), Ordering::Release);
        true
    }

    pub fn pop(&self) -> Option<OrderIntentPacket> {
        let tail = self.tail.load(Ordering::Relaxed);
        let head = self.head.load(Ordering::Acquire);
        if tail == head {
            return None; // Queue empty
        }
        let idx = (tail as usize) & (self.buffer.len() - 1);
        let packet = unsafe {
            let slot_ptr = self.buffer.as_ptr().add(idx);
            std::ptr::read_volatile(slot_ptr)
        };
        self.tail.store(tail.wrapping_add(1), Ordering::Release);
        Some(packet)
    }

    pub fn is_empty(&self) -> bool {
        self.tail.load(Ordering::Relaxed) == self.head.load(Ordering::Acquire)
    }
}

pub struct MultiAssetOmsEngine {
    max_assets: usize,
    symbols: RwLock<Vec<String>>,
    position_ledgers: Vec<Arc<PositionLedger>>,
    risk_guard: OmsRiskGuard,
    sor: SmartOrderRouter,
    slicing: ExecutionSlicer,
    intent_queue: Arc<LockFreeIntentQueue>,
    account_balance_usd: AtomicU64,
    metrics_orders_submitted: Vec<AtomicU64>,
    metrics_orders_filled: Vec<AtomicU64>,
    metrics_orders_canceled: Vec<AtomicU64>,
    metrics_orders_rejected: Vec<AtomicU64>,
    metrics_volume_usd_bits: Vec<AtomicU64>,
}

impl MultiAssetOmsEngine {
    pub fn new(
        max_assets: usize,
        initial_balance_usd: f64,
        symbols: Vec<String>,
        risk_config: Option<RiskConfig>,
    ) -> Self {
        let max_assets = max_assets.clamp(1, MAX_OMS_ASSETS);
        let mut position_ledgers = Vec::with_capacity(max_assets);
        let mut metrics_orders_submitted = Vec::with_capacity(max_assets);
        let mut metrics_orders_filled = Vec::with_capacity(max_assets);
        let mut metrics_orders_canceled = Vec::with_capacity(max_assets);
        let mut metrics_orders_rejected = Vec::with_capacity(max_assets);
        let mut metrics_volume_usd_bits = Vec::with_capacity(max_assets);

        for i in 0..max_assets {
            let sym = symbols.get(i).cloned().unwrap_or_else(|| format!("ASSET_{}", i));
            position_ledgers.push(Arc::new(PositionLedger::new(sym, 5.0)));
            metrics_orders_submitted.push(AtomicU64::new(0));
            metrics_orders_filled.push(AtomicU64::new(0));
            metrics_orders_canceled.push(AtomicU64::new(0));
            metrics_orders_rejected.push(AtomicU64::new(0));
            metrics_volume_usd_bits.push(AtomicU64::new(0.0f64.to_bits()));
        }

        Self {
            max_assets,
            symbols: RwLock::new(symbols),
            position_ledgers,
            risk_guard: OmsRiskGuard::new(risk_config.unwrap_or_default()),
            sor: SmartOrderRouter::default_hft(),
            slicing: ExecutionSlicer::default_hft(),
            intent_queue: Arc::new(LockFreeIntentQueue::new(INTENT_RING_CAPACITY)),
            account_balance_usd: AtomicU64::new(initial_balance_usd.to_bits()),
            metrics_orders_submitted,
            metrics_orders_filled,
            metrics_orders_canceled,
            metrics_orders_rejected,
            metrics_volume_usd_bits,
        }
    }

    pub fn default_hft(initial_balance_usd: f64) -> Self {
        let default_symbols = vec![
            "ETHUSDT".to_string(),
            "SOLUSDT".to_string(),
            "BNBUSDT".to_string(),
            "XRPUSDT".to_string(),
            "ADAUSDT".to_string(),
            "DOGEUSDT".to_string(),
            "AVAXUSDT".to_string(),
            "LINKUSDT".to_string(),
            "SUIUSDT".to_string(),
            "NEARUSDT".to_string(),
        ];
        Self::new(10, initial_balance_usd, default_symbols, None)
    }

    pub fn intent_queue(&self) -> Arc<LockFreeIntentQueue> {
        self.intent_queue.clone()
    }

    pub fn account_balance_usd(&self) -> f64 {
        f64::from_bits(self.account_balance_usd.load(Ordering::Relaxed))
    }

    pub fn set_account_balance_usd(&self, balance: f64) {
        self.account_balance_usd.store(balance.to_bits(), Ordering::Release);
    }

    pub fn sync_sab_slots(&self, bridge: &AtomicSharedMemoryBridge) {
        for asset_idx in 0..self.max_assets {
            let ledger = &self.position_ledgers[asset_idx];
            let snap = ledger.snapshot();
            let submitted = self.metrics_orders_submitted[asset_idx].load(Ordering::Relaxed);
            let filled = self.metrics_orders_filled[asset_idx].load(Ordering::Relaxed);
            let canceled = self.metrics_orders_canceled[asset_idx].load(Ordering::Relaxed);
            let rejected = self.metrics_orders_rejected[asset_idx].load(Ordering::Relaxed);
            let vol_usd = f64::from_bits(self.metrics_volume_usd_bits[asset_idx].load(Ordering::Relaxed));

            bridge.store_f64_asset(asset_idx, 181, 0.0); // Active orders count
            bridge.store_f64_asset(asset_idx, 182, snap.position_qty);
            bridge.store_f64_asset(asset_idx, 183, snap.avg_entry_price);
            bridge.store_f64_asset(asset_idx, 184, snap.realized_pnl);
            bridge.store_f64_asset(asset_idx, 185, snap.unrealized_pnl);
            bridge.store_f64_asset(asset_idx, 186, submitted as f64);
            bridge.store_f64_asset(asset_idx, 187, filled as f64);
            bridge.store_f64_asset(asset_idx, 188, canceled as f64);
            bridge.store_f64_asset(asset_idx, 189, rejected as f64);
            bridge.store_f64_asset(asset_idx, 190, vol_usd);
        }
    }

    pub fn submit_intent(
        &self,
        intent: OrderIntent,
        mid_price: f64,
        top5_depth_usd: f64,
        step_size: f64,
        tick_size: f64,
        portfolio_leverage: f64,
        avg_correlation: f64,
    ) -> Result<Vec<OrderIntent>, RejectionReason> {
        let asset_idx = intent.asset_idx.min(self.max_assets - 1);
        let cur_pos = self.position_ledgers[asset_idx].snapshot().position_qty;


        if let Err(err) = self.risk_guard.validate_multi_asset_order(
            &intent,
            mid_price,
            cur_pos,
            portfolio_leverage,
            avg_correlation,
        ) {
            self.metrics_orders_rejected[asset_idx].fetch_add(1, Ordering::Relaxed);
            let reason = match err {
                crate::oms::risk::OmsRiskError::RateLimitExceeded(_) => RejectionReason::RateLimitExceeded,
                crate::oms::risk::OmsRiskError::PriceCollarExceeded { .. } => RejectionReason::PriceCollarExceeded,
                crate::oms::risk::OmsRiskError::LeverageCapExceeded { .. } => RejectionReason::LeverageCapExceeded,
                crate::oms::risk::OmsRiskError::CorrelationSpikeEmergency { .. } => RejectionReason::CorrelationSpikeEmergency,
                _ => RejectionReason::InvalidQuantityOrPrice,
            };
            return Err(reason);
        }

        // Slice intent if necessary
        let slices = self.slicing.slice_intent(&intent, top5_depth_usd, step_size, tick_size);

        // Push slices to lock-free intent ring buffer
        for slice in &slices {
            let pkt = OrderIntentPacket::from_intent(slice);
            self.intent_queue.push(pkt);
            self.metrics_orders_submitted[asset_idx].fetch_add(1, Ordering::Relaxed);
        }

        Ok(slices)
    }

    pub fn apply_fill(&self, report: ExecutionReport) {
        let asset_idx = report.asset_idx.min(self.max_assets - 1);
        if report.status == OrderStatus::Filled || report.status == OrderStatus::PartiallyFilled {
            self.position_ledgers[asset_idx].apply_fill(
                report.side,
                report.last_filled_qty,
                report.last_filled_price,
                report.commission,
            );
            if report.status == OrderStatus::Filled {
                self.metrics_orders_filled[asset_idx].fetch_add(1, Ordering::Relaxed);
            }
            let fill_vol = report.last_filled_qty * report.last_filled_price;
            let mut cur = self.metrics_volume_usd_bits[asset_idx].load(Ordering::Relaxed);
            loop {
                let new_val = f64::from_bits(cur) + fill_vol;
                match self.metrics_volume_usd_bits[asset_idx].compare_exchange_weak(
                    cur,
                    new_val.to_bits(),
                    Ordering::Acquire,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(actual) => cur = actual,
                }
            }
        } else if report.status == OrderStatus::Canceled {
            self.metrics_orders_canceled[asset_idx].fetch_add(1, Ordering::Relaxed);
        } else if report.status == OrderStatus::Rejected {
            self.metrics_orders_rejected[asset_idx].fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn get_metrics(&self, asset_idx: usize) -> OmsMetrics {
        let idx = asset_idx.min(self.max_assets - 1);
        let snap = self.position_ledgers[idx].snapshot();
        OmsMetrics {
            asset_idx: idx,
            total_orders_submitted: self.metrics_orders_submitted[idx].load(Ordering::Relaxed),
            total_orders_filled: self.metrics_orders_filled[idx].load(Ordering::Relaxed),
            total_orders_canceled: self.metrics_orders_canceled[idx].load(Ordering::Relaxed),
            total_orders_rejected: self.metrics_orders_rejected[idx].load(Ordering::Relaxed),
            total_volume_usd: f64::from_bits(self.metrics_volume_usd_bits[idx].load(Ordering::Relaxed)),
            realized_pnl_usd: snap.realized_pnl,
            unrealized_pnl_usd: snap.unrealized_pnl,
            current_position_size: snap.position_qty,
            avg_entry_price: snap.avg_entry_price,
        }
    }

}
