---
"@hansjm10/volt-coding-agent": patch
---

feature(tui): Interactive Volt runs its conversations in the Volt daemon's [conversation workers](https://volt-cli.dev/docs/daemon/#conversation-workers), so closing the terminal leaves a conversation running and several terminals can attach to the same one. ([#585](https://github.com/volt-hq/Volt/issues/585))

Volt starts the daemon when none runs and shows the terminal while the conversation starts; what you type meanwhile is sent once it is ready. `volt -c`, `-r`, and `--session` reattach to a conversation that is still running, including a turn in progress. Quitting while a turn runs asks whether to stop it or leave it running in the background. When a conversation's worker exits or the daemon restarts, the terminal keeps its transcript, shows "Reconnecting..." or "Host restarting...", and resumes where it was; after `volt daemon stop` it starts the daemon again after 10 seconds. A daemon started this way exits after five minutes without conversations, terminals, or paired devices. A daemon of another Volt version is restarted when it runs nothing; otherwise Volt asks you to run `volt daemon restart`.
