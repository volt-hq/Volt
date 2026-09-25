---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Linked pull request status in Work now keeps refreshing after a session leaves the PR branch, its runtime ends, or the daemon restarts. ([#468](https://github.com/volt-hq/Volt/issues/468))

Existing Work associations are reset once on upgrade; active sessions relink their pull request the next time their branch is observed.
