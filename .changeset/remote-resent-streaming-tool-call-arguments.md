---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): Fixed a paired device being sent the start of a workspace path from a tool call whose arguments were still streaming, when the host resent a streaming answer or the device joined mid-stream. ([#830](https://github.com/volt-hq/Volt/issues/830))
