import type { AgentTool } from "@hansjm10/volt-agent-core";
import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	getModel,
	type SimpleStreamOptions,
} from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { streamSimpleAnthropic } from "../../../../ai/src/providers/anthropic.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0).reverse()) await harness.cleanupAsync();
});

async function anthropicHarness(options: Parameters<typeof createHarness>[0] = {}) {
	const harness = await createHarness({
		provider: "anthropic",
		models: [{ id: "claude-fable-5-2", reasoning: true }],
		...options,
		settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 }, ...options.settings },
	});
	harnesses.push(harness);
	return harness;
}

function inputLevels(context: Context) {
	return context.messages.flatMap((message) => (message.role === "user" ? [message.thinkingLevel] : []));
}

describe("#1068 Anthropic effort history", () => {
	it("defers a tool-loop change to the next new input without leaking metadata to the log or clients", async () => {
		let harness: Harness;
		const tool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Test tool",
			parameters: Type.Object({}),
			execute: async () => {
				await harness.session.setThinkingLevel("low", { persistDefault: false });
				return { content: [{ type: "text", text: "result" }] };
			},
		};
		harness = await anthropicHarness({ tools: [tool] });
		await harness.session.setThinkingLevel("high", { persistDefault: false });
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push({ ...context, messages: structuredClone(context.messages) });
				return fauxAssistantMessage([fauxToolCall("inspect", {})], { stopReason: "toolUse" });
			},
			(context) => {
				requests.push({ ...context, messages: structuredClone(context.messages) });
				return fauxAssistantMessage("done");
			},
			(context) => {
				requests.push({ ...context, messages: structuredClone(context.messages) });
				return fauxAssistantMessage("follow-up");
			},
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(requests.map(inputLevels)).toEqual([["high"], ["high"], ["high", "low"]]);
		expect(requests[1]?.messages.at(-1)?.role).toBe("toolResult");
		for (const entry of harness.sessionManager.getEntries()) {
			if (entry.type === "message") expect(entry.message).not.toHaveProperty("thinkingLevel");
		}
		for (const event of harness.eventsOfType("message_end"))
			expect(event.message).not.toHaveProperty("thinkingLevel");
	});

	it.each(["prompt", "steer", "followUp", "sendUserMessage"] as const)(
		"keeps reminders unannotated until a real %s is delivered",
		async (delivery) => {
			let harness: Harness;
			const tool: AgentTool = {
				name: "inspect",
				label: "Inspect",
				description: "Test tool",
				parameters: Type.Object({}),
				execute: async () => {
					await harness.session.setThinkingLevel("low", { persistDefault: false });
					await harness.session.sendCustomMessage({
						customType: "reminder",
						content: "Keep working.",
						display: false,
					});
					return { content: [{ type: "text", text: "result" }] };
				},
			};
			harness = await anthropicHarness({ tools: [tool] });
			await harness.session.setThinkingLevel("high", { persistDefault: false });
			const requests: Context[] = [];
			harness.setResponses([
				(context) => {
					requests.push({ ...context, messages: structuredClone(context.messages) });
					return fauxAssistantMessage([fauxToolCall("inspect", {})], { stopReason: "toolUse" });
				},
				async (context) => {
					requests.push({ ...context, messages: structuredClone(context.messages) });
					if (delivery === "sendUserMessage") {
						await harness.session.sendUserMessage("second", { deliverAs: "followUp" });
					} else if (delivery !== "prompt") {
						await harness.session[delivery]("second");
					}
					return fauxAssistantMessage("done");
				},
				(context) => {
					requests.push({ ...context, messages: structuredClone(context.messages) });
					return fauxAssistantMessage("follow-up");
				},
			]);
			await harness.session.prompt("first");
			if (delivery === "prompt") await harness.session.prompt("second");
			await harness.session.waitForIdle();
			expect(requests.map(inputLevels)).toEqual([["high"], ["high", undefined], ["high", undefined, "low"]]);
			for (const event of harness.eventsOfType("message_end"))
				expect(event.message).not.toHaveProperty("thinkingLevel");
			for (const entry of harness.sessionManager.getEntries()) {
				if (entry.type === "custom_message") expect(entry).not.toHaveProperty("thinkingLevel");
				if (entry.type === "message") expect(entry.message).not.toHaveProperty("thinkingLevel");
			}
		},
	);

	it.each([
		{ before: "high", after: "off" },
		{ before: "off", after: "high" },
	] as const)(
		"defers serialized $before → $after mode through a tool loop with reminders",
		async ({ before, after }) => {
			let harness: Harness;
			const target = getModel("anthropic", "claude-opus-5");
			const tool: AgentTool = {
				name: "inspect",
				label: "Inspect",
				description: "Test tool",
				parameters: Type.Object({}),
				execute: async () => {
					await harness.session.setThinkingLevel(after, { persistDefault: false });
					await harness.session.sendCustomMessage({
						customType: "reminder",
						content: "Continue.",
						display: false,
					});
					return { content: [{ type: "text", text: "result" }] };
				},
			};
			harness = await anthropicHarness({ tools: [tool], models: [{ id: target.id, reasoning: true }] });
			await harness.session.setThinkingLevel(before, { persistDefault: false });
			const requests: { context: Context; options: SimpleStreamOptions | undefined }[] = [];
			const stream = harness.control.getStreamFn();
			harness.control.setStreamFn((model, context, options) => {
				requests.push({ context: { ...context, messages: structuredClone(context.messages) }, options });
				return stream(model, context, options);
			});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
				fauxAssistantMessage("follow-up"),
			]);
			await harness.session.prompt("first");
			await harness.session.prompt("second");
			expect(requests.map(({ context }) => inputLevels(context))).toEqual([
				[before],
				[before, undefined],
				[before, undefined, after],
			]);

			const payloads: {
				thinking?: { type: string };
				output_config?: { effort: string };
				messages: { role: string }[];
			}[] = [];
			for (const request of requests) {
				// Exercise the actual Anthropic serializer on the session's captured input.
				// The hook stops before transport; faux remains the only response provider.
				await streamSimpleAnthropic(target, request.context, {
					...request.options,
					apiKey: "sk-ant-api03-test",
					onPayload: (payload) => {
						payloads.push(JSON.parse(JSON.stringify(payload)) as (typeof payloads)[number]);
						throw new Error("Captured before network");
					},
				}).result();
			}
			expect(payloads).toHaveLength(3);
			expect(payloads.map((payload) => payload.thinking?.type)).toEqual(
				[before, before, after].map((level) => (level === "off" ? "disabled" : "adaptive")),
			);
			expect(payloads[1].output_config).toEqual(payloads[0].output_config);
			expect(payloads[1].messages.filter((message) => message.role === "system")).toEqual([]);
		},
	);

	it("restores historical selections from SQLite and copies them into a fork", async () => {
		const first = await anthropicHarness({ log: "sqlite" });
		await first.session.setThinkingLevel("high", { persistDefault: false });
		first.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await first.session.prompt("first");
		const branchPoint = first.sessionManager.getLeafId();
		await first.session.setThinkingLevel("low", { persistDefault: false });
		await first.session.prompt("second");
		const forkManager = await SessionManager.createBranched(first.sessionManager, branchPoint);
		const ref = first.sessionManager.getSessionRef()!;
		first.session.dispose();
		await first.session.waitForClosed();

		const resumed = await anthropicHarness({ sessionManager: await SessionManager.open(ref) });
		await resumed.session.setThinkingLevel("medium", { persistDefault: false });
		let resumedContext: Context | undefined;
		resumed.setResponses([
			(context) => {
				resumedContext = context;
				return fauxAssistantMessage("resumed");
			},
		]);
		await resumed.session.prompt("after resume");
		expect(resumedContext && inputLevels(resumedContext)).toEqual(["high", "low", "medium"]);

		const fork = await anthropicHarness({ sessionManager: forkManager });
		await fork.session.setThinkingLevel("medium", { persistDefault: false });
		let forkContext: Context | undefined;
		fork.setResponses([
			(context) => {
				forkContext = context;
				return fauxAssistantMessage("forked");
			},
		]);
		await fork.session.prompt("different branch");
		expect(forkContext && inputLevels(forkContext)).toEqual(["high", "medium"]);
	});

	it("keeps historical levels when switching away and back", async () => {
		const harness = await anthropicHarness({
			models: [
				{ id: "claude-fable-5-2", reasoning: true },
				{ id: "non-reasoning", reasoning: false },
			],
		});
		const anthropic = harness.session.model!;
		await harness.session.setThinkingLevel("high", { persistDefault: false });
		let switchedContext: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			(context) => {
				switchedContext = context;
				return fauxAssistantMessage("three");
			},
		]);
		await harness.session.prompt("first");
		await harness.session.setModel(harness.getModel("non-reasoning")!, { persistDefault: false });
		await harness.session.prompt("other provider");
		await harness.session.setModel(anthropic, { persistDefault: false });
		await harness.session.setThinkingLevel("low", { persistDefault: false });
		await harness.session.prompt("back");
		expect(switchedContext && inputLevels(switchedContext)).toEqual(["high", "off", "low"]);
	});

	it("keeps native compaction history and seeds the retained suffix without relabeling it", async () => {
		const harness = await anthropicHarness();
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage([
				{ type: "thinking", thinking: "", thinkingSignature: "signed" },
				{ type: "text", text: "three" },
			]),
		]);
		for (const level of ["high", "low", "medium"] as const) {
			await harness.session.setThinkingLevel(level, { persistDefault: false });
			await harness.session.prompt(`${level}: ${"context ".repeat(300)}`);
		}
		await harness.session.setThinkingLevel("high", { persistDefault: false });
		let compacted: Context | undefined;
		harness.setResponses([
			(context) => {
				compacted = { ...context, messages: structuredClone(context.messages) };
				return fauxAssistantMessage("## Goal\nContinue the task.");
			},
		]);
		await harness.session.compact();
		expect(compacted && inputLevels(compacted)).toEqual(["high", "low", "medium", "high"]);
		expect(
			compacted?.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "thinking" && block.thinkingSignature === "signed"),
			),
		).toBe(true);
		let continued: Context | undefined;
		harness.setResponses([
			(context) => {
				continued = context;
				return fauxAssistantMessage("continued");
			},
		]);
		await harness.session.prompt("next task");
		expect(continued && inputLevels(continued)).toEqual(["medium", "high"]);
	});
});
