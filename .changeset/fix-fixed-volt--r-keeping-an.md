---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Fixed volt -r keeping an outdated transcript after taking a session over from the daemon, which made the first message fail with a revision conflict. ([#524](https://github.com/volt-hq/Volt/issues/524))
