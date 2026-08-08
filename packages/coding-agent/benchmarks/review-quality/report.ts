import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ReviewQualityCaseReport,
	ReviewQualityCoverage,
	ReviewQualityFinding,
	ReviewQualityReport,
	ReviewQualityRun,
	ReviewQualityTokenUse,
} from "./types.ts";

const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SAMPLE_REPORT_PATH = join(benchmarkDirectory, "reports", "sample.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a non-negative finite number`);
	}
	return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

function parseStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function parseFinding(value: unknown, label: string): ReviewQualityFinding {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const startLine = requirePositiveInteger(value.startLine, `${label}.startLine`);
	const endLine = requirePositiveInteger(value.endLine, `${label}.endLine`);
	if (endLine < startLine) throw new Error(`${label}.endLine must not precede startLine`);
	const summary = value.summary;
	if (summary !== undefined && typeof summary !== "string") throw new Error(`${label}.summary must be a string`);
	return {
		issueKey: requireString(value.issueKey, `${label}.issueKey`),
		path: requireString(value.path, `${label}.path`),
		startLine,
		endLine,
		...(summary === undefined ? {} : { summary }),
	};
}

function parseCoverage(value: unknown, label: string): ReviewQualityCoverage {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return {
		reviewedFiles: parseStringArray(value.reviewedFiles, `${label}.reviewedFiles`),
		reviewedHunks: parseStringArray(value.reviewedHunks, `${label}.reviewedHunks`),
	};
}

export function parseReviewQualityCaseReport(
	value: unknown,
	label = "case report",
	expectedCaseId?: string,
): ReviewQualityCaseReport {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	if (!Array.isArray(value.findings)) throw new Error(`${label}.findings must be an array`);
	const caseId = expectedCaseId ?? requireString(value.caseId, `${label}.caseId`);
	if (value.caseId !== undefined && value.caseId !== caseId) {
		throw new Error(`${label}.caseId must be ${caseId}`);
	}
	return {
		caseId,
		findings: value.findings.map((finding, index) => parseFinding(finding, `${label}.findings[${index}]`)),
		coverage: parseCoverage(value.coverage, `${label}.coverage`),
	};
}

function parseTokenUse(value: unknown, label: string): ReviewQualityTokenUse {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return {
		input: requireNonNegativeNumber(value.input, `${label}.input`),
		output: requireNonNegativeNumber(value.output, `${label}.output`),
		cacheRead: requireNonNegativeNumber(value.cacheRead, `${label}.cacheRead`),
		cacheWrite: requireNonNegativeNumber(value.cacheWrite, `${label}.cacheWrite`),
		total: requireNonNegativeNumber(value.total, `${label}.total`),
	};
}

function parseRun(value: unknown): ReviewQualityRun {
	if (!isRecord(value)) throw new Error("run must be an object");
	if (value.mode !== "sample" && value.mode !== "real-model") throw new Error("run.mode must be sample or real-model");
	return {
		mode: value.mode,
		provider: requireString(value.provider, "run.provider"),
		model: requireString(value.model, "run.model"),
		latencyMs: requireNonNegativeNumber(value.latencyMs, "run.latencyMs"),
		tokenUse: parseTokenUse(value.tokenUse, "run.tokenUse"),
		reportedCostUsd: requireNonNegativeNumber(value.reportedCostUsd, "run.reportedCostUsd"),
	};
}

export function parseReviewQualityReport(value: unknown): ReviewQualityReport {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.cases)) {
		throw new Error("Review-quality report must have schemaVersion 1 and a cases array");
	}
	return {
		schemaVersion: 1,
		run: parseRun(value.run),
		cases: value.cases.map((caseReport, index) => parseReviewQualityCaseReport(caseReport, `cases[${index}]`)),
	};
}

export function loadReviewQualityReport(path = DEFAULT_SAMPLE_REPORT_PATH): ReviewQualityReport {
	return parseReviewQualityReport(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
