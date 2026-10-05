import { describe, expect, test, vi } from "vitest";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type * as SessionIntents from "../../src/core/host/session-intents.ts";
import {
	type IntentContext,
	type IntentServices,
	intentRegistry,
	LOCAL_INTENT_PROFILE,
} from "../../src/core/protocol/intents/index.ts";
import type { ReviewWorkflowResult } from "../../src/core/review.ts";
import type { ParsedReview } from "../../src/core/review-report.ts";
import {
	acknowledgeReviewRun,
	appendReviewRun,
	getReviewRun,
	type ReviewRunRecord,
} from "../../src/core/review-state.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { SessionWriter } from "../../src/core/session-writer.ts";

const openNewSession = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/host/session-intents.ts", async (importOriginal) => ({
	...(await importOriginal<typeof SessionIntents>()),
	openNewSession,
}));

function durableRecord(): ReviewRunRecord {
	const firstFinding: ParsedReview["findings"][number] = {
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
		evidenceLocations: [{ path: "src/value.ts", side: "base", startLine: 1, endLine: 3 }],
		verification: {
			outcome: "accepted",
			method: "Exact blob comparison",
			rationale: "The added branch is present.",
			confidence: 0.95,
		},
	};
	return {
		schemaVersion: 1,
		runId: "review:test",
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "uncommitted changes",
			diffCommand: "git diff exact-base..exact-head",
			identity: { kind: "uncommitted", baseTree: "base-tree", headTree: "head-tree" },
			files: [
				{
					path: "src/value.ts",
					baseOid: "base-blob",
					headOid: "head-blob",
					hunkIds: ["hunk-1"],
					reviewable: true,
				},
			],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
		result: {
			completionStatus: "complete",
			summary: "Two issues were independently verified.",
			findings: [
				firstFinding,
				{
					...firstFinding,
					id: "finding-2",
					fingerprint: "b".repeat(64),
					title: "Second issue",
				},
			],
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

function durableBranchRecord(runId = "review:branch"): ReviewRunRecord {
	const record = durableRecord();
	return {
		...record,
		runId,
		workflowAction: "review.branch",
		target: {
			...record.target,
			description: "branch changes vs origin/main",
			diffCommand: "git diff origin/main...HEAD",
			identity: {
				kind: "branch",
				baseTree: "base-tree",
				headTree: "head-tree",
				baseCommit: "base-commit",
				headCommit: "head-commit",
			},
			branchBase: { kind: "remote", remote: "origin", remoteRef: "refs/heads/main" },
		},
	};
}

/** An intent context on a conversation whose session reads and writes `manager`. */
function contextOf(manager: SessionManager, services: IntentServices = {}): IntentContext {
	const session = { sessionId: manager.getSessionId(), sessionManager: manager, sessionWriter: manager.logWriter };
	return {
		target: { session, conversation: {}, host: {}, client: {} } as unknown as IntentContext["target"],
		services,
		profile: LOCAL_INTENT_PROFILE,
	};
}

describe("durable review lifecycle intents", () => {
	test.each([{ acknowledgedAt: undefined }, { acknowledgedAt: 123 }])(
		"seeds all durable findings and preserves acknowledgment without selected ids (acknowledged: $acknowledgedAt)",
		async (testCase) => {
			const manager = SessionManager.inMemory("/workspace");
			await appendReviewRun(manager.logWriter, durableRecord());
			if (testCase.acknowledgedAt !== undefined) {
				await acknowledgeReviewRun(manager.logWriter, "review:test", testCase.acknowledgedAt);
			}
			const replacementManager = SessionManager.inMemory("/workspace");
			const ctx = contextOf(manager);
			openNewSession.mockImplementationOnce(
				async (
					_host: unknown,
					_client: unknown,
					options: {
						setup(writer: SessionWriter): Promise<void>;
						beforeMove(source: HostedConversation): Promise<void>;
					},
				) => {
					await options.setup(replacementManager.logWriter);
					// The source is still the current session, and open, when `beforeMove` runs.
					await options.beforeMove({ session: ctx.target?.session } as unknown as HostedConversation);
					return { cancelled: false, sessionId: replacementManager.getSessionId(), seeded: false };
				},
			);

			const opened = await intentRegistry.invoke(ctx, "review_open_session", { runId: "review:test" });
			expect(opened.conversation).toBe(replacementManager.getSessionId());
			const seedMessages = replacementManager.getBranch().filter((entry) => entry.type === "custom_message");
			expect(seedMessages).toHaveLength(1);
			const seedMessage = seedMessages[0] as { details?: { findings?: Array<{ id: string }> } };
			expect(seedMessage.details?.findings?.map((finding) => finding.id)).toEqual(["finding-1", "finding-2"]);
			const sourceAcknowledgedAt = getReviewRun(manager, "review:test")?.acknowledgedAt;
			expect(sourceAcknowledgedAt).toEqual(expect.any(Number));
			if (testCase.acknowledgedAt !== undefined) expect(sourceAcknowledgedAt).toBe(testCase.acknowledgedAt);
			expect(getReviewRun(replacementManager, "review:test")?.acknowledgedAt).toBe(sourceAcknowledgedAt);
		},
	);

	test("reruns a durable branch through its stored locator and rejects missing locators", async () => {
		const manager = SessionManager.inMemory("/workspace");
		await appendReviewRun(manager.logWriter, durableBranchRecord());
		const runReview = vi.fn(async (): Promise<ReviewWorkflowResult> => ({ status: "cancelled" }));
		const ctx = contextOf(manager, { runReview });

		await expect(
			intentRegistry.invoke(ctx, "review_rerun", { runId: "review:branch", mode: "incremental" }),
		).resolves.toMatchObject({ outcome: { status: "cancelled" } });
		expect(runReview).toHaveBeenCalledWith(
			{
				kind: "branch",
				branchBase: { kind: "remote", remote: "origin", remoteRef: "refs/heads/main" },
			},
			expect.objectContaining({ parentRunId: "review:branch" }),
		);

		const missing = durableBranchRecord("review:missing-locator");
		delete missing.target.branchBase;
		await appendReviewRun(manager.logWriter, missing);
		await expect(intentRegistry.invoke(ctx, "review_rerun", { runId: missing.runId })).rejects.toThrow(
			"Durable branch review run does not retain a base locator.",
		);
	});
});
