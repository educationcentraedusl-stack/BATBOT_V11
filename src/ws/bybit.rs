use crate::lob::{LockFreeSpscQueue, MarketUpdateEvent, LOB_DEPTH};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

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
                    if let Ok(json) = serde_json::from_str::<Value>(&text) {
                        Self::parse_and_enqueue(&json, &queue);
                    }
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

    fn parse_and_enqueue(json: &Value, queue: &LockFreeSpscQueue) {
        let topic = match json.get("topic").and_then(|t| t.as_str()) {
            Some(t) => t,
            None => return,
        };

        let data = match json.get("data") {
            Some(d) => d,
            None => return,
        };

        let timestamp_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);

        if topic.starts_with("orderbook.20.") {
            let bids_val = match data.get("b").and_then(|b| b.as_array()) {
                Some(arr) => arr,
                None => return,
            };
            let asks_val = match data.get("a").and_then(|a| a.as_array()) {
                Some(arr) => arr,
                None => return,
            };

            let mut bids = [(0.0, 0.0); LOB_DEPTH];
            let mut asks = [(0.0, 0.0); LOB_DEPTH];

            for (i, item) in bids_val.iter().take(LOB_DEPTH).enumerate() {
                if let Some(pair) = item.as_array() {
                    let p = pair.get(0).and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                    let q = pair.get(1).and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                    bids[i] = (p, q);
                }
            }

            for (i, item) in asks_val.iter().take(LOB_DEPTH).enumerate() {
                if let Some(pair) = item.as_array() {
                    let p = pair.get(0).and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                    let q = pair.get(1).and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                    asks[i] = (p, q);
                }
            }

            let _ = queue.push(MarketUpdateEvent::DepthUpdate {
                bids,
                asks,
                timestamp_ns,
            });
        } else if topic.starts_with("publicTrade.") {
            if let Some(trades) = data.as_array() {
                for trade in trades {
                    let price = trade.get("p").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                    let quantity = trade.get("v").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                    let side = trade.get("S").and_then(|v| v.as_str()).unwrap_or("");
                    let is_buyer_maker = side == "Sell";

                    let _ = queue.push(MarketUpdateEvent::TradeEvent {
                        price,
                        quantity,
                        is_buyer_maker,
                        timestamp_ns,
                    });
                }
            }
        } else if topic.starts_with("liquidation.") {
            let symbol = data.get("symbol").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let side = data.get("side").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let price = data.get("price").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
            let quantity = data.get("size").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);

            let _ = queue.push(MarketUpdateEvent::LiquidationEvent {
                symbol,
                side,
                price,
                quantity,
                timestamp_ns,
            });
        }
    }
}
