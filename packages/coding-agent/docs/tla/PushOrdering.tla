------------------------------- MODULE PushOrdering -------------------------------
\* In plain terms
\*
\* A Live Activity (the lock-screen/Dynamic Island progress pill) can only be
\* delivered if the phone first told the daemon HOW to reach it. So there is a
\* strict order: the phone registers a push target (which carries the Live
\* Activity delivery channel) and waits for the ack; only then does it register
\* the Live Activity. The daemon likewise refuses a Live Activity registration
\* whose token it can't resolve to a stored channel (`unknown_live_activity_token`).
\*
\* The other subtlety: if the delivery channel CHANGES (new token / session), any
\* previously "confirmed" channel must be thrown away, so a stale confirmation can
\* never wave through a Live Activity for the wrong channel.
\*
\* Source of truth:
\*   volt-app .../VoltSession+LiveActivity.swift  (phone two-phase send + confirm)
\*   src/daemon/conversation-commands.ts          (register_live_activity gate)
\*   src/core/remote/iroh/push.ts                 (host delivery via stored channel)
\*
\* Properties: the daemon never registers a Live Activity without a matching
\* stored delivery channel; the phone never sends the Live Activity registration
\* before its channel is confirmed; and a confirmed channel always matches the
\* current one (stale confirmations are invalidated).

EXTENDS Naturals

CONSTANTS
    Channels,   \* delivery channel identities (symmetric); small, e.g. {c1, c2}
    NONE        \* sentinel: no channel

ASSUME NONE \notin Channels

ChannelOrNone == Channels \cup {NONE}
PushPhases    == {"idle", "sent", "confirmed"}
LAPhases      == {"idle", "sent", "registered"}

VARIABLES
    currentChannel,    \* the channel the phone currently wants a Live Activity on
    pushPhase,         \* register_push_target progress
    pushSentChannel,   \* channel carried by the in-flight push registration
    confirmedChannel,  \* channel confirmed by a push-target ack (gates the LA send)
    laPhase,           \* register_live_activity progress
    laSentChannel,     \* channel of the in-flight LA registration
    storedChannel,     \* daemon's stored delivery channel (from register_push_target)
    hostLAChannel,     \* channel of the daemon's accepted LA registration
    badHostAccept,     \* daemon accepted an LA with no matching stored channel (sticky)
    badPhoneSend       \* phone sent an LA registration before its channel was confirmed (sticky)

vars == << currentChannel, pushPhase, pushSentChannel, confirmedChannel, laPhase,
           laSentChannel, storedChannel, hostLAChannel, badHostAccept, badPhoneSend >>

-----------------------------------------------------------------------------
POTypeOK ==
    /\ currentChannel \in ChannelOrNone
    /\ pushPhase \in PushPhases
    /\ pushSentChannel \in ChannelOrNone
    /\ confirmedChannel \in ChannelOrNone
    /\ laPhase \in LAPhases
    /\ laSentChannel \in ChannelOrNone
    /\ storedChannel \in ChannelOrNone
    /\ hostLAChannel \in ChannelOrNone
    /\ badHostAccept \in BOOLEAN
    /\ badPhoneSend \in BOOLEAN

Init ==
    /\ currentChannel = NONE
    /\ pushPhase = "idle"
    /\ pushSentChannel = NONE
    /\ confirmedChannel = NONE
    /\ laPhase = "idle"
    /\ laSentChannel = NONE
    /\ storedChannel = NONE
    /\ hostLAChannel = NONE
    /\ badHostAccept = FALSE
    /\ badPhoneSend = FALSE

-----------------------------------------------------------------------------
\* The desired channel changes (new token / session, or Live Activity cleared).
\* resetLiveActivityDeliveryStateIfNeeded: a stale confirmed / pending push
\* channel is thrown away, and the LA registration is invalidated.
SetChannel(c) ==
    /\ c # currentChannel
    /\ currentChannel'   = c
    /\ confirmedChannel' = IF confirmedChannel = c THEN confirmedChannel ELSE NONE
    /\ pushPhase'        = IF pushSentChannel = c THEN pushPhase ELSE "idle"
    /\ pushSentChannel'  = IF pushSentChannel = c THEN pushSentChannel ELSE NONE
    /\ laPhase'          = "idle"
    /\ laSentChannel'    = NONE
    /\ UNCHANGED << storedChannel, hostLAChannel, badHostAccept, badPhoneSend >>

\* Phone sends register_push_target for the current channel; clears confirmation.
PhoneSendPush ==
    /\ currentChannel # NONE
    /\ pushPhase'        = "sent"
    /\ pushSentChannel'  = currentChannel
    /\ confirmedChannel' = NONE
    /\ UNCHANGED << currentChannel, laPhase, laSentChannel, storedChannel,
                    hostLAChannel, badHostAccept, badPhoneSend >>

\* Daemon receives register_push_target and stores the delivery channel.
HostStorePush ==
    /\ pushPhase = "sent"
    /\ storedChannel' = pushSentChannel
    /\ UNCHANGED << currentChannel, pushPhase, pushSentChannel, confirmedChannel,
                    laPhase, laSentChannel, hostLAChannel, badHostAccept, badPhoneSend >>

\* Phone processes the push-target ack (after the daemon stored it): confirm the
\* channel only if it still matches what the phone currently wants.
PhoneAckPush ==
    /\ pushPhase = "sent"
    /\ storedChannel = pushSentChannel      \* the ack follows the daemon storing it
    /\ pushPhase'        = "confirmed"
    /\ confirmedChannel' = IF pushSentChannel = currentChannel THEN pushSentChannel ELSE NONE
    /\ pushSentChannel'  = NONE
    /\ UNCHANGED << currentChannel, laPhase, laSentChannel, storedChannel,
                    hostLAChannel, badHostAccept, badPhoneSend >>

\* Phone sends register_live_activity -- ONLY when the channel is confirmed.
PhoneSendLA ==
    /\ laPhase = "idle"
    /\ currentChannel # NONE
    /\ confirmedChannel = currentChannel
    /\ laPhase'       = "sent"
    /\ laSentChannel' = currentChannel
    /\ badPhoneSend'  = badPhoneSend \/ (confirmedChannel # currentChannel)
    /\ UNCHANGED << currentChannel, pushPhase, pushSentChannel, confirmedChannel,
                    storedChannel, hostLAChannel, badHostAccept >>

\* Daemon processes register_live_activity: accept iff it has a matching stored
\* channel, else reject (unknown_live_activity_token).
HostProcessLA ==
    /\ laPhase = "sent"
    /\ IF storedChannel = laSentChannel
       THEN /\ laPhase' = "registered"
            /\ hostLAChannel' = laSentChannel
            /\ badHostAccept' = badHostAccept
            /\ UNCHANGED laSentChannel
       ELSE /\ laPhase' = "idle"                 \* rejected
            /\ laSentChannel' = NONE
            /\ hostLAChannel' = hostLAChannel
            /\ badHostAccept' = badHostAccept \/ FALSE
    /\ UNCHANGED << currentChannel, pushPhase, pushSentChannel, confirmedChannel,
                    storedChannel, badPhoneSend >>

\* Cleanup: unregister the Live Activity (disable / replace / close / abort).
Unregister ==
    /\ laPhase = "registered"
    /\ laPhase' = "idle"
    /\ laSentChannel' = NONE
    /\ hostLAChannel' = NONE
    /\ UNCHANGED << currentChannel, pushPhase, pushSentChannel, confirmedChannel,
                    storedChannel, badHostAccept, badPhoneSend >>

Next ==
    \/ \E c \in ChannelOrNone : SetChannel(c)
    \/ PhoneSendPush
    \/ HostStorePush
    \/ PhoneAckPush
    \/ PhoneSendLA
    \/ HostProcessLA
    \/ Unregister

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* The daemon never registers a Live Activity without a matching stored delivery
\* channel (the register_push_target-before-register_live_activity ordering).
OrderingGate == badHostAccept = FALSE

\* The phone never sends the Live Activity registration before its channel is
\* confirmed by a push-target ack.
SendAfterConfirm == badPhoneSend = FALSE

\* A confirmed delivery channel always matches the current one; stale confirmations
\* are invalidated on a channel change (so they can't gate the wrong Live Activity).
StaleChannelInvalidated ==
    (confirmedChannel # NONE) => (confirmedChannel = currentChannel)

\* A daemon-registered Live Activity is always for the currently stored channel at
\* the time it was accepted (follows from OrderingGate).
RegisteredLAHadStoredChannel ==
    (laPhase = "registered") => (hostLAChannel # NONE)
=============================================================================
