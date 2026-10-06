/**
 * A conversation worker (Phase 7 plan §1): one `ConversationHost` in `rpc`
 * extension mode that keeps its conversations open without clients, hosting
 * the conversation the daemon spawned it for (its primary). It connects to
 * the daemon with role `worker` and the single-use token of its launch,
 * receives that conversation, opens its stored log (taking its lock), and
 * reports `worker_ready`; its conversation's extensions start when its first
 * client attaches. While it runs it reports whether any conversation it hosts
 * is active, debounced.
 *
 * It stops when the daemon asks: a stop that is not forced is refused when a
 * hosted conversation is active as it arrives; otherwise the worker admits
 * no new work in any conversation, lets a running turn finish for at most
 * 60 s on a forced stop (then aborts it), closes its conversations
 * (`session_shutdown{quit}`), and exits. Losing its daemon connection stops
 * it the same way: a worker never outlives its daemon. It also exits once its
 * primary conversation closed on its own (it lost its log).
 */

import { realpath } from "node:fs/promises";
import type { ConversationHost } from "../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import {
	type IrohRemoteHostHandshakeFailureOutcome,
	isIrohRemoteHostHandshakeFailureOutcome,
} from "../../core/remote/iroh/protocol.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { WorkerSpawnSpec } from "../control-protocol.ts";
import { resolveIrohRemoteSessionTarget } from "../session-target.ts";
import type { WorkerExit, WorkerExitReason, WorkerLaunchRequest } from "../worker-launcher.ts";
import { isPathInside } from "../workspace-directory.ts";
import { createIrohRemoteAgentRuntimeWithSessionSelection } from "./conversation-factory.ts";
import { WorkerDaemonClient, type WorkerStopEvent } from "./daemon-client.ts";

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

/** Open the spawn's stored conversation in a host of its own. */
async function openPrimary(
	spec: WorkerSpawnSpec,
	agentDir: string,
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
	});
	return runtime;
}

/**
 * Run one conversation worker until it stops. Resolves how it exited; never
 * rejects.
 */
export async function runWorker(request: WorkerLaunchRequest): Promise<WorkerExit> {
	let host: ConversationHost | undefined;
	/** Settles once the primary opened, or failed to: a stop meanwhile closes what opened. */
	let opening: Promise<unknown> = Promise.resolve();
	let stopping: Promise<WorkerExit> | undefined;
	let reportedActive = false;
	let sampler: ReturnType<typeof setInterval> | undefined;
	const exit = Promise.withResolvers<WorkerExit>();

	const active = (): boolean => host?.list().some((conversation) => conversation.isActive()) ?? false;

	/** Admit nothing new, let a running turn finish (at most `capMs` when given), close every conversation, and exit. */
	const stop = (reason: WorkerExitReason, capMs: number | undefined): Promise<WorkerExit> => {
		stopping ??= (async (): Promise<WorkerExit> => {
			clearInterval(sampler);
			await opening.catch(() => undefined);
			const conversations = host?.list() ?? [];
			for (const conversation of conversations) {
				try {
					conversation.session.suspendAdmission();
				} catch {
					// A conversation already closing admits nothing.
				}
			}
			if (capMs !== undefined) {
				const idle = Promise.all(conversations.map((conversation) => conversation.waitForIdle())).then(() => true);
				let timer: ReturnType<typeof setTimeout> | undefined;
				const capped = new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), capMs);
					timer.unref?.();
				});
				const finished = await Promise.race([idle.catch(() => true), capped]);
				clearTimeout(timer);
				if (!finished) {
					await Promise.allSettled(conversations.map((conversation) => conversation.session.abort()));
				}
			}
			let error: string | undefined;
			try {
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
		void stop("stopped", event.force ? WORKER_TURN_CAP_MS : undefined);
	};

	const client = new WorkerDaemonClient({
		socketPath: request.socketPath,
		workerId: request.workerId,
		workerToken: request.workerToken,
		onStop,
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
		const open = client
			.spawnSpec(SPAWN_SPEC_TIMEOUT_MS)
			.then((spec) => openPrimary(spec, request.agentDir))
			.then((result) => {
				host = result.host;
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
