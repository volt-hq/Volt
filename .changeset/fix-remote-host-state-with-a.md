---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): Remote host state with a negative, fractional, or unsafe pairing or worktree timestamp now fails to load with a clear error instead of breaking daemon status, client, and worktree responses. ([#861](https://github.com/volt-hq/Volt/issues/861))
