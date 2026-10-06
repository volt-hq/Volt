import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import type { ControlRelayFrame, ControlRelayOutcome } from "@hansjm10/volt-protocol";
import { isStandaloneBinary } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { discoverGitWorktree } from "../core/git-repository.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { intentRegistry } from "../core/protocol/intents/index.ts";
import { type IntentContext, WorkspaceIntentError } from "../core/protocol/intents/types.ts";
import { queryRegistry } from "../core/protocol/queries/index.ts";
import {
	type AuthorityLoss,
	type ProtocolConnection,
	queryErrorReason,
	rejectionReason,
} from "../core/protocol/server/connection.ts";
import type { IrohBiStreamLike } from "../core/protocol/transport/iroh-transport.ts";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
	getIrohRemoteStreamCapability,
	hasIrohRemoteRpcCapability,
	parseIrohRemoteRpcCapabilities,
	parseIrohRemoteRpcGrant,
} from "../core/remote/iroh/access-grant.ts";
import type { IrohRemoteActiveStreamEntry } from "../core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteActiveStreamRegistry } from "../core/remote/iroh/active-stream-registry.ts";
import {
	createIrohRemoteAgentOptions,
	type IrohRemoteAgentOptions,
	type IrohRemoteAgentOptionsRpcBackend,
} from "../core/remote/iroh/agent-options.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import {
	hashIrohRemotePairingSecret,
	isIrohRemoteClientAllowedForWorkspace,
} from "../core/remote/iroh/authorization.ts";
import { serveIrohRemoteConnection } from "../core/remote/iroh/connection.ts";
import {
	DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS,
	IrohRemoteHostEngine,
	type IrohRemoteHostHandshakeResult,
} from "../core/remote/iroh/engine.ts";
import {
	createIrohRemoteHandshakeFailure,
	type IrohRemoteHandshakeResponse,
	type IrohRemoteHello,
	isIrohRemoteSessionId,
} from "../core/remote/iroh/handshake.ts";
import {
	DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
	DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
	writeIrohRemoteHandshakeResponse,
} from "../core/remote/iroh/handshake-reader.ts";
import { resolveIrohRemoteWorkspaceProjectTrusted } from "../core/remote/iroh/host-policy.ts";
import { type IrohRemotePrReviewRpcBackend, PrReviewPreparationError } from "../core/remote/iroh/pr-review-rpc.ts";
import {
	IROH_REMOTE_ALPN,
	isIrohRemoteHostStorageFullError,
	isIrohRemoteRuntimeToolPolicyWithin,
	normalizeIrohRemoteAllowTools,
	resolveIrohRemoteRuntimeToolPolicy,
} from "../core/remote/iroh/protocol.ts";
import {
	IrohRemoteInMemoryPushNotificationDeduper,
	type IrohRemotePushNotificationDeliveryStatus,
	IrohRemotePushNotificationDispatcher,
	type IrohRemotePushNotificationIntent,
	type IrohRemotePushRelayHttpClient,
	revokeIrohRemoteClientPushTargets,
} from "../core/remote/iroh/push.ts";
import {
	createIrohRemoteSessionContextsRpcBackend,
	type IrohRemoteSessionContextsRpcBackend,
} from "../core/remote/iroh/session-contexts.ts";
import type { IrohRemoteClient, IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import {
	getIrohRemoteAuthorizationLoss,
	IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
	type IrohRemoteHostStateManager,
	isIrohRemoteWorkspaceHasWorktreesError,
} from "../core/remote/iroh/state-manager.ts";
import { getIrohRemoteWorkspaceAvailabilityStatus } from "../core/remote/iroh/workspace.ts";
import type { IrohRemoteWorktreeRpcBackend } from "../core/remote/iroh/worktree-rpc.ts";
import { getDefaultSessionDir, getDefaultSessionDirPath, SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { getCurrentThemeName, getResolvedThemeColors } from "../core/theme/runtime.ts";
import { ProjectTrustStore } from "../core/trust-manager.ts";
import {
	CONTROL_RPC_GRANTS_CAPABILITY,
	CONTROL_WORKTREES_CAPABILITY,
	type ControlLeaseStatus,
	type ControlRelayCredentialStatus,
	type ControlRequest,
	createControlClientStatus,
	type HelloBinding,
	type HelloProof,
	isRemoteTransportPairingAvailable,
	type PhoneRelayPreamble,
	REMOTE_TRANSPORT_REASON_MESSAGES,
	type RelayCloseReason,
	type RemoteTransportHealth,
	STANDALONE_REMOTE_TRANSPORT_MESSAGE,
} from "./control-protocol.ts";
import type { ControlConnection } from "./control-server.ts";
import { ConversationCoordinatorRegistry } from "./conversation-coordinator.ts";
import {
	type ConversationOpenServices,
	createConversationOpenError,
	getResolvedTargetSessionId,
	type ResolvedConversationOpen,
	resolveConversationOpen,
} from "./conversation-open.ts";
import type { IntegratedConversationSessionSelection } from "./handshake-responses.ts";
import { IrohConnectionSupervisor } from "./iroh-connection-supervisor.ts";
import { createIrohEndpointTicket } from "./iroh-endpoint-ticket.ts";
import {
	formatIrohLoadError,
	type IrohBoundEndpointLike,
	type IrohConnectionLike,
	type IrohEndpointBuilderLike,
	type IrohEndpointLike,
	type IrohModuleLike,
	type IrohNativeLoadResult,
	loadIrohModule,
} from "./iroh-native.ts";
import { IrohRelayRecoveryMonitor } from "./iroh-relay-recovery.ts";
import { IrohRemoteResourceGuard } from "./iroh-resource-guard.ts";
import {
	createLifecycleFencedIrohStream,
	IrohStreamLifecycleClosedError,
	isIrohStreamLifecycleClosedError,
	runLifecycleFencedPhysicalOperation,
} from "./iroh-stream-lifecycle.ts";
import { LeaseBroker, type LeaseRecord, type LeaseState } from "./lease-broker.ts";
import type { VoltdRuntimeServices, VoltdServiceExtension } from "./main.ts";
import {
	PrReviewCheckoutError,
	PrReviewCheckoutManager,
	type PrReviewPreparationAuthority,
} from "./pr-review-checkout.ts";
import { createDaemonPushRelayClient } from "./push-relay-client.ts";
import {
	activateIrohManagedRelayCredential,
	createIrohManagedRelayCredentialClaim,
	exchangeIrohManagedRelayCredentialClaim,
	type IrohManagedRelayAppEndpoint,
	type IrohManagedRelayCredential,
	type IrohManagedRelayCredentialClaim,
	IrohRelayCredentialSubscriptionInactiveError,
	managedRelayCredentialFailureRetryMs,
	managedRelayCredentialPendingRetryMs,
	managedRelayCredentialRateLimitRetryMs,
	managedRelayCredentialRefreshAt,
	normalizeIrohCredentialServiceUrl,
	parseIrohManagedRelayAppEndpoint,
	parseIrohManagedRelayCredential,
	parseIrohManagedRelayCredentialClaim,
	refreshIrohManagedRelayCredential,
	revokeIrohManagedRelayAppEndpoint,
	revokeIrohManagedRelayCredential,
} from "./relay-credential.ts";
import { type RelayLifecycleOwner, RelayRegistry } from "./relay-stream.ts";
import {
	type RemoteIntentHost,
	type RemoteStreamKeep,
	type RemoteStreamScope,
	remoteIntentServices,
	remoteStreamAllows,
	toRemoteKeepAwakeStatus,
} from "./remote-intents.ts";
import {
	createSessionManagerTargetStore,
	type IrohRemoteSessionTarget,
	type ResolvedSessionTargetWithManager,
	resolveIrohRemoteSessionTarget,
} from "./session-target.ts";
import { resolveWorktreeCleanupPolicy } from "./state.ts";
import { sanitizeHostThemeTokens } from "./theme-push.ts";
import { ViewerFeedRegistry } from "./viewer-feed.ts";
import { type LiveWorker, MAX_WORKER_HOSTED_SESSIONS, type WorkerRegistry } from "./worker-registry.ts";
import { isPathInside, type WorkspaceDirectoryResolution } from "./workspace-directory.ts";
import {
	evaluateWorktreeRelayGate,
	getRegisteredWorkingDirectoryForWorktree,
	getWorkspaceWorktreesDir,
	getWorktreesRoot,
	handleWorktreeControlRequest,
	isWorktreeControlRequest,
	WorktreeCapacityError,
	WorktreeManager,
	type WorktreeResult,
	WorktreeRetentionSweeper,
} from "./worktree-manager.ts";

const ACTIVE_REVOKE_CLOSE_REASON = "revoked";
/** How long a worker may take to end a relay whose client lost its authority before the daemon closes it (D4). */
const WORKER_RELAY_AUTHORITY_CLOSE_MS = 2_000;
/** Streams of a workspace that was unregistered close with this reason. */
export const WORKSPACE_UNREGISTERED_CLOSE_REASON = "workspace_unregistered";
const ACTIVE_REPLACE_CLOSE_REASON = "replaced";
const DUPLICATE_CONVERSATION_RETRY_AFTER_MS = 500;
const RELAY_OFFER_RETRY_AFTER_MS = 1000;
const WORKSPACE_DISCOVERY_STREAM_SESSION_ID = "$workspace-discovery";
const WORKSPACE_MANAGEMENT_STREAM_SESSION_ID = "$workspace-management";
const IROH_ENDPOINT_READY_TIMEOUT_MS = 15_000;
const IROH_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS = 15_000;
const _SHUTDOWN_RUNTIME_IDLE_CAP_MS = 60_000;
/** Local floor between broker refresh attempts started by a manual relay access check. */
const RELAY_CREDENTIAL_CHECK_MIN_INTERVAL_MS = 5_000;
/** Pinned direct-port bind attempts; covers a predecessor daemon still releasing the socket. */
const DIRECT_PORT_BIND_ATTEMPTS = 3;
const DIRECT_PORT_RETRY_DELAY_MS = 250;

type ManagedRelayRefreshOutcome =
	| { status: "refreshed" }
	| { status: "subscription_inactive" }
	/** Fenced by reset, shutdown, or a newer credential; nothing was scheduled. */
	| { status: "superseded" }
	| { status: "failed"; message: string };

export function isExactTuiChangeObservationLeaseHolder(
	connection: Pick<ControlConnection, "client" | "connectionId">,
	lease: Pick<LeaseRecord, "state" | "tuiConnectionId"> | undefined,
): boolean {
	return (
		connection.client === "tui" && lease?.state === "tui-owned" && lease.tuiConnectionId === connection.connectionId
	);
}

function normalizeRelayCloseReason(reason: string): RelayCloseReason {
	switch (reason) {
		case "phone_disconnected":
		case "tui_disconnected":
		case "lease_transferred":
		case "workspace_unregistered":
		case "host_shutdown":
		case "worker_exited":
		case "error":
			return reason;
		default:
			return "error";
	}
}

function relayPendingMessageForReason(reason: string): string {
	if (reason === "host_shutdown") return "daemon shutting down";
	if (reason === "workspace_unregistered") return "workspace unregistered";
	return "relay offer cancelled; retry";
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
export const VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL = "https://credentials.volt-cli.dev";
export const VOLT_CANARY_RELAY_URLS = ["https://iroh-relay-us-central-canary.volt-cli.dev"];
export const VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL = "https://credentials-canary.volt-cli.dev";

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
	/** Refreshable node-bound credential for a Volt-managed JWT relay. */
	relayCredential?: IrohManagedRelayCredential;
	/** Explicit broker origin for tests/staging; it must match any built-in relay deployment exactly. */
	relayCredentialServiceUrl?: string;
	pushRelayUrl?: string;
	pushRelayAuthToken?: string;
	profile?: string;
}

export interface IrohDaemonServiceDependencies {
	/** Override native module loading for deterministic missing-binding tests. */
	loadIrohModule?: typeof loadIrohModule;
	/** Decorate a freshly bound endpoint (used to exercise native lifecycle failures). */
	decorateEndpoint?(endpoint: IrohEndpointLike): IrohEndpointLike;
	/** Decorate an accepted raw stream before lifecycle fencing (test-only failure injection). */
	decorateAcceptedStream?(stream: IrohBiStreamLike): IrohBiStreamLike;
	/** Pause an authorized attach immediately before its first ownership publication (test-only race injection). */
	beforeAuthorizedStreamPublication?(
		kind: "conversation" | "workspace_discovery" | "workspace_management" | "worktree_management" | "relay",
		authorization: IrohRemoteClientAuthorizationSuccess,
	): void | Promise<void>;
	/** Pause a TUI change receipt after its daemon revision is claimed and before validation (test-only race injection). */
	beforeTuiChangeObservationValidation?(
		request: Readonly<Extract<ControlRequest, { type: "change_observe" }>>,
	): void | Promise<void>;
	/** Override native relay-recovery capabilities and timing (test-only). */
	relayWatchApiSafe?: boolean;
	relayReconnectApiSafe?: boolean;
	relayRecoveryDelayMs?: number;
	relayRecoveryRetryMs?: number;
	relayRecoveryConfirmationTimeoutMs?: number;
	/** Override the manual relay access check's minimum interval since the last broker attempt (test-only). */
	relayCredentialCheckMinIntervalMs?: number;
	/** Override pinned direct-port bind attempts and their retry spacing before the unpinned fallback (test-only). */
	directPortBindAttempts?: number;
	directPortRetryDelayMs?: number;
	/** Override the connection authentication, first-stream accept, and stream handshake deadlines (test-only). */
	handshakeTimeoutMs?: number;
}

export interface ResolvedIrohRelayConfig {
	relayMode: IrohRelayMode;
	relayUrls: string[];
	warning?: string;
}

/**
 * Resolves the effective relay configuration. Precedence: explicit service
 * config, then VOLT_IROH_RELAY_MODE / VOLT_IROH_RELAY_URLS, then origins from
 * persisted managed authority, then the Volt production relay fleet.
 */
export function resolveIrohRelayConfig(
	config: Pick<IrohDaemonServiceConfig, "relayMode" | "relayUrls">,
	env: Record<string, string | undefined> = process.env,
	persistedRelayUrls?: string[],
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
	const configuredUrls = config.relayUrls ?? envUrls ?? persistedRelayUrls;
	const relayUrls =
		relayMode === "production" ? (configuredUrls ?? VOLT_PRODUCTION_RELAY_URLS) : (configuredUrls ?? []);
	return { relayMode, relayUrls, ...(warning === undefined ? {} : { warning }) };
}

export function resolveIrohRelayCredentialServiceUrl(
	relayMode: IrohRelayMode,
	relayUrls: string[],
	explicitServiceUrl?: string,
): string | undefined {
	if (relayMode !== "production") return undefined;
	const normalized = relayUrls.map((value) => new URL(value).origin).sort();
	const isProductionDeployment = sameStringSet(normalized, [...VOLT_PRODUCTION_RELAY_URLS].sort());
	const isCanaryDeployment = sameStringSet(normalized, [...VOLT_CANARY_RELAY_URLS].sort());
	if (!isProductionDeployment && !isCanaryDeployment) return undefined;
	const deploymentServiceUrl = isProductionDeployment
		? VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL
		: VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL;
	if (explicitServiceUrl !== undefined) {
		const normalizedServiceUrl = normalizeIrohCredentialServiceUrl(explicitServiceUrl);
		if (normalizedServiceUrl !== deploymentServiceUrl) {
			throw new Error(
				`explicit managed relay credential service URL conflicts with the ${isProductionDeployment ? "production" : "canary"} relay deployment`,
			);
		}
	}
	return deploymentServiceUrl;
}

function sameStringSet(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
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

function createRelayCredentialStatus(
	credential: IrohManagedRelayCredential | undefined,
	claim: IrohManagedRelayCredentialClaim | undefined,
	revocationPending = false,
	subscriptionInactive = false,
	nextRefreshAt?: number,
): ControlRelayCredentialStatus {
	const expiresAt = credential?.accessTokenExpiresAt;
	const state = revocationPending
		? "revocation_pending"
		: subscriptionInactive
			? "subscription_inactive"
			: expiresAt !== undefined && expiresAt <= Date.now()
				? "expired"
				: claim !== undefined && (claim.expiresAt === undefined || claim.expiresAt > Date.now())
					? "pairing"
					: credential !== undefined
						? "active"
						: "unpaired";
	return {
		state,
		...(expiresAt === undefined ? {} : { expiresAt }),
		...(nextRefreshAt === undefined ? {} : { nextRefreshAt }),
	};
}

function initialRelayCredentialStatus(
	config: IrohDaemonServiceConfig,
	services: VoltdRuntimeServices,
): ControlRelayCredentialStatus | undefined {
	const settings = services.state.state.settings;
	const credential = config.relayCredential ?? settings.relayCredential;
	const claim = settings.relayCredentialClaim;
	const revocation = settings.relayCredentialRevocation;
	const authority = revocation ?? credential ?? claim;
	const relay = resolveIrohRelayConfig(config, process.env, authority?.relayUrls);
	const staticToken =
		config.relayAuthToken ?? process.env.VOLT_IROH_RELAY_AUTH_TOKEN?.trim() ?? settings.relayAuthToken;
	if (relay.relayMode !== "production") return undefined;
	if (authority === undefined) {
		if (staticToken) return undefined;
		try {
			if (resolveIrohRelayCredentialServiceUrl(relay.relayMode, relay.relayUrls) === undefined) return undefined;
		} catch {
			// Malformed custom relay URLs must not break local status reporting
			// after endpoint initialization has already reported its failure.
			return undefined;
		}
	}
	return createRelayCredentialStatus(
		revocation === undefined ? credential : undefined,
		claim,
		revocation !== undefined,
	);
}

interface PendingPairRequest {
	requestId: string;
	connectionId: string;
	secretHash: string;
	expiresAt: number;
	timer: NodeJS.Timeout;
	relayCredentialClaim?: IrohManagedRelayCredentialClaim;
	cancellation?: Promise<void>;
}

interface ClientConnectionRecord {
	connectionId: string;
	supervisor: IrohConnectionSupervisor;
}

/** A phone's relay to the worker hosting its conversation. */
interface WorkerRelay {
	readonly relay: RelayLifecycleOwner;
	/** The daemon's authorization of the phone, re-read before each of its frames acts (D4). */
	readonly authorization: IrohRemoteClientAuthorizationSuccess;
	readonly workerId: string;
}

interface TuiChangeAuthorityClaim {
	readonly connectionId: string;
	readonly revision: bigint;
	workspaceGeneration: number | undefined;
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

/** The IPv4 port among native bound sockets (`a.b.c.d:port`); bracketed IPv6 entries are skipped. */
function ipv4PortFromBoundSockets(sockets: readonly string[]): number | undefined {
	for (const socket of sockets) {
		const match = /^\d{1,3}(?:\.\d{1,3}){3}:(\d{1,5})$/.exec(socket);
		const port = match === null ? Number.NaN : Number(match[1]);
		if (port >= 1 && port <= 65_535) return port;
	}
	return undefined;
}

/** Resolves true after `delayMs`, or false as soon as `signal` aborts. */
async function delayUnlessAborted(delayMs: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return false;
	return await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, delayMs);
		function onAbort() {
			clearTimeout(timer);
			resolve(false);
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForRelayCredentialRetry(delayMs: number): Promise<void> {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, delayMs);
		timer.unref?.();
	});
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

/**
 * Keep a provisional admission task observed, but stop making daemon shutdown
 * wait for an external operation that cannot itself be cancelled. Every
 * ownership publication inside the task still revalidates the lease/signal;
 * if the external promise eventually settles, its normal stale-admission path
 * performs rollback and resource cleanup.
 */
async function waitUntilAdmissionCancelled<T>(task: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) {
		void task.catch(() => {});
		return undefined;
	}
	let detachAbort = () => {};
	const cancelled = new Promise<undefined>((resolve) => {
		const onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		detachAbort = () => signal.removeEventListener("abort", onAbort);
	});
	try {
		return await Promise.race([task, cancelled]);
	} finally {
		detachAbort();
		// Promise.race does not observe a loser that rejects later.
		void task.catch(() => {});
	}
}

export interface IrohDaemonAdmissionLease {
	/** Aborted synchronously when the daemon closes this admission epoch. */
	readonly signal: AbortSignal;
	/** True only while this lease still belongs to the service's open admission epoch. */
	isCurrent(): boolean;
	release(): void;
}

/**
 * One-way admission epoch for daemon-owned work. Closing the gate is
 * synchronous: callers that already crossed an await must revalidate their
 * lease immediately before publishing ownership, while shutdown can await the
 * fixed set of pre-close operations before taking runtime snapshots.
 */
export class IrohDaemonAdmissionGate {
	private open = true;
	private epoch = 0;
	private inFlight = 0;
	private readonly abortController = new AbortController();
	private drainPromise: Promise<void> | undefined;
	private resolveDrain: (() => void) | undefined;

	get isOpen(): boolean {
		return this.open;
	}

	tryAcquire(): IrohDaemonAdmissionLease | undefined {
		if (!this.open) {
			return undefined;
		}
		const leaseEpoch = this.epoch;
		let released = false;
		this.inFlight++;
		return {
			signal: this.abortController.signal,
			isCurrent: () => !released && this.open && this.epoch === leaseEpoch,
			release: () => {
				if (released) {
					return;
				}
				released = true;
				this.inFlight--;
				if (this.inFlight === 0) {
					this.resolveDrain?.();
					this.resolveDrain = undefined;
					this.drainPromise = undefined;
				}
			},
		};
	}

	close(): void {
		if (!this.open) {
			return;
		}
		this.open = false;
		this.epoch++;
		this.abortController.abort(new Error("Iroh daemon admission closed"));
	}

	waitForDrain(): Promise<void> {
		if (this.inFlight === 0) {
			return Promise.resolve();
		}
		if (!this.drainPromise) {
			this.drainPromise = new Promise<void>((resolve) => {
				this.resolveDrain = resolve;
			});
		}
		return this.drainPromise;
	}
}

type IrohPhysicalStreamCloseAction = (reason: string) => Promise<void> | void;

/** Single idempotent owner for a physical bi-stream from accept to task exit. */
export class IrohPhysicalStreamOwner {
	private readonly fallbackClose: IrohPhysicalStreamCloseAction;
	readonly physicalStream: IrohBiStreamLike | undefined;
	private readonly closeController = new AbortController();
	private closeAction: IrohPhysicalStreamCloseAction | undefined;
	/** How long the fence stays open for an installed close action to finish its stream, at most. */
	private fenceAfterMs: number | undefined;
	private readonly settledPromise: Promise<void>;
	private resolveSettled: () => void = () => {};
	private rejectSettled: (error: unknown) => void = () => {};
	private closeStarted = false;

	constructor(fallbackClose: IrohPhysicalStreamCloseAction, physicalStream?: IrohBiStreamLike) {
		this.fallbackClose = fallbackClose;
		this.physicalStream = physicalStream;
		this.settledPromise = new Promise<void>((resolve, reject) => {
			this.resolveSettled = resolve;
			this.rejectSettled = reject;
		});
	}

	get isClosing(): boolean {
		return this.closeStarted;
	}

	get settled(): Promise<void> {
		return this.settledPromise;
	}

	get signal(): AbortSignal {
		return this.closeController.signal;
	}

	/**
	 * Install how the stream closes. With `fenceAfterMs`, the stream stays
	 * usable while the close action runs (at most that long), so the action
	 * can write its final frames and finish the stream; otherwise it is fenced
	 * as the close starts.
	 */
	installCloseAction(closeAction: IrohPhysicalStreamCloseAction, options: { fenceAfterMs?: number } = {}): boolean {
		if (this.closeStarted || this.closeAction !== undefined) {
			return false;
		}
		this.closeAction = closeAction;
		this.fenceAfterMs = options.fenceAfterMs;
		return true;
	}

	close(reason: string): Promise<void> {
		if (this.closeStarted) {
			return this.settledPromise;
		}
		this.closeStarted = true;
		const closeAction = this.closeAction ?? this.fallbackClose;
		const fenceAfterMs = this.closeAction === undefined ? undefined : this.fenceAfterMs;
		const fence = (): void => this.closeController.abort(new IrohStreamLifecycleClosedError());
		try {
			const closeResult = closeAction(reason);
			if (fenceAfterMs === undefined) {
				fence();
			} else {
				const timer = setTimeout(fence, fenceAfterMs);
				timer.unref?.();
				void Promise.resolve(closeResult)
					.catch(() => undefined)
					.finally(() => {
						clearTimeout(timer);
						fence();
					});
			}
			Promise.resolve(closeResult).then(this.resolveSettled, this.rejectSettled);
		} catch (error) {
			this.closeController.abort(new IrohStreamLifecycleClosedError());
			this.rejectSettled(error);
		}
		return this.settledPromise;
	}
}

function closeIrohRemoteStream(stream: IrohBiStreamLike, reason?: string): void {
	try {
		const closeSend =
			reason === "stream_task_settled"
				? stream.send.finish?.()
				: stream.send.reset
					? stream.send.reset(0n)
					: stream.send.finish?.();
		if (closeSend) void Promise.resolve(closeSend).catch(() => {});
	} catch {}
	void Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
}

/** How long a stream the host closes may take to deliver its final frame before it is reset. */
const STREAM_FINAL_FRAME_TIMEOUT_MS = 2_000;

function isAuthorityTighteningCloseReason(reason: string): boolean {
	return (
		reason === ACTIVE_REVOKE_CLOSE_REASON ||
		reason === "workspace_authorization_removed" ||
		reason === "access_updated" ||
		reason === "access_updated_during_attach"
	);
}

/**
 * End a device stream the host closes on purpose. Its connection tells the
 * device why, as its last frame: a revoked or changed grant
 * `fatal{revoked}`, an unregistered workspace `fatal{workspace_unregistered}`,
 * and a host shutdown `fatal{host_shutdown}`. Other closes end the stream
 * without a frame. A stream that cannot deliver its
 * final frame in time is reset.
 *
 * The stream's owner keeps `stream` usable while this close runs, up to the
 * final-frame timeout. A connection that could not end its stream in time,
 * or failed to, has `physical` (the stream under the fence) reset; one that
 * did is finished again, harmlessly.
 */
async function closeStreamConnection(
	stream: IrohBiStreamLike,
	physical: IrohBiStreamLike,
	reason: string,
	connection: ProtocolConnection | undefined,
	lifecycleSettled: Promise<void> | undefined,
): Promise<void> {
	if (connection) {
		const ending = isAuthorityTighteningCloseReason(reason)
			? connection.close({ code: "revoked", message: "The device's access changed; reconnect" })
			: reason === WORKSPACE_UNREGISTERED_CLOSE_REASON
				? connection.close({ code: "workspace_unregistered" })
				: reason === "host_shutdown"
					? connection.shutdown()
					: connection.close();
		const delivered = await Promise.race([
			ending.then(
				() => true,
				() => false,
			),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STREAM_FINAL_FRAME_TIMEOUT_MS).unref()),
		]);
		closeIrohRemoteStream(physical, delivered ? "stream_task_settled" : reason);
	} else {
		closeIrohRemoteStream(stream, reason);
	}
	await lifecycleSettled?.catch(() => {});
}

/** Remote health of a daemon whose Iroh binding did not load; a standalone binary never bundles it. */
function bindingMissingTransport(wrapperVersion: string | undefined): RemoteTransportHealth {
	return {
		state: "unavailable",
		reasonCode: "native_binding_missing",
		message: isStandaloneBinary
			? STANDALONE_REMOTE_TRANSPORT_MESSAGE
			: REMOTE_TRANSPORT_REASON_MESSAGES.native_binding_missing,
		...(wrapperVersion === undefined ? {} : { wrapperVersion }),
	};
}

/**
 * The daemon's Iroh host: owns the endpoint identity, pairing, revocation,
 * headless integrated runtimes, workspace/device streams, push dispatch, and
 * the accept loop. Ported from the dissolved src/remote/iroh-host.mjs.
 *
 * Where the Iroh binding does not load (standalone binaries, `--omit=optional`
 * installs, darwin x64) the service runs without an endpoint: TUIs, workers,
 * workspaces, and worktrees are served as with one, its status reports phone
 * transport unavailable, and pairing is refused with the same guidance.
 */
export function createIrohDaemonService(
	config: IrohDaemonServiceConfig = {},
	dependencies: IrohDaemonServiceDependencies = {},
): VoltdServiceExtension {
	return (services: VoltdRuntimeServices) => {
		const log = services.logger.child("iroh");
		// A standalone binary never bundles the binding: nothing is looked up for it on disk.
		const loaded: IrohNativeLoadResult = isStandaloneBinary ? {} : (dependencies.loadIrohModule ?? loadIrohModule)();
		if (!loaded.iroh) {
			log(
				"warn",
				isStandaloneBinary
					? "phone transport is not included in the standalone binary; serving local clients and workers only"
					: formatIrohLoadError(loaded.error),
			);
		}

		let service: IrohDaemonService;
		try {
			service = new IrohDaemonService(
				loaded.iroh,
				services,
				config,
				loaded.packageVersion,
				loaded.capabilities?.connectedHomeRelayWatch === true,
				loaded.capabilities?.reconnectRelay === true,
				dependencies,
			);
		} catch (error) {
			log("error", `failed to initialize iroh endpoint: ${error instanceof Error ? error.message : String(error)}`);
			const remoteTransport: RemoteTransportHealth = loaded.iroh
				? {
						state: "unavailable",
						reasonCode: "endpoint_start_failed",
						message: REMOTE_TRANSPORT_REASON_MESSAGES.endpoint_start_failed,
						...(loaded.packageVersion === undefined ? {} : { wrapperVersion: loaded.packageVersion }),
					}
				: bindingMissingTransport(loaded.packageVersion);
			return {
				async handleRequest(connection, request) {
					if (request.type !== "pair_request" && request.type !== "relay_credential_check") return false;
					connection.send({
						type: "error",
						id: request.id,
						code: "iroh_unavailable",
						message: remoteTransport.message!,
					});
					return true;
				},
				statusExtras: () => ({ remoteTransport, relayCredential: initialRelayCredentialStatus(config, services) }),
			};
		}
		service.start();
		return {
			handleRequest: (connection, request) => service.handleRequest(connection, request),
			onConnectionClosed: (connection) => service.onControlConnectionClosed(connection),
			onThemeChanged: () => service.onThemeChanged(),
			onKeepAwakeChanged: () => service.onKeepAwakeChanged(),
			statusExtras: () => service.statusExtras(),
			admitRelay: (relayId, proof, binding, socket, bufferedRemainder) =>
				service.admitRelay(relayId, proof, binding, socket, bufferedRemainder),
			quiesce: () => service.quiesce(),
			dispose: () => service.dispose(),
		};
	};
}

class IrohDaemonService {
	/** The Iroh binding; absent where it did not load, and the service then runs without an endpoint. */
	private readonly iroh: IrohModuleLike | undefined;
	private readonly services: VoltdRuntimeServices;
	private readonly dependencies: IrohDaemonServiceDependencies;
	private readonly relayMode: IrohRelayMode;
	private readonly relayUrls: string[];
	private readonly relayWatchApiSafe: boolean;
	private readonly relayReconnectApiSafe: boolean;
	private relayAuthToken: string | undefined;
	private managedRelayCredential: IrohManagedRelayCredential | undefined;
	private managedRelayCredentialClaim: IrohManagedRelayCredentialClaim | undefined;
	private managedRelayAppEndpoints: IrohManagedRelayAppEndpoint[];
	private managedRelayCredentialRevocation: IrohManagedRelayCredential | undefined;
	private readonly relayCredentialServiceUrl: string | undefined;
	private relayCredentialRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** Epoch ms when relayCredentialRefreshTimer fires; set exactly while that timer is pending. */
	private relayCredentialNextRefreshAt: number | undefined;
	private relayCredentialRefreshFailureCount = 0;
	private relayCredentialLastRefreshAttemptAt: number | undefined;
	private relayCredentialExpiryTimer: ReturnType<typeof setTimeout> | undefined;
	private relayCredentialRefreshTask: Promise<ManagedRelayRefreshOutcome> | undefined;
	private relayCredentialExchangeTask: Promise<void> | undefined;
	private relayConfigurationTask: Promise<void> = Promise.resolve();
	private relayRecoveryMonitor: IrohRelayRecoveryMonitor | undefined;
	private relayRecoveryUnsupportedLogged = false;
	private relayCredentialEpoch = 0;
	private relayCredentialIsRevoking = false;
	private relayCredentialSubscriptionInactive = false;
	private readonly relayConfigWarning: string | undefined;
	private readonly profile: string | undefined;
	private readonly wrapperVersion: string | undefined;
	private remoteTransport: RemoteTransportHealth;
	private readonly log: ReturnType<VoltdRuntimeServices["logger"]["child"]>;
	private readonly stateManager: IrohRemoteHostStateManager;
	private readonly activeStreams = new IrohRemoteActiveStreamRegistry();
	private readonly admission = new IrohDaemonAdmissionGate();
	private readonly physicalStreamOwners = new Map<string, IrohPhysicalStreamOwner>();
	private readonly clientConnections = new Map<string, Set<ClientConnectionRecord>>();
	private readonly connectionSupervisors = new Map<string, IrohConnectionSupervisor>();
	private readonly connectionTasks = new Set<Promise<void>>();
	private readonly nativeLifecycleTasks = new Set<Promise<void>>();
	private readonly endpointDisposalTasks = new Map<IrohEndpointLike, Promise<void>>();
	private startupTask: Promise<void> | undefined;
	private startupEndpoint: IrohEndpointLike | undefined;
	private acceptLoopTask: Promise<void> | undefined;
	private readonly resourceGuard = new IrohRemoteResourceGuard();
	private readonly pendingPairRequests = new Map<string, PendingPairRequest>();
	private remoteIntentHostValue: RemoteIntentHost | undefined;
	private readonly pushRelayClient: IrohRemotePushRelayHttpClient;
	private readonly pushNotificationDeduper = new IrohRemoteInMemoryPushNotificationDeduper();
	private readonly trustStore: ProjectTrustStore;
	private readonly conversationCoordinators = new ConversationCoordinatorRegistry();
	/** The conversation workers the daemon supervises: phones' conversations run in them. */
	private readonly workers: WorkerRegistry;
	/** Relays to workers, by relay id: the client's authorization and the worker serving it. */
	private readonly workerRelays = new Map<string, WorkerRelay>();
	/** The client whose open spawned each worker: revoking it, or changing its access, retires the worker. */
	private readonly workerSpawners = new Map<string, string>();
	/** Every client each worker served a relay for: revoking one, or changing its access, retires the worker too. */
	private readonly workerClients = new Map<string, Set<string>>();
	/** Workers spawned in a managed worktree: their exit lets the worktree's retention run. */
	private readonly workerWorktrees = new Map<string, { workspaceName: string; worktreeId: string }>();
	/** Checkouts workers restored, by pin id: pinned until the worker releases them or its connection ends. */
	private readonly workerWorktreePins = new Map<
		string,
		{ readonly connectionId: string; readonly release: () => void }
	>();
	private readonly tuiChangeAuthorities = new Map<string, TuiChangeAuthorityClaim>();
	private readonly tuiChangeRetirementTasks = new Set<Promise<void>>();
	private tuiChangeReceiptRevision = 0n;
	private readonly worktrees: WorktreeManager;
	private readonly prReviewCheckouts: PrReviewCheckoutManager;
	private readonly worktreeRetention: WorktreeRetentionSweeper;
	private readonly leaseBroker: LeaseBroker;
	private readonly viewerFeeds: ViewerFeedRegistry;
	private readonly relays = new RelayRegistry();
	private endpoint: IrohEndpointLike | undefined;
	private engine: IrohRemoteHostEngine | undefined;
	private hostNodeId: string | undefined;
	private endpointTicket: string | undefined;
	private readonly ready: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };

	constructor(
		iroh: IrohModuleLike | undefined,
		services: VoltdRuntimeServices,
		config: IrohDaemonServiceConfig,
		wrapperVersion: string | undefined,
		nativeWatchApiSafe: boolean,
		nativeReconnectApiSafe: boolean,
		dependencies: IrohDaemonServiceDependencies,
	) {
		this.iroh = iroh;
		this.services = services;
		this.dependencies = dependencies;
		this.wrapperVersion = wrapperVersion;
		this.remoteTransport =
			iroh === undefined
				? bindingMissingTransport(wrapperVersion)
				: { state: "starting", ...(wrapperVersion === undefined ? {} : { wrapperVersion }) };
		this.relayWatchApiSafe = dependencies.relayWatchApiSafe ?? nativeWatchApiSafe;
		this.relayReconnectApiSafe = dependencies.relayReconnectApiSafe ?? nativeReconnectApiSafe;
		const persistedRevocation = services.state.state.settings.relayCredentialRevocation;
		this.managedRelayCredentialRevocation =
			persistedRevocation === undefined ? undefined : parseIrohManagedRelayCredential(persistedRevocation);
		const managedRelayCredential = config.relayCredential ?? services.state.state.settings.relayCredential;
		this.managedRelayCredential =
			this.managedRelayCredentialRevocation !== undefined || managedRelayCredential === undefined
				? undefined
				: parseIrohManagedRelayCredential(managedRelayCredential);
		this.managedRelayCredentialClaim =
			services.state.state.settings.relayCredentialClaim === undefined
				? undefined
				: parseIrohManagedRelayCredentialClaim(services.state.state.settings.relayCredentialClaim);
		const persistedRelayUrls =
			this.managedRelayCredential?.relayUrls ??
			this.managedRelayCredentialRevocation?.relayUrls ??
			this.managedRelayCredentialClaim?.relayUrls;
		const relayConfig = resolveIrohRelayConfig(config, process.env, persistedRelayUrls);
		this.relayMode = relayConfig.relayMode;
		this.relayUrls = relayConfig.relayUrls;
		this.relayConfigWarning = relayConfig.warning;
		this.profile = config.profile;
		const envRelayAuthToken = process.env.VOLT_IROH_RELAY_AUTH_TOKEN?.trim();
		const explicitRelayAuthToken =
			config.relayAuthToken ??
			(envRelayAuthToken !== undefined && envRelayAuthToken !== "" ? envRelayAuthToken : undefined);
		this.managedRelayAppEndpoints = (services.state.state.settings.relayCredentialAppEndpoints ?? []).map(
			parseIrohManagedRelayAppEndpoint,
		);
		if (
			new Set(this.managedRelayAppEndpoints.map((endpoint) => endpoint.endpointId)).size !==
				this.managedRelayAppEndpoints.length ||
			new Set(this.managedRelayAppEndpoints.map((endpoint) => endpoint.claimId)).size !==
				this.managedRelayAppEndpoints.length
		) {
			throw new Error("managed relay app endpoint state contains duplicates");
		}
		const builtInRelayCredentialServiceUrl = resolveIrohRelayCredentialServiceUrl(
			this.relayMode,
			this.relayUrls,
			config.relayCredentialServiceUrl,
		);
		if (builtInRelayCredentialServiceUrl !== undefined) {
			for (const [authority, state] of [
				["credential", this.managedRelayCredential],
				["revocation", this.managedRelayCredentialRevocation],
				["claim", this.managedRelayCredentialClaim],
			] as const) {
				if (state !== undefined && state.serviceUrl !== builtInRelayCredentialServiceUrl) {
					throw new Error(
						`managed relay ${authority} authority service URL ${state.serviceUrl} conflicts with the built-in relay deployment broker ${builtInRelayCredentialServiceUrl}`,
					);
				}
			}
		}
		this.relayCredentialServiceUrl =
			builtInRelayCredentialServiceUrl ??
			this.managedRelayCredential?.serviceUrl ??
			this.managedRelayCredentialRevocation?.serviceUrl ??
			this.managedRelayCredentialClaim?.serviceUrl;
		const configuredRelayOrigins = this.relayUrls.map((url) => new URL(url).origin).sort();
		if (this.managedRelayCredential !== undefined) {
			const credentialRelayOrigins = [...this.managedRelayCredential.relayUrls].sort();
			if (!sameStringSet(configuredRelayOrigins, credentialRelayOrigins)) {
				throw new Error("managed relay credential is scoped to a different relay origin set");
			}
		}
		if (this.managedRelayCredentialRevocation !== undefined) {
			const revocationRelayOrigins = [...this.managedRelayCredentialRevocation.relayUrls].sort();
			if (!sameStringSet(configuredRelayOrigins, revocationRelayOrigins)) {
				throw new Error("managed relay credential revocation is scoped to a different relay origin set");
			}
		}
		if (this.managedRelayCredentialClaim !== undefined) {
			const claimRelayOrigins = [...this.managedRelayCredentialClaim.relayUrls].sort();
			if (
				!sameStringSet(configuredRelayOrigins, claimRelayOrigins) ||
				this.managedRelayCredentialClaim.serviceUrl !== this.relayCredentialServiceUrl
			) {
				throw new Error("managed relay credential claim is scoped to a different deployment");
			}
		}
		if (this.managedRelayCredential !== undefined && explicitRelayAuthToken !== undefined) {
			throw new Error("static and managed Iroh relay credentials cannot be configured together");
		}
		this.relayAuthToken =
			this.managedRelayCredentialRevocation !== undefined
				? undefined
				: (this.managedRelayCredential?.accessToken ??
					explicitRelayAuthToken ??
					services.state.state.settings.relayAuthToken);
		if (this.managedRelayCredential !== undefined) {
			services.state.updateSettings({
				relayAuthToken: undefined,
				relayCredential: this.managedRelayCredential,
			});
		} else if (
			this.relayAuthToken !== undefined &&
			this.relayAuthToken !== services.state.state.settings.relayAuthToken
		) {
			// Static access.shared_token support remains available for self-managed relays.
			services.state.updateSettings({ relayAuthToken: this.relayAuthToken });
		}
		this.log = services.logger.child("iroh");
		this.stateManager = services.stateManager;
		this.trustStore = new ProjectTrustStore(services.agentDir);
		this.pushRelayClient = createDaemonPushRelayClient(config, () => this.managedRelayCredential?.accessToken);
		this.workers = services.workers;
		// A worker that exited ends its relays (D19): their clients reconnect with resume.
		this.workers.onWorkerExited((workerId) => {
			for (const [relayId, entry] of this.workerRelays) {
				if (entry.workerId !== workerId) continue;
				void entry.relay.close("worker_exited", { pendingMessage: "conversation host exited; retry" });
				this.workerRelays.delete(relayId);
			}
			this.workerSpawners.delete(workerId);
			this.workerClients.delete(workerId);
			const worktree = this.workerWorktrees.get(workerId);
			this.workerWorktrees.delete(workerId);
			if (worktree !== undefined)
				this.worktreeRetention.onRuntimeDisposed(worktree.workspaceName, worktree.worktreeId);
		});
		// A worker retiring without the option to refuse ends the streams whose authority went with it.
		this.workers.onWorkerRetiring((workerId) => {
			for (const [relayId, entry] of this.workerRelays) {
				if (entry.workerId !== workerId) continue;
				const loss = getIrohRemoteAuthorizationLoss(this.services.state.getHostState(), entry.authorization);
				if (loss !== undefined) this.endWorkerRelay(relayId, loss);
			}
		});
		// The lease broker sees a session a worker hosts as daemon-owned, until slice 9 deletes it.
		this.workers.onHostsChanged((workspaceName, sessionId) => this.syncWorkerLease(workspaceName, sessionId));
		this.worktrees = new WorktreeManager({
			agentDir: services.agentDir,
			stateManager: this.stateManager,
			auditLogger: services.auditLogger,
			hasActiveRuntimeForSession: (workspaceName, sessionId) => {
				const lease = this.leaseBroker.lookup(workspaceName, sessionId);
				return this.workers.hosts(workspaceName, sessionId) || (lease !== undefined && lease.state !== "unowned");
			},
			reserveSessionsForRemoval: (workspaceName, sessionIds) =>
				this.leaseBroker.reserveSessionsForWorktreeRemoval(workspaceName, sessionIds),
			flushState: () => services.state.flush(),
		});
		this.prReviewCheckouts = new PrReviewCheckoutManager({
			agentDir: services.agentDir,
			stateManager: this.stateManager,
			worktrees: this.worktrees,
			hasActiveSession: (workspaceName, sessionId) => {
				const lease = this.leaseBroker.lookup(workspaceName, sessionId);
				return (
					this.workers.hosts(workspaceName, sessionId) ||
					(lease !== undefined && (lease.state !== "unowned" || lease.pendingDaemonAttaches > 0))
				);
			},
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
		// The broker's daemon-owned states are a session a worker hosts (Phase 7 slice 4, until slice 9).
		this.leaseBroker = new LeaseBroker({
			isRuntimeStreaming: (workspaceName, sessionId) => this.workers.isHostActive(workspaceName, sessionId),
			waitForRuntimeIdle: (workspaceName, sessionId) => this.workers.whenHostIdle(workspaceName, sessionId),
			// A TUI taking the session's lease retires the worker hosting it.
			disposeRuntime: (workspaceName, sessionId) =>
				this.workers.retireHost(workspaceName, sessionId, "lease_transferred"),
			closePhoneStreams: async (workspaceName, sessionId) => {
				await this.closeWorkerRelays(
					(entry) => entry.relay.workspaceName === workspaceName && entry.relay.sessionId === sessionId,
					"lease_transferred",
				);
			},
			closeRelays: (record, reason) => {
				for (const relayId of Array.from(record.relayIds)) {
					void this.conversationCoordinators
						.get(record.workspaceName, record.sessionId)
						?.closeTransport(relayId, reason);
				}
			},
			beginTuiLeaseHandoff: (workspaceName, sessionId, connectionId) => {
				this.conversationCoordinators.getOrCreate(workspaceName, sessionId).beginTuiLeaseHandoff(connectionId);
			},
			commitTuiLeaseHandoff: (workspaceName, sessionId, connectionId) => {
				const coordinator = this.conversationCoordinators.get(workspaceName, sessionId);
				if (!coordinator) {
					throw new Error(`TUI handoff lost its conversation coordinator for ${workspaceName}/${sessionId}`);
				}
				coordinator.commitTuiLeaseHandoff(connectionId);
			},
			cancelTuiLeaseHandoff: (workspaceName, sessionId, connectionId) => {
				this.conversationCoordinators.get(workspaceName, sessionId)?.cancelTuiLeaseHandoff(connectionId);
			},
			releaseTuiLease: (workspaceName, sessionId, connectionId) => {
				this.conversationCoordinators.get(workspaceName, sessionId)?.releaseTuiLease(connectionId);
			},
			// The drained turn runs in the worker hosting the session; the TUI waiting for it may stop it.
			onDrainStarted: (record, viewerFeedId) => {
				const host = this.workers.host(record.workspaceName, record.sessionId);
				const connectionId = host === undefined ? undefined : this.workers.connectionOf(host.workerId);
				if (connectionId === undefined || !record.tuiConnectionId) return;
				this.viewerFeeds.start(viewerFeedId, record.tuiConnectionId, {
					abort: () => {
						this.services.controlServer.sendTo(connectionId, {
							type: "worker_abort",
							sessionId: record.sessionId,
						});
					},
				});
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
		this.conversationCoordinators.bindLeaseBroker(this.leaseBroker);
		let readyResolve: () => void = () => {};
		let readyReject: (error: unknown) => void = () => {};
		const readyPromise = new Promise<void>((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		readyPromise.catch(() => {});
		this.ready = { promise: readyPromise, resolve: readyResolve, reject: readyReject };
	}

	private tuiChangeKey(workspaceName: string, sessionId: string): string {
		return `${workspaceName}\0${sessionId}`;
	}

	private claimTuiChangeAuthority(
		workspaceName: string,
		sessionId: string,
		connectionId: string,
	): TuiChangeAuthorityClaim {
		const key = this.tuiChangeKey(workspaceName, sessionId);
		const previous = this.tuiChangeAuthorities.get(key);
		const claim: TuiChangeAuthorityClaim = {
			connectionId,
			revision: ++this.tuiChangeReceiptRevision,
			workspaceGeneration: previous?.workspaceGeneration,
		};
		this.tuiChangeAuthorities.set(key, claim);
		return claim;
	}

	private isCurrentTuiChangeAuthority(key: string, claim: TuiChangeAuthorityClaim): boolean {
		return this.tuiChangeAuthorities.get(key)?.revision === claim.revision;
	}

	private retireTuiChangeAuthorityClaim(
		key: string,
		workspaceName: string,
		sessionId: string,
		claim: TuiChangeAuthorityClaim,
	): Promise<void> {
		if (!this.isCurrentTuiChangeAuthority(key, claim)) return Promise.resolve();
		this.tuiChangeAuthorities.delete(key);
		return claim.workspaceGeneration === undefined
			? Promise.resolve()
			: this.services.changes.retireSession(workspaceName, claim.workspaceGeneration, sessionId);
	}

	private retireTuiChangeAuthority(workspaceName: string, sessionId: string, connectionId?: string): Promise<void> {
		const key = this.tuiChangeKey(workspaceName, sessionId);
		const claim = this.tuiChangeAuthorities.get(key);
		if (!claim || (connectionId !== undefined && claim.connectionId !== connectionId)) return Promise.resolve();
		return this.retireTuiChangeAuthorityClaim(key, workspaceName, sessionId, claim);
	}

	private retireCurrentTuiChangeObservation(
		key: string,
		workspaceName: string,
		sessionId: string,
		claim: TuiChangeAuthorityClaim,
	): Promise<void> {
		if (!this.isCurrentTuiChangeAuthority(key, claim) || claim.workspaceGeneration === undefined) {
			return Promise.resolve();
		}
		return this.services.changes.retireSession(workspaceName, claim.workspaceGeneration, sessionId);
	}

	private retireTuiChangeWorkspace(workspaceName: string): Promise<void> {
		for (const [key, claim] of this.tuiChangeAuthorities) {
			if (key.startsWith(`${workspaceName}\0`) && this.isCurrentTuiChangeAuthority(key, claim)) {
				this.tuiChangeAuthorities.delete(key);
			}
		}
		return this.services.changes.retireWorkspace(workspaceName);
	}

	private trackTuiChangeRetirement(task: Promise<void>): void {
		const tracked = task.catch((error: unknown) => {
			this.log("warn", "failed to retire TUI change observation after control disconnect", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		this.tuiChangeRetirementTasks.add(tracked);
		void tracked.finally(() => this.tuiChangeRetirementTasks.delete(tracked));
	}

	/**
	 * A conversation's Git state for change association, from the process
	 * that writes it: the worker hosting it, or the TUI holding its lease.
	 */
	private async handleChangeObservation(
		connection: ControlConnection,
		request: Extract<ControlRequest, { type: "change_observe" }>,
	): Promise<void> {
		const workerId = connection.client === "worker" ? this.workers.workerOf(connection.connectionId) : undefined;
		// A worker observes the sessions it hosts, under its workspace's current authority only.
		const workerKeyCurrent = (): boolean => {
			const key = workerId === undefined ? undefined : this.workers.keyOf(workerId);
			return (
				key !== undefined &&
				key.workspaceName === request.workspaceName &&
				this.services.state
					.getHostState()
					.workspaceGenerations?.find((record) => record.workspaceName === request.workspaceName)?.generation ===
					key.workspaceGeneration
			);
		};
		const assertLease = (): boolean =>
			workerId !== undefined
				? this.workers.workerHosts(workerId, request.sessionId) && workerKeyCurrent()
				: isExactTuiChangeObservationLeaseHolder(
						connection,
						this.leaseBroker.lookup(request.workspaceName, request.sessionId),
					);
		if (!assertLease()) {
			connection.send({ type: "error", id: request.id, code: "not_held", message: "lease not held" });
			return;
		}
		const key = this.tuiChangeKey(request.workspaceName, request.sessionId);
		const claim = this.claimTuiChangeAuthority(request.workspaceName, request.sessionId, connection.connectionId);
		const isCurrentRevision = (): boolean => this.isCurrentTuiChangeAuthority(key, claim);
		const initialRetirement =
			request.gitContext === null
				? this.retireCurrentTuiChangeObservation(key, request.workspaceName, request.sessionId, claim)
				: Promise.resolve();
		const finishIfSuperseded = async (): Promise<boolean> => {
			if (isCurrentRevision()) return false;
			await initialRetirement;
			connection.send({ type: "ok", id: request.id });
			return true;
		};
		await this.dependencies.beforeTuiChangeObservationValidation?.(request);
		if (await finishIfSuperseded()) return;

		const state = await this.stateManager.getState();
		if (await finishIfSuperseded()) return;
		const workspace = state.workspaces.find((candidate) => candidate.name === request.workspaceName);
		const workspaceGeneration = (state.workspaceGenerations ?? []).find(
			(candidate) => candidate.workspaceName === request.workspaceName,
		)?.generation;
		if (!workspace || workspaceGeneration === undefined) {
			connection.send({ type: "error", id: request.id, code: "not_found", message: "workspace not found" });
			return;
		}
		claim.workspaceGeneration = workspaceGeneration;
		if (request.gitContext === null) {
			if (!assertLease()) {
				await this.retireTuiChangeAuthorityClaim(key, request.workspaceName, request.sessionId, claim);
				connection.send({ type: "error", id: request.id, code: "not_held", message: "lease not held" });
				return;
			}
			await Promise.all([
				initialRetirement,
				this.retireCurrentTuiChangeObservation(key, request.workspaceName, request.sessionId, claim),
			]);
			connection.send({ type: "ok", id: request.id });
			return;
		}

		const sessionDir = getDefaultSessionDirPath(workspace.path, this.services.agentDir);
		let sessionCwd: string | undefined;
		try {
			const sessionRef = await SessionManager.findForResume(sessionDir, request.sessionId);
			if (sessionRef !== undefined) {
				const manager = await SessionManager.openReadOnly(sessionRef);
				try {
					sessionCwd = manager.getCwd();
				} finally {
					await manager.closePersistence();
				}
			}
		} catch {
			sessionCwd = undefined;
		}
		if (await finishIfSuperseded()) return;
		if (sessionCwd === undefined) {
			connection.send({ type: "error", id: request.id, code: "not_found", message: "session not found" });
			return;
		}
		const worktree = (state.worktrees ?? []).find(
			(candidate) =>
				candidate.workspaceName === request.workspaceName && candidate.sessionIds.includes(request.sessionId),
		);
		let runtimeDirectory: WorkspaceDirectoryResolution;
		try {
			const rootPath = await realpath(worktree?.path ?? workspace.path);
			const absolutePath = await realpath(sessionCwd);
			if (!isPathInside(rootPath, absolutePath) || !(await stat(absolutePath)).isDirectory()) {
				throw new Error("session working directory escaped its workspace");
			}
			const relativePath = relative(rootPath, absolutePath).split(sep).join("/");
			runtimeDirectory = {
				absolutePath,
				...(relativePath.length === 0 ? {} : { relativePath }),
			};
		} catch {
			if (await finishIfSuperseded()) return;
			connection.send({
				type: "error",
				id: request.id,
				code: "session_unavailable",
				message: "session working directory is unavailable",
			});
			return;
		}
		if (await finishIfSuperseded()) return;
		const location = discoverGitWorktree(runtimeDirectory.absolutePath);
		if (!location) {
			connection.send({ type: "error", id: request.id, code: "not_git", message: "session is not in Git" });
			return;
		}
		const currentState = await this.stateManager.getState();
		if (await finishIfSuperseded()) return;
		const currentWorkspace = currentState.workspaces.find(
			(candidate) => candidate.name === request.workspaceName && candidate.path === workspace.path,
		);
		const currentGeneration = (currentState.workspaceGenerations ?? []).find(
			(candidate) => candidate.workspaceName === request.workspaceName,
		)?.generation;
		if (!assertLease() || !currentWorkspace || currentGeneration !== workspaceGeneration) {
			await this.retireTuiChangeAuthorityClaim(key, request.workspaceName, request.sessionId, claim);
			connection.send({ type: "error", id: request.id, code: "authority_changed", message: "authority changed" });
			return;
		}
		void this.services.changes
			.observe(
				{
					workspaceName: request.workspaceName,
					workspaceGeneration,
					sessionId: request.sessionId,
					cwd: runtimeDirectory.absolutePath,
					commonGitDir: location.commonGitDir,
					repositoryDisplayName: request.gitContext.repository,
					branch: request.gitContext.branch,
					headOid: request.gitContext.headOid,
					trusted: resolveIrohRemoteWorkspaceProjectTrusted(currentWorkspace, { trustStore: this.trustStore }),
					...(request.gitContext.baseRef === undefined ? {} : { baseBranches: [request.gitContext.baseRef] }),
				},
				isCurrentRevision,
			)
			.catch(() => {});
		connection.send({ type: "ok", id: request.id });
	}

	private requireEngine(): IrohRemoteHostEngine {
		if (!this.engine) {
			throw new Error("iroh host engine is not ready");
		}
		return this.engine;
	}

	private markStorageCapacityUnavailable(): void {
		this.remoteTransport = {
			state: this.endpoint && this.engine ? "degraded" : "unavailable",
			reasonCode: "host_storage_full",
			message: REMOTE_TRANSPORT_REASON_MESSAGES.host_storage_full,
			...(this.wrapperVersion === undefined ? {} : { wrapperVersion: this.wrapperVersion }),
		};
	}

	private clearStorageCapacityDegradation(): void {
		if (this.remoteTransport.reasonCode !== "host_storage_full" || !this.endpoint || !this.engine) return;
		this.remoteTransport = {
			state: "ready",
			...(this.wrapperVersion === undefined ? {} : { wrapperVersion: this.wrapperVersion }),
		};
	}

	private async pruneWorktreesOnStart(signal: AbortSignal): Promise<void> {
		if (signal.aborted || !resolveWorktreeCleanupPolicy(this.services.state.state.settings).pruneOnStart) {
			return;
		}
		try {
			const state = await this.stateManager.getState();
			if (signal.aborted) return;
			const workspacesWithRecords = new Set((state.worktrees ?? []).map((worktree) => worktree.workspaceName));
			for (const workspace of state.workspaces) {
				if (signal.aborted) return;
				// Skip workspaces with neither records nor checkout directories: no git
				// subprocesses or audit noise on the common no-worktrees start.
				if (
					!workspacesWithRecords.has(workspace.name) &&
					!existsSync(getWorkspaceWorktreesDir(this.services.agentDir, workspace.path))
				) {
					continue;
				}
				try {
					await this.worktrees.prune(workspace, { signal });
				} catch (error) {
					if (signal.aborted) return;
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

	private isAuthorizationCurrent(authorization: IrohRemoteClientAuthorizationSuccess): Promise<boolean> {
		return this.stateManager.isAuthorizationCurrent(authorization);
	}

	/**
	 * A stream's per-frame authority: the daemon's in-memory host state, read
	 * again whenever it changes. A revoked or changed grant, or an unregistered
	 * workspace, ends the stream with its fatal code before the next frame.
	 */
	private frameAuthority(authorization: IrohRemoteClientAuthorizationSuccess): () => AuthorityLoss | undefined {
		let checked: unknown;
		let loss: AuthorityLoss | undefined;
		return () => {
			const current = this.services.state.state;
			if (current !== checked) {
				checked = current;
				loss = this.admission.isOpen
					? getIrohRemoteAuthorizationLoss(this.services.state.getHostState(), authorization)
					: undefined;
			}
			return loss;
		};
	}

	/** The daemon backends the remote intents and queries of every device stream call. */
	private get remoteIntentHost(): RemoteIntentHost {
		this.remoteIntentHostValue ??= {
			agentDir: this.services.agentDir,
			auditLogger: this.services.auditLogger,
			stateManager: this.stateManager,
			keepAwake: {
				status: () => toRemoteKeepAwakeStatus(this.services.keepAwake.status),
				setEnabled: (enabled) => {
					const status = this.services.keepAwake.setEnabled(enabled);
					this.services.state.updateSettings({ keepAwakeEnabled: enabled });
					return toRemoteKeepAwakeStatus(status);
				},
			},
			webSearchKey: this.services.webSearchKey,
			hostTheme: () =>
				this.isThemeTokenPushEnabled()
					? {
							themeName: getCurrentThemeName() ?? "dark",
							tokens: sanitizeHostThemeTokens(getResolvedThemeColors()),
						}
					: undefined,
			pushTargets: (authorization) => {
				const dispatcher = this.createPushNotificationDispatcher(authorization);
				return { register: (args) => dispatcher.registerPushTarget(args) };
			},
			worktrees: (authorization) => this.createWorktreeRpcBackend(authorization.workspace),
			agentOptions: (authorization) => this.createAgentOptionsRpcBackend(authorization.workspace),
			sessionContexts: (authorization) => this.createSessionContextsRpcBackend(authorization),
			prReviews: (authorization, signal) =>
				this.createPrReviewRpcBackend(authorization, signal ?? new AbortController().signal),
			listRuntimeStates: (workspaceName) => {
				const states = new Map<string, Exclude<LeaseState, "unowned">>();
				for (const record of this.leaseBroker.list()) {
					if (record.workspaceName === workspaceName && record.state !== "unowned") {
						states.set(record.sessionId, record.state);
					}
				}
				return states;
			},
			getChangeContext: (workspaceName, workspaceGeneration, sessionId) =>
				this.services.changes.getChangeContext(workspaceName, workspaceGeneration, sessionId),
			unregisterWorkspace: (workspaceName, keep) => this.unregisterWorkspaceForRemote(workspaceName, keep),
		};
		return this.remoteIntentHostValue;
	}

	/** Unregister a workspace for a device, keeping the requesting stream, runtime, or relays until it is answered. */
	private async unregisterWorkspaceForRemote(
		workspaceName: string,
		keep: RemoteStreamKeep,
	): Promise<{ closedStreamCount: number; stoppedRuntimeCount: number }> {
		let removed: Awaited<ReturnType<IrohRemoteHostStateManager["unregisterWorkspace"]>>;
		try {
			removed = await this.stateManager.unregisterWorkspace(workspaceName);
		} catch (error) {
			if (!isIrohRemoteWorkspaceHasWorktreesError(error)) throw error;
			throw new WorkspaceIntentError(IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR, {
				worktreeCount: error.worktreeIds.length,
				worktreeIds: error.worktreeIds,
			});
		}
		if (!removed) throw new WorkspaceIntentError("workspace_unregistered");
		this.engine?.clearPairingSecretForWorkspace(workspaceName);
		const streamEntry =
			keep.streamId === undefined
				? undefined
				: this.activeStreams.allEntries().find((entry) => entry.streamId === keep.streamId);
		return await this.cleanupUnregisteredWorkspace(workspaceName, {
			...(streamEntry === undefined ? {} : { streamEntry }),
			...(keep.relayIds === undefined ? {} : { relayIds: keep.relayIds }),
			workspacePath: removed.path,
		});
	}

	start(): void {
		if (this.startupTask !== undefined) return;
		this.startupTask = this.runStart();
	}

	private trackNativeLifecycleTask(task: Promise<unknown>): void {
		const settled = task.then(
			() => undefined,
			() => undefined,
		);
		this.nativeLifecycleTasks.add(settled);
		void settled.then(() => this.nativeLifecycleTasks.delete(settled));
	}

	private retireEndpoint(endpoint: IrohEndpointLike, context: string): Promise<void> {
		if (this.startupEndpoint === endpoint) {
			this.startupEndpoint = undefined;
		}
		const existing = this.endpointDisposalTasks.get(endpoint);
		if (existing !== undefined) {
			return existing;
		}
		const closeTask = Promise.resolve()
			.then(() => endpoint.close())
			.catch((error: unknown) => {
				this.log("warn", `${context}: ${error instanceof Error ? error.message : String(error)}`);
			});
		this.endpointDisposalTasks.set(endpoint, closeTask);
		this.trackNativeLifecycleTask(closeTask);
		return closeTask;
	}

	/** A fresh builder for one bind attempt; `bind()` consumes it. Production relay URLs are validated by the caller. */
	private createEndpointBuilder(
		iroh: IrohModuleLike,
		secretKey: number[] | undefined,
		pinnedPort: number | undefined,
	): IrohEndpointBuilderLike {
		const builder = iroh.Endpoint.builder();
		if (this.relayMode === "development") {
			iroh.presetN0(builder);
		} else if (this.relayMode === "production") {
			iroh.presetN0DisableRelay(builder);
			const relayAuthToken = this.currentRelayAuthToken();
			if (relayAuthToken !== undefined) {
				const relayMap = iroh.RelayMap.empty();
				for (const url of this.relayUrls) {
					relayMap.insert({ url, authToken: relayAuthToken });
				}
				builder.relayMode(iroh.RelayMode.custom(relayMap));
			} else {
				builder.relayMode(iroh.RelayMode.customFromUrls(this.relayUrls));
			}
		} else {
			iroh.presetMinimal(builder);
			builder.relayMode(iroh.RelayMode.disabled());
		}
		if (secretKey) {
			builder.secretKey(secretKey);
		}
		builder.alpns([Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"))]);
		if (pinnedPort !== undefined) {
			// Replaces only the default IPv4 socket and makes it required; IPv6
			// stays on an optional random port so IPv6-less hosts still start.
			builder.bindAddr(`0.0.0.0:${pinnedPort}`);
		}
		return builder;
	}

	private retireLateBoundEndpoint(bindTask: Promise<IrohEndpointLike>): void {
		const cleanupTask = bindTask.then(
			(endpoint) => this.retireEndpoint(endpoint, "late iroh endpoint disposal failed"),
			() => undefined,
		);
		this.trackNativeLifecycleTask(cleanupTask);
	}

	private enqueueRelayConfigurationMutation(operation: () => Promise<void>): Promise<void> {
		const task = this.relayConfigurationTask.catch(() => {}).then(operation);
		this.relayConfigurationTask = task;
		return task;
	}

	private currentRelayAuthToken(): string | undefined {
		const credential = this.managedRelayCredential;
		if (
			credential !== undefined &&
			(this.relayAuthToken !== credential.accessToken || credential.accessTokenExpiresAt <= Date.now())
		) {
			return undefined;
		}
		return this.relayAuthToken;
	}

	private ensureRelayRecoveryMonitor(): IrohRelayRecoveryMonitor | undefined {
		if (this.relayRecoveryMonitor !== undefined) return this.relayRecoveryMonitor;
		if (
			this.relayMode !== "production" ||
			(this.relayCredentialServiceUrl !== undefined && this.currentRelayAuthToken() === undefined)
		) {
			return undefined;
		}
		if (!this.relayWatchApiSafe || !this.relayReconnectApiSafe) {
			if (!this.relayRecoveryUnsupportedLogged) {
				this.relayRecoveryUnsupportedLogged = true;
				this.log("warn", "installed Volt Iroh binding lacks required relay reconnect capabilities");
			}
			return undefined;
		}
		const endpoint = this.endpoint;
		if (endpoint?.watchHomeRelay === undefined || endpoint.reconnectRelay === undefined) return undefined;
		const watchHomeRelay = endpoint.watchHomeRelay.bind(endpoint);
		const monitor = new IrohRelayRecoveryMonitor({
			watchHomeRelay,
			recover: () =>
				this.enqueueRelayConfigurationMutation(async () => {
					if (!this.admission.isOpen || this.endpoint !== endpoint || this.relayCredentialIsRevoking) return;
					const authToken = this.currentRelayAuthToken();
					if (this.relayCredentialServiceUrl !== undefined && authToken === undefined) return;
					for (const url of this.relayUrls) {
						await endpoint.reconnectRelay?.({ url, ...(authToken === undefined ? {} : { authToken }) });
					}
				}),
			log: (level, message, details) => this.log(level, message, details),
			recoveryDelayMs: this.dependencies.relayRecoveryDelayMs,
			retryDelayMs: this.dependencies.relayRecoveryRetryMs,
			confirmationTimeoutMs: this.dependencies.relayRecoveryConfirmationTimeoutMs,
		});
		this.relayRecoveryMonitor = monitor;
		monitor.start();
		return monitor;
	}

	private async stopRelayRecoveryMonitor(): Promise<void> {
		const monitor = this.relayRecoveryMonitor;
		this.relayRecoveryMonitor = undefined;
		await monitor?.stop();
	}

	private async createManagedRelayCredentialClaim(): Promise<IrohManagedRelayCredentialClaim | undefined> {
		if (this.relayCredentialIsRevoking || this.managedRelayCredentialRevocation !== undefined) {
			throw new Error("Relay credential reset is pending. Retry the reset before pairing.");
		}
		if (
			this.relayMode !== "production" ||
			this.relayCredentialServiceUrl === undefined ||
			(this.managedRelayCredential === undefined && this.relayAuthToken !== undefined)
		) {
			return undefined;
		}
		if (!this.hostNodeId) {
			throw new Error("persistent Iroh endpoint identity is not ready");
		}
		const existingClaim = this.managedRelayCredentialClaim;
		if (existingClaim !== undefined) {
			if (existingClaim.expiresAt !== undefined && existingClaim.expiresAt <= Date.now()) {
				this.managedRelayCredentialClaim = undefined;
				this.services.state.updateSettings({ relayCredentialClaim: undefined });
				await this.services.state.flush();
			} else {
				throw new Error("another managed relay credential pairing is already pending");
			}
		}

		const expectedEpoch = this.relayCredentialEpoch;
		const candidate = parseIrohManagedRelayCredentialClaim({
			schemaVersion: 1,
			serviceUrl: this.relayCredentialServiceUrl,
			relayUrls: this.relayUrls.map((url) => new URL(url).origin),
			hostNodeId: this.hostNodeId,
			claimSecret: `vpc_${randomBytes(32).toString("base64url")}`,
			...(this.managedRelayCredential === undefined
				? { bootstrapRefreshToken: `vrr_${randomBytes(32).toString("base64url")}` }
				: {}),
		});
		this.managedRelayCredentialClaim = candidate;
		this.services.state.updateSettings({ relayCredentialClaim: candidate });
		await this.services.state.flush();

		let created: IrohManagedRelayCredentialClaim;
		try {
			created = await createIrohManagedRelayCredentialClaim(candidate, this.managedRelayCredential);
		} catch (error) {
			if (this.managedRelayCredentialClaim === candidate) {
				this.managedRelayCredentialClaim = undefined;
				this.services.state.updateSettings({ relayCredentialClaim: undefined });
				await this.services.state.flush();
			}
			throw error;
		}
		if (
			!this.admission.isOpen ||
			this.relayCredentialIsRevoking ||
			expectedEpoch !== this.relayCredentialEpoch ||
			this.managedRelayCredentialClaim !== candidate ||
			created.expiresAt === undefined ||
			created.expiresAt <= Date.now()
		) {
			throw new Error("managed relay credential claim creation was superseded");
		}
		this.managedRelayCredentialClaim = created;
		this.services.state.updateSettings({ relayCredentialClaim: created });
		await this.services.state.flush();
		this.startManagedRelayCredentialExchange();
		return created;
	}

	private async discardManagedRelayCredentialClaim(claim: IrohManagedRelayCredentialClaim): Promise<void> {
		if (this.managedRelayCredentialClaim !== claim) return;
		this.managedRelayCredentialClaim = undefined;
		this.services.state.updateSettings({ relayCredentialClaim: undefined });
		await this.services.state.flush();
	}

	private async authorizeRelayCredentialPairing(claimId: string, remoteNodeId: string): Promise<boolean> {
		if (this.relayCredentialIsRevoking || this.managedRelayCredentialRevocation !== undefined) return false;
		const expectedEpoch = this.relayCredentialEpoch;
		const approved = () =>
			this.managedRelayAppEndpoints.find((endpoint) => endpoint.claimId === claimId && !endpoint.revocationPending);
		const existing = approved();
		if (existing !== undefined) return existing.nodeId === remoteNodeId;
		if (this.managedRelayCredentialClaim?.claimId !== claimId || this.relayCredentialExchangeTask === undefined) {
			return false;
		}
		await withTimeout(
			this.relayCredentialExchangeTask,
			10_000,
			"managed relay credential claim exchange did not finish before pairing authorization",
		).catch(() => {});
		return (
			expectedEpoch === this.relayCredentialEpoch &&
			!this.relayCredentialIsRevoking &&
			approved()?.nodeId === remoteNodeId
		);
	}

	private startManagedRelayCredentialExchange(): void {
		if (
			this.relayCredentialExchangeTask !== undefined ||
			!this.admission.isOpen ||
			this.relayCredentialIsRevoking ||
			this.managedRelayCredentialRevocation !== undefined
		)
			return;
		const claim = this.managedRelayCredentialClaim;
		if (claim?.claimId === undefined || claim.expiresAt === undefined) return;
		const expectedEpoch = this.relayCredentialEpoch;
		const task = this.runManagedRelayCredentialExchange(claim, expectedEpoch).finally(() => {
			if (this.relayCredentialExchangeTask === task) {
				this.relayCredentialExchangeTask = undefined;
				// Only a replacement claim needs another task. Restarting the same
				// cancelled/expired claim here can spin forever without yielding.
				if (this.managedRelayCredentialClaim !== claim) this.startManagedRelayCredentialExchange();
			}
		});
		this.relayCredentialExchangeTask = task;
	}

	private async runManagedRelayCredentialExchange(
		claim: IrohManagedRelayCredentialClaim,
		expectedEpoch: number,
	): Promise<void> {
		let pendingResponseCount = 0;
		let consecutiveFailureCount = 0;
		while (
			this.admission.isOpen &&
			!this.relayCredentialIsRevoking &&
			expectedEpoch === this.relayCredentialEpoch &&
			this.managedRelayCredentialClaim === claim &&
			claim.expiresAt !== undefined &&
			Date.now() < claim.expiresAt
		) {
			try {
				const result = await exchangeIrohManagedRelayCredentialClaim(claim);
				if (
					!this.admission.isOpen ||
					this.relayCredentialIsRevoking ||
					expectedEpoch !== this.relayCredentialEpoch ||
					this.managedRelayCredentialClaim !== claim
				)
					return;
				consecutiveFailureCount = 0;
				if (result.status === "pending") {
					pendingResponseCount++;
					await waitForRelayCredentialRetry(
						managedRelayCredentialPendingRetryMs(result.retryAfterMs, pendingResponseCount),
					);
					continue;
				}
				if (result.status === "rate_limited") {
					await waitForRelayCredentialRetry(managedRelayCredentialRateLimitRetryMs(result.retryAfterMs));
					continue;
				}
				if (
					!this.admission.isOpen ||
					this.relayCredentialIsRevoking ||
					expectedEpoch !== this.relayCredentialEpoch ||
					this.managedRelayCredentialClaim !== claim
				) {
					return;
				}
				this.clearManagedRelayCredentialRefreshTimer();
				await this.relayCredentialRefreshTask?.catch(() => {});
				const credential = activateIrohManagedRelayCredential(claim, result.exchange, this.managedRelayCredential);
				const approvedAppEndpoint = parseIrohManagedRelayAppEndpoint({
					schemaVersion: 1,
					claimId: claim.claimId,
					nodeId: result.exchange.appNodeId,
					endpointId: result.exchange.appEndpointId,
					revocationPending: false,
				});
				if (await this.installManagedRelayCredential(credential, expectedEpoch, claim, approvedAppEndpoint)) {
					this.log("info", "exchanged managed Iroh relay credential claim");
					this.scheduleManagedRelayCredentialRefresh();
				}
				return;
			} catch (error) {
				if (
					!this.admission.isOpen ||
					this.relayCredentialIsRevoking ||
					expectedEpoch !== this.relayCredentialEpoch ||
					this.managedRelayCredentialClaim !== claim
				)
					return;
				consecutiveFailureCount++;
				this.log("warn", "managed Iroh relay credential claim exchange failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				await waitForRelayCredentialRetry(managedRelayCredentialFailureRetryMs(consecutiveFailureCount));
			}
		}
		if (
			this.admission.isOpen &&
			this.managedRelayCredentialClaim === claim &&
			claim.expiresAt !== undefined &&
			Date.now() >= claim.expiresAt
		) {
			await this.discardManagedRelayCredentialClaim(claim);
		}
	}

	private async installManagedRelayCredential(
		credentialValue: IrohManagedRelayCredential,
		expectedEpoch: number,
		exchangedClaim?: IrohManagedRelayCredentialClaim,
		approvedAppEndpoint?: IrohManagedRelayAppEndpoint,
	): Promise<boolean> {
		const credential = parseIrohManagedRelayCredential(credentialValue);
		if (credential.accessTokenExpiresAt <= Date.now()) {
			throw new Error("managed relay credential expired before installation");
		}
		if (
			!this.admission.isOpen ||
			this.relayCredentialIsRevoking ||
			expectedEpoch !== this.relayCredentialEpoch ||
			(exchangedClaim !== undefined && this.managedRelayCredentialClaim !== exchangedClaim)
		) {
			return false;
		}
		const endpoint = this.endpoint;
		if (endpoint !== undefined) {
			if (endpoint.id().toString() !== credential.endpointNodeId) {
				throw new Error("managed relay credential does not match the persistent Iroh endpoint identity");
			}
			if (endpoint.reconnectRelay === undefined || !this.relayReconnectApiSafe) {
				throw new Error("the installed Volt Iroh binding cannot reconnect a live relay credential");
			}
		}
		let installed = false;
		await this.enqueueRelayConfigurationMutation(async () => {
			if (
				!this.admission.isOpen ||
				this.relayCredentialIsRevoking ||
				expectedEpoch !== this.relayCredentialEpoch ||
				(exchangedClaim !== undefined && this.managedRelayCredentialClaim !== exchangedClaim)
			) {
				return;
			}
			if (credential.accessTokenExpiresAt <= Date.now()) {
				throw new Error("managed relay credential expired before installation");
			}
			const nextAppEndpoints =
				approvedAppEndpoint === undefined
					? this.managedRelayAppEndpoints
					: [
							...this.managedRelayAppEndpoints.filter(
								(endpoint) => endpoint.endpointId !== approvedAppEndpoint.endpointId,
							),
							approvedAppEndpoint,
						];
			// The durable credential becomes authoritative before the live actor
			// reconnects. A crash at any later point restarts with this token rather
			// than reviving the connection whose strict expiry triggered recovery.
			// Keep an exchanged claim durable until reconnect is confirmed so this
			// same operation remains retryable after a post-commit transport failure.
			this.services.state.updateSettings({
				relayAuthToken: undefined,
				relayCredential: credential,
				...(approvedAppEndpoint === undefined ? {} : { relayCredentialAppEndpoints: nextAppEndpoints }),
				relayCredentialRevocation: undefined,
			});
			await this.services.state.flush();
			if (!this.admission.isOpen || this.relayCredentialIsRevoking || expectedEpoch !== this.relayCredentialEpoch) {
				return;
			}
			if (credential.accessTokenExpiresAt <= Date.now()) {
				throw new Error("managed relay credential expired during installation");
			}
			this.managedRelayCredential = credential;
			this.managedRelayAppEndpoints = nextAppEndpoints;
			this.relayAuthToken = credential.accessToken;
			this.scheduleManagedRelayCredentialExpiryFence();
			if (endpoint !== undefined) {
				const monitor = this.ensureRelayRecoveryMonitor();
				const reconnectRelay = endpoint.reconnectRelay?.bind(endpoint);
				if (monitor === undefined || reconnectRelay === undefined) {
					throw new Error("the installed Volt Iroh binding cannot confirm relay credential reconnect");
				}
				for (const url of this.relayUrls) {
					if (
						!this.admission.isOpen ||
						this.relayCredentialIsRevoking ||
						expectedEpoch !== this.relayCredentialEpoch
					) {
						return;
					}
					await monitor.confirmReconnect(() => reconnectRelay({ url, authToken: credential.accessToken }));
				}
			}
			if (exchangedClaim !== undefined) {
				if (
					!this.admission.isOpen ||
					this.relayCredentialIsRevoking ||
					expectedEpoch !== this.relayCredentialEpoch
				) {
					return;
				}
				if (this.managedRelayCredentialClaim === exchangedClaim) {
					this.services.state.updateSettings({ relayCredentialClaim: undefined });
					await this.services.state.flush();
					if (
						!this.admission.isOpen ||
						this.relayCredentialIsRevoking ||
						expectedEpoch !== this.relayCredentialEpoch
					) {
						return;
					}
					if (this.managedRelayCredentialClaim === exchangedClaim) {
						this.managedRelayCredentialClaim = undefined;
					}
				}
			}
			this.relayCredentialSubscriptionInactive = false;
			this.relayCredentialRefreshFailureCount = 0;
			installed = true;
		});
		return installed;
	}

	private async refreshManagedRelayCredential(expectedEpoch = this.relayCredentialEpoch): Promise<boolean> {
		const credential = this.managedRelayCredential;
		if (
			credential === undefined ||
			!this.admission.isOpen ||
			this.relayCredentialIsRevoking ||
			expectedEpoch !== this.relayCredentialEpoch
		) {
			return false;
		}
		const refreshed = await refreshIrohManagedRelayCredential(credential);
		return this.installManagedRelayCredential(refreshed, expectedEpoch);
	}

	private async stageManagedRelayAppEndpointRevocation(
		nodeId: string,
	): Promise<IrohManagedRelayAppEndpoint | undefined> {
		const endpoint = this.managedRelayAppEndpoints.find((candidate) => candidate.nodeId === nodeId);
		if (endpoint === undefined) return undefined;
		if (endpoint.revocationPending) return endpoint;
		const pending = { ...endpoint, revocationPending: true };
		const next = this.managedRelayAppEndpoints.map((candidate) =>
			candidate.endpointId === endpoint.endpointId ? pending : candidate,
		);
		this.services.state.updateSettings({ relayCredentialAppEndpoints: next });
		await this.services.state.flush();
		this.managedRelayAppEndpoints = next;
		return pending;
	}

	private async completeManagedRelayAppEndpointRevocation(endpoint: IrohManagedRelayAppEndpoint): Promise<void> {
		const credential = this.managedRelayCredential;
		if (credential === undefined) return;
		await revokeIrohManagedRelayAppEndpoint(credential, endpoint.endpointId);
		const next = this.managedRelayAppEndpoints.filter((candidate) => candidate.endpointId !== endpoint.endpointId);
		this.services.state.updateSettings({ relayCredentialAppEndpoints: next });
		await this.services.state.flush();
		this.managedRelayAppEndpoints = next;
	}

	private async resumeManagedRelayAppEndpointRevocations(): Promise<void> {
		if (this.managedRelayCredential === undefined) return;
		for (const endpoint of [...this.managedRelayAppEndpoints]) {
			if (!endpoint.revocationPending) continue;
			try {
				await this.completeManagedRelayAppEndpointRevocation(endpoint);
			} catch (error) {
				this.log("warn", "managed relay app endpoint revocation retry failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	private async revokeManagedRelayCredential(): Promise<void> {
		if (this.relayCredentialIsRevoking) {
			throw new Error("Relay credential reset is already in progress. Wait for it to finish.");
		}
		let credential = this.managedRelayCredentialRevocation ?? this.managedRelayCredential;
		if (credential === undefined && this.managedRelayCredentialClaim === undefined) {
			throw new Error("no managed Iroh relay credential is configured");
		}
		const endpoint = this.endpoint ?? this.startupEndpoint;
		if (endpoint !== undefined && endpoint.removeRelay === undefined) {
			throw new Error("the installed Iroh binding cannot remove a live relay credential");
		}
		this.relayCredentialIsRevoking = true;
		this.relayCredentialEpoch += 1;
		let removalError: unknown;
		try {
			await this.stopRelayRecoveryMonitor();
			this.clearManagedRelayCredentialRefreshTimer();
			clearTimeout(this.relayCredentialExpiryTimer);
			this.relayCredentialExpiryTimer = undefined;

			await this.enqueueRelayConfigurationMutation(async () => {
				// An earlier installer may have persisted authority before seeing the
				// epoch fence. Revoke that durable grant too, even on first bootstrap.
				credential =
					this.services.state.state.settings.relayCredentialRevocation ??
					this.services.state.state.settings.relayCredential ??
					credential;
				this.managedRelayCredential = undefined;
				this.managedRelayCredentialRevocation = credential;
				this.relayAuthToken = undefined;
				this.managedRelayCredentialClaim = undefined;
				this.services.state.updateSettings({
					relayAuthToken: undefined,
					relayCredential: undefined,
					relayCredentialClaim: undefined,
					relayCredentialRevocation: credential,
				});
				await this.services.state.flush();
				if (endpoint === undefined) return;
				for (const url of this.relayUrls) {
					try {
						await endpoint.removeRelay?.(url);
					} catch (error) {
						removalError ??= error;
					}
				}
			});

			// Include tickets restored after a crash, not just this process's QR
			// requests. Pairings admitted before the epoch fence self-cancel below.
			for (const [requestId, pending] of this.pendingPairRequests) {
				await this.cancelPendingPairing(requestId, pending);
				this.services.controlServer.sendTo(pending.connectionId, {
					type: "pairing_progress",
					requestId,
					phase: "failed",
					error: "Relay credential reset cancelled pairing.",
				});
			}
			for (const ticket of (await this.stateManager.getState()).pendingPairingTickets ?? []) {
				if (this.engine) await this.engine.cancelPairingSecretByHash(ticket.secretHash);
				else await this.stateManager.removePendingPairingTicket(ticket.secretHash);
			}
			if (credential !== undefined) await revokeIrohManagedRelayCredential(credential);
			if (removalError !== undefined) throw removalError;
			this.services.state.updateSettings({
				relayCredentialAppEndpoints: undefined,
				relayCredentialRevocation: undefined,
			});
			await this.services.state.flush();
			this.managedRelayCredentialRevocation = undefined;
			this.managedRelayAppEndpoints = [];
			this.relayCredentialSubscriptionInactive = false;
			this.relayCredentialRefreshFailureCount = 0;
		} catch (error) {
			throw new Error(
				`Relay credential reset failed. Retry the reset before pairing: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			// A durable tombstone, not this in-flight guard, blocks pairing after
			// failure. Releasing the guard makes the same operation retryable.
			this.relayCredentialIsRevoking = false;
		}
	}

	private scheduleManagedRelayCredentialExpiryFence(): void {
		if (this.relayCredentialExpiryTimer !== undefined) {
			clearTimeout(this.relayCredentialExpiryTimer);
			this.relayCredentialExpiryTimer = undefined;
		}
		const credential = this.managedRelayCredential;
		if (credential === undefined || !this.admission.isOpen || this.relayCredentialIsRevoking) return;
		const expectedEpoch = this.relayCredentialEpoch;
		const expire = () => {
			this.relayCredentialExpiryTimer = undefined;
			if (
				!this.admission.isOpen ||
				this.relayCredentialIsRevoking ||
				expectedEpoch !== this.relayCredentialEpoch ||
				this.managedRelayCredential !== credential
			) {
				return;
			}
			if (credential.accessTokenExpiresAt > Date.now()) {
				this.scheduleManagedRelayCredentialExpiryFence();
				return;
			}
			if (this.relayAuthToken === credential.accessToken) {
				this.relayAuthToken = undefined;
			}
			void this.stopRelayRecoveryMonitor().catch((error: unknown) => {
				this.log("warn", "managed Iroh relay recovery monitor failed to stop at credential expiry", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			this.log("warn", "managed Iroh relay credential expired; relay access disabled pending refresh");
			void this.enqueueRelayConfigurationMutation(async () => {
				if (
					!this.admission.isOpen ||
					this.relayCredentialIsRevoking ||
					expectedEpoch !== this.relayCredentialEpoch ||
					this.managedRelayCredential !== credential
				) {
					return;
				}
				const endpoint = this.endpoint ?? this.startupEndpoint;
				if (endpoint === undefined) return;
				if (endpoint.removeRelay === undefined) {
					throw new Error("the installed Iroh binding cannot expire a live relay credential");
				}
				for (const url of this.relayUrls) {
					if (
						!this.admission.isOpen ||
						this.relayCredentialIsRevoking ||
						expectedEpoch !== this.relayCredentialEpoch ||
						this.managedRelayCredential !== credential
					) {
						return;
					}
					await endpoint.removeRelay(url);
				}
			}).catch((error: unknown) => {
				this.log("warn", "failed to remove expired managed Iroh relay credential", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		};
		const delay = Math.max(0, credential.accessTokenExpiresAt - Date.now());
		if (delay === 0) {
			expire();
			return;
		}
		this.relayCredentialExpiryTimer = setTimeout(expire, delay);
		this.relayCredentialExpiryTimer.unref?.();
	}

	private clearManagedRelayCredentialRefreshTimer(): void {
		clearTimeout(this.relayCredentialRefreshTimer);
		this.relayCredentialRefreshTimer = undefined;
		this.relayCredentialNextRefreshAt = undefined;
	}

	private scheduleManagedRelayCredentialRefresh(delayOverride?: number): void {
		this.clearManagedRelayCredentialRefreshTimer();
		const credential = this.managedRelayCredential;
		if (credential === undefined || !this.admission.isOpen || this.relayCredentialIsRevoking) return;
		const expectedEpoch = this.relayCredentialEpoch;
		const delay = Math.max(0, delayOverride ?? managedRelayCredentialRefreshAt(credential) - Date.now());
		this.relayCredentialNextRefreshAt = Date.now() + delay;
		this.relayCredentialRefreshTimer = setTimeout(() => {
			this.relayCredentialRefreshTimer = undefined;
			this.relayCredentialNextRefreshAt = undefined;
			void this.startManagedRelayCredentialRefresh(expectedEpoch);
		}, delay);
		this.relayCredentialRefreshTimer.unref?.();
	}

	/**
	 * One broker refresh attempt, shared by the scheduled timer and manual checks.
	 * The outcome always schedules the next attempt (unless fenced), so a manual
	 * check follows the same Retry-After and backoff as the timer.
	 */
	private startManagedRelayCredentialRefresh(expectedEpoch: number): Promise<ManagedRelayRefreshOutcome> {
		this.relayCredentialLastRefreshAttemptAt = Date.now();
		const isFenced = () =>
			!this.admission.isOpen || expectedEpoch !== this.relayCredentialEpoch || this.relayCredentialIsRevoking;
		const task = this.refreshManagedRelayCredential(expectedEpoch)
			.then((installed): ManagedRelayRefreshOutcome => {
				if (!installed || isFenced()) return { status: "superseded" };
				this.log("info", "refreshed managed Iroh relay credential");
				this.scheduleManagedRelayCredentialRefresh();
				return { status: "refreshed" };
			})
			.catch((error: unknown): ManagedRelayRefreshOutcome => {
				if (isFenced()) return { status: "superseded" };
				const subscriptionInactive = error instanceof IrohRelayCredentialSubscriptionInactiveError;
				const message = error instanceof Error ? error.message : String(error);
				// The broker paces suspended hosts with short retries; log the suspension once.
				const repeatedSuspension = subscriptionInactive && this.relayCredentialSubscriptionInactive;
				if (subscriptionInactive) this.relayCredentialSubscriptionInactive = true;
				this.relayCredentialRefreshFailureCount = subscriptionInactive
					? 0
					: Math.min(this.relayCredentialRefreshFailureCount + 1, 6);
				if (!repeatedSuspension) {
					this.log("warn", "managed Iroh relay credential refresh failed", { error: message });
				}
				this.scheduleManagedRelayCredentialRefresh(
					subscriptionInactive
						? error.retryAfterMs
						: managedRelayCredentialFailureRetryMs(this.relayCredentialRefreshFailureCount),
				);
				return subscriptionInactive ? { status: "subscription_inactive" } : { status: "failed", message };
			})
			.finally(() => {
				if (this.relayCredentialRefreshTask === task) {
					this.relayCredentialRefreshTask = undefined;
				}
			});
		this.relayCredentialRefreshTask = task;
		return task;
	}

	/**
	 * Manual "check now" for expired or suspended relay access. It joins an
	 * in-flight refresh, skips the broker inside RELAY_CREDENTIAL_CHECK_MIN_INTERVAL_MS
	 * of the last attempt, and otherwise runs the scheduled refresh early. It never
	 * bypasses broker pacing: denied refreshes read cached broker state.
	 */
	private async checkManagedRelayCredential(): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
		const unavailable = (message: string) =>
			({ ok: false, code: "relay_credential_check_unavailable", message }) as const;
		if (this.relayCredentialIsRevoking || this.managedRelayCredentialRevocation !== undefined) {
			return unavailable("A relay credential reset is pending. Retry the reset instead.");
		}
		if (this.relayCredentialServiceUrl === undefined || this.managedRelayCredential === undefined) {
			return unavailable("No managed relay credential is configured. Pair a phone to set up relay access.");
		}
		if (!this.admission.isOpen || this.endpoint === undefined) {
			return unavailable("Phone transport is not running. Run `volt daemon status`.");
		}
		const { state } = createRelayCredentialStatus(
			this.managedRelayCredential,
			this.managedRelayCredentialClaim,
			false,
			this.relayCredentialSubscriptionInactive,
		);
		if (state !== "expired" && state !== "subscription_inactive") {
			return unavailable(
				state === "pairing"
					? "A phone pairing is in progress. Finish it before checking relay access."
					: "Relay access is active; there is nothing to check.",
			);
		}
		let task = this.relayCredentialRefreshTask;
		if (task === undefined) {
			const lastAttemptAt = this.relayCredentialLastRefreshAttemptAt;
			const minimumIntervalMs =
				this.dependencies.relayCredentialCheckMinIntervalMs ?? RELAY_CREDENTIAL_CHECK_MIN_INTERVAL_MS;
			if (lastAttemptAt !== undefined && Date.now() - lastAttemptAt < minimumIntervalMs) {
				return { ok: true };
			}
			this.clearManagedRelayCredentialRefreshTimer();
			task = this.startManagedRelayCredentialRefresh(this.relayCredentialEpoch);
		}
		const outcome = await task;
		if (outcome.status === "failed") {
			return { ok: false, code: "relay_credential_check_failed", message: outcome.message };
		}
		if (outcome.status === "superseded") {
			return unavailable("Relay credentials changed during the check. Refresh status.");
		}
		return { ok: true };
	}

	private async runStart(): Promise<void> {
		let endpoint: IrohEndpointLike | undefined;
		const startupAdmission = this.admission.tryAcquire();
		if (!startupAdmission) {
			this.ready.reject(new Error("iroh service shut down before endpoint startup"));
			return;
		}
		let startupAdmissionReleased = false;
		const releaseStartupAdmission = () => {
			if (startupAdmissionReleased) return;
			startupAdmissionReleased = true;
			startupAdmission.release();
		};
		const iroh = this.iroh;
		// No endpoint will come up: what waits for one fails now.
		if (iroh === undefined) this.ready.reject(new Error(this.remoteTransport.message));
		if (this.relayConfigWarning !== undefined) {
			this.log("warn", this.relayConfigWarning);
		}
		try {
			// Reconcile worktree records/checkouts before the endpoint starts taking
			// conversations. The startup admission lease keeps every state mutation
			// inside the durable quiesce barrier, while its abort signal cancels git.
			await this.pruneWorktreesOnStart(startupAdmission.signal);
			if (this.managedRelayCredentialRevocation !== undefined) {
				try {
					await this.revokeManagedRelayCredential();
				} catch (error) {
					// A broker outage must not strand the local endpoint. Keep the
					// tombstone and block pairing until the same reset action succeeds.
					this.log("warn", "managed relay credential reset remains pending", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			if (this.managedRelayCredential !== undefined) {
				await this.services.state.flush();
				await this.resumeManagedRelayAppEndpointRevocations();
			}
			if (!startupAdmission.isCurrent()) {
				this.ready.reject(new Error("iroh service shut down before endpoint startup"));
				return;
			}
			// Without the binding the daemon serves its control plane and workers, and no phone.
			if (iroh === undefined) return;
			if (
				this.managedRelayCredential !== undefined &&
				this.managedRelayCredential.accessTokenExpiresAt <= Date.now()
			) {
				// Never pass an expired JWT to Iroh. Publish the identity-bound endpoint
				// without relay auth and let the fenced background refresh install a
				// newly validated token into the live endpoint.
				this.relayAuthToken = undefined;
				this.log("warn", "managed Iroh relay credential expired; starting endpoint in degraded retry mode");
			}
			const startupCredentialEpoch = this.relayCredentialEpoch;
			const isManagedRelayEndpoint =
				this.relayMode === "production" &&
				this.relayCredentialServiceUrl !== undefined &&
				(this.managedRelayCredential !== undefined || this.relayAuthToken === undefined);
			if (this.relayMode === "development") {
				this.log(
					"warn",
					"using public n0 relays (development only; unset VOLT_IROH_RELAY_MODE for the Volt relays)",
				);
			} else if (this.relayMode === "production" && this.relayUrls.length === 0) {
				throw new Error("relayMode production requires relay URLs (config.relayUrls or VOLT_IROH_RELAY_URLS)");
			}
			const secretKey = this.services.state.state.irohSecretKey;
			// Saved direct tickets carry this port and relay-disabled phones have no
			// discovery, so reuse it. Retry briefly in case a predecessor daemon is
			// still releasing the socket, then fall back to a fresh port.
			const savedBindPort = this.services.state.state.settings.irohBindPort;
			let boundEndpoint: IrohBoundEndpointLike | undefined;
			let pinnedBindError: unknown;
			if (savedBindPort !== undefined) {
				const attempts = Math.max(1, this.dependencies.directPortBindAttempts ?? DIRECT_PORT_BIND_ATTEMPTS);
				const retryDelayMs = this.dependencies.directPortRetryDelayMs ?? DIRECT_PORT_RETRY_DELAY_MS;
				for (let attempt = 0; boundEndpoint === undefined && attempt < attempts; attempt++) {
					if (attempt > 0 && !(await delayUnlessAborted(retryDelayMs, startupAdmission.signal))) break;
					const bindTask = Promise.resolve().then(() =>
						this.createEndpointBuilder(iroh, secretKey, savedBindPort).bind(),
					);
					let bound: IrohBoundEndpointLike | undefined;
					try {
						bound = await waitUntilAdmissionCancelled(bindTask, startupAdmission.signal);
					} catch (error) {
						pinnedBindError = error;
						continue;
					}
					if (bound === undefined) {
						this.retireLateBoundEndpoint(bindTask);
						this.ready.reject(new Error("iroh service shut down during endpoint bind"));
						return;
					}
					boundEndpoint = bound;
				}
			}
			if (boundEndpoint === undefined && startupAdmission.signal.aborted) {
				this.ready.reject(new Error("iroh service shut down during endpoint bind"));
				return;
			}
			const pinnedBindFailed = savedBindPort !== undefined && boundEndpoint === undefined;
			if (boundEndpoint === undefined) {
				const bindTask = this.createEndpointBuilder(iroh, secretKey, undefined).bind();
				boundEndpoint = await waitUntilAdmissionCancelled(bindTask, startupAdmission.signal);
				if (!boundEndpoint) {
					this.retireLateBoundEndpoint(bindTask);
					this.ready.reject(new Error("iroh service shut down during endpoint bind"));
					return;
				}
			}
			endpoint = boundEndpoint;
			const directPort = ipv4PortFromBoundSockets(boundEndpoint.boundSockets());
			if (pinnedBindFailed) {
				this.log(
					"warn",
					"could not reuse the saved Iroh direct port; relay-disabled phone pairings made before this start must pair again",
					{
						savedPort: savedBindPort,
						...(directPort === undefined ? {} : { directPort }),
						error: pinnedBindError instanceof Error ? pinnedBindError.message : String(pinnedBindError),
					},
				);
			}
			endpoint = this.dependencies.decorateEndpoint?.(endpoint) ?? endpoint;
			this.startupEndpoint = endpoint;
			if (startupCredentialEpoch !== this.relayCredentialEpoch || this.relayCredentialIsRevoking) {
				throw new Error("managed relay credential changed during endpoint startup");
			}
			if (
				this.managedRelayCredential !== undefined &&
				endpoint.id().toString() !== this.managedRelayCredential.endpointNodeId
			) {
				throw new Error("managed relay credential does not match the persistent Iroh endpoint identity");
			}
			if (
				isManagedRelayEndpoint &&
				(endpoint.reconnectRelay === undefined ||
					endpoint.watchHomeRelay === undefined ||
					!this.relayReconnectApiSafe)
			) {
				throw new Error("the installed Volt Iroh binding cannot rotate and confirm live relay credentials");
			}
			this.scheduleManagedRelayCredentialExpiryFence();
			if (!startupAdmission.isCurrent()) {
				this.retireEndpoint(endpoint, "iroh endpoint disposal after cancelled bind failed");
				endpoint = undefined;
				this.ready.reject(new Error("iroh service shut down during endpoint startup"));
				return;
			}
			const persistDirectPort = directPort !== undefined && directPort !== savedBindPort;
			if (!secretKey || persistDirectPort) {
				if (!secretKey) {
					const boundKey = endpoint.secretKey().toBytes();
					this.services.state.setHostState({
						...this.services.state.getHostState(),
						hostSecretKey: boundKey,
					});
				}
				if (persistDirectPort) {
					this.services.state.updateSettings({ irohBindPort: directPort });
				}
				// Persist the freshly minted identity and direct port synchronously
				// before the accept loop starts taking pairings. A crash/SIGKILL inside
				// the 250ms debounce window would otherwise lose them, and every phone
				// paired against this endpoint would hold a node id or direct address
				// the daemon can never reproduce on restart.
				await this.services.state.flush();
				if (!startupAdmission.isCurrent()) {
					this.retireEndpoint(endpoint, "iroh endpoint disposal after endpoint state persistence failed");
					endpoint = undefined;
					this.ready.reject(new Error("iroh service shut down during endpoint state persistence"));
					return;
				}
			}
			const hostNodeId = endpoint.id().toString();
			const persistedClaim = this.managedRelayCredentialClaim;
			if (persistedClaim?.hostNodeId !== undefined && persistedClaim.hostNodeId !== hostNodeId) {
				throw new Error("managed relay credential claim does not match the persistent Iroh endpoint identity");
			}
			if (
				persistedClaim !== undefined &&
				(persistedClaim.claimId === undefined ||
					persistedClaim.expiresAt === undefined ||
					persistedClaim.expiresAt <= Date.now())
			) {
				await this.discardManagedRelayCredentialClaim(persistedClaim);
			}
			if (!startupAdmission.isCurrent()) {
				this.retireEndpoint(endpoint, "iroh endpoint disposal after managed relay claim cleanup failed");
				endpoint = undefined;
				this.ready.reject(new Error("iroh service shut down during managed relay claim cleanup"));
				return;
			}
			// Everything after this boundary is native/publication work. Quiesce may
			// now close core state without waiting for bind/online transport tails;
			// dispose owns and bounds those tasks instead.
			releaseStartupAdmission();
			if (this.relayMode !== "disabled" && !isManagedRelayEndpoint) {
				const onlineTask = Promise.resolve(endpoint.online());
				this.trackNativeLifecycleTask(onlineTask);
				const online = await waitUntilAdmissionCancelled(
					onlineTask.then(() => true),
					startupAdmission.signal,
				);
				if (online !== true) {
					this.retireEndpoint(endpoint, "iroh endpoint disposal after cancelled online failed");
					endpoint = undefined;
					this.ready.reject(new Error("iroh service shut down while endpoint was coming online"));
					return;
				}
			}
			if (
				!this.admission.isOpen ||
				startupCredentialEpoch !== this.relayCredentialEpoch ||
				this.relayCredentialIsRevoking
			) {
				this.retireEndpoint(endpoint, "iroh endpoint disposal after startup cancellation failed");
				endpoint = undefined;
				this.ready.reject(new Error("iroh service shut down during endpoint startup"));
				return;
			}
			const endpointTicket = createIrohEndpointTicket(
				iroh,
				endpoint.addr(),
				this.relayMode === "production" ? this.relayUrls : [],
			);
			const engine = new IrohRemoteHostEngine({
				auditLogger: this.services.auditLogger,
				authorizeRelayCredentialPairing: (claimId, remoteNodeId) =>
					this.authorizeRelayCredentialPairing(claimId, remoteNodeId),
				classifyWorkspaceAvailability: getIrohRemoteWorkspaceAvailabilityStatus,
				hostNodeId,
				relayMode: this.relayMode,
				...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
				stateManager: this.stateManager,
				validateWorkspace: async (workspace) =>
					(await getIrohRemoteWorkspaceAvailabilityStatus(workspace)) === "available",
				workspace: { name: "voltd", path: this.services.agentDir },
			});
			this.endpoint = endpoint;
			this.startupEndpoint = undefined;
			this.hostNodeId = hostNodeId;
			this.endpointTicket = endpointTicket;
			this.engine = engine;
			this.ensureRelayRecoveryMonitor();
			this.startManagedRelayCredentialExchange();
			this.scheduleManagedRelayCredentialRefresh();
			if (this.relayMode !== "disabled" && isManagedRelayEndpoint) {
				const publishedEndpoint = endpoint;
				const onlineTask = Promise.resolve().then(() => publishedEndpoint.online());
				this.trackNativeLifecycleTask(
					onlineTask.catch((error: unknown) => {
						if (!this.admission.isOpen) return;
						this.log("warn", "Iroh endpoint initial online wait failed before managed relay activation", {
							error: error instanceof Error ? error.message : String(error),
						});
					}),
				);
			}
			this.remoteTransport = {
				state: "ready",
				...(this.wrapperVersion === undefined ? {} : { wrapperVersion: this.wrapperVersion }),
			};
			this.ready.resolve();
			this.log("info", `iroh endpoint online`, {
				hostNodeId: this.hostNodeId,
				relayMode: this.relayMode,
				...(directPort === undefined ? {} : { directPort }),
				...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
			});
			this.acceptLoopTask = this.acceptLoop(endpoint).catch((error) => {
				this.remoteTransport = {
					state: "unavailable",
					reasonCode: "endpoint_start_failed",
					message: REMOTE_TRANSPORT_REASON_MESSAGES.endpoint_start_failed,
					...(this.wrapperVersion === undefined ? {} : { wrapperVersion: this.wrapperVersion }),
				};
				this.log("error", `accept loop failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			endpoint = undefined;
		} catch (error) {
			if (endpoint) {
				this.retireEndpoint(endpoint, "iroh endpoint disposal after startup failure failed");
			}
			// Without the binding, startup work that failed does not change why phone transport is unavailable.
			if (iroh === undefined) {
				this.log("error", `daemon startup work failed: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			if (isIrohRemoteHostStorageFullError(error)) {
				this.markStorageCapacityUnavailable();
			} else {
				this.remoteTransport = {
					state: "unavailable",
					reasonCode: "endpoint_start_failed",
					message: REMOTE_TRANSPORT_REASON_MESSAGES.endpoint_start_failed,
					...(this.wrapperVersion === undefined ? {} : { wrapperVersion: this.wrapperVersion }),
				};
			}
			this.ready.reject(error);
			this.log("error", `failed to start iroh endpoint: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			releaseStartupAdmission();
		}
	}

	private async acceptLoop(endpoint: IrohEndpointLike): Promise<void> {
		while (this.admission.isOpen) {
			let incoming: Awaited<ReturnType<IrohEndpointLike["acceptNext"]>>;
			try {
				incoming = await endpoint.acceptNext();
			} catch (error) {
				if (!this.admission.isOpen) {
					break;
				}
				throw error;
			}
			if (!incoming) {
				if (!this.admission.isOpen) {
					break;
				}
				throw new Error("Iroh endpoint accept loop terminated unexpectedly");
			}
			// Acquire once for the accepted incoming before branching. This is the
			// exact publication fence for both rejection work and handleConnection;
			// quiesce either observes this lease or wins before it can be acquired.
			const admission = this.admission.tryAcquire();
			if (!admission) {
				try {
					const refusalTask = Promise.resolve(incoming.refuse());
					this.trackNativeLifecycleTask(refusalTask);
				} catch {}
				break;
			}
			const connectionAdmission = this.resourceGuard.tryAcquireConnectionTask();
			if (!connectionAdmission.ok) {
				try {
					let refused = true;
					try {
						await runLifecycleFencedPhysicalOperation(
							() => incoming.refuse(),
							admission.signal,
							(task) => this.trackNativeLifecycleTask(task),
						);
					} catch (error) {
						if (isIrohStreamLifecycleClosedError(error)) {
							continue;
						}
						refused = false;
					}
					if (!admission.isCurrent()) {
						continue;
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
				} finally {
					admission.release();
				}
				continue;
			}
			// Ownership of the per-incoming admission lease transfers to the
			// connection task; its single release path lives in handleConnection.
			const task = this.handleConnection(incoming, admission)
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
		admission: IrohDaemonAdmissionLease,
	): Promise<void> {
		let admissionReleased = false;
		const releaseAdmission = () => {
			if (admissionReleased) return;
			admissionReleased = true;
			admission.release();
		};
		let connection: IrohConnectionLike;
		let supervisor: IrohConnectionSupervisor;
		let remoteId: string;
		let connectionId: string;
		let unauthenticatedAdmission: Extract<
			ReturnType<IrohRemoteResourceGuard["tryAcquireUnauthenticatedConnection"]>,
			{ ok: true }
		>;
		try {
			try {
				const accepting = await runLifecycleFencedPhysicalOperation(
					() => incoming.accept(),
					admission.signal,
					(task) => this.trackNativeLifecycleTask(task),
				);
				connection = await runLifecycleFencedPhysicalOperation(
					() => accepting.connect(),
					admission.signal,
					(task) => this.trackNativeLifecycleTask(task),
				);
			} catch (error) {
				if (!isIrohStreamLifecycleClosedError(error) && admission.isCurrent()) {
					await this.logAudit({
						type: "iroh_security_transport_rejected",
						success: false,
						error: "incoming transport handshake failed",
						details: { phase: "transport_connect" },
					});
				}
				return;
			}
			// A transport handshake can complete in the same event-loop turn as
			// quiesce. Close it without publishing application ownership; endpoint
			// disposal owns any remaining native transport tail.
			if (!admission.isCurrent()) {
				try {
					connection.close(0n, Array.from(Buffer.from("host_shutdown", "utf8")));
				} catch {}
				return;
			}
			supervisor = new IrohConnectionSupervisor(connection);
			try {
				connection.setMaxConcurrentBiStreams(BigInt(MAX_CONCURRENT_STREAMS_PER_CONNECTION));
			} catch {
				supervisor.requestClose("stream_limit_configuration_failed", "immediate");
				await this.logAudit({
					type: "iroh_security_transport_rejected",
					success: false,
					error: "connected transport could not enforce the inbound stream limit",
					details: { phase: "stream_limit_configuration" },
				});
				releaseAdmission();
				await supervisor.finalize("stream_limit_configuration_failed");
				return;
			}
			try {
				remoteId = connection.remoteId().toString();
			} catch {
				supervisor.requestClose("invalid_remote_identity", "immediate");
				await this.logAudit({
					type: "iroh_security_transport_rejected",
					success: false,
					error: "connected transport did not expose a valid remote identity",
					details: { phase: "remote_identity" },
				});
				releaseAdmission();
				await supervisor.finalize("invalid_remote_identity");
				return;
			}
			const nodeConnectionAdmission = this.resourceGuard.tryAcquireNodeConnection(remoteId);
			if (!nodeConnectionAdmission.ok) {
				supervisor.requestClose("node_connection_limit", "immediate");
				await this.logAudit({
					type: "iroh_security_connection_limit",
					clientNodeId: remoteId,
					success: false,
					error: "connection refused at per-node connection limit",
					details: { limit: nodeConnectionAdmission.limit, scope: nodeConnectionAdmission.scope },
				});
				releaseAdmission();
				await supervisor.finalize("node_connection_limit");
				return;
			}
			supervisor.addTerminalFinalizer(() => nodeConnectionAdmission.lease.release());
			const provisionalUnauthenticatedAdmission = this.resourceGuard.tryAcquireUnauthenticatedConnection(remoteId);
			if (!provisionalUnauthenticatedAdmission.ok) {
				supervisor.requestClose("unauthenticated_connection_limit", "immediate");
				await this.logAudit({
					type: "iroh_security_unauthenticated_connection_limit",
					clientNodeId: remoteId,
					success: false,
					error: "unauthenticated connection refused at admission limit",
					details: {
						limit: provisionalUnauthenticatedAdmission.limit,
						scope: provisionalUnauthenticatedAdmission.scope,
					},
				});
				releaseAdmission();
				await supervisor.finalize("unauthenticated_connection_limit");
				return;
			}
			unauthenticatedAdmission = provisionalUnauthenticatedAdmission;
			supervisor.addTerminalFinalizer(() => provisionalUnauthenticatedAdmission.lease.release());
			connectionId = `conn-${++activeConnectionSequence}`;
			this.registerClientConnection(remoteId, connectionId, supervisor);
			releaseAdmission();
		} finally {
			releaseAdmission();
		}
		let acceptedStreamCount = 0;
		let authenticated = false;
		const unauthenticatedTimeoutMs =
			this.dependencies.handshakeTimeoutMs ?? IROH_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS;
		const handshakeTimeoutMs = this.dependencies.handshakeTimeoutMs ?? DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS;
		const unauthenticatedTimer = setTimeout(() => {
			if (authenticated || supervisor.isClosing) return;
			supervisor.requestClose("handshake_timeout", "immediate");
			void this.logAudit({
				type: "iroh_security_handshake_timeout",
				clientNodeId: remoteId,
				success: false,
				error: "connection did not authenticate before the handshake deadline",
				details: { connectionId, timeoutMs: unauthenticatedTimeoutMs },
			});
		}, unauthenticatedTimeoutMs);
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
				// Bound only the wait for the first stream. The first stream authenticates
				// asynchronously, and the unauthenticated timer already closes a connection
				// that never authenticates; a sibling-accept deadline would tear down a
				// single authenticated stream still serving a slow request.
				const stream = await (acceptedStreamCount === 0
					? withTimeout(connection.acceptBi(), handshakeTimeoutMs, "handshake timed out")
					: connection.acceptBi());
				acceptedStreamCount++;
				if (!this.admission.isOpen) {
					closeIrohRemoteStream(stream, "host_shutdown");
					supervisor.requestClose("host_shutdown", "immediate");
					break;
				}
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
				const task = this.runOwnedConnectionStream(stream, remoteId, connectionId, streamId, markAuthenticated)
					.catch(async (error) => {
						if (
							this.admission.isOpen &&
							!isIrohStreamLifecycleClosedError(error) &&
							!isExpectedApplicationClose(error)
						) {
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
					details: { connectionId, timeoutMs: handshakeTimeoutMs },
				});
			}
		} finally {
			clearTimeout(unauthenticatedTimer);
			await this.closeActiveStreamsForConnection(connectionId, "connection_closed");
			await supervisor.finalize("done");
			if (authenticated && this.admission.isOpen) {
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

	private async runOwnedConnectionStream(
		rawStream: IrohBiStreamLike,
		remoteId: string,
		connectionId: string,
		streamId: string,
		markAuthenticated: () => Promise<boolean>,
	): Promise<void> {
		const decoratedStream = this.dependencies.decorateAcceptedStream?.(rawStream) ?? rawStream;
		let stream: IrohBiStreamLike | undefined;
		const owner = new IrohPhysicalStreamOwner(
			(reason) => closeIrohRemoteStream(stream ?? decoratedStream, reason),
			decoratedStream,
		);
		stream = createLifecycleFencedIrohStream(decoratedStream, owner.signal, (task) =>
			this.trackNativeLifecycleTask(task),
		);
		this.physicalStreamOwners.set(streamId, owner);
		try {
			await this.handleConnectionStream(stream, remoteId, connectionId, streamId, markAuthenticated, owner);
		} finally {
			try {
				await owner.close("stream_task_settled").catch(() => {});
			} finally {
				if (this.physicalStreamOwners.get(streamId) === owner) {
					this.physicalStreamOwners.delete(streamId);
				}
			}
		}
	}

	private async handleConnectionStream(
		stream: IrohBiStreamLike,
		remoteId: string,
		connectionId: string,
		streamId: string,
		markAuthenticated: () => Promise<boolean>,
		owner: IrohPhysicalStreamOwner,
	): Promise<void> {
		if (!this.admission.isOpen) {
			await owner.close("host_shutdown").catch(() => {});
			return;
		}
		const engine = this.requireEngine();
		const handshakeAdmission = this.resourceGuard.tryAcquireHandshake(remoteId);
		if (!handshakeAdmission.ok) {
			await owner.close("handshake_limit_exceeded").catch(() => {});
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
				isCancelled: () => owner.signal.aborted,
				maxLineBytes: DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
				timeoutMs: this.dependencies.handshakeTimeoutMs ?? DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
			});
		} finally {
			handshakeAdmission.lease.release();
		}
		if (!this.admission.isOpen) {
			await owner.close("host_shutdown").catch(() => {});
			return;
		}
		if (!handshake.ok) {
			if (handshake.response.outcome === "host_storage_full") {
				this.markStorageCapacityUnavailable();
			}
			if (
				handshake.response.outcome === "workspace_authorization_removed" &&
				typeof handshake.response.workspace === "string"
			) {
				await this.closeWorkspaceAuthorizationRemovedStreams(remoteId, handshake.response.workspace);
			}
			await this.writeTerminalHandshakeResponse(stream, handshake.response);
			return;
		}
		this.clearStorageCapacityDegradation();
		if (!(await markAuthenticated())) {
			await owner.close("handshake_timeout").catch(() => {});
			return;
		}
		if (!this.admission.isOpen) {
			await owner.close("host_shutdown").catch(() => {});
			return;
		}

		const streamCapability = getIrohRemoteStreamCapability({
			mode: handshake.hello.mode,
			...(handshake.hello.mode === "workspaceManagement"
				? { purpose: handshake.hello.workspaceManagement.purpose }
				: handshake.hello.mode === "workspaceDiscovery"
					? { purpose: handshake.hello.workspaceDiscovery.purpose }
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
			await this.runWorkspaceStream(stream, handshake, connectionId, streamId, owner, {
				kind: "discovery",
				purpose: handshake.hello.workspaceDiscovery.purpose,
			});
			return;
		}
		if (handshake.hello.mode === "workspaceManagement") {
			await this.runWorkspaceStream(stream, handshake, connectionId, streamId, owner, {
				kind: "management",
				purpose: handshake.hello.workspaceManagement.purpose,
			});
			return;
		}
		await this.runIntegratedConversation(stream, handshake, connectionId, streamId, owner);
	}

	// ==========================================================================
	// Workspace streams
	// ==========================================================================

	private registerActiveStream(
		authorization: IrohRemoteClientAuthorizationSuccess,
		sessionId: string,
		stream: IrohBiStreamLike,
		owner: IrohPhysicalStreamOwner,
		connectionId: string,
		streamId: string,
		details: {
			/** Settles after the owning stream task has finished. */
			lifecycleSettled?: Promise<void>;
		} = {},
	): { entry: IrohRemoteActiveStreamEntry; remove: () => void } {
		const entry: IrohRemoteActiveStreamEntry = {
			clientNodeId: authorization.client.nodeId,
			connectionId,
			sessionId,
			streamId,
			workspaceName: authorization.workspace.name,
			close: (reason: string) => owner.close(reason),
		};
		const installed = owner.installCloseAction(
			(reason) =>
				closeStreamConnection(
					stream,
					owner.physicalStream ?? stream,
					reason,
					entry.connection,
					details.lifecycleSettled,
				),
			// The connection writes its final frames and finishes the stream before the fence closes it.
			{ fenceAfterMs: STREAM_FINAL_FRAME_TIMEOUT_MS },
		);
		if (!installed) {
			throw new Error("physical stream closed before active ownership was installed");
		}
		const removeActiveStream = this.activeStreams.register(entry);
		// Every client stream, including short discovery reads, keeps linked PR status polling fast.
		const releaseClientActivity = this.services.changes.retainClientActivity();
		let removed = false;
		return {
			entry,
			remove: () => {
				if (removed) return;
				removed = true;
				removeActiveStream();
				releaseClientActivity();
			},
		};
	}

	// ==========================================================================
	// Host status: keep-awake and the shared theme reach devices as `changed{host}`
	// ==========================================================================

	/** Whether the daemon shares its resolved theme colors with devices (`host_status.theme`); off by default. */
	private isThemeTokenPushEnabled(): boolean {
		return this.services.state.state.settings.themeTokenPush === true || process.env.VOLT_HOST_THEME_TOKENS === "1";
	}

	/** Tell every device stream to refetch the host's status. */
	private hostStatusChanged(): void {
		for (const entry of this.activeStreams.allEntries()) entry.connection?.changed("host");
	}

	/** Theme changed: devices refetch the shared theme. */
	onThemeChanged(): void {
		if (!this.isThemeTokenPushEnabled()) {
			return;
		}
		this.hostStatusChanged();
	}

	/** Keep-awake status changed (control toggle, phone toggle, or degradation). */
	onKeepAwakeChanged(): void {
		this.hostStatusChanged();
	}

	/**
	 * Serve a workspace stream: host intents and queries of one purpose on the
	 * device's remote profile, without a conversation.
	 */
	private async runWorkspaceStream(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		owner: IrohPhysicalStreamOwner,
		scope: Extract<RemoteStreamScope, { kind: "discovery" | "management" }>,
	): Promise<void> {
		const authorization = handshake.authorization;
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		await this.dependencies.beforeAuthorizedStreamPublication?.(
			scope.kind === "discovery"
				? "workspace_discovery"
				: scope.purpose === "manage_worktrees"
					? "worktree_management"
					: "workspace_management",
			authorization,
		);
		if (!this.admission.isOpen || !(await this.isAuthorizationCurrent(authorization))) {
			await owner.close("access_updated_during_attach").catch(() => {});
			return;
		}
		const activeStream = this.registerActiveStream(
			authorization,
			scope.kind === "discovery" ? WORKSPACE_DISCOVERY_STREAM_SESSION_ID : WORKSPACE_MANAGEMENT_STREAM_SESSION_ID,
			stream,
			owner,
			connectionId,
			streamId,
		);
		/** The device unregisters this stream's workspace: the stream stays until the answer is written. */
		let unregistering = false;
		const frameAuthority = this.frameAuthority(authorization);
		const allows = remoteStreamAllows(scope);
		try {
			const connection = serveIrohRemoteConnection({
				stream,
				initialInput: handshake.initialInput,
				grant: parseIrohRemoteRpcGrant(authorization.client.rpcGrant, "client rpcGrant"),
				clientKey: authorization.client.nodeId,
				redaction: {
					workspacePath: authorization.workspace.path,
					remoteWorkspacePath: "/workspace",
					...(scope.purpose === "manage_worktrees"
						? { additionalRedactedPaths: [getWorktreesRoot(this.services.agentDir)] }
						: {}),
				},
				services: () =>
					remoteIntentServices(this.remoteIntentHost, authorization, scope, {
						keep: { streamId },
						signal: owner.signal,
						workspaceUnregister: {
							begin: () => {
								unregistering = true;
							},
							// An accepted unregister ends the connection after its answer.
							end: (succeeded) => {
								if (!succeeded) unregistering = false;
							},
						},
					}),
				authority: () => (unregistering ? undefined : frameAuthority()),
				revalidate: () => (unregistering ? Promise.resolve(true) : this.isAuthorizationCurrent(authorization)),
				...(allows === undefined ? {} : { allows }),
			});
			activeStream.entry.connection = connection;
			await connection.closed.catch(() => undefined);
		} finally {
			activeStream.remove();
		}
	}

	private createSessionContextsRpcBackend(
		authorization: IrohRemoteClientAuthorizationSuccess,
	): IrohRemoteSessionContextsRpcBackend {
		const backend = createIrohRemoteSessionContextsRpcBackend({
			workspaceName: authorization.workspace.name,
			sessionDirectory: getDefaultSessionDirPath(authorization.workspace.path, this.services.agentDir),
			getChangeContext: (sessionId) =>
				authorization.workspaceGeneration === undefined
					? undefined
					: this.services.changes.getChangeContext(
							authorization.workspace.name,
							authorization.workspaceGeneration,
							sessionId,
						),
		});
		return {
			getSessionContexts: async (workspaceName, sessionIds) => {
				const admission = this.admission.tryAcquire();
				if (!admission) throw new Error("host is shutting down");
				try {
					return await backend.getSessionContexts(workspaceName, sessionIds);
				} finally {
					admission.release();
				}
			},
		};
	}

	private createAgentOptionsRpcBackend(workspace: IrohRemoteWorkspace): IrohRemoteAgentOptionsRpcBackend {
		return {
			getAgentOptions: async () => {
				const admission = this.admission.tryAcquire();
				if (!admission) throw new Error("host is shutting down");
				try {
					return await this.getAgentOptions(workspace, admission.signal);
				} finally {
					admission.release();
				}
			},
		};
	}

	private async getAgentOptions(
		workspace: IrohRemoteWorkspace,
		signal?: AbortSignal,
	): Promise<IrohRemoteAgentOptions> {
		const projectTrusted = resolveIrohRemoteWorkspaceProjectTrusted(workspace, { trustStore: this.trustStore });
		const settingsManager = SettingsManager.create(workspace.path, this.services.agentDir, {
			profile: this.profile,
			projectTrusted,
		});
		// The daemon runs no extension code: the models of the built-in catalog and models.json.
		const authStorage = AuthStorage.create(join(this.services.agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(this.services.agentDir, "models.json"));
		return createIrohRemoteAgentOptions(workspace.name, { modelRegistry, settingsManager }, signal);
	}

	private prReviewAuthority(
		authorization: IrohRemoteClientAuthorizationSuccess,
		signal?: AbortSignal,
	): PrReviewPreparationAuthority {
		return {
			workspaceGeneration: authorization.workspaceGeneration ?? 0,
			signal,
			assertCurrent: () => {
				signal?.throwIfAborted();
				const state = this.services.state.getHostState();
				const client = state.clients.find((entry) => entry.nodeId === authorization.client.nodeId);
				const workspace = state.workspaces.find((entry) => entry.name === authorization.workspace.name);
				const generation = state.workspaceGenerations?.find(
					(entry) => entry.workspaceName === authorization.workspace.name,
				)?.generation;
				if (
					!this.admission.isOpen ||
					client?.rpcGrant?.revision !== authorization.client.rpcGrant.revision ||
					!isIrohRemoteClientAllowedForWorkspace(client, authorization.workspace.name) ||
					client.allowedTools !== authorization.client.allowedTools ||
					workspace?.path !== authorization.workspace.path ||
					workspace.allowedTools !== authorization.workspace.allowedTools ||
					generation !== authorization.workspaceGeneration
				) {
					throw new PrReviewPreparationError("review_preparation_failed");
				}
			},
		};
	}

	private createPrReviewRpcBackend(
		authorization: IrohRemoteClientAuthorizationSuccess,
		signal: AbortSignal,
	): IrohRemotePrReviewRpcBackend {
		const run = async <T>(operation: (authority: PrReviewPreparationAuthority) => Promise<T>): Promise<T> => {
			const admission = this.admission.tryAcquire();
			if (!admission) throw new PrReviewPreparationError("review_preparation_failed");
			try {
				const authority = this.prReviewAuthority(authorization, AbortSignal.any([signal, admission.signal]));
				authority.assertCurrent();
				return await operation(authority);
			} catch (error) {
				throw new PrReviewPreparationError(
					error instanceof PrReviewCheckoutError ? error.code : "review_preparation_failed",
				);
			} finally {
				admission.release();
			}
		};
		return {
			resolvePrReview: (_workspaceName, request) =>
				run((authority) => this.prReviewCheckouts.resolve(authorization.workspace, request, authority)),
			preparePrReview: (_workspaceName, request) =>
				run((authority) => this.prReviewCheckouts.prepare(authorization.workspace, request, authority)),
		};
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
		let closedStreamCount = 0;
		const boundWorkers = new Set(
			record.sessionIds.flatMap((sessionId) => this.workers.host(workspace.name, sessionId)?.workerId ?? []),
		);
		if (boundWorkers.size > 0) {
			if (!force) {
				return { ok: false, error: "worktree_busy" };
			}
			for (const workerId of boundWorkers) {
				closedStreamCount += [...this.workerRelays.values()].filter((entry) => entry.workerId === workerId).length;
				await this.workers.retireWorker(workerId, "authority");
			}
		}
		const stoppedRuntimeCount = boundWorkers.size;
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
			const requestedWorktreeId = hello.conversation.worktreeId;
			const boundWorktree =
				targetSessionId === undefined
					? undefined
					: await this.worktrees.resolveSessionWorktree(workspaceName, targetSessionId);
			if (boundWorktree !== undefined && boundWorktree.id !== requestedWorktreeId) {
				throw createConversationOpenError(
					"invalid_conversation_target",
					"session id is already bound to a different worktree placement",
					{ workspace: workspaceName, sessionId: targetSessionId },
				);
			}
			if (requestedWorktreeId === undefined) return undefined;
			const worktree = boundWorktree ?? (await this.worktrees.findWorktree(workspaceName, requestedWorktreeId));
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
		// Plain {message, ...} records (relay closure, lease re-check) must not
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

	/**
	 * Relay a phone conversation stream to the owning TUI (§5.6): the daemon
	 * has already authenticated the phone; the TUI serves the framed RPC from
	 * its in-process runtime over a dedicated relay unix connection.
	 */
	private async relayConversationToTui(
		stream: IrohBiStreamLike,
		physicalOwner: IrohPhysicalStreamOwner,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		targetSessionId: string,
		tuiConnectionId: string,
		admission: IrohDaemonAdmissionLease,
	): Promise<void> {
		const authorization = handshake.authorization;
		const workspaceName = authorization.workspace.name;
		if (!admission.isCurrent()) {
			return;
		}

		// Duplicate handling per clientNodeId + key: duplicates already on this
		// Iroh connection are real duplicates; entries on older connections are
		// stale for this conversation and may be replaced independently of any
		// sibling subagent streams that opened first on the new connection.
		const liveRelays = this.relays.forConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
			"active",
		);
		const pendingRelays = this.relays.forConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
			"offered",
		);
		if (
			liveRelays.some((relay) => relay.connectionId === connectionId) ||
			pendingRelays.some((pending) => pending.connectionId === connectionId)
		) {
			await this.rejectDuplicateActiveConnection(stream, authorization, targetSessionId, "relay_registry");
			return;
		}
		for (const relay of liveRelays) {
			void this.conversationCoordinators.get(workspaceName, targetSessionId)?.closeTransport(relay.relayId, "error");
		}
		// Unredeemed offers for the same conversation on older connections are
		// superseded by this one: fail their deferred handshakes and settle them
		// (relay_closed to the TUI, lease bookkeeping) instead of leaking tasks.
		for (const pending of pendingRelays) {
			void this.conversationCoordinators
				.get(workspaceName, targetSessionId)
				?.closeTransport(pending.relayId, "error");
		}

		// Resolve the concrete session target for the preamble (§3.7).
		const sessionTarget: IrohRemoteSessionTarget =
			handshake.hello.mode === "conversation" && handshake.hello.conversation.target === "session"
				? { kind: "session", sessionId: targetSessionId }
				: { kind: "last", resumeSessionId: targetSessionId };
		// A worktree-bound session opens with its stored cwd while retaining the
		// parent workspace's session store. resolveSessionWorktree also heals
		// stranded bindings (moved-to/subagent session ids) from that stored cwd, so
		// relays fail with the designed worktree gates instead of
		// session_unavailable (#83).
		const boundWorktree = await this.worktrees.resolveSessionWorktree(workspaceName, targetSessionId);
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
		let resolvedTarget: ResolvedSessionTargetWithManager<SessionManager>;
		let resolvedSessionCwd: string;
		try {
			resolvedTarget = await resolveIrohRemoteSessionTarget(
				sessionTarget,
				{ name: workspaceName, path: authorization.workspace.path },
				createSessionManagerTargetStore(
					boundWorktree?.path ?? authorization.workspace.path,
					getDefaultSessionDir(authorization.workspace.path, this.services.agentDir),
					// The owning TUI holds the session's lock; resolving the target only reads it.
					{ listAll: true, preserveSessionCwd: true, readOnly: true },
				),
			);
			try {
				resolvedSessionCwd = resolvedTarget.sessionManager.getCwd();
			} finally {
				await resolvedTarget.sessionManager.closePersistence();
			}
		} catch (error) {
			await this.sendHandshakeError(stream, error);
			return;
		}
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
		// connection loss) in the meantime. Re-check before minting so the offer
		// cannot go to a stale or dead owner.
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
		await this.dependencies.beforeAuthorizedStreamPublication?.("relay", authorization);
		if (!(await this.isAuthorizationCurrent(authorization))) {
			await this.sendHandshakeError(stream, { message: "client access changed; reconnect" });
			return;
		}
		if (!admission.isCurrent()) {
			return;
		}

		// A sibling stream can resolve/redeem while this stream awaits target
		// resolution. Re-check immediately before minting the offer.
		const currentLiveRelays = this.relays.forConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
			"active",
		);
		const currentPendingRelays = this.relays.forConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
			"offered",
		);
		if (
			currentLiveRelays.some((relay) => relay.connectionId === connectionId) ||
			currentPendingRelays.some((pending) => pending.connectionId === connectionId)
		) {
			await this.rejectDuplicateActiveConnection(stream, authorization, targetSessionId, "relay_registry");
			return;
		}
		for (const relay of currentLiveRelays) {
			void this.conversationCoordinators.get(workspaceName, targetSessionId)?.closeTransport(relay.relayId, "error");
		}
		for (const pending of currentPendingRelays) {
			void this.conversationCoordinators
				.get(workspaceName, targetSessionId)
				?.closeTransport(pending.relayId, "error");
		}

		if (!admission.isCurrent()) {
			return;
		}
		const coordinator = this.conversationCoordinators.getOrCreate(workspaceName, targetSessionId);
		let releaseRelayTransport = () => {};
		const relayPhysicalStream = physicalOwner.physicalStream ?? stream;
		const relay = this.relays.mint({
			workspaceName,
			sessionId: targetSessionId,
			clientNodeId: authorization.client.nodeId,
			connectionId,
			ownerControlConnectionId: tuiConnectionId,
			streamId,
			stream: relayPhysicalStream,
			observePhysicalTask: (task) => this.trackNativeLifecycleTask(task),
			preamble: this.phonePreamble(handshake, connectionId, streamId, {
				sessionId: resolvedTarget.sessionId,
				selection: resolvedTarget.selection,
				...(resolvedTarget.requestedSessionId === undefined
					? {}
					: { requestedSessionId: resolvedTarget.requestedSessionId }),
				worktree: boundWorktree,
				workingDirectory: relayWorkingDirectory,
			}),
			rejectPending: ({ message, retryAfterMs }) =>
				this.sendHandshakeError(relayPhysicalStream, {
					message,
					...(retryAfterMs === undefined ? {} : { retryAfterMs }),
				}),
			onSettled: async (outcome) => {
				coordinator.unregisterRelayLease(relay.relayId);
				this.services.controlServer.sendTo(tuiConnectionId, {
					type: "relay_closed",
					relayId: relay.relayId,
					reason: outcome.reason,
				});
				await this.logAudit({
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
			},
		});
		if (
			!physicalOwner.installCloseAction((reason) =>
				relay
					.close(normalizeRelayCloseReason(reason), {
						pendingMessage: relayPendingMessageForReason(reason),
						...(reason === "workspace_unregistered" || reason === "host_shutdown"
							? {}
							: { retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS }),
					})
					.then(() => undefined),
			)
		) {
			await relay.close("host_shutdown", { pendingMessage: relayPendingMessageForReason("host_shutdown") });
			this.conversationCoordinators.releaseIfVacant(coordinator);
			return;
		}

		try {
			releaseRelayTransport = coordinator.registerTransport({
				id: relay.relayId,
				kind: "relay",
				clientNodeId: authorization.client.nodeId,
				connectionId,
				close: (reason) => physicalOwner.close(reason),
			});
		} catch (error) {
			// Surface the underlying registration failure in the relay_closed audit
			// record; the client only ever sees the retryable pendingMessage.
			await relay.close("error", {
				pendingMessage: "conversation owner changed; retry",
				retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
				error: error instanceof Error ? error.message : String(error),
			});
			this.conversationCoordinators.releaseIfVacant(coordinator);
			return;
		}
		void relay.settled.finally(releaseRelayTransport);
		if (this.physicalStreamOwners.get(streamId) === physicalOwner) {
			this.physicalStreamOwners.delete(streamId);
		}
		if (!admission.isCurrent()) {
			await coordinator.closeTransport(relay.relayId, "host_shutdown");
			return;
		}

		if (!coordinator.registerRelayLease(relay.relayId)) {
			await coordinator.closeTransport(relay.relayId, "error");
			return;
		}
		// Coordinator, relay, and exact lease ownership are synchronously published;
		// the long-lived relay no longer holds attach-operation admission.
		admission.release();
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
			clientKind: "phone",
			relayId: relay.relayId,
			relayToken: relay.relayToken,
			workspaceName,
			sessionId: targetSessionId,
			clientNodeId: authorization.client.nodeId,
			connectionId,
			streamId,
		});
		if (!delivered) {
			// The TUI vanished between lease publication and offer delivery. The
			// coordinator closes the same offered owner the expiry path would close.
			void coordinator.closeTransport(relay.relayId, "error");
		}
		await relay.settled;
	}

	private async runIntegratedConversation(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		owner: IrohPhysicalStreamOwner,
	): Promise<void> {
		const admission = this.admission.tryAcquire();
		if (!admission) {
			await owner.close("host_shutdown").catch(() => {});
			return;
		}
		const admittedTask = this.runAdmittedIntegratedConversation(
			stream,
			handshake,
			connectionId,
			streamId,
			owner,
			admission,
		);
		try {
			await waitUntilAdmissionCancelled(admittedTask, admission.signal);
		} finally {
			admission.release();
		}
	}

	private async runAdmittedIntegratedConversation(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		owner: IrohPhysicalStreamOwner,
		admission: IrohDaemonAdmissionLease,
	): Promise<void> {
		const authorization = handshake.authorization;
		const targetSessionId = getResolvedTargetSessionId(handshake.hello, authorization);
		if (!admission.isCurrent()) {
			return;
		}
		// A session a TUI holds the lease of is served by that TUI until the TUI attaches to workers (slice 8).
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
				owner,
				handshake,
				connectionId,
				streamId,
				targetSessionId,
				daemonAttach.tuiConnectionId,
				admission,
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
		try {
			await this.relayToWorker(stream, owner, handshake, connectionId, streamId, admission);
		} finally {
			this.leaseBroker.abortDaemonAttach(daemonAttach.claim);
		}
	}

	/**
	 * What the host serving a relayed phone needs (`relay_preamble`): the
	 * phone's handshake, the daemon's authorization of it, the daemon's
	 * identity and relays, and the conversation target it resolved.
	 */
	private phonePreamble(
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		target: {
			sessionId: string;
			selection: "created" | "created_after_missing" | "resumed";
			requestedSessionId?: string;
			worktree: IrohRemoteWorkspaceWorktree | undefined;
			workingDirectory: string | undefined;
		},
	): Omit<PhoneRelayPreamble, "type" | "relayId"> {
		const authorization = handshake.authorization;
		const worktree = target.worktree;
		return {
			kind: "phone",
			handshake: {
				hello: handshake.hello,
				response: handshake.response,
				initialInput: Array.from(handshake.initialInput),
			},
			authorization: {
				clientNodeId: authorization.client.nodeId,
				allowedTools: normalizeIrohRemoteAllowTools(authorization.client.allowedTools),
				rpcGrant: authorization.client.rpcGrant,
				workspaceName: authorization.workspace.name,
				workspacePath: authorization.workspace.path,
				workspaceNames: [...authorization.workspaceNames],
				workspaces: authorization.workspaces.map((workspace) => ({ ...workspace })),
				...(worktree === undefined
					? {}
					: {
							worktreeId: worktree.id,
							worktreePath: worktree.path,
							...(worktree.sourceRootRelativePath === undefined
								? {}
								: { worktreeSourceRootRelativePath: worktree.sourceRootRelativePath }),
						}),
			},
			// The phone verifies the saved host's node id in the handshake response
			// its host writes; without this it fails the client's identity check.
			...(this.hostNodeId === undefined ? {} : { hostNodeId: this.hostNodeId }),
			relayMode: this.relayMode,
			...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
			connectionId,
			streamId,
			resolvedTarget: {
				sessionId: target.sessionId,
				selection: target.selection,
				...(target.requestedSessionId === undefined ? {} : { requestedSessionId: target.requestedSessionId }),
				workspaceName: authorization.workspace.name,
				workspacePath: authorization.workspace.path,
				...(worktree === undefined ? {} : { worktreeId: worktree.id }),
				...(target.workingDirectory === undefined ? {} : { workingDirectory: target.workingDirectory }),
			},
		};
	}

	/** The services a phone's conversation open draws on. */
	private get conversationOpenServices(): ConversationOpenServices {
		return {
			agentDir: this.services.agentDir,
			...(this.profile === undefined ? {} : { profile: this.profile }),
			toolPolicy: (authorization) =>
				resolveIrohRemoteRuntimeToolPolicy({
					clientAllowTools: authorization.allowTools,
					workspaceAllowTools: authorization.workspace.allowedTools,
					daemonAllowTools: this.services.state.state.settings.allowTools,
				}),
			projectTrusted: (workspace) =>
				resolveIrohRemoteWorkspaceProjectTrusted(workspace, { trustStore: this.trustStore }),
			resolveWorktree: (workspaceName, hello, targetSessionId) =>
				this.resolveConversationWorktree(workspaceName, hello, targetSessionId),
			resolveWorkingDirectory: (options) => this.resolveConversationWorkingDirectory(options),
			prepareWorktreeRuntime: (workspaceName, worktreeId, sessionId) =>
				this.worktrees.beginRuntimePreparation(workspaceName, worktreeId, sessionId),
			preparePrReviewSession: (authorization, hello, signal) =>
				this.prReviewCheckouts.prepareSession(authorization, hello, this.prReviewAuthority(authorization, signal)),
			bindWorktreeSession: (workspaceName, worktreeId, sessionId) =>
				this.worktrees.bindSession(workspaceName, worktreeId, sessionId),
		};
	}

	/**
	 * Relay a phone's conversation stream to the worker hosting its
	 * conversation (Phase 7 plan §1, "Open and attach"): the target resolves
	 * read-only, then the registry attaches the phone to the live worker
	 * hosting it, waits for the spawn or retirement under way, or spawns one
	 * with the phone's tool policy. The offer is minted in the turn the live
	 * worker is looked up in, to that worker only; it carries the daemon's
	 * authorization of the phone unchanged. A phone attaching to a worker
	 * another phone opened with tools beyond its own grant gets
	 * `conversation_in_use` (D9).
	 */
	private async relayToWorker(
		stream: IrohBiStreamLike,
		physicalOwner: IrohPhysicalStreamOwner,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		admission: IrohDaemonAdmissionLease,
	): Promise<void> {
		const authorization = handshake.authorization;
		const workspaceName = authorization.workspace.name;
		const workspaceGeneration = authorization.workspaceGeneration;
		const target = handshake.hello.mode === "conversation" ? handshake.hello.conversation.target : undefined;
		const failed = async (error: unknown): Promise<void> => {
			// The resolved target correlates a failed open in the audit log alone (#83 was undiagnosable without it).
			await this.logAudit({
				type: "runtime_failure",
				clientNodeId: authorization.client.nodeId,
				workspace: workspaceName,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				details: { runtime: "worker", ...(target === undefined ? {} : { target }) },
			});
			await this.sendHandshakeError(stream, error);
		};
		if (workspaceGeneration === undefined) {
			await failed(
				createConversationOpenError("workspace_unavailable", "workspace authority is unavailable; retry"),
			);
			return;
		}
		let resolved: ResolvedConversationOpen;
		try {
			resolved = await resolveConversationOpen(
				handshake.hello,
				authorization,
				this.conversationOpenServices,
				admission.signal,
			);
		} catch (error) {
			await failed(error);
			return;
		}
		const sessionId = resolved.sessionId;
		// One relay per phone and conversation on a connection; one on an older connection is replaced.
		const relaysOf = () => [
			...this.relays.forConversation(authorization.client.nodeId, workspaceName, sessionId, "active"),
			...this.relays.forConversation(authorization.client.nodeId, workspaceName, sessionId, "offered"),
		];
		if (relaysOf().some((relay) => relay.connectionId === connectionId)) {
			await this.rejectDuplicateActiveConnection(stream, authorization, sessionId, "relay_registry");
			return;
		}
		for (const relay of relaysOf()) void relay.close("error", { pendingMessage: "conversation reopened; retry" });
		try {
			// A fresh pairing replaces the phone-opened worker serving the conversation, as it replaced a daemon
			// runtime; a TUI's worker keeps serving its TUI (the phone uses its tools, D9, or is refused).
			if (
				authorization.paired &&
				target !== "new" &&
				this.workers.host(workspaceName, sessionId)?.origin === "phone"
			) {
				await this.workers.retireHost(workspaceName, sessionId, "authority");
			}
			await this.dependencies.beforeAuthorizedStreamPublication?.("conversation", authorization);
			if (!(await this.isAuthorizationCurrent(authorization))) {
				throw new Error("client or workspace authority changed during conversation attach; reconnect");
			}
		} catch (error) {
			await failed(error);
			return;
		}
		if (!admission.isCurrent()) return;
		let opened: { relay: RelayLifecycleOwner; workerId: string; kind: string };
		try {
			opened = await this.workers.open(
				{ workspaceName, workspaceGeneration, sessionId },
				{
					origin: "phone",
					signal: admission.signal,
					prepare: () => resolved.prepare(workspaceGeneration, admission.signal),
					attach: (worker) => {
						// Everything the awaits above could have changed is checked again in this turn.
						if (!admission.isCurrent()) throw new Error("daemon admission closed");
						if (getIrohRemoteAuthorizationLoss(this.services.state.getHostState(), authorization) !== undefined) {
							throw new Error("client or workspace authority changed during conversation attach; reconnect");
						}
						const lease = this.leaseBroker.lookup(workspaceName, sessionId);
						if (lease?.state === "tui-owned" || lease?.state === "daemon-draining") {
							throw createConversationOpenError(
								"duplicate_conversation_connection",
								"conversation owner changed; retry",
								{
									workspace: workspaceName,
									sessionId,
									retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
								},
							);
						}
						// A TUI-opened worker keeps its own tools for every client (#50).
						if (
							worker.spec.origin === "phone" &&
							!isIrohRemoteRuntimeToolPolicyWithin(worker.spec.toolPolicy, resolved.toolPolicy)
						) {
							throw createConversationOpenError(
								"conversation_in_use",
								"conversation is using tools outside this client's persisted grant",
								{ workspace: workspaceName, sessionId },
							);
						}
						if (!this.workerSpawners.has(worker.workerId)) {
							this.workerSpawners.set(worker.workerId, authorization.client.nodeId);
							if (resolved.worktree !== undefined) {
								this.workerWorktrees.set(worker.workerId, { workspaceName, worktreeId: resolved.worktree.id });
							}
						}
						const relay = this.mintWorkerRelay(worker, {
							stream,
							physicalOwner,
							handshake,
							connectionId,
							streamId,
							resolved,
						});
						return {
							relay,
							workerId: worker.workerId,
							kind: this.workers.host(workspaceName, sessionId)?.kind ?? "primary",
						};
					},
				},
			);
		} catch (error) {
			if (admission.isCurrent()) await failed(error);
			return;
		}
		const relay = opened.relay;
		if (
			!physicalOwner.installCloseAction((reason) =>
				relay
					.close(normalizeRelayCloseReason(reason), {
						pendingMessage: relayPendingMessageForReason(reason),
						...(reason === "workspace_unregistered" || reason === "host_shutdown"
							? {}
							: { retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS }),
					})
					.then(() => undefined),
			)
		) {
			await relay.close("host_shutdown", { pendingMessage: relayPendingMessageForReason("host_shutdown") });
			return;
		}
		if (this.physicalStreamOwners.get(streamId) === physicalOwner) {
			this.physicalStreamOwners.delete(streamId);
		}
		// The relay, its worker attachment, and its offer are published; the stream no longer holds attach admission.
		admission.release();
		// A subagent's child is not the phone's last session.
		if (opened.kind !== "child") {
			await this.requireEngine()
				.setClientLastSessionId(authorization.client.nodeId, workspaceName, sessionId)
				.catch(() => undefined);
		}
		await this.logSessionSelection(resolved.selection, authorization);
		void this.logAudit({
			type: "relay_opened",
			clientNodeId: authorization.client.nodeId,
			workspace: workspaceName,
			success: true,
			details: {
				relayId: relay.relayId,
				workerId: opened.workerId,
				workspaceName,
				sessionId,
				connectionId,
				streamId,
			},
		});
		await relay.settled;
	}

	/**
	 * Mint the relay offer of a phone to a live worker and send it there; the
	 * worker counts as attached while the relay is offered or open. Runs in
	 * the turn the registry looked the worker up in.
	 */
	private mintWorkerRelay(
		worker: LiveWorker,
		options: {
			stream: IrohBiStreamLike;
			physicalOwner: IrohPhysicalStreamOwner;
			handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>;
			connectionId: string;
			streamId: string;
			resolved: ResolvedConversationOpen;
		},
	): RelayLifecycleOwner {
		const { handshake, connectionId, streamId, resolved } = options;
		const authorization = handshake.authorization;
		const workspaceName = authorization.workspace.name;
		const relayPhysicalStream = options.physicalOwner.physicalStream ?? options.stream;
		const release = worker.attach("remote");
		let relay: RelayLifecycleOwner;
		try {
			relay = this.relays.mint({
				workspaceName,
				sessionId: resolved.sessionId,
				clientNodeId: authorization.client.nodeId,
				connectionId,
				ownerControlConnectionId: worker.connectionId,
				streamId,
				stream: relayPhysicalStream,
				observePhysicalTask: (task) => this.trackNativeLifecycleTask(task),
				preamble: this.phonePreamble(handshake, connectionId, streamId, {
					sessionId: resolved.sessionId,
					selection: resolved.selection.kind,
					...(resolved.selection.kind === "created"
						? {}
						: { requestedSessionId: resolved.selection.requestedSessionId }),
					worktree: resolved.worktree,
					workingDirectory: resolved.workingDirectory,
				}),
				rejectPending: ({ message, retryAfterMs }) =>
					this.sendHandshakeError(relayPhysicalStream, {
						message,
						...(retryAfterMs === undefined ? {} : { retryAfterMs }),
					}),
				onSettled: async (outcome) => {
					release();
					this.workerRelays.delete(relay.relayId);
					this.syncWorkerLease(workspaceName, resolved.sessionId);
					this.services.controlServer.sendTo(worker.connectionId, {
						type: "relay_closed",
						relayId: relay.relayId,
						reason: outcome.reason,
					});
					await this.logAudit({
						type: "relay_closed",
						clientNodeId: authorization.client.nodeId,
						workspace: workspaceName,
						success: outcome.error === undefined,
						error: outcome.error,
						details: {
							relayId: relay.relayId,
							workerId: worker.workerId,
							reason: outcome.reason,
							bytesUp: outcome.bytesUp,
							bytesDown: outcome.bytesDown,
							durationMs: outcome.durationMs,
						},
					});
				},
			});
		} catch (error) {
			release();
			throw error;
		}
		this.workerRelays.set(relay.relayId, { relay, authorization, workerId: worker.workerId });
		const clients = this.workerClients.get(worker.workerId) ?? new Set<string>();
		clients.add(authorization.client.nodeId);
		this.workerClients.set(worker.workerId, clients);
		this.syncWorkerLease(workspaceName, resolved.sessionId);
		const delivered = this.services.controlServer.sendTo(worker.connectionId, {
			type: "relay_offer",
			clientKind: "phone",
			relayId: relay.relayId,
			relayToken: relay.relayToken,
			workspaceName,
			sessionId: resolved.sessionId,
			clientNodeId: authorization.client.nodeId,
			connectionId,
			streamId,
		});
		// The worker's connection closed meanwhile: the offer closes as an expired one does.
		if (!delivered) void relay.close("error", { retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS });
		return relay;
	}

	/** Keep the lease broker's view of a session a worker hosts current: hosted, and with how many relays (offered or open). */
	private syncWorkerLease(workspaceName: string, sessionId: string): void {
		const streams = [...this.workerRelays.values()].filter(
			(entry) =>
				entry.relay.workspaceName === workspaceName &&
				entry.relay.sessionId === sessionId &&
				entry.relay.phase !== "closed",
		).length;
		this.leaseBroker.syncWorkerHosting(
			workspaceName,
			sessionId,
			this.workers.hosts(workspaceName, sessionId),
			streams,
		);
	}

	/** Close the relays to workers `select` picks with `reason`; resolves how many closed. */
	private async closeWorkerRelays(select: (entry: WorkerRelay) => boolean, reason: RelayCloseReason): Promise<number> {
		const selected = [...this.workerRelays.values()].filter(select);
		await Promise.allSettled(
			selected.map((entry) =>
				entry.relay.close(reason, {
					pendingMessage: relayPendingMessageForReason(reason),
					...(reason === "workspace_unregistered" || reason === "host_shutdown"
						? {}
						: { retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS }),
				}),
			),
		);
		return selected.length;
	}

	/**
	 * A relayed phone lost its authority (D4): its worker ends the stream with
	 * `fatal{loss}` as its last frame, and the daemon closes the relay itself
	 * when the worker has not within 2 s. An offer not yet redeemed closes now.
	 */
	private endWorkerRelay(relayId: string, loss: AuthorityLoss): void {
		const entry = this.workerRelays.get(relayId);
		if (!entry) return;
		const reason: RelayCloseReason = loss === "workspace_unregistered" ? "workspace_unregistered" : "error";
		if (entry.relay.phase !== "active") {
			void entry.relay.close(reason, { pendingMessage: "client access changed; reconnect" });
			return;
		}
		const connectionId = this.workers.connectionOf(entry.workerId);
		if (connectionId !== undefined) {
			this.services.controlServer.sendTo(connectionId, { type: "relay_authority", relayId, loss });
		}
		const timer = setTimeout(() => void entry.relay.close(reason), WORKER_RELAY_AUTHORITY_CLOSE_MS);
		timer.unref?.();
		void entry.relay.settled.finally(() => clearTimeout(timer));
	}

	/** Retire the workers `clientNodeId` opened, or that serve it, without the option to refuse; resolves once they exited. */
	private async retireClientWorkers(clientNodeId: string, workspaceName?: string): Promise<number> {
		const workerIds = new Set<string>();
		for (const [workerId, spawner] of this.workerSpawners) if (spawner === clientNodeId) workerIds.add(workerId);
		// Every worker that served the client, whether or not its relay is still open: a turn it started may still run.
		for (const [workerId, clients] of this.workerClients) if (clients.has(clientNodeId)) workerIds.add(workerId);
		const retired = [...workerIds].filter(
			(workerId) => workspaceName === undefined || this.workers.keyOf(workerId)?.workspaceName === workspaceName,
		);
		await Promise.allSettled(retired.map((workerId) => this.workers.retireWorker(workerId, "authority")));
		return retired.length;
	}

	private async logSessionSelection(
		selection: IntegratedConversationSessionSelection,
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<void> {
		const common = { clientNodeId: authorization.client.nodeId, workspace: authorization.workspace.name };
		if (selection.kind === "resumed") {
			await this.logAudit({
				...common,
				type: "session_resumed",
				success: true,
				details: { requestedSessionId: selection.requestedSessionId, sessionId: selection.sessionId },
			});
			return;
		}
		if (selection.kind === "created_after_missing") {
			await this.logAudit({
				...common,
				type: "session_missing_on_resume",
				success: false,
				error: "session not found",
				details: { requestedSessionId: selection.requestedSessionId },
			});
			await this.logAudit({
				...common,
				type: "session_created",
				success: true,
				details: { reason: "missing_on_resume", sessionId: selection.sessionId },
			});
			return;
		}
		await this.logAudit({
			...common,
			type: "session_created",
			success: true,
			details: { reason: "new_client_connection", sessionId: selection.sessionId },
		});
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

	/** Make every TUI relay of `nodeId`, active or offered, unusable now. */
	private closeClientRelays(nodeId: string): void {
		for (const relay of [...this.relays.all("active"), ...this.relays.all("offered")]) {
			if (relay.clientNodeId !== nodeId) continue;
			void this.conversationCoordinators
				.get(relay.workspaceName, relay.sessionId)
				?.closeTransport(relay.relayId, "error");
		}
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
		await this.initiateActiveStreamRetirement(new Set(this.activeStreams.entriesForConnection(connectionId)), reason);
	}

	private initiateActiveStreamRetirement(
		entries: ReadonlySet<IrohRemoteActiveStreamEntry>,
		reason: string,
	): Promise<void> {
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
		}
		this.requestCloseWhenIdleForEntries(Array.from(entries), reason);
		return Promise.allSettled(Array.from(entries, (entry) => entry.close(reason))).then(() => undefined);
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
		await this.initiateActiveStreamRetirement(new Set(entries), reason);
		return entries.length;
	}

	/** Close the relays to TUIs of a workspace, except the requesting ones. */
	private closeRelaysForWorkspace(workspaceName: string, excludeRelayIds?: ReadonlySet<string>): void {
		for (const relay of this.relays.all()) {
			if (relay.workspaceName === workspaceName && !excludeRelayIds?.has(relay.relayId)) {
				void this.conversationCoordinators
					.get(relay.workspaceName, relay.sessionId)
					?.closeTransport(relay.relayId, "workspace_unregistered");
			}
		}
	}

	/**
	 * Post-unregister host cleanup shared by the control, workspace-management,
	 * and conversation unregister paths: phone streams close, the relays to
	 * workers end with `fatal{workspace_unregistered}`, the workspace's workers
	 * retire, and the relays to TUIs close. The requesting stream or relays
	 * stay until the unregister is answered: a requesting relay's worker
	 * retires once that relay ended (at most the final-frame timeout later).
	 * Resolves once the workers exited.
	 */
	private async cleanupUnregisteredWorkspace(
		workspaceName: string,
		exclusions: {
			streamEntry?: IrohRemoteActiveStreamEntry;
			relayIds?: ReadonlySet<string>;
			/** Enables a non-destructive audit of preserved checkout directories. */
			workspacePath?: string;
		} = {},
	): Promise<{ closedStreamCount: number; stoppedRuntimeCount: number }> {
		const changeRetirement = this.retireTuiChangeWorkspace(workspaceName);
		const closedStreamCount = await this.closeActiveStreamsForWorkspace(
			workspaceName,
			WORKSPACE_UNREGISTERED_CLOSE_REASON,
			exclusions.streamEntry,
		);
		const kept: Promise<unknown>[] = [];
		for (const [relayId, entry] of this.workerRelays) {
			if (entry.relay.workspaceName !== workspaceName) continue;
			if (exclusions.relayIds?.has(relayId)) {
				kept.push(entry.relay.settled);
				continue;
			}
			this.endWorkerRelay(relayId, "workspace_unregistered");
		}
		const workerIds = this.workers.workersOf(workspaceName);
		this.closeRelaysForWorkspace(workspaceName, exclusions.relayIds);
		if (kept.length === 0) {
			await this.workers.fenceWorkspace(workspaceName, { all: true, reason: "authority" });
		} else {
			// The requesting relay is answered first (its answer waits for this
			// call); then the workers the unregister found retire, and only those:
			// a registration of the same name meanwhile keeps its own.
			void (async () => {
				await Promise.race([
					Promise.allSettled(kept),
					new Promise((resolve) => setTimeout(resolve, STREAM_FINAL_FRAME_TIMEOUT_MS).unref()),
				]);
				await Promise.allSettled(workerIds.map((workerId) => this.workers.retireWorker(workerId, "authority")));
			})();
		}
		if (exclusions.workspacePath !== undefined) {
			await this.worktrees
				.cleanupUnregisteredWorkspace({ name: workspaceName, path: exclusions.workspacePath })
				.catch(() => {});
		}
		await changeRetirement;
		return { closedStreamCount, stoppedRuntimeCount: workerIds.length };
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
		await this.initiateActiveStreamRetirement(new Set(entries), reason);
		return entries.length;
	}

	/**
	 * A device's access changed: its streams and relays end with
	 * `fatal{revoked}`, and the workers it opened or is served by retire
	 * (D4). Resolves once they exited.
	 */
	private async closeClientForAccessUpdate(nodeId: string): Promise<void> {
		const entries = new Set(this.activeStreams.entriesForClientNodeId(nodeId));
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
		}
		// Invalidate transport and relay authority synchronously. Terminal writes
		// below are best-effort and must never keep old commands or buffered prompts
		// alive behind backpressure.
		this.closeClientConnectionsForClient(nodeId, "access_updated");
		for (const relay of this.relays.all().filter((candidate) => candidate.clientNodeId === nodeId)) {
			void this.conversationCoordinators
				.get(relay.workspaceName, relay.sessionId)
				?.closeTransport(relay.relayId, "error");
		}
		for (const [relayId, entry] of this.workerRelays) {
			if (entry.relay.clientNodeId === nodeId) this.endWorkerRelay(relayId, "revoked");
		}
		await this.initiateActiveStreamRetirement(entries, "access_updated");
		await this.retireClientWorkers(nodeId);
	}

	private async closeWorkspaceAuthorizationRemovedStreams(nodeId: string, workspaceName: string): Promise<void> {
		const reason = "workspace_authorization_removed";
		const relayClosures = this.relays
			.all()
			.filter((relay) => relay.clientNodeId === nodeId && relay.workspaceName === workspaceName)
			.map(
				(relay) =>
					this.conversationCoordinators
						.get(relay.workspaceName, relay.sessionId)
						?.closeTransport(relay.relayId, reason) ?? Promise.resolve(false),
			);
		let closedStreamCount = 0;
		for (const [relayId, entry] of this.workerRelays) {
			if (entry.relay.clientNodeId !== nodeId || entry.relay.workspaceName !== workspaceName) continue;
			this.endWorkerRelay(relayId, "revoked");
			closedStreamCount++;
		}
		const relayResults = await Promise.allSettled(relayClosures);
		closedStreamCount += relayResults.filter(
			(result): result is PromiseFulfilledResult<true> => result.status === "fulfilled" && result.value,
		).length;
		closedStreamCount += await this.closeActiveStreamsForClientWorkspace(nodeId, workspaceName, reason);
		const stoppedRuntimeCount = await this.retireClientWorkers(nodeId, workspaceName);
		await this.logAudit({
			type: "workspace_authorization_removed",
			clientNodeId: nodeId,
			workspace: workspaceName,
			success: closedStreamCount > 0 || stoppedRuntimeCount > 0,
			details: {
				closedStreamCount,
				source: "authorization_failure",
				stoppedRuntimeCount,
			},
		});
	}

	/**
	 * A device was revoked: its connections close, its streams and relays end
	 * with `fatal{revoked}`, and the workers it opened or is served by retire.
	 */
	async closeActiveStreamsForClient(nodeId: string): Promise<{ closed: boolean; closedCount: number }> {
		const entries = new Set(this.activeStreams.entriesForClientNodeId(nodeId));
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
		}

		// Match access-update ordering: synchronously make active and unredeemed relays
		// unusable before any terminal write, worker retirement, or control ack.
		const activeRelays = this.relays.all("active").filter((relay) => relay.clientNodeId === nodeId);
		const pendingRelays = this.relays.all("offered").filter((relay) => relay.clientNodeId === nodeId);
		for (const relay of [...activeRelays, ...pendingRelays]) {
			if (this.workerRelays.has(relay.relayId)) {
				this.endWorkerRelay(relay.relayId, "revoked");
				continue;
			}
			void this.conversationCoordinators
				.get(relay.workspaceName, relay.sessionId)
				?.closeTransport(relay.relayId, "error");
		}

		const closedConnectionCount = this.closeClientConnectionsForClient(nodeId, ACTIVE_REVOKE_CLOSE_REASON);
		await this.initiateActiveStreamRetirement(entries, ACTIVE_REVOKE_CLOSE_REASON);
		const stoppedRuntimeCount = await this.retireClientWorkers(nodeId);
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
		if (this.relayCredentialIsRevoking || this.managedRelayCredentialRevocation !== undefined) {
			connection.send({
				type: "error",
				id: request.id,
				code: "relay_credential_revocation_pending",
				message: "Relay credential reset is pending. Retry the reset before pairing.",
			});
			return;
		}
		const expectedEpoch = this.relayCredentialEpoch;
		try {
			await withTimeout(
				this.ready.promise,
				IROH_ENDPOINT_READY_TIMEOUT_MS,
				"Iroh endpoint did not become ready within 15s",
			);
		} catch {
			connection.send({
				type: "error",
				id: request.id,
				code: "iroh_unavailable",
				message:
					this.remoteTransport.message ??
					"Phone transport is still starting. Run `volt daemon status`, then retry.",
			});
			return;
		}
		const engine = this.requireEngine();
		const endpoint = this.endpoint;
		if (!endpoint || !this.endpointTicket || !isRemoteTransportPairingAvailable(this.remoteTransport)) {
			connection.send({
				type: "error",
				id: request.id,
				code: "iroh_unavailable",
				message: this.remoteTransport.message ?? "Phone transport is not ready. Run `volt daemon status`.",
			});
			return;
		}
		const workspaceName =
			typeof (request as Record<string, unknown>).workspaceName === "string"
				? ((request as Record<string, unknown>).workspaceName as string)
				: undefined;
		const requestId = randomUUID();
		let relayCredentialClaim: IrohManagedRelayCredentialClaim | undefined;
		let pairingPublished = false;
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
			relayCredentialClaim = await this.createManagedRelayCredentialClaim();
			if (this.relayCredentialIsRevoking || expectedEpoch !== this.relayCredentialEpoch) {
				throw new Error("Relay credential reset cancelled pairing. Retry pairing after the reset completes.");
			}
			const pairing = await engine.pair({
				allowTools: access.allowedTools,
				...(relayCredentialClaim?.expiresAt === undefined
					? {}
					: {
							expiresAt: Math.min(
								relayCredentialClaim.expiresAt,
								Date.now() + DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS,
							),
						}),
				rpcGrant: access.rpcGrant,
				irohTicket: this.endpointTicket,
				nodeId: this.hostNodeId,
				relayMode: this.relayMode,
				...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
				...(relayCredentialClaim?.claimId === undefined
					? {}
					: {
							relayCredentialClaim: {
								claimId: relayCredentialClaim.claimId,
								serviceUrl: relayCredentialClaim.serviceUrl,
							},
						}),
				...(this.relayMode === "production" &&
				this.managedRelayCredential === undefined &&
				this.relayAuthToken !== undefined
					? { relayAuthToken: this.relayAuthToken }
					: {}),
				...(workspaceName === undefined ? {} : { workspace: workspaceName }),
			});
			if (this.relayCredentialIsRevoking || expectedEpoch !== this.relayCredentialEpoch) {
				await engine.cancelPairingSecretByHash(hashIrohRemotePairingSecret(pairing.secret));
				throw new Error("Relay credential reset cancelled pairing. Retry pairing after the reset completes.");
			}
			this.clearStorageCapacityDegradation();
			connection.send({ type: "pair_started", id: request.id, requestId });
			connection.send({
				type: "pairing_progress",
				requestId,
				phase: "ticket",
				ticket: pairing.ticket,
			});
			pairingPublished = true;
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
				...(relayCredentialClaim === undefined ? {} : { relayCredentialClaim }),
			});
		} catch (error) {
			if (relayCredentialClaim !== undefined && !pairingPublished) {
				await this.discardManagedRelayCredentialClaim(relayCredentialClaim).catch(() => {});
			}
			const storageFull = isIrohRemoteHostStorageFullError(error);
			if (storageFull) this.markStorageCapacityUnavailable();
			connection.send({
				type: "error",
				id: request.id,
				code: storageFull ? "iroh_unavailable" : "pair_failed",
				message: storageFull
					? REMOTE_TRANSPORT_REASON_MESSAGES.host_storage_full
					: error instanceof Error
						? error.message
						: String(error),
			});
		}
	}

	// ==========================================================================
	// Control plane integration
	// ==========================================================================

	async handleRequest(connection: ControlConnection, request: ControlRequest): Promise<boolean> {
		// Without the binding nothing pairs or reaches a relay: refused with the guidance status shows.
		if (this.iroh === undefined && (request.type === "pair_request" || request.type === "relay_credential_check")) {
			connection.send({
				type: "error",
				id: request.id,
				code: "iroh_unavailable",
				message: this.remoteTransport.message ?? REMOTE_TRANSPORT_REASON_MESSAGES.native_binding_missing,
			});
			return true;
		}
		switch (request.type) {
			case "change_observe": {
				await this.handleChangeObservation(connection, request);
				return true;
			}
			case "worker_forward":
			case "worker_notification_delivery":
			case "worker_moved":
			case "worker_last_session":
			case "worker_authority":
			case "worker_worktree_restore":
			case "worker_worktree_release":
				await this.handleWorkerRequest(connection, request);
				return true;
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
					request.reason,
				);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: "lease not held" });
					return true;
				}
				await this.retireTuiChangeAuthority(request.workspaceName, request.sessionId, connection.connectionId);
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
				connection.send({ type: "relay_rpc_result", id: request.id, frame: result.frame });
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
			case "relay_credential_revoke": {
				try {
					await this.startupTask;
					await this.revokeManagedRelayCredential();
					connection.send({ type: "ok", id: request.id });
				} catch (error) {
					connection.send({
						type: "error",
						id: request.id,
						code: "relay_credential_revoke_failed",
						message: error instanceof Error ? error.message : String(error),
					});
				}
				return true;
			}
			case "relay_credential_check": {
				try {
					await this.startupTask;
					const result = await this.checkManagedRelayCredential();
					connection.send(
						result.ok
							? { type: "ok", id: request.id }
							: { type: "error", id: request.id, code: result.code, message: result.message },
					);
				} catch (error) {
					connection.send({
						type: "error",
						id: request.id,
						code: "relay_credential_check_failed",
						message: error instanceof Error ? error.message : String(error),
					});
				}
				return true;
			}
			case "client_access_update": {
				// A TUI serves a relayed device on the grant it was relayed with: end those relays before the change.
				this.closeClientRelays(request.clientNodeId);
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
								? {
										revision: updated.client.rpcGrant.revision,
										allowedTools: normalizeIrohRemoteAllowTools(updated.client.allowedTools),
										usesDefaultTools: updated.client.allowedTools === undefined,
									}
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
					client: createControlClientStatus(updated.client),
				});
				return true;
			}
			case "client_revoke": {
				// Without the binding there is no engine to wait for: the revocation is the state change and its audit.
				const result = this.iroh === undefined ? undefined : await this.requireEngineSafe();
				if (result !== undefined && !result.ok) {
					connection.send({ type: "error", id: request.id, code: "iroh_unavailable", message: result.error });
					return true;
				}
				if ((await this.stateManager.getClient(request.clientNodeId)) === undefined) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "client not found" });
					return true;
				}
				// A TUI serves a relayed device on the grant it was relayed with: end those relays before the change.
				this.closeClientRelays(request.clientNodeId);
				const relayAppEndpoint = await this.stageManagedRelayAppEndpointRevocation(request.clientNodeId);
				const revocation =
					result === undefined
						? await this.stateManager.revokeClient(request.clientNodeId)
						: await result.engine.revokeClient(request.clientNodeId);
				if (result === undefined) {
					await this.logAudit({
						type: "client_revoked",
						clientNodeId: request.clientNodeId,
						success: revocation.revoked,
						...(revocation.revoked ? {} : { error: "client not found" }),
					});
				}
				if (!revocation.revoked) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "client not found" });
					return true;
				}
				await this.closeActiveStreamsForClient(request.clientNodeId);
				await this.revokeClientPushTargets(revocation.client);
				if (relayAppEndpoint !== undefined) {
					await this.completeManagedRelayAppEndpointRevocation(relayAppEndpoint).catch((error: unknown) => {
						this.log("warn", "managed relay app endpoint revocation deferred", {
							error: error instanceof Error ? error.message : String(error),
						});
					});
				}
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
						bindWorktreeSession: async (workspaceName, worktreeId, sessionId, acquireLease) => {
							let acquired = !acquireLease;
							const leaseDenied = new Error("worktree lease acquisition denied");
							try {
								await this.worktrees.bindSession(
									workspaceName,
									worktreeId,
									sessionId,
									acquireLease
										? async () => {
												const outcome = await this.leaseBroker.acquireForTui({
													connectionId: connection.connectionId,
													workspaceName,
													sessionId,
												});
												if (outcome.kind === "denied") throw leaseDenied;
												acquired = true;
											}
										: undefined,
								);
							} catch (error) {
								if (error === leaseDenied) return false;
								throw error;
							}
							return acquired;
						},
						removeWorktree: (workspace, worktreeId, force) =>
							this.removeWorkspaceWorktree(workspace, worktreeId, force),
					});
					return true;
				}
				return false;
		}
	}

	/** The device `scope` names, as the daemon's state holds it now, authorized for its workspace. */
	private async currentRelayAuthorization(scope: {
		readonly clientNodeId: string;
		readonly workspaceName: string;
		readonly workspaceNames: readonly string[];
		readonly workspaces: IrohRemoteClientAuthorizationSuccess["workspaces"];
	}): Promise<
		{ ok: true; authorization: IrohRemoteClientAuthorizationSuccess } | { ok: false; code: string; message: string }
	> {
		const client = await this.stateManager.getClient(scope.clientNodeId);
		if (!client) {
			return { ok: false, code: "not_found", message: "paired client not found" };
		}
		if (!isIrohRemoteClientAllowedForWorkspace(client, scope.workspaceName)) {
			return { ok: false, code: "not_allowed", message: "client is not authorized for the relay workspace" };
		}
		const workspace = (await this.stateManager.getState()).workspaces.find(
			(candidate) => candidate.name === scope.workspaceName,
		);
		if (!workspace) {
			return { ok: false, code: "not_found", message: `no registered workspace named ${scope.workspaceName}` };
		}
		return {
			ok: true,
			authorization: {
				ok: true,
				allowTools: normalizeIrohRemoteAllowTools(client.allowedTools),
				client,
				paired: true,
				pairingSecretConsumed: false,
				workspace,
				workspaceNames: [...scope.workspaceNames],
				workspaces: scope.workspaces.map((entry) => ({ ...entry })),
			},
		};
	}

	/** A relayed phone's completion push, scoped to the relay's session and workspace. */
	private async deliverRelayNotification(
		scope: { clientNodeId: string; workspaceName: string; sessionId: string },
		notification: IrohRemotePushNotificationIntent,
	): Promise<RelayPushDeliveryResult> {
		if (notification.sessionId !== undefined && notification.sessionId !== scope.sessionId) {
			return { ok: false, code: "session_mismatch", message: "notification session does not match relay session" };
		}
		if (notification.workspaceName !== undefined && notification.workspaceName !== scope.workspaceName) {
			return {
				ok: false,
				code: "workspace_mismatch",
				message: "notification workspace does not match relay workspace",
			};
		}
		const authorization = await this.currentRelayAuthorization({
			...scope,
			workspaceNames: [scope.workspaceName],
			workspaces: [{ name: scope.workspaceName, status: "available" }],
		});
		if (!authorization.ok) {
			return authorization;
		}
		const scopedNotification: IrohRemotePushNotificationIntent = {
			...notification,
			sessionId: notification.sessionId ?? scope.sessionId,
			workspaceName: notification.workspaceName ?? scope.workspaceName,
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

	private async handleRelayNotificationDelivery(
		connection: ControlConnection,
		request: Extract<ControlRequest, { type: "relay_notification_delivery" }>,
	): Promise<RelayPushDeliveryResult> {
		const lease = this.leaseBroker.lookup(request.workspaceName, request.sessionId);
		if (!lease || lease.state !== "tui-owned" || lease.tuiConnectionId !== connection.connectionId) {
			return {
				ok: false,
				code: "not_held",
				message: "relay lease is not held by this control connection",
			};
		}
		return this.deliverRelayNotification(request, request.notification);
	}

	/**
	 * Run a relayed phone's intent or query that the daemon's state backs
	 * (§5.6): push targets, workspace registration and worktrees, keep-awake,
	 * the web search key, and the session list. The host serving the phone
	 * forwards the frame; the daemon admits it on the phone's remote profile
	 * with the grant it holds now and answers with the outcome frame. An
	 * unregister keeps the relays in `keep`, so their host can still answer.
	 */
	private async runRelayFrame(
		relay: RelayLifecycleOwner,
		frame: ControlRelayFrame,
		keep: ReadonlySet<string>,
	): Promise<{ ok: true; frame: ControlRelayOutcome } | { ok: false; code: string; message: string }> {
		// The daemon's own relays are phones'; a TUI's local relays forward nothing.
		if (relay.preamble.kind !== "phone") return { ok: false, code: "not_found", message: "not a phone's relay" };
		const metadata = relay.preamble.authorization;
		const current = await this.currentRelayAuthorization({
			clientNodeId: relay.clientNodeId,
			workspaceName: relay.workspaceName,
			workspaceNames: metadata.workspaceNames,
			workspaces: metadata.workspaces,
		});
		if (!current.ok) {
			return current;
		}
		const authorization = current.authorization;
		const ctx: IntentContext = {
			services: remoteIntentServices(
				this.remoteIntentHost,
				authorization,
				{ kind: "relay", sessionId: relay.sessionId },
				{ keep: { relayIds: keep } },
			),
			profile: { name: "remote", grant: parseIrohRemoteRpcGrant(authorization.client.rpcGrant, "client rpcGrant") },
		};
		if (frame.type === "query") {
			try {
				const data = await queryRegistry.runFrame(ctx, frame.query, frame.params);
				return { ok: true, frame: { type: "result", queryId: frame.queryId, data } };
			} catch (error) {
				return {
					ok: true,
					frame: { type: "query_error", queryId: frame.queryId, reason: queryErrorReason(error) },
				};
			}
		}
		try {
			const invocation = await intentRegistry.invokeFrame(ctx, frame.type, frame.input);
			return {
				ok: true,
				frame: {
					type: "accepted",
					intentId: frame.intentId,
					ordinals: invocation.ordinals,
					...(invocation.result === undefined ? {} : { result: invocation.result }),
				},
			};
		} catch (error) {
			return { ok: true, frame: { type: "rejected", intentId: frame.intentId, reason: rejectionReason(error) } };
		}
	}

	private async handleRelayRpc(
		connection: ControlConnection,
		request: Extract<ControlRequest, { type: "relay_rpc" }>,
	): Promise<{ ok: true; frame: ControlRelayOutcome } | { ok: false; code: string; message: string }> {
		const relayAuthorization = this.relays.authorizeRpc(request.relayId, connection.connectionId, request);
		if (!relayAuthorization.ok) {
			return relayAuthorization;
		}
		// An unregister keeps the requesting conversation's relays, so the TUI can still answer the phone.
		const relayIds = new Set(
			this.relays
				.forConversation(request.clientNodeId, request.workspaceName, request.sessionId, "active")
				.map((relay) => relay.relayId),
		);
		return this.runRelayFrame(relayAuthorization.relay, request.frame, relayIds);
	}

	/**
	 * The relay a worker's request names: one of its own, open. Every worker
	 * service acts only on the worker's own relays (D3).
	 */
	private workerRelayOf(
		connection: ControlConnection,
		relayId: string,
	): { ok: true; entry: WorkerRelay } | { ok: false; code: string; message: string } {
		const workerId = this.workers.workerOf(connection.connectionId);
		const entry = this.workerRelays.get(relayId);
		if (workerId === undefined || entry === undefined || entry.workerId !== workerId) {
			return { ok: false, code: "not_found", message: "the worker has no such relay" };
		}
		if (entry.relay.phase !== "active") {
			return { ok: false, code: "not_found", message: "the relay is not open" };
		}
		return { ok: true, entry };
	}

	/** The worker role's daemon services (daemon RFC §5.4, D3, D4). */
	private async handleWorkerRequest(
		connection: ControlConnection,
		request: Extract<
			ControlRequest,
			{
				type:
					| "worker_forward"
					| "worker_notification_delivery"
					| "worker_moved"
					| "worker_last_session"
					| "worker_authority"
					| "worker_worktree_restore"
					| "worker_worktree_release";
			}
		>,
	): Promise<void> {
		const refuse = (code: string, message: string) =>
			connection.send({ type: "error", id: request.id, code, message });
		switch (request.type) {
			case "worker_forward": {
				const relay = this.workerRelayOf(connection, request.relayId);
				if (!relay.ok) return refuse(relay.code, relay.message);
				if (getIrohRemoteAuthorizationLoss(this.services.state.getHostState(), relay.entry.authorization)) {
					return refuse("revoked", "the relay's authority changed");
				}
				const result = await this.runRelayFrame(relay.entry.relay, request.frame, new Set([request.relayId]));
				if (!result.ok) return refuse(result.code, result.message);
				connection.send({ type: "worker_forward_result", id: request.id, frame: result.frame });
				return;
			}
			case "worker_notification_delivery": {
				const relay = this.workerRelayOf(connection, request.relayId);
				if (!relay.ok) return refuse(relay.code, relay.message);
				if (getIrohRemoteAuthorizationLoss(this.services.state.getHostState(), relay.entry.authorization)) {
					return refuse("revoked", "the relay's authority changed");
				}
				const result = await this.deliverRelayNotification(relay.entry.relay, request.notification);
				if (!result.ok) return refuse(result.code, result.message);
				connection.send({ type: "relay_push_delivery_result", id: request.id, status: result.status });
				return;
			}
			case "worker_authority": {
				const relay = this.workerRelayOf(connection, request.relayId);
				if (!relay.ok) return refuse(relay.code, relay.message);
				const authorization = relay.entry.authorization;
				const loss =
					getIrohRemoteAuthorizationLoss(this.services.state.getHostState(), authorization) ??
					((await this.isAuthorizationCurrent(authorization)) ? undefined : "revoked");
				connection.send({ type: "worker_authority_result", id: request.id, authority: loss ?? "current" });
				return;
			}
			case "worker_last_session": {
				const relay = this.workerRelayOf(connection, request.relayId);
				if (!relay.ok) return refuse(relay.code, relay.message);
				const { clientNodeId, workspaceName, sessionId: previousSessionId } = relay.entry.relay;
				if (
					!isIrohRemoteSessionId(request.sessionId) ||
					!(await this.isStoredSession(workspaceName, request.sessionId))
				) {
					return refuse("invalid_session", "not a stored session of the relay's workspace");
				}
				try {
					await this.requireEngine().setClientLastSessionId(clientNodeId, workspaceName, request.sessionId);
				} catch (error) {
					// The phone reconnects to the target it is told; only `target:"last"` misses it.
					await this.logAudit({
						type: "session_changed",
						clientNodeId,
						workspace: workspaceName,
						success: false,
						error: error instanceof Error ? error.message : String(error),
						details: { reason: "conversation_moved", sessionId: request.sessionId, lastSessionUpdated: false },
					});
					return refuse("failed", "the last session was not recorded");
				}
				await this.logAudit({
					type: "session_changed",
					clientNodeId,
					workspace: workspaceName,
					success: true,
					details: { reason: "conversation_moved", previousSessionId, sessionId: request.sessionId },
				});
				connection.send({ type: "ok", id: request.id });
				return;
			}
			case "worker_moved": {
				const workerId = this.workers.workerOf(connection.connectionId);
				const key = workerId === undefined ? undefined : this.workers.keyOf(workerId);
				if (workerId === undefined || key === undefined || !this.workers.workerHosts(workerId, request.from)) {
					return refuse("not_hosted", "the worker does not host that conversation");
				}
				if (!isIrohRemoteSessionId(request.to) || !(await this.isStoredSession(key.workspaceName, request.to))) {
					return refuse("invalid_session", "not a stored session of the worker's workspace");
				}
				// The new conversation carries the source's change and pull-request association; the source keeps its own.
				void this.services.changes
					.inheritSession(key.workspaceName, key.workspaceGeneration, request.from, request.to)
					.catch(() => {});
				connection.send({ type: "ok", id: request.id });
				return;
			}
			case "worker_worktree_restore": {
				const workerId = this.workers.workerOf(connection.connectionId);
				const key = workerId === undefined ? undefined : this.workers.keyOf(workerId);
				// Only a session the worker hosts (claimed before it opens), while the worker serves under its
				// workspace's current authority. The worktree manager also requires the session's stored cwd to
				// be `path` and the checkout to be one of the worker's workspace's.
				if (workerId === undefined || key === undefined || !this.workers.isServing(workerId)) {
					return refuse("not_current", "the worker no longer serves its workspace");
				}
				if (!this.workers.workerHosts(workerId, request.sessionRef.sessionId)) {
					return refuse("not_hosted", "the worker does not host that conversation");
				}
				const held = [...this.workerWorktreePins.values()].filter(
					(pin) => pin.connectionId === connection.connectionId,
				).length;
				if (held >= MAX_WORKER_HOSTED_SESSIONS) return refuse("too_many", "the worker holds too many pins");
				// Reserved before the restore, so concurrent requests count against the cap.
				const pinId = randomUUID();
				const reserved = { connectionId: connection.connectionId, release: () => {} };
				this.workerWorktreePins.set(pinId, reserved);
				let unpin: () => void;
				try {
					unpin = await this.worktrees.acquireLocalSessionWorktree(
						key.workspaceName,
						request.sessionRef,
						request.path,
					);
				} catch (error) {
					if (this.workerWorktreePins.get(pinId) === reserved) this.workerWorktreePins.delete(pinId);
					return refuse(
						error instanceof WorktreeCapacityError ? error.code : "worktree_restore_failed",
						error instanceof Error ? error.message : String(error),
					);
				}
				// The pin ends with the worker's connection, if the worker does not release it first.
				if (
					this.workerWorktreePins.get(pinId) !== reserved ||
					this.workers.workerOf(connection.connectionId) !== workerId
				) {
					if (this.workerWorktreePins.get(pinId) === reserved) this.workerWorktreePins.delete(pinId);
					unpin();
					return refuse("not_registered", "the worker's connection closed");
				}
				this.workerWorktreePins.set(pinId, { connectionId: connection.connectionId, release: unpin });
				connection.send({ type: "worker_worktree_pinned", id: request.id, pinId });
				return;
			}
			case "worker_worktree_release": {
				const pin = this.workerWorktreePins.get(request.pinId);
				if (pin === undefined || pin.connectionId !== connection.connectionId) {
					return refuse("not_found", "the worker holds no such pin");
				}
				this.workerWorktreePins.delete(request.pinId);
				pin.release();
				connection.send({ type: "ok", id: request.id });
				return;
			}
		}
	}

	/** Whether `sessionId` is a stored session of the registered workspace `workspaceName`. */
	private async isStoredSession(workspaceName: string, sessionId: string): Promise<boolean> {
		const workspace = this.services.state.getHostState().workspaces.find((entry) => entry.name === workspaceName);
		if (!workspace) return false;
		const sessionDir = getDefaultSessionDirPath(workspace.path, this.services.agentDir);
		return (await SessionManager.findForResume(sessionDir, sessionId).catch(() => undefined)) !== undefined;
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

	private cancelPendingPairing(requestId: string, pending: PendingPairRequest): Promise<void> {
		if (this.pendingPairRequests.get(requestId) !== pending) {
			return Promise.resolve();
		}
		if (pending.cancellation) {
			return pending.cancellation;
		}
		clearTimeout(pending.timer);
		const cancellation = (async () => {
			if (this.engine) {
				await this.engine.cancelPairingSecretByHash(pending.secretHash);
			} else {
				await this.stateManager.removePendingPairingTicket(pending.secretHash);
			}
			if (pending.relayCredentialClaim !== undefined) {
				await this.discardManagedRelayCredentialClaim(pending.relayCredentialClaim);
			}
			await this.services.state.flush();
			if (this.pendingPairRequests.get(requestId) === pending) {
				this.pendingPairRequests.delete(requestId);
			}
		})();
		pending.cancellation = cancellation;
		void cancellation.catch(() => {
			if (pending.cancellation === cancellation) {
				pending.cancellation = undefined;
			}
		});
		return cancellation;
	}

	onControlConnectionClosed(connection: ControlConnection): void {
		this.leaseBroker.releaseAllForConnection(connection.connectionId);
		for (const [pinId, pin] of this.workerWorktreePins) {
			if (pin.connectionId !== connection.connectionId) continue;
			this.workerWorktreePins.delete(pinId);
			pin.release();
		}
		const changeRetirements: Promise<void>[] = [];
		for (const [key, claim] of this.tuiChangeAuthorities) {
			if (claim.connectionId !== connection.connectionId) continue;
			const separator = key.indexOf("\0");
			changeRetirements.push(
				this.retireTuiChangeAuthorityClaim(key, key.slice(0, separator), key.slice(separator + 1), claim),
			);
		}
		if (changeRetirements.length > 0) {
			this.trackTuiChangeRetirement(Promise.all(changeRetirements).then(() => undefined));
		}
		const admission = this.admission.tryAcquire();
		if (!admission) {
			// Quiesce owns every remaining ticket after the admission cut. A final
			// control-socket close must never launch a durable write after state.close().
			return;
		}
		const cancellations = Array.from(this.pendingPairRequests)
			.filter(([, pending]) => pending.connectionId === connection.connectionId)
			.map(async ([requestId, pending]) => {
				try {
					await this.cancelPendingPairing(requestId, pending);
				} catch (error) {
					this.log("warn", "failed to cancel pairing after control disconnect", {
						requestId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			});
		void Promise.all(cancellations).finally(() => admission.release());
	}

	admitRelay(
		relayId: string,
		proof: HelloProof,
		binding: HelloBinding,
		socket: Socket,
		bufferedRemainder: Buffer,
	): boolean {
		return this.relays.admit(relayId, proof, binding, socket, bufferedRemainder);
	}

	statusExtras(): {
		leases: ControlLeaseStatus[];
		phoneConnections: number;
		relayCount: number;
		remoteTransport: RemoteTransportHealth;
		relayCredential?: ControlRelayCredentialStatus;
	} {
		const leases: ControlLeaseStatus[] = this.leaseBroker.list().map((record) => ({
			workspaceName: record.workspaceName,
			sessionId: record.sessionId,
			state: record.state,
			relayCount: record.relayIds.size,
			streamCount: record.streamCount,
		}));
		return {
			leases,
			phoneConnections: this.clientConnections.size,
			relayCount: this.relays.activeCount(),
			remoteTransport: { ...this.remoteTransport },
			...(this.relayMode !== "production" ||
			this.relayCredentialServiceUrl === undefined ||
			(this.managedRelayCredential === undefined && this.relayAuthToken !== undefined)
				? {}
				: {
						relayCredential: createRelayCredentialStatus(
							this.managedRelayCredential,
							this.managedRelayCredentialClaim,
							this.relayCredentialIsRevoking || this.managedRelayCredentialRevocation !== undefined,
							this.relayCredentialSubscriptionInactive,
							this.relayCredentialNextRefreshAt,
						),
					}),
		};
	}

	async quiesce(): Promise<void> {
		// Close the service-wide epoch before any snapshot or await. New streams,
		// ownership commits, relay offers, and turn-starting commands now fail
		// closed against the same state.
		this.admission.close();
		const changeRetirements: Promise<void>[] = [];
		for (const [key, claim] of this.tuiChangeAuthorities) {
			const separator = key.indexOf("\0");
			changeRetirements.push(
				this.retireTuiChangeAuthorityClaim(key, key.slice(0, separator), key.slice(separator + 1), claim),
			);
		}
		await Promise.allSettled([...changeRetirements, ...this.tuiChangeRetirementTasks]);
		await this.stopRelayRecoveryMonitor();
		this.clearManagedRelayCredentialRefreshTimer();
		if (this.relayCredentialExpiryTimer !== undefined) {
			clearTimeout(this.relayCredentialExpiryTimer);
			this.relayCredentialExpiryTimer = undefined;
		}
		await this.relayCredentialRefreshTask?.catch(() => {});
		await this.relayCredentialExchangeTask?.catch(() => {});
		await this.relayConfigurationTask.catch(() => {});
		this.worktreeRetention.dispose();
		// Freeze expiry callbacks at the same cut. Once admission is closed, no
		// disconnect callback may mutate durable pairing state; quiesce becomes the
		// sole owner of every ticket still published in this map.
		for (const pending of this.pendingPairRequests.values()) {
			clearTimeout(pending.timer);
		}
		// 1. Stop accepting, then close every relay to a TUI through its
		//    coordinator. Offered and redeemed relays share this same terminal
		//    path and therefore preserve the host_shutdown reason. Offers to
		//    workers not yet redeemed close the same way; their open relays end
		//    with their workers (step 2).
		for (const entry of this.workerRelays.values()) {
			if (entry.relay.phase === "offered") void entry.relay.close("host_shutdown");
		}
		const streamClosures: Promise<void>[] = this.conversationCoordinators
			.values()
			.map((coordinator) => coordinator.closeTransports("host_shutdown").then(() => undefined));
		// Retire every accepted physical stream, including handshakes and attach
		// operations that have not reached the active-stream registry yet.
		const activeEntries = this.activeStreams.allEntries();
		for (const entry of activeEntries) {
			this.activeStreams.unregister(entry);
		}
		for (const entry of activeEntries) {
			const coordinator = this.conversationCoordinators.get(entry.workspaceName, entry.sessionId);
			if (!coordinator) {
				try {
					streamClosures.push(Promise.resolve(entry.close("host_shutdown")));
				} catch {}
			}
		}
		const ownedStreams = Array.from(this.physicalStreamOwners.entries());
		for (const [, owner] of ownedStreams) {
			try {
				streamClosures.push(owner.close("host_shutdown"));
			} catch {}
		}

		// Every operation admitted by the old epoch either published before the
		// close (and is in the snapshots above) or observes a stale lease, rolls
		// back, and releases here. No runtime can appear after the next snapshot.
		await this.admission.waitForDrain();
		// Control request admission was drained before extension quiesce began, and
		// the service gate now rejects disconnect-owned cancellation work. Therefore
		// this is a fixed producer-free set: settle it completely before state.close.
		const pendingPairingResults = await Promise.allSettled(
			Array.from(this.pendingPairRequests, ([requestId, pending]) => this.cancelPendingPairing(requestId, pending)),
		);
		const pendingPairingFailures = pendingPairingResults.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		for (const failure of pendingPairingFailures) {
			this.log("warn", "failed to cancel pending pairing during quiesce", {
				error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
			});
		}

		// 2. Stop every worker: each finishes its turn (60 s cap), tells the
		//    clients it serves the host is shutting down (`ended{shutdown}`,
		//    `fatal{host_shutdown}`), closes its conversations, and exits.
		await this.workers.stopAll();
		// 3. Wait for stream-local projection/RPC modes and their outer subscriber
		//    detach before disposing runtime-owned feeds.
		await Promise.allSettled(streamClosures);
		for (const [streamId, owner] of ownedStreams) {
			if (this.physicalStreamOwners.get(streamId) === owner) {
				this.physicalStreamOwners.delete(streamId);
			}
		}
		// 4. Close all remaining client connections and join their admitted
		//    application children. Connection.closed(), accept-loop settlement,
		//    and endpoint closure are native tails owned by bounded dispose().
		const supervisors = Array.from(this.connectionSupervisors.values());
		for (const nodeId of Array.from(this.clientConnections.keys())) {
			this.closeClientConnectionsForClient(nodeId, "host_shutdown");
		}
		await Promise.allSettled(supervisors.map((supervisor) => supervisor.sealAndWaitForChildren()));
		await this.services.auditLogger.flush().catch(() => {});
		this.log("info", "iroh service quiesced");
		if (pendingPairingFailures.length > 0) {
			throw new AggregateError(
				pendingPairingFailures.map((failure) => failure.reason),
				"pending pairing cleanup failed",
			);
		}
	}

	async dispose(): Promise<void> {
		await this.stopRelayRecoveryMonitor();
		const endpoints = new Set(
			[this.endpoint, this.startupEndpoint].filter(
				(endpoint): endpoint is IrohEndpointLike => endpoint !== undefined,
			),
		);
		this.endpoint = undefined;
		this.startupEndpoint = undefined;
		const endpointDisposals = Array.from(endpoints, (endpoint) =>
			this.retireEndpoint(endpoint, "iroh endpoint disposal failed"),
		);
		await Promise.allSettled([this.startupTask, ...endpointDisposals]);
		// The accept loop is the last producer of connection tasks and closed-gate
		// refusal tasks. Join it before taking the final disposal snapshots, then
		// drain to a fixed point because connection settlement can still enqueue a
		// raw native tail. The daemon's outer extension deadline bounds this whole
		// native phase.
		await this.acceptLoopTask;
		while (this.connectionTasks.size > 0 || this.nativeLifecycleTasks.size > 0) {
			await Promise.allSettled([...this.connectionTasks, ...this.nativeLifecycleTasks]);
		}
		await this.services.auditLogger.flush().catch(() => {});
		this.log("info", "iroh service stopped");
	}

	private async logAudit(event: Parameters<VoltdRuntimeServices["auditLogger"]["log"]>[0]): Promise<void> {
		try {
			await this.services.auditLogger.log(event);
		} catch {
			// Audit logging is best-effort.
		}
	}
}
