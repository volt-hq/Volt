---
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-coding-agent": patch
---

fix(agent): Retry transient provider failures even when background results or other input are queued, preventing recoverable errors from prematurely blocking goals.

Queued notices and input are delivered through normal recovery without duplication. Explicit aborts, non-retryable failures, and exhausted retry limits still stop execution.
