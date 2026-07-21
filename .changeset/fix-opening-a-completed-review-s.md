---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): Opening a completed review's findings session now consumes the retained review record, so reconnecting or reconciling clients no longer re-surface an already-acted-on review and cannot seed a duplicate findings session. ([#78](https://github.com/volt-hq/Volt/issues/78))

A declined or failed open keeps the review available. After a successful open, get_review_result for that workflow id fails; the findings live in the seeded session.
