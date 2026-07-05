-------------------------------- MODULE ClientConn --------------------------------
\* In plain terms
\*
\* The phone's own connection behavior for the conversation it's showing. The
\* things that must never go wrong:
\*   - If the user pressed Disconnect, the phone must NOT quietly reconnect on its
\*     own; only an explicit user reconnect resumes.
\*   - Only ONE reconnect attempt runs at a time. A network blip while a dial is
\*     already in flight must not spawn a second, concurrent dial.
\*   - "Abort" (stop the current turn) is not "detach": aborting keeps the stream
\*     live.
\*   - A terminal failure (revoked / workspace removed) is absorbing: nothing auto-
\*     recovers out of it; only an explicit user action does.
\*   - An expected closure (a lease hand-off) leads to a clean reconnect; a
\*     terminal closure leads to the absorbing failure -- neither is a surprise
\*     disconnect.
\*
\* Source of truth:
\*   volt-app .../VoltSession+Reconnect.swift  (the reconnect loop + network path)
\*   volt-app .../ConversationClosureLedger.swift  (expected-closure markers)
\*   volt-app README "Mobile Background Behavior"
\*
\* Modeling note: `loopActive` is the guard variable (reconnectTask != nil) and
\* `dials` counts connect attempts actually in flight. The bug the code guards
\* against (networkPathStatusDidChange clobbering a live `.connecting` dial) would
\* clear `loopActive` while `dials > 0`, letting a second dial start -> `dials = 2`.
\* The correct rule (NetLoss leaves an in-flight dial alone) keeps `dials <= 1`.

EXTENDS Naturals

Statuses    == {"live", "down", "waiting", "terminal"}
LedgerKinds == {"none", "handoff", "terminal"}

VARIABLES
    status,             \* connection status of the shown conversation
    dials,              \* reconnect connect attempts actually in flight (0..2)
    loopActive,         \* a reconnect loop owns the retry (reconnectTask != nil)
    userDisc,           \* user pressed Disconnect (suppresses auto-reconnect)
    background,         \* app is backgrounded
    netOK,              \* network path is satisfied
    ledger,             \* armed expected-closure marker for this conversation
    turnAborted,        \* the current turn was aborted (stream stays live)
    wIllegalReconnect,  \* an auto-reconnect began while suppressed (sticky witness)
    wTerminalEscape,    \* an auto action left the terminal state (sticky witness)
    wAbortDropped       \* an abort dropped the stream / triggered reconnect (sticky witness)

vars == << status, dials, loopActive, userDisc, background, netOK, ledger,
           turnAborted, wIllegalReconnect, wTerminalEscape, wAbortDropped >>

-----------------------------------------------------------------------------
CCTypeOK ==
    /\ status \in Statuses
    /\ dials \in 0..2
    /\ loopActive \in BOOLEAN
    /\ userDisc \in BOOLEAN
    /\ background \in BOOLEAN
    /\ netOK \in BOOLEAN
    /\ ledger \in LedgerKinds
    /\ turnAborted \in BOOLEAN
    /\ wIllegalReconnect \in BOOLEAN
    /\ wTerminalEscape \in BOOLEAN
    /\ wAbortDropped \in BOOLEAN

Init ==
    /\ status = "live"
    /\ dials = 0
    /\ loopActive = FALSE
    /\ userDisc = FALSE
    /\ background = FALSE
    /\ netOK = TRUE
    /\ ledger = "none"
    /\ turnAborted = FALSE
    /\ wIllegalReconnect = FALSE
    /\ wTerminalEscape = FALSE
    /\ wAbortDropped = FALSE

-----------------------------------------------------------------------------
\* canContinueAutomaticReconnect (VoltSession+Reconnect.swift L154-163), collapsed.
CanAuto ==
    /\ ~ userDisc
    /\ ~ background
    /\ netOK
    /\ status \in {"down", "waiting"}

-----------------------------------------------------------------------------
\* beginForegroundReconnect: start the single reconnect loop and its first dial.
\* Guards on ~loopActive (no second loop) and status not connected/connecting.
BeginAutoDial ==
    /\ CanAuto
    /\ ~ loopActive
    /\ dials = 0
    /\ loopActive' = TRUE
    /\ dials' = 1
    /\ wIllegalReconnect' = wIllegalReconnect \/ userDisc            \* FALSE by CanAuto
    /\ wTerminalEscape'   = wTerminalEscape \/ (status = "terminal") \* FALSE by CanAuto
    /\ UNCHANGED << status, userDisc, background, netOK, ledger, turnAborted, wAbortDropped >>

\* The one loop retries after a failed dial (sequential, still one loop).
RetryDial ==
    /\ loopActive
    /\ dials = 0
    /\ CanAuto
    /\ dials' = 1
    /\ UNCHANGED << status, loopActive, userDisc, background, netOK, ledger, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

\* A reconnect dial connects.
DialSucceed ==
    /\ dials >= 1
    /\ status' = "live"
    /\ dials' = dials - 1
    /\ loopActive' = FALSE
    /\ wTerminalEscape' = wTerminalEscape \/ (status = "terminal")   \* status is down/waiting here
    /\ UNCHANGED << userDisc, background, netOK, ledger, turnAborted, wIllegalReconnect, wAbortDropped >>

\* A reconnect dial fails; the loop keeps retrying only while it still can.
DialFail ==
    /\ dials >= 1
    /\ dials' = dials - 1
    /\ loopActive' = IF (~ userDisc /\ ~ background /\ netOK /\ status # "terminal") THEN loopActive ELSE FALSE
    /\ UNCHANGED << status, userDisc, background, netOK, ledger, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

\* Unexpected stream loss (network / host): report a disconnect, become recoverable.
LoseStreamUnexpected ==
    /\ status = "live"
    /\ ledger = "none"
    /\ status' = "down"
    /\ UNCHANGED << dials, loopActive, userDisc, background, netOK, ledger, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

\* Arm an expected-closure marker before the host closes the stream.
MarkHandoff ==
    /\ status = "live" /\ ledger = "none"
    /\ ledger' = "handoff"
    /\ UNCHANGED << status, dials, loopActive, userDisc, background, netOK, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

MarkTerminal ==
    /\ status = "live" /\ ledger = "none"
    /\ ledger' = "terminal"
    /\ UNCHANGED << status, dials, loopActive, userDisc, background, netOK, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

\* Expected hand-off closure (lease_transferred / session_rekeyed_reconnect):
\* consume the marker and reconnect cleanly -- no surprise disconnect.
LoseStreamHandoff ==
    /\ status = "live"
    /\ ledger = "handoff"
    /\ ledger' = "none"
    /\ status' = "down"
    /\ UNCHANGED << dials, loopActive, userDisc, background, netOK, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

\* Expected terminal closure (revocation / workspace removal): absorbing failure.
LoseStreamTerminal ==
    /\ status = "live"
    /\ ledger = "terminal"
    /\ ledger' = "none"
    /\ status' = "terminal"
    /\ dials' = 0
    /\ loopActive' = FALSE
    /\ UNCHANGED << userDisc, background, netOK, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

\* Abort the current turn: the stream stays LIVE (abort is not detach).
Abort ==
    /\ status = "live"
    /\ ~ turnAborted
    /\ turnAborted' = TRUE
    /\ wAbortDropped' = wAbortDropped \/ (status # "live") \/ loopActive   \* FALSE: status stays live, loop untouched
    /\ UNCHANGED << status, dials, loopActive, userDisc, background, netOK, ledger,
                    wIllegalReconnect, wTerminalEscape >>

ClearTurn ==
    /\ turnAborted
    /\ turnAborted' = FALSE
    /\ UNCHANGED << status, dials, loopActive, userDisc, background, netOK, ledger,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

\* The user explicitly disconnects: suppress auto-reconnect, cancel any loop.
UserDisconnect ==
    /\ ~ userDisc
    /\ userDisc' = TRUE
    /\ status' = "down"
    /\ dials' = 0
    /\ loopActive' = FALSE
    /\ UNCHANGED << background, netOK, ledger, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

\* The user explicitly reconnects: clears suppression, starts a dial (also the only
\* escape from the terminal state).
UserReconnect ==
    /\ userDisc \/ status \in {"down", "waiting", "terminal"}
    /\ userDisc' = FALSE
    /\ status' = "down"
    /\ loopActive' = TRUE
    /\ dials' = 1
    /\ UNCHANGED << background, netOK, ledger, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

\* Network path drops. If a dial is IN FLIGHT it owns "connecting" -- do NOT cancel
\* it (that is the anti-double-loop rule). Otherwise cancel an idle loop.
NetLoss ==
    /\ netOK
    /\ netOK' = FALSE
    /\ IF dials > 0
       THEN /\ UNCHANGED << status, loopActive >>
       ELSE /\ loopActive' = FALSE
            /\ status' = IF status = "down" THEN "waiting" ELSE status
    /\ UNCHANGED << dials, userDisc, background, ledger, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

NetSatisfied ==
    /\ ~ netOK
    /\ netOK' = TRUE
    /\ UNCHANGED << status, dials, loopActive, userDisc, background, ledger, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

\* Backgrounding detaches and cancels reconnect; foreground re-enables it.
Background ==
    /\ ~ background
    /\ background' = TRUE
    /\ loopActive' = FALSE
    /\ dials' = 0
    /\ status' = IF status = "live" THEN "down" ELSE status
    /\ UNCHANGED << userDisc, netOK, ledger, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

Foreground ==
    /\ background
    /\ background' = FALSE
    /\ UNCHANGED << status, dials, loopActive, userDisc, netOK, ledger, turnAborted,
                    wIllegalReconnect, wTerminalEscape, wAbortDropped >>

Next ==
    \/ BeginAutoDial \/ RetryDial \/ DialSucceed \/ DialFail
    \/ LoseStreamUnexpected \/ MarkHandoff \/ MarkTerminal
    \/ LoseStreamHandoff \/ LoseStreamTerminal
    \/ Abort \/ ClearTurn
    \/ UserDisconnect \/ UserReconnect
    \/ NetLoss \/ NetSatisfied \/ Background \/ Foreground

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* At most one reconnect dial is ever in flight -- a network blip during a dial
\* never spawns a second concurrent dial.
SingleReconnectDial == dials <= 1

\* While the user has disconnected, no reconnect loop or dial is running.
UserDiscSuppresses == userDisc => (~ loopActive /\ dials = 0)

\* No AUTOMATIC action ever began a reconnect while suppressed.
NoIllegalReconnect == wIllegalReconnect = FALSE

\* No AUTOMATIC action escaped the absorbing terminal state.
TerminalAbsorbing == wTerminalEscape = FALSE

\* An abort never drops the stream or triggers a reconnect.
AbortKeepsLive == wAbortDropped = FALSE

\* A live in-flight dial implies the loop owns it (coherence of the two counters).
DialImpliesLoop == (dials >= 1) => loopActive
=============================================================================
