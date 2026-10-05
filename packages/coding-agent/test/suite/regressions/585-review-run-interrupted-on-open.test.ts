// Regression for #585 (Phase 4, RFC §7.1, §2.4): a review is `review` work in
// the conversation's log, not an `unfinished` run record that nothing ever
// reconciles. A review running when its runtime stops ends `interrupted` once
// the conversation opens again, whether the runtime closed or ended without
// closing; it leaves no unfinished run record and no usage entries, has no
// findings to open, and the conversation reviews again as usual.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConversationLogEntry, InMemoryConversationLog } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	executeReviewWorkflow,
	type PreparedReviewWorkflow,
	prepareReviewWorkflow,
	reviewWorkExecution,
	reviewWorkTarget,
} from "../../../src/core/review.ts";
import { getReviewRun, listReviewRuns, REVIEW_RUN_CUSTOM_ENTRY_TYPE } from "../../../src/core/review-state.ts";
import { reviewWorkInput } from "../../../src/core/review-work.ts";
import { WorkError, type WorkOpenContext } from "../../../src/core/work/registry.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const releases: Array<() => void> = [];
const directories: string[] = [];

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const harness of harnesses.splice(0).reverse()) await harness.cleanupAsync();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A repository with one uncommitted change to review. */
function repository(): string {
	const cwd = mkdtempSync(join(tmpdir(), "volt-585-review-"));
	directories.push(cwd);
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr);
	};
	git("init", "--initial-branch=main");
	git("config", "user.email", "review@example.test");
	git("config", "user.name", "Review Test");
	writeFileSync(join(cwd, "file.ts"), "export const value = 1;\n");
	git("add", "file.ts");
	git("commit", "-m", "initial");
	writeFileSync(join(cwd, "file.ts"), "export const value = 2;\n");
	return cwd;
}

async function open(log: InMemoryConversationLog): Promise<Harness> {
	const harness = await createHarness({
		log,
		settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
	});
	harnesses.push(harness);
	return harness;
}

/** The same conversation as a new runtime finds it: a copy of every entry of `log`. */
async function copyOf(log: InMemoryConversationLog): Promise<InMemoryConversationLog> {
	const entries: ConversationLogEntry[] = [];
	for (;;) {
		const page = await log.read(entries.length, 1_000);
		entries.push(...page.entries);
		if (page.entries.length === 0 || entries.length >= page.lastOrdinal) break;
	}
	const copy = new InMemoryConversationLog(log.conversationId);
	await copy.append({
		expectedOrdinal: 0,
		commitId: "restart-copy",
		entries: entries.map(({ ordinal: _ordinal, ...draft }) => draft),
	});
	return copy;
}

/** Start `harness`'s conversation's review of `cwd` as its `review` work, as a host does. */
async function startReview(harness: Harness, cwd: string): Promise<PreparedReviewWorkflow> {
	const session = harness.session;
	const prepared = await prepareReviewWorkflow({
		target: { kind: "uncommitted" },
		cwd,
		settingsManager: harness.settingsManager,
		modelRegistry: session.modelRegistry,
		currentModel: harness.getModel(),
		sessionManager: session.sessionManager,
	});
	const target = reviewWorkTarget(prepared.resolution);
	await session.work.start(
		"review",
		reviewWorkInput(prepared.action, target),
		async (ctx) =>
			reviewWorkExecution(
				await executeReviewWorkflow({
					prepared,
					cwd,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					modelRegistry: session.modelRegistry,
					settingsManager: harness.settingsManager,
					sessionWriter: session.sessionWriter,
					signal: ctx.signal,
					work: ctx,
				}),
				target,
			),
		{ workId: prepared.workflowId },
	);
	return prepared;
}

/** The discovery pass's model request waits until the runtime stops it; resolves once it was dispatched. */
function blockDiscovery(harness: Harness): Promise<void> {
	const dispatched = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	releases.push(release.resolve);
	harness.setResponses([
		async (_context, options) => {
			dispatched.resolve();
			options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return fauxAssistantMessage("Stopped");
		},
	]);
	return dispatched.promise;
}

/** Custom entries of `harness`'s log that only an unfinished run would leave. */
function unfinishedTraces(harness: Harness): unknown[] {
	return harness.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom" &&
				(entry.customType === "volt.review.usage" ||
					(entry.customType === REVIEW_RUN_CUSTOM_ENTRY_TYPE &&
						(entry.data as { status?: unknown } | undefined)?.status === "unfinished")),
		);
}

/** Open the review's work: `review_open_session` behavior, refused before a client is consulted. */
function openWork(harness: Harness, workId: string): Promise<unknown> {
	return harness.session.work.open(workId, {} as unknown as WorkOpenContext);
}

async function reviewAgain(harness: Harness, cwd: string): Promise<void> {
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("report_review_candidates", { summary: "No candidates", candidates: [], limitations: [] }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("report_review_verification", {
				summary: "Checked",
				assessment: "complete",
				decisions: [],
				priorFindingDecisions: [],
				limitations: [],
			}),
			{ stopReason: "toolUse" },
		),
	]);
	const next = await startReview(harness, cwd);
	await harness.session.work.settled(next.workflowId);
	// The model inspected nothing, so the verified review is incomplete; its work completed.
	expect(harness.session.work.get(next.workflowId)).toMatchObject({
		kind: "review",
		outcome: "completed",
		result: { summary: "Review incomplete.", data: { findingsCount: 0, completionStatus: "incomplete" } },
	});
	expect(getReviewRun(harness.sessionManager, next.workflowId)).toMatchObject({ status: "incomplete" });
}

describe("#585 review run interrupted on open", () => {
	it("interrupts a review whose runtime ended without closing when the conversation opens again", async () => {
		const cwd = repository();
		const log = new InMemoryConversationLog("review-restart-crash");
		const first = await open(log);
		const dispatched = blockDiscovery(first);
		const { workflowId: runId } = await startReview(first, cwd);
		await dispatched;
		// The discovery pass is a durable checkpoint carrying the accounting so far.
		expect(first.session.work.get(runId)).toMatchObject({
			kind: "review",
			title: "Review uncommitted changes",
			state: "running",
			progress: { text: "Discovery pass" },
			detail: { type: "keyValue", key: "review-usage" },
		});
		expect(first.session.work.get(runId)?.outcome).toBeUndefined();
		// No run record is written until the review ends.
		expect(listReviewRuns(first.sessionManager).runs).toEqual([]);
		expect(unfinishedTraces(first)).toEqual([]);

		// The runtime ends without closing: the log keeps the review open.
		const second = await open(await copyOf(log));
		expect(second.session.work.get(runId)).toMatchObject({
			kind: "review",
			outcome: "interrupted",
			progress: { text: "Discovery pass" },
		});
		expect(second.session.hasRunningWork).toBe(false);
		expect(getReviewRun(second.sessionManager, runId)).toBeUndefined();
		expect(unfinishedTraces(second)).toEqual([]);
		// An interrupted review has no findings to open; nothing runs.
		await expect(openWork(second, runId)).rejects.toMatchObject({ name: "WorkError", code: "unavailable" });
		await expect(openWork(second, runId)).rejects.toBeInstanceOf(WorkError);
		expect(second.faux.state.callCount).toBe(0);

		await reviewAgain(second, cwd);
	});

	it("interrupts a review when its runtime closes, and the reopened conversation knows it", async () => {
		const cwd = repository();
		const log = new InMemoryConversationLog("review-restart-close");
		const first = await open(log);
		const dispatched = blockDiscovery(first);
		const { workflowId: runId } = await startReview(first, cwd);
		await dispatched;
		await first.cleanupAsync();
		harnesses.splice(harnesses.indexOf(first), 1);

		const second = await open(await copyOf(log));
		expect(second.session.work.get(runId)).toMatchObject({ kind: "review", outcome: "interrupted" });
		expect(second.session.work.running()).toEqual([]);
		expect(unfinishedTraces(second)).toEqual([]);
		await expect(openWork(second, runId)).rejects.toMatchObject({ code: "unavailable" });
		expect(second.faux.state.callCount).toBe(0);

		await reviewAgain(second, cwd);
	});
});
