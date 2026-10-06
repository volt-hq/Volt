------------------------------ MODULE WorkerRegistry ------------------------------
(***************************************************************************)
(* In plain terms                                                          *)
(*                                                                         *)
(* Every interactive conversation runs in a conversation WORKER: a process *)
(* the daemon spawns and supervises.  Clients (a TUI or a phone) never own *)
(* a conversation; the daemon relays their stream to the worker that hosts *)
(* it.  Ownership never moves between processes.  A worker is spawned for  *)
(* one conversation and may also host conversations that must share its    *)
(* writer (subagent children, review siblings, extension-started moves):   *)
(* it CLAIMS those from the registry first.                                *)
(*                                                                         *)
(* The daemon's worker registry decides, for each open:                    *)
(*                                                                         *)
(*   live worker hosts it     -> mint a single-use relay offer to it       *)
(*   worker is starting       -> wait for that same spawn (coalesced)      *)
(*   worker is retiring       -> wait for it to exit, then spawn           *)
(*   nobody hosts it          -> spawn a worker                            *)
(*                                                                         *)
(* A worker takes the per-log OS lock before it opens a log, and the lock  *)
(* never waits, so a replacement retries until the previous holder is      *)
(* gone.  A detached, idle worker is retired after a TTL; the worker can   *)
(* refuse the stop if it turned active.  A crashed worker's relays close   *)
(* and its clients reconnect.  If the daemon dies, its workers stop taking *)
(* input, finish their turn, and exit; a restarted daemon starts from an   *)
(* empty registry and admits nothing until those orphans have exited.      *)
(*                                                                         *)
(* The properties: one registered host and one writer per log; clients     *)
(* attach only to live workers that have the log open; relay offers are    *)
(* single-use and only for live workers; no acknowledged input is lost or  *)
(* committed twice across crashes, retirement, and daemon loss; retention  *)
(* closes a worker only when it is detached and idle; a fenced workspace   *)
(* generation is inert; and every open is eventually served.               *)
(*                                                                         *)
(* -------------------------------------------------------------------     *)
(* Source of truth (keep this spec beside it; change the model first):     *)
(*   the Phase 7 plan (#585): section 1 worker model, section 6 this model *)
(*   docs/daemon-hosted-conversations-design.md  4.2, 4.3, 5.1-5.3         *)
(*   docs/workspace-authority-lifecycle-design.md W3-W6                    *)
(*   src/daemon/worker-registry.ts, src/daemon/worker-launcher.ts,         *)
(*     src/daemon/worker/  (Phase 7 slices 4 and 5)                        *)
(*   src/daemon/worker-gate.ts  (the restart wait, RestartWaitsForOrphans) *)
(*   src/daemon/relay-stream.ts  (single-use relay offers, 10 s TTL)       *)
(*   src/core/conversation-log/conversation-lock.ts  (per-log lock)        *)
(*   src/core/host/hosted-conversation.ts  isActive() (the idle check)     *)
(*                                                                         *)
(* Modeling choices (smallest model that checks the plan's properties):    *)
(*  - One workspace.  Of the registry key (workspace, generation,          *)
(*    session) the name part is constant, so a stale generation stands for *)
(*    any authority mismatch (another workspace, replace, unregister).     *)
(*  - The plan's Route is split into its outcomes: Spawn (nobody hosts     *)
(*    it), MintOffer (a live worker hosts it), and waiting (no step while  *)
(*    a worker is starting or retiring).                                   *)
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
(*  - The registry's activity view is exact; a turn that starts after the  *)
(*    registry sent worker_stop stands for the debounced report's lag, and *)
(*    the worker refuses the stop.                                         *)
(*  - Worker ids are never reused.  When every id is spent, an open that   *)
(*    needs a spawn is refused (SpawnUnavailable), a bound artifact.       *)
(*  - Faults (worker crash, offer expiry, daemon crash) share one budget,  *)
(*    MaxFaults, so liveness is checked after the faults stop.  A starting *)
(*    worker that gives up on a held lock after 75 s is a Crash.           *)
(*  - Not modeled: tool policy and conversation_in_use (D9), in-process    *)
(*    hosts holding a lock (D20), --no-session (D15), graceful daemon stop *)
(*    (forced retirement of every worker, as RetireStale does for a        *)
(*    workspace), and the handoff write a redirect makes to its target log *)
(*    (a lock-guarded write that fails the move when the target is held).  *)
(*  - The primary is not tracked: Release never closes a worker's last     *)
(*    open log, which stands for the registry refusing the primary's       *)
(*    release (it closes with the worker).                                 *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Sessions,               \* conversation logs (session ids); e.g. {s1, s2}
    Workers,                \* worker ids in spawn order, never reused; e.g. {w1, w2, w3}
    Clients,                \* client streams (a TUI or a phone); e.g. {c1, c2}
    Senders,                \* clients that send an input id; e.g. {c1}
    NoWorker,               \* sentinel: free lock, no offer, not attached
    NoSession,              \* sentinel: wants nothing, input not sent yet
    MaxFaults,              \* budget of crashes, offer expiries, and daemon crashes
    MaxGen,                 \* bound on the workspace authority generation
    RestartWaitsForOrphans  \* design switch: a restarted daemon admits nothing
                            \* until the dead daemon's workers have exited

ASSUME NoWorker \notin Workers
ASSUME NoSession \notin Sessions
ASSUME Senders \subseteq Clients
ASSUME MaxFaults \in Nat /\ MaxGen \in Nat
ASSUME RestartWaitsForOrphans \in BOOLEAN

WStates == {"unused", "starting", "live", "retiring", "exited"}
Frames  == {"none", "input", "ack"}

VARIABLES
    daemonUp,   \* the daemon process runs
    gen,        \* the workspace's current authority generation
    wsPending,  \* a fenced workspace mutation awaits its workers' exit
    faults,     \* faults spent, 0..MaxFaults
    wState,     \* [Workers -> WStates]                registry view of the worker
    wGen,       \* [Workers -> 0..MaxGen]              generation of the worker's key
    hosts,      \* [Workers -> SUBSET Sessions]        registry assignment (spawn + claims)
    alive,      \* [Workers -> BOOLEAN]                the worker process exists
    opened,     \* [Workers -> SUBSET Sessions]        logs the process has open
    busy,       \* [Workers -> BOOLEAN]                a hosted conversation isActive()
    closing,    \* [Workers -> BOOLEAN]                the worker accepted worker_stop
    lockOf,     \* [Sessions -> Workers \cup {NoWorker}]  the per-log OS lock
    want,       \* [Clients -> Sessions \cup {NoSession}] the conversation the client opens
    offer,      \* [Clients -> Workers \cup {NoWorker}]   unredeemed relay offer
    att,        \* [Clients -> Workers \cup {NoWorker}]   worker serving the relayed stream
    inSess,     \* [Clients -> Sessions \cup {NoSession}] session of the client's input id
    wire,       \* [Clients -> Frames]                 frame in flight on the relay
    acked,      \* [Clients -> BOOLEAN]                the client holds the input's ack
    logCnt      \* [Clients -> 0..2]                   commits of the input id (durable)

daemonVars == << daemonUp, gen, wsPending, faults >>
workerVars == << wState, wGen, hosts, alive, opened, busy, closing, lockOf >>
clientVars == << want, offer, att, inSess, wire, acked, logCnt >>
vars       == << daemonVars, workerVars, clientVars >>

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

\* No relayed stream of any hosted conversation, offered or active.
Detached(w) == \A c \in Clients : att[c] # w /\ offer[c] # w

\* The daemon admits opens, offers, and claims: up, and no workspace mutation
\* in flight (workspace authority RFC W3/W5: the old generation's admission is
\* closed and the new one is not admitted until retirement completes).
Admitting == daemonUp /\ ~wsPending

\* A client waiting for its open to be routed.
Waiting(c) == want[c] # NoSession /\ att[c] = NoWorker /\ offer[c] = NoWorker

\* An open is being routed to the worker.  The daemon routes synchronously (lookup
\* plus offer), so it never retires a worker in the middle of routing to it;
\* the model's separate routing step must not invent that window.
Routing(w) == \E c \in Clients : Waiting(c) /\ want[c] \in hosts[w]

\* A live worker the retention TTL applies to.
DetachedIdle(w) ==
    /\ wState[w] = "live"
    /\ ~Forced(w)
    /\ Detached(w)
    /\ ~Routing(w)
    /\ ~busy[w]

ReleaseLocks(w) == [s \in Sessions |-> IF lockOf[s] = w THEN NoWorker ELSE lockOf[s]]

-----------------------------------------------------------------------------
TypeOK ==
    /\ daemonUp  \in BOOLEAN
    /\ gen       \in 0..MaxGen
    /\ wsPending \in BOOLEAN
    /\ faults    \in 0..MaxFaults
    /\ wState    \in [Workers -> WStates]
    /\ wGen      \in [Workers -> 0..MaxGen]
    /\ hosts     \in [Workers -> SUBSET Sessions]
    /\ alive     \in [Workers -> BOOLEAN]
    /\ opened    \in [Workers -> SUBSET Sessions]
    /\ busy      \in [Workers -> BOOLEAN]
    /\ closing   \in [Workers -> BOOLEAN]
    /\ lockOf    \in [Sessions -> Workers \cup {NoWorker}]
    /\ want      \in [Clients -> Sessions \cup {NoSession}]
    /\ offer     \in [Clients -> Workers \cup {NoWorker}]
    /\ att       \in [Clients -> Workers \cup {NoWorker}]
    /\ inSess    \in [Clients -> Sessions \cup {NoSession}]
    /\ wire      \in [Clients -> Frames]
    /\ acked     \in [Clients -> BOOLEAN]
    /\ logCnt    \in [Clients -> 0..2]

Init ==
    /\ daemonUp  = TRUE
    /\ gen       = 0
    /\ wsPending = FALSE
    /\ faults    = 0
    /\ wState    = [w \in Workers |-> "unused"]
    /\ wGen      = [w \in Workers |-> 0]
    /\ hosts     = [w \in Workers |-> {}]
    /\ alive     = [w \in Workers |-> FALSE]
    /\ opened    = [w \in Workers |-> {}]
    /\ busy      = [w \in Workers |-> FALSE]
    /\ closing   = [w \in Workers |-> FALSE]
    /\ lockOf    = [s \in Sessions |-> NoWorker]
    /\ want      = [c \in Clients |-> NoSession]
    /\ offer     = [c \in Clients |-> NoWorker]
    /\ att       = [c \in Clients |-> NoWorker]
    /\ inSess    = [c \in Clients |-> NoSession]
    /\ wire      = [c \in Clients |-> "none"]
    /\ acked     = [c \in Clients |-> FALSE]
    /\ logCnt    = [c \in Clients |-> 0]

-----------------------------------------------------------------------------
(*                      OPENS, SPAWNS, AND RELAY OFFERS                      *)

\* A client opens a conversation: a TUI conversation_open or a phone
\* handshake, already admitted and resolved to a session id.  A reconnect after
\* a crash keeps want[c] and simply waits to be routed again.
RequestOpen(c, s) ==
    /\ want[c] = NoSession
    /\ want' = [want EXCEPT ![c] = s]
    /\ UNCHANGED << daemonVars, workerVars, offer, att, inSess, wire, acked, logCnt >>

\* Route, nobody hosts s: spawn the next worker id for it.  A starting or
\* retiring host makes HostOf(s) non-empty, so concurrent opens share one spawn
\* and an open during retirement waits for the exit.
Spawn(s) ==
    /\ Admitting
    /\ \E c \in Clients : Waiting(c) /\ want[c] = s
    /\ HostOf(s) = {}
    /\ \E w \in Workers : wState[w] = "unused"
    /\ LET w == CHOOSE v \in Workers : wState[v] = "unused" IN
         /\ wState' = [wState EXCEPT ![w] = "starting"]
         /\ wGen'   = [wGen   EXCEPT ![w] = gen]
         /\ hosts'  = [hosts  EXCEPT ![w] = {s}]
         /\ alive'  = [alive  EXCEPT ![w] = TRUE]
    /\ UNCHANGED << daemonVars, opened, busy, closing, lockOf, clientVars >>

\* Bound artifact: every worker id is spent, so the open fails.
SpawnUnavailable(c) ==
    /\ Admitting
    /\ Waiting(c)
    /\ HostOf(want[c]) = {}
    /\ \A w \in Workers : wState[w] # "unused"
    /\ want' = [want EXCEPT ![c] = NoSession]
    /\ UNCHANGED << daemonVars, workerVars, offer, att, inSess, wire, acked, logCnt >>

\* The worker opens a hosted log: its primary while starting, a claimed one
\* while live.  The lock never waits: the step is enabled only while the lock
\* is free, so a replacement retries until the previous holder released it.
WorkerOpen(w, s) ==
    /\ Ctl(w)
    /\ wState[w] \in {"starting", "live"}
    /\ s \in hosts[w] \ opened[w]
    /\ lockOf[s] = NoWorker
    /\ opened' = [opened EXCEPT ![w] = @ \cup {s}]
    /\ lockOf' = [lockOf EXCEPT ![s] = w]
    /\ UNCHANGED << daemonVars, wState, wGen, hosts, alive, busy, closing, clientVars >>

\* worker_ready after session_start: the primary is open.
WorkerReady(w) ==
    /\ Ctl(w)
    /\ wState[w] = "starting"
    /\ hosts[w] \subseteq opened[w]
    /\ wState' = [wState EXCEPT ![w] = "live"]
    /\ UNCHANGED << daemonVars, wGen, hosts, alive, opened, busy, closing, lockOf, clientVars >>

\* Route, a live worker hosts the key: mint a relay offer to it.  The
\* registry knows only its own view (it cannot see a crash before the exit).
MintOffer(c) ==
    /\ Admitting
    /\ Waiting(c)
    /\ \E w \in HostOf(want[c]) :
         /\ wState[w] = "live"
         /\ wGen[w] = gen
         /\ offer' = [offer EXCEPT ![c] = w]
    /\ UNCHANGED << daemonVars, workerVars, want, att, inSess, wire, acked, logCnt >>

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
    /\ UNCHANGED << daemonVars, workerVars, want, inSess, wire, acked, logCnt >>

\* Fault: the 10 s token TTL elapses unredeemed; the client retries the open.
ExpireOffer(c) ==
    /\ offer[c] # NoWorker
    /\ faults < MaxFaults
    /\ offer'  = [offer EXCEPT ![c] = NoWorker]
    /\ faults' = faults + 1
    /\ UNCHANGED << daemonUp, gen, wsPending, workerVars, want, att, inSess, wire, acked, logCnt >>

-----------------------------------------------------------------------------
(*                             CLIENTS AND INPUT                             *)

\* The client leaves (quit, close the phone tab).  The worker stays.
Detach(c) ==
    /\ att[c] # NoWorker
    /\ att'  = [att  EXCEPT ![c] = NoWorker]
    /\ want' = [want EXCEPT ![c] = NoSession]
    /\ wire' = [wire EXCEPT ![c] = "none"]
    /\ UNCHANGED << daemonVars, workerVars, offer, inSess, acked, logCnt >>

\* A client structural intent (new_session, switch_session, fork, ...) or an
\* extension-started move whose target the worker claimed: the worker sends
\* ended{moved, target} and the client reconnects through the daemon (D1).
\* Frames on a relay are ordered, so earlier frames settle first.  The worker
\* the client left is detached, not disposed.
Redirect(c, s) ==
    /\ att[c] # NoWorker
    /\ Ctl(att[c])
    /\ wGen[att[c]] = gen
    /\ wire[c] = "none"
    /\ s # want[c]
    /\ att'  = [att  EXCEPT ![c] = NoWorker]
    /\ want' = [want EXCEPT ![c] = s]
    /\ UNCHANGED << daemonVars, workerVars, offer, inSess, wire, acked, logCnt >>

\* The client sends (or, after a reconnect, resends) its input id until acked.
Send(c) ==
    /\ c \in Senders
    /\ att[c] # NoWorker
    /\ wire[c] = "none"
    /\ ~acked[c]
    /\ inSess[c] \in {NoSession, want[c]}
    /\ inSess' = [inSess EXCEPT ![c] = want[c]]
    /\ wire'   = [wire   EXCEPT ![c] = "input"]
    /\ UNCHANGED << daemonVars, workerVars, want, offer, att, acked, logCnt >>

\* The worker revalidates authority (worker_authority, D4), commits the input
\* to the durable log unless its clientMessageId is already there, then acks.
Accept(c) ==
    /\ wire[c] = "input"
    /\ att[c] # NoWorker
    /\ Ctl(att[c])
    /\ wGen[att[c]] = gen
    /\ logCnt' = [logCnt EXCEPT ![c] = IF @ = 0 THEN 1 ELSE @]
    /\ wire'   = [wire   EXCEPT ![c] = "ack"]
    /\ UNCHANGED << daemonVars, workerVars, want, offer, att, inSess, acked >>

DeliverAck(c) ==
    /\ wire[c] = "ack"
    /\ att[c] # NoWorker
    /\ acked' = [acked EXCEPT ![c] = TRUE]
    /\ wire'  = [wire  EXCEPT ![c] = "none"]
    /\ UNCHANGED << daemonVars, workerVars, want, offer, att, inSess, logCnt >>

-----------------------------------------------------------------------------
(*                                   TURNS                                   *)

\* A hosted conversation turns active: a prompt, or a job's wake while the
\* worker is detached or has not yet answered worker_stop.  A fenced or
\* closing worker admits nothing.
TurnStart(w) ==
    /\ Ctl(w)
    /\ wState[w] \in {"live", "retiring"}
    /\ ~Forced(w)
    /\ ~closing[w]
    /\ ~busy[w]
    /\ busy' = [busy EXCEPT ![w] = TRUE]
    /\ UNCHANGED << daemonVars, wState, wGen, hosts, alive, opened, closing, lockOf, clientVars >>

TurnEnd(w) ==
    /\ alive[w]
    /\ busy[w]
    /\ busy' = [busy EXCEPT ![w] = FALSE]
    /\ UNCHANGED << daemonVars, wState, wGen, hosts, alive, opened, closing, lockOf, clientVars >>

\* The 60 s waitForIdle cap of a forced retirement aborts the turn.
ForceAbort(w) ==
    /\ alive[w]
    /\ busy[w]
    /\ wState[w] = "retiring"
    /\ Forced(w)
    /\ busy' = [busy EXCEPT ![w] = FALSE]
    /\ UNCHANGED << daemonVars, wState, wGen, hosts, alive, opened, closing, lockOf, clientVars >>

-----------------------------------------------------------------------------
(*                                 RETIREMENT                                *)

\* remote.detachedRuntimeTtlMs fires on a detached, idle worker: the registry
\* enters retiring and sends worker_stop{reason: "retention"}.
RetireDetachedIdle(w) ==
    /\ daemonUp
    /\ DetachedIdle(w)
    /\ wState' = [wState EXCEPT ![w] = "retiring"]
    /\ UNCHANGED << daemonVars, wGen, hosts, alive, opened, busy, closing, lockOf, clientVars >>

\* The worker answers refused_active: it turned active.  Back to live.
StopRefused(w) ==
    /\ Ctl(w)
    /\ wState[w] = "retiring"
    /\ ~Forced(w)
    /\ ~closing[w]
    /\ busy[w]
    /\ wState' = [wState EXCEPT ![w] = "live"]
    /\ UNCHANGED << daemonVars, wGen, hosts, alive, opened, busy, closing, lockOf, clientVars >>

\* The worker answers stopped: it is idle (its own isActive() check), so it
\* stops admitting and closes its conversations (session_shutdown{quit}).
StopAccept(w) ==
    /\ Ctl(w)
    /\ wState[w] = "retiring"
    /\ ~closing[w]
    /\ ~busy[w]
    /\ closing' = [closing EXCEPT ![w] = TRUE]
    /\ UNCHANGED << daemonVars, wState, wGen, hosts, alive, opened, busy, lockOf, clientVars >>

\* The conversations are closed; the process exits and its locks are released.
Dispose(w) ==
    /\ alive[w]
    /\ closing[w]
    /\ alive'   = [alive   EXCEPT ![w] = FALSE]
    /\ opened'  = [opened  EXCEPT ![w] = {}]
    /\ busy'    = [busy    EXCEPT ![w] = FALSE]
    /\ closing' = [closing EXCEPT ![w] = FALSE]
    /\ lockOf'  = ReleaseLocks(w)
    /\ UNCHANGED << daemonVars, wState, wGen, hosts, clientVars >>

\* Workspace replace, unregister, revoke, access tightening, or worktree
\* removal: fence the authority.  Admission closes until the fenced workers
\* have exited (W3, W5).  Its success is reported by WorkspaceRetired.
FenceWorkspace ==
    /\ daemonUp
    /\ ~wsPending
    /\ gen < MaxGen
    /\ gen'       = gen + 1
    /\ wsPending' = TRUE
    /\ UNCHANGED << daemonUp, faults, workerVars, clientVars >>

\* A fenced worker: its relays (offered and active) get fatal{loss} and close,
\* and it is retired without the option to refuse.
RetireStale(w) ==
    /\ daemonUp
    /\ Forced(w)
    /\ wState[w] \in {"starting", "live"}
    /\ LET gone == {c \in Clients : att[c] = w \/ offer[c] = w} IN
         /\ att'   = [c \in Clients |-> IF c \in gone THEN NoWorker ELSE att[c]]
         /\ offer' = [c \in Clients |-> IF c \in gone THEN NoWorker ELSE offer[c]]
         /\ want'  = [c \in Clients |-> IF c \in gone THEN NoSession ELSE want[c]]
         /\ wire'  = [c \in Clients |-> IF c \in gone THEN "none" ELSE wire[c]]
    /\ wState' = [wState EXCEPT ![w] = "retiring"]
    /\ UNCHANGED << daemonVars, wGen, hosts, alive, opened, busy, closing, lockOf,
                    inSess, acked, logCnt >>

\* The mutation reports success once no registered worker of the fenced
\* generation remains (W4), and admission reopens.
WorkspaceRetired ==
    /\ daemonUp
    /\ wsPending
    /\ \A w \in Workers : Registered(w) => ~Forced(w)
    /\ wsPending' = FALSE
    /\ UNCHANGED << daemonUp, gen, faults, workerVars, clientVars >>

-----------------------------------------------------------------------------
(*                          CRASHES AND DAEMON LOSS                          *)

\* Fault: a registered worker dies (or a starting worker gives up on a held
\* lock).  The OS releases its locks and its relays drop.
Crash(w) ==
    /\ alive[w]
    /\ Registered(w)
    /\ faults < MaxFaults
    /\ alive'   = [alive   EXCEPT ![w] = FALSE]
    /\ opened'  = [opened  EXCEPT ![w] = {}]
    /\ busy'    = [busy    EXCEPT ![w] = FALSE]
    /\ closing' = [closing EXCEPT ![w] = FALSE]
    /\ lockOf'  = ReleaseLocks(w)
    /\ att'     = [c \in Clients |-> IF att[c] = w THEN NoWorker ELSE att[c]]
    /\ wire'    = [c \in Clients |-> IF att[c] = w THEN "none" ELSE wire[c]]
    /\ faults'  = faults + 1
    /\ UNCHANGED << daemonUp, gen, wsPending, wState, wGen, hosts,
                    want, offer, inSess, acked, logCnt >>

\* The daemon sees the child exit: the entry becomes exited and its offers
\* close with worker_exited (D19); those clients route again.
ObserveExit(w) ==
    /\ daemonUp
    /\ Registered(w)
    /\ ~alive[w]
    /\ wState' = [wState EXCEPT ![w] = "exited"]
    /\ hosts'  = [hosts  EXCEPT ![w] = {}]
    /\ wGen'   = [wGen   EXCEPT ![w] = 0]   \* canonical once gone
    /\ offer'  = [c \in Clients |-> IF offer[c] = w THEN NoWorker ELSE offer[c]]
    /\ UNCHANGED << daemonVars, alive, opened, busy, closing, lockOf,
                    want, att, inSess, wire, acked, logCnt >>

\* Fault: the daemon dies.  The registry, its relays, and its offers are lost;
\* clients keep their target and reconnect later.  An in-flight workspace
\* mutation fails and rolls back (W6).  Live workers become orphans: no
\* control connection, so they take no input.
DaemonCrash ==
    /\ daemonUp
    /\ faults < MaxFaults
    /\ daemonUp'  = FALSE
    /\ wsPending' = FALSE
    /\ gen'       = IF wsPending THEN gen - 1 ELSE gen
    /\ faults'    = faults + 1
    /\ wState' = [w \in Workers |-> IF Registered(w) THEN "exited" ELSE wState[w]]
    /\ hosts'  = [w \in Workers |-> {}]
    /\ wGen'   = [w \in Workers |-> IF alive[w] THEN wGen[w] ELSE 0]
    /\ att'    = [c \in Clients |-> NoWorker]
    /\ offer'  = [c \in Clients |-> NoWorker]
    /\ wire'   = [c \in Clients |-> "none"]
    /\ UNCHANGED << alive, opened, busy, closing, lockOf, want, inSess, acked, logCnt >>

\* The daemon starts again with an empty registry.  With the restart wait
\* (the implementation: every worker holds a shared lock on the daemon's
\* worker gate, which a starting daemon takes exclusively before it serves) it
\* admits nothing until the orphans have exited.  Without it, spawns retry on
\* locks the orphans hold (WorkerRegistryOrphans.cfg).
DaemonRestart ==
    /\ ~daemonUp
    /\ RestartWaitsForOrphans => \A w \in Workers : ~alive[w]
    /\ daemonUp' = TRUE
    /\ UNCHANGED << gen, wsPending, faults, workerVars, clientVars >>

\* An orphan stops taking input, lets its turn finish (60 s cap), persists,
\* and exits.  Workers never outlive their daemon for longer than that.
OrphanExit(w) ==
    /\ Orphan(w)
    /\ alive'   = [alive   EXCEPT ![w] = FALSE]
    /\ opened'  = [opened  EXCEPT ![w] = {}]
    /\ busy'    = [busy    EXCEPT ![w] = FALSE]
    /\ closing' = [closing EXCEPT ![w] = FALSE]
    /\ lockOf'  = ReleaseLocks(w)
    /\ wGen'    = [wGen    EXCEPT ![w] = 0]
    /\ UNCHANGED << daemonVars, wState, hosts, clientVars >>

-----------------------------------------------------------------------------
(*                                   CLAIMS                                  *)

\* worker_hosts: a live worker claims a session for a subagent child, a review
\* sibling (before opening it), or an extension-started move target.  Refused
\* (no step) when another registered worker hosts it.  WorkerOpen opens it.
Claim(w, s) ==
    /\ Admitting
    /\ Ctl(w)
    /\ wState[w] = "live"
    /\ wGen[w] = gen
    /\ s \notin hosts[w]
    /\ HostOf(s) = {}
    /\ hosts' = [hosts EXCEPT ![w] = @ \cup {s}]
    /\ UNCHANGED << daemonVars, wState, wGen, alive, opened, busy, closing, lockOf, clientVars >>

\* worker_released: a live worker closed a conversation it claimed (a finished
\* subagent child, a closed review sibling, a move target its clients left),
\* which released the log's lock, and the registry drops the claim.  It
\* closes a conversation only once no relay of it is offered or attached
\* there.  A later open of that session spawns a worker or a claim takes it.
\* No open of the session waits: the daemon routes an open in the turn it
\* arrives, so the model's separate routing step must not invent a window
\* for a release (as for retention, ~Routing).  An offer minted in the real
\* window between the close and worker_released is one the worker does not
\* take: it expires and the client retries (an ExpireOffer).
Release(w, s) ==
    /\ Ctl(w)
    /\ wState[w] = "live"
    /\ s \in opened[w]
    /\ opened[w] # {s}
    /\ \A c \in Clients : want[c] = s => (att[c] # w /\ offer[c] # w /\ ~Waiting(c))
    /\ hosts'  = [hosts  EXCEPT ![w] = @ \ {s}]
    /\ opened' = [opened EXCEPT ![w] = @ \ {s}]
    /\ lockOf' = [lockOf EXCEPT ![s] = NoWorker]
    /\ UNCHANGED << daemonVars, wState, wGen, alive, busy, closing, clientVars >>

-----------------------------------------------------------------------------
Next ==
    \/ FenceWorkspace
    \/ WorkspaceRetired
    \/ DaemonCrash
    \/ DaemonRestart
    \/ \E s \in Sessions : Spawn(s)
    \/ \E c \in Clients :
         \/ SpawnUnavailable(c)
         \/ MintOffer(c)
         \/ AdmitOffer(c)
         \/ ExpireOffer(c)
         \/ Detach(c)
         \/ Send(c)
         \/ Accept(c)
         \/ DeliverAck(c)
         \/ \E s \in Sessions : RequestOpen(c, s) \/ Redirect(c, s)
    \/ \E w \in Workers :
         \/ WorkerReady(w)
         \/ TurnStart(w)
         \/ TurnEnd(w)
         \/ ForceAbort(w)
         \/ RetireDetachedIdle(w)
         \/ StopRefused(w)
         \/ StopAccept(w)
         \/ Dispose(w)
         \/ RetireStale(w)
         \/ Crash(w)
         \/ ObserveExit(w)
         \/ OrphanExit(w)
         \/ \E s \in Sessions : WorkerOpen(w, s) \/ Claim(w, s) \/ Release(w, s)

\* Fairness: weak fairness on every daemon and worker step the design promises
\* will happen (routing, spawning, opening, readiness, redemption, the TTL, the
\* answer to worker_stop, disposal, exit observation, forced aborts, orphan
\* exit, restart).  Client choices, turns, claims, releases, fences, and
\* faults get none: they may or may not happen, and the fault budget ends them.
Fairness ==
    /\ WF_vars(DaemonRestart)
    /\ WF_vars(WorkspaceRetired)
    /\ \A s \in Sessions : WF_vars(Spawn(s))
    /\ \A c \in Clients :
         /\ WF_vars(MintOffer(c))
         /\ WF_vars(AdmitOffer(c))
         /\ WF_vars(SpawnUnavailable(c))
    /\ \A w \in Workers :
         /\ WF_vars(WorkerReady(w))
         /\ \A s \in Sessions : WF_vars(WorkerOpen(w, s))
         /\ WF_vars(RetireDetachedIdle(w))
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
\* epoch: spawns coalesce, retiring hosts are waited for, claims are refused.
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

\* A live worker became ready with its primary open, opens only what the
\* registry assigned it, and holds the lock of every log it has open.
ReadyHoldsLocks ==
    \A w \in Workers :
        (wState[w] = "live" /\ alive[w]) =>
            /\ opened[w] # {}
            /\ opened[w] \subseteq hosts[w]
            /\ \A s \in opened[w] : lockOf[s] = w

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

\* No acknowledged input is lost: the ack follows the durable commit.
NoLostInput ==
    \A c \in Clients : acked[c] => logCnt[c] >= 1

\* No input id is committed twice: retries after a lost ack, a crash, or daemon
\* loss are deduplicated by the durable clientMessageId.
ExactlyOnce ==
    \A c \in Clients : logCnt[c] <= 1

\* Retirement closes a worker only when it is detached and idle: a retention
\* stop goes only to a detached worker, nothing attaches to a retiring one, and
\* a worker that accepted a stop starts no turn.
RetireOnlyDetachedIdle ==
    \A w \in Workers :
        /\ (wState[w] = "retiring" /\ ~Forced(w)) => Detached(w)
        /\ closing[w] => (Detached(w) /\ ~busy[w])

-----------------------------------------------------------------------------
(*                    ACTION PROPERTIES (checked as PROPERTY)                *)

\* Every new attachment redeems the client's pending offer for exactly that
\* worker and consumes it: an offer is admitted at most once.
OfferAdmittedOnce ==
    [][\A c \in Clients :
         (att[c] = NoWorker /\ att'[c] # NoWorker) =>
             (offer[c] = att'[c] /\ offer'[c] = NoWorker)]_vars

\* A worker gains a session only through a spawn or claim under the current
\* key, and never one another registered worker hosts.
ClaimRespectsHost ==
    [][\A w \in Workers :
         (hosts'[w] \ hosts[w] # {}) =>
             /\ wGen'[w] = gen'
             /\ \A s \in hosts'[w] \ hosts[w] : HostOf(s) = {}]_vars

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

\* A detached, idle worker does not stay that way: it retires unless a client
\* attaches or it turns active.
DetachedIdleRetires ==
    \A w \in Workers : DetachedIdle(w) ~> ~DetachedIdle(w)

\* Orphans of a dead daemon exit.
OrphansExit ==
    \A w \in Workers : Orphan(w) ~> ~alive[w]

\* A fenced workspace mutation completes (or fails with the daemon).
WorkspaceRetireCompletes ==
    wsPending ~> ~wsPending

=============================================================================
