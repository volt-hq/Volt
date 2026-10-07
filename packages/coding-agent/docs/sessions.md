# Sessions

Volt saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Session Storage

Volt stores the sessions of each working directory in `sessions.sqlite`, in a directory of its own under `~/.volt/agent/sessions/`. A custom `--session-dir` contains its own `sessions.sqlite`. This SQLite database is the live authoritative store; sessions are addressed by stable IDs instead of live files.

```bash
volt -c                  # Continue most recent session
volt -r                  # Browse and select from past sessions
volt --no-session        # Ephemeral mode; do not save
volt --name "my task"    # Set session display name at startup
volt --session <id|path> # Resume by partial ID, or import a JSONL snapshot by path
volt --fork <id|path>    # Fork by partial ID, or import a JSONL snapshot as a new session
```

In interactive Volt, `--session` with the ID of a session from another project offers to fork it into the current directory.

Use `/session` in interactive mode to see the session's name, store directory (`In-memory` with `--no-session`), session ID, message counts, tokens, and cost.

JSONL is not live storage. It is used only for explicit snapshot import and export; passing a path to `--session` or `--fork` imports a current `snapshotVersion: 1` snapshot into SQLite as a new session (see [Fork Lineage](#fork-lineage)).

Session listing, exact-ID resolution, continuation candidate selection, and remote discovery read materialized summaries without loading transcript entries. Picker search is a deep scan over extracted user, assistant, and displayed custom-message text. It processes one session document at a time, but latency still grows with searchable history and query complexity; JavaScript regex searches have no general runtime bound.

For storage, snapshots, and the `SessionManager` API, see [Session Format](session-format.md).

## Where Conversations Run

Interactive Volt does not run its conversations in the terminal's process. They run in conversation workers, processes that the background daemon starts and supervises, and the TUI is a client of the conversation it shows ([Background daemon](daemon.md#conversation-workers)). Interactive Volt starts the daemon when none runs. `volt -p`, `--mode json`, `--mode rpc`, and SDK embeddings run their conversation in their own process.

### Quitting and Coming Back

Quitting the TUI detaches it; its conversation stays open in its worker. If a turn is running, quitting asks first:

- **Stop turn and quit** (the default) stops the turn, waits up to a minute for it to settle, then quits.
- **Leave running in background** quits and lets the turn finish in the worker.

Other running work, such as background jobs, subagents, and reviews, keeps running in the worker without asking. `volt -c`, `volt -r`, `volt --session <id>`, or `/resume` attach to the conversation again, including while its turn still runs. Stopping the daemon (`volt daemon stop`, or `volt update`) lets each running turn finish for up to a minute, then closes every conversation; see [Background daemon](daemon.md#crashes-restarts-and-stopping).

### Several Terminals and Phones

Any number of terminals, and paired phones, can show the same conversation at once; they are all clients of the one worker that has it open. Every client sees the conversation as it streams, and a message sent while a turn runs queues as it does with one terminal. An extension's dialog goes to every client that can answer it: the first answer counts, and the dialog closes in the others. `/clear`, `/resume`, `/fork`, `/clone`, and `/import` move only the terminal that ran them; the other clients stay on the conversation. See [Background daemon](daemon.md#several-terminals-and-phones).

### When a Conversation Closes

A worker keeps a conversation open while a client shows it and while it is active: a turn or another operation runs, or work runs (a background job, a subagent, a review, an approved host action, or extension work). Once no client is attached and it is idle, the conversation stays open for 30 minutes by default, so attaching again is quick, then closes and its extensions receive `session_shutdown`; see [Background daemon](daemon.md#retention-and-background). Work suspended since a restart and host actions still waiting for approval do not keep it open.

A conversation started with `volt --no-session` exists only in its worker's memory. Only the terminal that started it can attach, it is not listed, and it ends 10 seconds after that terminal leaves it.

If a worker crashes, a turn it was running is lost. The TUI shows `Reconnecting` and opens the conversation again from what was saved.

### One Volt Process per Session

A session can be open for writing in only one Volt process at a time: the worker hosting an interactive conversation, or the process of `volt -p`, `--mode json`, `--mode rpc`, or an SDK embedding. A subagent's conversation is open in its parent's process. Each takes an exclusive lock on `<session dir>/locks/<sha256(session id)>.lock` before it opens the session and holds it until it closes the session; the operating system releases it if the process exits. Taking the lock never waits.

Opening a session that another process has open fails with a `conversation_locked` error that names the session:

```text
Session <id> is open in another Volt process. Quit that session there (or switch it to another session), then retry. Listing, searching, and exporting it still work.
```

- `volt -p`, `--mode json`, and `--mode rpc` started on such a session print the error and exit with code 1. That includes a session an interactive conversation's worker has open, even after its last terminal quit (see [When a Conversation Closes](#when-a-conversation-closes)). To continue it, attach to it with `volt -r` or `volt --session <id>` instead.
- A protocol client whose `switch_session` (or another move) reaches such a session gets the intent rejected with code `locked`.
- Paired phones receive the `conversation_locked` handshake outcome.
- Interactive Volt attaches to a session a worker has open. When another process, such as `volt -p`, has it open, interactive Volt waits up to 75 seconds for that process to close it, then reports that the conversation is open in another Volt process.

Listing and searching read store summaries, and exporting and forking from a session open it read-only: none of them take the lock, so they keep working while the session is open elsewhere. SDK code reads a session the same way with `SessionManager.openReadOnly(ref)`; every write through a read-only manager throws. Renaming or deleting another session from the picker takes its lock briefly, so it fails while that session is open anywhere, including while its worker still keeps it open after its last client left.

### When a Session Stops

Every write to a session names the log position it expects (see [Session Format](session-format.md#the-conversation-log)). If a write finds that another writer appended, that the session was deleted, or that its own outcome cannot be resolved, the session's log is lost: Volt cannot confirm what was saved, so it stops that session instead of continuing.

- The TUI exits with `Volt stopped this session because its saved state could not be confirmed`, suggests running volt again and using `/resume`, and prints any unsent editor text so you can copy it.
- `volt -p`, `--mode json`, and `--mode rpc` print `Volt stopped session <id> because its saved state could not be confirmed: <reason>` and exit with code 1.
- The worker hosting an interactive conversation closes it, and every terminal showing it exits as above.

Extensions observe the stop through the aborted `ctx.signal` of their commands and then receive `session_shutdown`; session writes after the stop throw. Reopen the session with `/resume` or `--session` to continue from what was saved.

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/clear` | Start a new session |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |
| `/import <file>` | Import a JSONL snapshot as a new session |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

### Work and Switching Sessions

Background jobs, subagents, reviews, host actions, and extension work are work items of the session that started them (see [Session Format](session-format.md#work-entries-host-only)); `/work` lists them. In interactive Volt, `/clear`, `/resume`, `/fork`, `/clone`, and `/import` move the terminal even while work runs: the work keeps running in the session's worker, which keeps the session open until it is idle and then closes it as described in [When a Conversation Closes](#when-a-conversation-closes). `/clear` stops a running turn first; the other commands leave it running. `volt --mode rpc` and SDK hosts refuse to leave a session while work runs, and so does a session change an extension command starts unless another client stays on the session: cancel the work in `/work` or wait for it to finish. Work suspended since a restart, such as a subagent that was running when Volt stopped, does not hold the session; it stays in `/work` until you resume or cancel it.

## Resuming and Deleting Sessions

`/resume` opens an interactive session picker for the current project. `volt -r` opens the same picker at startup.

In the picker you can:

- search by typing
- switch between the current folder's sessions and all sessions with Tab
- toggle path display with Ctrl+P
- toggle sort mode with Ctrl+S
- filter to named sessions with Ctrl+N
- rename with Ctrl+R
- delete with Ctrl+D, then confirm

Volt deletes only sessions of the current folder's workspace that no conversation has open: in the All view, another folder's sessions cannot be deleted from here, and a session that is open anywhere is refused or fails at its lock, including one its worker still keeps open after its last client left (see [When a Conversation Closes](#when-a-conversation-closes)). Before deleting a session from SQLite, volt exports it as a JSONL recovery snapshot into `deleted-session-snapshots/` under its session directory, and moves the snapshot to the system trash when a `trash` command is available. Protocol clients delete with the `delete_session` intent and list sessions with the `sessions` query ([RPC](rpc.md#built-in-intents)).

## Naming Sessions

Use `/name <name>` to set a human-readable session name:

```text
/name Refactor auth module
```

Set the name at startup with `--name` or `-n`:

```bash
volt --name "Refactor auth module"
volt --name "CI audit" -p "Review this build failure"
```

Named sessions are easier to find in `/resume` and `volt -r`.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating another session.

<p align="center"><img src="images/tree-view.png" alt="Volt session tree selector. After the first answer the session splits into two branches: the active, highlighted branch adds a separator option, and the other branch, labeled maxLength draft, adds a maxLength option. Each branch lists its user prompt, tool calls, and assistant reply." width="720"></p>
<p align="center"><em><code>/tree</code> in Volt 0.2.1 after rewriting an earlier prompt. Both branches remain in the same session.</em></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| Ctrl+←/Ctrl+→ or Alt+←/Alt+→ | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label on the selected entry |
| Shift+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/Ctrl+C | Cancel |
| Ctrl+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](settings.md).

### Labels

A label bookmarks an entry of the tree. Shift+L in `/tree` sets or clears the selected entry's label, which shows before the entry as `[label]`; the labeled-only filter lists the labeled entries. Labels are log entries of the session: forks and clones copy those on the copied branch, and a label stays when the active branch moves elsewhere. Protocol clients set them with the `set_label` intent (`null` clears one), and extensions with [`volt.setLabel()`](extensions.md#voltsetlabelentryid-label).

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session | New session | New session |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session ID.

### Fork Lineage

A forked, cloned, or imported session does not read its source. Its log starts with a `forked_from` entry that names the source session and the entry the copy ends at, followed by a copy of the source's branch from the root to that entry and the labels on it. The copied entries keep their IDs. Other branches of the source stay only in the source.

| Source | Copied branch | `forked_from` names |
|--------|---------------|---------------------|
| `/fork` on a user message | Up to the entry before the message, which goes to the editor | The session and that entry, or no entry when the message is the first entry |
| `/clone` | Up to the current leaf | The session and its leaf |
| `--fork <id>` | The source's active branch | The source and its leaf |
| `/import`, or a path to `--session` or `--fork` | The snapshot's active branch | The snapshot's session ID and leaf |

An imported session gets a new ID. With `--fork <path>`, `--session-id` chooses it instead. A snapshot's parent locator is not carried into the imported session; its lineage names the snapshot.

Only the branch's public entries are copied. Host records stay with the source: a copy carries no work items, and the review runs it copies are local reports, linked to neither the source review's General nor its finding discussions. A review finding discussion cannot be forked or cloned; reset it from the source review instead.

## Branch Summaries

When `/tree` switches away from one branch to another, volt can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Session Format

Each session in the SQLite store is a log of entries: messages, model, thinking-level, and Fast mode changes, plan state, labels, compactions, branch summaries, extension entries, and host-only records such as branch moves, queued input, fork lineage, work items, and review state. Explicit JSONL snapshots serialize the public session tree for interchange; they are not reopened as live storage.

For the log format, snapshot parsers, and the full `SessionManager` API, see [Session Format](session-format.md).
