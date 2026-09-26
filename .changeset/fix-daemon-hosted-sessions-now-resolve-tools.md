---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Daemon-hosted sessions now resolve tools from your login shell environment instead of the environment of whatever started the daemon. ([#464](https://github.com/volt-hq/Volt/issues/464))

The environment is resolved once per daemon start; run `volt daemon restart` after changing PATH or your shell profile. Variables exported only in the terminal that started the daemon no longer reach its sessions. Set `VOLT_DAEMON_INHERIT_ENV=1` to keep the inherited environment, and check `volt daemon status` for the environment source.
