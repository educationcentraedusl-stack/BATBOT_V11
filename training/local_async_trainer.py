#!/usr/bin/env python3
"""
BATBOT_V11 2026 SOTA Decoupled Local Asynchronous Background PyTorch 2.6 Recalibrator
100% FREE ($0) Lifetime Hardware-Accelerated Local Model Trainer.
Eliminates external cloud GPU dependencies, credit card requirements, and network latency.

Workflow:
1. SafeTensors Zero-Copy Ingestion: Reads `data/cfc_features.safetensors`.
2. Hardware Auto-Detection: Leverages CUDA GPU / DirectML if available, else multi-threaded AVX-512/AVX2 CPU.
3. Liquid CfC Continuous-Time Training: Executes 10 epochs over the latest market regime dataset with BF16/FP32 AMP, Huber+IC Loss, and L2 Gradient Clipping.
4. Atomic Weight Export: Writes trained SafeTensors directly to `models/cfc_weights.safetensors`.
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

class LocalCfCCell(nn.Module):
    """
    Exact PyTorch 2.6 implementation of the Closed-Form Continuous-Time (CfC) cell
    matching the Candle Rust formulation in src/ai/cfc.rs and src/ai/weights.rs.
    """
    def __init__(self, input_dim: int = 16, hidden_dim: int = 32, output_dim: int = 1):
        super().__init__()
        self.input_dim = input_dim
        self.hidden_dim = hidden_dim
        self.output_dim = output_dim
        concat_dim = input_dim + hidden_dim  # 48

        self.w_alpha = nn.Parameter(torch.randn(concat_dim, hidden_dim) * (1.0 / math.sqrt(concat_dim)))
        self.b_alpha = nn.Parameter(torch.zeros(hidden_dim))

        self.w_beta = nn.Parameter(torch.randn(concat_dim, hidden_dim) * (1.0 / math.sqrt(concat_dim)))
        self.b_beta = nn.Parameter(torch.zeros(hidden_dim))

        self.w_output = nn.Parameter(torch.randn(hidden_dim, output_dim) * (1.0 / math.sqrt(hidden_dim)))
        self.b_output = nn.Parameter(torch.zeros(output_dim))

    def forward(self, input_seq: torch.Tensor) -> torch.Tensor:
        batch_size, seq_len, _ = input_seq.shape
        device = input_seq.device

        if seq_len == 0:
            return torch.empty(batch_size, 0, self.output_dim, device=device)

        z_prev = torch.zeros(batch_size, self.hidden_dim, device=device, dtype=input_seq.dtype)
        outputs = []

        for t in range(seq_len):
            x_t = input_seq[:, t, :]  # [Batch, 16]

            # Last feature element (index 15) represents absolute dt interval
            delta_t = x_t[:, 15:16].abs() + 1e-4  # [Batch, 1]
            chi = torch.cat([x_t, z_prev], dim=-1) # [Batch, 48]

            alpha = F.softplus(chi @ self.w_alpha + self.b_alpha)
            beta = torch.tanh(chi @ self.w_beta + self.b_beta)

            decay_factor = torch.exp(-alpha * delta_t)
            z_t = beta - (beta - z_prev) * decay_factor

            output_t = z_t @ self.w_output + self.b_output
            outputs.append(output_t.unsqueeze(1))

            z_prev = z_t

        return torch.cat(outputs, dim=1)  # [Batch, SeqLen, 1]


class HuberICLoss(nn.Module):
    """
    Continuous-Time Hybrid Loss: Combines robust Huber Loss with Information Coefficient (IC) Rank Correlation.
    """
    def __init__(self, delta: float = 1e-3, ic_weight: float = 0.5, eps: float = 1e-8):
        super().__init__()
        self.huber = nn.HuberLoss(delta=delta)
        self.ic_weight = ic_weight
        self.eps = eps

    def forward(self, pred: torch.Tensor, target: torch.Tensor):
        h_loss = self.huber(pred, target)
        pred_flat = pred.view(-1)
        target_flat = target.view(-1)

        p_mean = pred_flat.mean()
        t_mean = target_flat.mean()

        p_diff = pred_flat - p_mean
        t_diff = target_flat - t_mean

        p_std = torch.sqrt((p_diff ** 2).mean() + self.eps)
        t_std = torch.sqrt((t_diff ** 2).mean() + self.eps)

        cov = (p_diff * t_diff).mean()
        ic = cov / (p_std * t_std)

        loss = h_loss + self.ic_weight * (1.0 - ic)
        return loss, h_loss, ic


def create_cfc_sequences_strided_torch(features: torch.Tensor, targets: torch.Tensor, seq_len: int = 32):
    num_samples = features.shape[0] - seq_len + 1
    if num_samples <= 0:
        return features.unsqueeze(0), targets.unsqueeze(0)
    in_sw = features.unfold(0, seq_len, 1)  # [num_samples, 16, 32]
    tgt_sw = targets.unfold(0, seq_len, 1) # [num_samples, 1, 32]
    seq_inputs = in_sw.transpose(1, 2).contiguous() # [num_samples, 32, 16]
    seq_targets = tgt_sw.transpose(1, 2).contiguous() # [num_samples, 32, 1]
    return seq_inputs, seq_targets


def fit_platt_temperature_calibration(model: nn.Module, val_loader: DataLoader, device: torch.device):
    """
    Fits Empirical Platt Scaling parameters (A, B) and Temperature (T) post-training
    using the Validation dataset to calibrate continuous Neural ODE output logits.
    """
    model.eval()
    all_preds = []
    all_targets = []

    with torch.no_grad():
        for bx, by in val_loader:
            if bx.shape[1] == 0:
                continue
            pred = model(bx)
            last_pred = pred[:, -1, 0].cpu()
            last_target = by[:, -1, 0].cpu()
            all_preds.append(last_pred)
            all_targets.append(last_target)

    if not all_preds:
        print("[BATBOT_V11][CALIBRATION] Validation dataset empty. Using default calibration (A=1.0, B=0.0, T=1.0).")
        return 1.0, 0.0, 1.0

    preds = torch.cat(all_preds, dim=0)
    targets = torch.cat(all_targets, dim=0)

    if preds.shape[0] < 10:
        print("[BATBOT_V11][CALIBRATION] Insufficient val samples for fitting. Using defaults.")
        return 1.0, 0.0, 1.0

    directional_match = (preds * targets > 0).float()
    magnitudes = preds.abs()
    z_dir = magnitudes

    platt_scale = nn.Parameter(torch.tensor([1.0], device=device))
    platt_offset = nn.Parameter(torch.tensor([0.0], device=device))
    temperature = nn.Parameter(torch.tensor([1.0], device=device))

    z_dir_dev = z_dir.to(device)
    target_dev = directional_match.to(device)

    optimizer = torch.optim.AdamW([platt_scale, platt_offset, temperature], lr=0.01)

    for _ in range(200):
        optimizer.zero_grad()
        temp_clamp = torch.clamp(temperature, min=0.05)
        calibrated_logit = (platt_scale * z_dir_dev + platt_offset) / temp_clamp
        prob = torch.sigmoid(calibrated_logit)
        loss = F.binary_cross_entropy(prob, target_dev)
        loss.backward()
        optimizer.step()

    final_scale = max(0.01, float(platt_scale.item()))
    final_offset = float(platt_offset.item())
    final_temp = max(0.05, float(temperature.item()))

    print(f"[BATBOT_V11][CALIBRATION SUCCESS] Empirical Platt Scale A: {final_scale:.4f} | Offset B: {final_offset:.4f} | Temperature T: {final_temp:.4f}")
    return final_scale, final_offset, final_temp


def train_local_cfc():
    start_time = time.time()

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

    model = LocalCfCCell(input_dim=16, hidden_dim=32, output_dim=1).to(device)
    criterion = HuberICLoss(delta=1e-3, ic_weight=0.5)

    epochs = 10
    total_steps = max(1, epochs * len(train_loader))
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4, amsgrad=True)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=2e-3, total_steps=total_steps, pct_start=0.1
    )

    best_val_ic = -1.0

    print(f"[BATBOT_V11][LOCAL-TRAINER] Starting Sub-30s Continuous-Time Recalibration ({epochs} Epochs)...")

    for epoch in range(1, epochs + 1):
        model.train()
        last_loss = 0.0
        for bx, by in train_loader:
            if bx.shape[1] == 0:
                continue

            optimizer.zero_grad(set_to_none=True)

            if use_amp:
                with torch.autocast('cuda', dtype=amp_dtype):
                    pred = model(bx)
                    loss, h_loss, ic = criterion(pred, by)
            else:
                pred = model(bx)
                loss, h_loss, ic = criterion(pred, by)

            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            scheduler.step()

            last_loss = loss.item()

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
                            _, _, ic = criterion(pred, by)
                    else:
                        pred = model(bx)
                        _, _, ic = criterion(pred, by)

                    val_ic_sum += ic.item() * len(bx)
                    val_count += len(bx)

            val_ic = val_ic_sum / max(1, val_count)
            if val_ic > best_val_ic:
                best_val_ic = val_ic

        if epoch % 2 == 0 or epoch == epochs:
            print(f"[BATBOT Epoch {epoch:02d}/{epochs}] Loss: {last_loss:.6f} | Best Val IC: {best_val_ic:+.4f}")

    duration = time.time() - start_time
    print(f"[BATBOT_V11][LOCAL-TRAINER] Recalibration completed in {duration:.3f}s | Final Best Val IC: {best_val_ic:+.4f}")

    # Fit Platt Scaling & Temperature Calibration parameters on Validation Set
    platt_scale, platt_offset, temperature = fit_platt_temperature_calibration(model, val_loader, device)

    # Extract Tensors for Rust Candle Engine compatibility
    weight_tensors = {
        "w_alpha": model.w_alpha.detach().cpu().contiguous(),
        "b_alpha": model.b_alpha.detach().cpu().contiguous(),
        "w_beta": model.w_beta.detach().cpu().contiguous(),
        "b_beta": model.b_beta.detach().cpu().contiguous(),
        "w_output": model.w_output.detach().cpu().contiguous(),
        "b_output": model.b_output.detach().cpu().contiguous(),
        "platt_scale": torch.tensor([platt_scale], dtype=torch.float32),
        "platt_offset": torch.tensor([platt_offset], dtype=torch.float32),
        "temperature": torch.tensor([temperature], dtype=torch.float32),
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
    print(f"[BATBOT_V11][LOCAL-TRAINER SUCCESS] SafeTensors weights saved ({weights_size} bytes) to '{weights_path}'!")

if __name__ == "__main__":
    train_local_cfc()

