---
"@hansjm10/volt-coding-agent": patch
---

fix(review): Recheck verifier concerns before completing a review and show unresolved code locations, explanations, and next steps instead of a generic incomplete result. ([#372](https://github.com/volt-hq/Volt/issues/372))

Reviews perform at most one follow-up discovery and independent verification cycle on the captured snapshot. Unresolved concerns remain distinct from verified findings, private PR analysis stays private, and failed follow-up checks preserve the earlier verified result. Review failures identify the failed stage and a recovery action.
