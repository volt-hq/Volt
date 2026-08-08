export type ReviewQualityCaseKind = "buggy" | "clean";

export interface LineRange {
	startLine: number;
	endLine: number;
}

export interface ExpectedIssueLocation extends LineRange {
	path: string;
}

export interface ExpectedIssue {
	key: string;
	locations: ExpectedIssueLocation[];
}

export interface ChangedHunk extends LineRange {
	id: string;
	path: string;
	index: number;
	changedLineRanges: LineRange[];
}

export interface ChangedFile {
	path: string;
	diff: string;
	hunks: ChangedHunk[];
}

export interface ReviewQualityCase {
	id: string;
	kind: ReviewQualityCaseKind;
	description: string;
	expectedIssues: ExpectedIssue[];
	changedFiles: ChangedFile[];
	diff: string;
}

export interface ReviewQualityCorpus {
	schemaVersion: 1;
	cases: ReviewQualityCase[];
}

export interface ReviewQualityFinding extends ExpectedIssueLocation {
	issueKey: string;
	summary?: string;
}

export interface ReviewQualityCoverage {
	reviewedFiles: string[];
	reviewedHunks: string[];
}

export interface ReviewQualityCaseReport {
	caseId: string;
	findings: ReviewQualityFinding[];
	coverage: ReviewQualityCoverage;
}

export interface ReviewQualityTokenUse {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface ReviewQualityRun {
	mode: "sample" | "real-model";
	provider: string;
	model: string;
	latencyMs: number;
	tokenUse: ReviewQualityTokenUse;
	reportedCostUsd: number;
}

export interface ReviewQualityReport {
	schemaVersion: 1;
	run: ReviewQualityRun;
	cases: ReviewQualityCaseReport[];
}

export interface ReviewQualityCaseScore {
	caseId: string;
	matchedIssueKeys: string[];
	missedIssueKeys: string[];
	falsePositiveIssueKeys: string[];
	duplicateCount: number;
	invalidAnchorCount: number;
}

export interface ReviewQualityCounts {
	cases: number;
	buggyCases: number;
	cleanCases: number;
	expectedIssues: number;
	findings: number;
	truePositives: number;
	falsePositives: number;
	falseNegatives: number;
	duplicates: number;
	invalidAnchors: number;
	changedFiles: number;
	coveredChangedFiles: number;
	changedHunks: number;
	coveredChangedHunks: number;
}

export interface ReviewQualityMetrics {
	precision: number;
	recall: number;
	cleanDiffNoFindingAccuracy: number;
	duplicateRate: number;
	invalidAnchorRate: number;
	changedFileCoverage: number;
	changedHunkCoverage: number;
}

export interface ReviewQualityEvaluation {
	schemaVersion: 1;
	report: ReviewQualityRun;
	counts: ReviewQualityCounts;
	metrics: ReviewQualityMetrics;
	performance: {
		latencyMs: {
			total: number;
			meanPerCase: number;
		};
		tokenUse: ReviewQualityTokenUse;
		reportedCostUsd: number;
	};
	cases: ReviewQualityCaseScore[];
}
