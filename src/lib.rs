#[macro_use]
extern crate napi_derive;

pub mod ai;
pub mod ipc;
pub mod lob;
pub mod oms;
pub mod ws;

use std::sync::{Arc, Mutex, RwLock};
use lazy_static::lazy_static;
use arc_swap::ArcSwapOption;

use ai::{AIEngine, PreflightValidator};
use ipc::bridge::IngestionBridge;
use ipc::shared_memory::AtomicSharedMemoryBridge;
use lob::{LimitOrderBook, LockFreeSpscQueue};
use oms::{BinanceWsConfig, OmsEngine};
use ws::manager::{ConnectionManager, ExchangeType};
use napi::bindgen_prelude::Buffer;
use napi::Error;

lazy_static! {
    static ref GLOBAL_LOB: RwLock<LimitOrderBook> = RwLock::new(LimitOrderBook::new());
    pub static ref GLOBAL_AI_ENGINE: ArcSwapOption<AIEngine> = ArcSwapOption::from(Some(Arc::new(AIEngine::new())));
    pub static ref GLOBAL_SHADOW_ENGINE: ArcSwapOption<Mutex<PreflightValidator>> = ArcSwapOption::from(None);
    pub static ref GLOBAL_OMS_ENGINE: ArcSwapOption<OmsEngine> = ArcSwapOption::from(None);
    static ref GLOBAL_RUNTIME: tokio::runtime::Runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to initialize Tokio runtime for HFT ingestion");
}

#[napi]
pub fn init_core() -> String {
    "BATBOT_V11_CORE_INITIALIZED".to_string()
}

#[napi]
pub fn create_lob_engine() -> bool {
    let mut lob_guard = GLOBAL_LOB.write().unwrap_or_else(|e| e.into_inner());
    *lob_guard = LimitOrderBook::new();
    true
}

#[napi]
pub fn load_ai_model(weights_path: String) -> bool {
    let new_engine = AIEngine::load_from_file(&weights_path);
    let success = new_engine.is_calibrated();
    GLOBAL_AI_ENGINE.store(Some(Arc::new(new_engine)));
    println!(
        "[BATBOT_V11][N-API Lock-Free RCU] Atomic load_ai_model trigger for path '{}'. Status: {}.",
        weights_path,
        if success { "CALIBRATED" } else { "UNCALIBRATED" }
    );
    success
}

#[napi]
pub fn load_ai_model_full(weights_path: String, tkan_path: String) -> bool {
    let new_engine = AIEngine::load_from_paths(&weights_path, &tkan_path);
    let success = new_engine.is_calibrated();
    GLOBAL_AI_ENGINE.store(Some(Arc::new(new_engine)));
    println!(
        "[BATBOT_V11][N-API Lock-Free RCU] Atomic load_ai_model_full trigger for cfc: '{}', tkan: '{}'. Status: {}.",
        weights_path,
        tkan_path,
        if success { "CALIBRATED" } else { "UNCALIBRATED" }
    );
    success
}

#[napi]
pub fn reset_ic_tracker() -> bool {
    if let Some(active_engine) = GLOBAL_AI_ENGINE.load().as_ref() {
        active_engine.reset_ic_tracker();
        println!("[BATBOT_V11][N-API IC Tracker] Reset IC tracking window and cleared drift status.");
        true
    } else {
        false
    }
}

#[napi]
pub fn get_ic_status() -> String {
    if let Some(active_engine) = GLOBAL_AI_ENGINE.load().as_ref() {
        if let Ok(tracker) = active_engine.ic_tracker.lock() {
            format!(
                "{{\"ic\":{:.6},\"is_drifted\":{},\"sample_count\":{}}}",
                tracker.current_ic(),
                tracker.is_drifted(),
                tracker.len()
            )
        } else {
            "{\"ic\":0.0,\"is_drifted\":false,\"sample_count\":0}".to_string()
        }
    } else {
        "{\"ic\":0.0,\"is_drifted\":false,\"sample_count\":0}".to_string()
    }
}

#[napi]
pub fn trigger_preflight_warmup(
    weights_path: String,
    tkan_path: String,
    min_ic: Option<f64>,
    warmup_ticks: Option<u32>,
    testing_ticks: Option<u32>,
) -> bool {
    let candidate = AIEngine::load_from_paths(&weights_path, &tkan_path);
    if let Some(active_engine) = GLOBAL_AI_ENGINE.load().as_ref() {
        candidate.inherit_hidden_state(active_engine);
    }

    let min_ic_val = min_ic.unwrap_or(0.03);
    let warmup_val = warmup_ticks.unwrap_or(256) as u64;
    let testing_val = testing_ticks.unwrap_or(256) as u64;

    let validator = PreflightValidator::new(candidate, warmup_val, testing_val, min_ic_val);
    let initial_phase = validator.phase();
    GLOBAL_SHADOW_ENGINE.store(Some(Arc::new(Mutex::new(validator))));

    println!(
        "[BATBOT_V11][Pre-Flight Shadow Ingestion] Spawned candidate shadow validator for cfc: '{}', tkan: '{}'. Initial Phase: {}",
        weights_path,
        tkan_path,
        initial_phase.as_str()
    );

    initial_phase != ai::PreflightPhase::Failed
}

#[napi]
pub fn get_preflight_status() -> String {
    if let Some(shadow_mutex) = GLOBAL_SHADOW_ENGINE.load().as_ref() {
        if let Ok(validator) = shadow_mutex.try_lock() {
            let m = validator.get_metrics();
            format!(
                "{{\"phase\":\"{}\",\"warmup_completed\":{},\"warmup_target\":{},\"testing_completed\":{},\"testing_target\":{},\"shadow_ic\":{:.4},\"dir_accuracy\":{:.4},\"avg_latency_ns\":{},\"max_latency_ns\":{},\"gate1\":{},\"gate2\":{},\"gate3\":{},\"gate4\":{},\"failure_reason\":{}}}",
                m.current_phase.as_str(),
                m.warmup_ticks_completed,
                m.warmup_ticks_target,
                m.testing_ticks_completed,
                m.testing_ticks_target,
                m.shadow_ic,
                m.directional_accuracy,
                m.avg_latency_ns,
                m.max_latency_ns,
                m.gate1_passed,
                m.gate2_passed,
                m.gate3_passed,
                m.gate4_passed,
                m.failure_reason.map(|r| format!("\"{}\"", r)).unwrap_or_else(|| "null".to_string())
            )
        } else {
            "{\"phase\":\"BUSY_LOCK\"}".to_string()
        }
    } else {
        "{\"phase\":\"UNLOADED\"}".to_string()
    }
}

#[napi]
pub fn start_oms_engine(
    symbol: String,
    initial_balance: Option<f64>,
    api_key: Option<String>,
    api_secret: Option<String>,
    is_testnet: Option<bool>,
) -> bool {
    let balance = initial_balance.unwrap_or(100_000.0);
    let ws_config = if let (Some(key), Some(secret)) = (api_key, api_secret) {
        if !key.is_empty() && !secret.is_empty() {
            Some(BinanceWsConfig {
                api_key: key,
                api_secret: secret,
                is_testnet: is_testnet.unwrap_or(true),
            })
        } else {
            None
        }
    } else {
        None
    };

    let oms = OmsEngine::new(symbol.clone(), balance, None, None, ws_config);
    GLOBAL_OMS_ENGINE.store(Some(Arc::new(oms)));
    println!(
        "[BATBOT_V11][OMS Core] Order Management System initialized for symbol '{}' with balance ${:.2}.",
        symbol, balance
    );
    true
}

#[napi]
pub fn evaluate_oms_tick(sab_buffer: Buffer) -> napi::Result<String> {
    let raw_ptr = sab_buffer.as_ptr() as *mut u8;
    let len = sab_buffer.len();

    let bridge = AtomicSharedMemoryBridge::new(raw_ptr, len)
        .map_err(|err| Error::from_reason(err.to_string()))?;

    if let Some(oms) = GLOBAL_OMS_ENGINE.load().as_ref() {
        if let Some(intent) = oms.evaluate_sab_prediction(&bridge) {
            let json = serde_json::to_string(&intent)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            return Ok(json);
        }
    }

    Ok("null".to_string())
}

#[napi]
pub fn get_oms_metrics() -> String {
    if let Some(oms) = GLOBAL_OMS_ENGINE.load().as_ref() {
        let m = oms.get_metrics();
        serde_json::to_string(&m).unwrap_or_else(|_| "{}".to_string())
    } else {
        "{\"status\":\"UNINITIALIZED\"}".to_string()
    }
}

#[napi]
pub fn get_position_snapshot() -> String {
    if let Some(oms) = GLOBAL_OMS_ENGINE.load().as_ref() {
        let snap = oms.position_ledger().snapshot();
        serde_json::to_string(&snap).unwrap_or_else(|_| "{}".to_string())
    } else {
        "{\"status\":\"UNINITIALIZED\"}".to_string()
    }
}

#[napi]
pub fn start_ingestion(sab_buffer: Buffer) -> napi::Result<bool> {
    let raw_ptr = sab_buffer.as_ptr() as *mut u8;
    let len = sab_buffer.len();

    let atomic_bridge = AtomicSharedMemoryBridge::new(raw_ptr, len)
        .map_err(|err| Error::from_reason(err.to_string()))?;

    let queue = LockFreeSpscQueue::new(4096);
    let bridge = Arc::new(IngestionBridge::new(atomic_bridge));
    let bridge_clone = bridge.clone();
    let queue_consumer = queue.clone();

    // Spawn consumer loop on Tokio runtime
    GLOBAL_RUNTIME.spawn(async move {
        bridge_clone.start_consumer_loop(queue_consumer);
    });

    // Spawn WebSocket Connection Manager on Tokio runtime
    let symbol = std::env::var("SYMBOL").unwrap_or_else(|_| "BTCUSDT".to_string());
    let conn_mgr = Arc::new(ConnectionManager::new(&symbol, ExchangeType::Binance));
    let queue_producer = queue.clone();

    GLOBAL_RUNTIME.spawn(async move {
        println!("[BATBOT_V11] Starting Binance Futures WebSocket Ingestion Stream for {}...", symbol);
        if let Err(e) = conn_mgr.run_rotation_loop(queue_producer).await {
            eprintln!("[BATBOT_V11][WS Manager Error] Rotation loop error: {}", e);
        }
    });

    // Spawn Latency Monitor background task on Tokio runtime
    ai::spawn_latency_monitor(atomic_bridge);

    Ok(true)
}

#[napi]
pub fn get_microstructure_metrics() -> String {
    let lob_guard = GLOBAL_LOB.read().unwrap_or_else(|e| e.into_inner());
    let m = &lob_guard.metrics;
    format!(
        "{{\"obi\":{:.6},\"cvd\":{:.4},\"rv_gk\":{:.6},\"vpin\":{:.4},\"hurst\":{:.4},\"lob_entropy\":{:.4},\"regime\":{},\"is_sweep_detected\":{}}}",
        m.obi, m.cvd, m.rv_gk, m.vpin, m.hurst, m.lob_entropy, m.regime, m.is_sweep_detected
    )
}

#[napi]
pub fn get_dynamic_collars(entry_price: f64, position_side: String) -> String {
    let lob_guard = GLOBAL_LOB.read().unwrap_or_else(|e| e.into_inner());
    let (sl, tp) = lob_guard.calculate_dynamic_collars(entry_price, &position_side);
    format!("{{\"stop_loss\":{:.4},\"take_profit\":{:.4}}}", sl, tp)
}
