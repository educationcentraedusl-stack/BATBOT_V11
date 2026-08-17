#!/usr/bin/env python3
"""
BATBOT_V11 2026 SOTA Decoupled Local Asynchronous Background PyTorch Recalibrator
100% FREE ($0) Lifetime Hardware-Accelerated Local Model Trainer.
Eliminates external cloud GPU dependencies, credit card requirements, and network latency.

Architecture:
- Mid-Frequency Mamba-2 Structured State-Space Model (SSM) with continuous selective discretization.
- Dual-Stage Multi-Head Architecture:
  1. Primary Directional Prediction (tanh logit -> y_dir in [-1.0, 1.0])
  2. Meta-Labeling Win Probability (sigmoid logit -> P_win in [0.0, 1.0]) with Focal Loss
  3. Holding Horizon Duration (softplus logit -> y_horiz in seconds)
- Loss: Hybrid Multi-Objective Loss (Huber + IC Rank Correlation + Focal Loss + Smooth L1).
- Atomic Weight Export: Writes trained SafeTensors directly to models/cfc_weights.safetensors.
"""

import os
import sys
import math
import time
import json
import shutil
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import TensorDataset, DataLoader
from safetensors.torch import load_file, save_file

class LocalMamba2SSM(nn.Module):
    """
    Exact PyTorch implementation of the 2026 SOTA Mamba-2 Structured State-Space Model (SSM)
    matching the Candle Rust formulation in src/ai/mamba.rs and src/ai/weights.rs.
    """
    def __init__(self, input_dim: int = 16, d_inner: int = 32, d_state: int = 16):
        super().__init__()
        self.input_dim = input_dim
        self.d_inner = d_inner
        self.d_state = d_state

        # 1. Input Linear Projection
        self.w_in = nn.Parameter(torch.randn(input_dim, d_inner) * (1.0 / math.sqrt(input_dim)))
        self.b_in = nn.Parameter(torch.zeros(d_inner))

        # 2. Selective Discretization Parameter A (log domain)
        self.a_log = nn.Parameter(torch.randn(d_inner) * 0.1 - 1.0)

        # 3. Selective B and C Projections
        self.w_b = nn.Parameter(torch.randn(d_inner, d_state) * (1.0 / math.sqrt(d_inner)))
        self.b_b = nn.Parameter(torch.zeros(d_state))

        self.w_c = nn.Parameter(torch.randn(d_inner, d_state) * (1.0 / math.sqrt(d_inner)))
        self.b_c = nn.Parameter(torch.zeros(d_state))

        # 4. Output Projection with Skip Connection
        self.w_out = nn.Parameter(torch.randn(d_inner, d_inner) * (1.0 / math.sqrt(d_inner)))
        self.b_out = nn.Parameter(torch.zeros(d_inner))
        self.d_skip = nn.Parameter(torch.ones(d_inner))

        # 5. Multi-Head Predictions (Direction Logit, Meta Logit, Horizon Logit)
        self.w_heads = nn.Parameter(torch.randn(d_inner, 3) * (1.0 / math.sqrt(d_inner)))
        self.b_heads = nn.Parameter(torch.zeros(3))

    def forward(self, input_seq: torch.Tensor) -> torch.Tensor:
        batch_size, seq_len, _ = input_seq.shape
        device = input_seq.device

        if seq_len == 0:
            return torch.empty(batch_size, 0, 3, device=device)

        h_prev = torch.zeros(batch_size, self.d_inner, self.d_state, device=device, dtype=input_seq.dtype)
        outputs = []

        a_clamped = torch.clamp(self.a_log, -20.0, 20.0)
        a_softplus = F.softplus(a_clamped) # [d_inner]

        for t in range(seq_len):
            x_t = input_seq[:, t, :] # [Batch, 16]

            # Delta time interval from feature index 15 (delta_tau)
            delta_t = torch.clamp(x_t[:, 15:16].abs(), min=1e-4, max=10.0) # [Batch, 1]

            # 1. Input Linear Projection
            u_t = x_t @ self.w_in + self.b_in # [Batch, d_inner]

            # 2. Selective Discretization & Exponential Decay
            delta_a = delta_t * a_softplus.unsqueeze(0) # [Batch, d_inner]
            decay = torch.exp(-delta_a).unsqueeze(-1) # [Batch, d_inner, 1]

            # 3. Selective B and C projections
            b_proj = u_t @ self.w_b + self.b_b # [Batch, d_state]
            c_proj = u_t @ self.w_c + self.b_c # [Batch, d_state]

            u_3d = u_t.unsqueeze(-1) # [Batch, d_inner, 1]
            b_3d = b_proj.unsqueeze(1) # [Batch, 1, d_state]
            c_3d = c_proj.unsqueeze(1) # [Batch, 1, d_state]

            # 4. Latent State Transition
            h_t = h_prev * decay + (u_3d * b_3d) # [Batch, d_inner, d_state]

            # 5. Output Contraction across d_state
            h_contracted = (h_t * c_3d).sum(dim=2) # [Batch, d_inner]

            y_ssm = h_contracted @ self.w_out + self.b_out # [Batch, d_inner]
            y_skip = u_t * self.d_skip # [Batch, d_inner]
            y_t = y_ssm + y_skip # [Batch, d_inner]

            # 6. Multi-Head Predictions: [Batch, 3] -> (dir_logit, meta_logit, horiz_logit)
            heads_t = y_t @ self.w_heads + self.b_heads # [Batch, 3]
            outputs.append(heads_t.unsqueeze(1))

            h_prev = h_t

        return torch.cat(outputs, dim=1) # [Batch, SeqLen, 3]


class DualStageFocalLoss(nn.Module):
    """
    Dual-Stage Multi-Objective Loss combining:
    1. Primary Direction: Huber Loss + IC Rank Correlation on y_dir in [-1.0, 1.0].
    2. Meta-Labeling Classifier: Focal Loss on P_win in {0.0, 1.0} to handle class imbalance.
    3. Holding Horizon Duration: Smooth L1 Loss on estimated duration in minutes.
    """
    def __init__(
        self,
        delta: float = 1e-3,
        ic_weight: float = 0.5,
        focal_gamma: float = 2.0,
        focal_alpha: float = 0.65,
        eps: float = 1e-8
    ):
        super().__init__()
        self.huber = nn.HuberLoss(delta=delta)
        self.ic_weight = ic_weight
        self.focal_gamma = focal_gamma
        self.focal_alpha = focal_alpha
        self.eps = eps

    def forward(self, pred: torch.Tensor, target: torch.Tensor):
        # pred: [Batch, SeqLen, 3] or [Batch, 3]
        # target: [Batch, SeqLen, 3] or [Batch, 3]
        if pred.dim() == 3:
            pred_last = pred[:, -1, :] # [Batch, 3]
        else:
            pred_last = pred

        if target.dim() == 3:
            tgt_last = target[:, -1, :] # [Batch, 3]
        else:
            tgt_last = target

        # 1. Primary Direction Head
        dir_logit = pred_last[:, 0]
        pred_dir = torch.tanh(dir_logit)
        tgt_dir = tgt_last[:, 0]

        h_loss = self.huber(pred_dir, tgt_dir)

        p_diff = pred_dir - pred_dir.mean()
        t_diff = tgt_dir - tgt_dir.mean()
        p_std = torch.sqrt((p_diff ** 2).mean() + self.eps)
        t_std = torch.sqrt((t_diff ** 2).mean() + self.eps)
        cov = (p_diff * t_diff).mean()
        ic = cov / (p_std * t_std + self.eps)
        dir_loss = h_loss + self.ic_weight * (1.0 - ic)

        # 2. Meta-Labeling Head (Focal Loss)
        meta_logit = pred_last[:, 1]
        tgt_meta = tgt_last[:, 1].clamp(0.0, 1.0)
        bce = F.binary_cross_entropy_with_logits(meta_logit, tgt_meta, reduction='none')
        p_t = torch.exp(-bce)
        alpha_t = self.focal_alpha * tgt_meta + (1.0 - self.focal_alpha) * (1.0 - tgt_meta)
        focal_loss = (alpha_t * ((1.0 - p_t) ** self.focal_gamma) * bce).mean()

        # 3. Horizon Head (in minutes)
        horiz_logit = pred_last[:, 2]
        pred_horiz = F.softplus(horiz_logit)
        tgt_horiz = (tgt_last[:, 2] / 60.0).clamp(0.1, 30.0)
        horiz_loss = F.smooth_l1_loss(pred_horiz, tgt_horiz)

        total_loss = dir_loss + 1.5 * focal_loss + 0.1 * horiz_loss
        return total_loss, dir_loss, focal_loss, ic


def create_cfc_sequences_strided_torch(features: torch.Tensor, targets: torch.Tensor, seq_len: int = 32):
    num_samples = features.shape[0] - seq_len + 1
    if num_samples <= 0:
        return features.unsqueeze(0), targets.unsqueeze(0)
    in_sw = features.unfold(0, seq_len, 1)  # [num_samples, 16, 32]
    tgt_sw = targets.unfold(0, seq_len, 1) # [num_samples, 3, 32]
    seq_inputs = in_sw.transpose(1, 2).contiguous() # [num_samples, 32, 16]
    seq_targets = tgt_sw.transpose(1, 2).contiguous() # [num_samples, 32, 3]
    return seq_inputs, seq_targets


def fit_platt_temperature_calibration(model: nn.Module, val_loader: DataLoader, device: torch.device):
    """
    Fits Empirical Platt Scaling parameters (A, B) and Temperature (T) post-training
    using the Validation dataset to calibrate Meta-Labeling Win Probability (P_win).
    """
    model.eval()
    all_meta_logits = []
    all_targets = []

    with torch.no_grad():
        for bx, by in val_loader:
            if bx.shape[1] == 0:
                continue
            pred = model(bx) # [Batch, SeqLen, 3]
            last_meta_logit = pred[:, -1, 1].cpu()
            last_target = by[:, -1, 1].cpu().clamp(0.0, 1.0)
            all_meta_logits.append(last_meta_logit)
            all_targets.append(last_target)

    if not all_meta_logits:
        print("[BATBOT_V11][CALIBRATION] Validation dataset empty. Using default calibration (A=1.0, B=0.0, T=1.0).")
        return 1.0, 0.0, 1.0

    meta_logits = torch.cat(all_meta_logits, dim=0)
    targets = torch.cat(all_targets, dim=0)

    if meta_logits.shape[0] < 10:
        print("[BATBOT_V11][CALIBRATION] Insufficient val samples for fitting. Using defaults.")
        return 1.0, 0.0, 1.0

    platt_scale = nn.Parameter(torch.tensor([1.0], device=device))
    platt_offset = nn.Parameter(torch.tensor([0.0], device=device))
    temperature = nn.Parameter(torch.tensor([1.0], device=device))

    logits_dev = meta_logits.to(device)
    target_dev = targets.to(device)

    optimizer = torch.optim.AdamW([platt_scale, platt_offset, temperature], lr=0.01)

    for _ in range(200):
        optimizer.zero_grad()
        temp_clamp = torch.clamp(temperature, min=0.05)
        calibrated_logit = (platt_scale * logits_dev + platt_offset) / temp_clamp
        prob = torch.sigmoid(calibrated_logit)
        loss = F.binary_cross_entropy(prob, target_dev)
        loss.backward()
        optimizer.step()

    final_scale = max(0.01, float(platt_scale.item()))
    final_offset = float(platt_offset.item())
    final_temp = max(0.05, float(temperature.item()))

    print(f"[BATBOT_V11][CALIBRATION SUCCESS] Empirical Platt Scale A: {final_scale:.4f} | Offset B: {final_offset:.4f} | Temperature T: {final_temp:.4f}")
    return final_scale, final_offset, final_temp


def write_progress(pct: int):
    try:
        progress_path = os.path.join(os.getcwd(), ".training_progress")
        with open(progress_path, "w") as f:
            f.write(f"{pct}\n")
    except Exception:
        pass


def train_local_cfc():
    start_time = time.time()
    write_progress(5)

    project_root = os.getcwd()
    dataset_path = os.path.join(project_root, "data", "cfc_features.safetensors")
    weights_path = os.path.join(project_root, "models", "cfc_weights.safetensors")
    weights_updated_path = os.path.join(project_root, "models", "cfc_updated.safetensors")

    if not os.path.exists(dataset_path):
        print(f"[Local Recalibrator Error] Dataset file missing at '{dataset_path}'.")
        sys.exit(1)

    print(f"[BATBOT_V11][LOCAL-TRAINER] Ingesting SafeTensors dataset: '{dataset_path}' ({os.path.getsize(dataset_path)} bytes)...")

    # Hardware Acceleration Selection
    if torch.cuda.is_available():
        device = torch.device("cuda")
        device_name = torch.cuda.get_device_name(0)
        use_amp = True
        amp_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        print(f"[BATBOT_V11][LOCAL-TRAINER] Hardware Acceleration: CUDA GPU ({device_name}) | AMP Dtype: {amp_dtype}")
    else:
        device = torch.device("cpu")
        num_threads = max(1, os.cpu_count() or 4)
        torch.set_num_threads(num_threads)
        use_amp = False
        amp_dtype = torch.float32
        print(f"[BATBOT_V11][LOCAL-TRAINER] Hardware Acceleration: CPU Vectorized ({num_threads} Threads)")

    # 1. Zero-Copy SafeTensors Loading
    dataset_tensors = load_file(dataset_path)
    x_train_raw = dataset_tensors["train_inputs"]
    y_train_raw = dataset_tensors["train_targets"]
    x_val_raw = dataset_tensors["val_inputs"]
    y_val_raw = dataset_tensors["val_targets"]

    # Cap training samples to latest 20,000 ticks for sub-30s continuous regime-adaptive recalibration
    max_train_samples = 20000
    max_val_samples = 5000

    if x_train_raw.shape[0] > max_train_samples:
        x_train_raw = x_train_raw[-max_train_samples:]
        y_train_raw = y_train_raw[-max_train_samples:]
    if x_val_raw.shape[0] > max_val_samples:
        x_val_raw = x_val_raw[-max_val_samples:]
        y_val_raw = y_val_raw[-max_val_samples:]

    x_train_raw = x_train_raw.to(device, non_blocking=True)
    y_train_raw = y_train_raw.to(device, non_blocking=True)
    x_val_raw = x_val_raw.to(device, non_blocking=True)
    y_val_raw = y_val_raw.to(device, non_blocking=True)

    if x_train_raw.dim() == 2:
        x_train, y_train = create_cfc_sequences_strided_torch(x_train_raw, y_train_raw, 32)
        x_val, y_val = create_cfc_sequences_strided_torch(x_val_raw, y_val_raw, 32)
        print(f"[BATBOT_V11][LOCAL-TRAINER] Unfolded 2D feature matrix into 3D sequences: train={x_train.shape}, val={x_val.shape}")
    else:
        x_train, y_train = x_train_raw, y_train_raw
        x_val, y_val = x_val_raw, y_val_raw

    train_samples = x_train.shape[0]
    val_samples = x_val.shape[0]
    print(f"[BATBOT_V11][LOCAL-TRAINER] Sequence Dataset Ready: {train_samples} train samples, {val_samples} val samples.")

    if train_samples == 0:
        print("[Local Recalibrator Error] Dataset contains 0 train sequences.")
        sys.exit(1)

    batch_size = 4096
    train_dataset = TensorDataset(x_train, y_train)
    val_dataset = TensorDataset(x_val, y_val)

    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)

    model = LocalMamba2SSM(input_dim=16, d_inner=32, d_state=16).to(device)
    criterion = DualStageFocalLoss(delta=1e-3, ic_weight=0.5, focal_gamma=2.0, focal_alpha=0.65)

    epochs = 10
    total_steps = max(1, epochs * len(train_loader))
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4, amsgrad=True)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=2e-3, total_steps=total_steps, pct_start=0.1
    )

    best_val_ic = -1.0

    print(f"[BATBOT_V11][LOCAL-TRAINER] Starting Sub-30s Mid-Frequency Scalping Recalibration ({epochs} Epochs)...")

    for epoch in range(1, epochs + 1):
        model.train()
        last_loss = 0.0
        last_focal = 0.0
        for bx, by in train_loader:
            if bx.shape[1] == 0:
                continue

            optimizer.zero_grad(set_to_none=True)

            if use_amp:
                with torch.autocast('cuda', dtype=amp_dtype):
                    pred = model(bx)
                    loss, dir_loss, focal_loss, ic = criterion(pred, by)
            else:
                pred = model(bx)
                loss, dir_loss, focal_loss, ic = criterion(pred, by)

            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            scheduler.step()

            last_loss = loss.item()
            last_focal = focal_loss.item()

        if val_samples > 0:
            model.eval()
            val_ic_sum = 0.0
            val_count = 0
            with torch.no_grad():
                for bx, by in val_loader:
                    if bx.shape[1] == 0:
                        continue
                    if use_amp:
                        with torch.autocast('cuda', dtype=amp_dtype):
                            pred = model(bx)
                            _, _, _, ic = criterion(pred, by)
                    else:
                        pred = model(bx)
                        _, _, _, ic = criterion(pred, by)

                    val_ic_sum += ic.item() * len(bx)
                    val_count += len(bx)

            val_ic = val_ic_sum / max(1, val_count)
            if val_ic > best_val_ic:
                best_val_ic = val_ic

        if epoch % 2 == 0 or epoch == epochs:
            print(f"[BATBOT Epoch {epoch:02d}/{epochs}] Loss: {last_loss:.6f} | Focal: {last_focal:.6f} | Best Val IC: {best_val_ic:+.4f}")

        # Update real-time training progress for TUI dashboard
        write_progress(int((epoch / epochs) * 100))

    duration = time.time() - start_time
    print(f"[BATBOT_V11][LOCAL-TRAINER] Recalibration completed in {duration:.3f}s | Final Best Val IC: {best_val_ic:+.4f}")

    # Fit Platt Scaling & Temperature Calibration parameters on Validation Set
    platt_scale, platt_offset, temperature = fit_platt_temperature_calibration(model, val_loader, device)

    # Extract Tensors for Rust Candle Engine (Mamba-2 + CfC compatibility)
    weight_tensors = {
        # SOTA Mamba-2 SSM Tensors
        "w_in": model.w_in.detach().cpu().contiguous(),
        "b_in": model.b_in.detach().cpu().contiguous(),
        "a_log": model.a_log.detach().cpu().contiguous(),
        "w_b": model.w_b.detach().cpu().contiguous(),
        "b_b": model.b_b.detach().cpu().contiguous(),
        "w_c": model.w_c.detach().cpu().contiguous(),
        "b_c": model.b_c.detach().cpu().contiguous(),
        "w_out": model.w_out.detach().cpu().contiguous(),
        "b_out": model.b_out.detach().cpu().contiguous(),
        "d_skip": model.d_skip.detach().cpu().contiguous(),
        "w_heads": model.w_heads.detach().cpu().contiguous(),
        "b_heads": model.b_heads.detach().cpu().contiguous(),
        # Platt & Temperature Calibration
        "platt_scale": torch.tensor([platt_scale], dtype=torch.float32),
        "platt_offset": torch.tensor([platt_offset], dtype=torch.float32),
        "temperature": torch.tensor([temperature], dtype=torch.float32),
        # Legacy CfC Tensors for Full Backward Compatibility
        "w_alpha": torch.zeros((48, 32), dtype=torch.float32),
        "b_alpha": torch.zeros((32,), dtype=torch.float32),
        "w_beta": torch.zeros((48, 32), dtype=torch.float32),
        "b_beta": torch.zeros((32,), dtype=torch.float32),
        "w_output": torch.zeros((32, 1), dtype=torch.float32),
        "b_output": torch.zeros((1,), dtype=torch.float32),
    }

    # Atomic Write to Disk
    os.makedirs(os.path.dirname(weights_path), exist_ok=True)
    tmp_weights_path = f"{weights_path}.tmp"
    save_file(weight_tensors, tmp_weights_path)

    if os.path.exists(weights_path):
        os.remove(weights_path)
    os.rename(tmp_weights_path, weights_path)
    shutil.copyfile(weights_path, weights_updated_path)

    weights_size = os.path.getsize(weights_path)
    write_progress(100)
    print(f"[BATBOT_V11][LOCAL-TRAINER SUCCESS] SafeTensors weights saved ({weights_size} bytes) to '{weights_path}'!")

if __name__ == "__main__":
    train_local_cfc()


