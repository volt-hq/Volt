import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { REVIEW_BRANCH_ACTION_ID, REVIEW_UNCOMMITTED_ACTION_ID } from "../../core/host-actions.ts";
import { type CustomMessage, extractVisibleTextContent } from "../../core/messages.ts";
import {
	createIrohRemoteFilteredRpcTransport,
	createIrohRemoteOutboundDeltaSanitizer,
	createIrohRemoteOutboundFilteredRpcTransport,
	createIrohRemoteRpcErrorResponse,
	type IrohRemoteLiveActivityContentState,
	type IrohRemoteLiveActivityToolGlyph,
	type IrohRemoteLiveActivityUpdateIntent,
	type IrohRemoteOutboundValueDecorator,
	type IrohRemotePushNotificationDelivery,
	type IrohRemoteRpcGrant,
	sanitizeIrohRemoteTranscriptText,
} from "../../core/remote/iroh/index.ts";
import {
	createIrohRpcTransport,
	type IrohRpcTransportOptions,
	type RpcCloseHandler,
	type RpcLineHandler,
	RpcSessionEventEncoder,
	type RpcTranscriptItem,
	type RpcTransport,
} from "../../core/rpc/index.ts";
import { extractMessageImages, projectSessionTranscript } from "../../core/rpc/transcript.ts";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../../core/session-manager.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../../core/subagents/tool-names.ts";
import { type RpcModeOptions, type RpcSessionChange, runRpcMode } from "./rpc-mode.ts";
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
	getCompletionState?: () => IrohRemoteCompletionState;
	onCommandCompleted?: (completion: IrohRemoteCompletedCommand) => void | Promise<void>;
	onResponseWritten?: (response: Record<string, unknown>) => void | Promise<void>;
	waitForPromptCompletion(): Promise<void>;
}

interface IrohRemoteCloseDeferringRpcTransport extends RpcTransport {
	setRpcModeStartupComplete(startupComplete: boolean): void;
}

interface IrohRemoteHostCommandRpcTransportOptions {
	handleCommand?: (command: Record<string, unknown>) => object | Promise<object | undefined> | undefined;
	isRpcGrantCurrent?: () => boolean | Promise<boolean>;
	transport: RpcTransport;
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
	let detachTranscriptEntryEvents: (() => void) | undefined;
	let transportClosed = false;
	const attachLiveActivityUpdates = () => {
		detachLiveActivityUpdates?.();
		detachLiveActivityUpdates = attachIrohRemoteLiveActivityUpdates(
			runtimeHost,
			options.notificationDelivery,
			options.workspaceName,
		);
	};
	const filteredOutboundTransport = createIrohRemoteOutboundFilteredRpcTransport({
		decorate: options.decorateOutbound,
		remoteWorkspacePath: options.remoteWorkspacePath,
		transport: createIrohRpcTransport(options),
		workspacePath: options.workspacePath,
		additionalRedactedPaths: options.additionalRedactedPaths,
		// The session event encoders below derive message_update deltas from
		// sanitized accumulated text; re-sanitizing those fragments in isolation
		// would over-redact and desynchronize client accumulation.
		preSanitizedMessageDeltas: true,
	});
	// The outbound filter sanitizes frames independently, which cannot redact a
	// host path split across delta-only message_update frames; encode streamed
	// deltas from sanitized accumulated text so clients never rebuild a
	// complete raw path.
	const messageDeltaSanitizer = createIrohRemoteOutboundDeltaSanitizer({
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
	const attachTranscriptEntryEvents = () => {
		detachTranscriptEntryEvents?.();
		detachTranscriptEntryEvents = attachIrohRemoteTranscriptEntryEvents(runtimeHost, outboundTransport, {
			remoteWorkspacePath: options.remoteWorkspacePath,
			workspacePath: options.workspacePath,
		});
	};
	attachTranscriptEntryEvents();
	const deliverCompletionNotification = async (notification: IrohRemoteNotificationRequest): Promise<void> => {
		if (options.notificationDelivery) {
			const deliveryStatus = await options.notificationDelivery.deliverNotification(notification);
			if (deliveryStatus === "sent" || deliveryStatus === "duplicate") {
				return;
			}
		}
		await outboundTransport.write(notification);
	};
	const closeDeferringTransport = createIrohRemoteCloseDeferringRpcTransport({
		transport: outboundTransport,
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

	const filteredTransport = createIrohRemoteFilteredRpcTransport({
		transport: closeDeferringTransport,
		rpcGrant: options.rpcGrant,
	});
	const remoteHostCommandTransport =
		options.remoteCommandHandler || options.isRpcGrantCurrent
			? createIrohRemoteHostCommandRpcTransport({
					handleCommand: options.remoteCommandHandler,
					isRpcGrantCurrent: options.isRpcGrantCurrent,
					transport: filteredTransport,
				})
			: filteredTransport;

	return runRpcMode(runtimeHost, {
		allowUiActionInvocation: true,
		disposeRuntimeOnClose: options.disposeRuntimeOnClose,
		onSessionChanged: async (session) => {
			await options.onSessionChanged?.(session);
			if (!transportClosed) {
				attachLiveActivityUpdates();
				attachTranscriptEntryEvents();
			}
		},
		onClientCapabilitiesChanged: options.onClientCapabilitiesChanged,
		onWorkflowEvent: options.onWorkflowEvent,
		requireRemoteSafeUiActions: true,
		transport: remoteHostCommandTransport,
		exitProcess: false,
		registerPushTarget: options.registerPushTarget,
		createSessionEventEncoder: () => new RpcSessionEventEncoder({ deltaSanitizer: messageDeltaSanitizer }),
	}).finally(() => {
		transportClosed = true;
		detachTranscriptEntryEvents?.();
		detachLiveActivityUpdates?.();
	});
}

interface IrohRemoteTranscriptEventOptions {
	remoteWorkspacePath?: string;
	workspacePath: string;
}

function attachIrohRemoteTranscriptEntryEvents(
	runtimeHost: AgentSessionRuntime,
	transport: RpcTransport,
	options: IrohRemoteTranscriptEventOptions,
): () => void {
	const emittedFinalEntryIds = new Set<string>();
	return runtimeHost.session.subscribe((event) => {
		if (event.type !== "message_end") {
			return;
		}
		const message = event.message;
		queueMicrotask(() => {
			const entry = findPersistedMessageEntry(runtimeHost, message);
			if (!entry || emittedFinalEntryIds.has(entry.id)) {
				return;
			}
			const transcriptEvent = createIrohRemoteTranscriptEntryEvent(entry, runtimeHost, options);
			if (!transcriptEvent) {
				return;
			}
			emittedFinalEntryIds.add(entry.id);
			void Promise.resolve()
				.then(() => transport.write(transcriptEvent))
				.catch(() => {});
		});
	});
}

type IrohRemoteTranscriptSourceEntry = SessionMessageEntry | CustomMessageEntry;

interface IrohRemoteStoredToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

function findPersistedMessageEntry(
	runtimeHost: AgentSessionRuntime,
	message: unknown,
): IrohRemoteTranscriptSourceEntry | undefined {
	const branch = runtimeHost.session.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message === message) {
			return entry;
		}
		if (entry.type === "custom_message" && isMatchingReviewCustomMessageEntry(entry, message)) {
			return entry;
		}
	}
	return undefined;
}

function isMatchingReviewCustomMessageEntry(entry: CustomMessageEntry, message: unknown): message is CustomMessage {
	if (entry.customType !== "review" || entry.display !== true || !isReviewCustomMessage(message)) {
		return false;
	}
	return customMessageContentMatches(entry.content, message.content);
}

function isReviewCustomMessage(message: unknown): message is CustomMessage {
	if (typeof message !== "object" || message === null || Array.isArray(message)) {
		return false;
	}
	const candidate = message as Partial<CustomMessage>;
	return candidate.role === "custom" && candidate.customType === "review" && candidate.display === true;
}

function customMessageContentMatches(left: CustomMessageEntry["content"], right: CustomMessage["content"]): boolean {
	if (typeof left === "string" || typeof right === "string") {
		return left === right;
	}
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

function createIrohRemoteTranscriptEntryEvent(
	entry: IrohRemoteTranscriptSourceEntry,
	runtimeHost: AgentSessionRuntime,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, unknown> | undefined {
	const projectedEvent = createIrohRemoteProjectedTranscriptEntryEvent(entry, runtimeHost, options);
	if (projectedEvent) {
		return projectedEvent;
	}

	if (entry.type === "custom_message") {
		if (entry.customType !== "review" || entry.display !== true) {
			return undefined;
		}
		const text = extractVisibleTextContent(entry.content);
		return text ? createIrohRemoteTranscriptEntryEventValue(entry, "assistant", text, options) : undefined;
	}
	const message = entry.message;
	if (message.role === "user" || message.role === "assistant") {
		const text = extractVisibleTextContent(message.content);
		const imageCount = message.role === "user" ? extractMessageImages(message.content).length : 0;
		if (!text && imageCount === 0) {
			return undefined;
		}
		return createIrohRemoteTranscriptEntryEventValue(
			entry,
			message.role,
			text,
			options,
			imageCount > 0 ? { imageCount } : {},
		);
	}
	if (message.role === "toolResult") {
		const status = message.isError ? "failed" : "completed";
		const toolName =
			typeof message.toolName === "string" && message.toolName.trim() ? message.toolName.trim() : "tool";
		const toolCall = collectIrohRemoteToolCalls(runtimeHost.session.sessionManager.getBranch()).get(
			message.toolCallId,
		);
		const imageCount = extractMessageImages(message.content).length;
		return createIrohRemoteTranscriptEntryEventValue(entry, "tool", `${toolName} ${status}`, options, {
			toolName,
			status,
			summary: `${toolName} ${status}`,
			...(toolName === "subagent" || toolName === SUBAGENT_REGISTRY_TOOL_NAME
				? {
						...projectIrohRemoteSubagentTranscriptArgs(toolCall?.arguments, options),
						...projectIrohRemoteSubagentTranscriptDetails(message.details, options),
					}
				: {}),
			...sanitizeIrohRemoteToolOutputFields(extractVisibleTextContent(message.content), options),
			...(imageCount > 0 ? { imageCount } : {}),
		});
	}
	if (message.role === "bashExecution") {
		const failed = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
		const status = failed ? "failed" : "completed";
		const exit = message.cancelled
			? "cancelled"
			: message.exitCode === undefined
				? status
				: `exit ${message.exitCode}`;
		return createIrohRemoteTranscriptEntryEventValue(
			entry,
			"tool",
			`bash ${exit}`,
			options,
			sanitizeIrohRemoteToolOutputFields(message.output, options, message.truncated === true),
		);
	}
	return undefined;
}

function createIrohRemoteProjectedTranscriptEntryEvent(
	entry: IrohRemoteTranscriptSourceEntry,
	runtimeHost: AgentSessionRuntime,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, unknown> | undefined {
	const item = projectSessionTranscript(runtimeHost.session.sessionManager, { limit: 200 }).items.find(
		(transcriptItem) => transcriptItem.id === entry.id,
	);
	if (!item) {
		return undefined;
	}
	return {
		type: "transcript_entry",
		entry: {
			entryId: item.id,
			createdAt: item.timestamp,
			...createIrohRemoteProjectedTranscriptEntryFields(item, options),
			...(item.role === "tool" ? getIrohRemoteToolOutputFields(entry, options) : {}),
		},
		final: true,
	};
}

/** Sanitized, bounded tool result text for a persisted tool transcript entry. */
function getIrohRemoteToolOutputFields(
	entry: IrohRemoteTranscriptSourceEntry,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, unknown> {
	if (entry.type !== "message") {
		return {};
	}
	const message = entry.message;
	if (message.role === "toolResult") {
		return sanitizeIrohRemoteToolOutputFields(extractVisibleTextContent(message.content), options);
	}
	if (message.role === "bashExecution") {
		return sanitizeIrohRemoteToolOutputFields(message.output, options, message.truncated === true);
	}
	return {};
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

function createIrohRemoteProjectedTranscriptEntryFields(
	item: RpcTranscriptItem,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, unknown> {
	if (item.role === "tool") {
		const summary = sanitizeIrohRemoteTranscriptText(item.summary, options, "summary");
		const fields: Record<string, unknown> = {
			role: "tool",
			text: summary.text,
			truncated: summary.truncated,
			toolName: item.toolName,
			status: item.status,
			summary: summary.text,
		};
		if (item.path) {
			fields.path = item.path;
		}
		if (item.args) {
			fields.args = item.args;
		}
		if (item.details) {
			fields.details = item.details;
		}
		if (item.diffPreview) {
			fields.diffPreview = item.diffPreview;
		}
		if (item.patchPreview) {
			fields.patchPreview = item.patchPreview;
		}
		if (item.imageCount) {
			fields.imageCount = item.imageCount;
		}
		return fields;
	}

	const text = sanitizeIrohRemoteTranscriptText(item.text, options);
	const fields: Record<string, unknown> = {
		role: item.role,
		text: text.text,
		truncated: text.truncated,
	};
	if (item.role === "summary") {
		fields.title = item.title;
	}
	if (item.role === "user" && item.imageCount) {
		fields.imageCount = item.imageCount;
	}
	return fields;
}

function createIrohRemoteTranscriptEntryEventValue(
	entry: SessionEntry,
	role: "user" | "assistant" | "system" | "tool",
	text: string,
	options: IrohRemoteTranscriptEventOptions,
	extraEntryFields: Record<string, unknown> = {},
): Record<string, unknown> {
	const sanitized = sanitizeIrohRemoteTranscriptText(text, options, role === "tool" ? "summary" : "preserve");
	return {
		type: "transcript_entry",
		entry: {
			entryId: entry.id,
			createdAt: normalizeIrohRemoteTranscriptTimestamp(entry.timestamp),
			role,
			text: sanitized.text,
			truncated: sanitized.truncated,
			...extraEntryFields,
		},
		final: true,
	};
}

function collectIrohRemoteToolCalls(entries: SessionEntry[]): Map<string, IrohRemoteStoredToolCall> {
	const toolCalls = new Map<string, IrohRemoteStoredToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		for (const block of entry.message.content) {
			if (isIrohRemoteStoredToolCall(block)) {
				toolCalls.set(block.id, block);
			}
		}
	}
	return toolCalls;
}

function isIrohRemoteStoredToolCall(value: unknown): value is IrohRemoteStoredToolCall {
	return (
		isRecord(value) &&
		value.type === "toolCall" &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		isRecord(value.arguments)
	);
}

function projectIrohRemoteSubagentTranscriptArgs(
	args: Record<string, unknown> | undefined,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, unknown> {
	if (!args) {
		return {};
	}
	const projected: Record<string, unknown> = {};
	copyIrohRemoteBoundedString(args, projected, "agent", options, 200);
	copyIrohRemoteBoundedString(args, projected, "task", options, 1_000);
	const tasks = projectIrohRemoteSubagentInputArray(args.tasks, options);
	if (tasks) {
		projected.tasks = tasks;
	}
	const chain = projectIrohRemoteSubagentInputArray(args.chain, options);
	if (chain) {
		projected.chain = chain;
	}
	if (typeof args.list === "boolean") {
		projected.list = args.list;
	}
	const cursor = getIrohRemoteFiniteNumber(args.cursor);
	if (cursor !== undefined) {
		projected.cursor = cursor;
	}
	copyIrohRemoteBoundedString(args, projected, "follow", options, 200);
	return Object.keys(projected).length > 0 ? { args: projected } : {};
}

function projectIrohRemoteSubagentInputArray(
	value: unknown,
	options: IrohRemoteTranscriptEventOptions,
): Array<{ agent: string; task: string }> | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const projected = value
		.map((item) => {
			if (!isRecord(item)) {
				return undefined;
			}
			const agent = getIrohRemoteBoundedString(item.agent, options, 200);
			const task = getIrohRemoteBoundedString(item.task, options, 1_000);
			return agent && task ? { agent, task } : undefined;
		})
		.filter((item): item is { agent: string; task: string } => item !== undefined);
	return projected.length > 0 ? projected : undefined;
}

function projectIrohRemoteSubagentTranscriptDetails(
	details: unknown,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, unknown> {
	if (!isRecord(details)) {
		return {};
	}
	const projected: Record<string, unknown> = {};
	copyIrohRemoteBoundedString(details, projected, "mode", options, 200);
	copyIrohRemoteBoundedString(details, projected, "status", options, 200);
	copyIrohRemoteBoundedString(details, projected, "subagentId", options, 200);
	copyIrohRemoteBoundedString(details, projected, "sessionId", options, 200);
	copyIrohRemoteSubagentNumericDetails(details, projected);
	copyIrohRemoteBoundedString(details, projected, "currentActivity", options, 300);
	const summary = projectIrohRemoteSubagentSummary(details.summary);
	if (summary) {
		projected.summary = summary;
	}
	const childSessions = projectIrohRemoteSubagentDetailArray(details.childSessions, options);
	if (childSessions) {
		projected.childSessions = childSessions;
	}
	const agent = projectIrohRemoteSubagentAgent(details.agent, options);
	if (agent) {
		projected.agent = agent;
	}
	const output = projectIrohRemoteSubagentOutput(details.output, options);
	if (output) {
		projected.output = output;
	}
	const error = projectIrohRemoteSubagentError(details.error, options);
	if (error) {
		projected.error = error;
	}
	const children = projectIrohRemoteSubagentDetailArray(details.children, options);
	if (children) {
		projected.children = children;
	}
	const tasks = projectIrohRemoteSubagentDetailArray(details.tasks, options);
	if (tasks) {
		projected.tasks = tasks;
	}
	const steps = projectIrohRemoteSubagentDetailArray(details.steps, options);
	if (steps) {
		projected.steps = steps;
	}
	return Object.keys(projected).length > 0 ? { details: projected } : {};
}

const IROH_REMOTE_SUBAGENT_NUMERIC_KEYS = ["startedAt", "durationMs", "toolCalls", "tokens"] as const;
const IROH_REMOTE_SUBAGENT_TREE_DEPTH_LIMIT = 5;

function copyIrohRemoteSubagentNumericDetails(from: Record<string, unknown>, to: Record<string, unknown>): void {
	for (const key of IROH_REMOTE_SUBAGENT_NUMERIC_KEYS) {
		const numberValue = getIrohRemoteFiniteNumber(from[key]);
		if (numberValue !== undefined) {
			to[key] = numberValue;
		}
	}
}

function projectIrohRemoteSubagentSummary(value: unknown): Record<string, number> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const projected: Record<string, number> = {};
	for (const key of [
		"total",
		"completed",
		"failed",
		"aborted",
		"running",
		"maxTasks",
		"maxConcurrency",
		"stoppedAt",
		"returned",
		"nextCursor",
		"omittedTasks",
	]) {
		const numberValue = getIrohRemoteFiniteNumber(value[key]);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectIrohRemoteSubagentDetailArray(
	value: unknown,
	options: IrohRemoteTranscriptEventOptions,
	depth = 0,
): Array<Record<string, unknown>> | undefined {
	if (!Array.isArray(value) || depth >= IROH_REMOTE_SUBAGENT_TREE_DEPTH_LIMIT) {
		return undefined;
	}
	const projected = value
		.map((item) => projectIrohRemoteSubagentTask(item, options, depth))
		.filter((item): item is Record<string, unknown> => item !== undefined);
	return projected.length > 0 ? projected : undefined;
}

function projectIrohRemoteSubagentTask(
	value: unknown,
	options: IrohRemoteTranscriptEventOptions,
	depth = 0,
): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const index = getIrohRemoteFiniteNumber(value.index);
	if (index !== undefined) {
		projected.index = index;
	}
	copyIrohRemoteBoundedString(value, projected, "subagentId", options, 200);
	copyIrohRemoteBoundedString(value, projected, "sessionId", options, 200);
	const agent = projectIrohRemoteSubagentAgent(value.agent, options);
	if (agent) {
		projected.agent = agent;
	}
	copyIrohRemoteBoundedString(value, projected, "status", options, 200);
	copyIrohRemoteBoundedString(value, projected, "task", options, 1_000);
	copyIrohRemoteSubagentNumericDetails(value, projected);
	copyIrohRemoteBoundedString(value, projected, "currentActivity", options, 300);
	const error = projectIrohRemoteSubagentError(value.error, options);
	if (error) {
		projected.error = error;
	}
	const children = projectIrohRemoteSubagentDetailArray(value.children, options, depth + 1);
	if (children) {
		projected.children = children;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectIrohRemoteSubagentAgent(
	value: unknown,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const projected: Record<string, string> = {};
	copyIrohRemoteBoundedString(value, projected, "name", options, 200);
	copyIrohRemoteBoundedString(value, projected, "source", options, 200);
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectIrohRemoteSubagentOutput(
	value: unknown,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	copyIrohRemoteBoundedString(value, projected, "text", options, 1_000);
	for (const key of ["bytes", "omittedBytes", "maxBytes"]) {
		const numberValue = getIrohRemoteFiniteNumber(value[key]);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	if (typeof value.truncated === "boolean") {
		projected.truncated = value.truncated;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectIrohRemoteSubagentError(
	value: unknown,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const message = getIrohRemoteBoundedString(value.message, options, 1_000);
	return message ? { message } : undefined;
}

function copyIrohRemoteBoundedString(
	from: Record<string, unknown>,
	to: Record<string, unknown>,
	key: string,
	options: IrohRemoteTranscriptEventOptions,
	maxScalars: number,
): void {
	const value = getIrohRemoteBoundedString(from[key], options, maxScalars);
	if (value) {
		to[key] = value;
	}
}

function getIrohRemoteBoundedString(
	value: unknown,
	options: IrohRemoteTranscriptEventOptions,
	maxScalars: number,
): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}
	return truncateUnicodeScalars(sanitizeIrohRemoteTranscriptText(value, options, "summary").text, maxScalars);
}

function getIrohRemoteFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateUnicodeScalars(value: string, maxLength: number): string {
	const scalars = Array.from(value);
	return scalars.length <= maxLength ? value : scalars.slice(0, maxLength).join("");
}

function normalizeIrohRemoteTranscriptTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
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

	const writeHandlerError = async (line: string, error: unknown): Promise<void> => {
		const target = getIrohRemoteRpcErrorTarget(line);
		await options.transport.write(
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
		try {
			if (options.isRpcGrantCurrent && !(await options.isRpcGrantCurrent())) {
				const target = getIrohRemoteRpcErrorTarget(line);
				response = createIrohRemoteRpcErrorResponse(target.id, target.command, "RPC grant is stale; reconnect");
			} else {
				response = await options.handleCommand?.(command);
			}
		} catch (error: unknown) {
			await writeHandlerError(line, error);
			return;
		}
		if (response === undefined) {
			await handler(line);
			return;
		}
		await options.transport.write(response);
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
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			await waitForPendingInboundCommand();
			await options.transport.flush?.();
		},
		async close() {
			await waitForPendingInboundCommand();
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
): RpcTransport {
	const pendingCommands = new Set<PendingIrohRemoteCommand>();
	let rpcModeStartupComplete = true;
	let startupCompletedPendingCommand = false;
	let startupCleanClosePending = false;
	const startupCleanCloseHandlers = new Set<() => void>();

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
		if (response.success === true && shouldWaitForRemoteResponseCompletion(pending.command, response)) {
			void finishAfterPromptCompletion(pending).catch(() => {});
			return;
		}
		if (response.success === true && isCompletedReviewInvocationResponse(pending.command, response)) {
			void finishAfterCommandCompletion(pending, response).catch(() => {});
			return;
		}
		pending.finish();
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
			for (const handler of startupCleanCloseHandlers) {
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
			const handleCleanClose = () => {
				void waitForPendingCommands().then(() => {
					if (active) {
						handler();
					}
				});
			};
			startupCleanCloseHandlers.add(handleCleanClose);
			const detach =
				options.transport.onClose?.((error) => {
					if (!active) {
						return;
					}
					if (error) {
						handler(error);
						return;
					}
					if (!rpcModeStartupComplete && (pendingCommands.size > 0 || startupCompletedPendingCommand)) {
						startupCleanClosePending = true;
						return;
					}
					handleCleanClose();
				}) ?? (() => {});
			return () => {
				active = false;
				startupCleanCloseHandlers.delete(handleCleanClose);
				detach();
			};
		},
		async waitForBackpressure() {
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			await options.transport.flush?.();
		},
		close() {
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
