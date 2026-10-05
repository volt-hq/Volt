import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { withBackgroundJobs } from "../src/core/tools/background.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import {
	createJobsTool,
	JOB_LIST_MAX,
	JOB_MAX_ACTIVE,
	JOB_OUTPUT_MAX_BYTES,
	type JobRuntime,
	type JobStart,
	type JobSummary,
	jobOfDetails,
} from "../src/core/tools/jobs.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { createTestJobRuntime, type TestJobRuntime } from "./utilities/job-runtime.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function summary(result: AgentToolResult<unknown>): JobSummary {
	const job = jobOfDetails(result.details);
	if (!job) throw new Error("Expected a background job result");
	return job;
}

const completed: AgentToolResult<unknown> = { content: [{ type: "text", text: "finished" }] };
const runtimes: TestJobRuntime[] = [];

async function runtime(): Promise<TestJobRuntime> {
	const created = await createTestJobRuntime();
	runtimes.push(created);
	return created;
}

function start(jobs: JobRuntime, run: JobStart["run"], label = "work", toolCallId = "call"): Promise<JobSummary> {
	return jobs.start({ tool: "bash", toolCallId, label, run });
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(runtimes.splice(0).map((created) => created.close()));
});

describe("JobRuntime", () => {
	it("returns a running job before execution settles, keeps its output non-destructively, and records its result", async () => {
		const { jobs, work } = await runtime();
		const done = deferred();
		let update!: (partial: AgentToolResult<unknown>) => void;
		const job = await start(jobs, async (_signal, onUpdate) => {
			update = onUpdate;
			onUpdate({ content: [{ type: "text", text: "working" }] });
			await done.promise;
			return completed;
		});
		expect(job).toMatchObject({ status: "running", tool: "bash", toolCallId: "call", label: "work" });
		await vi.waitFor(() => expect(jobs.get(job.id).output).toBe("working"));
		const snapshot = jobs.get(job.id);
		(snapshot as { output: string }).output = "changed by caller";
		expect(jobs.get(job.id).output).toBe("working");
		done.resolve();
		expect((await jobs.wait([job.id])).results[0]).toMatchObject({ status: "completed", output: "finished" });
		update({ content: [{ type: "text", text: "late output" }] });
		expect(jobs.get(job.id).output).toBe("finished");
		// The result is the job's work record: the log keeps it.
		expect(work.get(job.id)).toMatchObject({
			kind: "job",
			outcome: "completed",
			input: { tool: "bash" },
			result: { output: { text: "finished", truncated: false } },
		});
	});

	it("distinguishes a cancellation request from settled cancellation", async () => {
		const { jobs } = await runtime();
		const finish = deferred();
		let signal!: AbortSignal;
		const job = await start(jobs, async (value) => {
			signal = value;
			await finish.promise;
			return completed;
		});
		await vi.waitFor(() => expect(signal).toBeDefined());
		expect((await jobs.cancel(job.id)).status).toBe("cancelling");
		expect(signal.aborted).toBe(true);
		expect((await jobs.wait([job.id], { timeoutMs: 0 })).pending[0].status).toBe("cancelling");
		finish.resolve();
		expect((await jobs.wait([job.id])).results[0].status).toBe("cancelled");
		// Cancelling a finished job reports it.
		expect((await jobs.cancel(job.id)).status).toBe("cancelled");
	});

	it("bounds waiting, and aborting a wait does not cancel the job", async () => {
		const { jobs } = await runtime();
		const finish = deferred();
		const job = await start(jobs, async () => {
			await finish.promise;
			return completed;
		});
		vi.useFakeTimers();
		const waiting = jobs.wait([job.id], { timeoutMs: 10 });
		await vi.advanceTimersByTimeAsync(10);
		const timedOut = await waiting;
		expect(timedOut).toMatchObject({ reason: "timeout", results: [], pending: [{ id: job.id, status: "running" }] });
		expect(timedOut.pending[0]).not.toHaveProperty("output");
		const controller = new AbortController();
		const abortedWait = jobs.wait([job.id], { timeoutMs: 30_000, signal: controller.signal });
		const rejected = expect(abortedWait).rejects.toThrow("Job wait aborted");
		controller.abort();
		await rejected;
		expect(jobs.get(job.id).status).toBe("running");
		expect(vi.getTimerCount()).toBe(0);
		vi.useRealTimers();
		finish.resolve();
		await jobs.wait([job.id]);
	});

	it.each([-1, 300_001, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
		"rejects invalid wait duration %s",
		async (timeout) => {
			const { jobs } = await runtime();
			const job = await start(jobs, async () => completed);
			await expect(jobs.wait([job.id], { timeoutMs: timeout })).rejects.toThrow("timeoutMs");
		},
	);

	it("bounds running jobs and lists the newest", async () => {
		const { jobs } = await runtime();
		const finish = deferred();
		const active: JobSummary[] = [];
		for (let index = 0; index < JOB_MAX_ACTIVE; index++) {
			active.push(
				await start(
					jobs,
					async () => {
						await finish.promise;
						return completed;
					},
					"pending",
					String(index),
				),
			);
		}
		await expect(start(jobs, async () => completed, "excess", "overflow")).rejects.toThrow("At most");
		finish.resolve();
		await jobs.wait(
			active.map((job) => job.id),
			{ mode: "all" },
		);
		for (let index = 0; index < JOB_LIST_MAX; index++) {
			const job = await start(jobs, async () => completed, "x".repeat(500), `finished-${index}`);
			await jobs.wait([job.id]);
		}
		const listed = jobs.list();
		expect(listed).toHaveLength(JOB_LIST_MAX);
		expect(listed[0].toolCallId).toBe(`finished-${JOB_LIST_MAX - 1}`);
		expect(listed[0].label).toHaveLength(200);
		// Older jobs leave the list, but stay readable by id.
		expect(jobs.get(active[0].id).status).toBe("completed");
	});

	it.each(["x", "é", "€", "😀"])("retains a partial %s line before trailing status text", async (character) => {
		const { jobs } = await runtime();
		const suffix = "\nstatus";
		const output = character.repeat(JOB_OUTPUT_MAX_BYTES) + suffix;
		const job = await start(jobs, async () => ({ content: [{ type: "text", text: output }] }));
		const result = (await jobs.wait([job.id])).results[0];
		const retainedCharacters = Math.floor(
			(JOB_OUTPUT_MAX_BYTES - Buffer.byteLength(suffix)) / Buffer.byteLength(character),
		);
		expect(result.output).toBe(character.repeat(retainedCharacters) + suffix);
		expect(result.outputTruncated).toBe(true);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(JOB_OUTPUT_MAX_BYTES);
	});

	it("bounds multibyte and multiline output", async () => {
		const { jobs } = await runtime();
		for (const output of [
			"😀".repeat(30_000),
			"line\n".repeat(3000),
			`${"x".repeat(JOB_OUTPUT_MAX_BYTES)}\n${"line\n".repeat(3000)}`,
		]) {
			const job = await start(jobs, async () => ({ content: [{ type: "text", text: output }] }));
			const result = (await jobs.wait([job.id])).results[0];
			expect(result.outputTruncated).toBe(true);
			expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(JOB_OUTPUT_MAX_BYTES);
			expect(result.output).not.toContain("�");
			expect(result.output.split("\n").length).toBeLessThanOrEqual(2000);
		}
	});

	it.each([
		[undefined, false],
		[null, false],
		["unrelated metadata", false],
		[[], false],
		[{ truncation: null }, false],
		[{ truncation: [] }, false],
		[{ truncation: { truncated: false } }, false],
		[{ truncation: { truncated: "true" } }, false],
		[{ truncation: { truncated: true } }, true],
	] as const)("reads upstream truncation only from an explicit boolean flag: %j", async (details, truncated) => {
		const { jobs } = await runtime();
		const job = await start(jobs, async () => ({
			content: [{ type: "text", text: "retained output" }],
			...(details === undefined ? {} : { details }),
		}));
		expect((await jobs.wait([job.id])).results[0]).toMatchObject({
			status: "completed",
			output: "retained output",
			outputTruncated: truncated,
		});
	});

	it("notifies truncation-only changes without changing output time", async () => {
		const { jobs } = await runtime();
		const finish = deferred();
		const result: AgentToolResult<unknown> = { content: [{ type: "text", text: "retained output" }] };
		let update!: (partial: AgentToolResult<unknown>) => void;
		const job = await start(jobs, async (_signal, onUpdate) => {
			update = onUpdate;
			onUpdate(result);
			await finish.promise;
			return result;
		});
		try {
			await vi.waitFor(() => expect(jobs.get(job.id)).toMatchObject({ outputTruncated: false }));
			const lastOutputAt = jobs.get(job.id).lastOutputAt;
			expect(lastOutputAt).toBeDefined();
			const observer = vi.fn();
			jobs.subscribe(observer);
			update({ ...result, details: { truncation: { truncated: true } } });
			expect(jobs.get(job.id)).toMatchObject({ outputTruncated: true, lastOutputAt });
			expect(observer).toHaveBeenCalledTimes(1);
			update({ ...result, details: { truncation: { truncated: true } } });
			expect(observer).toHaveBeenCalledTimes(1);
			update({ ...result, details: { truncation: { truncated: false } } });
			expect(jobs.get(job.id).outputTruncated).toBe(false);
			expect(observer).toHaveBeenCalledTimes(2);
		} finally {
			finish.resolve();
			await jobs.wait([job.id]);
		}
		expect(jobs.get(job.id)).toMatchObject({
			status: "completed",
			output: "retained output",
			outputTruncated: false,
		});
	});

	it("contains invalid progress, aborts the worker, and does not retain late output", async () => {
		const { jobs } = await runtime();
		let executionSignal!: AbortSignal;
		const job = await start(jobs, async (signal, update) => {
			executionSignal = signal;
			update({ content: [], details: { bad: Number.NaN } });
			update({ content: [{ type: "text", text: "must not appear" }] });
			return completed;
		});
		const result = (await jobs.wait([job.id])).results[0];
		expect(executionSignal.aborted).toBe(true);
		expect(result.status).toBe("failed");
		expect(result.output).toMatch(/finite/);
		expect(result.output).not.toContain("must not appear");
	});

	it("contains errors and structured failures without exposing prior progress on finalization failure", async () => {
		const { jobs } = await runtime();
		const throwing = await start(jobs, async (_signal, update) => {
			update({ content: [{ type: "text", text: "pre-policy secret" }] });
			throw new Error("Result policy rejected output");
		});
		expect((await jobs.wait([throwing.id])).results[0]).toMatchObject({
			status: "failed",
			output: "Result policy rejected output",
		});
		const failed = await start(jobs, async () => ({ ...completed, isError: true }), "failure", "call2");
		expect((await jobs.wait([failed.id])).results[0].status).toBe("failed");
		await expect(jobs.wait(["unknown"])).rejects.toThrow("Unknown background job");
	});
});

describe("background tool interface", () => {
	it("collects a real native Bash process through the background interface", async () => {
		const { jobs } = await runtime();
		const tool = wrapToolDefinition(
			withBackgroundJobs(createBashToolDefinition(process.cwd()), { start: (job) => jobs.start(job) }),
		);
		const job = summary(
			await tool.execute("shell-smoke", { command: "printf 'background smoke\\n'", background: true }),
		);
		expect((await jobs.wait([job.id])).results[0]).toMatchObject({
			status: "completed",
			output: "background smoke\n",
		});
	});

	const schema = Type.Object({ command: Type.String() });
	it("preserves foreground execution and returns a background handle without native result details", async () => {
		const { jobs } = await runtime();
		const finish = deferred();
		const definition: ToolDefinition<typeof schema, { marker: string }, object> = {
			name: "bash",
			label: "bash",
			description: "Test Bash",
			parameters: schema,
			execute: async (_id, _input, _signal, update) => {
				update?.({ content: [], details: { marker: "progress" } });
				await finish.promise;
				return { content: [{ type: "text", text: "done" }], details: { marker: "done" } };
			},
		};
		const tool = wrapToolDefinition(withBackgroundJobs(definition, { start: (job) => jobs.start(job) }));
		const result = await tool.execute("call", { command: "work", background: true });
		const job = summary(result);
		expect(job.status).toBe("running");
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining(job.id) });
		expect(result.details).toEqual({ job });
		finish.resolve();
		expect((await jobs.wait([job.id])).results[0].output).toBe("done");
		expect(await tool.execute("foreground", { command: "work" })).toMatchObject({ details: { marker: "done" } });
	});

	it("keeps subagent preflight direct, preserves failure status, and finalizes actual completion once", async () => {
		const { jobs } = await runtime();
		const finalize = vi.fn(async (_name, _id, _input, result: AgentToolResult<unknown>) => result);
		const definition = {
			name: "subagent",
			label: "subagent",
			description: "Subagents",
			parameters: Type.Object({ agent: Type.String(), confirm: Type.Optional(Type.String()) }),
			execute: async (_id: string, params: { agent: string; confirm?: string }) => ({
				content: [{ type: "text" as const, text: params.confirm ? "child failed" : "confirm token" }],
				details: { status: params.confirm ? "failed" : "running" },
			}),
		};
		const tool = wrapToolDefinition(withBackgroundJobs(definition, { start: (job) => jobs.start(job), finalize }));
		expect(await tool.execute("preflight", { agent: "general", background: true })).toMatchObject({
			content: [{ text: "confirm token" }],
		});
		expect(jobs.list()).toHaveLength(0);
		expect(finalize).not.toHaveBeenCalled();
		const job = summary(await tool.execute("confirmed", { agent: "general", confirm: "token", background: true }));
		expect(job.tool).toBe("subagent");
		expect((await jobs.wait([job.id])).results[0].status).toBe("failed");
		expect(finalize).toHaveBeenCalledTimes(1);
	});

	it("exposes bounded job control results and rejects ambiguous actions", async () => {
		const { jobs } = await runtime();
		const tool = createJobsTool({ jobs });
		const job = await start(jobs, async () => completed);
		const waited = await tool.execute("wait", { action: "wait", ids: [job.id] });
		expect(waited.details).toMatchObject({ wait: { results: [{ id: job.id, status: "completed" }] } });
		const read = await tool.execute("read", { action: "read", id: job.id });
		expect(summary(read).status).toBe("completed");
		expect(read.content[0]).toMatchObject({ text: expect.stringContaining("finished") });
		expect(await tool.execute("list", { action: "list" })).toMatchObject({ details: { jobs: [{ id: job.id }] } });
		await expect(tool.execute("bad", { action: "read" })).rejects.toThrow("id is required");
		await expect(tool.execute("bad", { action: "list", id: job.id })).rejects.toThrow("does not accept");
		await expect(tool.execute("bad", { action: "read", id: job.id, timeoutMs: 1 })).rejects.toThrow("wait");
		await expect(createJobsTool().execute("bad", { action: "list" })).rejects.toThrow("conversation");
	});
});
