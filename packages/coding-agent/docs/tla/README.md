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

Six modules are written and model-checked with TLC; each is checkable on its own
via `./check.sh <Module>`. **`WorkerRegistry` is the model of record for the
host/worker protocol** (architecture rewrite Phase 7, daemon-hosted
conversations). `LeaseBroker` and `RelayViewer` model the ownership-transfer
design it replaces; they stay until that code is deleted (Phase 7 slice 9), then
go with it.

> Keep these files beside their RFCs (`docs/daemon-hosted-conversations-design.md`
> for `WorkerRegistry`, `docs/live-shared-session-daemon-design.md` for the
> superseded modules). When the design changes, change the model first, watch
> the check break, then change the code. If they drift, the model stops meaning
> anything.

---

## Status

| Module | What it covers (plain) | State |
|--------|------------------------|-------|
| **`WorkerRegistry`** | Which worker process hosts each conversation: spawning, attaching, relay offers, the per-log lock, retirement, crashes, workspace fences, and daemon loss. | **Model of record. Verified green** (1,112,484 distinct states). `WorkerRegistry.tla` / `.cfg`, variants `WorkerRegistryOrphans.cfg` (finding below) and `WorkerRegistryRestartWaits.cfg` |
| **`LeaseBroker`** | Who held a conversation (daemon vs terminal) and how it handed off. | **Superseded by `WorkerRegistry`**; deleted with the lease code in Phase 7 slice 9. Last verified green (40,804 states). `LeaseBroker.tla` / `.cfg` |
| **`RelayViewer`** | The relay token + the "watch the turn finish" viewer feed during a hand-off. | **Superseded by `WorkerRegistry`** (relay offers) and the deletion of the viewer feed; deleted in Phase 7 slice 9. Last verified green (207,025 states). `RelayViewer.tla` / `.cfg` |
| **`SessionTarget`** | Picking the right session on connect, so a phone never pins the wrong one. | **Verified green** (28 states) before its rekey overlay was removed; not re-run since (24 states by construction). `SessionTarget.tla` / `.cfg` |
| **`ClientAuth`** | Pairing, revoking, and re-pairing a phone. | **Verified green** (9,678 states). `ClientAuth.tla` / `.cfg` |
| **`ClientConn`** | The phone's own connect / reconnect / detach / abort behavior. | **Verified green** (176 states). `ClientConn.tla` / `.cfg` |

**Running the checker.** `./check.sh` runs TLC on `WorkerRegistry` (it
auto-downloads `tla2tools.jar` on first run; needs a JDK 17+ via `JAVA_HOME` or
`java` on PATH). No CI job runs TLC; run it by hand, and re-run it in every
change to registry semantics. See [How to run](#how-to-run).

---

## What the models found

**`WorkerRegistry` — an orphan can outlive a workspace mutation (open).**
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
orphan running a turn in the fenced workspace. The predicates that catch it,
`RetireReportsAfterExit` and `NoGenerationOverlap`, are off in the baseline so it
models the plan's design. A fix is to have a restarted daemon admit nothing until
the previous daemon's workers have exited (for example, each worker holds a
shared lock that the daemon takes exclusively before it serves);
`WorkerRegistryRestartWaits.cfg` checks that variant green with both predicates
on. The decision belongs to the slice that implements daemon loss (Phase 7 slice
5).

**`LeaseBroker` (superseded), two issues in `lease-broker.ts`**, each reproduced
by TLC as a concrete trace (both invariants ship in `LeaseBroker.tla`, off by
default so the baseline stays green; add either to the `.cfg` to see it):

**1 — `streamCount` leak (fixed).**
In `runDrain`'s disposal-error recovery (~L388–408), the cancelled branch dropped
the lease to `unowned` but **never zeroed `record.streamCount`** — unlike the
success path (L409). Since `dropIfUnowned` requires `streamCount === 0`, the
record could never be dropped: a leaked `unowned` ghost that handed a phantom
stream count to the next acquirer. TLC trace: `CommitDaemonAttach →
PhoneStreamAttach → RuntimeStartTurn → AcquireDrainStart → DrainRuntimeIdle →
DrainCancelDisposing → DrainDisposeError`, ending in `unowned` with
`streamCount = 1`. **Fixed** in `lease-broker.ts` (zero `streamCount` in that catch
branch) with a regression test; `NoStreamLeak` is now in the baseline `.cfg` so it
stays fixed.

**2 — turn killed on TUI open after the phone walks away (resolved: intended).**
`acquireForTui` only *drains* when the state is `daemon-active` (L296). A turn
keeps running after the last phone detaches (RFC: "the prompt continues on the
host"), leaving a `daemon-detached` runtime that is still mid-turn; opening the TUI
then disposes it, killing that turn instead of draining it. The model surfaced this
(`IdleAcquireOnlyWhenIdle`, TLC trace `RuntimeStartTurn → PhoneStreamDetach →
AcquireIdleFlip`), and the decision came back: **this is intended** — once no
device is receiving the turn there is nothing to watch, so it is abandonable (the
same as closing a TUI mid-turn). Documented in the RFC §4.2 and the
`lease-broker.ts` comment; `IdleAcquireOnlyWhenIdle` stays off in the baseline as a
marker of that deliberate choice.

---

## The `WorkerRegistry` module (model of record)

It models the daemon's worker registry (`src/daemon/worker-registry.ts`), the
worker lifecycle and spawn (`src/daemon/worker-launcher.ts`, `src/daemon/worker/`),
relay offers (`src/daemon/relay-stream.ts`), and the per-log lock
(`src/core/conversation-log/conversation-lock.ts`), as daemon-hosted
conversations RFC §4–§5 and the Phase 7 plan (#585) describe them. With workers a
conversation's owner never changes, so there is no hand-off left to model; the
question is who hosts what, and when a host may go away.

### State

| Variable | Meaning |
|----------|---------|
| `wState[w]` | Registry view: `unused → starting → live → retiring → exited`; a refused stop returns `retiring → live`. Ids are never reused. |
| `alive[w]`, `opened[w]`, `lockOf[s]` | The worker process, the logs it has open, and the per-log OS lock. |
| `hosts[w]`, `wGen[w]` | The registry assignment (its spawn plus claims) and the generation in the worker's key `(workspace, generation, session)`. |
| `busy[w]`, `closing[w]` | `HostedConversation.isActive()`, and whether the worker accepted `worker_stop`. |
| `want[c]`, `offer[c]`, `att[c]` | The session a client opens, its unredeemed relay offer, and the worker serving its relayed stream. |
| `inSess`, `wire`, `acked`, `logCnt` | One durable input id per sending client: its session, the frame in flight, the ack, and how often the id was committed. |
| `daemonUp`, `gen`, `wsPending`, `faults` | The daemon, the workspace's authority generation, a fenced mutation in flight, and the fault budget. |

An open is routed by its outcome: `MintOffer` when a live worker of the current
key hosts the session, `Spawn` when nobody does, and no step (waiting) while the
host is starting or retiring. `WorkerOpen` takes a log's lock only while it is
free, so a replacement waits for the previous holder. Retention
(`RetireDetachedIdle`) sends `worker_stop`; the worker answers `StopRefused` if it
turned active, else `StopAccept` and `Dispose`. A fence (`FenceWorkspace`) closes
admission, `RetireStale` closes the fenced workers' relays with `fatal` and
retires them without the option to refuse (`ForceAbort` is the 60 s cap), and
`WorkspaceRetired` reports success once they exited. `DaemonCrash` loses the
registry, its relays, and offers; live workers become orphans that exit by
`OrphanExit`.

### Invariants checked (safety)

| Invariant | Plain meaning |
|-----------|---------------|
| `OneHost` | At most one registered worker hosts a session: spawns coalesce, an open waits for a retiring host, and claims of a hosted session are refused. |
| `OneWriter` | At most one live process has a log open, across daemon epochs too (an orphan and its replacement). |
| `LockCoherent` | A process has a log open exactly while it holds that log's lock. |
| `ReadyHoldsLocks` | A live worker has its primary open, opens only what the registry assigned it, and holds the lock of every log it has open. |
| `AttachOnlyToLive` | A client is served only by a live worker that hosts its session and has that log open. |
| `NoOfferToRetiring` | Relay offers exist only for live workers. |
| `NoLostInput` | An acknowledged input is in the durable log. |
| `ExactlyOnce` | No input id is committed twice, across lost acks, worker crashes, retirement, and daemon loss. |
| `RetireOnlyDetachedIdle` | Retention retires only a detached worker, and a worker that accepted a stop is detached and idle and starts nothing. |
| `NoGenerationOverlap` | *(off in the baseline)* Two workspace generations never run at once (W5). |

Action properties, checked as `PROPERTY`:

| Property | Plain meaning |
|----------|---------------|
| `OfferAdmittedOnce` | Every new attachment redeems the client's pending offer for exactly that worker and consumes it: an offer is admitted at most once. |
| `ClaimRespectsHost` | A worker gains a session only through a spawn or claim under the current key, never one another registered worker hosts. |
| `FencedWorkersInert` | After a fence, no client newly attaches to a fenced worker and no fenced worker commits input. |
| `RetireReportsAfterExit` | *(off in the baseline)* A workspace mutation reports success only when no process of the fenced generation is alive (W4). |

### Properties checked (liveness)

| Property | Plain meaning |
|----------|---------------|
| `OpenServed` | Every open is eventually attached, or answered (refused when every worker id is spent, or `fatal` for a fenced relay). |
| `RetiringExits` | A retiring worker exits, unless it refused a retention stop. |
| `StartingSettles` | A spawn becomes ready or exits. |
| `DetachedIdleRetires` | A detached, idle worker retires unless a client attaches or it turns active. |
| `OrphansExit` | The workers of a dead daemon exit. |
| `WorkspaceRetireCompletes` | A fenced workspace mutation completes. |

Every daemon and worker step the design promises gets weak fairness: routing,
spawning, opening, readiness, redemption, the TTL, the answer to `worker_stop`
(one step, whichever way it goes), disposal, exit observation, the forced-abort
cap, orphan exit, and restart. Client choices, turns, claims, fences, and faults
get none. Faults (a worker crash, an offer expiry, a daemon crash) share the
budget `MaxFaults`, so liveness is checked for what follows the last fault.

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
- **The registry's activity view is exact.** A turn that starts after the registry
  sent `worker_stop` stands for the debounced `worker_activity` lag, and the
  worker refuses the stop.
- **Worker ids are never reused.** When every id is spent, an open that needs a
  spawn is refused (`SpawnUnavailable`), a bound artifact.
- **A starting worker that gives up on a held lock** (75 s) is a `Crash`.
- **`Release` drops a claim** (`worker_released`) once the worker closed the
  conversation and its lock, with no relay of it offered or attached there and
  no open of it waiting (the daemon routes an open in the turn it arrives). The
  primary is not tracked: a release never closes a worker's last open log, which
  stands for the registry refusing the primary's release.
- **Not modeled:** tool policy and `conversation_in_use` (D9), in-process hosts
  holding a log's lock (D20), `--no-session` (D15), graceful daemon stop (the
  forced retirement `RetireStale` applies to one workspace), and the handoff
  write a redirect makes to its target log (a lock-guarded write that fails the
  move when the target is held).

### Bounds and result

`WorkerRegistry.cfg`: `Sessions = {s1, s2}`, `Workers = {w1, w2, w3}`,
`Clients = {c1, c2}`, `Senders = {c1}`, `MaxFaults = 1`, `MaxGen = 1`, symmetry
off (liveness). TLC 2.19 on JDK 17, 8 workers: **1,112,484 distinct states**
(6,423,426 generated), depth 42, all ten invariants, the three action
properties, and the six liveness properties hold; about 11 minutes on a shared
16-core machine. Safety alone takes seconds, so larger bounds are cheap for a run
without the liveness properties (`MaxFaults = 2`: 2,459,059 distinct states,
15 s).

`WorkerRegistryOrphans.cfg` reaches the orphan trace above in seven states.
`WorkerRegistryRestartWaits.cfg` (the fix) checks everything in the baseline plus
`RetireReportsAfterExit` and `NoGenerationOverlap`, green: 495,727 distinct
states, depth 42, about 4 minutes.

---

## The `LeaseBroker` module (superseded)

> Superseded by `WorkerRegistry`. It models the lease broker that Phase 7 deletes
> (slice 9); the file and this section go with that code.

### The five states (who holds the conversation)

`unowned` · `daemon-active` · `daemon-detached` · `daemon-draining` · `tui-owned`,
keyed on `(workspaceName, sessionId)` — `clientNodeId` is deliberately dropped, so
two phones are the *same* conversation, not two. See the header comment in
`LeaseBroker.tla` for the plain-English description of each.

### The one design decision that makes the check meaningful

The RFC's headline invariant is "one live runtime per conversation, and a daemon
runtime exists **iff** the state is `daemon-*`." The tempting way to model that —
define "runtime alive" as "state is `daemon-*`" — makes the invariant `X ⇔ X`: it
passes while proving nothing. (The first draft did exactly this; the review
caught it.)

The real code flips the lease to `tui-owned` **before** it finishes disposing the
daemon runtime, so there's a genuine window where the lease says `tui-owned`
while the daemon runtime is still alive. That window *is* the split-brain the
invariant is meant to rule out. So the model tracks `runtimeEntry` as an
**independent** variable (set on attach, cleared only when disposal *completes*)
and splits the idle-acquire into `flip → disposeDone / disposeFail`. Now the
window is a reachable state and the invariants can actually fail — which is the
whole point.

### Invariants checked (safety)

Each maps to a real prose invariant or a §4.8 race row. Names match
`LeaseBroker.tla` exactly.

| Invariant | Plain meaning |
|-----------|---------------|
| `OwnershipUnique` (I1) | The daemon runtime and a serving terminal never both exist for one conversation — no split-brain. |
| `RuntimeIffDaemon` (I2) | A daemon runtime exists exactly in the daemon states, plus the brief disposal window. |
| `TuiOwnerWellFormed` (I3a) | A terminal connection is recorded exactly when a terminal holds or is acquiring the lease. |
| `DisposePendingOnlyTui` | The disposal window only exists under `tui-owned`. |
| `RelaysOnlyWhenTui` (I3b) | Relays exist only while a terminal holds the lease. |
| `DrainHasAcquirer` (I4) | A draining conversation always has a waiting acquirer and a live pump. |
| `StreamingCoherent` | A turn only runs while the daemon owns a live runtime. |
| `DrainNoNewTurn` (I6) | Once a hand-off is disposing, no new turn can start (the `lease_draining` rejection). |
| `NoStreamLeak` | a stream count implies a live runtime — guards the finding-1 fix (in the baseline). |
| `IdleAcquireOnlyWhenIdle` | *(off by default)* an idle-acquire never disposes a mid-turn runtime — intentionally does **not** hold; detached turns are abandonable (RFC §4.2). |

### Properties checked (liveness, needs fairness)

| Property | Plain meaning |
|----------|---------------|
| `DrainConverges` (I5) | A hand-off never wedges: a draining conversation always leaves that state. |
| `EventualSettle` (I4) | The acquirer's grant is always settled (granted, cancelled, or errored) — nobody waits forever. |

Both rely on weak fairness on the drain pump, applied **per key** so one
conversation's hand-off can't starve another's. The adversarial branches
(cancel, disposal error) get *no* fairness, so they can't manufacture a fake
liveness violation.

### What the model deliberately simplifies

A turn is a boolean (`runtimeStreaming`) with a nondeterministic end, not
token-by-token streaming. The byte relay is a count, not a pump. Time/TTL is a
fireable event, not a clock. Counts are bounded (`MaxStreams`, `MaxRelays=2`,
`MaxPending=1`) so the state space is finite. These are the standard
abstractions; the ownership logic itself is kept exact.

---

## How to run

```bash
./check.sh                                                # WorkerRegistry, baseline config (auto-fetches tla2tools.jar)
./check.sh WorkerRegistry WorkerRegistryOrphans.cfg       # the orphan finding (a trace)
./check.sh WorkerRegistry WorkerRegistryRestartWaits.cfg  # the proposed fix (green)
./check.sh LeaseBroker                                    # a superseded module
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
  is a design artifact — it found the `streamCount` leak because we modeled the
  code's *intent* and asserted more than the code guarantees, not automatically.
- **Correctness beyond the bounds.** Two sessions, three workers, two clients, and
  one fault are strong evidence via small-model reasoning, not a proof for all N.
- **Anything abstracted away** — byte-level relay framing, real timers, transcript
  content, full async scheduling beyond the modeled windows.
- **Freedom from drift.** The biggest risk is the spec rotting as the RFC and code
  evolve. Cross-reference invariant names both ways (RFC and plan ↔ the names
  above) and re-run whenever a registry, lock, relay, retention, or close-reason
  change lands.

---

## Build order

The original build order was `LeaseBroker` → `RelayViewer` → `SessionTarget` →
`ClientAuth` → `ClientConn`, with `LeaseBroker` as the spine. With daemon-hosted
conversations `WorkerRegistry` replaces the first two as the spine; the others
are independent of it.

Full module scope, per-module invariant/property catalogs, and the shared
abstraction strategy live in [`PLAN.md`](PLAN.md).
