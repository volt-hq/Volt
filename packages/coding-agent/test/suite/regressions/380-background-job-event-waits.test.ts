import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import * as toolProgressCapture from "../../../src/core/tool-progress-capture.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import {
	createJobsToolDefinition,
	type JobRuntime,
	type JobSnapshot,
	type JobSummary,
	type JobToolName,
	jobWaitResult,
} from "../../../src/core/tools/jobs.ts";
import { BackgroundJobsStatus } from "../../../src/modes/interactive/components/background-jobs.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createTestJobRuntime, type TestJobRuntime } from "../../utilities/job-runtime.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const runtimes: TestJobRuntime[] = [];
const harnesses: Harness[] = [];
const finishes: Array<() => void> = [];
const completed: AgentToolResult<unknown> = { content: [{ type: "text", text: "done" }] };

/** The jobs of a conversation kernel with no model: notices queue, and no turn runs. */
async function jobRuntime(): Promise<TestJobRuntime> {
	const runtime = await createTestJobRuntime();
	runtimes.push(runtime);
	return runtime;
}

async function controlledJob(jobs: JobRuntime, tool: JobToolName = "bash", toolCallId = "launch") {
	const finish = deferred();
	finishes.push(finish.resolve);
	let signal: AbortSignal | undefined;
	const job = await jobs.start({
		tool,
		toolCallId,
		label: "worker",
		run: async (value) => {
			signal = value;
			await finish.promise;
			return completed;
		},
	});
	return {
		job,
		finish,
		get signal() {
			return signal;
		},
	};
}

afterEach(async () => {
	for (const finish of finishes.splice(0)) finish();
	vi.useRealTimers();
	for (const runtime of runtimes.splice(0)) await runtime.close();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("event-driven job waits", () => {
	it.each(["bash", "subagent"] as const)(
		"waits ten minutes without a timer for %s; any/all preserve unfinished workers",
		async (tool) => {
			const { jobs, work } = await jobRuntime();
			const first = await controlledJob(jobs, tool, "first");
			const second = await controlledJob(jobs, tool, "second");
			vi.useFakeTimers();
			const resolved = vi.fn();
			const any = jobs.wait([first.job.id, second.job.id]).then((result) => {
				resolved();
				return result;
			});
			const all = jobs.wait([first.job.id, second.job.id], { mode: "all" });
			await vi.advanceTimersByTimeAsync(600000);
			expect(resolved).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			vi.useRealTimers();
			first.finish.resolve();
			expect(await any).toMatchObject({
				reason: "terminal",
				results: [{ id: first.job.id, tool, status: "completed", output: "done" }],
				pending: [{ id: second.job.id }],
			});
			expect(second.signal?.aborted).toBe(false);
			expect(jobs.listWaits()).toHaveLength(1);
			second.finish.resolve();
			expect((await all).results).toHaveLength(2);
			expect(jobs.listWaits()).toEqual([]);
			await work.waitForIdle();
			// Both results reached their waits: neither queued a notice.
			expect(work.list().map((record) => record.outcome)).toEqual(["completed", "completed"]);
		},
	);

	it("batches simultaneous completion and returns metadata-only pending jobs on deadlines and steering", async () => {
		const { jobs } = await jobRuntime();
		const first = await controlledJob(jobs, "bash", "first");
		const second = await controlledJob(jobs, "bash", "second");
		const timed = await jobs.wait([first.job.id, second.job.id], { timeoutMs: 0 });
		expect(timed.reason).toBe("timeout");
		expect(timed.pending).toHaveLength(2);
		expect(timed.pending[0]).not.toHaveProperty("output");
		jobs.setSteering(true);
		expect((await jobs.wait([first.job.id])).reason).toBe("steered");
		jobs.setSteering(false);
		const waiting = jobs.wait([first.job.id, second.job.id]);
		first.finish.resolve();
		second.finish.resolve();
		expect((await waiting).results.length).toBeGreaterThan(0);
		expect((await jobs.wait([first.job.id, second.job.id], { mode: "all" })).results).toHaveLength(2);
		expect((await jobs.wait([first.job.id])).reason).toBe("terminal");
	});

	it("returns partial all results at an explicit deadline without copying running output", async () => {
		const { jobs } = await jobRuntime();
		const first = await controlledJob(jobs, "bash", "first");
		const second = await controlledJob(jobs, "bash", "second");
		first.finish.resolve();
		await jobs.wait([first.job.id]);
		const result = await jobs.wait([first.job.id, second.job.id], { mode: "all", timeoutMs: 0 });
		expect(result).toMatchObject({
			reason: "timeout",
			results: [{ id: first.job.id }],
			pending: [{ id: second.job.id }],
		});
		expect(result.pending[0]).not.toHaveProperty("output");
		expect(jobWaitResult(result).details.wait.results).toHaveLength(1);
	});

	it("ends a wait on abort without cancelling its jobs, and refuses unknown jobs", async () => {
		const { jobs } = await jobRuntime();
		const job = await controlledJob(jobs);
		const controller = new AbortController();
		const waiting = jobs.wait([job.job.id], { signal: controller.signal, timeoutMs: 300000 });
		const rejected = expect(waiting).rejects.toThrow("aborted");
		controller.abort();
		await rejected;
		expect(jobs.listWaits()).toEqual([]);
		expect(job.signal?.aborted).toBe(false);
		await expect(jobs.wait(["missing"])).rejects.toThrow("Unknown background job");
		await expect(jobs.wait([job.job.id, job.job.id])).rejects.toThrow("unique");
		expect(jobs.listWaits()).toEqual([]);
	});

	it("bounds a multi-result envelope and keeps the original output", async () => {
		const output = "😀".repeat(20000) + "\nline".repeat(3000);
		const results: JobSnapshot[] = Array.from({ length: 64 }, (_, index) => ({
			id: `job_${index}`,
			toolCallId: `launch_${index}`,
			tool: "bash",
			label: "not repeated",
			status: index === 0 ? "failed" : "completed",
			startedAt: 1,
			endedAt: 2,
			output,
			outputTruncated: false,
		}));
		const envelope = jobWaitResult({
			id: "wait_test",
			ids: results.map((job) => job.id),
			mode: "all",
			reason: "terminal",
			startedAt: 1,
			endedAt: 2,
			results,
			pending: [],
		});
		const text = envelope.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
		expect(text.split("\n").length).toBeLessThanOrEqual(2000);
		expect(text).not.toContain("�");
		expect(text.match(/\[Output truncated; use jobs read for the retained output\.\]/g)).toHaveLength(64);
		expect(envelope.isError).toBe(true);
		expect(envelope.details.wait.results).toHaveLength(64);
		// Details carry metadata only; the output reaches the model once, in the text.
		expect(JSON.stringify(envelope.details)).not.toContain("😀");
		expect(results[0].output).toBe(output);
	});
});

async function setup(diagnostics = false, extra: HarnessOptions = {}) {
	vi.stubEnv("VOLT_BACKGROUND_JOB_DIAGNOSTICS", diagnostics ? "1" : "0");
	const finish = deferred();
	finishes.push(finish.resolve);
	const operations: BashOperations = {
		exec: async (command, _cwd, options) => {
			options.onData(Buffer.from("private worker output"));
			options.signal?.addEventListener("abort", finish.resolve, { once: true });
			await finish.promise;
			return { exitCode: command.includes("fail") ? 1 : 0 };
		},
	};
	const original = nativeTools.createAllToolDefinitions;
	vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
		original(cwd, { ...options, bash: { ...options?.bash, operations } }),
	);
	const harness = await createHarness({
		initialActiveToolNames: ["bash", "jobs"],
		settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
		...extra,
	});
	harnesses.push(harness);
	await harness.session.setSessionName("Wait regression");
	const started = deferred();
	const unsubscribe = harness.session.jobs.subscribe(() => {
		if (harness.session.jobs.listWaits().length) started.resolve();
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "private command", background: true }), {
			stopReason: "toolUse",
		}),
		() =>
			fauxAssistantMessage(fauxToolCall("jobs", { action: "wait", ids: [harness.session.jobs.list()[0].id] }), {
				stopReason: "toolUse",
			}),
		fauxAssistantMessage("Result received"),
		fauxAssistantMessage("Follow-up received"),
	]);
	return { harness, finish, started, unsubscribe, operations };
}

function waitDetails(harness: Harness): { reason?: unknown } | undefined {
	const result = harness.session.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "jobs",
	);
	return result?.role === "toolResult" ? (result.details as { wait?: { reason?: unknown } }).wait : undefined;
}

describe("multi-job presentation and delivery", () => {
	it.each([32, 100])("renders a live any/all wait and its mixed results at width %s", async (width) => {
		initTheme("dark");
		const { jobs } = await jobRuntime();
		const first = await controlledJob(jobs, "bash", "first");
		const second = await controlledJob(jobs, "bash", "second");
		const ids = [first.job.id, second.job.id];
		const definition = createJobsToolDefinition({ jobs });
		const card = new ToolExecutionComponent(
			"jobs",
			"wait-call",
			{ action: "wait", ids, mode: "all" },
			{},
			definition,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		const waiting = jobs.wait(ids, { mode: "all", toolCallId: "wait-call" });
		try {
			card.markExecutionStarted();
			const dock = new BackgroundJobsStatus(() => jobs);
			const frames = [card.render(width), dock.render(width)];
			expect(frames[0].lines.map(stripAnsi).join(" ")).toContain("Waiting for background jobs");
			expect(frames[1].lines.map(stripAnsi).join(" ")).toContain("waiting (all)");
			for (const frame of frames)
				for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			first.finish.resolve();
			second.finish.resolve();
			const result = jobWaitResult(await waiting);
			card.updateResult({ ...result, isError: false });
			expect(card.render(100).lines.map(stripAnsi).join(" ")).toContain("jobs wait (all) · 2 completed");
		} finally {
			card.dispose();
		}
	});

	it("returns jobs that finish into a multi-job wait without notices", async () => {
		const { harness, finish, started, unsubscribe } = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "pass", background: true }),
					fauxToolCall("bash", { command: "fail", background: true }),
				],
				{ stopReason: "toolUse" },
			),
			() =>
				fauxAssistantMessage(
					fauxToolCall("jobs", {
						action: "wait",
						ids: harness.session.jobs.list().map((job: JobSummary) => job.id),
						mode: "all",
					}),
					{ stopReason: "toolUse" },
				),
			(context) => {
				const result = context.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "jobs",
				);
				expect(getMessageText(result)).toContain("private worker output");
				return fauxAssistantMessage("Received");
			},
		]);
		const prompting = harness.session.prompt("Collect the jobs");
		await started.promise;
		finish.resolve();
		await prompting;
		await harness.session.waitForIdle();
		expect(
			harness.session.jobs
				.list()
				.map((job) => job.status)
				.sort(),
		).toEqual(["completed", "failed"]);
		expect(harness.session.messages.filter((message) => message.role === "custom")).toEqual([]);
		expect(harness.faux.state.callCount).toBe(3);
		unsubscribe();
	});
});

describe("active-run waiting", () => {
	it.each([false, true])("makes no parent requests during ten minutes with diagnostics=%s", async (diagnostics) => {
		// Keep wait/metadata assertions independent of Windows PowerShell startup.
		// The real private sink is covered in background-job-diagnostics.test.ts.
		const batches: string[] = [];
		vi.spyOn(toolProgressCapture, "writeToolProgressCapture").mockImplementation(async (_path, content) => {
			batches.push(content);
		});
		const { harness, finish, started, unsubscribe } = await setup(diagnostics);
		const prompting = harness.session.prompt("Wait for the worker");
		await started.promise;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const calls = harness.faux.state.callCount;
		await vi.advanceTimersByTimeAsync(600000);
		expect(harness.faux.state.callCount).toBe(calls);
		expect(harness.session.isStreaming).toBe(true);
		vi.useRealTimers();
		finish.resolve();
		await prompting;
		expect(harness.faux.state.callCount).toBe(calls + 1);
		expect(harness.session.getLastAssistantText()).toBe("Result received");
		expect(harness.session.jobs.listWaits()).toEqual([]);
		unsubscribe();
		harness.session.dispose();
		await harness.session.waitForClosed();
		if (diagnostics) {
			const text = batches.join("\n");
			expect(text).not.toContain("private command");
			expect(text).not.toContain("private worker output");
			const records = text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { kind: string });
			expect(records.filter((record) => record.kind === "request_start")).toHaveLength(3);
			expect(records.filter((record) => record.kind === "wait_end")).toHaveLength(1);
		} else {
			expect(batches).toEqual([]);
		}
	});

	it.each([false, true])(
		"interrupts on admitted steering (prequeued=%s) without cancelling work",
		async (prequeued) => {
			const { harness, finish, started, unsubscribe } = await setup();
			if (prequeued)
				harness.session.registerTurnPolicy({
					beforeToolCall: async (event) => {
						if (event.toolName === "jobs") await harness.session.steer("Change the priority");
					},
				});
			const prompting = harness.session.prompt("Start work");
			await started.promise;
			if (!prequeued) await harness.session.steer("Change the priority");
			await prompting;
			expect(harness.session.hasRunningWork).toBe(true);
			expect(waitDetails(harness)?.reason).toBe("steered");
			expect(harness.faux.state.callCount).toBe(3);
			// The job's notice wakes the idle conversation once it completes.
			finish.resolve();
			await harness.session.work.waitForIdle();
			await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("Follow-up received"));
			await harness.session.waitForIdle();
			expect(harness.faux.state.callCount).toBe(4);
			unsubscribe();
		},
	);

	it("interrupts the wait without cancelling or bypassing a sibling foreground tool", async () => {
		const { harness, started, finish, unsubscribe, operations } = await setup();
		const foreground = deferred();
		const foregroundStarted = deferred();
		finishes.push(foreground.resolve);
		let foregroundSignal: AbortSignal | undefined;
		const exec = operations.exec;
		operations.exec = async (command, cwd, options) => {
			if (command !== "foreground") return exec(command, cwd, options);
			foregroundSignal = options.signal;
			foregroundStarted.resolve();
			await foreground.promise;
			return { exitCode: 0 };
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "background", background: true }), {
				stopReason: "toolUse",
			}),
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("jobs", { action: "wait", ids: [harness.session.jobs.list()[0].id] }),
						fauxToolCall("bash", { command: "foreground" }),
					],
					{ stopReason: "toolUse" },
				),
			fauxAssistantMessage("Steering after the batch"),
			fauxAssistantMessage("Noticed the job."),
		]);
		const prompting = harness.session.prompt("Run independent tools");
		await started.promise;
		await foregroundStarted.promise;
		const waitFinished = deferred();
		const stopWatching = harness.session.jobs.subscribe(() => {
			if (!harness.session.jobs.listWaits().length) waitFinished.resolve();
		});
		await harness.session.steer("Change priority");
		await waitFinished.promise;
		expect(foregroundSignal?.aborted).toBe(false);
		expect(harness.faux.state.callCount).toBe(2);
		foreground.resolve();
		await prompting;
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.hasRunningWork).toBe(true);
		finish.resolve();
		await harness.session.work.waitForIdle();
		await harness.session.waitForIdle();
		stopWatching();
		unsubscribe();
	});

	it("keeps follow-ups queued and does not restart after abort", async () => {
		const { harness, started, unsubscribe } = await setup();
		const prompting = harness.session.prompt("Start work");
		await started.promise;
		await harness.session.followUp("Later");
		expect(harness.session.jobs.listWaits()).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
		await harness.session.abort();
		await prompting;
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.jobs.listWaits()).toEqual([]);
		expect(harness.session.jobs.list()).toMatchObject([{ status: "cancelled" }]);
		unsubscribe();
	});
});
