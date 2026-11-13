---
"@hansjm10/volt-coding-agent": minor
---

breaking(review): Preserve exact Git filename bytes across review reads, searches, diffs, findings, and publication.

Review paths now use canonical byte-reversible references: ordinary printable UTF-8 stays readable, while invalid bytes, percent signs, backslashes, colons, and control characters use uppercase `%HH` escapes. Copy fresh references from review tools unchanged into scopes and reports. Extension authors must encode actual UTF-8 checkout filenames with `reviewPathFromUtf8` and decode only at native boundaries with `reviewPathToUtf8`; use snapshot tools when a path cannot be represented by the OS. An engine checks that a reported path exists with `ctx.hasTextFile`, which counts as nothing inspected. Non-UTF-8 findings remain summary-only when publishing, with their exact reference and location.

Rerun pre-change reviews: schema-1 review-run records are no longer read or reused for incremental review, and are not migrated. Swarm's old dismissal cache is also no longer reused. Client protocol fields and variants are unchanged.
