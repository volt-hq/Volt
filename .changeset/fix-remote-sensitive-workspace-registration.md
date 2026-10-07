---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

fix(remote): Volt no longer registers a filesystem root, your home directory, or a directory containing or inside its agent directory as a phone-visible workspace without asking.

Starting Volt in one of those directories asks whether paired devices with access to all workspaces may reach it: yes registers it as usual, no registers it local to this host. Volt asks once; `volt remote workspace add` shares it later. A workspace can now be local to the host: paired devices never see or reach it unless their grant names it, and `volt daemon status` marks it local only.
