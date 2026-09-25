---
"@hansjm10/volt-coding-agent": patch
---

improvement(rpc): The host now emits a terminal `subagent_disposed` event whenever it releases a local RPC-managed subagent (abort, dispose, failed start, or a session switch disposing active subagents). ([#44](https://github.com/volt-hq/Volt/issues/44))

Host-side disposals (for example a session switch while a subagent streams) previously produced no terminal frame, so the bundled RPC client retained that subagent's message-delta accumulator indefinitely. The bundled client now drops the accumulator on `subagent_disposed`; raw-frame consumers should treat it as the end of that subagent's event stream.
