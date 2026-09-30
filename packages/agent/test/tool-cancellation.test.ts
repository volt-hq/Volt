import { getEventListeners } from "node:events";
import { fauxAssistantMessage, fauxToolCall, type Message, registerFauxProvider } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../src/types.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("tool cancellation", () => {
	it.each(["parallel", "sequential"] as const)(
		"settles %s execution without waiting for tools and fences late output",
		async (toolExecution) => {
			const faux = registerFauxProvider();
			cleanups.push(() => faux.unregister());
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("wait", {}), fauxToolCall("wait", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("must not run"),
			]);
			const controller = new AbortController();
			const started = Promise.withResolvers<void>();
			const calls: Array<{
				result: ReturnType<typeof Promise.withResolvers<AgentToolResult>>;
				update: AgentToolUpdateCallback | undefined;
			}> = [];
			const tool: AgentTool = {
				name: "wait",
				label: "Wait",
				description: "Ignores cancellation",
				parameters: Type.Object({}),
				execute: (_id, _args, _signal, update) => {
					const result = Promise.withResolvers<AgentToolResult>();
					calls.push({ result, update });
					if (calls.length === (toolExecution === "parallel" ? 2 : 1)) started.resolve();
					return result.promise;
				},
			};
			const events: AgentEvent[] = [];
			const running = runAgentLoop(
				[{ role: "user", content: "start", timestamp: Date.now() }],
				{ systemPrompt: "test", messages: [], tools: [tool] },
				{
					model: faux.getModel(),
					apiKey: "faux-key",
					toolExecution,
					convertToLlm: (messages) => messages as Message[],
				},
				(event) => {
					events.push(event);
				},
				controller.signal,
			);
			await started.promise;
			controller.abort();
			const messages = await running;
			const results = messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(calls.length);
			expect(results.every((result) => result.isError)).toBe(true);
			expect(
				results.every(
					(result) => result.content[0]?.type === "text" && result.content[0].text === "Operation aborted",
				),
			).toBe(true);
			expect(events.at(-1)?.type).toBe("agent_end");
			expect(faux.state.callCount).toBe(1);
			expect(getEventListeners(controller.signal, "abort")).toEqual([]);
			const settledEvents = [...events];
			for (const [index, call] of calls.entries()) {
				call.update?.({ content: [{ type: "text", text: "late progress" }] });
				if (index === 0) call.result.reject(new Error("late rejection"));
				else call.result.resolve({ content: [{ type: "text", text: "late result" }] });
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(events).toEqual(settledEvents);
		},
	);

	it("does not start another prepared parallel tool after synchronous cancellation", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("cancel", {}), fauxToolCall("cancel", {})], { stopReason: "toolUse" }),
		]);
		const controller = new AbortController();
		const execute = vi.fn(() => {
			controller.abort();
			throw new Error("synchronous failure after abort");
		});
		await runAgentLoop(
			[{ role: "user", content: "start", timestamp: Date.now() }],
			{
				systemPrompt: "test",
				messages: [],
				tools: [{ name: "cancel", label: "Cancel", description: "Cancel", parameters: Type.Object({}), execute }],
			},
			{ model: faux.getModel(), apiKey: "faux-key", convertToLlm: (messages) => messages as Message[] },
			() => {},
			controller.signal,
		);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
