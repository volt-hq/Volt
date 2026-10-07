# Volt conversation hosting — formal (TLA+) specification

## In plain terms

Volt's hardest bugs aren't in any one function — they're in *who hosts a
conversation* as clients come and go between the desktop terminal, the
background daemon, its conversation workers, and the phone, and in *what order*
things get opened, closed, and replaced. Those are exactly the bugs ordinary
tests miss, because they only show up in a specific interleaving of events
across several programs.

This directory holds a formal model of that behavior. A model is a precise,
executable description of the rules; a checker (TLC) then explores **every**
reachable interleaving and reports the first one that breaks a rule. It's a way
to test the *design* exhaustively before trusting it in code.

Four modules are written and model-checked with TLC; each is checkable on its own
via `./check.sh <Module>`. **`WorkerRegistry` is the model of record for the
host/worker protocol** (architecture rewrite Phase 7, daemon-hosted
conversations). The two models of the ownership-transfer design it replaced
were deleted with that code (Phase 7 slice 9).

> Keep these files beside their RFCs (`docs/daemon-hosted-conversations-design.md`
> for `WorkerRegistry`, `docs/live-shared-session-daemon-design.md` for the
> phone-side modules). When the design changes, change the model first, watch
> the check break, then change the code. If they drift, the model stops meaning
> anything.

---

## Status

| Module | What it covers (plain) | State |
|--------|------------------------|-------|
| **`WorkerRegistry`** | Which worker process hosts each conversation: spawning, sharing a worker among compatible conversations, attaching, relay offers, the per-log lock, per-conversation retention, retirement, crashes, workspace fences, and daemon loss. | **Model of record. Verified green** with shared workers and the restart wait (1,102,474 distinct states with liveness; safety variants 7,539,110 and 9,667,010). `WorkerRegistry.tla` / `.cfg`, safety variants `WorkerRegistrySafety.cfg` and `WorkerRegistrySharing.cfg`, variant `WorkerRegistryOrphans.cfg` (the finding below, without the restart wait) |
| **`SessionTarget`** | Picking the right session on connect, so a phone never pins the wrong one. | **Verified green** (28 states) before its rekey overlay was removed; not re-run since (24 states by construction). `SessionTarget.tla` / `.cfg` |
| **`ClientAuth`** | Pairing, revoking, and re-pairing a phone. | **Verified green** (9,678 states). `ClientAuth.tla` / `.cfg` |
| **`ClientConn`** | The phone's own connect / reconnect / detach / abort behavior. | **Verified green** (176 states). `ClientConn.tla` / `.cfg` |

**Running the checker.** `./check.sh` runs TLC on `WorkerRegistry` (it
auto-downloads `tla2tools.jar` on first run; needs a JDK 17+ via `JAVA_HOME` or
`java` on PATH). No CI job runs TLC; run it by hand, and re-run it in every
change to registry semantics. See [How to run](#how-to-run).

---

## What the models found

**`WorkerRegistry` — an orphan can outlive a workspace mutation (fixed: the restart wait).**
When the daemon dies, its workers stop taking input, finish their turn (60 s
cap), and exit. A restarted daemon starts from an empty registry, so it does not
know those orphans. If a workspace is then replaced, unregistered, or has its
access tightened, the restarted daemon finds no worker of the fenced generation,
reports success, and readmits the workspace while an orphan of the old
generation may still be running a turn in it. That breaks the workspace
authority rule that a mutation succeeds only after every old-generation owner is
terminal (`docs/workspace-authority-lifecycle-design.md` W4/W5). TLC trace
(`WorkerRegistryOrphans.cfg`): `RequestOpen → Spawn → DaemonCrash → DaemonRestart
→ FenceWorkspace → WorkspaceRetired`, with the spawned worker still alive; with
`WorkerOpen → WorkerReady → TurnStart` before the crash, the same steps leave an
orphan running a turn in the fenced workspace. The predicates that catch it are
`RetireReportsAfterExit` and `NoGenerationOverlap`. **Fixed** (maintainer decision
2026-10-06, Phase 7 slice 5): a restarted daemon admits nothing until the previous
daemon's workers have exited. Every worker holds a shared lock on the daemon's
worker gate for its whole run (`src/daemon/worker-gate.ts`), and a starting daemon
takes the gate exclusively, and releases it, before it serves anything. The
baseline `.cfg` sets `RestartWaitsForOrphans = TRUE` with both predicates on;
`WorkerRegistryOrphans.cfg` keeps the trace of the design without the wait.

---

## The `WorkerRegistry` module (model of record)

It models the daemon's worker registry (`src/daemon/worker-registry.ts`), the
worker lifecycle and spawn (`src/daemon/worker-launcher.ts`, `src/daemon/worker/`),
the compatibility key (`src/daemon/worker-spawn-options.ts`), relay offers
(`src/daemon/relay-stream.ts`), and the per-log lock
(`src/core/conversation-log/conversation-lock.ts`), as daemon-hosted
conversations RFC §4–§5 and the Phase 7 plan (#585) describe them, with the
maintainer's D11 revision (shared workers, Phase 7 slice 7b). With workers a
conversation's owner never changes, so there is no hand-off left to model; the
question is who hosts what, and when a host may go away.

### State

| Variable | Meaning |
|----------|---------|
| `wState[w]` | Registry view: `unused → starting → live → retiring → exited`; a refused stop returns `retiring → live`. Ids are never reused. |
| `alive[w]`, `opened[w]`, `lockOf[s]` | The worker process, the logs it has open, and the per-log OS lock. |
| `hosts[w]`, `wGen[w]`, `wKey[w]` | The registry assignment (its top-level conversations plus claims), the generation in the worker's key `(workspace, generation, session)`, and its compatibility key (its spawner's, fixed). |
| `tops[w]`, `grp[s]` | The worker's top-level conversations (at most `Cap`), and the top-level conversation whose group a hosted session is in (a claim joins its parent's). |
| `closeReq[w]`, `closeForced[w]` | Groups (by their top-level conversation) the registry asked the worker to close (`worker_close`), and of those the ones that cannot be refused. |
| `busy`, `closing[w]` | The conversations whose `HostedConversation.isActive()` holds, and whether the worker accepted `worker_stop`. |
| `want[c]`, `wantKey[c]`, `offer[c]`, `att[c]` | The session a client opens and its open's compatibility key, its unredeemed relay offer, and the worker serving its relayed stream. |
| `inSess`, `wire`, `acked`, `logCnt` | One durable input id per sending client: its session, the frame in flight, the ack, and how often the id was committed. |
| `daemonUp`, `gen`, `wsPending`, `faults` | The daemon, the workspace's authority generation, a fenced mutation in flight, and the fault budget. |

An open is routed by its outcome: `MintOffer` when a live worker of the current
key hosts the session (and its group is not closing), `RouteShared` when nobody
does and a live worker of the open's compatibility key has room, `Spawn` when
none has, and no step (waiting) while the host is starting or retiring or the
group closing. `WorkerOpen` takes a log's lock only while it is free, so a
replacement waits for the previous holder. Retention is per group
(`CloseDetachedIdle` sends `worker_close`); the worker answers `CloseRefused` if
a member turned active, else `CloseAccept` closes the group and releases it,
and a worker left with nothing retires (`worker_stop`, then `StopAccept` and
`Dispose`). `ForceClose` closes one group without the option to refuse (its
relays first; `ForceAbortClose` is the 60 s cap). A fence (`FenceWorkspace`) closes
admission, `RetireStale` closes the fenced workers' relays with `fatal` and
retires them without the option to refuse (`ForceAbort` is the 60 s cap), and
`WorkspaceRetired` reports success once they exited. `DaemonCrash` loses the
registry, its relays, and offers; live workers become orphans that exit by
`OrphanExit`, and `DaemonRestart` waits for them (the worker gate).

### Invariants checked (safety)

| Invariant | Plain meaning |
|-----------|---------------|
| `OneHost` | At most one registered worker hosts a session: spawns coalesce, an open waits for a retiring host, and claims of a hosted session are refused. |
| `OneWriter` | At most one live process has a log open, across daemon epochs too (an orphan and its replacement). |
| `LockCoherent` | A process has a log open exactly while it holds that log's lock. |
| `ReadyHoldsLocks` | A live worker opens only what the registry assigned it, and holds the lock of every log it has open. |
| `RetireWhenEmpty` | A starting or live worker always hosts something: one left with nothing retires. |
| `GroupsWellFormed` | Every hosted session belongs to the group of a top-level conversation of the same worker, and closes name top-level conversations. |
| `CapRespected` | A worker hosts at most `Cap` top-level conversations. |
| `AttachOnlyToLive` | A client is served only by a live worker that hosts its session and has that log open. |
| `NoOfferToRetiring` | Relay offers exist only for live workers. |
| `CloseOnlyDetached` | Nothing is offered to or attached to a member of a group being closed. |
| `NoLostInput` | An acknowledged input is in the durable log. |
| `ExactlyOnce` | No input id is committed twice, across lost acks, worker crashes, retirement, and daemon loss. |
| `RetireOnlyDetachedIdle` | A worker retires (without a fence) only detached, and a worker that accepted a stop is detached and idle and starts nothing. |
| `NoGenerationOverlap` | Two workspace generations never run at once (W5), across a daemon restart too. |

Action properties, checked as `PROPERTY`:

| Property | Plain meaning |
|----------|---------------|
| `OfferAdmittedOnce` | Every new attachment redeems the client's pending offer for exactly that worker and consumes it: an offer is admitted at most once. |
| `ClaimRespectsHost` | A worker gains a session only through a spawn, a route, or a claim under the current key, never one another registered worker hosts. |
| `RouteRespectsKey` | A top-level conversation enters a worker only for an open whose compatibility key is the worker's, and a worker keeps its key while registered. |
| `CloseScoped` | Closing one group, or beginning a forced close of it, leaves the worker's other groups hosted, open, running, and attached. |
| `FencedWorkersInert` | After a fence, no client newly attaches to a fenced worker and no fenced worker commits input. |
| `RetireReportsAfterExit` | A workspace mutation reports success only when no process of the fenced generation is alive (W4), an orphan of a dead daemon included. |

### Properties checked (liveness)

| Property | Plain meaning |
|----------|---------------|
| `OpenServed` | Every open is eventually attached, or answered (refused when every worker id is spent, or `fatal` for a fenced relay). |
| `RetiringExits` | A retiring worker exits, unless it refused a retention stop. |
| `StartingSettles` | A spawn becomes ready or exits. |
| `DetachedIdleCloses` | A detached, idle group is asked to close unless a client attaches, an open routes to it, or it turns active. |
| `ClosesSettle` | A close the registry asked for is refused or done. |
| `OrphansExit` | The workers of a dead daemon exit. |
| `WorkspaceRetireCompletes` | A fenced workspace mutation completes. |

Every daemon and worker step the design promises gets weak fairness: routing,
spawning, routing, opening, readiness, redemption, the TTL, the answers to
`worker_close` and `worker_stop` (one step each, whichever way it goes), disposal,
exit observation, the forced-abort caps, orphan exit, and restart. Client
choices, turns, claims, releases, fences, forced closes, and faults get none.
Faults (a worker crash, an offer expiry, a daemon crash) and forced closes of
one conversation share the budget `MaxFaults`, so liveness is checked for what
follows the last of them.

### Model decisions

These are choices the plan left open; each is the smallest shape that checks the
plan's properties.

- **One workspace.** The key's name part is constant, so a fenced generation
  stands for every authority mismatch (another workspace, replace, unregister,
  revoke, access tightening, worktree removal). The fence closes admission until
  the fenced workers exit (W3, W5), and a daemon crash mid-mutation rolls it back
  (W6).
- **Route is split into its outcomes** (`Spawn`, `MintOffer`, waiting). The daemon
  routes synchronously, so retention does not fire on a worker an open is being
  routed to.
- **The control connection is derived:** it lives while the worker and its daemon
  do. A lone connection drop is the orphan path for one worker.
- **A client's served session is `want[c]`;** `att[c]` names the worker, and
  `offer[c]` is its pending relay offer: redemption moves it into `att[c]` and
  expiry clears it, so "used" and "expired" need no flags of their own.
- **One input id per sending client** (`MaxInputs = 1`), and one sender
  (`Senders = {c1}`): ids are deduplicated independently, so a second sender
  repeats the same path. The dedupe is by the durable `clientMessageId`.
- **The registry's activity view is exact and per conversation.** A turn that
  starts after the registry sent `worker_close` (or `worker_stop`) stands for the
  debounced `worker_activity` lag, and the worker refuses it.
- **The compatibility key is an opaque value** each open carries (`Keys`); a
  worker keeps its spawner's. Its inputs (opener kind, environment, spawn-only
  options, tool policy, trust, profile) are the implementation's
  (`worker-spawn-options.ts`).
- **A group closes in one step:** the worker closes its members, claims first,
  releases each, and a worker left with nothing retires in the same turn. The
  implementation sends the releases one by one, the top-level conversation's
  last, and the registry refuses a top-level release while its group has members.
- **Worker ids are never reused.** When every id is spent, an open that needs a
  spawn is refused (`SpawnUnavailable`), a bound artifact.
- **A starting worker that gives up on a held lock** (75 s) is a `Crash`.
- **`Release` drops a conversation** (`worker_released`) the worker closed on its
  own (a claim, or a top-level conversation that lost its log, once its group is
  just itself), with its lock, no relay of it offered or attached there, and no
  open of it waiting (the daemon routes an open in the turn it arrives).
- **Not modeled:** tool policy and `conversation_in_use` (D9), in-process hosts
  holding a log's lock (D20), `--no-session` (D15; its worker is never shared),
  the cap on a worker's hosted conversations (claims count toward 256), a routed
  conversation whose open fails, graceful daemon stop (the forced retirement
  `RetireStale` applies to one workspace), and the handoff write a redirect makes
  to its target log (a lock-guarded write that fails the move when the target is
  held). The answer to an extension command that moves its own client is not
  written on the old relay, as `Redirect` assumes of earlier frames: the client
  retries the intent on its new connection and the host answers it from the
  client key's outcome window.

### Bounds and result

`WorkerRegistry.cfg`: `Sessions = {s1, s2}`, `Workers = {w1, w2}`,
`Clients = {c1, c2}`, `Senders = {c1}`, `Keys = {k1}`, `Cap = 2`,
`MaxFaults = 1`, `MaxGen = 1`, `RestartWaitsForOrphans = TRUE`, symmetry off
(liveness). TLC 2.19 on JDK 17, 6 workers (`-workers auto`, 10 cores): **1,102,474 distinct states**
(7,629,297 generated), depth 35; all fifteen invariants, the six action
properties, and the seven liveness properties hold; about 18 minutes on a
shared machine. Shared workers multiply the reachable configurations
(the pre-sharing model had 495,727 distinct states with three worker ids), so
the liveness run keeps two worker ids and the larger bounds are checked for
safety:

- `WorkerRegistrySafety.cfg` (the baseline with `Workers = {w1, w2, w3}`): 7,539,110
  distinct states, depth 45, every invariant and action property, about 1.5 minutes.
- `WorkerRegistrySharing.cfg` (`Sessions = {s1, s2, s3}`, `Workers = {w1, w2, w3}`,
  one client, `Keys = {k1, k2}`, `Cap = 2`, `MaxFaults = 1`, `MaxGen = 0`):
  9,667,010 distinct states, depth 45, every invariant and action property, about
  3 minutes. With two clients and no faults (an ad-hoc run) it reaches 50,971,912
  distinct states in 12 minutes, also green.

`WorkerRegistryOrphans.cfg` (`RestartWaitsForOrphans = FALSE`) reaches the
orphan trace above in seven states.

---

## How to run

```bash
./check.sh                                                # WorkerRegistry, baseline config (auto-fetches tla2tools.jar)
./check.sh WorkerRegistry WorkerRegistrySharing.cfg       # safety: differing keys and a binding cap
./check.sh WorkerRegistry WorkerRegistrySafety.cfg        # safety: a third worker id
./check.sh WorkerRegistry WorkerRegistryOrphans.cfg       # the orphan finding without the restart wait (a trace)
./check.sh ClientConn                                     # another module
```

`check.sh` needs a JDK 17+ (via `JAVA_HOME` or `java` on PATH). Equivalently, by hand:

```bash
java -XX:+UseParallelGC -jar tla2tools.jar -workers auto \
     -config WorkerRegistry.cfg WorkerRegistry.tla
```

A clean run prints `Model checking completed. No error has been found.` To see a
bug trace instead, run `WorkerRegistryOrphans.cfg`: TLC prints the shortest
sequence of states + action names that reaches the violation.

**Reading a counterexample as a Volt bug.** TLC gives you an ordered list of
states with the action name between each. Translate directly: a `OneHost` trace
ending in two registered hosts after `Spawn → Spawn` would be a routing bug that
spawned a second worker instead of waiting for the starting one; an `ExactlyOnce`
trace through `Accept → Crash → Spawn → … → Accept` would be a retry that the
durable `clientMessageId` failed to deduplicate.

---

## What a green check does and does not prove

A green run proves that **the model**, at these bounds and abstractions, cannot
reach a state that breaks the listed invariants and satisfies the liveness
properties under the stated fairness. That's strong evidence the *design* is
internally consistent and free of the specific race classes encoded.

It does **not** prove:

- **That the code matches the model.** The TS/Swift isn't generated from the
  spec; a correct model over a buggy implementation still checks green. The spec
  is a design artifact — it found the orphan trace because we modeled the
  design's *intent* and asserted more than the design guaranteed, not automatically.
- **Correctness beyond the bounds.** Two or three sessions, two or three worker
  ids, one or two clients, a cap of two, and one fault are strong evidence via
  small-model reasoning, not a proof for all N (the implementation's cap is six).
- **Anything abstracted away** — byte-level relay framing, real timers, transcript
  content, full async scheduling beyond the modeled windows.
- **Freedom from drift.** The biggest risk is the spec rotting as the RFC and code
  evolve. Cross-reference invariant names both ways (RFC and plan ↔ the names
  above) and re-run whenever a registry, lock, relay, retention, or close-reason
  change lands.

---

## Build order

`WorkerRegistry` is the spine; `SessionTarget`, `ClientAuth`, and `ClientConn`
are independent of it.

Full module scope, per-module invariant/property catalogs, and the shared
abstraction strategy live in [`PLAN.md`](PLAN.md).
