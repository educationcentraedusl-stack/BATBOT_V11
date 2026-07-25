# AUTONOMIC MEMORY JOURNAL (THE BRAIN)

## Core Architectural Rules (Learned)
* **Financial Fallbacks:** Zero silent financial fallbacks permitted. Never use `.catch(() => null)` in trade execution blocks.

## Structural Learnings & Edge Cases
* **IPC Memory Sync:** V8 Garbage Collector pauses disrupt Rust IPC if buffers are allocated dynamically. 
  * *Fix Applied:* Always pre-allocate `Float64Array` during initialization phase.
* **Sandbox Bypasses:** Do not attempt to use symlinks for file access. All read/write operations must resolve using realpath to prevent sandbox escapes.

## State of the Build
* [Librarian Agent: Append the structural state and timestamp upon successful QA verification of each feature.]