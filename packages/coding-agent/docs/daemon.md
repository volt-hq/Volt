# Background daemon (voltd)

`voltd` is a persistent background daemon that owns Volt's remote-access
plane: the stable Iroh endpoint identity, phone pairing and revocation,
workspace registration, push notification dispatch, headless conversation
runtimes, and the conversation lease broker that lets a phone and a desktop
TUI share one live conversation.

It replaces the old foreground `volt remote host` process. Remote access no
longer requires a dedicated terminal: the daemon keeps running when every TUI
is closed, and paired phones stay paired across restarts because the Iroh
secret key lives in the daemon's state file.

## Quick start

```bash
volt daemon start          # start the daemon (no-op if already running)
volt remote pair           # pair a phone (QR / ticket)
volt daemon status         # inspect workspaces, clients, leases
```

Set `remote.background: true` in settings to make interactive Volt manage the
daemon automatically: the TUI starts it on demand, registers its working
directory as a workspace, and acquires a conversation lease for the open
session so a paired phone can co-attach to it live.

## CLI

```
volt daemon start                 Start the background daemon.
volt daemon stop                  Graceful shutdown (state flushed, phones notified).
volt daemon status [--json]       Status; exit 0 when running, 1 when not.
volt daemon restart               Stop then start; persistent state survives.
volt daemon logs [-f] [-n N]      Tail the daemon log.
volt daemon install-service       Register a login service (launchd/systemd).
volt daemon uninstall-service     Remove the login service.
volt daemon run --foreground      Run in this process (internal; used by start).

volt remote pair [--workspace <name>]   Create a pairing ticket, wait for the phone.
volt remote status [--json]             Same status view as volt daemon status.
volt remote clients                     List paired clients.
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

`volt remote host` is gone; running it prints a pointer to `volt daemon
start`. The daemon requires Node.js with the optional `@number0/iroh` native
adapter (Bun binary builds cannot host it, matching the old restriction).

`volt daemon install-service` writes a launchd LaunchAgent (macOS) or a
systemd user unit (Linux) that starts the daemon at login. The service does
not auto-restart after a graceful `volt daemon stop`; on Linux, run
`loginctl enable-linger` if the daemon should also run without an active
login session.

## File layout

Everything lives under `~/.volt/agent/daemon/` (mode `0700`):

| File | Purpose |
|------|---------|
| `voltd.sock` | Control socket (JSONL protocol; mode `0600`) |
| `voltd.pid` | Advisory pidfile; liveness truth is always a socket probe |
| `voltd.log` | Daemon log (`volt daemon logs`) |
| `state.json` | Iroh secret key, paired clients, workspaces, settings (`0600`) |
| `audit.jsonl` | Append-only audit log (pairing, leases, relays, lifecycle) |

On first start the daemon migrates the legacy `remote/iroh-host.json` state
file automatically, carrying the Iroh secret key over verbatim so existing
phone pairings survive; the legacy file is renamed to `.migrated`.

## Conversation leases

Exactly one process owns the live runtime for each `(workspace, session)`
conversation at a time:

- **daemon-active / daemon-detached** — the daemon runs a headless runtime for
  phones. When the last phone disconnects, the runtime is retained for
  `remote.detachedRuntimeTtlMs` (default 30 minutes) so a reattach is warm.
- **tui-owned** — a desktop TUI owns the runtime. The daemon still terminates
  the phone's Iroh connection, then relays the raw stream bytes to the TUI,
  which serves it from its in-process session. Prompts from either side appear
  on both; the TUI footer shows `📱 n` while phones are attached.
- **daemon-draining** — a TUI asked to take over while a remote turn is
  streaming. The TUI shows a read-only "Attaching — finishing remote turn…"
  viewer, phones get transient `lease_draining` errors on new prompts, and
  ownership transfers at the turn boundary.

Handoffs are invisible on the phone: when a TUI takes over or quits, the
daemon closes phone streams with reason `lease_transferred` and the app
reconnects immediately to the new owner. Abort is non-destructive everywhere:
stopping a turn never closes streams or disposes runtimes.

When the TUI owns the lease, phone prompts run with the TUI session's full
local tool set. `remote.allowTools` applies only to daemon-owned headless
runtimes — see [Security](security.md).

## Git worktrees

Concurrent sessions in one workspace share one checkout by default — two
agents will step on each other's files and branches. The daemon can instead
run a session inside a **daemon-managed git worktree**: an isolated checkout
on its own branch under `~/.volt/agent/worktrees/` (0700). Create worktrees
with `volt remote worktree add`, from the TUI's `/worktree` command, or from a
paired phone (`manage_worktrees` stream, gated on the `worktrees.v1` feature);
then open a conversation with `target:"new"` plus a `worktreeId`.

Key behaviors:

- **Sessions stay with the parent workspace.** Worktree sessions are stored
  and listed under the parent workspace; leases, push notifications, and
  `list_sessions` are unchanged. The daemon persists a session→worktree
  binding so resumes (phone reattach, daemon restart, TUI takeover) land back
  in the worktree checkout.
- **Policy inheritance.** A worktree runtime uses exactly the parent
  workspace's trust decision and tool allowlist — never wider. Trust is never
  prompted for or persisted on worktree paths.
- **Branch layout.** Each worktree gets its own branch (default
  `volt/<id>`) off the recorded base ref (default: the checkout's current
  branch). `volt remote worktree list` shows dirtiness and ahead/behind counts
  against the base; `volt remote worktree diff <id>` shows the branch diff.
  Merging back is always a user action — the daemon never mutates the main
  checkout.
- **Removal safety.** `worktree remove` refuses dirty or in-use worktrees
  without `--force`; force stops bound runtimes first. `worktree prune`
  reconciles records against the filesystem and quarantines unrecognized
  directories by renaming (never deleting) them.
- **Fresh checkouts are fresh.** Worktrees share git objects but not
  untracked files: `node_modules`, virtualenvs, and build caches must be
  reinstalled per worktree.

Cleanup policies live in `state.json` under `settings.worktreeCleanup`:

```json
{ "worktreeCleanup": { "retention": { "enabled": true, "ttlMs": 3600000 }, "pruneOnStart": true } }
```

- `retention` (off by default): after a worktree-bound runtime is disposed,
  remove the worktree once the TTL expires — but only when it is clean and its
  branch is fully merged into the base ref. Skips are recorded in the audit
  log as `worktree_retention_skipped_dirty`; uncommitted work is never
  deleted.
- `pruneOnStart` (default `true`): reconcile worktree records and checkouts
  during daemon startup.

Downgrade caveat: older daemons drop the `worktrees` state collection on
their next write. Checkouts survive on disk as orphans; re-upgrading and
running `volt remote worktree prune` quarantines them.

## Optional: theme token push (experimental)

With `VOLT_HOST_THEME_TOKENS=1` in the daemon's environment (or
`settings.themeTokenPush` in `state.json`), the daemon pushes its resolved
theme colors to phones that advertise the `host_theme_tokens.v1` capability as
`host_theme_tokens` frames (hex color values only — nothing path-like ever
crosses the wire). Off by default; clients that ignore the frame are fully
supported.

## Troubleshooting

- `volt daemon status` exits 1 → the daemon is not running; `volt daemon
  start` and check `volt daemon logs`.
- Stale socket after a crash: `volt daemon start` probes the socket, unlinks
  it when dead, and rebinds.
- A second daemon on the same agent dir exits immediately (single-instance is
  guaranteed by the socket bind).
- Phone shows "in use"-style errors: never emitted by lease-capable daemons at
  handshake; a `duplicate_conversation_connection` error means the same phone
  raced two connections and retries on its own.
- Full audit trail: `~/.volt/agent/daemon/audit.jsonl` records pairing,
  revocation, lease transitions, and daemon lifecycle for post-hoc review.

## Manual walk-away checklist

See [scripts/manual-walkaway.md](../scripts/manual-walkaway.md) for the full
end-to-end verification script (TUI ↔ phone handoff in both directions,
mid-turn attach, abort semantics, and daemon restart behavior).
