---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): `volt update` no longer breaks the installation while the daemon is running; it asks to stop the daemon, updates, and starts it again. ([#546](https://github.com/volt-hq/Volt/issues/546))

The daemon starts from wherever the package manager put the updated package, including pnpm global installs and renamed packages. A daemon the login service was running is restarted through the service. Non-interactive updates refuse instead and print the stop, update, and start commands. If the install step still fails, the error now says the installation may be incomplete and explains how to recover.
