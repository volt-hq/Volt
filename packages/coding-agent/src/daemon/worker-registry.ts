/**
 * The daemon's conversation workers (Phase 7 plan §1, D11 revised; the model
 * of record is docs/tla/WorkerRegistry.tla). Every conversation a client
 * opens runs in a worker the daemon spawns and supervises; the daemon hosts
 * none itself.
 *
 * Workers are shared. A worker hosts up to `MAX_WORKER_CONVERSATIONS`
 * top-level conversations, each in a host of its own, under one key
 * (workspace, generation) and one compatibility key (`worker-spawn-options.ts`:
 * the opener's kind, and a phone's tool policy, trust, and profile, or a
 * TUI's environment and spawn-only options). Each top-level conversation
 * heads a group: the conversations the worker claims for it (`worker_hosts`),
 * a subagent's child, a review sibling, the target of a move an extension
 * started, which count toward `MAX_WORKER_HOSTED_SESSIONS`. At most one
 * registered worker hosts a session, whatever its workspace.
 *
 * A worker's states are `starting` (spawned, its first conversation not open
 * yet), `live` (serving), `retiring` (it hosts nothing, or is fenced, or lost
 * its control connection) and `exited` (its process exited; the record is
 * gone). A top-level conversation is `opening`, `open`, or `closing`. An
 * open of a session:
 *
 *   open in a live worker  -> the caller's `attach` runs in the same turn as the lookup
 *   opening (or starting)  -> wait for that same open (concurrent opens share it)
 *   closing, or retiring   -> wait for its release or the worker's exit, then route
 *   nobody hosts it        -> route it into a live worker of the same key and
 *                             compatibility key with room (`worker_open`), else spawn
 *
 * Retention is per group: a group is attached while any relayed stream of
 * one of its conversations is offered or open, else detached. The retention
 * TTL (`detachedRuntimeTtlMs` in the daemon's state settings) runs only while
 * the group is open, detached, and idle (the worker's last `worker_activity`);
 * when it fires, the worker is asked to close the group and may refuse because
 * it turned active. A worker that hosts nothing after a release retires
 * (`worker_stop`).
 * One conversation can be closed without the option to refuse (a revoked
 * client, a removed worktree, a phone's fresh pairing), leaving the worker's
 * other groups serving. A worker a TUI spawned for a conversation without a
 * session file (`--no-session`, D15) is exclusive to that TUI's client key:
 * it is never shared, no other client's open reaches what it hosts, it alone
 * claims conversations in its memory, and its group closes once its last
 * client left for `EXCLUSIVE_WORKER_RETENTION_MS` (its client reconnects
 * within it after a move). A fenced workspace closes admission for that
 * workspace and retires its workers without the option to refuse, until
 * their exit is observed. A worker's exit, however it happens, removes its
 * record and fails the opens that waited for its conversations. A worker
 * opening a TUI's conversation may ask the TUI whose open opens it
 * (`worker_host_request`: its project trust prompts, P7-8b); the wait for
 * that conversation's `worker_ready` pauses while the TUI is asked, and
 * starts over once it answered.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { HostPromptRequest, HostResponse } from "@hansjm10/volt-protocol";
import type { DistributiveOmit } from "./control-client.ts";
import {
	type ControlEvent,
	type ControlRequest,
	type ControlResponse,
	type ControlWorkerOrigin,
	type ControlWorkerStatus,
	createDaemonProof,
	type HelloBinding,
	type HelloMessage,
	helloProofMatches,
	type WorkerHostKind,
	type WorkerSpawnSpec,
	type WorkerStopReason,
} from "./control-protocol.ts";
import type { LaunchedWorker, WorkerExit, WorkerLauncher } from "./worker-launcher.ts";
import { type WorkerCompatibility, workerCompatibilityKey } from "./worker-spawn-options.ts";

/** How long a forced stop may take before the daemon stops waiting for the worker: its 60 s turn cap, and margin. */
export const WORKER_FORCED_STOP_TIMEOUT_MS = 75_000;

/**
 * How long a forced close of one conversation may take before the daemon
 * retires its worker: the 60 s turn cap, the 15 s its head's release waits
 * for the group's pending claims, and margin.
 */
export const WORKER_FORCED_CLOSE_TIMEOUT_MS = 90_000;

/** How long a worker may take to open a conversation (a replacement retries a held lock for 75 s). */
export const WORKER_READY_TIMEOUT_MS = 90_000;

/** The top-level conversations one worker hosts at most (D11 revised). */
export const MAX_WORKER_CONVERSATIONS = 6;

/** The conversations one worker may host at most: its top-level conversations and their claims. */
export const MAX_WORKER_HOSTED_SESSIONS = 256;

/** How long an exclusive (`--no-session`) worker outlives its last client: its client reconnects within it after a move. */
export const EXCLUSIVE_WORKER_RETENTION_MS = 10_000;

export type WorkerState = "starting" | "live" | "retiring";

/** The registry key of an open. */
export interface WorkerOpenKey {
	readonly workspaceName: string;
	readonly workspaceGeneration: number;
	readonly sessionId: string;
}

/** A relayed stream's client: a phone, or a local TUI. */
export type WorkerClientKind = "remote" | "local";

/**
 * How an open reached its conversation: it spawned the worker for it, it
 * routed it into a compatible live worker, or it found it open already.
 */
export type WorkerOpenOutcome = "spawned" | "routed" | "attached";

/** A live worker, as an open's `attach` sees it. */
export interface LiveWorker {
	readonly workerId: string;
	readonly origin: ControlWorkerOrigin;
	readonly workspaceName: string;
	readonly workspaceGeneration: number;
	/** The session the open reached. */
	readonly sessionId: string;
	/** The worker's control connection, where its events go. */
	readonly connectionId: string;
	/**
	 * What the worker was spawned with: its tool policy, or its TUI's
	 * spawn-only options, are fixed for its lifetime (D9) and shared by every
	 * conversation it hosts.
	 */
	readonly spec: WorkerSpawnSpec;
	/** The compatibility key of every open routed into it (see `worker-spawn-options.ts`). */
	readonly compatibilityKey: string;
	/**
	 * Count a relayed stream of the session (an offer, then the stream it was
	 * redeemed for) as attached until the returned release runs: its group is
	 * not detached meanwhile. Release once; later calls do nothing.
	 */
	attach(kind: WorkerClientKind): () => void;
}

/** The conversation an open prepares, as the daemon resolved it; the registry adds the worker id. */
export type WorkerSpawnInput = DistributiveOmit<WorkerSpawnSpec, "workerId">;

/**
 * Ask the TUI whose open opens a conversation, until `signal` aborts: what it
 * answered (no `response` when it closed the question without one), or
 * undefined when it cannot be asked.
 */
export type OpenerAsk = (
	request: HostPromptRequest,
	signal: AbortSignal,
) => Promise<{ readonly response?: HostResponse } | undefined>;

/** An open failed: the worker could not open its conversation, or it exited first. */
export class WorkerOpenError extends Error {
	/** A phone handshake outcome the worker reported, such as conversation_locked. */
	readonly outcome: string | undefined;
	constructor(message: string, outcome?: string) {
		super(message);
		this.name = "WorkerOpenError";
		this.outcome = outcome;
	}
}

export interface WorkerRegistryAuditEvent {
	readonly type:
		| "worker_spawned"
		| "worker_ready"
		| "worker_exited"
		| "worker_hosts"
		| "worker_stop"
		| "worker_open"
		| "worker_close";
	readonly workspace: string;
	readonly success: boolean;
	readonly error?: string;
	readonly details: Record<string, unknown>;
}

export interface WorkerRegistryOptions {
	readonly launcher: WorkerLauncher;
	readonly agentDir: string;
	/** The control socket workers connect to. */
	socketPath(): string;
	/** Send `event` to one control connection; false when it is gone. */
	sendTo(connectionId: string, event: ControlEvent): boolean;
	/** The workspace's current authority generation; undefined once it is unregistered. */
	currentGeneration(workspaceName: string): number | undefined;
	/** The daemon's `detachedRuntimeTtlMs` state setting, read whenever a detached idle group arms its timer. */
	detachedRuntimeTtlMs(): number;
	/**
	 * Whether `sessionId` is a stored session of `workspaceName`, or of the
	 * session directory of the claiming group's top-level conversation (a
	 * TUI's sessions are stored by their working directory): a worker claims
	 * only its own workspace's sessions.
	 */
	sessionInWorkspace(workspaceName: string, sessionId: string, sessionDirectory?: string): Promise<boolean>;
	audit(event: WorkerRegistryAuditEvent): void;
	log?(level: "info" | "warn" | "error", message: string, details?: Record<string, unknown>): void;
}

interface HostedSession {
	/** `conversation`: a top-level conversation, heading its group. */
	readonly kind: "conversation" | WorkerHostKind;
	readonly parentSessionId?: string;
	/** The top-level conversation whose group it is in (itself for one). */
	readonly top: string;
}

interface CloseRequest {
	readonly closeId: string;
	readonly reason: WorkerStopReason;
	readonly force: boolean;
	/** Settles once the conversation was released, or the worker exited. */
	readonly done: PromiseWithResolvers<void>;
}

/** A top-level conversation of a worker, and its group's retention. */
interface TopLevelConversation {
	state: "opening" | "open" | "closing";
	/** Whether the worker reported it open. */
	opened: boolean;
	/** What the worker opened it from, once it was sent. */
	spec: WorkerSpawnSpec | undefined;
	/** Opens of the group's conversations resolving to it that have not attached yet: it is not closed meanwhile. */
	routing: number;
	retention: ReturnType<typeof setTimeout> | undefined;
	close: CloseRequest | undefined;
	readonly ready: PromiseWithResolvers<void>;
	readyTimer: ReturnType<typeof setTimeout> | undefined;
	/** The TUI whose open opens it, which the worker may ask while it does. */
	ask: OpenerAsk | undefined;
	/** The worker's questions to `ask` unanswered: the wait for its readiness pauses meanwhile. */
	asking: number;
	/** Aborts those questions once it is gone. */
	readonly questions: AbortController;
}

interface StopRequest {
	readonly stopId: string;
	readonly reason: WorkerStopReason;
	readonly force: boolean;
}

interface WorkerRecord {
	readonly workerId: string;
	readonly token: Buffer;
	tokenUsed: boolean;
	state: WorkerState;
	readonly origin: ControlWorkerOrigin;
	readonly workspaceName: string;
	readonly workspaceGeneration: number;
	/** The conversation it was spawned for. */
	readonly primarySessionId: string;
	/** Registry assignment: every hosted session, top-level ones and claims, in order. */
	readonly hosts: Map<string, HostedSession>;
	/** Its top-level conversations. */
	readonly conversations: Map<string, TopLevelConversation>;
	/** What it was spawned with (its first conversation's spec). */
	spec: WorkerSpawnSpec | undefined;
	readonly compatibilityKey: string;
	/** The only client key whose opens reach this worker (`--no-session`, D15). */
	readonly exclusiveTo: string | undefined;
	launched: LaunchedWorker | undefined;
	connectionId: string | undefined;
	/** Its key's generation was fenced, or it is being stopped without the option to refuse. */
	forced: boolean;
	/** The hosted conversations the worker last reported active. */
	active: Set<string>;
	readonly attachments: Map<number, { readonly kind: WorkerClientKind; readonly sessionId: string }>;
	stop: StopRequest | undefined;
	openFailure: WorkerOpenError | undefined;
	readonly exited: PromiseWithResolvers<WorkerExit>;
	/** Settles at the worker's next state change (a refused close or stop, a release, its exit); replaced after each. */
	changed: PromiseWithResolvers<void>;
	/** Claims refused once, audited once. */
	readonly refusedClaims: Set<string>;
	readyTimer: ReturnType<typeof setTimeout> | undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function newConversation(): TopLevelConversation {
	const conversation: TopLevelConversation = {
		state: "opening",
		opened: false,
		spec: undefined,
		routing: 0,
		retention: undefined,
		close: undefined,
		ready: Promise.withResolvers<void>(),
		readyTimer: undefined,
		ask: undefined,
		asking: 0,
		questions: new AbortController(),
	};
	void conversation.ready.promise.catch(() => undefined);
	return conversation;
}

let attachmentSequence = 0;

export class WorkerRegistry {
	private readonly options: WorkerRegistryOptions;
	/** Registered workers: starting, live, or retiring. */
	private readonly workers = new Map<string, WorkerRecord>();
	/** Workspaces with a fence in flight: admission closes until its fenced workers exited. */
	private readonly fences = new Map<string, Promise<void>>();
	private readonly exitListeners = new Set<(workerId: string, exit: WorkerExit) => void>();
	private readonly retireListeners = new Set<
		(workerId: string, reason: WorkerStopReason, sessionIds: readonly string[]) => void
	>();
	private readonly hostsListeners = new Set<(workspaceName: string, sessionId: string, hosted: boolean) => void>();
	private closed = false;

	constructor(options: WorkerRegistryOptions) {
		this.options = options;
	}

	// ==========================================================================
	// Opens
	// ==========================================================================

	/**
	 * Open `key` for a client: resolves with what `attach` returned, which runs
	 * synchronously with the lookup of the live worker hosting the session, so
	 * no retention can fire between them. With no host, the open routes into a
	 * live worker of the same key whose compatibility key is the open's
	 * (`compatibility` in `env`) and that has room, else spawns one; `prepare`
	 * builds the conversation either way, once. Concurrent opens of the session
	 * share that open and fail with it. A closing group or a retiring host is
	 * waited for until it was released or exited. An open of a fenced
	 * generation, a session another workspace's worker hosts, a session an
	 * exclusive worker of another client hosts, or a closed registry is
	 * refused. `attach` hears how this open reached the conversation.
	 */
	async open<T>(
		key: WorkerOpenKey,
		options: {
			/** What the worker this open spawns runs every conversation with; also who opens (its `origin`). */
			readonly compatibility: WorkerCompatibility;
			readonly prepare: () => Promise<WorkerSpawnInput>;
			readonly attach: (worker: LiveWorker, outcome: WorkerOpenOutcome) => T;
			readonly signal?: AbortSignal;
			/** The opening client's key (a TUI's); phones have none. */
			readonly client?: string;
			/** A worker this open spawns admits no other client's open, and is never shared (`--no-session`, D15). */
			readonly exclusive?: boolean;
			/** The environment a worker this open spawns runs with (a TUI's); the daemon's own without one. */
			readonly env?: Readonly<Record<string, string>>;
			/** The opening TUI, which the worker opening the conversation may ask while this open opens it. */
			readonly ask?: OpenerAsk;
		},
	): Promise<T> {
		const origin = options.compatibility.origin;
		if (options.exclusive === true && options.client === undefined) {
			throw new WorkerOpenError("An exclusive worker needs its client's key", "invalid_conversation_target");
		}
		const compatibilityKey = workerCompatibilityKey(options.compatibility, options.env);
		let prepared: Promise<WorkerSpawnInput> | undefined;
		// A conversation is prepared once (a new one's log is created then), whichever worker opens it.
		const prepare = (): Promise<WorkerSpawnInput> => {
			prepared ??= options.prepare();
			return prepared;
		};
		let reserved: { readonly record: WorkerRecord; readonly outcome: "spawned" | "routed" } | undefined;
		for (;;) {
			options.signal?.throwIfAborted();
			if (this.closed) throw new WorkerOpenError("The daemon is shutting down");
			const fence = this.fences.get(key.workspaceName);
			if (fence) {
				await fence;
				continue;
			}
			if (this.options.currentGeneration(key.workspaceName) !== key.workspaceGeneration) {
				throw new WorkerOpenError("Workspace authority changed; reconnect", "workspace_authorization_removed");
			}
			const host = this.hostOf(key.sessionId);
			if (!host) {
				const shared = options.exclusive === true ? undefined : this.routable(key, compatibilityKey);
				const record =
					shared ??
					this.reserve(key, origin, compatibilityKey, options.exclusive === true ? options.client : undefined);
				const conversation = shared
					? this.reserveConversation(shared, key.sessionId)
					: record.conversations.get(key.sessionId);
				if (!conversation) throw new Error("A reserved worker has no conversation");
				conversation.ask = options.ask;
				reserved = { record, outcome: shared ? "routed" : "spawned" };
				conversation.routing++;
				try {
					if (shared) await this.openIn(shared, key.sessionId, conversation, prepare, options.env);
					else await this.launch(record, prepare, options.env);
				} finally {
					conversation.routing--;
					// Armed for a later turn; the attach below, in this turn, cancels it again.
					this.updateRetention(record);
				}
				continue;
			}
			if (host.workspaceName !== key.workspaceName) {
				throw new WorkerOpenError("The conversation is open in another workspace", "session_unavailable");
			}
			if (host.exclusiveTo !== undefined && host.exclusiveTo !== options.client) {
				throw new WorkerOpenError(
					"The conversation is open in a terminal without a session file; only that terminal reaches it",
					"conversation_in_use",
				);
			}
			const top = host.hosts.get(key.sessionId)?.top;
			const conversation = top === undefined ? undefined : host.conversations.get(top);
			const current = host.workspaceGeneration === key.workspaceGeneration;
			if (host.state === "live" && !host.forced && current && conversation?.state === "open") {
				try {
					return options.attach(
						this.liveView(host, key.sessionId),
						reserved?.record === host && top === key.sessionId ? reserved.outcome : "attached",
					);
				} finally {
					this.updateRetention(host);
				}
			}
			// Opening (or its worker starting): wait for that same open. Closing, retiring, or of a fenced
			// generation: route again once it was released or exited, unless a refused close or stop
			// leaves it serving. Either way the waiting open keeps its group from being closed meanwhile.
			const opening = current && !host.forced && host.state !== "retiring" && conversation?.state === "opening";
			if (conversation) conversation.routing++;
			try {
				await this.waitFor(opening ? conversation.ready.promise : host.changed.promise, options.signal);
			} finally {
				if (conversation) conversation.routing--;
				this.updateRetention(host);
			}
		}
	}

	/** Wait for `until`, or until `signal` aborts. */
	private async waitFor(until: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
		if (!signal) {
			await until;
			return;
		}
		signal.throwIfAborted();
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([until, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	/** Wake the opens waiting on `record`'s state. */
	private notifyChanged(record: WorkerRecord): void {
		const changed = record.changed;
		record.changed = Promise.withResolvers<void>();
		changed.resolve();
	}

	/**
	 * A live worker an open of an unhosted session in `key` can be routed
	 * into: connected, unfenced, not exclusive, of the same workspace and
	 * generation and compatibility key, with room for another top-level
	 * conversation. The oldest such worker fills first.
	 */
	private routable(key: WorkerOpenKey, compatibilityKey: string): WorkerRecord | undefined {
		for (const record of this.workers.values()) {
			if (
				record.state === "live" &&
				!record.forced &&
				record.connectionId !== undefined &&
				record.exclusiveTo === undefined &&
				record.workspaceName === key.workspaceName &&
				record.workspaceGeneration === key.workspaceGeneration &&
				record.compatibilityKey === compatibilityKey &&
				record.conversations.size < MAX_WORKER_CONVERSATIONS &&
				record.hosts.size < MAX_WORKER_HOSTED_SESSIONS
			) {
				return record;
			}
		}
		return undefined;
	}

	/** Register a starting worker for `key` synchronously, so concurrent opens of the session wait for it. */
	private reserve(
		key: WorkerOpenKey,
		origin: ControlWorkerOrigin,
		compatibilityKey: string,
		exclusiveTo: string | undefined,
	): WorkerRecord {
		const record: WorkerRecord = {
			workerId: `w-${randomUUID()}`,
			token: randomBytes(32),
			tokenUsed: false,
			state: "starting",
			origin,
			workspaceName: key.workspaceName,
			workspaceGeneration: key.workspaceGeneration,
			primarySessionId: key.sessionId,
			hosts: new Map([[key.sessionId, { kind: "conversation", top: key.sessionId }]]),
			conversations: new Map([[key.sessionId, newConversation()]]),
			spec: undefined,
			compatibilityKey,
			exclusiveTo,
			launched: undefined,
			connectionId: undefined,
			forced: false,
			active: new Set(),
			attachments: new Map(),
			stop: undefined,
			openFailure: undefined,
			exited: Promise.withResolvers<WorkerExit>(),
			changed: Promise.withResolvers<void>(),
			refusedClaims: new Set(),
			readyTimer: undefined,
		};
		this.workers.set(record.workerId, record);
		this.hostsChanged(record.workspaceName, key.sessionId, true);
		return record;
	}

	/** Register `sessionId` as a top-level conversation `record` opens, synchronously, so concurrent opens wait for it. */
	private reserveConversation(record: WorkerRecord, sessionId: string): TopLevelConversation {
		const conversation = newConversation();
		record.conversations.set(sessionId, conversation);
		record.hosts.set(sessionId, { kind: "conversation", top: sessionId });
		this.hostsChanged(record.workspaceName, sessionId, true);
		return conversation;
	}

	private hostsChanged(workspaceName: string, sessionId: string, hosted: boolean): void {
		for (const listener of [...this.hostsListeners]) listener(workspaceName, sessionId, hosted);
	}

	/** Why `input` cannot be the conversation `record` opens as `sessionId` (in `env`); undefined when it can be. */
	private mismatch(
		record: WorkerRecord,
		sessionId: string,
		input: WorkerSpawnInput,
		env: Readonly<Record<string, string>> | undefined,
	): string | undefined {
		if (input.session.sessionId !== sessionId) {
			return "The prepared conversation is not the one the open was registered for";
		}
		// Only a TUI's open runs with an environment of its own, and an in-memory conversation only in its exclusive worker.
		if (
			input.origin !== record.origin ||
			(env !== undefined && input.origin !== "tui") ||
			"inMemory" in input.session !== (record.exclusiveTo !== undefined)
		) {
			return "The prepared conversation does not match the open's client";
		}
		if (input.workspace.name !== record.workspaceName || input.workspace.generation !== record.workspaceGeneration) {
			return "The prepared conversation's workspace authority changed";
		}
		if (workerCompatibilityKey(input, env) !== record.compatibilityKey) {
			return "The prepared conversation does not match the open's compatibility";
		}
		return undefined;
	}

	/** Build the spawn and start the worker; resolves once its first conversation is open, rejects with its failure. */
	private async launch(
		record: WorkerRecord,
		prepare: () => Promise<WorkerSpawnInput>,
		env: Readonly<Record<string, string>> | undefined,
	): Promise<void> {
		const conversation = record.conversations.get(record.primarySessionId);
		if (!conversation) throw new Error("A starting worker has no conversation");
		let input: WorkerSpawnInput;
		try {
			input = await prepare();
			const mismatch = this.mismatch(record, record.primarySessionId, input, env);
			if (mismatch !== undefined) throw new Error(mismatch);
		} catch (error) {
			this.finish(record, { reason: "failed", error: errorMessage(error) }, error);
			throw error;
		}
		if (record.state !== "starting" || record.forced || this.closed) {
			const error = new WorkerOpenError("Workspace authority changed; reconnect", "workspace_authorization_removed");
			this.finish(record, { reason: "failed", error: error.message }, error);
			throw error;
		}
		record.spec = { ...input, workerId: record.workerId };
		conversation.spec = record.spec;
		this.options.audit({
			type: "worker_spawned",
			workspace: record.workspaceName,
			success: true,
			details: {
				workerId: record.workerId,
				origin: record.origin,
				sessionId: record.primarySessionId,
				workspaceGeneration: record.workspaceGeneration,
			},
		});
		let launched: LaunchedWorker;
		try {
			launched = this.options.launcher.launch({
				workerId: record.workerId,
				workerToken: record.token.toString("base64url"),
				socketPath: this.options.socketPath(),
				agentDir: this.options.agentDir,
				// The workspace, not the first conversation's directory: the process outlives that conversation,
				// and its directory (a managed worktree) may be removed while others still run here.
				cwd: input.workspace.path,
				...(env === undefined ? {} : { env }),
			});
		} catch (error) {
			this.finish(record, { reason: "failed", error: errorMessage(error) }, error);
			throw error;
		}
		record.launched = launched;
		this.options.log?.("info", "worker started", {
			workerId: record.workerId,
			pid: launched.pid,
			...(launched.logPath === undefined ? {} : { logPath: launched.logPath }),
		});
		this.armSpawnReady(record);
		void launched.exited.then(
			(exit) => this.finish(record, exit),
			(error: unknown) => this.finish(record, { reason: "crashed", error: errorMessage(error) }),
		);
		await conversation.ready.promise;
	}

	/**
	 * Prepare the conversation routed into the live worker `record` and have
	 * the worker open it (`worker_open`); resolves once it is open there,
	 * rejects with its failure. A worker that does not report it within
	 * `WORKER_READY_TIMEOUT_MS` is asked to close it without the option to
	 * refuse, and the open fails.
	 */
	private async openIn(
		record: WorkerRecord,
		sessionId: string,
		conversation: TopLevelConversation,
		prepare: () => Promise<WorkerSpawnInput>,
		env: Readonly<Record<string, string>> | undefined,
	): Promise<void> {
		let input: WorkerSpawnInput;
		try {
			input = await prepare();
			const mismatch = this.mismatch(record, sessionId, input, env);
			if (mismatch !== undefined) throw new Error(mismatch);
		} catch (error) {
			this.dropConversation(record, sessionId, conversation, error);
			throw error;
		}
		const connectionId = record.connectionId;
		if (
			this.workers.get(record.workerId) !== record ||
			record.state !== "live" ||
			record.forced ||
			this.closed ||
			connectionId === undefined ||
			record.conversations.get(sessionId) !== conversation ||
			conversation.state !== "opening"
		) {
			const error = new WorkerOpenError("The worker stopped serving; retry", "duplicate_conversation_connection");
			this.dropConversation(record, sessionId, conversation, error);
			throw error;
		}
		const spec: WorkerSpawnSpec = { ...input, workerId: record.workerId };
		conversation.spec = spec;
		this.options.audit({
			type: "worker_open",
			workspace: record.workspaceName,
			success: true,
			details: {
				workerId: record.workerId,
				origin: record.origin,
				sessionId,
				workspaceGeneration: record.workspaceGeneration,
				conversations: record.conversations.size,
			},
		});
		if (!this.options.sendTo(connectionId, { type: "worker_open", spec })) {
			const error = new WorkerOpenError(
				"The worker's connection closed; retry",
				"duplicate_conversation_connection",
			);
			this.dropConversation(record, sessionId, conversation, error);
			throw error;
		}
		this.armOpenReady(record, sessionId, conversation);
		await conversation.ready.promise;
	}

	/** A worker that never reports ready (a lock it cannot take) is retired. */
	private armSpawnReady(record: WorkerRecord): void {
		clearTimeout(record.readyTimer);
		record.readyTimer = setTimeout(() => {
			if (record.state === "starting") void this.retire(record, "authority");
		}, WORKER_READY_TIMEOUT_MS);
		record.readyTimer.unref?.();
	}

	/** A routed conversation the worker does not report open is closed without the option to refuse, and its opens fail. */
	private armOpenReady(record: WorkerRecord, sessionId: string, conversation: TopLevelConversation): void {
		clearTimeout(conversation.readyTimer);
		conversation.readyTimer = setTimeout(() => {
			if (record.conversations.get(sessionId) !== conversation || conversation.opened) return;
			conversation.ready.reject(new WorkerOpenError("The worker did not open the conversation"));
			void this.closeTop(record, sessionId, conversation, "authority");
		}, WORKER_READY_TIMEOUT_MS);
		conversation.readyTimer.unref?.();
	}

	/**
	 * `worker_host_request`: the worker opening the TUI conversation
	 * `sessionId` asks the TUI whose open opens it. Its wait for readiness
	 * pauses until the TUI answered, then starts over. Undefined when nobody
	 * can be asked: no TUI's open opens it, or that TUI left.
	 */
	private async askOpener(
		record: WorkerRecord,
		sessionId: string,
		request: HostPromptRequest,
	): Promise<{ readonly response?: HostResponse } | undefined> {
		const conversation = record.conversations.get(sessionId);
		const ask = conversation?.ask;
		if (
			conversation === undefined ||
			ask === undefined ||
			conversation.opened ||
			conversation.state !== "opening" ||
			record.hosts.get(sessionId)?.kind !== "conversation" ||
			conversation.questions.signal.aborted
		) {
			return undefined;
		}
		const spawning = record.state === "starting" && sessionId === record.primarySessionId;
		conversation.asking++;
		clearTimeout(spawning ? record.readyTimer : conversation.readyTimer);
		try {
			return await ask(request, conversation.questions.signal);
		} finally {
			conversation.asking--;
			if (
				conversation.asking === 0 &&
				!conversation.opened &&
				record.conversations.get(sessionId) === conversation
			) {
				if (spawning) {
					if (record.state === "starting") this.armSpawnReady(record);
				} else {
					this.armOpenReady(record, sessionId, conversation);
				}
			}
		}
	}

	/**
	 * Unregister a top-level conversation the worker does not hold (its open
	 * failed, or never reached the worker): the opens that waited for it fail
	 * with `error`, and a worker left with nothing retires.
	 */
	private dropConversation(
		record: WorkerRecord,
		sessionId: string,
		conversation: TopLevelConversation,
		error: unknown,
	): void {
		if (record.conversations.get(sessionId) !== conversation) return;
		this.removeConversation(record, sessionId, conversation);
		conversation.ready.reject(error instanceof Error ? error : new WorkerOpenError(errorMessage(error)));
		this.notifyChanged(record);
		this.retireIfEmpty(record);
	}

	/** Forget a top-level conversation: its timers stop, its questions to its TUI end, and its close settles. */
	private removeConversation(record: WorkerRecord, sessionId: string, conversation: TopLevelConversation): void {
		clearTimeout(conversation.retention);
		clearTimeout(conversation.readyTimer);
		conversation.questions.abort();
		conversation.retention = undefined;
		record.conversations.delete(sessionId);
		record.hosts.delete(sessionId);
		record.active.delete(sessionId);
		conversation.close?.done.resolve();
		this.hostsChanged(record.workspaceName, sessionId, false);
	}

	/** The registered worker hosting `sessionId`, in any workspace. */
	private hostOf(sessionId: string): WorkerRecord | undefined {
		for (const record of this.workers.values()) {
			if (record.hosts.has(sessionId)) return record;
		}
		return undefined;
	}

	/** The top-level conversation heading `sessionId`'s group in `record`. */
	private topOf(
		record: WorkerRecord,
		sessionId: string,
	): { readonly id: string; readonly conversation: TopLevelConversation } | undefined {
		const top = record.hosts.get(sessionId)?.top;
		const conversation = top === undefined ? undefined : record.conversations.get(top);
		return top === undefined || conversation === undefined ? undefined : { id: top, conversation };
	}

	/** The sessions of `record` in the group of the top-level conversation `top`. */
	private groupOf(record: WorkerRecord, top: string): string[] {
		return [...record.hosts].filter(([, hosted]) => hosted.top === top).map(([sessionId]) => sessionId);
	}

	private liveView(record: WorkerRecord, sessionId: string): LiveWorker {
		const spec = record.spec;
		const connectionId = record.connectionId;
		if (!spec || connectionId === undefined) throw new Error("A live worker has no spawn or connection");
		return {
			workerId: record.workerId,
			origin: record.origin,
			workspaceName: record.workspaceName,
			workspaceGeneration: record.workspaceGeneration,
			sessionId,
			connectionId,
			spec,
			compatibilityKey: record.compatibilityKey,
			attach: (kind) => {
				// Offers go only to a live worker, and never to a closing group (the model's
				// NoOfferToRetiring and CloseOnlyDetached).
				if (
					this.workers.get(record.workerId) !== record ||
					record.state !== "live" ||
					record.forced ||
					this.topOf(record, sessionId)?.conversation.state !== "open"
				) {
					throw new WorkerOpenError(
						"The conversation's worker is closing it; retry",
						"duplicate_conversation_connection",
					);
				}
				const id = ++attachmentSequence;
				record.attachments.set(id, { kind, sessionId });
				this.updateRetention(record);
				return () => {
					if (!record.attachments.delete(id)) return;
					this.updateRetention(record);
				};
			},
		};
	}

	// ==========================================================================
	// The worker control role
	// ==========================================================================

	/**
	 * Admit a worker hello: the worker must be starting, proving the unused
	 * token its spawn issued (which never crosses the socket) on this
	 * connection (`binding`), a connection of its own. The token is spent
	 * here; the conversation the worker opens first follows the ack. Returns
	 * the daemon's proof of the token for the ack, or undefined when the hello
	 * is refused.
	 */
	admitWorker(
		hello: Extract<HelloMessage, { role: "worker" }>,
		binding: HelloBinding,
		connectionId: string,
	): string | undefined {
		const record = this.workers.get(hello.workerId);
		if (!record || record.state !== "starting" || record.tokenUsed || record.connectionId !== undefined) {
			return undefined;
		}
		const token = record.token.toString("base64url");
		if (!helloProofMatches("worker", token, binding, hello.workerProof)) return undefined;
		const spec = record.spec;
		if (!spec) return undefined;
		record.tokenUsed = true;
		record.connectionId = connectionId;
		// After the ack the control server writes once this returns.
		queueMicrotask(() => {
			if (record.connectionId === connectionId) this.options.sendTo(connectionId, { type: "worker_open", spec });
		});
		return createDaemonProof("worker", token, binding, hello.workerProof);
	}

	/** The worker a control connection speaks for, while it is registered. */
	workerOf(connectionId: string): string | undefined {
		for (const record of this.workers.values()) {
			if (record.connectionId === connectionId) return record.workerId;
		}
		return undefined;
	}

	/**
	 * Answer one request of a worker connection. Every request acts only on
	 * the worker the connection was admitted for.
	 */
	async handleWorkerRequest(
		connectionId: string,
		request: Extract<
			ControlRequest,
			{
				type:
					| "worker_host_request"
					| "worker_ready"
					| "worker_open_failed"
					| "worker_activity"
					| "worker_hosts"
					| "worker_released"
					| "worker_stop_result"
					| "worker_close_result";
			}
		>,
	): Promise<ControlResponse> {
		const ok: ControlResponse = { type: "ok", id: request.id };
		const refuse = (code: string, message: string): ControlResponse => ({
			type: "error",
			id: request.id,
			code,
			message,
		});
		const record = [...this.workers.values()].find((candidate) => candidate.connectionId === connectionId);
		if (!record) return refuse("not_registered", "the worker is not registered");
		switch (request.type) {
			case "worker_host_request": {
				const answer = await this.askOpener(record, request.sessionId, request.request);
				if (answer === undefined)
					return refuse("unavailable", "no terminal waiting for that conversation can be asked");
				return {
					type: "worker_host_response",
					id: request.id,
					...(answer.response === undefined ? {} : { response: answer.response }),
				};
			}
			case "worker_ready": {
				const conversation = record.conversations.get(request.sessionId);
				if (record.state === "starting") {
					if (request.sessionId !== record.primarySessionId || !conversation) {
						return refuse("invalid_sessions", "the worker reported a conversation it was not spawned for");
					}
					record.state = "live";
					clearTimeout(record.readyTimer);
					this.options.audit({
						type: "worker_ready",
						workspace: record.workspaceName,
						success: true,
						details: { workerId: record.workerId, sessionId: record.primarySessionId },
					});
				} else if (
					!conversation ||
					conversation.opened ||
					record.hosts.get(request.sessionId)?.kind !== "conversation"
				) {
					return refuse("invalid_sessions", "the worker reported a conversation it was not sent");
				}
				clearTimeout(conversation.readyTimer);
				conversation.opened = true;
				if (conversation.state === "opening") conversation.state = "open";
				conversation.ready.resolve();
				this.updateRetention(record);
				return ok;
			}
			case "worker_open_failed": {
				const conversation = record.conversations.get(request.sessionId);
				const failure = new WorkerOpenError(request.message, request.outcome);
				if (record.state === "starting") {
					if (request.sessionId !== record.primarySessionId) {
						return refuse("invalid_sessions", "the worker reported a conversation it was not spawned for");
					}
					// The worker exits; its first conversation's opens fail with this once it did.
					record.openFailure = failure;
					return ok;
				}
				if (!conversation || conversation.opened) {
					return refuse("invalid_sessions", "the worker reported a conversation it was not sent");
				}
				this.options.audit({
					type: "worker_open",
					workspace: record.workspaceName,
					success: false,
					error: request.outcome ?? "open_failed",
					details: { workerId: record.workerId, sessionId: request.sessionId },
				});
				this.dropConversation(record, request.sessionId, conversation, failure);
				return ok;
			}
			case "worker_activity": {
				record.active = new Set(request.activeSessionIds.filter((sessionId) => record.hosts.has(sessionId)));
				this.updateRetention(record);
				return ok;
			}
			case "worker_hosts": {
				// A conversation the worker hosts already is in some group, maybe another's: a claim never moves
				// it, and the release that would follow a granted one would drop it while it is open.
				if (record.hosts.has(request.sessionId)) {
					return refuse("claimed", "the worker hosts that conversation already");
				}
				// A worker claims only its own workspace's stored sessions, and a `--no-session` one also the
				// conversations in its memory, which only its client reaches.
				const parentTop = this.topOf(record, request.parentSessionId);
				const session = parentTop?.conversation.spec?.session;
				const owned =
					request.inMemory === true
						? record.exclusiveTo !== undefined
						: await this.options
								.sessionInWorkspace(
									record.workspaceName,
									request.sessionId,
									session === undefined || "inMemory" in session ? undefined : session.sessionDirectory,
								)
								.catch(() => false);
				const refused = owned
					? this.claim(record, request.sessionId, request.kind, request.parentSessionId)
					: { code: "not_found", message: "no such session in the worker's workspace" };
				const repeated = refused !== undefined && record.refusedClaims.has(request.sessionId);
				if (refused !== undefined && record.refusedClaims.size < MAX_WORKER_HOSTED_SESSIONS) {
					record.refusedClaims.add(request.sessionId);
				}
				if (!repeated) {
					this.options.audit({
						type: "worker_hosts",
						workspace: record.workspaceName,
						success: refused === undefined,
						...(refused === undefined ? {} : { error: refused.code }),
						details: {
							workerId: record.workerId,
							sessionId: request.sessionId,
							kind: request.kind,
							parentSessionId: request.parentSessionId,
						},
					});
				}
				return refused === undefined ? ok : refuse(refused.code, refused.message);
			}
			case "worker_released": {
				const hosted = record.hosts.get(request.sessionId);
				if (!hosted) return refuse("not_hosted", "the worker does not host that conversation");
				if (hosted.kind !== "conversation") {
					record.hosts.delete(request.sessionId);
					record.active.delete(request.sessionId);
					this.hostsChanged(record.workspaceName, request.sessionId, false);
					this.updateRetention(record);
					return ok;
				}
				const conversation = record.conversations.get(request.sessionId);
				if (record.state === "starting" || !conversation?.opened) {
					return refuse("invalid_state", "the conversation is not open yet");
				}
				// What a conversation claimed closes before it: the registry never holds a group without its head.
				if (this.groupOf(record, request.sessionId).length > 1) {
					return refuse("group_open", "the conversation's group closes before it");
				}
				this.options.audit({
					type: "worker_close",
					workspace: record.workspaceName,
					success: true,
					details: {
						workerId: record.workerId,
						sessionId: request.sessionId,
						...(conversation.close === undefined ? {} : { reason: conversation.close.reason }),
					},
				});
				this.removeConversation(record, request.sessionId, conversation);
				this.notifyChanged(record);
				this.retireIfEmpty(record);
				return ok;
			}
			case "worker_stop_result": {
				const stop = record.stop;
				if (!stop || stop.stopId !== request.stopId) return refuse("not_found", "no such stop request");
				record.stop = undefined;
				if (
					request.outcome === "refused_active" &&
					!stop.force &&
					!record.forced &&
					record.state === "retiring" &&
					record.hosts.size > 0
				) {
					// It turned active: back to live; its groups' TTLs wait for idle again.
					record.state = "live";
					for (const sessionId of record.hosts.keys()) record.active.add(sessionId);
					this.notifyChanged(record);
					this.options.audit({
						type: "worker_stop",
						workspace: record.workspaceName,
						success: false,
						error: "refused_active",
						details: { workerId: record.workerId, reason: stop.reason },
					});
					this.updateRetention(record);
				}
				return ok;
			}
			case "worker_close_result": {
				const entry = [...record.conversations].find(
					([, candidate]) => candidate.close?.closeId === request.closeId,
				);
				if (!entry) return refuse("not_found", "no such close request");
				const [sessionId, conversation] = entry;
				const close = conversation.close;
				if (request.outcome === "refused_active" && close !== undefined && !close.force) {
					// A conversation of the group turned active, such as a job's wake: it stays open, and its
					// TTL waits for the worker to report it idle again.
					conversation.close = undefined;
					conversation.state = "open";
					record.active.add(sessionId);
					close.done.resolve();
					this.notifyChanged(record);
					this.options.audit({
						type: "worker_close",
						workspace: record.workspaceName,
						success: false,
						error: "refused_active",
						details: { workerId: record.workerId, sessionId, reason: close.reason },
					});
					this.updateRetention(record);
				}
				// Closed: the worker releases the group's conversations, the head last.
				return ok;
			}
		}
	}

	/**
	 * `worker_hosts`: the worker claims `sessionId` before opening it, into
	 * the group of the conversation `parentSessionId` it hosts. Refused unless
	 * the worker is live with a control connection, its generation is current
	 * and its workspace admits, the parent's group is not closing, and no
	 * registered worker hosts the session. A sibling claim of a session a
	 * detached, idle group hosts closes that group early, as its TTL would
	 * (`retiring`: the claimant retries).
	 */
	private claim(
		record: WorkerRecord,
		sessionId: string,
		kind: WorkerHostKind,
		parentSessionId: string,
	): { code: string; message: string } | undefined {
		if (record.state !== "live" || record.forced || record.connectionId === undefined) {
			return { code: "not_live", message: "the worker is not live" };
		}
		if (
			this.fences.has(record.workspaceName) ||
			this.options.currentGeneration(record.workspaceName) !== record.workspaceGeneration
		) {
			return { code: "fenced", message: "the workspace authority changed" };
		}
		const parent = this.topOf(record, parentSessionId);
		if (!parent) return { code: "not_hosted", message: "the worker does not host the parent conversation" };
		if (parent.conversation.state !== "open") {
			return { code: "closing", message: "the parent conversation is closing" };
		}
		// Hosted meanwhile (an open routed it here as a conversation of its own): never claimed into another group.
		if (record.hosts.has(sessionId))
			return { code: "claimed", message: "the worker hosts that conversation already" };
		const owner = this.hostOf(sessionId);
		if (owner) {
			// A review source or discussion a detached, idle group keeps only until its TTL runs: retention
			// closes that group now, and the claimant retries once it was released.
			const ownerTop = this.topOf(owner, sessionId);
			if (
				kind === "sibling" &&
				owner.workspaceName === record.workspaceName &&
				ownerTop !== undefined &&
				(owner.state === "retiring" ||
					ownerTop.conversation.state === "closing" ||
					this.expire(owner, ownerTop.id, "sibling_claim"))
			) {
				return { code: "retiring", message: "the conversation is being closed where it is hosted; retry" };
			}
			return { code: "claimed", message: "another worker hosts that conversation" };
		}
		if (record.hosts.size >= MAX_WORKER_HOSTED_SESSIONS) {
			return { code: "too_many", message: "the worker hosts too many conversations" };
		}
		record.hosts.set(sessionId, { kind, parentSessionId, top: parent.id });
		this.hostsChanged(record.workspaceName, sessionId, true);
		return undefined;
	}

	/** A worker's control connection closed: it stops admitting and exits; the registry waits for that. */
	onConnectionClosed(connectionId: string): void {
		for (const record of this.workers.values()) {
			if (record.connectionId !== connectionId) continue;
			record.connectionId = undefined;
			this.beginRetiring(record);
		}
	}

	// ==========================================================================
	// Retention and closes
	// ==========================================================================

	/** Whether a group of `record` is active, as the worker last reported it. */
	private groupActive(record: WorkerRecord, top: string): boolean {
		for (const [sessionId, hosted] of record.hosts) {
			if (hosted.top === top && record.active.has(sessionId)) return true;
		}
		return false;
	}

	/** Whether a relayed stream of a conversation in the group of `top` is offered or open. */
	private groupAttached(record: WorkerRecord, top: string): boolean {
		for (const attachment of record.attachments.values()) {
			if (record.hosts.get(attachment.sessionId)?.top === top) return true;
		}
		return false;
	}

	/**
	 * Whether the group of `top` is one the retention TTL applies to: its
	 * worker live, unfenced, and connected; the conversation open with no
	 * close pending; and the group detached, idle, and no open resolving to it.
	 */
	private detachedIdle(record: WorkerRecord, top: string, conversation: TopLevelConversation): boolean {
		return (
			this.workers.get(record.workerId) === record &&
			record.state === "live" &&
			!record.forced &&
			record.connectionId !== undefined &&
			conversation.state === "open" &&
			conversation.close === undefined &&
			conversation.routing === 0 &&
			!this.groupAttached(record, top) &&
			!this.groupActive(record, top)
		);
	}

	/** Arm the retention TTL of every detached idle group of `record`; cancel the others'. */
	private updateRetention(record: WorkerRecord): void {
		for (const [top, conversation] of record.conversations) {
			if (!this.detachedIdle(record, top, conversation)) {
				clearTimeout(conversation.retention);
				conversation.retention = undefined;
				continue;
			}
			if (conversation.retention !== undefined) continue;
			const ttlMs =
				record.exclusiveTo !== undefined ? EXCLUSIVE_WORKER_RETENTION_MS : this.options.detachedRuntimeTtlMs();
			conversation.retention = setTimeout(() => {
				conversation.retention = undefined;
				this.expire(record, top, ttlMs);
			}, ttlMs);
			conversation.retention.unref?.();
		}
	}

	/**
	 * The TTL fired on a detached, idle group, or a sibling claim needs a
	 * conversation in it: ask the worker to close the group. It may refuse if
	 * it turned active. Whether the close went out.
	 */
	private expire(record: WorkerRecord, top: string, why: number | "sibling_claim"): boolean {
		const conversation = record.conversations.get(top);
		if (!conversation || !this.detachedIdle(record, top, conversation)) return false;
		clearTimeout(conversation.retention);
		conversation.retention = undefined;
		this.sendClose(record, top, conversation, "retention", false);
		this.options.log?.("info", "closing a detached idle conversation", {
			workerId: record.workerId,
			sessionId: top,
			...(why === "sibling_claim" ? { why } : { ttlMs: why }),
		});
		return true;
	}

	/** Ask the worker to close the group of `top` (`worker_close`); no open reaches the group meanwhile. */
	private sendClose(
		record: WorkerRecord,
		top: string,
		conversation: TopLevelConversation,
		reason: WorkerStopReason,
		force: boolean,
	): CloseRequest {
		const close: CloseRequest = {
			closeId: randomUUID(),
			reason,
			force,
			done: conversation.close?.done ?? Promise.withResolvers<void>(),
		};
		conversation.state = "closing";
		conversation.close = close;
		this.options.audit({
			type: "worker_close",
			workspace: record.workspaceName,
			success: true,
			details: { workerId: record.workerId, sessionId: top, reason, force, requested: true },
		});
		if (record.connectionId !== undefined) {
			this.options.sendTo(record.connectionId, {
				type: "worker_close",
				closeId: close.closeId,
				sessionId: top,
				reason,
				force,
			});
		}
		return close;
	}

	/**
	 * Close the group of `top` without the option to refuse: the retire
	 * listeners hear its sessions first (their relays close), then the worker
	 * closes it, aborting a turn still running after 60 s (at once for lost
	 * authority). A worker that has not released it by the forced-close timeout
	 * is stuck: it retires without the option to refuse, its other
	 * conversations' turns getting the 60 s cap (never aborted at once for this
	 * group's lost authority). Resolves once the group's head was released, or
	 * the worker exited.
	 */
	private async closeTop(
		record: WorkerRecord,
		top: string,
		conversation: TopLevelConversation,
		reason: WorkerStopReason,
	): Promise<void> {
		if (!conversation.close?.force) {
			clearTimeout(conversation.retention);
			conversation.retention = undefined;
			const sessionIds = this.groupOf(record, top);
			for (const listener of [...this.retireListeners]) listener(record.workerId, reason, sessionIds);
			const close = this.sendClose(record, top, conversation, reason, true);
			this.notifyChanged(record);
			const timer = setTimeout(() => {
				if (record.conversations.get(top) !== conversation || this.workers.get(record.workerId) !== record) return;
				this.options.log?.("warn", "worker did not close a conversation after a forced close; retiring it", {
					workerId: record.workerId,
					sessionId: top,
				});
				void this.retire(record, "retention");
			}, WORKER_FORCED_CLOSE_TIMEOUT_MS);
			timer.unref?.();
			void close.done.promise.then(() => clearTimeout(timer));
		}
		await Promise.race([conversation.close?.done.promise, record.exited.promise]);
	}

	/** A live worker that hosts nothing retires: no open is routed to it again, and it is asked to stop. */
	private retireIfEmpty(record: WorkerRecord): void {
		if (this.workers.get(record.workerId) !== record || record.state !== "live" || record.hosts.size > 0) return;
		record.state = "retiring";
		this.sendStop(record, "retention", false);
		this.options.log?.("info", "retiring a worker that hosts nothing", { workerId: record.workerId });
	}

	private sendStop(record: WorkerRecord, reason: WorkerStopReason, force: boolean): void {
		const stop: StopRequest = { stopId: randomUUID(), reason, force };
		record.stop = stop;
		this.options.audit({
			type: "worker_stop",
			workspace: record.workspaceName,
			success: true,
			details: { workerId: record.workerId, reason, force },
		});
		if (record.connectionId !== undefined) {
			this.options.sendTo(record.connectionId, { type: "worker_stop", stopId: stop.stopId, reason, force });
		}
	}

	/** Stop admitting to `record`: it is retiring until its exit is observed; the opens waiting for its conversations fail. */
	private beginRetiring(record: WorkerRecord): void {
		if (this.workers.get(record.workerId) !== record) return;
		for (const [sessionId, conversation] of record.conversations) {
			clearTimeout(conversation.retention);
			conversation.retention = undefined;
			if (!conversation.opened) {
				conversation.ready.reject(
					sessionId === record.primarySessionId && record.openFailure !== undefined
						? record.openFailure
						: new WorkerOpenError("The worker stopped before it opened the conversation"),
				);
			}
		}
		record.state = "retiring";
		this.notifyChanged(record);
	}

	/**
	 * Retire `record` without the option to refuse: its relays close first
	 * (the retire listeners), then it stops, aborting a turn still running
	 * after 60 s. A worker that has not exited by the forced-stop timeout (its
	 * event loop is blocked) is killed, so no fence waits for it forever.
	 * Resolves once it exited.
	 */
	private retire(record: WorkerRecord, reason: WorkerStopReason): Promise<WorkerExit> {
		if (!record.forced) {
			record.forced = true;
			this.beginRetiring(record);
			const sessionIds = [...record.hosts.keys()];
			for (const listener of [...this.retireListeners]) listener(record.workerId, reason, sessionIds);
			this.sendStop(record, reason, true);
			const timer = setTimeout(() => {
				if (this.workers.get(record.workerId) !== record) return;
				this.options.log?.("warn", "worker did not exit after a forced stop; killing it", {
					workerId: record.workerId,
				});
				record.launched?.kill();
			}, WORKER_FORCED_STOP_TIMEOUT_MS);
			timer.unref?.();
			void record.exited.promise.then(() => clearTimeout(timer));
		}
		return record.exited.promise;
	}

	/**
	 * Fence a workspace's authority (an unregister, a replace, a revocation, a
	 * tightened grant, a removed worktree): admission for the workspace closes,
	 * every registered worker of the workspace whose key is no longer current
	 * (all of them with `all`) retires without the option to refuse, and the
	 * returned promise resolves once their exits were observed, when admission
	 * reopens. Every conversation of such a worker is of the fenced workspace
	 * and generation. Call it after the authority changed in the daemon's state.
	 */
	fenceWorkspace(workspaceName: string, options: { all?: boolean; reason?: WorkerStopReason } = {}): Promise<void> {
		const previous = this.fences.get(workspaceName) ?? Promise.resolve();
		const current = this.options.currentGeneration(workspaceName);
		const fenced = [...this.workers.values()].filter(
			(record) =>
				record.workspaceName === workspaceName &&
				(options.all === true || current === undefined || record.workspaceGeneration !== current),
		);
		// Their relays close and their stops go out now; the fence settles once they exited.
		const exits = fenced.map((record) => this.retire(record, options.reason ?? "authority"));
		const settled = Promise.allSettled([previous, ...exits]).then(() => undefined);
		this.fences.set(workspaceName, settled);
		void settled.finally(() => {
			if (this.fences.get(workspaceName) === settled) this.fences.delete(workspaceName);
		});
		return settled;
	}

	/**
	 * Close the conversation hosting `sessionId` of `workspaceName` without the
	 * option to refuse (its client lost its authority, its worktree is being
	 * removed, a phone's fresh pairing replaces it): its group closes in its worker, and the
	 * worker's other groups keep serving. A worker that is starting, or not
	 * live, retires instead. Resolves once the group was released or the
	 * worker exited; at once when no worker hosts it.
	 */
	async closeConversation(workspaceName: string, sessionId: string, reason: WorkerStopReason): Promise<void> {
		const record = this.hostOf(sessionId);
		if (!record || record.workspaceName !== workspaceName) return;
		const top = this.topOf(record, sessionId);
		if (record.state !== "live" || record.forced || !top) {
			await this.retire(record, reason);
			return;
		}
		await this.closeTop(record, top.id, top.conversation, reason);
	}

	/** The workspace of the registered worker hosting `sessionId`, whichever it is. */
	workspaceHosting(sessionId: string): string | undefined {
		return this.hostOf(sessionId)?.workspaceName;
	}

	/**
	 * Every session a registered worker of `workspaceName` hosts, and whether
	 * a client is on it (`sessions[].runtimeState`, D18): `attached` while a
	 * relayed stream of it is offered or open, or its worker or top-level
	 * conversation is still starting; `detached` otherwise.
	 */
	runtimeStates(workspaceName: string): Map<string, "attached" | "detached"> {
		const states = new Map<string, "attached" | "detached">();
		for (const record of this.workers.values()) {
			if (record.workspaceName !== workspaceName) continue;
			const streamed = new Set([...record.attachments.values()].map((attachment) => attachment.sessionId));
			for (const sessionId of record.hosts.keys()) {
				const starting =
					record.state === "starting" || this.topOf(record, sessionId)?.conversation.state === "opening";
				states.set(sessionId, starting || streamed.has(sessionId) ? "attached" : "detached");
			}
		}
		return states;
	}

	/** Whether a registered worker hosts `sessionId` of `workspaceName`. */
	hosts(workspaceName: string, sessionId: string): boolean {
		return this.hostOf(sessionId)?.workspaceName === workspaceName;
	}

	/** The registered worker hosting `sessionId` of `workspaceName`, who opened it, and why it hosts the session. */
	host(
		workspaceName: string,
		sessionId: string,
	):
		| {
				readonly workerId: string;
				readonly origin: ControlWorkerOrigin;
				readonly kind: "conversation" | WorkerHostKind;
		  }
		| undefined {
		const record = this.hostOf(sessionId);
		const hosted = record?.hosts.get(sessionId);
		return record && hosted && record.workspaceName === workspaceName
			? { workerId: record.workerId, origin: record.origin, kind: hosted.kind }
			: undefined;
	}

	/** Whether the worker `workerId` hosts `sessionId`. */
	workerHosts(workerId: string, sessionId: string): boolean {
		return this.workers.get(workerId)?.hosts.has(sessionId) ?? false;
	}

	/** The control connection of a registered worker, once it said hello. */
	connectionOf(workerId: string): string | undefined {
		return this.workers.get(workerId)?.connectionId;
	}

	/** The workspace and generation of a registered worker. */
	keyOf(workerId: string): { readonly workspaceName: string; readonly workspaceGeneration: number } | undefined {
		const record = this.workers.get(workerId);
		return record
			? { workspaceName: record.workspaceName, workspaceGeneration: record.workspaceGeneration }
			: undefined;
	}

	/** The registered workers of `workspaceName`. */
	workersOf(workspaceName: string): string[] {
		return [...this.workers.values()]
			.filter((record) => record.workspaceName === workspaceName)
			.map((record) => record.workerId);
	}

	/** Retire the worker `workerId` without the option to refuse; resolves once it exited. */
	async retireWorker(workerId: string, reason: WorkerStopReason): Promise<void> {
		const record = this.workers.get(workerId);
		if (record) await this.retire(record, reason);
	}

	/**
	 * The daemon stops: admission closes, and every worker retires without the
	 * option to refuse. Resolves once each exited, or after the forced-stop
	 * timeout, by which `retire` killed a worker that had not exited.
	 */
	async stopAll(): Promise<void> {
		this.closed = true;
		const records = [...this.workers.values()];
		await Promise.allSettled(
			records.map(async (record) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const timedOut = new Promise<void>((resolve) => {
					timer = setTimeout(resolve, WORKER_FORCED_STOP_TIMEOUT_MS);
					timer.unref?.();
				});
				try {
					await Promise.race([this.retire(record, "shutdown"), timedOut]);
				} finally {
					clearTimeout(timer);
				}
			}),
		);
	}

	/**
	 * Whether `workerId` may still act on its workspace: registered, live,
	 * not fenced or retiring, connected, and its generation current with no
	 * fence of its workspace in flight.
	 */
	isServing(workerId: string): boolean {
		const record = this.workers.get(workerId);
		return (
			record !== undefined &&
			record.state === "live" &&
			!record.forced &&
			record.connectionId !== undefined &&
			!this.fences.has(record.workspaceName) &&
			this.options.currentGeneration(record.workspaceName) === record.workspaceGeneration
		);
	}

	/** The worker exited: its record goes, and the opens that waited for it fail or route again. */
	private finish(record: WorkerRecord, exit: WorkerExit, cause?: unknown): void {
		if (this.workers.get(record.workerId) !== record) return;
		clearTimeout(record.readyTimer);
		this.workers.delete(record.workerId);
		const failure =
			cause instanceof Error
				? cause
				: (record.openFailure ??
					new WorkerOpenError(exit.error ?? "The worker exited before it opened the conversation"));
		for (const conversation of record.conversations.values()) {
			clearTimeout(conversation.retention);
			clearTimeout(conversation.readyTimer);
			conversation.questions.abort();
			conversation.retention = undefined;
			if (!conversation.opened) conversation.ready.reject(failure);
			conversation.close?.done.resolve();
		}
		if (record.launched !== undefined) {
			this.options.audit({
				type: "worker_exited",
				workspace: record.workspaceName,
				success: exit.reason === "stopped",
				...(exit.error === undefined ? {} : { error: exit.error }),
				details: { workerId: record.workerId, reason: exit.reason, sessionIds: [...record.hosts.keys()] },
			});
		}
		const hosted = [...record.hosts.keys()];
		record.hosts.clear();
		record.conversations.clear();
		record.active.clear();
		for (const sessionId of hosted) this.hostsChanged(record.workspaceName, sessionId, false);
		record.exited.resolve(exit);
		this.notifyChanged(record);
		for (const listener of [...this.exitListeners]) listener(record.workerId, exit);
	}

	/** A worker exited; its relayed streams close (D19). */
	onWorkerExited(listener: (workerId: string, exit: WorkerExit) => void): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	/** A registered worker started or stopped hosting a session (spawn, route, claim, release, exit). */
	onHostsChanged(listener: (workspaceName: string, sessionId: string, hosted: boolean) => void): () => void {
		this.hostsListeners.add(listener);
		return () => {
			this.hostsListeners.delete(listener);
		};
	}

	/**
	 * Conversations of a worker close without the option to refuse (the
	 * worker retires, or one group is closed), naming them; their relayed
	 * streams close before they do.
	 */
	onWorkerRetiring(
		listener: (workerId: string, reason: WorkerStopReason, sessionIds: readonly string[]) => void,
	): () => void {
		this.retireListeners.add(listener);
		return () => {
			this.retireListeners.delete(listener);
		};
	}

	// ==========================================================================
	// Status
	// ==========================================================================

	list(): ControlWorkerStatus[] {
		return [...this.workers.values()].map((record) => {
			const kinds = [...record.attachments.values()].map((attachment) => attachment.kind);
			return {
				workerId: record.workerId,
				pid: record.launched?.pid ?? 0,
				state: record.state,
				origin: record.origin,
				workspaceName: record.workspaceName,
				sessionIds: [...record.hosts.keys()],
				clients: {
					local: kinds.filter((kind) => kind === "local").length,
					remote: kinds.filter((kind) => kind === "remote").length,
				},
				...(record.launched?.logPath === undefined ? {} : { logPath: record.launched.logPath }),
			};
		});
	}

	/** Whether any worker is registered. */
	get size(): number {
		return this.workers.size;
	}
}
