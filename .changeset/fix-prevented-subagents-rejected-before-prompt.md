---
"@hansjm10/volt-coding-agent": patch
---

fix(subagents): Prevented subagents rejected before prompt acceptance from appearing in the inspector or daemon. ([#56](https://github.com/volt-hq/Volt/issues/56))

A first prompt rejected before the start is published (including a daemon registration commit failure after acceptance) now also disposes the SDK subagent handle, so later handle calls fail with a clear disposed-handle error instead of hitting a rolled-back runtime.
