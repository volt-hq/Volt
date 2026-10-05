/**
 * What feeds a conversation's live state from its session (RFC §6.1): the
 * run phase, Git and prompt-cache status, token use, the intents whose
 * availability follows the conversation, the streaming assistant message,
 * running tools, and the MCP server calls they make. Each value is set when
 * it changes; streaming items are published as the session emits them and
 * leave the live state when the entry that commits them is applied (an MCP
 * call, which no entry commits, when it ends). A running call carries its
 * presentation, which changes at most every 100 ms as patches of the one the
 * live state holds (presentation-state.ts).
 */

import type { AssistantMessageEvent } from "@hansjm10/volt-ai";
import type { LiveItem, LiveValue } from "@hansjm10/volt-protocol";
import type { AgentSession, AgentSessionEvent } from "../agent-session.ts";
import { liveIntentAvailability } from "../protocol/intents/state.ts";
import type { LiveToolPartial } from "../protocol/live-fold.ts";
import type { CommittedSessionEntry } from "../session-manager.ts";
import { ToolPresentationState } from "../ui/presentation-state.ts";

type SlimAssistantEvent = Extract<LiveItem, { type: "assistant_delta" }>["event"];

/** Entry types whose commit changes what the live `intents` value reads. */
const INTENT_STATE_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"model_change",
	"thinking_level_change",
	"fast_mode_change",
	"planning_state_change",
	"leaf",
]);

export interface LiveFeed {
	/** Stop feeding; the live state closes with the session. */
	close(): void;
}

const NOOP_FEED: LiveFeed = { close() {} };

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

/** A tool's result as its presenter sees it: its content blocks and details. */
interface ToolResultView {
	readonly content: LiveToolPartial["content"];
	readonly details?: unknown;
}

/**
 * A tool's partial or final result as its presenter sees it. The live lane
 * carries only its content: how the call looks is its presentation.
 */
function toolResult(value: unknown): ToolResultView | undefined {
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
	const stream = (items: LiveItem[]): void => {
		if (closed) return;
		try {
			live.stream(items);
		} catch {
			// A stream event that does not fit the live lane is dropped; the committed entry follows.
		}
	};
	const presentations = new ToolPresentationState({
		presenters: () => session.presenters,
		cwd: () => session.sessionManager.getCwd(),
		held: (toolCallId) => live.snapshot().tools.get(toolCallId)?.presentation,
		update: (toolCallId, toolName, change) => {
			if (!live.snapshot().tools.has(toolCallId)) return;
			stream([{ type: "tool", op: "update", toolCallId, toolName, ...change }]);
		},
	});
	/** End a call: its end item carries what its final result changed of its presentation. */
	const endTool = (toolCallId: string, toolName: string, result: ToolResultView, isError: boolean): void => {
		const held = live.snapshot().tools.get(toolCallId);
		if (!held) {
			presentations.drop(toolCallId);
			return;
		}
		const change = presentations.end(toolCallId, toolName, held.args, { ...result, isError });
		stream([{ type: "tool", op: "end", toolCallId, toolName, isError, ...change }]);
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
			case "tool_execution_start": {
				const args = isRecord(event.args) ? event.args : undefined;
				stream([
					{
						type: "tool",
						op: "start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						...(args === undefined ? {} : { args }),
						presentation: presentations.start(event.toolCallId, event.toolName, args ?? {}),
					},
				]);
				return;
			}
			case "tool_execution_update": {
				const partial = toolResult(event.partialResult);
				if (partial) {
					stream([
						{
							type: "tool",
							op: "update",
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							partial: { content: partial.content },
						},
					]);
					presentations.update(event.toolCallId, partial);
				}
				return;
			}
			case "tool_execution_end":
				endTool(event.toolCallId, event.toolName, toolResult(event.result) ?? { content: [] }, event.isError);
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
			case "mcp_call_start": {
				const toolCallId = mcpCallId(event.call.id);
				const args = { server: event.call.server, tool: event.call.tool };
				stream([
					{
						type: "tool",
						op: "start",
						toolCallId,
						toolName: "mcp",
						args,
						presentation: presentations.start(toolCallId, "mcp", args),
					},
				]);
				return;
			}
			case "mcp_call_update": {
				const toolCallId = mcpCallId(event.call.id);
				if (!live.snapshot().tools.has(toolCallId)) return;
				const { progress, total, message } = event.progress;
				const content: LiveToolPartial["content"] = message === undefined ? [] : [{ type: "text", text: message }];
				stream([{ type: "tool", op: "update", toolCallId, toolName: "mcp", partial: { content } }]);
				presentations.update(toolCallId, {
					content,
					details: { progress, ...(total === undefined ? {} : { total }) },
				});
				return;
			}
			case "mcp_call_end": {
				const toolCallId = mcpCallId(event.call.id);
				const ended = live.snapshot().tools.get(toolCallId);
				endTool(toolCallId, "mcp", { content: ended?.partial?.content ?? [] }, event.call.status !== "completed");
				presentations.drop(toolCallId);
				// No result entry commits a nested MCP call: it leaves the streaming state once it ended.
				if (ended) live.commit({ role: "tool", toolCallId });
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
			case "fast_mode_changed":
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
			else if (message.role === "toolResult") {
				presentations.drop(message.toolCallId);
				live.commit({ role: "tool", toolCallId: message.toolCallId });
			}
			updateUsage();
		} else if (entry.type === "compaction") {
			updateUsage();
		}
		if (INTENT_STATE_ENTRY_TYPES.has(entry.type)) updateIntents();
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
	const unsubscribeSettings = session.settingsManager.subscribeCompactionSettings?.(updateIntents);
	if (unsubscribeSettings) unsubscribers.push(unsubscribeSettings);

	updatePhase();
	updateIntents();
	updateUsage();
	update("git", () => ({ kind: "git", gitContext: session.gitContextProvider.getSnapshot() }));
	update("prompt_cache", () => ({ kind: "prompt_cache", promptCache: session.getPromptCacheStatus() ?? null }));

	return {
		close() {
			if (closed) return;
			closed = true;
			presentations.close();
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
