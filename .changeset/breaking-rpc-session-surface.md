---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(rpc): Stopping intents (`abort`, `abort_bash`, `abort_retry`, `cancel_work`) now run as soon as they arrive instead of waiting behind a long intent such as `compact`, and local protocol clients can navigate the session tree, label entries, reload, import and export JSONL, take queued input back, delete and rename stored sessions, and read the conversation's info, resources, and tools. ([#585](https://github.com/volt-hq/Volt/issues/585))

A stop no longer waits for the frames sent before it. A client that needs an earlier intent admitted before it stops a run waits for that intent's `accepted` first.

The live fold moved to `@hansjm10/volt-protocol`: import `foldLiveFrame`, `foldLiveItems`, `foldLiveCommit`, `emptyLiveFold`, `liveCommitOf`, `patchLiveValue`, and `LivePatchError` from there instead of `@hansjm10/volt-coding-agent`.

Every client also sees the host's own notices (a cancelled or failed compaction, retries that gave up, an Anthropic subscription login), when a scheduled retry starts and what failed before it, when work started and finished, and the keys extensions bind to intents; local clients also see how many paired devices are attached (live `presence`). Paired devices are refused every addition that names host paths or the host's stored sessions.
