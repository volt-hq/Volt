---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Fixed the daemon freezing when a remote client detached while a ! command, extension command, or reload was running; shutdown and TUI lease handoff now also wait for that work instead of cutting it off.
