---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(protocol): The four review start intents, `review_uncommitted`, `review_branch`, `review_pr`, and `review_commit`, are now one `review` intent with a `target`. ([#725](https://github.com/volt-hq/Volt/issues/725))

Send `review` with `target` set to `uncommitted`, `branch`, `pr`, or `commit`, plus the fields of that target (`base` for `branch`; `number` and `url` for `pr`; `ref`, required, for `commit`) and the same controls as before. A field that belongs to another target, or a commit review without `ref`, is rejected `invalid_input`. `tools` and `url` stay local only. Completions use `intent_completions` with `intent: "review"` and the field `base`, `number`, `url`, or `ref`. The result is still `{workId}`. The old intent names are no longer accepted; the protocol contract in `packages/protocol/contract/protocol-schema.json` lists the new schema.
