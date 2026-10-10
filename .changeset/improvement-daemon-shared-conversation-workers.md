---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(daemon): Conversations run in worker processes the daemon supervises, conversations in the same workspace share a worker, and running conversations pick up settings and logins saved by other Volt processes without a restart. ([#585](https://github.com/volt-hq/Volt/issues/585))

A conversation opens in a running worker of its workspace that was started with the same environment, extensions, tool policy, and project trust, up to six conversations per worker, instead of starting a process of its own. A detached, idle conversation closes after the daemon's retention time while the others in its worker keep running, and a worker exits once it hosts no conversation. A worker that crashes interrupts every conversation it hosts; their clients reconnect and reopen them. A worker that loses its daemon finishes its running turn (at most 60 seconds) and exits, and a restarted daemon waits for those workers before it serves.

Each worker writes its own log under `daemon/workers/`, and `volt daemon status` lists every worker's pid and log. A worker reloads its conversations' settings when the global or project `settings.json` changes, and its credentials and models when `auth.json` or `models.json` changes, and tells attached clients to refetch them.
