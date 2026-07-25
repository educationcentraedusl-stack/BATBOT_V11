# BATBOT_V11: C4 ARCHITECTURE MAP

## System Context
* **Node.js Control Plane:** Manages WebSocket data ingestion, API routing, and high-level orchestration.
* **Rust Data Plane (N-API):** Handles deterministic matching engine, zero-latency deserialization, and binary operations.
* **Memory Bridge:** SharedArrayBuffer linking Node.js and Rust environments.

## Component Boundaries (Strict Segregation)
* `src/trading_engine/` - Restricted to Rust Core logic. Modifying this requires triggering rigorous latency benchmarks.
* `src/api_gateway/` - Restricted to TypeScript/Express logic. 
* `src/shared_memory/` - The IPC boundary. Changes here require cross-language validation.

## Execution Constraint
Agent must reference this map before modifying any utility functions to prevent breaking dependencies in un-indexed microservices. Global refactors without explicit approval are denied.