import type { JsonValue } from "@hansjm10/volt-ai";
import { getKeybindings, setKeybindings, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { convertToLlm, createCustomMessage } from "../src/core/messages.ts";
import { createReviewSeedMessage, STATIC_REVIEW_LIMITATION } from "../src/core/review-presentation.ts";
import type { ReviewFinding } from "../src/core/review-report.ts";
import type { ReviewRunRecord } from "../src/core/review-state.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function finding(
	id: string,
	status: ReviewFinding["status"] = "open",
	priority: ReviewFinding["priority"] = 2,
): ReviewFinding {
	return {
		id,
		status,
		priority,
		fingerprint: id.padEnd(64, "a"),
		title: `Handle empty queue ${id}`,
		body: "The new path reads a missing queue entry.",
		trigger: "The queue is empty.",
		impact: "The request fails.",
		category: "correctness",
		rootCauseKey: "empty-queue",
		confidence: 0.92,
		changeLocation: { path: "src/queue.ts", side: "head", startLine: 4, endLine: 5 },
		evidenceLocations: [{ path: "test/queue.test.ts", side: "base", startLine: 10, endLine: 11 }],
		verification: {
			outcome: "accepted",
			method: "Inspected the changed branch.",
			rationale: "The array can be empty.",
			confidence: 0.92,
		},
	};
}

function record(findings: ReviewFinding[] = []): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId: "review:sample",
		workflowAction: "review.pr",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "PR #346 (prefer cache-preserving single-pass compaction)",
			diffCommand: "gh pr diff 346",
			identity: {
				kind: "pr",
				baseTree: "b".repeat(40),
				headTree: "c".repeat(40),
				headCommit: "eec0db3c22ef60f5df65f236200fd0c2809f4198",
				pullRequest: {
					providerId: "github",
					baseRefOid: "b".repeat(40),
					headRefOid: "eec0db3c22ef60f5df65f236200fd0c2809f4198",
					number: 346,
					title: "prefer cache-preserving single-pass compaction",
					body: "",
					url: "https://github.com/volt-hq/Volt/pull/346",
					baseRefName: "main",
					headRefName: "fix/compaction",
				},
			},
			files: [],
		},
		options: { scope: [], scopeMode: "full", effort: "standard", includeOptional: true },
		result: {
			completionStatus: "complete",
			summary: findings.length ? "The review found a defect." : "No candidates were accepted.",
			findings,
			overallCorrectness: findings.some((entry) => entry.priority <= 2) ? "incorrect" : "correct",
			overallExplanation: findings.length
				? "An independently verified finding remains."
				: "No verified P0-P2 findings remain.",
			coverage: {
				changedFileInventoryComplete: true,
				filesInspected: Array.from({ length: 33 }, (_, i) => `src/observed-${i}.ts`),
				hunksInspected: Array.from({ length: 56 }, (_, i) => i.toString().padStart(20, "0")),
				commandsRun: [],
				failedVerificationAttempts: [],
				exclusions: [],
				uncheckedAreas: [],
				residualRisk: [STATIC_REVIEW_LIMITATION],
				modelReportedLimitations: [
					"Discovery reported 1 model limitation(s).",
					"Verification reported 1 model limitation(s).",
				],
			},
		},
	};
}

function component(run: ReviewRunRecord, ids?: readonly string[]) {
	const seed = createReviewSeedMessage(run, ids);
	return new CustomMessageComponent(
		createCustomMessage(
			seed.customType,
			seed.content,
			seed.display,
			JSON.parse(JSON.stringify(seed.details)) as JsonValue,
			new Date(0).toISOString(),
		),
	);
}

function rendered(view: CustomMessageComponent, width = 80): string[] {
	return view.render(width).lines.map(stripAnsi);
}

describe("review presentation", () => {
	const previousKeybindings = getKeybindings();
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => setKeybindings(previousKeybindings));

	it("renders the 33-path/56-hunk clean review in at most ten lines without losing expanded evidence", () => {
		const run = record();
		const original = structuredClone(run);
		const view = component(run);
		const lines = rendered(view);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines.join("\n")).toContain("Review · PR #346 · eec0db3c22ef");
		expect(lines.join("\n")).toContain(STATIC_REVIEW_LIMITATION);
		expect(lines.join("\n")).not.toMatch(
			/Overall:|Files inspected:|Hunks inspected:|model limitation\(s\)|When asked to fix/,
		);
		view.setExpanded(true);
		const expanded = rendered(view).join("\n");
		for (const path of run.result!.coverage.filesInspected) expect(expanded).toContain(path);
		for (const hunk of run.result!.coverage.hunksInspected) expect(expanded).toContain(hunk);
		expect(expanded).toContain("Discovery reported 1 model limitation(s).");
		expect(expanded).toContain("Original review conclusion");
		view.setExpanded(false);
		expect(rendered(view)).toEqual(lines);
		expect(run).toEqual(original);
	});

	it.each([40, 80])("renders actionable findings with exact identities and no overflow at %s columns", (width) => {
		const first = finding("3ee10fe0-2abe-4146-93fd-0d6fbd97b14f");
		const view = component(record([first]));
		const lines = rendered(view, width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		const text = lines.join("\n");
		expect(text).toContain("[P2]");
		expect(text.replace(/\s/g, "")).toContain(first.id);
		expect(text).toContain("Trigger:");
		expect(text).toContain("Impact:");
		expect(text).not.toContain(first.body);
		view.setExpanded(true);
		const full = rendered(view, width).join("\n").replace(/\s+/g, " ");
		expect(full).toContain(first.body);
		expect(full).toContain("test/queue.test.ts:10-11, base");
		expect(full).toContain("confidence 92%");
	});

	it("separates optional suggestions from verified P0-P2 findings", () => {
		const summary = createReviewSeedMessage(record([finding("optional", "open", 3)])).details.summary;
		expect(summary).toContain("No verified P0-P2 findings");
		expect(summary).toContain("1 optional suggestion");
		expect(summary).toContain("[P3]");
	});

	it.each(["fixed", "dismissed"] as const)(
		"labels original conclusions as historical after the sole finding becomes %s",
		(status) => {
			const run = record([finding("resolved")]);
			run.result!.findings[0]!.status = status;
			const seed = createReviewSeedMessage(run);
			expect(seed.details.summary).toContain("0 active P0-P2 findings; 1 fixed/dismissed");
			expect(seed.details.summary).not.toContain("No verified P0-P2 findings in the selected change");
			expect(seed.content).toContain("Original review conclusion (1970-01-01T00:00:00.002Z)");
			expect(seed.content).toContain("Finding status when this session opened: 0 active P0-P2 findings");
			expect(seed.content).toContain(`Status: ${status}`);
			expect(seed.content).toContain("Overall: incorrect");
			const messages = convertToLlm([
				createCustomMessage(
					seed.customType,
					seed.content,
					true,
					JSON.parse(JSON.stringify(seed.details)) as JsonValue,
					new Date(0).toISOString(),
				),
			]);
			expect(JSON.stringify(messages)).toContain("Original review conclusion");
			expect(JSON.stringify(messages)).not.toContain("to expand review details");
		},
	);

	it("keeps selected and empty selections distinct from the full result", () => {
		const run = record([finding("first"), finding("second")]);
		for (const ids of [[], ["second"]]) {
			const seed = createReviewSeedMessage(run, ids);
			expect(seed.details.summary).toContain(`Selected findings: ${ids.length} of 2 retained entries`);
			expect(seed.details.summary).toContain("2 active P0-P2 findings");
			expect(seed.details.summary).toContain("outside this selection");
			expect(seed.content).not.toContain("no verified issues worth flagging");
			expect(seed.details.findings.map((entry) => entry.id)).toEqual(ids);
			if (!ids.length) expect(seed.content).toContain("No findings were selected for this session.");
		}
		expect(run.result!.findings).toHaveLength(2);
		expect(() => createReviewSeedMessage(run, ["unknown"])).toThrow("Unknown finding ids");
	});

	it("keeps canonical ordering and does not renumber around hidden historical entries", () => {
		const run = record([finding("first", "fixed"), finding("second"), finding("third", "accepted", 1)]);
		const seed = createReviewSeedMessage(run, ["third", "first", "second"]);
		expect(seed.details.findings.map((entry) => entry.id)).toEqual(["first", "second", "third"]);
		expect(seed.details.summary).toContain("### 2. [P2]");
		expect(seed.details.summary).toContain("### 3. [P1]");
		expect(seed.content).toContain("### 2. Handle empty queue second");
	});

	it("keeps incompleteness and uncertain findings visible without a correctness claim", () => {
		const run = record([finding("uncertain", "uncertain")]);
		run.status = "incomplete";
		run.result!.completionStatus = "incomplete";
		delete run.result!.overallCorrectness;
		run.result!.coverage.changedFileInventoryComplete = false;
		run.result!.coverage.context = {
			captureStatus: "incomplete",
			linkedIssueCount: 1,
			discussionEntryCount: 0,
			limitationCodes: ["api-error"],
			fingerprint: "f".repeat(64),
			discoveryInspectionComplete: false,
			verificationInspectionComplete: false,
		};
		const seed = createReviewSeedMessage(run);
		expect(seed.details.summary).toContain("Review incomplete");
		expect(seed.details.summary).toContain("No overall conclusion.");
		expect(seed.details.summary).toContain("changed-file inventory is incomplete");
		expect(seed.details.summary).toContain("Code-host context capture is incomplete");
		expect(seed.details.summary).toContain("Discovery did not inspect all");
		expect(seed.details.summary).toContain("Verification did not inspect all");
		expect(seed.details.summary).toContain("1 uncertain");
		expect(seed.details.summary).not.toContain("No verified P0-P2 findings");
		expect(seed.content).toContain("Status: uncertain");
	});

	it("shows an unresolved concern, code location, and next step in the collapsed result", () => {
		const run = record();
		run.status = "incomplete";
		run.result!.completionStatus = "incomplete";
		delete run.result!.overallCorrectness;
		run.result!.verificationChallenge =
			"Unverified concern: Reasoning may consume the output allowance.\nNext step: Test a reasoning-only length stop.\nLocation: src/compaction.ts:303-306 (head).";
		run.result!.coverage.residualRisk.push(run.result!.verificationChallenge);
		const view = component(run);
		for (const expanded of [false, true]) {
			view.setExpanded(expanded);
			const text = rendered(view).join("\n").replace(/\s+/g, " ");
			expect(text).toContain("Unverified concern: Reasoning may consume the output allowance.");
			expect(text).toContain("Next step: Test a reasoning-only length stop.");
			expect(text).toContain("src/compaction.ts:303-306");
			expect(text).not.toContain("Overall: correct");
		}
		expect(createReviewSeedMessage(run).details.findings).toEqual([]);
	});

	it("qualifies explicit scope and effective incremental review without inventing coverage totals", () => {
		const run = record();
		run.options.scope = ["src/**"];
		run.options.focus = "Cache reuse";
		run.options.scopeMode = "incremental";
		let seed = createReviewSeedMessage(run);
		expect(seed.details.summary).toContain("Limited to the selected paths");
		expect(seed.details.summary).not.toContain("prior review");
		expect(seed.content).toContain("Focus: Cache reuse");
		run.parentRunId = "review:previous";
		seed = createReviewSeedMessage(run);
		expect(seed.details.summary).toContain("Includes evidence retained from a prior review");
		run.incrementalFallbackReason = "The context changed.";
		seed = createReviewSeedMessage(run);
		expect(seed.details.summary).not.toContain("Includes evidence retained");
		expect(seed.content).toContain("Full-review fallback: The context changed\\.");
		expect(seed.content).toContain("lists can be bounded");
		expect(seed.details.summary).not.toMatch(/33|56|files inspected/i);
	});

	it.each(["complete", "incomplete"] as const)(
		"omits attempt diagnostics from a %s report while preserving actionable limits",
		(completionStatus) => {
			const run = record();
			run.result!.completionStatus = completionStatus;
			const failure = "review_file: File does not exist in the head snapshot: missing.ts";
			run.result!.coverage.failedVerificationAttempts = [failure];
			const gap = "Changed hunk was not fully inspected: 0123456789abcdef0123";
			const challenge = "Review verification model request failed. Retry with another review model.";
			if (completionStatus === "incomplete") {
				run.status = "incomplete";
				delete run.result!.overallCorrectness;
				run.result!.coverage.uncheckedAreas = [gap];
				run.result!.verificationChallenge = challenge;
				run.result!.coverage.residualRisk.push(challenge);
			}
			const original = structuredClone(run);
			const seed = createReviewSeedMessage(run);
			const view = component(run);
			for (const expanded of [false, true]) {
				view.setExpanded(expanded);
				const text = rendered(view).join("\n").replace(/\s+/g, " ");
				expect(text).not.toMatch(/review tool attempts|missing\.ts/);
				expect(text).toContain(STATIC_REVIEW_LIMITATION);
				if (completionStatus === "incomplete") {
					expect(text).toContain(gap);
					expect(text).toContain(challenge);
					expect(text).not.toContain("Overall: correct");
				}
			}
			for (const text of [seed.content, seed.details.summary]) {
				expect(text).not.toMatch(/review tool attempts|missing\.ts/);
			}
			expect(run).toEqual(original);
		},
	);

	it("does not infer static-only, absent attempts, or passing tests from completion/failure arrays or model prose", () => {
		const run = record();
		run.result!.coverage.residualRisk = [];
		run.result!.coverage.commandsRun = ["1 bash command(s) completed during review."];
		run.result!.coverage.failedVerificationAttempts = ["1 verification tool attempt(s) failed."];
		run.result!.coverage.modelReportedLimitations = [STATIC_REVIEW_LIMITATION, "PRIVATE_MODEL_PROSE"];
		const summary = createReviewSeedMessage(run).details.summary;
		expect(summary).toContain("Runtime validation is not established by this report.");
		expect(summary).not.toContain("Some review tool attempts failed");
		expect(summary).not.toContain(STATIC_REVIEW_LIMITATION);
		expect(summary).not.toContain("PRIVATE_MODEL_PROSE");
		expect(summary).not.toMatch(/tests passed|no command|tests failed/i);
	});

	it("uses the captured tree for uncommitted reviews", () => {
		const run = record();
		run.target.identity.kind = "uncommitted";
		expect(createReviewSeedMessage(run).details.summary).toContain(`Uncommitted changes · tree ${"c".repeat(12)}`);
	});

	it("keeps newly formatted data inert and reconstructs display from serialized metadata", () => {
		const unsafe = finding("literal");
		unsafe.title = "[click](https://example.com)\u001b[2J\n# forged heading";
		unsafe.changeLocation.path = "src/[literal]`file.ts";
		const seed = createReviewSeedMessage(record([unsafe]));
		expect(seed.details.summary).not.toContain("\u001b");
		expect(seed.details.summary).not.toContain("\n# forged heading");
		expect(seed.details.summary).toContain("\\[click\\]");
		const restored = JSON.parse(JSON.stringify(seed)) as typeof seed;
		const view = new CustomMessageComponent(
			createCustomMessage(
				restored.customType,
				restored.content,
				true,
				JSON.parse(JSON.stringify(restored.details)) as JsonValue,
				new Date(0).toISOString(),
			),
		);
		expect(rendered(view).join("\n")).toContain("[click](https://example.com)");
	});

	it.each(["+ queue.ts", "1) queue.ts"])("preserves literal root filenames: %s", (path) => {
		const entry = finding("literal-path");
		entry.changeLocation.path = path;
		const view = component(record([entry]));
		expect(rendered(view).join("\n")).toContain(`Location: ${path}:4-5, head`);
		view.setExpanded(true);
		expect(rendered(view).join("\n").replace(/\s+/g, " ")).toContain(`${path}:4-5, head`);
	});

	it.each(["www.example.com", "admin@example.com", "~~value~~", "https://example.com"])(
		"keeps GFM data literal without creating links: %s",
		(value) => {
			const entry = finding("literal");
			entry.title = value;
			entry.changeLocation.path = value;
			const view = component(record([entry]));
			for (const expanded of [false, true]) {
				view.setExpanded(expanded);
				const frame = view.render(80);
				expect(frame.lines.join("\n")).not.toContain("\u001b]8;");
				expect(frame.lines.map(stripAnsi).join("\n")).toContain(value);
			}
		},
	);

	it.each(["failed", "cancelled"] as const)(
		"does not manufacture a clean seed for a %s run without a result",
		(status) => {
			const run = record();
			run.status = status;
			delete run.result;
			expect(() => createReviewSeedMessage(run)).toThrow("no validated result");
		},
	);
});
