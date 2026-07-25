---
trigger: always_on
---

# LAYER 1: STRICT TECHNOLOGY CONSTRAINTS FOR HFT PIPELINE

## 1. Node.js & TypeScript Constraints
* **Language:** TypeScript strictly. `noImplicitAny: true` must be enforced.
* **Prohibited Types:** The use of `any` type casting is strictly forbidden.
* **Prohibited Syntaxes:** The use of `// @ts-ignore` is fundamentally severed and will cause an execution rollback.
* **Silent Fallbacks:** Zero silent financial fallbacks. Do not use `|| 0` or `.catch(() => null)`. 

## 2. Rust & N-API Zero-Copy Optimization Protocol
* **Memory Management:** Never copy memory between the V8 engine and the Rust binary. You must utilize `SharedArrayBuffer` for zero-copy inter-process communication (IPC).
* **Pointer Mapping:** Always map `Float64Array` views directly to Rust `*mut f64` pointers.
* **Prohibited Macros/Methods:** The BATBOT_V11 pipeline cannot tolerate `.unwrap()`, `.expect()`, or `unimplemented!()` macros in Rust. These induce thread panics and latency spikes and are strictly forbidden. Handle all `Result` and `Option` types explicitly.
* **Serialization:** Reject any standard JSON serialization paradigms for IPC messaging. 

## 3. Latency Benchmarking
* All generated Rust modules must be benchmarked. If execution time exceeds 1.5 microseconds, the code is considered failed and must be refactored autonomously before Artifact presentation.