use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use hex;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

use crate::oms::types::{ExecutionReport, OrderIntent, OrderStatus, OrderSide};

type HmacSha256 = Hmac<Sha256>;

pub struct BinanceWsConfig {
    pub api_key: String,
    pub api_secret: String,
    pub is_testnet: bool,
}

impl BinanceWsConfig {
    pub fn get_ws_url(&self) -> &'static str {
        if self.is_testnet {
            "wss://testnet.binancefuture.com/ws-fapi/v1"
        } else {
            "wss://ws-fapi.binance.com/ws-fapi/v1"
        }
    }
}

pub struct BinanceWsApiClient {
    config: BinanceWsConfig,
    is_connected: Arc<AtomicBool>,
    tx_order_outbound: mpsc::UnboundedSender<String>,
}

impl BinanceWsApiClient {
    pub fn new(config: BinanceWsConfig) -> (Self, mpsc::UnboundedReceiver<ExecutionReport>) {
        let (tx_outbound, rx_outbound) = mpsc::unbounded_channel::<String>();
        let (tx_report, rx_report) = mpsc::unbounded_channel::<ExecutionReport>();
        let is_connected = Arc::new(AtomicBool::new(false));

        let client = Self {
            config,
            is_connected: is_connected.clone(),
            tx_order_outbound: tx_outbound,
        };

        // Spawn async background connection worker
        let ws_url_str = client.config.get_ws_url();
        let api_key = client.config.api_key.clone();
        let api_secret = client.config.api_secret.clone();
        let connected_flag = is_connected;

        tokio::spawn(async move {
            Self::run_ws_loop(ws_url_str, api_key, api_secret, rx_outbound, tx_report, connected_flag).await;
        });

        (client, rx_report)
    }

    pub fn is_connected(&self) -> bool {
        self.is_connected.load(Ordering::Relaxed)
    }

    pub fn sign_query_string(query: &str, secret: &str) -> Result<String, String> {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
            .map_err(|e| format!("HMAC init error: {}", e))?;
        mac.update(query.as_bytes());
        let result = mac.finalize();
        Ok(hex::encode(result.into_bytes()))
    }

    pub fn send_order_intent(&self, intent: &OrderIntent) -> Result<(), String> {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        // 1. Build sorted query parameters string for signature calculation
        let query_str = format!(
            "apiKey={}&newClientOrderId={}&price={:.2}&quantity={:.3}&side={}&symbol={}&timeInForce={}&timestamp={}&type={}",
            self.config.api_key,
            intent.client_order_id,
            intent.price,
            intent.quantity,
            intent.side.as_str(),
            intent.symbol,
            intent.time_in_force.as_str(),
            now_ms,
            intent.order_type.as_str()
        );

        let signature = Self::sign_query_string(&query_str, &self.config.api_secret)?;

        // 2. Format Binance WebSocket API v3 order.place payload
        let payload = format!(
            "{{\"id\":\"{}\",\"method\":\"order.place\",\"params\":{{\"apiKey\":\"{}\",\"newClientOrderId\":\"{}\",\"price\":\"{:.2}\",\"quantity\":\"{:.3}\",\"side\":\"{}\",\"symbol\":\"{}\",\"timeInForce\":\"{}\",\"timestamp\":{},\"type\":\"{}\",\"signature\":\"{}\"}}}}",
            intent.client_order_id,
            self.config.api_key,
            intent.client_order_id,
            intent.price,
            intent.quantity,
            intent.side.as_str(),
            intent.symbol,
            intent.time_in_force.as_str(),
            now_ms,
            intent.order_type.as_str(),
            signature
        );

        self.tx_order_outbound
            .send(payload)
            .map_err(|e| format!("Failed to queue order payload: {}", e))
    }

    pub fn send_cancel_order(&self, symbol: &str, client_order_id: &str) -> Result<(), String> {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let query_str = format!(
            "apiKey={}&origClientOrderId={}&symbol={}&timestamp={}",
            self.config.api_key, client_order_id, symbol, now_ms
        );

        let signature = Self::sign_query_string(&query_str, &self.config.api_secret)?;

        let payload = format!(
            "{{\"id\":\"cancel_{}\",\"method\":\"order.cancel\",\"params\":{{\"apiKey\":\"{}\",\"origClientOrderId\":\"{}\",\"symbol\":\"{}\",\"timestamp\":{},\"signature\":\"{}\"}}}}",
            client_order_id,
            self.config.api_key,
            client_order_id,
            symbol,
            now_ms,
            signature
        );

        self.tx_order_outbound
            .send(payload)
            .map_err(|e| format!("Failed to queue cancel payload: {}", e))
    }

    async fn run_ws_loop(
        url_str: &'static str,
        _api_key: String,
        _api_secret: String,
        mut rx_outbound: mpsc::UnboundedReceiver<String>,
        tx_report: mpsc::UnboundedSender<ExecutionReport>,
        connected_flag: Arc<AtomicBool>,
    ) {
        loop {
            println!("[BATBOT_V11][WS OMS] Connecting to Binance Futures WS API: {}...", url_str);
            match connect_async(url_str).await {
                Ok((ws_stream, _)) => {
                    println!("[BATBOT_V11][WS OMS] WebSocket connected successfully.");
                    connected_flag.store(true, Ordering::Release);

                    let (mut write, mut read) = ws_stream.split();

                    loop {
                        tokio::select! {
                            Some(outbound_msg) = rx_outbound.recv() => {
                                if let Err(e) = write.send(Message::Text(outbound_msg.into())).await {
                                    eprintln!("[BATBOT_V11][WS OMS Error] Socket write error: {}", e);
                                    break;
                                }
                            }
                            Some(msg) = read.next() => {
                                match msg {
                                    Ok(Message::Text(txt)) => {
                                        Self::parse_and_dispatch_ws_msg(&txt, &tx_report);
                                    }
                                    Ok(Message::Ping(ping_data)) => {
                                        let _ = write.send(Message::Pong(ping_data)).await;
                                    }
                                    Ok(Message::Close(_)) => {
                                        println!("[BATBOT_V11][WS OMS] Connection closed by remote exchange server.");
                                        break;
                                    }
                                    Err(e) => {
                                        eprintln!("[BATBOT_V11][WS OMS Error] Socket read error: {}", e);
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                            else => break,
                        }
                    }

                    connected_flag.store(false, Ordering::Release);
                }
                Err(e) => {
                    eprintln!("[BATBOT_V11][WS OMS Error] WebSocket connection failed: {}. Retrying in 2s...", e);
                    connected_flag.store(false, Ordering::Release);
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                }
            }
        }
    }

    fn parse_and_dispatch_ws_msg(txt: &str, tx_report: &mpsc::UnboundedSender<ExecutionReport>) {
        let v: serde_json::Value = match serde_json::from_str(txt) {
            Ok(val) => val,
            Err(_) => return,
        };

        // Parse Execution Report (from WebSocket API v3 response or User Data Stream ORDER_TRADE_UPDATE)
        if let Some(result) = v.get("result") {
            let status_str = result.get("status").and_then(|s| s.as_str()).unwrap_or("NEW");
            let client_order_id = result.get("clientOrderId").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let symbol = result.get("symbol").and_then(|s| s.as_str()).unwrap_or("BTCUSDT").to_string();
            let side_str = result.get("side").and_then(|s| s.as_str()).unwrap_or("BUY");
            let side = if side_str == "BUY" { OrderSide::Buy } else { OrderSide::Sell };
            let executed_qty: f64 = result.get("executedQty").and_then(|s| s.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let avg_price: f64 = result.get("avgPrice").and_then(|s| s.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let order_id: u64 = result.get("orderId").and_then(|s| s.as_u64()).unwrap_or(0);

            let now_ns = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as u64;

            let report = ExecutionReport {
                client_order_id,
                order_id,
                symbol,
                side,
                status: OrderStatus::from_str(status_str),
                last_filled_qty: executed_qty,
                last_filled_price: avg_price,
                cum_filled_qty: executed_qty,
                avg_price,
                commission: 0.0,
                commission_asset: "USDT".to_string(),
                trade_id: 0,
                event_time_ns: now_ns,
                is_maker: false,
            };

            let _ = tx_report.send(report);
        }
    }
}
