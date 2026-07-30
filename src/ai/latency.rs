use crate::ipc::shared_memory::AtomicSharedMemoryBridge;
use std::time::{Duration, Instant};
use tokio::time::sleep;

pub struct LatencyMonitor {
    bridge: AtomicSharedMemoryBridge,
    endpoint: String,
}

impl LatencyMonitor {
    pub fn new(bridge: AtomicSharedMemoryBridge, endpoint: Option<&str>) -> Self {
        Self {
            bridge,
            endpoint: endpoint
                .unwrap_or("https://fapi.binance.com/fapi/v1/time")
                .to_string(),
        }
    }

    pub async fn run_loop(&self) {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .user_agent("BATBOT_V11-HFT-LatencyMonitor/1.0")
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = e;
                return;
            }
        };

        loop {
            let start = Instant::now();
            let response = client.get(&self.endpoint).send().await;
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;

            match response {
                Ok(_) => {
                    let rtt_ms = elapsed_ms;
                    // latency_penalty_coefficient = max(0.5, 1.0 - (rtt - 50) / 200) clamped to max 1.0
                    let penalty_coeff = (1.0 - (rtt_ms - 50.0) / 200.0).clamp(0.5, 1.0);

                    // Slot 98: Measured RTT (ms)
                    self.bridge.store_f64(98, rtt_ms);
                    // Slot 99: Latency Penalty Coefficient
                    self.bridge.store_f64(99, penalty_coeff);
                }
                Err(_) => {
                    // Log error softly and maintain fallback values (e.g. 50ms default if slot was empty)
                    let current_rtt = self.bridge.load_f64(98);
                    if current_rtt == 0.0 {
                        self.bridge.store_f64(98, 50.0);
                        self.bridge.store_f64(99, 1.0);
                    }
                }
            }

            sleep(Duration::from_secs(5)).await;
        }
    }
}

pub fn spawn_latency_monitor(bridge: AtomicSharedMemoryBridge) {
    let use_testnet = std::env::var("USE_TESTNET")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
        || std::env::var("BINANCE_TESTNET")
            .map(|v| v == "true")
            .unwrap_or(false);

    let endpoint: &'static str = if use_testnet {
        "https://testnet.binancefuture.com/fapi/v1/time"
    } else {
        "https://fapi.binance.com/fapi/v1/time"
    };

    println!(
        "[BATBOT_V11][LatencyMonitor] Targeting endpoint: {} (testnet={})",
        endpoint, use_testnet
    );

    tokio::spawn(async move {
        let monitor = LatencyMonitor::new(bridge, Some(endpoint));
        monitor.run_loop().await;
    });
}
