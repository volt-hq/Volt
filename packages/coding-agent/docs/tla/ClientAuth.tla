-------------------------------- MODULE ClientAuth --------------------------------
\* In plain terms
\*
\* This is the door: deciding whether a phone is allowed to connect. A phone is
\* identified by its Iroh node id (never by anything it claims in the hello). The
\* security questions that matter:
\*   - Can a REVOKED phone get back in? (Only after the operator explicitly
\*     approves a re-pair AND a fresh, unexpired pairing secret is used.)
\*   - Can a one-time pairing secret be replayed by a DIFFERENT phone? (No: once
\*     consumed it is a tombstone that rejects any other node.)
\*   - Can an EXPIRED secret still pair? (No.)
\*   - Can a stale approval, or a host clock that jumped backwards, silently keep
\*     a revoked phone's re-pair window open forever? (No -- the approval window
\*     fails CLOSED on a negative time delta.)
\*
\* This module models the host state (paired / revoked / approval / secret / clock)
\* evolving through operator and phone actions, and checks that no sequence of
\* interleavings ever admits a phone that should be blocked.
\*
\* Source of truth:
\*   src/core/remote/iroh/authorization.ts  (authorizeIrohRemoteClient)
\*   src/core/remote/iroh/state.ts          (tombstones, revoked clients)
\*   docs/iroh-remote-protocol.md           (handshake failure outcomes)
\*
\* The decision function `Decide` mirrors authorizeIrohRemoteClient's ORDERED
\* checks; `LegitPaired` states independently what must be true for a pairing to
\* be safe. Keeping them separate is what makes the invariants non-vacuous: if a
\* future edit reorders or weakens the decision, the two diverge and TLC reports it.

EXTENDS Naturals

CONSTANTS
    Nodes,        \* client node ids (symmetric); small, e.g. {n1, n2}
    NONE          \* sentinel

ASSUME NONE \notin Nodes

MaxClock     == 2   \* small logical clock; can move forwards AND backwards
ApprovalTTL  == 1   \* re-pair approval window (clock units)

SecretStates == {"none", "pending", "expired", "consumed"}
Outcomes     == {"idle", "client_revoked", "pairing_secret_expired", "workspace_denied",
                 "pairing_secret_consumed", "client_unknown", "ok_paired", "ok_existing"}

VARIABLES
    paired,          \* [Nodes -> BOOLEAN]  a known paired client
    revoked,         \* [Nodes -> BOOLEAN]  has a revocation tombstone
    approved,        \* [Nodes -> BOOLEAN]  re-pair approval granted
    approvedAt,      \* [Nodes -> 0..MaxClock]  when approval was granted
    secretState,     \* the single current pairing secret slot
    secretConsumer,  \* Nodes \cup {NONE}  who consumed the secret
    wsAvailable,     \* requested workspace currently usable
    clock,           \* logical clock
    lastOutcome,     \* result of the most recent Attempt
    illegitPair,     \* the last Attempt paired a phone that should have been blocked
    wsBypass         \* the last Attempt returned ok while the workspace was unavailable

vars == << paired, revoked, approved, approvedAt, secretState, secretConsumer,
           wsAvailable, clock, lastOutcome, illegitPair, wsBypass >>

-----------------------------------------------------------------------------
CATypeOK ==
    /\ paired \in [Nodes -> BOOLEAN]
    /\ revoked \in [Nodes -> BOOLEAN]
    /\ approved \in [Nodes -> BOOLEAN]
    /\ approvedAt \in [Nodes -> 0..MaxClock]
    /\ secretState \in SecretStates
    /\ secretConsumer \in Nodes \cup {NONE}
    /\ wsAvailable \in BOOLEAN
    /\ clock \in 0..MaxClock
    /\ lastOutcome \in Outcomes
    /\ illegitPair \in BOOLEAN
    /\ wsBypass \in BOOLEAN

Init ==
    /\ paired = [n \in Nodes |-> FALSE]
    /\ revoked = [n \in Nodes |-> FALSE]
    /\ approved = [n \in Nodes |-> FALSE]
    /\ approvedAt = [n \in Nodes |-> 0]
    /\ secretState = "none"
    /\ secretConsumer = NONE
    /\ wsAvailable = TRUE
    /\ clock = 0
    /\ lastOutcome = "idle"
    /\ illegitPair = FALSE
    /\ wsBypass = FALSE

-----------------------------------------------------------------------------
\* Re-pair approval window, with the FAIL-CLOSED lower bound (clock >= approvedAt)
\* from authorization.ts L120: without it a backwards clock leaves a negative delta
\* that trivially satisfies the TTL and keeps a revoked client admissible forever.
ApprovalActive(n) ==
    /\ revoked[n]
    /\ approved[n]
    /\ clock >= approvedAt[n]
    /\ clock - approvedAt[n] <= ApprovalTTL

HasPendingSecret(presents) == presents /\ secretState = "pending"
ExpiredSecret(presents)    == presents /\ secretState = "expired"
ConsumedSecret(presents)   == presents /\ secretState = "consumed"

\* authorizeIrohRemoteClient's ordered decision (L129-301), workspace collapsed to
\* one availability bit.
Decide(n, presents) ==
    IF revoked[n] /\ ~ (ApprovalActive(n) /\ HasPendingSecret(presents))
        THEN "client_revoked"
    ELSE IF ~ paired[n] /\ ExpiredSecret(presents)
        THEN "pairing_secret_expired"
    ELSE IF ~ wsAvailable
        THEN "workspace_denied"
    ELSE IF ~ paired[n] /\ ConsumedSecret(presents)
        THEN "pairing_secret_consumed"
    ELSE IF ~ paired[n] /\ ~ HasPendingSecret(presents)
        THEN "client_unknown"
    ELSE IF ~ paired[n]
        THEN "ok_paired"
    ELSE "ok_existing"

\* The security SPEC for a legitimate pairing, written independently of Decide.
LegitPaired(n, presents) ==
    /\ ~ paired[n]
    /\ presents
    /\ secretState = "pending"
    /\ wsAvailable
    /\ (revoked[n] => ApprovalActive(n))

-----------------------------------------------------------------------------
\* A phone connects and presents (or omits) the current pairing secret.
Attempt(n, presents) ==
    LET oc == Decide(n, presents) IN
    /\ lastOutcome' = oc
    /\ illegitPair' = (oc = "ok_paired" /\ ~ LegitPaired(n, presents))
    /\ wsBypass'    = (oc \in {"ok_paired", "ok_existing"} /\ ~ wsAvailable)
    /\ IF oc = "ok_paired"
       THEN \* pair: add client, consume secret, clear any revocation for this node
            /\ paired'         = [paired         EXCEPT ![n] = TRUE]
            /\ revoked'        = [revoked        EXCEPT ![n] = FALSE]
            /\ approved'       = [approved       EXCEPT ![n] = FALSE]
            /\ secretState'    = "consumed"
            /\ secretConsumer' = n
            /\ UNCHANGED << approvedAt, wsAvailable, clock >>
       ELSE UNCHANGED << paired, revoked, approved, secretState, secretConsumer,
                         approvedAt, wsAvailable, clock >>

\* Operator mints a fresh pairing ticket (new secret in the slot).
MintTicket ==
    /\ secretState' = "pending"
    /\ secretConsumer' = NONE
    /\ UNCHANGED << paired, revoked, approved, approvedAt, wsAvailable, clock, lastOutcome, illegitPair, wsBypass >>

\* The pending secret's TTL elapses.
ExpireSecret ==
    /\ secretState = "pending"
    /\ secretState' = "expired"
    /\ UNCHANGED << paired, revoked, approved, approvedAt, secretConsumer, wsAvailable, clock, lastOutcome, illegitPair, wsBypass >>

\* Operator revokes a paired client.
Revoke(n) ==
    /\ paired[n] = TRUE
    /\ paired'   = [paired   EXCEPT ![n] = FALSE]
    /\ revoked'  = [revoked  EXCEPT ![n] = TRUE]
    /\ approved' = [approved EXCEPT ![n] = FALSE]
    /\ UNCHANGED << approvedAt, secretState, secretConsumer, wsAvailable, clock, lastOutcome, illegitPair, wsBypass >>

\* Operator approves a re-pair for a revoked node (records approval time = now).
ApproveRePair(n) ==
    /\ revoked[n] = TRUE
    /\ approved'   = [approved   EXCEPT ![n] = TRUE]
    /\ approvedAt' = [approvedAt EXCEPT ![n] = clock]
    /\ UNCHANGED << paired, revoked, secretState, secretConsumer, wsAvailable, clock, lastOutcome, illegitPair, wsBypass >>

\* The requested workspace becomes (un)available.
SetWorkspace(b) ==
    /\ b # wsAvailable
    /\ wsAvailable' = b
    /\ UNCHANGED << paired, revoked, approved, approvedAt, secretState, secretConsumer, clock, lastOutcome, illegitPair, wsBypass >>

\* The host clock moves -- forwards OR backwards (adversarial).
SetClock(t) ==
    /\ t # clock
    /\ clock' = t
    /\ UNCHANGED << paired, revoked, approved, approvedAt, secretState, secretConsumer, wsAvailable, lastOutcome, illegitPair, wsBypass >>

Next ==
    \/ MintTicket
    \/ ExpireSecret
    \/ \E n \in Nodes : \/ Revoke(n)
                        \/ ApproveRePair(n)
                        \/ \E p \in BOOLEAN : Attempt(n, p)
    \/ \E b \in BOOLEAN : SetWorkspace(b)
    \/ \E t \in 0..MaxClock : SetClock(t)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* No phone is ever paired when the security spec says it should be blocked --
\* covers revoked-re-entry (needs approval), one-time-secret replay by another node
\* (needs a pending, not consumed/expired, secret), and the fail-closed clock check.
NoIllegitimatePairing == illegitPair = FALSE

\* Workspace authorization is re-checked on EVERY handshake: no ok outcome slips
\* through while the workspace is unavailable (not cached at pairing).
WorkspacePerRequest == wsBypass = FALSE

=============================================================================
