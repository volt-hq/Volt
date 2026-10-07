/**
 * A conversation worker (Phase 7 plan §1, D11 revised): a process that keeps
 * conversations open without clients, each top-level conversation the
 * daemon sends it (`worker_open`) in a `ConversationHost` of its own in
 * `rpc` extension mode, with the conversations it claims for each
 * (`hosted.ts`). It connects to the daemon with role `worker` and the
 * single-use token of its launch, receives the conversation it was spawned
 * for, opens its stored log (taking its lock), and reports `worker_ready`;
 * the daemon may then route more compatible conversations to it, up to its
 * cap, each answered the same way. A conversation's extensions start when
 * its first client attaches. While it runs it reports which conversations it
 * hosts are active, debounced.
 *
 * A phone's open spawns it with the phone's tool policy; a TUI's with the
 * TUI's environment and its spawn-only options, shared by every
 * conversation it hosts (the daemon routes here only opens with the same
 * compatibility key), and each conversation's session-level options, which
 * it and every conversation it creates are built from
 * (`conversation-factory.ts`); for `--no-session` around an in-memory
 * conversation (D15), in a worker that is never shared. Every hosted
 * conversation's settings and credentials are watched (D12).
 *
 * The daemon relays clients to it: a relay offer names a conversation it
 * hosts and the client's kind, and the worker redeems it and serves the
 * stream: a phone's on the remote profile (`serve-phone.ts`), a TUI's on the
 * local profile (`serve-local.ts`). The phone's daemon-backed intents and
 * queries, its completion pushes, and its authority go to the daemon over
 * the worker's connection, scoped to that relay; a lost authority ends the
 * stream with its fatal code. A client's own structural intents redirect it,
 * the target's log written here and opened wherever it reconnects; the moves
 * an extension command starts for it open here (D1), and so do all of an
 * in-memory conversation's (D15), whose logs exist nowhere else.
 *
 * It closes one group when the daemon asks (`worker_close`): a close that
 * is not forced (retention) is refused when a conversation of the group is
 * active as it arrives; otherwise the group admits no new work, a running
 * turn finishes for at most 60 s on a forced close (at once for lost
 * authority), its clients' streams end, and its conversations close
 * (`session_shutdown{quit}`) and are released, the top-level one last. A
 * top-level conversation that closes on its own (it lost its log) closes its
 * group the same way. Its other groups serve on.
 *
 * It stops when the daemon asks, once it hosts nothing or without the
 * option to refuse: a stop that is not forced is refused when a hosted
 * conversation is active as it arrives; otherwise the worker admits no new
 * work in any conversation, lets a running turn finish for at most 60 s on a
 * forced stop (then aborts it; a stop for lost authority aborts it at once),
 * ends its clients' streams, closes its conversations
 * (`session_shutdown{quit}`), and exits. Losing its daemon connection stops
 * it the same way: a worker never outlives its daemon. A crash takes every
 * conversation it hosts with it; their clients reconnect, and spawn a
 * replacement.
 *
 * For its whole run it holds a share of the daemon's worker gate
 * (`worker-gate.ts`), so a restarted daemon admits nothing until it exited.
 * The log of a conversation it opens may still be locked by a previous
 * holder that is exiting: the open retries for up to 75 s, then fails
 * `conversation_locked`.
 */

import { realpath } from "node:fs/promises";
import { ConversationLockedError } from "../../core/conversation-log/conversation-lock.ts";
import type { ConversationHost } from "../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import { resolveConversationProjectTrust } from "../../core/project-trust.ts";
import type { AuthorityLoss, ProtocolConnection } from "../../core/protocol/server/connection.ts";
import {
	type IrohRemoteHostHandshakeFailureOutcome,
	isIrohRemoteHostHandshakeFailureOutcome,
} from "../../core/remote/iroh/protocol.ts";
import { SessionManager, type SessionReference } from "../../core/session-manager.ts";
import type { WorkerSpawnSpec } from "../control-protocol.ts";
import { createDaemonLogger } from "../log.ts";
import { getDaemonPaths } from "../paths.ts";
import { admitRemoteIntent } from "../remote-intents.ts";
import { type ResolvedSessionTargetWithManager, resolveIrohRemoteSessionTarget } from "../session-target.ts";
import { holdWorkerGate } from "../worker-gate.ts";
import type { WorkerExit, WorkerExitReason, WorkerLaunchRequest } from "../worker-launcher.ts";
import { isPathInside } from "../workspace-directory.ts";
import {
	createIrohRemoteAgentRuntimeWithSessionSelection,
	type IrohRemoteSubagentRuntimeCreatedEvent,
} from "./conversation-factory.ts";
import {
	type WorkerCloseEvent,
	WorkerDaemonClient,
	type WorkerRelayOffer,
	type WorkerStopEvent,
} from "./daemon-client.ts";
import { type WorkerConversation, WorkerConversations } from "./hosted.ts";
import { serveLocalRelay } from "./serve-local.ts";
import { servePhoneRelay } from "./serve-phone.ts";

/** How long a worker waits for the conversation it opens after its hello. */
const SPAWN_SPEC_TIMEOUT_MS = 30_000;
/** How often a worker samples whether its conversations are active. */
const ACTIVITY_SAMPLE_MS = 250;
/** How long a forced stop, or the daemon's loss, lets a running turn finish. */
export const WORKER_TURN_CAP_MS = 60_000;
/** How long a worker retries the lock of a log it opens while another holder has it. */
export const WORKER_LOCK_RETRY_MS = 75_000;
const LOCK_RETRY_FIRST_DELAY_MS = 50;
const LOCK_RETRY_MAX_DELAY_MS = 2_000;

export interface RunWorkerOptions {
	/** How long an open retries a held lock; `WORKER_LOCK_RETRY_MS` by default. */
	readonly lockRetryMs?: number;
	/** Once aborted, the worker stops as on a forced stop: a running turn finishes, for at most 60 s. */
	readonly signal?: AbortSignal;
	/** The worker began to stop. */
	onStopping?(reason: WorkerExitReason): void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The phone-facing outcome an open failure carries, if any. */
function failureOutcome(error: unknown): IrohRemoteHostHandshakeFailureOutcome | undefined {
	const outcome = typeof error === "object" && error !== null ? (error as { outcome?: unknown }).outcome : undefined;
	return isIrohRemoteHostHandshakeFailureOutcome(outcome) ? outcome : undefined;
}

/** Throw unless `cwd` stays inside `root`, both resolved. */
async function assertInsideRoot(root: string, cwd: string): Promise<void> {
	let rootReal: string;
	let cwdReal: string;
	try {
		rootReal = await realpath(root);
		cwdReal = await realpath(cwd);
	} catch {
		throw Object.assign(new Error("session working directory is unavailable"), { outcome: "session_unavailable" });
	}
	if (!isPathInside(rootReal, cwdReal)) {
		throw Object.assign(new Error("stored session working directory is outside the authorized workspace"), {
			outcome: "session_unavailable",
		});
	}
}

/**
 * Open `ref` for writing (in `cwd`, when given, instead of its stored one),
 * retrying while another holder has its lock: a replacement opens once the
 * previous holder exited. Gives up at `retryMs`, or once `signal` aborts,
 * with the lock's error.
 */
async function openRetryingLock(
	ref: SessionReference,
	retryMs: number,
	signal: AbortSignal,
	cwd?: string,
): Promise<SessionManager> {
	const deadline = Date.now() + retryMs;
	let delayMs = LOCK_RETRY_FIRST_DELAY_MS;
	for (;;) {
		try {
			return await SessionManager.open(ref, cwd);
		} catch (error) {
			if (!(error instanceof ConversationLockedError) || signal.aborted || Date.now() + delayMs > deadline) {
				throw error;
			}
		}
		await new Promise<void>((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", wake);
				resolve();
			};
			const timer = setTimeout(wake, delayMs);
			signal.addEventListener("abort", wake, { once: true });
		});
		delayMs = Math.min(delayMs * 2, LOCK_RETRY_MAX_DELAY_MS);
	}
}

/** Open a top-level conversation in a host of its own: a stored log, or for a TUI's `--no-session` one in memory. */
async function openConversation(
	spec: WorkerSpawnSpec,
	agentDir: string,
	client: WorkerDaemonClient,
	lock: { readonly retryMs: number; readonly signal: AbortSignal },
	onSubagentRuntimeCreated: (
		event: IrohRemoteSubagentRuntimeCreatedEvent,
	) => ReturnType<WorkerConversations["registerChild"]>,
): Promise<{ host: ConversationHost; conversation: HostedConversation }> {
	const workspace = { name: spec.workspace.name, path: spec.workspace.path };
	const primary = spec.session;
	const target: ResolvedSessionTargetWithManager<SessionManager> =
		"inMemory" in primary
			? {
					sessionId: primary.sessionId,
					selection: "created",
					workspaceName: workspace.name,
					workspacePath: workspace.path,
					sessionManager: SessionManager.inMemory(spec.cwd, { id: primary.sessionId }),
				}
			: await resolveIrohRemoteSessionTarget({ kind: "session", sessionId: primary.sessionId }, workspace, {
					list: async () => [{ id: primary.sessionId, ref: primary }],
					find: async (sessionId) => (sessionId === primary.sessionId ? primary : undefined),
					// A TUI's stored conversation runs in the directory it opened it in.
					open: (opened) =>
						openRetryingLock(opened, lock.retryMs, lock.signal, spec.origin === "tui" ? spec.cwd : undefined),
					create: () => Promise.reject(new Error("A worker opens a stored conversation")),
				});
	const { runtime } = await createIrohRemoteAgentRuntimeWithSessionSelection({
		agentDir,
		cwd: spec.cwd,
		projectCwd: spec.projectCwd,
		workspaceName: spec.workspace.name,
		...(spec.baseRef === undefined ? {} : { baseRef: spec.baseRef }),
		...(spec.origin === "phone"
			? {
					toolPolicy: spec.toolPolicy,
					projectTrusted: spec.projectTrusted,
					...(spec.profile === undefined ? {} : { profile: spec.profile }),
				}
			: {
					cli: {
						config: spec.config,
						sessionOptions: spec.sessionOptions,
						...(spec.modelScopePatterns === undefined ? {} : { modelScopePatterns: spec.modelScopePatterns }),
					},
					...(spec.config.profile === undefined ? {} : { profile: spec.config.profile }),
				}),
		resolvedSessionTarget: target,
		validateCwd: (cwd) => assertInsideRoot(spec.root, cwd),
		onSubagentRuntimeCreated,
		// Managed checkouts are restored by the daemon over the worker's own connection.
		worktreeDaemon: { restore: (sessionRef, cwd) => client.restoreWorktree(sessionRef, cwd) },
	});
	return runtime;
}

/**
 * Run one conversation worker until it stops, holding its share of the
 * daemon's worker gate throughout. Resolves how it exited; never rejects.
 */
export async function runWorker(request: WorkerLaunchRequest, options: RunWorkerOptions = {}): Promise<WorkerExit> {
	let gate: ReturnType<typeof holdWorkerGate>;
	try {
		gate = holdWorkerGate(request.agentDir);
	} catch (error) {
		return { reason: "failed", error: errorMessage(error) };
	}
	// A daemon holds the gate while it waits for an earlier daemon's workers: this worker's daemon is gone.
	if (!gate) return { reason: "failed", error: "the daemon that spawned this worker is gone" };
	try {
		return await serveWorker(request, options);
	} finally {
		gate.close();
	}
}

/** Admit nothing new in `hosted`, let a running turn finish (at most `capMs` when given, then abort it). */
async function quiesce(hosted: readonly WorkerConversation[], capMs: number | undefined): Promise<void> {
	for (const { conversation } of hosted) {
		try {
			conversation.session.suspendAdmission();
		} catch {
			// A conversation already closing admits nothing.
		}
	}
	if (capMs === undefined) return;
	const idle = Promise.all(hosted.map(({ conversation }) => conversation.waitForIdle())).then(() => true);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const capped = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), capMs);
		timer.unref?.();
	});
	const finished = await Promise.race([idle.catch(() => true), capped]);
	clearTimeout(timer);
	if (!finished) await Promise.allSettled(hosted.map(({ conversation }) => conversation.session.abort()));
}

async function serveWorker(request: WorkerLaunchRequest, options: RunWorkerOptions): Promise<WorkerExit> {
	let conversations: WorkerConversations | undefined;
	/** The top-level conversations being opened, by session: a stop or a close meanwhile waits for them. */
	const opening = new Map<string, Promise<unknown>>();
	/** Aborts the open of a routed conversation (a lock it still retries): a forced close of it cancels it. */
	const openAborts = new Map<string, AbortController>();
	/** The groups being closed, by their top-level conversation. */
	const closingGroups = new Map<string, Promise<void>>();
	let stopping: Promise<WorkerExit> | undefined;
	let shuttingDown = false;
	/** The active conversations last reported; undefined forces the next report. */
	let reportedActive: string | undefined = "";
	let sampler: ReturnType<typeof setInterval> | undefined;
	const exit = Promise.withResolvers<WorkerExit>();
	/** Aborted once the worker stops: an open still retrying a held lock gives up. */
	const halted = new AbortController();
	/** The streams the worker serves, by relay. */
	const served = new Map<string, ProtocolConnection>();
	/** Relays whose client lost its authority, with the fatal code their stream ends with. */
	const losses = new Map<string, AuthorityLoss>();
	const serving = new Set<Promise<void>>();
	const lockRetryMs = options.lockRetryMs ?? WORKER_LOCK_RETRY_MS;

	const active = (): boolean => conversations?.active() ?? false;

	/** End the streams serving the conversations of `hosted`. */
	const endStreams = async (hosted: readonly WorkerConversation[], shutdown: boolean): Promise<void> => {
		const members = new Set(hosted.map(({ conversation }) => conversation));
		await Promise.allSettled(
			[...served.values()]
				.filter((connection) => connection.conversation !== undefined && members.has(connection.conversation))
				.map((connection) => (shutdown ? connection.shutdown() : connection.close())),
		);
	};

	/** Admit nothing new, let a running turn finish (at most `capMs` when given), end the streams, close every conversation, and exit. */
	const stop = (reason: WorkerExitReason, capMs: number | undefined, shutdown = false): Promise<WorkerExit> => {
		shuttingDown ||= shutdown;
		if (!stopping) options.onStopping?.(reason);
		halted.abort();
		stopping ??= (async (): Promise<WorkerExit> => {
			clearInterval(sampler);
			await Promise.allSettled([...opening.values()]);
			conversations?.beginStopping();
			const hosted = conversations?.list() ?? [];
			await quiesce(hosted, capMs);
			// A daemon shutdown tells its clients so (`ended{shutdown}`, `fatal{host_shutdown}`); other stops end their streams.
			await Promise.allSettled(
				[...served.values()].map((connection) => (shuttingDown ? connection.shutdown() : connection.close())),
			);
			await Promise.allSettled([...serving]);
			let error: string | undefined;
			try {
				await conversations?.closeAll();
			} catch (disposeError) {
				error = errorMessage(disposeError);
			}
			await client.close().catch(() => undefined);
			return { reason, ...(error === undefined ? {} : { error }) };
		})();
		void stopping.then(exit.resolve);
		return stopping;
	};

	/** Stop every running turn now. */
	const abortTurns = (hosted: readonly WorkerConversation[]): void => {
		for (const { conversation } of hosted) void conversation.session.abort().catch(() => undefined);
	};

	/**
	 * Close the group of the top-level conversation `top`: it admits nothing
	 * new, a running turn finishes for at most `capMs` (when given), its
	 * clients' streams end, and its conversations close and are released.
	 */
	const closeGroup = (top: string, capMs: number | undefined): Promise<void> => {
		const pending = closingGroups.get(top);
		if (pending) {
			if (capMs === 0) abortTurns(conversations?.group(top) ?? []);
			return pending;
		}
		const task = (async () => {
			const hosted = conversations?.group(top) ?? [];
			await quiesce(hosted, capMs);
			await endStreams(hosted, false);
			await conversations?.closeGroup(top);
		})();
		closingGroups.set(top, task);
		void task.finally(() => closingGroups.delete(top));
		return task;
	};

	const onStop = (event: WorkerStopEvent): void => {
		// Lost authority stops the turns at once: the clients it served may no longer act here.
		const authority = event.force && event.reason === "authority";
		if (stopping) {
			if (authority) abortTurns(conversations?.list() ?? []);
			void client.stopResult(event.stopId, "stopped").catch(() => undefined);
			return;
		}
		// Answered once, from the idle check as the stop arrives.
		if (!event.force && active()) {
			reportedActive = undefined;
			void client.stopResult(event.stopId, "refused_active").catch(() => undefined);
			return;
		}
		void client.stopResult(event.stopId, "stopped").catch(() => undefined);
		void stop("stopped", authority ? 0 : event.force ? WORKER_TURN_CAP_MS : undefined, event.reason === "shutdown");
	};

	const onClose = (event: WorkerCloseEvent): void => {
		void (async () => {
			// A conversation still opening closes once it opened (or failed to); a forced close stops its open.
			if (event.force) openAborts.get(event.sessionId)?.abort();
			await opening.get(event.sessionId)?.catch(() => undefined);
			const hosted = conversations;
			if (stopping || !hosted || hosted.top(event.sessionId) === undefined) {
				// Closed already, or the worker stops: nothing of it serves on.
				await client.closeResult(event.closeId, "closed").catch(() => undefined);
				return;
			}
			// Answered once, from the group's idle check as the close arrives.
			if (!event.force && hosted.group(event.sessionId).some(({ conversation }) => conversation.isActive())) {
				reportedActive = undefined;
				await client.closeResult(event.closeId, "refused_active").catch(() => undefined);
				return;
			}
			await client.closeResult(event.closeId, "closed").catch(() => undefined);
			// Lost authority stops the group's turns at once.
			const capMs = !event.force ? undefined : event.reason === "authority" ? 0 : WORKER_TURN_CAP_MS;
			await closeGroup(event.sessionId, capMs);
		})();
	};

	/** Open a top-level conversation the daemon sent, and report it open or failed. */
	const openTop = (spec: WorkerSpawnSpec): Promise<unknown> => {
		const sessionId = spec.session.sessionId;
		const abort = new AbortController();
		const task = (async () => {
			const hosted = conversations;
			if (stopping || !hosted || !first || opening.has(sessionId) || hosted.get(sessionId) !== undefined) {
				await client.openFailed(sessionId, "The worker cannot open the conversation now").catch(() => undefined);
				return;
			}
			// The daemon routes only compatible opens here: the same workspace and authority, opener, and never
			// an in-memory conversation (its worker is its own).
			if (
				spec.origin !== first.origin ||
				spec.workspace.name !== first.workspace.name ||
				spec.workspace.generation !== first.workspace.generation ||
				"inMemory" in spec.session ||
				"inMemory" in first.session
			) {
				await client
					.openFailed(sessionId, "The conversation does not belong in this worker")
					.catch(() => undefined);
				return;
			}
			let opened: { host: ConversationHost; conversation: HostedConversation };
			try {
				opened = await openConversation(
					spec,
					request.agentDir,
					client,
					{ retryMs: lockRetryMs, signal: AbortSignal.any([halted.signal, abort.signal]) },
					(event) => hosted.registerChild(event),
				);
			} catch (error) {
				if (!stopping) {
					await client.openFailed(sessionId, errorMessage(error), failureOutcome(error)).catch(() => undefined);
				}
				return;
			}
			// A stop that arrived meanwhile closes what opened.
			if (stopping) {
				await opened.host.dispose().catch(() => undefined);
				return;
			}
			hosted.adoptTop(spec, opened.host, opened.conversation);
			await client.ready(sessionId).catch(() => undefined);
		})();
		opening.set(sessionId, task);
		openAborts.set(sessionId, abort);
		void task.finally(() => {
			if (opening.get(sessionId) === task) opening.delete(sessionId);
			if (openAborts.get(sessionId) === abort) openAborts.delete(sessionId);
		});
		return task;
	};

	/** Serve a relay the daemon offered for a client of a conversation this worker hosts. */
	const onRelayOffer = (offer: WorkerRelayOffer): void => {
		// An offer the worker does not take expires; the daemon tells the client to retry.
		const target = conversations?.get(offer.sessionId);
		const spec = target === undefined ? undefined : conversations?.specOf(target.conversation);
		if (stopping || !target || !conversations || !spec) return;
		const hosted = conversations;
		const relayId = offer.relayId;
		const conversation = target.conversation;
		const task = (async () => {
			let relay: Awaited<ReturnType<WorkerDaemonClient["openRelay"]>>;
			try {
				relay = await client.openRelay(offer);
			} catch {
				return;
			}
			const finished = () => served.delete(relayId);
			const onConnection = (connection: ProtocolConnection) => {
				served.set(relayId, connection);
				// A loss pushed before the stream was served ends it now.
				const loss = losses.get(relayId);
				if (loss !== undefined) void connection.close({ code: loss });
			};
			// The daemon names the client's kind in its offer and its preamble alike.
			if (relay.preamble.kind !== offer.clientKind) {
				relay.stream.destroy();
				return;
			}
			if (relay.preamble.kind === "local") {
				await serveLocalRelay({
					host: target.host,
					conversation,
					relay: { preamble: relay.preamble, stream: relay.stream, finished },
					// A TUI's structural intents redirect it; an extension's moves open here, and an in-memory
					// conversation's every move does (D15): its targets exist nowhere else.
					redirect: {
						hostTarget: (moved) => hosted.hostMoved(conversation, moved),
						hostsStoredSessions: true,
						hostsClientMoves: spec.origin === "tui" && "inMemory" in spec.session,
						onRedirected: (sessionId, created) => {
							// A conversation the move created carries the source's change association.
							if (created) void client.moved(conversation.id, sessionId).catch(() => undefined);
						},
					},
					admit: (intent) => admitRemoteIntent(intent, { shuttingDown: stopping !== undefined, subagent: false }),
					reviewDiscussions: hosted.reviewDiscussions(conversation),
					onConnection,
				});
				return;
			}
			await servePhoneRelay({
				host: target.host,
				conversation,
				relay: { preamble: relay.preamble, stream: relay.stream, finished },
				agentDir: request.agentDir,
				daemon: {
					forward: (frame) => client.forward(relayId, frame),
					deliverNotification: (notification) => client.deliverNotification(relayId, notification),
					// The daemon re-reads the relay's authority before each frame acts (D4).
					revalidate: async () => (await client.authority(relayId)) === "current",
				},
				// The phone's own structural intents redirect it; an extension's moves open here (D1).
				redirect: {
					hostTarget: (moved) => hosted.hostMoved(conversation, moved),
					hostsStoredSessions: true,
					onRedirected: (sessionId, created) => {
						void client.lastSession(relayId, sessionId).catch(() => undefined);
						// A conversation the move created carries the source's change association; a stored one keeps its own.
						if (created) void client.moved(conversation.id, sessionId).catch(() => undefined);
					},
				},
				admit: (intent, admitted) =>
					admitRemoteIntent(intent, {
						shuttingDown: stopping !== undefined,
						subagent: admitted.subagentContext !== undefined,
					}),
				authority: () => losses.get(relayId),
				reviewDiscussions: hosted.reviewDiscussions(conversation),
				onConnection,
			});
		})().finally(() => losses.delete(relayId));
		serving.add(task);
		void task.finally(() => serving.delete(task));
	};

	const onRelayAuthority = (relayId: string, loss: AuthorityLoss): void => {
		losses.set(relayId, loss);
		void served.get(relayId)?.close({ code: loss });
	};

	const client = new WorkerDaemonClient({
		socketPath: request.socketPath,
		workerId: request.workerId,
		workerToken: request.workerToken,
		onStop,
		onOpen: (spec) => void openTop(spec),
		onClose,
		onRelayOffer,
		onRelayAuthority,
		// The daemon is gone: workers never outlive it.
		onLost: () => void stop("daemon_lost", WORKER_TURN_CAP_MS),
	});

	try {
		await client.connect();
	} catch (error) {
		await client.close().catch(() => undefined);
		return { reason: "failed", error: errorMessage(error) };
	}
	// The worker's process was asked to exit: it stops as on a forced stop.
	if (options.signal?.aborted) void stop("stopped", WORKER_TURN_CAP_MS);
	options.signal?.addEventListener("abort", () => void stop("stopped", WORKER_TURN_CAP_MS), { once: true });

	/** The conversation the worker was spawned for, once it arrived: every later one must match its workspace and opener. */
	let first: WorkerSpawnSpec | undefined;
	try {
		first = await client.spawnSpec(SPAWN_SPEC_TIMEOUT_MS);
	} catch (error) {
		if (stopping) return exit.promise;
		await client.close().catch(() => undefined);
		return { reason: "failed", error: errorMessage(error) };
	}
	// Every conversation of the worker is of one workspace (the daemon routes only compatible opens here).
	conversations = new WorkerConversations({
		client,
		workspaceName: first.workspace.name,
		log: createDaemonLogger({ logPath: getDaemonPaths(request.agentDir).logPath }).child("compaction"),
		// Settings or credentials another process wrote: the clients on that conversation refetch them.
		onCatalogChanged: (conversation, catalog) => {
			for (const connection of served.values()) {
				if (connection.conversation === conversation) connection.changed(catalog);
			}
		},
		// As the conversation's factory decides it: a TUI's decision for the project its conversation opened in, else the saved one.
		projectTrusted: (cwd, spec) =>
			resolveConversationProjectTrust(
				request.agentDir,
				cwd,
				spec.origin === "tui" && spec.config.trust !== undefined
					? { cwd: spec.cwd, trusted: spec.config.trust }
					: undefined,
			),
	});
	// The first conversation's failure ends the worker: the daemon spawned it for that one.
	const hosted = conversations;
	let failure: unknown;
	const opened = (async () => {
		try {
			const result = await openConversation(
				first,
				request.agentDir,
				client,
				{ retryMs: lockRetryMs, signal: halted.signal },
				(event) => hosted.registerChild(event),
			);
			if (stopping) {
				await result.host.dispose().catch(() => undefined);
				return false;
			}
			hosted.adoptTop(first, result.host, result.conversation);
			return true;
		} catch (error) {
			failure = error;
			return false;
		}
	})();
	opening.set(first.session.sessionId, opened);
	const ready = await opened;
	opening.delete(first.session.sessionId);
	// A stop that arrived while it opened closed it.
	if (stopping) return exit.promise;
	if (!ready) {
		await client
			.openFailed(first.session.sessionId, errorMessage(failure), failureOutcome(failure))
			.catch(() => undefined);
		await client.close().catch(() => undefined);
		return { reason: "failed", error: errorMessage(failure) };
	}
	try {
		await client.ready(first.session.sessionId);
	} catch (error) {
		await stop("failed", undefined);
		return { reason: "failed", error: errorMessage(error) };
	}

	sampler = setInterval(() => {
		if (stopping) return;
		const now = (conversations?.activeIds() ?? []).sort();
		const key = now.join("\n");
		if (key === reportedActive) return;
		reportedActive = key;
		void client.activity(now).catch(() => undefined);
	}, ACTIVITY_SAMPLE_MS);
	sampler.unref?.();

	return exit.promise;
}
