import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarnessAdmissionGate } from "../../src/harness/admission-gate.ts";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentHarnessOptions } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

const registrations: Array<ReturnType<typeof registerFauxProvider>> = [];
const harnesses: AgentHarness[] = [];
const barriers: Array<() => void> = [];
const suspendedError = { code: "busy", message: "Operation admission is suspended" };

afterEach(async () => {
	for (const release of barriers.splice(0)) release();
	const closing = harnesses.splice(0);
	for (const harness of closing) harness.requestClose();
	await Promise.all(closing.map((harness) => harness.waitForClosed()));
	for (const registration of registrations.splice(0)) registration.unregister();
	vi.restoreAllMocks();
});

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	barriers.push(resolve);
	return { promise, resolve };
}

function observe<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
	return promise.then(
		(value) => ({ status: "fulfilled", value }),
		(reason: unknown) => ({ status: "rejected", reason }),
	);
}

function createHarness(options: Omit<AgentHarnessOptions, "env" | "session" | "model"> = {}) {
	const registration = registerFauxProvider({
		models: [{ id: "admission-test", contextWindow: 6000, maxTokens: 1000 }],
	});
	registrations.push(registration);
	const session = new Session(new InMemorySessionStorage());
	const harness = new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session,
		model: registration.getModel(),
		...options,
	});
	harnesses.push(harness);
	return { harness, session, registration };
}

function userMessage(content: string): AgentMessage {
	return { role: "user", content, timestamp: 1 };
}

function userTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		return typeof message.content === "string"
			? [message.content]
			: message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	});
}

describe("AgentHarness shared admission", () => {
	it.each([
		"run",
		"run-array",
		"runPrompt",
		"prompt",
		"skill",
		"promptFromTemplate",
		"continue",
		"continue-context",
	] as const)(
		"rejects idle %s before hooks, provider work, or transcript changes and recovers after release",
		async (operation) => {
			const admissionGate = new AgentHarnessAdmissionGate();
			const systemPrompt = vi.fn(() => "test system prompt");
			const { harness, registration, session } = createHarness({
				admissionGate,
				systemPrompt,
				resources: {
					skills: [
						{ name: "test", description: "Test skill", content: "Skill input", filePath: "/test/SKILL.md" },
					],
					promptTemplates: [{ name: "test", content: "Template input" }],
				},
			});
			await session.appendMessage(userMessage("canonical input"));
			const before = await session.getEntries();
			const beforeStart = vi.fn(() => undefined);
			const beforeProvider = vi.fn(() => undefined);
			const contextHook = vi.fn(() => undefined);
			const messageHook = vi.fn(() => undefined);
			const subscriber = vi.fn();
			harness.on("before_agent_start", beforeStart);
			harness.on("before_provider_request", beforeProvider);
			harness.on("context", contextHook);
			harness.on("message_end", messageHook);
			harness.subscribe(subscriber);
			const buildContext = vi.spyOn(session, "buildContext");
			const getBranchSnapshot = vi.spyOn(session, "getBranchSnapshot");
			const commitBatch = vi.spyOn(session, "commitBatch");
			registration.setResponses([fauxAssistantMessage("recovered")]);
			const invoke = {
				run: () => harness.run(userMessage("new input")),
				"run-array": () => harness.run([userMessage("new input"), userMessage("second input")]),
				runPrompt: () => harness.runPrompt("new input"),
				prompt: () => harness.prompt("new input"),
				skill: () => harness.skill("test"),
				promptFromTemplate: () => harness.promptFromTemplate("test"),
				continue: () => harness.continue(),
				"continue-context": () => harness.continue({ context: [userMessage("explicit context")] }),
			}[operation];

			const release = admissionGate.suspend();
			await expect(invoke()).rejects.toMatchObject(suspendedError);
			expect(registration.state.callCount).toBe(0);
			for (const hook of [systemPrompt, beforeStart, beforeProvider, contextHook, messageHook, subscriber]) {
				expect(hook).not.toHaveBeenCalled();
			}
			expect(buildContext).not.toHaveBeenCalled();
			expect(getBranchSnapshot).not.toHaveBeenCalled();
			expect(commitBatch).not.toHaveBeenCalled();
			expect(await session.getEntries()).toEqual(before);
			expect(harness.hasPendingPrompt()).toBe(false);
			expect(harness.isReservedOrRunning()).toBe(false);
			expect(harness.signal).toBeUndefined();
			await harness.waitForIdle();

			release();
			await expect(invoke()).resolves.toBeDefined();
			expect(registration.state.callCount).toBe(1);
			expect(beforeProvider).toHaveBeenCalledTimes(1);
			expect(harness.getPhase()).toBe("idle");
		},
	);

	it("gates assistant-tail no-op continuation and synchronous run reservations", async () => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const { harness, session, registration } = createHarness({ admissionGate });
		await session.appendMessage(fauxAssistantMessage("already complete"));
		const before = await session.getEntries();
		const release = admissionGate.suspend();
		expect(() => harness.reserveRun()).toThrow("Operation admission is suspended");
		await expect(harness.continue()).rejects.toMatchObject(suspendedError);
		expect(await session.getEntries()).toEqual(before);
		expect(harness.getPhase()).toBe("idle");
		release();
		await expect(harness.continue()).resolves.toEqual({ status: "completed", deliveries: [] });
		const reservation = harness.reserveRun();
		expect(harness.cancelReservedRun(reservation)).toBe(true);
		await harness.waitForIdle();
		expect(registration.state.callCount).toBe(0);
	});

	it.each(["runCompactionOperation", "requestCompaction", "runTreeOperation", "requestTreeOperation"] as const)(
		"rejects idle %s before strategy execution and recovers after release",
		async (operation) => {
			const admissionGate = new AgentHarnessAdmissionGate();
			const { harness, session, registration } = createHarness({ admissionGate });
			const strategy = vi.fn(() => "structural result");
			const getMetadata = vi.spyOn(session, "getMetadata");
			const release = admissionGate.suspend();
			await expect(harness[operation](strategy)).rejects.toMatchObject(suspendedError);
			expect(strategy).not.toHaveBeenCalled();
			expect(getMetadata).not.toHaveBeenCalled();
			expect(await session.getEntries()).toEqual([]);
			expect(harness.getPhase()).toBe("idle");
			await harness.waitForIdle();
			release();
			await expect(harness[operation](strategy)).resolves.toBe("structural result");
			expect(strategy).toHaveBeenCalledTimes(1);
			expect(registration.state.callCount).toBe(0);
		},
	);

	it.each(["compact", "navigateTree"] as const)(
		"rejects idle %s before structural hooks and canonical work and recovers after release",
		async (operation) => {
			const admissionGate = new AgentHarnessAdmissionGate();
			const { harness, session, registration } = createHarness({ admissionGate });
			const target = await session.appendMessage(userMessage("branch target"));
			for (let index = 0; index < 5; index++) {
				await session.appendMessage(userMessage(String(index).repeat(4000)));
			}
			const before = await session.getBranchSnapshot();
			const beforeCompact = vi.fn(() => undefined);
			const beforeTree = vi.fn(() => undefined);
			const beforeProvider = vi.fn(() => undefined);
			harness.on("session_before_compact", beforeCompact);
			harness.on("session_before_tree", beforeTree);
			harness.on("before_provider_request", beforeProvider);
			const getBranchSnapshot = vi.spyOn(session, "getBranchSnapshot");
			const commitBatch = vi.spyOn(session, "commitBatch");
			registration.setSimpleResponses([fauxAssistantMessage("summary")]);
			const invoke = () =>
				operation === "compact" ? harness.compact() : harness.navigateTree(target, { summarize: true });
			const release = admissionGate.suspend();
			await expect(invoke()).rejects.toMatchObject(suspendedError);
			for (const hook of [beforeCompact, beforeTree, beforeProvider]) expect(hook).not.toHaveBeenCalled();
			expect(getBranchSnapshot).not.toHaveBeenCalled();
			expect(commitBatch).not.toHaveBeenCalled();
			expect(registration.state).toEqual({ callCount: 0, simpleCallCount: 0 });
			expect(await session.getBranchSnapshot()).toEqual(before);
			await harness.waitForIdle();
			release();
			await expect(invoke()).resolves.toBeDefined();
			expect(beforeProvider).toHaveBeenCalledTimes(1);
			expect(registration.state).toEqual({ callCount: 0, simpleCallCount: 1 });
		},
	);

	it("shares host holds across harnesses without affecting independent or default gates", async () => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const shared = [createHarness({ admissionGate }), createHarness({ admissionGate })];
		const independent = createHarness({ admissionGate: new AgentHarnessAdmissionGate() });
		const defaults = [createHarness(), createHarness()];
		for (const created of [...shared, independent, ...defaults]) {
			created.registration.setResponses([fauxAssistantMessage("done")]);
		}
		const outer = admissionGate.suspend();
		const inner = admissionGate.suspend();
		for (const { harness } of shared)
			await expect(harness.runPrompt("blocked")).rejects.toMatchObject(suspendedError);
		for (const { harness } of [independent, ...defaults]) {
			await expect(harness.runPrompt("independent")).resolves.toMatchObject({ status: "completed" });
		}
		outer();
		outer();
		for (const { harness } of shared)
			await expect(harness.runPrompt("still blocked")).rejects.toMatchObject(suspendedError);
		inner();
		for (const { harness, registration } of shared) {
			await expect(harness.runPrompt("reopened")).resolves.toMatchObject({ status: "completed" });
			expect(registration.state.callCount).toBe(1);
		}
	});

	it("retains queued continuations while admission is suspended", async () => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const { harness, registration, session } = createHarness({ admissionGate });
		await session.appendMessage(fauxAssistantMessage("previous answer"));
		const before = await session.getEntries();
		const steerId = harness.queueSteer(userMessage("queued steer"));
		const followUpId = harness.queueFollowUp(userMessage("queued follow-up"));
		const requests: string[][] = [];
		registration.setResponses([
			(context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage("steer answer");
			},
			(context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage("follow-up answer");
			},
		]);
		const release = admissionGate.suspend();
		await expect(harness.continue({ drainFollowUps: true })).rejects.toMatchObject(suspendedError);
		expect(harness.hasQueuedMessages()).toBe(true);
		expect(registration.state.callCount).toBe(0);
		expect(await session.getEntries()).toEqual(before);
		release();
		await expect(harness.continue({ drainFollowUps: true })).resolves.toMatchObject({
			status: "completed",
			deliveries: [
				{ deliveryId: steerId, outcome: "committed" },
				{ deliveryId: followUpId, outcome: "committed" },
			],
		});
		expect(requests).toEqual([["queued steer"], ["queued steer", "queued follow-up"]]);
		expect(harness.hasQueuedMessages()).toBe(false);
	});

	it("keeps queue, messaging, and configuration APIs usable while suspended", async () => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const { harness, registration, session } = createHarness({ admissionGate });
		const release = admissionGate.suspend();
		await harness.appendMessage(userMessage("host message"));
		await harness.setModelAndThinkingLevel(registration.getModel(), "high");
		await harness.setStreamOptions({ maxRetries: 0 });
		await harness.setResources({ promptTemplates: [{ name: "new", content: "new template" }] });
		await harness.setSteeringMode("all");
		await harness.setFollowUpMode("all");
		const steer = harness.queueSteer(userMessage("clear steer"));
		const followUp = harness.queueFollowUp(userMessage("clear follow-up"));
		await expect(harness.clearAllQueues()).resolves.toEqual([steer, followUp]);
		await harness.nextTurn("next-turn payload");
		expect(harness.getThinkingLevel()).toBe("high");
		expect(harness.getStreamOptions()).toEqual({ maxRetries: 0 });
		expect((await session.buildContext()).thinkingLevel).toBe("high");
		await expect(harness.runPrompt("blocked")).rejects.toMatchObject(suspendedError);
		expect(userTexts((await session.buildContext()).messages)).toEqual(["host message"]);
		let received: string[] = [];
		registration.setResponses([
			(context) => {
				received = userTexts(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		release();
		await harness.runPrompt("accepted");
		expect(received).toEqual(["host message", "next-turn payload", "accepted"]);
	});
});

describe("AgentHarness reserved admission invalidation", () => {
	it.each([
		["runReserved", false],
		["runReserved", true],
		["continueReserved", false],
		["continueReserved", true],
		["runCompactionBeforeReserved", false],
		["runCompactionBeforeReserved", true],
	] as const)("rejects pre-suspend %s without stranding idle, reopened=%s", async (operation, reopen) => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const { harness, registration, session } = createHarness({ admissionGate });
		await session.appendMessage(userMessage("canonical input"));
		const before = await session.getEntries();
		const strategy = vi.fn(() => "must not compact");
		const beforeStart = vi.fn(() => undefined);
		const beforeProvider = vi.fn(() => undefined);
		harness.on("before_agent_start", beforeStart);
		harness.on("before_provider_request", beforeProvider);
		const reservation = harness.reserveRun();
		const idle = harness.waitForIdle();
		const release = admissionGate.suspend();
		if (reopen) release();
		const invoke = {
			runReserved: () => harness.runReserved(reservation, userMessage("stale input")),
			continueReserved: () => harness.continueReserved(reservation),
			runCompactionBeforeReserved: () => harness.runCompactionBeforeReserved(reservation, strategy),
		}[operation];
		await expect(invoke()).rejects.toBeInstanceOf(Error);
		await idle;
		expect(harness.getPhase()).toBe("idle");
		expect(harness.signal).toBeUndefined();
		expect(harness.hasPendingPrompt()).toBe(false);
		expect(harness.cancelReservedRun(reservation)).toBe(false);
		expect(strategy).not.toHaveBeenCalled();
		expect(beforeStart).not.toHaveBeenCalled();
		expect(beforeProvider).not.toHaveBeenCalled();
		expect(registration.state.callCount).toBe(0);
		expect(await session.getEntries()).toEqual(before);
		release();
		registration.setResponses([fauxAssistantMessage("fresh result")]);
		await harness.runReserved(harness.reserveRun(), userMessage("fresh input"));
		expect(registration.state.callCount).toBe(1);
	});

	it.each([false, true])(
		"invalidates a continuation reserved before an awaited context read, reopened=%s",
		async (reopen) => {
			const admissionGate = new AgentHarnessAdmissionGate();
			const { harness, session, registration } = createHarness({ admissionGate });
			await session.appendMessage(userMessage("canonical input"));
			const entered = deferred();
			const barrier = deferred();
			const buildContext = session.buildContext.bind(session);
			vi.spyOn(session, "buildContext").mockImplementationOnce(async () => {
				entered.resolve();
				await barrier.promise;
				return await buildContext();
			});
			const continuation = observe(harness.continue());
			await entered.promise;
			const idle = harness.waitForIdle();
			const release = admissionGate.suspend();
			if (reopen) release();
			barrier.resolve();
			expect(await continuation).toMatchObject({ status: "rejected" });
			await idle;
			expect(registration.state.callCount).toBe(0);
			expect(userTexts((await session.buildContext()).messages)).toEqual(["canonical input"]);
			release();
			registration.setResponses([fauxAssistantMessage("continued")]);
			await harness.continue();
			expect(registration.state.callCount).toBe(1);
		},
	);

	it.each([false, true])("invalidates a pending post-compaction turn handoff, reopened=%s", async (reopen) => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const { harness, session, registration } = createHarness({ admissionGate });
		const entered = deferred();
		const barrier = deferred();
		const handoff = observe(
			harness.runCompactionBeforeReserved(harness.reserveRun(), async () => {
				entered.resolve();
				await barrier.promise;
				return "compacted";
			}),
		);
		await entered.promise;
		const idle = harness.waitForIdle();
		const release = admissionGate.suspend();
		if (reopen) release();
		barrier.resolve();
		expect(await handoff).toMatchObject({ status: "rejected" });
		await idle;
		expect(harness.getPhase()).toBe("idle");
		expect(registration.state.callCount).toBe(0);
		expect(await session.getEntries()).toEqual([]);
		release();
		registration.setResponses([fauxAssistantMessage("fresh")]);
		await harness.runPrompt("fresh after invalid handoff");
	});
});

describe("AgentHarness successor admission and teardown", () => {
	it.each([
		["requestCompaction", false],
		["requestCompaction", true],
		["requestTreeOperation", false],
		["requestTreeOperation", true],
	] as const)("rejects promoted %s before strategy startup, reopened=%s", async (operation, reopen) => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const { harness, session, registration } = createHarness({ admissionGate });
		const reservation = harness.reserveRun();
		const idle = harness.waitForIdle();
		const strategy = vi.fn(() => "fresh structural result");
		const successor = observe(harness[operation](strategy));
		expect(harness.getPhase()).toBe(operation === "requestCompaction" ? "compaction" : "branch_summary");
		const release = admissionGate.suspend();
		if (reopen) release();
		expect(await successor).toMatchObject({ status: "rejected" });
		await idle;
		expect(harness.getPhase()).toBe("idle");
		expect(harness.cancelReservedRun(reservation)).toBe(false);
		expect(strategy).not.toHaveBeenCalled();
		expect(registration.state).toEqual({ callCount: 0, simpleCallCount: 0 });
		expect(await session.getEntries()).toEqual([]);
		release();
		await expect(harness[operation](strategy)).resolves.toBe("fresh structural result");
		expect(strategy).toHaveBeenCalledTimes(1);
	});

	it.each([
		["requestCompaction", false],
		["requestCompaction", true],
		["requestTreeOperation", false],
		["requestTreeOperation", true],
	] as const)("rejects pending %s without executing it, reopened=%s", async (operation, reopen) => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const { harness, session, registration } = createHarness({ admissionGate });
		const entered = deferred();
		const barrier = deferred();
		harness.on("before_agent_start", async () => {
			entered.resolve();
			await barrier.promise;
			return undefined;
		});
		const running = harness.runPrompt("preflight input");
		await entered.promise;
		const strategy = vi.fn(() => "must not execute");
		const successor = observe(harness[operation](strategy));
		expect(harness.signal?.aborted).toBe(true);
		const idle = harness.waitForIdle();
		const release = admissionGate.suspend();
		if (reopen) release();
		barrier.resolve();
		await running;
		expect(await successor).toMatchObject({ status: "rejected" });
		await idle;
		expect(strategy).not.toHaveBeenCalled();
		expect(registration.state.callCount).toBe(0);
		expect(await session.getEntries()).toEqual([]);
		expect(harness.hasPendingPrompt()).toBe(true);
		release();
		await expect(harness[operation](strategy)).resolves.toBe("must not execute");
		expect(strategy).toHaveBeenCalledTimes(1);
		registration.setResponses([fauxAssistantMessage("resumed")]);
		await harness.continue();
		expect(harness.hasPendingPrompt()).toBe(false);
	});

	it.each(["requestCompaction", "requestTreeOperation"] as const)(
		"rejects new %s before aborting executing structural work",
		async (operation) => {
			const admissionGate = new AgentHarnessAdmissionGate();
			const { harness } = createHarness({ admissionGate });
			const entered = deferred();
			const barrier = deferred();
			const running = harness.runCompactionOperation(async () => {
				entered.resolve();
				await barrier.promise;
				return "existing work finished";
			});
			await entered.promise;
			const release = admissionGate.suspend();
			const strategy = vi.fn(() => "not admitted");
			await expect(harness[operation](strategy)).rejects.toMatchObject(suspendedError);
			expect(harness.signal?.aborted).toBe(false);
			expect(strategy).not.toHaveBeenCalled();
			barrier.resolve();
			await expect(running).resolves.toBe("existing work finished");
			await harness.waitForIdle();
			release();
		},
	);

	it.each([false, true])(
		"does not strand a compaction handoff when tree replacement is rejected, inherited=%s",
		async (inherited) => {
			const admissionGate = new AgentHarnessAdmissionGate();
			const { harness, registration, session } = createHarness({ admissionGate });
			const entered = deferred();
			const barrier = deferred();
			const handoff = observe(
				harness.runCompactionBeforeReserved(harness.reserveRun(), async () => {
					entered.resolve();
					await barrier.promise;
					return "compacted";
				}),
			);
			await entered.promise;
			const treeStrategy = vi.fn(() => "tree result");
			const tree = inherited ? observe(harness.requestTreeOperation(treeStrategy)) : undefined;
			const release = admissionGate.suspend();
			const rejectedStrategy = vi.fn(() => "must not replace");
			await expect(harness.requestTreeOperation(rejectedStrategy)).rejects.toMatchObject(suspendedError);
			barrier.resolve();
			expect(await handoff).toMatchObject({ status: "rejected" });
			if (tree) expect(await tree).toMatchObject({ status: "rejected" });
			await harness.waitForIdle();
			expect(treeStrategy).not.toHaveBeenCalled();
			expect(rejectedStrategy).not.toHaveBeenCalled();
			expect(registration.state.callCount).toBe(0);
			expect(await session.getEntries()).toEqual([]);
			release();
		},
	);

	it("lets an executing provider request finish while admission remains suspended", async () => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const { harness, registration, session } = createHarness({ admissionGate });
		const entered = deferred();
		const barrier = deferred();
		registration.setResponses([
			async () => {
				entered.resolve();
				await barrier.promise;
				return fauxAssistantMessage("existing response");
			},
		]);
		const running = harness.runPrompt("existing prompt");
		await entered.promise;
		const release = admissionGate.suspend();
		expect(harness.signal?.aborted).toBe(false);
		barrier.resolve();
		await expect(running).resolves.toMatchObject({ status: "completed" });
		await harness.waitForIdle();
		expect((await session.buildContext()).messages.at(-1)).toMatchObject({ stopReason: "stop" });
		expect(registration.state.callCount).toBe(1);
		await expect(harness.runPrompt("new prompt")).rejects.toMatchObject(suspendedError);
		release();
	});

	it("keeps active messaging and explicit abort functional while suspended", async () => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const { harness, registration, session } = createHarness({ admissionGate });
		const entered = deferred();
		const barrier = deferred();
		registration.setResponses([
			async () => {
				entered.resolve();
				await barrier.promise;
				return fauxAssistantMessage("late response");
			},
		]);
		const running = harness.runPrompt("abort me");
		await entered.promise;
		const release = admissionGate.suspend();
		const steer = await harness.steer("retained steer");
		const followUp = await harness.followUp("retained follow-up");
		expect(harness.abort("host_action")).toMatchObject({ accepted: true, source: "host_action" });
		expect(harness.abort("disposal")).toMatchObject({ accepted: false, source: "host_action" });
		expect(harness.signal?.aborted).toBe(true);
		barrier.resolve();
		await running;
		await harness.waitForIdle();
		expect(harness.hasQueuedMessages()).toBe(true);
		await expect(harness.clearAllQueues()).resolves.toEqual([steer, followUp]);
		const response = (await session.buildContext()).messages.at(-1);
		expect(response).toMatchObject({
			role: "assistant",
			diagnostics: expect.arrayContaining([
				expect.objectContaining({ type: "runtime_abort", details: { source: "host_action" } }),
			]),
		});
		expect(admissionGate.isOpen).toBe(false);
		release();
	});

	it.each(["cancelReservedRun", "abort", "requestClose", "dispose"] as const)(
		"permits %s to release a preexisting reservation while suspended",
		async (operation) => {
			const admissionGate = new AgentHarnessAdmissionGate();
			const { harness, registration } = createHarness({ admissionGate });
			const reservation = harness.reserveRun();
			const idle = harness.waitForIdle();
			const release = admissionGate.suspend();
			if (operation === "cancelReservedRun") expect(harness.cancelReservedRun(reservation)).toBe(true);
			else if (operation === "abort") expect(harness.abort("host_action")).toMatchObject({ accepted: true });
			else harness[operation]();
			await idle;
			expect(harness.getPhase()).toBe("idle");
			expect(registration.state.callCount).toBe(0);
			expect(admissionGate.isOpen).toBe(false);
			if (operation === "requestClose" || operation === "dispose") {
				await harness.waitForClosed();
				release();
				await expect(harness.runPrompt("terminal")).rejects.toMatchObject({ code: "invalid_state" });
			} else release();
		},
	);

	it("closes active structural work and pending successors without reopening the shared gate", async () => {
		const admissionGate = new AgentHarnessAdmissionGate();
		const { harness } = createHarness({ admissionGate });
		const entered = deferred();
		const barrier = deferred();
		const handoff = observe(
			harness.runCompactionBeforeReserved(harness.reserveRun(), async () => {
				entered.resolve();
				await barrier.promise;
				return "compacted";
			}),
		);
		await entered.promise;
		const treeStrategy = vi.fn(() => "must not run");
		const tree = observe(harness.requestTreeOperation(treeStrategy));
		const release = admissionGate.suspend();
		harness.requestClose();
		let closed = false;
		const closing = harness.waitForClosed().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		barrier.resolve();
		expect(await handoff).toMatchObject({ status: "rejected" });
		expect(await tree).toMatchObject({ status: "rejected" });
		await closing;
		expect(treeStrategy).not.toHaveBeenCalled();
		expect(admissionGate.isOpen).toBe(false);
		release();
		await expect(harness.runPrompt("closed")).rejects.toMatchObject({ code: "invalid_state" });
	});
});
