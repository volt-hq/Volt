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
 * base; `message_start` and `message_end` keep full messages.
 *
 * `RpcMessageDeltaDecoder` reconstructs the full documented event shape on the
 * client, so consumers of `RpcClientEvent` keep the in-process contract
 * regardless of what crossed the wire.
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
 * Per-stream outbound projection of AgentSession events. One encoder serves
 * exactly one ordered event stream (a session subscription or one subagent
 * handle); it tracks whether the connected client already holds the
 * accumulator base for the currently streaming assistant message.
 */
export class RpcSessionEventEncoder {
	private deltaBaseSent = false;

	encode(event: object): object {
		if (!isRecord(event)) {
			return event;
		}
		switch (event.type) {
			case "message_start":
				if (isRecord(event.message) && event.message.role === "assistant") {
					// The full (near-empty) partial in this frame is the base.
					this.deltaBaseSent = true;
				}
				return event;
			case "message_end":
				this.deltaBaseSent = false;
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
		if (!this.deltaBaseSent) {
			// No message_start observed on this stream for this message:
			// this frame doubles as the accumulator snapshot.
			this.deltaBaseSent = true;
			return { ...event, assistantMessageEvent: slimEvent };
		}
		if (slimEvent.type === "toolcall_start") {
			// Tool call identity otherwise only exists in the omitted partial;
			// ship the tiny id/name stub so clients can render the pending call.
			const contentIndex = slimEvent.contentIndex;
			const block =
				Array.isArray(message.content) && typeof contentIndex === "number"
					? message.content[contentIndex]
					: undefined;
			if (isRecord(block) && block.type === "toolCall") {
				slimEvent.toolCall = { id: block.id, name: block.name };
			}
		}
		const { message: _message, ...deltaFrame } = event;
		return { ...deltaFrame, assistantMessageEvent: slimEvent };
	}
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
		if (value.type === "subagent_end" && typeof value.subagentId === "string") {
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
				// Terminal run events. Subagents disposed mid-stream never forward a
				// message_end/subagent_end frame, so drop any partial-message
				// accumulator here to keep the streams map bounded. Safe: any later
				// assistant message re-seeds via message_start or a snapshot frame.
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

	/**
	 * Drop accumulated state for a subagent stream whose terminal frames may
	 * never arrive: a client-initiated abort/dispose unsubscribes the server-side
	 * forwarder before the child's message_end/subagent_end can cross the wire.
	 */
	endSubagentStream(subagentId: string): void {
		this.streams.delete(`subagent:${subagentId}`);
	}

	private adopt(key: string, message: Record<string, unknown>): void {
		this.streams.set(key, {
			base: message,
			content: Array.isArray(message.content) ? [...message.content] : [],
			// Unknown mid-stream tool-call argument text cannot be resumed from a
			// parsed snapshot; toolcall_end frames carry the authoritative block.
			argsText: new Map(),
		});
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
