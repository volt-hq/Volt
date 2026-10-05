/**
 * Review state as log entries (RFC §14 Q7): the store's derived run and
 * discussion indexes, how it refuses review records that do not fit the
 * other logs, and run membership and General across conversations.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getReviewGeneral,
	prepareReviewGeneralReplacement,
	type ReviewSourceWriter,
	registerReviewHandoffAliases,
	resolveCanonicalReviewSource,
} from "../src/core/review-links.ts";
import type { ReviewSessionIdentity } from "../src/core/review-log-state.ts";
import { appendReviewRun, type ReviewRunRecord } from "../src/core/review-state.ts";
import { REVIEW_DISCUSSION_CONTEXT_MAX_BYTES } from "../src/core/session-entry-types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SQLiteSessionStoreClient } from "../src/core/session-store/index.ts";
import {
	parseSessionStoreOperationResult,
	parseSessionStoreWorkerOperation,
} from "../src/core/session-store/protocol.ts";
import type { ReviewRecord } from "../src/core/session-writer.ts";
import { anchorReviewRun } from "./utilities/review-runs.ts";

const roots: string[] = [];
const managers: SessionManager[] = [];
const clients: SQLiteSessionStoreClient[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closePersistence();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-review-entries-"));
	roots.push(root);
	const cwd = join(root, "project");
	mkdirSync(cwd);
	const directory = join(root, "sessions");
	const create = async () => {
		const manager = await SessionManager.create(cwd, directory);
		managers.push(manager);
		return manager;
	};
	const store = await SQLiteSessionStoreClient.open(directory);
	clients.push(store);
	const source = await create();
	await anchorReviewRun(source, "run");
	return { root, cwd, directory, store, source, create };
}

function identity(manager: SessionManager): ReviewSessionIdentity {
	const ref = manager.getSessionRef()!;
	return { sessionId: ref.sessionId, sessionGeneration: ref.sessionGeneration };
}

function record(manager: SessionManager, ...records: ReviewRecord[]): Promise<void> {
	return manager.logWriter.recordReviewState(() => ({ records, result: undefined }));
}

function link(source: SessionManager, discussionId = "discussion", findingId = "finding"): ReviewRecord {
	return {
		type: "review_discussion_link",
		discussionId,
		runId: "run",
		findingId,
		source: identity(source),
		contextSnapshot: { finding: { title: "Canonical finding" } },
	};
}

function discussion(child: SessionManager, discussionId = "discussion", findingId = "finding"): ReviewRecord {
	return {
		type: "review_discussion",
		discussionId,
		runId: "run",
		findingId,
		contextSnapshot: { finding: { title: "Canonical finding" } },
		child: identity(child),
		requestId: `create:${discussionId}`,
		kickoffClientMessageId: `kickoff-${discussionId}`,
	};
}

function run(runId = "run"): ReviewRunRecord {
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

describe("review state entries and the store's derived indexes", () => {
	it("indexes a run's anchor and General, refuses a second anchor, and keeps both across reopen", async () => {
		const { store, source, create, directory } = await fixture();
		const other = await create();
		expect(await store.findReviewRun("run")).toEqual({
			runId: "run",
			source: identity(source),
			general: identity(source),
		});
		await expect(anchorReviewRun(other, "run")).rejects.toThrow(/already anchored/);
		expect(other.getReviewState().anchors.has("run")).toBe(false);
		// Only the source records the run's General, and only for a run it anchors.
		const general: ReviewRecord = { type: "review_general", runId: "run", general: identity(other) };
		await expect(record(other, general)).rejects.toThrow(/not anchored/);
		await expect(record(source, { ...general, runId: "unanchored" })).rejects.toThrow(/not anchored/);
		await record(source, general);
		expect(source.getReviewState().generals.get("run")).toEqual(identity(other));
		await store.close();
		const reopened = await SQLiteSessionStoreClient.open(directory);
		clients.push(reopened);
		expect(await reopened.findReviewRun("run")).toMatchObject({ general: identity(other) });
		expect(await reopened.findReviewRun("unanchored")).toBeNull();
		expect(await reopened.verifyForeignKeys()).toEqual({ status: "valid" });
	});

	it("accepts aliases and discussion links only for the run's indexed source, and links only as a first entry", async () => {
		const { source, create } = await fixture();
		const alias = await create();
		const stranger = await create();
		await expect(record(alias, { type: "review_alias", runId: "run", source: identity(stranger) })).rejects.toThrow(
			/not anchored/,
		);
		await expect(record(source, { type: "review_alias", runId: "run", source: identity(source) })).rejects.toThrow(
			/own conversation/,
		);
		await record(alias, { type: "review_alias", runId: "run", source: identity(source) });
		expect(alias.getReviewState().aliases.get("run")).toEqual(identity(source));
		await expect(record(stranger, { ...link(source), source: identity(alias) } as ReviewRecord)).rejects.toThrow(
			/not anchored/,
		);
		await expect(record(alias, link(source))).rejects.toThrow(/first entry/);
		await stranger.logWriter.appendSessionInfo("not empty");
		await expect(record(stranger, link(source))).rejects.toThrow(/root entry/);
		const child = await create();
		await record(child, link(source));
		expect(child.getReviewDiscussion()).toMatchObject({ discussionId: "discussion", source: identity(source) });
	});

	it("records discussions and resets in their source and indexes each child once", async () => {
		const { store, source, create } = await fixture();
		const [first, second, third] = [await create(), await create(), await create()];
		for (const child of [first, second, third]) await record(child, link(source));
		await expect(record(first, discussion(second))).rejects.toThrow(/not anchored/);
		await record(source, discussion(first));
		await expect(record(source, discussion(second, "other-discussion"))).rejects.toThrow(/already exists/);
		await expect(record(source, discussion(first, "other-discussion", "other-finding"))).rejects.toThrow(
			/new conversation/,
		);
		const reset = (child: SessionManager, requestId: string): ReviewRecord => ({
			type: "review_discussion_reset",
			discussionId: "discussion",
			child: identity(child),
			requestId,
			kickoffClientMessageId: `kickoff-${requestId}`,
		});
		await expect(record(first, reset(second, "reset"))).rejects.toThrow(/source can reset/);
		await record(source, reset(second, "reset"));
		await expect(record(source, reset(third, "reset"))).rejects.toThrow(/already recorded/);
		await expect(record(source, reset(first, "again"))).rejects.toThrow(/new conversation/);
		const recorded = source.getReviewState().discussions.get("discussion");
		expect(recorded?.children.map((child) => [child.ordinal, child.child])).toEqual([
			[1, identity(first)],
			[2, identity(second)],
		]);
		expect(recorded?.contextSnapshot).toEqual({ finding: { title: "Canonical finding" } });
		expect(await store.findReviewDiscussion("discussion")).toEqual({
			discussionId: "discussion",
			runId: "run",
			findingId: "finding",
			source: identity(source),
			child: identity(second),
			ordinal: 2,
		});
		expect(await store.findReviewDiscussionChild(identity(first))).toMatchObject({ ordinal: 1 });
		expect(await store.findReviewDiscussionChild(identity(third))).toBeNull();
		expect(
			await store.findReviewDiscussionChild({ ...identity(first), sessionGeneration: "other-generation" }),
		).toBeNull();
	});

	it("drops a deleted source's derived rows while its children keep their link", async () => {
		const { store, source, create } = await fixture();
		const child = await create();
		await record(child, link(source));
		await record(source, discussion(child));
		const sourceRef = source.getSessionRef()!;
		const childRef = child.getSessionRef()!;
		for (const manager of managers.splice(0)) await manager.closePersistence();
		expect(await SessionManager.delete(sourceRef)).toBe(true);
		expect(await store.findReviewRun("run")).toBeNull();
		expect(await store.findReviewDiscussion("discussion")).toBeNull();
		expect(await store.findReviewDiscussionChild(identity(child))).toBeNull();
		const reopened = await SessionManager.open(childRef);
		managers.push(reopened);
		expect(reopened.getReviewDiscussion()).toMatchObject({ discussionId: "discussion", runId: "run" });
		expect(await store.verifyForeignKeys()).toEqual({ status: "valid" });
	});

	it("bounds review records and validates the index lookups' wire values", async () => {
		const { source, create } = await fixture();
		const child = await create();
		await expect(
			record(child, {
				...link(source),
				contextSnapshot: "x".repeat(REVIEW_DISCUSSION_CONTEXT_MAX_BYTES),
			} as ReviewRecord),
		).rejects.toThrow(/exceeds/);
		await expect(
			record(source, { ...discussion(child), kickoffClientMessageId: "not a client id" } as ReviewRecord),
		).rejects.toThrow(/kickoffClientMessageId/);
		await expect(
			record(source, { type: "review_alias", runId: "run", source: identity(source), extra: true } as ReviewRecord),
		).rejects.toThrow(/unknown property/);
		await expect(
			record(source, { type: "review_general", runId: "run", general: { sessionId: "../escape" } } as ReviewRecord),
		).rejects.toThrow(/invalid review_general payload/);
		expect(() => parseSessionStoreWorkerOperation({ kind: "find_review_run", runId: "run", portable: true })).toThrow(
			/unknown property/,
		);
		expect(() =>
			parseSessionStoreWorkerOperation({ kind: "find_review_discussion_child", child: { sessionId: "only-id" } }),
		).toThrow(/missing property/);
		for (const kind of ["register_review_anchor", "replace_review_general", "create_review_discussion"]) {
			expect(() => parseSessionStoreWorkerOperation({ kind })).toThrow(/unsupported operation/);
		}
		expect(() =>
			parseSessionStoreOperationResult("find_review_discussion", {
				discussionId: "discussion",
				runId: "run",
				findingId: "finding",
				source: identity(source),
				child: identity(child),
				ordinal: 0,
			}),
		).toThrow(/safe integer/);
	});
});

describe("review run membership and General", () => {
	it("resolves a run's source from its source and aliases, keeps copies local, and fails closed without the source", async () => {
		const { source, create } = await fixture();
		await appendReviewRun(source.logWriter, run());
		const alias = await create();
		await appendReviewRun(alias.logWriter, run());
		await registerReviewHandoffAliases(source, alias.logWriter, ["run"]);
		const copy = await create();
		await appendReviewRun(copy.logWriter, run());
		const sourceRef = source.getSessionRef()!;
		expect(await resolveCanonicalReviewSource(source, "run")).toEqual(sourceRef);
		expect(await resolveCanonicalReviewSource(alias, "run")).toEqual(sourceRef);
		expect(await resolveCanonicalReviewSource(copy, "run")).toBeUndefined();
		expect(await resolveCanonicalReviewSource(source, "unanchored")).toBeUndefined();
		// A copy carries no membership: handing it off grants none.
		const fromCopy = await create();
		await registerReviewHandoffAliases(copy, fromCopy.logWriter, ["run"]);
		expect(fromCopy.getReviewState().aliases.size).toBe(0);
		const aliasRef = alias.getSessionRef()!;
		for (const manager of managers.splice(0)) await manager.closePersistence();
		await SessionManager.delete(sourceRef);
		const reopened = await SessionManager.open(aliasRef);
		managers.push(reopened);
		await expect(resolveCanonicalReviewSource(reopened, "run")).rejects.toMatchObject({
			code: "review_source_unavailable",
		});
	});

	it("answers the General to the source, its aliases, and the children it records, and to no one else", async () => {
		const { source, create } = await fixture();
		const alias = await create();
		await registerReviewHandoffAliases(source, alias.logWriter, ["run"]);
		const [recorded, orphan, stranger] = [await create(), await create(), await create()];
		await record(recorded, link(source));
		await record(source, discussion(recorded));
		await record(orphan, link(source, "orphan", "other-finding"));
		const expected = {
			runId: "run",
			sourceSessionId: source.getSessionId(),
			generalSessionId: source.getSessionId(),
			generalSessionGeneration: identity(source).sessionGeneration,
			generalAvailable: true,
		};
		for (const member of [source, alias, recorded]) expect(await getReviewGeneral(member, "run")).toEqual(expected);
		for (const outsider of [orphan, stranger]) {
			await expect(getReviewGeneral(outsider, "run")).rejects.toMatchObject({ code: "review_source_unavailable" });
		}
		await expect(getReviewGeneral(source, "other")).rejects.toMatchObject({ code: "review_source_unavailable" });
	});

	it("moves the General through the source's log: of two replacements from the same General one wins", async () => {
		const { source, create } = await fixture();
		const targets = [await create(), await create()];
		for (const target of targets) await registerReviewHandoffAliases(source, target.logWriter, ["run"]);
		const writeSource: ReviewSourceWriter = (_ref, write) => write(source.logWriter);
		const replacements = await Promise.all(
			targets.map(() => prepareReviewGeneralReplacement(source, "run", writeSource)),
		);
		const results = await Promise.allSettled(
			replacements.map((replacement, index) => replacement.commit(targets[index]!)),
		);
		expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		const winner = targets[results.findIndex((result) => result.status === "fulfilled")]!;
		expect(await getReviewGeneral(source, "run")).toMatchObject({ generalSessionId: winner.getSessionId() });
		// The new General can move it again; the old one no longer can.
		await expect(prepareReviewGeneralReplacement(source, "run", writeSource)).rejects.toMatchObject({
			code: "review_source_unavailable",
		});
		const next = await create();
		await registerReviewHandoffAliases(winner, next.logWriter, ["run"]);
		await (await prepareReviewGeneralReplacement(winner, "run", writeSource)).commit(next);
		expect(await getReviewGeneral(next, "run")).toMatchObject({
			sourceSessionId: source.getSessionId(),
			generalSessionId: next.getSessionId(),
		});
		// A new conversation that does not carry the run cannot become its General.
		const unrelated = await create();
		await expect(
			(await prepareReviewGeneralReplacement(next, "run", writeSource)).commit(unrelated),
		).rejects.toMatchObject({ code: "review_source_unavailable" });
	});
});
