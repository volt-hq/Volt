import type { AgentTool } from "@hansjm10/volt-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantStreamNormalizer } from "../../../ai/src/stream/normalizer.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { SubagentManager } from "../../src/core/subagents/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function interruptedResponse(errorMessage = "WebSocket error"): FauxResponseFactory {
	return async (_context, _options, _state, model) => {
		const normalizer = new AssistantStreamNormalizer();
		normalizer.push({
			type: "start",
			init: { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() },
		});
		// Even a completed call in the failed response must not execute.
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "failed-complete", name: "echo" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"must not execute"}' });
		normalizer.push({ type: "toolcall_end", contentIndex: 0 });
		normalizer.push({ type: "toolcall_start", contentIndex: 1, id: "failed-partial", name: "echo" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 1, argsTextDelta: '{"text":"unfinished' });
		normalizer.push({ type: "error", reason: "error", errorMessage });
		normalizer.end();
		return normalizer.stream.result();
	};
}

const retrySettings = {
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
};

describe("tool response transport recovery", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	});

	async function setup() {
		const parameters = Type.Object({ text: Type.String() });
		const execute = vi.fn(async (_id: string, args: { text: string }) => ({
			content: [{ type: "text" as const, text: args.text }],
		}));
		const tool: AgentTool<typeof parameters> = {
			name: "echo",
			label: "Echo",
			description: "Record completed calls",
			parameters,
			execute,
		};
		const harness = await createHarness({ tools: [tool], settings: retrySettings });
		harnesses.push(harness);
		return { harness, execute };
	}

	it.each(["WebSocket error", "fetch failed", "HTTP status 503: connection timeout"])(
		"retries %s without replaying successful tools or sending the failed response",
		async (errorMessage) => {
			const { harness, execute } = await setup();
			const sessionId = harness.session.sessionId;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("echo", { text: "previous result" }, { id: "previous" }), {
					stopReason: "toolUse",
				}),
				interruptedResponse(errorMessage),
				(context, options) => {
					expect(options?.sessionId).toBe(sessionId);
					expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
					expect(context.messages.at(-1)).toMatchObject({ toolCallId: "previous", isError: false });
					expect(execute).toHaveBeenCalledTimes(1);
					return fauxAssistantMessage(fauxToolCall("echo", { text: "replacement" }, { id: "replacement" }), {
						stopReason: "toolUse",
					});
				},
				fauxAssistantMessage("review complete"),
			]);

			await harness.session.prompt("finish the review");

			expect(execute.mock.calls.map(([id]) => id)).toEqual(["previous", "replacement"]);
			expect(harness.faux.state.callCount).toBe(4);
			expect(harness.session.sessionId).toBe(sessionId);
			expect(harness.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, delayMs: 1, errorMessage }]);
			expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true }]);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(harness.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({ message: expect.objectContaining({ stopReason: "error", errorMessage }) }),
			);
			expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
		},
	);

	it("exhausts the existing retry limit without executing any failed calls", async () => {
		const { harness, execute } = await setup();
		harness.setResponses([
			interruptedResponse(),
			interruptedResponse(),
			interruptedResponse(),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("finish the review");

		expect(execute).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toMatchObject([
			{ attempt: 1, delayMs: 1 },
			{ attempt: 2, delayMs: 2 },
		]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: false, attempt: 2, finalError: "WebSocket error" },
		]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it.each(["invalid_api_key", "insufficient_quota", "HTTP status 400: bad request", "An unknown error occurred"])(
		"does not retry a non-transient provider failure: %s",
		async (errorMessage) => {
			const { harness, execute } = await setup();
			harness.setResponses([interruptedResponse(errorMessage), fauxAssistantMessage("unused")]);
			await harness.session.prompt("finish the review");
			expect(execute).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		},
	);

	it.each([
		"invalid_tool_arguments",
		"tool_argument_generation_limit",
		"assistant_stream_queue_limit",
		"assistant_stream_processing_error",
	])("keeps %s non-retryable even with a transient-looking cause", async (type) => {
		const { harness, execute } = await setup();
		harness.setResponses([
			async (...args) => ({
				...(await interruptedResponse()(...args)),
				diagnostics: [{ type, timestamp: 0, details: { code: "invalid_json" } }],
			}),
			fauxAssistantMessage("unused"),
		]);
		await harness.session.prompt("finish the review");
		expect(execute).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it("honors disabled retries", async () => {
		const { harness, execute } = await setup();
		harness.settingsManager.applyOverrides({ retry: { enabled: false } });
		harness.setResponses([interruptedResponse(), fauxAssistantMessage("unused")]);
		await harness.session.prompt("finish the review");
		expect(execute).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it("honors cancellation during retry backoff", async () => {
		const { harness, execute } = await setup();
		harness.settingsManager.applyOverrides({ retry: { baseDelayMs: 60_000 } });
		harness.setResponses([interruptedResponse(), fauxAssistantMessage("unused")]);
		const started = Promise.withResolvers<void>();
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") started.resolve();
		});
		const prompt = harness.session.prompt("finish the review");
		await started.promise;
		await harness.session.abort();
		await prompt;
		expect(execute).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, finalError: "Retry cancelled" }]);
	});

	it.each([false, true])(
		"settles a child only after transport recovery finishes (exhausted=%s)",
		async (exhausted) => {
			const { harness } = await setup();
			const retryStarted = Promise.withResolvers<void>();
			const finishRetry = Promise.withResolvers<void>();
			harness.setResponses([
				interruptedResponse(),
				async (...args) => {
					retryStarted.resolve();
					await finishRetry.promise;
					return exhausted ? interruptedResponse()(...args) : fauxAssistantMessage("review complete");
				},
			]);
			const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
				const services = await createAgentSessionServices({
					cwd,
					agentDir,
					authStorage: harness.authStorage,
					resourceLoaderOptions: {
						noExtensions: true,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
					},
				});
				services.settingsManager.applyOverrides({
					...retrySettings,
					retry: { ...retrySettings.retry, maxRetries: 1 },
				});
				const created = await createAgentSessionFromServices({
					services,
					sessionManager,
					model: harness.getModel(),
					noTools: "all",
				});
				created.session.setSessionName("tool response recovery child");
				return { ...created, services, diagnostics: services.diagnostics };
			};
			const manager = new SubagentManager({ createRuntime, cwd: harness.tempDir, agentDir: harness.tempDir });
			try {
				const handle = await manager.start();
				const completion = handle.waitForEnd();
				let settled = false;
				void completion.then(() => {
					settled = true;
				});
				await handle.prompt("finish the review");
				await retryStarted.promise;
				expect(settled).toBe(false);
				expect(manager.listActivities()).toMatchObject([{ id: handle.id, status: "running" }]);
				finishRetry.resolve();
				const result = await completion;
				expect(result).toMatchObject({
					id: handle.id,
					sessionId: handle.sessionId,
					status: exhausted ? "failed" : "completed",
				});
				expect(result.error).toBe(exhausted ? "WebSocket error" : undefined);
				expect(manager.listDelegations()).toMatchObject([{ id: handle.id, status: result.status }]);
				expect(harness.faux.state.callCount).toBe(2);
			} finally {
				finishRetry.resolve();
				await manager.dispose();
			}
		},
	);
});
