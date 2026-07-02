import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { IrohRemoteActiveStreamEntry } from "../core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteActiveStreamRegistry } from "../core/remote/iroh/active-stream-registry.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import { hashIrohRemotePairingSecret } from "../core/remote/iroh/authorization.ts";
import {
	DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS,
	IrohRemoteHostEngine,
	type IrohRemoteHostHandshakeResult,
} from "../core/remote/iroh/engine.ts";
import { createIrohRemoteHandshakeFailure } from "../core/remote/iroh/handshake.ts";
import {
	DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
	DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
	writeIrohRemoteHandshakeResponse,
} from "../core/remote/iroh/handshake-reader.ts";
import { resolveIrohRemoteWorkspaceProjectTrusted } from "../core/remote/iroh/host-policy.ts";
import { IROH_REMOTE_ALPN } from "../core/remote/iroh/protocol.ts";
import {
	IrohRemoteInMemoryPushNotificationDeduper,
	IrohRemotePushNotificationDispatcher,
	IrohRemotePushRelayHttpClient,
} from "../core/remote/iroh/push.ts";
import type { IrohRemoteWorkspace } from "../core/remote/iroh/state.ts";
import type { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import { getIrohRemoteWorkspaceAvailabilityStatus } from "../core/remote/iroh/workspace.ts";
import type { IrohBiStreamLike } from "../core/rpc/iroh-transport.ts";
import { ProjectTrustStore } from "../core/trust-manager.ts";
import { runIrohRemoteRpcMode } from "../modes/rpc/iroh-remote-rpc-mode.ts";
import type { ControlLeaseStatus, ControlRequest } from "./control-protocol.ts";
import type { ControlConnection } from "./control-server.ts";
import {
	type ConversationCommandContext,
	handleIntegratedConversationRpcCommand,
	REMOTE_SESSION_LIST_CURSOR_TTL_MS,
	type RemoteSessionListCursorEntry,
} from "./conversation-commands.ts";
import {
	createIntegratedConversationHandshakeResponse,
	decorateRemoteHostState,
	type RemoteHostResponseContext,
} from "./handshake-responses.ts";
import {
	type IntegratedRuntimeEntry,
	IntegratedRuntimeRegistry,
	type IntegratedRuntimeSubscriber,
} from "./integrated-runtimes.ts";
import {
	formatIrohLoadError,
	type IrohConnectionLike,
	type IrohEndpointLike,
	type IrohModuleLike,
	loadIrohModule,
} from "./iroh-native.ts";
import type { VoltdRuntimeServices, VoltdServiceExtension } from "./main.ts";
import {
	runWorkspaceDiscoveryStream,
	runWorkspaceManagementStream,
	WORKSPACE_UNREGISTERED_CLOSE_REASON,
	writeIrohRemoteJsonLine,
} from "./workspace-streams.ts";

const ACTIVE_REVOKE_CLOSE_REASON = "revoked";
const ACTIVE_REPLACE_CLOSE_REASON = "replaced";
const DUPLICATE_CONVERSATION_RETRY_AFTER_MS = 500;
const WORKSPACE_DISCOVERY_STREAM_SESSION_ID = "$workspace-discovery";
const WORKSPACE_MANAGEMENT_STREAM_SESSION_ID = "$workspace-management";
const SHUTDOWN_RUNTIME_IDLE_CAP_MS = 60_000;

let activeConnectionSequence = 0;
let activeStreamSequence = 0;

export type IrohRelayMode = "disabled" | "default";

export interface IrohDaemonServiceConfig {
	relayMode?: IrohRelayMode;
	pushRelayUrl?: string;
	pushRelayAuthToken?: string;
	profile?: string;
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
	close(reason: string): void;
}

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

function closeConnection(connection: IrohConnectionLike, reason: string): void {
	connection.close(0n, Array.from(Buffer.from(reason, "utf8")));
}

async function waitForConnectionClose(connection: IrohConnectionLike): Promise<void> {
	await Promise.race([
		connection.closed().catch(() => {}),
		new Promise((resolveDelay) => {
			setTimeout(resolveDelay, 500);
		}),
	]);
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
	if (reason === WORKSPACE_UNREGISTERED_CLOSE_REASON || reason === "workspace_authorization_removed") {
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
			statusExtras: () => service.statusExtras(),
			shutdown: () => service.shutdown(),
		};
	};
}

class IrohDaemonService {
	private readonly iroh: IrohModuleLike;
	private readonly services: VoltdRuntimeServices;
	private readonly relayMode: IrohRelayMode;
	private readonly log: ReturnType<VoltdRuntimeServices["logger"]["child"]>;
	private readonly stateManager: IrohRemoteHostStateManager;
	private readonly activeStreams = new IrohRemoteActiveStreamRegistry();
	private readonly clientConnections = new Map<string, Set<ClientConnectionRecord>>();
	private readonly connectionTasks = new Set<Promise<void>>();
	private readonly pendingPairRequests = new Map<string, PendingPairRequest>();
	private readonly sessionListCursors = new Map<string, RemoteSessionListCursorEntry>();
	private readonly pushRelayClient: IrohRemotePushRelayHttpClient;
	private readonly pushNotificationDeduper = new IrohRemoteInMemoryPushNotificationDeduper();
	private readonly trustStore: ProjectTrustStore;
	private readonly runtimes: IntegratedRuntimeRegistry;
	private endpoint: IrohEndpointLike | undefined;
	private engine: IrohRemoteHostEngine | undefined;
	private hostNodeId: string | undefined;
	private endpointTicket: string | undefined;
	private shuttingDown = false;
	private readonly ready: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };

	constructor(iroh: IrohModuleLike, services: VoltdRuntimeServices, config: IrohDaemonServiceConfig) {
		this.iroh = iroh;
		this.services = services;
		this.relayMode = config.relayMode ?? "default";
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
			getAllowTools: (workspace) => this.getWorkspaceAllowTools(workspace),
			getProjectTrustedForWorkspace: (workspace) =>
				resolveIrohRemoteWorkspaceProjectTrusted(workspace, { trustStore: this.trustStore }),
			setClientLastSessionId: (nodeId, workspace, sessionId) =>
				this.requireEngine().setClientLastSessionId(nodeId, workspace, sessionId),
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

	private getWorkspaceAllowTools(workspace: IrohRemoteWorkspace): string | undefined {
		const allowTools = this.services.state.state.settings.allowTools;
		if (allowTools && allowTools.length > 0) {
			return allowTools.join(",");
		}
		return workspace.allowedTools;
	}

	private getResponseContext(): RemoteHostResponseContext {
		return { hostNodeId: this.hostNodeId, relayMode: this.relayMode };
	}

	private getCommandContext(): ConversationCommandContext {
		return {
			agentDir: this.services.agentDir,
			auditLogger: this.services.auditLogger,
			hostEngine: this.engine,
			stateManager: this.stateManager,
			sessionListCursors: this.sessionListCursors,
			sessionListCursorTtlMs: REMOTE_SESSION_LIST_CURSOR_TTL_MS,
		};
	}

	async start(): Promise<void> {
		try {
			const builder = this.iroh.Endpoint.builder();
			if (this.relayMode === "default") {
				this.iroh.presetN0(builder);
			} else {
				this.iroh.presetMinimal(builder);
				builder.relayMode(this.iroh.RelayMode.disabled());
			}
			const secretKey = this.services.state.state.irohSecretKey;
			if (secretKey) {
				builder.secretKey(secretKey);
			}
			builder.alpns([Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"))]);
			const endpoint = await builder.bind();
			if (!secretKey) {
				const boundKey = endpoint.secretKey().toBytes();
				this.services.state.setHostState({
					...this.services.state.getHostState(),
					hostSecretKey: boundKey,
				});
			}
			if (this.relayMode === "default") {
				await endpoint.online();
			}
			this.endpoint = endpoint;
			this.hostNodeId = endpoint.id().toString();
			this.endpointTicket = this.iroh.EndpointTicket.fromAddr(endpoint.addr()).toString();
			this.engine = new IrohRemoteHostEngine({
				auditLogger: this.services.auditLogger,
				classifyWorkspaceAvailability: getIrohRemoteWorkspaceAvailabilityStatus,
				hostNodeId: this.hostNodeId,
				stateManager: this.stateManager,
				validateWorkspace: async (workspace) =>
					(await getIrohRemoteWorkspaceAvailabilityStatus(workspace)) === "available",
				workspace: { name: "voltd", path: this.services.agentDir },
			});
			this.ready.resolve();
			this.log("info", `iroh endpoint online`, { hostNodeId: this.hostNodeId, relayMode: this.relayMode });
			void this.acceptLoop(endpoint);
		} catch (error) {
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
				});
			this.connectionTasks.add(task);
		}
	}

	private async handleConnection(
		incoming: NonNullable<Awaited<ReturnType<IrohEndpointLike["acceptNext"]>>>,
	): Promise<void> {
		const accepting = await incoming.accept();
		const connection = await accepting.connect();
		const remoteId = connection.remoteId().toString();
		const connectionId = `conn-${++activeConnectionSequence}`;
		const removeClientConnection = this.registerClientConnection(remoteId, connection, connectionId);
		const streamTasks = new Set<Promise<void>>();
		let acceptedStreamCount = 0;
		let closeRequested = false;
		this.log("info", `client connection opened: ${remoteId} (${connectionId})`);
		await this.logAudit({
			type: "client_connected",
			clientNodeId: remoteId,
			success: true,
			details: { connectionId },
		});

		const requestCloseWhenIdle = () => {
			if (closeRequested || acceptedStreamCount === 0 || streamTasks.size > 0) {
				return;
			}
			closeRequested = true;
			closeConnection(connection, "done");
		};

		try {
			while (!closeRequested) {
				const stream = await (acceptedStreamCount === 0
					? withTimeout(connection.acceptBi(), DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS, "handshake timed out")
					: connection.acceptBi());
				acceptedStreamCount++;
				const streamId = `stream-${++activeStreamSequence}`;
				const replaceExistingConversationStream = acceptedStreamCount === 1;
				const task = this.handleConnectionStream(
					stream,
					connection,
					remoteId,
					connectionId,
					streamId,
					replaceExistingConversationStream,
				)
					.catch((error) => {
						if (!isExpectedApplicationClose(error)) {
							this.log(
								"error",
								`stream error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
							);
						}
					})
					.finally(() => {
						streamTasks.delete(task);
						requestCloseWhenIdle();
					});
				streamTasks.add(task);
			}
		} catch (error) {
			if (acceptedStreamCount === 0) {
				throw error;
			}
		} finally {
			await this.closeActiveStreamsForConnection(connectionId, "connection_closed");
			await Promise.allSettled(streamTasks);
			removeClientConnection();
			if (!closeRequested) {
				closeConnection(connection, "done");
			}
			await waitForConnectionClose(connection);
			this.log("info", `client connection closed: ${remoteId} (${connectionId})`);
			await this.logAudit({
				type: "client_disconnected",
				clientNodeId: remoteId,
				success: true,
				details: { connectionId },
			});
		}
	}

	private async handleConnectionStream(
		stream: IrohBiStreamLike,
		connection: IrohConnectionLike,
		remoteId: string,
		connectionId: string,
		streamId: string,
		replaceExistingConversationStream: boolean,
	): Promise<void> {
		const engine = this.requireEngine();
		const handshake = await engine.readHandshake(stream, remoteId, {
			child: "volt",
			maxLineBytes: DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
			timeoutMs: DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
			writeSuccessResponse: false,
		});
		if (!handshake.ok) {
			if (
				handshake.response.outcome === "workspace_authorization_removed" &&
				typeof handshake.response.workspace === "string"
			) {
				await this.closeWorkspaceAuthorizationRemovedStreams(remoteId, handshake.response.workspace);
			}
			await Promise.resolve(stream.send.finish?.()).catch(() => {});
			await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
			return;
		}

		this.notifyPairingConsumed(handshake, remoteId);

		if (handshake.authorization.paired) {
			this.log("info", `paired client stream: ${handshake.authorization.client.label} (${remoteId}, ${streamId})`);
		}

		if (handshake.hello.mode === "workspaceDiscovery") {
			await this.runWorkspaceDiscovery(stream, handshake, connection, connectionId, streamId);
			return;
		}
		if (handshake.hello.mode === "workspaceManagement") {
			await this.runWorkspaceManagement(stream, handshake, connection, connectionId, streamId);
			return;
		}
		await this.runIntegratedConversation(
			stream,
			handshake,
			connection,
			connectionId,
			streamId,
			replaceExistingConversationStream,
		);
	}

	// ==========================================================================
	// Workspace streams
	// ==========================================================================

	private registerActiveStream(
		authorization: IrohRemoteClientAuthorizationSuccess,
		sessionId: string,
		stream: IrohBiStreamLike,
		connection: IrohConnectionLike,
		connectionId: string,
		streamId: string,
		details: { terminalSessionId?: string | undefined } = {},
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
			closeConnection: (reason: string) => closeConnection(connection, reason),
			write: (value: object) => writeIrohRemoteJsonLine(stream.send, value, authorization),
		};
		const remove = this.activeStreams.register(entry);
		return { entry, remove };
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
		connection: IrohConnectionLike,
		connectionId: string,
		streamId: string,
	): Promise<void> {
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		const activeStream = this.registerActiveStream(
			handshake.authorization,
			WORKSPACE_DISCOVERY_STREAM_SESSION_ID,
			stream,
			connection,
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
		connection: IrohConnectionLike,
		connectionId: string,
		streamId: string,
	): Promise<void> {
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		const activeStream = this.registerActiveStream(
			handshake.authorization,
			WORKSPACE_MANAGEMENT_STREAM_SESSION_ID,
			stream,
			connection,
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
					closeStream: (reason) => {
						activeStream.remove();
						closeIrohRemoteStream(stream, reason);
					},
				},
				{
					auditLogger: this.services.auditLogger,
					commandContext: this.getCommandContext(),
					unregisterWorkspace: async (workspaceName) => {
						const removedWorkspace = await this.stateManager.unregisterWorkspace(workspaceName);
						if (!removedWorkspace) {
							return { ok: false, error: "workspace_unregistered" };
						}
						this.engine?.clearPairingSecretForWorkspace(workspaceName);
						const closedStreamCount = await this.closeActiveStreamsForWorkspace(
							workspaceName,
							WORKSPACE_UNREGISTERED_CLOSE_REASON,
							activeStream.entry,
						);
						const stoppedRuntimeCount = await this.runtimes.stopForWorkspace(
							workspaceName,
							WORKSPACE_UNREGISTERED_CLOSE_REASON,
						);
						await this.stateManager.removeLiveActivitiesForWorkspace(workspaceName);
						return { ok: true, closedStreamCount, stoppedRuntimeCount };
					},
				},
			);
		} finally {
			activeStream.remove();
		}
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

	private async sendHandshakeError(stream: IrohBiStreamLike, error: unknown): Promise<void> {
		const record = (error ?? {}) as Record<string, unknown>;
		const message = error instanceof Error ? error.message : String(error);
		const outcome = typeof record.outcome === "string" ? record.outcome : undefined;
		const workspace = typeof record.workspace === "string" ? record.workspace : undefined;
		const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
		const retryAfterMs = typeof record.retryAfterMs === "number" ? record.retryAfterMs : undefined;
		await writeIrohRemoteHandshakeResponse(
			stream.send,
			createIrohRemoteHandshakeFailure(message, {
				hostNodeId: this.hostNodeId,
				...(outcome === undefined ? {} : { outcome: outcome as never }),
				...(workspace === undefined ? {} : { workspace }),
				...(sessionId === undefined ? {} : { sessionId }),
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			}),
		);
		await Promise.resolve(stream.send.finish?.()).catch(() => {});
		await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
	}

	private async rejectDuplicateActiveConnection(
		stream: IrohBiStreamLike,
		authorization: IrohRemoteClientAuthorizationSuccess,
		sessionId: string,
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
				source: "active_stream_registry",
			},
		});
		await writeIrohRemoteHandshakeResponse(
			stream.send,
			createIrohRemoteHandshakeFailure(error, {
				hostNodeId: this.hostNodeId,
				outcome: "duplicate_conversation_connection",
				workspace: authorization.workspace.name,
				sessionId,
				retryAfterMs: DUPLICATE_CONVERSATION_RETRY_AFTER_MS,
			}),
		);
		await Promise.resolve(stream.send.finish?.()).catch(() => {});
		await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
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
		await this.closeIdleConnectionsForEntries(replacedEntries, ACTIVE_REPLACE_CLOSE_REASON);
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

	private async runIntegratedConversation(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connection: IrohConnectionLike,
		connectionId: string,
		streamId: string,
		replaceExistingConversationStream: boolean,
	): Promise<void> {
		const authorization = handshake.authorization;
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
			if (createdRuntime) {
				await this.runtimes.cleanupUncommittedEntry(entry, sessionSelection);
			}
			await this.rejectDuplicateActiveConnection(stream, authorization, entry.sessionId);
			return;
		}

		const matchingActiveStreams = this.activeStreams.entriesForConversation(
			authorization.client.nodeId,
			authorization.workspace.name,
			entry.sessionId,
		);
		if (matchingActiveStreams.length > 0 && !replaceExistingConversationStream) {
			if (createdRuntime) {
				await this.runtimes.cleanupUncommittedEntry(entry, sessionSelection);
			}
			await this.rejectDuplicateActiveConnection(stream, authorization, entry.sessionId);
			return;
		}
		const replacedEntries = replaceExistingConversationStream
			? this.activeStreams.takeEntriesForConversation(
					authorization.client.nodeId,
					authorization.workspace.name,
					entry.sessionId,
				)
			: [];

		let activeStream: { entry: IrohRemoteActiveStreamEntry; remove: () => void } | undefined;
		let subscriber: IntegratedRuntimeSubscriber | undefined;
		let subscriberError: unknown;
		let handshakeCommitted = false;
		let abortStreamInvalidated = false;
		const invalidateStreamAfterAbortResponse = async (response: Record<string, unknown>) => {
			if (response.command !== "abort" || response.success !== true || abortStreamInvalidated) {
				return;
			}
			abortStreamInvalidated = true;
			activeStream?.remove();
			await this.runtimes.stopEntry(entry, "abort");
			closeIrohRemoteStream(stream, "abort");
		};
		try {
			await this.runtimes.commitEntry(entry, sessionSelection, authorization);
			handshakeCommitted = true;
			activeStream = this.registerActiveStream(
				authorization,
				entry.sessionId,
				stream,
				connection,
				connectionId,
				streamId,
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
				),
			);
			subscriber = await this.runtimes.attachSubscriber(entry);
			await this.runtimes.replayWorkflowEvents(activeStream.entry, entry);
			const pushDispatcher = this.createPushNotificationDispatcher(authorization);
			await runIrohRemoteRpcMode(entry.runtime, {
				decorateOutbound: (value) => decorateRemoteHostState(value, authorization, this.getResponseContext()),
				disposeRuntimeOnClose: false,
				notificationDelivery: pushDispatcher,
				onResponseWritten: invalidateStreamAfterAbortResponse,
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
						this.getCommandContext(),
						entry.runtime,
					),
				stream,
				initialInput: handshake.initialInput,
				workspaceName: authorization.workspace.name,
				workspacePath: authorization.workspace.path,
			});
		} catch (error) {
			subscriberError = error;
			if (!handshakeCommitted) {
				await this.runtimes.cleanupUncommittedEntry(entry, sessionSelection);
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
			} else if (handshakeCommitted && !abortStreamInvalidated) {
				await this.runtimes.detachWithoutSubscriber(
					entry,
					subscriberError ? "transport_error" : "transport_closed",
				);
			}
			activeStream?.remove();
		}
	}

	// ==========================================================================
	// Stream/connection registries
	// ==========================================================================

	private registerClientConnection(nodeId: string, connection: IrohConnectionLike, connectionId: string): () => void {
		const record: ClientConnectionRecord = {
			connectionId,
			close: (reason: string) => closeConnection(connection, reason),
		};
		let records = this.clientConnections.get(nodeId);
		if (!records) {
			records = new Set();
			this.clientConnections.set(nodeId, records);
		}
		records.add(record);
		let removed = false;
		return () => {
			if (removed) {
				return;
			}
			removed = true;
			records.delete(record);
			if (records.size === 0 && this.clientConnections.get(nodeId) === records) {
				this.clientConnections.delete(nodeId);
			}
		};
	}

	private async closeClientConnectionsForClient(nodeId: string, reason: string): Promise<number> {
		const records = Array.from(this.clientConnections.get(nodeId) ?? []);
		if (records.length === 0) {
			return 0;
		}
		this.clientConnections.delete(nodeId);
		for (const record of records) {
			try {
				record.close(reason);
			} catch {
				// Connection closure is best-effort; the transport may already be closing.
			}
		}
		return records.length;
	}

	private async closeEntryConnection(entry: IrohRemoteActiveStreamEntry, reason: string): Promise<void> {
		try {
			await Promise.resolve(entry.closeConnection?.(reason));
		} catch {
			// Connection closure is best-effort. Stream teardown still drives task cleanup.
		}
	}

	private async closeIdleConnectionsForEntries(entries: IrohRemoteActiveStreamEntry[], reason: string): Promise<void> {
		const closedConnectionIds = new Set<string>();
		for (const entry of entries) {
			if (closedConnectionIds.has(entry.connectionId)) {
				continue;
			}
			if (this.activeStreams.entriesForConnection(entry.connectionId).length > 0) {
				continue;
			}
			closedConnectionIds.add(entry.connectionId);
			await this.closeEntryConnection(entry, reason);
		}
	}

	private async closeActiveStreamsForConnection(connectionId: string, reason: string): Promise<void> {
		const entries = this.activeStreams.entriesForConnection(connectionId);
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
			await Promise.resolve(entry.close(reason)).catch(() => {});
		}
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
		await this.closeIdleConnectionsForEntries(entries, reason);
		return entries.length;
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
		await this.closeIdleConnectionsForEntries(entries, reason);
		return entries.length;
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
		const entries = this.activeStreams.entriesForClientNodeId(nodeId);
		if (entries.length === 0) {
			const closedConnectionCount = await this.closeClientConnectionsForClient(nodeId, ACTIVE_REVOKE_CLOSE_REASON);
			const stoppedRuntimeCount = await this.runtimes.stopForClient(nodeId, "client_revoked");
			const closed = closedConnectionCount > 0;
			await this.logAudit({
				type: "active_connection_revoked",
				clientNodeId: nodeId,
				success: closed || stoppedRuntimeCount > 0,
				error: closed || stoppedRuntimeCount > 0 ? undefined : "no active connection found",
				details: {
					closeReason: ACTIVE_REVOKE_CLOSE_REASON,
					closedConnectionCount,
					source: "control_channel",
					stoppedRuntimeCount,
				},
			});
			return { closed, closedCount: closedConnectionCount };
		}

		for (const entry of entries) {
			this.activeStreams.unregister(entry);
			await Promise.resolve(entry.close(ACTIVE_REVOKE_CLOSE_REASON)).catch(() => {});
		}
		await this.closeIdleConnectionsForEntries(entries, ACTIVE_REVOKE_CLOSE_REASON);
		const closedConnectionCount = await this.closeClientConnectionsForClient(nodeId, ACTIVE_REVOKE_CLOSE_REASON);
		const stoppedRuntimeCount = await this.runtimes.stopForClient(nodeId, "client_revoked");
		for (const entry of entries) {
			await this.logAudit({
				type: "active_connection_revoked",
				clientNodeId: nodeId,
				workspace: entry.workspaceName,
				success: true,
				details: {
					closeReason: ACTIVE_REVOKE_CLOSE_REASON,
					closedConnectionCount,
					source: "control_channel",
					streamId: entry.streamId,
					stoppedRuntimeCount,
				},
			});
		}
		return { closed: true, closedCount: entries.length };
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
			await this.ready.promise;
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
			const pairing = await engine.pair({
				irohTicket: this.endpointTicket,
				nodeId: this.hostNodeId,
				relayMode: this.relayMode,
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
			case "pair_request":
				await this.handlePairRequest(connection, request);
				return true;
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
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "workspace_unregister": {
				const removedWorkspace = await this.stateManager.unregisterWorkspace(request.name);
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
				await this.closeActiveStreamsForWorkspace(request.name, WORKSPACE_UNREGISTERED_CLOSE_REASON);
				await this.runtimes.stopForWorkspace(request.name, WORKSPACE_UNREGISTERED_CLOSE_REASON);
				await this.stateManager.removeLiveActivitiesForWorkspace(request.name);
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
				return false;
		}
	}

	private async requireEngineSafe(): Promise<
		{ ok: true; engine: IrohRemoteHostEngine } | { ok: false; error: string }
	> {
		try {
			await this.ready.promise;
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (!this.engine) {
			return { ok: false, error: "iroh host engine is not ready" };
		}
		return { ok: true, engine: this.engine };
	}

	onControlConnectionClosed(connection: ControlConnection): void {
		for (const [requestId, pending] of this.pendingPairRequests) {
			if (pending.connectionId !== connection.connectionId) {
				continue;
			}
			clearTimeout(pending.timer);
			this.pendingPairRequests.delete(requestId);
		}
	}

	statusExtras(): { leases: ControlLeaseStatus[]; phoneConnections: number } {
		const leases: ControlLeaseStatus[] = this.runtimes.values().map((entry) => ({
			workspaceName: entry.workspaceName,
			sessionId: entry.sessionId,
			state: entry.subscribers.size > 0 ? "daemon-active" : "daemon-detached",
			relayCount: 0,
			streamCount: entry.subscribers.size,
		}));
		return { leases, phoneConnections: this.clientConnections.size };
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		// 1. Stop accepting: close the endpoint accept loop lazily; new hellos are
		//    rejected by the control server's shutting-down gate.
		// 2. Wait for streaming runtimes to go idle (60s cap each, concurrently);
		//    never abort a turn from shutdown.
		const drainResults = await Promise.allSettled(
			this.runtimes
				.values()
				.filter((entry) => entry.runtime.session.isStreaming)
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
