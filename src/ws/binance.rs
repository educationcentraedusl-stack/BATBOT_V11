use crate::lob::{LockFreeSpscQueue, MarketUpdateEvent, LOB_DEPTH};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

#[derive(Deserialize)]
struct BinanceCombinedStream<'a> {
    #[serde(borrow)]
    stream: &'a str,
    #[serde(borrow)]
    data: &'a serde_json::value::RawValue,
}

#[derive(Deserialize)]
struct BinanceDepthPayload<'a> {
    #[serde(borrow)]
    b: Vec<[&'a str; 2]>,
    #[serde(borrow)]
    a: Vec<[&'a str; 2]>,
}

#[derive(Deserialize)]
struct BinanceTradePayload<'a> {
    #[serde(borrow)]
    p: &'a str,
    #[serde(borrow)]
    q: &'a str,
    m: bool,
}

#[derive(Deserialize)]
struct BinanceForceOrderOuter<'a> {
    #[serde(borrow)]
    o: BinanceForceOrderData<'a>,
}

#[derive(Deserialize)]
struct BinanceForceOrderData<'a> {
    #[serde(borrow)]
    s: &'a str,
    #[serde(borrow)]
    S: &'a str,
    #[serde(borrow)]
    p: &'a str,
    #[serde(borrow)]
    q: &'a str,
}

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
        let combined: BinanceCombinedStream = match serde_json::from_str(text) {
            Ok(c) => c,
            Err(_) => return,
        };

        let timestamp_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);

        if combined.stream.contains("@depth20") {
            if let Ok(depth) = serde_json::from_str::<BinanceDepthPayload>(combined.data.get()) {
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
        } else if combined.stream.contains("@aggTrade") {
            if let Ok(trade) = serde_json::from_str::<BinanceTradePayload>(combined.data.get()) {
                let price = trade.p.parse::<f64>().unwrap_or(0.0);
                let quantity = trade.q.parse::<f64>().unwrap_or(0.0);
                let is_buyer_maker = trade.m;

                let _ = queue.push(MarketUpdateEvent::TradeEvent {
                    price,
                    quantity,
                    is_buyer_maker,
                    timestamp_ns,
                });
            }
        } else if combined.stream.contains("@forceOrder") {
            if let Ok(fo) = serde_json::from_str::<BinanceForceOrderOuter>(combined.data.get()) {
                let price = fo.o.p.parse::<f64>().unwrap_or(0.0);
                let quantity = fo.o.q.parse::<f64>().unwrap_or(0.0);

                let _ = queue.push(MarketUpdateEvent::new_liquidation(
                    fo.o.s,
                    fo.o.S,
                    price,
                    quantity,
                    timestamp_ns,
                ));
            }
        }
    }
}

