-------------------------------- MODULE LeaseBroker --------------------------------
(***************************************************************************)
(* In plain terms                                                          *)
(*                                                                         *)
(* A "conversation" is one chat with the agent, named by (workspace,       *)
(* session).  The rule this module checks: exactly one program does the    *)
(* real work for that chat at a time -- either the background service      *)
(* (the daemon) or the desktop terminal (the TUI).  A phone never runs the *)
(* work itself; it rides along through whoever holds the chat.  The five   *)
(* states are just "who holds it":                                         *)
(*                                                                         *)
(*   unowned          nobody holds it, no runtime running                  *)
(*   daemon-active    daemon holds it, a phone is attached                 *)
(*   daemon-detached  daemon holds it, phone stepped away (30-min timer)   *)
(*   tui-owned        the terminal holds it; phones relay through it       *)
(*   daemon-draining  the hand-off moment: the terminal wants it, the      *)
(*                    daemon is mid-reply, so it waits for the reply first  *)
(*                                                                         *)
(* The only genuinely tricky part is the hand-off, and it can end three    *)
(* ways -- the reply finishes and the terminal takes over, the terminal    *)
(* backs out before the switch starts, or the terminal disappears in the   *)
(* MIDDLE of the switch.  Each must leave things clean.  That is what a     *)
(* model checker is good at and prose review is not.                       *)
(*                                                                         *)
(* -------------------------------------------------------------------     *)
(* Source of truth (keep this spec beside it; do not let them drift):      *)
(*   Volt/packages/coding-agent/src/daemon/lease-broker.ts                 *)
(*   docs/live-shared-session-daemon-design.md  (RFC 4.2 / 4.8)            *)
(*                                                                         *)
(* Design note that makes the safety invariants MEAN something:            *)
(*   `runtimeEntry[k]` is an INDEPENDENT variable -- whether a daemon       *)
(*   runtime object still exists -- NOT `Lease[k] \in daemon-*`.  The code  *)
(*   flips the lease to tui-owned BEFORE it finishes disposing the daemon   *)
(*   runtime (lease-broker.ts acquireForTui, ~L302-317), so there is a real *)
(*   window where Lease = "tui-owned" while the daemon runtime is still     *)
(*   alive.  That window is exactly the split-brain the RFC's I1/I2 are     *)
(*   about, so it must be a reachable state, not defined away.              *)
(***************************************************************************)

EXTENDS Naturals, TLC

CONSTANTS
    Keys,        \* conversation keys (workspace,session); symmetric; small e.g. {k1,k2}
    TUIs,        \* TUI control-connection ids; symmetric; small e.g. {t1,t2}
    MaxStreams,  \* cap on live phone streams per key (e.g. 2)
    NoTUI        \* sentinel for "no owning / acquiring TUI connection"

ASSUME NoTUI \notin TUIs
ASSUME MaxStreams \in Nat /\ MaxStreams >= 1

MaxRelays  == 2   \* small finite bound on relays per tui-owned key
MaxPending == 1   \* small finite bound on in-flight provisional daemon attaches

\* Interchangeable keys and TUI connections -> symmetry reduction.  Enable this
\* in the .cfg only for INVARIANT-only runs; TLC + symmetry + liveness can be
\* unsound, so the default .cfg (which also checks PROPERTIES) leaves it off.
Symmetry == Permutations(Keys) \cup Permutations(TUIs)

LeaseStates  == {"unowned", "daemon-active", "daemon-detached", "daemon-draining", "tui-owned"}
DaemonStates == {"daemon-active", "daemon-detached", "daemon-draining"}
DrainPhases  == {"none", "waiting", "disposing"}

VARIABLES
    Lease,            \* [Keys -> LeaseStates]          record.state
    owner,            \* [Keys -> TUIs \cup {NoTUI}]     record.tuiConnectionId
    streamCount,      \* [Keys -> 0..MaxStreams]        record.streamCount
    relayCount,       \* [Keys -> 0..MaxRelays]         |record.relayIds|
    runtimeStreaming, \* [Keys -> BOOLEAN]              a turn is in progress (isRuntimeStreaming)
    runtimeEntry,     \* [Keys -> BOOLEAN]              *** independent: a daemon runtime object exists
    disposePending,   \* [Keys -> BOOLEAN]              idle-acquire flipped to tui-owned, dispose not done
    drainPhase,       \* [Keys -> DrainPhases]          runDrain pump position
    drainCancelled,   \* [Keys -> BOOLEAN]              drain.cancelled
    grantSettled,     \* [Keys -> BOOLEAN]              drain.resolveGranted / rejectGranted called
    pendingAttaches   \* [Keys -> 0..MaxPending]        record.pendingDaemonAttaches

vars == << Lease, owner, streamCount, relayCount, runtimeStreaming, runtimeEntry,
           disposePending, drainPhase, drainCancelled, grantSettled, pendingAttaches >>

-----------------------------------------------------------------------------
(* Derived predicates *)

\* What runtimeEntry SHOULD equal if the machine is coherent: the daemon runtime
\* is alive exactly in the daemon-* states OR during the idle-acquire disposal
\* window (tui-owned but not yet disposed).  RuntimeIffDaemon pins the real,
\* independent runtimeEntry variable to this -- and can therefore catch a forget-
\* to-dispose bug, unlike a definition that just restated Lease.
RuntimeAliveExpected(k) == (Lease[k] \in DaemonStates) \/ disposePending[k]

\* The TUI is actually serving its own runtime for k: it holds the lease AND the
\* daemon runtime it replaced is already gone (disposal window closed).
TuiServing(k) == (Lease[k] = "tui-owned") /\ (~ disposePending[k])

-----------------------------------------------------------------------------
TypeOK ==
    /\ Lease            \in [Keys -> LeaseStates]
    /\ owner            \in [Keys -> TUIs \cup {NoTUI}]
    /\ streamCount      \in [Keys -> 0..MaxStreams]
    /\ relayCount       \in [Keys -> 0..MaxRelays]
    /\ runtimeStreaming \in [Keys -> BOOLEAN]
    /\ runtimeEntry     \in [Keys -> BOOLEAN]
    /\ disposePending   \in [Keys -> BOOLEAN]
    /\ drainPhase       \in [Keys -> DrainPhases]
    /\ drainCancelled   \in [Keys -> BOOLEAN]
    /\ grantSettled     \in [Keys -> BOOLEAN]
    /\ pendingAttaches  \in [Keys -> 0..MaxPending]

Init ==
    /\ Lease            = [k \in Keys |-> "unowned"]
    /\ owner            = [k \in Keys |-> NoTUI]
    /\ streamCount      = [k \in Keys |-> 0]
    /\ relayCount       = [k \in Keys |-> 0]
    /\ runtimeStreaming = [k \in Keys |-> FALSE]
    /\ runtimeEntry     = [k \in Keys |-> FALSE]
    /\ disposePending   = [k \in Keys |-> FALSE]
    /\ drainPhase       = [k \in Keys |-> "none"]
    /\ drainCancelled   = [k \in Keys |-> FALSE]
    /\ grantSettled     = [k \in Keys |-> FALSE]
    /\ pendingAttaches  = [k \in Keys |-> 0]

-----------------------------------------------------------------------------
(*                              ACTIONS                                     *)
(* One (family of) action per lease-broker.ts method / environment event.  *)
(* Pure denials (acquireForTui force -> denied{force_unsupported}; tui-owned *)
(* other-conn -> denied{held_by_tui}; draining other-conn ->                *)
(* denied{draining_elsewhere}; releaseFromTui on a non-held key ->          *)
(* not_held) never mutate the machine, so they are NOT modeled as actions   *)
(* -- adding UNCHANGED self-loops would only mask TLC deadlock detection.    *)

\* acquireForTui: unowned -> tui-owned, granted{none}.  (lease-broker.ts L243-253)
AcquireUnowned(k, t) ==
    /\ Lease[k] = "unowned"
    /\ Lease' = [Lease EXCEPT ![k] = "tui-owned"]
    /\ owner' = [owner EXCEPT ![k] = t]
    /\ UNCHANGED << streamCount, relayCount, runtimeStreaming, runtimeEntry,
                    disposePending, drainPhase, drainCancelled, grantSettled, pendingAttaches >>

\* acquireForTui on ANY mid-turn daemon runtime (active or detached) -> begin
\* drain. Detached runtimes drain too: disposing a busy runtime would abandon
\* the turn and discard its un-persisted results.
\* (lease-broker.ts acquireForTui daemon-active/daemon-detached case -> beginDrain)
AcquireDrainStart(k, t) ==
    /\ Lease[k] \in {"daemon-active", "daemon-detached"}
    /\ runtimeStreaming[k] = TRUE
    /\ Lease'          = [Lease          EXCEPT ![k] = "daemon-draining"]
    /\ owner'          = [owner          EXCEPT ![k] = t]
    /\ drainPhase'     = [drainPhase     EXCEPT ![k] = "waiting"]
    /\ drainCancelled' = [drainCancelled EXCEPT ![k] = FALSE]
    /\ grantSettled'   = [grantSettled   EXCEPT ![k] = FALSE]
    /\ UNCHANGED << streamCount, relayCount, runtimeStreaming, runtimeEntry,
                    disposePending, pendingAttaches >>

\* acquireForTui on an IDLE daemon runtime: FLIP to tui-owned first, runtime NOT
\* yet disposed.  This opens the split-brain window (disposePending = TRUE while
\* runtimeEntry stays TRUE).  Only idle runtimes take this path; a streaming
\* runtime (active OR detached) drains via AcquireDrainStart instead.
AcquireIdleFlip(k, t) ==
    /\ Lease[k] \in {"daemon-active", "daemon-detached"}
    /\ runtimeStreaming[k] = FALSE
    /\ Lease'          = [Lease          EXCEPT ![k] = "tui-owned"]
    /\ owner'          = [owner          EXCEPT ![k] = t]
    /\ disposePending' = [disposePending EXCEPT ![k] = TRUE]
    /\ UNCHANGED << streamCount, relayCount, runtimeStreaming, runtimeEntry,
                    drainPhase, drainCancelled, grantSettled, pendingAttaches >>

\* Idle-acquire disposal COMPLETES: daemon runtime gone, streams zeroed, window
\* closes.  Either the acquiring TUI is still alive (stays tui-owned, granted
\* {warm}) or it died during the await and the lease was released -> unowned
\* (lease-broker.ts L318-325).
AcquireIdleDisposeDone(k) ==
    /\ Lease[k] = "tui-owned"
    /\ disposePending[k] = TRUE
    /\ runtimeEntry[k] = TRUE
    /\ runtimeEntry'     = [runtimeEntry     EXCEPT ![k] = FALSE]
    /\ disposePending'   = [disposePending   EXCEPT ![k] = FALSE]
    /\ streamCount'      = [streamCount      EXCEPT ![k] = 0]
    /\ runtimeStreaming' = [runtimeStreaming EXCEPT ![k] = FALSE]  \* disposal ends any in-flight turn
    /\ \/ /\ Lease' = Lease            \* owner alive: stays tui-owned
          /\ owner' = owner
       \/ /\ Lease' = [Lease EXCEPT ![k] = "unowned"]   \* owner lost mid-dispose
          /\ owner' = [owner EXCEPT ![k] = NoTUI]
    /\ UNCHANGED << relayCount, drainPhase, drainCancelled,
                    grantSettled, pendingAttaches >>

\* Idle-acquire disposal FAILS: revert to a daemon-owned state, runtime still
\* alive, acquire throws.  (lease-broker.ts L307-317 catch block)
AcquireIdleDisposeFail(k) ==
    /\ Lease[k] = "tui-owned"
    /\ disposePending[k] = TRUE
    /\ runtimeEntry[k] = TRUE
    /\ Lease'          = [Lease EXCEPT ![k] = IF streamCount[k] > 0 THEN "daemon-active"
                                                                    ELSE "daemon-detached"]
    /\ owner'          = [owner EXCEPT ![k] = NoTUI]
    /\ disposePending' = [disposePending EXCEPT ![k] = FALSE]
    /\ UNCHANGED << streamCount, relayCount, runtimeStreaming, runtimeEntry,
                    drainPhase, drainCancelled, grantSettled, pendingAttaches >>

\* runDrain step 1: waitForRuntimeIdle resolves -> the turn ended, disposal
\* becomes irreversible.  (lease-broker.ts L367 + L384)
DrainRuntimeIdle(k) ==
    /\ Lease[k] = "daemon-draining"
    /\ drainPhase[k] = "waiting"
    /\ drainCancelled[k] = FALSE
    /\ runtimeStreaming' = [runtimeStreaming EXCEPT ![k] = FALSE]
    /\ drainPhase'       = [drainPhase       EXCEPT ![k] = "disposing"]
    /\ UNCHANGED << Lease, owner, streamCount, relayCount, runtimeEntry,
                    disposePending, drainCancelled, grantSettled, pendingAttaches >>

\* runDrain step 1 ERROR: waitForRuntimeIdle rejects -> revert, reject grant.
\* Runtime not disposed, so runtimeEntry stays TRUE.  (lease-broker.ts L368-376)
DrainRuntimeIdleError(k) ==
    /\ Lease[k] = "daemon-draining"
    /\ drainPhase[k] = "waiting"
    /\ drainCancelled[k] = FALSE
    /\ Lease'            = [Lease EXCEPT ![k] = IF streamCount[k] > 0 THEN "daemon-active"
                                                                     ELSE "daemon-detached"]
    /\ owner'            = [owner            EXCEPT ![k] = NoTUI]
    /\ drainPhase'       = [drainPhase       EXCEPT ![k] = "none"]
    /\ grantSettled'     = [grantSettled     EXCEPT ![k] = TRUE]
    /\ runtimeStreaming' = [runtimeStreaming EXCEPT ![k] = FALSE]
    /\ UNCHANGED << streamCount, relayCount, runtimeEntry, disposePending,
                    drainCancelled, pendingAttaches >>

\* runDrain step 2: dispose + closePhoneStreams SUCCEED (runtime gone).
\*   cancelled -> unowned + audit connection_lost (acquirer died mid-dispose)
\*   else       -> tui-owned, grant resolved{warm}
\* (lease-broker.ts L408-432)
DrainDispose(k) ==
    /\ Lease[k] = "daemon-draining"
    /\ drainPhase[k] = "disposing"
    /\ runtimeEntry' = [runtimeEntry EXCEPT ![k] = FALSE]
    /\ streamCount'  = [streamCount  EXCEPT ![k] = 0]
    /\ drainPhase'   = [drainPhase   EXCEPT ![k] = "none"]
    /\ grantSettled' = [grantSettled EXCEPT ![k] = TRUE]
    /\ IF drainCancelled[k]
       THEN /\ Lease' = [Lease EXCEPT ![k] = "unowned"]
            /\ owner' = [owner EXCEPT ![k] = NoTUI]
       ELSE /\ Lease' = [Lease EXCEPT ![k] = "tui-owned"]
            /\ owner' = owner
    /\ UNCHANGED << relayCount, runtimeStreaming, disposePending, drainCancelled, pendingAttaches >>

\* runDrain step 2 ERROR: dispose/closePhoneStreams throw.  (lease-broker.ts L388-408)
\*   cancelled -> unowned, streamCount zeroed so the record is droppable
\*   else       -> revert to daemon-*, reject grant, runtime still alive.
\*
\* The cancelled branch zeroes streamCount (the lease-broker.ts fix): without it the
\* record would be stranded as an undroppable "unowned" ghost carrying a phantom
\* stream count, since dropIfUnowned requires streamCount === 0.  NoStreamLeak
\* (below, in the baseline .cfg) guards this.
DrainDisposeError(k) ==
    /\ Lease[k] = "daemon-draining"
    /\ drainPhase[k] = "disposing"
    /\ drainPhase'   = [drainPhase   EXCEPT ![k] = "none"]
    /\ owner'        = [owner        EXCEPT ![k] = NoTUI]
    /\ grantSettled' = [grantSettled EXCEPT ![k] = TRUE]
    /\ \/ /\ drainCancelled[k] = TRUE
          /\ Lease'        = [Lease        EXCEPT ![k] = "unowned"]
          /\ runtimeEntry' = [runtimeEntry EXCEPT ![k] = FALSE]
          /\ streamCount'  = [streamCount  EXCEPT ![k] = 0]
       \/ /\ drainCancelled[k] = FALSE
          /\ Lease'        = [Lease EXCEPT ![k] = IF streamCount[k] > 0 THEN "daemon-active"
                                                                        ELSE "daemon-detached"]
          /\ runtimeEntry' = runtimeEntry
          /\ streamCount'  = streamCount
    /\ UNCHANGED << relayCount, runtimeStreaming, disposePending,
                    drainCancelled, pendingAttaches >>

\* cancelDrain while WAITING (releaseFromTui change-of-mind, or the owner's
\* connection dropped): not yet disposing -> revert, reject grant.  The turn was
\* still running (streamCount stayed > 0 through draining), so revert lands
\* daemon-active.  (lease-broker.ts L435-454, L463-471, L490-500)
DrainCancelWaiting(k, t) ==
    /\ Lease[k] = "daemon-draining"
    /\ owner[k] = t
    /\ drainPhase[k] = "waiting"
    /\ drainCancelled[k] = FALSE
    /\ Lease'          = [Lease EXCEPT ![k] = IF streamCount[k] > 0 THEN "daemon-active"
                                                                    ELSE "daemon-detached"]
    /\ owner'          = [owner          EXCEPT ![k] = NoTUI]
    /\ drainPhase'     = [drainPhase     EXCEPT ![k] = "none"]
    /\ drainCancelled' = [drainCancelled EXCEPT ![k] = TRUE]
    /\ grantSettled'   = [grantSettled   EXCEPT ![k] = TRUE]
    /\ UNCHANGED << streamCount, relayCount, runtimeStreaming, runtimeEntry,
                    disposePending, pendingAttaches >>

\* cancelDrain while DISPOSING already started (irreversible): mark cancelled and
\* reject the grant NOW, but DEFER the final transition to DrainDispose /
\* DrainDisposeError, which land unowned.  (lease-broker.ts L441-448)
DrainCancelDisposing(k, t) ==
    /\ Lease[k] = "daemon-draining"
    /\ owner[k] = t
    /\ drainPhase[k] = "disposing"
    /\ drainCancelled[k] = FALSE
    /\ drainCancelled' = [drainCancelled EXCEPT ![k] = TRUE]
    /\ grantSettled'   = [grantSettled   EXCEPT ![k] = TRUE]
    /\ UNCHANGED << Lease, owner, streamCount, relayCount, runtimeStreaming,
                    runtimeEntry, disposePending, drainPhase, pendingAttaches >>

\* releaseFromTui (quit / switch) and the tui-owned branch of
\* releaseAllForConnection collapse to the same state effect: close relays,
\* -> unowned.  Not allowed mid-disposal window (that critical section owns the
\* record).  (lease-broker.ts L456-500)
ReleaseTui(k, t) ==
    /\ Lease[k] = "tui-owned"
    /\ ~ disposePending[k]
    /\ owner[k] = t
    /\ Lease'      = [Lease      EXCEPT ![k] = "unowned"]
    /\ owner'      = [owner      EXCEPT ![k] = NoTUI]
    /\ relayCount' = [relayCount EXCEPT ![k] = 0]
    /\ UNCHANGED << streamCount, runtimeStreaming, runtimeEntry, disposePending,
                    drainPhase, drainCancelled, grantSettled, pendingAttaches >>

\* registerRelay: only once the TUI is actually serving (tui-owned, window
\* closed).  (lease-broker.ts L541-546)
RegisterRelay(k) ==
    /\ Lease[k] = "tui-owned"
    /\ ~ disposePending[k]
    /\ relayCount[k] < MaxRelays
    /\ relayCount' = [relayCount EXCEPT ![k] = relayCount[k] + 1]
    /\ UNCHANGED << Lease, owner, streamCount, runtimeStreaming, runtimeEntry,
                    disposePending, drainPhase, drainCancelled, grantSettled, pendingAttaches >>

\* unregisterRelay.  (lease-broker.ts L548-554)
UnregisterRelay(k) ==
    /\ relayCount[k] > 0
    /\ relayCount' = [relayCount EXCEPT ![k] = relayCount[k] - 1]
    /\ UNCHANGED << Lease, owner, streamCount, runtimeStreaming, runtimeEntry,
                    disposePending, drainPhase, drainCancelled, grantSettled, pendingAttaches >>

\* beginDaemonAttach "proceed": a provisional attach is now in flight.  Keeps an
\* otherwise-unowned key alive so it cannot be rekeyed/dropped from under the
\* attach.  (lease-broker.ts L147-167)
BeginDaemonAttach(k) ==
    /\ Lease[k] \in {"unowned", "daemon-active", "daemon-detached"}
    /\ pendingAttaches[k] < MaxPending
    /\ pendingAttaches' = [pendingAttaches EXCEPT ![k] = pendingAttaches[k] + 1]
    /\ UNCHANGED << Lease, owner, streamCount, relayCount, runtimeStreaming,
                    runtimeEntry, disposePending, drainPhase, drainCancelled, grantSettled >>

\* commitDaemonRuntime success: the provisional attach commits a live runtime.
\* (lease-broker.ts L181-207)
CommitDaemonAttach(k) ==
    /\ pendingAttaches[k] > 0
    /\ Lease[k] \in {"unowned", "daemon-active", "daemon-detached"}
    /\ pendingAttaches' = [pendingAttaches EXCEPT ![k] = pendingAttaches[k] - 1]
    /\ Lease'           = [Lease           EXCEPT ![k] = "daemon-active"]
    /\ runtimeEntry'    = [runtimeEntry    EXCEPT ![k] = TRUE]
    /\ UNCHANGED << owner, streamCount, relayCount, runtimeStreaming,
                    disposePending, drainPhase, drainCancelled, grantSettled >>

\* The provisional attach is abandoned: abortDaemonAttach, or commit onto a lease
\* that meanwhile became tui-owned / daemon-draining (fail{tui_owned}/{draining}).
\* No live runtime is committed; just release the provisional claim.
\* (lease-broker.ts L169-179, L184-193)
AbortDaemonAttach(k) ==
    /\ pendingAttaches[k] > 0
    /\ pendingAttaches' = [pendingAttaches EXCEPT ![k] = pendingAttaches[k] - 1]
    /\ UNCHANGED << Lease, owner, streamCount, relayCount, runtimeStreaming,
                    runtimeEntry, disposePending, drainPhase, drainCancelled, grantSettled >>

\* onDaemonRuntimeStreamCountChanged, count UP.  (lease-broker.ts L573-584)
PhoneStreamAttach(k) ==
    /\ Lease[k] \in {"daemon-active", "daemon-detached"}
    /\ streamCount[k] < MaxStreams
    /\ streamCount' = [streamCount EXCEPT ![k] = streamCount[k] + 1]
    /\ Lease'       = [Lease       EXCEPT ![k] = "daemon-active"]
    /\ UNCHANGED << owner, relayCount, runtimeStreaming, runtimeEntry,
                    disposePending, drainPhase, drainCancelled, grantSettled, pendingAttaches >>

\* onDaemonRuntimeStreamCountChanged, count DOWN (phone detaches; the turn keeps
\* running headless if one was in flight -> runtimeStreaming unchanged).
\* (lease-broker.ts L573-584)
PhoneStreamDetach(k) ==
    /\ Lease[k] \in {"daemon-active", "daemon-detached"}
    /\ streamCount[k] > 0
    /\ streamCount' = [streamCount EXCEPT ![k] = streamCount[k] - 1]
    /\ Lease'       = [Lease       EXCEPT ![k] = IF streamCount[k] - 1 > 0 THEN "daemon-active"
                                                                           ELSE "daemon-detached"]
    /\ UNCHANGED << owner, relayCount, runtimeStreaming, runtimeEntry,
                    disposePending, drainPhase, drainCancelled, grantSettled, pendingAttaches >>

\* A turn starts / ends on the daemon runtime.  A turn can only START on a
\* daemon-active runtime with a phone attached; RuntimeStartTurn being disabled in
\* daemon-draining is exactly the `lease_draining` prompt rejection (RFC 4.5).
RuntimeStartTurn(k) ==
    /\ Lease[k] = "daemon-active"
    /\ streamCount[k] > 0
    /\ runtimeStreaming[k] = FALSE
    /\ runtimeStreaming' = [runtimeStreaming EXCEPT ![k] = TRUE]
    /\ UNCHANGED << Lease, owner, streamCount, relayCount, runtimeEntry,
                    disposePending, drainPhase, drainCancelled, grantSettled, pendingAttaches >>

RuntimeEndTurn(k) ==
    /\ Lease[k] \in {"daemon-active", "daemon-detached"}
    /\ runtimeStreaming[k] = TRUE
    /\ runtimeStreaming' = [runtimeStreaming EXCEPT ![k] = FALSE]
    /\ UNCHANGED << Lease, owner, streamCount, relayCount, runtimeEntry,
                    disposePending, drainPhase, drainCancelled, grantSettled, pendingAttaches >>

\* Retention TTL fires on an idle detached runtime -> dispose, -> unowned.
\* (integrated-runtime-retention.ts; lease-broker.ts L586-612 disposed path)
RetentionDispose(k) ==
    /\ Lease[k] = "daemon-detached"
    /\ runtimeStreaming[k] = FALSE
    /\ streamCount[k] = 0
    /\ Lease'        = [Lease        EXCEPT ![k] = "unowned"]
    /\ runtimeEntry' = [runtimeEntry EXCEPT ![k] = FALSE]
    /\ UNCHANGED << owner, streamCount, relayCount, runtimeStreaming,
                    disposePending, drainPhase, drainCancelled, grantSettled, pendingAttaches >>

\* rekey(ws, old, new) into a genuinely FREE destination.  The refusal branch the
\* code takes when the destination is occupied (lease-broker.ts L511-526) is
\* modeled as this action being DISABLED when kNew is live -- an unguarded move
\* would overwrite kNew and break OwnershipUnique / RuntimeIffDaemon there, which
\* is exactly why the guard exists (I7).  We model the tui-owned source (the case
\* with the session_rekeyed_reconnect relay close, L531-534); daemon-state rekey
\* is a plain relabel that preserves every invariant trivially.
RekeyMove(kOld, kNew) ==
    /\ kOld # kNew
    /\ Lease[kOld] = "tui-owned"
    /\ ~ disposePending[kOld]
    /\ Lease[kNew] = "unowned"
    /\ relayCount[kNew] = 0
    /\ streamCount[kNew] = 0
    /\ pendingAttaches[kNew] = 0
    /\ ~ runtimeEntry[kNew]
    /\ ~ disposePending[kNew]
    /\ Lease'      = [Lease      EXCEPT ![kOld] = "unowned",   ![kNew] = "tui-owned"]
    /\ owner'      = [owner      EXCEPT ![kOld] = NoTUI,       ![kNew] = owner[kOld]]
    /\ relayCount' = [relayCount EXCEPT ![kOld] = 0,           ![kNew] = 0]
    /\ UNCHANGED << streamCount, runtimeStreaming, runtimeEntry, disposePending,
                    drainPhase, drainCancelled, grantSettled, pendingAttaches >>

-----------------------------------------------------------------------------
Next ==
    \E k \in Keys :
        \/ \E t \in TUIs : \/ AcquireUnowned(k, t)
                           \/ AcquireDrainStart(k, t)
                           \/ AcquireIdleFlip(k, t)
                           \/ DrainCancelWaiting(k, t)
                           \/ DrainCancelDisposing(k, t)
                           \/ ReleaseTui(k, t)
        \/ AcquireIdleDisposeDone(k)
        \/ AcquireIdleDisposeFail(k)
        \/ DrainRuntimeIdle(k)
        \/ DrainRuntimeIdleError(k)
        \/ DrainDispose(k)
        \/ DrainDisposeError(k)
        \/ RegisterRelay(k)
        \/ UnregisterRelay(k)
        \/ BeginDaemonAttach(k)
        \/ CommitDaemonAttach(k)
        \/ AbortDaemonAttach(k)
        \/ PhoneStreamAttach(k)
        \/ PhoneStreamDetach(k)
        \/ RuntimeStartTurn(k)
        \/ RuntimeEndTurn(k)
        \/ RetentionDispose(k)
        \/ \E kNew \in Keys : RekeyMove(k, kNew)

-----------------------------------------------------------------------------
(* Fairness: a started drain must make progress, so the two drain pumps get     *)
(* WEAK fairness -- PER KEY, so the scheduler cannot forever service one key's   *)
(* drain and starve another.  The error/cancel branches are adversarial and get  *)
(* NO fairness, yet they still settle the grant, so they cannot create a         *)
(* spurious liveness violation.                                                  *)
DrainProgress(k) == DrainRuntimeIdle(k) \/ DrainDispose(k)

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ \A k \in Keys : WF_vars(DrainProgress(k))

-----------------------------------------------------------------------------
(*                            SAFETY INVARIANTS                              *)

\* I1 -- no split-brain: a daemon runtime never coexists with a TUI that is
\* actually serving the conversation.  Non-vacuous because runtimeEntry is an
\* independent variable; it would fire if any transition left the daemon runtime
\* alive after the TUI started serving (e.g. a forget-to-dispose regression).
OwnershipUnique ==
    \A k \in Keys : ~ (runtimeEntry[k] /\ TuiServing(k))

\* I2 -- runtime-entry / state coherence: the daemon runtime object exists
\* exactly in the daemon-* states OR the idle-acquire disposal window.  This is
\* the RFC risk-table invariant, made real by the independent runtimeEntry.
RuntimeIffDaemon ==
    \A k \in Keys : runtimeEntry[k] <=> RuntimeAliveExpected(k)

\* I3a -- ownership well-formed: a TUI connection is recorded exactly when a TUI
\* holds or is acquiring the lease.
TuiOwnerWellFormed ==
    \A k \in Keys :
        /\ (Lease[k] = "tui-owned")       => (owner[k] # NoTUI)
        /\ (Lease[k] = "daemon-draining") => (owner[k] # NoTUI)
        /\ (Lease[k] \in {"unowned", "daemon-active", "daemon-detached"}) => (owner[k] = NoTUI)

\* The idle-acquire disposal window only ever exists under tui-owned.
DisposePendingOnlyTui ==
    \A k \in Keys : disposePending[k] => (Lease[k] = "tui-owned")

\* I3b -- relays exist only under a tui-owned lease.
RelaysOnlyWhenTui ==
    \A k \in Keys : (relayCount[k] > 0) => (Lease[k] = "tui-owned")

\* I4 (safety half) -- a draining lease has a pending acquirer and a live pump.
DrainHasAcquirer ==
    \A k \in Keys :
        (Lease[k] = "daemon-draining") =>
            /\ owner[k] # NoTUI
            /\ drainPhase[k] \in {"waiting", "disposing"}

\* A turn only runs while a daemon runtime object actually exists (including the
\* brief idle-acquire disposal window, which is tui-owned but still backed by a
\* not-yet-disposed runtime).  "A turn needs a runtime."
StreamingCoherent ==
    \A k \in Keys : runtimeStreaming[k] => runtimeEntry[k]

\* I6 -- no NEW turn starts during a hand-off: once we are past waitForRuntimeIdle
\* (drainPhase = "disposing") the runtime is idle and stays idle.  Guards against a
\* regression that let a phone prompt start a turn mid-drain.
DrainNoNewTurn ==
    \A k \in Keys :
        (Lease[k] = "daemon-draining" /\ drainPhase[k] = "disposing") => (runtimeStreaming[k] = FALSE)

\* A positive stream count implies a live daemon runtime backing it.  Guards the
\* lease-broker.ts fix: the cancelled + disposal-error branch of runDrain must zero
\* record.streamCount, or an "unowned" key keeps a phantom count and (since
\* dropIfUnowned requires streamCount === 0) becomes an undroppable ghost.  Enabled
\* in the baseline LeaseBroker.cfg.
NoStreamLeak ==
    \A k \in Keys : (streamCount[k] > 0) => runtimeEntry[k]

\* --- Documented INTENTIONAL behavior (OFF in the default .cfg) ---
\* "An idle-acquire only ever disposes a runtime that is NOT mid-turn." This
\* predicate INTENTIONALLY DOES NOT HOLD, by design (decided; see
\* docs/live-shared-session-daemon-design.md §4.2). acquireForTui only DRAINS when
\* the state is "daemon-active" (lease-broker.ts L296); a "daemon-detached" runtime
\* still streaming a turn (the last phone left mid-turn) is disposed on TUI acquire,
\* abandoning that turn -- once no device is receiving it, there is nothing to
\* watch. It is kept OUT of the baseline and defined here only so the behavior is
\* explicit and any FUTURE change back to "always drain" can be checked. Enable it
\* to see the trace: detach-mid-turn -> AcquireIdleFlip.
IdleAcquireOnlyWhenIdle ==
    \A k \in Keys : disposePending[k] => (runtimeStreaming[k] = FALSE)

-----------------------------------------------------------------------------
(*                          TEMPORAL PROPERTIES                              *)

\* I5 -- a hand-off always converges: a draining lease eventually leaves that
\* state (to tui-owned, back to a daemon-* state, or unowned).  Needs the drain
\* fairness in Spec; non-vacuous because AcquireDrainStart makes draining reachable.
DrainConverges ==
    \A k \in Keys :
        (Lease[k] = "daemon-draining") ~>
            (Lease[k] \in ({"tui-owned", "unowned", "daemon-active", "daemon-detached"}))

\* I4 (liveness half) -- a started hand-off's grant promise is always settled
\* (resolved on success, rejected on cancel/error): no acquirer waits forever.
EventualSettle ==
    \A k \in Keys :
        (Lease[k] = "daemon-draining") ~> grantSettled[k]

=============================================================================
