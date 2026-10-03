import { afterEach, describe, expect, it, vi } from "vitest";
import { applyReplayPolicy } from "../src/replay-policy.ts";
import type { AssistantMessage, Context, KnownApi, Model, ToolResultMessage } from "../src/types.ts";
import { streamSimple } from "./test-client.ts";

const apis: KnownApi[] = [
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
];
const fakeToken = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;

function modelFor(api: KnownApi): Model<KnownApi> {
	return {
		id: "test-model",
		name: "Payload test",
		api,
		provider: api,
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
		maxTokens: 1000,
	};
}

function assistant(
	model: Model<KnownApi>,
	stopReason: AssistantMessage["stopReason"],
	...ids: string[]
): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "jobs", arguments: { action: "read", id: "job_test" } })),
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason,
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function result(toolCallId: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "jobs",
		content: [{ type: "text", text }],
		isError,
		timestamp: 2,
	};
}

async function capturePayload(model: Model<KnownApi>, context: Context): Promise<string> {
	let payload: unknown;
	const response = await streamSimple(model, context, {
		apiKey: fakeToken,
		cacheRetention: "none",
		transport: "sse",
		env: { AWS_REGION: "us-east-1", AWS_BEDROCK_SKIP_AUTH: "1", AZURE_OPENAI_BASE_URL: model.baseUrl },
		onPayload: (value) => {
			payload = value;
			// Stop before any provider request. All endpoints and credentials are synthetic.
			throw new Error("payload captured before request");
		},
	}).result();
	expect(response.stopReason).toBe("error");
	expect(response.error?.message).toContain("payload captured before request");
	expect(payload).toBeDefined();
	return JSON.stringify(payload);
}

afterEach(() => vi.unstubAllGlobals());

describe.each(apis)("%s serializes the replayed context", (api) => {
	it.each([
		["error", false],
		["error", true],
		["aborted", false],
		["aborted", true],
	] as const)(
		"sends every tool result of a context replayed after %s (cross-model: %s)",
		async (stopReason, crossModel) => {
			const fetch = vi.fn(() => {
				throw new Error("Unexpected provider request");
			});
			vi.stubGlobal("fetch", fetch);
			const model = modelFor(api);
			const source = crossModel ? { ...model, provider: "source-provider", id: "source-model" } : model;
			const reusedId = crossModel ? "call/reused|foreign/item" : "reused001";
			const secondId = crossModel ? "call/second|foreign/other" : "second001";
			const messages = [
				{ role: "user" as const, content: "Inspect jobs", timestamp: 0 },
				assistant(source, stopReason, reusedId),
				result(reusedId, "dropped-result"),
				assistant(source, "toolUse", reusedId, secondId),
				result(reusedId, "delivered-result"),
				result(secondId, "delivered-failure", true),
				assistant(source, "toolUse", "missing01"),
				{ role: "user" as const, content: "Continue", timestamp: 3 },
			];
			const replayed = applyReplayPolicy(messages);
			const original = structuredClone(replayed);

			const encoded = await capturePayload(model, { messages: replayed });

			expect(encoded).not.toContain("dropped-result");
			for (const message of replayed) {
				if (message.role !== "toolResult") continue;
				const text = message.content[0]?.type === "text" ? message.content[0].text : "";
				expect(encoded).toContain(text);
			}
			expect(encoded).toContain("No result provided");
			expect(replayed).toEqual(original);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("does not apply the replay policy itself", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("Unexpected provider request");
			}),
		);
		const model = modelFor(api);
		const encoded = await capturePayload(model, {
			messages: [
				{ role: "user", content: "Inspect jobs", timestamp: 0 },
				assistant(model, "aborted", "aborted01"),
				result("aborted01", "unreplayed-result"),
				{ role: "user", content: "Continue", timestamp: 3 },
			],
		});
		// Replay would drop the aborted turn and its result; the provider sends what it is handed.
		expect(encoded).toContain("unreplayed-result");
	});
});
