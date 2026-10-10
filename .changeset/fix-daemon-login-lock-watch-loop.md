---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Fixed a provider sign-in through the daemon failing with "The host ended the connection: invalid_frame (More than 256 frames are pending)".

The worker's settings and credentials watchers reacted to the lock files their own reloads created (`settings.json.lock`, `auth.json.lock`), so they reloaded forever and told every client its settings changed several times a second. A sign-in (`auth.login`) held the connection's intent and query lane while it waited for the browser, so the catalog queries those notices prompted piled up past the connection's limit. Lock files are no longer changes, and a sign-in now runs beside the other intents and queries like `bash` and `compact` do.
