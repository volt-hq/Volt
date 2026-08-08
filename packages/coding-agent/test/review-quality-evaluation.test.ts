import { describe, expect, it } from "vitest";
import { loadReviewQualityCorpus } from "../benchmarks/review-quality/corpus.ts";
import { REAL_MODEL_ENV_FLAG } from "../benchmarks/review-quality/environment.ts";
import { evaluateReviewQuality } from "../benchmarks/review-quality/evaluate.ts";
import { loadReviewQualityReport } from "../benchmarks/review-quality/report.ts";
import { scoreReviewQuality } from "../benchmarks/review-quality/scorer.ts";
import type { ReviewQualityReport } from "../benchmarks/review-quality/types.ts";

describe("review-quality evaluation", () => {
	it("loads buggy and clean repository fixtures with semantic anchors on changed lines", () => {
		const corpus = loadReviewQualityCorpus();
		expect(corpus.cases.map((corpusCase) => [corpusCase.id, corpusCase.kind])).toEqual([
			["token-refresh-bug", "buggy"],
			["token-refresh-clean", "clean"],
		]);
		for (const corpusCase of corpus.cases) {
			expect(corpusCase.changedFiles.length).toBeGreaterThan(0);
			expect(corpusCase.diff).toContain("@@");
			for (const issue of corpusCase.expectedIssues) {
				expect(issue.key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
				for (const location of issue.locations) {
					const changedFile = corpusCase.changedFiles.find((file) => file.path === location.path);
					const overlapsChangedLine = changedFile?.hunks.some((hunk) =>
						hunk.changedLineRanges.some(
							(range) => location.startLine <= range.endLine && range.startLine <= location.endLine,
						),
					);
					expect(overlapsChangedLine).toBe(true);
				}
			}
		}
	});

	it("scores the checked-in report deterministically without matching reviewer prose", () => {
		const evaluation = scoreReviewQuality(loadReviewQualityCorpus(), loadReviewQualityReport());
		expect(evaluation.counts).toMatchObject({
			expectedIssues: 1,
			findings: 1,
			truePositives: 1,
			falsePositives: 0,
			falseNegatives: 0,
			duplicates: 0,
			invalidAnchors: 0,
			changedFiles: 2,
			coveredChangedFiles: 2,
			changedHunks: 2,
			coveredChangedHunks: 2,
		});
		expect(evaluation.metrics).toEqual({
			precision: 1,
			recall: 1,
			cleanDiffNoFindingAccuracy: 1,
			duplicateRate: 0,
			invalidAnchorRate: 0,
			changedFileCoverage: 1,
			changedHunkCoverage: 1,
		});
		expect(evaluation.performance).toEqual({
			latencyMs: { total: 350, meanPerCase: 175 },
			tokenUse: { input: 850, output: 140, cacheRead: 10, cacheWrite: 0, total: 1000 },
			reportedCostUsd: 0.0125,
		});
		expect(JSON.parse(JSON.stringify(evaluation))).toEqual(evaluation);
	});

	it("counts false positives, duplicates, invalid anchors, clean findings, and partial coverage", () => {
		const corpus = loadReviewQualityCorpus();
		const report = structuredClone(loadReviewQualityReport());
		const buggy = report.cases.find((caseReport) => caseReport.caseId === "token-refresh-bug");
		const clean = report.cases.find((caseReport) => caseReport.caseId === "token-refresh-clean");
		if (!buggy || !clean) throw new Error("Checked-in report is missing benchmark cases");
		const matched = buggy.findings[0];
		if (!matched) throw new Error("Checked-in buggy report is missing its semantic finding");
		buggy.findings.push(
			{ ...matched },
			{ issueKey: "unrelated-condition", path: matched.path, startLine: 7, endLine: 7 },
			{ issueKey: "out-of-diff-anchor", path: matched.path, startLine: 100, endLine: 100 },
		);
		clean.findings.push({
			issueKey: "clean-false-positive",
			path: "src/token-cache.ts",
			startLine: 7,
			endLine: 7,
		});
		clean.coverage = { reviewedFiles: [], reviewedHunks: [] };

		const evaluation = scoreReviewQuality(corpus, report);
		expect(evaluation.counts).toMatchObject({
			findings: 5,
			truePositives: 1,
			falsePositives: 4,
			falseNegatives: 0,
			duplicates: 1,
			invalidAnchors: 1,
			coveredChangedFiles: 1,
			coveredChangedHunks: 1,
		});
		expect(evaluation.metrics).toEqual({
			precision: 0.2,
			recall: 1,
			cleanDiffNoFindingAccuracy: 0,
			duplicateRate: 0.2,
			invalidAnchorRate: 0.2,
			changedFileCoverage: 0.5,
			changedHunkCoverage: 0.5,
		});
	});

	it("uses checked-in reports unless the exact real-model flag is enabled", async () => {
		let realModelCalls = 0;
		const runRealModel = async (): Promise<ReviewQualityReport> => {
			realModelCalls++;
			return loadReviewQualityReport();
		};
		const defaultEvaluation = await evaluateReviewQuality({ environment: {}, runRealModel });
		expect(defaultEvaluation.report.mode).toBe("sample");
		expect(realModelCalls).toBe(0);

		await evaluateReviewQuality({ environment: { [REAL_MODEL_ENV_FLAG]: "1" }, runRealModel });
		expect(realModelCalls).toBe(1);
	});
});
