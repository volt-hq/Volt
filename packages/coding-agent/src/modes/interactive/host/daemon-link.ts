/**
 * The TUI host's link to the daemon (live-shared session daemon design): one
 * control connection that leases the conversation the TUI shows, receives the
 * relays of the phones that reach it, forwards their daemon-backed intents
 * and completion pushes, and publishes the session's Git observation.
 *
 * A conversation lease frees the session's lock when the daemon hosts it, so
 * the TUI takes the lease before it opens a stored session (at startup, and
 * through the host's open gate on a resume) and gives a session's lease back
 * only once it closed it. Until conversations run in workers (architecture
 * rewrite Phase 7), leaving a conversation releases its lease and the lease of
 * the next one is acquired, instead of rekeying.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { ControlRelayFrame, ControlRelayOutcome, HostRequest } from "@hansjm10/volt-protocol";
import type { RpcGitContext } from "@hansjm10/volt-protocol/git-context";
import { getAgentDir, VERSION } from "../../../config.ts";
import { GitContextObservationBinding } from "../../../core/git-context-provider.ts";
import type { ConversationHost, OpenGate, OpenGateHold } from "../../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../../core/host/hosted-conversation.ts";
import type { ConversationTarget, HostClient } from "../../../core/host/targets.ts";
import type {
	IrohRemotePushNotificationDeliveryStatus,
	IrohRemotePushNotificationIntent,
} from "../../../core/remote/iroh/push.ts";
import { findSessionInfoById, SessionManager, type SessionReference } from "../../../core/session-manager.ts";
import { createDaemonClient, type DaemonClient } from "../../../daemon/control-client.ts";
import {
	CONTROL_RPC_GRANTS_CAPABILITY,
	CONTROL_WORKTREES_CAPABILITY,
	type ControlEvent,
	ControlValidators,
	type LeaseReleaseReason,
	type PhoneRelayPreamble,
} from "../../../daemon/control-protocol.ts";
import { getDaemonSocketPath } from "../../../daemon/paths.ts";
import { ensureDaemonRunning, probeDaemon, readPublishedDaemonEndpoint } from "../../../daemon/spawn.ts";
import { servePhoneRelay } from "../../../daemon/worker/serve-phone.ts";
import { resolveDaemonWorkspaceForCwd } from "../worktree-control.ts";

export type DaemonLinkState = "connected" | "reconnecting" | "gone" | "disabled";

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
	preamble: PhoneRelayPreamble;
	stream: Duplex;
	/** Mark the relay finished locally (updates the relay count). */
	finished(): void;
}

export interface RelayNotificationDeliveryForwarder {
	deliverNotification(
		clientNodeId: string,
		sessionId: string,
		notification: IrohRemotePushNotificationIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus>;
}

/**
 * The TUI host's daemon connection. Ordinary best-effort methods resolve as
 * no-ops when the daemon is unavailable. Each lease is acquired and released
 * on its own: a TUI moving to another session releases the session it left
 * and acquires the one it opened.
 */
export interface DaemonLink {
	/** Connect, resolve (or auto-register) the cwd workspace. Later calls join the first. Never throws. */
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
	/** Phones relayed through this link and served now. */
	relayCount(): number;
	connectionState(): DaemonLinkState;
	workspaceName(): string | undefined;
	dispose(): Promise<void>;
}

const NOOP_OUTCOME: AcquireOutcome = { kind: "noop" };

export function createDisabledDaemonLink(): DaemonLink {
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
		connectionState() {
			return "disabled";
		},
		workspaceName() {
			return undefined;
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
export interface LeaseWait {
	/** Stop the daemon's running turn (a non-destructive abort), so the lease is granted when it ends. */
	abortRemoteTurn(): void;
	/** Stop waiting and do not open the session; the daemon keeps it. */
	cancel(): void;
}

export interface OpenSessionWithDaemonLeaseOptions {
	/** Create the daemon link for the session's workspace; the caller owns what is returned. */
	createLink: () => DaemonLink;
	/**
	 * Called once when the lease waits for the daemon's current turn to finish.
	 * Returns a function that ends what the wait started (for example, key input).
	 */
	onWaiting: (wait: LeaseWait) => () => void;
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
	link: DaemonLink,
	sessionId: string,
	options: { cwd?: string; tentative?: boolean; onWaiting: (wait: LeaseWait) => () => void },
): Promise<boolean> {
	const outcome = options.tentative
		? await link.acquire(sessionId, options.cwd, { tentative: true })
		: await link.acquire(sessionId, options.cwd);
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
				void link.viewerAbort(outcome.viewerFeedId);
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
 * daemon conversation lease first (see `acquireDaemonLease`). Returns the link
 * still holding the lease, or none when no daemon lease was taken.
 */
export async function openSessionWithDaemonLease(
	ref: SessionReference,
	options: OpenSessionWithDaemonLeaseOptions,
): Promise<{ manager: SessionManager; link?: DaemonLink }> {
	const link = options.createLink();
	try {
		await link.start();
		const leased = await acquireDaemonLease(link, ref.sessionId, { onWaiting: options.onWaiting });
		const manager = await SessionManager.open(ref);
		if (leased) return { manager, link };
		await link.dispose();
		return { manager };
	} catch (error) {
		await link.dispose().catch(() => {});
		throw error;
	}
}

export interface CreateDaemonLinkOptions {
	cwd: string;
	agentDir: string;
	/** Auto-spawn the daemon when unreachable. */
	autoStart?: boolean;
	log?: (message: string) => void;
}

export function createDaemonLink(options: CreateDaemonLinkOptions): DaemonLink {
	let client: DaemonClient | undefined;
	let state: DaemonLinkState = "reconnecting";
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
	let starting: Promise<void> | undefined;
	let resolvingWorkspace: Promise<void> | undefined;
	const eventHandlers = new Set<(event: ControlEvent) => void>();
	let relayOfferHandler: ((offer: DaemonRelayOffer, openRelay: () => Promise<OpenedRelay>) => void) | undefined;
	let reacquiredHandler: ((sessionId: string, outcome: AcquireOutcome) => void) | undefined;

	const log = options.log ?? (() => {});

	const setRelayCount = (next: number) => {
		activeRelays = next;
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
			// The daemon offers a TUI phones only.
			if (opened.preamble.kind !== "phone") {
				opened.stream.destroy();
				throw new Error("The daemon relayed a client the TUI does not serve");
			}
			const preamble = opened.preamble;
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
			return { preamble, stream: opened.stream, finished: finish };
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
			const workspace = await resolveDaemonWorkspaceForCwd(activeClient, cwd);
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
			const workspace = await resolveDaemonWorkspaceForCwd(activeClient, cwd);
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

	const connect = async (): Promise<void> => {
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
					if (event.type === "relay_offer" && event.clientKind === "phone") {
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
	};

	return {
		start() {
			starting ??= connect();
			return starting;
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
					type: "change_observe",
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
		connectionState() {
			return state;
		},
		workspaceName() {
			return resolvedWorkspaceName;
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

/** How long a lease handover waits for the phones relayed into the session the TUI left to hear where to reconnect. */
const RELAY_END_TIMEOUT_MS = 2000;

/** An open the leases have nothing to hold for. */
const NO_HOLD: OpenGateHold = { commit() {}, async abort() {} };

const STOP_REMOTE_TURN_ACTION = "stop_remote_turn";
const CANCEL_ACTION = "cancel";

/** The dialog that asks the client opening `sessionId` to wait for the daemon's turn there. */
function leaseWaitDialog(sessionId: string, stopping: boolean): HostRequest {
	return stopping
		? {
				kind: "dialog",
				title: `Stopping the remote turn in session ${sessionId}...`,
				body: [{ type: "text", text: "The session opens here once that turn ends.", token: "muted" }],
				actions: [{ id: CANCEL_ACTION, label: "Cancel" }],
			}
		: {
				kind: "dialog",
				title: `Waiting for the remote turn in session ${sessionId} to finish before opening it here`,
				body: [
					{
						type: "text",
						text: "Stop that turn to open the session now, or cancel to leave the session with the daemon.",
						token: "muted",
					},
				],
				actions: [
					{ id: STOP_REMOTE_TURN_ACTION, label: "Stop remote turn", destructive: true },
					{ id: CANCEL_ACTION, label: "Cancel" },
				],
			};
}

export interface DaemonLeasesOptions {
	/** The link that took the startup conversation's lease before the conversation opened. */
	readonly link?: DaemonLink;
	/** Otherwise the link to serve through, created for the conversation the TUI shows when the leases start. */
	readonly createLink: (conversation: HostedConversation) => DaemonLink;
}

/** What the leases serve: the TUI's host and the conversation its client shows. */
export interface DaemonLeasesServing {
	readonly host: ConversationHost;
	/** The conversation the TUI shows. */
	readonly shown: () => HostedConversation;
	/** False once the TUI quits or its conversation lost its log: leases stop following moves, and relays are refused. */
	readonly serving: () => boolean;
}

/**
 * The TUI host's daemon leases: the lease of the conversation the TUI shows,
 * taken at startup and after every move, and reacquired on reconnect; the
 * host's open gate, which takes a stored session's lease before the session
 * opens; the phones relayed into the shown conversation; and its Git
 * observation. Lease changes run one at a time, in order.
 */
export class DaemonLeases {
	/** The host's open gate: a resume takes the target's lease before the target opens. */
	readonly openGate: OpenGate;
	private readonly createLink: (conversation: HostedConversation) => DaemonLink;
	private link: DaemonLink | undefined;
	private served: DaemonLeasesServing | undefined;
	private stopFollowing: (() => void) | undefined;
	/**
	 * Lease handovers, in order: once the TUI left a session, its relays end, its
	 * lease is released, and the lease of the session the TUI shows is acquired.
	 */
	private tail: Promise<void> = Promise.resolve();
	/** A resume that holds its target's lease while it opens: relay offers for the target wait for it. */
	private pendingSwitch: { readonly sessionId: string; readonly settled: Promise<void> } | undefined;
	/** Relayed phone conversations being served, with the session each stays on. */
	private readonly relays = new Map<Promise<void>, string>();
	private readonly gitObservation: GitContextObservationBinding;
	/** The conversation whose Git observation is published: while it is the one the TUI shows. */
	private observed: HostedConversation | undefined;
	private readonly eventListeners = new Set<(event: ControlEvent) => void>();
	private disposed: Promise<void> | undefined;

	constructor(options: DaemonLeasesOptions) {
		this.createLink = options.createLink;
		this.openGate = (target, client) => this.gate(target, client);
		this.gitObservation = new GitContextObservationBinding((observation) => {
			const observed = this.observed;
			if (observation.status !== "definitive" || !observed || observed !== this.served?.shown()) return;
			void this.link?.publishGitObservation(observed.id, observation.gitContext);
		});
		if (options.link) this.adopt(options.link);
	}

	/**
	 * Serve `served`: connect the link, acquire the lease of the conversation
	 * the TUI shows, serve the phones relayed into it, and follow the TUI's
	 * moves. Resolves the startup lease outcome.
	 */
	async start(served: DaemonLeasesServing): Promise<AcquireOutcome> {
		if (this.served) throw new Error("The daemon leases already serve a host");
		this.served = served;
		const link = this.link ?? this.adopt(this.createLink(served.shown()));
		link.onRelayOffer((offer, openRelay) => void this.serveRelay(offer, openRelay));
		link.onReacquired((_sessionId, outcome) => void this.reacquired(outcome));
		await link.start();
		const outcome = await this.acquireShown();
		this.bindGitObservation();
		// The TUI leaves a conversation by closing it; the lease follows once it closed.
		this.stopFollowing = served.host.onClosed(({ id }) => {
			void this.queue(() => this.handOver(id)).catch(() => undefined);
		});
		return outcome;
	}

	/** Phones relayed into the conversations the TUI hosts and served now. */
	relayCount(): number {
		return this.link?.relayCount() ?? 0;
	}

	/** The daemon events the link receives. */
	onEvent(listener: (event: ControlEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	/** The daemon workspace of the conversation the TUI shows, once resolved. */
	workspaceName(): string | undefined {
		return this.link?.workspaceName();
	}

	/**
	 * Stop serving: the lease of the conversation the TUI showed goes back to
	 * the daemon once the phones relayed into it heard where to reconnect, and
	 * the link closes. Later calls join the first.
	 */
	dispose(): Promise<void> {
		this.disposed ??= (async () => {
			this.stopFollowing?.();
			this.gitObservation.dispose();
			const link = this.link;
			if (!link || link.connectionState() === "disabled") return;
			try {
				const shown = this.served?.shown();
				if (shown) {
					await this.waitForRelaysToEnd(shown.id);
					await link.release(shown.id);
				}
				await link.dispose();
			} catch {
				// Daemon-side implicit release on disconnect covers any failure here.
			}
		})();
		return this.disposed;
	}

	private adopt(link: DaemonLink): DaemonLink {
		this.link = link;
		link.onEvent((event) => {
			for (const listener of [...this.eventListeners]) listener(event);
		});
		return link;
	}

	/**
	 * Point the daemon lease at the conversation the TUI shows. The TUI holds
	 * the session's lock, so the daemon cannot host the session: the lease is
	 * granted without a handoff or denied, never pending, and nothing else
	 * wrote the session.
	 */
	private async acquireShown(): Promise<AcquireOutcome> {
		const link = this.link;
		const shown = this.served?.shown();
		if (!link || !shown || link.connectionState() === "disabled") return NOOP_OUTCOME;
		const outcome = await link.acquire(shown.id, shown.cwd);
		if (outcome.kind === "denied") {
			// Multi-TUI is a non-goal: another TUI holds the lease. Phones cannot
			// reach this session through the daemon until it is released.
			shown.liveState.notice(
				"warning",
				"This conversation is open in another desktop window; live sharing is disabled here.",
			);
		}
		return outcome;
	}

	private bindGitObservation(): void {
		const shown = this.served?.shown();
		if (!shown || !this.link || this.link.connectionState() === "disabled") return;
		this.observed = shown;
		this.gitObservation.bind(shown.session.gitContextProvider);
	}

	/** A reconnect reacquired the lease: the conversation's queued input is recovered, and its Git state republished. */
	private async reacquired(outcome: AcquireOutcome): Promise<void> {
		const shown = this.served?.shown();
		if (outcome.kind !== "granted" || !shown) return;
		await shown.startRecoveredClientInputs().catch(() => undefined);
		void shown.session.gitContextProvider.refresh();
	}

	/**
	 * The TUI left `closedSessionId`, which closed and released its log. The
	 * phones relayed into it end first, told to reconnect; then its lease is
	 * released, so the daemon hosts it for them, and the lease of the session
	 * the TUI shows now is acquired. A quitting TUI releases its lease itself.
	 */
	private async handOver(closedSessionId: string): Promise<void> {
		await this.waitForRelaysToEnd(closedSessionId);
		const served = this.served;
		const link = this.link;
		if (!served || !link || !served.serving() || served.shown().id === closedSessionId) return;
		await link.release(closedSessionId, "switch");
		await this.acquireShown();
		this.bindGitObservation();
	}

	/** Run lease work after the handovers before it, so leases change in order. */
	private queue(work: () => Promise<void>): Promise<void> {
		const queued = this.tail.then(work);
		this.tail = queued.catch(() => undefined);
		return queued;
	}

	/** Wait, briefly, for the relays serving `sessionId` to write their final frame and close. */
	private async waitForRelaysToEnd(sessionId: string): Promise<void> {
		const servers = [...this.relays].flatMap(([server, served]) => (served === sessionId ? [server] : []));
		if (servers.length === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, RELAY_END_TIMEOUT_MS);
			timer.unref?.();
		});
		await Promise.race([Promise.allSettled(servers), timeout]);
		clearTimeout(timer);
	}

	/** Serve a relay offer for the conversation the TUI shows; an offer for any other session expires. */
	private async serveRelay(offer: DaemonRelayOffer, openRelay: () => Promise<OpenedRelay>): Promise<void> {
		// A resume holding its target's lease serves the target's phones once it switched.
		const pending = this.pendingSwitch;
		if (pending?.sessionId === offer.sessionId) await pending.settled;
		const served = this.served;
		const link = this.link;
		// The daemon tells the phone of an expired offer to retry.
		if (!served || !link || !served.serving()) return;
		const conversation = served.shown();
		if (offer.sessionId !== conversation.id) return;
		const server = (async () => {
			// The conversation is closing: the TUI is leaving it.
			if (conversation.closed) return;
			let relay: OpenedRelay;
			try {
				relay = await openRelay();
			} catch {
				return;
			}
			const clientNodeId = relay.preamble.authorization.clientNodeId;
			await servePhoneRelay({
				host: served.host,
				conversation,
				relay,
				agentDir: getAgentDir(),
				daemon: {
					forward: (frame) => link.forwardRelayRpc(clientNodeId, conversation.id, frame),
					deliverNotification: (notification) =>
						link.relayNotificationDelivery.deliverNotification(clientNodeId, conversation.id, notification),
					// A phone that unregistered the workspace retires the session's lease once it is answered.
					unregistered: () => link.release(conversation.id, "workspace_unregistered"),
				},
			});
		})();
		this.relays.set(server, conversation.id);
		void server.finally(() => this.relays.delete(server));
		await server;
	}

	/**
	 * The open gate. A stored session the TUI's client (the anchor of its
	 * conversations) resumes may be hosted by the daemon, and granting its
	 * lease frees its lock, so the lease is taken first. A pending lease waits for the daemon's turn, asking the
	 * client through a dialog only it answers; cancelling the wait cancels the
	 * open. A session in no registered workspace needs no lease (the daemon
	 * cannot host it); its workspace is registered once the TUI opened it. A
	 * refused lease fails the open. An open that does not happen hands the
	 * target's lease back and points the daemon at the session the TUI still
	 * shows.
	 */
	private async gate(
		target: ConversationTarget,
		client: HostClient,
	): Promise<OpenGateHold | { readonly cancelled: true }> {
		const served = this.served;
		const link = this.link;
		if (
			!served ||
			!link ||
			target.kind !== "session" ||
			client.anchor !== true ||
			link.connectionState() === "disabled"
		) {
			return NO_HOLD;
		}
		const sessionId = target.ref.sessionId;
		const cwd = target.cwdOverride ?? (await findSessionInfoById(target.ref.sessionDirectory, sessionId))?.cwd;
		// A session whose cwd is gone has no daemon workspace to lease it in; the
		// switch asks for a cwd and leases it then.
		if (cwd === undefined || !existsSync(cwd)) return NO_HOLD;
		const settled = Promise.withResolvers<void>();
		const pending = { sessionId, settled: settled.promise };
		this.pendingSwitch = pending;
		const finish = (): void => {
			if (this.pendingSwitch === pending) this.pendingSwitch = undefined;
			settled.resolve();
		};
		const restore = (): Promise<void> =>
			this.queue(async () => {
				await link.release(sessionId, "switch");
				await this.acquireShown();
			});
		let cancelled = false;
		try {
			// A handover still running for an earlier move finishes first.
			await this.tail;
			await acquireDaemonLease(link, sessionId, {
				cwd,
				tentative: true,
				onWaiting: (wait) =>
					this.askToWait(client, sessionId, {
						abortRemoteTurn: () => wait.abortRemoteTurn(),
						cancel: () => {
							cancelled = true;
							wait.cancel();
						},
					}),
			});
		} catch (error) {
			await restore().catch(() => undefined);
			finish();
			// Cancelling the wait is the user's choice, not a failure.
			if (cancelled) return { cancelled: true };
			throw error;
		}
		return {
			commit: () => {
				finish();
				// The client moved to the target, whose lease it holds already.
				this.bindGitObservation();
			},
			abort: async () => {
				try {
					// Even without a lease, the attempt pointed the daemon link at the target.
					if (sessionId !== served.shown().id) await restore();
				} finally {
					finish();
				}
			},
		};
	}

	/**
	 * Ask `client`, which opens `sessionId`, to wait for the daemon's turn
	 * there: a dialog on the client's conversation that no other client sees
	 * or answers, cleared once the wait ends. Stopping the remote turn asks
	 * again, to cancel only. A client that cannot answer dialogs waits for the
	 * turn to end. Returns the function that ends the wait's dialog.
	 */
	private askToWait(client: HostClient, sessionId: string, wait: LeaseWait): () => void {
		const conversation = this.served?.host.conversationOf(client);
		const ended = new AbortController();
		if (!conversation) return () => ended.abort();
		void (async () => {
			let stopping = false;
			while (!ended.signal.aborted) {
				const outcome = await conversation.liveState.request(leaseWaitDialog(sessionId, stopping), {
					client: client.id,
					signal: ended.signal,
				});
				if (outcome.status === "cancelled") {
					// The conversation the client opens from closed: it opens nothing.
					if (outcome.reason === "closed") wait.cancel();
					return;
				}
				const response = outcome.response;
				if (!stopping && "value" in response && response.value === STOP_REMOTE_TURN_ACTION) {
					stopping = true;
					wait.abortRemoteTurn();
					continue;
				}
				wait.cancel();
				return;
			}
		})().catch(() => wait.cancel());
		return () => ended.abort();
	}
}
