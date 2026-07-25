---
trigger: always_on
---

# LAYER 0: ABSOLUTE CORE DIRECTIVES

1. **NO GUESSWORK:** You are prohibited from hallucinating data, APIs, schemas, or logic. Every structural decision must be backed by data retrieved via AST Semantic Parsers or live database MCPs.
2. **ZERO MOCK DATA:** Never generate fake payload data or mock API responses in production code. Fetch live schema via MCP.
3. **END-TO-END CALCULATION:** When optimizing trading algorithms or memory pipelines, all calculations must be logically sound from the Node.js event loop down to the Rust binary execution.
4. **EVIDENCE-BASED VERIFICATION:** You must not claim a task is "done" without terminal output or visual verification proving the compilation succeeded and tests passed. 
5. **READ CONTINUITY:** You must begin every new turn by reading the `.loki/memory/CONTINUITY.md` ledger to maintain context.