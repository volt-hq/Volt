import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { calculateCost, getModel, getModels, getProviders } from "../src/models.ts";
import {
	ActiveToolCallStateSchema,
	ApiSchema,
	AssistantMessageSchema,
	MessageSchema,
	ModelSchema,
	ToolResultMessageSchema,
	UserMessageSchema,
} from "../src/schemas.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "../src/types.ts";
import { drainEventStream } from "../src/utils/event-stream.ts";

const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" } as const;

const userText: UserMessage = { role: "user", content: "hello", timestamp: 1 };

const userBlocks: UserMessage = {
	role: "user",
	content: [{ type: "text", text: "describe this" }, image],
	clientMessageId: "client-1",
	timestamp: 2,
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "plan", thinkingSignature: "sig", redacted: false },
		{ type: "text", text: "Reading the file.", textSignature: '{"v":1,"id":"msg_1"}' },
		{
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "README.md", range: [1, 20], options: { follow: true, encoding: null } },
			thoughtSignature: "thought",
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-4-8",
	responseModel: "claude-opus-4-8-20260101",
	responseId: "msg_1",
	diagnostics: [
		{
			type: "retry",
			timestamp: 3,
			error: { name: "Error", message: "overloaded", stack: "Error: overloaded", code: 529 },
			details: { attempt: 1 },
		},
	],
	usage: {
		availability: "complete",
		input: 100,
		output: 20,
		cacheRead: 50,
		cacheWrite: 10,
		cacheWrite1h: 4,
		totalTokens: 180,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33, priceVersion: "0a1b2c3d" },
		serviceTier: { requested: "priority", effective: "default" },
	},
	stopReason: "error",
	error: { kind: "rate_limit", retryable: true, providerCode: "429", message: "partial failure" },
	timestamp: 4,
};

const toolResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call_1",
	toolName: "read",
	content: [{ type: "text", text: "# Volt" }, image],
	details: { lines: 1, truncated: false },
	isError: false,
	timestamp: 5,
};

const messages: Message[] = [userText, userBlocks, assistant, toolResult];

function withExtra(value: object, path: readonly (string | number)[], extra: Record<string, unknown>): unknown {
	const copy = structuredClone(value) as Record<string | number, unknown>;
	let target = copy;
	for (const key of path) target = target[key] as Record<string | number, unknown>;
	Object.assign(target, extra);
	return copy;
}

describe("ai message schemas", () => {
	it("accepts representative messages and their JSON round trips", () => {
		const compiled = Compile(MessageSchema);
		for (const message of messages) {
			const decoded: unknown = JSON.parse(JSON.stringify(message));
			expect(Value.Check(MessageSchema, message)).toBe(true);
			expect(compiled.Errors(decoded)).toEqual([]);
			expect(decoded).toEqual(message);
		}
		expect(Value.Check(UserMessageSchema, userBlocks)).toBe(true);
		expect(Value.Check(AssistantMessageSchema, assistant)).toBe(true);
		expect(Value.Check(ToolResultMessageSchema, toolResult)).toBe(true);
	});

	it("accepts minimal messages without optional fields", () => {
		const minimal: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		expect(Value.Check(MessageSchema, minimal)).toBe(true);
		const { details: _details, ...withoutDetails } = toolResult;
		expect(Value.Check(MessageSchema, withoutDetails)).toBe(true);
	});

	it("rejects unknown fields at every closed level", () => {
		const cases: Array<[object, readonly (string | number)[]]> = [
			[userBlocks, []],
			[userBlocks, ["content", 0]],
			[userBlocks, ["content", 1]],
			[assistant, []],
			[assistant, ["content", 0]],
			[assistant, ["content", 1]],
			[assistant, ["content", 2]],
			[assistant, ["usage"]],
			[assistant, ["usage", "cost"]],
			[assistant, ["usage", "serviceTier"]],
			[assistant, ["diagnostics", 0]],
			[assistant, ["diagnostics", 0, "error"]],
			[toolResult, []],
			[toolResult, ["content", 0]],
		];
		for (const [message, path] of cases) {
			expect(Value.Check(MessageSchema, withExtra(message, path, { unexpected: true })), path.join(".")).toBe(false);
		}
	});

	it("rejects content blocks outside a role's content union", () => {
		expect(Value.Check(AssistantMessageSchema, { ...assistant, content: [image] })).toBe(false);
		expect(Value.Check(ToolResultMessageSchema, { ...toolResult, content: [assistant.content[2]] })).toBe(false);
		expect(Value.Check(UserMessageSchema, { ...userBlocks, content: [assistant.content[0]] })).toBe(false);
		expect(Value.Check(MessageSchema, { ...userText, role: "system" })).toBe(false);
	});

	it("rejects invalid enum, required, and scalar values", () => {
		expect(Value.Check(AssistantMessageSchema, { ...assistant, stopReason: "timeout" })).toBe(false);
		expect(
			Value.Check(AssistantMessageSchema, {
				...assistant,
				usage: { ...assistant.usage, availability: "estimated" },
			}),
		).toBe(false);
		const { usage: _usage, ...withoutUsage } = assistant;
		expect(Value.Check(AssistantMessageSchema, withoutUsage)).toBe(false);
		expect(Value.Check(MessageSchema, { ...userText, timestamp: "1" })).toBe(false);
		expect(Value.Check(ActiveToolCallStateSchema, { contentIndex: 0.5, argsText: "{" })).toBe(false);
		expect(Value.Check(ActiveToolCallStateSchema, { contentIndex: 0, argsText: "{" })).toBe(true);
	});

	it("keeps the api open to custom providers", () => {
		expect(Value.Check(ApiSchema, "anthropic-messages")).toBe(true);
		expect(Value.Check(ApiSchema, "custom-api.v2")).toBe(true);
		expect(Value.Check(ApiSchema, 7)).toBe(false);
	});

	it("accepts the assistant messages the stream normalizer produces", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const counts = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
		const normalizer = new AssistantStreamNormalizer();
		normalizer.push({
			type: "start",
			init: { api: model.api, provider: model.provider, model: model.id, timestamp: 1 },
		});
		normalizer.push({ type: "meta", patch: { responseId: "msg_2" } });
		normalizer.push({ type: "thinking_start", contentIndex: 0 });
		normalizer.push({ type: "thinking_delta", contentIndex: 0, delta: "think" });
		normalizer.push({ type: "thinking_end", contentIndex: 0, thinkingSignature: "sig" });
		normalizer.push({ type: "toolcall_start", contentIndex: 1, id: "call_2", name: "bash" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 1, argsTextDelta: '{"command":"ls"}' });
		normalizer.push({ type: "toolcall_end", contentIndex: 1 });
		normalizer.push({
			type: "done",
			reason: "toolUse",
			usage: { availability: "complete", ...counts, cost: calculateCost(model, counts) },
		});
		normalizer.end();
		const message = await drainEventStream(normalizer.stream);
		expect(Compile(AssistantMessageSchema).Errors(message)).toEqual([]);
	});
});

describe("ai model schema", () => {
	it("accepts every built-in model", () => {
		const compiled = Compile(ModelSchema);
		let count = 0;
		for (const provider of getProviders()) {
			for (const model of getModels(provider)) {
				expect(compiled.Errors(model), `${provider}/${model.id}`).toEqual([]);
				count++;
			}
		}
		expect(count).toBeGreaterThan(100);
	});

	it("rejects unknown model fields and malformed metadata", () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		expect(Value.Check(ModelSchema, { ...model, unexpected: true })).toBe(false);
		expect(Value.Check(ModelSchema, { ...model, cost: { ...model.cost, total: 1 } })).toBe(false);
		expect(Value.Check(ModelSchema, { ...model, input: ["text", "audio"] })).toBe(false);
		expect(Value.Check(ModelSchema, { ...model, thinkingLevelMap: { ultra: "x" } })).toBe(false);
	});
});
