---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

internal(work): Added the host work registry: every hosted conversation settles the work a previous runtime left open when it opens, runs work kinds with live `work/<id>` progress and coarse checkpoints, stops its work when it closes, and serves the `cancel_work`, `open_work`, `resume_work`, and `start_subagent` intents and the `work_output` query; session logs store work entries, both profiles project them (the remote profile without input, child locators, output, or result data), and quiet work notices stay queued across a restart without replaying. Jobs, subagents, reviews, and host actions still run on their own paths. ([#585](https://github.com/volt-hq/Volt/issues/585))
