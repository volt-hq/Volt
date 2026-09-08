import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestBodyOwner } from "../../test-body-owner.ts";
import { createHarness } from "../harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

afterEach(() => vi.useRealTimers());

describe("#363 timed-out test fixture ownership", () => {
	it("waits for the whole cancelled body before restoring mocks and removing fixtures", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("Fixture ready.")]);
		const owner = createTestBodyOwner();
		owner.start();
		const timeout = new AbortController();
		const operationFinished = gate();
		const cancellationObserved = gate();
		const continuation = gate();
		const events: string[] = [];
		const fixturePath = join(harness.tempDir, "continuation.txt");
		const observer = { record: (_message: string) => {} };
		const record = vi.spyOn(observer, "record");
		let callsBeforeCleanup: Array<[string]> = [];
		const cleanup = vi.fn(async () => {
			events.push("cleanup");
			callsBeforeCleanup = [...record.mock.calls];
			record.mockRestore();
			await harness.cleanupAsync();
		});
		const body = owner.run(timeout.signal, async (signal) => {
			await harness.session.prompt("Prepare the test fixture.");
			operationFinished.release();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			events.push("cancelled");
			cancellationObserved.release();
			await continuation.promise;
			// This represents a post-operation continuation that timeout cannot stop.
			observer.record("late continuation");
			writeFileSync(fixturePath, "settled");
			events.push("body settled");
		});
		try {
			await Promise.race([operationFinished.promise, body]);
			timeout.abort(new Error("Simulated Vitest timeout"));
			const finished = owner.finish(cleanup);
			await cancellationObserved.promise;
			expect(cleanup).not.toHaveBeenCalled();
			expect(existsSync(harness.tempDir)).toBe(true);
			expect(() => owner.start()).toThrow("Previous test body or fixture cleanup is still active");
			continuation.release();
			await body;
			await finished;
			expect(callsBeforeCleanup).toEqual([["late continuation"]]);
			expect(events).toEqual(["cancelled", "body settled", "cleanup"]);
			expect(cleanup).toHaveBeenCalledTimes(1);
			expect(existsSync(harness.tempDir)).toBe(false);
		} finally {
			timeout.abort();
			continuation.release();
			await owner.finish(cleanup);
		}
	});

	it.each(["body", "cleanup"] as const)(
		"fails a stuck %s drain within its deadline and blocks new tests until it settles",
		async (phase) => {
			vi.useFakeTimers();
			const owner = createTestBodyOwner(100);
			owner.start();
			const pending = gate();
			const started = gate();
			const body = owner.run(new AbortController().signal, async () => {
				if (phase === "body") {
					started.release();
					await pending.promise;
				}
			});
			const cleanup = vi.fn(async () => {
				if (phase === "cleanup") {
					started.release();
					await pending.promise;
				}
			});
			if (phase === "body") await started.promise;
			else await body;
			const draining = owner.finish(cleanup);
			const deadline = expect(draining).rejects.toThrow("did not settle within 100ms");
			try {
				await started.promise;
				await vi.advanceTimersByTimeAsync(100);
				await deadline;
				expect(() => owner.start()).toThrow("Previous test body or fixture cleanup is still active");
				expect(() => owner.run(new AbortController().signal, async () => {})).toThrow("not accepting a test");
				expect(cleanup).toHaveBeenCalledTimes(phase === "body" ? 0 : 1);
			} finally {
				pending.release();
				await body;
				await owner.finish(cleanup);
			}
			expect(cleanup).toHaveBeenCalledTimes(1);
			owner.start();
			await owner.finish(async () => {});
		},
	);

	it("retains both body and cleanup failures after the body has settled", async () => {
		const owner = createTestBodyOwner();
		owner.start();
		const bodyError = new Error("Review assertion failed");
		const cleanupError = new Error("Fixture cleanup failed");
		const body = owner.run(new AbortController().signal, async () => {
			throw bodyError;
		});
		await expect(body).rejects.toBe(bodyError);
		const cleanup = vi.fn(async () => {
			throw cleanupError;
		});
		await expect(owner.finish(cleanup)).rejects.toMatchObject({ errors: [bodyError, cleanupError] });
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});
