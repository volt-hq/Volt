import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewSeedMessage, type ReviewUsageSnapshot, runReview } from "../../src/core/review.ts";
import { STATIC_REVIEW_LIMITATION } from "../../src/core/review-presentation.ts";
import type { ReviewCandidate, ReviewCandidateReport, ReviewVerificationReport } from "../../src/core/review-report.ts";
import { type ReviewSnapshot, resolveReviewSnapshot } from "../../src/core/review-snapshot.ts";
import { createReviewRunRecord } from "../../src/core/review-state.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const PRIVATE = "private-github-reasoning-budget-marker";
const location = { path: "budget.ts", side: "head" as const, startLine: 1, endLine: 1 };
const empty: ReviewCandidateReport = { summary: PRIVATE, candidates: [], limitations: [] };
const candidate: ReviewCandidate = {
	candidateId: "budget",
	title: PRIVATE,
	body: PRIVATE,
	trigger: PRIVATE,
	impact: PRIVATE,
	category: "correctness",
	rootCauseKey: "output-budget",
	priority: 2,
	confidence: 0.9,
	changeLocation: location,
	evidenceLocations: [],
};

function verification(incomplete: boolean, candidates: ReviewCandidate[] = []): ReviewVerificationReport {
	return {
		summary: PRIVATE,
		assessment: incomplete ? "incomplete" : "complete",
		...(incomplete ? { challenge: PRIVATE, challengeLocations: [location] } : {}),
		decisions: candidates.map((entry) => ({
			candidateId: entry.candidateId,
			outcome: "accept",
			method: PRIVATE,
			rationale: PRIVATE,
			confidence: 0.9,
		})),
		priorFindingDecisions: [],
		limitations: [],
	};
}

function analysis(
	tool: "report_review_candidates" | "report_review_verification",
	report: ReviewCandidateReport | ReviewVerificationReport,
	withContext = true,
): FauxResponseStep[] {
	return [
		...(withContext ? [fauxAssistantMessage(fauxToolCall("review_context", {}), { stopReason: "toolUse" })] : []),
		fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("review_diff", { path: "budget.ts" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall(tool, report as never), { stopReason: "toolUse" }),
	];
}

function presentation(challenge: boolean, capture: (messages: string, tools: string[]) => void): FauxResponseStep[] {
	return [
		(context) => {
			capture(JSON.stringify(context.messages), context.tools?.map((tool) => tool.name) ?? []);
			return fauxAssistantMessage(fauxToolCall("review_diff", { path: "budget.ts" }), { stopReason: "toolUse" });
		},
		(context) => {
			const messages = JSON.stringify(context.messages);
			const ids = [...messages.matchAll(/presentationId.{0,20}?([0-9a-f]{8}-[0-9a-f-]{27,})/gi)].map(
				(match) => match[1],
			);
			return fauxAssistantMessage(
				fauxToolCall("report_review_presentations", {
					findings: [...new Set(ids)].map((presentationId) => ({
						presentationId,
						title: "Output budget can be consumed by reasoning",
						body: "The output allowance is smaller than the reasoning budget.",
						trigger: "Compaction uses high reasoning.",
						impact: "No usable summary is produced.",
						category: "correctness",
						rootCauseKey: "output-budget",
						rationale: "The changed request caps all generated output.",
					})),
					...(challenge
						? {
								challenge: {
									explanation: "The output cap may leave no space for a summary after reasoning.",
									nextStep: "Check provider payloads and test a reasoning-only length stop.",
								},
							}
						: {}),
				}),
				{ stopReason: "toolUse" },
			);
		},
	];
}

describe("review completeness recovery", () => {
	let harness: Harness;
	let snapshot: ReviewSnapshot;
	beforeEach(async () => {
		vi.stubEnv("VOLT_REVIEW_PRIVATE_DIAGNOSTICS", "0");
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		for (const args of [
			["init", "--initial-branch=main"],
			["config", "user.email", "review@example.com"],
			["config", "user.name", "Review Test"],
		]) {
			const result = spawnSync("git", args, { cwd: harness.tempDir, encoding: "utf8" });
			if (result.status !== 0) throw new Error(result.stderr);
		}
		writeFileSync(
			join(harness.tempDir, "budget.ts"),
			"export const output = 8192;\nexport const reasoning = 'minimal';\n",
		);
		for (const args of [
			["add", "budget.ts"],
			["commit", "-m", "initial"],
		]) {
			const result = spawnSync("git", args, { cwd: harness.tempDir, encoding: "utf8" });
			if (result.status !== 0) throw new Error(result.stderr);
		}
		writeFileSync(
			join(harness.tempDir, "budget.ts"),
			"export const output = 4096;\nexport const reasoning = 'high';\n",
		);
		const resolved = await resolveReviewSnapshot({ kind: "uncommitted" }, harness.tempDir, {
			maxCommitRefBytes: 1024,
			maxPullRequestNumber: 2147483647,
		});
		if ("error" in resolved) throw new Error(resolved.error);
		snapshot = resolved;
		snapshot.codeHostContext = {
			manifest: {
				status: "complete",
				capturedAt: "2026-01-01T00:00:00Z",
				linkedIssueCount: 0,
				discussionEntryCount: 1,
				renderedLinkedIssueCount: 0,
				renderedDiscussionEntryCount: 1,
				renderedBytes: PRIVATE.length,
				limitations: [],
				fingerprint: "f".repeat(64),
			},
			linkedIssues: [],
			discussionEntries: [{ id: "comment", kind: "pr-comment", body: PRIVATE }],
			rendered: PRIVATE,
		};
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await snapshot?.dispose();
		await harness?.cleanupAsync();
	});

	function run(extra: Partial<Parameters<typeof runReview>[0]> = {}) {
		return runReview({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved: snapshot,
			workflowId: "review:budget",
			workflowAction: "review.pr",
			controls: { scopeMode: "full" },
			...extra,
		});
	}

	it("recovers an omitted issue through fresh discovery, verification, and blind presentation", async () => {
		const presentations: string[] = [];
		const usage: ReviewUsageSnapshot[] = [];
		let followUpContext = "";
		const followUp = analysis("report_review_candidates", { ...empty, candidates: [candidate] });
		followUp[0] = (context) => {
			followUpContext = JSON.stringify(context.messages);
			return fauxAssistantMessage(fauxToolCall("review_context", {}), { stopReason: "toolUse" });
		};
		harness.setResponses([
			...analysis("report_review_candidates", empty),
			...analysis("report_review_verification", verification(true)),
			...followUp,
			...analysis("report_review_verification", verification(false, [candidate])),
			...presentation(false, (messages, tools) => {
				presentations.push(messages);
				expect(tools).not.toContain("review_context");
			}),
		]);
		const result = await run({ onUsage: (value) => usage.push(value) });
		expect(result.errorMessage).toBeUndefined();
		expect(result.parsed).toMatchObject({
			completionStatus: "complete",
			overallCorrectness: "incorrect",
			findings: [{ title: "Output budget can be consumed by reasoning", changeLocation: location }],
		});
		expect(result.parsed?.verificationChallenge).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain(PRIVATE);
		expect(followUpContext).toContain(PRIVATE);
		expect(followUpContext).toContain(snapshot.identity.headTree);
		expect(followUpContext).not.toContain("Candidate report accepted");
		expect(presentations).toHaveLength(1);
		expect(presentations[0]).not.toContain(PRIVATE);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.faux.state.callCount).toBe(18);
		for (let i = 1; i < usage.length; i++)
			expect(usage[i]!.totals.input).toBeGreaterThanOrEqual(usage[i - 1]!.totals.input);
	});

	it("retains initial candidates when follow-up discovery supplies only additions", async () => {
		let candidateIds: string[] = [];
		const second = {
			...candidate,
			rootCauseKey: "reasoning-level",
			changeLocation: { ...location, startLine: 2, endLine: 2 },
		};
		const followUpVerification = analysis("report_review_verification", verification(false));
		followUpVerification[3] = (context) => {
			const prompt = context.messages.find((message) => message.role === "user");
			const text = getMessageText(prompt);
			const match = /<validated_candidates>(.*?)<\/validated_candidates>/.exec(text);
			if (!match) throw new Error("Missing candidate input");
			const decoded = match[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
			const candidates = JSON.parse(decoded) as ReviewCandidate[];
			candidateIds = candidates.map((entry) => entry.candidateId);
			return fauxAssistantMessage(
				fauxToolCall("report_review_verification", verification(false, candidates) as never),
				{ stopReason: "toolUse" },
			);
		};
		harness.setResponses([
			...analysis("report_review_candidates", { ...empty, candidates: [candidate] }),
			...analysis("report_review_verification", verification(true, [candidate])),
			...analysis("report_review_candidates", { ...empty, candidates: [second] }),
			...followUpVerification,
			...presentation(false, () => {}),
		]);
		const result = await run();
		expect(result.errorMessage).toBeUndefined();
		expect(result.parsed?.findings).toHaveLength(2);
		expect(new Set(candidateIds).size).toBe(2);
		expect(candidateIds).toContain("budget");
	});

	it("bounds recovery and publishes an unverified code explanation without private analysis", async () => {
		let blindContext = "";
		const events: unknown[] = [];
		harness.setResponses([
			...analysis("report_review_candidates", empty),
			...analysis("report_review_verification", verification(true)),
			...analysis("report_review_candidates", empty),
			...analysis("report_review_verification", verification(true)),
			...presentation(true, (messages, tools) => {
				blindContext = messages;
				expect(tools).not.toContain("review_context");
				expect(tools).not.toContain("bash");
			}),
		]);
		const result = await run({ onEvent: (event) => events.push(event) });
		expect(result.errorMessage).toBeUndefined();
		expect(result.parsed).toMatchObject({ completionStatus: "incomplete", findings: [] });
		expect(result.parsed?.overallCorrectness).toBeUndefined();
		expect(result.parsed?.verificationChallenge).toContain("Unverified concern: The output cap");
		expect(result.parsed?.verificationChallenge).toContain("Next step: Check provider payloads");
		expect(result.parsed?.verificationChallenge).toContain("budget.ts:1-1 (head)");
		expect(result.parsed?.coverage.residualRisk).toContain(STATIC_REVIEW_LIMITATION);
		expect(blindContext).not.toContain(PRIVATE);
		expect(JSON.stringify({ result, events })).not.toContain(PRIVATE);
		const record = createReviewRunRecord({
			workflowId: "review:budget",
			workflowAction: "review.pr",
			snapshot,
			startedAt: 1,
			status: "incomplete",
			controls: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
			result: result.parsed,
		});
		const seed = createReviewSeedMessage(record);
		expect(seed.details.summary).toContain("Unverified concern");
		expect(seed.content).toContain("reasoning-only length stop");
		expect(seed.details.findings).toEqual([]);
		expect(harness.faux.state.callCount).toBe(18);
	});

	it.each(["discovery", "verification"] as const)(
		"retains verified findings when follow-up %s fails",
		async (stage) => {
			harness.setResponses([
				...analysis("report_review_candidates", { ...empty, candidates: [candidate] }),
				...analysis("report_review_verification", verification(true, [candidate])),
				...(stage === "verification" ? analysis("report_review_candidates", empty) : []),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: PRIVATE }),
				...presentation(false, () => {}),
				...presentation(true, () => {}),
			]);
			const result = await run();
			expect(result.errorMessage).toBeUndefined();
			expect(result.parsed?.findings).toHaveLength(1);
			expect(result.parsed?.completionStatus).toBe("incomplete");
			expect(result.parsed?.verificationChallenge).toContain(`Review ${stage} model request failed`);
			expect(JSON.stringify(result)).not.toContain(PRIVATE);
		},
	);

	it("does not discard verification decisions when optional challenge anchors are invalid", async () => {
		const invalid = {
			...verification(true, [candidate]),
			challengeLocations: [{ ...location, path: `${PRIVATE}.ts` }],
		};
		harness.setResponses([
			...analysis("report_review_candidates", { ...empty, candidates: [candidate] }),
			...analysis("report_review_verification", invalid),
			...analysis("report_review_candidates", empty),
			...analysis("report_review_verification", invalid),
			...presentation(false, () => {}),
		]);
		const result = await run();
		expect(result.errorMessage).toBeUndefined();
		expect(result.parsed?.findings).toHaveLength(1);
		expect(result.parsed?.verificationChallenge).toContain("did not supply a validated changed-code location");
		expect(JSON.stringify(result)).not.toContain(PRIVATE);
		expect(harness.faux.state.callCount).toBe(18);
	});

	it("does not require local findings to pass optional concern presentation", async () => {
		delete snapshot.codeHostContext;
		const localCandidate = { ...candidate, title: "Keep the output budget" };
		const usage: ReviewUsageSnapshot[] = [];
		harness.setResponses([
			...analysis("report_review_candidates", { ...empty, candidates: [localCandidate] }, false),
			...analysis("report_review_verification", verification(true, [localCandidate]), false),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Follow-up provider failure" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Presentation provider failure" }),
		]);
		const result = await run({ onUsage: (value) => usage.push(value) });
		expect(result.errorMessage).toBeUndefined();
		expect(result.parsed?.findings).toMatchObject([
			{ title: localCandidate.title, verification: { outcome: "accepted" } },
		]);
		expect(result.parsed?.verificationChallenge).toContain("budget.ts:1-1");
		expect(result.parsed?.verificationChallenge).toContain("Review presentation model request failed");
		expect(harness.faux.state.callCount).toBe(8);
		for (let i = 1; i < usage.length; i++)
			expect(usage[i]!.totals.input).toBeGreaterThanOrEqual(usage[i - 1]!.totals.input);
	});

	it("can resolve an unsubstantiated challenge without inventing a finding", async () => {
		harness.setResponses([
			...analysis("report_review_candidates", empty),
			...analysis("report_review_verification", verification(true)),
			...analysis("report_review_candidates", empty),
			...analysis("report_review_verification", verification(false)),
		]);
		const result = await run();
		expect(result.parsed).toMatchObject({
			completionStatus: "complete",
			findings: [],
			overallCorrectness: "correct",
		});
		expect(result.parsed?.verificationChallenge).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(16);
	});

	it("keeps validated locations and a recovery action if challenge presentation fails", async () => {
		harness.setResponses([
			...analysis("report_review_candidates", empty),
			...analysis("report_review_verification", verification(true)),
			...analysis("report_review_candidates", empty),
			...analysis("report_review_verification", verification(true)),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: PRIVATE }),
		]);
		const result = await run();
		expect(result.errorMessage).toBeUndefined();
		expect(result.parsed?.verificationChallenge).toContain("budget.ts:1-1");
		expect(result.parsed?.verificationChallenge).toContain("Review presentation model request failed");
		expect(result.parsed?.findings).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(PRIVATE);
	});

	it("lets cancellation stop follow-up without starting presentation", async () => {
		const controller = new AbortController();
		harness.setResponses([
			...analysis("report_review_candidates", empty),
			...analysis("report_review_verification", verification(true)),
			() => {
				controller.abort();
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: PRIVATE });
			},
		]);
		const result = await run({ signal: controller.signal });
		expect(result).toEqual({ aborted: true, raw: "" });
		expect(harness.faux.state.callCount).toBe(9);
	});
});
