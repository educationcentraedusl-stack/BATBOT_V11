use crate::lob::{LockFreeSpscQueue, MarketUpdateEvent, LOB_DEPTH};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

#[derive(Deserialize)]
struct BybitStreamMessage<'a> {
    #[serde(borrow)]
    topic: &'a str,
    #[serde(borrow)]
    data: &'a serde_json::value::RawValue,
}

#[derive(Deserialize)]
struct BybitDepthPayload<'a> {
    #[serde(borrow)]
    b: Vec<[&'a str; 2]>,
    #[serde(borrow)]
    a: Vec<[&'a str; 2]>,
}

#[derive(Deserialize)]
struct BybitTradeItem<'a> {
    #[serde(borrow)]
    p: &'a str,
    #[serde(borrow)]
    v: &'a str,
    #[serde(borrow)]
    S: &'a str,
}

#[derive(Deserialize)]
struct BybitLiquidationPayload<'a> {
    #[serde(borrow)]
    symbol: &'a str,
    #[serde(borrow)]
    side: &'a str,
    #[serde(borrow)]
    price: &'a str,
    #[serde(borrow)]
    size: &'a str,
}

pub struct BybitWsStream {
    symbol: String,
    stream_url: String,
    is_running: Arc<AtomicBool>,
}

impl BybitWsStream {
    pub fn new(symbol: &str) -> Self {
        Self {
            symbol: symbol.to_uppercase(),
            stream_url: "wss://stream.bybit.com/v5/public/linear".to_string(),
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::Relaxed);
    }

    pub async fn connect_and_listen(&self, queue: LockFreeSpscQueue) -> Result<(), String> {
        let (ws_stream, _) = match connect_async(self.stream_url.as_str()).await {
            Ok(res) => res,
            Err(e) => return Err(format!("Failed to connect to Bybit WS: {}", e)),
        };

        self.is_running.store(true, Ordering::Relaxed);
        let (mut write, mut read) = ws_stream.split();

        // Subscribe payload
        let sub_payload = json!({
            "op": "subscribe",
            "args": [
                format!("orderbook.20.{}", self.symbol),
                format!("publicTrade.{}", self.symbol),
                format!("liquidation.{}", self.symbol)
            ]
        });

        if let Ok(msg_str) = serde_json::to_string(&sub_payload) {
            let _ = write.send(Message::Text(msg_str.into())).await;
        }

        while self.is_running.load(Ordering::Relaxed) {
            match read.next().await {
                Some(Ok(Message::Text(text))) => {
                    Self::parse_and_enqueue(&text, &queue);
                }
                Some(Ok(Message::Ping(payload))) => {
                    let _ = write.send(Message::Pong(payload)).await;
                }
                Some(Ok(Message::Close(_))) => {
                    self.is_running.store(false, Ordering::Relaxed);
                    break;
                }
                Some(Err(_)) => {
                    self.is_running.store(false, Ordering::Relaxed);
                    break;
                }
                None => {
                    self.is_running.store(false, Ordering::Relaxed);
                    break;
                }
                _ => {}
            }
        }

        Ok(())
    }

    fn parse_and_enqueue(text: &str, queue: &LockFreeSpscQueue) {
        let msg: BybitStreamMessage = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(_) => return,
        };

        let timestamp_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);

        if msg.topic.starts_with("orderbook.20.") {
            if let Ok(depth) = serde_json::from_str::<BybitDepthPayload>(msg.data.get()) {
                let mut bids = [(0.0, 0.0); LOB_DEPTH];
                let mut asks = [(0.0, 0.0); LOB_DEPTH];

                for (i, pair) in depth.b.iter().take(LOB_DEPTH).enumerate() {
                    let p = pair[0].parse::<f64>().unwrap_or(0.0);
                    let q = pair[1].parse::<f64>().unwrap_or(0.0);
                    bids[i] = (p, q);
                }

                for (i, pair) in depth.a.iter().take(LOB_DEPTH).enumerate() {
                    let p = pair[0].parse::<f64>().unwrap_or(0.0);
                    let q = pair[1].parse::<f64>().unwrap_or(0.0);
                    asks[i] = (p, q);
                }

                let _ = queue.push(MarketUpdateEvent::DepthUpdate {
                    bids,
                    asks,
                    timestamp_ns,
                });
            }
        } else if msg.topic.starts_with("publicTrade.") {
            if let Ok(trades) = serde_json::from_str::<Vec<BybitTradeItem>>(msg.data.get()) {
                for trade in trades {
                    let price = trade.p.parse::<f64>().unwrap_or(0.0);
                    let quantity = trade.v.parse::<f64>().unwrap_or(0.0);
                    let is_buyer_maker = trade.S == "Sell";

                    let _ = queue.push(MarketUpdateEvent::TradeEvent {
                        price,
                        quantity,
                        is_buyer_maker,
                        timestamp_ns,
                    });
                }
            }
        } else if msg.topic.starts_with("liquidation.") {
            if let Ok(liq) = serde_json::from_str::<BybitLiquidationPayload>(msg.data.get()) {
                let price = liq.price.parse::<f64>().unwrap_or(0.0);
                let quantity = liq.size.parse::<f64>().unwrap_or(0.0);

                let _ = queue.push(MarketUpdateEvent::new_liquidation(
                    liq.symbol,
                    liq.side,
                    price,
                    quantity,
                    timestamp_ns,
                ));
            }
        }
    }
}

