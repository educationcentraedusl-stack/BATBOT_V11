#!/usr/bin/env python3
"""
BATBOT_V11 SOTA CfC (Closed-Form Continuous-Time) Liquid Neural Network Trainer
Trains 16 -> 32 -> 1 continuous-time dynamic solver model on 32-step sequence datasets using
Huber + Pearson Rank Correlation (IC) loss, AdamW optimizer, OneCycleLR scheduler,
gradient clipping, PyTorch 2.0 compilation, AMP FP16, and optimized DataLoaders.
Exports weights directly to SafeTensors for zero-copy Rust Candle inference.
"""

import os
import sys
import math
import time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import TensorDataset, DataLoader
from safetensors.torch import load_file, save_file

# Enable cuDNN Benchmarking for optimal algorithm selection
torch.backends.cudnn.benchmark = True

# Add training dir to sys.path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from data_config import (
    CFC_OUT_PATH, MODELS_DIR, CFC_WEIGHTS_PATH
)

PROGRESS_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".training_progress"))

def update_training_progress(pct: int):
    try:
        tmp_path = f"{PROGRESS_FILE}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(str(pct))
            f.flush()
        os.replace(tmp_path, PROGRESS_FILE)
    except Exception:
        pass

class PyTorchCfCCell(nn.Module):
    """
    Exact PyTorch implementation of the 2026 Closed-Form Continuous-Time (CfC) cell
    matching the Candle Rust formulation in src/ai/cfc.rs.
    """
    def __init__(self, input_dim: int = 16, hidden_dim: int = 32, output_dim: int = 1):
        super().__init__()
        self.input_dim = input_dim
        self.hidden_dim = hidden_dim
        self.output_dim = output_dim
        concat_dim = input_dim + hidden_dim # 48

        # Weights matching Candle Rust shapes:
        # w_alpha: [48, 32], b_alpha: [32]
        # w_beta:  [48, 32], b_beta:  [32]
        # w_output:[32, 1],  b_output:[1]
        self.w_alpha = nn.Parameter(torch.randn(concat_dim, hidden_dim) * (1.0 / math.sqrt(concat_dim)))
        self.b_alpha = nn.Parameter(torch.zeros(hidden_dim))

        self.w_beta = nn.Parameter(torch.randn(concat_dim, hidden_dim) * (1.0 / math.sqrt(concat_dim)))
        self.b_beta = nn.Parameter(torch.zeros(hidden_dim))

        self.w_output = nn.Parameter(torch.randn(hidden_dim, output_dim) * (1.0 / math.sqrt(hidden_dim)))
        self.b_output = nn.Parameter(torch.zeros(output_dim))

    def forward(self, input_seq: torch.Tensor) -> torch.Tensor:
        """
        input_seq: [Batch, SeqLen (32), InputDim (16)]
        Returns:   [Batch, SeqLen (32), OutputDim (1)]
        """
        batch_size, seq_len, _ = input_seq.shape
        device = input_seq.device

        if seq_len == 0:
            return torch.empty(batch_size, 0, self.output_dim, device=device)

        z_prev = torch.zeros(batch_size, self.hidden_dim, device=device)
        outputs = []

        for t in range(seq_len):
            x_t = input_seq[:, t, :] # [Batch, 16]

            # Delta t extracted from column 15 (delta_tau) or defaulted to 0.001s
            delta_t = x_t[:, 15:16].abs() + 1e-4 # [Batch, 1]

            # Chi = concat(x_t, z_prev) -> [Batch, 48]
            chi = torch.cat([x_t, z_prev], dim=-1)

            # Alpha = softplus(chi @ w_alpha + b_alpha) -> [Batch, 32]
            alpha = F.softplus(chi @ self.w_alpha + self.b_alpha)

            # Beta = tanh(chi @ w_beta + b_beta) -> [Batch, 32]
            beta = torch.tanh(chi @ self.w_beta + self.b_beta)

            # z_t = beta - (beta - z_prev) * exp(-alpha * delta_t) -> [Batch, 32]
            decay_factor = torch.exp(-alpha * delta_t)
            z_t = beta - (beta - z_prev) * decay_factor

            # output_t = z_t @ w_output + b_output -> [Batch, 1]
            output_t = z_t @ self.w_output + self.b_output
            outputs.append(output_t.unsqueeze(1))

            z_prev = z_t

        return torch.cat(outputs, dim=1) # [Batch, SeqLen, 1]

class HuberICLoss(nn.Module):
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

        # Maximize IC -> minimize 1.0 - IC
        loss = h_loss + self.ic_weight * (1.0 - ic)
        return loss, h_loss, ic

def train_cfc():
    print("=" * 75)
    print("BATBOT_V11 SOTA CfC LIQUID NEURAL NETWORK TRAINING PIPELINE")
    print("=" * 75)

    # Enable PyTorch Dynamo error suppression to cleanly fall back to eager mode if C++ compiler is absent
    try:
        import torch._dynamo
        torch._dynamo.config.suppress_errors = True
    except Exception:
        pass

    # 5. Device Verification: Strictly target CUDA; log fatal error if falling back to CPU
    if torch.cuda.is_available():
        device = torch.device("cuda")
        print(f"[Device] Strictly targeting CUDA GPU: {torch.cuda.get_device_name(0)}")
        use_amp = True
        pin_memory = True
    else:
        print("[FATAL ERROR] CUDA device unavailable! CPU fallback initiated. GPU acceleration & FP16 Tensor Cores disabled.", file=sys.stderr)
        device = torch.device("cpu")
        use_amp = False
        pin_memory = False

    num_threads = min(8, os.cpu_count() or 4)
    torch.set_num_threads(num_threads)
    print(f"[CPU Optimization] Configuring host threads: {num_threads}")

    if not os.path.exists(CFC_OUT_PATH):
        raise FileNotFoundError(f"CfC dataset safe tensors not found at: {CFC_OUT_PATH}")

    print(f"[Dataset] Loading SafeTensors from '{CFC_OUT_PATH}'...")
    data = load_file(CFC_OUT_PATH)

    x_train = data["train_inputs"]
    y_train = data["train_targets"]
    x_val = data["val_inputs"]
    y_val = data["val_targets"]

    print(f"[Dataset] Train sequences: {x_train.shape[0]} | Val sequences: {x_val.shape[0]}")

    if x_train.shape[0] == 0:
        raise ValueError("Error: Training dataset contains 0 sequence samples. Aborting training.")

    batch_size = 256
    train_dataset = TensorDataset(x_train, y_train)
    val_dataset = TensorDataset(x_val, y_val)

    # 3. DataLoader Optimization: pin_memory, persistent_workers, num_workers tuning
    num_workers = 0
    use_persistent = False

    train_loader = DataLoader(
        train_dataset,
        batch_size=batch_size,
        shuffle=True,
        num_workers=num_workers,
        pin_memory=pin_memory,
        persistent_workers=use_persistent
    )
    val_loader = DataLoader(
        val_dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=num_workers,
        pin_memory=pin_memory,
        persistent_workers=use_persistent
    )
    print(f"[DataLoader] Workers: {num_workers} | Pinned Memory: {pin_memory} | Persistent Workers: {use_persistent}")

    raw_model = PyTorchCfCCell(input_dim=16, hidden_dim=32, output_dim=1).to(device)

    # 1. PyTorch 2.0 Compilation
    if device.type == "cuda":
        try:
            model = torch.compile(raw_model, mode="reduce-overhead")
            print("[PyTorch 2.0] Successfully compiled CfC model with mode='reduce-overhead'.")
        except Exception as e:
            print(f"[PyTorch 2.0 Warning] torch.compile fallback to raw model ({e}).")
            model = raw_model
    else:
        model = raw_model
        print("[PyTorch Eager] Operating CfC model on CPU (Eager Mode).")

    criterion = HuberICLoss(delta=1e-3, ic_weight=0.5)

    epochs = 35
    total_steps = max(1, epochs * len(train_loader))
    optimizer = torch.optim.AdamW(raw_model.parameters(), lr=1e-3, weight_decay=1e-4, amsgrad=True)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=1e-3, total_steps=total_steps, pct_start=0.1
    )

    # 2. Automatic Mixed Precision (AMP)
    if use_amp:
        scaler = torch.cuda.amp.GradScaler()
        print("[AMP] Automatic Mixed Precision (FP16 Tensor Cores + GradScaler) Enabled.")
    else:
        scaler = None
        print("[AMP] Automatic Mixed Precision Disabled (Operating on CPU).")

    print(f"[Training] Starting CfC optimization for {epochs} epochs (Batch Size: {batch_size})...")
    sys.stdout.flush()
    start_time = time.time()

    best_val_ic = -1.0
    current_step = 0
    update_training_progress(0)

    for epoch in range(1, epochs + 1):
        raw_model.train()
        train_loss_sum = 0.0
        train_ic_sum = 0.0

        for bx, by in train_loader:
            current_step += 1
            progress_pct = min(100, int((current_step / total_steps) * 100))
            update_training_progress(progress_pct)

            bx = bx.to(device, non_blocking=pin_memory)
            by = by.to(device, non_blocking=pin_memory)

            if bx.shape[1] == 0:
                continue

            optimizer.zero_grad()

            if use_amp and scaler is not None:
                with torch.cuda.amp.autocast():
                    pred = model(bx)
                    loss, h_loss, ic = criterion(pred, by)

                scaler.scale(loss).backward()
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(raw_model.parameters(), max_norm=1.0)
                scaler.step(optimizer)
                scaler.update()
            else:
                pred = model(bx)
                loss, h_loss, ic = criterion(pred, by)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(raw_model.parameters(), max_norm=1.0)
                optimizer.step()

            scheduler.step()

            train_loss_sum += loss.item() * len(bx)
            train_ic_sum += ic.item() * len(bx)

        train_loss = train_loss_sum / max(1, len(train_dataset))
        train_ic = train_ic_sum / max(1, len(train_dataset))

        # Validation Phase
        val_loss = 0.0
        val_ic = 0.0
        if len(val_dataset) > 0:
            raw_model.eval()
            val_loss_sum = 0.0
            val_ic_sum = 0.0

            with torch.no_grad():
                if use_amp:
                    with torch.cuda.amp.autocast():
                        for bx, by in val_loader:
                            bx = bx.to(device, non_blocking=pin_memory)
                            by = by.to(device, non_blocking=pin_memory)
                            if bx.shape[1] == 0:
                                continue
                            pred = model(bx)
                            loss, h_loss, ic = criterion(pred, by)
                            val_loss_sum += loss.item() * len(bx)
                            val_ic_sum += ic.item() * len(bx)
                else:
                    for bx, by in val_loader:
                        bx = bx.to(device, non_blocking=pin_memory)
                        by = by.to(device, non_blocking=pin_memory)
                        if bx.shape[1] == 0:
                            continue
                        pred = model(bx)
                        loss, h_loss, ic = criterion(pred, by)
                        val_loss_sum += loss.item() * len(bx)
                        val_ic_sum += ic.item() * len(bx)

            val_loss = val_loss_sum / len(val_dataset)
            val_ic = val_ic_sum / len(val_dataset)

            if val_ic > best_val_ic:
                best_val_ic = val_ic

        if epoch % 5 == 0 or epoch == epochs:
            print(f"Epoch {epoch:02d}/{epochs} | Train Loss: {train_loss:.6f} | Train IC: {train_ic:+.4f} | Val Loss: {val_loss:.6f} | Val IC: {val_ic:+.4f}")
            sys.stdout.flush()

    total_training_duration = time.time() - start_time
    print(f"[Training] Training completed in {total_training_duration:.2f}s | Best Val IC: {best_val_ic:+.4f}")

    # Export SafeTensors for Rust Candle
    print("[Export] Exporting zero-copy SafeTensors weights for Candle Rust...")
    os.makedirs(MODELS_DIR, exist_ok=True)

    weight_tensors = {
        "w_alpha": raw_model.w_alpha.detach().cpu().contiguous(),
        "b_alpha": raw_model.b_alpha.detach().cpu().contiguous(),
        "w_beta": raw_model.w_beta.detach().cpu().contiguous(),
        "b_beta": raw_model.b_beta.detach().cpu().contiguous(),
        "w_output": raw_model.w_output.detach().cpu().contiguous(),
        "b_output": raw_model.b_output.detach().cpu().contiguous(),
    }

    save_file(weight_tensors, CFC_WEIGHTS_PATH)
    file_bytes = os.path.getsize(CFC_WEIGHTS_PATH)
    print(f"         Exported SafeTensors: '{CFC_WEIGHTS_PATH}' ({file_bytes} bytes)")

    update_training_progress(100)
    print("=" * 75)
    print("CfC TRAINING & SAFETENSORS EXPORT COMPLETED SUCCESSFULLY [SUCCESS]")
    print("=" * 75)

if __name__ == "__main__":
    train_cfc()
