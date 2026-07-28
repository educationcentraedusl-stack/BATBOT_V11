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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderIntent {
    pub client_order_id: String,
    pub symbol: String,
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

    pub fn notional_value(&self) -> f64 {
        self.quantity * self.price
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionReport {
    pub client_order_id: String,
    pub order_id: u64,
    pub symbol: String,
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
