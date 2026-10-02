import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.ts";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import type { Model, StreamOptions, Transport } from "../src/types.ts";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.test`;
function model<T extends string>(api: T): Model<T> {
	return {
		id: "test-model",
		name: "Test",
		api,
		provider: "test-provider",
		baseUrl: "https://test.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16000,
		maxTokens: 4000,
	};
}
const providers = [
	{
		name: "Responses",
		api: "openai-responses",
		run: (options: StreamOptions) => streamOpenAIResponses(model("openai-responses"), { messages: [] }, options),
	},
	{
		name: "Completions",
		api: "openai-completions",
		run: (options: StreamOptions) => streamOpenAICompletions(model("openai-completions"), { messages: [] }, options),
	},
	{
		name: "Azure Responses",
		api: "azure-openai-responses",
		run: (options: StreamOptions) =>
			streamAzureOpenAIResponses(model("azure-openai-responses"), { messages: [] }, options),
	},
	...(["sse", "websocket", "websocket-cached"] satisfies Transport[]).map((transport) => ({
		name: `Codex ${transport}`,
		api: "openai-codex-responses",
		run: (options: StreamOptions) =>
			streamOpenAICodexResponses(model("openai-codex-responses"), { messages: [] }, { ...options, transport }),
	})),
];

afterEach(() => vi.unstubAllGlobals());

describe("local tool limit validation before provider startup", () => {
	it("aborts the transport signal and settles with metadata without requiring a first fragment", async () => {
		const normalizer = new AssistantStreamNormalizer({ toolArgumentLimits: { maxBytes: 0 } });
		expect(
			normalizer.validateConfiguration({
				api: "test",
				provider: "test-provider",
				model: "test-model",
				timestamp: 1,
			}),
		).toBe(false);
		expect(normalizer.signal.aborted).toBe(true);
		expect(await normalizer.stream.result()).toMatchObject({
			stopReason: "error",
			api: "test",
			provider: "test-provider",
			model: "test-model",
			timestamp: 1,
		});
	});

	describe.each(providers)("$name", ({ run, api }) => {
		it.each([false, true])(
			"rejects before network or callback acquisition (pending payload hook=%s)",
			async (pendingHook) => {
				const fetch = vi.fn(() => new Promise<Response>(() => {}));
				const socket = vi.fn();
				vi.stubGlobal("fetch", fetch);
				vi.stubGlobal(
					"WebSocket",
					class {
						constructor() {
							socket();
							throw new Error("unexpected socket");
						}
					},
				);
				const onPayload = vi.fn(() => new Promise<undefined>(() => {}));
				const onResponse = vi.fn();
				const stream = run({
					apiKey: token,
					toolArgumentLimits: { maxDurationMs: 0 },
					onResponse,
					...(pendingHook ? { onPayload } : {}),
				});
				const result = await stream.result();
				expect(result).toMatchObject({
					stopReason: "error",
					api,
					provider: "test-provider",
					model: "test-model",
					diagnostics: [
						expect.objectContaining({
							type: "tool_argument_generation_limit",
							details: { code: "invalid_configuration" },
						}),
					],
				});
				expect(fetch).not.toHaveBeenCalled();
				expect(socket).not.toHaveBeenCalled();
				expect(onPayload).not.toHaveBeenCalled();
				expect(onResponse).not.toHaveBeenCalled();
			},
			1000,
		);
	});
});
