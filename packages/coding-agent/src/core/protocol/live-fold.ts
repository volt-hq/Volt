/**
 * The live lane's fold (RFC §6.1): a conversation's live state is the fold of
 * its live items, on the host that publishes them and on every client that
 * receives them, so both hold the same state.
 *
 * Keyed values (`set`, `clear`) persist until cleared or reset; a `patch`
 * changes a panel's node or a work item's detail in place, so a reset carries
 * the patched value. Streaming
 * items (the streaming assistant message and running tools) build on the
 * frame's `basedOn` ordinal: a client discards them when a frame arrives with
 * another `basedOn`, or when it applies the entry that commits them. A host
 * that changes `basedOn` while something streams sends the streaming state
 * again first ({@link liveStreamingItems}), so the client's state matches.
 * Notices and directives leave no state.
 */

import { type AssistantMessage, type JsonObject, parseStreamingJson, type ToolCall } from "@hansjm10/volt-ai";
import {
	applyUiPatch,
	type LiveItem,
	type LiveValue,
	type ProjectedEntry,
	type UiNode,
	type UiPatchOp,
} from "@hansjm10/volt-protocol";

type SlimAssistantEvent = Extract<LiveItem, { type: "assistant_delta" }>["event"];
type LiveToolItem = Extract<LiveItem, { type: "tool" }>;
export type LiveToolPartial = NonNullable<LiveToolItem["partial"]>;

/** The streaming assistant message: the start message with every delta since applied. */
export interface LiveStreamingAssistant {
	readonly message: AssistantMessage;
	/** `assistant_end` arrived: the entry that commits the message follows. */
	readonly ended: boolean;
	/** The raw argument text of tool calls still streaming, by content index. */
	readonly argsText: ReadonlyMap<number, string>;
}

/** A running tool: started, with its latest partial result, possibly ended before its result entry. */
export interface LiveStreamingTool {
	readonly toolName: string;
	readonly args?: Record<string, unknown>;
	readonly partial?: LiveToolPartial;
	readonly ended: boolean;
	readonly isError?: boolean;
}

export interface LiveFoldState {
	/** The ordinal the streaming state builds on. */
	readonly basedOn: number;
	/** Keyed values, in the order their keys were first set. */
	readonly values: ReadonlyMap<string, LiveValue>;
	readonly assistant: LiveStreamingAssistant | undefined;
	/** Running tools by tool call id, in start order. */
	readonly tools: ReadonlyMap<string, LiveStreamingTool>;
}

const NO_TOOLS: ReadonlyMap<string, LiveStreamingTool> = new Map();
const NO_VALUES: ReadonlyMap<string, LiveValue> = new Map();

/** A `patch` item that does not apply to the value the fold holds: the holder's state diverged. */
export class LivePatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LivePatchError";
	}
}

/**
 * `value` with `ops` applied to its node: a panel's `node`, which stays one
 * node, or a work item's `detail` (the empty tree without one), which stays
 * at most one node. Throws {@link LivePatchError} when they do not apply.
 */
export function patchLiveValue(value: LiveValue, ops: readonly UiPatchOp[]): LiveValue {
	const apply = (tree: readonly UiNode[]): UiNode[] => {
		try {
			return applyUiPatch(tree, ops);
		} catch (error) {
			throw new LivePatchError(error instanceof Error ? error.message : String(error));
		}
	};
	if (value.kind === "ext_panel") {
		const [node, ...rest] = apply([value.node]);
		if (node === undefined || rest.length > 0) throw new LivePatchError("A panel keeps exactly one node");
		return { ...value, node };
	}
	if (value.kind === "work") {
		const { detail: _detail, ...work } = value;
		const [detail, ...rest] = apply(value.detail === undefined ? [] : [value.detail]);
		if (rest.length > 0) throw new LivePatchError("Work detail is at most one node");
		return detail === undefined ? work : { ...work, detail };
	}
	throw new LivePatchError(`A ${value.kind} value has no node to patch`);
}

/** Nothing live, building on `basedOn`. */
export function emptyLiveFold(basedOn = 0): LiveFoldState {
	return { basedOn, values: NO_VALUES, assistant: undefined, tools: NO_TOOLS };
}

/** Whether a tool call or assistant message streams. */
export function isLiveStreaming(state: LiveFoldState): boolean {
	return state.assistant !== undefined || state.tools.size > 0;
}

/** The state with nothing streaming. */
function withoutStreaming(state: LiveFoldState, basedOn: number): LiveFoldState {
	return { basedOn, values: state.values, assistant: undefined, tools: NO_TOOLS };
}

/**
 * Apply `items` in order; `basedOn` does not change. Throws
 * {@link LivePatchError} for a patch of a value the state does not hold, or
 * one that does not apply to it.
 */
export function foldLiveItems(state: LiveFoldState, items: readonly LiveItem[]): LiveFoldState {
	let values = state.values;
	let ownsValues = false;
	let assistant = state.assistant;
	let tools = state.tools;
	let ownsTools = false;
	const writableValues = (): Map<string, LiveValue> => {
		if (!ownsValues) {
			values = new Map(values);
			ownsValues = true;
		}
		return values as Map<string, LiveValue>;
	};
	const writableTools = (): Map<string, LiveStreamingTool> => {
		if (!ownsTools) {
			tools = new Map(tools);
			ownsTools = true;
		}
		return tools as Map<string, LiveStreamingTool>;
	};
	for (const item of items) {
		switch (item.type) {
			case "set":
				writableValues().set(item.key, item.value);
				break;
			case "clear":
				if (values.has(item.key)) writableValues().delete(item.key);
				break;
			case "patch": {
				const value = values.get(item.key);
				if (value === undefined) throw new LivePatchError(`No live value under ${item.key} to patch`);
				writableValues().set(item.key, patchLiveValue(value, item.ops));
				break;
			}
			case "assistant_start":
				assistant = { message: item.message, ended: false, argsText: new Map() };
				break;
			case "assistant_delta":
				if (assistant) assistant = applyAssistantDelta(assistant, item.event);
				break;
			case "assistant_end":
				if (assistant) assistant = { ...assistant, ended: true };
				break;
			case "tool":
				writableTools().set(item.toolCallId, applyToolItem(tools.get(item.toolCallId), item));
				break;
			default:
				break;
		}
	}
	return { basedOn: state.basedOn, values, assistant, tools };
}

/**
 * A client applying one live frame: a reset replaces the state; a frame with
 * another `basedOn` discards the streaming state first.
 */
export function foldLiveFrame(
	state: LiveFoldState,
	frame: { readonly basedOn: number; readonly reset?: boolean; readonly items: readonly LiveItem[] },
): LiveFoldState {
	const base =
		frame.reset === true
			? emptyLiveFold(frame.basedOn)
			: frame.basedOn === state.basedOn
				? state
				: withoutStreaming(state, frame.basedOn);
	return foldLiveItems(base, frame.items);
}

/** What a committed message entry ends: the streaming assistant message, or one tool call. */
export type LiveCommit = { readonly role: "assistant" } | { readonly role: "tool"; readonly toolCallId: string };

/** The streaming state a projected entry commits, if any. */
export function liveCommitOf(entry: ProjectedEntry): LiveCommit | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.payload?.message;
	if (message) {
		if (message.role === "assistant") return { role: "assistant" };
		if (message.role === "toolResult") return { role: "tool", toolCallId: message.toolCallId };
		return undefined;
	}
	const view = entry.view;
	if (view?.role === "assistant") return { role: "assistant" };
	if (view?.role === "tool" && view.toolCallId !== undefined) return { role: "tool", toolCallId: view.toolCallId };
	return undefined;
}

/** Drop what a committed entry ends from the streaming state. */
export function foldLiveCommit(state: LiveFoldState, commit: LiveCommit | undefined): LiveFoldState {
	if (!commit) return state;
	if (commit.role === "assistant") return state.assistant ? { ...state, assistant: undefined } : state;
	if (!state.tools.has(commit.toolCallId)) return state;
	const tools = new Map(state.tools);
	tools.delete(commit.toolCallId);
	return { ...state, tools };
}

/** Items that rebuild the streaming state on a client that holds none. */
export function liveStreamingItems(state: LiveFoldState): LiveItem[] {
	const items: LiveItem[] = [];
	const assistant = state.assistant;
	if (assistant) {
		items.push({ type: "assistant_start", message: assistant.message });
		for (const [contentIndex, argsText] of assistant.argsText) {
			const block = assistant.message.content[contentIndex];
			if (block?.type !== "toolCall") continue;
			items.push({
				type: "assistant_delta",
				event: { type: "toolcall_start", contentIndex, id: block.id, name: block.name },
			});
			if (argsText.length > 0) {
				items.push({
					type: "assistant_delta",
					event: { type: "toolcall_delta", contentIndex, argsTextDelta: argsText },
				});
			}
		}
		if (assistant.ended) items.push({ type: "assistant_end" });
	}
	for (const [toolCallId, tool] of state.tools) {
		const base = { type: "tool" as const, toolCallId, toolName: tool.toolName };
		items.push({ ...base, op: "start", ...(tool.args === undefined ? {} : { args: tool.args }) });
		if (tool.partial !== undefined) items.push({ ...base, op: "update", partial: tool.partial });
		if (tool.ended)
			items.push({ ...base, op: "end", ...(tool.isError === undefined ? {} : { isError: tool.isError }) });
	}
	return items;
}

/** Items that rebuild the whole state on a client that holds none: the keyed values, then the streaming state. */
export function liveResetItems(state: LiveFoldState): LiveItem[] {
	return [
		...[...state.values].map(([key, value]): LiveItem => ({ type: "set", key, value })),
		...liveStreamingItems(state),
	];
}

function applyToolItem(existing: LiveStreamingTool | undefined, item: LiveToolItem): LiveStreamingTool {
	switch (item.op) {
		case "start":
			return { toolName: item.toolName, ...(item.args === undefined ? {} : { args: item.args }), ended: false };
		case "update": {
			const args = item.args ?? existing?.args;
			const partial = item.partial ?? existing?.partial;
			return {
				toolName: item.toolName,
				...(args === undefined ? {} : { args }),
				...(partial === undefined ? {} : { partial }),
				ended: existing?.ended ?? false,
				...(existing?.isError === undefined ? {} : { isError: existing.isError }),
			};
		}
		case "end": {
			const args = item.args ?? existing?.args;
			const partial = item.partial ?? existing?.partial;
			const isError = item.isError ?? existing?.isError;
			return {
				toolName: item.toolName,
				...(args === undefined ? {} : { args }),
				...(partial === undefined ? {} : { partial }),
				ended: true,
				...(isError === undefined ? {} : { isError }),
			};
		}
	}
}

/** One incremental assistant event applied to the streaming message; an event that does not fit is ignored. */
function applyAssistantDelta(assistant: LiveStreamingAssistant, event: SlimAssistantEvent): LiveStreamingAssistant {
	const index = event.contentIndex;
	if (!Number.isSafeInteger(index) || index < 0 || index > assistant.message.content.length) return assistant;
	const content = [...assistant.message.content];
	const existing = content[index];
	let argsText = assistant.argsText;
	const setArgsText = (text: string | undefined): void => {
		const next = new Map(argsText);
		if (text === undefined) next.delete(index);
		else next.set(index, text);
		argsText = next;
	};
	switch (event.type) {
		case "text_start":
			content[index] = { type: "text", text: "" };
			break;
		case "text_delta":
			if (existing?.type !== "text") return assistant;
			content[index] = { ...existing, text: existing.text + event.delta };
			break;
		case "text_end":
			if (existing?.type !== "text") return assistant;
			content[index] = { ...existing, text: event.content };
			break;
		case "thinking_start":
			content[index] = {
				type: "thinking",
				thinking: "",
				...(event.redacted === undefined ? {} : { redacted: event.redacted }),
			};
			break;
		case "thinking_delta":
			if (existing?.type !== "thinking") return assistant;
			content[index] = { ...existing, thinking: existing.thinking + event.delta };
			break;
		case "thinking_end":
			if (existing?.type !== "thinking") return assistant;
			content[index] = {
				...existing,
				thinking: event.content,
				...(event.redacted === undefined ? {} : { redacted: event.redacted }),
			};
			break;
		case "toolcall_start":
			content[index] = { type: "toolCall", id: event.id, name: event.name, arguments: {} };
			setArgsText("");
			break;
		case "toolcall_delta": {
			const previous = argsText.get(index);
			if (existing?.type !== "toolCall" || previous === undefined) return assistant;
			const text = previous + event.argsTextDelta;
			setArgsText(text);
			content[index] = {
				...existing,
				...(event.id === undefined ? {} : { id: event.id }),
				...(event.name === undefined ? {} : { name: event.name }),
				arguments: parseStreamingJson<JsonObject>(text),
			};
			break;
		}
		case "toolcall_end":
			if (existing?.type !== "toolCall") return assistant;
			content[index] = event.toolCall as ToolCall;
			setArgsText(undefined);
			break;
	}
	return { message: { ...assistant.message, content }, ended: assistant.ended, argsText };
}
