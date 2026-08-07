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
    #[serde(rename = "S", borrow)]
    side: &'a str,
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
    shutdown_requested: Arc<AtomicBool>,
    shutdown_notify: Arc<tokio::sync::Notify>,
}

impl BybitWsStream {
    pub fn new(symbol: &str) -> Self {
        Self {
            symbol: symbol.to_uppercase(),
            stream_url: "wss://stream.bybit.com/v5/public/linear".to_string(),
            is_running: Arc::new(AtomicBool::new(false)),
            shutdown_requested: Arc::new(AtomicBool::new(false)),
            shutdown_notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.shutdown_requested.store(true, Ordering::Relaxed);
        self.is_running.store(false, Ordering::Relaxed);
        self.shutdown_notify.notify_one();
    }

    pub fn is_shutdown_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::Relaxed)
    }

    pub fn shutdown_notify(&self) -> Arc<tokio::sync::Notify> {
        self.shutdown_notify.clone()
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
            tokio::select! {
                _ = self.shutdown_notify.notified() => {
                    let _ = write.send(Message::Close(None)).await;
                    self.is_running.store(false, Ordering::Relaxed);
                    break;
                }
                msg = read.next() => {
                    match msg {
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
                        Some(Err(e)) => {
                            eprintln!("[Bybit WS Error] Stream error: {}", e);
                            self.is_running.store(false, Ordering::Relaxed);
                            break;
                        }
                        None => {
                            eprintln!("[Bybit WS Error] Stream closed unexpectedly");
                            self.is_running.store(false, Ordering::Relaxed);
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        Ok(())
    }

    fn parse_and_enqueue(text: &str, queue: &LockFreeSpscQueue) {
        let msg: BybitStreamMessage = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[Bybit WS Error] Failed to deserialize stream message: {}", e);
                return;
            }
        };

        let timestamp_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);

        if msg.topic.starts_with("orderbook.20.") {
            match serde_json::from_str::<BybitDepthPayload>(msg.data.get()) {
                Ok(depth) => {
                    let mut bids = [(0.0, 0.0); LOB_DEPTH];
                    let mut asks = [(0.0, 0.0); LOB_DEPTH];
                    let mut valid = true;

                    for (i, pair) in depth.b.iter().take(LOB_DEPTH).enumerate() {
                        let Ok(p) = pair[0].parse::<f64>() else { valid = false; break; };
                        let Ok(q) = pair[1].parse::<f64>() else { valid = false; break; };
                        bids[i] = (p, q);
                    }

                    for (i, pair) in depth.a.iter().take(LOB_DEPTH).enumerate() {
                        let Ok(p) = pair[0].parse::<f64>() else { valid = false; break; };
                        let Ok(q) = pair[1].parse::<f64>() else { valid = false; break; };
                        asks[i] = (p, q);
                    }

                    if valid {
                        let _ = queue.push(MarketUpdateEvent::DepthUpdate {
                            bids,
                            asks,
                            timestamp_ns,
                        });
                    } else {
                        eprintln!("[Bybit WS Error] Failed to parse depth price/quantity float");
                    }
                }
                Err(e) => eprintln!("[Bybit WS Error] Failed to deserialize depth payload: {}", e),
            }
        } else if msg.topic.starts_with("publicTrade.") {
            match serde_json::from_str::<Vec<BybitTradeItem>>(msg.data.get()) {
                Ok(trades) => {
                    for trade in trades {
                        let Ok(price) = trade.p.parse::<f64>() else {
                            eprintln!("[Bybit WS Error] Failed to parse trade price float");
                            continue;
                        };
                        let Ok(quantity) = trade.v.parse::<f64>() else {
                            eprintln!("[Bybit WS Error] Failed to parse trade quantity float");
                            continue;
                        };
                        let is_buyer_maker = trade.side == "Sell";

                        let _ = queue.push(MarketUpdateEvent::TradeEvent {
                            price,
                            quantity,
                            is_buyer_maker,
                            timestamp_ns,
                        });
                    }
                }
                Err(e) => eprintln!("[Bybit WS Error] Failed to deserialize trade payload: {}", e),
            }
        } else if msg.topic.starts_with("liquidation.") {
            match serde_json::from_str::<BybitLiquidationPayload>(msg.data.get()) {
                Ok(liq) => {
                    let Ok(price) = liq.price.parse::<f64>() else {
                        eprintln!("[Bybit WS Error] Failed to parse liquidation price float");
                        return;
                    };
                    let Ok(quantity) = liq.size.parse::<f64>() else {
                        eprintln!("[Bybit WS Error] Failed to parse liquidation quantity float");
                        return;
                    };

                    let _ = queue.push(MarketUpdateEvent::new_liquidation(
                        liq.symbol,
                        liq.side,
                        price,
                        quantity,
                        timestamp_ns,
                    ));
                }
                Err(e) => eprintln!("[Bybit WS Error] Failed to deserialize liquidation payload: {}", e),
            }
        }
    }
}

