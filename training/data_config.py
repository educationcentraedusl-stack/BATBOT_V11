"""
BATBOT_V11 SOTA Data Preparation Configuration
Defines feature schemas, mathematical parameters, and file locations for T-KAN and CfC models.
"""

import os

# Base Directories & Files
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
SIGNALS_PATH = os.path.join(DATA_DIR, "signals.jsonl")
EXECUTIONS_PATH = os.path.join(DATA_DIR, "executions.jsonl")

TKAN_OUT_PATH = os.path.join(DATA_DIR, "tkan_features.safetensors")
CFC_OUT_PATH = os.path.join(DATA_DIR, "cfc_features.safetensors")
STATS_OUT_PATH = os.path.join(DATA_DIR, "feature_stats.json")

# Normalization & Window Settings
WELFORD_WINDOW = 1000       # Rolling window size for online Welford Z-Score
CFC_SEQ_LEN = 32           # Sequence length for CfC continuous-time solver
TRAIN_SPLIT_RATIO = 0.8    # 80/20 non-overlapping chronological split

# T-KAN Spatial Feature Schema (Strictly 40 Dimensions)
TKAN_FEATURE_NAMES = [
    # 1-8: Micro-Price & Spread Metrics
    "spread",
    "relative_spread",
    "micro_price_dev",
    "mid_log_ret_1",
    "mid_log_ret_5",
    "mid_log_ret_10",
    "mid_log_ret_50",
    "mid_log_ret_100",
    # 9-18: Order Book Imbalance & Pressure Dynamics
    "obi_l1",
    "obi_ema_5",
    "obi_ema_10",
    "obi_ema_25",
    "obi_ema_50",
    "obi_ema_100",
    "obi_ema_250",
    "obi_vel_1",
    "obi_vel_5",
    "obi_press_ratio",
    # 19-28: Cumulative Volume Delta & Flow Dynamics
    "cvd_raw",
    "cvd_delta_1",
    "cvd_delta_5",
    "cvd_delta_10",
    "cvd_delta_50",
    "cvd_delta_100",
    "trade_vel",
    "trade_vel_accel",
    "vpin_proxy_10",
    "vpin_proxy_50",
    # 29-34: Telemetry & Microsecond Latency
    "lat_us",
    "lat_us_mean_50",
    "lat_us_std_50",
    "lat_us_jitter",
    "seq_gap",
    "execution_latency_ms",
    # 35-40: Volatility & Regime Indicators
    "vol_realized_10",
    "vol_realized_50",
    "vol_realized_100",
    "vol_parkinson_50",
    "price_acceleration",
    "momentum_direction",
]

# CfC Continuous-Time Feature Schema (Strictly 16 Dimensions)
CFC_FEATURE_NAMES = [
    "mid_log_ret_10",
    "mid_log_ret_50",
    "relative_spread",
    "micro_price_dev",
    "obi_l1",
    "obi_ema_10",
    "obi_ema_50",
    "cvd_delta_10",
    "trade_vel",
    "vpin_proxy_10",
    "lat_us_norm",
    "vol_realized_50",
    "exec_side_flag",
    "order_fill_qty",
    "pnl_realized_trend",
    "delta_tau",
]
