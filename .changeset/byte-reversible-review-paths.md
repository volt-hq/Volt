---
"@hansjm10/volt-coding-agent": minor
---

breaking(review): Preserve exact Git filename bytes across review reads, searches, diffs, findings, and publication.

Review paths now use canonical byte-reversible references: ordinary printable UTF-8 stays readable, while invalid bytes, percent signs, backslashes, colons, and control characters use uppercase `%HH` escapes. Copy fresh references from review tools unchanged into scopes and reports. Extension authors must encode actual UTF-8 checkout filenames with `reviewPathFromUtf8`, and get from a reference to a file in a review checkout with the checkout's `nativePath(reference)` instead of decoding it. A review checkout is no longer refused for a filename: it leaves out the paths its filesystem cannot hold faithfully (names the system cannot store, and all but one of the names that differ only in case where those are one file), lists them in `unrepresented`, and the snapshot tools still read them. An engine checks that a reported path exists with `ctx.hasTextFile`, which counts as nothing inspected. Non-UTF-8 findings remain summary-only when publishing, with their exact reference and location.

Rerun pre-change reviews: schema-1 review-run records are no longer read or reused for incremental review, and are not migrated. Swarm's old dismissal cache is also no longer reused. Client protocol fields and variants are unchanged.
