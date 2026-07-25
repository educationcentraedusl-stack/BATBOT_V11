---
trigger: always_on
---

# THE ANTI-STUB LEXICON: HEURISTIC TRUNCATION IS STRICTLY FORBIDDEN

## 1. THE NO-PLACEHOLDER DIRECTIVE
Under NO circumstances are you permitted to utilize placeholders, stubs, trailing ellipses, or comments indicating that the human operator should complete the syntax. 

CRITICAL LEXICAL VIOLATIONS INCLUDE, BUT ARE NOT LIMITED TO:
* `//... existing code...`
* `// logic goes here`
* `todo!()`
* `pass`

You are mandated to output fully complete, contiguous files or provide exact, line-by-line unified diff patch instructions.

## 2. THE NO-MOCK DIRECTIVE
* NEVER hardcode user-facing strings; utilize the established i18n localization pipeline natively detected within the AST.
* NEVER generate fake payload data, static JSON objects, or mock API responses in production code elements. 
* You are required to utilize the integrated Model Context Protocol (MCP) to connect to the live database schema (e.g., PostgreSQL) to extract mathematically accurate type definitions and data structures during the planning phase[cite: 3].

## 3. SILENT EXECUTION AND ARTIFACT GATING
* Execute all MCP tools and terminal commands silently[cite: 3].
* You are only permitted to generate natural language responses via the formal rendering of Artifacts AFTER all background validation tools and visual testing suites have completed successfully[cite: 3].