---
"@hansjm10/volt-coding-agent": patch
---

feature(prompt-cache): Volt writes metadata-only prompt-cache audit logs to ~/.volt/agent/prompt-cache-audit/ so cache hit rates and keepalive costs can be compared over time.

Records cover request token counts and gaps, refresh outcomes and costs, and keepalive stops, never prompt or response content. Set `VOLT_PROMPT_CACHE_AUDIT=0` to turn them off.
