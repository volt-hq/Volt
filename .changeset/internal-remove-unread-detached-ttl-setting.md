---
"@hansjm10/volt-coding-agent": patch
---

internal(daemon): Removed the `remote.detachedRuntimeTtlMs` settings field, which the daemon never read; the retention time is `detachedRuntimeTtlMs` in the daemon's `state.json`.
