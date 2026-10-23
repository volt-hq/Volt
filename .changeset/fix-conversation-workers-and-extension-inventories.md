---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

fix(daemon): Conversation workers and extension inventories now end every process still descended from them when they exit, however they exit, the same way on macOS, Linux, and Windows. ([#952](https://github.com/volt-hq/Volt/issues/952), [#971](https://github.com/volt-hq/Volt/issues/971))

A process whose parent exited first, such as a server started with `nohup … &` through the bash tool, keeps running when a worker stops; on macOS and Linux a worker crash can still end it. See [daemon.md](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/daemon.md#processes-a-conversation-started).
