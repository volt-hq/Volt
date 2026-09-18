---
"@hansjm10/volt-coding-agent": patch
---

feature(subagents): Added opt-in pre-inference delegation so local TUI extensions can run bounded tasks on a configured worker model without calling the primary model.

The repository-local Jev experiment adds `/jev route` for standalone PR creation from completed committed changes. Uncertain requests stay with the primary model; dispatched workers remain cancellable and publish attributed results without an automatic parent summary.
