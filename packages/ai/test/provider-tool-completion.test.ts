import type * as BedrockRuntime from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { streamBedrock } from "../src/providers/amazon-bedrock.ts";
import { streamMistral } from "../src/providers/mistral.ts";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

const mock = vi.hoisted(() => ({ chunks: [] as unknown[] }));

async function* chunks() {
	for (const chunk of mock.chunks) yield chunk;
}

vi.mock("openai", () => ({
	default: class {
		chat = {
			completions: {
				create: () => {
					const data = chunks();
					return Object.assign(Promise.resolve(data), {
						withResponse: async () => ({ data, response: { status: 200, headers: new Headers() } }),
					});
				},
			},
		};
	},
}));

vi.mock("@mistralai/mistralai", () => ({
	Mistral: class {
		chat = { stream: async () => chunks() };
	},
}));

vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => ({
	...(await importOriginal<typeof BedrockRuntime>()),
	BedrockRuntimeClient: class {
		send = async () => ({ $metadata: {}, stream: chunks() });
	},
}));

const context: Context = { messages: [{ role: "user", content: "edit", timestamp: 0 }] };
const base = {
	id: "test-model",
	name: "Test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe.each(["openai", "mistral", "bedrock"] as const)("%s strict tool completion", (provider) => {
	async function run(raw: string, terminal: "complete" | "length" | "missing" | "missing_block") {
		const parts = [raw.slice(0, Math.floor(raw.length / 2)), raw.slice(Math.floor(raw.length / 2))];
		if (provider === "openai") {
			mock.chunks = parts.map((argumentsText) => ({
				id: "response-1",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call-1",
									type: "function",
									function: { name: "edit", arguments: argumentsText },
								},
							],
						},
					},
				],
			}));
			if (terminal !== "missing")
				mock.chunks.push({
					choices: [{ index: 0, delta: {}, finish_reason: terminal === "length" ? "length" : "tool_calls" }],
				});
			return streamOpenAICompletions(
				{ ...base, api: "openai-completions", provider: "openai" } satisfies Model<"openai-completions">,
				context,
				{ apiKey: "test" },
			).result();
		}
		if (provider === "mistral") {
			mock.chunks = parts.map((argumentsText) => ({
				data: {
					id: "response-1",
					choices: [
						{
							delta: {
								toolCalls: [{ index: 0, id: "call-1", function: { name: "edit", arguments: argumentsText } }],
							},
						},
					],
				},
			}));
			if (terminal !== "missing")
				mock.chunks.push({
					data: { choices: [{ delta: {}, finishReason: terminal === "length" ? "length" : "tool_calls" }] },
				});
			return streamMistral(
				{ ...base, api: "mistral-conversations", provider: "mistral" } satisfies Model<"mistral-conversations">,
				context,
				{ apiKey: "test" },
			).result();
		}
		mock.chunks = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call-1", name: "edit" } } } },
			...parts.map((input) => ({ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input } } } })),
		];
		if (terminal !== "missing_block") mock.chunks.push({ contentBlockStop: { contentBlockIndex: 0 } });
		if (terminal !== "missing")
			mock.chunks.push({ messageStop: { stopReason: terminal === "length" ? "max_tokens" : "tool_use" } });
		return streamBedrock(
			{
				...base,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
			} satisfies Model<"bedrock-converse-stream">,
			context,
			{ env: {} },
		).result();
	}

	it.each(['{"text":"unfinished', '{"text":"done",}', "[]", "null", ""])(
		"rejects invalid completed raw JSON %j",
		async (raw) => {
			const result = await run(raw, "complete");
			expect(result.stopReason).toBe("error");
			expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "invalid_tool_arguments" }));
		},
	);

	it.each(["length", "missing"] as const)("rejects valid previews after %s termination", async (terminal) => {
		const result = await run('{"text":"done"}', terminal);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "invalid_tool_arguments" }));
	});

	if (provider === "bedrock")
		it("requires the explicit content block stop", async () => {
			expect((await run('{"text":"done"}', "missing_block")).stopReason).toBe("error");
		});

	it("preserves valid fragmented escaped code exactly", async () => {
		const args = { text: 'const path = "C:\\notes";\nconsole.log("done");' };
		const result = await run(JSON.stringify(args), "complete");
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ arguments: args });
	});
});
