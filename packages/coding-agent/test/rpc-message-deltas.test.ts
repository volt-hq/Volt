import { resolve, sep } from "node:path";
import { parseStreamingJson } from "@hansjm10/volt-ai";
import { describe, expect, test } from "vitest";
import {
	createIrohRemoteOutboundDeltaSanitizer,
	sanitizeIrohRemoteOutbound,
} from "../src/core/remote/iroh/outbound-filter.ts";
import {
	RpcMessageDeltaDecoder,
	RpcSessionEventEncoder,
	stripAssistantMessageEventPartial,
} from "../src/core/rpc/message-deltas.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantPartial(content: unknown[]): Record<string, unknown> {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		stopReason: "stop",
		timestamp: 0,
	};
}

function messageUpdate(message: Record<string, unknown>, assistantMessageEvent: Record<string, unknown>): object {
	return { type: "message_update", message, assistantMessageEvent: { ...assistantMessageEvent, partial: message } };
}

function getContent(value: unknown): unknown[] {
	if (!isRecord(value) || !Array.isArray(value.content)) {
		throw new Error("Expected a message with content array");
	}
	return value.content;
}

function getRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error("Expected a record");
	}
	return value;
}

describe("stripAssistantMessageEventPartial", () => {
	test("removes partial without mutating the in-process event", () => {
		const partial = assistantPartial([{ type: "text", text: "hi" }]);
		const event = messageUpdate(partial, { type: "text_delta", contentIndex: 0, delta: "hi" });
		const stripped = getRecord(stripAssistantMessageEventPartial(event));
		expect("partial" in getRecord(stripped.assistantMessageEvent)).toBe(false);
		expect(stripped.message).toBe(partial);
		// The original event (shared with extensions/TUI) keeps its partial.
		expect("partial" in getRecord(getRecord(event).assistantMessageEvent)).toBe(true);
	});

	test("passes other events through unchanged", () => {
		const event = { type: "tool_execution_start", toolCallId: "tc1", toolName: "read", args: {} };
		expect(stripAssistantMessageEventPartial(event)).toBe(event);
	});
});

describe("RpcSessionEventEncoder", () => {
	test("omits the accumulated message once message_start delivered the base", () => {
		const encoder = new RpcSessionEventEncoder();
		encoder.encode({ type: "message_start", message: assistantPartial([]) });
		const frame = getRecord(
			encoder.encode(
				messageUpdate(assistantPartial([{ type: "text", text: "hi" }]), {
					type: "text_delta",
					contentIndex: 0,
					delta: "hi",
				}),
			),
		);
		expect("message" in frame).toBe(false);
		expect("partial" in getRecord(frame.assistantMessageEvent)).toBe(false);
	});

	test("sends a snapshot for the first update without message_start, then delta-only frames", () => {
		const encoder = new RpcSessionEventEncoder();
		const first = getRecord(
			encoder.encode(
				messageUpdate(assistantPartial([{ type: "text", text: "He" }]), {
					type: "text_delta",
					contentIndex: 0,
					delta: "He",
				}),
			),
		);
		expect(isRecord(first.message)).toBe(true);
		expect("partial" in getRecord(first.assistantMessageEvent)).toBe(false);
		const second = getRecord(
			encoder.encode(
				messageUpdate(assistantPartial([{ type: "text", text: "Hello" }]), {
					type: "text_delta",
					contentIndex: 0,
					delta: "llo",
				}),
			),
		);
		expect("message" in second).toBe(false);
		expect("partial" in getRecord(second.assistantMessageEvent)).toBe(false);
	});

	test("delta-only toolcall_start frames carry the id/name stub", () => {
		const encoder = new RpcSessionEventEncoder();
		encoder.encode({ type: "message_start", message: assistantPartial([]) });
		const frame = getRecord(
			encoder.encode(
				messageUpdate(assistantPartial([{ type: "toolCall", id: "tc1", name: "write", arguments: {} }]), {
					type: "toolcall_start",
					contentIndex: 0,
				}),
			),
		);
		expect("message" in frame).toBe(false);
		expect(getRecord(frame.assistantMessageEvent).toolCall).toEqual({ id: "tc1", name: "write" });
	});

	test("message_end resets the base so the next message starts from its message_start", () => {
		const encoder = new RpcSessionEventEncoder();
		encoder.encode({ type: "message_start", message: assistantPartial([]) });
		encoder.encode({ type: "message_end", message: assistantPartial([{ type: "text", text: "done" }]) });
		// No message_start for the next message on this stream: snapshot required.
		const frame = getRecord(
			encoder.encode(
				messageUpdate(assistantPartial([{ type: "text", text: "x" }]), {
					type: "text_delta",
					contentIndex: 0,
					delta: "x",
				}),
			),
		);
		expect(isRecord(frame.message)).toBe(true);
	});
});

describe("RpcSessionEventEncoder + RpcMessageDeltaDecoder round trip", () => {
	test("reconstructs text and progressive tool-call arguments from delta frames", () => {
		const encoder = new RpcSessionEventEncoder();
		const decoder = new RpcMessageDeltaDecoder();

		const roundTrip = (event: object): Record<string, unknown> =>
			getRecord(decoder.decode(JSON.parse(JSON.stringify(encoder.encode(event)))));

		roundTrip({ type: "message_start", message: assistantPartial([]) });

		const textDelta1 = roundTrip(
			messageUpdate(assistantPartial([{ type: "text", text: "Hel" }]), {
				type: "text_delta",
				contentIndex: 0,
				delta: "Hel",
			}),
		);
		expect(getContent(textDelta1.message)).toEqual([{ type: "text", text: "Hel" }]);
		// The documented partial reference is restored client-side.
		expect(getRecord(textDelta1.assistantMessageEvent).partial).toBe(textDelta1.message);

		const textDelta2 = roundTrip(
			messageUpdate(assistantPartial([{ type: "text", text: "Hello" }]), {
				type: "text_delta",
				contentIndex: 0,
				delta: "lo",
			}),
		);
		expect(getContent(textDelta2.message)).toEqual([{ type: "text", text: "Hello" }]);
		// Copy-on-write: the earlier snapshot is not mutated by later deltas.
		expect(getContent(textDelta1.message)).toEqual([{ type: "text", text: "Hel" }]);

		roundTrip(
			messageUpdate(assistantPartial([{ type: "text", text: "Hello" }]), {
				type: "text_end",
				contentIndex: 0,
				content: "Hello",
			}),
		);

		const toolStart = roundTrip(
			messageUpdate(
				assistantPartial([
					{ type: "text", text: "Hello" },
					{ type: "toolCall", id: "tc1", name: "write", arguments: {} },
				]),
				{ type: "toolcall_start", contentIndex: 1 },
			),
		);
		expect(getContent(toolStart.message)[1]).toEqual({ type: "toolCall", id: "tc1", name: "write", arguments: {} });

		const toolDelta1 = roundTrip(
			messageUpdate(
				assistantPartial([
					{ type: "text", text: "Hello" },
					{ type: "toolCall", id: "tc1", name: "write", arguments: {} },
				]),
				{ type: "toolcall_delta", contentIndex: 1, delta: '{"path":"a' },
			),
		);
		expect(getRecord(getContent(toolDelta1.message)[1]).arguments).toEqual({ path: "a" });

		const toolDelta2 = roundTrip(
			messageUpdate(
				assistantPartial([
					{ type: "text", text: "Hello" },
					{ type: "toolCall", id: "tc1", name: "write", arguments: {} },
				]),
				{ type: "toolcall_delta", contentIndex: 1, delta: '.txt"}' },
			),
		);
		expect(getRecord(getContent(toolDelta2.message)[1]).arguments).toEqual({ path: "a.txt" });

		const finalToolCall = { type: "toolCall", id: "tc1", name: "write", arguments: { path: "a.txt" } };
		const toolEnd = roundTrip(
			messageUpdate(assistantPartial([{ type: "text", text: "Hello" }, finalToolCall]), {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: finalToolCall,
			}),
		);
		expect(getContent(toolEnd.message)).toEqual([{ type: "text", text: "Hello" }, finalToolCall]);
	});

	test("reconstructs thinking blocks", () => {
		const encoder = new RpcSessionEventEncoder();
		const decoder = new RpcMessageDeltaDecoder();
		const roundTrip = (event: object): Record<string, unknown> =>
			getRecord(decoder.decode(JSON.parse(JSON.stringify(encoder.encode(event)))));

		roundTrip({ type: "message_start", message: assistantPartial([]) });
		roundTrip(
			messageUpdate(assistantPartial([{ type: "thinking", thinking: "" }]), {
				type: "thinking_start",
				contentIndex: 0,
			}),
		);
		const delta = roundTrip(
			messageUpdate(assistantPartial([{ type: "thinking", thinking: "hmm" }]), {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "hmm",
			}),
		);
		expect(getContent(delta.message)).toEqual([{ type: "thinking", thinking: "hmm" }]);
		const end = roundTrip(
			messageUpdate(assistantPartial([{ type: "thinking", thinking: "hmm ok" }]), {
				type: "thinking_end",
				contentIndex: 0,
				content: "hmm ok",
			}),
		);
		expect(getContent(end.message)).toEqual([{ type: "thinking", thinking: "hmm ok" }]);
	});
});

describe("RpcMessageDeltaDecoder", () => {
	test("keys subagent_event streams independently and clears them on subagent_end", () => {
		const decoder = new RpcMessageDeltaDecoder();
		decoder.decode({
			type: "subagent_event",
			subagentId: "sa_1",
			event: { type: "message_start", message: assistantPartial([]) },
		});
		const update = getRecord(
			decoder.decode({
				type: "subagent_event",
				subagentId: "sa_1",
				event: {
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
				},
			}),
		);
		expect(getContent(getRecord(update.event).message)).toEqual([{ type: "text", text: "hi" }]);

		// The main-session stream has no base: slim frames pass through untouched.
		const mainSlim = {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
		};
		expect(decoder.decode(mainSlim)).toBe(mainSlim);

		decoder.decode({ type: "subagent_end", subagentId: "sa_1", result: {} });
		const afterEnd = {
			type: "subagent_event",
			subagentId: "sa_1",
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y" } },
		};
		expect(decoder.decode(afterEnd)).toBe(afterEnd);
	});

	test("drops deltas whose contentIndex skips past the accumulated content", () => {
		const decoder = new RpcMessageDeltaDecoder();
		decoder.decode({ type: "message_start", message: assistantPartial([]) });
		// A tiny frame must not be able to allocate an arbitrarily large content
		// array (memory-amplification DoS from a malicious or buggy server).
		const decoded = getRecord(
			decoder.decode({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 50_000_000, delta: "x" },
			}),
		);
		expect(getContent(decoded.message)).toEqual([]);
		// Contiguous appends still work after the out-of-range delta was dropped.
		const appended = getRecord(
			decoder.decode({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
			}),
		);
		expect(getContent(appended.message)).toEqual([{ type: "text", text: "hi" }]);
	});

	test("clears subagent stream state on agent_end when no subagent_end arrives", () => {
		const decoder = new RpcMessageDeltaDecoder();
		decoder.decode({
			type: "subagent_event",
			subagentId: "sa_1",
			event: { type: "message_start", message: assistantPartial([]) },
		});
		decoder.decode({ type: "subagent_event", subagentId: "sa_1", event: { type: "agent_end", messages: [] } });
		// No accumulator base left: slim frames pass through untouched.
		const slim = {
			type: "subagent_event",
			subagentId: "sa_1",
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } },
		};
		expect(decoder.decode(slim)).toBe(slim);
	});

	test("subagent_disposed drops the accumulator for a host-disposed subagent", () => {
		const decoder = new RpcMessageDeltaDecoder();
		decoder.decode({
			type: "subagent_event",
			subagentId: "sa_1",
			event: { type: "message_start", message: assistantPartial([]) },
		});
		// The host emits this terminal frame for every disposal path (abort,
		// dispose, failed start, session rebind).
		decoder.decode({ type: "subagent_disposed", subagentId: "sa_1" });
		const slim = {
			type: "subagent_event",
			subagentId: "sa_1",
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } },
		};
		expect(decoder.decode(slim)).toBe(slim);
	});

	test("restores the partial reference on snapshot frames", () => {
		const decoder = new RpcMessageDeltaDecoder();
		const message = assistantPartial([{ type: "text", text: "hi" }]);
		const decoded = getRecord(
			decoder.decode({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
			}),
		);
		expect(getRecord(decoded.assistantMessageEvent).partial).toBe(message);
	});
});

describe("RpcSessionEventEncoder with the iroh outbound delta sanitizer", () => {
	// Same redaction options for the delta sanitizer and the per-frame outbound
	// filter, mirroring runIrohRemoteRpcMode.
	const workspacePath = resolve("/Users/jordan/secret-project");
	const sanitizerOptions = { workspacePath };

	function createPipeline() {
		const encoder = new RpcSessionEventEncoder({
			deltaSanitizer: createIrohRemoteOutboundDeltaSanitizer(sanitizerOptions),
		});
		const decoder = new RpcMessageDeltaDecoder();
		const wireFrames: Array<Record<string, unknown>> = [];
		const roundTrip = (event: object): Record<string, unknown> => {
			const frame = getRecord(
				JSON.parse(JSON.stringify(sanitizeIrohRemoteOutbound(encoder.encode(event), sanitizerOptions))),
			);
			wireFrames.push(frame);
			return getRecord(decoder.decode(frame));
		};
		return { roundTrip, wireFrames };
	}

	test("host paths split across text deltas cannot be reconstructed by the client", () => {
		const { roundTrip, wireFrames } = createPipeline();
		const fullText = `See ${workspacePath}${sep}notes.md ok`;
		// Split inside the secret directory name, like model tokenizers do.
		const splitAt = fullText.indexOf("secret-project") + 3;

		roundTrip({ type: "message_start", message: assistantPartial([]) });
		roundTrip(messageUpdate(assistantPartial([{ type: "text", text: "" }]), { type: "text_start", contentIndex: 0 }));
		roundTrip(
			messageUpdate(assistantPartial([{ type: "text", text: fullText.slice(0, splitAt) }]), {
				type: "text_delta",
				contentIndex: 0,
				delta: fullText.slice(0, splitAt),
			}),
		);
		// Streaming stays delta-only while sanitization is append-only.
		expect("message" in wireFrames[2]).toBe(false);

		const afterFull = roundTrip(
			messageUpdate(assistantPartial([{ type: "text", text: fullText }]), {
				type: "text_delta",
				contentIndex: 0,
				delta: fullText.slice(splitAt),
			}),
		);
		// Redaction rewrote already-streamed text: the wire carries a sanitized
		// snapshot (accumulator replacement) instead of the raw delta.
		expect(isRecord(wireFrames[3].message)).toBe(true);
		expect(getRecord(wireFrames[3].assistantMessageEvent).delta).toBe("");
		expect(getContent(afterFull.message)).toEqual([{ type: "text", text: "See /workspace/notes.md ok" }]);

		const ended = roundTrip(
			messageUpdate(assistantPartial([{ type: "text", text: fullText }]), {
				type: "text_end",
				contentIndex: 0,
				content: fullText,
			}),
		);
		expect(getContent(ended.message)).toEqual([{ type: "text", text: "See /workspace/notes.md ok" }]);

		for (const frame of wireFrames) {
			expect(JSON.stringify(frame)).not.toContain("secret-project");
		}
	});

	test("host paths split across toolcall deltas are redacted via snapshot frames", () => {
		const { roundTrip, wireFrames } = createPipeline();
		const argsJson = JSON.stringify({ path: `${workspacePath}${sep}notes.md` });
		const splitAt = argsJson.indexOf("secret-project") + 3;
		const partialArgs = parseStreamingJson(argsJson.slice(0, splitAt));
		const fullArgs = { path: `${workspacePath}${sep}notes.md` };
		const toolBlock = (args: unknown) => ({ type: "toolCall", id: "tc1", name: "read", arguments: args });

		roundTrip({ type: "message_start", message: assistantPartial([]) });
		roundTrip(messageUpdate(assistantPartial([toolBlock({})]), { type: "toolcall_start", contentIndex: 0 }));
		roundTrip(
			messageUpdate(assistantPartial([toolBlock(partialArgs)]), {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: argsJson.slice(0, splitAt),
			}),
		);
		// Sanitization does not change the partial arguments yet: raw JSON streams.
		expect("message" in wireFrames[2]).toBe(false);

		const afterFull = roundTrip(
			messageUpdate(assistantPartial([toolBlock(fullArgs)]), {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: argsJson.slice(splitAt),
			}),
		);
		// The completed path is redactable: raw argument JSON stops and a
		// sanitized snapshot replaces the client accumulator.
		expect(isRecord(wireFrames[3].message)).toBe(true);
		expect(getRecord(wireFrames[3].assistantMessageEvent).delta).toBe("");
		expect(getRecord(getContent(afterFull.message)[0]).arguments).toEqual({ path: "/workspace/notes.md" });

		const ended = roundTrip(
			messageUpdate(assistantPartial([toolBlock(fullArgs)]), {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: toolBlock(fullArgs),
			}),
		);
		expect(getContent(ended.message)[0]).toEqual(toolBlock({ path: "/workspace/notes.md" }));

		for (const frame of wireFrames) {
			expect(JSON.stringify(frame)).not.toContain("secret-project");
		}
	});

	test("clean streamed text stays delta-only", () => {
		const { roundTrip, wireFrames } = createPipeline();
		roundTrip({ type: "message_start", message: assistantPartial([]) });
		roundTrip(messageUpdate(assistantPartial([{ type: "text", text: "" }]), { type: "text_start", contentIndex: 0 }));
		const first = roundTrip(
			messageUpdate(assistantPartial([{ type: "text", text: "Hello " }]), {
				type: "text_delta",
				contentIndex: 0,
				delta: "Hello ",
			}),
		);
		const second = roundTrip(
			messageUpdate(assistantPartial([{ type: "text", text: "Hello world" }]), {
				type: "text_delta",
				contentIndex: 0,
				delta: "world",
			}),
		);
		expect("message" in wireFrames[2]).toBe(false);
		expect("message" in wireFrames[3]).toBe(false);
		expect(getRecord(wireFrames[3].assistantMessageEvent).delta).toBe("world");
		expect(getContent(first.message)).toEqual([{ type: "text", text: "Hello " }]);
		expect(getContent(second.message)).toEqual([{ type: "text", text: "Hello world" }]);
	});
});
