/**
 * Durable review intents and queries over protocol frames: a review starts as
 * the conversation's `review` work, whose `work_started` entry its `accepted`
 * names, and the durable run's lifecycle (outcomes, feedback export, fix
 * sessions, acknowledgement, discussion sessions, reruns) runs through
 * `review_*` intents and `review.*` queries; `cancel_work` cancels a run.
 */

import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLoopbackClient, type LoopbackClient, ProtocolRejectedError } from "../src/client/protocol-client.ts";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { convertToLlm, createCustomMessage } from "../src/core/messages.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import type { createReviewSeedMessage } from "../src/core/review-presentation.ts";
import type { ParsedReview } from "../src/core/review-report.ts";
import {
	acknowledgeReviewRun,
	appendReviewRun,
	getReviewRun,
	REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE,
	type ReviewRunRecord,
} from "../src/core/review-state.ts";
import type { SessionManager } from "../src/core/session-manager.ts";
import type { SessionWriter } from "../src/core/session-writer.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone } from "./utilities/remote-phone.ts";
import { presentedMessage } from "./utilities/test-presenters.ts";

function parsedReview(): ParsedReview {
	return {
		completionStatus: "complete",
		summary: "One issue was independently verified.",
		findings: [
			{
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
		overallExplanation: "A verified P2 finding remains.",
	};
}

function durableRecord(runId = "review:test"): ReviewRunRecord {
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
			fileSummary: { totalCount: 1, additions: 3, deletions: 1, inventoryComplete: true },
			files: [
				{
					path: "src/value.ts",
					status: "modified",
					baseOid: "base-blob",
					headOid: "head-blob",
					hunkIds: ["hunk-1"],
					reviewable: true,
					additions: 3,
					deletions: 1,
				},
			],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
		result: parsedReview(),
	};
}

function durablePullRequestRecord(runId = "review:test"): ReviewRunRecord {
	const record = durableRecord(runId);
	return {
		...record,
		workflowAction: "review.pr",
		target: {
			...record.target,
			description: "PR #243",
			diffCommand: "gh pr diff 243",
			identity: {
				kind: "pr",
				baseTree: "base-tree",
				headTree: "head-tree",
				pullRequest: {
					providerId: "github",
					number: 243,
					title: "Compact width UI",
					body: "PRIVATE_PULL_REQUEST_BODY",
					url: "https://example.test/pull/243",
					baseRefName: "main",
					headRefName: "fix/compact-width-ui",
					baseRefOid: "a".repeat(40),
					headRefOid: "b".repeat(40),
					author: {
						login: "review-author",
						avatarUrl: "https://example.test/review-author.png",
					},
					reviewState: "ready",
					mergeability: "mergeable",
					checks: {
						state: "passing",
						totalCount: 2,
						passedCount: 2,
						pendingCount: 0,
						failedCount: 0,
						neutralCount: 0,
						unknownCount: 0,
					},
					observedAt: 1_782_470_400_000,
				},
			},
		},
	};
}

function durableBranchRecord(runId = "review:test"): ReviewRunRecord {
	const record = durableRecord(runId);
	return {
		...record,
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

interface ExecuteOptions {
	prepared: { workflowId: string; action: string };
	sessionWriter?: SessionWriter;
	sanitizeRemoteErrors?: boolean;
	signal?: AbortSignal;
	work?: { progress(progress: { text?: string }): void };
}

type ExecuteResult =
	| { status: "cancelled" }
	| { status: "failed"; errorMessage: string }
	| {
			status: "completed";
			raw: string;
			parsed: ParsedReview;
			findingsCount: number;
			completionStatus: ParsedReview["completionStatus"];
			record: ReviewRunRecord;
	  };

const reviewMocks = vi.hoisted(() => {
	const dispose = vi.fn(async () => {});
	const resolution = {
		description: "uncommitted changes",
		diffCommand: "git diff exact-base..exact-head",
		identity: { kind: "uncommitted", baseTree: "base-tree", headTree: "head-tree" },
		changedFiles: [],
		root: "/workspace",
		readFile: vi.fn(async () => undefined),
		listFiles: vi.fn(async () => []),
		materializeHead: vi.fn(async () => "/tmp/review"),
		dispose,
	};
	return {
		dispose,
		prepareReviewWorkflow: vi.fn(
			async (options: { target: { kind: string }; controls?: object; parentRunId?: string }) => ({
				workflowId: "review:test",
				action: `review.${options.target.kind}`,
				target: options.target,
				controls: {
					scope: [],
					effort: "standard",
					includeOptional: false,
					scopeMode: "incremental",
					...options.controls,
				},
				resolution,
				model: { id: "test-model", provider: "test" },
				verifierModel: { id: "verify-model", provider: "test" },
				startedAt: 1,
				incrementalPlan: {
					mode: "full",
					changedPaths: [],
					priorOpenFindings: [],
					suppressedDismissedFingerprints: [],
				},
			}),
		),
		executeReviewWorkflow: vi.fn(async (options: ExecuteOptions): Promise<ExecuteResult> => {
			options.work?.progress({ text: "Discovery pass: review_file" });
			const record = durableRecord(options.prepared.workflowId);
			if (options.sessionWriter) await appendReviewRun(options.sessionWriter, record);
			return {
				status: "completed" as const,
				raw: record.result?.summary ?? "",
				parsed: record.result!,
				findingsCount: 1,
				completionStatus: record.result!.completionStatus,
				record,
			};
		}),
	};
});

vi.mock("../src/core/review.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/review.ts")>();
	return {
		...actual,
		prepareReviewWorkflow: reviewMocks.prepareReviewWorkflow,
		executeReviewWorkflow: reviewMocks.executeReviewWorkflow,
	};
});

type SeedMessage = ReturnType<typeof createReviewSeedMessage>;

/** The review fix messages a conversation's log was seeded with. */
function seedsOf(conversation: HostedConversation): SeedMessage[] {
	return conversation.session.sessionManager.getBranch().flatMap((entry) =>
		entry.type === "custom_message" && entry.customType === "review"
			? [
					{
						customType: "review",
						content: entry.content as string,
						display: true,
						details: entry.details as unknown as SeedMessage["details"],
					},
				]
			: [],
	);
}

function runOf(conversation: HostedConversation, runId = "review:test"): ReturnType<typeof getReviewRun> {
	return getReviewRun(conversation.session.sessionManager, runId);
}

function acknowledgments(manager: SessionManager): number {
	return manager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE)
		.length;
}

interface ReviewFixture {
	harness: HostHarness;
	/** The conversation the client started on; it stays open after the client leaves it. */
	source: HostedConversation;
	client: LoopbackClient;
	/** An open conversation by id. */
	conversation(id: string | undefined): HostedConversation;
	/** An extension cancels the next session the client's intents open. */
	cancelNextOpen(): void;
	/** The next session the client's intents open fails to open. */
	failNextOpen(error: Error): void;
}

afterEach(() => {
	reviewMocks.prepareReviewWorkflow.mockClear();
	reviewMocks.executeReviewWorkflow.mockClear();
	reviewMocks.dispose.mockClear();
});

describe("durable review intents over protocol frames", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/** A conversation holding `records`, and a local client on it. */
	async function setup(records: ReviewRunRecord[] = []): Promise<ReviewFixture> {
		let cancelOpen = false;
		let failOpen: Error | undefined;
		const harness = await createHostHarness({
			whenUnattached: "keep",
			extension: (volt) => {
				volt.on("session_before_switch", () => {
					if (!cancelOpen) return undefined;
					cancelOpen = false;
					return { cancel: true };
				});
			},
			beforeCreate: () => {
				const error = failOpen;
				failOpen = undefined;
				if (error) throw error;
			},
		});
		cleanups.push(() => harness.cleanup());
		const source = await harness.openStartup();
		for (const record of records) await appendReviewRun(source.session.sessionWriter, record);
		const client = await createLoopbackClient(harness.host, source, { anchor: false });
		cleanups.push(() => client.stop());
		return {
			harness,
			source,
			client,
			conversation(id) {
				const conversation = id === undefined ? undefined : harness.host.get(id);
				if (!conversation) throw new Error(`Conversation ${id} is not open`);
				return conversation;
			},
			cancelNextOpen: () => {
				cancelOpen = true;
			},
			failNextOpen: (error) => {
				failOpen = error;
			},
		};
	}

	/**
	 * A paired device on the remote profile starts a review of uncommitted
	 * changes; the review's work reports progress, then waits for `release`.
	 */
	async function startRemoteReview() {
		const gate = Promise.withResolvers<void>();
		reviewMocks.executeReviewWorkflow.mockImplementationOnce(async (options: ExecuteOptions) => {
			options.work?.progress({ text: "Reviewing." });
			await gate.promise;
			const record = durableRecord();
			if (options.sessionWriter) await appendReviewRun(options.sessionWriter, record);
			return {
				status: "completed",
				raw: record.result!.summary,
				parsed: record.result!,
				findingsCount: 1,
				completionStatus: record.result!.completionStatus,
				record,
			};
		});
		const { harness, source } = await setup();
		cleanups.push(async () => gate.resolve());
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation: source,
			stream: pair.host,
			grant: createIrohRemotePresetAccess("coding").rpcGrant,
			redaction: { workspacePath: source.cwd },
			redirect: {},
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await phone.close();
			await connection.close().catch(() => undefined);
		});
		await phone.hello();
		await phone.subscribe(source.id);
		const accepted = await phone.intent("review", { target: "uncommitted" });
		const isProgress = (frame: HostFrame): frame is HostFrame =>
			frame.type === "live" &&
			frame.items.some(
				(item) =>
					item.type === "set" &&
					item.key === "work/review:test" &&
					item.value.kind === "work" &&
					item.value.progress?.text === "Reviewing.",
			);
		await phone.waitFor(isProgress);
		return { source, phone, accepted, isProgress, release: () => gate.resolve() };
	}

	test("starts a remote review as review work with remote failures sanitized", async () => {
		const { source, accepted, release } = await startRemoteReview();
		expect(accepted).toMatchObject({ type: "accepted", result: { workId: "review:test" } });
		expect(reviewMocks.executeReviewWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({ sanitizeRemoteErrors: true }),
		);
		expect(source.work.get("review:test")).toMatchObject({
			kind: "review",
			title: "Review uncommitted changes",
			delivery: "none",
			state: "running",
		});
		release();
		await vi.waitFor(() =>
			expect(source.work.get("review:test")).toMatchObject({
				outcome: "completed",
				result: {
					summary: "Review complete: 1 finding.",
					data: { target: "uncommitted changes", findingsCount: 1, completionStatus: "complete" },
				},
			}),
		);
	});

	test("names the review's work_started entry among the accepted ordinals", async () => {
		const { source, accepted, release } = await startRemoteReview();
		const started = source.work.get("review:test")?.startedOrdinal;
		if (started === undefined) throw new Error("Expected the review's work_started entry");
		expect(accepted).toMatchObject({ type: "accepted" });
		expect(accepted.type === "accepted" ? accepted.ordinals : []).toContain(started);
		release();
	});

	test("hydrates durable paginated results and exposes structured context coverage without raw GitHub text", async () => {
		const newer = { ...durablePullRequestRecord("review:newer"), endedAt: 3 };
		newer.target.context = {
			captureStatus: "complete",
			linkedIssueCount: 2,
			discussionEntryCount: 5,
			renderedLinkedIssueCount: 2,
			renderedDiscussionEntryCount: 5,
			renderedBytes: 1_024,
			limitationCodes: [],
			fingerprint: "c".repeat(64),
		};
		newer.result!.coverage.context = {
			captureStatus: "complete",
			linkedIssueCount: 2,
			discussionEntryCount: 5,
			limitationCodes: [],
			fingerprint: "c".repeat(64),
			discoveryInspectionComplete: true,
			verificationInspectionComplete: true,
		};
		const { client } = await setup([durableRecord("review:older"), newer]);

		const list = await client.query("review.runs", { limit: 1 });
		expect(list.runs).toHaveLength(1);
		expect(list.runs[0]?.target).toMatchObject({
			pullRequest: {
				provider: "github",
				number: 243,
				title: "Compact width UI",
				author: { login: "review-author", avatarUrl: "https://example.test/review-author.png" },
				reviewState: "ready",
				mergeability: "mergeable",
				checks: { state: "passing", totalCount: 2 },
			},
			files: {
				totalCount: 1,
				projectedCount: 0,
				omittedCount: 1,
				additions: 3,
				deletions: 1,
				isComplete: false,
				items: [],
			},
		});
		expect(JSON.stringify(list)).not.toContain("PRIVATE_PULL_REQUEST_BODY");
		if (!list.nextCursor) throw new Error("Expected a next page");
		await expect(client.query("review.runs", { cursor: list.nextCursor, limit: 1 })).resolves.toMatchObject({
			runs: [{ runId: "review:older" }],
		});
		await expect(client.query("review.runs", { limit: 51 })).rejects.toMatchObject({
			code: "invalid_input",
			message: expect.stringContaining("limit"),
		});

		const result = await client.query("review.result", { runId: "review:newer" });
		expect(result).toMatchObject({
			runId: "review:newer",
			completionStatus: "complete",
			overallCorrectness: "incorrect",
			target: {
				pullRequest: { provider: "github", number: 243, title: "Compact width UI" },
				files: {
					totalCount: 1,
					projectedCount: 1,
					isComplete: true,
					items: [{ path: "src/value.ts", status: "modified", additions: 3, deletions: 1 }],
				},
				context: { linkedIssueCount: 2, discussionEntryCount: 5, fingerprint: "c".repeat(64) },
			},
			coverage: {
				context: {
					discoveryInspectionComplete: true,
					verificationInspectionComplete: true,
				},
			},
		});
		const serialized = JSON.stringify(result);
		expect(serialized).toContain("changeLocation");
		expect(serialized).toContain("PRIVATE_PULL_REQUEST_BODY");
		expect(serialized).not.toContain('"file"');
		expect(serialized).not.toContain("filesReviewed");
		expect(serialized).not.toContain("PRIVATE_LINKED_ISSUE_AND_REVIEW_TEXT");
	});

	test("records local outcomes, seeds explicit selections, and opens every finding without a selection", async () => {
		const record = durableRecord();
		record.result!.findings.push({
			...parsedReview().findings[0]!,
			id: "finding-2",
			fingerprint: "b".repeat(64),
			title: "Second issue",
		});
		const { client, source, conversation } = await setup([record]);

		await expect(
			client.intent("review_record_finding_outcome", {
				runId: "review:test",
				findingId: "finding-1",
				status: "dismissed",
				reason: "false_positive",
				note: "Reproduced expected behavior",
			}),
		).resolves.toMatchObject({ result: { findingId: "finding-1", status: "dismissed" } });
		const exported = await client.intent("review_export_feedback", {});
		expect(exported.result).toMatchObject({
			schemaVersion: 1,
			outcomes: [{ findingId: "finding-1", status: "dismissed" }],
		});

		const opened = await client.intent("review_open_session", { runId: "review:test", findingIds: ["finding-2"] });
		const target = conversation(opened.conversation);
		expect(target).not.toBe(source);
		const seeds = JSON.stringify(seedsOf(target));
		expect(seeds).toContain("finding-2");
		expect(seeds).not.toContain("finding-1");
		expect(seeds).not.toContain("PRIVATE_LINKED_ISSUE_AND_REVIEW_TEXT");
		expect(
			target.session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "volt.review.run"),
		).toBe(true);
		expect(runOf(source)?.acknowledgedAt).toBeUndefined();
		const openedAcknowledgedAt = runOf(target)?.acknowledgedAt;
		expect(openedAcknowledgedAt).toEqual(expect.any(Number));
		// The client is on the fix session now: reads and intents act on it.
		await expect(client.query("review.result", { runId: "review:test" })).resolves.toMatchObject({
			runId: "review:test",
			acknowledgedAt: openedAcknowledgedAt,
			findings: expect.any(Array),
		});

		const all = await client.intent("review_open_session", { runId: "review:test" });
		const fixAll = JSON.stringify(seedsOf(conversation(all.conversation)));
		expect(fixAll).toContain("finding-1");
		expect(fixAll).toContain("finding-2");
		expect(runOf(conversation(all.conversation))?.acknowledgedAt).toBe(openedAcknowledgedAt);
	});

	test("opens an explicit empty selection without claiming the full run is clean", async () => {
		const { client, conversation } = await setup([durableRecord()]);

		const opened = await client.intent("review_open_session", { runId: "review:test", findingIds: [] });
		const target = conversation(opened.conversation);
		const [seed] = seedsOf(target);
		expect(seed?.details.findings).toEqual([]);
		expect(seed?.details.summary).toContain("Selected findings: 0 of 1 retained entries");
		expect(seed?.details.summary).toContain("1 active P0-P2 finding is outside this selection");
		expect(seed?.content).toContain("No findings were selected for this session");
		expect(seed?.content).not.toContain("no verified issues worth flagging");
		expect(runOf(target)?.result?.findings).toHaveLength(1);
	});

	test.each(["fixed", "dismissed"] as const)(
		"reopens the sole %s finding with historical verdicts and current status",
		async (status) => {
			const { client, conversation } = await setup([durableRecord()]);
			await client.intent("review_record_finding_outcome", {
				runId: "review:test",
				findingId: "finding-1",
				status,
				...(status === "dismissed" ? { reason: "false_positive" as const } : {}),
			});

			const opened = await client.intent("review_open_session", { runId: "review:test" });
			const target = conversation(opened.conversation);
			const [seed] = seedsOf(target);
			if (!seed) throw new Error("Expected the review seed message");
			expect(seed.details.summary).toContain("0 active P0-P2 findings; 1 fixed/dismissed");
			expect(seed.details.summary).not.toContain("No verified P0-P2 findings in the selected change");
			expect(seed.details.findings[0]?.status).toBe(status);
			initTheme("dark");
			const message = createCustomMessage(
				seed.customType,
				seed.content,
				true,
				{ summary: seed.details.summary },
				new Date(0).toISOString(),
			);
			const view = presentedMessage(message);
			expect(view.render(100).lines.map(stripAnsi).join("\n")).toContain("0 active P0-P2 findings");
			view.setExpanded(true);
			const expanded = view.render(100).lines.map(stripAnsi).join("\n");
			expect(expanded).toContain("Original review conclusion");
			expect(expanded).toContain("Overall: incorrect");
			expect(expanded).toContain(`Status: ${status}`);
			expect(JSON.stringify(convertToLlm([message]))).toContain("Original review conclusion");
			expect(runOf(target)?.result).toMatchObject({
				overallCorrectness: "incorrect",
				findings: [{ status }],
			});
		},
	);

	test("acknowledges full opens in source and target while retaining durable results", async () => {
		const { client, source, conversation } = await setup([durableRecord()]);

		const opened = await client.intent("review_open_session", { runId: "review:test" });
		const target = conversation(opened.conversation);
		const sourceRun = runOf(source);
		const targetRun = runOf(target);
		expect(sourceRun?.acknowledgedAt).toEqual(expect.any(Number));
		expect(targetRun?.acknowledgedAt).toBe(sourceRun?.acknowledgedAt);
		expect(sourceRun?.result?.findings).toHaveLength(1);
		expect(targetRun?.result?.findings).toHaveLength(1);

		await expect(client.query("review.runs", {})).resolves.toMatchObject({
			runs: [{ runId: "review:test", acknowledgedAt: sourceRun?.acknowledgedAt }],
		});
		await expect(client.query("review.result", { runId: "review:test" })).resolves.toMatchObject({
			runId: "review:test",
			acknowledgedAt: sourceRun?.acknowledgedAt,
			findings: expect.any(Array),
		});
	});

	test("explicit acknowledgment is idempotent and unsuccessful opens preserve the source", async () => {
		const { harness, client, source, cancelNextOpen, failNextOpen } = await setup([durableRecord()]);

		const first = await client.intent("review_acknowledge", { runId: "review:test" });
		const acknowledgedAt = first.result?.acknowledgedAt;
		expect(acknowledgedAt).toEqual(expect.any(Number));
		await expect(client.intent("review_acknowledge", { runId: "review:test" })).resolves.toMatchObject({
			result: { runId: "review:test", acknowledgedAt },
		});
		expect(acknowledgments(source.session.sessionManager)).toBe(1);

		const unacknowledged = durableRecord("review:unacknowledged");
		await appendReviewRun(source.session.sessionWriter, unacknowledged);
		cancelNextOpen();
		const cancelled = await client.intent("review_open_session", { runId: unacknowledged.runId });
		expect(cancelled.result).toEqual({ cancelled: true });
		expect(cancelled.conversation).toBeUndefined();
		expect(runOf(source, unacknowledged.runId)?.acknowledgedAt).toBeUndefined();

		failNextOpen(new Error("seed failed"));
		const failed = client.intent("review_open_session", { runId: unacknowledged.runId });
		await expect(failed).rejects.toBeInstanceOf(ProtocolRejectedError);
		await expect(failed).rejects.toMatchObject({ reason: { code: "failed", message: "seed failed" } });
		expect(runOf(source, unacknowledged.runId)?.acknowledgedAt).toBeUndefined();
		expect(client.conversation).toBe(source.id);
		expect(harness.host.list()).toEqual([source]);
	});

	test("preserves a durable review when starting a clear discussion session", async () => {
		const { harness, client, source, conversation } = await setup([durableRecord()]);
		const { acknowledgedAt } = await acknowledgeReviewRun(source.session.sessionWriter, "review:test");

		const moved = await client.intent("new_session", { preserveReviewRunId: "review:test" });
		const target = conversation(moved.conversation);
		expect(target).not.toBe(source);
		expect(runOf(target)).toMatchObject({
			runId: "review:test",
			acknowledgedAt,
			result: { completionStatus: "complete" },
		});

		// The preserved run reruns from the discussion session.
		await expect(client.intent("review_rerun", { runId: "review:test" })).resolves.toMatchObject({
			result: { workId: "review:test" },
		});
		await vi.waitFor(() => expect(target.work.get("review:test")?.outcome).toBe("completed"));

		await expect(client.intent("new_session", { preserveReviewRunId: "review:missing" })).rejects.toMatchObject({
			reason: { code: "failed", message: "Unknown review run: review:missing" },
		});
		expect(harness.host.list()).toHaveLength(2);
		expect(client.conversation).toBe(target.id);
	});

	test("accepts an incremental durable branch rerun through its host-only locator", async () => {
		const { client } = await setup([durableBranchRecord()]);
		const list = await client.query("review.runs", {});
		expect(list.runs).toHaveLength(1);
		expect(JSON.stringify(list)).not.toContain("branchBase");

		await expect(client.intent("review_rerun", { runId: "review:test", mode: "incremental" })).resolves.toMatchObject(
			{ result: { workId: "review:test" } },
		);
		await vi.waitFor(() => expect(reviewMocks.executeReviewWorkflow).toHaveBeenCalled());
		expect(reviewMocks.prepareReviewWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				target: {
					kind: "branch",
					branchBase: { kind: "remote", remote: "origin", remoteRef: "refs/heads/main" },
				},
				parentRunId: "review:test",
				controls: expect.objectContaining({ scopeMode: "incremental" }),
			}),
		);
	});

	test("cancels a review's work and reaches a terminal state", async () => {
		reviewMocks.executeReviewWorkflow.mockImplementationOnce(async (options: ExecuteOptions) => {
			await new Promise<void>((resolve) =>
				options.signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			return { status: "cancelled" as const };
		});
		const { client, source } = await setup();

		await expect(client.intent("review", { target: "uncommitted" })).resolves.toMatchObject({
			result: { workId: "review:test" },
		});
		await vi.waitFor(() => expect(reviewMocks.executeReviewWorkflow).toHaveBeenCalled());
		await client.intent("cancel_work", { workId: "review:test" });
		await vi.waitFor(() => expect(source.work.get("review:test")?.outcome).toBe("cancelled"));
	});
});
