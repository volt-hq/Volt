/**
 * What feeds a conversation's live state from its session (RFC §6.1): the
 * run phase, Git and prompt-cache status, token use, the intents whose
 * availability follows the conversation, background jobs, review workflows,
 * the streaming assistant message, running tools, and the MCP server calls
 * they make. Each value is set when it changes; streaming items are published
 * as the session emits them and leave the live state when the entry that
 * commits them is applied (an MCP call, which no entry commits, when it ends).
 */

import type { AssistantMessageEvent } from "@hansjm10/volt-ai";
import type { LiveItem, LiveValue } from "@hansjm10/volt-protocol";
import type { AgentSession, AgentSessionEvent } from "../agent-session.ts";
import { liveIntentAvailability } from "../protocol/intents/state.ts";
import type { LiveToolPartial } from "../protocol/live-fold.ts";
import type { ReviewWorkflowEvent, ReviewWorkflowToolEvent } from "../review.ts";
import { listRpcBackgroundJobs } from "../rpc/background-jobs.ts";
import type { CommittedSessionEntry } from "../session-manager.ts";
import { liveKey } from "./live-state.ts";

type SlimAssistantEvent = Extract<LiveItem, { type: "assistant_delta" }>["event"];
type WorkflowToolStart = Extract<ReviewWorkflowToolEvent, { type: "tool_execution_start" }>;

/** How often background job changes reach the live state at most. */
const JOBS_COALESCE_MS = 100;

/** Entry types whose commit changes what the live `intents` value reads. */
const INTENT_STATE_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"model_change",
	"thinking_level_change",
	"fast_mode_change",
	"planning_state_change",
	"leaf",
]);

export interface LiveFeed {
	/** A review workflow of the conversation reported progress. */
	workflowEvent(event: ReviewWorkflowEvent | ReviewWorkflowToolEvent): void;
	/** Stop feeding; the live state closes with the session. */
	close(): void;
}

const NOOP_FEED: LiveFeed = { workflowEvent() {}, close() {} };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The incremental part of an assistant stream event, without its message snapshot. */
export function slimAssistantEvent(event: AssistantMessageEvent): SlimAssistantEvent | undefined {
	switch (event.type) {
		case "text_start":
			return { type: "text_start", contentIndex: event.contentIndex };
		case "text_delta":
			return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "text_end":
			return { type: "text_end", contentIndex: event.contentIndex, content: event.content };
		case "thinking_start":
			return {
				type: "thinking_start",
				contentIndex: event.contentIndex,
				...(event.redacted === undefined ? {} : { redacted: event.redacted }),
			};
		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "thinking_end":
			return {
				type: "thinking_end",
				contentIndex: event.contentIndex,
				content: event.content,
				...(event.redacted === undefined ? {} : { redacted: event.redacted }),
			};
		case "toolcall_start":
			return { type: "toolcall_start", contentIndex: event.contentIndex, id: event.id, name: event.name };
		case "toolcall_delta":
			return {
				type: "toolcall_delta",
				contentIndex: event.contentIndex,
				argsTextDelta: event.argsTextDelta,
				...(event.id === undefined ? {} : { id: event.id }),
				...(event.name === undefined ? {} : { name: event.name }),
			};
		case "toolcall_end":
			return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: event.toolCall };
		default:
			return undefined;
	}
}

/**
 * The live tool call id of an MCP server call: MCP calls run inside a tool
 * call, and their progress is a tool item of its own.
 */
function mcpCallId(callId: string): string {
	return `mcp_call:${callId}`;
}

/** A tool's partial result as the live lane carries it: its content blocks and details. */
function toolPartial(value: unknown): LiveToolPartial | undefined {
	if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
	const content = value.content.filter(
		(block): block is LiveToolPartial["content"][number] =>
			isRecord(block) && (block.type === "text" || block.type === "image"),
	);
	return { content, ...(value.details === undefined ? {} : { details: value.details }) };
}

function phaseValue(session: AgentSession): LiveValue {
	const run = session.activeAgentRun;
	const compaction = session.activeCompaction;
	const attempt = Number.isSafeInteger(session.retryAttempt) && session.retryAttempt > 0 ? session.retryAttempt : 0;
	const maxAttempts = attempt > 0 ? session.settingsManager.getRetrySettings().maxRetries : 0;
	return {
		kind: "phase",
		busy: session.isBusy,
		operation: session.operation,
		...(run === undefined ? {} : { run }),
		...(compaction === undefined ? {} : { compaction }),
		...(attempt > 0 ? { retry: { attempt, maxAttempts } } : {}),
	};
}

function usageValue(session: AgentSession): LiveValue {
	const stats = session.getSessionStats();
	return {
		kind: "usage",
		tokens: { ...stats.tokens },
		cost: stats.cost,
		...(stats.contextUsage === undefined ? {} : { contextUsage: { ...stats.contextUsage } }),
	};
}

/** Feed `session`'s live state until the returned feed closes. */
export function feedLiveState(session: AgentSession): LiveFeed {
	if (typeof session.subscribe !== "function" || typeof session.subscribeActivity !== "function") return NOOP_FEED;
	const live = session.liveState;
	const published = new Map<string, string>();
	let closed = false;

	/** Set `key` when its value changed; a value the session cannot read now is skipped. */
	const update = (key: string, read: () => LiveValue): void => {
		if (closed) return;
		try {
			const value = read();
			const json = JSON.stringify(value);
			if (published.get(key) === json) return;
			live.set(key, value);
			published.set(key, json);
		} catch {
			// The live state is presentation; a value that cannot be read now is set by its next change.
		}
	};
	const updatePhase = (): void => update("phase", () => phaseValue(session));
	const updateUsage = (): void => update("usage", () => usageValue(session));
	const updateIntents = (): void =>
		update("intents", () => ({ kind: "intents", availability: liveIntentAvailability(session) }));
	const updateJobs = (): void =>
		update("jobs", () => ({ kind: "jobs", jobs: listRpcBackgroundJobs(session.backgroundJobs) }));
	const stream = (items: LiveItem[]): void => {
		if (closed) return;
		try {
			live.stream(items);
		} catch {
			// A stream event that does not fit the live lane is dropped; the committed entry follows.
		}
	};

	const onEvent = (event: AgentSessionEvent): void => {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") stream([{ type: "assistant_start", message: event.message }]);
				return;
			case "message_update": {
				if (event.message.role !== "assistant") return;
				const slim = slimAssistantEvent(event.assistantMessageEvent);
				if (slim) stream([{ type: "assistant_delta", event: slim }]);
				return;
			}
			case "message_end":
				// The committed entry usually ended the stream already.
				if (event.message.role === "assistant" && live.snapshot().assistant) stream([{ type: "assistant_end" }]);
				return;
			case "tool_execution_start":
				stream([
					{
						type: "tool",
						op: "start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						...(isRecord(event.args) ? { args: event.args } : {}),
					},
				]);
				return;
			case "tool_execution_update": {
				const partial = toolPartial(event.partialResult);
				if (partial) {
					stream([
						{ type: "tool", op: "update", toolCallId: event.toolCallId, toolName: event.toolName, partial },
					]);
				}
				return;
			}
			case "tool_execution_end":
				if (!live.snapshot().tools.has(event.toolCallId)) return;
				stream([
					{
						type: "tool",
						op: "end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						isError: event.isError,
					},
				]);
				return;
			case "agent_start":
			case "agent_end":
			case "agent_settled":
			case "auto_retry_start":
			case "auto_retry_end":
			case "compaction_start":
				updatePhase();
				updateIntents();
				return;
			case "compaction_end":
				updatePhase();
				updateIntents();
				updateUsage();
				return;
			case "mcp_call_start":
				stream([
					{
						type: "tool",
						op: "start",
						toolCallId: mcpCallId(event.call.id),
						toolName: "mcp",
						args: { server: event.call.server, tool: event.call.tool },
					},
				]);
				return;
			case "mcp_call_update": {
				if (!live.snapshot().tools.has(mcpCallId(event.call.id))) return;
				const { progress, total, message } = event.progress;
				stream([
					{
						type: "tool",
						op: "update",
						toolCallId: mcpCallId(event.call.id),
						toolName: "mcp",
						partial: {
							content: message === undefined ? [] : [{ type: "text", text: message }],
							details: { progress, ...(total === undefined ? {} : { total }) },
						},
					},
				]);
				return;
			}
			case "mcp_call_end": {
				const toolCallId = mcpCallId(event.call.id);
				if (!live.snapshot().tools.has(toolCallId)) return;
				stream([
					{
						type: "tool",
						op: "end",
						toolCallId,
						toolName: "mcp",
						isError: event.call.status !== "completed",
					},
				]);
				// No result entry commits a nested MCP call: it leaves the streaming state once it ended.
				live.commit({ role: "tool", toolCallId });
				return;
			}
			case "git_context_changed":
				update("git", () => ({ kind: "git", gitContext: event.gitContext }));
				return;
			case "prompt_cache_changed":
				update("prompt_cache", () => ({ kind: "prompt_cache", promptCache: event.promptCache }));
				return;
			case "thinking_level_changed":
			case "planning_state_changed":
			case "ui_action_state_changed":
				updateIntents();
				return;
			default:
				return;
		}
	};

	const onEntry = (entry: CommittedSessionEntry): void => {
		if (closed) return;
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") live.commit({ role: "assistant" });
			else if (message.role === "toolResult") live.commit({ role: "tool", toolCallId: message.toolCallId });
			updateUsage();
		} else if (entry.type === "compaction") {
			updateUsage();
		}
		if (INTENT_STATE_ENTRY_TYPES.has(entry.type)) updateIntents();
	};

	let jobsTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleJobs = (): void => {
		if (jobsTimer !== undefined || closed) return;
		jobsTimer = setTimeout(() => {
			jobsTimer = undefined;
			updateJobs();
		}, JOBS_COALESCE_MS);
		jobsTimer.unref?.();
	};

	/** Running workflows: the latest event and the tools still running. */
	const workflows = new Map<string, { event?: ReviewWorkflowEvent; tools: Map<string, WorkflowToolStart> }>();
	const publishWorkflow = (workflowId: string): void => {
		const workflow = workflows.get(workflowId);
		if (!workflow?.event) return;
		const event = workflow.event;
		update(liveKey("workflow", workflowId), () => ({
			kind: "workflow",
			event,
			activeTools: [...workflow.tools.values()],
		}));
	};

	const unsubscribers: Array<() => void> = [];
	unsubscribers.push(session.subscribe(onEvent, { monitorGitContext: false }));
	unsubscribers.push(session.sessionManager.subscribeEntries(onEntry));
	unsubscribers.push(
		session.subscribeActivity(() => {
			updatePhase();
			updateIntents();
		}),
	);
	unsubscribers.push(session.backgroundJobs.subscribe(scheduleJobs));
	const unsubscribeSettings = session.settingsManager.subscribeCompactionSettings?.(updateIntents);
	if (unsubscribeSettings) unsubscribers.push(unsubscribeSettings);

	updatePhase();
	updateIntents();
	updateUsage();
	updateJobs();
	update("git", () => ({ kind: "git", gitContext: session.gitContextProvider.getSnapshot() }));
	update("prompt_cache", () => ({ kind: "prompt_cache", promptCache: session.getPromptCacheStatus() ?? null }));

	return {
		workflowEvent(event) {
			if (closed) return;
			const workflow = workflows.get(event.workflowId) ?? { tools: new Map<string, WorkflowToolStart>() };
			workflows.set(event.workflowId, workflow);
			switch (event.type) {
				case "tool_execution_start":
					workflow.tools.set(event.toolCallId, event);
					break;
				case "tool_execution_end":
					workflow.tools.delete(event.toolCallId);
					break;
				default:
					workflow.event = event;
			}
			publishWorkflow(event.workflowId);
			if (event.type === "workflow_end") {
				// The final status reaches the clients; nothing of the workflow stays.
				workflows.delete(event.workflowId);
				const key = liveKey("workflow", event.workflowId);
				published.delete(key);
				live.clear(key);
			}
		},
		close() {
			if (closed) return;
			closed = true;
			if (jobsTimer !== undefined) clearTimeout(jobsTimer);
			for (const unsubscribe of unsubscribers.splice(0).reverse()) {
				try {
					unsubscribe();
				} catch {
					// Detaching a passive observer cannot fail the close.
				}
			}
		},
	};
}
