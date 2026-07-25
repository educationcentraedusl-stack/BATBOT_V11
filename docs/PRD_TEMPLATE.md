# PRODUCT REQUIREMENT DOCUMENT (PRD): BATBOT_V11

## 1. Core Mission & Constraints (For PM Agent)
* **Project Name:** BATBOT_V11 (Aggressive High-Frequency Profit Hunter)[cite: 13].
* **High-Level Goal:** Transform the BATBOT V10 PRO system into a state-of-the-art High-Frequency Trading (HFT) machine[cite: 13].
* **Target Audience:** Lead Quant Developer / Systems Engineer[cite: 13].
* **Tech Stack Constraints (Strict Rules):**
  * Completely decommission the legacy Python Machine Learning pipeline and Windows Named Pipe communication[cite: 13].
  * Initialize a new Rust library crate[cite: 13].
  * Use a minimalist, high-performance ML framework running natively on Rust, such as `candle-nn` or `burn`[cite: 13].
  * The VPS must be co-located in the same region as the exchange's matching engine (e.g., AWS AP-Northeast-1 for Binance Tokyo) to minimize network jitter[cite: 13].

## 2. Functional Requirements (Atomicity)

* **Feature 1: Rust-Native Data Ingestion & LOB Engine**
  * **Description:** Delegate data ingestion entirely to Rust to avoid burdening the Node.js event loop[cite: 13].
  * **Sub-tasks:**
    1. Use `tokio` and `tokio-tungstenite` crates for asynchronous, non-blocking WebSocket networking[cite: 13].
    2. Programmatically subscribe to `<symbol>@depth20@100ms` (or 50ms) to monitor Order book imbalances, `<symbol>@aggTrade` to identify aggressive taker flow and calculate Cumulative Volume Delta (CVD), and `<symbol>@forceOrder` to monitor immediate liquidation cascades[cite: 13].
    3. Create a local Limit Order Book (LOB) in Rust using lock-free Single-Producer-Single-Consumer (SPSC) primitives like `nexus-slab` or `nexus-channel` for sub-100 microsecond processing[cite: 13].
    4. Calculate Order Book Imbalance (OBI), Cumulative Volume Delta (CVD), and spread velocity upon receiving delta updates, and patch the LOB[cite: 13].
    5. Build a connection manager to handle Binance limits (10 messages per second and 1024 streams per connection)[cite: 13].
    6. Write an overlapping double-connection strategy executed at the 23.5-hour mark to prevent data loss during the exchange's 24-hour socket rotation[cite: 13].

* **Feature 2: Zero-Copy IPC Bridge via N-API**
  * **Description:** Achieve zero-latency communication between Rust and Node.js[cite: 13].
  * **Sub-tasks:**
    1. Use the `napi-rs` framework to compile the Rust ingestion engine into a `.node` native binary[cite: 13].
    2. Allocate a `BufferSlice<'env>` or a continuous `Uint8Array` / `Float64Array` inside the Rust module and map it directly to a Node.js `SharedArrayBuffer`[cite: 13].
    3. Use `std::sync::atomic` operations on a Rust background thread to continuously overwrite data in the `SharedArrayBuffer` without using blocking mutex locks[cite: 13].
    4. Expose a `start_ingestion()` function to initiate the system in Node.js[cite: 13].

* **Feature 3: The Predictive ML Engine**
  * **Description:** Forecast the market's Mid-Frequency timeframe (500 milliseconds to 5 minutes)[cite: 13].
  * **Sub-tasks:**
    1. Implement Closed-form Continuous-depth (CfC) Liquid Neural Networks (LNNs)[cite: 13]. The hidden state must be calculated using the equation: $x(t)=\sigma(-f(x,I;\theta_{f})t)\odot g(x,I;\theta_{g})+[1-\sigma(-[f(x,I;\theta_{f})]t)]\odot h(x,I;\theta_{h})$[cite: 13].
    2. Use Kolmogorov-Arnold Networks (KANs) with cubic B-splines or Hahn polynomials for edge weight parameters to identify complex relationships from level 5 to level 15 in the order book[cite: 13].
    3. Execute these models natively inside the Rust N-API module using `candle-nn` to completely eliminate cross-process serialization[cite: 13].

* **Feature 4: Intelligent Execution Routing**
  * **Description:** Issue orders based on AI signal risk and network latency[cite: 13].
  * **Sub-tasks:**
    1. Mathematically evaluate every signal under the Information Coefficient (IC) and Information Ratio ($IR=IC\times\sqrt{b}$) framework[cite: 13].
    2. **Aggressive Liquidity Seeker Logic:** If signal confidence exceeds the 95th percentile of the 24-hour confidence distribution, cross the spread using an Immediate-Or-Cancel (IOC) market order[cite: 13].
    3. **Passive Maker Logic:** In all other situations (approx. 90% of the time), capture the spread invisibly using Post-Only limit orders[cite: 13].
    4. **Slippage Buffer:** Send orders with a price shifted by 2 to 3 ticks from the exact best bid/ask to counter network delays[cite: 13].
    5. **Dynamic Latency Sizing:** Continuously measure round-trip latency (ping) to the Exchange API[cite: 13]. If latency exceeds 150ms, mathematically reduce the position sizing using a latency penalty coefficient (e.g., from 1.00% to 0.85%)[cite: 13].

## 3. Architecture & V8 Optimization Strict Rules
* Write JavaScript code that supports the V8 Turbofan optimizing compiler[cite: 13].
* Eliminate type polymorphism entirely; prohibit fallback values like `let val = data || 0;` as they de-optimize the V8 engine[cite: 13].
* Use only fixed-size, strongly typed arrays such as `Float64Array`[cite: 13].
* Run the Node.js worker thread as a non-blocking polling loop via `setImmediate` or a micro-timer, and read data using `Atomics.wait()` or `Atomics.load()` immediately after updates in the `SharedArrayBuffer`[cite: 13].
* String parsing and JSON deserialization are strictly forbidden within the Node.js event loop[cite: 13].
* Avoid Node.js Garbage Collection (GC) pauses and JIT compilation fallbacks[cite: 13].

## 4. "Definition of Done" (Reviewer & Critique Loop)
* The compiled system must demonstrate a fully functional zero-copy IPC bridge without any blocking locks[cite: 13].
* Sub-100 microsecond limit order book processing must be verified[cite: 13].
* Zero occurrences of Garbage Collection (GC) pauses and JIT fallbacks in the Node.js control plane[cite: 13].