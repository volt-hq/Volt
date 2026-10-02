import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.ts";
import type {
	AssistantMessage,
	Context,
	KnownApi,
	Model,
	ProviderPayloadMetadata,
	ToolResultMessage,
} from "../src/types.ts";

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

async function capture(model: Model<KnownApi>, context: Context) {
	let payload: unknown;
	let metadata: ProviderPayloadMetadata | undefined;
	const response = await streamSimple(model, context, {
		apiKey: fakeToken,
		cacheRetention: "none",
		transport: "sse",
		env: { AWS_REGION: "us-east-1", AWS_BEDROCK_SKIP_AUTH: "1", AZURE_OPENAI_BASE_URL: model.baseUrl },
		onPayload: (value, _model, evidence) => {
			payload = value;
			metadata = evidence;
			// Stop before any provider request. All endpoints and credentials are synthetic.
			throw new Error("payload captured before request");
		},
	}).result();
	expect(response.stopReason).toBe("error");
	expect(response.errorMessage).toContain("payload captured before request");
	expect(payload).toBeDefined();
	expect(metadata).toBeDefined();
	return { payload, metadata: metadata! };
}

afterEach(() => vi.unstubAllGlobals());

describe.each(apis)("%s tool-result payload evidence", (api) => {
	it.each([
		["error", false],
		["error", true],
		["aborted", false],
		["aborted", true],
	] as const)("tracks surviving source indices after %s replay (cross-model: %s)", async (stopReason, crossModel) => {
		const fetch = vi.fn(() => {
			throw new Error("Unexpected provider request");
		});
		vi.stubGlobal("fetch", fetch);
		const model = modelFor(api);
		const source = crossModel ? { ...model, provider: "source-provider", id: "source-model" } : model;
		const reusedId = crossModel ? "call/reused|foreign/item" : "reused001";
		const secondId = crossModel ? "call/second|foreign/other" : "second001";
		const context: Context = {
			messages: [
				{ role: "user", content: "Inspect jobs", timestamp: 0 },
				assistant(source, stopReason, reusedId),
				result(reusedId, "dropped-result"),
				assistant(source, "toolUse", reusedId, secondId),
				result(reusedId, "delivered-result"),
				result(secondId, "delivered-failure", true),
				assistant(source, "toolUse", "missing01"),
				{ role: "user", content: "Continue", timestamp: 3 },
			],
		};
		const original = structuredClone(context);
		const { payload, metadata } = await capture(model, context);
		expect(metadata.toolResultMessageIndices).toEqual([4, 5]);
		const encoded = JSON.stringify(payload);
		expect(encoded).not.toContain("dropped-result");
		expect(encoded).toContain("delivered-result");
		expect(encoded).toContain("delivered-failure");
		expect(encoded).toContain("No result provided");
		expect(encoded).not.toContain("toolResultMessageIndices");
		expect(context).toEqual(original);
		expect(Object.isFrozen(metadata)).toBe(true);
		expect(Object.isFrozen(metadata.toolResultMessageIndices)).toBe(true);
		const empty = await capture(model, { messages: [{ role: "user", content: "No results", timestamp: 0 }] });
		expect(empty.metadata.toolResultMessageIndices).toEqual([]);
		expect(metadata.toolResultMessageIndices).toEqual([4, 5]);
		expect(fetch).not.toHaveBeenCalled();
	});
});
