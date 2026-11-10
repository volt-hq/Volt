import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { refreshPromptCacheAnthropic, streamAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.ts";
import type { AssistantMessage, Context, ContextMessage, Model } from "../src/types.ts";

const model = getModel("anthropic", "claude-fable-5-2");
const beta = "mid-conversation-output-config-2026-07-01";
const apiKeys = ["sk-ant-api03-test", "sk-ant-oat01-test"];
const defaultOptions = { apiKey: apiKeys[0], reasoning: "low" as const, cacheRetention: "none" as const };

type ContextUserMessage = Extract<ContextMessage, { role: "user" }>;

interface CapturedMessage {
	role: "user" | "assistant" | "system";
	content: unknown;
	output_config?: { effort: string };
}

interface CapturedPayload {
	messages: CapturedMessage[];
	output_config?: { effort: string };
	thinking?: { type: string };
	max_tokens: number;
	stream: boolean;
}

interface CapturedRequest {
	body: CapturedPayload;
	headers: Headers;
}

function user(
	content: ContextUserMessage["content"],
	thinkingLevel?: ContextUserMessage["thinkingLevel"],
): ContextUserMessage {
	return { role: "user", content, timestamp: 1, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) };
}

function assistant(content: AssistantMessage["content"] = [{ type: "text", text: "Done." }]): AssistantMessage {
	return {
		role: "assistant",
		content,
		provider: model.provider,
		api: model.api,
		model: model.id,
		timestamp: 2,
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
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

function captureRequests(): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as CapturedPayload;
			requests.push({ body, headers: new Headers(init?.headers) });
			if (!body.stream) {
				return new Response(
					JSON.stringify({
						id: "msg_refresh",
						type: "message",
						role: "assistant",
						content: [],
						stop_reason: "max_tokens",
						usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 4000 },
					}),
					{ headers: { "content-type": "application/json" } },
				);
			}
			const events = [
				{ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } } },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			];
			return new Response(
				events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		}),
	);
	return requests;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Anthropic per-message effort", () => {
	it.each(apiKeys)("sends effort-only controls and the required beta with %s", async (apiKey) => {
		const requests = captureRequests();
		const context: Context = { messages: [user("Plan it", "high"), assistant(), user("Summarize", "low")] };
		const original = structuredClone(context);
		const result = await streamSimpleAnthropic(model, context, { ...defaultOptions, apiKey }).result();

		expect(result.stopReason, result.error?.message).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].body).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
			messages: [
				{ role: "user", content: "Plan it" },
				{ role: "assistant", content: [{ type: "text", text: "Done." }] },
				{ role: "system", content: [], output_config: { effort: "low" } },
				{ role: "user", content: "Summarize" },
			],
		});
		const isOAuth = apiKey.includes("oat");
		expect(requests[0].headers.get("anthropic-beta")?.split(",")).toEqual(
			isOAuth ? ["claude-code-20250219", "oauth-2025-04-20", beta] : [beta],
		);
		expect(requests[0].headers.get(isOAuth ? "authorization" : "x-api-key")).toBe(
			isOAuth ? `Bearer ${apiKey}` : apiKey,
		);
		expect(requests[0].body).not.toHaveProperty("context_management");
		expect(context).toEqual(original);
	});

	it.each(apiKeys)("retains the required beta when callers override optional betas with %s", async (apiKey) => {
		const requests = captureRequests();
		await streamSimpleAnthropic(
			{ ...model, headers: { "Anthropic-Beta": "model-beta" } },
			{ messages: [user("First", "high"), assistant(), user("Second", "low")] },
			{ ...defaultOptions, apiKey, headers: { "ANTHROPIC-BETA": "custom-beta" } },
		).result();

		expect(requests).toHaveLength(1);
		expect(requests[0].headers.get("anthropic-beta")?.split(",")).toEqual(["custom-beta", beta]);
		expect(requests[0].body.messages[2]).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
	});

	it("keeps the serialized history and top-level effort stable across later changes", async () => {
		const requests = captureRequests();
		const messages: ContextMessage[] = [user("First", "high"), assistant()];
		await streamSimpleAnthropic(model, { messages }, { ...defaultOptions, reasoning: "high" }).result();
		messages.push(user("Second", "low"), assistant());
		await streamSimpleAnthropic(model, { messages }, defaultOptions).result();
		messages.push(user("Third", "xhigh"));
		await streamSimpleAnthropic(model, { messages }, { ...defaultOptions, reasoning: "xhigh" }).result();
		await streamSimpleAnthropic(model, { messages }, { ...defaultOptions, reasoning: "max" }).result();

		expect(requests).toHaveLength(4);
		for (let i = 0; i < 3; i++) {
			expect(requests[i].body.output_config).toEqual({ effort: "high" });
			if (i > 0) {
				expect(JSON.stringify(requests[i].body.messages.slice(0, requests[i - 1].body.messages.length))).toBe(
					JSON.stringify(requests[i - 1].body.messages),
				);
			}
		}
		expect(requests[2].body.messages.filter((message) => message.role === "system")).toEqual([
			{ role: "system", content: [], output_config: { effort: "low" } },
			{ role: "system", content: [], output_config: { effort: "xhigh" } },
		]);
		// A changed request option without new input cannot rewrite historical effort.
		expect(requests[3].body).toEqual(requests[2].body);
	});

	it("does not activate a pending effort change on tool-result-only continuations", async () => {
		const requests = captureRequests();
		const messages: ContextMessage[] = [
			user("Inspect", "high"),
			assistant([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }]),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3,
			},
		];
		await streamSimpleAnthropic(model, { messages }, defaultOptions).result();
		messages.push(user("Now summarize", "low"));
		await streamSimpleAnthropic(model, { messages }, defaultOptions).result();

		expect(requests).toHaveLength(2);
		expect(requests[0].body.output_config).toEqual({ effort: "high" });
		expect(requests[0].body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(requests[1].body.messages.slice(0, 3)).toEqual(requests[0].body.messages);
		expect(requests[1].body.messages.slice(3)).toEqual([
			{ role: "system", content: [], output_config: { effort: "low" } },
			{ role: "user", content: "Now summarize" },
		]);
	});

	describe.each([
		{ before: "high", after: "off" },
		{ before: "off", after: "high" },
	] as const)("pending $before → $after", ({ before, after }) => {
		it.each(apiKeys)("keeps mode, controls, and token caps stable until rendered input with %s", async (apiKey) => {
			const requests = captureRequests();
			const target = getModel("anthropic", "claude-opus-5");
			const messages: ContextMessage[] = [
				user("Earlier", "medium"),
				{ ...assistant(), model: target.id },
				user("Inspect", before),
				{
					...assistant([
						{ type: "thinking", thinking: "Reasoned.", thinkingSignature: "signed" },
						{ type: "toolCall", id: "call_1", name: "read", arguments: {} },
					]),
					model: target.id,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
				user("Automatic reminder"),
			];
			const options = { apiKey, maxTokens: 1024, cacheRetention: "short" as const };
			await streamSimpleAnthropic(
				target,
				{ messages },
				{ ...options, reasoning: before === "off" ? undefined : before },
			).result();
			const pending = { ...options, reasoning: after === "off" ? undefined : after };
			// Even annotated input cannot activate a change if it renders nothing.
			messages.push(user([{ type: "text", text: "\uD800" }], after));
			await streamSimpleAnthropic(target, { messages }, pending).result();
			expect((await refreshPromptCacheAnthropic(target, { messages }, pending)).status).toBe("refreshed");
			messages.push(user("Next task", after));
			await streamSimpleAnthropic(target, { messages }, pending).result();

			expect(requests).toHaveLength(4);
			expect(requests[1].body).toEqual(requests[0].body);
			expect(requests[2].body).toEqual({ ...requests[0].body, stream: false, max_tokens: 0 });
			expect(requests[1].headers.get("anthropic-beta")).toBe(requests[0].headers.get("anthropic-beta"));
			expect(requests[2].headers.get("anthropic-beta")).toBe(requests[0].headers.get("anthropic-beta"));
			for (const [index, level] of [
				[0, before],
				[3, after],
			] as const) {
				const payload = requests[index].body;
				expect(payload.thinking?.type).toBe(level === "off" ? "disabled" : "adaptive");
				expect(payload.max_tokens).toBe(level === "off" ? 1024 : 17408);
				expect(payload.output_config).toEqual(level === "off" ? undefined : { effort: "medium" });
				expect(payload.messages.filter((message) => message.role === "system")).toEqual(
					level === "off" ? [] : [{ role: "system", content: [], output_config: { effort: "high" } }],
				);
				expect(requests[index].headers.get("anthropic-beta")?.split(",") ?? []).toEqual([
					...(apiKey.includes("oat") ? ["claude-code-20250219", "oauth-2025-04-20"] : []),
					...(level === "off" ? [] : [beta]),
				]);
			}
		});
	});

	it("does not emit disabled thinking for a model that forbids it", async () => {
		const requests = captureRequests();
		await streamSimpleAnthropic(
			model,
			{ messages: [user("Historical off selection", "off")] },
			defaultOptions,
		).result();
		expect(requests[0].body).not.toHaveProperty("thinking");
	});

	it("uses the earliest rendered annotated input, ignoring blanks, missing snapshots, and off", async () => {
		const requests = captureRequests();
		await streamSimpleAnthropic(
			model,
			{
				messages: [
					user("Unannotated history"),
					user(" ", "max"),
					user([{ type: "text", text: "\n" }], "xhigh"),
					user("Thinking was disabled", "off"),
					user("First effort", "medium"),
					assistant(),
					user("Unannotated follow-up"),
					user(" ", "low"),
				],
			},
			defaultOptions,
		).result();

		expect(requests).toHaveLength(1);
		expect(requests[0].body.output_config).toEqual({ effort: "medium" });
		expect(requests[0].body.messages.filter((message) => message.role === "system")).toEqual([]);
		expect(requests[0].body.messages).toHaveLength(5);
	});

	it.each([
		{ name: "high surrogate", content: "\uD800" },
		{ name: "low surrogate", content: "\uDC00" },
		{ name: "surrogate text array", content: [{ type: "text", text: "\uD800" }] },
		{ name: "empty array", content: [] },
		{ name: "whitespace", content: " \n\t" },
		{ name: "sanitized whitespace array", content: [{ type: "text", text: " \uDC00\t" }] },
	] satisfies { name: string; content: ContextUserMessage["content"] }[])(
		"ignores $name input before the baseline, between inputs, and at the tail",
		async ({ content }) => {
			const requests = captureRequests();
			const clean: Context = {
				messages: [user("First", "high"), assistant(), user("Inherit"), user("Next", "low")],
			};
			const dirty: Context = {
				messages: [
					user(content, "max"),
					...clean.messages.slice(0, 2),
					user(content, "low"),
					...clean.messages.slice(2),
					user(content, "xhigh"),
				],
			};
			const original = structuredClone(dirty);
			const options = { ...defaultOptions, cacheRetention: "short" as const };
			await streamSimpleAnthropic(model, clean, options).result();
			await streamSimpleAnthropic(model, dirty, options).result();
			expect((await refreshPromptCacheAnthropic(model, dirty, options)).status).toBe("refreshed");
			expect(requests).toHaveLength(3);
			expect(requests[1].body).toEqual(requests[0].body);
			expect(requests[2].body).toEqual({ ...requests[0].body, stream: false, max_tokens: 0 });
			expect(requests.map((request) => request.headers.get("anthropic-beta"))).toEqual([beta, beta, beta]);
			expect(requests[1].body.output_config).toEqual({ effort: "high" });
			expect(requests[1].body.messages.slice(2)).toEqual([
				{ role: "user", content: "Inherit" },
				{ role: "system", content: [], output_config: { effort: "low" } },
				{ role: "user", content: [{ type: "text", text: "Next", cache_control: { type: "ephemeral" } }] },
			]);
			expect(dirty).toEqual(original);
		},
	);

	it("leaves no dangling control when the last user input sanitizes away after an assistant", async () => {
		const requests = captureRequests();
		await streamSimpleAnthropic(
			model,
			{ messages: [user("First", "high"), assistant(), user([{ type: "text", text: "\uD800" }], "low")] },
			defaultOptions,
		).result();
		expect(requests[0].body.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(requests[0].body.output_config).toEqual({ effort: "high" });
	});

	it("does not enable the effort beta when every annotated input sanitizes away", async () => {
		const requests = captureRequests();
		await streamSimpleAnthropic(
			model,
			{ messages: [user("\uD800", "high"), user("Unannotated"), user([{ type: "text", text: "\uDC00" }], "max")] },
			defaultOptions,
		).result();
		expect(requests[0].body.messages).toEqual([{ role: "user", content: "Unannotated" }]);
		expect(requests[0].body.output_config).toEqual({ effort: "low" });
		expect(requests[0].headers.get("anthropic-beta")).toBeNull();
	});

	it("keeps valid text and images when neighboring text blocks sanitize away", async () => {
		const requests = captureRequests();
		await streamSimpleAnthropic(
			model,
			{
				messages: [
					user("First", "high"),
					assistant(),
					user(
						[
							{ type: "text", text: "\uD800" },
							{ type: "text", text: " keep \uDC00text \uD83D\uDE42 " },
							{ type: "image", data: "AA==", mimeType: "image/png" },
						],
						"low",
					),
				],
			},
			defaultOptions,
		).result();
		expect(requests[0].body.messages.slice(-2)).toEqual([
			{ role: "system", content: [], output_config: { effort: "low" } },
			{
				role: "user",
				content: [
					{ type: "text", text: " keep text \uD83D\uDE42 " },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
				],
			},
		]);
	});

	it("deduplicates mapped effort and preserves annotations through image normalization", async () => {
		const requests = captureRequests();
		await streamSimpleAnthropic(
			{ ...model, input: ["text"] },
			{
				messages: [
					user([{ type: "image", data: "AA==", mimeType: "image/png" }], "minimal"),
					assistant(),
					user("Same mapped effort", "low"),
					assistant(),
					user("Full effort", "max"),
				],
			},
			{ ...defaultOptions, reasoning: "max" },
		).result();

		expect(requests).toHaveLength(1);
		expect(requests[0].body.output_config).toEqual({ effort: "low" });
		expect(requests[0].body.messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "(image omitted: model does not support images)" }],
		});
		expect(requests[0].body.messages.filter((message) => message.role === "system")).toEqual([
			{ role: "system", content: [], output_config: { effort: "max" } },
		]);
	});

	it.each(apiKeys)("leaves unannotated requests unchanged with %s", async (apiKey) => {
		const requests = captureRequests();
		await streamSimpleAnthropic(
			model,
			{ messages: [user("First"), assistant(), user("Second")] },
			{
				...defaultOptions,
				apiKey,
			},
		).result();

		expect(requests).toHaveLength(1);
		expect(requests[0].body.output_config).toEqual({ effort: "low" });
		expect(requests[0].body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(requests[0].headers.get("anthropic-beta")?.split(",") ?? []).toEqual(
			apiKey.includes("oat") ? ["claude-code-20250219", "oauth-2025-04-20"] : [],
		);
	});

	it.each([
		{ id: "claude-fable-5" },
		{ id: "claude-opus-4-8" },
		{ id: "claude-sonnet-5" },
		{ id: "claude-opus-6" },
		{ provider: "github-copilot" },
		{ provider: "custom-anthropic" },
		{ baseUrl: "https://proxy.example/anthropic" },
		{ compat: { forceAdaptiveThinking: false } },
		{ reasoning: false },
	] satisfies Partial<Model<"anthropic-messages">>[])(
		"keeps the original payload for unsupported capability %j",
		async (overrides) => {
			const requests = captureRequests();
			const unsupported = { ...model, ...overrides };
			for (const annotated of [false, true]) {
				await streamSimpleAnthropic(
					unsupported,
					{
						messages: [
							user("First", annotated ? "high" : undefined),
							assistant(),
							user("Second", annotated ? "medium" : undefined),
						],
					},
					defaultOptions,
				).result();
			}
			expect(requests).toHaveLength(2);
			expect(requests[1].body).toEqual(requests[0].body);
			expect(requests[1].headers.get("anthropic-beta")?.split(",") ?? []).not.toContain(beta);
		},
	);

	it.each([undefined, false] as const)("does not enable the beta with thinkingEnabled=%s", async (thinkingEnabled) => {
		const requests = captureRequests();
		await streamAnthropic(
			model,
			{ messages: [user("First", "high"), assistant(), user("Second", "low")] },
			{
				apiKey: apiKeys[0],
				thinkingEnabled,
				effort: "low",
			},
		).result();
		expect(requests).toHaveLength(1);
		expect(requests[0].body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(requests[0].headers.get("anthropic-beta")?.split(",") ?? []).not.toContain(beta);
	});

	it("does not assume a supplied SDK client uses the direct Anthropic endpoint", async () => {
		const requests = captureRequests();
		await streamAnthropic(
			model,
			{ messages: [user("First", "high"), assistant(), user("Second", "medium")] },
			{
				client: new Anthropic({ apiKey: apiKeys[0], baseURL: "https://proxy.example" }),
				thinkingEnabled: true,
				effort: "low",
				cacheRetention: "none",
			},
		).result();

		expect(requests).toHaveLength(1);
		expect(requests[0].body.output_config).toEqual({ effort: "low" });
		expect(requests[0].body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(requests[0].headers.get("anthropic-beta")).toBeNull();
	});

	it.each(apiKeys)(
		"refreshes the identical effort history and keeps the cache breakpoint on input with %s",
		async (apiKey) => {
			const requests = captureRequests();
			const context: Context = {
				systemPrompt: "Be terse.",
				messages: [
					user("First", "high"),
					assistant([
						{ type: "thinking", thinking: "", thinkingSignature: "signed-empty-thinking" },
						{ type: "thinking", thinking: "Reasoned.", thinkingSignature: "signed-thinking" },
						{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true },
						{ type: "text", text: "Done." },
					]),
					user("Second", "low"),
				],
			};
			const options = { ...defaultOptions, apiKey, cacheRetention: "short" as const };
			const streamed = await streamSimpleAnthropic(model, context, options).result();
			const refreshed = await refreshPromptCacheAnthropic(model, context, options);

			expect(streamed.stopReason, streamed.error?.message).toBe("stop");
			expect(refreshed.status).toBe("refreshed");
			expect(requests).toHaveLength(2);
			expect(requests[1].body).toEqual({ ...requests[0].body, stream: false, max_tokens: 0 });
			expect(requests[1].headers.get("anthropic-beta")).toBe(requests[0].headers.get("anthropic-beta"));
			expect(requests[0].body.messages[1].content).toEqual([
				{ type: "thinking", thinking: "", signature: "signed-empty-thinking" },
				{ type: "thinking", thinking: "Reasoned.", signature: "signed-thinking" },
				{ type: "redacted_thinking", data: "opaque" },
				{ type: "text", text: "Done." },
			]);
			expect(requests[0].body.messages.slice(-2)).toEqual([
				{ role: "system", content: [], output_config: { effort: "low" } },
				{ role: "user", content: [{ type: "text", text: "Second", cache_control: { type: "ephemeral" } }] },
			]);
		},
	);

	it("does not change the cross-model thinking replay policy", async () => {
		const requests = captureRequests();
		const otherModel = assistant([
			{ type: "thinking", thinking: "", thinkingSignature: "other-empty-signature" },
			{ type: "thinking", thinking: "Reasoning", thinkingSignature: "other-signature" },
			{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true },
		]);
		otherModel.model = "claude-opus-5";
		await streamSimpleAnthropic(
			model,
			{ messages: [user("First", "high"), otherModel, user("Next", "low")] },
			defaultOptions,
		).result();

		expect(requests).toHaveLength(1);
		expect(requests[0].body.messages[1]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Reasoning" }],
		});
	});
});
