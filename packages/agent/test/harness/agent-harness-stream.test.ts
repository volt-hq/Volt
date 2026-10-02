import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type SimpleStreamOptions as StreamOptions,
	streamSimple,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { convertToLlm } from "../../src/harness/messages.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { StreamFn } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";
import { prompt } from "./harness-test-utils.ts";
import { InMemorySessionStorage } from "./in-memory-session-storage.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function createHarness(options: ConstructorParameters<typeof AgentHarness>[0]): AgentHarness {
	return new AgentHarness(options);
}

function captureOptions(options: StreamOptions | undefined): StreamOptions {
	return {
		...options,
		...(options?.headers ? { headers: { ...options.headers } } : {}),
		...(options?.metadata ? { metadata: { ...options.metadata } } : {}),
		...(options?.env ? { env: { ...options.env } } : {}),
	};
}

describe("AgentHarness stream configuration", () => {
	it("uses configurable base stream and message converter functions", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		let streamCalls = 0;
		let converterCalls = 0;
		const harness = createHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			streamFn: async (model, context, options) => {
				streamCalls++;
				return streamSimple(model, context, options);
			},
			convertToLlm: async (messages) => {
				converterCalls++;
				return convertToLlm(messages);
			},
		});

		await prompt(harness, "hello");

		expect(streamCalls).toBe(1);
		expect(converterCalls).toBe(1);
	});

	it("forwards snapshotted stream options and notifies response hooks", async () => {
		let capturedOptions: StreamOptions | undefined;
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			(_context, options) => {
				capturedOptions = options;
				return fauxAssistantMessage("ok");
			},
		]);

		const session = new Session(new InMemorySessionStorage({ metadata: { id: "session-1", createdAt: "now" } }));
		const harness = createHarness({
			session,
			model: registration.getModel(),
			streamOptions: {
				timeoutMs: 1000,
				websocketConnectTimeoutMs: 1500,
				maxRetries: 2,
				maxRetryDelayMs: 3000,
				headers: { "x-base": "base" },
				metadata: { base: true },
				env: { BASE_ENV: "base", SHARED_ENV: "base" },
				inferenceSpeed: "fast",
				thinkingBudgets: { low: 128 },
				transport: "websocket",
				cacheRetention: "none",
			},
		});

		let responseHookCalls = 0;
		harness.on("after_provider_response", (event) => {
			responseHookCalls++;
			expect(event.status).toBe(200);
			return undefined;
		});

		await prompt(harness, "hello");

		expect(responseHookCalls).toBe(1);
		expect(capturedOptions).toMatchObject({
			timeoutMs: 1000,
			websocketConnectTimeoutMs: 1500,
			maxRetries: 2,
			maxRetryDelayMs: 3000,
			sessionId: "session-1",
			inferenceSpeed: "fast",
			thinkingBudgets: { low: 128 },
			transport: "websocket",
			cacheRetention: "none",
		});
		expect(capturedOptions?.apiKey).toBeUndefined();
		expect(capturedOptions?.headers).toEqual({ "x-base": "base" });
		expect(capturedOptions?.metadata).toEqual({ base: true });
		expect(capturedOptions?.env).toEqual({ BASE_ENV: "base", SHARED_ENV: "base" });
	});

	it("uses updated stream options for save-point snapshots without mutating the active request", async () => {
		const capturedOptions: StreamOptions[] = [];
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			(_context, options) => {
				capturedOptions.push(captureOptions(options));
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(_context, options) => {
				capturedOptions.push(captureOptions(options));
				return fauxAssistantMessage("done");
			},
		]);

		const harness = createHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			streamOptions: { timeoutMs: 1000, headers: { turn: "first" } },
		});
		await harness.setTools([calculateTool], [calculateTool.name]);

		harness.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				harness.setStreamOptions({ timeoutMs: 2000, headers: { turn: "second" } });
			}
		});

		await prompt(harness, "hello");

		expect(capturedOptions).toHaveLength(2);
		expect(capturedOptions[0]?.timeoutMs).toBe(1000);
		expect(capturedOptions[0]?.headers).toEqual({ turn: "first" });
		expect(capturedOptions[1]?.timeoutMs).toBe(2000);
		expect(capturedOptions[1]?.headers).toEqual({ turn: "second" });
	});

	it("chains provider payload hooks", async () => {
		const seenPayloads: unknown[] = [];
		let finalPayload: unknown;
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			async (_context, options, _state, model) => {
				finalPayload = await options?.onPayload?.({ steps: ["provider"] }, model);
				return fauxAssistantMessage("ok");
			},
		]);

		const harness = createHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});

		harness.on("before_provider_payload", (event) => {
			seenPayloads.push(event.payload);
			return { payload: { steps: ["provider", "first"] } };
		});
		harness.on("before_provider_payload", (event) => {
			seenPayloads.push(event.payload);
			return { payload: { steps: ["provider", "first", "second"] } };
		});

		await prompt(harness, "hello");

		expect(seenPayloads).toEqual([{ steps: ["provider"] }, { steps: ["provider", "first"] }]);
		expect(finalPayload).toEqual({ steps: ["provider", "first", "second"] });
	});

	it("routes structural requests through snapshotted provider policy and lifecycle hooks", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("branch summary")]);
		const session = new Session(new InMemorySessionStorage({ metadata: { id: "branch-session", createdAt: "now" } }));
		let capturedOptions: StreamOptions | undefined;
		let payloadHookCalls = 0;
		let responseHookCalls = 0;
		const streamFn: StreamFn = async (model, context, options) => {
			capturedOptions = captureOptions(options);
			await options?.onPayload?.({ structural: true }, model);
			return streamSimple(model, context, options);
		};
		const harness = createHarness({
			session,
			model: registration.getModel(),
			streamFn,
			streamOptions: {
				env: { BASE_ENV: "base" },
				headers: { "x-base": "base" },
				metadata: { base: true },
			},
		});
		harness.on("before_provider_payload", () => {
			payloadHookCalls++;
			return undefined;
		});
		harness.on("after_provider_response", () => {
			responseHookCalls++;
			return undefined;
		});

		await harness.requestTreeOperation(async (operation) => {
			const stream = await operation.streamFn(
				registration.getModel(),
				{ messages: [{ role: "user", content: "summarize", timestamp: 1 }] },
				{ maxTokens: 2048, signal: operation.signal },
			);
			await stream.result();
		});

		expect(capturedOptions).toMatchObject({ maxTokens: 2048, sessionId: "branch-session" });
		expect(capturedOptions?.env).toEqual({ BASE_ENV: "base" });
		expect(capturedOptions?.headers).toEqual({ "x-base": "base" });
		expect(capturedOptions?.metadata).toEqual({ base: true });
		expect(payloadHookCalls).toBe(1);
		expect(responseHookCalls).toBe(1);
	});

	it("preserves operation-requested reasoning for structural provider work", async () => {
		const registration = registerFauxProvider({ models: [{ id: "reasoning", reasoning: true }] });
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("summary")]);
		let capturedReasoning: unknown;
		const harness = createHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			thinkingLevel: "xhigh",
			streamFn: (model, context, options) => {
				capturedReasoning = options?.reasoning;
				return streamSimple(model, context, options);
			},
		});

		await harness.requestTreeOperation(async (operation) => {
			const stream = await operation.streamFn(
				registration.getModel(),
				{ messages: [{ role: "user", content: "summarize", timestamp: 1 }] },
				{ reasoning: "low" },
			);
			for await (const _event of stream) {
				// Drain the policy-wrapped stream.
			}
		});

		expect(capturedReasoning).toBe("low");
	});

	it("snapshots tool argument limits and applies replacement and clearing", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const seen: Array<StreamOptions["toolArgumentLimits"]> = [];
		registration.setResponses(
			Array.from({ length: 3 }, () => (_context, options) => {
				seen.push(options?.toolArgumentLimits);
				return fauxAssistantMessage("ok");
			}),
		);
		const limits = { maxBytes: 128, maxDurationMs: 1000 };
		const harness = createHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			streamOptions: { toolArgumentLimits: limits },
		});
		limits.maxBytes = 999;
		const snapshot = harness.getStreamOptions();
		if (snapshot.toolArgumentLimits) snapshot.toolArgumentLimits.maxBytes = 999;
		await prompt(harness, "base");
		await harness.setStreamOptions({ toolArgumentLimits: { maxTotalBytes: 512 } });
		await prompt(harness, "replace");
		await harness.setStreamOptions({});
		await prompt(harness, "clear");
		expect(seen).toEqual([{ maxBytes: 128, maxDurationMs: 1000 }, { maxTotalBytes: 512 }, undefined]);
		expect(harness.getStreamOptions().toolArgumentLimits).toBeUndefined();
	});
});
