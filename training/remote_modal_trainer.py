#!/usr/bin/env python3
"""
BATBOT_V11 SOTA Remote Cloud GPU Trainer (Modal Serverless Webhook)
Decouples PyTorch Closed-Form Continuous-Time (CfC) model training to high-performance remote GPUs.
Receives binary dataset SafeTensors via HTTP POST, executes FP16 AMP training on CUDA (NVIDIA T4/L4),
and streams back trained model weights serialized in SafeTensors format.
"""

import io
import math
import time
import modal
import fastapi
from fastapi import Response

# 1. Define Modal Container Environment Image
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch",
        "safetensors",
        "fastapi",
        "numpy"
    )
)

# 2. Define Modal App
app = modal.App("batbot-cfc-trainer")

# Import PyTorch & SafeTensors inside container / module scope
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import TensorDataset, DataLoader
from safetensors.torch import load, save


# 3. Model Architecture (Exact Self-Contained PyTorch CfC Cell)
class RemoteCfCCell(nn.Module):
    """
    Exact PyTorch implementation of the 2026 Closed-Form Continuous-Time (CfC) cell
    matching the Candle Rust formulation in src/ai/cfc.rs.
    """
    def __init__(self, input_dim: int = 16, hidden_dim: int = 32, output_dim: int = 1):
        super().__init__()
        self.input_dim = input_dim
        self.hidden_dim = hidden_dim
        self.output_dim = output_dim
        concat_dim = input_dim + hidden_dim  # 48

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
            x_t = input_seq[:, t, :]  # [Batch, 16]

            # Delta t extracted from column 15 (delta_tau) or defaulted to 0.001s
            delta_t = x_t[:, 15:16].abs() + 1e-4  # [Batch, 1]

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

        return torch.cat(outputs, dim=1)  # [Batch, SeqLen, 1]


class HuberICLoss(nn.Module):
    """
    Combined Huber + Pearson Rank Correlation (IC) loss for high-precision trade ranking.
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

        # Maximize IC -> minimize 1.0 - IC
        loss = h_loss + self.ic_weight * (1.0 - ic)
        return loss, h_loss, ic


# 4. Serverless GPU Webhook Function
@app.function(gpu="T4", image=image, timeout=300)
@modal.fastapi_endpoint(method="POST")
async def train_cfc_webhook(request: fastapi.Request) -> Response:
    """
    High-Speed Serverless Training Webhook:
    - Receives dataset SafeTensors binary payload via HTTP POST body.
    - Trains PyTorch CfC cell on NVIDIA GPU using CUDA + AMP FP16.
    - Returns serialized SafeTensors weight buffer.
    """
    start_time = time.time()

    # Read incoming binary payload
    body_bytes = await request.body()
    if not body_bytes or len(body_bytes) < 64:
        return Response(
            content=b"Error: Invalid or empty SafeTensors dataset payload.",
            status_code=400,
            media_type="text/plain",
        )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[Modal Worker] Device target: {device} ({torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'})")

    # Deserialize dataset SafeTensors directly from memory
    try:
        dataset_tensors = load(body_bytes)
        x_train = dataset_tensors["train_inputs"].to(device, non_blocking=True)
        y_train = dataset_tensors["train_targets"].to(device, non_blocking=True)
        x_val = dataset_tensors["val_inputs"].to(device, non_blocking=True)
        y_val = dataset_tensors["val_targets"].to(device, non_blocking=True)
    except Exception as e:
        return Response(
            content=f"Error parsing SafeTensors dataset payload: {str(e)}".encode("utf-8"),
            status_code=400,
            media_type="text/plain",
        )

    train_samples = x_train.shape[0]
    val_samples = x_val.shape[0]
    print(f"[Modal Worker] Dataset received: {train_samples} train sequences, {val_samples} val sequences.")

    if train_samples == 0:
        return Response(
            content=b"Error: Dataset contains 0 train sequences.",
            status_code=400,
            media_type="text/plain",
        )

    batch_size = 256
    train_dataset = TensorDataset(x_train, y_train)
    val_dataset = TensorDataset(x_val, y_val)

    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)

    model = RemoteCfCCell(input_dim=16, hidden_dim=32, output_dim=1).to(device)
    criterion = HuberICLoss(delta=1e-3, ic_weight=0.5)

    epochs = 35
    total_steps = max(1, epochs * len(train_loader))
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4, amsgrad=True)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=1e-3, total_steps=total_steps, pct_start=0.1
    )

    use_amp = device.type == "cuda"
    scaler = torch.cuda.amp.GradScaler() if use_amp else None

    # High-Performance Training Loop
    best_val_ic = -1.0
    for epoch in range(1, epochs + 1):
        model.train()
        for bx, by in train_loader:
            if bx.shape[1] == 0:
                continue

            optimizer.zero_grad()

            if use_amp and scaler is not None:
                with torch.cuda.amp.autocast():
                    pred = model(bx)
                    loss, h_loss, ic = criterion(pred, by)

                scaler.scale(loss).backward()
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                scaler.step(optimizer)
                scaler.update()
            else:
                pred = model(bx)
                loss, h_loss, ic = criterion(pred, by)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                optimizer.step()

            scheduler.step()

        # Quick validation evaluation
        if val_samples > 0:
            model.eval()
            val_ic_sum = 0.0
            val_count = 0
            with torch.no_grad():
                for bx, by in val_loader:
                    if bx.shape[1] == 0:
                        continue
                    if use_amp:
                        with torch.cuda.amp.autocast():
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

    exec_duration = time.time() - start_time
    print(f"[Modal Worker] Training complete in {exec_duration:.3f}s | Best Val IC: {best_val_ic:+.4f}")

    # Serialize trained weights into SafeTensors byte buffer
    weight_tensors = {
        "w_alpha": model.w_alpha.detach().cpu().contiguous(),
        "b_alpha": model.b_alpha.detach().cpu().contiguous(),
        "w_beta": model.w_beta.detach().cpu().contiguous(),
        "b_beta": model.b_beta.detach().cpu().contiguous(),
        "w_output": model.w_output.detach().cpu().contiguous(),
        "b_output": model.b_output.detach().cpu().contiguous(),
    }

    serialized_weights = save(weight_tensors)
    print(f"[Modal Worker] Exported SafeTensors binary stream ({len(serialized_weights)} bytes). Returning HTTP 200.")

    return Response(content=serialized_weights, media_type="application/octet-stream")
