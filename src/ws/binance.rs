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
struct BinanceBookTickerPayload<'a> {
    #[serde(borrow)]
    b: &'a str,
    #[serde(borrow)]
    #[serde(rename = "B")]
    bid_qty: &'a str,
    #[serde(borrow)]
    a: &'a str,
    #[serde(borrow)]
    #[serde(rename = "A")]
    ask_qty: &'a str,
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
    shutdown_requested: Arc<AtomicBool>,
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

        // Combined stream URL for bookTicker, depth20@100ms, aggTrade, forceOrder
        let url_str = format!(
            "wss://{}/stream?streams={}@bookTicker/{}@depth20@100ms/{}@aggTrade/{}@forceOrder",
            host, sym_lower, sym_lower, sym_lower, sym_lower
        );
        println!("[Binance WS] Initialized WebSocket URL: {}", url_str);

        Self {
            symbol: symbol.to_uppercase(),
            stream_url: url_str,
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
                    if let Err(e) = write.send(Message::Close(None)).await {
                        eprintln!("[Binance WS Warning] Failed to send close frame: {}", e);
                    }
                    if let Err(e) = write.close().await {
                        eprintln!("[Binance WS Warning] Failed to close write stream: {}", e);
                    }
                    self.is_running.store(false, Ordering::Relaxed);
                    break;
                }
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            self.parse_and_enqueue(&text, &queue);
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            if let Err(e) = write.send(Message::Pong(payload)).await {
                                eprintln!("[Binance WS Warning] Failed to send pong response: {}", e);
                            }
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

    fn parse_and_enqueue(&self, text: &str, queue: &LockFreeSpscQueue) {
        if self.shutdown_requested.load(Ordering::Relaxed) {
            return;
        }

        // Filter out non-stream control frames or subscription ACKs (e.g. {"result":null,"id":1})
        if text.contains("\"result\":") || text.contains("\"id\":") || !text.contains("\"stream\":") {
            return;
        }

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

        if self.shutdown_requested.load(Ordering::Relaxed) {
            return;
        }

        if combined.stream.contains("@bookTicker") {
            match serde_json::from_str::<BinanceBookTickerPayload>(combined.data.get()) {
                Ok(ticker) => {
                    let Ok(best_bid) = fast_float::parse::<f64, _>(ticker.b.as_bytes()) else { return; };
                    let Ok(best_bid_qty) = fast_float::parse::<f64, _>(ticker.bid_qty.as_bytes()) else { return; };
                    let Ok(best_ask) = fast_float::parse::<f64, _>(ticker.a.as_bytes()) else { return; };
                    let Ok(best_ask_qty) = fast_float::parse::<f64, _>(ticker.ask_qty.as_bytes()) else { return; };

                    if self.shutdown_requested.load(Ordering::Relaxed) {
                        return;
                    }

                    if let Err(_) = queue.push(MarketUpdateEvent::BookTickerUpdate {
                        best_bid,
                        best_bid_qty,
                        best_ask,
                        best_ask_qty,
                        timestamp_ns,
                    }) {
                        eprintln!(
                            "[Binance WS Warning] SPSC queue full! Dropped bookTicker event. Total dropped: {}",
                            LockFreeSpscQueue::dropped_count()
                        );
                    }
                }
                Err(e) => eprintln!("[Binance WS Error] Failed to deserialize bookTicker payload: {}", e),
            }
        } else if combined.stream.contains("@depth20") {
            match serde_json::from_str::<BinanceDepthPayload>(combined.data.get()) {
                Ok(depth) => {
                    let mut bids = [(0.0, 0.0); LOB_DEPTH];
                    let mut asks = [(0.0, 0.0); LOB_DEPTH];
                    let mut valid = true;

                    for (i, pair) in depth.b.iter().take(LOB_DEPTH).enumerate() {
                        let Ok(p) = fast_float::parse::<f64, _>(pair[0].as_bytes()) else { valid = false; break; };
                        let Ok(q) = fast_float::parse::<f64, _>(pair[1].as_bytes()) else { valid = false; break; };
                        bids[i] = (p, q);
                    }

                    for (i, pair) in depth.a.iter().take(LOB_DEPTH).enumerate() {
                        let Ok(p) = fast_float::parse::<f64, _>(pair[0].as_bytes()) else { valid = false; break; };
                        let Ok(q) = fast_float::parse::<f64, _>(pair[1].as_bytes()) else { valid = false; break; };
                        asks[i] = (p, q);
                    }

                    if valid {
                        if self.shutdown_requested.load(Ordering::Relaxed) {
                            return;
                        }
                        if let Err(_) = queue.push(MarketUpdateEvent::DepthUpdate {
                            bids,
                            asks,
                            timestamp_ns,
                        }) {
                            eprintln!(
                                "[Binance WS Warning] SPSC queue full! Dropped depth event. Total dropped: {}",
                                LockFreeSpscQueue::dropped_count()
                            );
                        }
                    } else {
                        eprintln!("[Binance WS Error] Failed to parse depth price/quantity float");
                    }
                }
                Err(e) => eprintln!("[Binance WS Error] Failed to deserialize depth payload: {}", e),
            }
        } else if combined.stream.contains("@aggTrade") {
            match serde_json::from_str::<BinanceTradePayload>(combined.data.get()) {
                Ok(trade) => {
                    let Ok(price) = fast_float::parse::<f64, _>(trade.p.as_bytes()) else {
                        eprintln!("[Binance WS Error] Failed to parse trade price float");
                        return;
                    };
                    let Ok(quantity) = fast_float::parse::<f64, _>(trade.q.as_bytes()) else {
                        eprintln!("[Binance WS Error] Failed to parse trade quantity float");
                        return;
                    };
                    let is_buyer_maker = trade.m;

                    if self.shutdown_requested.load(Ordering::Relaxed) {
                        return;
                    }

                    if let Err(_) = queue.push(MarketUpdateEvent::TradeEvent {
                        price,
                        quantity,
                        is_buyer_maker,
                        timestamp_ns,
                    }) {
                        eprintln!(
                            "[Binance WS Warning] SPSC queue full! Dropped trade event. Total dropped: {}",
                            LockFreeSpscQueue::dropped_count()
                        );
                    }
                }
                Err(e) => eprintln!("[Binance WS Error] Failed to deserialize trade payload: {}", e),
            }
        } else if combined.stream.contains("@forceOrder") {
            match serde_json::from_str::<BinanceForceOrderOuter>(combined.data.get()) {
                Ok(fo) => {
                    let Ok(price) = fast_float::parse::<f64, _>(fo.o.p.as_bytes()) else {
                        eprintln!("[Binance WS Error] Failed to parse liquidation price float");
                        return;
                    };
                    let Ok(quantity) = fast_float::parse::<f64, _>(fo.o.q.as_bytes()) else {
                        eprintln!("[Binance WS Error] Failed to parse liquidation quantity float");
                        return;
                    };

                    if self.shutdown_requested.load(Ordering::Relaxed) {
                        return;
                    }

                    if let Err(_) = queue.push(MarketUpdateEvent::new_liquidation(
                        fo.o.s,
                        fo.o.side,
                        price,
                        quantity,
                        timestamp_ns,
                    )) {
                        eprintln!(
                            "[Binance WS Warning] SPSC queue full! Dropped liquidation event. Total dropped: {}",
                            LockFreeSpscQueue::dropped_count()
                        );
                    }
                }
                Err(e) => eprintln!("[Binance WS Error] Failed to deserialize liquidation payload: {}", e),
            }
        }
    }
}


