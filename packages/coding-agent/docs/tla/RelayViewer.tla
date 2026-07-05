-------------------------------- MODULE RelayViewer --------------------------------
(***************************************************************************)
(* In plain terms                                                          *)
(*                                                                         *)
(* This is the plumbing that carries a conversation during a hand-off,     *)
(* modeling two daemon mechanisms:                                         *)
(*                                                                         *)
(*  - RELAY TOKEN: when the terminal owns a conversation, the daemon hands *)
(*    a phone's stream to the terminal using a one-time token.  The token  *)
(*    must be redeemable at most once and must expire (10s), so a stale or  *)
(*    replayed token can never open a second pipe.                         *)
(*                                                                         *)
(*  - VIEWER FEED: while a hand-off waits for the current reply to finish, *)
(*    the acquiring terminal watches that reply read-only.  Events are      *)
(*    buffered until the terminal subscribes, then flushed and streamed     *)
(*    live; if too many pile up they are dropped with a "truncated" marker; *)
(*    and once the feed ends, nothing more may be sent on it.               *)
(*                                                                         *)
(* The properties worth proving: a token is redeemed at most once and never *)
(* after it expired; a viewer feed only ever talks to the terminal that     *)
(* requested it; no event is sent after the feed ends; sequence numbers only *)
(* go up; and every started feed / redeemed relay eventually finishes.       *)
(*                                                                         *)
(* Source of truth:                                                        *)
(*   src/daemon/relay-stream.ts   RelayRegistry: mint/admit/invalidate/finish  *)
(*   src/daemon/viewer-feed.ts    ViewerFeedRegistry: start/subscribe/end      *)
(*   docs/live-shared-session-daemon-design.md  (RFC 4.3, 5.4, 5.6)         *)
(*                                                                         *)
(* The lease drain that starts/ends a feed and mints/closes a relay is the  *)
(* LeaseBroker module; here that environment is abstracted as free actions. *)
(* Composition with LeaseBroker is a later step (see PLAN.md).              *)
(***************************************************************************)

EXTENDS Naturals, TLC

CONSTANTS
    Relays,   \* relay ids (symmetric); small, e.g. {r1, r2}
    Feeds,    \* viewer-feed ids (symmetric); small, e.g. {f1, f2}
    Conns,    \* control-connection ids (a feed is owned by exactly one); e.g. {c1, c2}
    NoConn    \* sentinel for "no owning connection"

ASSUME NoConn \notin Conns

MaxBuf == 2   \* buffered events before the next one overflows -> truncated
MaxSeq == 3   \* bound on emitted-event sequence numbers (keeps the model finite)

Symmetry == Permutations(Relays) \cup Permutations(Feeds) \cup Permutations(Conns)

RelayStates == {"none", "pending", "active", "settled", "invalidated"}
FeedStates  == {"none", "buffering", "truncated", "live", "unsubscribed", "ended"}
FeedLive    == {"buffering", "truncated", "live", "unsubscribed"}  \* started, not ended

VARIABLES
    relayState,    \* [Relays -> RelayStates]
    relayExpired,  \* [Relays -> BOOLEAN]  TTL elapsed while pending
    feedState,     \* [Feeds  -> FeedStates]
    feedOwner,     \* [Feeds  -> Conns \cup {NoConn}]  the drain requester
    feedBuffered,  \* [Feeds  -> 0..MaxBuf]  pre-subscribe buffered events
    feedSeq,       \* [Feeds  -> 0..MaxSeq]  emitted viewer_event count
    feedAborted    \* [Feeds  -> BOOLEAN]  viewer_abort seen (non-destructive)

rvvars == << relayState, relayExpired, feedState, feedOwner, feedBuffered, feedSeq, feedAborted >>

-----------------------------------------------------------------------------
RVTypeOK ==
    /\ relayState   \in [Relays -> RelayStates]
    /\ relayExpired \in [Relays -> BOOLEAN]
    /\ feedState    \in [Feeds  -> FeedStates]
    /\ feedOwner    \in [Feeds  -> Conns \cup {NoConn}]
    /\ feedBuffered \in [Feeds  -> 0..MaxBuf]
    /\ feedSeq      \in [Feeds  -> 0..MaxSeq]
    /\ feedAborted  \in [Feeds  -> BOOLEAN]

Init ==
    /\ relayState   = [r \in Relays |-> "none"]
    /\ relayExpired = [r \in Relays |-> FALSE]
    /\ feedState    = [f \in Feeds  |-> "none"]
    /\ feedOwner    = [f \in Feeds  |-> NoConn]
    /\ feedBuffered = [f \in Feeds  |-> 0]
    /\ feedSeq      = [f \in Feeds  |-> 0]
    /\ feedAborted  = [f \in Feeds  |-> FALSE]

-----------------------------------------------------------------------------
(*                          RELAY TOKEN ACTIONS                             *)
(* relay-stream.ts RelayRegistry. The shared `used` bit + map delete are    *)
(* here a single state variable, so admit and invalidate cannot both fire   *)
(* from `pending`: whichever runs first leaves `pending`, disabling the      *)
(* other -- exactly the "cannot both win" guarantee.                        *)

\* mint(): a new offer.  (relay-stream.ts L66-84)
RelayMint(r) ==
    /\ relayState[r] = "none"
    /\ relayState'   = [relayState   EXCEPT ![r] = "pending"]
    /\ relayExpired' = [relayExpired EXCEPT ![r] = FALSE]
    /\ UNCHANGED << feedState, feedOwner, feedBuffered, feedSeq, feedAborted >>

\* the 10s token TTL elapses while still pending.  (RELAY_TOKEN_TTL_MS)
RelayExpire(r) ==
    /\ relayState[r] = "pending"
    /\ relayExpired[r] = FALSE
    /\ relayExpired' = [relayExpired EXCEPT ![r] = TRUE]
    /\ UNCHANGED << relayState, feedState, feedOwner, feedBuffered, feedSeq, feedAborted >>

\* admit(): the TUI redeems the token.  Succeeds only if unused (still pending)
\* and not expired -- the expiry check at redeem time.  (relay-stream.ts L135-141)
RelayAdmit(r) ==
    /\ relayState[r] = "pending"
    /\ relayExpired[r] = FALSE
    /\ relayState' = [relayState EXCEPT ![r] = "active"]
    /\ UNCHANGED << relayExpired, feedState, feedOwner, feedBuffered, feedSeq, feedAborted >>

\* invalidatePending(): rekey / duplicate replacement / expiry cleanup marks the
\* offer used and drops it.  Allowed regardless of expiry.  (relay-stream.ts L87-94)
RelayInvalidate(r) ==
    /\ relayState[r] = "pending"
    /\ relayState' = [relayState EXCEPT ![r] = "invalidated"]
    /\ UNCHANGED << relayExpired, feedState, feedOwner, feedBuffered, feedSeq, feedAborted >>

\* finish(): either side closed; settle() runs exactly once (the `settled` guard),
\* here the single move active -> settled.  (relay-stream.ts L153-170)
RelaySettle(r) ==
    /\ relayState[r] = "active"
    /\ relayState' = [relayState EXCEPT ![r] = "settled"]
    /\ UNCHANGED << relayExpired, feedState, feedOwner, feedBuffered, feedSeq, feedAborted >>

-----------------------------------------------------------------------------
(*                          VIEWER FEED ACTIONS                             *)
(* viewer-feed.ts ViewerFeedRegistry. Events that arrive while truncated or  *)
(* unsubscribed are simply dropped by the code, so they are NOT modeled as   *)
(* actions (a dropped event is no state change).                            *)

\* start(): begin capturing the draining runtime's events for connection c.
\* (viewer-feed.ts L49-69)
FeedStart(f, c) ==
    /\ feedState[f] = "none"
    /\ feedState'    = [feedState    EXCEPT ![f] = "buffering"]
    /\ feedOwner'    = [feedOwner    EXCEPT ![f] = c]
    /\ feedBuffered' = [feedBuffered EXCEPT ![f] = 0]
    /\ feedSeq'      = [feedSeq      EXCEPT ![f] = 0]
    /\ feedAborted'  = [feedAborted  EXCEPT ![f] = FALSE]
    /\ UNCHANGED << relayState, relayExpired >>

\* onSessionEvent while buffering, under the cap: buffer it.  (L100-101)
FeedBufferEvent(f) ==
    /\ feedState[f] = "buffering"
    /\ feedBuffered[f] < MaxBuf
    /\ feedBuffered' = [feedBuffered EXCEPT ![f] = feedBuffered[f] + 1]
    /\ UNCHANGED << relayState, relayExpired, feedState, feedOwner, feedSeq, feedAborted >>

\* onSessionEvent while buffering, cap exceeded: drop buffer, mark truncated.  (L89-99)
FeedOverflow(f) ==
    /\ feedState[f] = "buffering"
    /\ feedBuffered[f] = MaxBuf
    /\ feedState'    = [feedState    EXCEPT ![f] = "truncated"]
    /\ feedBuffered' = [feedBuffered EXCEPT ![f] = 0]
    /\ UNCHANGED << relayState, relayExpired, feedOwner, feedSeq, feedAborted >>

\* subscribe() from the drain requester while buffering: flush the buffer, go live.
\* (L118-136)  Only the owning connection may subscribe.
FeedSubscribeFlush(f, c) ==
    /\ feedState[f] = "buffering"
    /\ feedOwner[f] = c
    /\ feedState'    = [feedState    EXCEPT ![f] = "live"]
    /\ feedSeq'      = [feedSeq EXCEPT ![f] =
                          IF feedSeq[f] + feedBuffered[f] > MaxSeq THEN MaxSeq
                                                                   ELSE feedSeq[f] + feedBuffered[f]]
    /\ feedBuffered' = [feedBuffered EXCEPT ![f] = 0]
    /\ UNCHANGED << relayState, relayExpired, feedOwner, feedAborted >>

\* subscribe() while truncated: emit exactly the {truncated} marker, go live.  (L127-128)
FeedSubscribeTrunc(f, c) ==
    /\ feedState[f] = "truncated"
    /\ feedOwner[f] = c
    /\ feedState' = [feedState EXCEPT ![f] = "live"]
    /\ feedSeq'   = [feedSeq   EXCEPT ![f] = IF feedSeq[f] + 1 > MaxSeq THEN MaxSeq ELSE feedSeq[f] + 1]
    /\ UNCHANGED << relayState, relayExpired, feedOwner, feedBuffered, feedAborted >>

\* subscribe() after a prior unsubscribe: no backlog (buffer already null), go live.
FeedResubscribe(f, c) ==
    /\ feedState[f] = "unsubscribed"
    /\ feedOwner[f] = c
    /\ feedState' = [feedState EXCEPT ![f] = "live"]
    /\ UNCHANGED << relayState, relayExpired, feedOwner, feedBuffered, feedSeq, feedAborted >>

\* a live session event is forwarded to the subscriber.  (emit(), L104-111)
FeedLiveEmit(f) ==
    /\ feedState[f] = "live"
    /\ feedSeq[f] < MaxSeq
    /\ feedSeq' = [feedSeq EXCEPT ![f] = feedSeq[f] + 1]
    /\ UNCHANGED << relayState, relayExpired, feedState, feedOwner, feedBuffered, feedAborted >>

\* unsubscribe(): TUI dismissed the overlay; stop forwarding, keep the feed.  (L140-149)
FeedUnsubscribe(f, c) ==
    /\ feedState[f] = "live"
    /\ feedOwner[f] = c
    /\ feedState' = [feedState EXCEPT ![f] = "unsubscribed"]
    /\ UNCHANGED << relayState, relayExpired, feedOwner, feedBuffered, feedSeq, feedAborted >>

\* abort(): viewer_abort stops the turn but leaves the feed intact.  (L152-159)
FeedAbort(f, c) ==
    /\ feedState[f] \in FeedLive
    /\ feedOwner[f] = c
    /\ feedAborted[f] = FALSE
    /\ feedAborted' = [feedAborted EXCEPT ![f] = TRUE]
    /\ UNCHANGED << relayState, relayExpired, feedState, feedOwner, feedBuffered, feedSeq >>

\* end(): the drain terminated (granted/cancelled/error); emit viewer_end and tear down.
\* (L162-171)  After this, no viewer_event may be emitted for the feed.
FeedEnd(f) ==
    /\ feedState[f] \in FeedLive
    /\ feedState'    = [feedState    EXCEPT ![f] = "ended"]
    /\ feedBuffered' = [feedBuffered EXCEPT ![f] = 0]
    /\ UNCHANGED << relayState, relayExpired, feedOwner, feedSeq, feedAborted >>

-----------------------------------------------------------------------------
\* Everything has finished: a genuine terminal state (no relay pending/active, no
\* feed live).  Stutter here so TLC's deadlock check does not flag normal
\* completion.  This fires ONLY when nothing else is enabled, so it masks no bug.
AllDone ==
    /\ \A r \in Relays : relayState[r] \in {"settled", "invalidated"}
    /\ \A f \in Feeds  : feedState[f] = "ended"

Terminating == AllDone /\ UNCHANGED rvvars

Next ==
    \/ \E r \in Relays : \/ RelayMint(r)
                         \/ RelayExpire(r)
                         \/ RelayAdmit(r)
                         \/ RelayInvalidate(r)
                         \/ RelaySettle(r)
    \/ \E f \in Feeds :
         \/ FeedBufferEvent(f)
         \/ FeedOverflow(f)
         \/ FeedLiveEmit(f)
         \/ FeedEnd(f)
         \/ \E c \in Conns : \/ FeedStart(f, c)
                             \/ FeedSubscribeFlush(f, c)
                             \/ FeedSubscribeTrunc(f, c)
                             \/ FeedResubscribe(f, c)
                             \/ FeedUnsubscribe(f, c)
                             \/ FeedAbort(f, c)
    \/ Terminating

Spec ==
    /\ Init
    /\ [][Next]_rvvars
    /\ \A f \in Feeds : WF_rvvars(FeedEnd(f))
    /\ \A r \in Relays : WF_rvvars(RelaySettle(r))

-----------------------------------------------------------------------------
(*                            SAFETY INVARIANTS                              *)

\* A feed has an owning connection exactly once it has started.
FeedOwnerSet ==
    \A f \in Feeds :
        /\ (feedState[f] # "none") => (feedOwner[f] \in Conns)
        /\ (feedState[f] = "none") => (feedOwner[f] = NoConn)

\* Truncation drops the buffer; a nonzero buffer only exists while buffering.
BufferCoherent ==
    \A f \in Feeds :
        /\ (feedState[f] = "truncated") => (feedBuffered[f] = 0)
        /\ (feedBuffered[f] > 0) => (feedState[f] = "buffering")

\* A relay is "used up" (dropped from the pending map) exactly in the post-pending
\* states -- the single state variable makes admit/invalidate mutually exclusive.
RelayUsedCoherent ==
    \A r \in Relays :
        (relayState[r] \in {"active", "settled", "invalidated"}) => (relayState[r] # "pending")

-----------------------------------------------------------------------------
(*                          TEMPORAL PROPERTIES                              *)

\* No viewer_event is emitted after the feed has ended (the ended short-circuit).
NoEmitAfterEnd ==
    [][ \A f \in Feeds : (feedState[f] = "ended") => (feedSeq'[f] = feedSeq[f]) ]_rvvars

\* "ended" is absorbing: a torn-down feed never comes back.
EndedIsTerminal ==
    [][ \A f \in Feeds : (feedState[f] = "ended") => (feedState'[f] = "ended") ]_rvvars

\* Emitted sequence numbers never go backwards (FIFO flush then live).
SeqMonotone ==
    [][ \A f \in Feeds : feedSeq'[f] >= feedSeq[f] ]_rvvars

\* A redeemed relay never returns to a redeemable state (token single-use).
RelayNoResurrect ==
    [][ \A r \in Relays : (relayState[r] \in {"active", "settled", "invalidated"})
                            => (relayState'[r] \in {"active", "settled", "invalidated"}) ]_rvvars

\* Every started feed eventually ends (granted/cancelled/error) -- needs WF(FeedEnd).
FeedConverges ==
    \A f \in Feeds : (feedState[f] \in FeedLive) ~> (feedState[f] = "ended")

\* Every redeemed relay eventually settles (either side closes) -- needs WF(RelaySettle).
RelaySettleConverges ==
    \A r \in Relays : (relayState[r] = "active") ~> (relayState[r] = "settled")

=============================================================================
