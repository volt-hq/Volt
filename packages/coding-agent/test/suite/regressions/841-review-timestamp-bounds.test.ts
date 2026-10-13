/**
 * Regression #841: review run and acknowledgment timestamps reach clients as
 * RPC epoch milliseconds, safe non-negative integers. The host skips a stored
 * run or acknowledgment holding any other timestamp instead of serving it,
 * and never records an acknowledgment with one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createLoopbackClient } from "../../../src/client/protocol-client.ts";
import {
	acknowledgeReviewRun,
	getReviewRun,
	REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE,
	REVIEW_RUN_CUSTOM_ENTRY_TYPE,
	type ReviewRunRecord,
} from "../../../src/core/review-state.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHostHarness } from "../host-harness.ts";

const INVALID_TIMESTAMPS = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1];

function run(runId: string, startedAt: number, endedAt: number): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId,
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt,
		endedAt,
		target: {
			description: "uncommitted changes",
			diffCommand: "git diff",
			identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
	};
}

describe("regression #841: review timestamps are epoch milliseconds", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("serves no stored run or acknowledgment whose timestamp is not epoch milliseconds", async () => {
		const harness = await createHostHarness();
		const source = await harness.openStartup();
		const client = await createLoopbackClient(harness.host, source);
		cleanups.push(async () => {
			await client.stop();
			await harness.cleanup();
		});
		const writer = source.session.sessionWriter;
		// The bounds themselves are epoch milliseconds.
		await writer.appendCustomEntry(REVIEW_RUN_CUSTOM_ENTRY_TYPE, run("valid", 0, Number.MAX_SAFE_INTEGER));
		for (const value of INVALID_TIMESTAMPS) {
			await writer.appendCustomEntry(REVIEW_RUN_CUSTOM_ENTRY_TYPE, run(`started:${value}`, value, 2));
			await writer.appendCustomEntry(REVIEW_RUN_CUSTOM_ENTRY_TYPE, run(`ended:${value}`, 1, value));
			await writer.appendCustomEntry(REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE, {
				schemaVersion: 1,
				runId: "valid",
				acknowledgedAt: value,
			});
		}

		const listed = await client.query("review.runs", {});
		expect(listed.runs.map((entry) => entry.runId)).toEqual(["valid"]);
		expect(listed.runs[0]?.acknowledgedAt).toBeUndefined();
		expect(await client.query("review.result", { runId: "valid" })).toMatchObject({
			startedAt: 0,
			endedAt: Number.MAX_SAFE_INTEGER,
		});
		for (const value of INVALID_TIMESTAMPS) {
			for (const runId of [`started:${value}`, `ended:${value}`]) {
				await expect(client.query("review.result", { runId })).rejects.toMatchObject({
					message: expect.stringContaining("Unknown durable review run"),
				});
			}
		}

		// The skipped acknowledgments leave the run unacknowledged, so acknowledging records a new time.
		const { result } = await client.intent("review_acknowledge", { runId: "valid" });
		expect(Number.isSafeInteger(result?.acknowledgedAt)).toBe(true);
		expect(INVALID_TIMESTAMPS).not.toContain(result?.acknowledgedAt);
	});

	it.each(INVALID_TIMESTAMPS)("never records an acknowledgment at %s", async (value) => {
		const manager = SessionManager.inMemory("/workspace");
		await manager.logWriter.appendCustomEntry(REVIEW_RUN_CUSTOM_ENTRY_TYPE, run("run", 1, 2));

		await expect(acknowledgeReviewRun(manager.logWriter, "run", value)).rejects.toThrow(
			"Review acknowledgment timestamp must be a safe non-negative integer.",
		);
		expect(
			manager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE),
		).toBe(false);
		expect(getReviewRun(manager, "run")?.acknowledgedAt).toBeUndefined();
		await expect(acknowledgeReviewRun(manager.logWriter, "run", 0)).resolves.toMatchObject({ acknowledgedAt: 0 });
	});
});
