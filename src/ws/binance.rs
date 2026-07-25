use crate::lob::{LockFreeSpscQueue, MarketUpdateEvent, LOB_DEPTH};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

pub struct BinanceWsStream {
    pub symbol: String,
    stream_url: String,
    is_running: Arc<AtomicBool>,
}

impl BinanceWsStream {
    pub fn new(symbol: &str) -> Self {
        let sym_lower = symbol.to_lowercase();
        // Combined stream URL for depth20@100ms, aggTrade, forceOrder
        let url_str = format!(
            "wss://fstream.binance.com/stream?streams={}@depth20@100ms/{}@aggTrade/{}@forceOrder",
            sym_lower, sym_lower, sym_lower
        );
        Self {
            symbol: symbol.to_uppercase(),
            stream_url: url_str,
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
            Err(e) => return Err(format!("Failed to connect to Binance WS: {}", e)),
        };

        self.is_running.store(true, Ordering::Relaxed);
        let (mut write, mut read) = ws_stream.split();

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
        let stream = match json.get("stream").and_then(|s| s.as_str()) {
            Some(s) => s,
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

        if stream.contains("@depth20") {
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
        } else if stream.contains("@aggTrade") {
            let price = data.get("p").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
            let quantity = data.get("q").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
            let is_buyer_maker = data.get("m").and_then(|v| v.as_bool()).unwrap_or(false);

            let _ = queue.push(MarketUpdateEvent::TradeEvent {
                price,
                quantity,
                is_buyer_maker,
                timestamp_ns,
            });
        } else if stream.contains("@forceOrder") {
            let o = match data.get("o") {
                Some(obj) => obj,
                None => return,
            };
            let symbol = o.get("s").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let side = o.get("S").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let price = o.get("p").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
            let quantity = o.get("q").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);

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
