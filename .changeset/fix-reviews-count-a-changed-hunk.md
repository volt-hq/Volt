---
"@hansjm10/volt-coding-agent": patch
---

fix(review): Reviews count a changed hunk as covered once either the discovery or the verification pass has read it, so a clean verification of a large change no longer leaves the review incomplete; coverage gaps are listed by file instead of by hunk id.
