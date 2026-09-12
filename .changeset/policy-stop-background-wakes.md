---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(policy): Background jobs no longer resume runs explicitly stopped by host turn policies.

SDK hosts must return `undefined` from next-action hooks and registered turn policies when leaving the suggested action unchanged, rather than returning `context.defaultAction`. Return `pause` for resumable interruptions such as compaction; an explicit `stop` revokes automatic continuation for existing jobs without cancelling workers or discarding their results. Natural completion still permits background wakes, and later explicit prompts remain available.
