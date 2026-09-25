import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { NextActionResolvedEvent } from "../../src/harness/types.ts";
import type { AgentLoopNextActionContext, AgentMessage, AgentTool } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function textOfContent(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");
}

function textOf(message: AgentMessage): string {
	return "content" in message ? textOfContent(message.content) : "";
}

function createHarness(options: ConstructorParameters<typeof AgentHarness>[0]): AgentHarness {
	return new AgentHarness(options);
}

describe("AgentHarness finalized next-action policy", () => {
	it("awaits ordered hooks and async scoped policies before publishing, dispatching, and settling", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const order: string[] = [];
		registration.setResponses([
			() => {
				order.push("provider");
				return fauxAssistantMessage("done");
			},
		]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		// Scoped policies run after hooks even when registered before them.
		harness.registerNextActionPolicy(async (context, signal) => {
			order.push(`policy-first:start:${context.defaultAction.type}`);
			await Promise.resolve();
			expect(signal.aborted).toBe(false);
			order.push(`policy-first:end:${context.defaultAction.type}`);
			return context.completedTurn ? undefined : { type: "request", reason: "continuation" };
		});
		harness.on("next_action", (event) => {
			order.push(`hook-first:${event.defaultAction.type}`);
			return event.completedTurn ? undefined : { type: "pause" };
		});
		harness.registerNextActionPolicy(async (context) => {
			await Promise.resolve();
			order.push(`policy-second:${context.defaultAction.type}`);
			if (!context.completedTurn) expect(context.defaultAction).toEqual({ type: "request", reason: "continuation" });
			return undefined;
		});
		harness.on("next_action", async (event) => {
			await Promise.resolve();
			order.push(`hook-second:${event.defaultAction.type}`);
			return event.completedTurn ? undefined : { type: "stop" };
		});
		const resolved: NextActionResolvedEvent[] = [];
		harness.on("next_action_resolved", async (event) => {
			await Promise.resolve();
			resolved.push(event);
			order.push(`resolved:${event.action.type}`);
			return undefined;
		});
		harness.on("before_provider_request", () => {
			order.push("before-provider");
			return undefined;
		});
		harness.subscribe((event) => {
			if (event.type === "settled") order.push("settled");
		});

		await expect(harness.runPrompt("hello")).resolves.toMatchObject({ status: "completed" });

		expect(order).toEqual([
			"hook-first:request",
			"hook-second:pause",
			"policy-first:start:stop",
			"policy-first:end:stop",
			"policy-second:request",
			"resolved:request",
			"before-provider",
			"provider",
			"hook-first:stop",
			"hook-second:stop",
			"policy-first:start:stop",
			"policy-first:end:stop",
			"policy-second:stop",
			"resolved:stop",
			"settled",
		]);
		expect(resolved).toEqual([
			{
				type: "next_action_resolved",
				action: { type: "request", reason: "continuation" },
				requestAuthority: "provider",
			},
			{
				type: "next_action_resolved",
				action: { type: "stop" },
				requestAuthority: "provider",
				stopReason: "completion",
			},
		]);
		expect(registration.state.callCount).toBe(1);
	});

	it.each(["hook", "scoped"] as const)(
		"attributes an explicit %s stop to policy even when the suggestion is already stop",
		async (source) => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			registration.setResponses([() => fauxAssistantMessage("done")]);
			const harness = createHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session: new Session(new InMemorySessionStorage()),
				model: registration.getModel(),
			});
			const stop = (context: AgentLoopNextActionContext) => {
				if (!context.completedTurn) return undefined;
				expect(context.defaultAction).toEqual({ type: "stop" });
				return { type: "stop" as const };
			};
			if (source === "hook") harness.on("next_action", stop);
			else harness.registerNextActionPolicy(stop);
			// Returning undefined must preserve explicit stop provenance, not reset it to completion.
			harness.registerNextActionPolicy(async () => undefined);
			const resolved: NextActionResolvedEvent[] = [];
			harness.on("next_action_resolved", (event) => {
				resolved.push(event);
				return undefined;
			});

			await expect(harness.runPrompt("hello")).resolves.toMatchObject({ status: "completed" });

			expect(resolved).toHaveLength(2);
			expect(resolved.at(-1)).toEqual({
				type: "next_action_resolved",
				action: { type: "stop" },
				requestAuthority: "provider",
				stopReason: "policy",
			});
			expect(registration.state.callCount).toBe(1);
		},
	);

	it.each(["hook", "scoped"] as const)(
		"publishes an explicit %s stop before settlement without dispatch",
		async (source) => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			registration.setResponses([() => fauxAssistantMessage("must not run")]);
			const harness = createHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session: new Session(new InMemorySessionStorage()),
				model: registration.getModel(),
			});
			const stop = () => ({ type: "stop" as const });
			if (source === "hook") harness.on("next_action", stop);
			else harness.registerNextActionPolicy(stop);
			const order: string[] = [];
			const resolved: NextActionResolvedEvent[] = [];
			harness.on("next_action_resolved", (event) => {
				resolved.push(event);
				order.push("resolved");
				return undefined;
			});
			harness.subscribe((event) => {
				if (event.type === "settled") order.push("settled");
			});

			await expect(harness.runPrompt("hello")).resolves.toMatchObject({ status: "completed" });

			expect(resolved).toEqual([
				{
					type: "next_action_resolved",
					action: { type: "stop" },
					requestAuthority: "provider",
					stopReason: "policy",
				},
			]);
			expect(order).toEqual(["resolved", "settled"]);
			expect(registration.state.callCount).toBe(0);
		},
	);

	it.each([false, true])(
		"preserves tool stop provenance unless policy explicitly stops (explicit=%s)",
		async (explicit) => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			registration.setResponses([
				() =>
					fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "stop-call" }), {
						stopReason: "toolUse",
					}),
			]);
			const harness = createHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session: new Session(new InMemorySessionStorage()),
				model: registration.getModel(),
				tools: [calculateTool],
			});
			harness.on("tool_result", () => ({ disposition: "stop" }));
			harness.on("next_action", () => undefined);
			harness.registerNextActionPolicy(async (context) => {
				if (!context.completedTurn) return undefined;
				expect(context.completedTurn.toolResults).toHaveLength(1);
				expect(context.defaultAction).toEqual({ type: "stop" });
				return explicit ? { type: "stop" } : undefined;
			});
			harness.registerNextActionPolicy(() => undefined);
			const resolved: NextActionResolvedEvent[] = [];
			harness.on("next_action_resolved", (event) => {
				resolved.push(event);
				return undefined;
			});

			await expect(harness.runPrompt("calculate")).resolves.toMatchObject({ status: "completed" });

			expect(registration.state.callCount).toBe(1);
			expect(resolved).toHaveLength(2);
			expect(resolved.at(-1)).toEqual({
				type: "next_action_resolved",
				action: { type: "stop" },
				requestAuthority: "provider",
				stopReason: explicit ? "policy" : "tool",
			});
		},
	);

	it.each([
		{ source: "hook", override: "request" },
		{ source: "scoped", override: "request" },
		{ source: "hook", override: "pause" },
		{ source: "scoped", override: "pause" },
	] as const)(
		"allows later $override to override a $source stop without stale provenance",
		async ({ source, override }) => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			let continuationMessages: AgentMessage[] = [];
			registration.setResponses([
				() =>
					fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 3" }, { id: "override-call" }), {
						stopReason: "toolUse",
					}),
				(context) => {
					continuationMessages = context.messages as AgentMessage[];
					return fauxAssistantMessage("done");
				},
			]);
			const harness = createHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session: new Session(new InMemorySessionStorage()),
				model: registration.getModel(),
				tools: [calculateTool],
			});
			const stop = (context: AgentLoopNextActionContext) =>
				context.completedTurn?.toolResults.length ? { type: "stop" as const } : undefined;
			if (source === "hook") harness.on("next_action", stop);
			else harness.registerNextActionPolicy(stop);
			harness.registerNextActionPolicy(async (context) => {
				if (!context.completedTurn?.toolResults.length) return undefined;
				expect(context.defaultAction).toEqual({ type: "stop" });
				await Promise.resolve();
				return override === "pause" ? { type: "pause" } : { type: "request", reason: "continuation" };
			});
			harness.registerNextActionPolicy(() => undefined);
			const resolved: NextActionResolvedEvent[] = [];
			let toolExecutions = 0;
			harness.subscribe((event) => {
				if (event.type === "tool_execution_end") toolExecutions++;
			});
			harness.on("next_action_resolved", (event) => {
				resolved.push(event);
				return undefined;
			});

			await expect(harness.runPrompt("calculate")).resolves.toMatchObject({ status: "completed" });

			expect(resolved[1]).toEqual({
				type: "next_action_resolved",
				action: override === "pause" ? { type: "pause" } : { type: "request", reason: "continuation" },
				requestAuthority: "tool_continuation",
			});
			if (override === "pause") {
				expect(registration.state.callCount).toBe(1);
				expect(harness.getPhase()).toBe("idle");
				await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });
			}
			expect(registration.state.callCount).toBe(2);
			expect(toolExecutions).toBe(1);
			expect(continuationMessages.filter((message) => message.role === "toolResult").map(textOf)).toEqual([
				"2 + 3 = 5",
			]);
			expect(resolved.at(-1)).toEqual({
				type: "next_action_resolved",
				action: { type: "stop" },
				requestAuthority: "provider",
				stopReason: "completion",
			});
		},
	);

	it("isolates finalized hooks and passive subscribers from each other, dispatch, and persistence", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let providerMessages: AgentMessage[] = [];
		registration.setResponses([
			(context) => {
				providerMessages = context.messages as AgentMessage[];
				return fauxAssistantMessage("done");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		harness.registerNextActionPolicy((context) =>
			context.completedTurn
				? undefined
				: {
						type: "request",
						reason: "delivery",
						deliveries: [{ messages: [{ role: "user", content: "owned delivery", timestamp: 123 }] }],
					},
		);
		const mutate = (event: NextActionResolvedEvent) => {
			if (event.action.type === "request") {
				const delivery = event.action.deliveries?.[0];
				if (delivery) {
					delivery.messages[0] = { role: "user", content: "mutated delivery", timestamp: 456 };
					delivery.messages.push({ role: "user", content: "injected delivery", timestamp: 789 });
				}
				event.action = { type: "stop" };
			} else {
				event.action = { type: "request", reason: "continuation" };
			}
			event.requestAuthority = "final_response";
			event.stopReason = "policy";
			return undefined;
		};
		const hookEvents: NextActionResolvedEvent[] = [];
		const subscriberEvents: NextActionResolvedEvent[] = [];
		harness.on("next_action_resolved", mutate);
		harness.on("next_action_resolved", (event) => {
			hookEvents.push(event);
			return undefined;
		});
		harness.subscribe((event) => {
			if (event.type === "next_action_resolved") mutate(event);
		});
		harness.subscribe((event) => {
			if (event.type === "next_action_resolved") subscriberEvents.push(event);
		});

		await expect(harness.runPrompt("hello")).resolves.toMatchObject({ status: "completed" });

		const expected: NextActionResolvedEvent[] = [
			{
				type: "next_action_resolved",
				action: {
					type: "request",
					reason: "delivery",
					deliveries: [{ messages: [{ role: "user", content: "owned delivery", timestamp: 123 }] }],
				},
				requestAuthority: "provider",
			},
			{
				type: "next_action_resolved",
				action: { type: "stop" },
				requestAuthority: "provider",
				stopReason: "completion",
			},
		];
		expect(hookEvents).toEqual(expected);
		expect(subscriberEvents).toEqual(expected);
		expect(registration.state.callCount).toBe(1);
		expect(providerMessages.map(textOf)).toEqual(["hello", "owned delivery"]);
		expect((await session.buildContext()).messages.map(textOf)).toEqual(["hello", "owned delivery", "done"]);
	});

	it.each(["stop", "request", "pause"] as const)(
		"publishes normalized final-response authority after policy returns %s",
		async (decision) => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			const finalRequests: Array<{ tools: string[]; systemPrompt: string; texts: string[] }> = [];
			registration.setResponses([
				() =>
					fauxAssistantMessage(fauxToolCall("calculate", { expression: "3 + 4" }, { id: "final-call" }), {
						stopReason: "toolUse",
					}),
				(context) => {
					finalRequests.push({
						tools: context.tools?.map((tool) => tool.name) ?? [],
						systemPrompt: context.systemPrompt ?? "",
						texts: (context.messages as AgentMessage[]).map(textOf),
					});
					return fauxAssistantMessage("final answer");
				},
			]);
			const harness = createHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session: new Session(new InMemorySessionStorage()),
				model: registration.getModel(),
				tools: [calculateTool],
			});
			harness.on("tool_result", () => ({ disposition: "final_response" }));
			let finalDecisions = 0;
			harness.on("next_action", (event) =>
				event.requestAuthority === "final_response" ? { type: "stop" } : undefined,
			);
			harness.registerNextActionPolicy(async (context) => {
				if (context.requestAuthority !== "final_response") return undefined;
				expect(context.defaultAction).toEqual({ type: "stop" });
				finalDecisions++;
				await Promise.resolve();
				if (decision === "pause" && finalDecisions === 1) return { type: "pause", requestAuthority: "provider" };
				if (decision === "request")
					return {
						type: "request",
						reason: "delivery",
						deliveries: [
							{ messages: [{ role: "user", content: "must not override final response", timestamp: 1 }] },
						],
					};
				return { type: "stop" };
			});
			const resolved: NextActionResolvedEvent[] = [];
			harness.on("next_action_resolved", (event) => {
				resolved.push(event);
				return undefined;
			});

			await expect(harness.runPrompt("calculate")).resolves.toMatchObject({ status: "completed" });

			if (decision === "pause") {
				expect(registration.state.callCount).toBe(1);
				expect(finalRequests).toEqual([]);
				expect(resolved.at(-1)).toEqual({
					type: "next_action_resolved",
					action: { type: "pause", requestAuthority: "final_response" },
					requestAuthority: "final_response",
				});
				await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });
			}
			expect(finalDecisions).toBe(decision === "pause" ? 2 : 1);
			expect(
				resolved.filter((event) => event.requestAuthority === "final_response" && event.action.type !== "pause"),
			).toEqual([
				{
					type: "next_action_resolved",
					action: { type: "request", reason: "final_response" },
					requestAuthority: "final_response",
				},
			]);
			expect(registration.state.callCount).toBe(2);
			expect(finalRequests).toHaveLength(1);
			expect(finalRequests[0]?.tools).toEqual([]);
			expect(finalRequests[0]?.systemPrompt).toContain("VOLT FINAL RESPONSE");
			expect(finalRequests[0]?.texts).toContain("3 + 4 = 7");
			expect(finalRequests[0]?.texts).not.toContain("must not override final response");
		},
	);
});

describe("AgentHarness host policy", () => {
	it("allows model-less construction and rejects only model-backed preflight", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
		});

		expect(harness.getModel()).toBeUndefined();
		await expect(harness.runPrompt("not yet")).rejects.toMatchObject({
			code: "invalid_state",
			message: "No model set for AgentHarness run",
		});
		expect(harness.getPhase()).toBe("idle");
		expect((await session.buildContext()).messages).toEqual([]);

		await harness.setModel(registration.getModel());
		await expect(harness.runPrompt("ready")).resolves.toMatchObject({ status: "completed" });
		expect(registration.state.callCount).toBe(1);
	});

	it("applies structured per-run system prompts and ordered context reducers", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let providerSystemPrompt = "";
		let providerMessages: unknown;
		registration.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				providerMessages = context.messages;
				return fauxAssistantMessage("ok");
			},
		]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			systemPrompt: "configured",
		});
		const order: string[] = [];
		harness.on("context", (event) => {
			order.push("first");
			return {
				messages: event.messages.map((message) =>
					message.role === "user" ? { ...message, content: "first replacement" } : message,
				),
			};
		});
		harness.on("context", (event) => {
			order.push(textOf(event.messages[0]!));
			return {
				messages: event.messages.map((message) =>
					message.role === "user" ? { ...message, content: "second replacement" } : message,
				),
			};
		});

		const message = { role: "user", content: "structured", timestamp: Date.now() } as const;
		await harness.run(message, { systemPrompt: "per-run" });

		expect(order).toEqual(["first", "first replacement"]);
		expect(providerSystemPrompt).toBe("per-run");
		expect(JSON.stringify(providerMessages)).toContain("second replacement");
	});

	it("finalizes ordered message replacements before persistence and passive cloned subscribers", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("provider")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const reducerInputs: string[] = [];
		harness.on("message_end", (event) => {
			if (event.message.role !== "assistant") return undefined;
			reducerInputs.push(textOf(event.message));
			return { message: { ...event.message, content: [{ type: "text", text: "first" }] } };
		});
		harness.on("message_end", (event) => {
			if (event.message.role !== "assistant") return undefined;
			reducerInputs.push(textOf(event.message));
			return { message: { ...event.message, content: [{ type: "text", text: "final" }] } };
		});
		const observed: string[] = [];
		harness.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			observed.push(textOf(event.message));
			const content = event.message.content;
			if (typeof content !== "string" && content[0]?.type === "text") content[0].text = "subscriber mutation";
			throw new Error("passive subscriber failure");
		});

		const response = await harness.prompt("hello");
		const persisted = (await session.buildContext()).messages.at(-1);

		expect(reducerInputs).toEqual(["provider", "first"]);
		expect(observed).toEqual(["final"]);
		expect(textOf(response)).toBe("final");
		expect(persisted && textOf(persisted)).toBe("final");
	});

	it("reduces tool policy in registration order before the continuation request", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let continuationMessages: unknown;
		const providerSystemPrompts: Array<string | undefined> = [];
		registration.setResponses([
			(context) => {
				providerSystemPrompts.push(context.systemPrompt);
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerSystemPrompts.push(context.systemPrompt);
				continuationMessages = context.messages;
				return fauxAssistantMessage("done");
			},
		]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [calculateTool],
		});
		const order: string[] = [];
		harness.on("tool_call", () => {
			order.push("tool-call-first");
			return { block: true, reason: "first" };
		});
		harness.on("tool_call", (event) => {
			expect(event).toMatchObject({ block: true, reason: "first" });
			order.push("tool-call-second");
			return { block: false, reason: "second" };
		});
		harness.on("tool_result", () => {
			order.push("tool-result-first");
			return { content: [{ type: "text", text: "first result" }], isError: false };
		});
		harness.on("tool_result", (event) => {
			order.push(textOfContent(event.content));
			return { content: [{ type: "text", text: "final result" }] };
		});

		await harness.prompt("calculate", { systemPrompt: "per-run" });

		expect(order).toEqual(["tool-call-first", "tool-call-second"]);
		expect(providerSystemPrompts).toEqual(["per-run", "per-run"]);
		expect(JSON.stringify(continuationMessages)).toContain("second");
		expect(JSON.stringify(continuationMessages)).not.toContain("final result");
	});

	it("fails the run when canonical storage cannot own non-cloneable tool details", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("non_cloneable_details", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("must not continue"),
		]);
		const detailCallback = () => "still callable";
		const tool: AgentTool = {
			name: "non_cloneable_details",
			label: "Non-cloneable details",
			description: "Returns successful details containing a function",
			parameters: calculateTool.parameters,
			execute: async () => ({
				content: [{ type: "text", text: "successful result" }],
				details: { callback: detailCallback },
				disposition: "stop",
			}),
		};
		const session = new Session(new InMemorySessionStorage());
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			tools: [tool],
		});

		const response = await harness.prompt("run the tool");
		const persistedToolResult = (await session.getEntries()).find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);

		expect(registration.state.callCount).toBe(1);
		expect(response.stopReason).toBe("error");
		expect(persistedToolResult).toBeUndefined();
	});

	it("allows scoped policy to deliver work from an assistant-tail continuation", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let continuationMessages: AgentMessage[] = [];
		registration.setResponses([
			() => fauxAssistantMessage("one"),
			(context) => {
				continuationMessages = context.messages as AgentMessage[];
				return fauxAssistantMessage("two");
			},
		]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		await harness.prompt("first");

		const decisions: string[] = [];
		let delivered = false;
		const policyMessage: AgentMessage = {
			role: "user",
			content: "policy delivery",
			timestamp: Date.now(),
		};
		const unregister = harness.registerNextActionPolicy((context) => {
			decisions.push(context.defaultAction.type);
			if (delivered) return undefined;
			delivered = true;
			return { type: "request", reason: "delivery", deliveries: [{ messages: [policyMessage] }] };
		});

		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });
		unregister();

		expect(decisions).toEqual(["stop", "stop"]);
		expect(continuationMessages.map(textOf)).toEqual(["first", "one", "policy delivery"]);
		expect(registration.state.callCount).toBe(2);
		await expect(harness.continue()).resolves.toEqual({ status: "completed", deliveries: [] });
		expect(registration.state.callCount).toBe(2);
	});

	it("isolates every next-action handler and policy projection and owns returned actions", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let continuationMessages: AgentMessage[] = [];
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "isolated-call" }), {
					stopReason: "toolUse",
				}),
			(context) => {
				continuationMessages = context.messages as AgentMessage[];
				return fauxAssistantMessage("done");
			},
		]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [calculateTool],
		});
		let mutatingHandlerCalls = 0;
		let observingHandlerCalls = 0;
		let observingPolicyCalls = 0;

		harness.on("next_action", (event) => {
			if (!event.completedTurn || event.completedTurn.toolResults.length === 0) return undefined;
			mutatingHandlerCalls++;
			event.context.messages[0] = { role: "user", content: "mutated context", timestamp: 10 };
			event.context.tools?.splice(0, event.context.tools.length);
			event.newMessages[0] = { role: "user", content: "mutated new messages", timestamp: 11 };
			event.completedTurn.message.content = [{ type: "text", text: "mutated completed message" }];
			event.completedTurn.toolResults[0]!.content = [{ type: "text", text: "mutated tool result" }];
			if (event.defaultAction.type === "request") event.defaultAction.reason = "final_response";
			return undefined;
		});
		harness.on("next_action", (event) => {
			if (!event.completedTurn || event.completedTurn.toolResults.length === 0) return undefined;
			observingHandlerCalls++;
			expect(event.context.tools).toEqual([calculateTool]);
			expect(event.context.messages.map(textOf)).not.toContain("mutated context");
			expect(event.newMessages.map(textOf)).not.toContain("mutated new messages");
			expect(JSON.stringify(event.completedTurn)).not.toContain("mutated");
			expect(event.defaultAction).toMatchObject({ type: "request", reason: "continuation" });
			const returnedMessage: AgentMessage = { role: "user", content: "owned reducer delivery", timestamp: 12 };
			const returnedAction = {
				type: "request" as const,
				reason: "delivery" as const,
				deliveries: [{ messages: [returnedMessage] }],
			};
			queueMicrotask(() => {
				returnedMessage.content = "late returned-action mutation";
				returnedAction.deliveries[0]!.messages.push({
					role: "user",
					content: "late returned delivery",
					timestamp: 13,
				});
			});
			return returnedAction;
		});
		harness.on("next_action", (event) => {
			if (
				event.defaultAction.type !== "request" ||
				event.defaultAction.reason !== "delivery" ||
				event.defaultAction.deliveries === undefined
			)
				return undefined;
			expect(event.defaultAction.deliveries.flatMap((delivery) => delivery.messages).map(textOf)).toEqual([
				"owned reducer delivery",
			]);
			const firstDelivery = event.defaultAction.deliveries?.[0];
			if (firstDelivery) {
				firstDelivery.messages[0] = { role: "user", content: "mutated handler delivery", timestamp: 14 };
				firstDelivery.messages.push({ role: "user", content: "extra handler delivery", timestamp: 15 });
			}
			return undefined;
		});
		harness.registerNextActionPolicy((context) => {
			if (
				context.defaultAction.type !== "request" ||
				context.defaultAction.reason !== "delivery" ||
				context.defaultAction.deliveries === undefined
			)
				return undefined;
			observingPolicyCalls++;
			expect(context.context.tools).toEqual([calculateTool]);
			expect(context.defaultAction.deliveries?.flatMap((delivery) => delivery.messages).map(textOf)).toEqual([
				"owned reducer delivery",
			]);
			return undefined;
		});

		await harness.prompt("calculate");

		expect(mutatingHandlerCalls).toBe(1);
		expect(observingHandlerCalls).toBe(1);
		expect(observingPolicyCalls).toBe(1);
		expect(continuationMessages.map(textOf)).toContain("owned reducer delivery");
		expect(continuationMessages.map(textOf)).not.toContain("mutated handler delivery");
		expect(continuationMessages.map(textOf)).not.toContain("late returned-action mutation");
	});

	it("orders event and scoped next-action policy and unregisters scoped policy", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("one"), () => fauxAssistantMessage("two")]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		const order: string[] = [];
		harness.on("next_action", (event) => {
			order.push(`event:${event.defaultAction.type}`);
			return undefined;
		});
		const unregister = harness.registerNextActionPolicy((context, signal) => {
			expect(signal.aborted).toBe(false);
			order.push(`scoped:${context.defaultAction.type}`);
			return undefined;
		});

		await harness.prompt("first");
		unregister();
		await harness.prompt("second");

		expect(order.slice(0, 4)).toEqual(["event:request", "scoped:request", "event:stop", "scoped:stop"]);
		expect(order.slice(4)).toEqual(["event:request", "event:stop"]);
	});
});
