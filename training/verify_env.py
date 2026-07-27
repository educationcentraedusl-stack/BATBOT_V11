#!/usr/bin/env python3
"""
BATBOT_V11 Offline AI Training Environment Verification Harness
Verifies PyTorch, CUDA/CPU hardware acceleration, SafeTensors zero-copy IO,
NCPS Liquid Neural Network (CfC), and PyKAN (Kolmogorov-Arnold Network) instantiations.
"""

import sys
import os
import time

def verify_environment():
    print("=" * 70)
    print("BATBOT_V11 OFFLINE AI TRAINING ENVIRONMENT VERIFICATION SUITE")
    print("=" * 70)
    
    # 1. Check Python Runtime
    print(f"[1/5] Python Runtime: {sys.version.split()[0]} ({sys.platform})")
    
    # 2. Check PyTorch & Hardware Acceleration
    try:
        import torch
        print(f"[2/5] PyTorch Version: {torch.__version__}")
        cuda_available = torch.cuda.is_available()
        if cuda_available:
            device_name = torch.cuda.get_device_name(0)
            capability = torch.cuda.get_device_capability(0)
            print(f"      CUDA Acceleration: ENABLED (GPU: {device_name}, Compute Capability: {capability[0]}.{capability[1]})")
            device = torch.device("cuda")
        else:
            print("      CUDA Acceleration: CPU Mode (CUDA not detected / CPU fallback operational)")
            device = torch.device("cpu")
            
        # Test basic tensor allocation and matrix multiplication
        x = torch.randn(64, 64, device=device)
        y = torch.randn(64, 64, device=device)
        z = torch.matmul(x, y)
        print(f"      Tensor MatMul Output Shape: {z.shape} on {z.device} -> PASSED")
    except Exception as e:
        print(f"[2/5] PyTorch Verification FAILED: {e}")
        return False

    # 3. Check SafeTensors Zero-Copy Serialization
    try:
        import safetensors
        from safetensors.torch import save_file, load_file
        print(f"[3/5] SafeTensors Version: {safetensors.__version__}")
        
        test_dict = {
            "weight_matrix": torch.randn(16, 32, dtype=torch.float32),
            "bias_vector": torch.zeros(32, dtype=torch.float32)
        }
        test_file = os.path.join("training", "temp_verify.safetensors") if os.path.exists("training") else "temp_verify.safetensors"
        save_file(test_dict, test_file)
        loaded_dict = load_file(test_file)
        
        assert "weight_matrix" in loaded_dict
        assert loaded_dict["weight_matrix"].shape == (16, 32)
        del loaded_dict
        if os.path.exists(test_file):
            try:
                os.remove(test_file)
            except Exception:
                pass
        print(f"      SafeTensors Zero-Copy Save & Load -> PASSED")
    except Exception as e:
        print(f"[3/5] SafeTensors Verification FAILED: {e}")
        return False

    # 4. Check NCPS (Neural Circuit Policies / Closed-Form Continuous-Time - CfC)
    try:
        import ncps
        from ncps.torch import CfC
        print(f"[4/5] NCPS Version: {ncps.__version__}")
        
        # Instantiate a CfC Liquid Neural Network cell (input_size=16, units=32)
        cfc_layer = CfC(input_size=16, units=32, proj_size=3)
        dummy_input = torch.randn(8, 10, 16) # [batch, sequence_length, features]
        output, _ = cfc_layer(dummy_input)
        print(f"      NCPS CfC Layer Forward Pass Output Shape: {output.shape} -> PASSED")
    except Exception as e:
        print(f"[4/5] NCPS Verification FAILED: {e}")
        return False

    # 5. Check PyKAN (Kolmogorov-Arnold Network)
    try:
        import kan
        print(f"[5/5] PyKAN (Kolmogorov-Arnold Network) Module Imported Successfully")
        
        # Instantiate KAN model: 2D input -> 5 hidden -> 1 output
        model = kan.KAN(width=[2, 5, 1], grid=5, k=3, seed=42)
        dummy_kan_input = torch.randn(16, 2)
        kan_out = model(dummy_kan_input)
        print(f"      PyKAN Spline Model Forward Pass Output Shape: {kan_out.shape} -> PASSED")
    except Exception as e:
        print(f"[5/5] PyKAN Verification FAILED: {e}")
        return False

    print("=" * 70)
    print("ALL ML LIBRARIES AND HARDWARE VERIFICATIONS PASSED SUCCESSFULLY [SUCCESS]")
    print("=" * 70)
    return True

if __name__ == "__main__":
    success = verify_environment()
    sys.exit(0 if success else 1)
