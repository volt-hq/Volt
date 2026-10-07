---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(daemon): Conversations in the same workspace share a worker process. ([#585](https://github.com/volt-hq/Volt/issues/585))

A conversation opens in a running worker of its workspace that was started with the same environment, extensions, tool policy, and project trust, up to six conversations per worker, instead of starting a process of its own. A detached, idle conversation closes after `remote.detachedRuntimeTtlMs` while the others in its worker keep running, and a worker exits once it hosts no conversation. A worker that crashes interrupts every conversation it hosts; their clients reconnect and reopen them.
