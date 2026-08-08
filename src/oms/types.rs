use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    pub fn as_str(&self) -> &'static str {
        match self {
            OrderSide::Buy => "BUY",
            OrderSide::Sell => "SELL",
        }
    }

    pub fn opposite(&self) -> Self {
        match self {
            OrderSide::Buy => OrderSide::Sell,
            OrderSide::Sell => OrderSide::Buy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderType {
    Limit,
    Market,
    StopMarket,
    TakeProfitMarket,
}

impl OrderType {
    pub fn as_str(&self) -> &'static str {
        match self {
            OrderType::Limit => "LIMIT",
            OrderType::Market => "MARKET",
            OrderType::StopMarket => "STOP_MARKET",
            OrderType::TakeProfitMarket => "TAKE_PROFIT_MARKET",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimeInForce {
    Gtc, // Good Till Cancel
    Ioc, // Immediate Or Cancel
    Fok, // Fill Or Kill
    Gtx, // Post Only (Good Till Crossing)
}

impl TimeInForce {
    pub fn as_str(&self) -> &'static str {
        match self {
            TimeInForce::Gtc => "GTC",
            TimeInForce::Ioc => "IOC",
            TimeInForce::Fok => "FOK",
            TimeInForce::Gtx => "GTX",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderStatus {
    New,
    PartiallyFilled,
    Filled,
    Canceled,
    Rejected,
    Expired,
}

impl OrderStatus {
    pub fn from_str(s: &str) -> Self {
        match s {
            "NEW" => OrderStatus::New,
            "PARTIALLY_FILLED" => OrderStatus::PartiallyFilled,
            "FILLED" => OrderStatus::Filled,
            "CANCELED" => OrderStatus::Canceled,
            "REJECTED" => OrderStatus::Rejected,
            "EXPIRED" => OrderStatus::Expired,
            _ => OrderStatus::Rejected,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            OrderStatus::Filled | OrderStatus::Canceled | OrderStatus::Rejected | OrderStatus::Expired
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExecutionMode {
    MakerPostOnly,
    TakerAggressiveSweep,
    PeggedBbo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RejectionReason {
    None,
    RateLimitExceeded,
    PriceCollarExceeded,
    LeverageCapExceeded,
    CorrelationSpikeEmergency,
    InvalidQuantityOrPrice,
    RiskGuardEngineError,
}

impl RejectionReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            RejectionReason::None => "NONE",
            RejectionReason::RateLimitExceeded => "REJECTED_RATE_LIMIT",
            RejectionReason::PriceCollarExceeded => "REJECTED_PRICE_COLLAR",
            RejectionReason::LeverageCapExceeded => "REJECTED_LEVERAGE_CAP",
            RejectionReason::CorrelationSpikeEmergency => "REJECTED_CORRELATION_SPIKE",
            RejectionReason::InvalidQuantityOrPrice => "REJECTED_INVALID_QTY_PRICE",
            RejectionReason::RiskGuardEngineError => "REJECTED_RISK_GUARD_ERROR",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderIntent {
    pub client_order_id: String,
    pub symbol: String,
    pub asset_idx: usize,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub time_in_force: TimeInForce,
    pub quantity: f64,
    pub price: f64,
    pub reduce_only: bool,
    pub post_only: bool,
    pub target_horizon_ms: f64,
    pub ai_confidence: f64,
    pub ai_direction: f64,
    pub creation_ns: u64,
}

impl OrderIntent {
    pub fn new(
        client_order_id: String,
        symbol: String,
        side: OrderSide,
        order_type: OrderType,
        time_in_force: TimeInForce,
        quantity: f64,
        price: f64,
        reduce_only: bool,
        post_only: bool,
        target_horizon_ms: f64,
        ai_confidence: f64,
        ai_direction: f64,
        creation_ns: u64,
    ) -> Self {
        Self {
            client_order_id,
            symbol,
            asset_idx: 0,
            side,
            order_type,
            time_in_force,
            quantity,
            price,
            reduce_only,
            post_only,
            target_horizon_ms,
            ai_confidence,
            ai_direction,
            creation_ns,
        }
    }

    pub fn with_asset_idx(mut self, asset_idx: usize) -> Self {
        self.asset_idx = asset_idx;
        self
    }

    pub fn notional_value(&self) -> f64 {
        self.quantity * self.price
    }
}

/// Zero-copy fixed 128-byte packet for lock-free ring buffer queueing across threads.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct OrderIntentPacket {
    pub asset_idx: u32,
    pub side: u8, // 0 = Buy, 1 = Sell
    pub order_type: u8, // 0 = Limit, 1 = Market, 2 = StopMarket, 3 = TakeProfitMarket
    pub time_in_force: u8, // 0 = Gtc, 1 = Ioc, 2 = Fok, 3 = Gtx
    pub flags: u8, // bit 0: reduce_only, bit 1: post_only
    pub quantity: f64,
    pub price: f64,
    pub target_horizon_ms: f32,
    pub ai_confidence: f32,
    pub ai_direction: f32,
    pub _pad: u32, // Explicit 4-byte padding to align creation_ns (u64) on 8-byte boundary
    pub creation_ns: u64,
    pub client_order_id_bytes: [u8; 64],
    pub symbol_bytes: [u8; 16],
}

impl Default for OrderIntentPacket {
    fn default() -> Self {
        Self {
            asset_idx: 0,
            side: 0,
            order_type: 0,
            time_in_force: 0,
            flags: 0,
            quantity: 0.0,
            price: 0.0,
            target_horizon_ms: 0.0,
            ai_confidence: 0.0,
            ai_direction: 0.0,
            _pad: 0,
            creation_ns: 0,
            client_order_id_bytes: [0u8; 64],
            symbol_bytes: [0u8; 16],
        }
    }
}

impl OrderIntentPacket {
    pub fn notional_value(&self) -> f64 {
        self.quantity * self.price
    }

    #[inline(always)]
    pub fn is_reduce_only(&self) -> bool {
        (self.flags & (1 << 0)) != 0
    }

    #[inline(always)]
    pub fn is_post_only(&self) -> bool {
        (self.flags & (1 << 1)) != 0
    }

    #[inline(always)]
    pub fn set_reduce_only(&mut self, val: bool) {
        if val { self.flags |= 1 << 0; } else { self.flags &= !(1 << 0); }
    }

    #[inline(always)]
    pub fn set_post_only(&mut self, val: bool) {
        if val { self.flags |= 1 << 1; } else { self.flags &= !(1 << 1); }
    }

    #[inline(always)]
    pub fn client_order_id_str(&self) -> &str {
        let len = self.client_order_id_bytes.iter().position(|&b| b == 0).unwrap_or(64);
        std::str::from_utf8(&self.client_order_id_bytes[..len]).unwrap_or("")
    }

    #[inline(always)]
    pub fn symbol_str(&self) -> &str {
        let len = self.symbol_bytes.iter().position(|&b| b == 0).unwrap_or(16);
        std::str::from_utf8(&self.symbol_bytes[..len]).unwrap_or("")
    }

    #[inline(always)]
    pub fn set_client_order_id(&mut self, cid: &str) {
        self.client_order_id_bytes = [0u8; 64];
        let bytes = cid.as_bytes();
        let len = bytes.len().min(64);
        self.client_order_id_bytes[..len].copy_from_slice(&bytes[..len]);
    }

    #[inline(always)]
    pub fn set_symbol(&mut self, sym: &str) {
        self.symbol_bytes = [0u8; 16];
        let bytes = sym.as_bytes();
        let len = bytes.len().min(16);
        self.symbol_bytes[..len].copy_from_slice(&bytes[..len]);
    }

    pub fn from_intent(intent: &OrderIntent) -> Self {
        let mut pkt = Self::default();
        pkt.asset_idx = intent.asset_idx as u32;
        pkt.side = match intent.side {
            OrderSide::Buy => 0,
            OrderSide::Sell => 1,
        };
        pkt.order_type = match intent.order_type {
            OrderType::Limit => 0,
            OrderType::Market => 1,
            OrderType::StopMarket => 2,
            OrderType::TakeProfitMarket => 3,
        };
        pkt.time_in_force = match intent.time_in_force {
            TimeInForce::Gtc => 0,
            TimeInForce::Ioc => 1,
            TimeInForce::Fok => 2,
            TimeInForce::Gtx => 3,
        };
        let mut flags = 0u8;
        if intent.reduce_only { flags |= 1 << 0; }
        if intent.post_only { flags |= 1 << 1; }
        pkt.flags = flags;
        pkt.quantity = intent.quantity;
        pkt.price = intent.price;
        pkt.target_horizon_ms = intent.target_horizon_ms as f32;
        pkt.ai_confidence = intent.ai_confidence as f32;
        pkt.ai_direction = intent.ai_direction as f32;
        pkt.creation_ns = intent.creation_ns;

        let cid_bytes = intent.client_order_id.as_bytes();
        let len_cid = cid_bytes.len().min(64);
        pkt.client_order_id_bytes[..len_cid].copy_from_slice(&cid_bytes[..len_cid]);

        let sym_bytes = intent.symbol.as_bytes();
        let len_sym = sym_bytes.len().min(16);
        pkt.symbol_bytes[..len_sym].copy_from_slice(&sym_bytes[..len_sym]);

        pkt
    }

    pub fn to_intent(&self) -> OrderIntent {
        let side = if self.side == 0 { OrderSide::Buy } else { OrderSide::Sell };
        let order_type = match self.order_type {
            0 => OrderType::Limit,
            1 => OrderType::Market,
            2 => OrderType::StopMarket,
            _ => OrderType::TakeProfitMarket,
        };
        let time_in_force = match self.time_in_force {
            0 => TimeInForce::Gtc,
            1 => TimeInForce::Ioc,
            2 => TimeInForce::Fok,
            _ => TimeInForce::Gtx,
        };
        let reduce_only = (self.flags & (1 << 0)) != 0;
        let post_only = (self.flags & (1 << 1)) != 0;

        let cid_len = self.client_order_id_bytes.iter().position(|&b| b == 0).unwrap_or(64);
        let client_order_id = String::from_utf8_lossy(&self.client_order_id_bytes[..cid_len]).to_string();

        let sym_len = self.symbol_bytes.iter().position(|&b| b == 0).unwrap_or(16);
        let symbol = String::from_utf8_lossy(&self.symbol_bytes[..sym_len]).to_string();

        OrderIntent {
            client_order_id,
            symbol,
            asset_idx: self.asset_idx as usize,
            side,
            order_type,
            time_in_force,
            quantity: self.quantity,
            price: self.price,
            reduce_only,
            post_only,
            target_horizon_ms: self.target_horizon_ms as f64,
            ai_confidence: self.ai_confidence as f64,
            ai_direction: self.ai_direction as f64,
            creation_ns: self.creation_ns,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionReport {
    pub client_order_id: String,
    pub order_id: u64,
    pub symbol: String,
    pub asset_idx: usize,
    pub side: OrderSide,
    pub status: OrderStatus,
    pub last_filled_qty: f64,
    pub last_filled_price: f64,
    pub cum_filled_qty: f64,
    pub avg_price: f64,
    pub commission: f64,
    pub commission_asset: String,
    pub trade_id: u64,
    pub event_time_ns: u64,
    pub is_maker: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OmsMetrics {
    pub asset_idx: usize,
    pub total_orders_submitted: u64,
    pub total_orders_filled: u64,
    pub total_orders_canceled: u64,
    pub total_orders_rejected: u64,
    pub total_volume_usd: f64,
    pub realized_pnl_usd: f64,
    pub unrealized_pnl_usd: f64,
    pub current_position_size: f64,
    pub avg_entry_price: f64,
}

