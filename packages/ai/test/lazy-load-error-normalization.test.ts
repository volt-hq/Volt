import { describe, expect, it, vi } from "vitest";

vi.mock("../src/providers/google.ts", () => {
	return {
		get streamGoogle() {
			throw new Error("simulated lazy module failure");
		},
		get streamSimpleGoogle() {
			throw new Error("simulated lazy module failure");
		},
	};
});

import { streamGoogle, streamSimpleGoogle } from "../src/providers/register-builtins.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"google-generative-ai"> = {
	id: "test-google-model",
	name: "Test Google Model",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
	maxTokens: 128,
};

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

async function expectNormalizedLazyLoadError(stream: AssistantMessageEventStream): Promise<void> {
	const { events, result } = await collect(stream);

	expect(events.map((event) => event.type)).toEqual(["start", "error"]);
	expect(events.map((event) => event.seq)).toEqual([0, 1]);
	expect(events[0]).toMatchObject({
		type: "start",
		snapshot: {
			api: "google-generative-ai",
			provider: "google",
			model: "test-google-model",
			content: [],
			stopReason: "stop",
		},
		toolState: [],
	});
	expect(events[1]).toMatchObject({
		type: "error",
		reason: "error",
		error: {
			content: [],
			stopReason: "error",
			errorMessage: "simulated lazy module failure",
		},
	});
	expect(result).toMatchObject({
		api: "google-generative-ai",
		provider: "google",
		model: "test-google-model",
		content: [],
		stopReason: "error",
		errorMessage: "simulated lazy module failure",
	});
	expect(events[0]?.type === "start" ? events[0].snapshot.errorMessage : "not-start").toBeUndefined();
	expect(Object.isFrozen(events[0])).toBe(true);
	expect(Object.isFrozen(events[1])).toBe(true);
	expect(Object.isFrozen(result)).toBe(true);
	expect(Object.isFrozen(result.content)).toBe(true);
	expect(Object.isFrozen(result.usage)).toBe(true);
	expect(Object.isFrozen(result.usage.cost)).toBe(true);
}

describe("lazy provider load error normalization", () => {
	it("normalizes raw stream lazy-load failures", async () => {
		await expectNormalizedLazyLoadError(streamGoogle(model, context, { apiKey: "unused" }));
	});

	it("normalizes simple stream lazy-load failures", async () => {
		await expectNormalizedLazyLoadError(streamSimpleGoogle(model, context, { apiKey: "unused" }));
	});
});
