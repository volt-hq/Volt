---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

feature(daemon): The daemon now runs in standalone binaries, `--omit=optional` installs, and on Intel Macs, serving the TUI and conversation workers with phone transport unavailable, and the TUI connects to it on Windows and in standalone binaries.

A daemon without phone transport refuses pairing with guidance in `volt daemon status`, `volt remote pair`, and `/remote`; workspace, worktree, and device revocation commands keep working. A standalone binary starts its daemon and workers by re-running its own executable. Local clients, conversation workers, and relays now prove their token instead of sending it, bound to a fresh daemon challenge and the socket they dialed, and only trust a daemon that proves it back, so a stale Windows pipe name taken over by another account is never trusted and a hello it captures works nowhere else.
