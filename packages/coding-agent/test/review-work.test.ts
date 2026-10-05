/**
 * Reviews as conversation work (RFC §7.2): the `review` kind every session
 * registers. Review work runs without a notice, at most three at once, keeps
 * running when the conversation's run is aborted, and is cancelled through
 * the registry. Opening completed review work fixes its findings in a new
 * conversation, as `review_open_session` does.
 */

import type { WorkRecord } from "@hansjm10/volt-agent-core";
import { WORK_TITLE_MAX_CHARS } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, ProtocolRejectedError } from "../src/client/protocol-client.ts";
import type { ExecuteReviewWorkflowResult, ParsedReview } from "../src/core/review.ts";
import { reviewWorkExecution } from "../src/core/review.ts";
import { appendReviewRun, getReviewRun, type ReviewRunRecord } from "../src/core/review-state.ts";
import { REVIEW_WORK_MAX_ACTIVE, reviewWorkData, reviewWorkInput } from "../src/core/review-work.ts";
import { WorkError, type WorkExecution, type WorkExecutor, type WorkRegistry } from "../src/core/work/registry.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function sessionHarness(): Promise<Harness> {
	const harness = await createHarness();
	cleanups.push(() => harness.cleanupAsync());
	return harness;
}

async function hostHarness(): Promise<HostHarness> {
	const harness = await createHostHarness({ whenUnattached: "keep" });
	cleanups.push(() => harness.cleanup());
	return harness;
}

/** An executor that runs until it is released or aborted. */
function held(): { execute: WorkExecutor; release(execution?: WorkExecution): void } {
	const release = Promise.withResolvers<WorkExecution>();
	return {
		execute: async (ctx) => {
			ctx.signal.addEventListener("abort", () => release.resolve({ outcome: "cancelled" }), { once: true });
			return await release.promise;
		},
		release: (execution = { outcome: "completed" }) => release.resolve(execution),
	};
}

function startReview(work: WorkRegistry, execute: WorkExecutor, workId?: string): Promise<WorkRecord> {
	return work.start("review", reviewWorkInput("review.uncommitted", "uncommitted changes"), execute, {
		...(workId === undefined ? {} : { workId }),
	});
}

function parsed(): ParsedReview {
	return {
		completionStatus: "complete",
		summary: "Two issues were independently verified.",
		findings: ["finding-1", "finding-2"].map((id, index) => ({
			id,
			fingerprint: String(index).repeat(64),
			status: "open" as const,
			title: `Finding ${index + 1}`,
			body: "The guard returns the wrong value.",
			trigger: "Call with zero.",
			impact: "The caller receives incorrect data.",
			category: "correctness",
			rootCauseKey: `root-cause-${index}`,
			priority: 2 as const,
			confidence: 0.9,
			changeLocation: { path: "src/value.ts", side: "head" as const, startLine: 2, endLine: 2 },
			evidenceLocations: [],
			verification: {
				outcome: "accepted" as const,
				method: "Exact blob comparison",
				rationale: "The added branch is present.",
				confidence: 0.95,
			},
		})),
		coverage: {
			changedFileInventoryComplete: true,
			filesInspected: ["src/value.ts"],
			hunksInspected: ["hunk-1"],
			commandsRun: [],
			failedVerificationAttempts: [],
			exclusions: [],
			uncheckedAreas: [],
			residualRisk: [],
			modelReportedLimitations: [],
		},
		overallCorrectness: "incorrect",
		overallExplanation: "Verified P2 findings remain.",
	};
}

function runRecord(runId: string): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId,
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "uncommitted changes",
			diffCommand: "git diff exact-base..exact-head",
			identity: { kind: "uncommitted", baseTree: "base-tree", headTree: "head-tree" },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		result: parsed(),
	};
}

function completed(findingsCount: number, completionStatus: ParsedReview["completionStatus"]) {
	return {
		status: "completed",
		raw: "summary",
		parsed: parsed(),
		findingsCount,
		completionStatus,
	} satisfies ExecuteReviewWorkflowResult;
}

describe("review work", () => {
	it("records review work without a notice, titled by what it reviews, and cancels it", async () => {
		const harness = await sessionHarness();
		const work = harness.session.work;
		const running = held();
		const record = await startReview(work, running.execute, "review:one");
		expect(record).toMatchObject({
			workId: "review:one",
			kind: "review",
			title: "Review uncommitted changes",
			input: { action: "review.uncommitted", target: "uncommitted changes" },
			delivery: "none",
			cancellable: true,
			resume: false,
			state: "running",
		});
		expect(work.running().map((item) => item.workId)).toEqual(["review:one"]);
		expect(harness.session.hasRunningWork).toBe(true);

		await work.cancel("review:one");
		await work.settled("review:one");
		expect(work.get("review:one")).toMatchObject({ state: "cancelling", outcome: "cancelled" });
		expect(work.running()).toEqual([]);
	});

	it("bounds the target a review's input keeps to a title", async () => {
		const harness = await sessionHarness();
		const target = `branch changes vs ${"b".repeat(300)}`;
		const input = reviewWorkInput("review.branch", target);
		expect(input).toEqual({ action: "review.branch", target: target.slice(0, WORK_TITLE_MAX_CHARS) });
		const record = await harness.session.work.start("review", input, async () => ({ outcome: "cancelled" }));
		expect(record.title.length).toBeLessThanOrEqual(WORK_TITLE_MAX_CHARS);
		expect(record.title.startsWith("Review branch changes vs bbb")).toBe(true);
	});

	it(`runs at most ${REVIEW_WORK_MAX_ACTIVE} reviews at once`, async () => {
		const harness = await sessionHarness();
		const work = harness.session.work;
		const reviews = Array.from({ length: REVIEW_WORK_MAX_ACTIVE }, () => held());
		for (const review of reviews) await startReview(work, review.execute);
		const refused = startReview(work, held().execute);
		await expect(refused).rejects.toBeInstanceOf(WorkError);
		await expect(refused).rejects.toMatchObject({ code: "limit" });

		reviews[0]?.release();
		await vi.waitFor(() => expect(work.running()).toHaveLength(REVIEW_WORK_MAX_ACTIVE - 1));
		await startReview(work, held().execute);
		expect(work.running()).toHaveLength(REVIEW_WORK_MAX_ACTIVE);
		for (const record of work.running()) await work.cancel(record.workId);
		await work.waitForIdle();
	});

	it("keeps reviews running when the conversation's run is aborted, unlike work a kind lets the abort cancel", async () => {
		const harness = await sessionHarness();
		const work = harness.session.work;
		work.register({
			kind: "ext:test/run",
			delivery: "none",
			cancellable: true,
			maxActive: 1,
			title: () => "Test work",
		});
		const review = held();
		const reviewRecord = await startReview(work, review.execute);
		const other = await work.start("ext:test/run", null, held().execute);

		await harness.session.abort();
		expect(work.get(other.workId)?.outcome).toBe("cancelled");
		expect(work.get(reviewRecord.workId)).toMatchObject({ state: "running" });
		expect(work.get(reviewRecord.workId)?.outcome).toBeUndefined();
		expect(work.running().map((item) => item.workId)).toEqual([reviewRecord.workId]);

		review.release({ outcome: "completed" });
		await work.settled(reviewRecord.workId);
		expect(work.get(reviewRecord.workId)?.outcome).toBe("completed");
	});

	it("ends a review as its execution reports: summary and finding counts, a failure's error, or a cancel", () => {
		expect(reviewWorkExecution(completed(2, "complete"), "PR #7")).toEqual({
			outcome: "completed",
			result: {
				summary: "Review complete: 2 findings.",
				data: { target: "PR #7", findingsCount: 2, completionStatus: "complete" },
			},
		});
		expect(reviewWorkExecution(completed(0, "incomplete"), "PR #7")).toMatchObject({
			result: { summary: "Review incomplete.", data: { findingsCount: 0, completionStatus: "incomplete" } },
		});
		expect(
			reviewWorkExecution({ status: "failed", errorMessage: "The review could not be completed." }, "x"),
		).toEqual({ outcome: "failed", error: "The review could not be completed." });
		expect(reviewWorkExecution({ status: "cancelled" }, "x")).toEqual({ outcome: "cancelled" });
	});

	it("reads the result data of completed review work only", async () => {
		const harness = await sessionHarness();
		const work = harness.session.work;
		const done = await startReview(work, async () => reviewWorkExecution(completed(3, "complete"), "PR #9"));
		const failed = await startReview(work, async () => ({ outcome: "failed", error: "boom" }));
		const malformed = await startReview(work, async () => ({
			outcome: "completed",
			result: { data: { target: "PR #9", findingsCount: -1, completionStatus: "complete" } },
		}));
		await work.waitForIdle();
		expect(reviewWorkData(work.get(done.workId)!)).toEqual({
			target: "PR #9",
			findingsCount: 3,
			completionStatus: "complete",
		});
		expect(reviewWorkData(work.get(failed.workId)!)).toBeUndefined();
		expect(reviewWorkData(work.get(malformed.workId)!)).toBeUndefined();
		const job = { ...work.get(done.workId)!, kind: "job" as const };
		expect(reviewWorkData(job)).toBeUndefined();
	});
});

describe("opening review work", () => {
	async function rejection(promise: Promise<unknown>): Promise<string> {
		const error = await promise.then(
			() => undefined,
			(reason: unknown) => reason,
		);
		if (!(error instanceof ProtocolRejectedError)) throw new Error("Expected a rejected intent");
		return error.reason.code;
	}

	it("refuses running and unfinished reviews, and moves the client to a fix of a completed review's findings", async () => {
		const harness = await hostHarness();
		const source = await harness.openStartup();
		const client = await createLoopbackClient(harness.host, source, { anchor: false });
		cleanups.push(() => client.stop());

		const running = held();
		const record = await startReview(source.work, running.execute, "review:running");
		await expect(
			source.work.open(record.workId, { host: harness.host, client: harness.client("direct") }),
		).rejects.toMatchObject({ code: "running" });
		expect(await rejection(client.intent("open_work", { workId: record.workId }))).toBe("conflict");
		// A review running in the conversation keeps its clients there.
		expect(await rejection(client.intent("new_session", {}))).toBe("failed");
		await client.intent("cancel_work", { workId: record.workId });
		await source.work.settled(record.workId);
		expect(source.work.get(record.workId)?.outcome).toBe("cancelled");
		expect(await rejection(client.intent("open_work", { workId: record.workId }))).toBe("unavailable");

		const done = await startReview(
			source.work,
			async () => {
				await appendReviewRun(source.session.sessionWriter, runRecord("review:done"));
				return reviewWorkExecution(completed(2, "complete"), "uncommitted changes");
			},
			"review:done",
		);
		await source.work.settled(done.workId);
		expect(source.work.get(done.workId)?.outcome).toBe("completed");

		const opened = await client.intent("open_work", { workId: done.workId });
		expect(opened.conversation).toEqual(expect.any(String));
		expect(opened.conversation).not.toBe(source.id);
		await vi.waitFor(() => expect(client.conversation).toBe(opened.conversation));
		const target = harness.host.get(opened.conversation!);
		if (!target) throw new Error("Expected the fix conversation to be open");
		const seeds = target.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "review");
		expect(seeds).toHaveLength(1);
		expect(JSON.stringify(seeds[0])).toContain("finding-1");
		expect(JSON.stringify(seeds[0])).toContain("finding-2");
		// Opening every finding acknowledges the run in the source and the fix.
		const acknowledgedAt = getReviewRun(source.session.sessionManager, "review:done")?.acknowledgedAt;
		expect(acknowledgedAt).toEqual(expect.any(Number));
		expect(getReviewRun(target.session.sessionManager, "review:done")?.acknowledgedAt).toBe(acknowledgedAt);
		// Work entries stay in the source: the fix conversation holds the run, not its work.
		expect(target.work.get(done.workId)).toBeUndefined();
	});

	it("refuses to open a completed review whose run record is gone", async () => {
		const harness = await hostHarness();
		const source = await harness.openStartup();
		const record = await startReview(
			source.work,
			async () => reviewWorkExecution(completed(1, "complete"), "uncommitted changes"),
			"review:no-record",
		);
		await source.work.settled(record.workId);
		await expect(
			source.work.open(record.workId, { host: harness.host, client: harness.client("direct") }),
		).rejects.toThrow("Unknown durable review run: review:no-record");
	});
});
