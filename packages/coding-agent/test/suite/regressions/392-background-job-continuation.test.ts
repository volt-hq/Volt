import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { WORK_NOTICE_CUSTOM_TYPE } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import type { JobSummary } from "../../../src/core/tools/jobs.ts";
import { createHarness, getMessageText, getUserTexts, type Harness, type HarnessOptions } from "../harness.ts";

// #392: a background job's completed or failed outcome resumes an idle
// conversation without user input. Since Phase 4 the outcome is a work
// notice the kernel queues with the job's finish; a stop of the turn that
// started the job (policy, tool, final response) fences its notices.

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
	await harness.session.setSessionName("Job continuation regression");
	return { harness, workers };
}

async function launch(harness: Harness, commands = ["work"]): Promise<JobSummary[]> {
	harness.setResponses([
		fauxAssistantMessage(
			commands.map((command) => fauxToolCall("bash", { command, background: true })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("My foreground work is done."),
	]);
	await harness.session.prompt("Run independent work");
	return harness.session.jobs.list();
}

/** The next turn sees the notices of `ids`, without their output, and waits for their results. */
function collect(harness: Harness, ids: string[]) {
	harness.setResponses([
		(context) => {
			const text = context.messages.map(getMessageText).join("\n");
			for (const id of ids) expect(text).toContain(`(job ${id})`);
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
	await delay(10);
	expect(harness.faux.state.callCount).toBe(calls);
}

function notices(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === WORK_NOTICE_CUSTOM_TYPE,
	);
}

async function settle(harness: Harness): Promise<void> {
	await harness.session.work.waitForIdle();
	await harness.session.waitForIdle();
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
		expect(harness.session.jobs.get(job.id).status).toBe(command === "fail" ? "failed" : "completed");
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(notices(harness)).toMatchObject([
			{ details: { workId: job.id, outcome: command === "fail" ? "failed" : "completed" } },
		]);
	});

	it.each(["work", "fail"])("fences late %s outcomes and siblings after a policy stop", async (command) => {
		const { harness, workers } = await setup();
		const unregister = harness.session.registerTurnPolicy({
			nextAction: async (context) =>
				context.completedTurn && context.completedTurn.toolResults.length === 0 ? { type: "stop" } : undefined,
		});
		const jobs = await launch(harness, [command, "later"]);
		expect(harness.session.work.busy()).toBe(true);
		workers.get(command)!.resolve();
		workers.get("later")!.resolve();
		await settle(harness);
		expect(harness.faux.state.callCount).toBe(2);
		for (const job of jobs) {
			expect(harness.session.jobs.get(job.id)).toMatchObject({
				status: job.label === "fail" ? "failed" : "completed",
				output: expect.stringContaining(`untrusted output for ${job.label}`),
			});
		}
		unregister();
		// The fence belongs to the work the stopped turn started, not to future launches.
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
		const first = harness.session.jobs.list().find((job) => job.label === "first")!;
		await vi.waitFor(() => expect(harness.session.jobs.get(first.id).status).toBe("completed"));
		release.resolve();
		await launching;
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
		workers.get("later")!.resolve();
		await settle(harness);
		expect(harness.faux.state.callCount).toBe(2);
		expect(notices(harness)).toHaveLength(0);
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
		await settle(harness);
		expect(harness.faux.state.callCount).toBe(calls);
		expect(harness.session.jobs.list()).toMatchObject([{ status: "completed" }]);
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
		const [job] = harness.session.jobs.list();
		const calls = type === "pause" ? 2 : 3;
		expect(harness.faux.state.callCount).toBe(calls);
		collect(harness, [job.id]);
		workers.get("work")!.resolve();
		await expectCollected(harness, calls + 2);
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

	it("delivers simultaneous outcomes to the turn they wake", async () => {
		const { harness, workers } = await setup();
		const jobs = await launch(harness, ["first", "second"]);
		harness.setResponses([fauxAssistantMessage("Noticed."), fauxAssistantMessage("Noticed again.")]);
		for (const worker of workers.values()) worker.resolve();
		await settle(harness);
		expect(
			notices(harness)
				.map((notice) => (notice.role === "custom" ? (notice.details as { workId: string }).workId : ""))
				.sort(),
		).toEqual(jobs.map((job) => job.id).sort());
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBeLessThanOrEqual(4);
	});

	it("does not wake when the user cancels a running job", async () => {
		const { harness } = await setup();
		const [job] = await launch(harness);
		await harness.session.jobs.cancel(job.id);
		await settle(harness);
		await delay(20);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.jobs.get(job.id).status).toBe("cancelled");
		expect(notices(harness)).toHaveLength(0);
	});

	it("session stop cancels running outcomes but not future launches", async () => {
		const { harness, workers } = await setup();
		await launch(harness, ["first", "second"]);
		await harness.session.abort();
		await delay(20);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.jobs.list().map((job) => job.status)).toEqual(["cancelled", "cancelled"]);
		const jobs = await launch(harness, ["new"]);
		const job = jobs.find((job) => job.label === "new")!;
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
		await harness.session.work.waitForIdle();
		await delay(10);
		expect(harness.faux.state.callCount).toBe(3);
		collect(harness, [job.id]);
		release.resolve();
		await prompt;
		await expectCollected(harness, 5);
	});

	it("cancelling one worker does not suppress a successful sibling", async () => {
		const { harness, workers } = await setup();
		const jobs = await launch(harness, ["cancelled", "survivor"]);
		const cancelled = jobs.find((job) => job.label === "cancelled")!;
		const survivor = jobs.find((job) => job.label === "survivor")!;
		await harness.session.jobs.cancel(cancelled.id);
		collect(harness, [survivor.id]);
		workers.get("survivor")!.resolve();
		await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("Collected background outcome."));
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.session.jobs.get(cancelled.id).status).toBe("cancelled");
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
		await harness.session.jobs.cancel(job.id);
		await harness.session.work.waitForIdle();
		release.resolve();
		await prompt;
		await delay(10);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.getLastAssistantText()).toBe("Independent foreground result.");
	});

	it("keeps a notice queued when a policy stops a later turn before its first request", async () => {
		const { harness, workers } = await setup();
		await launch(harness);
		const unregister = harness.session.registerTurnPolicy({ nextAction: () => ({ type: "stop" }) });
		// The policy stops the turn before it delivers the prompt; the prompt is withdrawn.
		await harness.session.prompt("A host policy forbids this request");
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).not.toContain("A host policy forbids this request");
		workers.get("work")!.resolve();
		await settle(harness);
		expect(harness.faux.state.callCount).toBe(2);
		unregister();
		harness.setResponses([
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).toContain("(job ");
				return fauxAssistantMessage("Explicitly authorized recovery.");
			},
		]);
		await harness.session.prompt("Recover explicitly");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.getLastAssistantText()).toBe("Explicitly authorized recovery.");
	});

	it("disposal interrupts running work and runs no turn for it", async () => {
		const { harness } = await setup();
		const [job] = await launch(harness);
		harness.session.dispose();
		await harness.session.waitForClosed();
		await delay(10);
		expect(harness.faux.state.callCount).toBe(2);
		expect(
			harness.sessionManager.committedEntriesAfter(0).find((entry) => entry.type === "work_finished"),
		).toMatchObject({ workId: job.id, outcome: "interrupted" });
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
		await harness.session.work.waitForIdle();
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
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "unknown", retryable: false, message: "Provider unavailable" },
			}),
		]);
		workers.get("work")!.resolve();
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(3));
		await harness.session.waitForIdle();
		await delay(20);
		expect(harness.faux.state.callCount).toBe(3);
	});
});
