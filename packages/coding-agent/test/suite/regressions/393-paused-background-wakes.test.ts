import type { AgentLoopNextActionContext } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_JOB_NOTIFICATION_TYPE } from "../../../src/core/background-jobs.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "../harness.ts";

const harnesses: Harness[] = [];
const finishes: Array<() => void> = [];

async function setup(exitCode = 0, options: HarnessOptions = {}) {
	let finish!: () => void;
	const worker = new Promise<void>((resolve) => {
		finish = resolve;
	});
	finishes.push(finish);
	const operations: BashOperations = {
		exec: async (_command, _cwd, options) => {
			options.signal?.addEventListener("abort", finish, { once: true });
			try {
				await worker;
				if (options.signal?.aborted) throw new Error("Cancelled worker");
				options.onData(Buffer.from("retained untrusted worker output"));
				return { exitCode };
			} finally {
				options.signal?.removeEventListener("abort", finish);
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
		...options,
	});
	harnesses.push(harness);
	harness.session.setSessionName("Paused background wake regression");
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Foreground finished."),
	]);
	await harness.session.prompt("Start independent work");
	const [job] = harness.session.backgroundJobs.list();
	return { harness, job, finish };
}

function hasNotice(context: AgentLoopNextActionContext): boolean {
	return (
		context.defaultAction.type === "request" &&
		(context.defaultAction.deliveries ?? []).some((delivery) =>
			delivery.messages.some(
				(message) => message.role === "custom" && message.customType === BACKGROUND_JOB_NOTIFICATION_TYPE,
			),
		)
	);
}

function notices(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === BACKGROUND_JOB_NOTIFICATION_TYPE,
	);
}

function respondToNotice(harness: Harness, jobId: string) {
	harness.setResponses([
		(context) => {
			const text = context.messages.map(getMessageText).join("\n");
			expect(text).toContain(`${jobId}:`);
			expect(text).toContain("Background job completion notice");
			expect(text).not.toContain("retained untrusted worker output");
			return fauxAssistantMessage("Outcome automatically handled.");
		},
	]);
}

afterEach(async () => {
	for (const harness of harnesses) harness.session.dispose();
	for (const finish of finishes.splice(0)) finish();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("#393 paused background wake authority", () => {
	it.each(
		(["foreground", "idle"] as const).flatMap((boundary) =>
			([0, 1] as const).flatMap((exitCode) =>
				(["during decision", "after settlement"] as const).map((remove) => ({ boundary, exitCode, remove })),
			),
		),
	)("resumes $boundary exit-$exitCode work after policy removal $remove", async ({ boundary, exitCode, remove }) => {
		const { harness, job, finish } = await setup(exitCode);
		let pauses = 0;
		const unregister = harness.session.registerTurnPolicy({
			nextAction: (context) => {
				if (!hasNotice(context)) return undefined;
				pauses++;
				if (remove === "during decision") unregister();
				return { type: "pause" };
			},
		});
		respondToNotice(harness, job.id);
		const expectedCallsBeforeWake = boundary === "foreground" ? 3 : 2;
		if (boundary === "foreground") {
			harness.setResponses([
				async () => {
					finish();
					await harness.session.waitForBackgroundJobs();
					return fauxAssistantMessage(fauxToolCall("jobs", { action: "list" }), { stopReason: "toolUse" });
				},
			]);
			await harness.session.prompt("Continue foreground work");
			respondToNotice(harness, job.id);
		} else {
			finish();
			await harness.session.waitForBackgroundJobs();
		}
		if (remove === "after settlement") {
			await harness.session.waitForIdle();
			expect(pauses).toBe(1);
			expect(notices(harness)).toHaveLength(0);
			expect(harness.faux.state.callCount).toBe(expectedCallsBeforeWake);
			// Worker inspection/change notifications and repeated joins are not readiness signals.
			expect(harness.session.backgroundJobs.get(job.id)).toMatchObject({
				status: exitCode === 0 ? "completed" : "failed",
				output: expect.stringContaining("retained untrusted worker output"),
			});
			await harness.session.waitForIdle();
			expect(pauses).toBe(1);
			unregister();
		}
		await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("Outcome automatically handled."));
		await harness.session.waitForIdle();
		expect(pauses).toBe(1);
		expect(harness.faux.state.callCount).toBe(expectedCallsBeforeWake + 1);
		expect(notices(harness)).toHaveLength(1);
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(
			boundary === "foreground" ? 2 : 1,
		);
	});

	it.each(["cancel", "abort", "stop"] as const)("does not resurrect a paused wake after %s", async (termination) => {
		const { harness, job, finish } = await setup();
		let pauses = 0;
		const unregisterPause = harness.session.registerTurnPolicy({
			nextAction: (context) => {
				if (!hasNotice(context)) return undefined;
				pauses++;
				return { type: "pause" };
			},
		});
		finish();
		await harness.session.waitForBackgroundJobs();
		await harness.session.waitForIdle();
		expect(pauses).toBe(1);
		let unregisterStop: (() => void) | undefined;
		if (termination === "cancel") harness.session.backgroundJobs.cancel(job.id);
		else if (termination === "abort") await harness.session.abort();
		else {
			unregisterStop = harness.session.registerTurnPolicy({ nextAction: () => ({ type: "stop" }) });
			await harness.session.waitForIdle();
		}
		unregisterPause();
		unregisterStop?.();
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
		expect(notices(harness)).toHaveLength(0);
		expect(harness.session.backgroundJobs.get(job.id).output).toContain("retained untrusted worker output");
		respondToNotice(harness, job.id);
		await harness.session.prompt("Explicitly inspect the retained outcome");
		expect(harness.faux.state.callCount).toBe(3);
		expect(notices(harness)).toHaveLength(1);
	});

	it("does not consume notices discarded by a request override", async () => {
		const { harness, job, finish } = await setup();
		const unregister = harness.session.registerTurnPolicy({
			nextAction: (context) => (hasNotice(context) ? { type: "request", reason: "continuation" } : undefined),
		});
		harness.setResponses([
			async () => {
				finish();
				await harness.session.waitForBackgroundJobs();
				return fauxAssistantMessage(fauxToolCall("jobs", { action: "list" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("The policy withheld the notice."),
		]);
		await harness.session.prompt("Continue independent foreground work");
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(4);
		expect(notices(harness)).toHaveLength(0);
		respondToNotice(harness, job.id);
		unregister();
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(5);
		expect(notices(harness)).toHaveLength(1);
	});

	it("defers a failed policy attempt without consuming authority or repeatedly retrying", async () => {
		const { harness, job, finish } = await setup();
		let attempts = 0;
		const unregister = harness.session.registerTurnPolicy({
			nextAction: (context) => {
				if (!hasNotice(context)) return undefined;
				attempts++;
				throw new Error("Controlled policy failure");
			},
		});
		finish();
		await harness.session.waitForBackgroundJobs();
		await harness.session.waitForIdle();
		expect(attempts).toBe(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(notices(harness)).toHaveLength(0);
		respondToNotice(harness, job.id);
		unregister();
		await harness.session.waitForIdle();
		expect(attempts).toBe(1);
		expect(harness.faux.state.callCount).toBe(3);
		expect(notices(harness)).toHaveLength(1);
	});

	it("joins a later wake that settles during an already-reserved automatic run", async () => {
		const { harness, finish } = await setup();
		harness.setResponses([
			async () => {
				const bash = harness.session.state.tools.find((tool) => tool.name === "bash")!;
				await bash.execute("host-sibling", { command: "later work", background: true });
				await harness.session.waitForBackgroundJobs();
				return fauxAssistantMessage("First wake handled.");
			},
			fauxAssistantMessage("Later wake handled."),
		]);
		finish();
		await harness.session.waitForBackgroundJobs();
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.session.getLastAssistantText()).toBe("Later wake handled.");
		expect(notices(harness)).toHaveLength(2);
	});

	it("rechecks preserved wakes after successful compaction", async () => {
		let ready = false;
		const { harness, job, finish } = await setup(0, {
			extensionFactories: [
				(api) => {
					api.on("session_before_compact", (event) => {
						ready = true;
						return {
							compaction: {
								summary: "Background work has finished but its notice is still pending.",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harness.session.registerTurnPolicy({
			nextAction: (context) => (!ready && hasNotice(context) ? { type: "pause" } : undefined),
		});
		finish();
		await harness.session.waitForBackgroundJobs();
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
		respondToNotice(harness, job.id);
		await harness.session.compact();
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(3);
		expect(notices(harness)).toHaveLength(1);
	});
});
