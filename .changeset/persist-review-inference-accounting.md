---
"@hansjm10/volt-ai": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(review): Review runs retain initial-review request, token, and model-priced cost accounting across completion and interruption ([#409](https://github.com/volt-hq/Volt/issues/409)).

RPC clients must accept the `unfinished` review status and an absent `endedAt` until a terminal result is committed. Use `usage` summaries and `usageBreakdown` details instead of reconstructing cost from workflow events; absent historical accounting is explicitly unavailable. Costs are model-priced USD estimates, not invoices or subscription charges. Initial-review usage remains separate from discussion usage.

Custom text providers should set `Usage.availability` to `complete`, `partial`, or `unavailable` according to reported counters; missing metadata is unknown, not reported zero.
