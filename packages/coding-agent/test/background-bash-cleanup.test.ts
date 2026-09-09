import { describe, expect, it, vi } from "vitest";
import { BackgroundJobManager, type BackgroundJobSnapshot } from "../src/core/background-jobs.ts";
import { withBackgroundJobs } from "../src/core/tools/background.ts";
import { createBashTool, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import * as shell from "../src/utils/shell.ts";

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
			const manager = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
			const tool = wrapToolDefinition(withBackgroundJobs(createBashToolDefinition(process.cwd()), { manager }));
			try {
				const result = await tool.execute("bash-cleanup", {
					command: "printf 'ready\\n'; sleep 30",
					background: true,
					...(cause === "timeout" ? { timeout: 1 } : {}),
				});
				const { id } = (result.details as { backgroundJob: BackgroundJobSnapshot }).backgroundJob;
				await vi.waitFor(() => expect(manager.get(id).output).toContain("ready"));
				if (cause === "cancel") manager.cancel(id);
				await barrier.shellStopped.promise;
				expect(manager.hasActive).toBe(true);
				expect(manager.get(id).endedAt).toBeUndefined();
				expect(manager.get(id).status).toBe(cause === "cancel" ? "cancelling" : "running");
				barrier.finishTeardown.resolve();
				const final = await manager.wait(id);
				expect(final.status).toBe(cause === "cancel" ? "cancelled" : "failed");
				expect(final.output).toContain(cause === "cancel" ? "Command aborted" : "timed out");
				expect(manager.hasActive).toBe(false);
			} finally {
				barrier.finishTeardown.resolve();
				await manager.close();
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
		const rejected = expect(execution).rejects.toThrow("Command aborted");
		try {
			await ready.promise;
			controller.abort();
			await barrier.shellStopped.promise;
			// This must resolve before releasing finishTeardown.
			await rejected;
		} finally {
			controller.abort();
			barrier.finishTeardown.resolve();
			await rejected;
			barrier.spy.mockRestore();
		}
	}, 15_000);
});
