---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(daemon): Running phone conversations pick up settings and logins saved by other Volt processes without a restart.

A conversation worker reloads its conversations' settings when the global or project `settings.json` changes, and its credentials and models when `auth.json` or `models.json` changes, and tells attached clients to refetch them.
