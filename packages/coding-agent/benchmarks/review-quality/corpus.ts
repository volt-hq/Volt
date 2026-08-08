import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createTwoFilesPatch, structuredPatch } from "diff";
import type {
	ChangedFile,
	ChangedHunk,
	ExpectedIssue,
	ExpectedIssueLocation,
	LineRange,
	ReviewQualityCase,
	ReviewQualityCaseKind,
	ReviewQualityCorpus,
} from "./types.ts";

interface CorpusManifestCase {
	id: string;
	kind: ReviewQualityCaseKind;
	description: string;
	before: string;
	after: string;
	expectedIssues: ExpectedIssue[];
}

interface CorpusManifest {
	schemaVersion: 1;
	cases: CorpusManifestCase[];
}

const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORPUS_MANIFEST_PATH = join(benchmarkDirectory, "fixtures", "corpus.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

function parseLocation(value: unknown, label: string): ExpectedIssueLocation {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const startLine = requirePositiveInteger(value.startLine, `${label}.startLine`);
	const endLine = requirePositiveInteger(value.endLine, `${label}.endLine`);
	if (endLine < startLine) throw new Error(`${label}.endLine must not precede startLine`);
	return {
		path: requireString(value.path, `${label}.path`),
		startLine,
		endLine,
	};
}

function parseExpectedIssue(value: unknown, label: string): ExpectedIssue {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	if (!Array.isArray(value.locations) || value.locations.length === 0) {
		throw new Error(`${label}.locations must be a non-empty array`);
	}
	return {
		key: requireString(value.key, `${label}.key`),
		locations: value.locations.map((location, index) => parseLocation(location, `${label}.locations[${index}]`)),
	};
}

function parseManifestCase(value: unknown, index: number): CorpusManifestCase {
	const label = `cases[${index}]`;
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const kind = value.kind;
	if (kind !== "buggy" && kind !== "clean") throw new Error(`${label}.kind must be buggy or clean`);
	if (!Array.isArray(value.expectedIssues)) throw new Error(`${label}.expectedIssues must be an array`);
	const expectedIssues = value.expectedIssues.map((issue, issueIndex) =>
		parseExpectedIssue(issue, `${label}.expectedIssues[${issueIndex}]`),
	);
	if (kind === "clean" && expectedIssues.length !== 0) {
		throw new Error(`${label} is clean and cannot declare expected issues`);
	}
	if (kind === "buggy" && expectedIssues.length === 0) {
		throw new Error(`${label} is buggy and must declare an expected issue`);
	}
	return {
		id: requireString(value.id, `${label}.id`),
		kind,
		description: requireString(value.description, `${label}.description`),
		before: requireString(value.before, `${label}.before`),
		after: requireString(value.after, `${label}.after`),
		expectedIssues,
	};
}

function parseManifest(value: unknown): CorpusManifest {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.cases)) {
		throw new Error("Corpus manifest must have schemaVersion 1 and a cases array");
	}
	const cases = value.cases.map(parseManifestCase);
	const ids = new Set<string>();
	for (const corpusCase of cases) {
		if (ids.has(corpusCase.id)) throw new Error(`Duplicate corpus case id: ${corpusCase.id}`);
		ids.add(corpusCase.id);
		const issueKeys = new Set<string>();
		for (const issue of corpusCase.expectedIssues) {
			if (issueKeys.has(issue.key)) throw new Error(`Duplicate issue key in ${corpusCase.id}: ${issue.key}`);
			issueKeys.add(issue.key);
		}
	}
	return { schemaVersion: 1, cases };
}

function resolveFixtureDirectory(manifestPath: string, fixturePath: string): string {
	const fixtureRoot = resolve(dirname(manifestPath));
	const directory = resolve(fixtureRoot, fixturePath);
	if (directory !== fixtureRoot && !directory.startsWith(`${fixtureRoot}${sep}`)) {
		throw new Error(`Fixture path escapes the fixture root: ${fixturePath}`);
	}
	return directory;
}

function collectFiles(directory: string, current = directory): string[] {
	const paths: string[] = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const absolutePath = join(current, entry.name);
		if (entry.isDirectory()) {
			paths.push(...collectFiles(directory, absolutePath));
		} else if (entry.isFile()) {
			paths.push(relative(directory, absolutePath).split(sep).join("/"));
		} else {
			throw new Error(`Fixture entries must be regular files or directories: ${absolutePath}`);
		}
	}
	return paths.sort();
}

function mergeLineNumbers(lines: number[]): LineRange[] {
	const ranges: LineRange[] = [];
	for (const line of lines) {
		const previous = ranges.at(-1);
		if (previous && previous.endLine + 1 === line) {
			previous.endLine = line;
		} else {
			ranges.push({ startLine: line, endLine: line });
		}
	}
	return ranges;
}

function changedLineRanges(lines: string[], newStart: number): LineRange[] {
	const changedLines: number[] = [];
	let line = newStart;
	for (const content of lines) {
		if (content.startsWith("+")) {
			changedLines.push(line);
			line++;
		} else if (!content.startsWith("-")) {
			line++;
		}
	}
	return mergeLineNumbers(changedLines.length > 0 ? changedLines : [newStart]);
}

function createChangedFile(path: string, beforeText: string, afterText: string): ChangedFile {
	const patch = structuredPatch(`a/${path}`, `b/${path}`, beforeText, afterText, undefined, undefined, { context: 3 });
	const hunks: ChangedHunk[] = patch.hunks.map((hunk, index) => {
		const ranges = changedLineRanges(hunk.lines, hunk.newStart);
		return {
			id: `${path}#${index + 1}`,
			path,
			index: index + 1,
			startLine: ranges[0].startLine,
			endLine: ranges.at(-1)?.endLine ?? ranges[0].endLine,
			changedLineRanges: ranges,
		};
	});
	return {
		path,
		diff: createTwoFilesPatch(`a/${path}`, `b/${path}`, beforeText, afterText, undefined, undefined, { context: 3 }),
		hunks,
	};
}

function readFixtureCase(manifestPath: string, manifestCase: CorpusManifestCase): ReviewQualityCase {
	const beforeDirectory = resolveFixtureDirectory(manifestPath, manifestCase.before);
	const afterDirectory = resolveFixtureDirectory(manifestPath, manifestCase.after);
	const beforeFiles = collectFiles(beforeDirectory);
	const afterFiles = collectFiles(afterDirectory);
	const paths = [...new Set([...beforeFiles, ...afterFiles])].sort();
	const beforeSet = new Set(beforeFiles);
	const afterSet = new Set(afterFiles);
	const changedFiles = paths.flatMap((path) => {
		const beforeText = beforeSet.has(path) ? readFileSync(join(beforeDirectory, path), "utf8") : "";
		const afterText = afterSet.has(path) ? readFileSync(join(afterDirectory, path), "utf8") : "";
		return beforeText === afterText ? [] : [createChangedFile(path, beforeText, afterText)];
	});
	if (changedFiles.length === 0) throw new Error(`Corpus case ${manifestCase.id} has no changed files`);
	return {
		id: manifestCase.id,
		kind: manifestCase.kind,
		description: manifestCase.description,
		expectedIssues: manifestCase.expectedIssues,
		changedFiles,
		diff: changedFiles.map((file) => file.diff).join("\n"),
	};
}

export function loadReviewQualityCorpus(manifestPath = DEFAULT_CORPUS_MANIFEST_PATH): ReviewQualityCorpus {
	const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
	return {
		schemaVersion: 1,
		cases: manifest.cases.map((manifestCase) => readFixtureCase(manifestPath, manifestCase)),
	};
}
