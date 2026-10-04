/**
 * The legacy RPC command wire, serving the remote path (Iroh streams, the
 * daemon's conversation streams, and phones relayed through the TUI) until it
 * moves to protocol frames on the remote profile. Local clients (stdio, JSON
 * mode, SDK loopback) speak protocol 1 through `serveConnection` instead.
 *
 * Commands are JSON objects with `type` and a correlation `id` where the
 * command schema requires one; responses are `{type: "response", command,
 * success, data?, error?}`; session events stream as they occur. Extension UI
 * and approvals are the conversation's live state, written as the old
 * extension_ui_request and host_action_request events; the client answers
 * with extension_ui_response and host_action_response (see
 * rpc-live-adapter.ts).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import type { RemoteCapability, RemoteGrant } from "@hansjm10/volt-protocol";
import type { AgentSession } from "../../core/agent-session.ts";
import type { WorkingIndicatorOptions } from "../../core/extensions/index.ts";
import { ClientScope } from "../../core/host/client-scope.ts";
import type { ConversationHost } from "../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import { openFork, openNewSession, openStoredSession } from "../../core/host/session-intents.ts";
import type { HostClient, HostedRedirect, RedirectTarget } from "../../core/host/targets.ts";
import { startModelCatalogWatcher } from "../../core/model-catalog-watcher.ts";
import {
	flushRawStdout,
	restoreStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import type { IntentServices } from "../../core/protocol/intents/index.ts";
import { parseIrohRemoteRpcGrant } from "../../core/remote/iroh/access-grant.ts";
import {
	executeReviewWorkflow,
	prepareReviewWorkflow,
	REMOTE_REVIEW_FAILURE_MESSAGE,
	REMOTE_REVIEW_TOOL_NAMES,
	type ReviewWorkflowEvent,
	type ReviewWorkflowToolEvent,
} from "../../core/review.ts";
import type { ReviewDiscussionService } from "../../core/review-discussions.ts";
import { appendReviewRun, createReviewRunRecord } from "../../core/review-state.ts";
import { createEmptyReviewUsage } from "../../core/review-usage.ts";
import { subscribeRpcSessionEvents } from "../../core/rpc/background-jobs.ts";
import { type ProjectionDiagnostic, StreamProjector } from "../../core/rpc/stream-projection.ts";
import type { RpcTransport } from "../../core/rpc/transport.ts";
import type { ExtensionTerminalUI } from "../../core/session/extension-binding.ts";
import type { SessionReference } from "../../core/session-manager.ts";
import type { SubagentDefinition, SubagentHandle } from "../../core/subagents/index.ts";
import { SubscriptionUsageService } from "../../core/subscription-usage.ts";
import {
	getAvailableThemesWithPaths,
	getThemeByName,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	Theme,
	theme,
} from "../../core/theme/runtime.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import {
	createRpcErrorResponse,
	getRpcErrorResponseTarget,
	HOST_ACTION_REQUESTS_CAPABILITY,
	handleRpcCommand,
	type RpcSubagentLifecycleController,
} from "./rpc-command-dispatcher.ts";
import { validateRpcCommandPayload } from "./rpc-command-validation.ts";
import {
	answerExtensionUiResponse,
	answerHostActionResponse,
	createRpcLiveView,
	pendingHostActionRequests,
} from "./rpc-live-adapter.ts";
import type {
	RpcClientCapabilityFeature,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcListSubagentsResponse,
	RpcRegisterPushTargetArgs,
	RpcRegisterPushTargetResponse,
	RpcResponse,
	RpcSessionState,
	RpcSubagentDefinition,
	RpcSubagentStartResponse,
	RpcTranscriptResponse,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	RpcClientCapabilityFeature,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostActionRequest,
	RpcHostActionResponse,
	RpcHostActionUpdate,
	RpcListSubagentsResponse,
	RpcPendingHostActionsResponse,
	RpcPushPlatform,
	RpcPushProvider,
	RpcRegisterPushTargetArgs,
	RpcRegisterPushTargetResponse,
	RpcResponse,
	RpcSessionState,
	RpcSubagentDefinition,
	RpcSubagentDefinitionSource,
	RpcSubagentSourceInfo,
	RpcSubagentStartResponse,
	RpcSubscriptionUsageReport,
	RpcWorkflowEvent,
	RpcWorkflowKind,
	RpcWorkflowStatus,
	RpcWorkflowToolEvent,
	UiActionArgumentDescriptor,
	UiActionArgumentType,
	UiActionCapabilities,
	UiActionCapabilityFeature,
	UiActionCategory,
	UiActionCompletionListResponse,
	UiActionDescriptor,
	UiActionInvocationQueueBehavior,
	UiActionInvocationResponse,
	UiActionInvocationStatus,
	UiActionListResponse,
	UiActionListScope,
	UiActionOptionDescriptor,
	UiActionPresentationHint,
	UiActionPresentationKind,
	UiActionScalar,
	UiActionSlashAlias,
	UiActionSource,
	UiActionStateDescriptor,
	UiActionStateType,
	UiActionStreamingBehavior,
} from "./rpc-types.ts";

export interface RpcSessionChange {
	sessionRef?: SessionReference;
	sessionId: string;
}

/**
 * How a client that follows its structural intents by redirect left its
 * conversation: redirected to another conversation by one of its intents, or
 * its conversation closed.
 */
export type RpcClientDetachment =
	| { readonly kind: "redirected"; readonly sessionId: string }
	| { readonly kind: "closed" };

/** A client that follows its structural intents by redirect (a phone): see `HostClientMove`. */
export interface RpcRedirectOptions {
	/** Host the conversations the client's intents lead it to before it is redirected there. */
	readonly hostTarget?: (target: RedirectTarget) => Promise<HostedRedirect>;
}

export interface RpcOrderedConversationBinding {
	readonly subscriptionId: string;
	readonly branchEpoch: string;
	enqueueControl(value: object): Promise<void>;
	requestCheckpoint(command: Extract<RpcCommand, { type: "report_stream_discontinuity" }>): {
		subscriptionId: string;
		requestId: string;
		checkpointCursor: number;
	};
	publishExternal(event: object): void;
}

export interface LegacyRemoteRpcModeOptions {
	transport?: RpcTransport;
	/**
	 * Defaults to true. The client anchors its conversation: the conversation
	 * closes when the mode ends, and the mode ends when its conversation loses
	 * its log. A host that shares the conversation (the daemon, a relaying TUI)
	 * keeps it open after the transport detaches.
	 */
	anchor?: boolean;
	/**
	 * The client follows its structural intents by redirect: it stays on its
	 * conversation, and after the intent's response the stream ends with
	 * `detachedTerminal`. Other clients move to the new conversation in place.
	 */
	redirect?: RpcRedirectOptions;
	/** Installed only by a daemon with sibling runtime ownership. */
	reviewDiscussions?: ReviewDiscussionService;
	/** Defaults to true for stdio RPC mode and false for caller-provided transports. */
	exitProcess?: boolean;
	/** Called after the active session is rebound, including initial startup. */
	onSessionChanged?: (session: RpcSessionChange) => void | Promise<void>;
	/** Called after initial startup has completed and the RPC transport is accepting commands. */
	onReady?: () => void;
	/** Called for review workflow events even if the client transport has already detached. */
	onWorkflowEvent?: (event: ReviewWorkflowEvent | ReviewWorkflowToolEvent) => void | Promise<void>;
	/** Defaults to true. Remote transports can disable this until their action allowlist is widened. */
	allowUiActionInvocation?: boolean;
	/**
	 * Defaults to true. Whether this client shows extension UI. A stream relayed
	 * through a desktop TUI attaches without it: dialogs and status stay there.
	 */
	extensionUi?: boolean;
	/**
	 * Defaults to true. Whether this client takes the session's host-action
	 * requests (approvals). A stream relayed through a desktop TUI leaves them
	 * with the TUI, which keeps answering them.
	 */
	hostActions?: boolean;
	/**
	 * The final frame for a redirect client that left its conversation: after
	 * the response of the command that redirected it, the stream ends with this
	 * frame.
	 */
	detachedTerminal?: (detachment: RpcClientDetachment) => object | undefined;
	/** Observes a redirect client leaving its conversation, before its stream ends. */
	onClientDetached?: (detachment: RpcClientDetachment) => void;
	/**
	 * A paired device's grant. Commands then run on the remote profile: only
	 * remote-safe intents and queries, each within the grant.
	 */
	remoteGrant?: RemoteGrant;
	/** Remote host callback for registering platform push notification targets. */
	registerPushTarget?: (args: RpcRegisterPushTargetArgs) => Promise<RpcRegisterPushTargetResponse>;
	/** Observes set_client_capabilities feature lists (remote hosts gate optional pushes on these). */
	onClientCapabilitiesChanged?: (features: string[]) => void;
	/** Outbound projector factory; Iroh remote mode supplies its field-aware sanitizer. */
	createStreamProjector?: () => StreamProjector;
	/** One runtime-owned conversation lane for events, checkpoints, and control frames. */
	orderedConversation?: RpcOrderedConversationBinding;
	/** Require generation-bound authority for remote conversation mutations. */
	requireConversationAuthority?: boolean;
}

type RpcModeStartupAwareTransport = RpcTransport & {
	setRpcModeStartupComplete?(startupComplete: boolean): void;
};

const MAX_PENDING_RPC_INPUT_TASKS = 64;
const RPC_CONVERSATION_AUTHORITY_MUTATION_TYPES: ReadonlySet<RpcCommand["type"]> = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"cancel_job",
	"new_session",
	"set_agent_mode",
	"plan_execute",
	"plan_change",
	"plan_discard",
	"switch_session_by_id",
	"set_model",
	"set_thinking_level",
	"invoke_ui_action",
	"open_review_session",
	"start_review_discussions",
	"reset_review_discussion",
	"acknowledge_review",
]);

/** A remote client's grant as stored; a malformed grant holds no capabilities, so its client never runs locally. */
function admittedRemoteGrant(grant: RemoteGrant): RemoteGrant {
	try {
		return parseIrohRemoteRpcGrant(grant, "remote RPC grant");
	} catch {
		return { schemaVersion: 1, revision: 1, capabilities: [] };
	}
}

class StaleConversationAuthorityError extends Error {
	readonly code = "stale_conversation_authority";

	constructor() {
		super("Conversation authority is stale; apply the latest conversation bootstrap and retry");
		this.name = "StaleConversationAuthorityError";
	}
}

function createStdioRpcTransport(): RpcTransport {
	return {
		write(value) {
			writeRawStdout(serializeJsonLine(value));
		},
		onLine(handler) {
			return attachJsonlLineReader(process.stdin, handler);
		},
		onClose(handler) {
			const onEnd = () => {
				handler();
			};
			const onError = (error: Error) => {
				handler(error);
			};
			process.stdin.on("end", onEnd);
			process.stdin.on("error", onError);
			return () => {
				process.stdin.off("end", onEnd);
				process.stdin.off("error", onError);
			};
		},
		waitForBackpressure: waitForRawStdoutBackpressure,
		flush: flushRawStdout,
		close() {
			process.stdin.pause();
		},
	};
}

interface RpcSubagentEntry {
	handle: SubagentHandle;
	projector: StreamProjector;
	projectorEnded: boolean;
	unsubscribe: () => void;
	disposed: boolean;
}

function toRpcSubagentDefinition(definition: SubagentDefinition): RpcSubagentDefinition {
	return {
		name: definition.name,
		description: definition.description,
		source: definition.source,
		sourceInfo: {
			source: definition.sourceInfo.source,
			scope: definition.sourceInfo.scope,
			origin: definition.sourceInfo.origin,
		},
		...(definition.tools ? { tools: definition.tools } : {}),
		...(definition.excludedTools ? { excludedTools: definition.excludedTools } : {}),
		...(definition.allowedSubagents ? { allowedSubagents: definition.allowedSubagents } : {}),
		...(definition.maxSubagentDepth !== undefined ? { maxSubagentDepth: definition.maxSubagentDepth } : {}),
		...(definition.maxChildAgents !== undefined ? { maxChildAgents: definition.maxChildAgents } : {}),
		...(definition.model ? { model: definition.model } : {}),
		...(definition.thinking ? { thinking: definition.thinking } : {}),
	};
}

class RpcSubagentLifecycle implements RpcSubagentLifecycleController {
	private readonly getSession: () => AgentSession;
	private readonly output: (event: object) => void;
	private readonly createProjector: () => StreamProjector;
	private readonly reportProjectionDiagnostics: (source: string, diagnostics: readonly ProjectionDiagnostic[]) => void;
	private readonly active = new Map<string, RpcSubagentEntry>();

	constructor(options: {
		getSession: () => AgentSession;
		output: (event: object) => void;
		createProjector: () => StreamProjector;
		reportProjectionDiagnostics: (source: string, diagnostics: readonly ProjectionDiagnostic[]) => void;
	}) {
		this.getSession = options.getSession;
		this.output = options.output;
		this.createProjector = options.createProjector;
		this.reportProjectionDiagnostics = options.reportProjectionDiagnostics;
	}

	list(): RpcListSubagentsResponse {
		return {
			subagents: this.getSession().resourceLoader.getSubagents().definitions.map(toRpcSubagentDefinition),
		};
	}

	async start(agent: string, prompt: string): Promise<RpcSubagentStartResponse> {
		const session = this.getSession();
		const manager = session.getSubagentToolManager();
		if (!manager) {
			throw new Error("Subagent manager is not available");
		}

		const handle = await manager.startByName(agent, { allowedTools: session.getActiveToolNames() });
		let entry: RpcSubagentEntry | undefined;
		const projector = this.createProjector();
		const unsubscribe = handle.onEvent((event) => {
			if (entry?.disposed) {
				return;
			}
			const batch = projector.push(event);
			this.reportProjectionDiagnostics(`subagent:${handle.id}`, batch.diagnostics);
			for (const frame of batch.frames) {
				this.output({ type: "subagent_event", subagentId: handle.id, event: frame });
			}
		});
		entry = { handle, projector, projectorEnded: false, unsubscribe, disposed: false };
		this.active.set(handle.id, entry);
		void handle.waitForEnd().then(
			(result) => {
				if (!entry?.disposed) {
					this.endProjector(handle.id, entry);
					this.output({ type: "subagent_end", subagentId: handle.id, result });
				}
			},
			(error: unknown) => {
				if (!entry?.disposed) {
					console.error(`[rpc-subagent:${handle.id}] stream failed`, error);
					void this.disposeEntry(handle.id, entry).catch((disposeError: unknown) => {
						console.error(`[rpc-subagent:${handle.id}] failed to dispose rejected stream`, disposeError);
					});
				}
			},
		);

		try {
			await handle.prompt(prompt);
		} catch (error) {
			await this.disposeEntry(handle.id, entry).catch(() => undefined);
			throw error;
		}

		return { subagentId: handle.id, sessionId: handle.sessionId };
	}

	async abort(subagentId: string): Promise<void> {
		const entry = this.getEntry(subagentId);
		try {
			await entry.handle.abort("remote_request");
		} finally {
			await this.disposeEntry(subagentId, entry);
		}
	}

	async getState(subagentId: string): Promise<RpcSessionState> {
		return this.getEntry(subagentId).handle.getState();
	}

	async getTranscript(options: {
		subagentId: string;
		limit?: number;
		beforeEntryId?: string;
	}): Promise<RpcTranscriptResponse> {
		return this.getEntry(options.subagentId).handle.getTranscript({
			limit: options.limit,
			beforeEntryId: options.beforeEntryId,
		});
	}

	async dispose(subagentId: string): Promise<void> {
		await this.disposeEntry(subagentId, this.getEntry(subagentId));
	}

	async disposeAll(): Promise<void> {
		const entries = Array.from(this.active.entries());
		await Promise.all(
			entries.map(([subagentId, entry]) => this.disposeEntry(subagentId, entry).catch(() => undefined)),
		);
	}

	private getEntry(subagentId: string): RpcSubagentEntry {
		const entry = this.active.get(subagentId);
		if (!entry || entry.disposed) {
			throw new Error(`Subagent ${subagentId} is not active`);
		}
		return entry;
	}

	private async disposeEntry(subagentId: string, entry: RpcSubagentEntry): Promise<void> {
		if (entry.disposed) {
			return;
		}
		entry.disposed = true;
		this.active.delete(subagentId);
		entry.unsubscribe();
		this.endProjector(subagentId, entry);
		// Terminal frame for every disposal path (abort/dispose commands, failed
		// starts, session rebinds). Nothing else fires for host-side disposals, and
		// without a terminal frame clients would retain this subagent stream's
		// message-delta accumulator forever. output() no-ops during shutdown.
		this.output({ type: "subagent_disposed", subagentId });
		await entry.handle.dispose();
	}

	private endProjector(subagentId: string, entry: RpcSubagentEntry): void {
		if (entry.projectorEnded) {
			return;
		}
		entry.projectorEnded = true;
		this.reportProjectionDiagnostics(`subagent:${subagentId}`, entry.projector.endStream().diagnostics);
	}
}

/**
 * Serve the legacy RPC command wire on a transport (stdio when none is given):
 * JSON commands in, events and responses out.
 */
export async function runLegacyRemoteRpcMode(
	host: ConversationHost,
	conversation: HostedConversation,
	options: LegacyRemoteRpcModeOptions = {},
): Promise<void> {
	if (!options.transport) {
		takeOverStdout();
	}
	const shouldExitProcess = options.exitProcess ?? !options.transport;
	const redirect = options.redirect;
	/** Whether this client anchors its conversation; a client that follows moves by redirect never does. */
	const anchorsConversation = redirect === undefined && (options.anchor ?? true);
	const allowUiActionInvocation = options.allowUiActionInvocation ?? true;
	const remoteGrant = options.remoteGrant === undefined ? undefined : admittedRemoteGrant(options.remoteGrant);
	const showsExtensionUi = options.extensionUi ?? true;
	const takesHostActions = options.hostActions ?? true;
	/** Set once a redirect client left its conversation: the stream only writes its final frame. */
	let clientDetached = false;
	/** This client's identity on the session's extensions; its commands run in its client scope. */
	const extensionClientId = crypto.randomUUID();
	const shouldRestoreStdout = !options.transport && !shouldExitProcess;
	const transport = options.transport ?? createStdioRpcTransport();
	const startupAwareTransport = transport as RpcModeStartupAwareTransport;
	startupAwareTransport.setRpcModeStartupComplete?.(false);
	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];
	const pendingWrites = new Set<Promise<void>>();
	let hasPendingWriteError = false;
	let pendingWriteError: unknown;
	let transportFailureShutdownScheduled = false;
	const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
	const recordPendingWriteError = (error: unknown): Error => {
		const writeError = toError(error);
		if (!hasPendingWriteError) {
			hasPendingWriteError = true;
			pendingWriteError = writeError;
		}
		return writeError;
	};
	const requestTransportFailureShutdown = (error: unknown): void => {
		const writeError = recordPendingWriteError(error);
		if (shuttingDown || transportFailureShutdownScheduled) {
			return;
		}
		transportFailureShutdownScheduled = true;
		// Defer so in-flight backpressure waits can report the same failure first.
		setImmediate(() => {
			transportFailureShutdownScheduled = false;
			if (shuttingDown) {
				return;
			}
			void shutdown(1, undefined, { error: writeError }).catch(() => {});
		});
	};
	const trackTransportWrite = (result: void | Promise<void>): void => {
		if (!result) {
			return;
		}
		const tracked = Promise.resolve(result)
			.catch((error: unknown) => {
				requestTransportFailureShutdown(error);
			})
			.finally(() => {
				pendingWrites.delete(tracked);
			});
		pendingWrites.add(tracked);
	};
	const waitForTransportBackpressure = async (): Promise<void> => {
		while (pendingWrites.size > 0) {
			await Promise.all(pendingWrites);
		}
		if (hasPendingWriteError) {
			const error = pendingWriteError;
			hasPendingWriteError = false;
			pendingWriteError = undefined;
			throw toError(error);
		}
		await transport.waitForBackpressure?.();
	};
	/** The conversation the client is on; a move points it at the next one before that one's extensions start. */
	let current = conversation;
	let session = conversation.session;
	let lastNotifiedSession: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let sessionProjector: StreamProjector | undefined;
	let stopModelCatalogWatcher: () => void = () => {};
	/** Settles when shutdown starts, so startup stops waiting on another client's pending bind. */
	const shutdownStarted = Promise.withResolvers<void>();

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		if (shuttingDown || hasPendingWriteError) {
			return;
		}
		try {
			trackTransportWrite(
				options.orderedConversation ? options.orderedConversation.enqueueControl(obj) : transport.write(obj),
			);
		} catch (writeError: unknown) {
			requestTransportFailureShutdown(writeError);
		}
	};
	const createStreamProjector = options.createStreamProjector ?? (() => new StreamProjector());
	const subscriptionUsageService = new SubscriptionUsageService();
	const reportProjectionDiagnostics = (source: string, diagnostics: readonly ProjectionDiagnostic[]): void => {
		for (const diagnostic of diagnostics) {
			console.error(`[stream-projection:${source}] ${diagnostic.code}: ${diagnostic.message}`, diagnostic);
		}
	};
	const rpcSubagents = new RpcSubagentLifecycle({
		getSession: () => session,
		output,
		createProjector: createStreamProjector,
		reportProjectionDiagnostics,
	});
	const endSessionProjector = (): void => {
		if (!sessionProjector) {
			return;
		}
		reportProjectionDiagnostics("rpc-session", sessionProjector.endStream().diagnostics);
		sessionProjector = undefined;
	};

	let clientCapabilities = new Set<RpcClientCapabilityFeature>();
	/** A remote client's grant holds `capability`; a local client holds every capability. */
	const grantAllows = (capability: RemoteCapability): boolean =>
		remoteGrant === undefined || remoteGrant.capabilities.includes(capability);
	/** Whether the client shows extension UI: a remote client must be able to answer its dialogs. */
	const showsExtensionUiNow = (): boolean =>
		!shuttingDown && showsExtensionUi && grantAllows("conversation.control.v1");
	/** Whether the client sees and answers approvals; a remote client needs host management. */
	const mayTakeApprovals = (): boolean => takesHostActions && grantAllows("host.manage.v1");
	/** The client's live view: the conversation's live state as the old events. */
	const liveView = createRpcLiveView({
		output: (event) => output(event),
		showsExtensionUi: showsExtensionUiNow,
		takesApprovals: () =>
			!shuttingDown && mayTakeApprovals() && clientCapabilities.has(HOST_ACTION_REQUESTS_CAPABILITY),
	});

	/** The terminal-only extension UI in RPC mode: theme control and editor paste; the rest needs a terminal. */
	const createTerminalUI = (): ExtensionTerminalUI => ({
		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(): void {
			// Component widgets are not supported in RPC mode; string widgets reach the client through the live state
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - the client sets its editor text
			const request: RpcExtensionUIRequest = {
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			};
			output(request);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return getAvailableThemesWithPaths();
		},

		getTheme(name: string) {
			return getThemeByName(name);
		},

		setTheme(themeOrName: string | Theme) {
			// Applies to this process's theme instance and persists the choice; a
			// daemon host observes the change and broadcasts a theme_snapshot. No
			// hot-reload watcher in rpc mode (that is the rendering TUI's job).
			if (themeOrName instanceof Theme) {
				setThemeInstance(themeOrName);
				return { success: true };
			}
			const result = setTheme(themeOrName, false);
			if (result.success && session.settingsManager.getTheme() !== themeOrName) {
				session.settingsManager.setTheme(themeOrName);
			}
			return result;
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	const notifySessionChanged = async (): Promise<void> => {
		// Fire on a new session object, not just a new sessionId: consumers (notably
		// the iroh transcript-entry subscription) must move to the new object.
		if (options.onSessionChanged && session !== lastNotifiedSession) {
			lastNotifiedSession = session;
			const sessionRef = session.sessionManager.getSessionRef();
			await options.onSessionChanged({
				...(sessionRef ? { sessionRef } : {}),
				sessionId: session.sessionId,
			});
		}
	};

	/**
	 * Point the client at `target` before its extensions bind or the client
	 * attaches to them: its commands and answers, and registered themes.
	 */
	const enterConversation = (target: HostedConversation): void => {
		current = target;
		session = target.session;
		// Extension-provided themes resolve by name in rpc mode too (getAllThemes /
		// getTheme / setTheme), mirroring the TUI's registration at bind time.
		const resourceThemes = session.resourceLoader?.getThemes?.().themes;
		if (resourceThemes) {
			setRegisteredThemes(resourceThemes);
		}
	};

	/** Stream the session's events to the client, unless an ordered conversation feed serves it. */
	const subscribeSessionEvents = (): void => {
		unsubscribe?.();
		unsubscribe = undefined;
		unsubscribeBackpressure?.();
		unsubscribeBackpressure = undefined;
		endSessionProjector();
		if (options.orderedConversation) return;
		sessionProjector = createStreamProjector();
		unsubscribe = subscribeRpcSessionEvents(session, (event) => {
			const batch = sessionProjector?.push(event);
			if (!batch) {
				return;
			}
			reportProjectionDiagnostics("rpc-session", batch.diagnostics);
			for (const frame of batch.frames) {
				output(frame);
			}
		});
		unsubscribeBackpressure = session.subscribeRuntimeEvents(async () => {
			try {
				await waitForTransportBackpressure();
			} catch (transportError: unknown) {
				requestTransportFailureShutdown(transportError);
			}
		});
	};

	/** An anchoring client's mode ends when the conversation it is on loses its log. */
	const observeLoss = (target: HostedConversation): void => {
		if (!anchorsConversation) return;
		void target.lost.then((error) => {
			if (shuttingDown || target !== current) return;
			console.error(
				`Volt stopped session ${target.id} because its saved state could not be confirmed: ${error.message}`,
			);
			void shutdown(1, undefined, shouldExitProcess ? undefined : { error }).catch(() => {});
		});
	};

	/** A redirect client left its conversation: after the response of the command that moved it, the stream ends. */
	const leaveConversation = (detachment: RpcClientDetachment): void => {
		if (shuttingDown || clientDetached) return;
		clientDetached = true;
		options.onClientDetached?.(detachment);
		const terminal = options.detachedTerminal?.(detachment);
		const queued = enqueueInputTask(async () => {
			if (terminal && !shuttingDown) {
				output(terminal);
				await waitForTransportBackpressure();
			}
			await shutdown();
		});
		if (!queued) void shutdown().catch(() => {});
	};

	const extensionUi = showsExtensionUi ? createTerminalUI() : undefined;
	const client: HostClient = {
		id: extensionClientId,
		...(anchorsConversation ? { anchor: true } : {}),
		recoversInput: true,
		live: liveView,
		surface: {
			...(extensionUi === undefined ? {} : { ui: extensionUi }),
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (newSessionOptions) => openNewSession(host, client, newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await openFork(host, client, entryId, forkOptions);
					return result.cancelled
						? result
						: { cancelled: false, sessionId: result.sessionId, seeded: result.seeded };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: (sessionRef, switchOptions) => openStoredSession(host, client, sessionRef, switchOptions),
				reload: () => session.reload(),
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		},
		move:
			redirect === undefined
				? {
						kind: "in_place",
						prepare: (to) => {
							// Host requests stay with the conversation that asked them; the host
							// attaches the client's live view to `to` when it joins.
							unsubscribe?.();
							unsubscribe = undefined;
							enterConversation(to);
						},
						onMoved: async (to) => {
							await rpcSubagents.disposeAll();
							observeLoss(to);
							await notifySessionChanged();
							if (shuttingDown) return;
							subscribeSessionEvents();
						},
					}
				: {
						kind: "redirect",
						redirect: (sessionId) => leaveConversation({ kind: "redirected", sessionId }),
						...(redirect.hostTarget === undefined ? {} : { hostTarget: redirect.hostTarget }),
					},
	};
	// A redirect client also leaves when its conversation closes, such as a relaying TUI leaving it.
	const stopObservingClose = redirect
		? host.onClosed((closed) => {
				if (closed === conversation) leaveConversation({ kind: "closed" });
			})
		: () => {};

	/** Attach the client to its conversation, whose extensions bind if no client attached before. */
	const attachClient = async (): Promise<void> => {
		// A redirect client whose conversation closed before it attached is told so, as if it had attached.
		if (redirect && conversation.closed) {
			leaveConversation({ kind: "closed" });
			return;
		}
		enterConversation(conversation);
		await Promise.race([host.attach(client, conversation), shutdownStarted.promise]);
		if (shuttingDown) return;
		await notifySessionChanged();
		subscribeSessionEvents();
	};

	/** Stop following the conversation's closing. */
	const stopObservingConversation = (): void => {
		stopObservingClose();
	};

	/** Leave the conversation once: an anchor closes it, even when the client never attached. */
	let clientLeft: Promise<void> | undefined;
	const leaveHost = (): Promise<void> => {
		clientLeft ??= (async () => {
			stopObservingClose();
			if (host.conversationOf(client) !== undefined) {
				await host.detach(client);
			} else if (anchorsConversation) {
				await host.close(current);
			}
		})();
		return clientLeft;
	};

	// Detached review workflow events reach ordered-conversation clients through
	// the conversation's projection feed (published by the manager itself,
	// which outlives this mode instance). This per-mode sink only serves the
	// direct stdio output path and the host's onWorkflowEvent observer.
	const detachReviewWorkflowSink =
		conversation.reviewWorkflows?.attachSink((event: ReviewWorkflowEvent | ReviewWorkflowToolEvent): void => {
			try {
				const result = options.onWorkflowEvent?.(event);
				if (result) {
					void Promise.resolve(result).catch(() => {});
				}
			} catch (error) {
				void error;
			}
			if (!options.orderedConversation) {
				output(event);
			}
		}) ?? (() => {});
	// Per-mode review sinks outlive shutdown while workflows this client may be
	// waiting on are still running; the conversation's manager keeps executing
	// them after the transport detaches (closing the conversation aborts them).
	const retireReviewWorkflowSink = (): void => {
		const reviewWorkflows = conversation.reviewWorkflows;
		if (!reviewWorkflows?.hasActiveWorkflows) {
			detachReviewWorkflowSink();
			return;
		}
		void reviewWorkflows.waitForIdle().then(detachReviewWorkflowSink, detachReviewWorkflowSink);
	};

	// Review workflows registered by invoke_ui_action but not yet executing; the
	// dispatcher launches them after the accepted response is enqueued so the
	// response deterministically precedes workflow_start on the shared lane.
	const pendingReviewWorkflows = new Map<string, { launch: () => void; cancel: () => void }>();

	// What this host gives intents: aborts deliver queued input, and reviews run as detached workflows.
	const createIntentServices = (commandConversation: HostedConversation): IntentServices => {
		const commandSession = commandConversation.session;
		return {
			// A remote stop sends what the user queued instead of stranding it behind an idle run.
			abortRun: (target) => target.abort("remote_request", { deliverQueuedMessages: true }),
			detachedReviews: true,
			runReview: async (target, reviewOptions) => {
				// Detached review: run the fast preflight inline so target errors fail
				// the invocation synchronously, then register the execution with the
				// runtime-scoped manager and return an accepted response immediately.
				// Confirmation is client-side (the descriptors advertise
				// requiresConfirmation); there is no server confirm round-trip.
				const prepared = await prepareReviewWorkflow({
					target,
					controls: reviewOptions.controls,
					...(reviewOptions.parentRunId ? { parentRunId: reviewOptions.parentRunId } : {}),
					cwd: commandConversation.cwd,
					settingsManager: commandSession.settingsManager,
					modelRegistry: commandSession.modelRegistry,
					currentModel: commandSession.model,
					sessionManager: commandSession.sessionManager,
					requireProjectTrust: reviewOptions.remote,
					sanitizeRemoteErrors: reviewOptions.remote,
				});
				const thinkingLevel = commandSession.thinkingLevel;
				const fastModeEnabled = commandSession.fastModeEnabled;
				const authStorage = commandSession.modelRegistry.authStorage;
				const modelRegistry = commandSession.modelRegistry;
				const settingsManager = commandSession.settingsManager;
				let started: ReturnType<typeof commandConversation.reviewWorkflows.start>;
				try {
					started = commandConversation.reviewWorkflows.start({
						prepared,
						fastModeEnabled,
						execute: async (hooks) => {
							try {
								const result = await executeReviewWorkflow({
									prepared,
									cwd: commandConversation.cwd,
									agentDir: commandConversation.services.agentDir,
									authStorage,
									modelRegistry,
									settingsManager,
									sessionWriter: commandSession.sessionWriter,
									sanitizeRemoteErrors: reviewOptions.remote,
									thinkingLevel,
									fastModeEnabled,
									// Immutable snapshot tools are always installed by the review host;
									// remote reviews receive no workspace or command-capable tools.
									tools: REMOTE_REVIEW_TOOL_NAMES,
									signal: hooks.signal,
									onEvent: hooks.onEvent,
								});
								if (reviewOptions.remote && result.status === "failed") {
									return { ...result, errorMessage: REMOTE_REVIEW_FAILURE_MESSAGE };
								}
								return result;
							} catch (error) {
								if (reviewOptions.remote) {
									return { status: "failed", errorMessage: REMOTE_REVIEW_FAILURE_MESSAGE };
								}
								throw error;
							}
						},
					});
				} catch (error) {
					await prepared.resolution.dispose();
					throw error;
				}
				const { descriptor, launch } = started;
				let launched = false;
				pendingReviewWorkflows.set(descriptor.workflowId, {
					launch: () => {
						launched = true;
						launch();
					},
					cancel: () => {
						if (!launched) {
							// The cancelled run record is best-effort; a lost log ends the runtime.
							void appendReviewRun(
								commandSession.sessionWriter,
								createReviewRunRecord({
									workflowId: prepared.workflowId,
									workflowAction: prepared.action,
									startedAt: prepared.startedAt,
									snapshot: prepared.resolution,
									controls: prepared.controls,
									status: "cancelled",
									usage: createEmptyReviewUsage(),
									incrementalPlan: prepared.incrementalPlan,
								}),
							).catch(() => {});
						}
						commandConversation.reviewWorkflows.cancel(descriptor.workflowId);
					},
				});
				return {
					status: "accepted",
					workflowId: descriptor.workflowId,
					...(prepared.modelWarning === undefined || reviewOptions.remote
						? {}
						: { message: prepared.modelWarning }),
				};
			},
			...(options.reviewDiscussions === undefined ? {} : { reviewDiscussions: options.reviewDiscussions }),
			subagents: rpcSubagents,
			subscriptionUsage: subscriptionUsageService,
			...(options.registerPushTarget === undefined ? {} : { pushTargets: { register: options.registerPushTarget } }),
		};
	};

	const createRpcCommandContext = (command: RpcCommand, commandConversation: HostedConversation) => {
		const commandSession = commandConversation.session;
		const assertConversationGenerationCurrent = () => assertConversationAuthority(command, commandSession);
		return {
			session: commandSession,
			conversation: commandConversation,
			host,
			client,
			options: {
				allowUiActionInvocation,
				...(remoteGrant === undefined ? {} : { remoteGrant }),
			},
			services: createIntentServices(commandConversation),
			output,
			setClientCapabilities(features: RpcClientCapabilityFeature[]): void {
				clientCapabilities = new Set(
					features.filter((feature): feature is RpcClientCapabilityFeature => typeof feature === "string"),
				);
				options.onClientCapabilitiesChanged?.(Array.from(clientCapabilities));
				// A client that may answer approvals declines them: those nobody else can answer end as
				// dismissed, as a reconnecting client without support expects. A client that may not
				// answer them (observe-only, relayed) cannot end them.
				if (mayTakeApprovals() && !liveView.acceptsHostRequest("approval")) {
					commandConversation.liveState.cancelUnanswerable("approval");
				}
			},
			async reportStreamDiscontinuity(command: Extract<RpcCommand, { type: "report_stream_discontinuity" }>) {
				const orderedConversation = options.orderedConversation;
				if (!orderedConversation) {
					throw new Error("Ordered conversation recovery is unavailable on this RPC transport");
				}
				if (command.sessionId !== commandSession.sessionId) {
					throw new Error(`Stale conversation session: ${command.sessionId}`);
				}
				if (command.subscriptionId !== orderedConversation.subscriptionId) {
					throw new Error(`Stale conversation subscription: ${command.subscriptionId}`);
				}
				return orderedConversation.requestCheckpoint(command);
			},
			// A client that may take approvals finds them after a reconnect, before it accepts them again.
			getPendingHostActionRequests: () =>
				mayTakeApprovals() ? pendingHostActionRequests(commandConversation.liveState) : [],
			assertConversationGenerationCurrent,
			conversationBranchEpoch: options.orderedConversation?.branchEpoch,
			takePendingReviewWorkflow: (workflowId: string) => {
				const pending = pendingReviewWorkflows.get(workflowId);
				pendingReviewWorkflows.delete(workflowId);
				return pending;
			},
			subagents: rpcSubagents,
		};
	};

	const assertConversationAuthority = (command: RpcCommand, commandSession: AgentSession): void => {
		if (!options.requireConversationAuthority || !RPC_CONVERSATION_AUTHORITY_MUTATION_TYPES.has(command.type)) {
			return;
		}
		const authority = "conversationAuthority" in command ? command.conversationAuthority : undefined;
		const orderedConversation = options.orderedConversation;
		if (
			!authority ||
			!orderedConversation ||
			authority.sessionId !== commandSession.sessionId ||
			authority.subscriptionId !== orderedConversation.subscriptionId ||
			authority.branchEpoch !== orderedConversation.branchEpoch
		) {
			throw new StaleConversationAuthorityError();
		}
	};

	let detachInput = () => {};
	let detachClose = () => {};
	let resolveModeClosed: (() => void) | undefined;
	let rejectModeClosed: ((error: unknown) => void) | undefined;
	const modeClosed = new Promise<void>((resolve, reject) => {
		resolveModeClosed = resolve;
		rejectModeClosed = reject;
	});
	let shutdownPromise: Promise<void> | undefined;
	let commandQueue: Promise<void> = Promise.resolve();
	let pendingInputTaskCount = 0;
	const commandTaskContext = new AsyncLocalStorage<boolean>();

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	const cleanupStartupFailure = async (): Promise<unknown[]> => {
		shuttingDown = true;
		const cleanupErrors: unknown[] = [];
		const recordCleanupError = (error: unknown): void => {
			if (error instanceof AggregateError) {
				for (const nestedError of error.errors as unknown[]) recordCleanupError(nestedError);
				return;
			}
			cleanupErrors.push(error);
		};
		const captureCleanupError = async (cleanup: () => void | Promise<void>): Promise<void> => {
			try {
				await cleanup();
			} catch (error) {
				recordCleanupError(error);
			}
		};

		await captureCleanupError(stopObservingConversation);
		await captureCleanupError(stopModelCatalogWatcher);
		await captureCleanupError(detachReviewWorkflowSink);
		await captureCleanupError(() => rpcSubagents.disposeAll());
		pendingReviewWorkflows.clear();
		for (const cleanup of signalCleanupHandlers) {
			await captureCleanupError(cleanup);
		}
		await captureCleanupError(() => unsubscribe?.());
		await captureCleanupError(endSessionProjector);
		await captureCleanupError(() => unsubscribeBackpressure?.());
		await captureCleanupError(leaveHost);
		await captureCleanupError(detachInput);
		await captureCleanupError(detachClose);
		await captureCleanupError(() => transport.close());
		if (shouldRestoreStdout) {
			await captureCleanupError(restoreStdout);
		}
		return cleanupErrors;
	};

	let startupComplete = false;
	let startupAbortError: Error | undefined;
	const queuedStartupCommands: unknown[] = [];

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	function shutdown(exitCode = 0, signal?: NodeJS.Signals, failure?: { error: unknown }): Promise<void> {
		const invokedFromCommandTask = commandTaskContext.getStore() === true;
		if (!startupComplete) {
			void modeClosed.catch(() => {});
			if (!startupAbortError) {
				if (failure) {
					startupAbortError = toError(failure.error);
				} else if (signal) {
					startupAbortError = new Error(`RPC mode shut down during startup by ${signal}`);
				} else {
					startupAbortError = new Error("RPC mode shut down during startup");
				}
			}
		}
		stopModelCatalogWatcher();
		// Extension UI, errors, and session actions go to the remaining clients from
		// here on; an anchor stays until its conversation closes with the mode.
		if (!anchorsConversation) void leaveHost().catch(() => {});
		shutdownStarted.resolve();
		retireReviewWorkflowSink();
		if (shuttingDown) {
			return invokedFromCommandTask ? Promise.resolve() : (shutdownPromise ?? modeClosed);
		}
		shuttingDown = true;
		shutdownPromise = (async () => {
			try {
				let hasShutdownError = failure !== undefined;
				let shutdownError: unknown = failure?.error;
				try {
					// Stop admitting input first, then let every command that already
					// owns a bounded queue slot either finish or observe shuttingDown and
					// cancel. Runtime/session teardown is only safe after that barrier.
					detachInput();
					detachClose();
					await commandQueue;
					stopObservingConversation();
					for (const cleanup of signalCleanupHandlers) {
						cleanup();
					}
					unsubscribe?.();
					endSessionProjector();
					unsubscribeBackpressure?.();
					await rpcSubagents.disposeAll();
					await leaveHost();
					if (signal !== "SIGTERM" && !hasShutdownError) {
						await waitForTransportBackpressure();
						await transport.flush?.();
					}
				} catch (error: unknown) {
					if (!hasShutdownError) {
						hasShutdownError = true;
						shutdownError = error;
					}
				} finally {
					try {
						await transport.close();
					} catch (closeError: unknown) {
						if (!hasShutdownError) {
							hasShutdownError = true;
							shutdownError = closeError;
						}
					}
					if (shouldRestoreStdout) {
						restoreStdout();
					}
				}
				if (hasShutdownError) {
					throw shutdownError;
				}
				if (shouldExitProcess) {
					process.exit(exitCode);
				}
				resolveModeClosed?.();
			} catch (shutdownError: unknown) {
				rejectModeClosed?.(shutdownError);
				throw shutdownError;
			}
		})();
		// modeClosed is the public outcome. Keep the independently running
		// finalizer observed as well when a command-task caller must return early.
		void shutdownPromise.catch(() => {});
		// A command cannot await a shutdown finalizer whose first barrier is the
		// command's own queue promise. It has initiated shutdown; returning here
		// lets that command settle so the independently owned finalizer can drain.
		return invokedFromCommandTask ? Promise.resolve() : shutdownPromise;
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleControlMessage = (parsed: unknown): boolean => {
		// Handle extension UI and host action responses during startup as well as normal operation.
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("type" in parsed)) {
			return false;
		}
		// Answers go to the conversation the client is on, under the client's id.
		if (parsed.type === "extension_ui_response") {
			answerExtensionUiResponse(current.liveState, extensionClientId, parsed as Record<string, unknown>);
			return true;
		}
		if (parsed.type === "host_action_response") {
			answerHostActionResponse(current.liveState, extensionClientId, parsed as Record<string, unknown>);
			return true;
		}
		return false;
	};

	const handleQueuedParsedInput = async (parsed: unknown): Promise<void> => {
		// Input queued behind the command that moved a redirected client never reaches its old conversation.
		if (shuttingDown || clientDetached) {
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			const target = getRpcErrorResponseTarget(parsed);
			output(createRpcErrorResponse(target.id, target.command, `Unknown command: ${target.command}`));
			await waitForTransportBackpressure();
			return;
		}

		const validationError = validateRpcCommandPayload(parsed);
		if (validationError) {
			const target = getRpcErrorResponseTarget(parsed);
			output(createRpcErrorResponse(target.id, target.command, validationError));
			await waitForTransportBackpressure();
			await checkShutdownRequested();
			return;
		}

		const command = parsed as RpcCommand;
		let response: RpcResponse | undefined;
		try {
			// Extension actions the command reaches go to this client. The command acts on the current session.
			response = await ClientScope.run(extensionClientId, () => {
				const commandConversation = current;
				assertConversationAuthority(command, commandConversation.session);
				return handleRpcCommand(command, createRpcCommandContext(command, commandConversation));
			});
		} catch (commandError: unknown) {
			const target = getRpcErrorResponseTarget(command);
			output(createRpcErrorResponse(target.id, target.command, toError(commandError).message, commandError));
			await waitForTransportBackpressure();
			await checkShutdownRequested();
			return;
		}
		if (response && !shuttingDown) {
			output(response);
			await waitForTransportBackpressure();
		}
		await checkShutdownRequested();
	};

	const enqueueInputTask = (task: () => Promise<void>): boolean => {
		if (pendingInputTaskCount >= MAX_PENDING_RPC_INPUT_TASKS) {
			return false;
		}
		pendingInputTaskCount++;
		const runTask = (): Promise<void> =>
			commandTaskContext.run(true, async () => {
				try {
					await task();
				} catch (inputError: unknown) {
					await shutdown(1, undefined, { error: toError(inputError) }).catch(() => {});
				} finally {
					pendingInputTaskCount--;
				}
			});
		commandQueue = commandQueue.then(runTask, runTask);
		void commandQueue.catch(() => {});
		return true;
	};

	const rejectInputTaskOverflow = (): Promise<void> => {
		return shutdown(1, undefined, {
			error: new Error(`RPC input queue exceeds ${MAX_PENDING_RPC_INPUT_TASKS} tasks`),
		}).catch(() => {});
	};

	const processParsedInput = (parsed: unknown): Promise<void> => {
		if (shuttingDown) {
			return Promise.resolve();
		}
		if (handleControlMessage(parsed)) {
			return Promise.resolve();
		}

		if (!startupComplete) {
			if (queuedStartupCommands.length >= MAX_PENDING_RPC_INPUT_TASKS) {
				return rejectInputTaskOverflow();
			}
			queuedStartupCommands.push(parsed);
			return Promise.resolve();
		}

		return enqueueInputTask(() => handleQueuedParsedInput(parsed)) ? Promise.resolve() : rejectInputTaskOverflow();
	};

	const processInputLine = (line: string): Promise<void> => {
		if (shuttingDown) {
			return Promise.resolve();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			const enqueued = enqueueInputTask(async () => {
				if (shuttingDown) {
					return;
				}
				output(
					createRpcErrorResponse(
						undefined,
						"parse",
						`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
					),
				);
				await waitForTransportBackpressure();
			});
			return enqueued ? Promise.resolve() : rejectInputTaskOverflow();
		}

		return processParsedInput(parsed);
	};

	detachInput = transport.onValue ? transport.onValue(processParsedInput) : transport.onLine(processInputLine);
	detachClose =
		transport.onClose?.((transportError) => {
			if (transportError) {
				void shutdown(1, undefined, { error: transportError }).catch(() => {});
				return;
			}
			if (!startupComplete) {
				void shutdown(0, undefined, { error: new Error("RPC transport closed during startup") }).catch(() => {});
				return;
			}
			void shutdown().catch(() => {});
		}) ?? (() => {});

	// An anchoring client's conversation ends with its log; a host that shares
	// the conversation (the daemon, a relaying TUI) ends it instead. The process
	// reports the error and exits non-zero; an embedded host rejects its close
	// promise with the error.
	observeLoss(conversation);

	try {
		await attachClient();
	} catch (startupError: unknown) {
		if (shuttingDown) {
			try {
				await shutdownPromise;
			} catch {}
			throw startupAbortError ?? startupError;
		}
		const cleanupErrors = await cleanupStartupFailure();
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[startupError, ...cleanupErrors],
				"RPC mode startup failed and cleanup did not complete",
			);
		}
		throw startupError;
	}
	if (shuttingDown) {
		try {
			await shutdownPromise;
		} catch {}
		throw startupAbortError ?? new Error("RPC mode shut down during startup");
	}
	startupComplete = true;
	startupAwareTransport.setRpcModeStartupComplete?.(true);
	// Notify connected clients when logins or API keys saved by other volt
	// processes change the selectable model catalog on disk.
	stopModelCatalogWatcher = startModelCatalogWatcher({
		agentDir: current.services.agentDir,
		getModelRegistry: () => session.modelRegistry,
		onCatalogChanged: () => output({ type: "models_changed" }),
	});
	for (const parsed of queuedStartupCommands.splice(0)) {
		// These commands were admitted into the bounded pre-startup queue before
		// an async-aware transport could apply steady-state per-frame
		// backpressure. Preserve detached review workflows by scheduling them
		// onto commandQueue without holding RPC-mode startup open until a
		// long-running action ends.
		void processParsedInput(parsed);
	}
	if (shouldExitProcess) {
		registerSignalHandlers();
	}
	try {
		options.onReady?.();
	} catch (readyError: unknown) {
		void modeClosed.catch(() => {});
		await shutdown(1, undefined, { error: readyError });
		throw readyError;
	}

	// Keep RPC mode active until shutdown completes.
	return modeClosed;
}
