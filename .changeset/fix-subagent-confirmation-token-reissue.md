---
"@hansjm10/volt-coding-agent": patch
---

fix(subagents): A mismatched spawn confirmation token now rotates the pending reservation and returns a fresh token instead of locking that exact request out until the five-minute expiry; exactly one token stays valid at a time.
