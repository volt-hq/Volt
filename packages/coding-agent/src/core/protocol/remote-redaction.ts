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
 *
 * A patched panel or work item is redacted as a whole value, as a set one is:
 * the redactor folds the raw patch, redacts the patched value, and sends the
 * client the patch from the redacted value it holds to the new one, or the
 * whole value when that is smaller or the two differ beyond the node. A reset
 * carries the patched values. A running tool's presentation is redacted the
 * same way: whole, without image data, within the remote presentation bound
 * (a presentation that does not fit becomes its tool's name only), and sent
 * as a patch from the redacted presentation the client holds when that is
 * smaller.
 */

import { Buffer } from "node:buffer";
import type { AssistantMessage, ToolCall } from "@hansjm10/volt-ai";
import type {
	HostFrame,
	HostRequest,
	HostResponse,
	LiveItem,
	LiveValue,
	ToolPresentation,
	UiNode,
	UiPatchOp,
} from "@hansjm10/volt-protocol";
import {
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
	diffUiTree,
	LIVE_PATCHABLE_KINDS,
	RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES,
	RPC_ACTIVE_TOOL_DETAILS_MAX_SERIALIZED_BYTES,
	WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
} from "@hansjm10/volt-protocol";
import { createIrohRemoteProjectionSanitizer, type IrohRemoteSanitizerOptions } from "../remote/iroh/sanitizer.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../subagents/tool-names.ts";
import { fitPresentation } from "../ui/presentation.ts";
import { presentationChange } from "../ui/presentation-state.ts";
import { redactedWorkPhase } from "../work/phase.ts";
import {
	emptyLiveFold,
	foldLiveCommit,
	foldLiveFrame,
	foldLiveItems,
	type LiveFoldState,
	liveCommitOf,
} from "./live-fold.ts";
import { withoutImages } from "./projection/presentation.ts";
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
	/** Largest tool presentation a client is sent, as serialized JSON in UTF-8 bytes. */
	readonly presentationBytes: number;
}

/** Identifiers the client sent, on the frame that answers it: never rewritten. */
const CLIENT_KEYS: ReadonlySet<string> = new Set(["subscriptionId", "intentId", "queryId"]);
/** Identifiers the client must match exactly: rewritten only when they name a root. */
const HOST_KEYS: ReadonlySet<string> = new Set(["requestId", "connectionId", "toolCallId", "key"]);
/** Identifiers bounding never cuts. */
const PRESERVED_KEYS: ReadonlySet<string> = new Set([...CLIENT_KEYS, ...HOST_KEYS]);

/** Largest value of one keyed live item, in bytes. */
const LIVE_VALUE_MAX_BYTES = 64 * 1024;
const PATCHABLE_KINDS: ReadonlySet<string> = new Set(LIVE_PATCHABLE_KINDS);
const SPAN_KEYS: ReadonlySet<string> = new Set(["text", "token", "bold", "italic", "underline", "code"]);

/** Whether `value` is styled text as spans: `{text, token?, bold?, italic?, underline?, code?}`. */
function isStyledSpans(value: readonly unknown[]): value is ReadonlyArray<{ readonly text: string }> {
	return (
		value.length > 1 &&
		value.every(
			(span) =>
				isRecord(span) && typeof span.text === "string" && Object.keys(span).every((key) => SPAN_KEYS.has(key)),
		)
	);
}

/** The node tree a patch of `value` applies to: a panel's node, or a work item's detail. */
function patchTree(value: LiveValue): UiNode[] | undefined {
	if (value.kind === "ext_panel") return [value.node];
	if (value.kind === "work") return value.detail === undefined ? [] : [value.detail];
	return undefined;
}

/** `value` without the node a patch changes. */
function withoutTree(value: LiveValue): unknown {
	if (value.kind === "ext_panel") return { ...value, node: null };
	if (value.kind === "work") return { ...value, detail: null };
	return value;
}

/**
 * The patch that turns `held` into `next`, both redacted: none when they
 * differ beyond the node a patch changes, or when it is not smaller than
 * `next` itself.
 */
function patchBetween(held: LiveValue, next: LiveValue): UiPatchOp[] | undefined {
	const from = patchTree(held);
	const to = patchTree(next);
	if (from === undefined || to === undefined || held.kind !== next.kind) return undefined;
	if (JSON.stringify(withoutTree(held)) !== JSON.stringify(withoutTree(next))) return undefined;
	const ops = diffUiTree(from, to);
	return jsonBytes(ops) < jsonBytes(next) ? ops : undefined;
}

/** What a sent item did to the value the client holds under a patchable key: what it held before, and after. */
interface HeldChange {
	readonly key: string;
	readonly before: LiveValue | undefined;
	readonly after: LiveValue | undefined;
}

/** What a sent tool item did to the presentation the client holds for its call. */
interface HeldPresentation {
	readonly toolCallId: string;
	readonly before: ToolPresentation | undefined;
	readonly after: ToolPresentation;
}
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
	/** The redacted panels and work items the client holds, by raw key: what the next patch of each starts from. */
	readonly held: Map<string, LiveValue>;
	/** The redacted presentations of running tools the client holds, by tool call id. */
	readonly presentations: Map<string, ToolPresentation>;
}

function newView(basedOn: number): StreamingView {
	return {
		raw: emptyLiveFold(basedOn),
		text: new Map(),
		args: new Map(),
		frozen: new Set(),
		bytes: 0,
		seq: 0,
		held: new Map(),
		presentations: new Map(),
	};
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
		const { presentation: _presentation, patch: _patch, ...rest } = item;
		const redacted = sanitize(rest);
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

	/**
	 * A raw presentation as the client may receive it: redacted whole, image
	 * nodes as their description, and within the presentation bound; one that
	 * does not fit is its tool's name only.
	 */
	const redactPresentation = (presentation: ToolPresentation, toolName: string): ToolPresentation => {
		const redacted = sanitizeUi(presentation);
		const summary = withoutImages(redacted.summary);
		const body = withoutImages(redacted.body);
		const shaped: ToolPresentation = {
			...redacted,
			...(summary === undefined ? {} : { summary }),
			...(body === undefined ? {} : { body }),
		};
		return fitPresentation(shaped, options.presentationBytes) ?? { title: sanitizeText(toolName) };
	};

	/**
	 * A raw tool item, already folded: its own fields redacted, and what it
	 * changed of the call's presentation as a change from the redacted
	 * presentation the client holds.
	 */
	const redactToolItem = (view: StreamingView, item: ToolItem): Sent[] => {
		const base = redactTool(item);
		if (item.presentation === undefined && item.patch === undefined) return [{ item: base }];
		const raw = view.raw.tools.get(item.toolCallId)?.presentation;
		if (raw === undefined) return [{ item: base }];
		const after = redactPresentation(raw, item.toolName);
		// A start replaces whatever the client held for the call.
		const before = item.op === "start" ? undefined : view.presentations.get(item.toolCallId);
		view.presentations.set(item.toolCallId, after);
		const change = presentationChange(before, after);
		return [{ item: { ...base, ...change }, tool: { toolCallId: item.toolCallId, before, after } }];
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

	/**
	 * `value` with each string the host cut (ending in "…") losing the start of
	 * a root the cut left, as UI data the host normalized ends a cut.
	 * Identifiers are never cut.
	 */
	const cutAware = <T>(value: T): T => {
		const visit = (entry: unknown, key: string | undefined): unknown => {
			if (typeof entry === "string") {
				return entry.endsWith("…") && (key === undefined || !PRESERVED_KEYS.has(key))
					? sanitizer.sanitizeCutText(entry)
					: entry;
			}
			if (Array.isArray(entry)) return entry.map((item) => visit(item, key));
			if (!isRecord(entry)) return entry;
			return Object.fromEntries(Object.entries(entry).map(([name, item]) => [name, visit(item, name)]));
		};
		return visit(value, undefined) as T;
	};

	/**
	 * `value` with each run of styled spans whose joined text spells a root, or
	 * ends a cut at the start of one, as one string: styling may split a path
	 * into spans (a dimmed directory, a highlighted match), which redaction must
	 * see whole. Such text loses its styling.
	 */
	const joinRootedSpans = <T>(value: T): T => {
		const visit = (entry: unknown): unknown => {
			if (Array.isArray(entry)) {
				if (isStyledSpans(entry)) {
					const joined = entry.map((span) => span.text).join("");
					const cut = joined.endsWith("…") && sanitizer.rootPrefixSuffix(joined.slice(0, -1)) > 0;
					if (cut || sanitizer.containsRoot(joined)) return joined;
				}
				return entry.map(visit);
			}
			if (!isRecord(entry)) return entry;
			return Object.fromEntries(Object.entries(entry).map(([name, item]) => [name, visit(item)]));
		};
		return visit(value) as T;
	};

	/** Redaction of UI data and other values: roots replaced, also across styled spans, and roots a cut split dropped. */
	const sanitizeUi = <T>(value: T): T => cutAware(sanitize(joinRootedSpans(value)));

	const redactValue = (value: LiveValue): LiveValue | undefined => {
		// Work progress the host cut loses a root's start the cut left; the value keeps the host's bound for it.
		if (value.kind === "work") {
			return redactedWorkPhase(
				value,
				sanitizeUi,
				(text) => sanitizer.sanitizeCutText(text),
				WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
			);
		}
		const redacted = sanitizeUi(value);
		if (redacted.kind === "host_request" && value.kind === "host_request") {
			rememberOptions(value.requestId, value.request, redacted.request);
			return redacted;
		}
		const bounded = boundStrings(redacted, LIVE_VALUE_MAX_BYTES) as LiveValue;
		return jsonBytes(bounded) <= LIVE_VALUE_MAX_BYTES ? bounded : undefined;
	};

	/**
	 * A sent item and, under a patchable key, what it changes of the value the
	 * client holds; for a tool item, what it changes of the call's presentation.
	 */
	type Sent = { readonly item: LiveItem; readonly held?: HeldChange; readonly tool?: HeldPresentation };

	/** Record that the client now holds `after` under `key`. */
	const hold = (view: StreamingView, key: string, after: LiveValue | undefined): HeldChange => {
		const before = view.held.get(key);
		if (after === undefined) view.held.delete(key);
		else view.held.set(key, after);
		return { key, before, after };
	};

	/** A raw patch of `key`, already folded: the redacted patched value, as a patch from what the client holds. */
	const redactPatch = (view: StreamingView, key: string): Sent[] => {
		const raw = view.raw.values.get(key);
		const value = raw === undefined ? undefined : redactValue(raw);
		// A value too large to send: the client keeps what it holds, which the next change starts from.
		if (value === undefined) return [];
		const held = view.held.get(key);
		const ops = held === undefined ? undefined : patchBetween(held, value);
		if (ops !== undefined && ops.length === 0) return [];
		const item: LiveItem =
			ops === undefined ? { type: "set", key: redactKey(key), value } : { type: "patch", key: redactKey(key), ops };
		return [{ item, held: hold(view, key, value) }];
	};

	const redactItem = (view: StreamingView, item: LiveItem): Sent[] => {
		const sent = (items: LiveItem[]): Sent[] => items.map((each) => ({ item: each }));
		switch (item.type) {
			case "assistant_start":
				return sent([{ type: "assistant_start", message: redactMessage(item.message, view) }]);
			case "assistant_delta":
				return sent(redactDelta(view, item.event));
			case "assistant_end":
				return sent([item]);
			case "tool":
				return redactToolItem(view, item);
			case "set": {
				if (item.key.startsWith("host_request/") && item.value.kind !== "host_request") return [];
				const value = redactValue(item.value);
				if (value === undefined) return [];
				const set: LiveItem = { type: "set", key: redactKey(item.key), value };
				return [PATCHABLE_KINDS.has(value.kind) ? { item: set, held: hold(view, item.key, value) } : { item: set }];
			}
			case "clear": {
				if (item.key.startsWith("host_request/")) optionMaps.delete(item.key.slice("host_request/".length));
				const clear: LiveItem = { type: "clear", key: redactKey(item.key) };
				return [view.held.has(item.key) ? { item: clear, held: hold(view, item.key, undefined) } : { item: clear }];
			}
			case "patch":
				return redactPatch(view, item.key);
			case "notice":
				return sent([sanitizeUi(item)]);
			case "directive":
				return sent([sanitize(item)]);
		}
	};

	/**
	 * The sent items within the frame, in order. After an item the frame cannot
	 * carry, later items of the same panel or work item are left out too, and
	 * the value the client holds is what it held before the first of them.
	 */
	const keptItems = (view: StreamingView, sent: Sent[], frame: LiveFrame): LiveItem[] => {
		const fitting = fitLive(
			sent.map((each) => each.item),
			frame,
		);
		const diverged = new Set<string>();
		const divergedTools = new Set<string>();
		const kept: LiveItem[] = [];
		sent.forEach((each, index) => {
			const tool = each.tool;
			if (tool !== undefined && each.item.type === "tool") {
				const fits = fitting.has(index);
				if (!divergedTools.has(tool.toolCallId)) {
					if (fits) {
						view.presentations.set(tool.toolCallId, tool.after);
						kept.push(each.item);
						return;
					}
					// The client keeps what it held: later changes of the call in this frame are left out.
					divergedTools.add(tool.toolCallId);
					if (tool.before === undefined) view.presentations.delete(tool.toolCallId);
					else view.presentations.set(tool.toolCallId, tool.before);
					return;
				}
				const { presentation, patch: _patch, ...rest } = each.item;
				if (fits && presentation !== undefined) {
					// A whole presentation starts over from nothing the client holds.
					divergedTools.delete(tool.toolCallId);
					view.presentations.set(tool.toolCallId, tool.after);
					kept.push(each.item);
				} else if (fits) {
					kept.push(rest);
				}
				return;
			}
			const key = each.held?.key;
			// A later clear or whole value starts over from nothing the client holds: it is sent, and held.
			if (
				key !== undefined &&
				diverged.has(key) &&
				(each.item.type === "clear" || each.item.type === "set") &&
				fitting.has(index)
			) {
				diverged.delete(key);
				const after = each.held?.after;
				if (after === undefined) view.held.delete(key);
				else view.held.set(key, after);
				kept.push(each.item);
				return;
			}
			if (key !== undefined && (diverged.has(key) || !fitting.has(index))) {
				if (!diverged.has(key)) {
					diverged.add(key);
					const before = each.held?.before;
					if (before === undefined) view.held.delete(key);
					else view.held.set(key, before);
				}
				return;
			}
			if (fitting.has(index)) kept.push(each.item);
		});
		return kept;
	};

	const redactLive = (frame: LiveFrame): LiveFrame | undefined => {
		const previous = views.get(frame.subscriptionId);
		const view = previous ?? newView(frame.basedOn);
		views.set(frame.subscriptionId, view);
		if (frame.reset === true || frame.basedOn !== view.raw.basedOn) {
			clearStreaming(view);
			// A client discards running tools, and their presentations, with the streaming state.
			view.presentations.clear();
		}
		if (frame.reset === true) view.held.clear();
		view.raw = foldLiveFrame(view.raw, { basedOn: frame.basedOn, reset: frame.reset, items: [] });
		const sent: Sent[] = [];
		for (const item of frame.items) {
			view.raw = foldLiveItems(view.raw, [item]);
			sent.push(...redactItem(view, item));
		}
		if (sent.length === 0 && frame.reset !== true) return undefined;
		const fitted = keptItems(view, sent, frame);
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

	/** The indexes of the items of a live frame within the frame limit: the largest are left out first. */
	const fitLive = (items: readonly LiveItem[], frame: LiveFrame): Set<number> => {
		const kept = new Set(items.keys());
		const envelope = jsonBytes({ ...frame, items: [] });
		let total = envelope + items.reduce((sum, item) => sum + jsonBytes(item) + 1, 0);
		if (total <= options.frameBytes) return kept;
		const sized = items.map((item, index) => ({ index, bytes: jsonBytes(item) }));
		sized.sort((left, right) => right.bytes - left.bytes);
		for (const entry of sized) {
			if (total <= options.frameBytes) break;
			kept.delete(entry.index);
			total -= entry.bytes + 1;
		}
		return kept;
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
							else view.presentations.delete(commit.toolCallId);
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
