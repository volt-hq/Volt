---
"@hansjm10/volt-coding-agent": patch
---

fix(review): Cancelling a PR review no longer leaves Git processes running in the review checkout, which could keep Windows from removing it.
