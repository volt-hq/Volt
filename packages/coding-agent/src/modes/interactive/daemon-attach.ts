import { basename, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { VERSION } from "../../config.ts";
import { createDaemonClient, type DaemonClient } from "../../daemon/control-client.ts";
import type { ControlEvent, RelayPreamble } from "../../daemon/control-protocol.ts";
import { getDaemonSocketPath } from "../../daemon/paths.ts";
import { ensureDaemonRunning } from "../../daemon/spawn.ts";

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

export interface RelayRpcForwardResult {
	/** verbatim RPC response object to forward to the phone */
	response: Record<string, unknown>;
	/** refreshed workspace metadata after a successful unregister_workspace */
	workspaceMetadata?: { workspaceNames: string[]; workspaces: Array<{ name: string; status: string }> };
}

/**
 * TUI-side daemon integration façade. Every method resolves successfully as a
 * no-op when the daemon is off or unreachable: InteractiveMode never throws or
 * blocks on daemon absence.
 */
export interface DaemonAttach {
	/** Connect, resolve (or auto-register) the cwd workspace. Never throws. */
	start(): Promise<void>;
	acquire(sessionId: string): Promise<AcquireOutcome>;
	release(sessionId: string): Promise<void>;
	rekey(oldSessionId: string, newSessionId: string): Promise<void>;
	/**
	 * Forward a state-touching RPC command from a relayed phone conversation to
	 * the daemon (push targets, live activities, workspace unregister). Returns
	 * undefined when the daemon is unreachable or rejected the request.
	 */
	forwardRelayRpc(
		clientNodeId: string,
		sessionId: string,
		command: Record<string, unknown> & { type: string },
	): Promise<RelayRpcForwardResult | undefined>;
	/** Viewer feed subscription (drain overlay). */
	viewerSubscribe(viewerFeedId: string): Promise<void>;
	viewerUnsubscribe(viewerFeedId: string): Promise<void>;
	viewerAbort(viewerFeedId: string): Promise<void>;
	onRelayOffer(handler: (offer: DaemonRelayOffer, openRelay: () => Promise<OpenedRelay>) => void): void;
	onEvent(handler: (event: ControlEvent) => void): () => void;
	/** Re-acquire outcomes after a daemon reconnect (session.reload on warm). */
	onReacquired(handler: (sessionId: string, outcome: AcquireOutcome) => void): void;
	relayCount(): number;
	onRelayCountChange(callback: (count: number) => void): void;
	connectionState(): DaemonAttachConnectionState;
	workspaceName(): string | undefined;
	dispose(): Promise<void>;
}

const NOOP_OUTCOME: AcquireOutcome = { kind: "noop" };

export function createDisabledDaemonAttach(): DaemonAttach {
	return {
		async start() {},
		async acquire() {
			return NOOP_OUTCOME;
		},
		async release() {},
		async rekey() {},
		async forwardRelayRpc() {
			return undefined;
		},
		async viewerSubscribe() {},
		async viewerUnsubscribe() {},
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
		async dispose() {},
	};
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
	let resolvedWorkspaceName: string | undefined;
	let activeRelays = 0;
	let currentSessionId: string | undefined;
	let disposed = false;
	let hadConnection = false;
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

	const handleRelayOffer = (offer: DaemonRelayOffer) => {
		const handler = relayOfferHandler;
		const activeClient = client;
		if (!handler || !activeClient) {
			return;
		}
		handler(offer, async () => {
			const opened = await activeClient.openRelay({ relayId: offer.relayId, relayToken: offer.relayToken });
			setRelayCount(activeRelays + 1);
			let finished = false;
			const finish = () => {
				if (!finished) {
					finished = true;
					setRelayCount(Math.max(0, activeRelays - 1));
				}
			};
			opened.stream.once("close", finish);
			return { preamble: opened.preamble, stream: opened.stream, finished: finish };
		});
	};

	const resolveWorkspace = async (): Promise<void> => {
		const activeClient = client;
		if (!activeClient) {
			return;
		}
		const status = await activeClient.request({ type: "status" });
		if (status.type !== "status_result") {
			return;
		}
		const cwd = resolve(options.cwd);
		const match = status.workspaces
			.filter((workspace) => cwd === workspace.path || cwd.startsWith(`${workspace.path}/`))
			.sort((left, right) => right.path.length - left.path.length)[0];
		if (match) {
			resolvedWorkspaceName = match.name;
			return;
		}
		// Auto-register the cwd so phones can reach sessions opened here.
		const takenNames = new Set(status.workspaces.map((workspace) => workspace.name));
		const base = basename(cwd) || "workspace";
		let candidate = base;
		for (let suffix = 2; takenNames.has(candidate); suffix++) {
			candidate = `${base}-${suffix}`;
		}
		const registered = await activeClient.request({ type: "workspace_register", name: candidate, path: cwd });
		if (registered.type === "ok") {
			resolvedWorkspaceName = candidate;
			log(`registered workspace ${candidate} -> ${cwd}`);
		}
	};

	const reacquireAfterReconnect = async (): Promise<void> => {
		const sessionId = currentSessionId;
		const workspaceName = resolvedWorkspaceName;
		const activeClient = client;
		if (!sessionId || !workspaceName || !activeClient || !reacquiredHandler) {
			return;
		}
		try {
			const response = await activeClient.request({ type: "lease_acquire", workspaceName, sessionId });
			const outcome = parseAcquireResponse(
				response as { type: string } & Record<string, unknown>,
				(id) => activeClient.waitForResponse(id) as Promise<{ type: string } & Record<string, unknown>>,
			);
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
					: { healthy: true, socketPath: undefined as string | undefined };
				const socketPath = ensured.socketPath;
				if (options.autoStart && !ensured.healthy) {
					state = "gone";
					return;
				}
				client = createDaemonClient({
					socketPath: socketPath ?? getDaemonSocketPath(options.agentDir),
					client: "tui",
					version: VERSION,
					reconnect: true,
					onEvent: (event) => {
						if (event.type === "relay_offer") {
							handleRelayOffer(event);
						}
						if (event.type === "relay_closed") {
							// The socket close callback decrements the count; nothing to do
							// beyond fanning the event out.
						}
						if (event.type === "daemon_shutdown") {
							setRelayCount(0);
						}
						for (const handler of Array.from(eventHandlers)) {
							handler(event);
						}
					},
					onConnectionStateChange: (next) => {
						const wasConnected = hadConnection;
						state = next;
						if (next === "connected") {
							hadConnection = true;
							void resolveWorkspace()
								.then(() => (wasConnected ? reacquireAfterReconnect() : undefined))
								.catch(() => {});
						}
					},
				});
				await client.connect();
				state = "connected";
				hadConnection = true;
				await resolveWorkspace();
			} catch (error) {
				log(`daemon unavailable: ${error instanceof Error ? error.message : String(error)}`);
				state = client ? "reconnecting" : "gone";
			}
		},
		async acquire(sessionId: string) {
			currentSessionId = sessionId;
			const workspaceName = resolvedWorkspaceName;
			const activeClient = client;
			if (!activeClient || !workspaceName || state !== "connected") {
				return NOOP_OUTCOME;
			}
			try {
				const response = await activeClient.request({ type: "lease_acquire", workspaceName, sessionId });
				return parseAcquireResponse(
					response as { type: string } & Record<string, unknown>,
					(id) => activeClient.waitForResponse(id) as Promise<{ type: string } & Record<string, unknown>>,
				);
			} catch {
				return NOOP_OUTCOME;
			}
		},
		async release(sessionId: string) {
			if (currentSessionId === sessionId) {
				currentSessionId = undefined;
			}
			const workspaceName = resolvedWorkspaceName;
			const activeClient = client;
			if (!activeClient || !workspaceName) {
				return;
			}
			try {
				await activeClient.request({ type: "lease_release", workspaceName, sessionId });
			} catch {
				// Daemon-side implicit release on disconnect covers this.
			}
		},
		async rekey(oldSessionId: string, newSessionId: string) {
			if (currentSessionId === oldSessionId) {
				currentSessionId = newSessionId;
			}
			const workspaceName = resolvedWorkspaceName;
			const activeClient = client;
			if (!activeClient || !workspaceName) {
				return;
			}
			try {
				await activeClient.request({ type: "lease_rekey", workspaceName, oldSessionId, newSessionId });
			} catch {
				// Reconnect re-acquires with the new id.
			}
		},
		async forwardRelayRpc(
			clientNodeId: string,
			sessionId: string,
			command: Record<string, unknown> & { type: string },
		) {
			const workspaceName = resolvedWorkspaceName;
			const activeClient = client;
			if (!activeClient || !workspaceName) {
				return undefined;
			}
			try {
				const response = await activeClient.request({
					type: "relay_rpc",
					clientNodeId,
					workspaceName,
					sessionId,
					command,
				});
				if (response.type !== "relay_rpc_result") {
					return undefined;
				}
				return {
					response: response.response,
					...(response.workspaceMetadata === undefined ? {} : { workspaceMetadata: response.workspaceMetadata }),
				};
			} catch {
				return undefined;
			}
		},
		async viewerSubscribe(viewerFeedId: string) {
			try {
				await client?.request({ type: "viewer_subscribe", viewerFeedId });
			} catch {
				// Viewer feed is best-effort; the post-grant file load is authoritative.
			}
		},
		async viewerUnsubscribe(viewerFeedId: string) {
			try {
				await client?.request({ type: "viewer_unsubscribe", viewerFeedId });
			} catch {
				// Best-effort.
			}
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
		async dispose() {
			disposed = true;
			await client?.close();
			client = undefined;
			state = "gone";
		},
	};
}
