use std::sync::atomic::{AtomicU64, Ordering};
use serde::{Deserialize, Serialize};
use crate::ipc::shared_memory::AtomicSharedMemoryBridge;
use crate::oms::types::OrderSide;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionSnapshot {
    pub symbol: String,
    pub position_qty: f64,
    pub avg_entry_price: f64,
    pub realized_pnl: f64,
    pub unrealized_pnl: f64,
    pub cum_volume_usd: f64,
    pub total_trades: u64,
    pub leverage: f64,
}

pub struct PositionLedger {
    symbol: String,
    position_qty_bits: AtomicU64,
    avg_entry_price_bits: AtomicU64,
    realized_pnl_bits: AtomicU64,
    unrealized_pnl_bits: AtomicU64,
    cum_volume_usd_bits: AtomicU64,
    total_trades: AtomicU64,
    leverage_bits: AtomicU64,
}

impl PositionLedger {
    pub fn new(symbol: String, initial_leverage: f64) -> Self {
        Self {
            symbol,
            position_qty_bits: AtomicU64::new(0.0f64.to_bits()),
            avg_entry_price_bits: AtomicU64::new(0.0f64.to_bits()),
            realized_pnl_bits: AtomicU64::new(0.0f64.to_bits()),
            unrealized_pnl_bits: AtomicU64::new(0.0f64.to_bits()),
            cum_volume_usd_bits: AtomicU64::new(0.0f64.to_bits()),
            total_trades: AtomicU64::new(0),
            leverage_bits: AtomicU64::new(initial_leverage.to_bits()),
        }
    }

    #[inline]
    fn get_f64(&self, atomic: &AtomicU64) -> f64 {
        f64::from_bits(atomic.load(Ordering::Relaxed))
    }

    #[inline]
    fn set_f64(&self, atomic: &AtomicU64, val: f64) {
        atomic.store(val.to_bits(), Ordering::Release);
    }

    pub fn position_qty(&self) -> f64 {
        self.get_f64(&self.position_qty_bits)
    }

    pub fn avg_entry_price(&self) -> f64 {
        self.get_f64(&self.avg_entry_price_bits)
    }

    pub fn realized_pnl(&self) -> f64 {
        self.get_f64(&self.realized_pnl_bits)
    }

    pub fn unrealized_pnl(&self) -> f64 {
        self.get_f64(&self.unrealized_pnl_bits)
    }

    pub fn cum_volume_usd(&self) -> f64 {
        self.get_f64(&self.cum_volume_usd_bits)
    }

    pub fn total_trades(&self) -> u64 {
        self.total_trades.load(Ordering::Relaxed)
    }

    pub fn leverage(&self) -> f64 {
        self.get_f64(&self.leverage_bits)
    }

    pub fn set_leverage(&self, leverage: f64) {
        self.set_f64(&self.leverage_bits, leverage);
    }

    pub fn update_mark_price(&self, mark_price: f64) -> f64 {
        let pos = self.position_qty();
        let entry = self.avg_entry_price();

        if pos.abs() < 1e-9 || mark_price <= 0.0 || entry <= 0.0 {
            self.set_f64(&self.unrealized_pnl_bits, 0.0);
            return 0.0;
        }

        let upnl = if pos > 0.0 {
            pos * (mark_price - entry)
        } else {
            pos.abs() * (entry - mark_price)
        };

        self.set_f64(&self.unrealized_pnl_bits, upnl);
        upnl
    }

    pub fn apply_fill(&self, side: OrderSide, qty: f64, price: f64, fee: f64) {
        if qty <= 0.0 || price <= 0.0 {
            return;
        }

        let cur_pos = self.position_qty();
        let cur_entry = self.avg_entry_price();
        let fill_qty = if side == OrderSide::Buy { qty } else { -qty };

        let trade_val = qty * price;
        let prev_vol = self.cum_volume_usd();
        self.set_f64(&self.cum_volume_usd_bits, prev_vol + trade_val);
        self.total_trades.fetch_add(1, Ordering::Relaxed);

        let new_pos = cur_pos + fill_qty;

        if cur_pos == 0.0 {
            // Opening a new position from flat
            self.set_f64(&self.position_qty_bits, new_pos);
            self.set_f64(&self.avg_entry_price_bits, price);
        } else if (cur_pos > 0.0 && fill_qty > 0.0) || (cur_pos < 0.0 && fill_qty < 0.0) {
            // Increasing existing position in same direction
            let total_qty = cur_pos.abs() + qty;
            let weighted_entry = (cur_pos.abs() * cur_entry + trade_val) / total_qty;
            self.set_f64(&self.position_qty_bits, new_pos);
            self.set_f64(&self.avg_entry_price_bits, weighted_entry);
        } else {
            // Reducing or reversing position
            let closed_qty = cur_pos.abs().min(qty);
            let pnl = if cur_pos > 0.0 {
                closed_qty * (price - cur_entry) - fee
            } else {
                closed_qty * (cur_entry - price) - fee
            };

            let cur_pnl = self.realized_pnl();
            self.set_f64(&self.realized_pnl_bits, cur_pnl + pnl);

            if new_pos.abs() < 1e-9 {
                // Fully closed to flat
                self.set_f64(&self.position_qty_bits, 0.0);
                self.set_f64(&self.avg_entry_price_bits, 0.0);
            } else if (cur_pos > 0.0 && new_pos < 0.0) || (cur_pos < 0.0 && new_pos > 0.0) {
                // Flipped position direction
                self.set_f64(&self.position_qty_bits, new_pos);
                self.set_f64(&self.avg_entry_price_bits, price);
            } else {
                // Partially closed position (direction unchanged)
                self.set_f64(&self.position_qty_bits, new_pos);
            }
        }
    }

    pub fn snapshot(&self) -> PositionSnapshot {
        PositionSnapshot {
            symbol: self.symbol.clone(),
            position_qty: self.position_qty(),
            avg_entry_price: self.avg_entry_price(),
            realized_pnl: self.realized_pnl(),
            unrealized_pnl: self.unrealized_pnl(),
            cum_volume_usd: self.cum_volume_usd(),
            total_trades: self.total_trades(),
            leverage: self.leverage(),
        }
    }

    pub fn sync_to_sab(&self, sab: &AtomicSharedMemoryBridge) {
        sab.store_f64(105, self.position_qty());
        sab.store_f64(106, self.avg_entry_price());
        sab.store_f64(107, self.realized_pnl());
        sab.store_f64(108, self.unrealized_pnl());
        sab.store_f64(109, self.leverage());
        sab.store_f64(110, self.cum_volume_usd());
        sab.store_u64(111, self.total_trades());
    }
}
