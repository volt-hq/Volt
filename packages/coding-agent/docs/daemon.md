# Background daemon (voltd)

`voltd` is the background daemon that runs interactive Volt's conversations and
Volt's remote-access plane. Every conversation you open in interactive `volt`
runs in a **conversation worker**, a process the daemon starts and supervises;
the TUI is a client of that conversation, and so is any paired phone attached
to it. Closing a terminal does not stop the conversation, and any number of
terminals and paired phones can attach to it at once.

The daemon itself runs no conversation. It owns the workers, the stable Iroh
endpoint identity, phone pairing and revocation, workspace registration, push
notification dispatch, and managed worktrees. Paired phones stay paired across
restarts because the Iroh secret key lives in the daemon's state file.

`volt -p`, `--mode json`, `--mode rpc`, and SDK embeddings run their
conversation in their own process and do not use workers.

## Quick start

```bash
volt                       # starts the daemon when none runs, then opens a conversation in a worker
volt daemon status         # inspect the daemon, workspaces, paired clients, and workers
volt remote pair           # pair a phone (QR / ticket)
```

Interactive Volt always uses the daemon: it starts one when none runs, and
exits with the reason and the daemon's log path if the daemon cannot start. A
daemon that `volt` or `volt daemon start` started exits once nothing has
needed it for five minutes (see [Idle exit](#idle-exit)). To keep one running
from login, run `volt daemon install-service`.

## CLI

```
volt daemon start                 Start the background daemon (no-op if already running).
volt daemon stop                  Graceful shutdown: each worker finishes its turn (60 s cap) and exits.
volt daemon status [--json]       Status; exit 0 only when phone transport and relay access are ready, or the build has no phone transport.
volt daemon restart               Stop then start; persistent state survives.
volt daemon regenerate-state      Back up invalid state and regenerate it after confirmation.
volt daemon keep-awake [on|off]   Keep the computer awake while the daemon runs; no argument prints the state.
volt daemon logs [-f] [-n N]      Tail the daemon log.
volt daemon install-service       Register a login service (launchd/systemd).
volt daemon uninstall-service     Remove the login service.
volt daemon run --foreground      Run in this process (internal; used by start and the login service).

volt remote pair [--workspace <name>]   Create a pairing ticket, wait for the phone.
volt remote status [--json]             Same status view; exit 0 only when phone transport and relay access are ready.
volt remote clients                     List paired clients.
volt remote credential revoke           Reset this daemon's managed relay credentials.
volt remote revoke <node-id>            Revoke a client and close its connections.
volt remote approve-repair <node-id>    Allow a revoked node ID to re-pair.
volt remote workspace add [path] [--name <name>]
volt remote workspace remove <name>
volt remote workspace list
volt remote worktree add [--workspace <name>] [--name <id>] [--branch <ref>] [--base <ref>]
volt remote worktree list [--workspace <name>] [--json]
volt remote worktree remove <id> [--workspace <name>] [--force]
volt remote worktree prune [--workspace <name>]
volt remote worktree diff <id> [--workspace <name>]
```

`volt daemon status` lists each worker with its pid, state (`starting`,
`live`, or `retiring`), whether a TUI or a phone opened it, its workspace and
sessions, its attached clients, and its log.

`volt remote host` is gone; running it prints a pointer to `volt daemon
start`. Phone transport requires a Node.js npm install or source checkout with
the exact required `@hansjm10/volt-iroh` wrapper and its optional selected
native binding. Installs made with `--omit=optional`, Darwin x64 (no binding),
and standalone Node SEA builds (Iroh is not bundled) still run the daemon and
its conversation workers for local terminals; their status reports phone
transport `unavailable` (`native_binding_missing`) and pairing is refused.
A standalone binary starts the daemon and its workers by re-running itself.
On Windows the daemon listens on a named pipe instead of a socket.

`volt daemon install-service` writes a launchd LaunchAgent (macOS) or a
systemd user unit (Linux) that starts the daemon at login. The service does
not auto-restart after a graceful `volt daemon stop`; on Linux, run
`loginctl enable-linger` if the daemon should also run without an active
login session.

The daemon keeps volt's native modules open, so `volt update` must stop it
before replacing the installation. It asks first, and after the update it
starts the daemon again from the updated installation. If the login service was
running the daemon, `volt update` reinstalls the service from the updated
installation and starts the daemon through it, so the daemon keeps the service
environment. Without an interactive terminal, it does not update and prints the
commands to run instead: `volt daemon stop`, `volt update --self`, then `volt
daemon start`, or `volt daemon install-service` when the login service runs the
daemon.

The login service records the path of the installation it runs. When the
service is installed but not running the daemon, `volt update` points it at
the updated installation without starting the daemon, because an update can
move that path (pnpm global installs, renamed packages). On macOS this also
unloads the service until the next login; run `volt daemon install-service` to
start it sooner. If the service cannot be updated, `volt update` says so and
exits with an error; run `volt daemon install-service` to fix it.

## Conversation workers

Each conversation runs in a worker: a `volt daemon worker` process started
from the daemon's own installation, detached from any terminal, in the
conversation's workspace directory. A worker opens the conversation's log,
holds its lock (see [Sessions](sessions.md#one-volt-process-per-session)),
loads its extensions, and serves every client attached to it. The TUI and
phones reach it over streams the daemon relays. At most one worker hosts a
session at a time, so a `volt -p`, `--mode json`, `--mode rpc`, or SDK run
that opens a session a worker hosts fails with `conversation_locked`; open it
in interactive Volt instead (`volt -r`, or `volt --session <id>`), which
attaches to the worker.

### Opening a conversation

Interactive Volt opens a conversation at startup (including `-c`, `-r`,
`--session`, `--fork`, and `--no-session`; a JSONL file given to `--session`
or `--fork` is imported first) and for `/clear`, `/resume`, `/fork`, `/clone`,
`/import`, and `/worktree`. It sends the daemon the conversation, its working
directory, its environment, and the options from its command line. The daemon
resolves the conversation's workspace: the managed worktree containing the
working directory (which belongs to its parent workspace), else the innermost
registered workspace containing it, else the directory itself, which it
registers as a new workspace. Then it:

- attaches the TUI to the worker already hosting the conversation, if one is
  live;
- otherwise opens the conversation in a live worker it can share (see
  [Shared workers](#shared-workers));
- otherwise starts a worker for it, with the TUI's environment and options.

The TUI shows its window and accepts typing while the daemon and the worker
start; prompts you send before the conversation is ready wait in the TUI and
are sent once it is. When the conversation was already open in a worker, the
TUI's model, thinking level, and `--plan` apply to it as if you had chosen
them after attaching. Options a worker fixes when it starts (extensions,
tools, the system prompt, resource paths, `--approve`/`--no-approve`, and
the like) stay as that worker has them, and the TUI shows a warning naming
the options it did not apply.

**Sensitive directories.** The daemon never registers these as a workspace
without asking: a filesystem root, your home directory or a directory
containing it, and a directory that contains or is inside Volt's agent
directory (`~/.volt/agent`). A paired device with access to all workspaces
could otherwise read everything under it. When a conversation opens in one
that no workspace holds, the TUI asks:

> Register *directory* as a Volt workspace? Paired devices with access to all
> workspaces could read files there

- **No, register it for this computer only** (listed first) registers a
  local-only workspace. Paired devices cannot see, list, open, or pair into it
  unless their grant names it; an all-workspace grant does not.
  `volt daemon status` marks it `(local only)`.
- **Yes, register it for paired devices too** registers it like any other
  workspace.

Either answer registers the directory, so Volt does not ask again there.
Dismissing the question opens nothing. Registering a local-only workspace
explicitly, with `volt remote workspace add` or **Register current
directory** in `/remote`, shares it.

### Shared workers

A worker hosts up to six top-level conversations of one workspace. When you
open a conversation no worker hosts, the daemon puts it in a live worker of
the same workspace that has room and was started with the same settings:

- A TUI's conversation shares only with conversations opened by a TUI with an
  identical environment and identical options that a worker fixes when it
  starts. In practice the conversations of one terminal (its startup
  conversation, `/clear`, `/resume`, `/fork`) share a worker, while separate
  terminals, whose environments differ, get workers of their own.
- A phone's conversation shares only with conversations phones opened with
  the same tool policy, project trust, and profile.
- A TUI's and a phone's conversations never share a worker, and a
  `--no-session` conversation always gets a worker of its own.

Each top-level conversation keeps its own subagents, review conversations,
and the conversations its extensions open with it, in the same worker. A
worker that hosts nothing exits. A crash interrupts every conversation the
worker hosts (up to six); their clients reconnect, as described in
[Crashes, restarts, and stopping](#crashes-restarts-and-stopping).

### Retention and background

A conversation is **attached** while a client's stream of it is open or its
worker is still opening it, and **detached** otherwise; phones see this as
the session's `runtimeState`. A detached conversation stays open in its
worker for 30 minutes by default, so attaching again finds it warm. The timer
runs only while the conversation is idle: no turn or other operation holds
it, no work runs (a background job, a subagent, a review, an approved host
action, or extension work), and no operation, such as a review discussion
start, holds it open. When the timer fires, the worker closes the conversation
(its extensions receive `session_shutdown`), unless it turned active in the
meantime. Work suspended since a restart and host actions still waiting for
approval keep nothing alive: they stay in the log and the conversation closes
as any idle one does; a suspended subagent resumes once a client asks after the
conversation opens again, and a pending approval ends with the conversation.

The retention time is `detachedRuntimeTtlMs` (milliseconds) under `settings`
in the daemon's `state.json`, read when the daemon starts. Edit it while the
daemon is stopped; the daemon rewrites the file while it runs.

Quitting the TUI detaches it; the conversation keeps running in its worker.
If a turn is running when you quit, the TUI asks: **Stop turn and quit** (the
default) stops the turn first, and **Leave running in background** quits and
lets the turn finish in the worker. Other running work, such as a background
job, keeps running without a question. `volt -c` or `volt -r` later attaches
to the conversation again, including to a turn that is still running.

A `--no-session` conversation exists only in its worker's memory: only the
TUI that opened it can attach to it, it is not listed, and it closes 10
seconds after that TUI's last connection to it ends.

### Several terminals and phones

Every client attaches to the same conversation: there is no read-only mode
and no handoff. Phones reach every conversation of a workspace, wherever in it
a terminal or phone started it: at its root, in any of its subdirectories, or
in a checkout of one of its managed worktrees (see [Session
storage](#session-storage)). Prompts from any client follow the usual rules while a turn
streams (steer or follow up) and appear in every client. A dialog, such as an
extension's confirmation, goes to every attached client that can answer it,
and the first answer wins.

When a client starts a new session, resumes, forks, clones, or imports, only
that client moves; other clients of the conversation stay on it. The client
receives its intent's answer, its stream ends with `ended{moved}` naming the
new session, and it reconnects there, which opens the new session in a worker
like any other open. The conversation it left stays open in its worker for its
other clients, or detached under the retention rules above (see
[Sessions](sessions.md#work-and-switching-sessions) for when a client may
leave a conversation whose work is running). A phone's move is
also recorded as its last session. Executing a plan in a new session queues
the plan's execution in the new session, where it starts once the client
reconnects. A session change an extension starts (`ctx.newSession()`,
`ctx.fork()`, `ctx.switchSession()`) opens the new session in the same worker,
and the extension's `withSession` callback runs there for phones and
terminals alike.

Abort is non-destructive: stopping a turn never closes streams or
conversations.

A phone attached to a conversation a TUI opened uses the tools of that
conversation's worker, which are the TUI's local tool set; `remote.allowTools`
applies only to conversations a phone opened. A phone attaching to a
conversation another phone opened with tools beyond its own grant is refused
with `conversation_in_use`. See [Security](security.md).

### Project trust

A conversation's worker decides its project trust as non-interactive Volt
does: user/global and `-e` extensions' `project_trust` handlers first, then
the saved decision in `trust.json`, then `defaultProjectTrust`, then the
built-in trust prompt. The prompt, and any dialog a `project_trust` handler
shows, appears in the TUI that opened the conversation; the TUI then reads its
own display settings with the trust the worker decided. `--approve` and
`--no-approve` decide trust for the startup conversation's project without
asking.

A decision for this session only applies to that project in the same
worker, for the same TUI's later conversations, never to another terminal's.
It is asked again after the worker exits or crashes, or when the
conversation opens in another worker. Dismissing the prompt leaves that
conversation untrusted and saves nothing; the conversation keeps that trust
while its worker hosts it. Quitting before you answer opens nothing.

### Settings and credentials

Each worker watches the global and project `settings.json`, `auth.json`, and
`models.json`. A change written by any process, such as `/settings` or
`/login` in another terminal, reaches the conversations of every live worker:
their settings reload (extensions see `settings_changed`) and their
credentials and model lists refresh. The daemon reads `remote.allowTools` and
`remote.pullRequestDiscovery` from the global settings when it starts.

### Crashes, restarts, and stopping

- **A worker crashes or is killed.** The daemon closes its clients' streams.
  The TUI keeps the transcript on screen, shows "Reconnecting", and opens the
  conversation again with backoff (at most 5 seconds apart), which starts a
  new worker from the stored session and resumes the transcript where the TUI
  left it. A turn in flight is lost. A `--no-session` conversation cannot be
  recovered: the TUI reports that it was kept only in its worker's memory.
- **`volt daemon stop`, `volt daemon restart`, or `volt update`.** The daemon
  admits nothing new, tells its TUIs it is shutting down, and stops each
  worker: a running turn may finish for up to 60 seconds, then the worker
  closes its conversations and exits. Open TUIs show "Host restarting" and
  reconnect when the daemon is back. If no daemon is back after 10 seconds, a
  TUI starts one itself. To keep the daemon stopped, quit your TUIs first.
- **The daemon crashes or is killed.** Its workers accept no more input, let a
  running turn finish for up to 60 seconds, and exit; a worker never outlives
  its daemon. A new daemon serves nothing until the previous daemon's workers
  have exited: it waits up to 75 seconds for them, and if they are still
  running it exits without starting (exit code 7) and its log names the worker
  logs to check. Meanwhile a TUI reconnecting to it shows that it is waiting
  for the previous daemon's conversations to stop.
- A replacement worker waits up to 75 seconds for the previous holder of a
  conversation's lock to exit before the open fails with
  `conversation_locked`.

### Idle exit

A daemon started by `volt` or `volt daemon start` exits after five minutes in
which it has no workers, no connected local clients (an open TUI or `/remote`
keeps a connection), and no paired devices. A daemon the login service runs
never exits for being idle. Interactive Volt starts the daemon again when you
next run it.

### Version skew

A TUI only attaches to a daemon running the same Volt version, because
workers always run the daemon's installation. If the daemon runs another
version:

- When the TUI starts and the daemon is idle (no workers, no phone
  connections) and was started from a terminal, the TUI restarts it from its
  own installation and continues.
- When the login service runs an idle daemon, the TUI refuses and asks you to
  run `volt daemon install-service` from the TUI's installation.
- Otherwise (it has workers or connected phones, or the TUI reconnects to it
  later), the TUI refuses with the version of each side and `volt daemon
  restart` guidance; restarting stops any running conversations.
- A daemon that speaks another control protocol is never restarted
  automatically: the TUI asks you to run `volt daemon restart`.

`volt update` restarts the daemon from the updated installation, so in
practice skew comes from source checkouts and multiple installations. To run
Volt from a source checkout next to an installed daemon, give it its own
agent directory, for example `VOLT_CODING_AGENT_DIR=$(mktemp -d)`.

### Worker logs

Each worker's standard output and error go to
`~/.volt/agent/daemon/workers/<workerId>.log` (mode `0600`, in a `0700`
directory); `volt daemon status` and `/remote` show which worker hosts which
conversation, and `volt daemon status` prints each worker's log path. The
daemon keeps the logs of running workers and the 49 most recent others. A
worker logs the names of its environment variables, never their values.

## Daemon environment

A conversation a TUI opened runs with that TUI's environment, except the
daemon's own relay credentials (`VOLT_IROH_RELAY_AUTH_TOKEN` and
`VOLT_PUSH_RELAY_AUTH_TOKEN`), and every conversation its worker hosts shares
it. A worker's environment is fixed for its lifetime.

A conversation a phone opened runs with the daemon's environment, so its bash
commands, language servers, MCP servers, tool installers, and Git resolve
through it. This includes a TUI's session that a phone resumes after its
worker exited. Whether the login service or a terminal started the daemon, it
builds that environment the same way at startup:

1. It takes the environment a new terminal session starts from, before any
   shell profile runs:
   - Started by the login service (`volt daemon install-service`): the
     environment launchd or the systemd user manager gave the daemon. This
     includes their `PATH`, values set with `launchctl setenv` or
     `systemctl --user set-environment`, `environment.d` files, and variables
     the desktop session imports, such as `DISPLAY` and `WAYLAND_DISPLAY`.
   - Started from a terminal on Linux: the systemd user manager's environment
     (what `systemctl --user show-environment` prints), read with `busctl`.
   - Otherwise, for example started from a terminal on macOS or without a
     systemd user session: the system default `PATH` plus `HOME`, `USER`,
     `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `XDG_*`, `SSH_AUTH_SOCK`,
     `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `WAYLAND_DISPLAY`, and
     `XAUTHORITY` from the process that started it.
2. It runs your login shell (from the user database, falling back to `SHELL`)
   from that environment, as an interactive login shell (`-i -l -c`) without a
   terminal.
3. It adopts the environment the shell produces, so `PATH` and the variables
   your shell profile exports match a new terminal. `VOLT_*` variables from
   the process that started the daemon are kept.

Supported login shells are bash, zsh, fish, sh, dash, and ksh. While
resolving, the shell runs with `VOLT_RESOLVING_ENVIRONMENT=1`. If your profile
starts interactive programs or prompts, for example auto-attaching tmux, skip
that work when the variable is set:

```sh
if [ -z "$VOLT_RESOLVING_ENVIRONMENT" ]; then
  # interactive-only setup
fi
```

If the shell is unsupported, exits without printing an environment, or takes
longer than 10 seconds, the daemon keeps the environment it was started with
and logs a warning. Windows always keeps the inherited environment, which for
a daemon interactive Volt started is that terminal's. To skip resolution,
start the daemon with `VOLT_DAEMON_INHERIT_ENV=1`, for example
`VOLT_DAEMON_INHERIT_ENV=1 volt daemon restart`.

Consequences:

- Variables exported only in the terminal that started the daemon, including
  API keys, do not reach conversations phones open. Export them from your
  shell profile (or on Linux, an `environment.d` file) instead.
- The environment is resolved once per daemon start. After changing `PATH` or
  your shell profile, run `volt daemon restart`.
- `volt daemon restart` starts the daemon from your terminal, not through the
  login service. On macOS, values set with `launchctl setenv` therefore reach
  the daemon only when the login service starts it. To restart through the
  service, run `volt daemon stop`, then
  `launchctl kickstart -k gui/$(id -u)/com.github.hansjm10.voltd` on macOS or
  `systemctl --user restart voltd.service` on Linux.
- Per-directory environments are not applied: direnv, activated virtualenvs,
  and hook-based version managers such as `mise activate`. Version managers
  that work through shims on `PATH` (asdf, mise shims) still pick the version
  for the session's working directory.

`volt daemon status` shows the result, for example
`environment: login shell /bin/zsh (service environment, 412ms)` or
`environment: inherited (timed out after 10000ms)`. The parenthesized base is
`service environment`, `systemd user environment`, or `minimal environment`,
matching the three cases above. `volt daemon logs` records the resolved `PATH`
and the names, not values, of variables the daemon started with that the
resolved environment no longer has. On failure it records the shell's exit
status and the end of its error output.

## Manage remote access from the TUI

Open `/remote` to inspect connections, pair a phone, and revoke device access.
It shows the daemon, phone transport and relay access, attached phones and
paired devices, the worker hosting the current conversation with its attached
clients, the registered workspaces, and every worker. Opening or refreshing it
does not register a workspace or change any conversation.

Choose **Register current directory** to register the exact current directory,
even when its parent is already registered. Repeating the action, including via
a symlink to the same directory, reuses the existing registration. New names
receive a numeric suffix when needed to avoid existing workspace names. A
managed worktree or its subdirectory cannot be registered separately: use its
parent workspace instead.

Registration updates the workspace list but does not move the current
conversation or modify the parent workspace.

For managed relays, **Relay access** reports enrollment, token expiry, inactive
Volt Pro subscriptions, and pending credential resets separately from the
local daemon endpoint. An endpoint marked ready does not mean relay access is
active.

Use **Pair a phone** for another phone using the same active subscription. If
Volt Pro is inactive, renew the existing subscription; the daemon checks again
automatically and reconnects existing phones without restarting or pairing again.
Automatic checks run every 15 seconds for a computer that lost relay access less
than a day ago, every 5 minutes for up to a week, then hourly. **Relay access**
shows when the next check runs. After renewing, choose **Check relay access now**
to check immediately. If the renewal is not recognized yet, Volt keeps checking;
if Apple's renewal notification is missed, confirmation can take up to about an
hour. **Refresh status** reloads the display, not the subscription itself.

To enroll using a different subscribed phone, choose **Reset credentials and
pair again…**. Review the confirmation (Cancel is selected by default). Reset
revokes the computer's entire managed relay grant, including its phones' relay
credentials, and cancels outstanding pairing codes. It preserves the computer
identity, workspaces, worktrees, conversations, and existing device permissions.
**It does not revoke direct device access**; revoke old phones separately under
**Paired devices**.

After reset, choose the new phone's access level and workspace, then scan the
fresh pairing QR and verify its details. No daemon restart is needed. If the
broker is unavailable, the reset remains pending: retry it when online before
pairing. On the CLI, the equivalent is `volt remote credential revoke`, followed
by `volt remote pair` after revocation succeeds; the CLI revoke command runs
without an interactive confirmation.

## File layout

Everything lives under `~/.volt/agent/daemon/` (mode `0700`):

| File | Purpose |
|------|---------|
| `voltd.sock` | Control socket (JSONL protocol; mode `0600`); a named pipe on Windows |
| `voltd.pid` | Advisory pidfile; liveness truth is always a socket probe |
| `voltd.log` | Daemon log (`volt daemon logs`) |
| `state.json` | Iroh secret key, paired clients, workspaces, settings (`0600`) |
| `changes.json` | Private, bounded session-to-change and pull-request associations (`0600`) |
| `audit.jsonl` | Append-only audit log (pairing, revocation, workers, relays, lifecycle) |
| `workers/` | One log per conversation worker (see [Worker logs](#worker-logs)) |

On first start the daemon migrates the legacy `remote/iroh-host.json` state
file automatically and renames it to `.migrated`. A pre-grant file keeps the
Iroh secret key (so the saved host identity does not rotate) plus validated
workspace/worktree metadata, but intentionally drops active clients, revoked
clients, and pending pairing tickets. The daemon logs and audits this expected
migration as `legacy_remote_access_dropped`; it is not corruption. Every old
client must pair again to receive an explicit current grant.

## Session storage

Conversation history uses the same authoritative SQLite storage as local Volt:
the default store, `~/.volt/agent/sessions/sessions.sqlite`, holds the sessions
of every working directory, each recorded with the real path of the directory it
was started in (see [Sessions](sessions.md#session-storage)). A session belongs
to the workspace where that directory runs, by the rule a TUI's conversation is
placed with: the innermost managed worktree containing it (its parent
workspace), else the innermost registered workspace containing it. So a
workspace's phones list and open the sessions started anywhere under its root or
in its worktrees' checkouts, except under a subdirectory registered as a
workspace of its own (a local-only one too), and never a session of a sibling
directory whose path only starts with the workspace's. A session of a worktree
whose record was removed, and a session of an explicitly configured session
directory, belong to no workspace for phones. A phone's new conversation cannot
take the ID of a stored session its workspace does not own
(`invalid_conversation_target`). Session lists and resumes use the store's
indexes. The daemon addresses conversations by stable workspace/session IDs and
never sends the database path, session directory, or host-side
`SessionReference` over the remote wire.

A worker that starts for a conversation opens it from SQLite; nothing moves
between workers in memory.

## Configured remote agents

Hosts advertising `agent_options.v1` expose a read-only workspace-discovery
stream with purpose `agent_options`. `get_agent_options` requires
`model.select.v1`, is bound to the stream-authorized workspace, and returns the
current authenticated model catalog plus a complete default model, thinking,
Fast, and Build/Plan configuration. Discovery creates no session or worker,
changes no selection, provisions no worktree, and does not mutate host
defaults.

Clients own configured-agent setup. They keep one caller-generated session ID
for the retry intent, optionally provision a deterministic worktree through
`create_worktree`, then open a normal conversation with `target:"new"`, that
session ID, and the chosen placement. The first attach creates the exact
session identity; identical retries resume it, including after daemon restart,
and concurrent attempts wait for the same conversation to open. Reusing the ID
with a different workspace, worktree, or working directory fails closed.

After attach, clients apply model, thinking level, Fast mode, and Build/Plan
mode as session-only intents, in that order, before sending the initial prompt.
A configuration failure leaves one empty resumable session and sends no prompt.
A successfully provisioned worktree is intentionally retained if a later step
fails; the client offers retry or explicit removal instead of expecting the
daemon to roll unrelated resources back. Prompt retries reuse the prompt's
intent ID, which is its durable client message ID, so neither configured attach
nor prompt delivery needs a launch receipt or transaction store.

## App-started pull-request reviews

Select the repository and PR before creating a review conversation. The app
resolves the PR without starting an agent, then asks the daemon to prepare its
exact reviewed commit. This requires `conversation.observe.v1` for discovery
and both `conversation.control.v1` and `worktrees.manage.v1` for preparation;
ordinary coding/review/chat presets do not grant worktree management.

The daemon reuses only a clean, idle, registered worktree with the correct
repository, PR branch and commit (or matching host-owned PR metadata).
Otherwise it creates a dedicated worktree and local branch at the verified PR
head, including fork PRs. It never switches, resets or stashes the parent
checkout, installs dependencies, or runs checkout hooks or filters.

The app keeps one session ID for each launch intent. Preparation durably binds
that ID to its checkout; identical retries retain the placement across daemon
restarts. Only after preparation succeeds does the app attach and configure
that session, then start the review. Changed identities or moved heads fail
explicitly: select and prepare a new review instead of retargeting an existing
one. Successful checkouts remain after cancellation or later configuration
failure, available for retry or explicit worktree removal.

General, findings handoffs and finding discussions inherit the same checkout.
Ordinary discussion/fix prompts may edit it; resume never undoes those edits.
Starting another bound PR review requires a clean checkout at the original PR
head. The original repository selection remains authoritative even though the
new local branch has a generated name. Local/unprepared and non-PR reviews
retain their existing behavior. See the [wire contract](iroh-remote-protocol.md#prepared-pull-request-reviews).

## Change and pull-request association

Each worker reports fresh path-free Git branch state for the conversations it
hosts over its own daemon connection; the daemon accepts it only from the
worker hosting that conversation, under the workspace's current registration.
A new session or fork a client starts from a conversation inherits that
conversation's association when it is a stored session the workspace owns (see
[Session storage](#session-storage)), as every conversation started in the
workspace or its worktrees is. Phone input and
`sessions` queries cannot choose an association or start provider discovery.

For trusted workspaces, the daemon uses configured Git remotes plus the local
authenticated `gh` CLI to match the exact head repository, branch, and object
ID. Provider failure remains distinct from “no pull request,” ambiguous matches
are not guessed, and configured/default base branches such as `main` are not
grouped across sessions. A positive PR match is sticky: later checkouts,
refresh failures, branch reuse, or a newer PR do not silently move the session
to another change. Set `remote.pullRequestDiscovery: false` to disable provider
calls.

Once a PR is linked, the daemon keeps its status current in the background,
whether or not the session is still on the PR branch or open in a worker,
and across daemon restarts. It refreshes every linked open or draft PR with one
batched `gh api graphql` query per GitHub host: about every minute while any
client stream is open or was open in the last few minutes, and about every 15
minutes otherwise. It also refreshes right away on daemon start, when a session
leaves a PR branch, and when a session's conversation closes. A PR stops being
refreshed once it is merged or closed. A closed PR that is later reopened is
picked up again only when a session returns to its branch. Reads never wait on
GitHub; they return the stored status.

Associations are stored separately in private `changes.json`. The file uses
opaque local IDs and a salted hash of the common Git directory, and stores each
linked PR's repository host, owner, and name so its status can be refreshed
after the branch is gone. Checkout paths, repository identities, credentials,
raw provider output, and provider diagnostics are not projected to phones. A
`sessions` entry's `changeContext` contains only the opaque change ID,
repository display name, effective branch, resolution state, and bounded PR
summary described in [Iroh Remote Protocol](iroh-remote-protocol.md#workspace-streams).

## Git worktrees

Concurrent sessions in one workspace share one checkout by default — two
agents will step on each other's files and branches. The daemon can instead
run a session inside a **daemon-managed git worktree**: an isolated checkout
on its own branch under `~/.volt/agent/worktrees/` (0700). Create worktrees
with `volt remote worktree add`, from the TUI's `/worktree` command, or from a
paired phone (`manage_worktrees` stream, gated on the `worktrees.v1` feature);
then open a conversation with `target:"new"`, a caller-generated `sessionId`,
and a `worktreeId`.

Key behaviors:

- **Sessions stay with the parent workspace.** Worktree sessions use the
  parent workspace's SQLite store and remain listed there; push
  notifications and `list_sessions` are unchanged. The daemon persists a
  session→worktree binding so resumes (a phone reattaching, a daemon restart,
  a TUI resuming the session) land back in the worktree checkout.
- **Policy inheritance.** A worktree conversation uses exactly the parent
  workspace's trust decision and tool allowlist — never wider. Trust is never
  prompted for or persisted on worktree paths.
- **Branch layout.** Each worktree gets its own branch (default
  `volt/<id>`) off the recorded base ref (default: the checkout's current
  branch). `volt remote worktree list` shows dirtiness and ahead/behind counts
  against the base; `volt remote worktree diff <id>` shows the branch diff.
  Merging back is always a user action — the daemon never mutates the main
  checkout.
- **Removal safety.** `worktree remove` refuses dirty worktrees, and worktrees
  with a conversation open in a worker, without `--force`; force closes those
  conversations first. `worktree prune` reconciles records against the
  filesystem and quarantines unrecognized directories by renaming (never
  deleting) them.
- **Fresh checkouts are fresh.** Worktrees share git objects but not
  untracked files: `node_modules`, virtualenvs, and build caches must be
  reinstalled per worktree.

Cleanup policies live in `state.json` under `settings.worktreeCleanup`:

```json
{ "worktreeCleanup": { "retention": { "enabled": true, "ttlMs": 3600000 }, "pruneOnStart": true } }
```

- `retention` (on by default, one hour): reclaim inactive, disposable checkouts
  after their conversation closes. Deadlines survive daemon restarts, and skipped
  checkouts are retried. Clean review snapshots at their recorded PR head and
  clean agent branches fully merged into their recorded base are eligible.
  Before refusing a new checkout at the 16-checkout limit, Volt also attempts
  reclamation regardless of the retention timer setting.
- Automatic reclamation preserves branches, exact commits, session bindings,
  transcripts, and review receipts. Resume recreates the same checkout at the
  recorded commit; a moved branch or changed repository fails explicitly rather
  than redirecting the session or resetting user work. Archived records remain
  listed with `available:false` until restored and do not consume checkout capacity.
- Resuming a session checks archive recovery state even when the checkout
  directory already exists. Every Volt process with a session open in a managed
  checkout (a worker, or a print, JSON, or RPC run) holds a lock on that
  checkout until the session closes; startup failures release it. When the
  checkout was archived, the daemon restores it first: interactive Volt asks
  before it opens the conversation, a worker asks over its own daemon
  connection, and other processes use a local control connection. The local
  `worktree_restore` request restores and acquires connection-owned protection
  before reporting success. Closing the connection releases it, including when
  restoration finishes after disconnect.
- Conversations open in a worker, pending review launches, conversation
  preparations, locked checkouts, dirty/untracked/ignored files, submodules,
  and ambiguous ownership block reclamation. Adopted checkouts and older agent
  records without disposable provenance are retained. Automatic cleanup never
  forces deletion or deletes branches. Reclamation and skip reasons appear in
  the audit log.
- `pruneOnStart` (default `true`): reconcile worktree records and checkouts
  during daemon startup, retaining archived records and their session bindings.

If every checkout is protected, `worktree_limit_reached` means checkout capacity,
not a GitHub-access problem. Finish active sessions, inspect
`volt remote worktree list --workspace <name>`, preserve or merge outstanding work,
and explicitly remove only checkouts you no longer need before retrying. Do not
use `--force` as routine capacity recovery.

Downgrade caveat: older daemons drop the `worktrees` state collection on
their next write. Checkouts survive on disk as orphans; re-upgrading and
running `volt remote worktree prune` quarantines them.

## Optional: theme token push (experimental)

With `VOLT_HOST_THEME_TOKENS=1` in the daemon's environment (or
`settings.themeTokenPush` in `state.json`), the daemon shares its resolved
theme colors with phones in the `host_status` query's `theme` (hex color values
only — nothing path-like ever crosses the wire) and announces a theme change
with `changed{host}`. Off by default; clients that ignore the field are fully
supported.

## Troubleshooting

- `volt daemon start` and `restart` wait up to 60 seconds after spawning for
  local control readiness, returning sooner when ready or when the child exits.
  This is separate from phone transport readiness. If the wait expires with the
  child still alive, the command exits nonzero but leaves it running and reports
  its PID with “readiness unconfirmed.” Check `volt daemon status` and the reported
  log before retrying; slow source loading, or a new daemon waiting for a
  previous daemon's workers (up to 75 seconds), can delay the control endpoint.
- `volt daemon status --json` reports `remoteTransport.state` as `starting`,
  `ready`, `degraded`, or `unavailable`, plus a safe reason code/message and the
  wrapper version when discoverable. For managed relays, `relayCredential.state`
  reports relay access and `relayCredential.nextRefreshAt` the next automatic
  check. Both daemon and remote status exit nonzero unless phone transport is
  `ready` and managed relay access is not `expired`, `subscription_inactive`, or
  `revocation_pending`, except that `volt daemon status` exits 0 when the build
  has no phone transport (`native_binding_missing`); local daemon
  workspace/client maintenance remains available while it is not ready.
- The TUI refuses to start because the daemon runs another Volt version → see
  [Version skew](#version-skew). The CLI (`volt daemon status`, `volt remote`)
  cannot use a daemon that speaks another control protocol either; run `volt
  daemon restart` after upgrading Volt.
- The daemon exits at start with code 7 → workers of a previous daemon are
  still running. Their pids are on the first line of each log in
  `~/.volt/agent/daemon/workers/`; wait for them to finish or stop them, then
  start the daemon again.
- A conversation misbehaves → read its worker's log (`volt daemon status`
  prints the path), or `volt daemon logs` for the daemon's side.
- `native_binding_missing` → reinstall without `--omit=optional` on a supported
  platform. Darwin x64 is intentionally local CLI/TUI only, and a standalone
  binary never bundles the binding: install Volt from npm to pair a phone.
- `endpoint_start_failed` → inspect `volt daemon logs`, fix the reported host
  issue, then restart the daemon.
- `host_storage_full` → free computer disk/quota capacity, then retry. Rejected
  handshakes do not create an in-memory authorization, and the phone keeps its
  saved pairing, selected agent, and transcript.
- `volt daemon status` reports that the daemon is not running → run `volt daemon
  start` and check `volt daemon logs`.
- Stale socket after a crash: `volt daemon start` probes the socket, unlinks
  it when dead, and rebinds.
- A second daemon on the same agent dir exits immediately (single-instance is
  guaranteed by the socket bind).
- Phone shows an "in use" error (`conversation_in_use`): another phone opened
  the conversation, and its worker runs with tools outside this phone's
  persisted grant, so this phone cannot safely attach. Re-pair with a
  compatible grant, or let that conversation close. A
  `duplicate_conversation_connection` error instead means the same phone raced
  two connections and retries on its own.
- `conversation_locked` → another Volt process (for example `volt -p` or an SDK
  embedding) has the session open. Quit it there; interactive Volt and phones
  can attach to a session a worker hosts at any time.
- Full audit trail: `~/.volt/agent/daemon/audit.jsonl` records pairing,
  revocation, workers starting and exiting, relays, and daemon lifecycle for
  post-hoc review.

## Manual walk-away checklist

See [scripts/manual-walkaway.md](../scripts/manual-walkaway.md) for the full
end-to-end verification script (a TUI and a phone on one conversation,
quitting to the background and attaching again, a worker crash, and daemon
restart behavior).
