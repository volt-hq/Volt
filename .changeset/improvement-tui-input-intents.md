---
"@hansjm10/volt-coding-agent": patch
---

improvement(tui): The TUI sends what you type, `!` commands, and its model, thinking, and mode keys to its host as a client, and messages sent during a compaction wait in the conversation's queue for every client. ([#585](https://github.com/volt-hq/Volt/issues/585))

The queue shown above the editor is the conversation's: the dequeue key and Esc take it back from the host. `!` and `!!` commands run on the host and show their output as they run; one run during a turn waits below the transcript until the turn ends. The slash menu, extension shortcuts, and completion triggers come from the conversation's commands, so a prompt template's argument hint shows in the menu, and the TUI reports an extension shortcut that one of its own keys takes. Cycling the model or thinking level through the keys notifies extensions with `model_select` source `set` instead of `cycle`.

Protocol clients can send `steer` and `follow_up` while a compaction or a tree navigation runs: the input waits in the queue and is delivered once it ends. A `bash` intent no longer holds back the intents and queries sent after it on the same connection; `bash` intents still run one at a time. The `resources` query reports keys two extensions bind among its diagnostics. Extension command argument completions use `ExtensionCompletionItem` (`label` is optional).
