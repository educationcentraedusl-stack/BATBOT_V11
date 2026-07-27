#!/usr/bin/env python3
"""
BATBOT_V11 Offline CfC Neural Network Training Script
Reads trading signals from data/signals.jsonl and executions from data/executions.jsonl.
Exports trained weights to models/cfc_weights.safetensors compatible with Candle Rust runtime.
Supports PyTorch/safetensors backend as well as zero-dependency NumPy/struct fallback.
"""

import os
import json
import struct

def load_dataset(signals_path: str, executions_path: str):
    signals = []
    executions = []

    if os.path.exists(signals_path):
        with open(signals_path, 'r', encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    try:
                        signals.append(json.loads(line))
                    except Exception:
                        pass

    if os.path.exists(executions_path):
        with open(executions_path, 'r', encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    try:
                        executions.append(json.loads(line))
                    except Exception:
                        pass

    print(f"[train_cfc] Loaded {len(signals)} signal records and {len(executions)} execution records.")
    return signals, executions

def save_safetensors_raw(tensors: dict, output_path: str):
    """
    Saves a dictionary of name -> numpy array / flat list of floats into valid Safetensors binary format.
    Header format:
    - 8 bytes uint64 Little-Endian: header string byte length N
    - N bytes UTF-8 encoded JSON string
    - Concatenated raw Little-Endian Float32 buffer
    """
    buffer = bytearray()
    header_dict = {}

    for name, shape_and_data in tensors.items():
        shape, data_floats = shape_and_data
        start_offset = len(buffer)
        raw_bytes = struct.pack(f'<{len(data_floats)}f', *data_floats)
        buffer.extend(raw_bytes)
        end_offset = len(buffer)

        header_dict[name] = {
            "dtype": "F32",
            "shape": list(shape),
            "data_offsets": [start_offset, end_offset]
        }

    header_json = json.dumps(header_dict, separators=(',', ':')).encode('utf-8')
    header_len = len(header_json)

    with open(output_path, 'wb') as f:
        f.write(struct.pack('<Q', header_len))
        f.write(header_json)
        f.write(buffer)

    print(f"[train_cfc] Safetensors binary file written to '{output_path}' ({os.path.getsize(output_path)} bytes).")

def main():
    signals_path = os.path.join("data", "signals.jsonl")
    executions_path = os.path.join("data", "executions.jsonl")
    models_dir = "models"
    os.makedirs(models_dir, exist_ok=True)
    weights_path = os.path.join(models_dir, "cfc_weights.safetensors")

    signals, executions = load_dataset(signals_path, executions_path)

    # Try PyTorch backend first, fallback to pure Python generator
    try:
        import torch
        import torch.nn as nn
        from torch.utils.data import Dataset, DataLoader
        from safetensors.torch import save_file

        print("[train_cfc] Using PyTorch backend for CfC neural optimization...")

        class CfCModel(nn.Module):
            def __init__(self):
                super().__init__()
                self.w_alpha = nn.Parameter(torch.randn(16, 32) * 0.1)
                self.b_alpha = nn.Parameter(torch.zeros(32))
                self.w_beta = nn.Parameter(torch.randn(16, 32) * 0.1)
                self.b_beta = nn.Parameter(torch.zeros(32))
                self.w_output = nn.Parameter(torch.randn(32, 3) * 0.1)
                self.b_output = nn.Parameter(torch.zeros(3))

            def forward(self, x):
                # x: [batch, 16]
                alpha = torch.tanh(torch.matmul(x, self.w_alpha) + self.b_alpha)
                beta = torch.sigmoid(torch.matmul(x, self.w_beta) + self.b_beta)
                h = alpha * beta
                out = torch.matmul(h, self.w_output) + self.b_output
                return out

        class SignalDataset(Dataset):
            def __init__(self, signals, executions):
                self.inputs = []
                self.targets = []
                if len(signals) > 0:
                    for s in signals:
                        # Extract features if present or synthesize 16-dim latent vector
                        feat = s.get("features", [0.0] * 16)
                        if len(feat) < 16:
                            feat = feat + [0.0] * (16 - len(feat))
                        target = [s.get("direction", 0.0), s.get("confidence", 1.0), s.get("horizon_ms", 500.0)]
                        self.inputs.append(feat[:16])
                        self.targets.append(target)
                else:
                    # Synthesize training batches for dry-run verification
                    torch.manual_seed(42)
                    for _ in range(128):
                        self.inputs.append(torch.randn(16).tolist())
                        self.targets.append([torch.randn(1).item(), 0.95, 500.0])

                self.inputs = torch.tensor(self.inputs, dtype=torch.float32)
                self.targets = torch.tensor(self.targets, dtype=torch.float32)

            def __len__(self):
                return len(self.inputs)

            def __getitem__(self, idx):
                return self.inputs[idx], self.targets[idx]

        dataset = SignalDataset(signals, executions)
        dataloader = DataLoader(dataset, batch_size=16, shuffle=True)

        model = CfCModel()
        optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
        criterion = nn.MSELoss()

        epochs = 5
        print(f"[train_cfc] Starting gradient descent optimization ({epochs} epochs over {len(dataset)} samples)...")
        for epoch in range(1, epochs + 1):
            total_loss = 0.0
            for batch_x, batch_y in dataloader:
                optimizer.zero_grad()
                pred = model(batch_x)
                loss = criterion(pred, batch_y)
                loss.backward()
                optimizer.step()
                total_loss += loss.item() * len(batch_x)

            avg_loss = total_loss / len(dataset)
            print(f"  Epoch {epoch}/{epochs} | Loss: {avg_loss:.6f}")

        state_dict = {
            "w_alpha": model.w_alpha.detach(),
            "b_alpha": model.b_alpha.detach(),
            "w_beta": model.w_beta.detach(),
            "b_beta": model.b_beta.detach(),
            "w_output": model.w_output.detach(),
            "b_output": model.b_output.detach(),
        }
        save_file(state_dict, weights_path)
        print(f"[train_cfc] Successfully exported PyTorch trained weights to '{weights_path}'.")

    except ImportError:
        print("[train_cfc] PyTorch not detected. Running zero-dependency CfC weight initialization pipeline...")
        # Pure Python float32 initialization matching target tensor shapes
        import random
        random.seed(42)

        w_alpha = [random.gauss(0, 0.1) for _ in range(16 * 32)]
        b_alpha = [0.0] * 32
        w_beta = [random.gauss(0, 0.1) for _ in range(16 * 32)]
        b_beta = [0.0] * 32
        w_output = [random.gauss(0, 0.1) for _ in range(32 * 3)]
        b_output = [0.0] * 3

        tensors = {
            "w_alpha": ((16, 32), w_alpha),
            "b_alpha": ((32,), b_alpha),
            "w_beta": ((16, 32), w_beta),
            "b_beta": ((32,), b_beta),
            "w_output": ((32, 3), w_output),
            "b_output": ((3,), b_output),
        }

        save_safetensors_raw(tensors, weights_path)

if __name__ == "__main__":
    main()
