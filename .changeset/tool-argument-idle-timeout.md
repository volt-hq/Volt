---
"@hansjm10/volt-ai": patch
"@hansjm10/volt-coding-agent": patch
---

fix(ai): Let long document and tool arguments keep streaming while bytes arrive, timing out after five minutes without progress by default.

Use `toolArgumentLimits.maxIdleMs` to adjust the idle timeout. A total preparation deadline applies only when `toolArgumentLimits.maxDurationMs` is explicitly configured. Byte limits and complete-JSON validation still apply before execution.
