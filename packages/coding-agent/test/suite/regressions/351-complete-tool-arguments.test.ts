import type { AgentTool } from "@hansjm10/volt-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall, getModel } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, streamAnthropic } from "../../../../ai/src/providers/anthropic.ts";
import type { AssistantStreamFragment } from "../../../../ai/src/stream/fragments.ts";
import { AssistantStreamNormalizer } from "../../../../ai/src/stream/normalizer.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #351 complete tool arguments", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup() {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "applied" }], details: {} }));
		const tool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Test edit boundary",
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

	it.each([
		{ name: "repaired truncated string", raw: '{"text":"unfinished', end: true },
		{ name: "malformed final JSON", raw: '{"text":"complete",}', end: true },
		{ name: "valid JSON without completion", raw: '{"text":"complete"}', end: false },
	])("never invokes a tool and retries only with feedback for $name", async ({ raw, end }) => {
		const { harness, execute } = await setup();
		let retryContext: Context | undefined;
		harness.setResponses([
			async (_context, _options, _state, model) => {
				const normalizer = new AssistantStreamNormalizer();
				const fragments: AssistantStreamFragment[] = [
					{
						type: "start",
						init: { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() },
					},
					{ type: "toolcall_start", contentIndex: 0, id: "call-351", name: "edit" },
					{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: raw },
					...(end ? [{ type: "toolcall_end" as const, contentIndex: 0 }] : []),
					{ type: "done", reason: "toolUse" },
				];
				for (const fragment of fragments) normalizer.push(fragment);
				normalizer.end();
				const result = await normalizer.stream.result();
				// A provider may attach a transient-looking transport message as well.
				// The diagnostic must select an immediate feedback retry regardless of that text.
				return { ...result, errorMessage: "HTTP status 503: connection timeout" };
			},
			(context) => {
				retryContext = context;
				return fauxAssistantMessage("corrected");
			},
		]);

		await harness.session.prompt("Apply the edit");

		expect(execute).not.toHaveBeenCalled();
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
		expect(harness.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, delayMs: 0 }]);
		expect(harness.faux.state.callCount).toBe(2);
		const failure = harness.session.messages.find(
			(message) => message.role === "assistant" && message.stopReason === "error",
		);
		if (failure?.role !== "assistant") throw new Error("Expected assistant failure");
		expect(failure.diagnostics).toContainEqual(expect.objectContaining({ type: "invalid_tool_arguments" }));
		// The retry replaces the rejected response with feedback instead of replaying its call.
		expect(retryContext?.messages.map((message) => message.role)).toEqual(["user", "user"]);
		expect(JSON.stringify(retryContext?.messages.at(-1))).toContain("none of its tool calls were executed");
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("never executes or replays unrepairable Anthropic tool starts with transient-looking private arguments", async () => {
		const { harness, execute } = await setup();
		const payload =
			'{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"edit","input":{"text":"sensitive timeout"';
		const response = new Response(
			`event: message_start\ndata: {"type":"message_start","message":{"id":"msg","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: ${payload}\n\n`,
		);
		const client = { messages: { create: () => ({ asResponse: async () => response }) } } as unknown as NonNullable<
			AnthropicOptions["client"]
		>;
		let retryContext: Context | undefined;
		harness.setResponses([
			async () => streamAnthropic(getModel("anthropic", "claude-haiku-4-5"), { messages: [] }, { client }).result(),
			(context) => {
				retryContext = context;
				return fauxAssistantMessage("corrected");
			},
		]);
		await harness.session.prompt("Apply the edit");
		expect(execute).not.toHaveBeenCalled();
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
		expect(harness.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, delayMs: 0 }]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.at(-2)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			diagnostics: [expect.objectContaining({ type: "invalid_tool_arguments" })],
		});
		expect(JSON.stringify(harness.session.messages)).not.toContain("sensitive");
		expect(JSON.stringify(retryContext)).not.toContain("sensitive");
	});

	it("executes a valid fragmented faux call exactly once after completion", async () => {
		const { harness, execute } = await setup();
		const text = 'const code = "C:\\notes";\nconsole.log("done");';
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { text }, { id: "call-351" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Apply the edit");

		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]).toEqual(expect.arrayContaining(["call-351", { text }]));
		const deltas = harness
			.eventsOfType("message_update")
			.filter((event) => event.assistantMessageEvent.type === "toolcall_delta");
		expect(deltas.length).toBeGreaterThan(1);
		const completeIndex = harness.events.findIndex(
			(event) => event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end",
		);
		const executeIndex = harness.events.findIndex((event) => event.type === "tool_execution_start");
		expect(executeIndex).toBeGreaterThan(completeIndex);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
