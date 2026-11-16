---
"@hansjm10/volt-coding-agent": patch
---

improvement(review): Reviews now keep a private audit log of each pass by default: its reasoning, replies, tool calls and results, and submitted report, including candidates the verifier rejected, in the owner-only review-diagnostics directory (newest 20 runs); set VOLT_REVIEW_PRIVATE_DIAGNOSTICS=0 to turn it off.
