---
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-protocol": patch
---

internal(agent): Added work items to the protocol and the `Conversation` kernel: `work_started`, `work_checkpoint`, and `work_finished` host entries with their fold and lifecycle checks, reconciliation of open work on open, atomic result delivery as `message` or `wake` notices, host input withdrawal, and work in the client fold; nothing uses them yet. ([#585](https://github.com/volt-hq/Volt/issues/585))
