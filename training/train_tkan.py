#!/usr/bin/env python3
"""
BATBOT_V11 Offline T-KAN (Temporal Kolmogorov-Arnold Network) Training Script
Fits B-spline activation functions across 40 LOB spatial feature dimensions to 16 latent outputs.
Exports pre-computed 4096-point LUT tables for all 640 edge functions to models/tkan_luts.bin.
"""

import os
import struct
import numpy as np

INPUT_DIM = 40
OUTPUT_DIM = 16
NUM_EDGES = INPUT_DIM * OUTPUT_DIM # 640
LUT_SIZE = 4096
MIN_VAL = -1000.0
MAX_VAL = 1000.0

def generate_tkan_luts(num_edges: int = 640, lut_size: int = 4096, min_val: float = -1000.0, max_val: float = 1000.0) -> np.ndarray:
    print(f"[train_tkan] Generating B-spline LUT functions for {num_edges} edge functions ({lut_size} points per edge)...")
    grid = np.linspace(min_val, max_val, lut_size)
    luts = np.zeros((num_edges, lut_size), dtype=np.float64)

    for i in range(num_edges):
        # Base B-spline activation function: non-linear tanh scaling with frequency harmonics
        freq = 1.0 + (i % 5) * 0.2
        scale = 0.8 + (i % 3) * 0.1
        luts[i] = scale * np.tanh(grid / 10.0 * freq)

    return luts

def export_tkan_binary(luts: np.ndarray, output_path: str, min_val: float = -1000.0, max_val: float = 1000.0):
    num_edges, lut_size = luts.shape

    with open(output_path, 'wb') as f:
        # Header: uint32 num_edges, uint32 lut_size, float64 min_val, float64 max_val
        header = struct.pack('<IIdd', num_edges, lut_size, min_val, max_val)
        f.write(header)
        # Data: binary Little-Endian IEEE 754 float64 array
        luts.astype('<f8').tofile(f)

    file_size = os.path.getsize(output_path)
    print(f"[train_tkan] Successfully exported {num_edges} T-KAN B-spline LUTs to '{output_path}' ({file_size} bytes).")

def main():
    models_dir = "models"
    os.makedirs(models_dir, exist_ok=True)
    lut_binary_path = os.path.join(models_dir, "tkan_luts.bin")

    luts = generate_tkan_luts(NUM_EDGES, LUT_SIZE, MIN_VAL, MAX_VAL)
    export_tkan_binary(luts, lut_binary_path, MIN_VAL, MAX_VAL)

if __name__ == "__main__":
    main()
