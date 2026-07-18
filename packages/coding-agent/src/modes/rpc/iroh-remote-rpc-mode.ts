import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { REVIEW_BRANCH_ACTION_ID, REVIEW_UNCOMMITTED_ACTION_ID } from "../../core/host-actions.ts";
import { extractVisibleTextContent } from "../../core/messages.ts";
import {
	createIrohRemoteFilteredRpcTransport,
	createIrohRemoteOutboundFilteredRpcTransport,
	createIrohRemoteProjectionSanitizer,
	createIrohRemoteRpcErrorResponse,
	type IrohRemoteLiveActivityContentState,
	type IrohRemoteLiveActivityToolGlyph,
	type IrohRemoteLiveActivityUpdateIntent,
	type IrohRemoteOutboundValueDecorator,
	type IrohRemotePushNotificationDelivery,
	type IrohRemoteRpcGrant,
	sanitizeIrohRemoteOutbound,
	sanitizeIrohRemoteTranscriptText,
} from "../../core/remote/iroh/index.ts";
import {
	type ConversationProjectionPreparedValue,
	type ConversationProjectionSnapshotBuilder,
	type ConversationProjectionSubscription,
	createIrohRpcTransport,
	type IrohRpcTransportOptions,
	type RpcCloseHandler,
	type RpcLineHandler,
	type RpcTransport,
	StreamProjector,
	serializeJsonLine,
} from "../../core/rpc/index.ts";
import { isRpcSessionInterruptionCommand, type RpcModeOptions, type RpcSessionChange, runRpcMode } from "./rpc-mode.ts";
import type { RpcRegisterPushTargetResponse } from "./rpc-types.ts";

export interface IrohRemoteRpcModeOptions extends IrohRpcTransportOptions {
	rpcGrant: IrohRemoteRpcGrant;
	/** Recheck persisted authority at each command boundary when the host owns grant state. */
	isRpcGrantCurrent?: () => boolean | Promise<boolean>;
	decorateOutbound?: IrohRemoteOutboundValueDecorator;
	disposeRuntimeOnClose?: boolean;
	notificationDelivery?: IrohRemotePushNotificationDelivery;
	onClientCapabilitiesChanged?: (features: string[]) => void;
	onResponseWritten?: (response: Record<string, unknown>) => void | Promise<void>;
	/**
	 * Ownership barrier for replacement sessions. The runtime does not publish
	 * the new conversation generation until every attached host has rekeyed it.
	 */
	onSessionWillProject?: (session: RpcSessionChange) => void | Promise<void>;
	onSessionChanged?: (session: RpcSessionChange) => void | Promise<void>;
	onWorkflowEvent?: RpcModeOptions["onWorkflowEvent"];
	registerPushTarget?: (args: unknown) => Promise<RpcRegisterPushTargetResponse>;
	remoteCommandHandler?: (command: Record<string, unknown>) => object | Promise<object | undefined> | undefined;
	remoteWorkspacePath?: string;
	/** Drop extension_ui_request frames (relayed streams: dialogs are answered in the owning TUI). */
	suppressExtensionUiRequests?: boolean;
	workspaceName?: string;
	workspacePath: string;
	/** Extra roots (worktree parent checkout, worktrees root) redacted on every outbound frame. */
	additionalRedactedPaths?: string[];
	/** Synchronous, subscriber-authorized full conversation checkpoint builder. */
	buildConversationSnapshot: ConversationProjectionSnapshotBuilder;
	/** Project canonical runtime commits for this subscriber; null omits one. */
	projectConversationExternal: (event: object) => object | null;
	/** Installs the idempotent owner for the physical conversation stream. */
	onConversationLifecycleReady?: (lifecycle: IrohRemoteConversationLifecycle) => void;
}

export interface IrohRemoteConversationLifecycle {
	write(value: object): Promise<void>;
	terminate(): Promise<void>;
}

export type IrohRemoteNotificationKind =
	| "conversation_completed"
	| "review_completed"
	| "action_completed"
	| "host_notice";

export interface IrohRemoteNotificationRequest {
	type: "notification_request";
	eventId: string;
	kind: IrohRemoteNotificationKind;
	title: string;
	body: string;
	sessionId?: string;
	workspace?: string;
}

type IrohRemoteRunTerminalOutcome = "completed" | "failed" | "aborted";

export interface IrohRemoteCompletionState {
	sessionId: string;
	runId?: string;
	terminalOutcome?: IrohRemoteRunTerminalOutcome;
}

export interface IrohRemoteCompletedCommand {
	command: string;
	id: string | undefined;
	initialState: IrohRemoteCompletionState | undefined;
	finalState: IrohRemoteCompletionState | undefined;
	response?: Record<string, unknown>;
}

interface PendingIrohRemoteCommand {
	command: string;
	id: string | undefined;
	initialState: IrohRemoteCompletionState | undefined;
	done: Promise<void>;
	responseMatched: boolean;
	finish(): void;
}

interface IrohRemoteCloseDeferringRpcTransportOptions {
	transport: RpcTransport;
	/** Bypasses outbound transformation for values already prepared by the ordered sink. */
	preparedTransport?: RpcTransport;
	getCompletionState?: () => IrohRemoteCompletionState;
	onCommandCompleted?: (completion: IrohRemoteCompletedCommand) => void | Promise<void>;
	onResponseWritten?: (response: Record<string, unknown>) => void | Promise<void>;
	waitForPromptCompletion(): Promise<void>;
}

interface IrohRemoteCloseDeferringRpcTransport extends RpcTransport {
	setRpcModeStartupComplete(startupComplete: boolean): void;
	/** Claims a response at final ordered-FIFO admission. */
	admitPrepared(value: object): void;
	/** Cancels stream-local command waits and emits one synthetic clean close. */
	retire(error?: Error): void;
	writePrepared(value: object): void | Promise<void>;
}

interface IrohRemoteHostCommandRpcTransportOptions {
	handleCommand?: (command: Record<string, unknown>) => object | Promise<object | undefined> | undefined;
	isRpcGrantCurrent?: () => boolean | Promise<boolean>;
	onRpcGrantStale?: () => void | Promise<void>;
	transport: RpcTransport;
	writeResponse?: (value: object) => void | Promise<void>;
}

/**
 * Cap on the per-stream completion-notification dedup set. Duplicate suppression
 * only needs recent history, so a very long-lived relay stream doing thousands of
 * turns evicts oldest-first rather than growing the set without bound.
 */
const MAX_SENT_NOTIFICATION_EVENT_IDS = 512;

/**
 * Scalar cap for tool result text shipped to remote clients (transcript entries
 * and tool_execution_end frames). Mirrors REMOTE_TOOL_OUTPUT_MAX_SCALARS in
 * daemon/conversation-commands.ts so live events and fetched history agree.
 */
const IROH_REMOTE_TOOL_OUTPUT_MAX_SCALARS = 8_000;

/** Run Volt RPC in-process over an authorized Iroh bidirectional stream. */
export function runIrohRemoteRpcMode(
	runtimeHost: AgentSessionRuntime,
	options: IrohRemoteRpcModeOptions,
): Promise<void> {
	const sentNotificationEventIds = new Set<string>();
	let detachLiveActivityUpdates: (() => void) | undefined;
	let transportClosed = false;
	const attachLiveActivityUpdates = () => {
		detachLiveActivityUpdates?.();
		detachLiveActivityUpdates = attachIrohRemoteLiveActivityUpdates(
			runtimeHost,
			options.notificationDelivery,
			options.workspaceName,
		);
	};
	const irohTransport = createIrohRpcTransport(options);
	const filteredOutboundTransport = createIrohRemoteOutboundFilteredRpcTransport({
		decorate: options.decorateOutbound,
		remoteWorkspacePath: options.remoteWorkspacePath,
		transport: irohTransport,
		workspacePath: options.workspacePath,
		additionalRedactedPaths: options.additionalRedactedPaths,
	});
	const streamProjectionSanitizer = createIrohRemoteProjectionSanitizer({
		remoteWorkspacePath: options.remoteWorkspacePath,
		workspacePath: options.workspacePath,
		additionalRedactedPaths: options.additionalRedactedPaths,
	});
	const suppressingTransport: RpcTransport = options.suppressExtensionUiRequests
		? {
				...filteredOutboundTransport,
				write: (value) => {
					if (
						typeof value === "object" &&
						value !== null &&
						(value as { type?: unknown }).type === "extension_ui_request"
					) {
						return Promise.resolve();
					}
					return filteredOutboundTransport.write(value);
				},
			}
		: filteredOutboundTransport;
	const preparedOutboundTransport: RpcTransport = options.suppressExtensionUiRequests
		? {
				...irohTransport,
				write: (value) => {
					if (
						typeof value === "object" &&
						value !== null &&
						(value as { type?: unknown }).type === "extension_ui_request"
					) {
						return Promise.resolve();
					}
					return irohTransport.write(value);
				},
			}
		: irohTransport;
	// Attach bounded, sanitized tool result text to live tool_execution_end
	// frames so remote clients can show real output in tool details.
	const outboundTransport: RpcTransport = {
		...suppressingTransport,
		write: (value) =>
			suppressingTransport.write(
				decorateIrohRemoteToolExecutionEnd(value, {
					remoteWorkspacePath: options.remoteWorkspacePath,
					workspacePath: options.workspacePath,
				}),
			),
	};
	let writeOrderedControl = (value: object): Promise<void> => Promise.resolve(outboundTransport.write(value));
	let writeOrderedTerminal = (value: object): Promise<void> => Promise.resolve(outboundTransport.write(value));
	const deliverCompletionNotification = async (notification: IrohRemoteNotificationRequest): Promise<void> => {
		if (options.notificationDelivery) {
			const deliveryStatus = await options.notificationDelivery.deliverNotification(notification);
			if (deliveryStatus === "sent" || deliveryStatus === "duplicate") {
				return;
			}
		}
		await writeOrderedControl(notification);
	};
	const closeDeferringTransport = createIrohRemoteCloseDeferringRpcTransport({
		transport: outboundTransport,
		preparedTransport: preparedOutboundTransport,
		getCompletionState: () => getIrohRemoteCompletionState(runtimeHost),
		onCommandCompleted: async (completion) => {
			const notification = createIrohRemoteCompletionNotification(completion, options.workspaceName);
			if (!notification || sentNotificationEventIds.has(notification.eventId)) {
				return;
			}
			if (sentNotificationEventIds.size >= MAX_SENT_NOTIFICATION_EVENT_IDS) {
				// Set preserves insertion order, so the first value is the oldest.
				const oldest = sentNotificationEventIds.values().next().value;
				if (oldest !== undefined) {
					sentNotificationEventIds.delete(oldest);
				}
			}
			sentNotificationEventIds.add(notification.eventId);
			try {
				await deliverCompletionNotification(notification);
			} catch (error: unknown) {
				sentNotificationEventIds.delete(notification.eventId);
				throw error;
			}
		},
		onResponseWritten: options.onResponseWritten,
		waitForPromptCompletion: () => runtimeHost.session.waitForIdle(),
	});
	let retireConversationStream: (error?: Error) => void = () => {};

	const filteredTransport = createIrohRemoteFilteredRpcTransport({
		transport: closeDeferringTransport,
		rpcGrant: options.rpcGrant,
		writeRejectedResponse: (value) => writeOrderedControl(value),
		writeStaleGrantResponse: (value) => writeOrderedTerminal(value),
		isRpcGrantCurrent: options.isRpcGrantCurrent,
		onRpcGrantStale: () => retireConversationStream(),
	});
	const remoteHostCommandTransport = options.remoteCommandHandler
		? createIrohRemoteHostCommandRpcTransport({
				handleCommand: (command) =>
					isRpcSessionInterruptionCommand(command)
						? options.remoteCommandHandler?.(command)
						: runtimeHost.runWithStableSession(() => options.remoteCommandHandler?.(command)),
				transport: filteredTransport,
				writeResponse: (value) => writeOrderedControl(value),
			})
		: filteredTransport;

	const prepareConversationOutbound = (value: object): ConversationProjectionPreparedValue => {
		const prepared = sanitizeIrohRemoteOutbound(
			decorateIrohRemoteToolExecutionEnd(value, {
				remoteWorkspacePath: options.remoteWorkspacePath,
				workspacePath: options.workspacePath,
			}),
			{
				decorate: options.decorateOutbound,
				remoteWorkspacePath: options.remoteWorkspacePath,
				workspacePath: options.workspacePath,
				additionalRedactedPaths: options.additionalRedactedPaths,
			},
		);
		return {
			value: prepared,
			bytes: Buffer.byteLength(serializeJsonLine(prepared), "utf8"),
		};
	};
	let conversationSubscription: ConversationProjectionSubscription | undefined;
	let conversationRetired = false;
	let physicalCloseStarted = false;
	let resolveModeSettled = () => {};
	const modeSettled = new Promise<void>((resolve) => {
		resolveModeSettled = resolve;
	});
	const closePhysicalConversationStream = (): void => {
		if (physicalCloseStarted) {
			return;
		}
		physicalCloseStarted = true;
		try {
			const closeSend = options.stream.send.reset ? options.stream.send.reset(0n) : options.stream.send.finish?.();
			if (closeSend) {
				void Promise.resolve(closeSend).catch(() => {});
			}
		} catch {}
		try {
			const closeRecv = options.stream.recv.stop?.(0n);
			if (closeRecv) {
				void Promise.resolve(closeRecv).catch(() => {});
			}
		} catch {}
	};
	const retireConversation = (error?: Error): void => {
		if (conversationRetired) {
			return;
		}
		// Retirement is the cancellation boundary. Mark it before rejecting feed
		// deliveries so RPC-mode backpressure observes cancellation, not a new
		// transport failure, and can finish independently of a native write promise.
		conversationRetired = true;
		conversationSubscription?.detach();
		closeDeferringTransport.retire(error);
		closePhysicalConversationStream();
	};
	retireConversationStream = retireConversation;
	// Register before runRpcMode installs the close-deferring handler. A natural
	// peer EOF must retire the feed and cancel its delivery promises before RPC
	// shutdown waits for transport backpressure.
	const detachRawCloseRetirement = irohTransport.onClose?.((error) => retireConversation(error)) ?? (() => {});
	const settleDeliveryAfterRetirement = async (delivery: Promise<void>): Promise<void> => {
		try {
			await delivery;
		} catch (error: unknown) {
			if (!conversationRetired) {
				throw error;
			}
		}
	};
	const admitPreparedResponse = (value: object): void => {
		closeDeferringTransport.admitPrepared(value);
	};

	conversationSubscription = runtimeHost.conversationProjectionFeed.attach({
		write: (value) => closeDeferringTransport.writePrepared(value),
		buildSnapshot: options.buildConversationSnapshot,
		projectExternal: options.projectConversationExternal,
		sanitizer: streamProjectionSanitizer,
		prepare: prepareConversationOutbound,
		onDiagnostic: (diagnostic) => {
			console.error(
				`[stream-projection:ordered-conversation] ${diagnostic.code}: ${diagnostic.message}`,
				diagnostic,
			);
		},
		onError: (error) => {
			retireConversation(error);
		},
	});
	if (conversationRetired) {
		conversationSubscription.detach();
	}
	const orderedSubscription = conversationSubscription;
	const enqueueOrderedControl = (value: object): Promise<void> =>
		settleDeliveryAfterRetirement(orderedSubscription.enqueueControl(value, admitPreparedResponse));
	const enqueueOrderedTerminal = (value: object): Promise<void> =>
		settleDeliveryAfterRetirement(orderedSubscription.fenceAndEnqueueTerminal(value, admitPreparedResponse));
	writeOrderedControl = enqueueOrderedControl;
	writeOrderedTerminal = enqueueOrderedTerminal;
	const lifecycle: IrohRemoteConversationLifecycle = {
		write: enqueueOrderedControl,
		async terminate() {
			retireConversation();
			await modeSettled;
		},
	};
	options.onConversationLifecycleReady?.(lifecycle);
	const detachSessionWillProject = options.onSessionWillProject
		? runtimeHost.subscribeSessionWillProject((nextSession) =>
				options.onSessionWillProject?.({
					sessionFile: nextSession.sessionFile,
					sessionId: nextSession.sessionId,
				}),
			)
		: undefined;

	// attach() returns only after the cursor-zero bootstrap owns its immutable
	// FIFO slot. RPC ingress can start at that admission boundary; waiting for
	// ready would couple reads to physical bootstrap delivery and deadlock peer
	// EOF behind a blocked native writer. Feed errors still retire the lifecycle.
	void orderedSubscription.ready.catch(() => {});
	return runRpcMode(runtimeHost, {
		allowUiActionInvocation: true,
		disposeRuntimeOnClose: options.disposeRuntimeOnClose,
		onSessionChanged: async (session) => {
			await options.onSessionChanged?.(session);
			if (!transportClosed) {
				attachLiveActivityUpdates();
			}
		},
		onClientCapabilitiesChanged: options.onClientCapabilitiesChanged,
		onWorkflowEvent: options.onWorkflowEvent,
		requireRemoteSafeUiActions: true,
		transport: remoteHostCommandTransport,
		exitProcess: false,
		registerPushTarget: options.registerPushTarget,
		createStreamProjector: () => new StreamProjector({ sanitizer: streamProjectionSanitizer }),
		orderedConversation: {
			get subscriptionId() {
				return orderedSubscription.subscriptionId;
			},
			enqueueControl: enqueueOrderedControl,
			requestCheckpoint: (requestId) => orderedSubscription.requestCheckpoint(requestId),
			publishExternal: (event) => runtimeHost.publishConversationProjectionEvent(event),
		},
	}).finally(() => {
		transportClosed = true;
		detachSessionWillProject?.();
		detachRawCloseRetirement();
		retireConversation();
		detachLiveActivityUpdates?.();
		resolveModeSettled();
	});
}

interface IrohRemoteTranscriptEventOptions {
	remoteWorkspacePath?: string;
	workspacePath: string;
}

function sanitizeIrohRemoteToolOutputFields(
	value: unknown,
	options: IrohRemoteTranscriptEventOptions,
	hostTruncated = false,
): Record<string, unknown> {
	if (typeof value !== "string" || value.trim().length === 0) {
		return {};
	}
	const sanitized = sanitizeIrohRemoteTranscriptText(value, options, "preserve");
	const scalars = Array.from(sanitized.text);
	const truncated = sanitized.truncated || hostTruncated || scalars.length > IROH_REMOTE_TOOL_OUTPUT_MAX_SCALARS;
	return {
		output:
			scalars.length > IROH_REMOTE_TOOL_OUTPUT_MAX_SCALARS
				? scalars.slice(0, IROH_REMOTE_TOOL_OUTPUT_MAX_SCALARS).join("")
				: sanitized.text,
		outputTruncated: truncated,
	};
}

/**
 * Adds `output`/`outputTruncated` to outbound tool_execution_end frames. The
 * generic outbound filter still sanitizes the whole frame afterwards; the text
 * is pre-sanitized and truncated here so the added field is bounded regardless.
 */
function decorateIrohRemoteToolExecutionEnd(value: object, options: IrohRemoteTranscriptEventOptions): object {
	if (!isRecord(value) || value.type !== "tool_execution_end" || "output" in value) {
		return value;
	}
	const result = value.result;
	if (!isRecord(result)) {
		return value;
	}
	const outputFields = sanitizeIrohRemoteToolOutputFields(extractVisibleTextContent(result.content), options);
	return Object.keys(outputFields).length > 0 ? { ...value, ...outputFields } : value;
}

function attachIrohRemoteLiveActivityUpdates(
	runtimeHost: AgentSessionRuntime,
	delivery: IrohRemotePushNotificationDelivery | undefined,
	workspaceName: string | undefined,
): () => void {
	if (!delivery?.deliverLiveActivityUpdate) {
		return () => {};
	}
	const updater = new IrohRemoteLiveActivityUpdater(runtimeHost, delivery, workspaceName);
	const unsubscribe = runtimeHost.session.subscribe((event) => {
		void updater.handle(event).catch(() => {});
	});
	updater.start();
	return unsubscribe;
}

class IrohRemoteLiveActivityUpdater {
	private readonly delivery: Required<Pick<IrohRemotePushNotificationDelivery, "deliverLiveActivityUpdate">>;
	private readonly runtimeHost: AgentSessionRuntime;
	private readonly workspaceName: string | undefined;
	private readonly toolIndexesByCallId = new Map<string, number>();
	private readonly instanceId = randomUUID();
	private deliveryQueue: Promise<void> = Promise.resolve();
	private recentTools: IrohRemoteLiveActivityToolGlyph[] = [];
	private sequence = 0;
	private active = false;
	private pendingTerminalStatus: "completed" | "failed" | undefined;

	constructor(
		runtimeHost: AgentSessionRuntime,
		delivery: IrohRemotePushNotificationDelivery,
		workspaceName: string | undefined,
	) {
		if (!delivery.deliverLiveActivityUpdate) {
			throw new Error("live activity delivery is unavailable");
		}
		this.runtimeHost = runtimeHost;
		this.delivery = { deliverLiveActivityUpdate: delivery.deliverLiveActivityUpdate.bind(delivery) };
		this.workspaceName = workspaceName;
	}

	start(): void {
		if (!this.runtimeHost.session.isStreaming) {
			return;
		}
		this.active = true;
		void this.sendUpdate("running").catch(() => {});
	}

	async handle(event: AgentSessionEvent): Promise<void> {
		switch (event.type) {
			case "agent_start":
				this.active = true;
				this.pendingTerminalStatus = undefined;
				this.recentTools = [];
				this.toolIndexesByCallId.clear();
				await this.sendUpdate("running");
				break;
			case "tool_execution_start":
				this.active = true;
				if (this.recordTool(event.toolCallId, createLiveActivityToolGlyph(event.toolName, "started"))) {
					await this.sendUpdate("running");
				}
				break;
			case "tool_execution_end":
				this.active = true;
				if (
					this.recordTool(
						event.toolCallId,
						createLiveActivityToolGlyph(event.toolName, event.isError ? "failed" : "completed"),
					)
				) {
					await this.sendUpdate("running");
				}
				break;
			case "agent_end":
				if (!this.active) {
					return;
				}
				this.pendingTerminalStatus = getRunTerminalOutcome(event.messages) === "completed" ? "completed" : "failed";
				break;
			case "agent_settled": {
				if (!this.active || this.pendingTerminalStatus === undefined) {
					return;
				}
				const terminalStatus = this.pendingTerminalStatus;
				// End the old run synchronously so delayed delivery cannot clear state
				// established by a newer agent_start handler.
				this.active = false;
				this.pendingTerminalStatus = undefined;
				this.toolIndexesByCallId.clear();
				await this.sendUpdate(terminalStatus);
				break;
			}
			default:
				break;
		}
	}

	private recordTool(toolCallId: string | undefined, tool: IrohRemoteLiveActivityToolGlyph): boolean {
		const normalizedCallId = typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : undefined;
		if (normalizedCallId) {
			const existingIndex = this.toolIndexesByCallId.get(normalizedCallId);
			if (existingIndex !== undefined && existingIndex < this.recentTools.length) {
				this.recentTools[existingIndex] = tool;
				return true;
			}
		}
		if (this.recentTools.at(-1)?.name === tool.name) {
			return false;
		}
		this.recentTools.push(tool);
		while (this.recentTools.length > 6) {
			this.recentTools.shift();
			for (const [callId, index] of this.toolIndexesByCallId) {
				if (index === 0) {
					this.toolIndexesByCallId.delete(callId);
				} else {
					this.toolIndexesByCallId.set(callId, index - 1);
				}
			}
		}
		if (normalizedCallId) {
			this.toolIndexesByCallId.set(normalizedCallId, this.recentTools.length - 1);
		}
		return true;
	}

	private async sendUpdate(
		status: IrohRemoteLiveActivityContentState["status"],
		activityEvent: "update" | "end" = "update",
	): Promise<void> {
		const nowSeconds = Math.floor(Date.now() / 1000);
		const currentTool = this.recentTools.at(-1);
		const completionState = getIrohRemoteCompletionState(this.runtimeHost);
		const contentState: IrohRemoteLiveActivityContentState = {
			status,
			statusText: liveActivityStatusText(status, currentTool),
			...(currentTool === undefined ? {} : { currentTool }),
			recentTools: this.recentTools.slice(-6),
			sessionID: completionState.sessionId,
			...(this.workspaceName === undefined ? {} : { workspaceName: this.workspaceName }),
			updatedAtEpochSeconds: nowSeconds,
		};
		const update: IrohRemoteLiveActivityUpdateIntent = {
			eventId: `live-activity:${completionState.sessionId}:${completionState.runId ?? "active"}:${this.instanceId}:${++this.sequence}`,
			kind: activityEvent === "end" ? "live_activity_end" : "live_activity_update",
			activityEvent,
			contentState,
			...(activityEvent === "end"
				? { dismissalDateEpochSeconds: nowSeconds + 45 }
				: { staleDateEpochSeconds: nowSeconds + 90 }),
		};
		const delivery = this.deliveryQueue.then(() => this.delivery.deliverLiveActivityUpdate(update));
		this.deliveryQueue = delivery.then(
			() => {},
			() => {},
		);
		await delivery;
	}
}

function createLiveActivityToolGlyph(
	toolName: string | undefined,
	status: IrohRemoteLiveActivityToolGlyph["status"],
): IrohRemoteLiveActivityToolGlyph {
	const name = sanitizeLiveActivityToolName(toolName);
	return {
		name,
		symbolName: liveActivitySymbolNameForTool(name),
		status,
	};
}

function sanitizeLiveActivityToolName(toolName: string | undefined): string {
	const trimmed = toolName?.trim();
	if (!trimmed) {
		return "tool";
	}
	return trimmed.slice(0, 32);
}

export function createIrohRemoteHostCommandRpcTransport(
	options: IrohRemoteHostCommandRpcTransportOptions,
): RpcTransport & { setRpcModeStartupComplete?(startupComplete: boolean): void } {
	let pendingInboundCommand = Promise.resolve();
	const pendingResponseWrites = new Set<Promise<void>>();
	let pendingResponseWriteError: Error | undefined;
	const inboundCommandContext = new AsyncLocalStorage<boolean>();
	const startupAwareTransport = options.transport as {
		setRpcModeStartupComplete?: (startupComplete: boolean) => void;
	};
	const waitForPendingInboundCommand = async (): Promise<void> => {
		// Command handlers themselves call transport backpressure/flush/close.
		// Awaiting their own pending promise would form a cycle; external callers
		// still wait for the full serialized inbound command chain.
		if (inboundCommandContext.getStore() === true) {
			return;
		}
		await pendingInboundCommand;
	};

	const trackResponseWrite = (result: void | Promise<void>): void => {
		if (!result) {
			return;
		}
		const pending = Promise.resolve(result)
			.catch((error: unknown) => {
				pendingResponseWriteError ??= error instanceof Error ? error : new Error(String(error));
			})
			.finally(() => {
				pendingResponseWrites.delete(pending);
			});
		pendingResponseWrites.add(pending);
	};

	const waitForResponseWrites = async (): Promise<void> => {
		while (pendingResponseWrites.size > 0) {
			await Promise.allSettled(pendingResponseWrites);
		}
		if (!pendingResponseWriteError) {
			return;
		}
		const error = pendingResponseWriteError;
		pendingResponseWriteError = undefined;
		throw error;
	};

	const admitResponse = (value: object): void => {
		// Ordered sinks claim their final FIFO slot synchronously. The returned
		// promise is a physical-delivery receipt owned by transport lifecycle
		// methods, never by the serialized input-handler chain.
		trackResponseWrite((options.writeResponse ?? options.transport.write.bind(options.transport))(value));
	};

	const writeHandlerError = (line: string, error: unknown): void => {
		const target = getIrohRemoteRpcErrorTarget(line);
		admitResponse(
			createIrohRemoteRpcErrorResponse(
				target.id,
				target.command,
				error instanceof Error ? error.message : String(error),
			),
		);
	};

	const handleLine = async (line: string, handler: RpcLineHandler): Promise<void> => {
		const command = parseIrohRemoteHostCommandLine(line);
		if (!command) {
			await handler(line);
			return;
		}
		let response: object | undefined;
		let grantStale = false;
		try {
			if (options.isRpcGrantCurrent && !(await options.isRpcGrantCurrent())) {
				grantStale = true;
				const target = getIrohRemoteRpcErrorTarget(line);
				response = createIrohRemoteRpcErrorResponse(target.id, target.command, "RPC grant is stale; reconnect");
			} else {
				response = await options.handleCommand?.(command);
			}
		} catch (error: unknown) {
			writeHandlerError(line, error);
			return;
		}
		if (response === undefined) {
			await handler(line);
			return;
		}
		admitResponse(response);
		if (grantStale) {
			await options.onRpcGrantStale?.();
		}
	};

	return {
		setRpcModeStartupComplete(startupComplete: boolean) {
			startupAwareTransport.setRpcModeStartupComplete?.(startupComplete);
		},
		write(value) {
			return options.transport.write(value);
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine((line) => {
				pendingInboundCommand = pendingInboundCommand.then(
					() => inboundCommandContext.run(true, () => handleLine(line, handler)),
					() => inboundCommandContext.run(true, () => handleLine(line, handler)),
				);
				void pendingInboundCommand.catch(() => {});
				return pendingInboundCommand;
			});
		},
		onClose(handler: RpcCloseHandler): () => void {
			return options.transport.onClose?.(handler) ?? (() => {});
		},
		async waitForBackpressure() {
			await waitForPendingInboundCommand();
			await waitForResponseWrites();
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			await waitForPendingInboundCommand();
			await waitForResponseWrites();
			await options.transport.flush?.();
		},
		async close() {
			await waitForPendingInboundCommand();
			await waitForResponseWrites();
			await options.transport.close();
		},
	};
}

function parseIrohRemoteHostCommandLine(line: string): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.type !== "string") {
		return undefined;
	}
	return parsed;
}

function getIrohRemoteRpcErrorTarget(line: string): { id: string | undefined; command: string } {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed)) {
			return { id: undefined, command: "unknown" };
		}
		return {
			id: typeof parsed.id === "string" ? parsed.id : undefined,
			command: typeof parsed.type === "string" ? parsed.type : "unknown",
		};
	} catch {
		return { id: undefined, command: "parse" };
	}
}

function liveActivityStatusText(
	status: IrohRemoteLiveActivityContentState["status"],
	currentTool: IrohRemoteLiveActivityToolGlyph | undefined,
): string {
	if (status === "completed") {
		return "Volt finished";
	}
	if (status === "failed") {
		return "Volt needs attention";
	}
	if (status === "waiting") {
		return "Waiting for input";
	}
	return currentTool ? `Using ${currentTool.name}` : "Volt is thinking";
}

function liveActivitySymbolNameForTool(toolName: string): string {
	switch (toolName.toLowerCase()) {
		case "read":
			return "doc.text.magnifyingglass";
		case "write":
			return "square.and.pencil";
		case "edit":
			return "pencil.and.outline";
		case "bash":
		case "shell":
		case "terminal":
			return "terminal";
		case "find":
		case "grep":
		case "search":
		case "rg":
			return "magnifyingglass";
		case "lsp":
			return "point.3.connected.trianglepath.dotted";
		case "build":
		case "build_sim":
		case "build_run_sim":
			return "hammer";
		case "test":
		case "test_sim":
			return "checkmark.seal";
		case "screenshot":
		case "snapshot_ui":
			return "camera.viewfinder";
		case "tap":
		case "touch":
		case "gesture":
		case "swipe":
		case "drag":
			return "hand.tap";
		default:
			return "sparkles";
	}
}

export function createIrohRemoteCloseDeferringRpcTransport(
	options: IrohRemoteCloseDeferringRpcTransportOptions,
): IrohRemoteCloseDeferringRpcTransport {
	const pendingCommands = new Set<PendingIrohRemoteCommand>();
	let retired = false;
	let retirementError: Error | undefined;
	let rpcModeStartupComplete = true;
	let startupCompletedPendingCommand = false;
	let startupCleanClosePending = false;
	const retirementCloseHandlers = new Set<(error?: Error) => void>();

	const createPendingCommand = (command: string, id: string | undefined): PendingIrohRemoteCommand => {
		let finished = false;
		let resolveDone = () => {};
		const pending: PendingIrohRemoteCommand = {
			command,
			id,
			initialState: options.getCompletionState?.(),
			done: new Promise<void>((resolve) => {
				resolveDone = resolve;
			}),
			responseMatched: false,
			finish() {
				if (finished) {
					return;
				}
				finished = true;
				pendingCommands.delete(pending);
				if (!rpcModeStartupComplete) {
					startupCompletedPendingCommand = true;
				}
				resolveDone();
			},
		};
		pendingCommands.add(pending);
		return pending;
	};

	const waitForPendingCommands = async (): Promise<void> => {
		while (pendingCommands.size > 0) {
			await Promise.allSettled([...pendingCommands].map((pending) => pending.done));
		}
	};

	const findPendingCommand = (command: string, id: string | undefined): PendingIrohRemoteCommand | undefined => {
		for (const pending of pendingCommands) {
			if (!pending.responseMatched && pending.command === command && pending.id === id) {
				return pending;
			}
		}
		return undefined;
	};

	const trackInboundLine = (line: string): PendingIrohRemoteCommand | undefined => {
		if (retired) {
			return undefined;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return createPendingCommand("parse", undefined);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return createPendingCommand("unknown", undefined);
		}
		const command = parsed as Record<string, unknown>;
		if (typeof command.type !== "string") {
			return createPendingCommand("unknown", typeof command.id === "string" ? command.id : undefined);
		}
		if (command.type === "extension_ui_response" || command.type === "host_action_response") {
			return undefined;
		}
		return createPendingCommand(command.type, typeof command.id === "string" ? command.id : undefined);
	};

	const notifyCompletedCommand = async (
		pending: PendingIrohRemoteCommand,
		response?: Record<string, unknown>,
	): Promise<void> => {
		await options.onCommandCompleted?.({
			command: pending.command,
			id: pending.id,
			initialState: pending.initialState,
			finalState: options.getCompletionState?.(),
			response,
		});
	};

	const finishAfterCommandCompletion = async (
		pending: PendingIrohRemoteCommand,
		response?: Record<string, unknown>,
	): Promise<void> => {
		try {
			await notifyCompletedCommand(pending, response);
		} finally {
			pending.finish();
		}
	};

	const finishAfterPromptCompletion = async (pending: PendingIrohRemoteCommand): Promise<void> => {
		try {
			// Prompt success is emitted just before AgentSession starts the run.
			// Steer/follow_up success means input was accepted into an active session run.
			// Yield once so waitForIdle observes that run or any accepted queued input.
			await Promise.resolve();
			await options.waitForPromptCompletion();
			await notifyCompletedCommand(pending);
		} finally {
			pending.finish();
		}
	};

	const trackOutboundResponse = (value: object): void => {
		const response = value as Record<string, unknown>;
		if (response.type !== "response" || typeof response.command !== "string") {
			return;
		}
		const pending = findPendingCommand(response.command, typeof response.id === "string" ? response.id : undefined);
		if (!pending) {
			return;
		}
		pending.responseMatched = true;
		// The response obligation belongs to the final FIFO once admitted. It must
		// no longer delay clean close while a prior physical write is blocked.
		pending.finish();
		if (response.success === true && shouldWaitForRemoteResponseCompletion(pending.command, response)) {
			void finishAfterPromptCompletion(pending).catch(() => {});
			return;
		}
		if (response.success === true && isCompletedReviewInvocationResponse(pending.command, response)) {
			void finishAfterCommandCompletion(pending, response).catch(() => {});
			return;
		}
	};

	const notifyResponseWritten = async (value: object, writeResult: void | Promise<void>): Promise<void> => {
		await writeResult;
		const response = value as Record<string, unknown>;
		if (response.type !== "response") {
			return;
		}
		await options.onResponseWritten?.(response);
	};

	const transport: IrohRemoteCloseDeferringRpcTransport = {
		setRpcModeStartupComplete(startupComplete) {
			rpcModeStartupComplete = startupComplete;
			if (!rpcModeStartupComplete || !startupCleanClosePending) {
				if (rpcModeStartupComplete) {
					startupCompletedPendingCommand = false;
				}
				return;
			}
			startupCleanClosePending = false;
			startupCompletedPendingCommand = false;
			for (const handler of retirementCloseHandlers) {
				handler();
			}
		},
		write(value) {
			trackOutboundResponse(value);
			const result = options.transport.write(value);
			if (options.onResponseWritten && (value as Record<string, unknown>).type === "response") {
				return notifyResponseWritten(value, result);
			}
			return result;
		},
		admitPrepared(value) {
			trackOutboundResponse(value);
		},
		retire(error) {
			if (retired) {
				return;
			}
			retired = true;
			retirementError = error;
			for (const pending of [...pendingCommands]) {
				pending.finish();
			}
			startupCleanClosePending = false;
			startupCompletedPendingCommand = false;
			for (const handleRetirementClose of [...retirementCloseHandlers]) {
				handleRetirementClose(error);
			}
		},
		writePrepared(value) {
			const result = (options.preparedTransport ?? options.transport).write(value);
			if (options.onResponseWritten && (value as Record<string, unknown>).type === "response") {
				return notifyResponseWritten(value, result);
			}
			return result;
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine(async (line) => {
				const pending = trackInboundLine(line);
				try {
					await handler(line);
				} catch (error: unknown) {
					pending?.finish();
					throw error;
				}
			});
		},
		onClose(handler: RpcCloseHandler): () => void {
			let active = true;
			let delivered = false;
			const deliver = (error?: Error) => {
				if (!active || delivered) {
					return;
				}
				delivered = true;
				handler(error);
			};
			const handleCleanClose = () => {
				void waitForPendingCommands().then(() => {
					deliver();
				});
			};
			const handleRetirementClose = (error?: Error) => {
				if (error) {
					deliver(error);
					return;
				}
				handleCleanClose();
			};
			retirementCloseHandlers.add(handleRetirementClose);
			const detach =
				options.transport.onClose?.((error) => {
					if (!active || delivered) {
						return;
					}
					if (error) {
						deliver(error);
						return;
					}
					if (!rpcModeStartupComplete && (pendingCommands.size > 0 || startupCompletedPendingCommand)) {
						startupCleanClosePending = true;
						return;
					}
					handleCleanClose();
				}) ?? (() => {});
			if (retired) {
				queueMicrotask(() => handleRetirementClose(retirementError));
			}
			return () => {
				active = false;
				retirementCloseHandlers.delete(handleRetirementClose);
				detach();
			};
		},
		async waitForBackpressure() {
			if (retired) {
				return;
			}
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			if (retired) {
				return;
			}
			await options.transport.flush?.();
		},
		close() {
			if (retired) {
				return Promise.resolve();
			}
			return options.transport.close();
		},
	};
	return transport;
}

function getIrohRemoteCompletionState(runtimeHost: AgentSessionRuntime): IrohRemoteCompletionState {
	return {
		sessionId: runtimeHost.session.sessionId,
		runId: runtimeHost.session.sessionManager.getLeafId() ?? undefined,
		terminalOutcome: getRunTerminalOutcome(runtimeHost.session.messages),
	};
}

function createIrohRemoteCompletionNotification(
	completion: IrohRemoteCompletedCommand,
	workspaceName: string | undefined,
): IrohRemoteNotificationRequest | undefined {
	const finalState = getChangedFinalCompletionState(completion);
	if (!finalState) {
		return undefined;
	}
	const workspace = getSafeNotificationWorkspace(workspaceName);
	const workspaceDetails = workspace === undefined ? {} : { workspace };
	if (isConversationCompletionCommand(completion.command)) {
		switch (finalState.terminalOutcome) {
			case "failed":
				return {
					type: "notification_request",
					eventId: `conversation:${finalState.sessionId}:${finalState.runId}:failed`,
					kind: "host_notice",
					title: workspace === undefined ? "Volt needs attention" : `Volt needs attention in ${workspace}`,
					body: "Open Volt to view the error.",
					sessionId: finalState.sessionId,
					...workspaceDetails,
				};
			case "aborted":
				return undefined;
			case "completed":
				return {
					type: "notification_request",
					eventId: `conversation:${finalState.sessionId}:${finalState.runId}:completed`,
					kind: "conversation_completed",
					title: workspace === undefined ? "Volt finished" : `Volt finished in ${workspace}`,
					body: "Your conversation is ready.",
					sessionId: finalState.sessionId,
					...workspaceDetails,
				};
		}
	}
	if (isCompletedReviewInvocationResponse(completion.command, completion.response)) {
		return {
			type: "notification_request",
			eventId: `review:${finalState.sessionId}:${finalState.runId}:completed`,
			kind: "review_completed",
			title: workspace === undefined ? "Review complete" : `Review complete in ${workspace}`,
			body: "Open Volt to see the findings.",
			sessionId: finalState.sessionId,
			...workspaceDetails,
		};
	}
	return undefined;
}

function getSafeNotificationWorkspace(workspaceName: string | undefined): string | undefined {
	if (workspaceName === undefined) {
		return undefined;
	}
	const trimmed = workspaceName.trim();
	if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
		return undefined;
	}
	return trimmed;
}

function getChangedFinalCompletionState(
	completion: IrohRemoteCompletedCommand,
): { sessionId: string; runId: string; terminalOutcome: IrohRemoteRunTerminalOutcome } | undefined {
	const finalState = completion.finalState;
	if (!finalState?.runId) {
		return undefined;
	}
	const initialState = completion.initialState;
	if (initialState?.sessionId === finalState.sessionId && initialState.runId === finalState.runId) {
		return undefined;
	}
	return {
		sessionId: finalState.sessionId,
		runId: finalState.runId,
		terminalOutcome: finalState.terminalOutcome ?? "completed",
	};
}

function getRunTerminalOutcome(messages: readonly AgentMessage[]): IrohRemoteRunTerminalOutcome {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") {
			continue;
		}
		if (message.stopReason === "error") {
			return "failed";
		}
		if (message.stopReason === "aborted") {
			return "aborted";
		}
		return "completed";
	}
	return "completed";
}

function isConversationCompletionCommand(command: string): boolean {
	return command === "prompt" || command === "steer" || command === "follow_up";
}

function shouldWaitForRemoteResponseCompletion(command: string, response: Record<string, unknown>): boolean {
	if (isConversationCompletionCommand(command)) {
		return true;
	}
	if (command !== "invoke_ui_action") {
		return false;
	}
	const data = response.data;
	if (!isRecord(data)) {
		return false;
	}
	return data.status === "accepted" || data.status === "queued";
}

function isCompletedReviewInvocationResponse(
	command: string,
	response: Record<string, unknown> | undefined,
): response is Record<string, unknown> & { data: { action: string; status: "completed" } } {
	if (command !== "invoke_ui_action" || !response) {
		return false;
	}
	const data = response.data;
	if (!isRecord(data)) {
		return false;
	}
	return data.status === "completed" && isReviewActionId(data.action);
}

function isReviewActionId(action: unknown): boolean {
	return action === REVIEW_UNCOMMITTED_ACTION_ID || action === REVIEW_BRANCH_ACTION_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
