import { describe, expect, it, vi } from "vitest";
import { withBackgroundJobs } from "../src/core/tools/background.ts";
import { createBashTool, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { type JobSummary, jobOfDetails } from "../src/core/tools/jobs.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import * as shell from "../src/utils/shell.ts";
import { createTestJobRuntime } from "./utilities/job-runtime.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function holdTeardownCompletion() {
	const shellStopped = deferred();
	const finishTeardown = deferred();
	const terminate = shell.terminateProcessTree;
	const spy = vi.spyOn(shell, "terminateProcessTree").mockImplementation(async (...args) => {
		await terminate(...args);
		shellStopped.resolve();
		// The shell has exited, but the cleanup owner has not released its receipt.
		await finishTeardown.promise;
	});
	return { shellStopped, finishTeardown, spy };
}

describe("background native Bash cleanup", () => {
	it.each(["cancel", "timeout"] as const)(
		"holds job ownership until process-tree teardown settles after %s",
		async (cause) => {
			const barrier = holdTeardownCompletion();
			const { jobs, work, close } = await createTestJobRuntime();
			const tool = wrapToolDefinition(
				withBackgroundJobs(createBashToolDefinition(process.cwd()), { start: (job) => jobs.start(job) }),
			);
			try {
				const result = await tool.execute("bash-cleanup", {
					command: "printf 'ready\\n'; sleep 30",
					background: true,
					...(cause === "timeout" ? { timeout: 1 } : {}),
				});
				const { id } = jobOfDetails(result.details) as JobSummary;
				await vi.waitFor(() => expect(jobs.get(id).output).toContain("ready"));
				if (cause === "cancel") await jobs.cancel(id);
				await barrier.shellStopped.promise;
				expect(jobs.hasRunning).toBe(true);
				expect(jobs.get(id).status).toBe(cause === "cancel" ? "cancelling" : "running");
				barrier.finishTeardown.resolve();
				const final = (await jobs.wait([id])).results[0];
				expect(final.status).toBe(cause === "cancel" ? "cancelled" : "failed");
				expect(final.output).toContain(cause === "cancel" ? "Command aborted" : "timed out");
				await work.waitForIdle();
				expect(jobs.hasRunning).toBe(false);
			} finally {
				barrier.finishTeardown.resolve();
				await close();
				barrier.spy.mockRestore();
			}
		},
		15_000,
	);

	it("preserves fast foreground cancellation before teardown completion", async () => {
		const barrier = holdTeardownCompletion();
		const controller = new AbortController();
		const ready = deferred();
		const execution = createBashTool(process.cwd()).execute(
			"foreground-cleanup",
			{ command: "printf 'ready\\n'; sleep 30" },
			controller.signal,
			(update) => {
				if (update.content.some((part) => part.type === "text" && part.text.includes("ready"))) ready.resolve();
			},
		);
		const aborted = expect(execution).resolves.toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("Command aborted") }],
		});
		try {
			await ready.promise;
			controller.abort();
			await barrier.shellStopped.promise;
			// This must resolve before releasing finishTeardown.
			await aborted;
		} finally {
			controller.abort();
			barrier.finishTeardown.resolve();
			await aborted;
			barrier.spy.mockRestore();
		}
	}, 15_000);
});
