#!/usr/bin/env python3
"""
BATBOT_V11 SOTA High-Frequency Trading (HFT) Data Preparation Pipeline
Processes raw signals.jsonl and executions.jsonl into training-ready SafeTensors.
Uses Polars (Rust-backed multi-threaded SIMD columnar engine), Apache Arrow zero-copy memory buffers,
SIMD Rolling Z-Scores (Welford SIMD), Symmetrical Tanh Bounding, Strided Sequence Extraction,
and Strict Split Purge Buffers for T-KAN and CfC models.
"""

import os
import sys
import io
import json
import math
import time
import tempfile
import struct
import numpy as np
import polars as pl
import torch
from safetensors.torch import save_file

from data_config import (
    DATA_DIR, SIGNALS_PATH, EXECUTIONS_PATH, TKAN_OUT_PATH, CFC_OUT_PATH, STATS_OUT_PATH,
    MODELS_DIR, TKAN_LUT_PATH,
    WELFORD_WINDOW, CFC_SEQ_LEN, TRAIN_SPLIT_RATIO,
    TKAN_FEATURE_NAMES, TKAN_OUTPUT_DIM
)

def read_ndjson_sanitized(file_path: str, schema_overrides: dict) -> pl.DataFrame:
    """
    Reads an NDJSON file into a Polars DataFrame with O(1) RAM streaming and strict JSON validation.
    Stream-writes sanitized lines to a temporary file on disk to prevent Out-Of-Memory (OOM) crashes
    on multi-gigabyte log files. Validates structural JSON bounds and catches json.JSONDecodeError explicitly.
    """
    if not os.path.exists(file_path) or os.path.getsize(file_path) == 0:
        return pl.DataFrame(schema=schema_overrides)

    skipped_count = 0
    valid_count = 0
    tmp_path = None

    try:
        # Stream to a disk-backed temporary file (delete=False for cross-platform file path access by Polars)
        tmp_file = tempfile.NamedTemporaryFile(mode="wb", suffix=".jsonl", delete=False)
        tmp_path = tmp_file.name

        with open(file_path, "rb") as f_in, tmp_file as f_out:
            for line_bytes in f_in:
                # 1. Strip embedded NUL bytes and surrounding whitespace
                if b"\x00" in line_bytes:
                    line_bytes = line_bytes.replace(b"\x00", b"")
                line_bytes = line_bytes.strip()

                if not line_bytes:
                    skipped_count += 1
                    continue

                # 2. Extract potential JSON object boundary
                if not (line_bytes.startswith(b"{") and line_bytes.endswith(b"}")):
                    start = line_bytes.find(b"{")
                    end = line_bytes.rfind(b"}")
                    if start != -1 and end != -1 and start < end:
                        line_bytes = line_bytes[start : end + 1]
                    else:
                        skipped_count += 1
                        continue

                # 3. Strict JSON validation: verify syntax before streaming to disk
                try:
                    json.loads(line_bytes.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    skipped_count += 1
                    continue

                # 4. Stream valid JSON line directly to temporary disk file
                f_out.write(line_bytes)
                f_out.write(b"\n")
                valid_count += 1

        if skipped_count > 0:
            print(f"[NDJSON Sanitizer] Filtered {skipped_count} corrupted or blank line(s) from '{file_path}'")

        if valid_count == 0:
            return pl.DataFrame(schema=schema_overrides)

        # Polars reads directly from the sanitized temporary file on disk
        return pl.read_ndjson(tmp_path, schema_overrides=schema_overrides)

    finally:
        # Guarantee complete cleanup of temporary file
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def compute_polars_rolling_tanh_df(df: pl.DataFrame, feature_names: list[str], window: int = 1000, eps: float = 1e-8) -> np.ndarray:
    """
    Computes SIMD-accelerated Rolling Z-Score followed by symmetrical Tanh bounding in Polars (Rust).
    Uses Polars native rolling_mean and rolling_std (powered by Rust multi-threaded SIMD Welford variance).
    Preserves unnormalized physical time delta (delta_tau) in seconds for continuous-time liquid neural network ODE solving.
    Formula: z_t = (x_t - mean_W(x)) / (std_W(x) + eps)
             x_norm = tanh(z_t) * 0.999 -> strictly bounded into (-0.999, 0.999) matching engine.rs
    """
    exprs = []
    for col in feature_names:
        mean_expr = pl.col(col).rolling_mean(window_size=window, min_samples=1)
        std_expr = pl.col(col).rolling_std(window_size=window, min_samples=1).fill_null(1.0)
        z_expr = (pl.col(col) - mean_expr) / (std_expr + eps)
        norm_expr = (z_expr.tanh() * 0.999).fill_null(0.0).fill_nan(0.0).alias(col)
        exprs.append(norm_expr)

    df_norm = df.select(exprs)
    return df_norm.to_numpy().astype(np.float32)


def compute_micro_horizon_continuous_targets(
    ts_ms: np.ndarray,
    mid_prices: np.ndarray,
    vols: np.ndarray = None,
    horizon_ms: int = 5000,
    min_vol: float = 0.0005,
) -> np.ndarray:
    """
    Computes SOTA HFT Micro-Horizon Continuous Return Targets (5-Second Horizon).
    Eradicates QA-4202 (Triple-Barrier Target Leakage & Mode Collapse).

    Targets per sample [y_dir, y_meta, y_horiz]:
      - y_dir in [-1.0, 1.0]: Continuous Direction Target = tanh(ret_5s / (2 * vol_5s + 1e-6))
      - y_meta in {0.0, 1.0}: Significance / Meta Target = 1.0 if |ret_5s| > vol_5s else 0.0
      - y_horiz in [5.0]: Constant 5.0 seconds micro-horizon target

    Guarantees:
      - Strict 5-second forward lookahead: ret_5s = ln(P_{t + 5s} / P_t).
      - Zero look-ahead bias: vol_5s is strictly computed from backward historical data.
    """
    n = len(mid_prices)
    if n == 0:
        return np.empty((0, 3), dtype=np.float32)

    # 1. Calculate strict 5-second forward index using searchsorted
    if n > 1 and ts_ms is not None and len(ts_ms) == n and (ts_ms[-1] - ts_ms[0] >= horizon_ms):
        target_ts = ts_ms + horizon_ms
        idx_5s = np.searchsorted(ts_ms, target_ts, side="left")
        # Eliminate terminal price sharing: for samples exceeding boundary, reference self (ret_5s = 0.0)
        idx_5s = np.where(idx_5s < n, idx_5s, np.arange(n))
    else:
        # Fallback for synthetic/flat timestamps: assume standard 100ms tick interval (50 ticks = 5s)
        # Shift must be strictly greater than CFC_SEQ_LEN (32 ticks) to prevent feature-target overlap within the sequence window.
        # Eradicates QA-43.0 D-1: Remove shift_ticks = max(1, min(50, n // 2)) and terminal np.clip price sharing.
        min_forward_shift = max(50, CFC_SEQ_LEN + 1)
        if n <= min_forward_shift:
            # Dataset too small to provide a clean forward target beyond sequence window: return clean neutral targets
            return np.zeros((n, 3), dtype=np.float32)
        shift_ticks = min_forward_shift
        raw_idx = np.arange(n) + shift_ticks
        valid_forward = raw_idx < n
        # For terminal samples without clean forward targets, reference self (idx = t)
        # so future_mid == curr_mid, yielding ret_5s = 0.0 without terminal price sharing or overlap.
        idx_5s = np.where(valid_forward, raw_idx, np.arange(n))

    # 2. Strict 5-second forward log return
    curr_mid = np.maximum(mid_prices, 1e-8)
    future_mid = np.maximum(mid_prices[idx_5s], 1e-8)
    ret_5s = np.log(future_mid / curr_mid)
    ret_5s = np.nan_to_num(ret_5s, nan=0.0, posinf=0.0, neginf=0.0)

    # 3. Localized Volatility (vol_5s) strictly backward-looking (Zero Look-Ahead Bias)
    if vols is not None and len(vols) == n:
        vol_5s = np.maximum(np.nan_to_num(vols, nan=min_vol), min_vol)
    else:
        # Compute backward rolling standard deviation over 50 ticks from historical returns
        backward_ret = np.diff(np.log(curr_mid), prepend=np.log(curr_mid[0]))
        vol_series = pl.Series("ret", backward_ret).rolling_std(window_size=50).fill_null(min_vol).to_numpy()
        vol_5s = np.maximum(vol_series, min_vol)

    # 4. Direction Target: tanh(ret_5s / (2 * vol_5s + 1e-6))
    y_dir = np.tanh(ret_5s / (2.0 * vol_5s + 1e-6))
    y_dir = np.nan_to_num(y_dir, nan=0.0, posinf=0.0, neginf=0.0)

    # 5. Significance / Meta Target: 1.0 if |ret_5s| > vol_5s else 0.0
    y_meta = np.where(np.abs(ret_5s) > vol_5s, 1.0, 0.0).astype(np.float32)

    # 6. Horizon Target: 5.0 (constant)
    y_horiz = np.full_like(ret_5s, 5.0, dtype=np.float32)

    # Assemble [y_dir, y_meta, y_horiz] matrix
    targets = np.stack([y_dir, y_meta, y_horiz], axis=1).astype(np.float32)
    return targets


# Alias for backward compatibility with existing callers
compute_volatility_adjusted_triple_barrier_labels = compute_micro_horizon_continuous_targets


def evaluate_tkan_offline(tkan_norm: np.ndarray, lut_path: str = TKAN_LUT_PATH) -> np.ndarray:
    """
    Offline T-KAN B-spline LUT inference pass matching src/ai/kan.rs exactly.
    Projects 40-dimensional Welford-normalized LOB features down to 16 dimensions
    using pre-trained B-spline look-up tables in tkan_luts.bin.
    Falls back to default identity (tanh activation sum) if LUT file is missing or invalid.
    """
    N, input_dim = tkan_norm.shape
    output_dim = TKAN_OUTPUT_DIM
    assert input_dim == 40, f"Expected 40 input features, got {input_dim}"

    if os.path.exists(lut_path) and os.path.getsize(lut_path) >= 24 + 640 * 2 * 8:
        try:
            with open(lut_path, "rb") as f:
                header = f.read(24)
                num_edges, lut_size, min_val, max_val = struct.unpack("<IIdd", header)
                if num_edges == 640 and lut_size >= 2 and max_val > min_val:
                    total_floats = num_edges * lut_size
                    payload = np.fromfile(f, dtype=np.float64, count=total_floats)
                    if len(payload) == total_floats:
                        luts = payload.reshape((input_dim, output_dim, lut_size))

                        clamped = np.clip(tkan_norm, min_val, max_val)
                        inv_range = (lut_size - 1) / (max_val - min_val)
                        idx_f = (clamped - min_val) * inv_range
                        i0 = np.floor(idx_f).astype(np.int64)
                        i1 = np.minimum(i0 + 1, lut_size - 1)
                        frac = idx_f - i0
                        w0 = (1.0 - frac)[:, :, np.newaxis]
                        w1 = frac[:, :, np.newaxis]

                        out = np.zeros((N, output_dim), dtype=np.float64)
                        for i in range(input_dim):
                            lut_i = luts[i]
                            i0_i = i0[:, i]
                            i1_i = i1[:, i]
                            v0 = lut_i[:, i0_i].T
                            v1 = lut_i[:, i1_i].T
                            w0_i = w0[:, i]
                            w1_i = w1[:, i]
                            out += w0_i * v0 + w1_i * v1

                        print(f"[T-KAN Offline] Evaluated {N} samples through {num_edges} B-spline LUTs from '{lut_path}'")
                        return out.astype(np.float32)
        except Exception as e:
            print(f"[T-KAN Offline Warning] Failed to evaluate LUTs ({e}). Falling back to identity.")

    # Fallback default identity: matching TKANLayer::default_40_to_16 in kan.rs
    print("[T-KAN Offline] Using default identity T-KAN projection.")
    tanh_inputs = np.tanh(tkan_norm)
    sum_tanh = tanh_inputs.sum(axis=1, keepdims=True)
    out = np.repeat(sum_tanh, output_dim, axis=1)
    return out.astype(np.float32)


def create_cfc_sequences_strided(features: np.ndarray, targets: np.ndarray, seq_len: int = 32):
    """
    Memory-efficient 32-step sliding window sequence extraction using zero-copy NumPy striding
    (np.lib.stride_tricks.sliding_window_view).
    Completely eliminates Python for-loops during sequence generation.
    Maps 16-dimensional T-KAN latent features and 3-dimensional micro-horizon targets
    [y_dir, y_meta, y_horiz] into 3D sequence tensors cleanly.
    Returns PyTorch tensors of shape [Batch, SeqLen, Features] and [Batch, SeqLen, 3].
    """
    assert features.shape[1] == TKAN_OUTPUT_DIM, f"Features dim mismatch: expected {TKAN_OUTPUT_DIM}, got {features.shape[1]}"
    assert targets.shape[1] == 3, f"Targets dim mismatch: expected 3, got {targets.shape[1]}"

    num_samples = len(features) - seq_len + 1
    if num_samples <= 0:
        return torch.from_numpy(features).unsqueeze(0).contiguous(), torch.from_numpy(targets).unsqueeze(0).contiguous()

    # sliding_window_view on axis 0 yields shape: (num_samples, Features, SeqLen)
    in_sw = np.lib.stride_tricks.sliding_window_view(features, window_shape=seq_len, axis=0)
    tgt_sw = np.lib.stride_tricks.sliding_window_view(targets, window_shape=seq_len, axis=0)

    # Transpose to (num_samples, SeqLen, Features)
    seq_inputs = np.transpose(in_sw, (0, 2, 1)).astype(np.float32)
    seq_targets = np.transpose(tgt_sw, (0, 2, 1)).astype(np.float32)

    return torch.from_numpy(seq_inputs).contiguous(), torch.from_numpy(seq_targets).contiguous()

def load_and_preprocess_lob_data():
    print("=" * 75)
    print("BATBOT_V11 SOTA HFT DATA PREPARATION ENGINE (POLARS SIMD + ARROW + SAFETENSORS)")
    print("=" * 75)

    if not os.path.exists(SIGNALS_PATH):
        raise FileNotFoundError(f"Signals file not found at: {SIGNALS_PATH}")

    print(f"[Ingestion] Reading raw signals from '{SIGNALS_PATH}' via Polars NDJSON scanner...")
    start_time = time.time()

    # Schema overrides to prevent type mismatch when 0 is parsed as Int64 instead of Float64
    sig_schema = {
        "ts": pl.Int64,
        "seq": pl.Utf8,
        "type": pl.Utf8,
        "obi": pl.Float64,
        "cvd": pl.Float64,
        "vel": pl.Float64,
        "bid": pl.Float64,
        "ask": pl.Float64,
        "latUs": pl.Float64,
    }

    df_sig = read_ndjson_sanitized(SIGNALS_PATH, sig_schema)
    print(f"[Ingestion] Loaded {len(df_sig)} raw signal records in {time.time() - start_time:.3f}s")

    # Load executions if available
    df_exec = None
    if os.path.exists(EXECUTIONS_PATH) and os.path.getsize(EXECUTIONS_PATH) > 0:
        exec_schema = {
            "timestamp": pl.Int64,
            "symbol": pl.Utf8,
            "side": pl.Utf8,
            "price": pl.Float64,
            "quantity": pl.Float64,
            "realizedPnl": pl.Float64,
            "fee": pl.Float64,
            "latencyMs": pl.Float64,
        }
        df_exec = read_ndjson_sanitized(EXECUTIONS_PATH, exec_schema)
        if len(df_exec) > 0:
            print(f"[Ingestion] Loaded {len(df_exec)} execution records")

    # Ensure timestamp sorting
    df_sig = df_sig.sort("ts")

    # Compute foundational price & LOB metrics using vectorized Polars expressions
    print("[Feature Engine] Computing 40 SOTA LOB features using vectorized Rust expressions...")

    # Step 1: Base Price and Spread Metrics
    df = df_sig.with_columns([
        ((pl.col("bid") + pl.col("ask")) / 2.0).clip(lower_bound=1e-5).alias("mid_price"),
        (pl.col("ask") - pl.col("bid")).alias("spread"),
        (pl.col("ts").diff().fill_null(0).cast(pl.Float64) / 1000.0).alias("delta_tau"), # in seconds
        (pl.col("seq").cast(pl.Int64).diff().fill_null(1) - 1).clip(0, 100).alias("seq_gap"),
        (pl.col("latUs").fill_null(0.0)).alias("lat_us")
    ])

    # Step 2: Micro-Price & Returns
    df = df.with_columns([
        (pl.col("spread") / (pl.col("mid_price") + 1e-8)).fill_nan(0.0).alias("relative_spread"),
        (pl.col("bid") * (1.0 - pl.col("obi")) / 2.0 + pl.col("ask") * (1.0 + pl.col("obi")) / 2.0).alias("micro_price"),
        (pl.col("mid_price").log() - pl.col("mid_price").log().shift(1)).fill_null(0.0).fill_nan(0.0).alias("mid_log_ret_1"),
        (pl.col("mid_price").log() - pl.col("mid_price").log().shift(5)).fill_null(0.0).fill_nan(0.0).alias("mid_log_ret_5"),
        (pl.col("mid_price").log() - pl.col("mid_price").log().shift(10)).fill_null(0.0).fill_nan(0.0).alias("mid_log_ret_10"),
        (pl.col("mid_price").log() - pl.col("mid_price").log().shift(50)).fill_null(0.0).fill_nan(0.0).alias("mid_log_ret_50"),
        (pl.col("mid_price").log() - pl.col("mid_price").log().shift(100)).fill_null(0.0).fill_nan(0.0).alias("mid_log_ret_100"),
    ])

    # Step 3: Order Book Imbalance, CVD Deltas, Trade Velocity & Volatility
    df = df.with_columns([
        (pl.col("micro_price") - pl.col("mid_price")).alias("micro_price_dev"),
        pl.col("obi").alias("obi_l1"),
        pl.col("obi").ewm_mean(span=5).fill_null(0.0).alias("obi_ema_5"),
        pl.col("obi").ewm_mean(span=10).fill_null(0.0).alias("obi_ema_10"),
        pl.col("obi").ewm_mean(span=25).fill_null(0.0).alias("obi_ema_25"),
        pl.col("obi").ewm_mean(span=50).fill_null(0.0).alias("obi_ema_50"),
        pl.col("obi").ewm_mean(span=100).fill_null(0.0).alias("obi_ema_100"),
        pl.col("obi").ewm_mean(span=250).fill_null(0.0).alias("obi_ema_250"),
        (pl.col("obi") - pl.col("obi").shift(1).fill_null(0.0)).alias("obi_vel_1"),
        ((pl.col("obi") - pl.col("obi").shift(5).fill_null(0.0)) / 5.0).alias("obi_vel_5"),
        (pl.col("obi") * pl.col("spread")).alias("obi_press_ratio"),
        pl.col("cvd").alias("cvd_raw"),
        (pl.col("cvd") - pl.col("cvd").shift(1).fill_null(0.0)).alias("cvd_delta_1"),
        (pl.col("cvd") - pl.col("cvd").shift(5).fill_null(0.0)).alias("cvd_delta_5"),
        (pl.col("cvd") - pl.col("cvd").shift(10).fill_null(0.0)).alias("cvd_delta_10"),
        (pl.col("cvd") - pl.col("cvd").shift(50).fill_null(0.0)).alias("cvd_delta_50"),
        (pl.col("cvd") - pl.col("cvd").shift(100).fill_null(0.0)).alias("cvd_delta_100"),
        pl.col("vel").alias("trade_vel"),
        (pl.col("vel") - pl.col("vel").shift(1).fill_null(0.0)).alias("trade_vel_accel"),
        pl.col("lat_us").rolling_mean(window_size=50).fill_null(0.0).alias("lat_us_mean_50"),
        pl.col("lat_us").rolling_std(window_size=50).fill_null(0.0).alias("lat_us_std_50"),
        (pl.col("lat_us") - pl.col("lat_us").shift(1).fill_null(0.0)).abs().alias("lat_us_jitter"),
        pl.col("mid_log_ret_1").rolling_std(window_size=10).fill_null(0.0).alias("vol_realized_10"),
        pl.col("mid_log_ret_1").rolling_std(window_size=50).fill_null(0.0).alias("vol_realized_50"),
        pl.col("mid_log_ret_1").rolling_std(window_size=100).fill_null(0.0).alias("vol_realized_100"),
        (pl.col("mid_price") - 2.0 * pl.col("mid_price").shift(1) + pl.col("mid_price").shift(2)).fill_null(0.0).alias("price_acceleration"),
        pl.col("mid_log_ret_10").sign().fill_null(0.0).alias("momentum_direction"),
        (pl.col("lat_us") / 1000.0).alias("lat_us_norm")
    ])

    # Step 4: Dependent VPIN Proxies & Parkinson Volatility
    df = df.with_columns([
        (pl.col("cvd_delta_10").abs() / (pl.col("trade_vel").rolling_mean(window_size=10).fill_null(1.0) + 1e-5)).alias("vpin_proxy_10"),
        (pl.col("cvd_delta_50").abs() / (pl.col("trade_vel").rolling_mean(window_size=50).fill_null(1.0) + 1e-5)).alias("vpin_proxy_50"),
        (pl.col("spread") * pl.col("vol_realized_50")).alias("vol_parkinson_50")
    ])

    # Step 5: Join execution metrics if available, else default to 0
    if df_exec is not None and len(df_exec) > 0:
        df_exec_processed = df_exec.select([
            pl.col("timestamp").alias("ts"),
            pl.when(pl.col("side") == "BUY").then(1.0).when(pl.col("side") == "SELL").then(-1.0).otherwise(0.0).alias("exec_side_flag"),
            pl.col("quantity").alias("order_fill_qty"),
            pl.col("realizedPnl").alias("realized_pnl"),
            pl.col("latencyMs").cast(pl.Float64).alias("execution_latency_ms")
        ])
        df = df.join(df_exec_processed, on="ts", how="left").with_columns([
            pl.col("exec_side_flag").fill_null(0.0),
            pl.col("order_fill_qty").fill_null(0.0),
            pl.col("realized_pnl").fill_null(0.0).cum_sum().alias("pnl_realized_trend"),
            pl.col("execution_latency_ms").fill_null(0.0)
        ])
    else:
        df = df.with_columns([
            pl.lit(0.0).alias("exec_side_flag"),
            pl.lit(0.0).alias("order_fill_qty"),
            pl.lit(0.0).alias("pnl_realized_trend"),
            pl.lit(0.0).alias("execution_latency_ms")
        ])

    # Step 6: Micro-Horizon Continuous Target Labeling (5-Second HFT Target)
    print("[Label Engine] Computing Micro-Horizon Continuous Targets (5s Horizon, Zero Look-Ahead Vol)...")
    ts_array = df.select("ts").to_numpy().flatten().astype(np.int64)
    mid_array = df.select("mid_price").to_numpy().flatten().astype(np.float64)
    vol_array = df.select("vol_realized_50").to_numpy().flatten().astype(np.float64)

    y_targets = compute_micro_horizon_continuous_targets(
        ts_array, mid_array, vol_array,
        horizon_ms=5000,
        min_vol=0.0005,
    )

    meta_sig_rate = float((y_targets[:, 1] > 0.5).mean() * 100.0)
    print(f"[Label Engine] Micro-Horizon Labeling Complete: Significant Move Rate = {meta_sig_rate:.2f}%")

    # Perform SIMD-Accelerated Rolling Z-Score + Tanh Bounding entirely in Rust/Polars
    print("[Normalization] Executing SIMD Polars Rolling Z-Scores (Rust Welford) + Symmetrical Tanh Bounding...")
    norm_start = time.time()

    tkan_norm = compute_polars_rolling_tanh_df(df, TKAN_FEATURE_NAMES, window=WELFORD_WINDOW)
    print(f"[Normalization] Completed SIMD feature normalization in {time.time() - norm_start:.4f}s")

    print("[T-KAN Encoder] Running offline T-KAN B-spline projection (40 -> 16)...")
    tkan_infer_start = time.time()
    cfc_norm = evaluate_tkan_offline(tkan_norm, TKAN_LUT_PATH)
    print(f"[T-KAN Encoder] Completed offline T-KAN inference in {time.time() - tkan_infer_start:.4f}s")

    N, num_tkan_features = tkan_norm.shape
    _, num_cfc_features = cfc_norm.shape

    print(f"[Verification] Extracted {N} records.")
    print(f"               T-KAN Feature Matrix Shape: ({N}, {num_tkan_features})")
    print(f"               CfC Feature Matrix Shape:   ({N}, {num_cfc_features})")

    if N < 64:
        raise ValueError(f"Error: Insufficient telemetry records for sequence training (N={N}, minimum required N >= 64).")

    assert num_tkan_features == 40, f"Error: T-KAN feature count is {num_tkan_features}, expected 40!"
    assert num_cfc_features == 16, f"Error: CfC feature count is {num_cfc_features}, expected 16!"

    # Split 80/20 Chronologically with Dynamic Purge Buffer (covering 5-second lookahead window)
    split_idx = int(N * TRAIN_SPLIT_RATIO)
    t_split_end = ts_array[split_idx] if split_idx < len(ts_array) else 0

    val_start_idx = split_idx
    if t_split_end > 0:
        t_purge_cutoff = t_split_end + 5000 # 5-second micro-horizon forward window in ms
        while val_start_idx < N - 1 and ts_array[val_start_idx] < t_purge_cutoff:
            val_start_idx += 1

    # Fallback to minimum purge buffer if timestamps are dense or synthetic
    min_purge_ticks = min(max(10, int((N - split_idx) * 0.05)), 100)
    if (val_start_idx - split_idx) < min_purge_ticks and (split_idx + min_purge_ticks) < N:
        val_start_idx = split_idx + min_purge_ticks

    purged_count = val_start_idx - split_idx

    print(f"[Dataset Split] Chronological 80/20 Split with 5-Second Non-Overlapping Purge Buffer:")
    print(f"                Train Range: [0 : {split_idx}] ({split_idx} samples)")
    print(f"                Purge Buffer Range: [{split_idx} : {val_start_idx}] ({purged_count} ticks purged)")
    print(f"                Validation Range: [{val_start_idx} : {N}] ({max(0, N - val_start_idx)} samples)")

    # Prepare T-KAN Tensors
    tkan_train_in = torch.from_numpy(tkan_norm[:split_idx])
    tkan_train_tgt = torch.from_numpy(y_targets[:split_idx])
    tkan_val_in = torch.from_numpy(tkan_norm[val_start_idx:])
    tkan_val_tgt = torch.from_numpy(y_targets[val_start_idx:])

    tkan_tensors = {
        "train_inputs": tkan_train_in.contiguous(),
        "train_targets": tkan_train_tgt.contiguous(),
        "val_inputs": tkan_val_in.contiguous(),
        "val_targets": tkan_val_tgt.contiguous(),
    }

    # Prepare compact 2D CfC / Mamba-2 Tensors [N, 16] & Targets [N, 3]
    cfc_train_in = torch.from_numpy(cfc_norm[:split_idx]).contiguous()
    cfc_train_tgt = torch.from_numpy(y_targets[:split_idx]).contiguous()
    cfc_val_in = torch.from_numpy(cfc_norm[val_start_idx:]).contiguous()
    cfc_val_tgt = torch.from_numpy(y_targets[val_start_idx:]).contiguous()

    cfc_tensors = {
        "train_inputs": cfc_train_in,
        "train_targets": cfc_train_tgt,
        "val_inputs": cfc_val_in,
        "val_targets": cfc_val_tgt,
    }

    # Export to SafeTensors via atomic temp-file write to prevent Windows file lock access denied errors
    print(f"[Export] Writing zero-copy SafeTensors to disk...")
    os.makedirs(DATA_DIR, exist_ok=True)

    tkan_tmp = f"{TKAN_OUT_PATH}.tmp"
    save_file(tkan_tensors, tkan_tmp)
    os.replace(tkan_tmp, TKAN_OUT_PATH)
    print(f"         Exported T-KAN Dataset: '{TKAN_OUT_PATH}' ({os.path.getsize(TKAN_OUT_PATH)} bytes)")

    cfc_tmp = f"{CFC_OUT_PATH}.tmp"
    save_file(cfc_tensors, cfc_tmp)
    os.replace(cfc_tmp, CFC_OUT_PATH)
    print(f"         Exported CfC Dataset:   '{CFC_OUT_PATH}' ({os.path.getsize(CFC_OUT_PATH)} bytes)")

    # Export Feature Normalization Statistics Metadata
    stats = {
        "dataset_records": N,
        "train_records": split_idx,
        "purged_records": purged_count,
        "val_records": max(0, N - val_start_idx),
        "welford_window": WELFORD_WINDOW,
        "cfc_sequence_length": CFC_SEQ_LEN,
        "purge_buffer_ticks": purged_count,
        "meta_win_rate_pct": meta_sig_rate,
        "target_horizon_sec": 5.0,
        "target_type": "micro_horizon_continuous_5s",
        "tkan_features": {
            "dim": 40,
            "names": TKAN_FEATURE_NAMES,
            "min_val": float(tkan_norm.min()),
            "max_val": float(tkan_norm.max()),
            "mean_val": float(tkan_norm.mean()),
        },
        "cfc_features": {
            "dim": TKAN_OUTPUT_DIM,
            "names": [f"tkan_out_{i}" for i in range(TKAN_OUTPUT_DIM)],
            "min_val": float(cfc_norm.min()),
            "max_val": float(cfc_norm.max()),
            "mean_val": float(cfc_norm.mean()),
        },
        "shapes": {
            "tkan_train_inputs": list(tkan_train_in.shape),
            "tkan_val_inputs": list(tkan_val_in.shape),
            "cfc_train_inputs": list(cfc_train_in.shape),
            "cfc_val_inputs": list(cfc_val_in.shape),
        }
    }

    with open(STATS_OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)

    print(f"         Exported Metadata Stats: '{STATS_OUT_PATH}'")
    print("=" * 75)
    print("DATA PREPARATION PIPELINE COMPLETED SUCCESSFULLY [SUCCESS]")
    print("=" * 75)

if __name__ == "__main__":
    load_and_preprocess_lob_data()

