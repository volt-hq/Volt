---
"@hansjm10/volt-coding-agent": patch
---

fix: Sessions report busy while a prompt waits in auto-retry backoff, so quit confirmation, daemon shutdown drains, RPC idle waits, and extension isIdle() no longer treat a retrying prompt as idle.
