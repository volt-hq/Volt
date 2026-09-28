---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Extension source context is no longer dropped on a busy machine when revalidation misses a 25 ms deadline; the deadline is now 100 ms. ([#509](https://github.com/volt-hq/Volt/issues/509))

`volt.getWorkStatus()` now reports `validation_deadline` for context whose sources could not be revalidated in time, instead of `source_unverified`.
