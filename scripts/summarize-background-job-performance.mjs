#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const OWNED_FILE = new RegExp(`^background-jobs-v1_\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_${UUID}_\\d{8,16}\\.jsonl$`);
const KINDS = new Set([
	"run_start", "run_end", "request_start", "request_end", "tool_start", "tool_end", "job_start", "job_end",
	"job_cancel", "wait_start", "wait_end", "job_read", "job_collected",
]);
const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const HELP = `Usage: node scripts/summarize-background-job-performance.mjs --dir <diagnostics-directory>
       [--session <session-id>] [--since <UTC-ISO>] [--until <UTC-ISO>]

Read completed background-jobs-v1_*.jsonl batches from the explicit directory.
--session selects that session and its recorded descendants. Time bounds are inclusive.
--since and --until require UTC ISO timestamps, for example 2026-09-10T12:00:00.000Z.
The script writes a JSON report. null means unavailable; observed counts are not complete totals.
Pairs that cross a filter boundary are incomplete, not clipped into invented durations.
Within-runtime durations use monotonic time; cross-runtime overlaps use approximate UTC time.
Requests are logical model requests, not an all-provider HTTP count. Tokens are provider-reported.
Overlap is temporal only. The report makes no billed-cost or useful-work claims.
Capture loss before retained data or after the final record cannot always be detected.
`;

function utc(value, label) {
	if (typeof value !== "string" || !UTC_ISO.test(value) || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Invalid ${label}: expected a UTC ISO timestamp`);
	}
	const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
	if (new Date(value).toISOString() !== normalized) throw new Error(`Invalid ${label}: expected a real UTC date`);
	return Date.parse(value);
}

export function parseBackgroundJobPerformanceArgs(args) {
	const options = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (!["--dir", "--session", "--since", "--until"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
		const key = arg.slice(2);
		if (options[key] !== undefined) throw new Error(`Duplicate option: ${arg}`);
		const value = args[++index];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
		options[key] = value;
	}
	if (!options.dir) throw new Error("--dir is required; diagnostics directories are never selected implicitly");
	validateFilters(options);
	return options;
}

function validateFilters(options) {
	const since = options.since === undefined ? -Infinity : utc(options.since, "--since");
	const until = options.until === undefined ? Infinity : utc(options.until, "--until");
	if (since > until) throw new Error("--since must not be later than --until");
	if (options.session !== undefined && (typeof options.session !== "string" || !options.session)) {
		throw new Error("Invalid --session");
	}
	return { since, until };
}

function count(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

function identifier(value) {
	return typeof value === "string" && value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value);
}

function normalizeRecord(value) {
	if (!value || typeof value !== "object" || value.schemaVersion !== 1 || !KINDS.has(value.kind) ||
		!count(value.sequence) || value.sequence === 0 || !count(value.droppedEvents) ||
		!identifier(value.runtimeId) || !identifier(value.sessionId) ||
		typeof value.monotonicMs !== "number" || !Number.isFinite(value.monotonicMs) || value.monotonicMs < 0) return null;
	try { utc(value.timestamp, "record timestamp"); } catch { return null; }
	const record = {
		schemaVersion: 1, kind: value.kind, timestamp: value.timestamp, monotonicMs: value.monotonicMs,
		sequence: value.sequence, runtimeId: value.runtimeId, sessionId: value.sessionId, droppedEvents: value.droppedEvents,
	};
	for (const key of ["parentSessionId", "runId", "requestId", "toolCallId", "jobId", "waitId"]) {
		if (value[key] === undefined) continue;
		if (!identifier(value[key])) return null;
		record[key] = value[key];
	}
	for (const [key, choices] of Object.entries({
		status: ["running", "cancelling", "completed", "failed", "cancelled"],
		reason: ["terminal", "steered", "timeout", "aborted", "revoked"],
		action: ["read", "wait"], mode: ["any", "all"],
	})) {
		if (value[key] === undefined) continue;
		if (!choices.includes(value[key])) return null;
		record[key] = value[key];
	}
	for (const key of ["outputBytes", "outputRevision"]) {
		if (value[key] === undefined) continue;
		if (!count(value[key])) return null;
		record[key] = value[key];
	}
	if (value.isError !== undefined) {
		if (typeof value.isError !== "boolean") return null;
		record.isError = value.isError;
	}
	if (value.usage !== undefined && value.usage && TOKEN_KEYS.every((key) => count(value.usage[key]))) {
		record.usage = Object.fromEntries(TOKEN_KEYS.map((key) => [key, value.usage[key]]));
	}
	return record;
}

function key(record, field) {
	return JSON.stringify([record.runtimeId, record.sessionId, record[field]]);
}

function pair(records, prefix, field) {
	const groups = new Map();
	let uncorrelated = 0;
	for (const record of records) {
		if (record.kind !== `${prefix}_start` && record.kind !== `${prefix}_end`) continue;
		if (!record[field]) { uncorrelated++; continue; }
		const id = key(record, field);
		if (!groups.has(id)) groups.set(id, { starts: [], ends: [] });
		groups.get(id)[record.kind.endsWith("_start") ? "starts" : "ends"].push(record);
	}
	const pairs = [];
	let missingStarts = 0;
	let missingEnds = 0;
	let ambiguous = 0;
	let invalidIntervals = 0;
	for (const { starts, ends } of groups.values()) {
		if (starts.length === 0) missingStarts += ends.length;
		if (ends.length === 0) missingEnds += starts.length;
		if (starts.length > 1 || ends.length > 1) { ambiguous++; continue; }
		if (starts.length !== 1 || ends.length !== 1) continue;
		const start = starts[0];
		const end = ends[0];
		if (end.sequence <= start.sequence || end.monotonicMs < start.monotonicMs) { invalidIntervals++; continue; }
		pairs.push({ start, end, durationMs: end.monotonicMs - start.monotonicMs });
	}
	return { pairs, missingStarts, missingEnds, ambiguous, invalidIntervals, uncorrelated };
}

function statistics(values) {
	if (values.length === 0) return null;
	const totalMs = values.reduce((total, value) => total + value, 0);
	return { samples: values.length, totalMs, minMs: Math.min(...values), maxMs: Math.max(...values), meanMs: totalMs / values.length };
}

function isRelated(sessionId, ancestorId, parents) {
	const visited = new Set();
	while (sessionId && !visited.has(sessionId)) {
		if (sessionId === ancestorId) return true;
		visited.add(sessionId);
		sessionId = parents.get(sessionId);
	}
	return false;
}

function relativeTime(record, reference) {
	return record.runtimeId === reference.runtimeId ? record.monotonicMs :
		reference.monotonicMs + Date.parse(record.timestamp) - Date.parse(reference.timestamp);
}

function unionOverlap(job, intervals, parents, excludeLaunchTool) {
	const segments = [];
	for (const interval of intervals) {
		if (!isRelated(interval.start.sessionId, job.start.sessionId, parents)) continue;
		if (excludeLaunchTool && interval.start.runtimeId === job.start.runtimeId && job.start.toolCallId &&
			interval.start.toolCallId === job.start.toolCallId) continue;
		const start = Math.max(job.start.monotonicMs, relativeTime(interval.start, job.start));
		const end = Math.min(job.end.monotonicMs, relativeTime(interval.end, job.start));
		if (end > start) segments.push([start, end]);
	}
	segments.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let lastEnd = -Infinity;
	for (const [start, end] of segments) {
		total += Math.max(0, end - Math.max(start, lastEnd));
		lastEnd = Math.max(lastEnd, end);
	}
	return total;
}

/** Pure summarizer. Observed values remain available even when complete totals cannot be established. */
export function summarizeBackgroundJobEvents(input, options = {}) {
	const { since, until } = validateFilters(options);
	const normalized = input.map(normalizeRecord);
	let invalidRecords = normalized.filter((record) => record === null).length + (options.invalidRecords ?? 0);
	const seen = new Map();
	let duplicates = 0;
	let conflictingDuplicates = 0;
	for (const record of normalized) {
		if (!record) continue;
		const id = JSON.stringify([record.runtimeId, record.sequence]);
		if (seen.has(id)) {
			duplicates++;
			if (JSON.stringify(seen.get(id)) !== JSON.stringify(record)) conflictingDuplicates++;
		} else seen.set(id, record);
	}
	const all = [...seen.values()].sort((a, b) => a.runtimeId.localeCompare(b.runtimeId) || a.sequence - b.sequence);
	const parents = new Map();
	for (const record of all) if (record.parentSessionId) parents.set(record.sessionId, record.parentSessionId);
	const scope = all.filter((record) => !options.session || isRelated(record.sessionId, options.session, parents));
	const runtimeIds = new Set(scope.map((record) => record.runtimeId));
	const runtimeSequences = new Map();
	for (const record of all) {
		if (!runtimeIds.has(record.runtimeId)) continue;
		if (!runtimeSequences.has(record.runtimeId)) runtimeSequences.set(record.runtimeId, []);
		runtimeSequences.get(record.runtimeId).push(record);
	}
	const sequenceGaps = [];
	let partialRetention = false;
	let reportedDroppedEvents = 0;
	let invalidOrdering = 0;
	for (const [runtimeId, records] of runtimeSequences) {
		partialRetention ||= records[0].sequence !== 1;
		reportedDroppedEvents += Math.max(...records.map((record) => record.droppedEvents));
		for (let index = 1; index < records.length; index++) {
			const before = records[index - 1];
			const after = records[index];
			if (after.sequence !== before.sequence + 1) sequenceGaps.push({
				runtimeId, afterSequence: before.sequence, beforeSequence: after.sequence,
				missingRecords: after.sequence - before.sequence - 1,
			});
			if (after.monotonicMs < before.monotonicMs || after.droppedEvents < before.droppedEvents) invalidOrdering++;
		}
	}
	const records = scope.filter((record) => Date.parse(record.timestamp) >= since && Date.parse(record.timestamp) <= until);
	const paired = Object.fromEntries([
		["run", "runId"], ["request", "requestId"], ["tool", "toolCallId"], ["job", "jobId"], ["wait", "waitId"],
	].map(([prefix, field]) => [prefix, pair(records, prefix, field)]));
	const pairing = Object.fromEntries(Object.entries(paired).map(([prefix, result]) => [prefix, {
		matched: result.pairs.length, missingStarts: result.missingStarts, missingEnds: result.missingEnds,
		ambiguous: result.ambiguous, invalidIntervals: result.invalidIntervals, uncorrelated: result.uncorrelated,
	}]));
	const incompletePairs = Object.values(pairing).some((result) =>
		result.missingStarts || result.missingEnds || result.ambiguous || result.invalidIntervals || result.uncorrelated);
	const fileProblems = (options.unreadableFiles ?? 0) + (options.oversizedFiles ?? 0);
	invalidRecords += options.unterminatedRecords ?? 0;
	const incomplete = records.length === 0 || paired.run.pairs.length === 0 || incompletePairs || partialRetention ||
		sequenceGaps.length > 0 || reportedDroppedEvents > 0 || invalidRecords > 0 || invalidOrdering > 0 ||
		conflictingDuplicates > 0 || fileProblems > 0;
	const role = (record) => parents.has(record.sessionId) ? "child" : "root";
	const logicalRequests = {};
	for (const group of ["root", "child"]) {
		const starts = records.filter((record) => record.kind === "request_start" && role(record) === group);
		const ends = records.filter((record) => record.kind === "request_end" && role(record) === group);
		const usage = ends.filter((record) => record.usage);
		const observedTokens = usage.length ? Object.fromEntries(TOKEN_KEYS.map((token) => [token,
			usage.reduce((sum, record) => sum + record.usage[token], 0),
		])) : null;
		logicalRequests[group] = {
			observedStarts: starts.length, observedEnds: ends.length,
			matched: paired.request.pairs.filter((entry) => role(entry.start) === group).length,
			withUsage: usage.length, missingUsage: ends.length - usage.length,
			observedTokens,
			tokens: !incomplete && usage.length > 0 && usage.length === starts.length && usage.length === ends.length ? observedTokens : null,
		};
	}
	const waitEnds = records.filter((record) => record.kind === "wait_end");
	const reasons = {};
	for (const record of waitEnds) if (record.reason) reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;
	const duringWaits = { root: 0, child: 0 };
	for (const request of records.filter((record) => record.kind === "request_start")) {
		if (paired.wait.pairs.some((wait) => {
			if (!isRelated(request.sessionId, wait.start.sessionId, parents)) return false;
			const time = relativeTime(request, wait.start);
			return time >= wait.start.monotonicMs && time < wait.end.monotonicMs;
		})) duringWaits[role(request)]++;
	}
	const readRecords = records.filter((record) => record.kind === "job_read");
	const previousReads = new Map();
	let activeReads = 0;
	let unknownStatusReads = 0;
	let unchangedReads = 0;
	let comparableReads = 0;
	for (const record of readRecords) {
		if (record.status === "running" || record.status === "cancelling") activeReads++;
		if (!record.status) unknownStatusReads++;
		if (!record.jobId) continue;
		const id = key(record, "jobId");
		const previous = previousReads.get(id);
		if (previous?.outputRevision !== undefined && record.outputRevision !== undefined) {
			comparableReads++;
			if (previous.outputRevision === record.outputRevision) unchangedReads++;
		}
		previousReads.set(id, record);
	}
	const jobs = paired.job.pairs.map((job) => {
		const sameJob = records.filter((record) => record.jobId && key(record, "jobId") === key(job.end, "jobId") &&
			record.sequence > job.end.sequence && record.monotonicMs >= job.end.monotonicMs);
		const read = sameJob.find((record) => record.kind === "job_read");
		const collected = sameJob.find((record) => record.kind === "job_collected");
		const observedModelOverlapMs = unionOverlap(job, paired.request.pairs, parents, false);
		const observedToolOverlapMs = unionOverlap(job, paired.tool.pairs, parents, true);
		return {
			runtimeId: job.start.runtimeId, sessionId: job.start.sessionId, jobId: job.start.jobId,
			status: job.end.status ?? null, durationMs: job.durationMs,
			observedModelOverlapMs, observedToolOverlapMs,
			modelOverlapMs: incomplete ? null : observedModelOverlapMs,
			toolOverlapMs: incomplete ? null : observedToolOverlapMs,
			completionReadLagMs: read ? read.monotonicMs - job.end.monotonicMs : null,
			completionCollectionLagMs: collected ? collected.monotonicMs - job.end.monotonicMs : null,
		};
	});
	return {
		schemaVersion: 1,
		measurement: {
			requests: "logical model requests, not an all-provider HTTP count",
			tokens: "provider-reported token/cache usage; no billed-cost estimate",
			overlap: "temporal only, not useful work; union per job; launching tool excluded",
			clock: "monotonic within a runtime; approximate UTC across runtimes",
			unavailable: "null; observed values can be partial",
		},
		filter: { session: options.session ?? null, since: options.since ?? null, until: options.until ?? null,
			excludedByTime: scope.length - records.length, excludedBySession: all.length - scope.length,
			windowMayCutPairs: options.since !== undefined || options.until !== undefined },
		integrity: {
			incomplete, filesRead: options.filesRead ?? null, unreadableFiles: options.unreadableFiles ?? 0,
			oversizedFiles: options.oversizedFiles ?? 0, invalidRecords, duplicates, conflictingDuplicates,
			sequenceGaps, reportedDroppedEvents, invalidOrdering, partialRetention,
			pairing, observedRecords: records.length,
			undetectableLoss: "An entirely missing runtime or events after the final retained record may be undetectable.",
		},
		logicalRequests,
		requestsStartedDuringWaits: {
			observedRoot: duringWaits.root, observedChild: duringWaits.child,
			root: incomplete ? null : duringWaits.root, child: incomplete ? null : duringWaits.child,
		},
		waits: {
			observedStarts: records.filter((record) => record.kind === "wait_start").length,
			observedEnds: waitEnds.length, durations: statistics(paired.wait.pairs.map((wait) => wait.durationMs)),
			reasons, unknownReasons: waitEnds.filter((record) => !record.reason).length,
		},
		reads: {
			observed: readRecords.length, observedActive: activeReads, unknownStatus: unknownStatusReads,
			active: unknownStatusReads || incomplete ? null : activeReads,
			observedUnchanged: unchangedReads, comparable: comparableReads,
			unchanged: comparableReads ? unchangedReads : null,
			unavailableComparisons: readRecords.length - comparableReads,
		},
		jobs,
		completionReadLag: statistics(jobs.flatMap((job) => job.completionReadLagMs === null ? [] : [job.completionReadLagMs])),
		completionCollectionLag: statistics(jobs.flatMap((job) => job.completionCollectionLagMs === null ? [] : [job.completionCollectionLagMs])),
	};
}

/** Read only owned-format regular completed batches. Never follow symlinks or read temp files. */
export async function summarizeBackgroundJobPerformance(options) {
	if (!options?.dir) throw new Error("--dir is required");
	validateFilters(options);
	const directory = resolve(options.dir);
	const directoryStat = await lstat(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Expected a regular diagnostics directory");
	const entries = await readdir(directory, { withFileTypes: true });
	const events = [];
	const counts = { filesRead: 0, unreadableFiles: 0, oversizedFiles: 0, invalidRecords: 0, unterminatedRecords: 0 };
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !OWNED_FILE.test(entry.name)) continue;
		let handle;
		try {
			const path = join(directory, entry.name);
			const stat = await lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
			if (stat.size >= 256 * 1024) { counts.oversizedFiles++; continue; }
			handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const actual = await handle.stat();
			if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size !== stat.size) {
				counts.unreadableFiles++;
				continue;
			}
			const content = await handle.readFile("utf8");
			counts.filesRead++;
			if (content && !content.endsWith("\n")) counts.unterminatedRecords++;
			for (const line of content.split("\n")) {
				if (!line) continue;
				if (Buffer.byteLength(line) + 1 > 4 * 1024) { counts.invalidRecords++; continue; }
				try { events.push(JSON.parse(line)); } catch { counts.invalidRecords++; }
			}
		} catch {
			counts.unreadableFiles++;
		} finally {
			await handle?.close();
		}
	}
	return summarizeBackgroundJobEvents(events, { ...options, ...counts });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const options = parseBackgroundJobPerformanceArgs(process.argv.slice(2));
		if (options.help) process.stdout.write(HELP);
		else process.stdout.write(`${JSON.stringify(await summarizeBackgroundJobPerformance(options), null, 2)}\n`);
	} catch (error) {
		process.stderr.write(`Background job report failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
		process.exitCode = 1;
	}
}
