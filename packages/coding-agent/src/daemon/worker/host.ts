/**
 * A conversation worker (Phase 7 plan §1): one `ConversationHost` in `rpc`
 * extension mode that keeps its conversations open without clients, hosting
 * the conversation the daemon spawned it for (its primary) and those it
 * claims beside it (`hosted.ts`). It connects to the daemon with role
 * `worker` and the single-use token of its launch, receives that
 * conversation, opens its stored log (taking its lock), and reports
 * `worker_ready`; a conversation's extensions start when its first client
 * attaches. While it runs it reports whether any conversation it hosts is
 * active, debounced.
 *
 * The daemon relays clients to it: a phone's relay offer names a
 * conversation it hosts, and the worker redeems it and serves the stream
 * (`serve-phone.ts`). The phone's daemon-backed intents and queries, its
 * completion pushes, and its authority go to the daemon over the worker's
 * connection, scoped to that relay; a lost authority ends the stream with
 * its fatal code. The phone's own structural intents redirect it, the
 * target's log written here and opened wherever it reconnects; the moves an
 * extension command starts for it open here (D1).
 *
 * It stops when the daemon asks: a stop that is not forced is refused when a
 * hosted conversation is active as it arrives; otherwise the worker admits
 * no new work in any conversation, lets a running turn finish for at most
 * 60 s on a forced stop (then aborts it), ends its clients' streams, closes
 * its conversations (`session_shutdown{quit}`), and exits. Losing its daemon
 * connection stops it the same way: a worker never outlives its daemon. It
 * also exits once its primary conversation closed on its own (it lost its
 * log).
 */

import { realpath } from "node:fs/promises";
import type { ConversationHost } from "../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import type { AuthorityLoss, ProtocolConnection } from "../../core/protocol/server/connection.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { WorkerSpawnSpec } from "../control-protocol.ts";
import { createDaemonLogger } from "../log.ts";
import { getDaemonPaths } from "../paths.ts";
import { admitRemoteIntent } from "../remote-intents.ts";
import { resolveIrohRemoteSessionTarget } from "../session-target.ts";
import type { WorkerExit, WorkerExitReason, WorkerLaunchRequest } from "../worker-launcher.ts";
import { isPathInside } from "../workspace-directory.ts";
import {
	createIrohRemoteAgentRuntimeWithSessionSelection,
	type IrohRemoteSubagentRuntimeCreatedEvent,
} from "./conversation-factory.ts";
import { WorkerDaemonClient, type WorkerRelayOffer, type WorkerStopEvent } from "./daemon-client.ts";
import { WorkerConversations } from "./hosted.ts";
import { servePhoneRelay } from "./serve-phone.ts";

/** How long a worker waits for the conversation it opens after its hello. */
const SPAWN_SPEC_TIMEOUT_MS = 30_000;
/** How often a worker samples whether its conversations are active. */
const ACTIVITY_SAMPLE_MS = 250;
/** How long a forced stop, or the daemon's loss, lets a running turn finish. */
export const WORKER_TURN_CAP_MS = 60_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The phone-facing outcome an open failure carries, if any. */
function failureOutcome(error: unknown): string | undefined {
	const outcome = typeof error === "object" && error !== null ? (error as { outcome?: unknown }).outcome : undefined;
	return typeof outcome === "string" ? outcome : undefined;
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

/** Open the spawn's stored conversation in a host of its own. */
async function openPrimary(
	spec: WorkerSpawnSpec,
	agentDir: string,
	onSubagentRuntimeCreated: (
		event: IrohRemoteSubagentRuntimeCreatedEvent,
	) => ReturnType<WorkerConversations["registerChild"]>,
): Promise<{ host: ConversationHost; conversation: HostedConversation }> {
	const ref = spec.session;
	const target = await resolveIrohRemoteSessionTarget(
		{ kind: "session", sessionId: ref.sessionId },
		{ name: spec.workspace.name, path: spec.workspace.path },
		{
			list: async () => [{ id: ref.sessionId, ref }],
			find: async (sessionId) => (sessionId === ref.sessionId ? ref : undefined),
			open: (opened) => SessionManager.open(opened),
			create: () => Promise.reject(new Error("A worker opens a stored conversation")),
		},
	);
	const { runtime } = await createIrohRemoteAgentRuntimeWithSessionSelection({
		agentDir,
		toolPolicy: spec.toolPolicy,
		cwd: spec.cwd,
		projectCwd: spec.projectCwd,
		workspaceName: spec.workspace.name,
		...(spec.baseRef === undefined ? {} : { baseRef: spec.baseRef }),
		...(spec.profile === undefined ? {} : { profile: spec.profile }),
		projectTrusted: spec.projectTrusted,
		resolvedSessionTarget: target,
		validateCwd: (cwd) => assertInsideRoot(spec.root, cwd),
		onSubagentRuntimeCreated,
	});
	return runtime;
}

/**
 * Run one conversation worker until it stops. Resolves how it exited; never
 * rejects.
 */
export async function runWorker(request: WorkerLaunchRequest): Promise<WorkerExit> {
	let host: ConversationHost | undefined;
	let conversations: WorkerConversations | undefined;
	/** Settles once the primary opened, or failed to: a stop meanwhile closes what opened. */
	let opening: Promise<unknown> = Promise.resolve();
	let stopping: Promise<WorkerExit> | undefined;
	let shuttingDown = false;
	let reportedActive = false;
	let sampler: ReturnType<typeof setInterval> | undefined;
	const exit = Promise.withResolvers<WorkerExit>();
	/** The streams the worker serves, by relay. */
	const served = new Map<string, ProtocolConnection>();
	/** Relays whose client lost its authority, with the fatal code their stream ends with. */
	const losses = new Map<string, AuthorityLoss>();
	const serving = new Set<Promise<void>>();

	const active = (): boolean => conversations?.active() ?? false;

	/** Admit nothing new, let a running turn finish (at most `capMs` when given), end the streams, close every conversation, and exit. */
	const stop = (reason: WorkerExitReason, capMs: number | undefined, shutdown = false): Promise<WorkerExit> => {
		shuttingDown ||= shutdown;
		stopping ??= (async (): Promise<WorkerExit> => {
			clearInterval(sampler);
			await opening.catch(() => undefined);
			conversations?.beginStopping();
			const hosted = conversations?.list() ?? [];
			for (const { conversation } of hosted) {
				try {
					conversation.session.suspendAdmission();
				} catch {
					// A conversation already closing admits nothing.
				}
			}
			if (capMs !== undefined) {
				const idle = Promise.all(hosted.map(({ conversation }) => conversation.waitForIdle())).then(() => true);
				let timer: ReturnType<typeof setTimeout> | undefined;
				const capped = new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), capMs);
					timer.unref?.();
				});
				const finished = await Promise.race([idle.catch(() => true), capped]);
				clearTimeout(timer);
				if (!finished) {
					await Promise.allSettled(hosted.map(({ conversation }) => conversation.session.abort()));
				}
			}
			// A daemon shutdown tells its clients so (`ended{shutdown}`, `fatal{host_shutdown}`); other stops end their streams.
			await Promise.allSettled(
				[...served.values()].map((connection) => (shuttingDown ? connection.shutdown() : connection.close())),
			);
			await Promise.allSettled([...serving]);
			let error: string | undefined;
			try {
				await Promise.all(
					hosted
						.filter((entry) => entry.host !== host)
						.map((entry) => entry.host.close(entry.conversation, { reason: "quit" })),
				);
				await host?.dispose();
			} catch (disposeError) {
				error = errorMessage(disposeError);
			}
			await client.close().catch(() => undefined);
			return { reason, ...(error === undefined ? {} : { error }) };
		})();
		void stopping.then(exit.resolve);
		return stopping;
	};

	const onStop = (event: WorkerStopEvent): void => {
		if (stopping) {
			void client.stopResult(event.stopId, "stopped").catch(() => undefined);
			return;
		}
		// Answered once, from the idle check as the stop arrives.
		if (!event.force && active()) {
			reportedActive = true;
			void client.stopResult(event.stopId, "refused_active").catch(() => undefined);
			return;
		}
		void client.stopResult(event.stopId, "stopped").catch(() => undefined);
		void stop("stopped", event.force ? WORKER_TURN_CAP_MS : undefined, event.reason === "shutdown");
	};

	/** Serve a relay the daemon offered for a client of a conversation this worker hosts. */
	const onRelayOffer = (offer: WorkerRelayOffer): void => {
		// An offer the worker does not take expires; the daemon tells the client to retry.
		const target = conversations?.get(offer.sessionId);
		if (stopping || !target || !conversations) return;
		const hosted = conversations;
		const relayId = offer.relayId;
		const task = (async () => {
			let relay: Awaited<ReturnType<WorkerDaemonClient["openRelay"]>>;
			try {
				relay = await client.openRelay(offer);
			} catch {
				return;
			}
			const conversation = target.conversation;
			await servePhoneRelay({
				host: target.host,
				conversation,
				relay: { ...relay, finished: () => served.delete(relayId) },
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
					onRedirected: (sessionId) => {
						void client.lastSession(relayId, sessionId).catch(() => undefined);
						void client.moved(conversation.id, sessionId).catch(() => undefined);
					},
				},
				admit: (intent, admitted) =>
					admitRemoteIntent(intent, {
						shuttingDown: stopping !== undefined,
						draining: false,
						subagent: admitted.subagentContext !== undefined,
					}),
				authority: () => losses.get(relayId),
				reviewDiscussions: hosted.reviewDiscussions(conversation),
				onConnection: (connection) => {
					served.set(relayId, connection);
					// A loss pushed before the stream was served ends it now.
					const loss = losses.get(relayId);
					if (loss !== undefined) void connection.close({ code: loss });
				},
			});
			losses.delete(relayId);
		})();
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
		onRelayOffer,
		onRelayAuthority,
		onAbort: (sessionId) =>
			void conversations
				?.get(sessionId)
				?.conversation.session.abort()
				.catch(() => undefined),
		// The daemon is gone: workers never outlive it.
		onLost: () => void stop("daemon_lost", WORKER_TURN_CAP_MS),
	});

	try {
		await client.connect();
	} catch (error) {
		await client.close().catch(() => undefined);
		return { reason: "failed", error: errorMessage(error) };
	}

	let opened: { host: ConversationHost; conversation: HostedConversation };
	try {
		const open = client.spawnSpec(SPAWN_SPEC_TIMEOUT_MS).then(async (spec) => {
			const hosted = new WorkerConversations({
				client,
				workspaceName: spec.workspace.name,
				log: createDaemonLogger({ logPath: getDaemonPaths(request.agentDir).logPath }).child("compaction"),
			});
			conversations = hosted;
			const result = await openPrimary(spec, request.agentDir, (event) => hosted.registerChild(event));
			host = result.host;
			hosted.adoptPrimary(result.host, result.conversation);
			return result;
		});
		opening = open;
		opened = await open;
	} catch (error) {
		if (stopping) return exit.promise;
		await client.openFailed(errorMessage(error), failureOutcome(error)).catch(() => undefined);
		await client.close().catch(() => undefined);
		return { reason: "failed", error: errorMessage(error) };
	}
	// A stop that arrived while the primary opened closes it.
	if (stopping) return exit.promise;
	const primary = opened.conversation;
	opened.host.onClosed((conversation) => {
		// The primary lost its log and closed: the worker has nothing to serve.
		if (conversation === primary) void stop("closed", undefined);
	});
	try {
		await client.ready([primary.id]);
	} catch (error) {
		await stop("failed", undefined);
		return { reason: "failed", error: errorMessage(error) };
	}

	sampler = setInterval(() => {
		const now = active();
		if (now === reportedActive || stopping) return;
		reportedActive = now;
		void client.activity(now).catch(() => undefined);
	}, ACTIVITY_SAMPLE_MS);
	sampler.unref?.();

	return exit.promise;
}
