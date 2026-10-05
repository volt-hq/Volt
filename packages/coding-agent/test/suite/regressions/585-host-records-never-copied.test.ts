/**
 * Regression #585 (Phase 4, RFC §14 Q7): work and review state are host
 * records of the conversation that wrote them. Fork, clone, and import copy
 * a branch's public entries only, so a copy never carries `work_*` or
 * `review_*` entries, never anchors, aliases, or discusses a review run, and
 * an imported snapshot cannot smuggle such a record in.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendReviewRun, type ReviewRunRecord } from "../../../src/core/review-state.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SQLiteSessionStoreClient } from "../../../src/core/session-store/index.ts";
import { anchorReviewRun, recordReviewDiscussion } from "../../utilities/review-runs.ts";
import { seedSession } from "../../utilities/seed-log.ts";

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closePersistence();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HOST_RECORD = /^(work_|review_)/;

function run(runId: string): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId,
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "Uncommitted changes",
			diffCommand: "git diff",
			identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
	};
}

/** A source holding every kind of work and review host record, interleaved with its conversation. */
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-585-host-records-"));
	roots.push(root);
	const directory = join(root, "sessions");
	const track = (manager: SessionManager) => {
		managers.push(manager);
		return manager;
	};
	const other = track(await SessionManager.create(root, directory));
	await anchorReviewRun(other, "other-run");
	const source = track(await SessionManager.create(root, directory));
	await seedSession(source, (log) => log.user("Review this").assistant("Reviewing"));
	await anchorReviewRun(source, "run");
	await appendReviewRun(source.logWriter, run("run"));
	await appendReviewRun(source.logWriter, run("other-run"));
	await seedSession(source, (log) =>
		log
			.hostRecord("work_started", {
				workId: "job",
				kind: "job",
				title: "Job",
				input: { command: "true" },
				cancellable: true,
				delivery: "wake",
				resume: false,
				state: "running",
			})
			.hostRecord("work_checkpoint", { workId: "job", progress: { text: "half" } })
			.user("Continue"),
	);
	await source.logWriter.recordReviewState(() => ({
		records: [
			{ type: "review_alias", runId: "other-run", source: identity(other) },
			{ type: "review_general", runId: "run", general: identity(other) },
		],
		result: undefined,
	}));
	const childRef = await recordReviewDiscussion(source, {
		discussionId: "discussion",
		runId: "run",
		findingId: "finding",
		contextSnapshot: { finding: { title: "Finding" } },
	});
	await seedSession(source, (log) => log.assistant("Done"));
	const types = source.committedEntriesAfter(0).map((entry) => entry.type);
	for (const type of [
		"work_started",
		"work_checkpoint",
		"work_finished",
		"review_alias",
		"review_general",
		"review_discussion",
	]) {
		expect(types).toContain(type);
	}
	return { root, directory, source, other, childRef, track };
}

function identity(manager: SessionManager) {
	const ref = manager.getSessionRef()!;
	return { sessionId: ref.sessionId, sessionGeneration: ref.sessionGeneration };
}

/** That `copy` holds the source's conversation and none of its host records or review state. */
function expectPublicCopy(copy: SessionManager, source: SessionManager): void {
	expect(copy.committedEntriesAfter(0).filter((entry) => HOST_RECORD.test(entry.type))).toEqual([]);
	expect(copy.getEntries().map((entry) => entry.id)).toEqual(
		expect.arrayContaining(source.getBranch().map((entry) => entry.id)),
	);
	const review = copy.getReviewState();
	expect([
		...review.anchors,
		...review.aliases.keys(),
		...review.generals.keys(),
		...review.discussions.keys(),
	]).toEqual([]);
	expect(review.link).toBeUndefined();
	expect(copy.getConversationState().work.size).toBe(0);
}

describe("regression #585: fork, clone, and import never carry work or review records", () => {
	it("forks and clones copy the public branch only, leaving every run anchored where it was", async () => {
		const { directory, root, source, other, track } = await fixture();
		const sourceRef = source.getSessionRef()!;
		const clone = track(await SessionManager.createBranched(source, source.getLeafId()));
		const [first] = source.getEntries();
		const fork = track(await SessionManager.createBranched(source, first!.id));
		expectPublicCopy(clone, source);
		expect(fork.committedEntriesAfter(0).filter((entry) => HOST_RECORD.test(entry.type))).toEqual([]);
		await source.closePersistence();
		const forkedFrom = track(await SessionManager.forkFrom(sourceRef, root, directory));
		expectPublicCopy(forkedFrom, await SessionManager.openReadOnly(sourceRef));
		const store = await SQLiteSessionStoreClient.open(directory);
		try {
			expect(await store.findReviewRun("run")).toMatchObject({ source: identity(source), general: identity(other) });
			expect(await store.findReviewRun("other-run")).toMatchObject({ source: identity(other) });
			expect(await store.findReviewDiscussion("discussion")).toMatchObject({ source: identity(source) });
		} finally {
			await store.close();
		}
	});

	it("imports copy the public branch only and refuse a snapshot that smuggles in a host record", async () => {
		const { directory, root, source } = await fixture();
		const sourceRef = source.getSessionRef()!;
		const exported = join(root, "source.jsonl");
		await SessionManager.exportJsonlSnapshot(sourceRef, exported);
		const lines = readFileSync(exported, "utf8").trim().split("\n");
		expect(lines.map((line) => JSON.parse(line).type).filter((type: string) => HOST_RECORD.test(type))).toEqual([]);
		const imported = await SessionManager.importFromJsonl(exported, root, directory);
		managers.push(imported);
		expectPublicCopy(imported, source);
		for (const record of [
			{
				type: "work_started",
				workId: "w",
				kind: "review",
				title: "Review",
				input: null,
				cancellable: true,
				delivery: "none",
				resume: false,
				state: "running",
			},
			{ type: "review_alias", runId: "run", source: identity(source) },
			{
				type: "review_discussion_link",
				discussionId: "discussion",
				runId: "run",
				findingId: "finding",
				source: identity(source),
				contextSnapshot: {},
			},
		]) {
			const [header, ...entries] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
			const leaf = entries.pop()!;
			const injected = {
				...record,
				id: "injected",
				parentId: entries.at(-1)!.id,
				timestamp: leaf.timestamp,
				ordinal: entries.length + 1,
			};
			const smuggled = join(root, `smuggled-${record.type}.jsonl`);
			writeFileSync(
				smuggled,
				`${[header, ...entries, injected, { ...leaf, parentId: "injected", ordinal: entries.length + 2 }]
					.map((entry) => JSON.stringify(entry))
					.join("\n")}\n`,
				{ mode: 0o600 },
			);
			await expect(SessionManager.importFromJsonl(smuggled, root, directory)).rejects.toThrow(
				`unsupported host-only entry: ${record.type}`,
			);
		}
	});

	it("refuses to fork or clone a discussion child, whose identity is its source's", async () => {
		const { root, directory, childRef } = await fixture();
		const child = await SessionManager.openReadOnly(childRef);
		expect(child.getReviewDiscussion()).toMatchObject({ discussionId: "discussion", runId: "run" });
		await expect(SessionManager.createBranched(child, child.getLeafId())).rejects.toThrow(/source-linked/);
		await expect(SessionManager.forkFrom(childRef, root, directory)).rejects.toThrow(/source-linked/);
	});
});
