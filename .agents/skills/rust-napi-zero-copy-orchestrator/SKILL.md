---
name: rust-napi-zero-copy-orchestrator
description: Strict instructions for generating zero-latency Node.js to Rust IPC bindings using SharedArrayBuffer. Use when generating or modifying HFT pipeline code.
---

# Rust N-API Optimization Protocol

1. **Zero-Copy Rule:** Never copy memory between the V8 engine and the Rust binary.
2. **Memory Mapping:** Always map `Float64Array` views directly to Rust `*mut f64` pointers.
3. **No JSON:** Reject any standard JSON serialization paradigms for inter-process communication.
4. **Execution Protocol:** Apply these rules strictly. If the required buffer offsets do not match, invoke the PostgreSQL MCP server to retrieve the live telemetry before compilation.