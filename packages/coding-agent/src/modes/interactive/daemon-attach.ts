import { basename, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { ControlRelayFrame, ControlRelayOutcome } from "@hansjm10/volt-protocol";
import { isStandaloneBinary, VERSION } from "../../config.ts";
import { parseIrohRemoteRpcGrant } from "../../core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../core/remote/iroh/authorization.ts";
import type {
	IrohRemotePushNotificationDeliveryStatus,
	IrohRemotePushNotificationIntent,
} from "../../core/remote/iroh/push.ts";
import type { RpcGitContext } from "../../core/rpc/types.ts";
import { SessionManager, type SessionReference } from "../../core/session-manager.ts";
import { createDaemonClient, type DaemonClient } from "../../daemon/control-client.ts";
import {
	CONTROL_RPC_GRANTS_CAPABILITY,
	CONTROL_WORKTREES_CAPABILITY,
	type ControlEvent,
	ControlValidators,
	type ControlWorktreeStatus,
	type LeaseReleaseReason,
	type LeaseState,
	type RelayPreamble,
} from "../../daemon/control-protocol.ts";
import { getDaemonSocketPath } from "../../daemon/paths.ts";
import {
	type EnsureDaemonResult,
	ensureDaemonRunning,
	probeDaemon,
	readPublishedDaemonEndpoint,
} from "../../daemon/spawn.ts";
import { isPathInside } from "../../daemon/workspace-directory.ts";
import { getWorktreesRoot } from "../../daemon/worktree-manager.ts";

export type DaemonAttachConnectionState = "connected" | "reconnecting" | "gone" | "disabled";

export type AcquireOutcome =
	| { kind: "granted"; handoff: "cold" | "warm" | "none" }
	| { kind: "pending"; viewerFeedId: string; granted: Promise<{ handoff: "cold" | "warm" | "none" }> }
	| { kind: "denied"; reason: string }
	| { kind: "noop" };

export interface DaemonRelayOffer {
	relayId: string;
	relayToken: string;
	workspaceName: string;
	sessionId: string;
	clientNodeId: string;
	connectionId: string;
	streamId: string;
}

export interface OpenedRelay {
	preamble: RelayPreamble;
	stream: Duplex;
	/** Mark the relay finished locally (updates the footer count). */
	finished(): void;
}

/**
 * A relayed phone unregistered the workspace of the session this TUI serves:
 * once the phone is answered, the TUI releases the session's lease.
 */
export interface RelayWorkspaceUnregisterRetirement {
	/** The daemon accepted the phone's unregister_workspace. */
	unregistered(): void;
	finalize(): Promise<void>;
}

export function createRelayWorkspaceUnregisterRetirement(
	daemonAttach: Pick<DaemonAttach, "release">,
	getSessionId: () => string,
): RelayWorkspaceUnregisterRetirement {
	let workspaceUnregistered = false;
	let releasePromise: Promise<void> | undefined;
	return {
		unregistered() {
			workspaceUnregistered = true;
		},
		async finalize() {
			if (!workspaceUnregistered) return;
			releasePromise ??= daemonAttach.release(getSessionId(), "workspace_unregistered");
			await releasePromise;
		},
	};
}

export interface RelayNotificationDeliveryForwarder {
	deliverNotification(
		clientNodeId: string,
		sessionId: string,
		notification: IrohRemotePushNotificationIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus>;
}

/**
 * TUI-side daemon integration façade. Ordinary best-effort methods resolve as
 * no-ops when the daemon is unavailable. Each lease is acquired and released
 * on its own: a TUI moving to another session releases the session it left
 * and acquires the one it opened.
 */
export interface DaemonAttach {
	/** Connect, resolve (or auto-register) the cwd workspace. Never throws. */
	start(): Promise<void>;
	/**
	 * Acquire the conversation lease of `sessionId`, which a reconnect then
	 * reacquires. `cwd` is the session's working directory when it differs from
	 * the last one: its workspace (and managed worktree) is resolved again, and
	 * registered when no workspace contains it. A `tentative` acquire, for a
	 * session the TUI has not opened yet, registers nothing and changes nothing
	 * when the daemon is unavailable or no registered workspace contains `cwd`.
	 */
	acquire(sessionId: string, cwd?: string, options?: { tentative?: boolean }): Promise<AcquireOutcome>;
	/** Publish path-free Git state only for the session leased by this exact connection. */
	publishGitObservation(sessionId: string, gitContext: RpcGitContext | null): Promise<void>;
	/** Release the lease of `sessionId`, in the workspace it was acquired in. */
	release(sessionId: string, reason?: LeaseReleaseReason): Promise<void>;
	/**
	 * Forward a relayed phone's intent or query that the daemon's state backs
	 * (push targets, workspace registration and worktrees, keep-awake, the web
	 * search key, the session list). Returns the daemon's outcome frame, or
	 * undefined when the daemon is unreachable or refused the relay.
	 */
	forwardRelayRpc(
		clientNodeId: string,
		sessionId: string,
		frame: ControlRelayFrame,
	): Promise<ControlRelayOutcome | undefined>;
	/** Deliver relayed completion pushes through the daemon-owned push backend. */
	relayNotificationDelivery: RelayNotificationDeliveryForwarder;
	/** Stop the daemon's turn in a session this TUI waits to acquire. */
	viewerAbort(viewerFeedId: string): Promise<void>;
	onRelayOffer(handler: (offer: DaemonRelayOffer, openRelay: () => Promise<OpenedRelay>) => void): void;
	onEvent(handler: (event: ControlEvent) => void): () => void;
	/** Re-acquire outcomes after a daemon reconnect (session.reload on warm). */
	onReacquired(handler: (sessionId: string, outcome: AcquireOutcome) => void): void;
	relayCount(): number;
	onRelayCountChange(callback: (count: number) => void): void;
	connectionState(): DaemonAttachConnectionState;
	workspaceName(): string | undefined;
	/** Live runtime ownership for sessions in a workspace, sourced from daemon status. */
	listRuntimeStates(workspaceName: string): Promise<ReadonlyMap<string, Exclude<LeaseState, "unowned">>>;
	dispose(): Promise<void>;
}

const NOOP_OUTCOME: AcquireOutcome = { kind: "noop" };

/** The TUI integrates with the daemon only where the daemon runs: not on Windows or in standalone builds. */
export function isDaemonAttachSupported(): boolean {
	return process.platform !== "win32" && !isStandaloneBinary;
}

/**
 * Resolve the registered workspace for a cwd against the daemon: longest
 * path-prefix match first, then (§5.2.2) a worktree_resolve lookup so a TUI
 * launched inside a daemon-managed worktree binds to the PARENT workspace
 * instead of auto-registering a bogus workspace under ~/.volt/agent/worktrees.
 * Only when both miss is the cwd auto-registered.
 */
export async function resolveDaemonWorkspaceForCwd(
	client: Pick<DaemonClient, "request">,
	cwd: string,
	log: (message: string) => void = () => {},
	options: { register?: boolean } = {},
): Promise<{ name: string; path: string; worktreeId?: string } | undefined> {
	const status = await client.request({ type: "status" });
	if (status.type !== "status_result") {
		return undefined;
	}
	const resolvedCwd = resolve(cwd);
	// A cwd inside a daemon-managed worktree belongs to the worktree's parent
	// workspace; auto-registering it would split lease keys from the daemon's
	// conversations for the same sessions.
	try {
		const resolved = await client.request({ type: "worktree_resolve", path: resolvedCwd });
		if (resolved.type === "worktree_resolve_result") {
			return { name: resolved.workspaceName, path: resolved.workspacePath, worktreeId: resolved.worktreeId };
		}
	} catch {
		// Old daemon (unknown request) or transient failure: fall through.
	}
	const match = status.workspaces
		.filter((workspace) => isPathInside(workspace.path, resolvedCwd))
		.sort((left, right) => right.path.length - left.path.length)[0];
	if (match) {
		return { name: match.name, path: match.path };
	}
	if (options.register === false) return undefined;
	// Auto-register the cwd so phones can reach sessions opened here.
	const takenNames = new Set(status.workspaces.map((workspace) => workspace.name));
	const base = basename(resolvedCwd) || "workspace";
	let candidate = base;
	for (let suffix = 2; takenNames.has(candidate); suffix++) {
		candidate = `${base}-${suffix}`;
	}
	const registered = await client.request({ type: "workspace_register", name: candidate, path: resolvedCwd });
	if (registered.type === "ok") {
		log(`registered workspace ${candidate} -> ${resolvedCwd}`);
		return { name: candidate, path: resolvedCwd };
	}
	return undefined;
}

/** Rehydrate the daemon-authorized relay snapshot without recomputing its workspace scope in the TUI. */
export function createTuiRelayAuthorization(
	authorization: RelayPreamble["authorization"],
): IrohRemoteClientAuthorizationSuccess {
	const rpcGrant = parseIrohRemoteRpcGrant(authorization.rpcGrant, "relay rpcGrant");
	return {
		ok: true,
		allowTools: authorization.allowedTools,
		client: {
			nodeId: authorization.clientNodeId,
			label: authorization.clientNodeId,
			allowedWorkspaces: authorization.workspaces.map((workspace) => workspace.name),
			allowedTools: authorization.allowedTools,
			rpcGrant,
			pairedAt: 0,
			lastSeenAt: 0,
		},
		paired: true,
		pairingSecretConsumed: false,
		workspace: { name: authorization.workspaceName, path: authorization.workspacePath },
		workspaceNames: [...authorization.workspaceNames],
		workspaces: authorization.workspaces.map((workspace) => ({ ...workspace })),
	};
}

/**
 * Sanitizer roots for serving a relayed conversation from the TUI: a
 * worktree-bound conversation sanitizes with the worktree checkout as the
 * root, and the parent checkout plus the worktrees root must ALSO redact
 * (bash output like `git worktree list` prints both). §5.2.3.
 */
export function getRelayServingSanitizerOptions(
	authorization: RelayPreamble["authorization"],
	agentDir: string,
): { remoteWorkspacePath?: string; workspacePath: string; additionalRedactedPaths?: string[] } {
	if (authorization.worktreePath === undefined) {
		return { workspacePath: authorization.workspacePath };
	}
	return {
		...(authorization.worktreeSourceRootRelativePath === undefined
			? {}
			: { remoteWorkspacePath: `/workspace/${authorization.worktreeSourceRootRelativePath}` }),
		workspacePath: authorization.worktreePath,
		additionalRedactedPaths: [authorization.workspacePath, getWorktreesRoot(agentDir)],
	};
}

export interface DaemonWorktreeControl {
	workspaceName: string;
	workspacePath: string;
	listWorktrees(): Promise<ControlWorktreeStatus[]>;
	createWorktree(name?: string): Promise<{ ok: true; worktree: ControlWorktreeStatus } | { ok: false; error: string }>;
	/** Best-effort: records the session→worktree binding in daemon state. */
	bindSession(worktreeId: string, sessionId: string): Promise<boolean>;
	close(): Promise<void>;
}

export interface OpenDaemonWorktreeControlOptions {
	cwd: string;
	agentDir: string;
	/** Injectable for tests; defaults to ensureDaemonRunning. */
	ensureDaemon?: (agentDir: string) => Promise<EnsureDaemonResult>;
}

/**
 * Control-plane handle for the TUI /worktree command (§5.2.1): ensures the
 * daemon is running, resolves (or registers) the parent workspace for the
 * cwd, and exposes worktree list/create/bind over the control socket.
 */
export async function openDaemonWorktreeControl(
	options: OpenDaemonWorktreeControlOptions,
): Promise<{ ok: true; control: DaemonWorktreeControl } | { ok: false; error: string }> {
	const ensureDaemon = options.ensureDaemon ?? ensureDaemonRunning;
	let ensured: EnsureDaemonResult;
	try {
		ensured = await ensureDaemon(options.agentDir);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!ensured.healthy) {
		return { ok: false, error: `voltd is not available (${ensured.state}); try \`volt daemon start\`` };
	}
	const client = createDaemonClient({
		socketPath: ensured.socketPath ?? getDaemonSocketPath(options.agentDir),
		client: "tui",
		version: VERSION,
		authToken: ensured.authToken,
		reconnect: false,
		capabilities: [CONTROL_WORKTREES_CAPABILITY, CONTROL_RPC_GRANTS_CAPABILITY],
	});
	try {
		await client.connect();
		const workspace = await resolveDaemonWorkspaceForCwd(client, options.cwd);
		if (!workspace) {
			await client.close();
			return { ok: false, error: "could not resolve or register a workspace for the current directory" };
		}
		const control: DaemonWorktreeControl = {
			workspaceName: workspace.name,
			workspacePath: workspace.path,
			async listWorktrees() {
				const response = await client.request({ type: "worktree_list", workspaceName: workspace.name });
				return response.type === "worktrees_result" ? response.worktrees : [];
			},
			async createWorktree(name?: string) {
				const response = await client.request({
					type: "worktree_create",
					workspaceName: workspace.name,
					...(name === undefined ? {} : { worktreeName: name }),
				});
				if (response.type === "worktree_result") {
					return { ok: true, worktree: response.worktree };
				}
				const error =
					response.type === "error" ? `${response.code}: ${response.message}` : "unexpected daemon response";
				return { ok: false, error };
			},
			async bindSession(worktreeId: string, sessionId: string) {
				try {
					const response = await client.request({
						type: "worktree_bind",
						workspaceName: workspace.name,
						worktreeId,
						sessionId,
					});
					return response.type === "ok";
				} catch {
					return false;
				}
			},
			close: () => client.close(),
		};
		return { ok: true, control };
	} catch (error) {
		await client.close().catch(() => {});
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function createDisabledDaemonAttach(): DaemonAttach {
	return {
		async start() {},
		async acquire() {
			return NOOP_OUTCOME;
		},
		async publishGitObservation() {},
		async release() {},
		async forwardRelayRpc() {
			return undefined;
		},
		relayNotificationDelivery: {
			async deliverNotification() {
				return "failed";
			},
		},
		async viewerAbort() {},
		onRelayOffer() {},
		onEvent() {
			return () => {};
		},
		onReacquired() {},
		relayCount() {
			return 0;
		},
		onRelayCountChange() {},
		connectionState() {
			return "disabled";
		},
		workspaceName() {
			return undefined;
		},
		async listRuntimeStates() {
			return new Map();
		},
		async dispose() {},
	};
}

/** The daemon would not hand an existing session to this TUI. */
export class DaemonLeaseUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaemonLeaseUnavailableError";
	}
}

/** Controls for a lease that waits for the daemon's current turn to finish. */
export interface DaemonLeaseWait {
	/** Stop the daemon's running turn (a non-destructive abort), so the lease is granted when it ends. */
	abortRemoteTurn(): void;
	/** Stop waiting and do not open the session; the daemon keeps it. */
	cancel(): void;
}

export interface OpenSessionWithDaemonLeaseOptions {
	/** Create the daemon integration for the session's workspace; the caller owns what is returned. */
	createAttach: () => DaemonAttach;
	/**
	 * Called once when the lease waits for the daemon's current turn to finish.
	 * Returns a function that ends what the wait started (for example, key input).
	 */
	onWaiting: (wait: DaemonLeaseWait) => () => void;
}

/**
 * Take the conversation lease of `sessionId` before the session is opened for
 * writing. While the daemon hosts the session, its runtime holds the session's
 * lock; granting the lease disposes that runtime, which frees the lock. A
 * pending lease waits for the daemon's current turn through `onWaiting`. A
 * denied lease (another TUI has the session open), a cancelled wait, or a
 * handoff the daemon could not finish throws `DaemonLeaseUnavailableError`;
 * the caller releases the lease then, which also cancels a pending handoff.
 * Resolves whether a lease was taken (none without a daemon).
 */
export async function acquireDaemonLease(
	attach: DaemonAttach,
	sessionId: string,
	options: { cwd?: string; tentative?: boolean; onWaiting: (wait: DaemonLeaseWait) => () => void },
): Promise<boolean> {
	const outcome = options.tentative
		? await attach.acquire(sessionId, options.cwd, { tentative: true })
		: await attach.acquire(sessionId, options.cwd);
	if (outcome.kind === "denied") {
		throw new DaemonLeaseUnavailableError(
			`Session ${sessionId} is open in another Volt window (${outcome.reason}). Quit it there, then retry.`,
		);
	}
	if (outcome.kind === "pending") {
		let cancelOpen = (): void => {};
		const cancelled = new Promise<never>((_, reject) => {
			cancelOpen = () =>
				reject(new DaemonLeaseUnavailableError(`Cancelled opening session ${sessionId}; the daemon keeps it.`));
		});
		cancelled.catch(() => {});
		const endWait = options.onWaiting({
			abortRemoteTurn: () => {
				void attach.viewerAbort(outcome.viewerFeedId);
			},
			cancel: () => cancelOpen(),
		});
		try {
			await Promise.race([
				outcome.granted.catch((error: unknown) => {
					throw new DaemonLeaseUnavailableError(
						`Could not take session ${sessionId} over from the daemon: ${error instanceof Error ? error.message : String(error)}`,
					);
				}),
				cancelled,
			]);
		} finally {
			endWait();
		}
	}
	return outcome.kind !== "noop";
}

/**
 * Open an existing session for writing from the TUI at startup, taking its
 * daemon conversation lease first (see `acquireDaemonLease`). Returns the
 * integration still holding the lease, or none when no daemon lease was taken.
 */
export async function openSessionWithDaemonLease(
	ref: SessionReference,
	options: OpenSessionWithDaemonLeaseOptions,
): Promise<{ manager: SessionManager; attach?: DaemonAttach }> {
	const attach = options.createAttach();
	try {
		await attach.start();
		const leased = await acquireDaemonLease(attach, ref.sessionId, { onWaiting: options.onWaiting });
		const manager = await SessionManager.open(ref);
		if (leased) return { manager, attach };
		await attach.dispose();
		return { manager };
	} catch (error) {
		await attach.dispose().catch(() => {});
		throw error;
	}
}

export interface CreateDaemonAttachOptions {
	cwd: string;
	agentDir: string;
	/** Auto-spawn the daemon when unreachable (remote.background). */
	autoStart?: boolean;
	log?: (message: string) => void;
}

export function createDaemonAttach(options: CreateDaemonAttachOptions): DaemonAttach {
	let client: DaemonClient | undefined;
	let state: DaemonAttachConnectionState = "reconnecting";
	let connectionGeneration = 0;
	let resolvedWorkspaceName: string | undefined;
	let resolvedContextCwd = options.cwd;
	let resolvedWorktreeId: string | undefined;
	let boundWorktreeSessionId: string | undefined;
	let activeRelays = 0;
	/** Active relays by phone and session, with the workspace each was offered in. */
	const activeRelayIds = new Map<string, { relayId: string; workspaceName: string }>();
	/** The session a reconnect reacquires: the last one acquired and not released. */
	let currentSessionId: string | undefined;
	/** Leases requested on this connection, with the workspace each was requested in and whether it is held. */
	const leases = new Map<string, { workspaceName: string; held: boolean }>();
	let disposed = false;
	let resolvingWorkspace: Promise<void> | undefined;
	const eventHandlers = new Set<(event: ControlEvent) => void>();
	const relayCountCallbacks = new Set<(count: number) => void>();
	let relayOfferHandler: ((offer: DaemonRelayOffer, openRelay: () => Promise<OpenedRelay>) => void) | undefined;
	let reacquiredHandler: ((sessionId: string, outcome: AcquireOutcome) => void) | undefined;

	const log = options.log ?? (() => {});

	const setRelayCount = (next: number) => {
		if (next === activeRelays) {
			return;
		}
		activeRelays = next;
		for (const callback of Array.from(relayCountCallbacks)) {
			callback(next);
		}
	};

	const parseAcquireResponse = (
		response: { type: string } & Record<string, unknown>,
		waitForResponse: (id: string) => Promise<{ type: string } & Record<string, unknown>>,
	): AcquireOutcome => {
		if (response.type === "lease_granted") {
			return { kind: "granted", handoff: response.handoff as "cold" | "warm" | "none" };
		}
		if (response.type === "lease_denied") {
			return { kind: "denied", reason: String(response.reason) };
		}
		if (response.type === "lease_pending") {
			const id = String(response.id);
			return {
				kind: "pending",
				viewerFeedId: String(response.viewerFeedId),
				granted: waitForResponse(id).then((terminal) => {
					if (terminal.type === "lease_granted") {
						return { handoff: terminal.handoff as "cold" | "warm" | "none" };
					}
					throw new Error(typeof terminal.message === "string" ? terminal.message : "lease drain failed");
				}),
			};
		}
		return NOOP_OUTCOME;
	};

	const trackAcquireOutcome = (sessionId: string, workspaceName: string, outcome: AcquireOutcome): void => {
		if (outcome.kind === "granted") {
			leases.set(sessionId, { workspaceName, held: true });
			return;
		}
		if (outcome.kind === "pending") {
			const lease = { workspaceName, held: false };
			leases.set(sessionId, lease);
			const generation = connectionGeneration;
			void outcome.granted.then(
				() => {
					// A connection that dropped meanwhile released every lease it held.
					if (generation === connectionGeneration && leases.get(sessionId) === lease) lease.held = true;
				},
				() => {
					if (leases.get(sessionId) === lease) leases.delete(sessionId);
				},
			);
			return;
		}
		leases.delete(sessionId);
	};

	const relayKey = (clientNodeId: string, sessionId: string) => `${clientNodeId}\0${sessionId}`;

	// The daemon offers relays only for leases this connection holds; the TUI
	// serves the ones for the session it shows.
	const handleRelayOffer = (offer: DaemonRelayOffer) => {
		const handler = relayOfferHandler;
		const activeClient = client;
		if (!handler || !activeClient) {
			return;
		}
		handler(offer, async () => {
			const opened = await activeClient.openRelay({ relayId: offer.relayId, relayToken: offer.relayToken });
			const key = relayKey(offer.clientNodeId, offer.sessionId);
			activeRelayIds.set(key, { relayId: offer.relayId, workspaceName: offer.workspaceName });
			setRelayCount(activeRelays + 1);
			let finished = false;
			const finish = () => {
				if (!finished) {
					finished = true;
					if (activeRelayIds.get(key)?.relayId === offer.relayId) {
						activeRelayIds.delete(key);
					}
					setRelayCount(Math.max(0, activeRelays - 1));
				}
			};
			opened.stream.once("close", finish);
			return { preamble: opened.preamble, stream: opened.stream, finished: finish };
		});
	};

	const resolveWorkspace = async (): Promise<void> => {
		if (resolvedWorkspaceName) return;
		if (resolvingWorkspace) {
			return resolvingWorkspace;
		}
		resolvingWorkspace = (async () => {
			const activeClient = client;
			if (!activeClient) {
				return;
			}
			const cwd = resolvedContextCwd;
			const workspace = await resolveDaemonWorkspaceForCwd(activeClient, cwd, log);
			// A session in another directory may have moved the context meanwhile.
			if (workspace && cwd === resolvedContextCwd) {
				resolvedWorkspaceName = workspace.name;
				resolvedWorktreeId = workspace.worktreeId;
			}
		})().finally(() => {
			resolvingWorkspace = undefined;
		});
		return resolvingWorkspace;
	};

	/**
	 * Point the workspace context at `cwd`; its workspace and managed worktree
	 * resolve again. A tentative retarget registers no workspace and keeps the
	 * context unless a registered workspace contains `cwd`. Resolves whether the
	 * context is `cwd`'s.
	 */
	const retargetContext = async (cwd: string, tentative: boolean): Promise<boolean> => {
		await resolvingWorkspace?.catch(() => {});
		if (resolve(cwd) === resolve(resolvedContextCwd)) return true;
		const activeClient = client;
		if (tentative) {
			if (!activeClient || state !== "connected") return false;
			const workspace = await resolveDaemonWorkspaceForCwd(activeClient, cwd, log, { register: false });
			if (!workspace) return false;
			resolvedContextCwd = cwd;
			resolvedWorkspaceName = workspace.name;
			resolvedWorktreeId = workspace.worktreeId;
			boundWorktreeSessionId = undefined;
			return true;
		}
		resolvedContextCwd = cwd;
		resolvedWorkspaceName = undefined;
		resolvedWorktreeId = undefined;
		boundWorktreeSessionId = undefined;
		if (state === "connected") await resolveWorkspace();
		return true;
	};

	const ensureWorktreeBinding = async (
		activeClient: DaemonClient,
		workspaceName: string,
		sessionId: string,
		acquireLease = true,
	): Promise<boolean> => {
		if (!resolvedWorktreeId || (boundWorktreeSessionId === sessionId && !acquireLease)) return true;
		const response = await activeClient.request({
			type: "worktree_bind",
			workspaceName,
			worktreeId: resolvedWorktreeId,
			sessionId,
			acquireLease,
		});
		if (response.type !== "ok") return false;
		boundWorktreeSessionId = sessionId;
		return true;
	};

	const ensureLeaseAfterConnected = async (): Promise<void> => {
		await resolveWorkspace();
		const sessionId = currentSessionId;
		const workspaceName = resolvedWorkspaceName;
		const activeClient = client;
		if (!sessionId || !workspaceName || !activeClient || !reacquiredHandler) {
			return;
		}
		try {
			if (!(await ensureWorktreeBinding(activeClient, workspaceName, sessionId))) {
				const outcome: AcquireOutcome = { kind: "denied", reason: "worktree_busy" };
				trackAcquireOutcome(sessionId, workspaceName, outcome);
				reacquiredHandler(sessionId, outcome);
				return;
			}
			const response = await activeClient.request({ type: "lease_acquire", workspaceName, sessionId });
			const outcome = parseAcquireResponse(
				response as { type: string } & Record<string, unknown>,
				(id) => activeClient.waitForResponse(id) as Promise<{ type: string } & Record<string, unknown>>,
			);
			trackAcquireOutcome(sessionId, workspaceName, outcome);
			reacquiredHandler(sessionId, outcome);
		} catch {
			// The next reconnect retries.
		}
	};

	return {
		async start() {
			if (disposed) {
				return;
			}
			try {
				const ensured = options.autoStart
					? await ensureDaemonRunning(options.agentDir)
					: await probeDaemon(options.agentDir);
				if (disposed) {
					return;
				}
				const socketPath = ensured.socketPath;
				if (options.autoStart && ensured.state === "protocol-mismatch") {
					state = "gone";
					return;
				}
				const startingClient = createDaemonClient({
					socketPath: socketPath ?? getDaemonSocketPath(options.agentDir),
					client: "tui",
					version: VERSION,
					authToken: ensured.authToken,
					refreshEndpoint: () => readPublishedDaemonEndpoint(options.agentDir),
					capabilities: [CONTROL_WORKTREES_CAPABILITY, CONTROL_RPC_GRANTS_CAPABILITY],
					reconnect: true,
					onEvent: (event) => {
						if (event.type === "relay_offer") {
							handleRelayOffer(event);
						}
						// relay_closed: the socket close callback decrements the count;
						// nothing to do beyond fanning the event out.
						if (event.type === "daemon_shutdown") {
							setRelayCount(0);
						}
						for (const handler of Array.from(eventHandlers)) {
							handler(event);
						}
					},
					onConnectionStateChange: (next) => {
						state = next;
						if (next !== "connected") {
							connectionGeneration++;
							// The daemon releases every lease of a lost connection.
							leases.clear();
						}
						if (next === "connected") {
							void ensureLeaseAfterConnected().catch(() => {});
						}
					},
				});
				client = startingClient;
				await startingClient.connect();
				if (disposed || client !== startingClient) {
					await startingClient.close();
					return;
				}
				state = "connected";
				await ensureLeaseAfterConnected();
			} catch (error) {
				log(`daemon unavailable: ${error instanceof Error ? error.message : String(error)}`);
				state = client?.connectionState ?? "gone";
			}
		},
		async acquire(sessionId: string, cwd?: string, acquireOptions: { tentative?: boolean } = {}) {
			const tentative = acquireOptions.tentative === true;
			if (cwd !== undefined) {
				try {
					if (!(await retargetContext(cwd, tentative))) return NOOP_OUTCOME;
				} catch {
					return NOOP_OUTCOME;
				}
			}
			const workspaceName = resolvedWorkspaceName;
			const activeClient = client;
			if (tentative && (!activeClient || !workspaceName || state !== "connected")) {
				return NOOP_OUTCOME;
			}
			currentSessionId = sessionId;
			if (!activeClient || !workspaceName || state !== "connected") {
				return NOOP_OUTCOME;
			}
			try {
				if (!(await ensureWorktreeBinding(activeClient, workspaceName, sessionId))) {
					return { kind: "denied", reason: "worktree_busy" };
				}
				const response = await activeClient.request({ type: "lease_acquire", workspaceName, sessionId });
				const outcome = parseAcquireResponse(
					response as { type: string } & Record<string, unknown>,
					(id) => activeClient.waitForResponse(id) as Promise<{ type: string } & Record<string, unknown>>,
				);
				trackAcquireOutcome(sessionId, workspaceName, outcome);
				return outcome;
			} catch {
				return NOOP_OUTCOME;
			}
		},
		async publishGitObservation(sessionId: string, gitContext: RpcGitContext | null) {
			const lease = leases.get(sessionId);
			const activeClient = client;
			if (!activeClient || !lease?.held || state !== "connected" || currentSessionId !== sessionId) {
				return;
			}
			const branchContext =
				gitContext && !gitContext.stale && gitContext.head.kind === "branch"
					? {
							repository: gitContext.repository,
							branch: gitContext.head.name,
							headOid: gitContext.head.oid,
							...(gitContext.base === null ? {} : { baseRef: gitContext.base.ref }),
						}
					: null;
			try {
				await activeClient.request({
					type: "work_observe",
					workspaceName: lease.workspaceName,
					sessionId,
					gitContext: branchContext,
				});
			} catch {
				// Observation publication is best-effort; lease recovery republishes.
			}
		},
		async release(sessionId: string, reason = "quit") {
			if (currentSessionId === sessionId) {
				currentSessionId = undefined;
			}
			const workspaceName = leases.get(sessionId)?.workspaceName ?? resolvedWorkspaceName;
			leases.delete(sessionId);
			const activeClient = client;
			if (!activeClient || !workspaceName) {
				return;
			}
			try {
				await activeClient.request({ type: "lease_release", workspaceName, sessionId, reason });
			} catch {
				// Daemon-side implicit release on disconnect covers this.
			}
		},
		async forwardRelayRpc(clientNodeId: string, sessionId: string, frame: ControlRelayFrame) {
			const activeClient = client;
			const relay = activeRelayIds.get(relayKey(clientNodeId, sessionId));
			if (!activeClient || !relay) {
				return undefined;
			}
			try {
				const response = await activeClient.request({
					type: "relay_rpc",
					relayId: relay.relayId,
					clientNodeId,
					workspaceName: relay.workspaceName,
					sessionId,
					frame,
				});
				return response.type === "relay_rpc_result" ? response.frame : undefined;
			} catch {
				return undefined;
			}
		},
		relayNotificationDelivery: {
			async deliverNotification(clientNodeId, sessionId, notification) {
				const workspaceName =
					activeRelayIds.get(relayKey(clientNodeId, sessionId))?.workspaceName ??
					leases.get(sessionId)?.workspaceName ??
					resolvedWorkspaceName;
				const activeClient = client;
				// The daemon admits only canonical intents; anything else fails without a round trip.
				if (!activeClient || !workspaceName || !ControlValidators.notification.Check(notification)) {
					return "failed";
				}
				try {
					const response = await activeClient.request({
						type: "relay_notification_delivery",
						clientNodeId,
						workspaceName,
						sessionId,
						notification,
					});
					return response.type === "relay_push_delivery_result" ? response.status : "failed";
				} catch {
					return "failed";
				}
			},
		},
		async viewerAbort(viewerFeedId: string) {
			try {
				await client?.request({ type: "viewer_abort", viewerFeedId });
			} catch {
				// Best-effort.
			}
		},
		onRelayOffer(handler) {
			relayOfferHandler = handler;
		},
		onEvent(handler) {
			eventHandlers.add(handler);
			return () => {
				eventHandlers.delete(handler);
			};
		},
		onReacquired(handler) {
			reacquiredHandler = handler;
		},
		relayCount() {
			return activeRelays;
		},
		onRelayCountChange(callback) {
			relayCountCallbacks.add(callback);
		},
		connectionState() {
			return state;
		},
		workspaceName() {
			return resolvedWorkspaceName;
		},
		async listRuntimeStates(workspaceName: string) {
			const states = new Map<string, Exclude<LeaseState, "unowned">>();
			const activeClient = client;
			if (!activeClient || state !== "connected") {
				return states;
			}
			try {
				const response = await activeClient.request({ type: "status" });
				if (response.type !== "status_result") {
					return states;
				}
				for (const lease of response.leases) {
					if (lease.workspaceName === workspaceName && lease.state !== "unowned") {
						states.set(lease.sessionId, lease.state);
					}
				}
			} catch {
				// Presence is best-effort; list_sessions remains available from local state.
			}
			return states;
		},
		async dispose() {
			disposed = true;
			currentSessionId = undefined;
			leases.clear();
			activeRelayIds.clear();
			await client?.close();
			client = undefined;
			state = "gone";
		},
	};
}
