import type { AgentTool } from "@hansjm10/volt-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantStreamNormalizer } from "../../../../ai/src/stream/normalizer.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #350 bounded tool argument generation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup() {
		const execute = vi.fn(async (_toolCallId: string) => ({
			content: [{ type: "text" as const, text: "applied" }],
			details: {},
		}));
		const tool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Apply a test edit",
			parameters: Type.Object({ text: Type.String() }),
			execute,
		};
		const harness = await createHarness({
			tools: [tool],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		return { harness, execute };
	}

	function failureStep(kind: "progressing" | "final"): FauxResponseStep {
		return async (_context, _options, _state, model) => {
			const normalizer = new AssistantStreamNormalizer({
				toolArgumentLimits: kind === "progressing" ? { maxDurationMs: 20 } : { maxBytes: 32 },
			});
			normalizer.push({
				type: "start",
				init: {
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
				},
			});
			normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "unfinished", name: "edit" });
			if (kind === "progressing") {
				const producer = setInterval(() => {
					normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: " " });
				}, 1);
				normalizer.signal.addEventListener("abort", () => clearInterval(producer), { once: true });
			} else {
				normalizer.push({ type: "toolcall_end", contentIndex: 0, argumentsText: `{"text":"${"x".repeat(1000)}"}` });
			}
			const result = await normalizer.stream.result();
			expect(normalizer.signal.aborted).toBe(true);
			// Classification must rely on the typed diagnostic, including provider-looking text.
			return { ...result, errorMessage: "HTTP status 503: connection timeout" };
		};
	}

	it.each(["progressing", "final"] as const)(
		"ends %s argument generation without tool execution or automatic retry",
		async (kind) => {
			const { harness, execute } = await setup();
			harness.setResponses([failureStep(kind), fauxAssistantMessage("must stay queued")]);
			await harness.session.prompt("Apply the edit");
			expect(execute).not.toHaveBeenCalled();
			expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.isBusy).toBe(false);
			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "error",
				diagnostics: [expect.objectContaining({ type: "tool_argument_generation_limit" })],
			});
		},
	);

	it("permits explicit continuation without replaying previously completed tools", async () => {
		const { harness, execute } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { text: "first" }, { id: "completed" }), { stopReason: "toolUse" }),
			failureStep("final"),
			fauxAssistantMessage(fauxToolCall("edit", { text: "second" }, { id: "replacement" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Apply the edits");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		await harness.session.prompt("Retry the unfinished edit");
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls.map((call) => call[0])).toEqual(["completed", "replacement"]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.session.isBusy).toBe(false);
	});

	it("continues to retry ordinary transient outages", async () => {
		const { harness, execute } = await setup();
		harness.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "HTTP status 503: service unavailable" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("Continue");
		expect(execute).not.toHaveBeenCalled();
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
	});
});
