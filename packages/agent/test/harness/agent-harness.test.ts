import { fauxAssistantMessage, fauxToolCall, getModel, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage, AgentTool } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";
import { getCurrentTimeTool } from "../utils/get-current-time.ts";
import { prompt, runPrompt, userMessage } from "./harness-test-utils.ts";
import { InMemorySessionStorage } from "./in-memory-session-storage.ts";

const registrations: Array<{ unregister(): void }> = [];

function textFromUserMessages(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		if (!Array.isArray(message.content)) return [];
		return message.content.flatMap((part) => {
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return [];
			return "text" in part && typeof part.text === "string" ? [part.text] : [];
		});
	});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function getReasoning(options: unknown): unknown {
	if (!options || typeof options !== "object" || !("reasoning" in options)) return undefined;
	return options["reasoning"];
}

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("AgentHarness", () => {
	it("constructs directly and exposes queue modes", () => {
		const session = new Session(new InMemorySessionStorage());
		const initialModel = getModel("anthropic", "claude-sonnet-4-5");
		const harness = new AgentHarness({
			session,
			model: initialModel,
			thinkingLevel: "high",
			systemPrompt: "You are helpful.",
			steeringMode: "all",
			followUpMode: "all",
		});
		expect(harness.getModel()).toBe(initialModel);
		expect(harness.getThinkingLevel()).toBe("high");
		expect(harness.getSteeringMode()).toBe("all");
		expect(harness.getFollowUpMode()).toBe("all");
		harness.setSteeringMode("one-at-a-time");
		harness.setFollowUpMode("one-at-a-time");
		expect(harness.getSteeringMode()).toBe("one-at-a-time");
		expect(harness.getFollowUpMode()).toBe("one-at-a-time");
	});

	it("drains one queued steering message at a time and emits queue updates", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const userCounts: number[] = [];
		registration.setResponses([
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("first");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("second");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("third");
			},
		]);
		const harness = new AgentHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			steeringMode: "one-at-a-time",
		});
		const steerQueueLengths: number[] = [];
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				steerQueueLengths.push(event.steer.length);
			}
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.queueSteer(userMessage("one"));
				harness.queueSteer(userMessage("two"));
			}
		});

		await prompt(harness, "hello");

		expect(userCounts).toEqual([1, 2, 3]);
		expect(steerQueueLengths).toEqual([1, 2, 1, 0]);
	});

	it("finalizes before leasing queued steering and processes it at the next boundary", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const requestSnapshots: Array<{ users: string[]; tools: string[] }> = [];
		registration.setResponses([
			(context) => {
				requestSnapshots.push({
					users: textFromUserMessages(context.messages),
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				requestSnapshots.push({
					users: textFromUserMessages(context.messages),
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("finalized");
			},
			(context) => {
				requestSnapshots.push({
					users: textFromUserMessages(context.messages),
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("handled queued steering");
			},
		]);
		const harness = new AgentHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		await harness.setTools([calculateTool], [calculateTool.name]);
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.queueSteer(userMessage("queued steering"));
			}
		});
		harness.on("tool_result", () => ({ disposition: "final_response" }));

		const response = await prompt(harness, "complete and summarize");

		expect(response.content).toEqual([{ type: "text", text: "handled queued steering" }]);
		expect(requestSnapshots).toEqual([
			{ users: ["complete and summarize"], tools: ["calculate"] },
			{ users: ["complete and summarize"], tools: [] },
			{ users: ["complete and summarize", "queued steering"], tools: ["calculate"] },
		]);
	});

	it("abort after a steering delivery begins preserves the committed payload", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let providerCalls = 0;
		registration.setResponses([
			() => {
				providerCalls++;
				return fauxAssistantMessage("first");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			session,
			model: registration.getModel(),
		});
		let turnStarts = 0;
		let queued = false;
		let abortResult: ReturnType<typeof harness.abort> | undefined;
		harness.subscribe(async (event) => {
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.queueSteer(userMessage("committed before abort"));
			}
			if (event.type === "turn_start" && ++turnStarts === 2) {
				abortResult = harness.abort();
			}
		});

		await prompt(harness, "hello");
		const persistedMessages = (await session.buildContext()).messages as AgentMessage[];

		expect(providerCalls).toBe(1);
		expect(abortResult).toMatchObject({ accepted: true });
		expect(textFromUserMessages(persistedMessages)).toEqual(["hello", "committed before abort"]);
	});

	it.each([
		["queue_update", "queue update exploded"],
		["delivery_start", "delivery start exploded"],
	] as const)(
		"keeps a begun delivery authoritative despite a rejecting %s observer",
		async (rejectedEvent, errorMessage) => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			registration.setResponses([() => fauxAssistantMessage("should not be used")]);
			const session = new Session(new InMemorySessionStorage());
			const harness = new AgentHarness({
				session,
				model: registration.getModel(),
			});
			const lifecycleEvents: string[] = [];
			const steerQueueSnapshots: string[][] = [];
			let queued = false;
			let sawDeliveryStart = false;
			let terminalMessages: AgentMessage[] = [];
			const unsubscribe = harness.subscribe(async (event) => {
				if (
					event.type === "agent_start" ||
					event.type === "turn_start" ||
					event.type === "turn_end" ||
					event.type === "message_start" ||
					event.type === "message_end" ||
					event.type === "agent_end"
				) {
					lifecycleEvents.push(event.type);
				}
				if (event.type === "agent_start" && !queued) {
					queued = true;
					harness.queueSteer(userMessage("committed delivery"));
				}
				if (event.type === "queue_update") {
					steerQueueSnapshots.push(textFromUserMessages(event.steer));
					if (rejectedEvent === "queue_update" && queued && event.steer.length === 0) {
						throw new Error(errorMessage);
					}
				}
				if (event.type === "delivery_start" && event.deliveryId !== undefined) {
					sawDeliveryStart = true;
					if (rejectedEvent === "delivery_start") throw new Error(errorMessage);
				}
				if (event.type === "agent_end") terminalMessages = event.messages;
			});

			const response = await prompt(harness, "initial prompt");
			const persistedMessages = (await session.buildContext()).messages as AgentMessage[];
			unsubscribe();
			const abortResult = harness.abort();

			expect(registration.state.callCount).toBe(1);
			expect(registration.getPendingResponseCount()).toBe(0);
			expect(response).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(textFromUserMessages(persistedMessages)).toEqual(["initial prompt", "committed delivery"]);
			expect(persistedMessages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
			expect(terminalMessages).toEqual(persistedMessages);
			expect(steerQueueSnapshots).toEqual([["committed delivery"], []]);
			expect(sawDeliveryStart).toBe(true);
			expect(abortResult).toMatchObject({ accepted: false });
			expect(lifecycleEvents.filter((event) => event === "turn_start" || event === "turn_end")).toEqual([
				"turn_start",
				"turn_end",
			]);
			expect(lifecycleEvents.at(-1)).toBe("agent_end");
		},
	);

	it("retains an initial prompt when agent_start observes abort intent", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("should not be used")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			session,
			model: registration.getModel(),
		});
		const lifecycleEvents: string[] = [];
		let abortResult: ReturnType<typeof harness.abort> | undefined;
		harness.subscribe((event) => {
			lifecycleEvents.push(event.type);
			if (event.type === "agent_start") abortResult = harness.abort();
		});

		const result = await runPrompt(harness, "preserve this prompt");

		expect(abortResult).toMatchObject({ accepted: true });
		expect(result).toEqual({ status: "completed", deliveries: [] });
		expect(registration.state.callCount).toBe(0);
		expect((await session.buildContext()).messages).toEqual([]);
		expect(harness.hasPendingPrompt()).toBe(true);
		expect(lifecycleEvents).toEqual(["agent_start", "agent_end", "settled"]);
	});

	it.each(["message_start", "message_end"] as const)(
		"isolates an initial delivery %s observer rejection without duplicating its message",
		async (rejectedEvent) => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			registration.setResponses([() => fauxAssistantMessage("should not be used")]);
			const session = new Session(new InMemorySessionStorage());
			const harness = new AgentHarness({
				session,
				model: registration.getModel(),
			});
			const lifecycleEvents: string[] = [];
			let terminalMessages: AgentMessage[] = [];
			harness.subscribe((event) => {
				if (
					event.type === "agent_start" ||
					event.type === "turn_start" ||
					event.type === "turn_end" ||
					event.type === "message_start" ||
					event.type === "message_end" ||
					event.type === "agent_end"
				) {
					lifecycleEvents.push(event.type);
				}
				if (event.type === rejectedEvent && event.message.role === "user") {
					throw new Error("initial delivery exploded");
				}
				if (event.type === "agent_end") terminalMessages = event.messages;
			});

			const response = await prompt(harness, "preserve this initial delivery");
			const persistedMessages = (await session.buildContext()).messages as AgentMessage[];

			expect(registration.state.callCount).toBe(1);
			expect(registration.getPendingResponseCount()).toBe(0);
			expect(response).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(textFromUserMessages(persistedMessages)).toEqual(["preserve this initial delivery"]);
			expect(persistedMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(terminalMessages).toEqual(persistedMessages);
			expect(lifecycleEvents).toEqual([
				"agent_start",
				"message_start",
				"message_end",
				"turn_start",
				"message_start",
				"message_end",
				"turn_end",
				"agent_end",
			]);
		},
	);

	it("prepares a queued request from the post-delivery session snapshot", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const requestPrompts: string[] = [];
		registration.setResponses([
			(context) => {
				requestPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("first");
			},
			(context) => {
				requestPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("second");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			session,
			model: registration.getModel(),
			systemPrompt: async () => {
				const current = await session.buildContext();
				return `users:${textFromUserMessages(current.messages as AgentMessage[]).join("|")}`;
			},
		});
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.queueSteer(userMessage("steer"));
			}
		});

		await prompt(harness, "hello");

		expect(requestPrompts).toEqual(["users:hello", "users:hello|steer"]);
	});

	it("abort retains steer and follow-up queues until explicit revocation", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let releaseFirstResponse: (() => void) | undefined;
		let abortedSignal: AbortSignal | undefined;
		const firstResponseReleased = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		const secondRequestText: string[] = [];
		registration.setResponses([
			async (_context, options) => {
				abortedSignal = options?.signal;
				await firstResponseReleased;
				return fauxAssistantMessage("aborted-ish");
			},
			(context) => {
				secondRequestText.push(...textFromUserMessages(context.messages));
				return fauxAssistantMessage("second");
			},
		]);
		const harness = new AgentHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		const queueUpdates: Array<{ steer: number; followUp: number }> = [];
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				queueUpdates.push({ steer: event.steer.length, followUp: event.followUp.length });
			}
		});

		const firstPrompt = prompt(harness, "first");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const steerId = harness.queueSteer(userMessage("steer"));
		const followUpId = harness.queueFollowUp(userMessage("follow"));
		const abortResult = harness.abort();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(abortedSignal?.aborted).toBe(true);
		releaseFirstResponse?.();
		await firstPrompt;
		expect(harness.hasQueuedMessages()).toBe(true);
		expect(harness.revokeAllQueues()).toEqual([steerId, followUpId]);
		await prompt(harness, "second");

		expect(abortResult).toMatchObject({ accepted: true });
		expect(queueUpdates).toEqual([
			{ steer: 1, followUp: 0 },
			{ steer: 1, followUp: 1 },
			{ steer: 0, followUp: 0 },
		]);
		expect(secondRequestText).toEqual(["first", "second"]);
	});

	it("settles with an aborted assistant when context preflight is aborted", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			session,
			model: registration.getModel(),
		});
		const contextStarted = deferred();
		const releaseContext = deferred();
		const lifecycle: string[] = [];
		harness.on("context", async (event) => {
			contextStarted.resolve();
			await releaseContext.promise;
			return { messages: event.messages };
		});
		harness.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				lifecycle.push("message_start");
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				lifecycle.push(`message_end:${event.message.stopReason}`);
			} else if (event.type === "turn_end") {
				lifecycle.push("turn_end");
			} else if (event.type === "agent_end" || event.type === "settled") {
				lifecycle.push(event.type);
			}
		});

		const promptPromise = prompt(harness, "hello");
		await contextStarted.promise;
		const abortPromise = harness.abort();
		releaseContext.resolve();
		const [response] = await Promise.all([promptPromise, abortPromise]);

		expect(response).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(lifecycle).toEqual(["message_start", "message_end:aborted", "turn_end", "agent_end", "settled"]);
		const persistedMessages = (await session.getEntries()).flatMap((entry) =>
			entry.type === "message" ? [entry.message] : [],
		);
		expect(persistedMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(persistedMessages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("drains follow-up messages one at a time after the agent would otherwise stop", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const userCounts: number[] = [];
		registration.setResponses([
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("first");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("second");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("third");
			},
		]);
		const harness = new AgentHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			followUpMode: "one-at-a-time",
		});
		const followUpQueueLengths: number[] = [];
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				followUpQueueLengths.push(event.followUp.length);
			}
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.queueFollowUp(userMessage("one"));
				harness.queueFollowUp(userMessage("two"));
			}
		});

		await prompt(harness, "hello");

		expect(userCounts).toEqual([1, 2, 3]);
		expect(followUpQueueLengths).toEqual([1, 2, 1, 0]);
	});

	it("settles thrown hook failures with persisted assistant error messages", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("should not be used")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			session,
			model: registration.getModel(),
		});
		const events: string[] = [];
		harness.subscribe((event) => {
			events.push(event.type);
		});
		harness.on("context", () => {
			throw new Error("context exploded");
		});

		const response = await prompt(harness, "hello");
		await expect(prompt(harness, "after failure")).resolves.toMatchObject({ role: "assistant" });

		const entries = await session.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("context exploded");
		expect(messages[0]?.role).toBe("user");
		expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "context exploded" });
		expect(events).toContain("agent_end");
		expect(events).toContain("settled");
	});

	it("refreshes model, thinking level, system prompt, and active tools at save points", async () => {
		const registration = registerFauxProvider({
			models: [
				{ id: "first", reasoning: true },
				{ id: "second", reasoning: true },
			],
		});
		registrations.push(registration);
		const secondModel = registration.getModel("second");
		if (!secondModel) throw new Error("missing second faux model");
		const captured: Array<{ modelId: string; reasoning: unknown; systemPrompt: string; tools: string[] }> = [];
		registration.setResponses([
			(context, options, _state, model) => {
				captured.push({
					modelId: model.id,
					reasoning: getReasoning(options),
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context, options, _state, model) => {
				captured.push({
					modelId: model.id,
					reasoning: getReasoning(options),
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("done");
			},
		]);
		let systemPrompt = "first prompt";
		const harness = new AgentHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			thinkingLevel: "off",
			systemPrompt: () => systemPrompt,
		});
		await harness.setTools([calculateTool], [calculateTool.name]);
		harness.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				void harness.setModel(secondModel);
				void harness.setThinkingLevel("high");
				systemPrompt = "second prompt";
				void harness.setTools([calculateTool, getCurrentTimeTool], [getCurrentTimeTool.name]);
			}
		});

		await prompt(harness, "hello");

		expect(captured).toEqual([
			{ modelId: "first", reasoning: undefined, systemPrompt: "first prompt", tools: ["calculate"] },
			{ modelId: "second", reasoning: "high", systemPrompt: "second prompt", tools: ["get_current_time"] },
		]);
	});

	it("orders pending listener session writes after agent-emitted messages", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			session,
			model: registration.getModel(),
		});
		let wrotePendingMessage = false;
		harness.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && !wrotePendingMessage) {
				wrotePendingMessage = true;
				await harness.appendCustomEntry("listener", { text: "listener write" });
			}
		});

		await prompt(harness, "hello");

		const entries = await session.getEntries();
		expect(entries.map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual([
			"user",
			"assistant",
			"custom",
		]);
	});

	it("waitForIdle waits for external run settlement and awaited listeners", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const barrier = deferred();
		const harness = new AgentHarness({
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		let listenerFinished = false;
		harness.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		const promptPromise = prompt(harness, "hello");
		let idleResolved = false;
		const idlePromise = harness.waitForIdle().then(() => {
			idleResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);
		expect(idleResolved).toBe(true);
		expect(listenerFinished).toBe(true);
	});

	it("runs tool_call and tool_result hooks through the direct loop", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			session,
			model: registration.getModel(),
		});
		await harness.setTools([calculateTool], [calculateTool.name]);
		const seenToolCalls: Array<{ id: string; name: string; expression: unknown }> = [];
		harness.on("tool_call", (event) => {
			seenToolCalls.push({ id: event.toolCallId, name: event.toolName, expression: event.input["expression"] });
			return undefined;
		});
		harness.on("tool_result", (event) => {
			expect(event.toolCallId).toBe("call-1");
			expect(event.toolName).toBe("calculate");
			return {
				content: [{ type: "text", text: "patched result" }],
				details: { patched: true },
				disposition: "stop",
			};
		});

		await prompt(harness, "hello");

		const toolResult = (await session.getEntries()).find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(seenToolCalls).toEqual([{ id: "call-1", name: "calculate", expression: "2 + 2" }]);
		expect(toolResult).toMatchObject({
			type: "message",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: "patched result" }],
				details: { patched: true },
			},
		});
	});

	it("preserves app tool types for active tools and update events", async () => {
		const session = new Session(new InMemorySessionStorage());
		const model = getModel("anthropic", "claude-sonnet-4-5");
		type AppTool = AgentTool<typeof calculateTool.parameters> & { source: "builtin" | "extension" };
		const inspectTool: AppTool = { ...calculateTool, name: "inspect", source: "builtin" };
		const searchTool: AppTool = { ...calculateTool, name: "search", source: "extension" };
		const harness = new AgentHarness<AppTool>({ session, model });
		await harness.setTools([inspectTool, searchTool], ["inspect"]);
		const updates: Array<{
			toolNames: string[];
			previousToolNames: string[];
			activeToolNames: string[];
			previousActiveToolNames: string[];
			source: "set" | "restore";
		}> = [];
		harness.subscribe((event) => {
			if (event.type === "tools_update") {
				updates.push({
					toolNames: event.toolNames,
					previousToolNames: event.previousToolNames,
					activeToolNames: event.activeToolNames,
					previousActiveToolNames: event.previousActiveToolNames,
					source: event.source,
				});
				expect(harness.getActiveTools().map((tool) => tool.name)).toEqual(event.activeToolNames);
			}
		});

		const activeTools = harness.getActiveTools();
		activeTools.pop();
		expect(harness.getActiveTools().map((tool) => tool.source)).toEqual(["builtin"]);

		await harness.setTools([inspectTool, searchTool], ["search"]);
		await harness.setTools([searchTool], ["search"]);
		await expect(harness.setTools([searchTool], ["missing"])).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(harness.setTools([searchTool], ["search", "search"])).rejects.toMatchObject({
			code: "invalid_argument",
		});
		await expect(harness.setTools([inspectTool])).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(harness.setTools([inspectTool, inspectTool], ["inspect"])).rejects.toMatchObject({
			code: "invalid_argument",
		});

		expect(updates).toEqual([
			{
				toolNames: ["inspect", "search"],
				previousToolNames: ["inspect", "search"],
				activeToolNames: ["search"],
				previousActiveToolNames: ["inspect"],
				source: "set",
			},
			{
				toolNames: ["search"],
				previousToolNames: ["inspect", "search"],
				activeToolNames: ["search"],
				previousActiveToolNames: ["search"],
				source: "set",
			},
		]);
		expect(harness.getActiveTools().map((tool) => tool.source)).toEqual(["extension"]);
		expect((await session.buildContext()).activeToolNames).toEqual(["search"]);
	});
});
