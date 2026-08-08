#[macro_use]
extern crate napi_derive;

pub mod ai;
pub mod ipc;
pub mod lob;
pub mod oms;
pub mod ws;
pub mod risk;
pub mod strategy;

use std::sync::{Arc, Mutex, RwLock};
use lazy_static::lazy_static;
use arc_swap::ArcSwapOption;

use ai::{AIEngine, PreflightValidator};
use ipc::bridge::IngestionBridge;
use ipc::shared_memory::AtomicSharedMemoryBridge;
use lob::{LimitOrderBook, LockFreeSpscQueue};
use oms::{BinanceWsConfig, OmsEngine};
use ws::manager::ConnectionManager;
use risk::CovarianceRiskGuard;
use strategy::MultiAssetSignalEngine;
use napi::bindgen_prelude::Buffer;
use napi::Error;

lazy_static! {
    static ref GLOBAL_LOB: RwLock<LimitOrderBook> = RwLock::new(LimitOrderBook::new());
    pub static ref GLOBAL_AI_ENGINE: ArcSwapOption<AIEngine> = ArcSwapOption::from(Some(Arc::new(AIEngine::new())));
    pub static ref GLOBAL_SHADOW_ENGINE: ArcSwapOption<Mutex<PreflightValidator>> = ArcSwapOption::from(None);
    pub static ref GLOBAL_OMS_ENGINE: ArcSwapOption<OmsEngine> = ArcSwapOption::from(None);
    pub static ref GLOBAL_INGESTION_BRIDGE: ArcSwapOption<IngestionBridge> = ArcSwapOption::from(None);
    pub static ref GLOBAL_COVARIANCE_RISKGUARD: CovarianceRiskGuard = CovarianceRiskGuard::new_arc(None, None);
    pub static ref GLOBAL_MULTI_STRATEGY_ENGINE: MultiAssetSignalEngine = MultiAssetSignalEngine::default();
    pub static ref GLOBAL_MULTI_OMS_ENGINE: ArcSwapOption<oms::MultiAssetOmsEngine> = ArcSwapOption::from(None);
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
                "{{\"ic\":{:.6},\"ewma_ic\":{:.6},\"adaptive_threshold\":{:.6},\"is_drifted\":{},\"sample_count\":{}}}",
                tracker.current_ic(),
                tracker.ewma_ic(),
                tracker.adaptive_threshold(),
                tracker.is_drifted(),
                tracker.len()
            )
        } else {
            "{\"ic\":0.0,\"ewma_ic\":0.0,\"adaptive_threshold\":0.01,\"is_drifted\":false,\"sample_count\":0}".to_string()
        }
    } else {
        "{\"ic\":0.0,\"ewma_ic\":0.0,\"adaptive_threshold\":0.01,\"is_drifted\":false,\"sample_count\":0}".to_string()
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
    GLOBAL_INGESTION_BRIDGE.store(Some(bridge.clone()));

    let bridge_clone = bridge.clone();
    let queue_consumer = queue.clone();

    // Spawn consumer loop on Tokio runtime
    GLOBAL_RUNTIME.spawn(async move {
        bridge_clone.start_consumer_loop(queue_consumer);
    });

    // Spawn WebSocket Connection Manager on Tokio runtime
    let symbol = std::env::var("SYMBOL").unwrap_or_else(|_| "BTCUSDT".to_string());
    let conn_mgr = Arc::new(ConnectionManager::new(&symbol));
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

#[napi]
pub fn calculate_cs_lvr_score_napi(
    symbol: String,
    high: f64,
    low: f64,
    open: f64,
    close: f64,
    volume_usd_5m: f64,
    best_bid: f64,
    best_ask: f64,
    price_change_5m: f64,
    volume_5m: f64,
) -> f64 {
    let metrics = lob::AltcoinMetrics {
        symbol,
        high,
        low,
        open,
        close,
        volume_usd_5m,
        best_bid,
        best_ask,
        price_change_5m,
        volume_5m,
        correlation_risk: 0.0,
    };
    lob::calculate_cs_lvr_score(&metrics)
}

#[napi]
pub struct NativeUniverseScanner {
    inner: lob::UniverseScanner,
}

#[napi]
impl NativeUniverseScanner {
    #[napi(constructor)]
    pub fn new(max_active_assets: u32) -> Self {
        Self {
            inner: lob::UniverseScanner::new(max_active_assets as usize),
        }
    }

    #[napi]
    pub fn update_ticker(
        &mut self,
        symbol: String,
        high: f64,
        low: f64,
        open: f64,
        close: f64,
        volume_usd_5m: f64,
        best_bid: f64,
        best_ask: f64,
        price_change_5m: f64,
        volume_5m: f64,
    ) {
        self.inner.update_ticker(
            &symbol,
            high,
            low,
            open,
            close,
            volume_usd_5m,
            best_bid,
            best_ask,
            price_change_5m,
            volume_5m,
            0.0,
        );
    }

    #[napi]
    pub fn rank_universe(&mut self) -> String {
        let scores = self.inner.rank_universe();
        serde_json::to_string(&scores).unwrap_or_else(|_| "[]".to_string())
    }

    #[napi]
    pub fn get_top_k(&mut self) -> Vec<String> {
        self.inner.get_top_k()
    }
}

#[napi]
pub struct NativeMultiStreamManager {
    inner: Arc<ws::manager::MultiStreamManager>,
    wired_slots: Arc<Mutex<Vec<bool>>>,
}

#[napi]
impl NativeMultiStreamManager {
    #[napi(constructor)]
    pub fn new(max_active_assets: u32) -> Self {
        let manager = Arc::new(ws::manager::MultiStreamManager::new(
            max_active_assets as usize,
        ));
        let num_slots = manager.max_active_assets();
        let wired_slots = Arc::new(Mutex::new(vec![false; num_slots]));

        let mgr = Self {
            inner: manager,
            wired_slots,
        };

        mgr.ensure_consumer_loops_wired();
        mgr
    }

    fn ensure_consumer_loops_wired(&self) {
        if let Some(bridge) = GLOBAL_INGESTION_BRIDGE.load().as_ref() {
            let mut wired = self.wired_slots.lock().unwrap_or_else(|e| e.into_inner());
            for slot in 0..self.inner.max_active_assets() {
                if slot < wired.len() && !wired[slot] {
                    if let Some(q) = self.inner.queue_at(slot) {
                        bridge.start_consumer_loop_asset(q, slot);
                        wired[slot] = true;
                    }
                }
            }
        }
    }

    #[napi]
    pub fn active_symbols(&self) -> Vec<String> {
        self.inner.active_symbols()
    }

    #[napi]
    pub async fn update_subscriptions(&self, new_top_k: Vec<String>) -> napi::Result<Vec<String>> {
        self.ensure_consumer_loops_wired();
        self.inner
            .update_subscriptions(&new_top_k)
            .await
            .map_err(|e| Error::from_reason(e))
    }

    #[napi]
    pub fn stop_all(&self) {
        self.inner.stop_all();
    }
}

#[napi]
pub fn update_asset_return_napi(asset_idx: u32, return_val: f64) -> bool {
    GLOBAL_COVARIANCE_RISKGUARD.update_single_asset_return(asset_idx as usize, return_val);
    true
}

#[napi]
pub fn get_covariance_matrix_napi() -> String {
    let snap = GLOBAL_COVARIANCE_RISKGUARD.snapshot();
    serde_json::to_string(&snap.covariance_matrix).unwrap_or_else(|_| "[]".to_string())
}

#[napi]
pub fn get_correlation_matrix_napi() -> String {
    let snap = GLOBAL_COVARIANCE_RISKGUARD.snapshot();
    serde_json::to_string(&snap.correlation_matrix).unwrap_or_else(|_| "[]".to_string())
}

#[napi]
pub fn calculate_cc_dfk_size_napi(
    asset_idx: u32,
    expected_return: f64,
    gk_vol: f64,
    bid_ask_spread_bp: f64,
    account_balance: f64,
    current_price: f64,
    active_weights_json: Option<String>,
) -> String {
    let mut weights = [0.0; 10];
    if let Some(json_str) = active_weights_json {
        if let Ok(parsed) = serde_json::from_str::<Vec<f64>>(&json_str) {
            for (i, w) in parsed.iter().enumerate().take(10) {
                weights[i] = *w;
            }
        }
    }
    let res = GLOBAL_COVARIANCE_RISKGUARD.calculate_cc_dfk_size(
        asset_idx as usize,
        expected_return,
        gk_vol,
        bid_ask_spread_bp,
        account_balance,
        current_price,
        &weights,
    );
    serde_json::to_string(&res).unwrap_or_else(|_| "{}".to_string())
}

#[napi]
pub fn get_multi_asset_collars_napi(entry_price: f64, gk_vol: f64, is_long: bool) -> String {
    let (sl, tp) = GLOBAL_COVARIANCE_RISKGUARD.calculate_dynamic_collars(entry_price, gk_vol, is_long);
    format!("{{\"stop_loss\":{:.4},\"take_profit\":{:.4}}}", sl, tp)
}

#[napi]
pub fn evaluate_multi_asset_signals_napi(
    sab_buffer: Buffer,
    active_symbols_json: String,
) -> napi::Result<String> {
    let raw_ptr = sab_buffer.as_ptr() as *mut u8;
    let len = sab_buffer.len();

    let bridge = AtomicSharedMemoryBridge::new(raw_ptr, len)
        .map_err(|err| Error::from_reason(err.to_string()))?;

    let mut symbols = [String::new(), String::new(), String::new(), String::new(), String::new(),
                       String::new(), String::new(), String::new(), String::new(), String::new()];

    if let Ok(parsed_syms) = serde_json::from_str::<Vec<String>>(&active_symbols_json) {
        for (i, s) in parsed_syms.iter().enumerate().take(10) {
            symbols[i] = s.clone();
        }
    }

    let res = GLOBAL_MULTI_STRATEGY_ENGINE.evaluate_sab_matrix(&bridge, &symbols);
    let json = serde_json::to_string(&res).map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(json)
}

#[napi]
pub fn start_multi_asset_oms_napi(
    initial_balance_usd: f64,
    symbols_json: Option<String>,
) -> bool {
    let mut symbols = vec![
        "ETHUSDT".to_string(),
        "SOLUSDT".to_string(),
        "BNBUSDT".to_string(),
        "XRPUSDT".to_string(),
        "ADAUSDT".to_string(),
        "DOGEUSDT".to_string(),
        "AVAXUSDT".to_string(),
        "LINKUSDT".to_string(),
        "SUIUSDT".to_string(),
        "NEARUSDT".to_string(),
    ];
    if let Some(json_str) = symbols_json {
        if let Ok(parsed) = serde_json::from_str::<Vec<String>>(&json_str) {
            if !parsed.is_empty() {
                symbols = parsed;
            }
        }
    }
    let engine = oms::MultiAssetOmsEngine::new(symbols.len(), initial_balance_usd, symbols, None);
    GLOBAL_MULTI_OMS_ENGINE.store(Some(Arc::new(engine)));
    true
}

#[napi]
pub fn submit_multi_asset_intent_napi(
    asset_idx: u32,
    intent_json: String,
    mid_price: f64,
    top5_depth_usd: f64,
    step_size: f64,
    tick_size: f64,
    portfolio_leverage: f64,
    avg_correlation: f64,
) -> napi::Result<String> {
    if let Some(engine) = GLOBAL_MULTI_OMS_ENGINE.load().as_ref() {
        let mut intent: oms::OrderIntent = serde_json::from_str(&intent_json)
            .map_err(|e| Error::from_reason(format!("Invalid intent JSON: {}", e)))?;
        intent.asset_idx = asset_idx as usize;

        match engine.submit_intent(
            intent,
            mid_price,
            top5_depth_usd,
            step_size,
            tick_size,
            portfolio_leverage,
            avg_correlation,
        ) {
            Ok(slices) => {
                let res_json = serde_json::to_string(&slices)
                    .map_err(|e| Error::from_reason(e.to_string()))?;
                Ok(res_json)
            }
            Err(reason) => Ok(format!(
                "{{\"status\":\"REJECTED\",\"reason\":\"{}\"}}",
                reason.as_str()
            )),
        }
    } else {
        Err(Error::from_reason("MultiAssetOmsEngine not initialized"))
    }
}

#[napi]
pub fn apply_multi_asset_fill_napi(report_json: String) -> bool {
    if let Some(engine) = GLOBAL_MULTI_OMS_ENGINE.load().as_ref() {
        if let Ok(report) = serde_json::from_str::<oms::ExecutionReport>(&report_json) {
            engine.apply_fill(report);
            true
        } else {
            false
        }
    } else {
        false
    }
}

#[napi]
pub fn get_multi_asset_oms_metrics_napi(asset_idx: u32) -> String {
    if let Some(engine) = GLOBAL_MULTI_OMS_ENGINE.load().as_ref() {
        let metrics = engine.get_metrics(asset_idx as usize);
        serde_json::to_string(&metrics).unwrap_or_else(|_| "{}".to_string())
    } else {
        "{}".to_string()
    }
}

#[napi]
pub fn pop_next_intent_packet_napi() -> Option<String> {
    if let Some(engine) = GLOBAL_MULTI_OMS_ENGINE.load().as_ref() {
        if let Some(pkt) = engine.intent_queue().pop() {
            let intent = pkt.to_intent();
            serde_json::to_string(&intent).ok()
        } else {
            None
        }
    } else {
        None
    }
}

#[napi]
pub fn sync_multi_oms_sab_napi(sab_buffer: Buffer) -> bool {
    if let Some(engine) = GLOBAL_MULTI_OMS_ENGINE.load().as_ref() {
        let raw_ptr = sab_buffer.as_ptr() as *mut u8;
        let len = sab_buffer.len();
        if let Ok(bridge) = AtomicSharedMemoryBridge::new(raw_ptr, len) {
            engine.sync_sab_slots(&bridge);
            true
        } else {
            false
        }
    } else {
        false
    }
}




