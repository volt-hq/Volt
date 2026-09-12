import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_JOB_NOTIFICATION_TYPE } from "../../../src/core/background-jobs.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const harnesses: Harness[] = [];
const finishes: Array<() => void> = [];

async function setup(extra: HarnessOptions = {}) {
	const workers = new Map<string, ReturnType<typeof deferred>>();
	const operations: BashOperations = {
		exec: async (command, _cwd, options) => {
			const finish = deferred();
			workers.set(command, finish);
			finishes.push(finish.resolve);
			options.signal?.addEventListener("abort", finish.resolve, { once: true });
			try {
				await finish.promise;
				if (options.signal?.aborted) throw new Error("Cancelled worker");
				options.onData(Buffer.from(`untrusted output for ${command}`));
				return { exitCode: command === "fail" ? 1 : 0 };
			} finally {
				options.signal?.removeEventListener("abort", finish.resolve);
			}
		},
	};
	const original = nativeTools.createAllToolDefinitions;
	vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
		original(cwd, { ...options, bash: { ...options?.bash, operations } }),
	);
	const harness = await createHarness({
		initialActiveToolNames: ["bash", "jobs"],
		settings: { lsp: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false } },
		...extra,
	});
	harnesses.push(harness);
	harness.session.setSessionName("Job continuation regression");
	const setResponses = harness.setResponses;
	harness.setResponses = (responses) =>
		setResponses(
			responses.map((response) => async (context, options, state, model) => {
				await options?.onPayload?.({ messages: structuredClone(context.messages) }, model, {
					toolResultMessageIndices: context.messages.flatMap((message, index) =>
						message.role === "toolResult" ? [index] : [],
					),
				});
				return typeof response === "function" ? response(context, options, state, model) : response;
			}),
		);
	return { harness, workers };
}

async function launch(harness: Harness, commands = ["work"]) {
	harness.setResponses([
		fauxAssistantMessage(
			commands.map((command) => fauxToolCall("bash", { command, background: true })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("My foreground work is done."),
	]);
	await harness.session.prompt("Run independent work");
	return harness.session.backgroundJobs.list();
}

function collect(harness: Harness, ids: string[]) {
	harness.setResponses([
		(context) => {
			const text = context.messages.map(getMessageText).join("\n");
			for (const id of ids) expect(text).toContain(id);
			expect(text).toContain("Background job completion notice");
			expect(text).not.toContain("untrusted output for");
			return fauxAssistantMessage(fauxToolCall("jobs", { action: "wait", ids, mode: "all" }), {
				stopReason: "toolUse",
			});
		},
		(context) => {
			expect(context.messages.map(getMessageText).join("\n")).toContain("untrusted output for");
			return fauxAssistantMessage("Collected background outcome.");
		},
	]);
}

async function expectCollected(harness: Harness, calls = 4) {
	await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("Collected background outcome."));
	await harness.session.waitForIdle();
	expect(harness.faux.state.callCount).toBe(calls);
	expect(harness.session.backgroundJobs.listUncollected()).toEqual([]);
	await delay(10);
	expect(harness.faux.state.callCount).toBe(calls);
}

afterEach(async () => {
	for (const harness of harnesses) harness.session.dispose();
	for (const finish of finishes.splice(0)) finish();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("#392 background outcome continuation", () => {
	it.each(["work", "fail"])("resumes an idle parent after %s without user input", async (command) => {
		const { harness, workers } = await setup();
		const [job] = await launch(harness, [command]);
		expect(harness.session.isBusy).toBe(false);
		collect(harness, [job.id]);
		workers.get(command)!.resolve();
		await expectCollected(harness);
		expect(harness.session.backgroundJobs.get(job.id).status).toBe(command === "fail" ? "failed" : "completed");
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it.each(["work", "fail"])("fences late %s outcomes and siblings after a policy stop", async (command) => {
		const { harness, workers } = await setup();
		const unregister = harness.session.registerTurnPolicy({
			nextAction: async (context) =>
				context.completedTurn && context.completedTurn.toolResults.length === 0 ? { type: "stop" } : undefined,
		});
		const jobs = await launch(harness, [command, "later"]);
		expect(harness.session.hasBackgroundJobs).toBe(true);
		workers.get(command)!.resolve();
		await vi.waitFor(() =>
			expect(
				harness.session.backgroundJobs.get(jobs.find((job) => job.label === command)!.id).endedAt,
			).toBeDefined(),
		);
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
		workers.get("later")!.resolve();
		await harness.session.waitForBackgroundJobs();
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.backgroundJobs.listUncollected()).toHaveLength(2);
		for (const job of jobs) {
			expect(harness.session.backgroundJobs.get(job.id)).toMatchObject({
				status: job.label === "fail" ? "failed" : "completed",
				output: expect.stringContaining(`untrusted output for ${job.label}`),
			});
		}
		unregister();
		// Suppression belongs to existing jobs, not the whole session or future launches.
		const allJobs = await launch(harness, ["new"]);
		const newJob = allJobs.find((job) => job.label === "new")!;
		collect(harness, [newJob.id]);
		workers.get("new")!.resolve();
		await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("Collected background outcome."));
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(6);
	});

	it("fences jobs settling during an asynchronous stop decision and after settlement", async () => {
		const { harness, workers } = await setup();
		const entered = deferred();
		const release = deferred();
		finishes.push(release.resolve);
		harness.session.registerTurnPolicy({
			nextAction: async (context) => {
				if (!context.completedTurn || context.completedTurn.toolResults.length > 0) return undefined;
				entered.resolve();
				await release.promise;
				return { type: "stop" };
			},
		});
		const launching = launch(harness, ["first", "later"]);
		await entered.promise;
		workers.get("first")!.resolve();
		const first = harness.session.backgroundJobs.list().find((job) => job.label === "first")!;
		await vi.waitFor(() => expect(harness.session.backgroundJobs.get(first.id).endedAt).toBeDefined());
		release.resolve();
		await launching;
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
		workers.get("later")!.resolve();
		await harness.session.waitForBackgroundJobs();
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("fences existing work when a policy stops before the first provider request", async () => {
		const { harness, workers } = await setup();
		await launch(harness);
		const unregister = harness.session.registerTurnPolicy({ nextAction: () => ({ type: "stop" }) });
		await harness.session.prompt("A host policy forbids this request");
		expect(harness.faux.state.callCount).toBe(2);
		workers.get("work")!.resolve();
		await harness.session.waitForBackgroundJobs();
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
		unregister();
		harness.setResponses([fauxAssistantMessage("Explicitly authorized recovery.")]);
		await harness.control.continue();
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.getLastAssistantText()).toBe("Explicitly authorized recovery.");
	});

	it.each(["request", "pause"] as const)("preserves wakes when a later policy replaces stop with %s", async (type) => {
		const { harness, workers } = await setup();
		let overridden = false;
		harness.session.registerTurnPolicy({
			nextAction: (context) =>
				!overridden && context.completedTurn?.toolResults.length === 0 ? { type: "stop" } : undefined,
		});
		harness.session.registerTurnPolicy({
			nextAction: (context) => {
				if (overridden || !context.completedTurn || context.defaultAction.type !== "stop") return undefined;
				overridden = true;
				return type === "pause"
					? { type: "pause" }
					: {
							type: "request",
							reason: "delivery",
							deliveries: [
								{ messages: [{ role: "user", content: "Authorized continuation", timestamp: Date.now() }] },
							],
						};
			},
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "work", background: true }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Foreground finished."),
			fauxAssistantMessage("Authorized continuation finished."),
		]);
		await harness.session.prompt("Start independent work");
		const [job] = harness.session.backgroundJobs.list();
		const calls = type === "pause" ? 2 : 3;
		expect(harness.faux.state.callCount).toBe(calls);
		collect(harness, [job.id]);
		workers.get("work")!.resolve();
		await expectCollected(harness, calls + 2);
	});

	it.each(["stop", "final_response"] as const)("fences late work after tool disposition %s", async (disposition) => {
		const { harness, workers } = await setup();
		harness.control.onToolResult((event) => (event.toolName === "jobs" ? { disposition } : undefined));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "work", background: true }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("jobs", { action: "list" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Final report."),
		]);
		await harness.session.prompt("Start independent work");
		const calls = disposition === "stop" ? 2 : 3;
		expect(harness.faux.state.callCount).toBe(calls);
		workers.get("work")!.resolve();
		await harness.session.waitForBackgroundJobs();
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(calls);
		expect(harness.session.backgroundJobs.listUncollected()).toHaveLength(1);
	});

	it("preserves late wakes through proactive compaction", async () => {
		const { harness, workers } = await setup({
			extensionFactories: [
				(api) => {
					api.on("session_before_compact", (event) => {
						harness.settingsManager.setCompactionEnabled(false);
						return {
							compaction: {
								summary: "Background work remains outstanding.",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		const [job] = await launch(harness);
		harness.setResponses([
			() => {
				// Enable a low threshold only after pre-prompt checks, forcing a tool-boundary pause.
				harness.settingsManager.applyOverrides({
					compaction: {
						enabled: true,
						reserveTokens: harness.getModel().contextWindow - 1,
						keepRecentTokens: 1,
					},
				});
				return fauxAssistantMessage(fauxToolCall("jobs", { action: "list" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Continued after compaction."),
		]);
		await harness.session.prompt("Continue independent work");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.session.getLastAssistantText()).toBe("Continued after compaction.");
		collect(harness, [job.id]);
		workers.get("work")!.resolve();
		await expectCollected(harness, 6);
	});

	it("coalesces simultaneous outcomes into one follow-up", async () => {
		const { harness, workers } = await setup();
		const jobs = await launch(harness, ["first", "second"]);
		collect(
			harness,
			jobs.map((job) => job.id),
		);
		for (const worker of workers.values()) worker.resolve();
		await expectCollected(harness);
		const notices = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === BACKGROUND_JOB_NOTIFICATION_TYPE,
		);
		expect(notices).toHaveLength(1);
	});

	it.each(["running", "settled"])("does not wake when the user cancels a %s job", async (phase) => {
		const { harness, workers } = await setup();
		const [job] = await launch(harness);
		if (phase === "settled") {
			workers.get("work")!.resolve();
			await harness.session.waitForBackgroundJobs();
		}
		harness.session.backgroundJobs.cancel(job.id);
		await harness.session.waitForBackgroundJobs();
		await delay(20);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.backgroundJobs.get(job.id).status).toBe(phase === "running" ? "cancelled" : "completed");
	});

	it("session stop revokes already-settled and running outcomes but not future launches", async () => {
		const { harness, workers } = await setup();
		await launch(harness, ["first", "second"]);
		const settled = deferred();
		const unsubscribe = harness.session.backgroundJobs.subscribe(() => {
			if (harness.session.backgroundJobs.list().find((job) => job.label === "first")?.status === "completed")
				settled.resolve();
		});
		workers.get("first")!.resolve();
		await settled.promise;
		unsubscribe();
		await harness.session.abort();
		await delay(20);
		expect(harness.faux.state.callCount).toBe(2);
		const jobs = await launch(harness, ["new"]);
		const job = jobs.find((job) => job.label === "new")!;
		// Earlier outcome text can appear in later context, so use a simple collection response here.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("jobs", { action: "read", id: job.id }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Collected background outcome."),
		]);
		workers.get("new")!.resolve();
		await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("Collected background outcome."));
		expect(harness.faux.state.callCount).toBe(6);
	});

	it("waits for a busy parent's final response before resuming", async () => {
		const { harness, workers } = await setup();
		const [job] = await launch(harness);
		const entered = deferred();
		const release = deferred();
		finishes.push(release.resolve);
		harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("Foreground finished.");
			},
		]);
		const prompt = harness.session.prompt("Continue foreground work");
		await entered.promise;
		workers.get("work")!.resolve();
		await harness.session.waitForBackgroundJobs();
		await delay(10);
		expect(harness.faux.state.callCount).toBe(3);
		collect(harness, [job.id]);
		release.resolve();
		await prompt;
		await expectCollected(harness, 5);
	});

	it("lets cancellation win while automatic delivery is awaiting an extension", async () => {
		const entered = deferred();
		const release = deferred();
		finishes.push(release.resolve);
		const { harness, workers } = await setup({
			extensionFactories: [
				(api) => {
					api.on("context", async (event) => {
						if (
							event.messages.some(
								(message) =>
									message.role === "custom" && message.customType === BACKGROUND_JOB_NOTIFICATION_TYPE,
							)
						) {
							entered.resolve();
							await release.promise;
						}
					});
				},
			],
		});
		const [job] = await launch(harness);
		workers.get("work")!.resolve();
		await entered.promise;
		harness.session.backgroundJobs.cancel(job.id);
		release.resolve();
		await harness.session.waitForIdle();
		await delay(10);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("cancelling one worker does not suppress a successful sibling", async () => {
		const { harness, workers } = await setup();
		const jobs = await launch(harness, ["cancelled", "survivor"]);
		const cancelled = jobs.find((job) => job.label === "cancelled")!;
		const survivor = jobs.find((job) => job.label === "survivor")!;
		harness.session.backgroundJobs.cancel(cancelled.id);
		collect(harness, [survivor.id]);
		workers.get("survivor")!.resolve();
		await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("Collected background outcome."));
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.session.backgroundJobs.listUncollected()).toMatchObject([
			{ id: cancelled.id, status: "cancelled" },
		]);
	});

	it("keeps a later batched sibling authorized when the original wake job is cancelled", async () => {
		let beforeAutoStart: (() => Promise<void>) | undefined;
		let cancelOriginal: (() => void) | undefined;
		const { harness, workers } = await setup({
			extensionFactories: [
				(api) => {
					api.on("agent_start", async () => {
						await beforeAutoStart?.();
					});
					api.on("context", (event) => {
						if (
							event.messages.some(
								(message) =>
									message.role === "custom" && message.customType === BACKGROUND_JOB_NOTIFICATION_TYPE,
							)
						)
							cancelOriginal?.();
					});
				},
			],
		});
		const jobs = await launch(harness, ["first", "later"]);
		const first = jobs.find((job) => job.label === "first")!;
		const later = jobs.find((job) => job.label === "later")!;
		beforeAutoStart = async () => {
			workers.get("later")!.resolve();
			await harness.session.waitForBackgroundJobs();
		};
		cancelOriginal = () => harness.session.backgroundJobs.cancel(first.id);
		collect(harness, [later.id]);
		workers.get("first")!.resolve();
		await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("Collected background outcome."));
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.session.backgroundJobs.listUncollected()).toMatchObject([{ id: first.id }]);
	});

	it("does not interrupt independent foreground work when a job is cancelled", async () => {
		const { harness } = await setup();
		const [job] = await launch(harness);
		const entered = deferred();
		const release = deferred();
		finishes.push(release.resolve);
		harness.setResponses([
			async (_context, options) => {
				entered.resolve();
				await release.promise;
				expect(options?.signal?.aborted).toBe(false);
				return fauxAssistantMessage("Independent foreground result.");
			},
		]);
		const prompt = harness.session.prompt("Do independent work");
		await entered.promise;
		harness.session.backgroundJobs.cancel(job.id);
		await harness.session.waitForBackgroundJobs();
		release.resolve();
		await prompt;
		await delay(10);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.getLastAssistantText()).toBe("Independent foreground result.");
	});

	it("disposal suppresses a scheduled completion", async () => {
		const { harness, workers } = await setup();
		await launch(harness);
		workers.get("work")!.resolve();
		await harness.session.waitForBackgroundJobs();
		harness.session.dispose();
		await harness.session.waitForClosed();
		await delay(10);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("resumes after a completion during manual compaction, not inside it", async () => {
		const entered = deferred();
		const release = deferred();
		finishes.push(release.resolve);
		const { harness, workers } = await setup({
			extensionFactories: [
				(api) => {
					api.on("session_before_compact", async (event) => {
						entered.resolve();
						await release.promise;
						return {
							compaction: {
								summary: "Background work remains outstanding.",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		const [job] = await launch(harness);
		const compacting = harness.session.compact();
		await entered.promise;
		workers.get("work")!.resolve();
		await harness.session.waitForBackgroundJobs();
		await delay(10);
		expect(harness.faux.state.callCount).toBe(2);
		collect(harness, [job.id]);
		release.resolve();
		await compacting;
		await expectCollected(harness);
	});

	it("does not repeatedly wake when the provider fails", async () => {
		const { harness, workers } = await setup();
		await launch(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider unavailable" })]);
		workers.get("work")!.resolve();
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(3));
		await harness.session.waitForIdle();
		await delay(20);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.backgroundJobs.listUncollected()).toHaveLength(1);
	});
});
