---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Fixed volt -r keeping an outdated transcript after taking a session over from the daemon, which made the first message fail with a revision conflict. ([#524](https://github.com/volt-hq/Volt/issues/524))

When a turn or review is still running on the desktop, the transcript reloads after it finishes; typed input stays in the editor until then.
