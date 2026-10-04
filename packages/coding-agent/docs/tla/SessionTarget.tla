------------------------------- MODULE SessionTarget -------------------------------
(***************************************************************************)
(* In plain terms                                                          *)
(*                                                                         *)
(* When the phone connects, the handshake has to agree on WHICH session it *)
(* is opening. The daemon resolves the phone's request ("resume my last",  *)
(* "start new", or "open this exact session id") to one concrete, canonical *)
(* session, and tells the phone what it did. The phone must then pin its    *)
(* tab to that canonical id -- never to the id it originally asked for,     *)
(* because the daemon may have created a fresh one. Getting this wrong is a  *)
(* "ghost pin": the tab points at a session that isn't really there.        *)
(*                                                                         *)
(* A session id never aliases another conversation: a phone that changes   *)
(* sessions is told the new id (`conversation_moved`) and reconnects with an *)
(* explicit session target, so an explicit target resolves to exactly the   *)
(* id the phone asked for, or fails.                                        *)
(*                                                                         *)
(* This module models two actors that must agree:                          *)
(*   - the daemon PRODUCER: session-target.ts resolveIrohRemoteSessionTarget, *)
(*   - the phone VALIDATOR: IrohProtocol selection validation + pin commit.    *)
(*                                                                         *)
(* Properties worth proving: an explicit "open this session" that doesn't   *)
(* resolve fails cleanly (no ghost pin); an explicit session that resolves  *)
(* is exactly the one asked for; the phone pins the canonical id; and every *)
(* tuple the daemon can emit is one the phone accepts (a cross-language     *)
(* compatibility proof).                                                    *)
(*                                                                         *)
(* Source of truth:                                                        *)
(*   src/daemon/session-target.ts               (the producer)             *)
(*   volt-app .../IrohProtocol + VoltSession+AgentSelection (the validator) *)
(*   docs/iroh-remote-protocol.md "Reconnect and session selection"        *)
(*                                                                         *)
(* Ids are modeled as tokens by ROLE, since only equality matters:          *)
(*   "req"   the id the phone asked for (session target)                    *)
(*   "last"  the daemon's remembered last-session id                        *)
(*   "fresh" a newly created session id                                     *)
(***************************************************************************)

EXTENDS Naturals

Targets   == {"last", "new", "session"}
Outcomes  == {"pending", "ok", "unavailable"}
Sels      == {"none", "created", "created_missing_last", "resumed"}
Ids       == {"none", "fresh", "last", "req"}
Phases    == {"start", "resolved", "validated", "done"}

VARIABLES
    phase,       \* pipeline position
    target,      \* what the phone asked for
    resolvable,  \* daemon can resolve the request to an existing session
    outcome,     \* daemon result: ok | unavailable
    sel,         \* wire selection
    canonical,   \* canonical session id the daemon returns
    accepted,    \* the phone validator accepted the tuple
    pin          \* the id the phone committed its tab to ("none" = no pin)

vars == << phase, target, resolvable, outcome, sel, canonical, accepted, pin >>

-----------------------------------------------------------------------------
STTypeOK ==
    /\ phase \in Phases
    /\ target \in Targets
    /\ resolvable \in BOOLEAN
    /\ outcome \in Outcomes
    /\ sel \in Sels
    /\ canonical \in Ids
    /\ accepted \in BOOLEAN
    /\ pin \in Ids

\* Enumerate all valid inputs as initial states.
ValidInputs ==
    /\ target \in Targets
    /\ resolvable \in BOOLEAN

Init ==
    /\ ValidInputs
    /\ phase = "start"
    /\ outcome = "pending"
    /\ sel = "none"
    /\ canonical = "none"
    /\ accepted = FALSE
    /\ pin = "none"

-----------------------------------------------------------------------------
(* Daemon producer: session-target.ts. Cases are mutually exclusive and     *)
(* cover every valid input.                                                   *)
Resolve ==
    /\ phase = "start"
    /\ phase' = "resolved"
    /\ \/ /\ target = "new"
          /\ outcome' = "ok" /\ sel' = "created" /\ canonical' = "fresh"
       \/ /\ target = "last" /\ resolvable = TRUE
          /\ outcome' = "ok" /\ sel' = "resumed" /\ canonical' = "last"
       \/ /\ target = "last" /\ resolvable = FALSE
          /\ outcome' = "ok" /\ sel' = "created_missing_last" /\ canonical' = "fresh"
       \/ /\ target = "session" /\ resolvable = FALSE
          \* explicit session that does not resolve -> session_unavailable, no pin
          /\ outcome' = "unavailable" /\ sel' = "none" /\ canonical' = "none"
       \/ /\ target = "session" /\ resolvable = TRUE
          /\ outcome' = "ok" /\ sel' = "resumed" /\ canonical' = "req"
    /\ UNCHANGED << target, resolvable, accepted, pin >>

\* Phone validator: which (target, selection, ids) tuples it accepts.
Validate ==
    /\ phase = "resolved"
    /\ phase' = "validated"
    /\ accepted' =
         (\/ (sel = "created"               /\ target \in {"new", "last"})
          \/ (sel = "created_missing_last"  /\ target = "last")
          \/ (sel = "resumed"               /\ (target = "last" \/ (target = "session" /\ canonical = "req"))))
    /\ UNCHANGED << target, resolvable, outcome, sel, canonical, pin >>

\* Phone commits the pin to the CANONICAL id the daemon returned.
Commit ==
    /\ phase = "validated"
    /\ outcome = "ok"
    /\ accepted = TRUE
    /\ pin' = canonical
    /\ phase' = "done"
    /\ UNCHANGED << target, resolvable, outcome, sel, canonical, accepted >>

\* Failure (session_unavailable) or a rejected tuple: no pin.
Reject ==
    /\ phase = "validated"
    /\ (outcome = "unavailable" \/ accepted = FALSE)
    /\ pin' = "none"
    /\ phase' = "done"
    /\ UNCHANGED << target, resolvable, outcome, sel, canonical, accepted >>

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

\* The phone always pins the canonical id the daemon returned.
CanonicalPinOnly ==
    (pin # "none") => (pin = canonical)

\* Every tuple the daemon actually emits (outcome ok) is one the phone accepts:
\* the producer's output space is a subset of the validator's accepted space.
ProducerSubsetOfValidator ==
    (phase \in {"validated", "done"} /\ outcome = "ok") => (accepted = TRUE)

\* A session id never aliases another conversation: an explicit session that
\* resolved is exactly the id the phone asked for.
SessionResumedMatches ==
    (target = "session" /\ outcome = "ok") => (sel = "resumed" /\ canonical = "req")

-----------------------------------------------------------------------------
(*                          TEMPORAL PROPERTY                                *)

\* Every handshake reaches a terminal decision (pin committed or rejected) --
\* no partial pin is left dangling.
HandshakeTerminates == <>(phase = "done")

=============================================================================
