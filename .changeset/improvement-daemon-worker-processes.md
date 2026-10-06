---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(daemon): Phone conversations run in conversation worker processes that the daemon supervises.

Each worker writes its own log under `daemon/workers/`, and `volt daemon status` lists every worker's pid and log. A worker that loses its daemon finishes its running turn (at most 60 seconds) and exits, and a restarted daemon waits for those workers before it serves.
