---
name: view-cli
description: Run and observe the Volt CLI/TUI from source. Use whenever you need to see what the terminal UI actually renders — verifying TUI features (transcript, tool cards, subagent trees, status bar), driving interactive mode with prompts and keybindings, capturing screen output, or smoke-testing CLI flags. Covers print mode, the tmux recipe for interactive mode, screen-reading, waiting for turns, and cleanup.
---

# Viewing the Volt CLI

Volt runs from source via `./volt-test.sh <args>` (a jiti runner executed from
the repo root — no build step). There are two ways to see it work; pick the
cheapest that answers the question.

**Interactive mode takes over the terminal.** Never run bare `./volt-test.sh`
in your own shell — it grabs the PTY and blocks your session. Interactive runs
go inside tmux (below), where you can send keys and read the screen.

Prompts hit a real model and cost real tokens. Keep test prompts cheap
(`Reply with exactly: ok`) unless the point is to exercise a feature.

## 1. Print mode — no TUI, no tmux

For "does the CLI answer / does a flag work", non-interactive mode prints and
exits:

```bash
./volt-test.sh --help
./volt-test.sh --list-models
./volt-test.sh -p "Reply with exactly: ok"    # one prompt, plain output, exit
```

Print mode does not render the TUI. Use it to verify plumbing, not rendering.

## 2. Interactive TUI in tmux

```bash
tmux new-session -d -s volt-view -x 110 -y 32     # size IS the render width
tmux send-keys -t volt-view "./volt-test.sh" Enter
sleep 5
tmux capture-pane -t volt-view -p                  # startup screen
```

- `-x/-y` set the terminal size the TUI renders into. 80x24 is the minimum
  sanity size; use 110+ columns when inspecting wide content like subagent
  trees or diffs so lines don't truncate to `…`.
- `capture-pane -p` prints the visible screen with ANSI stripped. Add
  `-S -200` to include scrollback, or `-e` if you need to inspect colors.

### Sending input

```bash
tmux send-keys -t volt-view "Reply with exactly: ok" Enter   # submit a prompt
tmux send-keys -t volt-view "/subagents" Enter               # slash commands
tmux send-keys -t volt-view Escape                           # interrupt a running turn
tmux send-keys -t volt-view C-o                              # ctrl+o: expand tool outputs
tmux send-keys -t volt-view M-a                              # option+a: subagent inspector
tmux send-keys -t volt-view C-d                              # ctrl+d: exit (editor must be empty)
```

Keybindings are configurable; the defaults live in
`packages/coding-agent/src/core/keybindings.ts` (`DEFAULT_APP_KEYBINDINGS`).
The footer hints under tool cards (e.g. `option+a inspect  ctrl+o outputs`)
tell you what is available in context.

### Waiting for a turn to finish

A running turn shows a spinner line like `⠹ Working... (11s · escape to
interrupt)`. Poll until it disappears instead of guessing sleeps:

```bash
until ! tmux capture-pane -t volt-view -p | grep -q "Working..."; do sleep 2; done
tmux capture-pane -t volt-view -p
```

Long-running tools tick their durations once per second, so consecutive
captures differ slightly while work is in flight — that is normal.

### Reading the screen

Bottom-up:

- **Status bar** (last lines): `cwd · git branch · session name`, then
  `(provider) model · thinking level`, then `context N%/window · cost · ↑in ↓out`.
  Watch cost/token counters to confirm a prompt actually ran.
- **Composer**: the `ASK VOLT` box. If your typed text landed here but nothing
  happened, you forgot `Enter`.
- **Transcript** above: user/assistant messages, tool cards, and inline
  renderers. Subagent tool calls render as a live tree
  (`├─`/`└─` branches, status glyphs `…`/`✓`/`✗`/`○`, per-node
  `status · tool calls · duration · tokens · current activity`), including
  nested children. The full-screen subagent inspector is `option+a`.

### Cleanup

```bash
tmux kill-session -t volt-view
```

`kill-session` is the reliable teardown; it also recovers from a wedged UI.
One session per concern (`volt-view`, `volt-repro`, …) keeps captures clean.

## Scope notes

- This skill covers the local TUI. Daemon/phone-pairing workflows
  (`./volt-test.sh daemon …`, `remote pair`) are a separate concern; the TUI
  recipe here works the same when a daemon is running.
- After editing TUI or agent source, just relaunch the TUI (new tmux session);
  volt-test.sh always runs current source. Only the long-lived daemon needs an
  explicit restart to pick up edits.
