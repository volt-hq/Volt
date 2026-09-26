---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Daemon-hosted sessions now resolve tools from your login shell environment instead of the environment of whatever started the daemon. ([#464](https://github.com/volt-hq/Volt/issues/464))

The login shell starts from your session's environment: the launchd or systemd user environment when the login service starts the daemon, or the systemd user manager's environment when a terminal starts it on Linux. Service-manager and desktop-session variables such as `launchctl setenv` values, `environment.d` files, display, and proxy settings are kept. Variables exported only in the terminal that started the daemon no longer reach its sessions. The environment is resolved once per daemon start; run `volt daemon restart` after changing PATH or your shell profile. Set `VOLT_DAEMON_INHERIT_ENV=1` to keep the inherited environment, and check `volt daemon status` for the environment source.
