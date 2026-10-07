# Volt formal specification — full modeling plan

This is the deeper reference behind [`README.md`](README.md): the complete module
decomposition, the per-module invariant/property catalogs for the modules still to
be written, and the shared abstraction strategy. Predicates are written in
near-TLA prose; each ties back to a named prose invariant (I1…I7) or a §4.8 race
row from the RFC.

> **`WorkerRegistry` (section 3) is the model of record for the host/worker
> protocol** (daemon-hosted conversations, architecture rewrite Phase 7). The
> models of the ownership-transfer design it replaced were deleted with that
> code in Phase 7 slice 9.

> Plain-first: every module below starts from one question a user would
> recognize ("did my phone reconnect to the right chat?", "why did two things run
> at once?"). The formal invariants are just those questions written precisely
> enough for a checker.

---

## 1. Module decomposition

Each module is its own `.tla` + `.cfg`. Shared datatypes (node ids, keys, close
reasons, handshake selections) will live in a `Common.tla` the others `EXTENDS`.
`WorkerRegistry` is the spine; the phone-side modules are independent of it.

| # | Module | Plain question it answers | Key state | Bug classes |
|---|--------|---------------------------|-----------|-------------|
| 1 | **`SessionTarget`** | On connect, does the phone pin the *right* session — never a stale one? | `target ∈ {last_noId,last_withId,new,session}`; `hostSession ∈ {exists,missing,liveMoved}`; wire `selection`; `requestedId?`; client `{Validated,StreamOpened,PinCommitted,RolledBack}` | ghost pin (pinned to requested vs canonical id), rekey without requestedId, requestedId leaking onto created/resumed, `target=session` silently creating a session, producer/validator tuple mismatch. |
| 2 | **`ClientAuth`** | Can a revoked or stale phone ever get back in? Is a one-time secret really one-time? | `clients`; `revoked[node]`; `pending[secretHash]`; `tomb ∈ {consumed(node),expired}`; logical `clock`; per-hello workspace authz | revoked-client re-entry, one-time secret replayed to a *different* node, expired-secret pairing, workspace-authz cached-at-pairing, check-order regressions. |
| 3 | **`ClientConn`** | Does the phone reconnect exactly once, never when the user said disconnect, and never confuse abort with detach? | app status; `userRequestedDisconnect`; background flag; per-pin status lattice; closure ledger; monotonic `operationToken`/`reconnectGen`/`attemptId` | ghost reconnect while user-disconnected, double reconnect loop, expected-closure marker mis-consume, abort-conflated-with-detach, stale continuation commit. |
| 4 | **`WorkerRegistry`** | Which worker hosts this chat, and can two processes ever write it, or an open wait forever? | registry worker state, key generation and compatibility key, hosts (top-level conversations + claims, by group), per-conversation closes, process, open logs, per-log lock, per-conversation activity, stop acceptance; client target and its open's key, relay offer, attachment; one durable input id; daemon up, workspace generation, fence in flight | two hosts or two writers per log, attach to a dead or retiring worker or a closing conversation, offer reuse, sharing across compatibility keys or past the cap, one conversation's close touching another, lost or doubled input across crashes and daemon loss, closing an attached or active conversation, a worker kept with nothing to host, fenced authority acting, a wedged open, spawn, close, retirement, or fence. **Written — model of record; see README and section 3.** |

**Build order.** `SessionTarget` → `ClientAuth` → `ClientConn` (largest state
space; consumes close reasons as an abstract input alphabet), then
`WorkerRegistry` as the spine of the host/worker protocol.

---

## 2. Invariant & property catalogs — planned modules

Unless noted, assume **weak fairness (WF)** on the daemon's internal steps
(disposal, ack handlers) and on "the environment eventually satisfies the
network / eventually idles"; revocation and user-disconnect are adversarial (no
fairness — they are choices, not obligations).

### 2.1 `SessionTarget` — written + verified green

Implemented in `SessionTarget.tla`. Models the daemon producer
(`session-target.ts`) and the phone validator as a
resolve → validate → commit/reject pipeline, checking `NoGhostSession`,
`CanonicalPinOnly`, `ProducerSubsetOfValidator` (the compatibility proof),
`SessionResumedMatches`, and `HandshakeTerminates`. The rekey overlay
(`session_rekeyed` with `requestedSessionId`) is gone: a session id never
aliases another conversation, and a phone that changes sessions reconnects to
the new id after `conversation_moved`. The prose below is the original design
intent.

**Safety**

- `CanonicalPinOnly` — the app commits a pin only against the canonical
  `metadata.sessionId`, never `requestedSessionId`. The strongest one: TLC must be
  unable to reach a `PinCommitted` whose id = the requested id on a rekey.
- `RequestedIdImpliesRekey` — `requestedSessionId` on the wire ⇔ `selection =
  session_rekeyed` ⇔ `target = session`; no created/resumed carries a requested id.
- `SessionTargetNoCreate` — `target=session ∧ hostSession=missing ⇒
  session_unavailable`, never `created_after_missing`.
- `NewTargetCreatedOnly` — `target=new ⇒ selection=created`.
- `ProducerSubsetOfValidator` (refinement) — the `(target, selection, requestedId)`
  tuples the host emits are a subset of what the Swift validator accepts. A genuine
  cross-language compatibility proof no test gives us.

**Liveness** — `HandshakeTerminates` (every valid target reaches exactly one of
`PinCommitted` / `RolledBack`; no partial pin persists), `RekeySurfacesToClient`.

### 2.2 `ClientAuth` — written + verified green

Implemented in `ClientAuth.tla` (9,678 states). Models the host authorization
decision (`authorization.ts`) evolving through pair / revoke / approve-re-pair /
expire-secret and a clock that moves backwards, checking `NoIllegitimatePairing`
(covers revoked re-entry, one-time-secret replay by another node, expired-secret
pairing, and the fail-closed backwards-clock case) and `WorkspacePerRequest`. The
prose below is the original design intent.

**Safety**

- `AuthoritativeIdentityIsNodeId` — all keying uses the transport `remoteNodeId`;
  `hello.clientNodeId` is never consulted.
- `RevokedNeedsApprovedRePair` — a revoked node is rejected unless re-pair approval
  is active (0 ≤ now−approvedAt ≤ 30min, **fail-closed on negative**) *and* a live,
  non-consumed, non-expired secret. A generic new ticket alone never re-admits.
- `ConsumedSecretBindsOneNode` — a `consumed(node)` tombstone rejects any *other*
  node presenting the same secret hash.
- `ExpiredSecretNeverPairs` — expiry dominates in check order; re-pair approval
  can't rescue an expired secret.
- `WorkspaceAuthzPerRequest` — even a paired client is authz-checked against
  *current* host state every handshake, never cached at pairing.
- `CheckOrderPreserved` — outcomes match the load-bearing order (revoked → expired
  → workspace_unregistered → workspace_missing/workspace_unavailable → workspace_authorization_removed
  → consumed → client_unknown).
- `RetiredOutcomesUnreachable` — the authorization-state model cannot produce
  `conversation_in_use` or `workspace_forbidden`; runtime attach may separately
  emit `conversation_in_use` for incompatible client tool grants.

**Adversarial-clock note.** Model the logical clock as able to move **backward**
and assert `RevokedNeedsApprovedRePair` still holds — a future-dated approval must
fail closed. **Liveness** — `PendingTicketResolves`, `TombstonesReclaimed`.

### 2.3 `ClientConn` — written + verified green

Implemented in `ClientConn.tla` (176 states). Models the phone reconnect loop and
network-path handling, checking `SingleReconnectDial` (the anti-double-loop race:
a network blip during a dial never spawns a second concurrent dial),
`UserDiscSuppresses`, `TerminalAbsorbing`, and `AbortKeepsLive`. The generation
guards, snapshots, and backoff timing are abstracted; the prose below is the fuller
design intent.

**Safety**

- `UserDisconnectSuppressesAutoReconnect` — while `userRequestedDisconnect`, no
  automatic reconnect runs; the flag clears only on an explicit user connect. Holds
  across app-active, network-flap, and background-return.
- `AbortKeepsStreamOpen` — a successful abort does not close the stream, arm a
  closure marker, schedule reconnect, or reselect. Abort and detach are disjoint.
- `ExpectedClosureNeverReportsDisconnect` — an EOF whose `(ws,sid)` marker is in
  the ledger is consumed exactly once and never reports a disconnect or schedules
  reconnect. Only an expected move (`conversation_moved`) (+ terminal
  revoke/workspace-removal) arms markers.
- `SingleReconnectLoop` — ≤ one live reconnect loop (generation guard);
  `networkPathStatusDidChange` never clobbers an in-flight dial.
- `StaleContinuationBails` — any await-resumption whose captured
  `operationToken`/`reconnectGen`/`attemptId` no longer matches is a no-op.
- `TerminalIsAbsorbing` — nothing auto-escapes a terminal `Failed` state.

**Suspected bugs to try to break:** closure-marker key collision (ledger keyed by
`ws` vs `(ws,sid)`); double reconnect across `networkPathStatusDidChange` vs
`beginForegroundReconnect` when `status=.connecting`; `reconnectGen` orphaning.

**Liveness** — `ReconnectMakesProgress`, `MoveSelfHeals` (an expected move on
the selected agent re-establishes a live stream), `BoundedRetryLoops` (duplicate
≤5 terminates).

---

## 3. `WorkerRegistry` (written; model of record)

Implemented in `WorkerRegistry.tla` from the Phase 7 plan (#585, sections 1 and 6)
and daemon-hosted conversations RFC §4–§5; full detail, model decisions, bounds,
and results are in [`README.md`](README.md#the-workerregistry-module-model-of-record).
It models the daemon's worker registry keyed by `(workspace, generation,
session)`, coalesced spawns, shared workers (an open routes into a live worker
of its compatibility key with room for another of at most `Cap` top-level
conversations, D11 revised), claims into a conversation's group, single-use
relay offers, the per-log lock and exit-ordered replacement, per-conversation
retention with a refusable close handshake, forced closes of one conversation,
retirement of a worker that hosts nothing, worker crashes, workspace fences,
and daemon loss with orphaned workers, which a restarted daemon waits for (the
worker gate, `RestartWaitsForOrphans = TRUE`).

**Safety:** `OneHost`, `OneWriter`, `LockCoherent`, `ReadyHoldsLocks`,
`RetireWhenEmpty`, `GroupsWellFormed`, `CapRespected`, `AttachOnlyToLive`,
`NoOfferToRetiring`, `CloseOnlyDetached`, `NoLostInput`, `ExactlyOnce`,
`RetireOnlyDetachedIdle`, `NoGenerationOverlap` (W5), and the action properties
`OfferAdmittedOnce`, `ClaimRespectsHost`, `RouteRespectsKey`, `CloseScoped`,
`FencedWorkersInert`, `RetireReportsAfterExit` (W4). The last two of these hold only with the restart
wait (Phase 7 slice 5); `WorkerRegistryOrphans.cfg` keeps the trace of the design
without it (an orphan of a dead daemon outlives a workspace mutation; see the
README finding).

**Liveness:** `OpenServed`, `RetiringExits`, `StartingSettles`,
`DetachedIdleCloses`, `ClosesSettle`, `OrphansExit`, `WorkspaceRetireCompletes`,
under weak fairness on daemon and worker steps, with faults (worker crash,
offer expiry, daemon crash) and forced closes bounded by `MaxFaults`.
`WorkerRegistrySharing.cfg` and `WorkerRegistrySafety.cfg` check safety at
bounds the liveness run cannot afford (differing keys and a binding cap; a
third worker id).

**Upkeep.** Every Phase 7 slice that changes registry semantics updates the model
first and re-runs `./check.sh WorkerRegistry`, pasting the TLC summary in its pull
request. A trace TLC finds is fixed in the model and the code, with a regression
test.
