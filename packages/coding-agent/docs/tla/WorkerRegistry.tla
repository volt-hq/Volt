------------------------------ MODULE WorkerRegistry ------------------------------
(***************************************************************************)
(* In plain terms                                                          *)
(*                                                                         *)
(* Every interactive conversation runs in a conversation WORKER: a process *)
(* the daemon spawns and supervises.  Clients (a TUI or a phone) never own *)
(* a conversation; the daemon relays their stream to the worker that hosts *)
(* it.  Ownership never moves between processes.  Workers are shared: a    *)
(* worker hosts up to Cap TOP-LEVEL conversations, each opened by a client *)
(* whose spawn options give the same COMPATIBILITY KEY as the worker's     *)
(* (same workspace and generation, environment, extension set, tool policy *)
(* and opener kind, trust override).  Each top-level conversation heads a  *)
(* GROUP: the conversations that must share its writer (subagent children, *)
(* review siblings, extension-started moves), which the worker CLAIMS from *)
(* the registry first.                                                     *)
(*                                                                         *)
(* The daemon's worker registry decides, for each open:                    *)
(*                                                                         *)
(*   a live worker hosts it      -> mint a single-use relay offer to it    *)
(*   it is starting or closing   -> wait for that same spawn or the close  *)
(*   its worker is retiring      -> wait for it to exit, then route        *)
(*   nobody hosts it             -> route it into a compatible live worker *)
(*                                  with room, else spawn a worker         *)
(*                                                                         *)
(* A worker takes the per-log OS lock before it opens a log, and the lock  *)
(* never waits, so a replacement retries until the previous holder is      *)
(* gone.  Retention is per conversation: a detached, idle group is closed  *)
(* after a TTL (the worker can refuse if it turned active), and a worker   *)
(* that hosts nothing retires.  One conversation can also be closed        *)
(* without the option to refuse (a revoked client, a removed worktree).  A *)
(* crashed worker's relays close and its clients reconnect.  If the daemon *)
(* dies, its workers stop taking input, finish their turn, and exit; a     *)
(* restarted daemon starts from an empty registry and admits nothing until *)
(* those orphans have exited.                                              *)
(*                                                                         *)
(* The properties: one registered host and one writer per log; clients     *)
(* attach only to live workers that have the log open; relay offers are    *)
(* single-use and only for live workers and open groups; a conversation    *)
(* enters a worker only under the worker's key, and at most Cap top-level  *)
(* conversations share one; closing one group touches no other group; no   *)
(* acknowledged input is lost or committed twice across crashes,           *)
(* retirement, and daemon loss; retention closes only detached, idle       *)
(* groups; a fenced workspace generation is inert; a worker never stays    *)
(* live with nothing to host; and every open is eventually served.         *)
(*                                                                         *)
(* -------------------------------------------------------------------     *)
(* Source of truth (keep this spec beside it; change the model first):     *)
(*   the Phase 7 plan (#585): section 1 worker model, section 6 this model *)
(*     and the maintainer's D11 revision (shared workers, slice 7b)        *)
(*   docs/daemon-hosted-conversations-design.md  4.2, 4.3, 5.1-5.3         *)
(*   docs/workspace-authority-lifecycle-design.md W3-W6                    *)
(*   src/daemon/worker-registry.ts, src/daemon/worker-launcher.ts,         *)
(*     src/daemon/worker/  (Phase 7 slices 4, 5, and 7b)                   *)
(*   src/daemon/worker-spawn-options.ts  (the compatibility key)           *)
(*   src/daemon/worker-gate.ts  (the restart wait, RestartWaitsForOrphans) *)
(*   src/daemon/relay-stream.ts  (single-use relay offers, 10 s TTL)       *)
(*   src/core/conversation-log/conversation-lock.ts  (per-log lock)        *)
(*   src/core/host/hosted-conversation.ts  isActive() (the idle check)     *)
(*                                                                         *)
(* Modeling choices (smallest model that checks the plan's properties):    *)
(*  - One workspace.  Of the registry key (workspace, generation,          *)
(*    session) the name part is constant, so a stale generation stands for *)
(*    any authority mismatch (another workspace, replace, unregister).     *)
(*    The compatibility key is an opaque value (Keys) each open carries;   *)
(*    a worker keeps its spawner's key for its lifetime.                   *)
(*  - The plan's Route is split into its outcomes: Spawn (nobody hosts it  *)
(*    and no compatible live worker has room), RouteShared (one does),     *)
(*    MintOffer (a live worker hosts it), and waiting (no step while its   *)
(*    worker is starting or retiring, or its group is closing).            *)
(*  - The control connection is derived (Ctl): it lives exactly while the  *)
(*    worker process and its daemon do.  A lone connection drop behaves as *)
(*    daemon loss for that worker and is covered by the orphan path.       *)
(*  - att[c] names only the serving worker; the served session is want[c]. *)
(*    offer[c] is the client's pending relay offer: redemption moves it    *)
(*    into att[c] and expiry clears it, so "used" and "expired" need no    *)
(*    flags of their own.                                                  *)
(*  - One durable input id per sending client (MaxInputs = 1): inSess,     *)
(*    wire, acked, and logCnt (commits of that id in its session's log).   *)
(*    Ids are deduplicated independently, so one sender (Senders = {c1})   *)
(*    checks the dedupe path; the other client still opens and attaches.   *)
(*  - Activity is per conversation (busy); the registry's view is exact.   *)
(*    A turn that starts after the registry sent a close or a stop stands  *)
(*    for the debounced report's lag, and the worker refuses it.           *)
(*  - A group closes in one step (the worker closes its members, claims    *)
(*    first, and releases each); a top-level conversation releases on its  *)
(*    own (it lost its log) only once its group is just itself.            *)
(*  - Worker ids are never reused.  When every id is spent, an open that   *)
(*    needs a spawn is refused (SpawnUnavailable), a bound artifact.       *)
(*  - Faults (worker crash, offer expiry, daemon crash) and forced closes  *)
(*    of one conversation share one budget, MaxFaults, so liveness is      *)
(*    checked after they stop.  A starting worker that gives up on a held  *)
(*    lock after 75 s is a Crash.                                          *)
(*  - Not modeled: tool policy and conversation_in_use (D9), in-process    *)
(*    hosts holding a lock (D20), --no-session (D15; its worker is never   *)
(*    shared), the per-worker cap on hosted conversations (claims), a      *)
(*    routed conversation whose open fails, graceful daemon stop (forced   *)
(*    retirement of every worker, as RetireStale does for a workspace),    *)
(*    and the handoff write a redirect makes to its target log (a          *)
(*    lock-guarded write that fails the move when the target is held).     *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Sessions,               \* conversation logs (session ids); e.g. {s1, s2}
    Workers,                \* worker ids in spawn order, never reused; e.g. {w1, w2, w3}
    Clients,                \* client streams (a TUI or a phone); e.g. {c1, c2}
    Senders,                \* clients that send an input id; e.g. {c1}
    Keys,                   \* compatibility keys an open's spawn options give; e.g. {k1}
    NoWorker,               \* sentinel: free lock, no offer, not attached
    NoSession,              \* sentinel: wants nothing, input not sent yet, no group
    NoKey,                  \* sentinel: no open, or no worker
    Cap,                    \* top-level conversations one worker hosts at most
    MaxFaults,              \* budget of crashes, offer expiries, daemon crashes, forced closes
    MaxGen,                 \* bound on the workspace authority generation
    RestartWaitsForOrphans  \* design switch: a restarted daemon admits nothing
                            \* until the dead daemon's workers have exited

ASSUME NoWorker \notin Workers
ASSUME NoSession \notin Sessions
ASSUME NoKey \notin Keys
ASSUME Senders \subseteq Clients
ASSUME Cap \in Nat /\ Cap >= 1
ASSUME MaxFaults \in Nat /\ MaxGen \in Nat
ASSUME RestartWaitsForOrphans \in BOOLEAN

WStates == {"unused", "starting", "live", "retiring", "exited"}
Frames  == {"none", "input", "ack"}

VARIABLES
    daemonUp,   \* the daemon process runs
    gen,        \* the workspace's current authority generation
    wsPending,  \* a fenced workspace mutation awaits its workers' exit
    faults,     \* faults and forced closes spent, 0..MaxFaults
    wState,     \* [Workers -> WStates]                registry view of the worker
    wGen,       \* [Workers -> 0..MaxGen]              generation of the worker's key
    wKey,       \* [Workers -> Keys \cup {NoKey}]      the worker's compatibility key
    hosts,      \* [Workers -> SUBSET Sessions]        registry assignment (tops + claims)
    tops,       \* [Workers -> SUBSET Sessions]        top-level conversations (spawn + routed)
    grp,        \* [Sessions -> Sessions \cup {NoSession}]  the top-level conversation heading a hosted session's group
    closeReq,   \* [Workers -> SUBSET Sessions]        groups (by top) the registry asked the worker to close
    closeForced,\* [Workers -> SUBSET Sessions]        of those, the closes that cannot be refused
    alive,      \* [Workers -> BOOLEAN]                the worker process exists
    opened,     \* [Workers -> SUBSET Sessions]        logs the process has open
    busy,       \* SUBSET Sessions                     conversations isActive() (where they are open)
    closing,    \* [Workers -> BOOLEAN]                the worker accepted worker_stop
    lockOf,     \* [Sessions -> Workers \cup {NoWorker}]  the per-log OS lock
    want,       \* [Clients -> Sessions \cup {NoSession}] the conversation the client opens
    wantKey,    \* [Clients -> Keys \cup {NoKey}]      the compatibility key of the client's open
    offer,      \* [Clients -> Workers \cup {NoWorker}]   unredeemed relay offer
    att,        \* [Clients -> Workers \cup {NoWorker}]   worker serving the relayed stream
    inSess,     \* [Clients -> Sessions \cup {NoSession}] session of the client's input id
    wire,       \* [Clients -> Frames]                 frame in flight on the relay
    acked,      \* [Clients -> BOOLEAN]                the client holds the input's ack
    logCnt      \* [Clients -> 0..2]                   commits of the input id (durable)

daemonVars == << daemonUp, gen, wsPending, faults >>
regVars    == << wState, wGen, wKey, hosts, tops, grp, closeReq, closeForced >>
procVars   == << alive, opened, busy, closing, lockOf >>
clientVars == << want, wantKey, offer, att, inSess, wire, acked, logCnt >>
vars       == << daemonVars, regVars, procVars, clientVars >>

-----------------------------------------------------------------------------
(* Derived predicates *)

\* In the registry: the daemon routes to it and waits for it.
Registered(w) == wState[w] \in {"starting", "live", "retiring"}

\* Its key's generation was fenced: it must retire and can never be refused.
Forced(w) == wGen[w] < gen

\* The worker's control connection (role worker) is up.
Ctl(w) == daemonUp /\ alive[w] /\ Registered(w)

\* A process the current daemon does not know: left over from a dead daemon.
Orphan(w) == alive[w] /\ wState[w] = "exited"

\* Registered workers hosting s (OneHost: at most one).
HostOf(s) == {w \in Workers : Registered(w) /\ s \in hosts[w]}

\* The hosted sessions of w in the group headed by top-level conversation t.
Group(w, t) == {s \in hosts[w] : grp[s] = t}

\* A hosted conversation of w is running a turn or work.
Busy(w) == opened[w] \cap busy # {}

\* No relayed stream of any hosted conversation, offered or active.
Detached(w) == \A c \in Clients : att[c] # w /\ offer[c] # w

\* No relayed stream of session s at w, offered or active.
DetachedS(w, s) == \A c \in Clients : want[c] = s => (att[c] # w /\ offer[c] # w)

\* The daemon admits opens, offers, and claims: up, and no workspace mutation
\* in flight (workspace authority RFC W3/W5: the old generation's admission is
\* closed and the new one is not admitted until retirement completes).
Admitting == daemonUp /\ ~wsPending

\* A client waiting for its open to be routed.
Waiting(c) == want[c] # NoSession /\ att[c] = NoWorker /\ offer[c] = NoWorker

\* An open of s is being routed.  The daemon routes synchronously (lookup plus
\* offer), so it never closes a conversation in the middle of routing to it;
\* the model's separate routing step must not invent that window.
Routing(s) == \E c \in Clients : Waiting(c) /\ want[c] = s

\* A live worker c's open of an unhosted session can be routed into: the same
\* compatibility key, the current generation, and room for another top-level
\* conversation.  The registry cannot see a crash before its exit.
CanRoute(c, w) ==
    /\ wState[w] = "live"
    /\ wGen[w] = gen
    /\ wKey[w] = wantKey[c]
    /\ Cardinality(tops[w]) < Cap

\* A group the retention TTL applies to: its top is open, nothing is offered
\* to or attached to any member, no open of a member is being routed, and no
\* member is active.
DetachedIdleGroup(w, t) ==
    /\ wState[w] = "live"
    /\ ~Forced(w)
    /\ t \in tops[w]
    /\ t \in opened[w]
    /\ t \notin closeReq[w]
    /\ \A s \in Group(w, t) : DetachedS(w, s) /\ ~Routing(s) /\ s \notin busy

ReleaseLocks(w, S) == [s \in Sessions |-> IF lockOf[s] = w /\ s \in S THEN NoWorker ELSE lockOf[s]]

-----------------------------------------------------------------------------
TypeOK ==
    /\ daemonUp    \in BOOLEAN
    /\ gen         \in 0..MaxGen
    /\ wsPending   \in BOOLEAN
    /\ faults      \in 0..MaxFaults
    /\ wState      \in [Workers -> WStates]
    /\ wGen        \in [Workers -> 0..MaxGen]
    /\ wKey        \in [Workers -> Keys \cup {NoKey}]
    /\ hosts       \in [Workers -> SUBSET Sessions]
    /\ tops        \in [Workers -> SUBSET Sessions]
    /\ grp         \in [Sessions -> Sessions \cup {NoSession}]
    /\ closeReq    \in [Workers -> SUBSET Sessions]
    /\ closeForced \in [Workers -> SUBSET Sessions]
    /\ alive       \in [Workers -> BOOLEAN]
    /\ opened      \in [Workers -> SUBSET Sessions]
    /\ busy        \in SUBSET Sessions
    /\ closing     \in [Workers -> BOOLEAN]
    /\ lockOf      \in [Sessions -> Workers \cup {NoWorker}]
    /\ want        \in [Clients -> Sessions \cup {NoSession}]
    /\ wantKey     \in [Clients -> Keys \cup {NoKey}]
    /\ offer       \in [Clients -> Workers \cup {NoWorker}]
    /\ att         \in [Clients -> Workers \cup {NoWorker}]
    /\ inSess      \in [Clients -> Sessions \cup {NoSession}]
    /\ wire        \in [Clients -> Frames]
    /\ acked       \in [Clients -> BOOLEAN]
    /\ logCnt      \in [Clients -> 0..2]
    /\ \A c \in Clients : (want[c] = NoSession) <=> (wantKey[c] = NoKey)

Init ==
    /\ daemonUp    = TRUE
    /\ gen         = 0
    /\ wsPending   = FALSE
    /\ faults      = 0
    /\ wState      = [w \in Workers |-> "unused"]
    /\ wGen        = [w \in Workers |-> 0]
    /\ wKey        = [w \in Workers |-> NoKey]
    /\ hosts       = [w \in Workers |-> {}]
    /\ tops        = [w \in Workers |-> {}]
    /\ grp         = [s \in Sessions |-> NoSession]
    /\ closeReq    = [w \in Workers |-> {}]
    /\ closeForced = [w \in Workers |-> {}]
    /\ alive       = [w \in Workers |-> FALSE]
    /\ opened      = [w \in Workers |-> {}]
    /\ busy        = {}
    /\ closing     = [w \in Workers |-> FALSE]
    /\ lockOf      = [s \in Sessions |-> NoWorker]
    /\ want        = [c \in Clients |-> NoSession]
    /\ wantKey     = [c \in Clients |-> NoKey]
    /\ offer       = [c \in Clients |-> NoWorker]
    /\ att         = [c \in Clients |-> NoWorker]
    /\ inSess      = [c \in Clients |-> NoSession]
    /\ wire        = [c \in Clients |-> "none"]
    /\ acked       = [c \in Clients |-> FALSE]
    /\ logCnt      = [c \in Clients |-> 0]

-----------------------------------------------------------------------------
(*                      OPENS, SPAWNS, AND RELAY OFFERS                      *)

\* A client opens a conversation with spawn options whose compatibility key is
\* k: a TUI conversation_open or a phone handshake, already admitted and
\* resolved to a session id.  A reconnect after a crash or a move keeps its
\* target and key and simply waits to be routed again.
RequestOpen(c, s, k) ==
    /\ want[c] = NoSession
    /\ want'    = [want    EXCEPT ![c] = s]
    /\ wantKey' = [wantKey EXCEPT ![c] = k]
    /\ UNCHANGED << daemonVars, regVars, procVars, offer, att, inSess, wire, acked, logCnt >>

\* Route, nobody hosts the session and no compatible live worker has room:
\* spawn the next worker id for it, under the opener's key.  A starting or
\* retiring host makes HostOf non-empty, so concurrent opens share one spawn
\* and an open during retirement waits for the exit.
Spawn(c) ==
    /\ Admitting
    /\ Waiting(c)
    /\ HostOf(want[c]) = {}
    /\ ~\E v \in Workers : CanRoute(c, v)
    /\ \E w \in Workers : wState[w] = "unused"
    /\ LET w == CHOOSE v \in Workers : wState[v] = "unused"
           s == want[c] IN
         /\ wState' = [wState EXCEPT ![w] = "starting"]
         /\ wGen'   = [wGen   EXCEPT ![w] = gen]
         /\ wKey'   = [wKey   EXCEPT ![w] = wantKey[c]]
         /\ hosts'  = [hosts  EXCEPT ![w] = {s}]
         /\ tops'   = [tops   EXCEPT ![w] = {s}]
         /\ grp'    = [grp    EXCEPT ![s] = s]
         /\ alive'  = [alive  EXCEPT ![w] = TRUE]
    /\ UNCHANGED << daemonVars, closeReq, closeForced, opened, busy, closing, lockOf, clientVars >>

\* Route, nobody hosts the session: a compatible live worker with room takes
\* it as another top-level conversation (worker_open), which it opens beside
\* its others; the open waits for that, as for a spawn.
RouteShared(c, w) ==
    /\ Admitting
    /\ Waiting(c)
    /\ HostOf(want[c]) = {}
    /\ CanRoute(c, w)
    /\ hosts' = [hosts EXCEPT ![w] = @ \cup {want[c]}]
    /\ tops'  = [tops  EXCEPT ![w] = @ \cup {want[c]}]
    /\ grp'   = [grp   EXCEPT ![want[c]] = want[c]]
    /\ UNCHANGED << daemonVars, wState, wGen, wKey, closeReq, closeForced, procVars, clientVars >>

\* Bound artifact: every worker id is spent and no worker has room, so the open fails.
SpawnUnavailable(c) ==
    /\ Admitting
    /\ Waiting(c)
    /\ HostOf(want[c]) = {}
    /\ ~\E v \in Workers : CanRoute(c, v)
    /\ \A w \in Workers : wState[w] # "unused"
    /\ want'    = [want    EXCEPT ![c] = NoSession]
    /\ wantKey' = [wantKey EXCEPT ![c] = NoKey]
    /\ UNCHANGED << daemonVars, regVars, procVars, offer, att, inSess, wire, acked, logCnt >>

\* The worker opens a hosted log: its first conversation while starting, a
\* routed or claimed one while live.  The lock never waits: the step is
\* enabled only while the lock is free, so a replacement retries until the
\* previous holder released it.
WorkerOpen(w, s) ==
    /\ Ctl(w)
    /\ wState[w] \in {"starting", "live"}
    /\ s \in hosts[w] \ opened[w]
    /\ lockOf[s] = NoWorker
    /\ opened' = [opened EXCEPT ![w] = @ \cup {s}]
    /\ lockOf' = [lockOf EXCEPT ![s] = w]
    /\ UNCHANGED << daemonVars, regVars, alive, busy, closing, clientVars >>

\* worker_ready after session_start: the first conversation is open.
WorkerReady(w) ==
    /\ Ctl(w)
    /\ wState[w] = "starting"
    /\ hosts[w] \subseteq opened[w]
    /\ wState' = [wState EXCEPT ![w] = "live"]
    /\ UNCHANGED << daemonVars, wGen, wKey, hosts, tops, grp, closeReq, closeForced, procVars, clientVars >>

\* Route, a live worker hosts the key: mint a relay offer to it, unless the
\* session's group is closing (the open waits for the close).  The registry
\* knows only its own view (it cannot see a crash before the exit).
MintOffer(c) ==
    /\ Admitting
    /\ Waiting(c)
    /\ \E w \in HostOf(want[c]) :
         /\ wState[w] = "live"
         /\ wGen[w] = gen
         /\ grp[want[c]] \notin closeReq[w]
         /\ offer' = [offer EXCEPT ![c] = w]
    /\ UNCHANGED << daemonVars, regVars, procVars, want, wantKey, att, inSess, wire, acked, logCnt >>

\* The worker redeems the offer with a relay hello.  The daemon accepts an
\* unexpired, unused token of the current generation (W3); the worker serves
\* the stream once the session's log is open there.
AdmitOffer(c) ==
    /\ Admitting
    /\ offer[c] # NoWorker
    /\ LET w == offer[c] IN
         /\ Ctl(w)
         /\ wGen[w] = gen
         /\ want[c] \in opened[w]
         /\ att'   = [att   EXCEPT ![c] = w]
         /\ offer' = [offer EXCEPT ![c] = NoWorker]
    /\ UNCHANGED << daemonVars, regVars, procVars, want, wantKey, inSess, wire, acked, logCnt >>

\* Fault: the 10 s token TTL elapses unredeemed; the client retries the open.
ExpireOffer(c) ==
    /\ offer[c] # NoWorker
    /\ faults < MaxFaults
    /\ offer'  = [offer EXCEPT ![c] = NoWorker]
    /\ faults' = faults + 1
    /\ UNCHANGED << daemonUp, gen, wsPending, regVars, procVars, want, wantKey, att, inSess, wire, acked, logCnt >>

-----------------------------------------------------------------------------
(*                             CLIENTS AND INPUT                             *)

\* The client leaves (quit, close the phone tab).  The worker stays.
Detach(c) ==
    /\ att[c] # NoWorker
    /\ att'     = [att     EXCEPT ![c] = NoWorker]
    /\ want'    = [want    EXCEPT ![c] = NoSession]
    /\ wantKey' = [wantKey EXCEPT ![c] = NoKey]
    /\ wire'    = [wire    EXCEPT ![c] = "none"]
    /\ UNCHANGED << daemonVars, regVars, procVars, offer, inSess, acked, logCnt >>

\* A client structural intent (new_session, switch_session, fork, ...) or an
\* extension-started move whose target the worker claimed: the worker sends
\* ended{moved, target} and the client reconnects through the daemon (D1)
\* with the same spawn options.  Frames on a relay are ordered, so earlier
\* frames settle first, with one exception the model leaves out: the answer
\* to the extension command that moved its own client is not written on the
\* old relay; the client retries that intent on its new connection and the
\* host answers it from the client key's outcome window.  The conversation
\* the client left stays open.
Redirect(c, s) ==
    /\ att[c] # NoWorker
    /\ Ctl(att[c])
    /\ wGen[att[c]] = gen
    /\ wire[c] = "none"
    /\ s # want[c]
    /\ att'  = [att  EXCEPT ![c] = NoWorker]
    /\ want' = [want EXCEPT ![c] = s]
    /\ UNCHANGED << daemonVars, regVars, procVars, wantKey, offer, inSess, wire, acked, logCnt >>

\* The client sends (or, after a reconnect, resends) its input id until acked.
Send(c) ==
    /\ c \in Senders
    /\ att[c] # NoWorker
    /\ wire[c] = "none"
    /\ ~acked[c]
    /\ inSess[c] \in {NoSession, want[c]}
    /\ inSess' = [inSess EXCEPT ![c] = want[c]]
    /\ wire'   = [wire   EXCEPT ![c] = "input"]
    /\ UNCHANGED << daemonVars, regVars, procVars, want, wantKey, offer, att, acked, logCnt >>

\* The worker revalidates authority (worker_authority, D4), commits the input
\* to the durable log unless its clientMessageId is already there, then acks.
Accept(c) ==
    /\ wire[c] = "input"
    /\ att[c] # NoWorker
    /\ Ctl(att[c])
    /\ wGen[att[c]] = gen
    /\ logCnt' = [logCnt EXCEPT ![c] = IF @ = 0 THEN 1 ELSE @]
    /\ wire'   = [wire   EXCEPT ![c] = "ack"]
    /\ UNCHANGED << daemonVars, regVars, procVars, want, wantKey, offer, att, inSess, acked >>

DeliverAck(c) ==
    /\ wire[c] = "ack"
    /\ att[c] # NoWorker
    /\ acked' = [acked EXCEPT ![c] = TRUE]
    /\ wire'  = [wire  EXCEPT ![c] = "none"]
    /\ UNCHANGED << daemonVars, regVars, procVars, want, wantKey, offer, att, inSess, logCnt >>

-----------------------------------------------------------------------------
(*                                   TURNS                                   *)

\* A hosted conversation turns active: a prompt, or a job's wake while it is
\* detached or the worker has not yet answered a close or a stop.  A fenced or
\* closing worker, and a conversation being closed without the option to
\* refuse, admit nothing.
TurnStart(w, s) ==
    /\ Ctl(w)
    /\ wState[w] \in {"live", "retiring"}
    /\ ~Forced(w)
    /\ ~closing[w]
    /\ s \in opened[w]
    /\ s \notin busy
    /\ grp[s] \notin closeForced[w]
    /\ busy' = busy \cup {s}
    /\ UNCHANGED << daemonVars, regVars, alive, opened, closing, lockOf, clientVars >>

TurnEnd(w, s) ==
    /\ alive[w]
    /\ s \in opened[w]
    /\ s \in busy
    /\ busy' = busy \ {s}
    /\ UNCHANGED << daemonVars, regVars, alive, opened, closing, lockOf, clientVars >>

\* The 60 s waitForIdle cap of a forced retirement aborts the worker's turns.
ForceAbort(w) ==
    /\ alive[w]
    /\ Busy(w)
    /\ wState[w] = "retiring"
    /\ Forced(w)
    /\ busy' = busy \ opened[w]
    /\ UNCHANGED << daemonVars, regVars, alive, opened, closing, lockOf, clientVars >>

\* The same cap of a forced conversation close aborts that group's turns.
ForceAbortClose(w, t) ==
    /\ alive[w]
    /\ t \in closeForced[w]
    /\ Group(w, t) \cap busy # {}
    /\ busy' = busy \ Group(w, t)
    /\ UNCHANGED << daemonVars, regVars, alive, opened, closing, lockOf, clientVars >>

-----------------------------------------------------------------------------
(*                     PER-CONVERSATION RETENTION AND CLOSES                 *)

\* The worker hosts nothing after a release: the registry retires it in the
\* same turn (no open is routed to it again) and sends worker_stop.
RetireIfEmpty(w, remaining) ==
    wState' = [wState EXCEPT ![w] = IF remaining = {} THEN "retiring" ELSE @]

\* remote.detachedRuntimeTtlMs fires on a detached, idle group: the registry
\* sends worker_close{reason: "retention"} for its top-level conversation.
CloseDetachedIdle(w, t) ==
    /\ daemonUp
    /\ DetachedIdleGroup(w, t)
    /\ closeReq' = [closeReq EXCEPT ![w] = @ \cup {t}]
    /\ UNCHANGED << daemonVars, wState, wGen, wKey, hosts, tops, grp, closeForced, procVars, clientVars >>

\* One conversation is closed without the option to refuse (a revoked client,
\* a removed worktree, a phone's fresh pairing): its group's relays (offered
\* and active) close first, and the clients route again once the close is
\* done.  Its neighbours in the worker are untouched.
ForceClose(w, t) ==
    /\ daemonUp
    /\ faults < MaxFaults
    /\ wState[w] = "live"
    /\ t \in tops[w]
    /\ t \notin closeForced[w]
    /\ LET gone == {c \in Clients : want[c] \in hosts[w] /\ grp[want[c]] = t /\ (att[c] = w \/ offer[c] = w)} IN
         /\ att'   = [c \in Clients |-> IF c \in gone THEN NoWorker ELSE att[c]]
         /\ offer' = [c \in Clients |-> IF c \in gone THEN NoWorker ELSE offer[c]]
         /\ wire'  = [c \in Clients |-> IF c \in gone THEN "none" ELSE wire[c]]
    /\ closeReq'    = [closeReq    EXCEPT ![w] = @ \cup {t}]
    /\ closeForced' = [closeForced EXCEPT ![w] = @ \cup {t}]
    /\ faults'      = faults + 1
    /\ UNCHANGED << daemonUp, gen, wsPending, wState, wGen, wKey, hosts, tops, grp, procVars,
                    want, wantKey, inSess, acked, logCnt >>

\* The worker answers refused_active: a member of the group turned active.
CloseRefused(w, t) ==
    /\ Ctl(w)
    /\ t \in closeReq[w] \ closeForced[w]
    /\ Group(w, t) \cap busy # {}
    /\ closeReq' = [closeReq EXCEPT ![w] = @ \ {t}]
    /\ UNCHANGED << daemonVars, wState, wGen, wKey, hosts, tops, grp, closeForced, procVars, clientVars >>

\* The worker answers closed: the group is idle (its own isActive() check),
\* so it closes its members (session_shutdown{quit}), releasing their locks,
\* and the registry drops each.  A worker left with nothing retires.
CloseAccept(w, t) ==
    /\ Ctl(w)
    /\ t \in closeReq[w]
    /\ Group(w, t) \cap busy = {}
    /\ LET G == Group(w, t) IN
         /\ hosts'       = [hosts       EXCEPT ![w] = @ \ G]
         /\ tops'        = [tops        EXCEPT ![w] = @ \ {t}]
         /\ grp'         = [s \in Sessions |-> IF s \in G THEN NoSession ELSE grp[s]]
         /\ closeReq'    = [closeReq    EXCEPT ![w] = @ \ {t}]
         /\ closeForced' = [closeForced EXCEPT ![w] = @ \ {t}]
         /\ opened'      = [opened      EXCEPT ![w] = @ \ G]
         /\ lockOf'      = ReleaseLocks(w, G)
         /\ RetireIfEmpty(w, hosts[w] \ G)
    /\ UNCHANGED << daemonVars, wGen, wKey, alive, busy, closing, clientVars >>

-----------------------------------------------------------------------------
(*                                 RETIREMENT                                *)

\* The worker answers refused_active: it turned active.  Back to live.  (A
\* worker retiring because it hosts nothing has nothing to turn active.)
StopRefused(w) ==
    /\ Ctl(w)
    /\ wState[w] = "retiring"
    /\ ~Forced(w)
    /\ ~closing[w]
    /\ Busy(w)
    /\ wState' = [wState EXCEPT ![w] = "live"]
    /\ UNCHANGED << daemonVars, wGen, wKey, hosts, tops, grp, closeReq, closeForced, procVars, clientVars >>

\* The worker answers stopped: it is idle (its own isActive() check), so it
\* stops admitting and closes its conversations (session_shutdown{quit}).
StopAccept(w) ==
    /\ Ctl(w)
    /\ wState[w] = "retiring"
    /\ ~closing[w]
    /\ ~Busy(w)
    /\ closing' = [closing EXCEPT ![w] = TRUE]
    /\ UNCHANGED << daemonVars, regVars, alive, opened, busy, lockOf, clientVars >>

\* The conversations are closed; the process exits and its locks are released.
Dispose(w) ==
    /\ alive[w]
    /\ closing[w]
    /\ alive'   = [alive   EXCEPT ![w] = FALSE]
    /\ opened'  = [opened  EXCEPT ![w] = {}]
    /\ busy'    = busy \ opened[w]
    /\ closing' = [closing EXCEPT ![w] = FALSE]
    /\ lockOf'  = ReleaseLocks(w, Sessions)
    /\ UNCHANGED << daemonVars, regVars, clientVars >>

\* Workspace replace, unregister, revoke, access tightening, or worktree
\* removal: fence the authority.  Admission closes until the fenced workers
\* have exited (W3, W5).  Its success is reported by WorkspaceRetired.
FenceWorkspace ==
    /\ daemonUp
    /\ ~wsPending
    /\ gen < MaxGen
    /\ gen'       = gen + 1
    /\ wsPending' = TRUE
    /\ UNCHANGED << daemonUp, faults, regVars, procVars, clientVars >>

\* A fenced worker: its relays (offered and active) get fatal{loss} and close,
\* and it is retired without the option to refuse.  Every conversation it
\* hosts is of the fenced workspace and generation.
RetireStale(w) ==
    /\ daemonUp
    /\ Forced(w)
    /\ wState[w] \in {"starting", "live"}
    /\ LET gone == {c \in Clients : att[c] = w \/ offer[c] = w} IN
         /\ att'     = [c \in Clients |-> IF c \in gone THEN NoWorker ELSE att[c]]
         /\ offer'   = [c \in Clients |-> IF c \in gone THEN NoWorker ELSE offer[c]]
         /\ want'    = [c \in Clients |-> IF c \in gone THEN NoSession ELSE want[c]]
         /\ wantKey' = [c \in Clients |-> IF c \in gone THEN NoKey ELSE wantKey[c]]
         /\ wire'    = [c \in Clients |-> IF c \in gone THEN "none" ELSE wire[c]]
    /\ wState' = [wState EXCEPT ![w] = "retiring"]
    /\ UNCHANGED << daemonVars, wGen, wKey, hosts, tops, grp, closeReq, closeForced, procVars,
                    inSess, acked, logCnt >>

\* The mutation reports success once no registered worker of the fenced
\* generation remains (W4), and admission reopens.
WorkspaceRetired ==
    /\ daemonUp
    /\ wsPending
    /\ \A w \in Workers : Registered(w) => ~Forced(w)
    /\ wsPending' = FALSE
    /\ UNCHANGED << daemonUp, gen, faults, regVars, procVars, clientVars >>

-----------------------------------------------------------------------------
(*                          CRASHES AND DAEMON LOSS                          *)

\* Fault: a registered worker dies (or a starting worker gives up on a held
\* lock).  The OS releases its locks and its relays drop: every conversation
\* it hosts goes with it (the shared worker's blast radius).
Crash(w) ==
    /\ alive[w]
    /\ Registered(w)
    /\ faults < MaxFaults
    /\ alive'   = [alive   EXCEPT ![w] = FALSE]
    /\ opened'  = [opened  EXCEPT ![w] = {}]
    /\ busy'    = busy \ opened[w]
    /\ closing' = [closing EXCEPT ![w] = FALSE]
    /\ lockOf'  = ReleaseLocks(w, Sessions)
    /\ att'     = [c \in Clients |-> IF att[c] = w THEN NoWorker ELSE att[c]]
    /\ wire'    = [c \in Clients |-> IF att[c] = w THEN "none" ELSE wire[c]]
    /\ faults'  = faults + 1
    /\ UNCHANGED << daemonUp, gen, wsPending, regVars,
                    want, wantKey, offer, inSess, acked, logCnt >>

\* The daemon sees the child exit: the entry becomes exited and its offers
\* close with worker_exited (D19); those clients route again.
ObserveExit(w) ==
    /\ daemonUp
    /\ Registered(w)
    /\ ~alive[w]
    /\ wState'      = [wState      EXCEPT ![w] = "exited"]
    /\ hosts'       = [hosts       EXCEPT ![w] = {}]
    /\ tops'        = [tops        EXCEPT ![w] = {}]
    /\ grp'         = [s \in Sessions |-> IF s \in hosts[w] THEN NoSession ELSE grp[s]]
    /\ closeReq'    = [closeReq    EXCEPT ![w] = {}]
    /\ closeForced' = [closeForced EXCEPT ![w] = {}]
    /\ wGen'        = [wGen        EXCEPT ![w] = 0]       \* canonical once gone
    /\ wKey'        = [wKey        EXCEPT ![w] = NoKey]
    /\ offer'       = [c \in Clients |-> IF offer[c] = w THEN NoWorker ELSE offer[c]]
    /\ UNCHANGED << daemonVars, procVars, want, wantKey, att, inSess, wire, acked, logCnt >>

\* Fault: the daemon dies.  The registry, its relays, and its offers are lost;
\* clients keep their target and reconnect later.  An in-flight workspace
\* mutation fails and rolls back (W6).  Live workers become orphans: no
\* control connection, so they take no input.
DaemonCrash ==
    /\ daemonUp
    /\ faults < MaxFaults
    /\ daemonUp'    = FALSE
    /\ wsPending'   = FALSE
    /\ gen'         = IF wsPending THEN gen - 1 ELSE gen
    /\ faults'      = faults + 1
    /\ wState'      = [w \in Workers |-> IF Registered(w) THEN "exited" ELSE wState[w]]
    /\ hosts'       = [w \in Workers |-> {}]
    /\ tops'        = [w \in Workers |-> {}]
    /\ grp'         = [s \in Sessions |-> NoSession]
    /\ closeReq'    = [w \in Workers |-> {}]
    /\ closeForced' = [w \in Workers |-> {}]
    /\ wGen'        = [w \in Workers |-> IF alive[w] THEN wGen[w] ELSE 0]
    /\ wKey'        = [w \in Workers |-> NoKey]
    /\ att'         = [c \in Clients |-> NoWorker]
    /\ offer'       = [c \in Clients |-> NoWorker]
    /\ wire'        = [c \in Clients |-> "none"]
    /\ UNCHANGED << procVars, want, wantKey, inSess, acked, logCnt >>

\* The daemon starts again with an empty registry.  With the restart wait
\* (the implementation: every worker holds a shared lock on the daemon's
\* worker gate, which a starting daemon takes exclusively before it serves) it
\* admits nothing until the orphans have exited.  Without it, spawns retry on
\* locks the orphans hold (WorkerRegistryOrphans.cfg).
DaemonRestart ==
    /\ ~daemonUp
    /\ RestartWaitsForOrphans => \A w \in Workers : ~alive[w]
    /\ daemonUp' = TRUE
    /\ UNCHANGED << gen, wsPending, faults, regVars, procVars, clientVars >>

\* An orphan stops taking input, lets its turns finish (60 s cap), persists,
\* and exits.  Workers never outlive their daemon for longer than that.
OrphanExit(w) ==
    /\ Orphan(w)
    /\ alive'   = [alive   EXCEPT ![w] = FALSE]
    /\ opened'  = [opened  EXCEPT ![w] = {}]
    /\ busy'    = busy \ opened[w]
    /\ closing' = [closing EXCEPT ![w] = FALSE]
    /\ lockOf'  = ReleaseLocks(w, Sessions)
    /\ wGen'    = [wGen    EXCEPT ![w] = 0]
    /\ UNCHANGED << daemonVars, wState, wKey, hosts, tops, grp, closeReq, closeForced, clientVars >>

-----------------------------------------------------------------------------
(*                                   CLAIMS                                  *)

\* worker_hosts: a live worker claims a session for a subagent child, a review
\* sibling (before opening it), or an extension-started move target of a
\* conversation p it hosts; the claim joins p's group.  Refused (no step)
\* when another registered worker hosts it, or p's group is closing.
\* WorkerOpen opens it.
Claim(w, s, p) ==
    /\ Admitting
    /\ Ctl(w)
    /\ wState[w] = "live"
    /\ wGen[w] = gen
    /\ s \notin hosts[w]
    /\ HostOf(s) = {}
    /\ p \in hosts[w]
    /\ grp[p] \notin closeReq[w]
    /\ hosts' = [hosts EXCEPT ![w] = @ \cup {s}]
    /\ grp'   = [grp   EXCEPT ![s] = grp[p]]
    /\ UNCHANGED << daemonVars, wState, wGen, wKey, tops, closeReq, closeForced, procVars, clientVars >>

\* worker_released: a live worker closed a conversation on its own (a
\* finished subagent child, a closed review sibling, a move target its
\* clients left, a top-level conversation that lost its log), which released
\* the log's lock, and the registry drops it.  A top-level conversation goes
\* last in its group (the worker closes its members first).  It closes a
\* conversation only once no relay of it is offered or attached there.  A
\* later open of that session routes again or a claim takes it.  No open of
\* the session waits: the daemon routes an open in the turn it arrives, so
\* the model's separate routing step must not invent a window for a release
\* (as for retention, ~Routing).  An offer minted in the real window between
\* the close and worker_released is one the worker does not take: it expires
\* and the client retries (an ExpireOffer).  A worker left with nothing
\* retires.
Release(w, s) ==
    /\ Ctl(w)
    /\ wState[w] = "live"
    /\ s \in opened[w]
    /\ s \in tops[w] => Group(w, s) = {s}
    /\ \A c \in Clients : want[c] = s => (att[c] # w /\ offer[c] # w /\ ~Waiting(c))
    /\ hosts'       = [hosts       EXCEPT ![w] = @ \ {s}]
    /\ tops'        = [tops        EXCEPT ![w] = @ \ {s}]
    /\ grp'         = [grp         EXCEPT ![s] = NoSession]
    /\ closeReq'    = [closeReq    EXCEPT ![w] = @ \ {s}]
    /\ closeForced' = [closeForced EXCEPT ![w] = @ \ {s}]
    /\ opened'      = [opened      EXCEPT ![w] = @ \ {s}]
    /\ lockOf'      = [lockOf      EXCEPT ![s] = NoWorker]
    /\ busy'        = busy \ {s}
    /\ RetireIfEmpty(w, hosts[w] \ {s})
    /\ UNCHANGED << daemonVars, wGen, wKey, alive, closing, clientVars >>

-----------------------------------------------------------------------------
Next ==
    \/ FenceWorkspace
    \/ WorkspaceRetired
    \/ DaemonCrash
    \/ DaemonRestart
    \/ \E c \in Clients :
         \/ Spawn(c)
         \/ SpawnUnavailable(c)
         \/ MintOffer(c)
         \/ AdmitOffer(c)
         \/ ExpireOffer(c)
         \/ Detach(c)
         \/ Send(c)
         \/ Accept(c)
         \/ DeliverAck(c)
         \/ \E w \in Workers : RouteShared(c, w)
         \/ \E s \in Sessions : Redirect(c, s) \/ \E k \in Keys : RequestOpen(c, s, k)
    \/ \E w \in Workers :
         \/ WorkerReady(w)
         \/ ForceAbort(w)
         \/ StopRefused(w)
         \/ StopAccept(w)
         \/ Dispose(w)
         \/ RetireStale(w)
         \/ Crash(w)
         \/ ObserveExit(w)
         \/ OrphanExit(w)
         \/ \E s \in Sessions :
              \/ WorkerOpen(w, s)
              \/ Release(w, s)
              \/ TurnStart(w, s)
              \/ TurnEnd(w, s)
              \/ ForceAbortClose(w, s)
              \/ CloseDetachedIdle(w, s)
              \/ ForceClose(w, s)
              \/ CloseRefused(w, s)
              \/ CloseAccept(w, s)
              \/ \E p \in Sessions : Claim(w, s, p)

\* Fairness: weak fairness on every daemon and worker step the design promises
\* will happen (routing, spawning, opening, readiness, redemption, the TTL, the
\* answers to worker_close and worker_stop, disposal, exit observation, forced
\* aborts, orphan exit, restart).  Client choices, turns, claims, releases,
\* fences, forced closes, and faults get none: they may or may not happen,
\* and the fault budget ends the forced closes and faults.
Fairness ==
    /\ WF_vars(DaemonRestart)
    /\ WF_vars(WorkspaceRetired)
    /\ \A c \in Clients :
         /\ WF_vars(Spawn(c))
         /\ WF_vars(\E w \in Workers : RouteShared(c, w))
         /\ WF_vars(MintOffer(c))
         /\ WF_vars(AdmitOffer(c))
         /\ WF_vars(SpawnUnavailable(c))
    /\ \A w \in Workers :
         /\ WF_vars(WorkerReady(w))
         /\ \A s \in Sessions :
              /\ WF_vars(WorkerOpen(w, s))
              /\ WF_vars(CloseDetachedIdle(w, s))
              /\ WF_vars(CloseRefused(w, s) \/ CloseAccept(w, s))   \* the worker answers worker_close
              /\ WF_vars(ForceAbortClose(w, s))
         /\ WF_vars(StopRefused(w) \/ StopAccept(w))   \* the worker answers worker_stop
         /\ WF_vars(Dispose(w))
         /\ WF_vars(ForceAbort(w))
         /\ WF_vars(RetireStale(w))
         /\ WF_vars(ObserveExit(w))
         /\ WF_vars(OrphanExit(w))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(*                             SAFETY INVARIANTS                             *)

\* Per session at most one registered worker hosts it, in the current daemon
\* epoch: spawns coalesce, routes take only unhosted sessions, retiring hosts
\* and closing groups are waited for, claims are refused.
OneHost ==
    \A s \in Sessions : Cardinality(HostOf(s)) <= 1

\* Per session at most one live process has its log open: the OS lock, also
\* across daemon epochs (an orphan and its replacement).
OneWriter ==
    \A s \in Sessions : Cardinality({w \in Workers : alive[w] /\ s \in opened[w]}) <= 1

\* A process has a log open exactly while it holds that log's lock.
LockCoherent ==
    \A s \in Sessions, w \in Workers :
        (alive[w] /\ s \in opened[w]) <=> (lockOf[s] = w)

\* A live worker opens only what the registry assigned it, and holds the lock
\* of every log it has open.
ReadyHoldsLocks ==
    \A w \in Workers :
        (wState[w] = "live" /\ alive[w]) =>
            /\ opened[w] \subseteq hosts[w]
            /\ \A s \in opened[w] : lockOf[s] = w

\* A worker in service always hosts something: one left with nothing retires.
RetireWhenEmpty ==
    \A w \in Workers : wState[w] \in {"starting", "live"} => hosts[w] # {}

\* Groups are well formed: every hosted session belongs to the group of a
\* top-level conversation of the same worker; closes name top-level ones.
GroupsWellFormed ==
    \A w \in Workers :
        /\ tops[w] \subseteq hosts[w]
        /\ \A t \in tops[w] : grp[t] = t
        /\ \A s \in hosts[w] : grp[s] \in tops[w]
        /\ closeReq[w] \subseteq tops[w]
        /\ closeForced[w] \subseteq closeReq[w]

\* A worker hosts at most Cap top-level conversations.
CapRespected ==
    \A w \in Workers : Cardinality(tops[w]) <= Cap

\* A client is served only by a live worker that hosts its session and has
\* that log open.
AttachOnlyToLive ==
    \A c \in Clients :
        att[c] # NoWorker =>
            /\ wState[att[c]] = "live"
            /\ alive[att[c]]
            /\ want[c] \in hosts[att[c]]
            /\ want[c] \in opened[att[c]]

\* Relay offers are minted only for live workers and never survive retirement.
NoOfferToRetiring ==
    \A c \in Clients : offer[c] # NoWorker => wState[offer[c]] = "live"

\* Nothing is offered to or attached to a member of a group being closed:
\* retention closes only detached groups, opens wait for the close, and a
\* forced close ends the group's relays first.
CloseOnlyDetached ==
    \A c \in Clients, w \in Workers :
        (att[c] = w \/ offer[c] = w) => grp[want[c]] \notin closeReq[w]

\* No acknowledged input is lost: the ack follows the durable commit.
NoLostInput ==
    \A c \in Clients : acked[c] => logCnt[c] >= 1

\* No input id is committed twice: retries after a lost ack, a crash, or daemon
\* loss are deduplicated by the durable clientMessageId.
ExactlyOnce ==
    \A c \in Clients : logCnt[c] <= 1

\* Retirement closes a worker only when it is detached and idle: a retention
\* stop goes only to a worker with nothing left, nothing attaches to a
\* retiring one, and a worker that accepted a stop starts no turn.
RetireOnlyDetachedIdle ==
    \A w \in Workers :
        /\ (wState[w] = "retiring" /\ ~Forced(w)) => Detached(w)
        /\ closing[w] => (Detached(w) /\ ~Busy(w))

-----------------------------------------------------------------------------
(*                    ACTION PROPERTIES (checked as PROPERTY)                *)

\* Every new attachment redeems the client's pending offer for exactly that
\* worker and consumes it: an offer is admitted at most once.
OfferAdmittedOnce ==
    [][\A c \in Clients :
         (att[c] = NoWorker /\ att'[c] # NoWorker) =>
             (offer[c] = att'[c] /\ offer'[c] = NoWorker)]_vars

\* A worker gains a session only through a spawn, a route, or a claim under
\* the current key, and never one another registered worker hosts.
ClaimRespectsHost ==
    [][\A w \in Workers :
         (hosts'[w] \ hosts[w] # {}) =>
             /\ wGen'[w] = gen'
             /\ \A s \in hosts'[w] \ hosts[w] : HostOf(s) = {}]_vars

\* Compatibility: a top-level conversation enters a worker only for an open
\* whose key is the worker's, and a worker keeps its key while registered.
RouteRespectsKey ==
    [][\A w \in Workers :
         /\ (Registered(w) /\ Registered(w)') => wKey'[w] = wKey[w]
         /\ \A s \in tops'[w] \ tops[w] :
              /\ wKey'[w] # NoKey
              /\ \E c \in Clients : Waiting(c) /\ want[c] = s /\ wantKey[c] = wKey'[w]]_vars

\* Closing one group, or beginning a forced close of it, touches no other
\* group of the worker: their sessions stay hosted and open, their turns run
\* on, and their clients stay attached (the worker's crash, fence, or exit
\* aside, which take every conversation it hosts).
CloseScoped ==
    [][\A w \in Workers, t \in Sessions :
         ((t \in tops[w] /\ t \notin tops'[w] /\ wState'[w] # "exited" /\ alive'[w])
            \/ (t \notin closeReq[w] /\ t \in closeReq'[w])) =>
             /\ \A s \in hosts[w] :
                  grp[s] # t =>
                      /\ s \in hosts'[w]
                      /\ grp'[s] = grp[s]
                      /\ (s \in opened[w] => s \in opened'[w])
                      /\ (s \in busy => s \in busy')
             /\ \A c \in Clients :
                  (att[c] = w /\ grp[want[c]] # t) => att'[c] = w]_vars

\* A fenced generation is inert: no client newly attaches to a fenced worker
\* and no fenced worker commits input (W3, D4).
FencedWorkersInert ==
    [][\A c \in Clients :
         /\ (att[c] = NoWorker /\ att'[c] # NoWorker) => wGen'[att'[c]] = gen'
         /\ (logCnt'[c] > logCnt[c]) => (att[c] # NoWorker /\ wGen[att[c]] = gen)]_vars

\* --- Hold only with RestartWaitsForOrphans = TRUE (the baseline .cfg). ---
\* Without the restart wait a restarted daemon does not know the dead
\* daemon's orphans, so a workspace mutation can report success, and admit the
\* new generation, while an orphan of the fenced generation still finishes its
\* turn (up to 60 s).  WorkerRegistryOrphans.cfg shows the trace.

\* W4: a mutation reports success only when no process of the fenced
\* generation is alive.
RetireReportsAfterExit ==
    [][(wsPending /\ ~wsPending' /\ daemonUp') =>
         \A w \in Workers : alive'[w] => wGen'[w] = gen']_vars

\* W5: two generations never run at once.
NoGenerationOverlap ==
    \A v, w \in Workers : (alive[v] /\ alive[w]) => wGen[v] = wGen[w]

-----------------------------------------------------------------------------
(*                            LIVENESS PROPERTIES                            *)

\* Every open is eventually served (attached) or answered (refused at the
\* bound, or fatal for a fenced relay).
OpenServed ==
    \A c \in Clients : (want[c] # NoSession) ~> (att[c] # NoWorker \/ want[c] = NoSession)

\* A retiring worker exits, unless a retention stop was refused.
RetiringExits ==
    \A w \in Workers :
        (wState[w] = "retiring") ~> (wState[w] = "exited" \/ (wState[w] = "live" /\ ~Forced(w)))

\* A spawn becomes ready or exits.
StartingSettles ==
    \A w \in Workers : (wState[w] = "starting") ~> (wState[w] # "starting")

\* A detached, idle group does not stay that way: it is asked to close
\* unless a client attaches, an open routes to it, or it turns active.
DetachedIdleCloses ==
    \A w \in Workers, t \in Sessions : DetachedIdleGroup(w, t) ~> ~DetachedIdleGroup(w, t)

\* A close the registry asked for is answered: refused or done (or the
\* worker went).
ClosesSettle ==
    \A w \in Workers, t \in Sessions : (t \in closeReq[w]) ~> (t \notin closeReq[w])

\* Orphans of a dead daemon exit.
OrphansExit ==
    \A w \in Workers : Orphan(w) ~> ~alive[w]

\* A fenced workspace mutation completes (or fails with the daemon).
WorkspaceRetireCompletes ==
    wsPending ~> ~wsPending

=============================================================================
