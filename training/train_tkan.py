#!/usr/bin/env python3
"""
BATBOT_V11 SOTA T-KAN (Temporal Kolmogorov-Arnold Network) Spatial Encoder Trainer
Trains 40 -> 16 dimension reduction model using Huber + Pearson Rank Correlation (IC) loss,
AdamW optimizer, OneCycleLR scheduler, gradient clipping, and zero-copy 24-byte header binary LUT export for Rust Candle.
"""

import os
import sys
import math
import time
import struct
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import TensorDataset, DataLoader
from safetensors.torch import load_file

# Add training dir to sys.path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from data_config import (
    TKAN_OUT_PATH, MODELS_DIR, TKAN_LUT_PATH
)

class FastKANLayer(nn.Module):
    """
    Fast KAN Layer (40 -> 16) with Gaussian Radial Basis Functions (RBF) spline grid representation.
    Learns 640 univariate edge activation functions phi_{i,j}(x) = w_base * silu(x) + sum(c_k * RBF_k(x)).
    """
    def __init__(self, input_dim: int = 40, output_dim: int = 16, num_grids: int = 8, grid_min: float = -1.0, grid_max: float = 1.0):
        super().__init__()
        self.input_dim = input_dim
        self.output_dim = output_dim
        self.num_grids = num_grids
        self.grid_min = grid_min
        self.grid_max = grid_max

        # Base weights: shape [input_dim, output_dim]
        self.w_base = nn.Parameter(torch.randn(input_dim, output_dim) * (1.0 / math.sqrt(input_dim)))

        # Spline RBF coefficient weights: shape [input_dim, output_dim, num_grids]
        self.c_spline = nn.Parameter(torch.randn(input_dim, output_dim, num_grids) * 0.1)

        # RBF Grid centers mu and scale sigma
        grid_centers = torch.linspace(grid_min, grid_max, num_grids)
        self.register_buffer("grid_centers", grid_centers)
        grid_step = (grid_max - grid_min) / (num_grids - 1)
        self.sigma = grid_step * 1.2

    def rbf_basis(self, x: torch.Tensor) -> torch.Tensor:
        # x: [Batch, input_dim] -> output: [Batch, input_dim, num_grids]
        x_exp = x.unsqueeze(-1) # [Batch, input_dim, 1]
        return torch.exp(-0.5 * ((x_exp - self.grid_centers) / self.sigma) ** 2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [Batch, 40]
        # Base activation: silu(x) @ w_base
        base_act = F.silu(x) @ self.w_base # [Batch, 16]

        # Spline activation: sum over grids and input_dim
        rbf = self.rbf_basis(x) # [Batch, 40, num_grids]
        # Contract rbf [Batch, 40, num_grids] and c_spline [40, 16, num_grids] over input and grid dims
        spline_act = torch.einsum("bin,ion->bo", rbf, self.c_spline) # [Batch, 16]

        return base_act + spline_act

    @torch.no_grad()
    def export_luts(self, lut_size: int = 4096, min_val: float = -1.0, max_val: float = 1.0) -> bytes:
        """
        Discretizes all 640 edge functions phi_{i,j}(x) into 4096 uniform steps across [min_val, max_val].
        Header: 24 bytes LE: u32 num_edges (640), u32 lut_size (4096), f64 min_val (-1.0), f64 max_val (1.0).
        Payload: 640 * 4096 f64 array in Little-Endian format.
        """
        num_edges = self.input_dim * self.output_dim
        grid_x = torch.linspace(min_val, max_val, lut_size, device=self.w_base.device) # [4096]

        # Evaluate base activation: silu(x)
        base_val = F.silu(grid_x) # [4096]

        # Evaluate RBF basis over grid_x: shape [4096, num_grids]
        grid_x_exp = grid_x.unsqueeze(-1) # [4096, 1]
        rbf_val = torch.exp(-0.5 * ((grid_x_exp - self.grid_centers) / self.sigma) ** 2) # [4096, num_grids]

        # Construct binary header: u32 num_edges, u32 lut_size, f64 min_val, f64 max_val
        header = struct.pack("<IIdd", num_edges, lut_size, min_val, max_val)

        payload_list = []
        for i in range(self.input_dim):
            for j in range(self.output_dim):
                wb = self.w_base[i, j]
                cs = self.c_spline[i, j] # [num_grids]

                # phi(x) = wb * silu(x) + sum_k cs[k] * rbf_k(x)
                phi = wb * base_val + (rbf_val @ cs) # [4096]
                phi_np = phi.cpu().numpy().astype(np.float64)
                payload_list.append(phi_np)

        full_payload = np.concatenate(payload_list, axis=0) # [640 * 4096]
        assert len(full_payload) == num_edges * lut_size

        return header + full_payload.tobytes()

class TKANPredictor(nn.Module):
    def __init__(self):
        super().__init__()
        self.kan_layer = FastKANLayer(input_dim=40, output_dim=16)
        self.head = nn.Linear(16, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        feat = self.kan_layer(x)
        return self.head(feat)

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

def write_progress(pct: int):
    try:
        progress_path = os.path.join(os.getcwd(), ".training_progress")
        with open(progress_path, "w") as f:
            f.write(f"{pct}\n")
    except Exception:
        pass


def train_tkan():
    write_progress(5)
    print("=" * 75)
    print("BATBOT_V11 SOTA T-KAN MODEL TRAINING PIPELINE")
    print("=" * 75)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[Device] Operating on: {device}")

    if not os.path.exists(TKAN_OUT_PATH):
        raise FileNotFoundError(f"T-KAN dataset safe tensors not found at: {TKAN_OUT_PATH}")

    print(f"[Dataset] Loading SafeTensors from '{TKAN_OUT_PATH}'...")
    data = load_file(TKAN_OUT_PATH)

    x_train = data["train_inputs"].to(device)
    y_train = data["train_targets"].to(device)
    x_val = data["val_inputs"].to(device)
    y_val = data["val_targets"].to(device)

    print(f"[Dataset] Train samples: {x_train.shape[0]} | Val samples: {x_val.shape[0]}")

    batch_size = 256
    train_dataset = TensorDataset(x_train, y_train)
    val_dataset = TensorDataset(x_val, y_val)

    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)

    model = TKANPredictor().to(device)
    criterion = HuberICLoss(delta=1e-3, ic_weight=0.5)

    epochs = 35
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4, amsgrad=True)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=1e-3, total_steps=epochs * len(train_loader), pct_start=0.1
    )

    print(f"[Training] Starting T-KAN optimization for {epochs} epochs...")
    start_time = time.time()

    best_val_ic = -1.0

    for epoch in range(1, epochs + 1):
        model.train()
        train_loss_sum = 0.0
        train_ic_sum = 0.0

        for bx, by in train_loader:
            optimizer.zero_grad()
            pred = model(bx)
            target = by[:, 0:1] if by.dim() > 1 and by.shape[1] > 1 else by
            loss, h_loss, ic = criterion(pred, target)
            loss.backward()

            # Gradient Clipping
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            scheduler.step()

            train_loss_sum += loss.item() * len(bx)
            train_ic_sum += ic.item() * len(bx)

        train_loss = train_loss_sum / len(train_dataset)
        train_ic = train_ic_sum / len(train_dataset)

        # Validation Phase
        model.eval()
        val_loss_sum = 0.0
        val_ic_sum = 0.0

        with torch.no_grad():
            for bx, by in val_loader:
                pred = model(bx)
                target = by[:, 0:1] if by.dim() > 1 and by.shape[1] > 1 else by
                loss, h_loss, ic = criterion(pred, target)
                val_loss_sum += loss.item() * len(bx)
                val_ic_sum += ic.item() * len(bx)

        val_loss = val_loss_sum / len(val_dataset)
        val_ic = val_ic_sum / len(val_dataset)

        if val_ic > best_val_ic:
            best_val_ic = val_ic

        if epoch % 5 == 0 or epoch == epochs:
            print(f"Epoch {epoch:02d}/{epochs} | Train Loss: {train_loss:.6f} | Train IC: {train_ic:+.4f} | Val Loss: {val_loss:.6f} | Val IC: {val_ic:+.4f}")

        # Update real-time training progress for TUI dashboard
        write_progress(int((epoch / epochs) * 100))

    print(f"[Training] Completed in {time.time() - start_time:.2f}s | Best Val IC: {best_val_ic:+.4f}")

    # Binary LUT Exporter
    print("[Export] Exporting zero-copy 24-byte header binary LUTs for Rust Candle...")
    os.makedirs(MODELS_DIR, exist_ok=True)
    lut_binary_data = model.kan_layer.export_luts(lut_size=4096, min_val=-1.0, max_val=1.0)

    with open(TKAN_LUT_PATH, "wb") as f:
        f.write(lut_binary_data)

    file_bytes = os.path.getsize(TKAN_LUT_PATH)
    print(f"         Exported Binary LUTs: '{TKAN_LUT_PATH}' ({file_bytes} bytes)")
    assert file_bytes == 24 + (640 * 4096 * 8), f"Error: Invalid LUT binary file size {file_bytes}!"

    write_progress(100)
    print("=" * 75)
    print("T-KAN TRAINING & LUT EXPORT COMPLETED SUCCESSFULLY [SUCCESS]")
    print("=" * 75)

if __name__ == "__main__":
    train_tkan()
