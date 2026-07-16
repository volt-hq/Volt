import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { relative, resolve, sep } from "node:path";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
	getIrohRemoteRpcCommandCapabilities,
	getIrohRemoteStreamCapability,
	getMissingIrohRemoteRpcCapability,
	hasIrohRemoteRpcCapability,
	parseIrohRemoteRpcCapabilities,
	parseIrohRemoteRpcGrant,
} from "../core/remote/iroh/access-grant.ts";
import type { IrohRemoteActiveStreamEntry } from "../core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteActiveStreamRegistry } from "../core/remote/iroh/active-stream-registry.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import { hashIrohRemotePairingSecret } from "../core/remote/iroh/authorization.ts";
import {
	DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS,
	IrohRemoteHostEngine,
	type IrohRemoteHostHandshakeResult,
} from "../core/remote/iroh/engine.ts";
import {
	createIrohRemoteHandshakeFailure,
	type IrohRemoteHandshakeResponse,
	type IrohRemoteHello,
} from "../core/remote/iroh/handshake.ts";
import {
	DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
	DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
	writeIrohRemoteHandshakeResponse,
} from "../core/remote/iroh/handshake-reader.ts";
import { resolveIrohRemoteWorkspaceProjectTrusted } from "../core/remote/iroh/host-policy.ts";
import { IROH_REMOTE_ALPN, resolveIrohRemoteRuntimeToolPolicy } from "../core/remote/iroh/protocol.ts";
import {
	IrohRemoteInMemoryPushNotificationDeduper,
	type IrohRemoteLiveActivityUpdateIntent,
	type IrohRemotePushNotificationDeliveryStatus,
	IrohRemotePushNotificationDispatcher,
	type IrohRemotePushNotificationIntent,
	IrohRemotePushRelayHttpClient,
	revokeIrohRemoteClientPushTargets,
} from "../core/remote/iroh/push.ts";
import {
	createIrohRemoteRpcCapabilityDeniedResponse,
	createIrohRemoteRpcErrorResponse,
} from "../core/remote/iroh/rpc-command-filter.ts";
import type { IrohRemoteClient, IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import {
	IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
	type IrohRemoteHostStateManager,
	isIrohRemoteWorkspaceHasWorktreesError,
} from "../core/remote/iroh/state-manager.ts";
import { getIrohRemoteWorkspaceAvailabilityStatus } from "../core/remote/iroh/workspace.ts";
import type { IrohRemoteWorktreeRpcBackend } from "../core/remote/iroh/worktree-rpc.ts";
import type { IrohBiStreamLike } from "../core/rpc/iroh-transport.ts";
import { getDefaultSessionDir } from "../core/session-manager.ts";
import { getCurrentThemeName, getResolvedThemeColors } from "../core/theme/runtime.ts";
import { ProjectTrustStore } from "../core/trust-manager.ts";
import { runIrohRemoteRpcMode } from "../modes/rpc/iroh-remote-rpc-mode.ts";
import {
	CONTROL_RPC_GRANTS_CAPABILITY,
	CONTROL_WORKTREES_CAPABILITY,
	type ControlLeaseStatus,
	type ControlRequest,
	RELAY_RPC_COMMAND_TYPES,
	type RelayCloseReason,
} from "./control-protocol.ts";
import type { ControlConnection } from "./control-server.ts";
import {
	type ConversationCommandContext,
	createKeepAwakeRpcResponse,
	createRemoteRegisterLiveActivityRpcResponse,
	createRemoteUnregisterLiveActivityRpcResponse,
	createRpcSuccessResponse,
	createWebSearchKeyRpcResponse,
	getRpcResponseId,
	handleIntegratedConversationRpcCommand,
	handleRemoteHostRpcCommand,
	REMOTE_SESSION_LIST_CURSOR_TTL_MS,
	type RemoteSessionListCursorEntry,
	toRpcKeepAwakeStatus,
} from "./conversation-commands.ts";
import {
	createIntegratedConversationHandshakeResponse,
	decorateRemoteHostState,
	type RemoteHostResponseContext,
} from "./handshake-responses.ts";
import {
	createConversationOpenError,
	getResolvedTargetSessionId,
	type IntegratedRuntimeEntry,
	IntegratedRuntimeRegistry,
	type IntegratedRuntimeSubscriber,
} from "./integrated-runtimes.ts";
import { IrohConnectionSupervisor } from "./iroh-connection-supervisor.ts";
import {
	formatIrohLoadError,
	type IrohConnectionLike,
	type IrohEndpointLike,
	type IrohModuleLike,
	loadIrohModule,
} from "./iroh-native.ts";
import { IrohRemoteResourceGuard } from "./iroh-resource-guard.ts";
import { type DaemonAttachClaim, LeaseBroker, type LeaseState } from "./lease-broker.ts";
import type { VoltdRuntimeServices, VoltdServiceExtension } from "./main.ts";
import { RELAY_TOKEN_TTL_MS, RelayRegistry } from "./relay-stream.ts";
import {
	createSessionManagerTargetStore,
	type IrohRemoteSessionTarget,
	resolveIrohRemoteSessionTarget,
} from "./session-target.ts";
import { resolveWorktreeCleanupPolicy } from "./state.ts";
import { createHostThemeTokensFrame, HOST_THEME_TOKENS_FEATURE } from "./theme-push.ts";
import { ViewerFeedRegistry } from "./viewer-feed.ts";
import { isPathInside, type WorkspaceDirectoryResolution } from "./workspace-directory.ts";
import {
	type RemoteSanitizerOverrides,
	runWorkspaceDiscoveryStream,
	runWorkspaceManagementStream,
	runWorktreeManagementStream,
	WORKSPACE_UNREGISTERED_CLOSE_REASON,
	writeIrohRemoteJsonLine,
} from "./workspace-streams.ts";
import {
	evaluateWorktreeRelayGate,
	getRegisteredWorkingDirectoryForWorktree,
	getWorkspaceWorktreesDir,
	getWorktreesRoot,
	handleWorktreeControlRequest,
	isWorktreeControlRequest,
	WorktreeManager,
	type WorktreeResult,
	WorktreeRetentionSweeper,
} from "./worktree-manager.ts";

const ACTIVE_REVOKE_CLOSE_REASON = "revoked";
const ACTIVE_REPLACE_CLOSE_REASON = "replaced";
const DUPLICATE_CONVERSATION_RETRY_AFTER_MS = 500;
const RELAY_OFFER_RETRY_AFTER_MS = 1000;
const WORKSPACE_DISCOVERY_STREAM_SESSION_ID = "$workspace-discovery";
const WORKSPACE_MANAGEMENT_STREAM_SESSION_ID = "$workspace-management";
const IROH_ENDPOINT_READY_TIMEOUT_MS = 15_000;
const IROH_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS = 15_000;
const SHUTDOWN_RUNTIME_IDLE_CAP_MS = 60_000;

export type AuthorityInvalidationRuntime = Pick<IntegratedRuntimeEntry, "clientNodeId" | "workspaceName" | "sessionId">;

export function collectClientAuthorityInvalidationRuntimes<T extends AuthorityInvalidationRuntime>(
	activeStreams: IrohRemoteActiveStreamRegistry,
	runtimes: Iterable<T>,
	clientNodeId: string,
): Set<T> {
	const clientEntries = activeStreams.entriesForClientNodeId(clientNodeId);
	return new Set(
		Array.from(runtimes).filter(
			(runtime) =>
				runtime.clientNodeId === clientNodeId ||
				clientEntries.some(
					(entry) => entry.workspaceName === runtime.workspaceName && entry.sessionId === runtime.sessionId,
				),
		),
	);
}

export function collectClientAuthorityInvalidationStreams(
	activeStreams: IrohRemoteActiveStreamRegistry,
	runtimes: Iterable<AuthorityInvalidationRuntime>,
	clientNodeId: string,
): Set<IrohRemoteActiveStreamEntry> {
	const runtimeList = Array.from(runtimes);
	const entries = new Set(activeStreams.entriesForClientNodeId(clientNodeId));
	for (const runtime of collectClientAuthorityInvalidationRuntimes(activeStreams, runtimeList, clientNodeId)) {
		for (const entry of activeStreams.entriesForConversationKey(runtime.workspaceName, runtime.sessionId)) {
			entries.add(entry);
		}
	}
	return entries;
}

function getRelativeWorkingDirectoryForRoot(rootPath: string, cwd: string): string | null | undefined {
	const root = resolve(rootPath);
	const child = resolve(cwd);
	if (!isPathInside(root, child)) {
		return null;
	}
	const relativePath = relative(root, child);
	return relativePath.length === 0 || relativePath === "." ? undefined : relativePath.split(sep).join("/");
}

/**
 * Defensive cap on concurrent in-flight bi-streams per client connection. A
 * well-behaved client keeps only a handful open (one conversation + a few
 * utility streams); an authenticated-but-misbehaving client could otherwise open
 * unbounded concurrent streams, each spawning a runtime attach, and exhaust
 * daemon resources. Hitting the cap closes the connection.
 */
const MAX_CONCURRENT_STREAMS_PER_CONNECTION = 64;

let activeConnectionSequence = 0;
let activeStreamSequence = 0;

export type IrohRelayMode = "disabled" | "development" | "production";

/**
 * The Volt-operated relay fleet. Endpoints bind against these by default
 * ("production" mode); the n0 public relays ("development" mode) are for
 * development only and must be opted into via VOLT_IROH_RELAY_MODE=development.
 */
export const VOLT_PRODUCTION_RELAY_URLS = ["https://iroh-relay-us-central.volt-cli.dev"];

export interface IrohDaemonServiceConfig {
	relayMode?: IrohRelayMode;
	/**
	 * Relay server URLs (e.g. "https://relay.example.com"). When set (or via
	 * VOLT_IROH_RELAY_URLS, comma-separated), production mode binds against
	 * these instead of the built-in Volt fleet, and pairing tickets carry the
	 * URLs so clients bind against the same relays.
	 */
	relayUrls?: string[];
	/**
	 * Bearer token presented to relay servers configured with
	 * access.shared_token. Falls back to VOLT_IROH_RELAY_AUTH_TOKEN, then the
	 * token persisted in daemon state from a previous start.
	 */
	relayAuthToken?: string;
	pushRelayUrl?: string;
	pushRelayAuthToken?: string;
	profile?: string;
}

export interface ResolvedIrohRelayConfig {
	relayMode: IrohRelayMode;
	relayUrls: string[];
	warning?: string;
}

/**
 * Resolves the effective relay configuration. Precedence: explicit service
 * config, then VOLT_IROH_RELAY_MODE / VOLT_IROH_RELAY_URLS, then the Volt
 * production relay fleet.
 */
export function resolveIrohRelayConfig(
	config: Pick<IrohDaemonServiceConfig, "relayMode" | "relayUrls">,
	env: Record<string, string | undefined> = process.env,
): ResolvedIrohRelayConfig {
	const envUrls = parseRelayUrlsEnv(env.VOLT_IROH_RELAY_URLS);
	const envModeValue = env.VOLT_IROH_RELAY_MODE?.trim();
	let envMode: IrohRelayMode | undefined;
	let warning: string | undefined;
	if (envModeValue !== undefined && envModeValue !== "") {
		if (envModeValue === "disabled" || envModeValue === "development" || envModeValue === "production") {
			envMode = envModeValue;
		} else {
			warning = `ignoring invalid VOLT_IROH_RELAY_MODE "${envModeValue}" (expected disabled, development, or production)`;
		}
	}
	const relayMode = config.relayMode ?? envMode ?? "production";
	const configuredUrls = config.relayUrls ?? envUrls;
	const relayUrls =
		relayMode === "production" ? (configuredUrls ?? VOLT_PRODUCTION_RELAY_URLS) : (configuredUrls ?? []);
	return { relayMode, relayUrls, ...(warning === undefined ? {} : { warning }) };
}

function parseRelayUrlsEnv(value: string | undefined): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const urls = value
		.split(",")
		.map((url) => url.trim())
		.filter((url) => url.length > 0);
	return urls.length > 0 ? urls : undefined;
}

interface PendingPairRequest {
	requestId: string;
	connectionId: string;
	secretHash: string;
	expiresAt: number;
	timer: NodeJS.Timeout;
}

interface ClientConnectionRecord {
	connectionId: string;
	supervisor: IrohConnectionSupervisor;
}

type RelayPushDeliveryResult =
	| { ok: true; status: IrohRemotePushNotificationDeliveryStatus }
	| { ok: false; code: string; message: string };

function isExpectedApplicationClose(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("ConnectionLost(ApplicationClosed") &&
		message.includes("error_code: 0") &&
		(message.includes('reason: b"done"') ||
			message.includes(`reason: b"${ACTIVE_REVOKE_CLOSE_REASON}"`) ||
			message.includes(`reason: b"${ACTIVE_REPLACE_CLOSE_REASON}"`) ||
			message.includes(`reason: b"${WORKSPACE_UNREGISTERED_CLOSE_REASON}"`))
	);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timeoutId: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timeoutId);
	}
}

function closeIrohRemoteStream(stream: IrohBiStreamLike, _reason?: string): void {
	void Promise.resolve(stream.send.finish?.()).catch(() => {});
	void Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
}

function getRemoteTerminalReason(reason: string): string | undefined {
	if (reason === ACTIVE_REVOKE_CLOSE_REASON) {
		return "client_revoked";
	}
	if (
		reason === WORKSPACE_UNREGISTERED_CLOSE_REASON ||
		reason === "workspace_authorization_removed" ||
		reason === "lease_transferred" ||
		reason === "session_rekeyed_reconnect"
	) {
		return reason;
	}
	return undefined;
}

/**
 * The daemon's Iroh host: owns the endpoint identity, pairing, revocation,
 * headless integrated runtimes, workspace/device streams, push dispatch, and
 * the accept loop. Ported from the dissolved src/remote/iroh-host.mjs.
 */
export function createIrohDaemonService(config: IrohDaemonServiceConfig = {}): VoltdServiceExtension {
	return (services: VoltdRuntimeServices) => {
		const log = services.logger.child("iroh");
		const loaded = loadIrohModule();
		if (!loaded.iroh) {
			log("warn", formatIrohLoadError(loaded.error));
			return {
				async handleRequest(connection, request) {
					if (request.type === "pair_request") {
						connection.send({
							type: "error",
							id: request.id,
							code: "iroh_unavailable",
							message: formatIrohLoadError(loaded.error),
						});
						return true;
					}
					return false;
				},
			};
		}

		const service = new IrohDaemonService(loaded.iroh, services, config);
		void service.start();
		return {
			handleRequest: (connection, request) => service.handleRequest(connection, request),
			onConnectionClosed: (connection) => service.onControlConnectionClosed(connection),
			onThemeChanged: () => service.onThemeChanged(),
			onKeepAwakeChanged: () => service.onKeepAwakeChanged(),
			statusExtras: () => service.statusExtras(),
			admitRelay: (relayId, relayToken, socket, bufferedRemainder) =>
				service.admitRelay(relayId, relayToken, socket, bufferedRemainder),
			shutdown: () => service.shutdown(),
		};
	};
}

class IrohDaemonService {
	private readonly iroh: IrohModuleLike;
	private readonly services: VoltdRuntimeServices;
	private readonly relayMode: IrohRelayMode;
	private readonly relayUrls: string[];
	private readonly relayAuthToken: string | undefined;
	private readonly relayConfigWarning: string | undefined;
	private readonly log: ReturnType<VoltdRuntimeServices["logger"]["child"]>;
	private readonly stateManager: IrohRemoteHostStateManager;
	private readonly activeStreams = new IrohRemoteActiveStreamRegistry();
	private readonly clientConnections = new Map<string, Set<ClientConnectionRecord>>();
	private readonly connectionSupervisors = new Map<string, IrohConnectionSupervisor>();
	private readonly connectionTasks = new Set<Promise<void>>();
	private readonly resourceGuard = new IrohRemoteResourceGuard();
	private readonly pendingPairRequests = new Map<string, PendingPairRequest>();
	private readonly sessionListCursors = new Map<string, RemoteSessionListCursorEntry>();
	private readonly pushRelayClient: IrohRemotePushRelayHttpClient;
	private readonly pushNotificationDeduper = new IrohRemoteInMemoryPushNotificationDeduper();
	private readonly trustStore: ProjectTrustStore;
	private readonly runtimes: IntegratedRuntimeRegistry;
	private readonly worktrees: WorktreeManager;
	private readonly worktreeRetention: WorktreeRetentionSweeper;
	private readonly leaseBroker: LeaseBroker;
	private readonly viewerFeeds: ViewerFeedRegistry;
	private readonly relays = new RelayRegistry();
	private endpoint: IrohEndpointLike | undefined;
	private engine: IrohRemoteHostEngine | undefined;
	private hostNodeId: string | undefined;
	private endpointTicket: string | undefined;
	private shuttingDown = false;
	private readonly ready: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };

	constructor(iroh: IrohModuleLike, services: VoltdRuntimeServices, config: IrohDaemonServiceConfig) {
		this.iroh = iroh;
		this.services = services;
		const relayConfig = resolveIrohRelayConfig(config);
		this.relayMode = relayConfig.relayMode;
		this.relayUrls = relayConfig.relayUrls;
		this.relayConfigWarning = relayConfig.warning;
		const envRelayAuthToken = process.env.VOLT_IROH_RELAY_AUTH_TOKEN?.trim();
		this.relayAuthToken =
			config.relayAuthToken ??
			(envRelayAuthToken !== undefined && envRelayAuthToken !== "" ? envRelayAuthToken : undefined) ??
			services.state.state.settings.relayAuthToken;
		// Persist a newly seen token so bare restarts keep authenticating against
		// the relay without re-exporting the env var.
		if (this.relayAuthToken !== undefined && this.relayAuthToken !== services.state.state.settings.relayAuthToken) {
			services.state.updateSettings({ relayAuthToken: this.relayAuthToken });
		}
		this.log = services.logger.child("iroh");
		this.stateManager = services.stateManager;
		this.trustStore = new ProjectTrustStore(services.agentDir);
		this.pushRelayClient = new IrohRemotePushRelayHttpClient({
			authToken: config.pushRelayAuthToken ?? process.env.VOLT_PUSH_RELAY_AUTH_TOKEN,
			baseUrl: config.pushRelayUrl ?? process.env.VOLT_PUSH_RELAY_URL,
		});
		this.runtimes = new IntegratedRuntimeRegistry({
			agentDir: services.agentDir,
			profile: config.profile,
			auditLogger: services.auditLogger,
			stateManager: this.stateManager,
			activeStreams: this.activeStreams,
			detachedRuntimeTtlMs: () => services.state.state.settings.detachedRuntimeTtlMs,
			getToolPolicy: (workspace, clientAllowTools) =>
				resolveIrohRemoteRuntimeToolPolicy({
					clientAllowTools,
					workspaceAllowTools: workspace.allowedTools,
					daemonAllowTools: services.state.state.settings.allowTools,
				}),
			getProjectTrustedForWorkspace: (workspace) =>
				resolveIrohRemoteWorkspaceProjectTrusted(workspace, { trustStore: this.trustStore }),
			setClientLastSessionId: (nodeId, workspace, sessionId) =>
				this.requireEngine().setClientLastSessionId(nodeId, workspace, sessionId),
			resolveWorktree: (workspaceName, hello, targetSessionId) =>
				this.resolveConversationWorktree(workspaceName, hello, targetSessionId),
			resolveWorkingDirectory: (options) => this.resolveConversationWorkingDirectory(options),
			bindWorktreeSession: (workspaceName, worktreeId, sessionId) =>
				this.worktrees.bindSession(workspaceName, worktreeId, sessionId),
			onRuntimeRekeyed: (workspaceName, previousSessionId, sessionId) =>
				this.leaseBroker.rekey(workspaceName, previousSessionId, sessionId),
			onRuntimeDisposed: (entry, reason) => {
				this.leaseBroker.onDaemonRuntimeDisposed(entry.workspaceName, entry.sessionId, reason);
				if (entry.worktreeId !== undefined) {
					this.worktreeRetention.onRuntimeDisposed(entry.workspaceName, entry.worktreeId);
				}
			},
		});
		this.worktrees = new WorktreeManager({
			agentDir: services.agentDir,
			stateManager: this.stateManager,
			auditLogger: services.auditLogger,
			hasActiveRuntimeForSession: (workspaceName, sessionId) =>
				this.runtimes.findOwner(workspaceName, sessionId) !== undefined,
			flushState: () => services.state.flush(),
		});
		this.worktreeRetention = new WorktreeRetentionSweeper({
			manager: this.worktrees,
			stateManager: this.stateManager,
			auditLogger: services.auditLogger,
			getRetentionPolicy: () => resolveWorktreeCleanupPolicy(services.state.state.settings).retention,
		});
		this.viewerFeeds = new ViewerFeedRegistry({
			sendTo: (connectionId, event) => services.controlServer.sendTo(connectionId, event),
		});
		this.leaseBroker = new LeaseBroker({
			isRuntimeStreaming: (workspaceName, sessionId) =>
				this.runtimes.findOwner(workspaceName, sessionId)?.runtime.session.isBusy ?? false,
			waitForRuntimeIdle: async (workspaceName, sessionId) => {
				await this.runtimes.findOwner(workspaceName, sessionId)?.runtime.session.waitForIdle();
			},
			disposeRuntime: async (workspaceName, sessionId, reason) => {
				const owner = this.runtimes.findOwner(workspaceName, sessionId);
				if (owner) {
					await this.runtimes.stopEntry(owner, reason);
				}
			},
			closePhoneStreams: async (workspaceName, sessionId, reason) => {
				await this.closeActiveStreamsForConversationKey(workspaceName, sessionId, reason);
			},
			closeRelays: (record, reason) => {
				for (const relayId of Array.from(record.relayIds)) {
					this.relays.closeActive(relayId, reason);
					// Unredeemed offers must not linger until the 10s token expiry:
					// fail the phone's deferred handshake immediately so it retries
					// against the new lease owner.
					this.abortPendingRelay(relayId, reason, "relay offer cancelled; retry", RELAY_OFFER_RETRY_AFTER_MS);
				}
			},
			onDrainStarted: (record, viewerFeedId) => {
				const owner = this.runtimes.findOwner(record.workspaceName, record.sessionId);
				if (owner && record.tuiConnectionId) {
					this.viewerFeeds.start(viewerFeedId, record.tuiConnectionId, owner.runtime.session);
				}
			},
			onDrainEnded: (_record, viewerFeedId, reason) => {
				this.viewerFeeds.end(viewerFeedId, reason);
			},
			audit: (event) => {
				void this.logAudit({
					type: event.type,
					workspace: event.workspaceName,
					success: true,
					details: { sessionId: event.sessionId, ...event.details },
				});
			},
		});
		let readyResolve: () => void = () => {};
		let readyReject: (error: unknown) => void = () => {};
		const readyPromise = new Promise<void>((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		readyPromise.catch(() => {});
		this.ready = { promise: readyPromise, resolve: readyResolve, reject: readyReject };
	}

	private requireEngine(): IrohRemoteHostEngine {
		if (!this.engine) {
			throw new Error("iroh host engine is not ready");
		}
		return this.engine;
	}

	private async pruneWorktreesOnStart(): Promise<void> {
		if (!resolveWorktreeCleanupPolicy(this.services.state.state.settings).pruneOnStart) {
			return;
		}
		try {
			const state = await this.stateManager.getState();
			const workspacesWithRecords = new Set((state.worktrees ?? []).map((worktree) => worktree.workspaceName));
			for (const workspace of state.workspaces) {
				// Skip workspaces with neither records nor checkout directories: no git
				// subprocesses or audit noise on the common no-worktrees start.
				if (
					!workspacesWithRecords.has(workspace.name) &&
					!existsSync(getWorkspaceWorktreesDir(this.services.agentDir, workspace.path))
				) {
					continue;
				}
				try {
					await this.worktrees.prune(workspace);
				} catch (error) {
					this.log("warn", "worktree prune failed on start", {
						workspace: workspace.name,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		} catch {
			// Startup prune is best-effort; a manual `volt remote worktree prune` covers it.
		}
	}

	private getResponseContext(): RemoteHostResponseContext {
		return {
			hostNodeId: this.hostNodeId,
			relayMode: this.relayMode,
			...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
		};
	}

	private async isAuthorizationGrantCurrent(authorization: IrohRemoteClientAuthorizationSuccess): Promise<boolean> {
		const client = await this.stateManager.getClient(authorization.client.nodeId);
		return client?.rpcGrant.revision === authorization.client.rpcGrant.revision;
	}

	private getCommandContext(conversation?: {
		workspaceName: string;
		workspacePath?: string;
		entry: IntegratedRuntimeEntry;
		streamEntry?: IrohRemoteActiveStreamEntry;
	}): ConversationCommandContext {
		return {
			agentDir: this.services.agentDir,
			auditLogger: this.services.auditLogger,
			hostEngine: this.engine,
			stateManager: this.stateManager,
			sessionListCursors: this.sessionListCursors,
			sessionListCursorTtlMs: REMOTE_SESSION_LIST_CURSOR_TTL_MS,
			listRuntimeStates: (workspaceName) => {
				const states = new Map<string, Exclude<LeaseState, "unowned">>();
				for (const record of this.leaseBroker.list()) {
					if (record.workspaceName === workspaceName && record.state !== "unowned") {
						states.set(record.sessionId, record.state);
					}
				}
				return states;
			},
			keepAwake: this.services.keepAwake,
			onKeepAwakeSetting: (enabled) => this.services.state.updateSettings({ keepAwakeEnabled: enabled }),
			webSearchKey: this.services.webSearchKey,
			createWorktreeBackend: (workspace) => this.createWorktreeRpcBackend(workspace),
			onWorkspaceUnregistered: async (workspaceName) => {
				// Unregistering the conversation's own workspace keeps the requesting
				// stream and runtime alive so the response can still be delivered
				// (mirrors the workspace-management stream path).
				const excludeOwn = conversation !== undefined && workspaceName === conversation.workspaceName;
				const workspacePath = excludeOwn ? conversation.workspacePath : undefined;
				await this.cleanupUnregisteredWorkspace(
					workspaceName,
					excludeOwn
						? { streamEntry: conversation.streamEntry, runtimeEntry: conversation.entry, workspacePath }
						: {},
				);
			},
			...(conversation === undefined
				? {}
				: {
						isDraining: () =>
							this.leaseBroker.isDraining(conversation.workspaceName, conversation.entry.sessionId),
						isSubagentSession: () =>
							conversation.entry.subagentId !== undefined || conversation.entry.parentSessionId !== undefined,
					}),
		};
	}

	async start(): Promise<void> {
		let endpoint: IrohEndpointLike | undefined;
		if (this.relayConfigWarning !== undefined) {
			this.log("warn", this.relayConfigWarning);
		}
		// Reconcile worktree records/checkouts before the endpoint starts taking
		// conversations (design §5.3 pruneOnStart; default on, quarantine-only).
		await this.pruneWorktreesOnStart();
		try {
			const builder = this.iroh.Endpoint.builder();
			if (this.relayMode === "development") {
				this.log(
					"warn",
					"using public n0 relays (development only; unset VOLT_IROH_RELAY_MODE for the Volt relays)",
				);
				this.iroh.presetN0(builder);
			} else if (this.relayMode === "production") {
				if (this.relayUrls.length === 0) {
					throw new Error("relayMode production requires relay URLs (config.relayUrls or VOLT_IROH_RELAY_URLS)");
				}
				this.iroh.presetN0DisableRelay(builder);
				if (this.relayAuthToken !== undefined) {
					const relayMap = this.iroh.RelayMap.empty();
					for (const url of this.relayUrls) {
						relayMap.insert({ url, authToken: this.relayAuthToken });
					}
					builder.relayMode(this.iroh.RelayMode.custom(relayMap));
				} else {
					builder.relayMode(this.iroh.RelayMode.customFromUrls(this.relayUrls));
				}
			} else {
				this.iroh.presetMinimal(builder);
				builder.relayMode(this.iroh.RelayMode.disabled());
			}
			const secretKey = this.services.state.state.irohSecretKey;
			if (secretKey) {
				builder.secretKey(secretKey);
			}
			builder.alpns([Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"))]);
			endpoint = await builder.bind();
			if (!secretKey) {
				const boundKey = endpoint.secretKey().toBytes();
				this.services.state.setHostState({
					...this.services.state.getHostState(),
					hostSecretKey: boundKey,
				});
				// Persist the freshly minted identity synchronously before the accept
				// loop starts taking pairings. A crash/SIGKILL inside the 250ms debounce
				// window would otherwise lose the key, and every phone paired against
				// this endpoint would be talking to a node id the daemon can never
				// reproduce on restart.
				await this.services.state.flush();
			}
			if (this.relayMode !== "disabled") {
				await endpoint.online();
			}
			this.endpoint = endpoint;
			this.hostNodeId = endpoint.id().toString();
			this.endpointTicket = this.iroh.EndpointTicket.fromAddr(endpoint.addr()).toString();
			this.engine = new IrohRemoteHostEngine({
				auditLogger: this.services.auditLogger,
				classifyWorkspaceAvailability: getIrohRemoteWorkspaceAvailabilityStatus,
				hostNodeId: this.hostNodeId,
				relayMode: this.relayMode,
				...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
				stateManager: this.stateManager,
				validateWorkspace: async (workspace) =>
					(await getIrohRemoteWorkspaceAvailabilityStatus(workspace)) === "available",
				workspace: { name: "voltd", path: this.services.agentDir },
			});
			this.ready.resolve();
			this.log("info", `iroh endpoint online`, {
				hostNodeId: this.hostNodeId,
				relayMode: this.relayMode,
				...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
			});
			void this.acceptLoop(endpoint);
		} catch (error) {
			if (endpoint) {
				// bind() succeeded but a later start step (e.g. online()) failed before
				// the endpoint was adopted; close it so its QUIC socket is not leaked.
				try {
					await endpoint.close();
				} catch {}
				if (this.endpoint === endpoint) {
					this.endpoint = undefined;
				}
			}
			this.ready.reject(error);
			this.log("error", `failed to start iroh endpoint: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async acceptLoop(endpoint: IrohEndpointLike): Promise<void> {
		while (!this.shuttingDown) {
			let incoming: Awaited<ReturnType<IrohEndpointLike["acceptNext"]>>;
			try {
				incoming = await endpoint.acceptNext();
			} catch (error) {
				if (this.shuttingDown) {
					break;
				}
				this.log("error", `accept failed: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (!incoming) {
				break;
			}
			const connectionAdmission = this.resourceGuard.tryAcquireConnectionTask();
			if (!connectionAdmission.ok) {
				let refused = true;
				try {
					await incoming.refuse();
				} catch {
					refused = false;
				}
				await this.logAudit({
					type: "iroh_security_connection_limit",
					success: false,
					error: "incoming connection refused at daemon connection-task limit",
					details: {
						limit: connectionAdmission.limit,
						refused,
						scope: connectionAdmission.scope,
					},
				});
				continue;
			}
			const task = this.handleConnection(incoming)
				.catch((error) => {
					if (!isExpectedApplicationClose(error)) {
						this.log(
							"error",
							`connection error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
						);
					}
				})
				.finally(() => {
					this.connectionTasks.delete(task);
					connectionAdmission.lease.release();
				});
			this.connectionTasks.add(task);
		}
	}

	private async handleConnection(
		incoming: NonNullable<Awaited<ReturnType<IrohEndpointLike["acceptNext"]>>>,
	): Promise<void> {
		let connection: IrohConnectionLike;
		try {
			const accepting = await incoming.accept();
			connection = await accepting.connect();
		} catch {
			await this.logAudit({
				type: "iroh_security_transport_rejected",
				success: false,
				error: "incoming transport handshake failed",
				details: { phase: "transport_connect" },
			});
			return;
		}
		const supervisor = new IrohConnectionSupervisor(connection);
		try {
			connection.setMaxConcurrentBiStreams(BigInt(MAX_CONCURRENT_STREAMS_PER_CONNECTION));
		} catch {
			supervisor.requestClose("stream_limit_configuration_failed", "immediate");
			await supervisor.finalize("stream_limit_configuration_failed");
			await this.logAudit({
				type: "iroh_security_transport_rejected",
				success: false,
				error: "connected transport could not enforce the inbound stream limit",
				details: { phase: "stream_limit_configuration" },
			});
			return;
		}
		let remoteId: string;
		try {
			remoteId = connection.remoteId().toString();
		} catch {
			supervisor.requestClose("invalid_remote_identity", "immediate");
			await supervisor.finalize("invalid_remote_identity");
			await this.logAudit({
				type: "iroh_security_transport_rejected",
				success: false,
				error: "connected transport did not expose a valid remote identity",
				details: { phase: "remote_identity" },
			});
			return;
		}
		const nodeConnectionAdmission = this.resourceGuard.tryAcquireNodeConnection(remoteId);
		if (!nodeConnectionAdmission.ok) {
			supervisor.requestClose("node_connection_limit", "immediate");
			await supervisor.finalize("node_connection_limit");
			await this.logAudit({
				type: "iroh_security_connection_limit",
				clientNodeId: remoteId,
				success: false,
				error: "connection refused at per-node connection limit",
				details: { limit: nodeConnectionAdmission.limit, scope: nodeConnectionAdmission.scope },
			});
			return;
		}
		supervisor.addTerminalFinalizer(() => nodeConnectionAdmission.lease.release());
		const unauthenticatedAdmission = this.resourceGuard.tryAcquireUnauthenticatedConnection(remoteId);
		if (!unauthenticatedAdmission.ok) {
			supervisor.requestClose("unauthenticated_connection_limit", "immediate");
			await supervisor.finalize("unauthenticated_connection_limit");
			await this.logAudit({
				type: "iroh_security_unauthenticated_connection_limit",
				clientNodeId: remoteId,
				success: false,
				error: "unauthenticated connection refused at admission limit",
				details: { limit: unauthenticatedAdmission.limit, scope: unauthenticatedAdmission.scope },
			});
			return;
		}
		supervisor.addTerminalFinalizer(() => unauthenticatedAdmission.lease.release());
		const connectionId = `conn-${++activeConnectionSequence}`;
		this.registerClientConnection(remoteId, connectionId, supervisor);
		let acceptedStreamCount = 0;
		let authenticated = false;
		const unauthenticatedTimer = setTimeout(() => {
			if (authenticated || supervisor.isClosing) return;
			supervisor.requestClose("handshake_timeout", "immediate");
			void this.logAudit({
				type: "iroh_security_handshake_timeout",
				clientNodeId: remoteId,
				success: false,
				error: "connection did not authenticate before the handshake deadline",
				details: { connectionId, timeoutMs: IROH_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS },
			});
		}, IROH_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS);
		unauthenticatedTimer.unref?.();

		const markAuthenticated = async (): Promise<boolean> => {
			if (authenticated) return true;
			if (supervisor.isClosing) return false;
			authenticated = true;
			clearTimeout(unauthenticatedTimer);
			unauthenticatedAdmission.lease.release();
			this.log("info", `client connection opened: ${remoteId} (${connectionId})`);
			await this.logAudit({
				type: "client_connected",
				clientNodeId: remoteId,
				success: true,
				details: { connectionId },
			});
			return true;
		};

		try {
			while (!supervisor.isClosing) {
				const stream = await (!authenticated
					? withTimeout(connection.acceptBi(), DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS, "handshake timed out")
					: connection.acceptBi());
				acceptedStreamCount++;
				if (supervisor.childTaskCount >= MAX_CONCURRENT_STREAMS_PER_CONNECTION) {
					// One connection is holding too many concurrent streams open. Refuse
					// further work and close the connection rather than let
					// it exhaust daemon resources; the just-accepted stream is torn down
					// with the connection. A legitimate client never reaches this.
					supervisor.requestClose("stream_limit_exceeded", "immediate");
					await this.logAudit({
						type: "iroh_security_stream_limit",
						clientNodeId: remoteId,
						success: false,
						error: "connection exceeded concurrent stream limit",
						details: { connectionId, limit: MAX_CONCURRENT_STREAMS_PER_CONNECTION, scope: "connection" },
					});
					break;
				}
				const streamAdmission = this.resourceGuard.tryAcquireActiveStream(remoteId);
				if (!streamAdmission.ok) {
					closeIrohRemoteStream(stream, "stream_limit_exceeded");
					await this.logAudit({
						type: "iroh_security_stream_limit",
						clientNodeId: remoteId,
						success: false,
						error: "stream refused at daemon active-stream limit",
						details: { connectionId, limit: streamAdmission.limit, scope: streamAdmission.scope },
					});
					supervisor.requestClose("done", "when_idle");
					continue;
				}
				const streamId = `stream-${++activeStreamSequence}`;
				const task = this.handleConnectionStream(stream, remoteId, connectionId, streamId, markAuthenticated)
					.catch(async (error) => {
						if (!isExpectedApplicationClose(error)) {
							if (authenticated) {
								this.log(
									"error",
									`stream error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
								);
							} else {
								await this.logAudit({
									type: "iroh_security_transport_rejected",
									clientNodeId: remoteId,
									success: false,
									error: "unauthenticated stream failed",
									details: { connectionId, phase: "stream_handshake" },
								});
							}
						}
					})
					.finally(() => {
						streamAdmission.lease.release();
					});
				supervisor.trackChild(task);
			}
		} catch (error) {
			if (acceptedStreamCount === 0 && authenticated) {
				throw error;
			}
			if (acceptedStreamCount === 0 && !supervisor.isClosing) {
				await this.logAudit({
					type: "iroh_security_handshake_timeout",
					clientNodeId: remoteId,
					success: false,
					error: "connection closed or timed out before opening a handshake stream",
					details: { connectionId, timeoutMs: DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS },
				});
			}
		} finally {
			clearTimeout(unauthenticatedTimer);
			await this.closeActiveStreamsForConnection(connectionId, "connection_closed");
			await supervisor.finalize("done");
			if (authenticated) {
				this.log("info", `client connection closed: ${remoteId} (${connectionId})`);
				await this.logAudit({
					type: "client_disconnected",
					clientNodeId: remoteId,
					success: true,
					details: { connectionId },
				});
			}
		}
	}

	private async handleConnectionStream(
		stream: IrohBiStreamLike,
		remoteId: string,
		connectionId: string,
		streamId: string,
		markAuthenticated: () => Promise<boolean>,
	): Promise<void> {
		const engine = this.requireEngine();
		const handshakeAdmission = this.resourceGuard.tryAcquireHandshake(remoteId);
		if (!handshakeAdmission.ok) {
			closeIrohRemoteStream(stream, "handshake_limit_exceeded");
			await this.logAudit({
				type: "iroh_security_handshake_limit",
				clientNodeId: remoteId,
				success: false,
				error: "stream refused at concurrent handshake limit",
				details: { connectionId, limit: handshakeAdmission.limit, scope: handshakeAdmission.scope },
			});
			return;
		}
		let handshake: IrohRemoteHostHandshakeResult;
		try {
			handshake = await engine.readHandshake(stream.recv, remoteId, {
				child: "volt",
				maxLineBytes: DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
				timeoutMs: DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
			});
		} finally {
			handshakeAdmission.lease.release();
		}
		if (!handshake.ok) {
			if (
				handshake.response.outcome === "workspace_authorization_removed" &&
				typeof handshake.response.workspace === "string"
			) {
				await this.closeWorkspaceAuthorizationRemovedStreams(remoteId, handshake.response.workspace);
			}
			await this.writeTerminalHandshakeResponse(stream, handshake.response);
			return;
		}
		if (!(await markAuthenticated())) {
			closeIrohRemoteStream(stream, "handshake_timeout");
			return;
		}

		const streamCapability = getIrohRemoteStreamCapability({
			mode: handshake.hello.mode,
			...(handshake.hello.mode === "workspaceManagement"
				? { purpose: handshake.hello.workspaceManagement.purpose }
				: {}),
		});
		if (
			streamCapability !== undefined &&
			!hasIrohRemoteRpcCapability(
				parseIrohRemoteRpcGrant(handshake.authorization.client.rpcGrant, "client rpcGrant"),
				streamCapability,
			)
		) {
			await this.writeTerminalHandshakeResponse(
				stream,
				createIrohRemoteHandshakeFailure(`rpc_capability_denied: ${streamCapability}`, {
					hostNodeId: this.hostNodeId,
					workspace: handshake.authorization.workspace.name,
				}),
			);
			return;
		}

		this.notifyPairingConsumed(handshake, remoteId);

		if (handshake.authorization.paired) {
			this.log("info", `paired client stream: ${handshake.authorization.client.label} (${remoteId}, ${streamId})`);
		}

		if (handshake.hello.mode === "workspaceDiscovery") {
			await this.runWorkspaceDiscovery(stream, handshake, connectionId, streamId);
			return;
		}
		if (handshake.hello.mode === "workspaceManagement") {
			if (handshake.hello.workspaceManagement.purpose === "manage_worktrees") {
				await this.runWorktreeManagement(stream, handshake, connectionId, streamId);
				return;
			}
			await this.runWorkspaceManagement(stream, handshake, connectionId, streamId);
			return;
		}
		await this.runIntegratedConversation(stream, handshake, connectionId, streamId);
	}

	// ==========================================================================
	// Workspace streams
	// ==========================================================================

	private registerActiveStream(
		authorization: IrohRemoteClientAuthorizationSuccess,
		sessionId: string,
		stream: IrohBiStreamLike,
		connectionId: string,
		streamId: string,
		details: { terminalSessionId?: string | undefined; sanitizerOverrides?: RemoteSanitizerOverrides } = {},
	): { entry: IrohRemoteActiveStreamEntry; remove: () => void } {
		const entry: IrohRemoteActiveStreamEntry = {
			clientNodeId: authorization.client.nodeId,
			connectionId,
			sessionId,
			streamId,
			workspaceName: authorization.workspace.name,
			close: (reason: string) =>
				this.closeStreamWithTerminal(stream, reason, {
					authorization,
					sessionId: Object.hasOwn(details, "terminalSessionId") ? details.terminalSessionId : entry.sessionId,
				}),
			write: (value: object) =>
				writeIrohRemoteJsonLine(stream.send, value, authorization, details.sanitizerOverrides ?? {}),
		};
		const remove = this.activeStreams.register(entry);
		return { entry, remove };
	}

	// ==========================================================================
	// iOS theme token push (§9.5) — flag off by default, capability gated
	// ==========================================================================

	private isThemeTokenPushEnabled(): boolean {
		return this.services.state.state.settings.themeTokenPush === true || process.env.VOLT_HOST_THEME_TOKENS === "1";
	}

	/** Send the current sanitized theme tokens to one capable stream. */
	private pushThemeTokensToStream(entry: IrohRemoteActiveStreamEntry): void {
		if (!this.isThemeTokenPushEnabled() || !entry.capabilities?.has(HOST_THEME_TOKENS_FEATURE)) {
			return;
		}
		const frame = createHostThemeTokensFrame(getCurrentThemeName() ?? "dark", getResolvedThemeColors());
		void Promise.resolve(entry.write?.(frame)).catch(() => {});
	}

	/** Theme changed: fan the new tokens out to every capable phone stream. */
	onThemeChanged(): void {
		if (!this.isThemeTokenPushEnabled()) {
			return;
		}
		for (const entry of this.activeStreams.allEntries()) {
			this.pushThemeTokensToStream(entry);
		}
	}

	/**
	 * Keep-awake status changed (control toggle, phone toggle, or degradation):
	 * fan the new state to every phone stream. Clients that ignore the frame are
	 * fully supported, so no capability gating.
	 */
	onKeepAwakeChanged(): void {
		const frame = {
			type: "keep_awake_changed",
			data: { keepAwake: toRpcKeepAwakeStatus(this.services.keepAwake.status) },
		};
		for (const entry of this.activeStreams.allEntries()) {
			void Promise.resolve(entry.write?.(frame)).catch(() => {});
		}
	}

	private async closeStreamWithTerminal(
		stream: IrohBiStreamLike,
		reason: string,
		terminal: { authorization: IrohRemoteClientAuthorizationSuccess; sessionId: string | undefined },
	): Promise<void> {
		const terminalReason = getRemoteTerminalReason(reason);
		if (terminalReason) {
			await writeIrohRemoteJsonLine(
				stream.send,
				{
					type: "remote_terminal",
					reason: terminalReason,
					workspace: terminal.authorization.workspace.name,
					...(terminal.sessionId === undefined ? {} : { sessionId: terminal.sessionId }),
					hostNodeId: this.hostNodeId,
				},
				terminal.authorization,
			).catch(() => {});
		}
		closeIrohRemoteStream(stream, reason);
	}

	private async runWorkspaceDiscovery(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
	): Promise<void> {
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		const activeStream = this.registerActiveStream(
			handshake.authorization,
			WORKSPACE_DISCOVERY_STREAM_SESSION_ID,
			stream,
			connectionId,
			streamId,
			{ terminalSessionId: undefined },
		);
		try {
			await runWorkspaceDiscoveryStream(
				{
					stream,
					initialInput: handshake.initialInput,
					authorization: handshake.authorization,
					isRpcGrantCurrent: () => this.isAuthorizationGrantCurrent(handshake.authorization),
					closeStream: (reason) => closeIrohRemoteStream(stream, reason),
				},
				{ commandContext: this.getCommandContext() },
			);
		} finally {
			activeStream.remove();
		}
	}

	private async runWorkspaceManagement(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
	): Promise<void> {
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		const activeStream = this.registerActiveStream(
			handshake.authorization,
			WORKSPACE_MANAGEMENT_STREAM_SESSION_ID,
			stream,
			connectionId,
			streamId,
			{ terminalSessionId: undefined },
		);
		try {
			await runWorkspaceManagementStream(
				{
					stream,
					initialInput: handshake.initialInput,
					authorization: handshake.authorization,
					isRpcGrantCurrent: () => this.isAuthorizationGrantCurrent(handshake.authorization),
					closeStream: (reason) => {
						activeStream.remove();
						closeIrohRemoteStream(stream, reason);
					},
				},
				{
					auditLogger: this.services.auditLogger,
					commandContext: this.getCommandContext(),
					unregisterWorkspace: async (workspaceName) => {
						let removedWorkspace: Awaited<ReturnType<IrohRemoteHostStateManager["unregisterWorkspace"]>>;
						try {
							removedWorkspace = await this.stateManager.unregisterWorkspace(workspaceName);
						} catch (error) {
							if (!isIrohRemoteWorkspaceHasWorktreesError(error)) {
								throw error;
							}
							return {
								ok: false,
								error: IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
								details: {
									worktreeCount: error.worktreeIds.length,
									worktreeIds: error.worktreeIds,
								},
							};
						}
						if (!removedWorkspace) {
							return { ok: false, error: "workspace_unregistered" };
						}
						this.engine?.clearPairingSecretForWorkspace(workspaceName);
						const { closedStreamCount, stoppedRuntimeCount } = await this.cleanupUnregisteredWorkspace(
							workspaceName,
							{ streamEntry: activeStream.entry, workspacePath: removedWorkspace.path },
						);
						return { ok: true, closedStreamCount, stoppedRuntimeCount };
					},
				},
			);
		} finally {
			activeStream.remove();
		}
	}

	/** Serve a manage_worktrees workspaceManagement stream (worktrees.v1). */
	private async runWorktreeManagement(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
	): Promise<void> {
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		const sanitizerOverrides: RemoteSanitizerOverrides = {
			additionalRedactedPaths: [getWorktreesRoot(this.services.agentDir)],
		};
		const activeStream = this.registerActiveStream(
			handshake.authorization,
			WORKSPACE_MANAGEMENT_STREAM_SESSION_ID,
			stream,
			connectionId,
			streamId,
			{ terminalSessionId: undefined, sanitizerOverrides },
		);
		try {
			await runWorktreeManagementStream(
				{
					stream,
					initialInput: handshake.initialInput,
					authorization: handshake.authorization,
					isRpcGrantCurrent: () => this.isAuthorizationGrantCurrent(handshake.authorization),
					closeStream: (reason) => closeIrohRemoteStream(stream, reason),
				},
				{
					auditLogger: this.services.auditLogger,
					additionalRedactedPaths: sanitizerOverrides.additionalRedactedPaths,
					worktrees: this.createWorktreeRpcBackend(handshake.authorization.workspace),
				},
			);
		} finally {
			activeStream.remove();
		}
	}

	/** Backend for the worktree RPC helpers, bound to the stream's authorized workspace. */
	private createWorktreeRpcBackend(workspace: IrohRemoteWorkspace): IrohRemoteWorktreeRpcBackend {
		return {
			createWorktree: async (_workspaceName, options) => {
				const created = await this.worktrees.create(workspace, options);
				if (!created.ok) {
					return {
						ok: false,
						error: created.error,
						...(created.detail === undefined ? {} : { detail: created.detail }),
					};
				}
				return { ok: true, worktree: created.worktree };
			},
			listWorktrees: async () => ({ ok: true, worktrees: await this.worktrees.list(workspace) }),
			removeWorktree: async (_workspaceName, worktreeId, force) =>
				this.removeWorkspaceWorktree(workspace, worktreeId, force),
		};
	}

	/**
	 * Runtime-aware worktree removal: refuses busy worktrees without force; with
	 * force, closes bound phone streams and stops bound runtimes first.
	 */
	private async removeWorkspaceWorktree(
		workspace: IrohRemoteWorkspace,
		worktreeId: string,
		force: boolean,
	): Promise<WorktreeResult<{ stoppedRuntimeCount: number; closedStreamCount: number }>> {
		const record = await this.worktrees.findWorktree(workspace.name, worktreeId);
		if (!record) {
			return { ok: false, error: "worktree_not_found" };
		}
		let stoppedRuntimeCount = 0;
		let closedStreamCount = 0;
		const boundEntries = record.sessionIds
			.map((sessionId) => this.runtimes.findOwner(workspace.name, sessionId))
			.filter((entry): entry is IntegratedRuntimeEntry => entry !== undefined);
		if (boundEntries.length > 0) {
			if (!force) {
				return { ok: false, error: "worktree_busy" };
			}
			for (const entry of boundEntries) {
				closedStreamCount += await this.closeActiveStreamsForConversationKey(
					workspace.name,
					entry.sessionId,
					"worktree_removed",
				);
				await this.runtimes.stopEntry(entry, "worktree_removed");
				stoppedRuntimeCount++;
			}
		}
		const removed = await this.worktrees.remove(workspace, worktreeId, { force });
		if (!removed.ok) {
			return removed;
		}
		return { ok: true, stoppedRuntimeCount, closedStreamCount };
	}

	/**
	 * Worktree resolution for conversation opens: explicit worktreeId on "new"
	 * (must exist AND be on disk), persisted binding on resume (missing checkout
	 * fails with session_unavailable). Availability is an open-time failure, not
	 * an authorization failure.
	 */
	private async resolveConversationWorktree(
		workspaceName: string,
		hello: IrohRemoteHello,
		targetSessionId: string | undefined,
	): Promise<IrohRemoteWorkspaceWorktree | undefined> {
		if (hello.mode !== "conversation") {
			return undefined;
		}
		if (hello.conversation.target === "new") {
			const worktreeId = hello.conversation.worktreeId;
			if (worktreeId === undefined) {
				return undefined;
			}
			const worktree = await this.worktrees.findWorktree(workspaceName, worktreeId);
			if (!worktree || !existsSync(worktree.path)) {
				throw createConversationOpenError("invalid_conversation_target", "unknown or unavailable worktree", {
					workspace: workspaceName,
				});
			}
			return worktree;
		}
		if (targetSessionId === undefined) {
			return undefined;
		}
		const worktree = await this.worktrees.resolveSessionWorktree(workspaceName, targetSessionId);
		if (worktree === undefined) {
			return undefined;
		}
		if (!existsSync(worktree.path)) {
			throw createConversationOpenError("session_unavailable", "worktree checkout is unavailable", {
				workspace: workspaceName,
				sessionId: targetSessionId,
			});
		}
		return worktree;
	}

	private async resolveConversationWorkingDirectory(options: {
		workspace: IrohRemoteWorkspace;
		rootPath: string;
		workingDirectory?: string;
		worktree?: IrohRemoteWorkspaceWorktree;
	}): Promise<WorkspaceDirectoryResolution> {
		if (options.worktree === undefined) {
			const parentDirectory = await this.worktrees.validateWorkingDirectory(
				options.workspace,
				options.workingDirectory,
			);
			if (!parentDirectory.ok) {
				const message = parentDirectory.detail ?? parentDirectory.error;
				throw createConversationOpenError("invalid_conversation_target", message, {
					workspace: options.workspace.name,
				});
			}
			return parentDirectory.directory;
		}
		const worktreeDirectory = await this.worktrees.resolveWorktreeWorkingDirectory(
			options.workspace,
			options.worktree,
			options.workingDirectory,
		);
		if (!worktreeDirectory.ok) {
			throw createConversationOpenError(
				"invalid_conversation_target",
				worktreeDirectory.detail ?? worktreeDirectory.error,
				{
					workspace: options.workspace.name,
					worktreeId: options.worktree.id,
				},
			);
		}
		return worktreeDirectory.directory;
	}

	// ==========================================================================
	// Integrated conversation serving
	// ==========================================================================

	private createPushNotificationDispatcher(
		authorization: IrohRemoteClientAuthorizationSuccess,
	): IrohRemotePushNotificationDispatcher {
		return new IrohRemotePushNotificationDispatcher({
			auditLogger: this.services.auditLogger,
			clientNodeId: authorization.client.nodeId,
			deduper: this.pushNotificationDeduper,
			relayClient: this.pushRelayClient,
			stateManager: this.stateManager,
			workspace: authorization.workspace.name,
		});
	}

	private async revokeClientPushTargets(client: IrohRemoteClient | undefined): Promise<void> {
		if ((client?.pushTargets?.length ?? 0) === 0) return;
		try {
			const summary = await revokeIrohRemoteClientPushTargets(client, this.pushRelayClient);
			const complete = summary.failed === 0 && summary.skipped === 0;
			if (!complete) {
				this.log("warn", "remote push-target cleanup incomplete after client revoke", { ...summary });
			}
			await this.logAudit({
				type: "push_targets_revoked",
				clientNodeId: client?.nodeId,
				success: complete,
				error: complete ? undefined : "remote push-target cleanup incomplete; relay TTL remains the lifetime bound",
				details: { ...summary, remainingLifetimeBound: "relay_target_ttl" },
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log("warn", "remote push-target cleanup failed after client revoke", { error: message });
			await this.logAudit({
				type: "push_targets_revoked",
				clientNodeId: client?.nodeId,
				success: false,
				error: "remote push-target cleanup failed; relay TTL remains the lifetime bound",
				details: { remainingLifetimeBound: "relay_target_ttl" },
			});
		}
	}

	private async writeTerminalHandshakeResponse(
		stream: IrohBiStreamLike,
		response: IrohRemoteHandshakeResponse,
	): Promise<void> {
		try {
			await writeIrohRemoteHandshakeResponse(stream.send, response);
		} finally {
			await Promise.resolve(stream.send.finish?.()).catch(() => {});
			await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
		}
	}

	private async sendHandshakeError(stream: IrohBiStreamLike, error: unknown): Promise<void> {
		const record = (error ?? {}) as Record<string, unknown>;
		// Plain {message, ...} records (abortPendingRelay, lease re-check) must not
		// stringify to "[object Object]".
		const message =
			error instanceof Error ? error.message : typeof record.message === "string" ? record.message : String(error);
		const outcome = typeof record.outcome === "string" ? record.outcome : undefined;
		const workspace = typeof record.workspace === "string" ? record.workspace : undefined;
		const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
		const retryAfterMs = typeof record.retryAfterMs === "number" ? record.retryAfterMs : undefined;
		await this.writeTerminalHandshakeResponse(
			stream,
			createIrohRemoteHandshakeFailure(message, {
				hostNodeId: this.hostNodeId,
				...(outcome === undefined ? {} : { outcome: outcome as never }),
				...(workspace === undefined ? {} : { workspace }),
				...(sessionId === undefined ? {} : { sessionId }),
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			}),
		);
	}

	private async rejectDuplicateActiveConnection(
		stream: IrohBiStreamLike,
		authorization: IrohRemoteClientAuthorizationSuccess,
		sessionId: string,
		source = "active_stream_registry",
	): Promise<void> {
		const error = "duplicate conversation connection";
		await this.logAudit({
			type: "duplicate_connection_rejected",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: false,
			error,
			details: {
				retryAfterMs: DUPLICATE_CONVERSATION_RETRY_AFTER_MS,
				sessionId,
				source,
			},
		});
		await this.writeTerminalHandshakeResponse(
			stream,
			createIrohRemoteHandshakeFailure(error, {
				hostNodeId: this.hostNodeId,
				outcome: "duplicate_conversation_connection",
				workspace: authorization.workspace.name,
				sessionId,
				retryAfterMs: DUPLICATE_CONVERSATION_RETRY_AFTER_MS,
			}),
		);
	}

	private async closeReplacedActiveStreams(
		authorization: IrohRemoteClientAuthorizationSuccess,
		replacementStreamId: string,
		replacedEntries: IrohRemoteActiveStreamEntry[],
	): Promise<void> {
		if (replacedEntries.length === 0) {
			return;
		}
		const replacedStreamIds = replacedEntries.map((entry) => entry.streamId);
		for (const entry of replacedEntries) {
			await Promise.resolve(entry.close(ACTIVE_REPLACE_CLOSE_REASON)).catch(() => {});
		}
		this.requestCloseWhenIdleForEntries(replacedEntries, ACTIVE_REPLACE_CLOSE_REASON);
		this.log(
			"info",
			`client stream replaced: ${authorization.client.nodeId}/${authorization.workspace.name} (${replacedStreamIds.join(", ")} -> ${replacementStreamId})`,
		);
		await this.logAudit({
			type: "duplicate_connection_replaced",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: true,
			details: {
				closeReason: ACTIVE_REPLACE_CLOSE_REASON,
				closedCount: replacedEntries.length,
				replacedStreamIds,
				replacementStreamId,
				source: "active_stream_registry",
			},
		});
	}

	/**
	 * Relay a phone conversation stream to the owning TUI (§5.6): the daemon
	 * has already authenticated the phone; the TUI serves the framed RPC from
	 * its in-process runtime over a dedicated relay unix connection.
	 */
	private async relayConversationToTui(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		targetSessionId: string,
		tuiConnectionId: string,
	): Promise<void> {
		const authorization = handshake.authorization;
		const workspaceName = authorization.workspace.name;

		// Duplicate handling per clientNodeId + key: duplicates already on this
		// Iroh connection are real duplicates; entries on older connections are
		// stale for this conversation and may be replaced independently of any
		// sibling subagent streams that opened first on the new connection.
		const liveRelays = this.relays.activeForConversation(authorization.client.nodeId, workspaceName, targetSessionId);
		const pendingRelays = this.relays.pendingForConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
		);
		if (
			liveRelays.some((relay) => relay.connectionId === connectionId) ||
			pendingRelays.some((pending) => pending.connectionId === connectionId)
		) {
			await this.rejectDuplicateActiveConnection(stream, authorization, targetSessionId, "relay_registry");
			return;
		}
		for (const relay of liveRelays) {
			relay.close("error");
		}
		// Unredeemed offers for the same conversation on older connections are
		// superseded by this one: fail their deferred handshakes and settle them
		// (relay_closed to the TUI, lease bookkeeping) instead of leaking tasks.
		for (const pending of pendingRelays) {
			this.abortPendingRelay(pending.relayId, "error", "relay offer superseded; retry", RELAY_OFFER_RETRY_AFTER_MS);
		}

		// Resolve the concrete session target for the preamble (§3.7).
		const target: IrohRemoteSessionTarget =
			handshake.hello.mode === "conversation" && handshake.hello.conversation.target === "session"
				? { kind: "session", sessionId: handshake.hello.conversation.sessionId }
				: { kind: "last", resumeSessionId: targetSessionId };
		// A worktree-bound session must resolve against the worktree cwd (the
		// parent-keyed session dir plus a non-matching cwd makes SessionManager.list
		// filter by header cwd, restricting resolution to that worktree's sessions).
		const boundWorktree = await this.stateManager.findWorktreeForSession(workspaceName, targetSessionId);
		const relayOwnerCapabilities = this.services.controlServer
			.connections()
			.find((controlConnection) => controlConnection.connectionId === tuiConnectionId)?.capabilities;
		if (!relayOwnerCapabilities?.has(CONTROL_RPC_GRANTS_CAPABILITY)) {
			await this.sendHandshakeError(stream, {
				message: "conversation owner is not grant-aware; retry",
				retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
			});
			return;
		}
		// Worktree-bound conversations are only relayed to TUIs that advertised the
		// worktrees control capability (an old TUI would sanitize with the parent
		// root and leak host paths), and never when the checkout has vanished.
		const relayGate = evaluateWorktreeRelayGate(boundWorktree, relayOwnerCapabilities, CONTROL_WORKTREES_CAPABILITY);
		if (!relayGate.ok) {
			if (relayGate.reason === "checkout_missing") {
				await this.sendHandshakeError(stream, {
					message: "worktree checkout is unavailable",
					outcome: "session_unavailable",
					workspace: workspaceName,
					sessionId: targetSessionId,
				});
				return;
			}
			await this.sendHandshakeError(stream, {
				message: "conversation owner cannot serve worktree sessions; retry",
				retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
			});
			return;
		}
		let resolvedTarget: Awaited<ReturnType<typeof resolveIrohRemoteSessionTarget>>;
		try {
			resolvedTarget = await resolveIrohRemoteSessionTarget(
				target,
				{ name: workspaceName, path: authorization.workspace.path },
				createSessionManagerTargetStore(
					boundWorktree?.path ?? authorization.workspace.path,
					getDefaultSessionDir(authorization.workspace.path, this.services.agentDir),
					{ listAll: true, preserveSessionCwd: true },
				),
			);
		} catch (error) {
			await this.sendHandshakeError(stream, error);
			return;
		}
		const resolvedSessionManager = resolvedTarget.sessionManager as { getCwd?: () => string };
		const resolvedSessionCwd =
			resolvedSessionManager.getCwd?.() ?? boundWorktree?.path ?? authorization.workspace.path;
		const relayWorkingDirectoryRelativeToRoot = getRelativeWorkingDirectoryForRoot(
			boundWorktree?.path ?? authorization.workspace.path,
			resolvedSessionCwd,
		);
		if (relayWorkingDirectoryRelativeToRoot === null) {
			await this.sendHandshakeError(stream, {
				message: "stored session working directory is outside the authorized workspace",
				outcome: "session_unavailable",
				workspace: workspaceName,
				sessionId: targetSessionId,
			});
			return;
		}
		const relayWorkingDirectory =
			boundWorktree === undefined
				? relayWorkingDirectoryRelativeToRoot
				: getRegisteredWorkingDirectoryForWorktree(boundWorktree, relayWorkingDirectoryRelativeToRoot);

		// Session-target resolution awaited; the lease can have moved (release,
		// rekey, connection loss) in the meantime. Re-check before minting so the
		// offer cannot go to a stale or dead owner.
		const lease = this.leaseBroker.lookup(workspaceName, targetSessionId);
		if (lease?.state !== "tui-owned" || lease.tuiConnectionId !== tuiConnectionId) {
			await this.sendHandshakeError(stream, {
				message: "conversation lease owner changed; retry",
				retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
			});
			return;
		}
		// The target-resolution awaits above can race an access update or revoke.
		// Recheck immediately before the synchronous mint so stale authorization
		// cannot create a new pending offer after control-plane invalidation acks.
		if (!(await this.isAuthorizationGrantCurrent(authorization))) {
			await this.sendHandshakeError(stream, { message: "client access changed; reconnect" });
			return;
		}

		// A sibling stream can resolve/redeem while this stream awaits target
		// resolution. Re-check immediately before minting the offer.
		const currentLiveRelays = this.relays.activeForConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
		);
		const currentPendingRelays = this.relays.pendingForConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
		);
		if (
			currentLiveRelays.some((relay) => relay.connectionId === connectionId) ||
			currentPendingRelays.some((pending) => pending.connectionId === connectionId)
		) {
			await this.rejectDuplicateActiveConnection(stream, authorization, targetSessionId, "relay_registry");
			return;
		}
		for (const relay of currentLiveRelays) {
			relay.close("error");
		}
		for (const pending of currentPendingRelays) {
			this.abortPendingRelay(pending.relayId, "error", "relay offer superseded; retry", RELAY_OFFER_RETRY_AFTER_MS);
		}

		const settled = new Promise<void>((resolveSettled) => {
			const relay = this.relays.mint({
				workspaceName,
				sessionId: targetSessionId,
				clientNodeId: authorization.client.nodeId,
				connectionId,
				ownerControlConnectionId: tuiConnectionId,
				streamId,
				stream,
				preamble: {
					handshake: {
						hello: handshake.hello,
						response: handshake.response,
						initialInput: Array.from(handshake.initialInput),
					},
					authorization: {
						clientNodeId: authorization.client.nodeId,
						allowedTools: authorization.client.allowedTools,
						rpcGrant: authorization.client.rpcGrant,
						workspaceName,
						workspacePath: authorization.workspace.path,
						...(boundWorktree === undefined
							? {}
							: {
									worktreeId: boundWorktree.id,
									worktreePath: boundWorktree.path,
									...(boundWorktree.sourceRootRelativePath === undefined
										? {}
										: { worktreeSourceRootRelativePath: boundWorktree.sourceRootRelativePath }),
								}),
					},
					// The phone verifies the saved host's node id in the handshake
					// response the TUI writes; without this the relay path fails the
					// client's identity check.
					...(this.hostNodeId === undefined ? {} : { hostNodeId: this.hostNodeId }),
					relayMode: this.relayMode,
					...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
					connectionId,
					streamId,
					resolvedTarget: {
						sessionId: resolvedTarget.sessionId,
						...(resolvedTarget.sessionFilePath === undefined
							? {}
							: { sessionFilePath: resolvedTarget.sessionFilePath }),
						selection: resolvedTarget.selection,
						...(resolvedTarget.requestedSessionId === undefined
							? {}
							: { requestedSessionId: resolvedTarget.requestedSessionId }),
						workspaceName: resolvedTarget.workspaceName,
						workspacePath: resolvedTarget.workspacePath,
						...(boundWorktree === undefined ? {} : { worktreeId: boundWorktree.id }),
						...(relayWorkingDirectory === undefined ? {} : { workingDirectory: relayWorkingDirectory }),
					},
				},
				settle: (outcome) => {
					this.leaseBroker.unregisterRelay(workspaceName, targetSessionId, relay.relayId);
					this.services.controlServer.sendTo(tuiConnectionId, {
						type: "relay_closed",
						relayId: relay.relayId,
						reason: outcome.reason,
					});
					void this.logAudit({
						type: "relay_closed",
						clientNodeId: authorization.client.nodeId,
						workspace: workspaceName,
						success: outcome.error === undefined,
						error: outcome.error,
						details: {
							relayId: relay.relayId,
							reason: outcome.reason,
							bytesUp: outcome.bytesUp,
							bytesDown: outcome.bytesDown,
							durationMs: outcome.durationMs,
						},
					});
					resolveSettled();
				},
			});

			// The offer is single-use with a 10s expiry; the phone's handshake
			// response is deferred until the TUI redeems the token.
			const expiryTimer = setTimeout(() => {
				this.abortPendingRelay(relay.relayId, "error", "relay offer expired; retry", RELAY_OFFER_RETRY_AFTER_MS);
			}, RELAY_TOKEN_TTL_MS);
			expiryTimer.unref?.();

			this.leaseBroker.registerRelay(workspaceName, targetSessionId, relay.relayId);
			void this.logAudit({
				type: "relay_opened",
				clientNodeId: authorization.client.nodeId,
				workspace: workspaceName,
				success: true,
				details: {
					relayId: relay.relayId,
					workspaceName,
					sessionId: targetSessionId,
					connectionId,
					streamId,
				},
			});
			const delivered = this.services.controlServer.sendTo(tuiConnectionId, {
				type: "relay_offer",
				relayId: relay.relayId,
				relayToken: relay.relayToken,
				workspaceName,
				sessionId: targetSessionId,
				clientNodeId: authorization.client.nodeId,
				connectionId,
				streamId,
			});
			if (!delivered) {
				// The TUI connection vanished between the lease check and the offer;
				// fail the phone's deferred handshake now instead of after the TTL.
				this.abortPendingRelay(
					relay.relayId,
					"error",
					"relay offer undeliverable; retry",
					RELAY_OFFER_RETRY_AFTER_MS,
				);
			}
		});
		await settled;
	}

	private async runIntegratedConversation(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
	): Promise<void> {
		const authorization = handshake.authorization;
		const targetSessionId = getResolvedTargetSessionId(handshake.hello, authorization);
		const daemonAttach = this.leaseBroker.beginDaemonAttach(authorization.workspace.name, targetSessionId);
		if (daemonAttach.kind === "relay") {
			if (!targetSessionId) {
				await this.sendHandshakeError(stream, {
					message: "conversation lease owner changed; retry",
					retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
				});
				return;
			}
			await this.relayConversationToTui(
				stream,
				handshake,
				connectionId,
				streamId,
				targetSessionId,
				daemonAttach.tuiConnectionId,
			);
			return;
		}
		if (daemonAttach.kind === "retry") {
			await this.sendHandshakeError(stream, {
				message: "conversation lease is draining; retry",
				retryAfterMs: daemonAttach.retryAfterMs,
			});
			return;
		}
		const daemonAttachClaim: DaemonAttachClaim = daemonAttach.claim;
		let entry: IntegratedRuntimeEntry;
		let sessionSelection: Awaited<ReturnType<IntegratedRuntimeRegistry["getOrCreateEntry"]>>["sessionSelection"];
		let createdRuntime = false;
		try {
			({
				entry,
				sessionSelection,
				created: createdRuntime,
			} = await this.runtimes.getOrCreateEntry(
				{ hello: handshake.hello, response: handshake.response },
				authorization,
			));
		} catch (error) {
			this.leaseBroker.abortDaemonAttach(daemonAttachClaim);
			await this.logAudit({
				type: "runtime_failure",
				clientNodeId: authorization.client.nodeId,
				workspace: authorization.workspace.name,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				details: { runtime: "integrated-volt" },
			});
			await this.sendHandshakeError(stream, error);
			return;
		}

		if (
			this.activeStreams.hasConversationOnConnection(
				authorization.client.nodeId,
				authorization.workspace.name,
				entry.sessionId,
				connectionId,
			)
		) {
			this.leaseBroker.abortDaemonAttach(daemonAttachClaim);
			if (createdRuntime) {
				await this.runtimes.cleanupUncommittedEntry(entry, sessionSelection);
			} else {
				// Reattach: getOrCreateEntry cancelled the detached-runtime retention
				// timer up front. Re-arm it (no-op unless the entry is still detached
				// with no timer) so aborting here never leaves the runtime unswept.
				await this.runtimes.detachWithoutSubscriber(entry, "reattach_superseded");
			}
			await this.rejectDuplicateActiveConnection(stream, authorization, entry.sessionId);
			return;
		}

		let activeStream: { entry: IrohRemoteActiveStreamEntry; remove: () => void } | undefined;
		let subscriber: IntegratedRuntimeSubscriber | undefined;
		let subscriberError: unknown;
		let handshakeCommitted = false;
		try {
			const brokerCommit = this.leaseBroker.commitDaemonRuntime(
				daemonAttachClaim,
				authorization.workspace.name,
				entry.sessionId,
			);
			if (!brokerCommit.ok) {
				if (createdRuntime) {
					await this.runtimes.cleanupUncommittedEntry(entry, sessionSelection);
				}
				if (
					brokerCommit.reason === "tui_owned" &&
					brokerCommit.tuiConnectionId &&
					targetSessionId === entry.sessionId
				) {
					await this.relayConversationToTui(
						stream,
						handshake,
						connectionId,
						streamId,
						entry.sessionId,
						brokerCommit.tuiConnectionId,
					);
					return;
				}
				await this.sendHandshakeError(stream, {
					message: "conversation lease owner changed; retry",
					retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
				});
				return;
			}
			try {
				await this.runtimes.commitEntry(entry, sessionSelection, authorization);
			} catch (error) {
				this.leaseBroker.rollbackDaemonRuntimeCommit(
					authorization.workspace.name,
					entry.sessionId,
					brokerCommit.previousState,
				);
				throw error;
			}
			if (
				this.activeStreams.hasConversationOnConnection(
					authorization.client.nodeId,
					authorization.workspace.name,
					entry.sessionId,
					connectionId,
				)
			) {
				this.leaseBroker.rollbackDaemonRuntimeCommit(
					authorization.workspace.name,
					entry.sessionId,
					brokerCommit.previousState,
				);
				if (createdRuntime) {
					await this.runtimes.cleanupUncommittedEntry(entry, sessionSelection);
				} else {
					await this.runtimes.detachWithoutSubscriber(entry, "reattach_superseded");
				}
				await this.rejectDuplicateActiveConnection(stream, authorization, entry.sessionId);
				return;
			}
			handshakeCommitted = true;
			// Worktree-bound conversations sanitize with the worktree checkout as the
			// root; the parent checkout and the worktrees root must ALSO redact (bash
			// output like `git worktree list` prints both).
			const worktreeSanitizerOverrides: RemoteSanitizerOverrides | undefined =
				entry.worktreePath === undefined
					? undefined
					: {
							remoteWorkspacePath:
								entry.worktreeSourceRootRelativePath === undefined
									? "/workspace"
									: `/workspace/${entry.worktreeSourceRootRelativePath}`,
							workspacePath: entry.worktreePath,
							additionalRedactedPaths: [authorization.workspace.path, getWorktreesRoot(this.services.agentDir)],
						};
			if (!(await this.isAuthorizationGrantCurrent(authorization))) {
				await this.runtimes.stopEntry(entry, "access_updated_during_attach");
				throw new Error("client access changed during conversation attach; reconnect");
			}
			const replacedEntries = this.activeStreams.takeEntriesForConversationOnOtherConnections(
				authorization.client.nodeId,
				authorization.workspace.name,
				entry.sessionId,
				connectionId,
			);
			activeStream = this.registerActiveStream(
				authorization,
				entry.sessionId,
				stream,
				connectionId,
				streamId,
				worktreeSanitizerOverrides === undefined ? {} : { sanitizerOverrides: worktreeSanitizerOverrides },
			);
			await this.closeReplacedActiveStreams(authorization, streamId, replacedEntries);
			await writeIrohRemoteHandshakeResponse(
				stream.send,
				createIntegratedConversationHandshakeResponse(
					{ hello: handshake.hello, response: handshake.response },
					authorization,
					entry.sessionId,
					sessionSelection,
					this.getResponseContext(),
					entry.worktreeId,
					entry.workingDirectory,
				),
			);
			subscriber = await this.runtimes.attachSubscriber(entry);
			this.leaseBroker.onDaemonRuntimeStreamCountChanged(
				authorization.workspace.name,
				entry.sessionId,
				entry.subscribers.size,
			);
			await this.runtimes.replayWorkflowEvents(activeStream.entry, entry);
			const pushDispatcher = this.createPushNotificationDispatcher(authorization);
			await runIrohRemoteRpcMode(entry.runtime, {
				rpcGrant: authorization.client.rpcGrant,
				isRpcGrantCurrent: () => this.isAuthorizationGrantCurrent(authorization),
				decorateOutbound: (value) => decorateRemoteHostState(value, authorization, this.getResponseContext()),
				disposeRuntimeOnClose: false,
				notificationDelivery: pushDispatcher,
				onClientCapabilitiesChanged: (features) => {
					const streamEntry = activeStream?.entry;
					if (streamEntry) {
						streamEntry.capabilities = new Set(features);
						this.pushThemeTokensToStream(streamEntry);
					}
				},
				onSessionChanged: async (session) => {
					await this.runtimes.handleSessionChanged(entry, activeStream?.entry, session, authorization);
				},
				onWorkflowEvent: async (event) => {
					await this.runtimes.handleWorkflowEvent(
						entry,
						event as unknown as Record<string, unknown>,
						activeStream?.entry,
					);
				},
				registerPushTarget: (args) => pushDispatcher.registerPushTarget(args),
				remoteCommandHandler: (command) =>
					handleIntegratedConversationRpcCommand(
						command as { type: string } & Record<string, unknown>,
						authorization,
						this.getCommandContext({
							workspaceName: authorization.workspace.name,
							workspacePath: authorization.workspace.path,
							entry,
							streamEntry: activeStream?.entry,
						}),
						entry.runtime,
					),
				stream,
				initialInput: handshake.initialInput,
				workspaceName: authorization.workspace.name,
				workspacePath: entry.worktreePath ?? authorization.workspace.path,
				...(worktreeSanitizerOverrides?.remoteWorkspacePath === undefined
					? {}
					: { remoteWorkspacePath: worktreeSanitizerOverrides.remoteWorkspacePath }),
				...(worktreeSanitizerOverrides?.additionalRedactedPaths === undefined
					? {}
					: { additionalRedactedPaths: worktreeSanitizerOverrides.additionalRedactedPaths }),
			});
		} catch (error) {
			subscriberError = error;
			if (!handshakeCommitted) {
				if (createdRuntime) {
					await this.runtimes.cleanupUncommittedEntry(entry, sessionSelection);
				}
				await this.sendHandshakeError(stream, error);
				return;
			}
		} finally {
			if (subscriber) {
				await this.runtimes.detachSubscriber(
					entry,
					subscriber,
					subscriberError ? "transport_error" : "transport_closed",
					subscriberError,
				);
				this.leaseBroker.onDaemonRuntimeStreamCountChanged(
					authorization.workspace.name,
					entry.sessionId,
					entry.subscribers.size,
				);
			} else if (handshakeCommitted || !createdRuntime) {
				// handshakeCommitted: normal detach after the runtime ran. !createdRuntime:
				// a reattach that failed before attachSubscriber, whose retention timer
				// getOrCreateEntry cancelled up front — re-arm it so the runtime is still
				// swept at TTL instead of leaking forever. detachWithoutSubscriber no-ops
				// when the entry was replaced or still has other subscribers.
				await this.runtimes.detachWithoutSubscriber(
					entry,
					subscriberError ? "transport_error" : "transport_closed",
				);
				// Sync the lease's stream count to reality. Without this, a handshake
				// write that failed after commitDaemonRuntime but before attachSubscriber
				// leaves the lease stuck at daemon-active with no live stream until the
				// detached-runtime retention TTL expires.
				this.leaseBroker.onDaemonRuntimeStreamCountChanged(
					authorization.workspace.name,
					entry.sessionId,
					entry.subscribers.size,
				);
			}
			activeStream?.remove();
		}
	}

	// ==========================================================================
	// Stream/connection registries
	// ==========================================================================

	private registerClientConnection(nodeId: string, connectionId: string, supervisor: IrohConnectionSupervisor): void {
		const record: ClientConnectionRecord = {
			connectionId,
			supervisor,
		};
		let records = this.clientConnections.get(nodeId);
		if (!records) {
			records = new Set();
			this.clientConnections.set(nodeId, records);
		}
		records.add(record);
		this.connectionSupervisors.set(connectionId, supervisor);
		supervisor.addTerminalFinalizer(() => {
			records.delete(record);
			if (records.size === 0 && this.clientConnections.get(nodeId) === records) {
				this.clientConnections.delete(nodeId);
			}
			if (this.connectionSupervisors.get(connectionId) === supervisor) {
				this.connectionSupervisors.delete(connectionId);
			}
		});
	}

	private closeClientConnectionsForClient(nodeId: string, reason: string): number {
		const records = Array.from(this.clientConnections.get(nodeId) ?? []);
		if (records.length === 0) {
			return 0;
		}
		for (const record of records) {
			record.supervisor.requestClose(reason, "immediate");
		}
		return records.length;
	}

	private requestCloseWhenIdleForEntries(entries: IrohRemoteActiveStreamEntry[], reason: string): void {
		const requestedConnectionIds = new Set<string>();
		for (const entry of entries) {
			if (requestedConnectionIds.has(entry.connectionId)) {
				continue;
			}
			requestedConnectionIds.add(entry.connectionId);
			this.connectionSupervisors.get(entry.connectionId)?.requestClose(reason, "when_idle");
		}
	}

	private async closeActiveStreamsForConnection(connectionId: string, reason: string): Promise<void> {
		const entries = this.activeStreams.entriesForConnection(connectionId);
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
			await Promise.resolve(entry.close(reason)).catch(() => {});
		}
	}

	private async closeActiveStreamsForConversationKey(
		workspaceName: string,
		sessionId: string,
		reason: string,
	): Promise<number> {
		const entries = this.activeStreams.entriesForConversationKey(workspaceName, sessionId);
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
			await Promise.resolve(entry.close(reason)).catch(() => {});
		}
		this.requestCloseWhenIdleForEntries(entries, reason);
		return entries.length;
	}

	private async closeActiveStreamsForWorkspace(
		workspaceName: string,
		reason: string,
		excludedEntry?: IrohRemoteActiveStreamEntry,
	): Promise<number> {
		const entries = this.activeStreams
			.entriesForWorkspaceName(workspaceName)
			.filter((entry) => entry !== excludedEntry);
		if (entries.length === 0) {
			return 0;
		}
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
			await Promise.resolve(entry.close(reason)).catch(() => {});
		}
		this.requestCloseWhenIdleForEntries(entries, reason);
		return entries.length;
	}

	/**
	 * Invalidate an unredeemed relay offer: fail the phone's deferred handshake
	 * immediately and settle the relay (lease bookkeeping, relay_closed to the
	 * TUI, audit).
	 */
	private abortPendingRelay(relayId: string, reason: RelayCloseReason, message: string, retryAfterMs?: number): void {
		const pending = this.relays.invalidatePending(relayId);
		if (!pending) {
			return;
		}
		void this.sendHandshakeError(pending.stream, {
			message,
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		}).finally(() => pending.settle({ reason, bytesUp: 0, bytesDown: 0, durationMs: 0 }));
	}

	private closeRelaysForWorkspace(workspaceName: string, excludeRelayIds?: ReadonlySet<string>): void {
		for (const relay of this.relays.activeRelays()) {
			if (relay.workspaceName === workspaceName && !excludeRelayIds?.has(relay.relayId)) {
				relay.close("workspace_unregistered");
			}
		}
		for (const pending of this.relays.pendingRelays()) {
			if (pending.workspaceName === workspaceName && !excludeRelayIds?.has(pending.relayId)) {
				this.abortPendingRelay(pending.relayId, "workspace_unregistered", "workspace unregistered");
			}
		}
	}

	/**
	 * Post-unregister host cleanup shared by the control, workspace-management,
	 * and conversation RPC unregister paths: closes phone streams, stops
	 * runtimes, drops live activities, and closes TUI relays for the workspace.
	 * Exclusions keep the requesting stream/runtime/relays alive so the
	 * unregister response can still be delivered.
	 */
	private async cleanupUnregisteredWorkspace(
		workspaceName: string,
		exclusions: {
			streamEntry?: IrohRemoteActiveStreamEntry;
			runtimeEntry?: IntegratedRuntimeEntry;
			relayIds?: ReadonlySet<string>;
			/** Enables a non-destructive audit of preserved checkout directories. */
			workspacePath?: string;
		} = {},
	): Promise<{ closedStreamCount: number; stoppedRuntimeCount: number }> {
		const closedStreamCount = await this.closeActiveStreamsForWorkspace(
			workspaceName,
			WORKSPACE_UNREGISTERED_CLOSE_REASON,
			exclusions.streamEntry,
		);
		const stoppedRuntimeCount = await this.runtimes.stopForWorkspace(
			workspaceName,
			WORKSPACE_UNREGISTERED_CLOSE_REASON,
			exclusions.runtimeEntry,
		);
		await this.stateManager.removeLiveActivitiesForWorkspace(workspaceName);
		this.closeRelaysForWorkspace(workspaceName, exclusions.relayIds);
		if (exclusions.workspacePath !== undefined) {
			await this.worktrees
				.cleanupUnregisteredWorkspace({ name: workspaceName, path: exclusions.workspacePath })
				.catch(() => {});
		}
		return { closedStreamCount, stoppedRuntimeCount };
	}

	private async closeActiveStreamsForClientWorkspace(
		nodeId: string,
		workspaceName: string,
		reason: string,
	): Promise<number> {
		const entries = this.activeStreams
			.entriesForClientNodeId(nodeId)
			.filter((entry) => entry.workspaceName === workspaceName);
		if (entries.length === 0) {
			return 0;
		}
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
			await Promise.resolve(entry.close(reason)).catch(() => {});
		}
		this.requestCloseWhenIdleForEntries(entries, reason);
		return entries.length;
	}

	private async closeClientForAccessUpdate(nodeId: string): Promise<void> {
		const runtimeEntries = collectClientAuthorityInvalidationRuntimes(
			this.activeStreams,
			this.runtimes.values(),
			nodeId,
		);
		const entries = collectClientAuthorityInvalidationStreams(this.activeStreams, runtimeEntries, nodeId);
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
		}
		// Invalidate transport and relay authority synchronously. Terminal writes
		// below are best-effort and must never keep old commands or buffered prompts
		// alive behind backpressure.
		this.closeClientConnectionsForClient(nodeId, "access_updated");
		for (const relay of this.relays.activeRelays()) {
			if (relay.clientNodeId === nodeId) relay.close("error");
		}
		for (const pending of this.relays.pendingRelays()) {
			if (pending.clientNodeId === nodeId) {
				this.abortPendingRelay(pending.relayId, "error", "client access updated; reconnect");
			}
		}
		const streamClosures = Promise.allSettled(
			Array.from(entries, (entry) => Promise.resolve(entry.close("access_updated"))),
		);
		await Promise.allSettled(
			Array.from(runtimeEntries, (runtimeEntry) => this.runtimes.stopEntry(runtimeEntry, "access_updated")),
		);
		await streamClosures;
	}

	private async closeWorkspaceAuthorizationRemovedStreams(nodeId: string, workspaceName: string): Promise<void> {
		const reason = "workspace_authorization_removed";
		const closedStreamCount = await this.closeActiveStreamsForClientWorkspace(nodeId, workspaceName, reason);
		const stoppedRuntimeCount = await this.runtimes.stopForClientWorkspace(nodeId, workspaceName, reason);
		const removedLiveActivityCount = await this.stateManager.removeClientLiveActivitiesForWorkspace(
			nodeId,
			workspaceName,
		);
		await this.logAudit({
			type: "workspace_authorization_removed",
			clientNodeId: nodeId,
			workspace: workspaceName,
			success: closedStreamCount > 0 || stoppedRuntimeCount > 0 || removedLiveActivityCount > 0,
			details: {
				closedStreamCount,
				removedLiveActivityCount,
				source: "authorization_failure",
				stoppedRuntimeCount,
			},
		});
	}

	async closeActiveStreamsForClient(nodeId: string): Promise<{ closed: boolean; closedCount: number }> {
		const runtimeEntries = collectClientAuthorityInvalidationRuntimes(
			this.activeStreams,
			this.runtimes.values(),
			nodeId,
		);
		const entries = collectClientAuthorityInvalidationStreams(this.activeStreams, runtimeEntries, nodeId);
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
		}

		// Match access-update ordering: synchronously make active and unredeemed TUI
		// relays unusable before any terminal write, runtime disposal, or control ack.
		const activeRelays = this.relays.activeRelays().filter((relay) => relay.clientNodeId === nodeId);
		const pendingRelays = this.relays.pendingRelays().filter((relay) => relay.clientNodeId === nodeId);
		for (const relay of activeRelays) {
			relay.close("error");
		}
		for (const pending of pendingRelays) {
			this.abortPendingRelay(pending.relayId, "error", "client revoked; re-pair required");
		}

		const closedConnectionCount = this.closeClientConnectionsForClient(nodeId, ACTIVE_REVOKE_CLOSE_REASON);
		const streamClosures = Promise.allSettled(
			Array.from(entries, (entry) => Promise.resolve(entry.close(ACTIVE_REVOKE_CLOSE_REASON))),
		);
		await Promise.allSettled(
			Array.from(runtimeEntries, (runtimeEntry) => this.runtimes.stopEntry(runtimeEntry, "client_revoked")),
		);
		await streamClosures;
		const stoppedRuntimeCount = runtimeEntries.size;
		const closed =
			entries.size > 0 || closedConnectionCount > 0 || activeRelays.length > 0 || pendingRelays.length > 0;
		if (entries.size === 0) {
			await this.logAudit({
				type: "active_connection_revoked",
				clientNodeId: nodeId,
				success: closed || stoppedRuntimeCount > 0,
				error: closed || stoppedRuntimeCount > 0 ? undefined : "no active connection found",
				details: {
					activeRelayCount: activeRelays.length,
					closeReason: ACTIVE_REVOKE_CLOSE_REASON,
					closedConnectionCount,
					pendingRelayCount: pendingRelays.length,
					source: "control_channel",
					stoppedRuntimeCount,
				},
			});
			return { closed, closedCount: closedConnectionCount + activeRelays.length + pendingRelays.length };
		}

		for (const entry of entries) {
			await this.logAudit({
				type: "active_connection_revoked",
				clientNodeId: nodeId,
				workspace: entry.workspaceName,
				success: true,
				details: {
					activeRelayCount: activeRelays.length,
					closeReason: ACTIVE_REVOKE_CLOSE_REASON,
					closedConnectionCount,
					pendingRelayCount: pendingRelays.length,
					source: "control_channel",
					streamId: entry.streamId,
					stoppedRuntimeCount,
				},
			});
		}
		return { closed: true, closedCount: entries.size + activeRelays.length + pendingRelays.length };
	}

	// ==========================================================================
	// Pairing over the control plane
	// ==========================================================================

	private notifyPairingConsumed(
		handshake: { ok: true; authorization: IrohRemoteClientAuthorizationSuccess },
		remoteId: string,
	): void {
		const consumed = handshake.authorization.consumedPairingTicket;
		if (!consumed) {
			return;
		}
		for (const [requestId, pending] of this.pendingPairRequests) {
			if (pending.secretHash !== consumed.secretHash) {
				continue;
			}
			clearTimeout(pending.timer);
			this.pendingPairRequests.delete(requestId);
			this.services.controlServer.sendTo(pending.connectionId, {
				type: "pairing_progress",
				requestId,
				phase: "completed",
				clientNodeId: remoteId,
			});
		}
	}

	private async handlePairRequest(
		connection: ControlConnection,
		request: ControlRequest & { type: "pair_request" },
	): Promise<void> {
		try {
			await withTimeout(
				this.ready.promise,
				IROH_ENDPOINT_READY_TIMEOUT_MS,
				"Iroh endpoint did not become ready within 15s",
			);
		} catch (error) {
			connection.send({
				type: "error",
				id: request.id,
				code: "iroh_unavailable",
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const engine = this.requireEngine();
		const endpoint = this.endpoint;
		if (!endpoint || !this.endpointTicket) {
			connection.send({ type: "error", id: request.id, code: "iroh_unavailable", message: "endpoint not ready" });
			return;
		}
		const workspaceName =
			typeof (request as Record<string, unknown>).workspaceName === "string"
				? ((request as Record<string, unknown>).workspaceName as string)
				: undefined;
		const requestId = randomUUID();
		try {
			const access =
				request.access !== undefined
					? createIrohRemotePresetAccess(request.access)
					: request.allowedTools !== undefined && request.rpcCapabilities !== undefined
						? createIrohRemoteExplicitAccess(
								request.allowedTools,
								parseIrohRemoteRpcCapabilities(request.rpcCapabilities),
							)
						: createIrohRemotePresetAccess("coding");
			const pairing = await engine.pair({
				allowTools: access.allowedTools,
				rpcGrant: access.rpcGrant,
				irohTicket: this.endpointTicket,
				nodeId: this.hostNodeId,
				relayMode: this.relayMode,
				...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
				...(this.relayMode === "production" && this.relayAuthToken !== undefined
					? { relayAuthToken: this.relayAuthToken }
					: {}),
				...(workspaceName === undefined ? {} : { workspace: workspaceName }),
			});
			connection.send({ type: "pair_started", id: request.id, requestId });
			connection.send({
				type: "pairing_progress",
				requestId,
				phase: "ticket",
				ticket: pairing.ticket,
			});
			connection.send({ type: "pairing_progress", requestId, phase: "waiting" });
			const ttlMs = Math.max(0, pairing.expiresAt - Date.now());
			const timer = setTimeout(
				() => {
					if (!this.pendingPairRequests.delete(requestId)) {
						return;
					}
					this.services.controlServer.sendTo(connection.connectionId, {
						type: "pairing_progress",
						requestId,
						phase: "failed",
						error: "pairing ticket expired",
					});
				},
				ttlMs > 0 ? ttlMs : DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS,
			);
			timer.unref?.();
			this.pendingPairRequests.set(requestId, {
				requestId,
				connectionId: connection.connectionId,
				secretHash: hashIrohRemotePairingSecret(pairing.secret),
				expiresAt: pairing.expiresAt,
				timer,
			});
		} catch (error) {
			connection.send({
				type: "error",
				id: request.id,
				code: "pair_failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// ==========================================================================
	// Control plane integration
	// ==========================================================================

	async handleRequest(connection: ControlConnection, request: ControlRequest): Promise<boolean> {
		switch (request.type) {
			case "lease_acquire": {
				const outcome = await this.leaseBroker.acquireForTui({
					connectionId: connection.connectionId,
					workspaceName: request.workspaceName,
					sessionId: request.sessionId,
					force: request.force,
				});
				if (outcome.kind === "granted") {
					connection.send({
						type: "lease_granted",
						id: request.id,
						workspaceName: request.workspaceName,
						sessionId: request.sessionId,
						handoff: outcome.handoff,
					});
					return true;
				}
				if (outcome.kind === "denied") {
					connection.send({ type: "lease_denied", id: request.id, reason: outcome.reason });
					return true;
				}
				connection.send({ type: "lease_pending", id: request.id, viewerFeedId: outcome.viewerFeedId });
				outcome.granted.then(
					(granted) => {
						connection.send({
							type: "lease_granted",
							id: request.id,
							workspaceName: request.workspaceName,
							sessionId: request.sessionId,
							handoff: granted.handoff,
						});
					},
					(error: unknown) => {
						connection.send({
							type: "error",
							id: request.id,
							code: "drain_failed",
							message: error instanceof Error ? error.message : String(error),
						});
					},
				);
				return true;
			}
			case "lease_release": {
				const result = this.leaseBroker.releaseFromTui(
					connection.connectionId,
					request.workspaceName,
					request.sessionId,
				);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: "lease not held" });
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "lease_rekey": {
				this.leaseBroker.rekey(request.workspaceName, request.oldSessionId, request.newSessionId);
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "viewer_subscribe": {
				if (!this.viewerFeeds.subscribe(request.viewerFeedId, connection.connectionId)) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "unknown viewer feed" });
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "viewer_unsubscribe": {
				if (!this.viewerFeeds.unsubscribe(request.viewerFeedId, connection.connectionId)) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "unknown viewer feed" });
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "viewer_abort": {
				if (!(await this.viewerFeeds.abort(request.viewerFeedId, connection.connectionId))) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "unknown viewer feed" });
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "pair_request":
				await this.handlePairRequest(connection, request);
				return true;
			case "pair_cancel": {
				const pending = this.pendingPairRequests.get(request.requestId);
				if (!pending || pending.connectionId !== connection.connectionId) {
					connection.send({
						type: "error",
						id: request.id,
						code: "not_found",
						message: "pairing request not found",
					});
					return true;
				}
				try {
					await this.cancelPendingPairing(request.requestId, pending);
					connection.send({ type: "ok", id: request.id });
				} catch (error) {
					connection.send({
						type: "error",
						id: request.id,
						code: "cancel_failed",
						message: error instanceof Error ? error.message : String(error),
					});
				}
				return true;
			}
			case "relay_rpc": {
				const result = await this.handleRelayRpc(connection, request);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: result.message });
					return true;
				}
				connection.send({
					type: "relay_rpc_result",
					id: request.id,
					response: result.response,
					...(result.workspaceMetadata === undefined ? {} : { workspaceMetadata: result.workspaceMetadata }),
				});
				return true;
			}
			case "relay_notification_delivery": {
				const result = await this.handleRelayNotificationDelivery(connection, request);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: result.message });
					return true;
				}
				connection.send({ type: "relay_push_delivery_result", id: request.id, status: result.status });
				return true;
			}
			case "relay_live_activity_delivery": {
				const result = await this.handleRelayLiveActivityDelivery(connection, request);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: result.message });
					return true;
				}
				connection.send({ type: "relay_push_delivery_result", id: request.id, status: result.status });
				return true;
			}
			case "client_access_update": {
				const access =
					request.access !== undefined
						? createIrohRemotePresetAccess(request.access)
						: createIrohRemoteExplicitAccess(
								request.allowedTools ?? [],
								parseIrohRemoteRpcCapabilities(request.rpcCapabilities),
							);
				const engine = this.engine;
				const updated = engine
					? await engine.updateClientAccess(request.clientNodeId, request.expectedRevision, access)
					: await this.stateManager.updateClientAccess(request.clientNodeId, request.expectedRevision, access);
				if (!engine) {
					await this.logAudit({
						type: "client_access_updated",
						clientNodeId: request.clientNodeId,
						success: updated.ok,
						error: updated.ok ? undefined : updated.reason,
						details: {
							expectedRevision: request.expectedRevision,
							...(updated.ok
								? { revision: updated.client.rpcGrant.revision }
								: { currentRevision: updated.currentRevision }),
						},
					});
				}
				if (!updated.ok) {
					connection.send({
						type: "error",
						id: request.id,
						code: updated.reason,
						message:
							updated.reason === "revision_conflict"
								? `RPC grant revision conflict (current ${updated.currentRevision ?? "unknown"})`
								: updated.reason === "revision_exhausted"
									? "RPC grant revision is exhausted; revoke and re-pair the client"
									: "client not found",
					});
					return true;
				}
				await this.services.state.flush();
				await this.closeClientForAccessUpdate(request.clientNodeId);
				connection.send({
					type: "client_access_updated",
					id: request.id,
					client: {
						clientNodeId: updated.client.nodeId,
						label: updated.client.label,
						pairedAtMs: updated.client.pairedAt,
						lastSeenAtMs: updated.client.lastSeenAt,
						allowedTools: updated.client.allowedTools.length === 0 ? [] : updated.client.allowedTools.split(","),
						rpcGrant: updated.client.rpcGrant,
					},
				});
				return true;
			}
			case "client_revoke": {
				const result = await this.requireEngineSafe();
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: "iroh_unavailable", message: result.error });
					return true;
				}
				const revocation = await result.engine.revokeClient(request.clientNodeId);
				if (!revocation.revoked) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "client not found" });
					return true;
				}
				await this.closeActiveStreamsForClient(request.clientNodeId);
				await this.revokeClientPushTargets(revocation.client);
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "workspace_unregister": {
				let removedWorkspace: Awaited<ReturnType<IrohRemoteHostStateManager["unregisterWorkspace"]>>;
				try {
					removedWorkspace = await this.stateManager.unregisterWorkspace(request.name);
				} catch (error) {
					if (!isIrohRemoteWorkspaceHasWorktreesError(error)) {
						throw error;
					}
					await this.logAudit({
						type: "workspace_unregistered",
						workspace: request.name,
						success: false,
						error: IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
						details: {
							source: "control",
							worktreeCount: error.worktreeIds.length,
							worktreeIds: error.worktreeIds,
						},
					});
					connection.send({
						type: "error",
						id: request.id,
						code: IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
						message: error.message,
					});
					return true;
				}
				if (!removedWorkspace) {
					connection.send({
						type: "error",
						id: request.id,
						code: "not_found",
						message: `No registered workspace named ${request.name}`,
					});
					return true;
				}
				this.engine?.clearPairingSecretForWorkspace(request.name);
				await this.cleanupUnregisteredWorkspace(request.name, { workspacePath: removedWorkspace.path });
				await this.logAudit({
					type: "workspace_unregistered",
					workspace: request.name,
					success: true,
					details: { source: "control" },
				});
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			default:
				if (isWorktreeControlRequest(request)) {
					await handleWorktreeControlRequest(connection, request, {
						manager: this.worktrees,
						stateManager: this.stateManager,
						removeWorktree: (workspace, worktreeId, force) =>
							this.removeWorkspaceWorktree(workspace, worktreeId, force),
					});
					return true;
				}
				return false;
		}
	}

	private async createRelayDeliveryAuthorization(
		connection: ControlConnection,
		request: { clientNodeId: string; workspaceName: string; sessionId: string },
	): Promise<
		{ ok: true; authorization: IrohRemoteClientAuthorizationSuccess } | { ok: false; code: string; message: string }
	> {
		const lease = this.leaseBroker.lookup(request.workspaceName, request.sessionId);
		if (!lease || lease.state !== "tui-owned" || lease.tuiConnectionId !== connection.connectionId) {
			return {
				ok: false,
				code: "not_held",
				message: "relay lease is not held by this control connection",
			};
		}
		const client = await this.stateManager.getClient(request.clientNodeId);
		if (!client) {
			return { ok: false, code: "not_found", message: "paired client not found" };
		}
		const workspace = (await this.stateManager.getState()).workspaces.find(
			(candidate) => candidate.name === request.workspaceName,
		);
		if (!workspace) {
			return { ok: false, code: "not_found", message: `no registered workspace named ${request.workspaceName}` };
		}
		return {
			ok: true,
			authorization: {
				ok: true,
				allowTools: client.allowedTools,
				client,
				paired: true,
				pairingSecretConsumed: false,
				workspace,
				workspaceNames: [workspace.name],
				workspaces: [{ name: workspace.name, status: "available" }],
			},
		};
	}

	private async handleRelayNotificationDelivery(
		connection: ControlConnection,
		request: Extract<ControlRequest, { type: "relay_notification_delivery" }>,
	): Promise<RelayPushDeliveryResult> {
		const notification = request.notification;
		if (notification.sessionId !== undefined && notification.sessionId !== request.sessionId) {
			return { ok: false, code: "session_mismatch", message: "notification session does not match relay session" };
		}
		if (notification.workspace !== undefined && notification.workspace !== request.workspaceName) {
			return {
				ok: false,
				code: "workspace_mismatch",
				message: "notification workspace does not match relay workspace",
			};
		}
		const authorization = await this.createRelayDeliveryAuthorization(connection, request);
		if (!authorization.ok) {
			return authorization;
		}
		const scopedNotification: IrohRemotePushNotificationIntent = {
			...notification,
			sessionId: notification.sessionId ?? request.sessionId,
			workspace: notification.workspace ?? request.workspaceName,
		};
		try {
			const status = await this.createPushNotificationDispatcher(authorization.authorization).deliverNotification(
				scopedNotification,
			);
			return { ok: true, status };
		} catch {
			return { ok: true, status: "failed" };
		}
	}

	private async handleRelayLiveActivityDelivery(
		connection: ControlConnection,
		request: Extract<ControlRequest, { type: "relay_live_activity_delivery" }>,
	): Promise<RelayPushDeliveryResult> {
		const contentState = request.update.contentState;
		if (contentState.sessionID !== undefined && contentState.sessionID !== request.sessionId) {
			return { ok: false, code: "session_mismatch", message: "Live Activity session does not match relay session" };
		}
		if (contentState.workspaceName !== undefined && contentState.workspaceName !== request.workspaceName) {
			return {
				ok: false,
				code: "workspace_mismatch",
				message: "Live Activity workspace does not match relay workspace",
			};
		}
		const authorization = await this.createRelayDeliveryAuthorization(connection, request);
		if (!authorization.ok) {
			return authorization;
		}
		const scopedUpdate: IrohRemoteLiveActivityUpdateIntent = {
			...request.update,
			contentState: {
				...contentState,
				sessionID: contentState.sessionID ?? request.sessionId,
				workspaceName: contentState.workspaceName ?? request.workspaceName,
			},
		};
		try {
			const status = await this.createPushNotificationDispatcher(
				authorization.authorization,
			).deliverLiveActivityUpdate(scopedUpdate);
			return { ok: true, status };
		} catch {
			return { ok: true, status: "failed" };
		}
	}

	/**
	 * Execute a state-touching RPC command forwarded from a TUI-owned relay
	 * against the daemon's real state (§5.6): push targets, live activities,
	 * and workspace unregistration must land here, not in the TUI's in-memory
	 * state copy.
	 */
	private async handleRelayRpc(
		connection: ControlConnection,
		request: Extract<ControlRequest, { type: "relay_rpc" }>,
	): Promise<
		| {
				ok: true;
				response: Record<string, unknown>;
				workspaceMetadata?: { workspaceNames: string[]; workspaces: Array<{ name: string; status: string }> };
		  }
		| { ok: false; code: string; message: string }
	> {
		const relayAuthorization = this.relays.authorizeRpc(request.relayId, connection.connectionId, request);
		if (!relayAuthorization.ok) {
			return relayAuthorization;
		}
		const command = request.command;
		if (!RELAY_RPC_COMMAND_TYPES.has(command.type)) {
			return { ok: false, code: "unsupported", message: `unsupported relay rpc command: ${command.type}` };
		}
		const client = await this.stateManager.getClient(request.clientNodeId);
		if (!client) {
			return { ok: false, code: "not_found", message: "paired client not found" };
		}
		const requiredCapabilities = getIrohRemoteRpcCommandCapabilities(command);
		if (requiredCapabilities === undefined) {
			return { ok: false, code: "unsupported", message: `unsupported relay rpc command: ${command.type}` };
		}
		const missingCapability = getMissingIrohRemoteRpcCapability(client.rpcGrant, requiredCapabilities);
		if (missingCapability !== undefined) {
			return {
				ok: true,
				response: {
					...createIrohRemoteRpcCapabilityDeniedResponse(
						getRpcResponseId(command),
						command.type,
						missingCapability,
					),
				},
			};
		}
		const workspace = (await this.stateManager.getState()).workspaces.find(
			(candidate) => candidate.name === request.workspaceName,
		);
		if (!workspace) {
			return { ok: false, code: "not_found", message: `no registered workspace named ${request.workspaceName}` };
		}
		const authorization: IrohRemoteClientAuthorizationSuccess = {
			ok: true,
			allowTools: client.allowedTools,
			client,
			paired: true,
			pairingSecretConsumed: false,
			workspace,
			workspaceNames: [workspace.name],
			workspaces: [{ name: workspace.name, status: "available" }],
		};
		const responseId = getRpcResponseId(command);
		if (command.type === "set_keep_awake" || command.type === "get_keep_awake") {
			const response = createKeepAwakeRpcResponse(command, this.getCommandContext());
			return { ok: true, response: response as Record<string, unknown> };
		}
		if (command.type === "set_web_search_key" || command.type === "get_web_search_status") {
			const response = createWebSearchKeyRpcResponse(command, this.getCommandContext());
			return { ok: true, response: response as Record<string, unknown> };
		}
		if (command.type === "register_push_target") {
			try {
				const data = await this.createPushNotificationDispatcher(authorization).registerPushTarget(command.args);
				return { ok: true, response: createRpcSuccessResponse(responseId, command.type, { ...data }) };
			} catch (error) {
				return {
					ok: true,
					response: {
						...createIrohRemoteRpcErrorResponse(
							responseId,
							command.type,
							error instanceof Error ? error.message : String(error),
						),
					},
				};
			}
		}
		if (command.type === "register_live_activity") {
			const response = await createRemoteRegisterLiveActivityRpcResponse(
				command,
				authorization,
				this.getCommandContext(),
				request.sessionId,
			);
			return { ok: true, response: response as Record<string, unknown> };
		}
		if (command.type === "unregister_live_activity") {
			const response = await createRemoteUnregisterLiveActivityRpcResponse(
				command,
				authorization,
				this.getCommandContext(),
				request.sessionId,
			);
			return { ok: true, response: response as Record<string, unknown> };
		}
		// unregister_workspace: run against the daemon state with the shared host
		// cleanup, keeping the requesting conversation's own relays open so the
		// response can still be delivered over them.
		const excludeRelayIds = new Set(
			this.relays
				.activeForConversation(request.clientNodeId, request.workspaceName, request.sessionId)
				.map((relay) => relay.relayId),
		);
		const context: ConversationCommandContext = {
			...this.getCommandContext(),
			onWorkspaceUnregistered: async (workspaceName) => {
				await this.cleanupUnregisteredWorkspace(workspaceName, {
					relayIds: excludeRelayIds,
					workspacePath: workspace.path,
				});
			},
		};
		const response = await handleRemoteHostRpcCommand(command, authorization, context);
		if (!response) {
			return { ok: false, code: "unsupported", message: `unsupported relay rpc command: ${command.type}` };
		}
		return {
			ok: true,
			response: response as Record<string, unknown>,
			workspaceMetadata: {
				workspaceNames: [...authorization.workspaceNames],
				workspaces: authorization.workspaces.map((entry) => ({ name: entry.name, status: entry.status })),
			},
		};
	}

	private async requireEngineSafe(): Promise<
		{ ok: true; engine: IrohRemoteHostEngine } | { ok: false; error: string }
	> {
		try {
			await withTimeout(
				this.ready.promise,
				IROH_ENDPOINT_READY_TIMEOUT_MS,
				"Iroh endpoint did not become ready within 15s",
			);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (!this.engine) {
			return { ok: false, error: "iroh host engine is not ready" };
		}
		return { ok: true, engine: this.engine };
	}

	private async cancelPendingPairing(
		requestId: string,
		pending: { secretHash: string; timer: NodeJS.Timeout },
	): Promise<void> {
		clearTimeout(pending.timer);
		if (this.engine) {
			await this.engine.cancelPairingSecretByHash(pending.secretHash);
		} else {
			await this.stateManager.removePendingPairingTicket(pending.secretHash);
		}
		await this.services.state.flush();
		this.pendingPairRequests.delete(requestId);
	}

	onControlConnectionClosed(connection: ControlConnection): void {
		this.leaseBroker.releaseAllForConnection(connection.connectionId);
		for (const [requestId, pending] of this.pendingPairRequests) {
			if (pending.connectionId !== connection.connectionId) continue;
			void this.cancelPendingPairing(requestId, pending).catch((error) => {
				this.log("warn", "failed to cancel pairing after control disconnect", {
					requestId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
	}

	admitRelay(relayId: string, relayToken: string, socket: Socket, bufferedRemainder: Buffer): boolean {
		return this.relays.admit(relayId, relayToken, socket, bufferedRemainder);
	}

	statusExtras(): { leases: ControlLeaseStatus[]; phoneConnections: number; relayCount: number } {
		const leases: ControlLeaseStatus[] = this.leaseBroker.list().map((record) => ({
			workspaceName: record.workspaceName,
			sessionId: record.sessionId,
			state: record.state,
			relayCount: record.relayIds.size,
			streamCount: record.streamCount,
		}));
		return { leases, phoneConnections: this.clientConnections.size, relayCount: this.relays.activeCount() };
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.worktreeRetention.dispose();
		// 1. Stop accepting: close the endpoint accept loop lazily; new hellos are
		//    rejected by the control server's shutting-down gate. Close relays and
		//    unredeemed offers up front with the dedicated host_shutdown reason —
		//    otherwise they die with the endpoint and TUIs see a misleading
		//    relay_closed{error}.
		for (const relay of this.relays.activeRelays()) {
			relay.close("host_shutdown");
		}
		for (const pending of this.relays.pendingRelays()) {
			this.abortPendingRelay(pending.relayId, "host_shutdown", "daemon shutting down");
		}
		// 2. Wait for busy runtimes to go idle (60s cap each, concurrently);
		//    never abort prompt preflight or a turn from shutdown.
		const drainResults = await Promise.allSettled(
			this.runtimes
				.values()
				.filter((entry) => entry.runtime.session.isBusy)
				.map((entry) =>
					withTimeout(entry.runtime.session.waitForIdle(), SHUTDOWN_RUNTIME_IDLE_CAP_MS, "drain cap"),
				),
		);
		const cappedRuntimes = drainResults.filter((result) => result.status === "rejected").length;
		// 3. Flush + dispose runtimes through the normal dispose path.
		await this.runtimes.stopAll("host_shutdown");
		// 4. Close all phone streams and connections with reason host_shutdown.
		for (const nodeId of Array.from(this.clientConnections.keys())) {
			for (const entry of this.activeStreams.entriesForClientNodeId(nodeId)) {
				this.activeStreams.unregister(entry);
				await Promise.resolve(entry.close("host_shutdown")).catch(() => {});
			}
			await this.closeClientConnectionsForClient(nodeId, "host_shutdown");
		}
		try {
			await this.endpoint?.close();
		} catch {
			// Endpoint shutdown is best-effort.
		}
		await Promise.allSettled(this.connectionTasks);
		await this.services.auditLogger.flush().catch(() => {});
		this.log("info", "iroh service stopped", { cappedRuntimes });
	}

	private async logAudit(event: Parameters<VoltdRuntimeServices["auditLogger"]["log"]>[0]): Promise<void> {
		try {
			await this.services.auditLogger.log(event);
		} catch {
			// Audit logging is best-effort.
		}
	}
}
