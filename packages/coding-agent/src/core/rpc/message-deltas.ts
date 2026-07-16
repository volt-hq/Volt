/**
 * Delta encoding for streamed `message_update` frames (issue #44).
 *
 * In-process `message_update` events carry the full accumulated partial
 * assistant message twice: once as `message` and once as
 * `assistantMessageEvent.partial`. Serializing both per streamed token makes
 * the wire cost quadratic in message length (O(updates x length) per message).
 *
 * On the wire, `message_update` frames are delta-only: the duplicated
 * `assistantMessageEvent.partial` is never serialized, and the accumulated
 * `message` is omitted while the client holds the accumulator base. The first
 * update for a message whose `message_start` was not observed on the same
 * stream (mid-turn attach) carries a full snapshot so clients always have a
 * base. Mid-toolcall snapshots resume deltas from provider argument scratch
 * text when available; otherwise replacement snapshots continue until
 * `toolcall_end`. `message_start` and `message_end` keep full messages.
 *
 * `RpcMessageDeltaDecoder` reconstructs the full documented event shape on the
 * client, so consumers of `RpcClientEvent` keep the in-process contract
 * regardless of what crossed the wire.
 *
 * Transports that redact outbound frames (iroh remote) sanitize each frame
 * independently, which cannot catch a host path split across deltas: the
 * client accumulator would rebuild the raw path. An encoder constructed with a
 * `deltaSanitizer` therefore re-derives wire deltas from sanitized accumulated
 * text and falls back to a full `message` snapshot (an accumulator replacement
 * per the documented protocol) whenever sanitization rewrites text the client
 * already received.
 */

import { parseStreamingJson } from "@hansjm10/volt-ai";
import { extractVisibleTextContent } from "../messages.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove the duplicated accumulated partial from a `message_update` event
 * before it crosses a serialization boundary. Never mutates the input: the
 * event object is shared with in-process listeners that may rely on `partial`.
 */
export function stripAssistantMessageEventPartial(event: unknown): unknown {
	if (!isRecord(event) || event.type !== "message_update") {
		return event;
	}
	const assistantMessageEvent = event.assistantMessageEvent;
	if (!isRecord(assistantMessageEvent) || !("partial" in assistantMessageEvent)) {
		return event;
	}
	const { partial: _partial, ...slimEvent } = assistantMessageEvent;
	return { ...event, assistantMessageEvent: slimEvent };
}

/**
 * Redacts streamed assistant content before it crosses a privacy boundary
 * (the iroh remote transport). `sanitizeText` must be deterministic and match
 * the transport's whole-string sanitization of the same text: the client's
 * delta accumulation has to agree with the sanitized snapshots and
 * `text_end`/`toolcall_end` frames the transport produces.
 */
export interface RpcSessionEventDeltaSanitizer {
	sanitizeText(value: string): string;
	sanitizeToolCallArguments(value: unknown): unknown;
}

export interface RpcSessionEventEncoderOptions {
	deltaSanitizer?: RpcSessionEventDeltaSanitizer;
}

/**
 * Per-stream outbound projection of AgentSession events. One encoder serves
 * exactly one ordered event stream (a session subscription or one subagent
 * handle); it tracks whether the connected client already holds the
 * accumulator base for the currently streaming assistant message.
 */
export class RpcSessionEventEncoder {
	private deltaBaseSent = false;
	private readonly deltaSanitizer: RpcSessionEventDeltaSanitizer | undefined;
	/** Sanitized text/thinking already shipped to the client, per content index. */
	private readonly emittedSanitizedText = new Map<number, string>();
	/** Raw tool-call argument text already shipped, per resumable content index. */
	private readonly resumableToolArgsText = new Map<number, string>();
	/** Mid-toolcall attaches that require replacement snapshots until toolcall_end. */
	private readonly snapshotOnlyToolCallIndexes = new Set<number>();

	constructor(options: RpcSessionEventEncoderOptions = {}) {
		this.deltaSanitizer = options.deltaSanitizer;
	}

	encode(event: object): object {
		if (!isRecord(event)) {
			return event;
		}
		switch (event.type) {
			case "message_start":
				if (isRecord(event.message) && event.message.role === "assistant") {
					// The full (near-empty) partial in this frame is the base.
					this.deltaBaseSent = true;
					this.snapshotOnlyToolCallIndexes.clear();
					this.seedSanitizedState(event.message);
				}
				return event;
			case "message_end":
				this.deltaBaseSent = false;
				this.emittedSanitizedText.clear();
				this.resumableToolArgsText.clear();
				this.snapshotOnlyToolCallIndexes.clear();
				return event;
			case "message_update":
				return this.encodeMessageUpdate(event);
			default:
				return event;
		}
	}

	private encodeMessageUpdate(event: Record<string, unknown>): object {
		const assistantMessageEvent = event.assistantMessageEvent;
		const message = event.message;
		if (!isRecord(assistantMessageEvent) || !isRecord(message)) {
			return event;
		}
		// Never serialize the duplicated accumulated partial.
		const { partial: _partial, ...slimEvent } = assistantMessageEvent;
		if (message.role === "assistant" && slimEvent.type === "text_end") {
			// Visible-text shim consumed by simple clients (kept from the
			// pre-delta protocol).
			slimEvent.message = extractVisibleTextContent(message.content);
		}
		if (message.role !== "assistant") {
			return { ...event, assistantMessageEvent: slimEvent };
		}
		const contentIndex = typeof slimEvent.contentIndex === "number" ? slimEvent.contentIndex : undefined;
		if (!this.deltaBaseSent) {
			// No message_start observed on this stream for this message:
			// this frame doubles as the accumulator snapshot.
			this.deltaBaseSent = true;
			return this.encodeSnapshotFrame(event, slimEvent, message);
		}
		if (
			slimEvent.type === "toolcall_delta" &&
			contentIndex !== undefined &&
			this.snapshotOnlyToolCallIndexes.has(contentIndex)
		) {
			return this.encodeSnapshotFrame(event, slimEvent, message);
		}
		if ((slimEvent.type === "toolcall_start" || slimEvent.type === "toolcall_end") && contentIndex !== undefined) {
			this.snapshotOnlyToolCallIndexes.delete(contentIndex);
		}
		if (this.deltaSanitizer) {
			return this.encodeSanitizedUpdate(this.deltaSanitizer, event, slimEvent, message);
		}
		if (slimEvent.type === "toolcall_start") {
			attachToolCallStub(slimEvent, message);
		}
		return encodeDeltaFrame(event, slimEvent);
	}

	/**
	 * Sanitizer-mode encoding: every emitted delta is the diff between
	 * successive sanitized accumulations, so the client's rebuilt text always
	 * equals the sanitized accumulated text. When sanitization rewrites text the
	 * client already received (a redactable host path completed across deltas),
	 * fall back to a full snapshot frame that the transport sanitizes wholesale.
	 */
	private encodeSanitizedUpdate(
		sanitizer: RpcSessionEventDeltaSanitizer,
		event: Record<string, unknown>,
		slimEvent: Record<string, unknown>,
		message: Record<string, unknown>,
	): object {
		const contentIndex = typeof slimEvent.contentIndex === "number" ? slimEvent.contentIndex : undefined;
		switch (slimEvent.type) {
			case "text_start":
			case "thinking_start":
				if (contentIndex === undefined) {
					return this.encodeSnapshotFrame(event, slimEvent, message);
				}
				this.emittedSanitizedText.set(contentIndex, "");
				return encodeDeltaFrame(event, slimEvent);
			case "text_delta":
			case "thinking_delta": {
				if (contentIndex === undefined) {
					return this.encodeSnapshotFrame(event, slimEvent, message);
				}
				const rawText = getStreamedBlockText(
					message,
					contentIndex,
					slimEvent.type === "text_delta" ? "text" : "thinking",
				);
				const emitted = this.emittedSanitizedText.get(contentIndex);
				if (rawText === undefined || emitted === undefined) {
					return this.encodeSnapshotFrame(event, slimEvent, message);
				}
				const sanitized = sanitizer.sanitizeText(rawText);
				if (!sanitized.startsWith(emitted)) {
					// Redaction rewrote text the client already rendered; replace the
					// accumulator wholesale instead of appending.
					return this.encodeSnapshotFrame(event, slimEvent, message);
				}
				this.emittedSanitizedText.set(contentIndex, sanitized);
				return encodeDeltaFrame(event, { ...slimEvent, delta: sanitized.slice(emitted.length) });
			}
			case "text_end":
			case "thinking_end":
				// The whole-string `content` is sanitized by the outbound transport
				// and is authoritative on the client; resync local state to it.
				if (contentIndex !== undefined && typeof slimEvent.content === "string") {
					this.emittedSanitizedText.set(contentIndex, sanitizer.sanitizeText(slimEvent.content));
				}
				return encodeDeltaFrame(event, slimEvent);
			case "toolcall_start":
				if (contentIndex !== undefined) {
					this.resumableToolArgsText.set(contentIndex, "");
				}
				attachToolCallStub(slimEvent, message);
				return encodeDeltaFrame(event, slimEvent);
			case "toolcall_delta": {
				const emittedArgsText =
					contentIndex === undefined ? undefined : this.resumableToolArgsText.get(contentIndex);
				if (contentIndex === undefined || emittedArgsText === undefined) {
					return this.encodeSnapshotFrame(event, slimEvent, message);
				}
				const rawArgsText = emittedArgsText + (typeof slimEvent.delta === "string" ? slimEvent.delta : "");
				const block = Array.isArray(message.content) ? message.content[contentIndex] : undefined;
				const args = isRecord(block) && block.type === "toolCall" ? block.arguments : undefined;
				// The parsed-arguments check alone is bypassable: parseStreamingJson
				// drops incomplete object keys and yields {} for unparseable text, so a
				// host path can hide in the raw argument text while the parsed args
				// stay sanitization-invariant. Gate raw streaming on the accumulated
				// raw text being sanitization-clean as well.
				if (
					args === undefined ||
					sanitizer.sanitizeText(rawArgsText) !== rawArgsText ||
					!jsonValueEquals(args, sanitizer.sanitizeToolCallArguments(args))
				) {
					// Sanitization changes the accumulated argument text or parsed
					// arguments, so the raw argument JSON cannot ship. Snapshots keep
					// the client's rendered args current until toolcall_end delivers
					// the sanitized block.
					this.resumableToolArgsText.delete(contentIndex);
					return this.encodeSnapshotFrame(event, slimEvent, message);
				}
				this.resumableToolArgsText.set(contentIndex, rawArgsText);
				return encodeDeltaFrame(event, slimEvent);
			}
			case "toolcall_end":
				if (contentIndex !== undefined) {
					this.resumableToolArgsText.delete(contentIndex);
				}
				return encodeDeltaFrame(event, slimEvent);
			default:
				return encodeDeltaFrame(event, slimEvent);
		}
	}

	private encodeSnapshotFrame(
		event: Record<string, unknown>,
		slimEvent: Record<string, unknown>,
		message: Record<string, unknown>,
	): object {
		this.updateSnapshotToolCallState(message);
		if (!this.deltaSanitizer) {
			return { ...event, assistantMessageEvent: slimEvent };
		}
		// The client re-seeds its accumulator (and drops any raw tool-call
		// argument text) from the sanitized snapshot; resync emitted state and
		// blank the raw delta so no unsanitized fragment rides along.
		this.seedSanitizedState(message);
		return {
			...event,
			assistantMessageEvent: typeof slimEvent.delta === "string" ? { ...slimEvent, delta: "" } : slimEvent,
		};
	}

	private updateSnapshotToolCallState(message: Record<string, unknown>): void {
		if (!Array.isArray(message.content)) {
			return;
		}
		for (const [index, block] of message.content.entries()) {
			if (!isRecord(block) || block.type !== "toolCall") {
				continue;
			}
			if (getToolCallArgsText(block) === undefined) {
				// Snapshot adoption discards the decoder's raw prefix. Without a
				// provider scratch prefix, later updates must remain replacements.
				this.snapshotOnlyToolCallIndexes.add(index);
			} else {
				this.snapshotOnlyToolCallIndexes.delete(index);
			}
		}
	}

	private seedSanitizedState(message: Record<string, unknown>): void {
		this.emittedSanitizedText.clear();
		this.resumableToolArgsText.clear();
		const sanitizer = this.deltaSanitizer;
		if (!sanitizer || !Array.isArray(message.content)) {
			return;
		}
		for (const [index, block] of message.content.entries()) {
			if (!isRecord(block)) {
				continue;
			}
			if (block.type === "text" && typeof block.text === "string") {
				this.emittedSanitizedText.set(index, sanitizer.sanitizeText(block.text));
			} else if (block.type === "thinking" && typeof block.thinking === "string") {
				this.emittedSanitizedText.set(index, sanitizer.sanitizeText(block.thinking));
			} else if (block.type === "toolCall") {
				const argsText = getToolCallArgsText(block);
				if (argsText !== undefined) {
					this.resumableToolArgsText.set(index, argsText);
				}
			}
		}
	}
}

function encodeDeltaFrame(event: Record<string, unknown>, slimEvent: Record<string, unknown>): object {
	const { message: _message, ...deltaFrame } = event;
	return { ...deltaFrame, assistantMessageEvent: slimEvent };
}

/**
 * Tool call identity otherwise only exists in the omitted partial; ship the
 * tiny id/name stub so clients can render the pending call.
 */
function attachToolCallStub(slimEvent: Record<string, unknown>, message: Record<string, unknown>): void {
	const contentIndex = slimEvent.contentIndex;
	const block =
		Array.isArray(message.content) && typeof contentIndex === "number" ? message.content[contentIndex] : undefined;
	if (isRecord(block) && block.type === "toolCall") {
		slimEvent.toolCall = { id: block.id, name: block.name };
	}
}

function getToolCallArgsText(block: Record<string, unknown>): string | undefined {
	if (typeof block.partialJson === "string") {
		return block.partialJson;
	}
	return typeof block.partialArgs === "string" ? block.partialArgs : undefined;
}

function getStreamedBlockText(
	message: Record<string, unknown>,
	contentIndex: number,
	kind: "text" | "thinking",
): string | undefined {
	if (!Array.isArray(message.content)) {
		return undefined;
	}
	const block = message.content[contentIndex];
	if (!isRecord(block) || block.type !== kind) {
		return undefined;
	}
	const value = kind === "text" ? block.text : block.thinking;
	return typeof value === "string" ? value : undefined;
}

function jsonValueEquals(left: unknown, right: unknown): boolean {
	if (left === right) {
		return true;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((entry, index) => jsonValueEquals(entry, right[index]))
		);
	}
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left);
		if (leftKeys.length !== Object.keys(right).length) {
			return false;
		}
		return leftKeys.every((key) => Object.hasOwn(right, key) && jsonValueEquals(left[key], right[key]));
	}
	return false;
}

interface MessageDeltaStreamState {
	base: Record<string, unknown>;
	content: unknown[];
	/** Accumulated raw tool-call argument JSON per content index. */
	argsText: Map<number, string>;
}

const SESSION_STREAM_KEY = "session";

/**
 * Client-side accumulator that rebuilds full `message_update` events from
 * delta frames and restores the documented `assistantMessageEvent.partial`
 * reference. Applied to every inbound RPC value; full frames pass through
 * (re-seeding the accumulator) so mixed streams stay correct.
 *
 * Emitted snapshots are copy-on-write: delta application replaces content
 * blocks instead of mutating them, so listeners holding an earlier
 * `message_update` never observe later edits.
 */
export class RpcMessageDeltaDecoder {
	private readonly streams = new Map<string, MessageDeltaStreamState>();

	decode(value: unknown): unknown {
		if (!isRecord(value)) {
			return value;
		}
		if (value.type === "subagent_event" && typeof value.subagentId === "string" && isRecord(value.event)) {
			const key = `subagent:${value.subagentId}`;
			const decoded = this.decodeSessionEvent(value.event, key);
			return decoded === value.event ? value : { ...value, event: decoded };
		}
		if (
			(value.type === "subagent_end" || value.type === "subagent_disposed") &&
			typeof value.subagentId === "string"
		) {
			// Terminal frames for a subagent's stream: subagent_end after the child
			// settles, subagent_disposed whenever the host releases the subagent
			// (abort/dispose commands, failed starts, session rebinds).
			this.streams.delete(`subagent:${value.subagentId}`);
			return value;
		}
		return this.decodeSessionEvent(value, SESSION_STREAM_KEY);
	}

	private decodeSessionEvent(event: Record<string, unknown>, key: string): Record<string, unknown> {
		switch (event.type) {
			case "message_start":
				if (isRecord(event.message) && event.message.role === "assistant") {
					this.adopt(key, event.message);
				}
				return event;
			case "message_end":
				this.streams.delete(key);
				return event;
			case "message_update":
				return this.decodeMessageUpdate(event, key);
			case "agent_end":
			case "agent_settled":
				// Terminal run events. Aborted or failed runs can end without a
				// message_end frame, so drop any partial-message accumulator here to
				// keep the streams map bounded. Safe: any later assistant message
				// re-seeds via message_start or a snapshot frame.
				this.streams.delete(key);
				return event;
			default:
				return event;
		}
	}

	private decodeMessageUpdate(event: Record<string, unknown>, key: string): Record<string, unknown> {
		const assistantMessageEvent = event.assistantMessageEvent;
		if (!isRecord(assistantMessageEvent)) {
			return event;
		}
		const message = event.message;
		if (isRecord(message)) {
			// Full frame (legacy client path or delta snapshot): re-seed the base.
			if (message.role === "assistant") {
				this.adopt(key, message);
				if (
					assistantMessageEvent.type === "toolcall_start" &&
					typeof assistantMessageEvent.contentIndex === "number"
				) {
					// The snapshot landed exactly on a toolcall_start, so the raw
					// argument text for that block is known to be empty. Seed it so
					// subsequent delta-only toolcall_delta frames stream instead of
					// freezing the rendered arguments until toolcall_end.
					this.streams.get(key)?.argsText.set(assistantMessageEvent.contentIndex, "");
				}
			}
			if ("partial" in assistantMessageEvent) {
				return event;
			}
			return { ...event, assistantMessageEvent: { ...assistantMessageEvent, partial: message } };
		}
		const state = this.streams.get(key);
		if (!state) {
			// No accumulator base; the server guarantees a snapshot-first stream,
			// so this only happens on malformed input. Pass through untouched.
			return event;
		}
		this.apply(state, assistantMessageEvent);
		const snapshot = { ...state.base, content: [...state.content] };
		return {
			...event,
			message: snapshot,
			assistantMessageEvent: { ...assistantMessageEvent, partial: snapshot },
		};
	}

	private adopt(key: string, message: Record<string, unknown>): void {
		const content = Array.isArray(message.content) ? [...message.content] : [];
		const argsText = new Map<number, string>();
		for (const [index, block] of content.entries()) {
			if (isRecord(block) && block.type === "toolCall") {
				const rawArgs = getToolCallArgsText(block);
				if (rawArgs !== undefined) {
					argsText.set(index, rawArgs);
				}
			}
		}
		this.streams.set(key, { base: message, content, argsText });
	}

	private apply(state: MessageDeltaStreamState, event: Record<string, unknown>): void {
		const contentIndex = event.contentIndex;
		if (typeof contentIndex !== "number" || !Number.isInteger(contentIndex) || contentIndex < 0) {
			return;
		}
		const content = state.content;
		if (contentIndex > content.length) {
			// Well-formed streams append content blocks contiguously, so an index
			// past the end means malformed or malicious input. Padding to an
			// arbitrary index would let a tiny frame allocate unbounded memory;
			// drop the out-of-range delta instead.
			return;
		}
		const existing = content[contentIndex];
		const delta = typeof event.delta === "string" ? event.delta : "";
		switch (event.type) {
			case "text_start":
				content[contentIndex] = { type: "text", text: "" };
				break;
			case "text_delta":
				content[contentIndex] =
					isRecord(existing) && typeof existing.text === "string"
						? { ...existing, text: existing.text + delta }
						: { type: "text", text: delta };
				break;
			case "text_end":
				content[contentIndex] = {
					...(isRecord(existing) && existing.type === "text" ? existing : { type: "text" }),
					text: typeof event.content === "string" ? event.content : delta,
				};
				break;
			case "thinking_start":
				content[contentIndex] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				content[contentIndex] =
					isRecord(existing) && typeof existing.thinking === "string"
						? { ...existing, thinking: existing.thinking + delta }
						: { type: "thinking", thinking: delta };
				break;
			case "thinking_end":
				content[contentIndex] = {
					...(isRecord(existing) && existing.type === "thinking" ? existing : { type: "thinking" }),
					thinking: typeof event.content === "string" ? event.content : delta,
				};
				break;
			case "toolcall_start": {
				const toolCall = isRecord(event.toolCall) ? event.toolCall : undefined;
				content[contentIndex] = {
					type: "toolCall",
					id: typeof toolCall?.id === "string" ? toolCall.id : "",
					name: typeof toolCall?.name === "string" ? toolCall.name : "",
					arguments: {},
				};
				state.argsText.set(contentIndex, "");
				break;
			}
			case "toolcall_delta": {
				const argsText = state.argsText.get(contentIndex);
				if (argsText === undefined) {
					// Adopted mid-toolcall from a snapshot: raw argument text is
					// unknown, keep the snapshot arguments until toolcall_end.
					break;
				}
				const nextArgsText = argsText + delta;
				state.argsText.set(contentIndex, nextArgsText);
				const block = isRecord(existing) ? existing : { type: "toolCall", id: "", name: "" };
				content[contentIndex] = { ...block, arguments: parseStreamingJson(nextArgsText) };
				break;
			}
			case "toolcall_end":
				if (isRecord(event.toolCall)) {
					content[contentIndex] = event.toolCall;
				}
				state.argsText.delete(contentIndex);
				break;
			default:
				break;
		}
	}
}
