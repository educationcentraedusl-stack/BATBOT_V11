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
    #[serde(rename = "S", borrow)]
    side: &'a str,
    #[serde(borrow)]
    p: &'a str,
    #[serde(borrow)]
    q: &'a str,
}

pub struct BinanceWsStream {
    pub symbol: String,
    stream_url: String,
    is_running: Arc<AtomicBool>,
    shutdown_notify: Arc<tokio::sync::Notify>,
}

impl BinanceWsStream {
    pub fn new(symbol: &str) -> Self {
        let sym_lower = symbol.to_lowercase();
        let use_testnet = std::env::var("USE_TESTNET").map(|v| v == "true" || v == "1").unwrap_or(false)
            || std::env::var("BINANCE_TESTNET").map(|v| v == "true").unwrap_or(false);

        let host = if use_testnet {
            "stream.binancefuture.com"
        } else {
            "fstream.binance.com"
        };

        // Combined stream URL for depth20@100ms, aggTrade, forceOrder
        let url_str = format!(
            "wss://{}/stream?streams={}@depth20@100ms/{}@aggTrade/{}@forceOrder",
            host, sym_lower, sym_lower, sym_lower
        );
        println!("[Binance WS] Initialized WebSocket URL: {}", url_str);

        Self {
            symbol: symbol.to_uppercase(),
            stream_url: url_str,
            is_running: Arc::new(AtomicBool::new(false)),
            shutdown_notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::Relaxed);
        self.shutdown_notify.notify_one();
    }

    pub async fn connect_and_listen(&self, queue: LockFreeSpscQueue) -> Result<(), String> {
        println!("[Binance WS] Connecting to Binance WebSocket stream ({}) ...", self.stream_url);
        let (ws_stream, _) = match connect_async(self.stream_url.as_str()).await {
            Ok(res) => {
                println!("[Binance WS] ✅ Connected to Binance WebSocket successfully!");
                res
            }
            Err(e) => {
                eprintln!("[Binance WS Error] ❌ Failed to connect to Binance WS (URL: {}): {}", self.stream_url, e);
                return Err(format!("Failed to connect to Binance WS: {}", e));
            }
        };

        self.is_running.store(true, Ordering::Relaxed);
        let (mut write, mut read) = ws_stream.split();

        while self.is_running.load(Ordering::Relaxed) {
            tokio::select! {
                _ = self.shutdown_notify.notified() => {
                    println!("[Binance WS] Received shutdown notification.");
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
                            println!("[Binance WS] Connection closed by remote server.");
                            self.is_running.store(false, Ordering::Relaxed);
                            break;
                        }
                        Some(Err(e)) => {
                            eprintln!("[Binance WS Error] Stream error: {}", e);
                            self.is_running.store(false, Ordering::Relaxed);
                            break;
                        }
                        None => {
                            eprintln!("[Binance WS Error] Stream closed unexpectedly (EOF)");
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
        let combined: BinanceCombinedStream = match serde_json::from_str(text) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[Binance WS Error] Failed to deserialize combined stream payload: {}", e);
                return;
            }
        };

        let timestamp_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);

        if combined.stream.contains("@depth20") {
            match serde_json::from_str::<BinanceDepthPayload>(combined.data.get()) {
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
                        eprintln!("[Binance WS Error] Failed to parse depth price/quantity float");
                    }
                }
                Err(e) => eprintln!("[Binance WS Error] Failed to deserialize depth payload: {}", e),
            }
        } else if combined.stream.contains("@aggTrade") {
            match serde_json::from_str::<BinanceTradePayload>(combined.data.get()) {
                Ok(trade) => {
                    let Ok(price) = trade.p.parse::<f64>() else {
                        eprintln!("[Binance WS Error] Failed to parse trade price float");
                        return;
                    };
                    let Ok(quantity) = trade.q.parse::<f64>() else {
                        eprintln!("[Binance WS Error] Failed to parse trade quantity float");
                        return;
                    };
                    let is_buyer_maker = trade.m;

                    let _ = queue.push(MarketUpdateEvent::TradeEvent {
                        price,
                        quantity,
                        is_buyer_maker,
                        timestamp_ns,
                    });
                }
                Err(e) => eprintln!("[Binance WS Error] Failed to deserialize trade payload: {}", e),
            }
        } else if combined.stream.contains("@forceOrder") {
            match serde_json::from_str::<BinanceForceOrderOuter>(combined.data.get()) {
                Ok(fo) => {
                    let Ok(price) = fo.o.p.parse::<f64>() else {
                        eprintln!("[Binance WS Error] Failed to parse liquidation price float");
                        return;
                    };
                    let Ok(quantity) = fo.o.q.parse::<f64>() else {
                        eprintln!("[Binance WS Error] Failed to parse liquidation quantity float");
                        return;
                    };

                    let _ = queue.push(MarketUpdateEvent::new_liquidation(
                        fo.o.s,
                        fo.o.side,
                        price,
                        quantity,
                        timestamp_ns,
                    ));
                }
                Err(e) => eprintln!("[Binance WS Error] Failed to deserialize liquidation payload: {}", e),
            }
        }
    }
}

