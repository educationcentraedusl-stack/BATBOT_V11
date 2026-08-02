#!/usr/bin/env python3
"""
BATBOT_V11 2026 SOTA Decoupled Asynchronous Remote Cloud GPU Trainer (Modal Serverless)
Decouples PyTorch Closed-Form Continuous-Time (CfC) model training to high-performance remote GPUs
using persistent Modal Volume storage (`modal.Volume`) and non-blocking asynchronous job dispatch:
1. POST /submit-job: Saves dataset to Modal Volume, spawns async GPU task, returns 202 Accepted in <100ms.
2. Async GPU Worker: Reads dataset from Volume, executes PyTorch 2.6 BF16 AMP training, saves weights to Volume.
3. GET /job-status?job_id=XYZ: Returns status (QUEUED -> PROCESSING -> COMPLETED) in <50ms.
4. GET /download-weights?job_id=XYZ: Streams trained SafeTensors model weights directly to client.
"""

import io
import os
import math
import time
import json
import uuid
import modal
import fastapi
from fastapi import Response
from fastapi.responses import StreamingResponse

# 1. Define Modal Container Environment Image
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch>=2.6.0",
        "safetensors",
        "fastapi",
        "numpy"
    )
)

# 2. Define Modal App & Persistent Shared Volume Storage
app = modal.App("batbot-cfc-trainer")
volume = modal.Volume.from_name("batbot-hft-storage", create_if_missing=True)
STORAGE_DIR = "/storage"

# 3. Model Architecture & Training Pipeline (Loaded dynamically inside Modal Container)
def execute_training_pipeline(body_bytes: bytes) -> bytes:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import TensorDataset, DataLoader
    from safetensors.torch import load, save

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

            z_prev = torch.zeros(batch_size, self.hidden_dim, device=device)
            outputs = []

            for t in range(seq_len):
                x_t = input_seq[:, t, :]  # [Batch, 16]

                delta_t = x_t[:, 15:16].abs() + 1e-4  # [Batch, 1]
                chi = torch.cat([x_t, z_prev], dim=-1)

                alpha = F.softplus(chi @ self.w_alpha + self.b_alpha)
                beta = torch.tanh(chi @ self.w_beta + self.b_beta)

                decay_factor = torch.exp(-alpha * delta_t)
                z_t = beta - (beta - z_prev) * decay_factor

                output_t = z_t @ self.w_output + self.b_output
                outputs.append(output_t.unsqueeze(1))

                z_prev = z_t

            return torch.cat(outputs, dim=1)  # [Batch, SeqLen, 1]

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

    start_time = time.time()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[Modal Worker] Device target: {device} ({torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'})")

    dataset_tensors = load(body_bytes)
    x_train_raw = dataset_tensors["train_inputs"].to(device, non_blocking=True)
    y_train_raw = dataset_tensors["train_targets"].to(device, non_blocking=True)
    x_val_raw = dataset_tensors["val_inputs"].to(device, non_blocking=True)
    y_val_raw = dataset_tensors["val_targets"].to(device, non_blocking=True)

    if x_train_raw.dim() == 2:
        x_train, y_train = create_cfc_sequences_strided_torch(x_train_raw, y_train_raw, 32)
        x_val, y_val = create_cfc_sequences_strided_torch(x_val_raw, y_val_raw, 32)
        print(f"[Modal Worker] Unfolded 2D feature matrix into 3D sequences: train={x_train.shape}, val={x_val.shape}")
    else:
        x_train, y_train = x_train_raw, y_train_raw
        x_val, y_val = x_val_raw, y_val_raw

    train_samples = x_train.shape[0]
    val_samples = x_val.shape[0]
    print(f"[Modal Worker] Dataset received: {train_samples} train sequences, {val_samples} val sequences.")

    if train_samples == 0:
        raise ValueError("Dataset contains 0 train sequences.")

    batch_size = 8192
    train_dataset = TensorDataset(x_train, y_train)
    val_dataset = TensorDataset(x_val, y_val)

    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)

    raw_model = RemoteCfCCell(input_dim=16, hidden_dim=32, output_dim=1).to(device)
    model = raw_model

    criterion = HuberICLoss(delta=1e-3, ic_weight=0.5)

    epochs = 20
    total_steps = max(1, epochs * len(train_loader))
    optimizer = torch.optim.AdamW(raw_model.parameters(), lr=2e-3, weight_decay=1e-4, amsgrad=True)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=2e-3, total_steps=total_steps, pct_start=0.1
    )

    use_amp = device.type == "cuda"
    amp_dtype = torch.bfloat16 if (use_amp and torch.cuda.is_bf16_supported()) else torch.float16
    best_val_ic = -1.0

    for epoch in range(1, epochs + 1):
        raw_model.train()
        last_loss = 0.0
        for bx, by in train_loader:
            if bx.shape[1] == 0:
                continue

            optimizer.zero_grad()

            if use_amp:
                with torch.autocast('cuda', dtype=amp_dtype):
                    pred = model(bx)
                    loss, h_loss, ic = criterion(pred, by)
            else:
                pred = model(bx)
                loss, h_loss, ic = criterion(pred, by)

            loss.backward()
            torch.nn.utils.clip_grad_norm_(raw_model.parameters(), max_norm=1.0)
            optimizer.step()
            scheduler.step()

            last_loss = loss.item()

        if val_samples > 0:
            raw_model.eval()
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

        if epoch % 5 == 0 or epoch == epochs:
            print(f"[Modal GPU Epoch {epoch:02d}/{epochs}] Loss: {last_loss:.6f} | Best Val IC: {best_val_ic:+.4f}")

    exec_duration = time.time() - start_time
    print(f"[Modal Worker] Training complete in {exec_duration:.3f}s | Best Val IC: {best_val_ic:+.4f}")

    weight_tensors = {
        "w_alpha": raw_model.w_alpha.detach().cpu().contiguous(),
        "b_alpha": raw_model.b_alpha.detach().cpu().contiguous(),
        "w_beta": raw_model.w_beta.detach().cpu().contiguous(),
        "b_beta": raw_model.b_beta.detach().cpu().contiguous(),
        "w_output": raw_model.w_output.detach().cpu().contiguous(),
        "b_output": raw_model.b_output.detach().cpu().contiguous(),
    }

    return save(weight_tensors)


# 4. Asynchronous Modal Functions & Storage Workers
@app.function(gpu="T4", image=image, volumes={STORAGE_DIR: volume}, timeout=900, scaledown_window=300)
def process_job_gpu(job_id: str):
    """
    Asynchronous GPU Training Task spawned by submit_job webhook.
    Reads /storage/jobs/{job_id}/cfc_features.safetensors, executes PyTorch training,
    saves trained weights to /storage/jobs/{job_id}/cfc_weights.safetensors, and updates status.json.
    """
    volume.reload()
    job_dir = os.path.join(STORAGE_DIR, "jobs", job_id)
    dataset_path = os.path.join(job_dir, "cfc_features.safetensors")
    weights_path = os.path.join(job_dir, "cfc_weights.safetensors")
    status_path = os.path.join(job_dir, "status.json")

    status_data = {"status": "PROCESSING", "jobId": job_id, "updatedAt": time.time()}
    with open(status_path, "w") as f:
        json.dump(status_data, f)
    volume.commit()

    try:
        with open(dataset_path, "rb") as f:
            body_bytes = f.read()

        serialized_weights = execute_training_pipeline(body_bytes)

        with open(weights_path, "wb") as f:
            f.write(serialized_weights)

        status_data = {
            "status": "COMPLETED",
            "jobId": job_id,
            "weightsSize": len(serialized_weights),
            "updatedAt": time.time(),
        }
        with open(status_path, "w") as f:
            json.dump(status_data, f)
        volume.commit()
    except Exception as e:
        status_data = {
            "status": "FAILED",
            "jobId": job_id,
            "error": str(e),
            "updatedAt": time.time(),
        }
        with open(status_path, "w") as f:
            json.dump(status_data, f)
        volume.commit()
        raise e


@app.function(gpu="T4", image=image, volumes={STORAGE_DIR: volume}, timeout=900, scaledown_window=300)
def train_cfc_direct(body_bytes: bytes) -> bytes:
    """
    Direct Synchronous Modal Function for Python SDK invocation over gRPC.
    """
    return execute_training_pipeline(body_bytes)


# 5. 2026 SOTA Decoupled Webhook Endpoints
@app.function(image=image, volumes={STORAGE_DIR: volume}, timeout=60)
@modal.fastapi_endpoint(method="POST")
async def submit_job(request: fastapi.Request):
    """
    POST /submit-job (or /api/submit-job)
    Submits binary SafeTensors dataset, persists to volume, spawns async GPU task,
    and returns 202 Accepted { jobId, status: "QUEUED" } in <100ms.
    """
    secret_token = os.environ.get("HFT_SECRET_TOKEN")
    if secret_token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header != f"Bearer {secret_token}":
            return Response(content=b"Error: Unauthorized request.", status_code=401)

    body_bytes = await request.body()
    if not body_bytes or len(body_bytes) < 64:
        return Response(content=b"Error: Invalid or empty dataset.", status_code=400)

    job_id = f"job_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
    job_dir = os.path.join(STORAGE_DIR, "jobs", job_id)
    os.makedirs(job_dir, exist_ok=True)

    dataset_path = os.path.join(job_dir, "cfc_features.safetensors")
    status_path = os.path.join(job_dir, "status.json")

    with open(dataset_path, "wb") as f:
        f.write(body_bytes)

    status_data = {"status": "QUEUED", "jobId": job_id, "submittedAt": time.time()}
    with open(status_path, "w") as f:
        json.dump(status_data, f)

    volume.commit()

    # Spawn async background GPU worker
    process_job_gpu.spawn(job_id)

    return fastapi.responses.JSONResponse(
        content={"jobId": job_id, "status": "QUEUED", "message": "Job submitted successfully."},
        status_code=202,
    )


@app.function(image=image, volumes={STORAGE_DIR: volume}, timeout=30)
@modal.fastapi_endpoint(method="GET")
async def job_status(request: fastapi.Request, job_id: str = ""):
    """
    GET /job-status?job_id=job_123
    Returns job status JSON in <50ms.
    """
    volume.reload()
    if not job_id:
        job_id = request.query_params.get("job_id", "")
    if not job_id:
        return Response(content=b"Error: Missing job_id query parameter.", status_code=400)

    status_path = os.path.join(STORAGE_DIR, "jobs", job_id, "status.json")
    if not os.path.exists(status_path):
        return fastapi.responses.JSONResponse(
            content={"status": "NOT_FOUND", "jobId": job_id},
            status_code=404,
        )

    with open(status_path, "r") as f:
        status_data = json.load(f)

    return fastapi.responses.JSONResponse(content=status_data, status_code=200)


@app.function(image=image, volumes={STORAGE_DIR: volume}, timeout=60)
@modal.fastapi_endpoint(method="GET")
async def download_weights(request: fastapi.Request, job_id: str = ""):
    """
    GET /download-weights?job_id=job_123
    Streams trained SafeTensors model weights binary file.
    """
    volume.reload()
    if not job_id:
        job_id = request.query_params.get("job_id", "")
    if not job_id:
        return Response(content=b"Error: Missing job_id query parameter.", status_code=400)

    weights_path = os.path.join(STORAGE_DIR, "jobs", job_id, "cfc_weights.safetensors")
    if not os.path.exists(weights_path):
        return Response(content=b"Error: Weights not found for job_id.", status_code=404)

    with open(weights_path, "rb") as f:
        weights_bytes = f.read()

    return StreamingResponse(
        io.BytesIO(weights_bytes),
        media_type="application/octet-stream",
        headers={"Content-Length": str(len(weights_bytes))},
    )


@app.function(gpu="T4", image=image, volumes={STORAGE_DIR: volume}, timeout=900, scaledown_window=300)
@modal.fastapi_endpoint(method="POST")
async def train_cfc_webhook(request: fastapi.Request):
    """
    Legacy Synchronous Serverless Webhook Endpoint (Retained for backward compatibility).
    """
    secret_token = os.environ.get("HFT_SECRET_TOKEN")
    if secret_token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header != f"Bearer {secret_token}":
            return Response(content=b"Error: Unauthorized request.", status_code=401)

    body_bytes = await request.body()
    if not body_bytes or len(body_bytes) < 64:
        return Response(content=b"Error: Invalid or empty SafeTensors dataset payload.", status_code=400)

    try:
        serialized_weights = execute_training_pipeline(body_bytes)
        return StreamingResponse(
            io.BytesIO(serialized_weights),
            media_type="application/octet-stream",
            headers={"Content-Length": str(len(serialized_weights))},
        )
    except Exception as e:
        return Response(content=f"Error: {str(e)}".encode("utf-8"), status_code=500)


@app.local_entrypoint()
def main():
    project_root = os.getcwd()
    dataset_path = os.path.join(project_root, "data", "cfc_features.safetensors")
    weights_path = os.path.join(project_root, "models", "cfc_weights.safetensors")

    if not os.path.exists(dataset_path):
        print(f"❌ Dataset file missing at '{dataset_path}'")
        return

    print(f"[Local Entrypoint] Reading dataset from '{dataset_path}' ({os.path.getsize(dataset_path)} bytes)...")
    with open(dataset_path, "rb") as f:
        dataset_bytes = f.read()

    print("[Local Entrypoint] Offloading to Modal Serverless Cloud GPU (NVIDIA T4)...")
    weights_bytes = train_cfc_direct.remote(dataset_bytes)

    os.makedirs(os.path.dirname(weights_path), exist_ok=True)
    with open(weights_path, "wb") as f:
        f.write(weights_bytes)

    print(f"[Local Entrypoint] SUCCESS: SafeTensors weights saved ({len(weights_bytes)} bytes) to '{weights_path}'!")
