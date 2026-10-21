---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Conversation workers and extension inventories now end every process still descended from them when they exit, however they exit, the same way on macOS, Linux, and Windows. ([#971](https://github.com/volt-hq/Volt/issues/971))

A process whose parent exited first, such as a server started with `nohup … &` through the bash tool, keeps running. See [daemon.md](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/daemon.md#processes-a-conversation-started).
