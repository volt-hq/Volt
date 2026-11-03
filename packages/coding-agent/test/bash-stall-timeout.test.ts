/**
 * Stall detection for the bash tool (#125).
 *
 * A wall-clock timeout cannot distinguish a hung command from a slow one, so it
 * has to be set generously and the excess becomes dead wall time. These tests
 * cover the silence-based deadline that replaces that guess.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { withBackgroundJobs } from "../src/core/tools/background.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { type JobStart, type JobSummary, jobOfDetails } from "../src/core/tools/jobs.ts";
import { createTestJobRuntime, type TestJobRuntime } from "./utilities/job-runtime.ts";

const ctx = {} as never;

/** The text of a call's result, which must have failed. */
function failureText(result: { content: ReadonlyArray<{ type: string; text?: string }>; isError?: boolean }): string {
	expect(result.isError).toBe(true);
	return result.content.map((part) => part.text ?? "").join("");
}

describe("bash stall detection", () => {
	test("kills a command that goes silent and explains why", async () => {
		const tool = createBashToolDefinition(process.cwd());
		expect(
			failureText(
				await tool.execute("stall-1", { command: "sleep 30", stallTimeout: 1 }, undefined, undefined, ctx),
			),
		).toMatch(/produced no output for 1 seconds and was killed as hung/);
	}, 15000);

	test("leaves a slow but talking command alone past the stall window", async () => {
		const tool = createBashToolDefinition(process.cwd());
		// ~2s total runtime, but never silent for more than ~0.3s.
		const result = await tool.execute(
			"stall-2",
			{ command: "for i in 1 2 3 4 5 6 7; do echo tick; sleep 0.3; done", stallTimeout: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(JSON.stringify(result)).toContain("tick");
	}, 15000);

	// Paired against the identical command with a live deadline, so this cannot
	// pass merely because the command was short enough to finish.
	test("an explicit stallTimeout of 0 disables the deadline", async () => {
		const tool = createBashToolDefinition(process.cwd());
		// The silence must outrun the 1s deadline by a wide margin: with a thin
		// gap, event-loop starvation from a parallel worker lets `echo` land first
		// and re-arm the timer, failing the kill case spuriously.
		const silent = "sleep 4; echo done";

		expect(
			failureText(await tool.execute("stall-3a", { command: silent, stallTimeout: 1 }, undefined, undefined, ctx)),
		).toMatch(/killed as hung/);

		const result = await tool.execute("stall-3b", { command: silent, stallTimeout: 0 }, undefined, undefined, ctx);
		expect(JSON.stringify(result)).toContain("done");
	}, 20000);

	test("a malformed stallTimeout falls back to the default instead of disabling", async () => {
		const tool = createBashToolDefinition(process.cwd());
		// -1 must not be read as "disable"; with the default deadline in force a
		// 1.5s silent command still completes normally.
		const result = await tool.execute(
			"stall-3c",
			{ command: "sleep 1.5; echo done", stallTimeout: -1 },
			undefined,
			undefined,
			ctx,
		);
		expect(JSON.stringify(result)).toContain("done");
	}, 20000);

	test("a caller abort is reported as an abort, not as a stall", async () => {
		const tool = createBashToolDefinition(process.cwd());
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		expect(
			failureText(
				await tool.execute("stall-4", { command: "sleep 30", stallTimeout: 1 }, controller.signal, undefined, ctx),
			),
		).toMatch(/Command aborted/);
	}, 15000);

	// The opposite ordering: the stall fires first, then the run is torn down
	// before the error surfaces. Reading signal.aborted at catch time would
	// report a plain abort here and hide the hang, so the model would retry it.
	test("reports a stall even when the caller aborts before the error surfaces", async () => {
		const controller = new AbortController();
		const operations: BashOperations = {
			exec: async (_command, _cwd, { signal: execSignal }) => {
				await new Promise<void>((resolve) => {
					execSignal?.addEventListener("abort", () => resolve(), { once: true });
				});
				controller.abort();
				throw new Error("aborted");
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		expect(
			failureText(
				await tool.execute("stall-5", { command: "hang", stallTimeout: 1 }, controller.signal, undefined, ctx),
			),
		).toMatch(/killed as hung/);
	}, 15000);
});

describe("moving a silent foreground command to a background job", () => {
	const runtimes: TestJobRuntime[] = [];
	afterEach(async () => {
		await Promise.all(runtimes.splice(0).map((created) => created.close()));
	});

	/** Bash as a session offers it: foreground calls can move to the runtime's jobs, unless `start` refuses. */
	async function jobCapableBash(start?: (job: JobStart) => Promise<JobSummary>) {
		const created = await createTestJobRuntime();
		runtimes.push(created);
		const tool = withBackgroundJobs(createBashToolDefinition(process.cwd()), {
			start: start ?? ((job) => created.jobs.start(job)),
		});
		return { jobs: created.jobs, tool };
	}

	function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
		return result.content.map((part) => part.text ?? "").join("");
	}

	test("keeps the command running as a job and returns its output so far", async () => {
		const { jobs, tool } = await jobCapableBash();
		const result = await tool.execute(
			"move-1",
			{ command: "printf 'started\\n'; sleep 3; printf 'done\\n'", stallTimeout: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(result.isError).toBeUndefined();
		const job = jobOfDetails(result.details);
		if (!job) throw new Error("Expected the call to name a job");
		expect(job).toMatchObject({ tool: "bash", status: "running", toolCallId: "move-1" });
		expect(text(result)).toContain("started");
		expect(text(result)).toContain(
			`Command produced no output for 1 seconds and is still running as background job ${job.id}.`,
		);
		const [final] = (await jobs.wait([job.id])).results;
		expect(final.status).toBe("completed");
		expect(final.output).toContain("started\ndone");
	}, 20000);

	test("the job, not the call, controls a moved command", async () => {
		const { jobs, tool } = await jobCapableBash();
		const call = new AbortController();
		const result = await tool.execute(
			"move-2",
			{ command: "sleep 2; printf 'survived\\n'; sleep 30", stallTimeout: 1 },
			call.signal,
			undefined,
			ctx,
		);
		const job = jobOfDetails(result.details);
		if (!job) throw new Error("Expected the call to name a job");
		// The call's turn ending no longer stops the command, and silence no longer kills it.
		call.abort();
		await vi.waitFor(() => expect(jobs.get(job.id).output).toContain("survived"), { timeout: 10000 });
		await jobs.cancel(job.id);
		const [final] = (await jobs.wait([job.id])).results;
		expect(final.status).toBe("cancelled");
		expect(final.output).toContain("Command aborted");
	}, 20000);

	test("kills the command as hung when no job can take it", async () => {
		const { jobs, tool } = await jobCapableBash(() =>
			Promise.reject(new Error("Background bash requires both bash and jobs to be active.")),
		);
		expect(
			failureText(await tool.execute("move-3", { command: "sleep 30", stallTimeout: 1 }, undefined, undefined, ctx)),
		).toMatch(/produced no output for 1 seconds and was killed as hung/);
		expect(jobs.list()).toEqual([]);
	}, 15000);

	test("a call that finishes or is aborted before its deadline does not move", async () => {
		const { jobs, tool } = await jobCapableBash();
		const finished = await tool.execute("move-4a", { command: "printf 'quick\\n'" }, undefined, undefined, ctx);
		expect(finished).toEqual({ content: [{ type: "text", text: "quick\n" }] });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		expect(
			failureText(
				await tool.execute("move-4b", { command: "sleep 30", stallTimeout: 5 }, controller.signal, undefined, ctx),
			),
		).toMatch(/Command aborted/);
		expect(jobs.list()).toEqual([]);
	}, 15000);
});

describe("bash timeout normalization", () => {
	function capturingOps(): { ops: BashOperations; seen: Array<number | undefined> } {
		const seen: Array<number | undefined> = [];
		return {
			seen,
			ops: {
				exec: async (_command, _cwd, { timeout }) => {
					seen.push(timeout);
					return { exitCode: 0 };
				},
			},
		};
	}

	test("clamps an over-large wall-clock timeout to the maximum", async () => {
		const { ops, seen } = capturingOps();
		const tool = createBashToolDefinition(process.cwd(), { operations: ops });
		await tool.execute("clamp-1", { command: "true", timeout: 99999 }, undefined, undefined, ctx);
		expect(seen).toEqual([3600]);
	});

	test("passes through an omitted timeout unchanged", async () => {
		const { ops, seen } = capturingOps();
		const tool = createBashToolDefinition(process.cwd(), { operations: ops });
		await tool.execute("clamp-2", { command: "true" }, undefined, undefined, ctx);
		expect(seen).toEqual([undefined]);
	});

	test("drops a non-positive wall-clock timeout instead of arming a zero timer", async () => {
		const { ops, seen } = capturingOps();
		const tool = createBashToolDefinition(process.cwd(), { operations: ops });
		await tool.execute("clamp-3", { command: "true", timeout: 0 }, undefined, undefined, ctx);
		expect(seen).toEqual([undefined]);
	});
});
