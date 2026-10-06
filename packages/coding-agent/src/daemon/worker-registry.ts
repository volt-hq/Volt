/**
 * The daemon's conversation workers (Phase 7 plan §1; the model of record is
 * docs/tla/WorkerRegistry.tla). Every conversation a client opens runs in a
 * worker the daemon spawns and supervises; the daemon hosts none itself.
 *
 * A worker is registered for the conversation it was spawned for, its
 * primary, under the key (workspace, generation, session), and for each
 * conversation it claims beside it (`worker_hosts`): a subagent's child, a
 * review sibling, the target of a move an extension started. At most one
 * registered worker hosts a session, whatever its workspace.
 *
 * Its states are `starting` (spawned, primary not open yet), `live` (serving),
 * `retiring` (asked to stop, fenced, or its control connection lost) and
 * `exited` (its process exited; the record is gone). An open of a session:
 *
 *   live host      -> the caller's `attach` runs in the same turn as the lookup
 *   starting host  -> wait for that same spawn (concurrent opens share it)
 *   retiring host  -> wait for its exit, then spawn
 *   no host        -> spawn
 *
 * A live worker is attached while any relayed stream of a conversation it
 * hosts is offered or open, else detached. The retention TTL
 * (`remote.detachedRuntimeTtlMs`) runs only while it is live, detached, and
 * idle (its last `worker_activity`); when it fires, the worker is asked to
 * stop and may refuse because it turned active. A worker a TUI spawned for a
 * conversation without a session file (`--no-session`, D15) is exclusive to
 * that TUI's client key: no other client's open reaches what it hosts, it
 * alone claims conversations in its memory, and it retires once its last client left
 * for `EXCLUSIVE_WORKER_RETENTION_MS` (its client reconnects within it after
 * a move). A fenced workspace closes
 * admission for that workspace and retires its workers without the option to
 * refuse, until their exit is observed. A worker's exit, however it happens,
 * removes its record and fails the opens that waited for its readiness.
 */

import { randomBytes, randomUUID } from "node:crypto";
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
import { workerCompatibilityKey } from "./worker-spawn-options.ts";

/** How long a forced stop may take before the daemon stops waiting for the worker: its 60 s turn cap, and margin. */
export const WORKER_FORCED_STOP_TIMEOUT_MS = 75_000;

/** How long a spawned worker may take to open its primary (a replacement retries a held lock for 75 s). */
export const WORKER_READY_TIMEOUT_MS = 90_000;

/** The conversations one worker may host at most: its primary and its claims. */
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

/** A live worker, as an open's `attach` sees it. */
export interface LiveWorker {
	readonly workerId: string;
	readonly origin: ControlWorkerOrigin;
	readonly workspaceName: string;
	readonly workspaceGeneration: number;
	/** The worker's control connection, where its events go. */
	readonly connectionId: string;
	/** What it was spawned with: its tool policy, or its TUI's spawn-only options, are fixed for its lifetime (D9). */
	readonly spec: WorkerSpawnSpec;
	/** Opens it could serve run with the same key (see `worker-spawn-options.ts`). */
	readonly compatibilityKey: string;
	/**
	 * Count a relayed stream (an offer, then the stream it was redeemed for)
	 * as attached until the returned release runs: the worker is not detached
	 * meanwhile. Release once; later calls do nothing.
	 */
	attach(kind: WorkerClientKind): () => void;
}

/** The conversation a spawn opens, as the daemon resolved it; the registry adds the worker id. */
export type WorkerSpawnInput = DistributiveOmit<WorkerSpawnSpec, "workerId">;

/** A spawn failed: the worker could not open its primary, or it exited first. */
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
	readonly type: "worker_spawned" | "worker_ready" | "worker_exited" | "worker_hosts" | "worker_stop";
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
	/** `remote.detachedRuntimeTtlMs`, read whenever a detached idle worker arms its timer. */
	detachedRuntimeTtlMs(): number;
	/**
	 * Whether `sessionId` is a stored session of `workspaceName`, or of the
	 * session directory of the claiming worker's primary (a TUI's sessions
	 * are stored by their working directory): a worker claims only its own
	 * workspace's sessions.
	 */
	sessionInWorkspace(workspaceName: string, sessionId: string, sessionDirectory?: string): Promise<boolean>;
	audit(event: WorkerRegistryAuditEvent): void;
	log?(level: "info" | "warn" | "error", message: string, details?: Record<string, unknown>): void;
}

interface HostedSession {
	readonly kind: "primary" | WorkerHostKind;
	readonly parentSessionId?: string;
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
	readonly primarySessionId: string;
	/** Registry assignment: the primary, then every claim, in order. */
	readonly hosts: Map<string, HostedSession>;
	spec: WorkerSpawnSpec | undefined;
	compatibilityKey: string | undefined;
	/** The only client key whose opens reach this worker (`--no-session`, D15). */
	readonly exclusiveTo: string | undefined;
	launched: LaunchedWorker | undefined;
	connectionId: string | undefined;
	/** Its key's generation was fenced, or it is being stopped without the option to refuse. */
	forced: boolean;
	/** Whether a hosted conversation is active, as the worker last reported it. */
	active: boolean;
	readonly attachments: Map<number, WorkerClientKind>;
	/** Opens resolved to this worker that have not attached yet: it is not retired meanwhile. */
	routing: number;
	retention: ReturnType<typeof setTimeout> | undefined;
	stop: StopRequest | undefined;
	openFailure: WorkerOpenError | undefined;
	readonly ready: PromiseWithResolvers<void>;
	readonly exited: PromiseWithResolvers<WorkerExit>;
	readonly idle: Set<() => void>;
	/** Settles at the worker's next state change (a refused stop, its exit); replaced after each. */
	changed: PromiseWithResolvers<void>;
	/** Claims refused once, audited once. */
	readonly refusedClaims: Set<string>;
	readyTimer: ReturnType<typeof setTimeout> | undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

let attachmentSequence = 0;

export class WorkerRegistry {
	private readonly options: WorkerRegistryOptions;
	/** Registered workers: starting, live, or retiring. */
	private readonly workers = new Map<string, WorkerRecord>();
	/** Workspaces with a fence in flight: admission closes until its fenced workers exited. */
	private readonly fences = new Map<string, Promise<void>>();
	private readonly exitListeners = new Set<(workerId: string, exit: WorkerExit) => void>();
	private readonly retireListeners = new Set<(workerId: string, reason: WorkerStopReason) => void>();
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
	 * no retention can fire between them. With no host, `prepare` builds the
	 * spawn's conversation; concurrent opens of the session share that spawn
	 * and fail with it. A retiring host is waited for until it exited. An open
	 * of a fenced generation, a session another workspace's worker hosts, a
	 * session an exclusive worker of another client hosts, or a closed
	 * registry is refused. `attach` hears whether this open spawned the worker.
	 */
	async open<T>(
		key: WorkerOpenKey,
		options: {
			readonly origin: ControlWorkerOrigin;
			readonly prepare: () => Promise<WorkerSpawnInput>;
			readonly attach: (worker: LiveWorker, spawned: boolean) => T;
			readonly signal?: AbortSignal;
			/** The opening client's key (a TUI's); phones have none. */
			readonly client?: string;
			/** A worker this open spawns admits no other client's open (`--no-session`, D15). */
			readonly exclusive?: boolean;
			/** The environment a worker this open spawns runs with (a TUI's); the daemon's own without one. */
			readonly env?: Readonly<Record<string, string>>;
		},
	): Promise<T> {
		if (options.exclusive === true && options.client === undefined) {
			throw new WorkerOpenError("An exclusive worker needs its client's key", "invalid_conversation_target");
		}
		let spawned: WorkerRecord | undefined;
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
				const record = this.reserve(key, options.origin, options.exclusive === true ? options.client : undefined);
				spawned = record;
				record.routing++;
				try {
					await this.launch(record, options.prepare, options.env);
				} finally {
					record.routing--;
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
			if (host.state === "live" && !host.forced && host.workspaceGeneration === key.workspaceGeneration) {
				try {
					return options.attach(this.liveView(host), host === spawned);
				} finally {
					this.updateRetention(host);
				}
			}
			// Starting: wait for that same spawn. Retiring, or of a fenced generation: a replacement
			// opens once it exited, unless it refused the stop and serves again. Either way the
			// waiting open keeps it from being retired meanwhile.
			const starting = host.state === "starting" && host.workspaceGeneration === key.workspaceGeneration;
			host.routing++;
			try {
				await this.waitFor(starting ? host.ready.promise : host.changed.promise, options.signal);
			} finally {
				host.routing--;
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

	/** Register a starting worker for `key` synchronously, so concurrent opens of the session wait for it. */
	private reserve(key: WorkerOpenKey, origin: ControlWorkerOrigin, exclusiveTo: string | undefined): WorkerRecord {
		const record: WorkerRecord = {
			workerId: `w-${randomUUID()}`,
			token: randomBytes(32),
			tokenUsed: false,
			state: "starting",
			origin,
			workspaceName: key.workspaceName,
			workspaceGeneration: key.workspaceGeneration,
			primarySessionId: key.sessionId,
			hosts: new Map([[key.sessionId, { kind: "primary" }]]),
			spec: undefined,
			compatibilityKey: undefined,
			exclusiveTo,
			launched: undefined,
			connectionId: undefined,
			forced: false,
			active: false,
			attachments: new Map(),
			routing: 0,
			retention: undefined,
			stop: undefined,
			openFailure: undefined,
			ready: Promise.withResolvers<void>(),
			exited: Promise.withResolvers<WorkerExit>(),
			idle: new Set(),
			changed: Promise.withResolvers<void>(),
			refusedClaims: new Set(),
			readyTimer: undefined,
		};
		void record.ready.promise.catch(() => undefined);
		this.workers.set(record.workerId, record);
		this.hostsChanged(record.workspaceName, key.sessionId, true);
		return record;
	}

	private hostsChanged(workspaceName: string, sessionId: string, hosted: boolean): void {
		for (const listener of [...this.hostsListeners]) listener(workspaceName, sessionId, hosted);
	}

	/** Build the spawn and start the worker; resolves once it is live, rejects with its failure. */
	private async launch(
		record: WorkerRecord,
		prepare: () => Promise<WorkerSpawnInput>,
		env: Readonly<Record<string, string>> | undefined,
	): Promise<void> {
		let input: WorkerSpawnInput;
		try {
			input = await prepare();
			if (input.session.sessionId !== record.primarySessionId) {
				throw new Error("The prepared conversation is not the one the spawn was registered for");
			}
			// Only a TUI's spawn runs with an environment of its own, and an in-memory primary only for its exclusive TUI.
			if (
				input.origin !== record.origin ||
				(env !== undefined && input.origin !== "tui") ||
				"inMemory" in input.session !== (record.exclusiveTo !== undefined)
			) {
				throw new Error("The prepared conversation does not match the spawn's client");
			}
			if (
				input.workspace.name !== record.workspaceName ||
				input.workspace.generation !== record.workspaceGeneration
			) {
				throw new Error("The prepared conversation's workspace authority changed");
			}
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
		record.compatibilityKey = workerCompatibilityKey(input, env);
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
				cwd: input.cwd,
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
		// A worker that never reports ready (a lock it cannot take) is retired.
		record.readyTimer = setTimeout(() => {
			if (record.state === "starting") void this.retire(record, "authority");
		}, WORKER_READY_TIMEOUT_MS);
		record.readyTimer.unref?.();
		void launched.exited.then(
			(exit) => this.finish(record, exit),
			(error: unknown) => this.finish(record, { reason: "crashed", error: errorMessage(error) }),
		);
		await record.ready.promise;
	}

	/** The registered worker hosting `sessionId`, in any workspace. */
	private hostOf(sessionId: string): WorkerRecord | undefined {
		for (const record of this.workers.values()) {
			if (record.hosts.has(sessionId)) return record;
		}
		return undefined;
	}

	private liveView(record: WorkerRecord): LiveWorker {
		const spec = record.spec;
		const connectionId = record.connectionId;
		const compatibilityKey = record.compatibilityKey;
		if (!spec || connectionId === undefined || compatibilityKey === undefined) {
			throw new Error("A live worker has no spawn or connection");
		}
		return {
			workerId: record.workerId,
			origin: record.origin,
			workspaceName: record.workspaceName,
			workspaceGeneration: record.workspaceGeneration,
			connectionId,
			spec,
			compatibilityKey,
			attach: (kind) => {
				// Offers go only to a live worker (the model's NoOfferToRetiring).
				if (this.workers.get(record.workerId) !== record || record.state !== "live" || record.forced) {
					throw new WorkerOpenError("The worker is retiring; retry", "duplicate_conversation_connection");
				}
				const id = ++attachmentSequence;
				record.attachments.set(id, kind);
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
	 * connection (`binding`), a connection of its own. The token is spent here; the conversation the worker opens
	 * follows the ack. Returns the daemon's proof of the token for the ack, or
	 * undefined when the hello is refused.
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
			if (record.connectionId === connectionId) this.options.sendTo(connectionId, { type: "worker_spawn", spec });
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
					| "worker_ready"
					| "worker_open_failed"
					| "worker_activity"
					| "worker_hosts"
					| "worker_released"
					| "worker_stop_result";
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
			case "worker_ready": {
				if (record.state !== "starting") return refuse("invalid_state", `the worker is ${record.state}`);
				if (request.sessionIds.length !== 1 || request.sessionIds[0] !== record.primarySessionId) {
					return refuse("invalid_sessions", "the worker reported conversations it was not spawned for");
				}
				record.state = "live";
				clearTimeout(record.readyTimer);
				this.options.audit({
					type: "worker_ready",
					workspace: record.workspaceName,
					success: true,
					details: { workerId: record.workerId, sessionId: record.primarySessionId },
				});
				record.ready.resolve();
				this.updateRetention(record);
				return ok;
			}
			case "worker_open_failed": {
				if (record.state !== "starting") return refuse("invalid_state", `the worker is ${record.state}`);
				record.openFailure = new WorkerOpenError(request.message, request.outcome);
				return ok;
			}
			case "worker_activity": {
				record.active = request.active;
				if (!record.active) {
					for (const resolve of [...record.idle]) resolve();
					record.idle.clear();
				}
				this.updateRetention(record);
				return ok;
			}
			case "worker_hosts": {
				if (record.hosts.has(request.sessionId)) return ok;
				// A worker claims only its own workspace's stored sessions, and a `--no-session` one also the
				// conversations in its memory, which only its client reaches.
				const primary = record.spec?.session;
				const owned =
					request.inMemory === true
						? record.exclusiveTo !== undefined
						: await this.options
								.sessionInWorkspace(
									record.workspaceName,
									request.sessionId,
									primary === undefined || "inMemory" in primary ? undefined : primary.sessionDirectory,
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
				if (hosted.kind === "primary") return refuse("primary", "a worker's primary closes with the worker");
				record.hosts.delete(request.sessionId);
				this.hostsChanged(record.workspaceName, request.sessionId, false);
				return ok;
			}
			case "worker_stop_result": {
				const stop = record.stop;
				if (!stop || stop.stopId !== request.stopId) return refuse("not_found", "no such stop request");
				record.stop = undefined;
				if (request.outcome === "refused_active" && !stop.force && !record.forced && record.state === "retiring") {
					// It turned active, such as a job's wake: back to live; the TTL waits for idle again.
					record.state = "live";
					record.active = true;
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
		}
	}

	/**
	 * `worker_hosts`: the worker claims `sessionId` before opening it. Refused
	 * unless the worker is live with a control connection, its generation is
	 * current and its workspace admits, the parent it names is one it hosts,
	 * and no registered worker hosts the session. A sibling claim of a
	 * session a detached, idle worker hosts retires that worker early, as its
	 * TTL would (`retiring`: the claimant retries).
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
		if (!record.hosts.has(parentSessionId)) {
			return { code: "not_hosted", message: "the worker does not host the parent conversation" };
		}
		if (record.hosts.has(sessionId)) return undefined;
		const owner = this.hostOf(sessionId);
		if (owner) {
			// A review source or discussion a detached, idle worker keeps only until its TTL runs: retention
			// retires that worker now, and the claimant retries once it exited.
			if (
				kind === "sibling" &&
				owner.workspaceName === record.workspaceName &&
				(owner.state === "retiring" || this.expire(owner, "sibling_claim"))
			) {
				return { code: "retiring", message: "the worker hosting that conversation is retiring; retry" };
			}
			return { code: "claimed", message: "another worker hosts that conversation" };
		}
		if (record.hosts.size >= MAX_WORKER_HOSTED_SESSIONS) {
			return { code: "too_many", message: "the worker hosts too many conversations" };
		}
		record.hosts.set(sessionId, { kind, parentSessionId });
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
	// Retirement
	// ==========================================================================

	/**
	 * Arm the retention TTL while the worker is live, unfenced, connected,
	 * detached, idle, and no open is resolving to it; cancel it otherwise.
	 */
	private updateRetention(record: WorkerRecord): void {
		const detachedIdle =
			record.state === "live" &&
			!record.forced &&
			record.connectionId !== undefined &&
			record.attachments.size === 0 &&
			record.routing === 0 &&
			!record.active &&
			this.workers.get(record.workerId) === record;
		if (!detachedIdle) {
			if (record.retention !== undefined) clearTimeout(record.retention);
			record.retention = undefined;
			return;
		}
		if (record.retention !== undefined) return;
		const ttlMs =
			record.exclusiveTo !== undefined ? EXCLUSIVE_WORKER_RETENTION_MS : this.options.detachedRuntimeTtlMs();
		record.retention = setTimeout(() => {
			record.retention = undefined;
			this.expire(record, ttlMs);
		}, ttlMs);
		record.retention.unref?.();
	}

	/**
	 * The TTL fired on a detached, idle worker, or a sibling claim needs a
	 * conversation it hosts: ask it to stop. It may refuse if it turned active.
	 * Whether it began retiring.
	 */
	private expire(record: WorkerRecord, why: number | "sibling_claim"): boolean {
		if (
			record.state !== "live" ||
			record.forced ||
			record.attachments.size > 0 ||
			record.routing > 0 ||
			record.active ||
			record.connectionId === undefined
		) {
			return false;
		}
		if (record.retention !== undefined) clearTimeout(record.retention);
		record.retention = undefined;
		record.state = "retiring";
		this.sendStop(record, "retention", false);
		this.options.log?.("info", "retiring detached idle worker", {
			workerId: record.workerId,
			...(why === "sibling_claim" ? { why } : { ttlMs: why }),
		});
		return true;
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

	/** Stop admitting to `record`: it is retiring until its exit is observed. */
	private beginRetiring(record: WorkerRecord): void {
		if (this.workers.get(record.workerId) !== record) return;
		if (record.retention !== undefined) clearTimeout(record.retention);
		record.retention = undefined;
		if (record.state === "starting") {
			record.ready.reject(record.openFailure ?? new WorkerOpenError("The worker stopped before it was ready"));
		}
		record.state = "retiring";
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
			for (const listener of [...this.retireListeners]) listener(record.workerId, reason);
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
	 * reopens. Call it after the authority changed in the daemon's state.
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
	 * Retire the worker hosting `sessionId` of `workspaceName` without the
	 * option to refuse (a TUI took the conversation's lease). Resolves once it
	 * exited; at once when no worker hosts it.
	 */
	async retireHost(workspaceName: string, sessionId: string, reason: WorkerStopReason): Promise<void> {
		const host = this.hostOf(sessionId);
		if (!host || host.workspaceName !== workspaceName) return;
		await this.retire(host, reason);
	}

	/** Whether the worker hosting `sessionId` of `workspaceName` reported itself active. */
	isHostActive(workspaceName: string, sessionId: string): boolean {
		const host = this.hostOf(sessionId);
		return host !== undefined && host.workspaceName === workspaceName && host.active;
	}

	/** Resolves once the worker hosting `sessionId` reports itself idle, or is gone. */
	whenHostIdle(workspaceName: string, sessionId: string): Promise<void> {
		const host = this.hostOf(sessionId);
		if (!host || host.workspaceName !== workspaceName || !host.active) return Promise.resolve();
		return new Promise<void>((resolve) => {
			host.idle.add(resolve);
			void host.exited.promise.then(() => resolve());
		});
	}

	/** The workspace of the registered worker hosting `sessionId`, whichever it is. */
	workspaceHosting(sessionId: string): string | undefined {
		return this.hostOf(sessionId)?.workspaceName;
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
				readonly kind: "primary" | WorkerHostKind;
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
		if (record.retention !== undefined) clearTimeout(record.retention);
		record.retention = undefined;
		clearTimeout(record.readyTimer);
		this.workers.delete(record.workerId);
		if (record.state === "starting") {
			record.ready.reject(
				cause instanceof Error
					? cause
					: (record.openFailure ?? new WorkerOpenError(exit.error ?? "The worker exited before it was ready")),
			);
		}
		for (const resolve of [...record.idle]) resolve();
		record.idle.clear();
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

	/** A registered worker started or stopped hosting a session (spawn, claim, release, exit). */
	onHostsChanged(listener: (workspaceName: string, sessionId: string, hosted: boolean) => void): () => void {
		this.hostsListeners.add(listener);
		return () => {
			this.hostsListeners.delete(listener);
		};
	}

	/** A worker retires without the option to refuse; its relayed streams close before it stops. */
	onWorkerRetiring(listener: (workerId: string, reason: WorkerStopReason) => void): () => void {
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
			const kinds = [...record.attachments.values()];
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
