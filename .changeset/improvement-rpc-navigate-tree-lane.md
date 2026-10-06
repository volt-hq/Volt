---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(rpc): A tree navigation (`navigate_tree`) runs beside a client's other intents like `bash` and `compact`, so input sent while it summarizes the branch it leaves queues at once. ([#585](https://github.com/volt-hq/Volt/issues/585))

`set_model` takes `source: "cycle"` for a client's model-cycle control, which extensions see on `model_select`, and the `conversation_info` query reports whether the conversation's project is trusted (`projectTrusted`, local clients only).
