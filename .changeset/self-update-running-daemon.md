---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): `volt update` no longer breaks the installation while the daemon is running; it asks to stop the daemon, updates, and starts it again. ([#546](https://github.com/volt-hq/Volt/issues/546))

Non-interactive updates refuse instead and print the stop, update, and start commands. If the install step still fails, the error now says the installation may be incomplete and explains how to recover.
