---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

fix(remote): Volt no longer registers a filesystem root, your home directory, or a directory containing or inside its agent directory as a phone-visible workspace without asking.

Starting Volt in one of those directories leaves it unregistered; `volt remote workspace add` still registers it on request. A workspace can now be local to the host: paired devices never see or reach it unless their grant names it, and `volt daemon status` marks it local only.
