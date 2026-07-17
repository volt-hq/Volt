import { beforeEach, describe, expect, it, vi } from "vitest";

const vertexMock = vi.hoisted(() => ({
	chunks: [] as unknown[],
	streamError: undefined as Error | undefined,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				for (const chunk of vertexMock.chunks) {
					yield chunk;
				}
				if (vertexMock.streamError) {
					throw vertexMock.streamError;
				}
			},
		};
	}

	return {
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			BLOCKLIST: "BLOCKLIST",
			PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
			SPII: "SPII",
			SAFETY: "SAFETY",
			IMAGE_SAFETY: "IMAGE_SAFETY",
			IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT",
			IMAGE_RECITATION: "IMAGE_RECITATION",
			IMAGE_OTHER: "IMAGE_OTHER",
			RECITATION: "RECITATION",
			FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
			OTHER: "OTHER",
			LANGUAGE: "LANGUAGE",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
			NO_IMAGE: "NO_IMAGE",
		},
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY" },
		GoogleGenAI,
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { getModel } from "../src/models.ts";
import { streamGoogleVertex } from "../src/providers/google-vertex.ts";
import type { AssistantMessage, AssistantMessageEvent, Context } from "../src/types.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model = getModel("google-vertex", "gemini-3-flash-preview");
const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

async function collect(
	stream: AssistantMessageEventStream,
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return { events, result: await stream.result() };
}

beforeEach(() => {
	vertexMock.chunks = [];
	vertexMock.streamError = undefined;
});

describe("Google Vertex stream normalization", () => {
	it("emits immutable dense-index events with terminal signatures, metadata, and whole tool arguments", async () => {
		vertexMock.chunks = [
			{
				responseId: "vertex-response-1",
				candidates: [
					{
						content: {
							parts: [
								{ text: "plan ", thought: true, thoughtSignature: "thinking-signature" },
								{ text: "first", thought: true },
								{ text: "answer", thoughtSignature: "text-signature" },
								{
									functionCall: { id: "call-1", name: "lookup", args: { query: "first" } },
									thoughtSignature: "tool-signature",
								},
								{ functionCall: { id: "call-1", name: "lookup", args: { query: "second" } } },
								{ text: "after" },
							],
						},
						finishReason: "STOP",
					},
				],
				usageMetadata: {
					promptTokenCount: 12,
					cachedContentTokenCount: 2,
					candidatesTokenCount: 3,
					thoughtsTokenCount: 4,
					totalTokenCount: 19,
				},
			},
		];

		const { events, result } = await collect(
			streamGoogleVertex(model, context, { apiKey: "AIzaSyExampleRealisticLookingApiKey123456" }),
		);

		expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
		expect(events[0]?.type).toBe("start");
		expect(events.at(-1)?.type).toBe("done");

		const thinkingStarts = events.filter((event) => event.type === "thinking_start");
		const textStarts = events.filter((event) => event.type === "text_start");
		const toolStarts = events.filter((event) => event.type === "toolcall_start");
		expect(thinkingStarts.map((event) => event.contentIndex)).toEqual([0]);
		expect(textStarts.map((event) => event.contentIndex)).toEqual([1, 4]);
		expect(toolStarts.map((event) => event.contentIndex)).toEqual([2, 3]);
		expect(toolStarts[0]).toMatchObject({ id: "call-1", name: "lookup" });
		expect(toolStarts[1]?.id).toMatch(/^lookup_\d+_\d+$/);
		expect(toolStarts[1]?.id).not.toBe("call-1");

		const toolDeltas = events.filter((event) => event.type === "toolcall_delta");
		expect(toolDeltas.map((event) => event.argsTextDelta)).toEqual(['{"query":"first"}', '{"query":"second"}']);

		const textDelta = events.find((event) => event.type === "text_delta" && event.contentIndex === 1);
		const textEnd = events.find((event) => event.type === "text_end" && event.contentIndex === 1);
		const thinkingEnd = events.find((event) => event.type === "thinking_end");
		if (textDelta?.type !== "text_delta" || textEnd?.type !== "text_end" || thinkingEnd?.type !== "thinking_end") {
			throw new Error("Expected normalized text and thinking events");
		}
		expect(textDelta?.snapshot.content[1]).not.toHaveProperty("textSignature");
		expect(textEnd?.snapshot.content[1]).toMatchObject({ textSignature: "text-signature" });
		expect(thinkingEnd?.snapshot.content[0]).toMatchObject({ thinkingSignature: "thinking-signature" });
		expect(thinkingStarts[0]?.snapshot.responseId).toBe("vertex-response-1");

		expect(result).toMatchObject({
			responseId: "vertex-response-1",
			stopReason: "toolUse",
			usage: { input: 10, output: 7, cacheRead: 2, cacheWrite: 0, totalTokens: 19 },
		});
		expect(result.content).toHaveLength(5);
		expect(result.content[0]).toMatchObject({
			type: "thinking",
			thinking: "plan first",
			thinkingSignature: "thinking-signature",
		});
		expect(result.content[1]).toMatchObject({
			type: "text",
			text: "answer",
			textSignature: "text-signature",
		});
		expect(result.content[2]).toMatchObject({
			type: "toolCall",
			id: "call-1",
			name: "lookup",
			arguments: { query: "first" },
			thoughtSignature: "tool-signature",
		});
		expect(result.content[4]).toEqual({ type: "text", text: "after" });
		expect(Object.isFrozen(events[0])).toBe(true);
		expect(Object.isFrozen(thinkingStarts[0]?.snapshot)).toBe(true);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.content)).toBe(true);
	});

	it("emits a valid aborted terminal sequence when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const { events, result } = await collect(
			streamGoogleVertex(model, context, {
				apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
				signal: controller.signal,
			}),
		);

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(events.map((event) => event.seq)).toEqual([0, 1]);
		expect(events[1]).toMatchObject({ reason: "aborted" });
		expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "Request aborted" });
		expect(Object.isFrozen(events[1])).toBe(true);
		expect(Object.isFrozen(result)).toBe(true);
	});
});
