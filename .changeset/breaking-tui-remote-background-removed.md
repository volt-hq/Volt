---
"@hansjm10/volt-coding-agent": minor
---

breaking(tui): The `remote.background` setting is removed: interactive Volt always starts the Volt daemon, which now hosts its conversations. ([#585](https://github.com/volt-hq/Volt/issues/585))

Migration: delete `remote.background` from your `settings.json`; it no longer has any effect. Interactive Volt starts the daemon on demand, and a daemon started that way exits after five minutes without conversations, terminals, or paired devices. To keep a daemon running across logins, run `volt daemon install-service`; `volt daemon stop` stops it. Print, JSON, and RPC modes still run without the daemon.
