# AUTONOMIC MEMORY JOURNAL (THE BRAIN)

## Core Architectural Rules (Learned)
* **Financial Fallbacks:** Zero silent financial fallbacks permitted. Never use `.catch(() => null)` in trade execution blocks.

## Structural Learnings & Edge Cases
* **IPC Memory Sync:** V8 Garbage Collector pauses disrupt Rust IPC if buffers are allocated dynamically. 
  * *Fix Applied:* Always pre-allocate `Float64Array` during initialization phase.
* **Sandbox Bypasses:** Do not attempt to use symlinks for file access. All read/write operations must resolve using realpath to prevent sandbox escapes.

## State of the Build
* **2026-07-25 Phase 1 Completion:** Initialized `batbot_v11_core` Rust `cdylib` crate with `napi-rs` (2.16), `candle-core` & `candle-nn` (0.8.2), `tokio` (1.43), and `tokio-tungstenite` (0.26). Initialized strict TypeScript Node.js control plane with `noImplicitAny: true` enforced. Clean compilation verified via `cargo check` and `npm install` / `tsc --noEmit`.