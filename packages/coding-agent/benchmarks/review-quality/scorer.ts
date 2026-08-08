import type {
	ChangedFile,
	ExpectedIssueLocation,
	ReviewQualityCase,
	ReviewQualityCaseReport,
	ReviewQualityCaseScore,
	ReviewQualityCorpus,
	ReviewQualityEvaluation,
	ReviewQualityFinding,
	ReviewQualityReport,
} from "./types.ts";

function ratio(numerator: number, denominator: number, emptyValue: number): number {
	return denominator === 0 ? emptyValue : numerator / denominator;
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^[ab]\//, "");
}

function rangesOverlap(
	left: { startLine: number; endLine: number },
	right: { startLine: number; endLine: number },
): boolean {
	return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function findingMatchesLocation(finding: ReviewQualityFinding, location: ExpectedIssueLocation): boolean {
	return normalizePath(finding.path) === normalizePath(location.path) && rangesOverlap(finding, location);
}

function findChangedFile(corpusCase: ReviewQualityCase, path: string): ChangedFile | undefined {
	const normalizedPath = normalizePath(path);
	return corpusCase.changedFiles.find((file) => normalizePath(file.path) === normalizedPath);
}

function hasValidAnchor(corpusCase: ReviewQualityCase, finding: ReviewQualityFinding): boolean {
	const file = findChangedFile(corpusCase, finding.path);
	if (!file) return false;
	return file.hunks.some((hunk) => hunk.changedLineRanges.some((range) => rangesOverlap(finding, range)));
}

function validateCaseReports(corpus: ReviewQualityCorpus, report: ReviewQualityReport): Map<string, ReviewQualityCaseReport> {
	const corpusIds = new Set(corpus.cases.map((corpusCase) => corpusCase.id));
	const reportsByCase = new Map<string, ReviewQualityCaseReport>();
	for (const caseReport of report.cases) {
		if (!corpusIds.has(caseReport.caseId)) throw new Error(`Report contains unknown case: ${caseReport.caseId}`);
		if (reportsByCase.has(caseReport.caseId)) throw new Error(`Report contains duplicate case: ${caseReport.caseId}`);
		reportsByCase.set(caseReport.caseId, caseReport);
	}
	for (const corpusCase of corpus.cases) {
		if (!reportsByCase.has(corpusCase.id)) throw new Error(`Report is missing case: ${corpusCase.id}`);
	}
	return reportsByCase;
}

export function scoreReviewQuality(
	corpus: ReviewQualityCorpus,
	report: ReviewQualityReport,
): ReviewQualityEvaluation {
	const reportsByCase = validateCaseReports(corpus, report);
	const allChangedFiles = new Set<string>();
	const allChangedHunks = new Set<string>();
	const coveredChangedFiles = new Set<string>();
	const coveredChangedHunks = new Set<string>();
	const caseScores: ReviewQualityCaseScore[] = [];
	let expectedIssues = 0;
	let findings = 0;
	let truePositives = 0;
	let duplicates = 0;
	let invalidAnchors = 0;
	let cleanCasesWithNoFindings = 0;

	for (const corpusCase of corpus.cases) {
		const caseReport = reportsByCase.get(corpusCase.id);
		if (!caseReport) throw new Error(`Report is missing case: ${corpusCase.id}`);
		for (const file of corpusCase.changedFiles) {
			allChangedFiles.add(`${corpusCase.id}:${normalizePath(file.path)}`);
			for (const hunk of file.hunks) allChangedHunks.add(`${corpusCase.id}:${hunk.id}`);
		}
		for (const path of caseReport.coverage.reviewedFiles) {
			const file = findChangedFile(corpusCase, path);
			if (file) coveredChangedFiles.add(`${corpusCase.id}:${normalizePath(file.path)}`);
		}
		const validHunkIds = new Set(corpusCase.changedFiles.flatMap((file) => file.hunks.map((hunk) => hunk.id)));
		for (const hunkId of caseReport.coverage.reviewedHunks) {
			if (validHunkIds.has(hunkId)) coveredChangedHunks.add(`${corpusCase.id}:${hunkId}`);
		}

		expectedIssues += corpusCase.expectedIssues.length;
		findings += caseReport.findings.length;
		if (corpusCase.kind === "clean" && caseReport.findings.length === 0) cleanCasesWithNoFindings++;
		const expectedByKey = new Map(corpusCase.expectedIssues.map((issue) => [issue.key, issue]));
		const seenIssueKeys = new Set<string>();
		const matchedIssueKeys = new Set<string>();
		const falsePositiveIssueKeys: string[] = [];
		let caseDuplicateCount = 0;
		let caseInvalidAnchorCount = 0;
		for (const finding of caseReport.findings) {
			const duplicate = seenIssueKeys.has(finding.issueKey);
			if (duplicate) {
				duplicates++;
				caseDuplicateCount++;
			}
			seenIssueKeys.add(finding.issueKey);
			const validAnchor = hasValidAnchor(corpusCase, finding);
			if (!validAnchor) {
				invalidAnchors++;
				caseInvalidAnchorCount++;
			}
			const expected = expectedByKey.get(finding.issueKey);
			const matchesExpectedLocation = expected?.locations.some((location) => findingMatchesLocation(finding, location));
			if (!duplicate && validAnchor && matchesExpectedLocation && !matchedIssueKeys.has(finding.issueKey)) {
				matchedIssueKeys.add(finding.issueKey);
				truePositives++;
			} else {
				falsePositiveIssueKeys.push(finding.issueKey);
			}
		}
		caseScores.push({
			caseId: corpusCase.id,
			matchedIssueKeys: [...matchedIssueKeys].sort(),
			missedIssueKeys: corpusCase.expectedIssues
				.map((issue) => issue.key)
				.filter((key) => !matchedIssueKeys.has(key))
				.sort(),
			falsePositiveIssueKeys,
			duplicateCount: caseDuplicateCount,
			invalidAnchorCount: caseInvalidAnchorCount,
		});
	}

	const falsePositives = findings - truePositives;
	const falseNegatives = expectedIssues - truePositives;
	const cleanCases = corpus.cases.filter((corpusCase) => corpusCase.kind === "clean").length;
	const counts = {
		cases: corpus.cases.length,
		buggyCases: corpus.cases.length - cleanCases,
		cleanCases,
		expectedIssues,
		findings,
		truePositives,
		falsePositives,
		falseNegatives,
		duplicates,
		invalidAnchors,
		changedFiles: allChangedFiles.size,
		coveredChangedFiles: coveredChangedFiles.size,
		changedHunks: allChangedHunks.size,
		coveredChangedHunks: coveredChangedHunks.size,
	};
	return {
		schemaVersion: 1,
		report: report.run,
		counts,
		metrics: {
			precision: ratio(truePositives, findings, 1),
			recall: ratio(truePositives, expectedIssues, 1),
			cleanDiffNoFindingAccuracy: ratio(cleanCasesWithNoFindings, cleanCases, 1),
			duplicateRate: ratio(duplicates, findings, 0),
			invalidAnchorRate: ratio(invalidAnchors, findings, 0),
			changedFileCoverage: ratio(coveredChangedFiles.size, allChangedFiles.size, 1),
			changedHunkCoverage: ratio(coveredChangedHunks.size, allChangedHunks.size, 1),
		},
		performance: {
			latencyMs: {
				total: report.run.latencyMs,
				meanPerCase: ratio(report.run.latencyMs, corpus.cases.length, 0),
			},
			tokenUse: report.run.tokenUse,
			reportedCostUsd: report.run.reportedCostUsd,
		},
		cases: caseScores,
	};
}
