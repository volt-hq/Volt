import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, ProtocolRejectedError } from "../../../src/client/protocol-client.ts";
import type { ParsedReview } from "../../../src/core/review-report.ts";
import {
	appendReviewRun,
	getReviewRun,
	REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE,
	type ReviewRunRecord,
} from "../../../src/core/review-state.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { createHostHarness } from "../host-harness.ts";

const RUN_ID = "review:585";

function reviewRecord(): ReviewRunRecord {
	const finding: ParsedReview["findings"][number] = {
		id: "finding-1",
		fingerprint: "a".repeat(64),
		status: "open",
		title: "Wrong guard",
		body: "The guard returns the wrong value.",
		trigger: "Call with zero.",
		impact: "The caller receives incorrect data.",
		category: "correctness",
		rootCauseKey: "wrong-zero-guard",
		priority: 2,
		confidence: 0.9,
		changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
		evidenceLocations: [],
		verification: {
			outcome: "accepted",
			method: "Exact blob comparison",
			rationale: "The added branch is present.",
			confidence: 0.95,
		},
	};
	return {
		schemaVersion: 1,
		runId: RUN_ID,
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "uncommitted changes",
			diffCommand: "git diff exact-base..exact-head",
			identity: { kind: "uncommitted", baseTree: "base-tree", headTree: "head-tree" },
			files: [{ path: "src/value.ts", baseOid: "base", headOid: "head", hunkIds: ["hunk-1"], reviewable: true }],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
		result: {
			completionStatus: "complete",
			summary: "Two issues were independently verified.",
			findings: [finding, { ...finding, id: "finding-2", fingerprint: "b".repeat(64), title: "Second issue" }],
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
			overallExplanation: "Two verified findings remain.",
		},
	};
}

function acknowledged(entries: ReadonlyArray<{ type: string; customType?: string }>): boolean {
	return entries.some(
		(entry) => entry.type === "custom" && entry.customType === REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE,
	);
}

describe("regression #585: a review fix acknowledges the run through the still-open source", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup() {
		/** For each session_shutdown: the session, and whether its log already held the acknowledgement. */
		const shutdowns: Array<{ sessionId: string; acknowledged: boolean }> = [];
		const harness = await createHostHarness({
			extension: (volt) => {
				volt.on("session_shutdown", (_event, ctx) => {
					shutdowns.push({
						sessionId: ctx.sessionManager.getSessionId(),
						acknowledged: acknowledged(ctx.sessionManager.getEntries()),
					});
				});
			},
		});
		const source = await harness.openStartup();
		await appendReviewRun(source.session.sessionWriter, reviewRecord());
		const client = await createLoopbackClient(harness.host, source);
		cleanups.push(async () => {
			await client.stop();
			await harness.cleanup();
		});
		/** The session of the one conversation open: the client's, as the host closes each it leaves. */
		const currentSession = () => {
			const [conversation, ...others] = harness.host.list();
			if (!conversation || others.length > 0) throw new Error("Expected one open conversation");
			return conversation.session;
		};
		return { harness, source, currentSession, client, shutdowns };
	}

	/** The run as the source's stored log holds it, read once nothing holds the log open. */
	async function storedSourceRun(ref: SessionReference) {
		const manager = await SessionManager.open(ref);
		try {
			return getReviewRun(manager, RUN_ID);
		} finally {
			await manager.closePersistence();
		}
	}

	it("writes the source's acknowledgement before the source closes and never reopens the source", async () => {
		const { source, currentSession, client, shutdowns } = await setup();
		const sourceId = source.id;
		const sourceRef = source.session.sessionRef!;
		const reopen = vi.spyOn(SessionManager, "open");

		const accepted = await client.intent("review_open_session", { runId: RUN_ID });

		const target = currentSession();
		expect(accepted.conversation).toBe(target.sessionId);
		expect(accepted.result).toBeUndefined();
		expect(target.sessionId).not.toBe(sourceId);
		await vi.waitFor(() => expect(client.conversation).toBe(target.sessionId));
		expect(reopen).not.toHaveBeenCalled();
		// The source closed after the client moved, and its log already held the acknowledgement.
		expect(shutdowns).toEqual([{ sessionId: sourceId, acknowledged: true }]);
		// The new session was written before it opened: the run, the review message, and the same acknowledgement.
		const targetRun = getReviewRun(target.sessionManager, RUN_ID);
		expect(targetRun?.acknowledgedAt).toEqual(expect.any(Number));
		const reviewMessages = target.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "review");
		expect(reviewMessages).toHaveLength(1);
		reopen.mockRestore();
		expect((await storedSourceRun(sourceRef))?.acknowledgedAt).toBe(targetRun?.acknowledgedAt);
	});

	it("acknowledges only the new session for a fix of selected findings", async () => {
		const { source, currentSession, client, shutdowns } = await setup();
		const sourceRef = source.session.sessionRef!;

		const accepted = await client.intent("review_open_session", { runId: RUN_ID, findingIds: ["finding-2"] });

		expect(accepted.conversation).toBe(currentSession().sessionId);
		expect(shutdowns).toEqual([{ sessionId: source.id, acknowledged: false }]);
		expect(getReviewRun(currentSession().sessionManager, RUN_ID)?.acknowledgedAt).toEqual(expect.any(Number));
		expect((await storedSourceRun(sourceRef))?.acknowledgedAt).toBeUndefined();
	});

	it("keeps the client on the source and discards the new session when the source write fails", async () => {
		const { harness, source, currentSession, client, shutdowns } = await setup();
		const writer = source.session.sessionWriter;
		const appendCustomEntry = writer.appendCustomEntry.bind(writer);
		vi.spyOn(writer, "appendCustomEntry").mockImplementation(async (customType, data) => {
			if (customType === REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE) throw new Error("source write failed");
			return appendCustomEntry(customType, data);
		});

		const opened = client.intent("review_open_session", { runId: RUN_ID });
		await expect(opened).rejects.toBeInstanceOf(ProtocolRejectedError);
		await expect(opened).rejects.toMatchObject({ reason: { code: "failed", message: "source write failed" } });

		expect(currentSession()).toBe(source.session);
		expect(client.conversation).toBe(source.id);
		expect(harness.host.list()).toEqual([source]);
		expect(shutdowns).toEqual([]);
		expect(acknowledged(source.session.sessionManager.getEntries())).toBe(false);
		// The source still admits work.
		await source.session.prompt("still here");
		expect(source.session.messages.at(-1)?.role).toBe("assistant");
	});
});
