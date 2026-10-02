import { getEventListeners } from "node:events";
import { fauxAssistantMessage, fauxToolCall, type Message, registerFauxProvider } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentTool, AgentToolUpdateCallback } from "../src/types.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("tool cancellation", () => {
	it.each([
		["parallel", "resolve"],
		["parallel", "reject"],
		["sequential", "resolve"],
		["sequential", "reject"],
	] as const)(
		"preserves cooperative cancellation output in %s execution when tools %s",
		async (toolExecution, outcome) => {
			const faux = registerFauxProvider();
			cleanups.push(() => faux.unregister());
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("must not run"),
			]);
			const controller = new AbortController();
			const started = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const cleanup = Promise.withResolvers<void>();
			cleanups.push(() => cleanup.resolve());
			let lateUpdate: AgentToolUpdateCallback | undefined;
			const tool: AgentTool = {
				name: "wait",
				label: "Wait",
				description: "Finishes asynchronous cleanup after cancellation",
				parameters: Type.Object({}),
				execute: async (_id, _args, signal, update) => {
					lateUpdate = update;
					signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
					started.resolve();
					await aborted.promise;
					await cleanup.promise;
					update?.({ content: [{ type: "text", text: "final progress" }] });
					if (outcome === "reject") throw new Error("partial output\nCommand aborted");
					return { content: [{ type: "text", text: "partial result" }], details: { retained: true } };
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
			const settled = vi.fn();
			void running.then(settled);
			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(settled).not.toHaveBeenCalled();
			cleanup.resolve();
			const messages = await running;
			const results = messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({
				isError: outcome === "reject",
				content: [
					{ type: "text", text: outcome === "reject" ? "partial output\nCommand aborted" : "partial result" },
				],
				...(outcome === "resolve" ? { details: { retained: true } } : {}),
			});
			expect(events.filter((event) => event.type === "tool_execution_update")).toMatchObject([
				{ partialResult: { content: [{ type: "text", text: "final progress" }] } },
			]);
			expect(events.at(-1)?.type).toBe("agent_end");
			expect(faux.state.callCount).toBe(1);
			expect(getEventListeners(controller.signal, "abort")).toEqual([]);
			const settledEvents = [...events];
			lateUpdate?.({ content: [{ type: "text", text: "late progress" }] });
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
