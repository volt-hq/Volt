/**
 * The remote profile's redaction (RFC §6.2): every frame a paired device
 * receives passes through one redactor at the connection's send. It replaces
 * host paths (the workspace or worktree root, the parent checkout, the
 * worktrees root) with the remote workspace path, drops host-local locators
 * and provider signatures, and bounds what can grow without limit.
 *
 * Streaming assistant text is redacted as a whole: the redactor folds the raw
 * live items of each subscription and sends the redacted text the client does
 * not hold yet. A path split across deltas is held back until its token ends,
 * and when redaction rewrites text the client already holds, the streaming
 * message is sent again in full. `seq` is renumbered per subscription, since
 * a frame left empty by redaction is not sent.
 */

import { Buffer } from "node:buffer";
import type { AssistantMessage, ToolCall } from "@hansjm10/volt-ai";
import type { HostFrame, HostRequest, HostResponse, LiveItem, LiveValue } from "@hansjm10/volt-protocol";
import {
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
	RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES,
	RPC_ACTIVE_TOOL_DETAILS_MAX_SERIALIZED_BYTES,
} from "@hansjm10/volt-protocol";
import { createIrohRemoteProjectionSanitizer, type IrohRemoteSanitizerOptions } from "../remote/iroh/sanitizer.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../subagents/tool-names.ts";
import {
	emptyLiveFold,
	foldLiveCommit,
	foldLiveFrame,
	foldLiveItems,
	type LiveFoldState,
	liveCommitOf,
} from "./live-fold.ts";
import { projectSubagentDetails } from "./projection/tool-view.ts";

type LiveFrame = Extract<HostFrame, { type: "live" }>;
type SlimAssistantEvent = Extract<LiveItem, { type: "assistant_delta" }>["event"];
type ToolItem = Extract<LiveItem, { type: "tool" }>;

/** One connection's outbound redaction. */
export interface FrameRedactor {
	/** The frame as the client may see it; none when nothing of it may reach the client. */
	redact(frame: HostFrame): HostFrame | undefined;
	/** A client's answer to a host request, mapped back to the option values the host asked with. */
	response(requestId: string, response: HostResponse): HostResponse;
}

export interface RemoteRedactionOptions extends IrohRemoteSanitizerOptions {
	/** Longest frame, in bytes. */
	readonly frameBytes: number;
	/** Most Unicode scalars of tool output a live tool item carries. */
	readonly textScalars: number;
	/** Most serialized bytes of a streaming assistant message a client is sent in one item. */
	readonly assistantSnapshotBytes: number;
}

/** Identifiers the client sent, on the frame that answers it: never rewritten. */
const CLIENT_KEYS: ReadonlySet<string> = new Set(["subscriptionId", "intentId", "queryId"]);
/** Identifiers the client must match exactly: rewritten only when they name a root. */
const HOST_KEYS: ReadonlySet<string> = new Set(["requestId", "connectionId", "toolCallId", "key"]);
/** Identifiers bounding never cuts. */
const PRESERVED_KEYS: ReadonlySet<string> = new Set([...CLIENT_KEYS, ...HOST_KEYS]);

/** Largest value of one keyed live item, in bytes. */
const LIVE_VALUE_MAX_BYTES = 64 * 1024;
/** Longest background job label after path replacement. */
const JOB_LABEL_MAX_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** Whether a key names a provider signature: `textSignature`, `thinkingSignature`, `thoughtSignature`, `signatureDelta`. */
function isSignatureKey(key: string): boolean {
	return key.endsWith("Signature") || key === "signatureDelta";
}

/** `value` without signature fields, at any depth. */
export function stripSignatures(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripSignatures);
	if (!isRecord(value)) return value;
	const stripped: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isSignatureKey(key)) stripped[key] = stripSignatures(entry);
	}
	return stripped;
}

/** Shorten the longest strings of `value` until it serializes within `maxBytes`. */
function boundStrings(value: unknown, maxBytes: number): unknown {
	if (jsonBytes(value) <= maxBytes) return value;
	let limit = 4_096;
	let bounded = value;
	while (limit >= 16) {
		bounded = truncateStrings(value, limit);
		if (jsonBytes(bounded) <= maxBytes) return bounded;
		limit = Math.floor(limit / 2);
	}
	return bounded;
}

function truncateStrings(value: unknown, limit: number): unknown {
	if (typeof value === "string") {
		if (value.length <= limit) return value;
		return `${Array.from(value).slice(0, limit).join("")}…`;
	}
	if (Array.isArray(value)) return value.map((entry) => truncateStrings(entry, limit));
	if (!isRecord(value)) return value;
	const truncated: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		truncated[key] = PRESERVED_KEYS.has(key) ? entry : truncateStrings(entry, limit);
	}
	return truncated;
}

/** The last `limit` Unicode scalars of `text`. */
function tailScalars(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const scalars = Array.from(text);
	return scalars.length <= limit ? text : scalars.slice(-limit).join("");
}

/**
 * The part of streaming text that is safe to redact now: everything up to the
 * last token when that token may be the start of a path, which the next delta
 * may complete.
 */
function settledPrefix(text: string): string {
	let boundary = -1;
	for (const separator of ["\n", " ", "\t", '"', "'", "`", "(", "<", ">", ","]) {
		boundary = Math.max(boundary, text.lastIndexOf(separator));
	}
	const token = text.slice(boundary + 1);
	if (token.includes("/") || token.includes("\\") || token.startsWith("~") || /^[A-Za-z]:/.test(token)) {
		return text.slice(0, boundary + 1);
	}
	return text;
}

/** What one subscription's client holds of the streaming assistant message, redacted. */
interface StreamingView {
	/** The raw live state the subscription was sent, folded as the client folds it. */
	raw: LiveFoldState;
	/** Redacted text of each text and thinking block the client holds. */
	readonly text: Map<number, string>;
	/** Redacted argument text of each streaming tool call the client holds. */
	readonly args: Map<number, string>;
	/** Blocks no longer streamed: over budget, or not redactable incrementally. The commit brings them. */
	readonly frozen: Set<number>;
	/** Redacted content bytes the client holds of the message. */
	bytes: number;
	/** The last `seq` sent; 0 before the first frame. */
	seq: number;
}

function newView(basedOn: number): StreamingView {
	return { raw: emptyLiveFold(basedOn), text: new Map(), args: new Map(), frozen: new Set(), bytes: 0, seq: 0 };
}

function clearStreaming(view: StreamingView): void {
	view.text.clear();
	view.args.clear();
	view.frozen.clear();
	view.bytes = 0;
}

/** The redactor of one remote connection. */
export function createRemoteRedactor(options: RemoteRedactionOptions): FrameRedactor {
	const sanitizer = createIrohRemoteProjectionSanitizer(options);
	const views = new Map<string, StreamingView>();
	/** Select and form-enum options as sent, mapped to the host's own, by request id. */
	const optionMaps = new Map<string, { select?: Map<string, string>; fields?: Map<string, Map<string, string>> }>();

	const sanitizeText = (text: string): string => sanitizer.sanitizeText(text);
	const sanitize = <T>(value: T): T => {
		const frame = stripSignatures(value);
		return sanitizer.sanitizeValue(
			frame,
			(record, key, entry) =>
				typeof entry === "string" &&
				((CLIENT_KEYS.has(key) && record === frame) || (HOST_KEYS.has(key) && !sanitizer.containsRoot(entry))),
		) as T;
	};

	/** A live key as the client sees it: rewritten the same way each time, so a set and its clear still match. */
	const redactKey = (key: string): string => (sanitizer.containsRoot(key) ? sanitizeText(key) : key);

	/** What streaming `text` may send: no trailing token that may still become a path, nor the start of a root. */
	const settled = (text: string): string => {
		const prefix = settledPrefix(text);
		return prefix.slice(0, prefix.length - sanitizer.rootPrefixSuffix(prefix));
	};

	/** A redacted background job's label within its bound, when path replacement lengthened it. */
	const boundJobLabel = (job: unknown): void => {
		if (isRecord(job) && typeof job.label === "string" && job.label.length > JOB_LABEL_MAX_CHARS) {
			job.label = job.label.slice(0, JOB_LABEL_MAX_CHARS);
		}
	};

	/** A redacted assistant message within the snapshot budget; blocks cut short are frozen. */
	const redactMessage = (message: AssistantMessage, view: StreamingView): AssistantMessage => {
		const redacted = sanitize(message);
		view.text.clear();
		view.frozen.clear();
		view.bytes = 0;
		let budget = Math.min(
			options.assistantSnapshotBytes,
			DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
		);
		const content = redacted.content.map((block, index) => {
			if (block.type !== "text" && block.type !== "thinking") {
				if (block.type === "toolCall") {
					return { ...block, arguments: boundStrings(block.arguments, RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES) };
				}
				return block;
			}
			const text = block.type === "text" ? block.text : block.thinking;
			let kept = text;
			const bytes = Buffer.byteLength(text, "utf8");
			if (bytes > budget) {
				kept = Buffer.from(text, "utf8").subarray(0, Math.max(0, budget)).toString("utf8").replace(/�$/u, "");
				view.frozen.add(index);
			}
			budget = Math.max(0, budget - Buffer.byteLength(kept, "utf8"));
			view.text.set(index, kept);
			view.bytes += Buffer.byteLength(kept, "utf8");
			return block.type === "text" ? { ...block, text: kept } : { ...block, thinking: kept };
		});
		return { ...redacted, content } as AssistantMessage;
	};

	/** Items that rebuild the client's streaming assistant message from the raw state, redacted. */
	const replacement = (view: StreamingView): LiveItem[] => {
		const assistant = view.raw.assistant;
		view.args.clear();
		if (!assistant) {
			clearStreaming(view);
			return [];
		}
		const items: LiveItem[] = [{ type: "assistant_start", message: redactMessage(assistant.message, view) }];
		for (const [contentIndex, argsText] of assistant.argsText) {
			const block = assistant.message.content[contentIndex];
			if (block?.type !== "toolCall") continue;
			items.push({
				type: "assistant_delta",
				event: { type: "toolcall_start", contentIndex, id: block.id, name: block.name },
			});
			const redacted = sanitizeText(settled(argsText));
			view.args.set(contentIndex, redacted);
			if (redacted.length > 0) {
				items.push({
					type: "assistant_delta",
					event: { type: "toolcall_delta", contentIndex, argsTextDelta: redacted },
				});
			}
		}
		if (assistant.ended) items.push({ type: "assistant_end" });
		return items;
	};

	/** The streaming text of a block as the raw state holds it. */
	const rawText = (view: StreamingView, index: number): string | undefined => {
		const block = view.raw.assistant?.message.content[index];
		if (block?.type === "text") return block.text;
		if (block?.type === "thinking") return block.thinking;
		return undefined;
	};

	/** Text the client may append to what it holds, or `undefined` when its text must be replaced. */
	const appendable = (held: string, next: string): string | undefined =>
		next.startsWith(held) ? next.slice(held.length) : undefined;

	const redactDelta = (view: StreamingView, event: SlimAssistantEvent): LiveItem[] => {
		const index = event.contentIndex;
		switch (event.type) {
			case "text_start":
			case "thinking_start":
				view.text.set(index, "");
				view.frozen.delete(index);
				return [{ type: "assistant_delta", event }];
			case "text_delta":
			case "thinking_delta": {
				if (view.frozen.has(index)) return [];
				const raw = rawText(view, index);
				const held = view.text.get(index);
				if (raw === undefined || held === undefined) return [];
				const next = sanitizeText(settled(raw));
				const delta = appendable(held, next);
				if (delta === undefined) return replacement(view);
				if (delta.length === 0) return [];
				const bytes = Buffer.byteLength(delta, "utf8");
				if (view.bytes + bytes > DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES) {
					view.frozen.add(index);
					return [];
				}
				view.bytes += bytes;
				view.text.set(index, next);
				return [{ type: "assistant_delta", event: { type: event.type, contentIndex: index, delta } }];
			}
			case "text_end":
			case "thinking_end": {
				const content = sanitizeText(event.content);
				const held = view.text.get(index) ?? "";
				view.bytes += Math.max(0, Buffer.byteLength(content, "utf8") - Buffer.byteLength(held, "utf8"));
				view.text.set(index, content);
				view.frozen.delete(index);
				return [{ type: "assistant_delta", event: { ...event, content } }];
			}
			case "toolcall_start":
				view.args.set(index, "");
				view.frozen.delete(index);
				return [{ type: "assistant_delta", event: sanitize(event) }];
			case "toolcall_delta": {
				if (view.frozen.has(index)) return [];
				const raw = view.raw.assistant?.argsText.get(index);
				const held = view.args.get(index);
				if (raw === undefined || held === undefined) return [];
				const next = sanitizeText(settled(raw));
				const delta = appendable(held, next);
				if (delta === undefined || view.bytes + delta.length > RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES * 4) {
					// Arguments that redaction rewrites mid-stream arrive whole with the call's end.
					view.frozen.add(index);
					return [];
				}
				if (delta.length === 0) return [];
				view.args.set(index, next);
				view.bytes += Buffer.byteLength(delta, "utf8");
				return [
					{
						type: "assistant_delta",
						event: {
							type: "toolcall_delta",
							contentIndex: index,
							argsTextDelta: delta,
							...(event.id === undefined ? {} : { id: event.id }),
							...(event.name === undefined ? {} : { name: event.name }),
						},
					},
				];
			}
			case "toolcall_end": {
				view.args.delete(index);
				view.frozen.delete(index);
				const toolCall = sanitize(event.toolCall) as ToolCall;
				return [
					{
						type: "assistant_delta",
						event: {
							type: "toolcall_end",
							contentIndex: index,
							toolCall: {
								...toolCall,
								arguments: boundStrings(
									toolCall.arguments,
									RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES,
								) as ToolCall["arguments"],
							},
						},
					},
				];
			}
		}
	};

	const redactTool = (item: ToolItem): ToolItem => {
		const redacted = sanitize(item);
		const subagent = item.toolName === "subagent" || item.toolName === SUBAGENT_REGISTRY_TOOL_NAME;
		const partial = redacted.partial;
		return {
			...redacted,
			...(redacted.args === undefined
				? {}
				: {
						args: boundStrings(redacted.args, RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES) as Record<
							string,
							unknown
						>,
					}),
			...(partial === undefined
				? {}
				: {
						partial: {
							// Images in progress are not sent; the result entry counts them.
							content: partial.content.flatMap((block) =>
								block.type === "text" ? [{ ...block, text: tailScalars(block.text, options.textScalars) }] : [],
							),
							...(partial.details === undefined
								? {}
								: {
										details: subagent
											? projectSubagentDetails(isRecord(partial.details) ? partial.details : undefined)
											: boundStrings(partial.details, RPC_ACTIVE_TOOL_DETAILS_MAX_SERIALIZED_BYTES),
									}),
						},
					}),
		};
	};

	/** Remember how option values were redacted, so an answer maps back to the host's values. */
	const rememberOptions = (requestId: string, request: HostRequest, sent: HostRequest): void => {
		/** Sent value to host value, for values redaction changed; values sent twice stay as sent. */
		const pairs = (raw: readonly string[], redacted: readonly string[]): Map<string, string> | undefined => {
			const counts = new Map<string, number>();
			for (const value of redacted) counts.set(value, (counts.get(value) ?? 0) + 1);
			const map = new Map<string, string>();
			raw.forEach((value, index) => {
				const sent = redacted[index];
				if (sent !== undefined && sent !== value && counts.get(sent) === 1) map.set(sent, value);
			});
			return map.size > 0 ? map : undefined;
		};
		if (request.kind === "select" && sent.kind === "select") {
			const select = pairs(request.options, sent.options);
			if (select) optionMaps.set(requestId, { select });
		} else if (request.kind === "form" && sent.kind === "form") {
			const fields = new Map<string, Map<string, string>>();
			request.fields.forEach((field, index) => {
				const sentField = sent.fields[index];
				if (field.kind !== "enum" || sentField?.kind !== "enum") return;
				const map = pairs(
					field.options.map((option) => option.value),
					sentField.options.map((option) => option.value),
				);
				if (map) fields.set(field.id, map);
			});
			if (fields.size > 0) optionMaps.set(requestId, { fields });
		}
	};

	const redactValue = (value: LiveValue): LiveValue | undefined => {
		const redacted = sanitize(value);
		if (redacted.kind === "host_request" && value.kind === "host_request") {
			rememberOptions(value.requestId, value.request, redacted.request);
			return redacted;
		}
		if (redacted.kind === "jobs") for (const job of redacted.jobs) boundJobLabel(job);
		const bounded = boundStrings(redacted, LIVE_VALUE_MAX_BYTES) as LiveValue;
		return jsonBytes(bounded) <= LIVE_VALUE_MAX_BYTES ? bounded : undefined;
	};

	const redactItem = (view: StreamingView, item: LiveItem): LiveItem[] => {
		switch (item.type) {
			case "assistant_start":
				return [{ type: "assistant_start", message: redactMessage(item.message, view) }];
			case "assistant_delta":
				return redactDelta(view, item.event);
			case "assistant_end":
				return [item];
			case "tool":
				return [redactTool(item)];
			case "set": {
				if (item.key.startsWith("host_request/") && item.value.kind !== "host_request") return [];
				const value = redactValue(item.value);
				return value === undefined ? [] : [{ type: "set", key: redactKey(item.key), value }];
			}
			case "clear":
				if (item.key.startsWith("host_request/")) optionMaps.delete(item.key.slice("host_request/".length));
				return [{ type: "clear", key: redactKey(item.key) }];
			case "notice":
			case "directive":
				return [sanitize(item)];
		}
	};

	const redactLive = (frame: LiveFrame): LiveFrame | undefined => {
		const previous = views.get(frame.subscriptionId);
		const view = previous ?? newView(frame.basedOn);
		views.set(frame.subscriptionId, view);
		if (frame.reset === true || frame.basedOn !== view.raw.basedOn) clearStreaming(view);
		view.raw = foldLiveFrame(view.raw, { basedOn: frame.basedOn, reset: frame.reset, items: [] });
		const items: LiveItem[] = [];
		for (const item of frame.items) {
			view.raw = foldLiveItems(view.raw, [item]);
			items.push(...redactItem(view, item));
		}
		if (items.length === 0 && frame.reset !== true) return undefined;
		const fitted = fitLive(items, frame);
		view.seq = frame.reset === true ? 1 : view.seq + 1;
		return {
			type: "live",
			subscriptionId: frame.subscriptionId,
			basedOn: frame.basedOn,
			seq: view.seq,
			...(frame.reset === true ? { reset: true } : {}),
			items: fitted,
		};
	};

	/** Items of a live frame within the frame limit: the largest are left out first. */
	const fitLive = (items: LiveItem[], frame: LiveFrame): LiveItem[] => {
		const envelope = jsonBytes({ ...frame, items: [] });
		let total = envelope + items.reduce((sum, item) => sum + jsonBytes(item) + 1, 0);
		if (total <= options.frameBytes) return items;
		const sized = items.map((item, index) => ({ index, bytes: jsonBytes(item) }));
		sized.sort((left, right) => right.bytes - left.bytes);
		const dropped = new Set<number>();
		for (const entry of sized) {
			if (total <= options.frameBytes) break;
			dropped.add(entry.index);
			total -= entry.bytes + 1;
		}
		return items.filter((_item, index) => !dropped.has(index));
	};

	const fits = (frame: HostFrame): boolean => jsonBytes(frame) <= options.frameBytes;

	return {
		redact(frame) {
			switch (frame.type) {
				case "live":
					return redactLive(frame);
				case "entry": {
					const view = views.get(frame.subscriptionId);
					if (view) {
						const commit = liveCommitOf(frame.entry);
						if (commit) {
							view.raw = foldLiveCommit(view.raw, commit);
							if (commit.role === "assistant") clearStreaming(view);
						}
					}
					const redacted = sanitize(frame);
					// An entry that cannot fit is skipped: the client's position covers it.
					return fits(redacted)
						? redacted
						: { type: "head", subscriptionId: frame.subscriptionId, ordinal: frame.entry.ordinal };
				}
				case "snapshot": {
					views.delete(frame.subscriptionId);
					let redacted = sanitize(frame);
					while (!fits(redacted) && redacted.state.entries.length > 0) {
						const entries = redacted.state.entries.slice(Math.ceil(redacted.state.entries.length / 4));
						redacted = { ...redacted, state: { ...redacted.state, entries, earlier: true } };
					}
					return redacted;
				}
				case "ended":
					views.delete(frame.subscriptionId);
					return sanitize(frame);
				case "result": {
					const redacted = sanitize(frame);
					// `job_output`'s job.
					if (isRecord(redacted.data)) boundJobLabel(redacted.data.job);
					return fits(redacted)
						? redacted
						: {
								type: "query_error",
								queryId: frame.queryId,
								reason: { code: "failed", message: "The result is larger than a frame" },
							};
				}
				case "accepted": {
					const redacted = sanitize(frame);
					// `cancel_job`'s job.
					if (isRecord(redacted.result)) boundJobLabel(redacted.result.job);
					if (fits(redacted)) return redacted;
					const { result: _result, ...rest } = redacted;
					return rest;
				}
				default:
					return sanitize(frame);
			}
		},
		response(requestId, response) {
			const maps = optionMaps.get(requestId);
			if (!maps) return response;
			if ("value" in response && maps.select) {
				const value = maps.select.get(response.value);
				return value === undefined ? response : { value };
			}
			if ("values" in response && maps.fields) {
				const values: Record<string, string | boolean | number> = { ...response.values };
				for (const [field, map] of maps.fields) {
					const sent = values[field];
					if (typeof sent === "string" && map.has(sent)) values[field] = map.get(sent)!;
				}
				return { values };
			}
			return response;
		},
	};
}

/** The local profile's redactor: every frame as it is. */
export const IDENTITY_REDACTOR: FrameRedactor = Object.freeze({
	redact: (frame: HostFrame) => frame,
	response: (_requestId: string, response: HostResponse) => response,
});
