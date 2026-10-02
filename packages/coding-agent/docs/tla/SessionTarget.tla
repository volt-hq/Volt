------------------------------- MODULE SessionTarget -------------------------------
(***************************************************************************)
(* In plain terms                                                          *)
(*                                                                         *)
(* When the phone connects, the handshake has to agree on WHICH session it *)
(* is opening. The daemon resolves the phone's request ("resume my last",  *)
(* "start new", or "open this exact session id") to one concrete, canonical *)
(* session, and tells the phone what it did. The phone must then pin its    *)
(* tab to that canonical id -- never to the id it originally asked for,     *)
(* because the daemon may have created a fresh one or rekeyed to a          *)
(* replacement. Getting this wrong is a "ghost pin": the tab points at a    *)
(* session that isn't really there.                                        *)
(*                                                                         *)
(* This module models two actors that must agree:                          *)
(*   - the daemon PRODUCER: session-target.ts resolveIrohRemoteSessionTarget  *)
(*     plus the live-runtime rekey overlay,                                    *)
(*   - the phone VALIDATOR: IrohProtocol selection validation + pin commit.    *)
(*                                                                         *)
(* Properties worth proving: an explicit "open this session" that doesn't   *)
(* resolve fails cleanly (no ghost pin); a rekey is only ever signalled for *)
(* an explicit session target and always changes the id; the phone pins the *)
(* canonical id, not the requested one; and every tuple the daemon can emit *)
(* is one the phone accepts (a cross-language compatibility proof).         *)
(*                                                                         *)
(* Source of truth:                                                        *)
(*   src/daemon/session-target.ts               (the producer)             *)
(*   src/modes/rpc/iroh-remote-agent-runtime.ts (rekey overlay)            *)
(*   volt-app .../IrohProtocol + VoltSession+AgentSelection (the validator) *)
(*   docs/iroh-remote-protocol.md "Reconnect and session selection"        *)
(*                                                                         *)
(* Ids are modeled as tokens by ROLE, since only equality matters:          *)
(*   "req"   the id the phone asked for (session target)                    *)
(*   "last"  the daemon's remembered last-session id                        *)
(*   "fresh" a newly created session id                                     *)
(*   "rekey" the canonical replacement after a live-runtime rekey           *)
(***************************************************************************)

EXTENDS Naturals

Targets   == {"last", "new", "session"}
Outcomes  == {"pending", "ok", "unavailable"}
Sels      == {"none", "created", "created_missing_last", "resumed", "session_rekeyed"}
Ids       == {"none", "fresh", "last", "req", "rekey"}
Phases    == {"start", "resolved", "validated", "done"}

VARIABLES
    phase,       \* pipeline position
    target,      \* what the phone asked for
    resolvable,  \* daemon can resolve the request to an existing session
    moved,       \* live runtime rekeyed to a replacement (session target only)
    outcome,     \* daemon result: ok | unavailable
    sel,         \* wire selection
    canonical,   \* canonical session id the daemon returns
    requested,   \* wire requestedSessionId (present only on rekey)
    accepted,    \* the phone validator accepted the tuple
    pin          \* the id the phone committed its tab to ("none" = no pin)

vars == << phase, target, resolvable, moved, outcome, sel, canonical, requested, accepted, pin >>

-----------------------------------------------------------------------------
STTypeOK ==
    /\ phase \in Phases
    /\ target \in Targets
    /\ resolvable \in BOOLEAN
    /\ moved \in BOOLEAN
    /\ outcome \in Outcomes
    /\ sel \in Sels
    /\ canonical \in Ids
    /\ requested \in Ids
    /\ accepted \in BOOLEAN
    /\ pin \in Ids

\* Enumerate all valid inputs as initial states; a rekey can only happen for an
\* explicit session target that actually resolved.
ValidInputs ==
    /\ target \in Targets
    /\ resolvable \in BOOLEAN
    /\ moved \in BOOLEAN
    /\ (moved = TRUE) => (target = "session" /\ resolvable = TRUE)

Init ==
    /\ ValidInputs
    /\ phase = "start"
    /\ outcome = "pending"
    /\ sel = "none"
    /\ canonical = "none"
    /\ requested = "none"
    /\ accepted = FALSE
    /\ pin = "none"

-----------------------------------------------------------------------------
(* Daemon producer: session-target.ts + the rekey overlay. Cases are mutually *)
(* exclusive and cover every valid input.                                     *)
Resolve ==
    /\ phase = "start"
    /\ phase' = "resolved"
    /\ \/ /\ target = "new"
          /\ outcome' = "ok" /\ sel' = "created" /\ canonical' = "fresh" /\ requested' = "none"
       \/ /\ target = "last" /\ resolvable = TRUE
          /\ outcome' = "ok" /\ sel' = "resumed" /\ canonical' = "last" /\ requested' = "none"
       \/ /\ target = "last" /\ resolvable = FALSE
          /\ outcome' = "ok" /\ sel' = "created_missing_last" /\ canonical' = "fresh" /\ requested' = "none"
       \/ /\ target = "session" /\ resolvable = FALSE
          \* explicit session that does not resolve -> session_unavailable, no pin
          /\ outcome' = "unavailable" /\ sel' = "none" /\ canonical' = "none" /\ requested' = "none"
       \/ /\ target = "session" /\ resolvable = TRUE /\ moved = TRUE
          /\ outcome' = "ok" /\ sel' = "session_rekeyed" /\ canonical' = "rekey" /\ requested' = "req"
       \/ /\ target = "session" /\ resolvable = TRUE /\ moved = FALSE
          /\ outcome' = "ok" /\ sel' = "resumed" /\ canonical' = "req" /\ requested' = "none"
    /\ UNCHANGED << target, resolvable, moved, accepted, pin >>

\* Phone validator: which (target, selection, ids) tuples it accepts.
Validate ==
    /\ phase = "resolved"
    /\ phase' = "validated"
    /\ accepted' =
         (\/ (sel = "created"               /\ target \in {"new", "last"})
          \/ (sel = "created_missing_last"  /\ target = "last")
          \/ (sel = "resumed"               /\ (target = "last" \/ (target = "session" /\ canonical = "req")))
          \/ (sel = "session_rekeyed"       /\ target = "session" /\ requested = "req"
                                            /\ canonical = "rekey" /\ canonical # requested))
    /\ UNCHANGED << target, resolvable, moved, outcome, sel, canonical, requested, pin >>

\* Phone commits the pin to the CANONICAL id (never `requested`).
Commit ==
    /\ phase = "validated"
    /\ outcome = "ok"
    /\ accepted = TRUE
    /\ pin' = canonical
    /\ phase' = "done"
    /\ UNCHANGED << target, resolvable, moved, outcome, sel, canonical, requested, accepted >>

\* Failure (session_unavailable) or a rejected tuple: no pin.
Reject ==
    /\ phase = "validated"
    /\ (outcome = "unavailable" \/ accepted = FALSE)
    /\ pin' = "none"
    /\ phase' = "done"
    /\ UNCHANGED << target, resolvable, moved, outcome, sel, canonical, requested, accepted >>

Done == phase = "done" /\ UNCHANGED vars

Next == Resolve \/ Validate \/ Commit \/ Reject \/ Done

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(Resolve) /\ WF_vars(Validate) /\ WF_vars(Commit) /\ WF_vars(Reject)

-----------------------------------------------------------------------------
(*                            SAFETY INVARIANTS                              *)

\* An explicit session target that cannot resolve never produces a pin (no ghost).
NoGhostSession ==
    (target = "session" /\ resolvable = FALSE) => (pin = "none")

\* The phone always pins the canonical id, never a stale requested one. In a
\* rekey, canonical ("rekey") differs from requested ("req"), so the pin is the
\* replacement, not the id the phone originally asked for.
CanonicalPinOnly ==
    (pin # "none") => (pin = canonical)

\* Every tuple the daemon actually emits (outcome ok) is one the phone accepts:
\* the producer's output space is a subset of the validator's accepted space.
ProducerSubsetOfValidator ==
    (phase \in {"validated", "done"} /\ outcome = "ok") => (accepted = TRUE)

\* A rekey is only ever signalled for an explicit session target, always carries
\* the requested id, and always changes the canonical id (a no-op rekey is a bug).
RekeyWellFormed ==
    (sel = "session_rekeyed") =>
        /\ target = "session"
        /\ canonical = "rekey"
        /\ requested = "req"
        /\ canonical # requested

\* A session that resolved without a rekey pins exactly the id the phone asked for.
SessionResumedMatches ==
    (target = "session" /\ sel = "resumed") => (canonical = "req")

\* The wire requestedSessionId field is present exactly on a rekey.
RequestedOnlyForRekey ==
    (requested # "none") <=> (sel = "session_rekeyed")

-----------------------------------------------------------------------------
(*                          TEMPORAL PROPERTY                                *)

\* Every handshake reaches a terminal decision (pin committed or rejected) --
\* no partial pin is left dangling.
HandshakeTerminates == <>(phase = "done")

=============================================================================
