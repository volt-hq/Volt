import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
	HELP,
	parseBackgroundJobPerformanceArgs,
	summarizeBackgroundJobEvents,
	summarizeBackgroundJobPerformance,
} from "./summarize-background-job-performance.mjs";

const origin = Date.parse("2026-09-10T12:00:00.000Z");
const tokens = { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, totalTokens: 37 };

function fixture() {
	const events = [];
	const sequences = new Map();
	function event(kind, ms, extra = {}) {
		const runtimeId = extra.runtimeId ?? "runtime-root";
		const sequence = (sequences.get(runtimeId) ?? 0) + 1;
		sequences.set(runtimeId, sequence);
		const result = {
			schemaVersion: 1, runtimeId, sessionId: "session-root", sequence, timestamp: new Date(origin + ms).toISOString(),
			monotonicMs: ms, droppedEvents: 0, kind, ...extra,
		};
		events.push(result);
		return result;
	}
	return { events, event };
}

function ownedName(index = 1) {
	return `background-jobs-v1_2026-09-10T12-00-00-000Z_12345678-1234-4234-8234-123456789abc_${String(index).padStart(8, "0")}.jsonl`;
}

function completeFixture() {
	const { events, event } = fixture();
	event("run_start", 0, { runId: "root-run" });
	event("tool_start", 5, { toolCallId: "launcher" });
	event("job_start", 10, { jobId: "job-1", toolCallId: "launcher" });
	event("tool_end", 15, { toolCallId: "launcher" });
	event("wait_start", 20, { waitId: "wait-1", jobIds: ["job-1"], mode: "all" });
	event("request_start", 30, { requestId: "request-root" });
	event("request_end", 50, { requestId: "request-root", usage: tokens });
	event("tool_start", 60, { toolCallId: "other-tool" });
	event("tool_end", 80, { toolCallId: "other-tool" });
	event("job_read", 81, { jobId: "job-1", status: "running", outputRevision: 1 });
	event("job_read", 82, { jobId: "job-1", status: "cancelling", outputRevision: 1 });
	event("job_read", 83, { jobId: "job-1", status: "running", outputRevision: 2 });
	event("job_end", 100, { jobId: "job-1", status: "completed" });
	event("wait_end", 105, { waitId: "wait-1", reason: "terminal" });
	event("job_read", 110, { jobId: "job-1", status: "completed", outputRevision: 2 });
	event("job_collected", 120, { jobId: "job-1", action: "read" });
	event("run_end", 130, { runId: "root-run" });
	const child = { runtimeId: "runtime-child", sessionId: "session-child", parentSessionId: "session-root" };
	event("run_start", 20, { ...child, runId: "child-run" });
	event("request_start", 40, { ...child, requestId: "request-child" });
	event("request_end", 70, { ...child, requestId: "request-child", usage: tokens });
	event("run_end", 90, { ...child, runId: "child-run" });
	return events;
}

describe("background performance CLI", () => {
	test("requires an explicit directory and validates UTC filter bounds", () => {
		assert.throws(() => parseBackgroundJobPerformanceArgs([]), /--dir is required/);
		assert.throws(() => parseBackgroundJobPerformanceArgs(["--dir"]), /Missing value/);
		assert.throws(() => parseBackgroundJobPerformanceArgs(["--directory", "somewhere"]), /Unknown option/);
		assert.throws(() => parseBackgroundJobPerformanceArgs(["--dir", "a", "--dir", "b"]), /Duplicate option/);
		for (const value of ["2026-09-10", "2026-09-10T12:00:00+00:00", "2026-02-30T00:00:00Z", "not-a-date"]) {
			assert.throws(() => parseBackgroundJobPerformanceArgs(["--dir", "a", "--since", value]), /Invalid --since/);
		}
		assert.throws(() => parseBackgroundJobPerformanceArgs([
			"--dir", "a", "--since", "2026-09-11T00:00:00Z", "--until", "2026-09-10T00:00:00Z",
		]), /later than/);
		assert.deepEqual(parseBackgroundJobPerformanceArgs([
			"--dir", "a", "--session", "s", "--since", "2026-09-10T12:00:00Z", "--until", "2026-09-10T13:00:00.000Z",
		]), { dir: "a", session: "s", since: "2026-09-10T12:00:00Z", until: "2026-09-10T13:00:00.000Z" });
	});

	test("is import-safe and supplies CLI help without inspecting a default directory", () => {
		assert.match(HELP, /null means unavailable/);
		assert.match(HELP, /not an all-provider HTTP count/);
		assert.match(HELP, /no billed-cost or useful-work claims/);
		const script = fileURLToPath(new URL("./summarize-background-job-performance.mjs", import.meta.url));
		const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, HELP);
		const missing = spawnSync(process.execPath, [script], { encoding: "utf8" });
		assert.equal(missing.status, 1);
		assert.equal(missing.stdout, "");
		assert.match(missing.stderr, /--dir is required/);
	});
});

describe("background performance metadata summary", () => {
	test("separates logical root and child requests, tokens, and cache totals", () => {
		const report = summarizeBackgroundJobEvents(completeFixture());
		assert.equal(report.integrity.incomplete, false);
		for (const group of ["root", "child"]) {
			assert.deepEqual(report.logicalRequests[group], {
				observedStarts: 1, observedEnds: 1, matched: 1, withUsage: 1, missingUsage: 0,
				observedTokens: tokens, tokens,
			});
		}
		assert.deepEqual(report.requestsStartedDuringWaits, { observedRoot: 1, observedChild: 1, root: 1, child: 1 });
		assert.deepEqual(report.waits.durations, { samples: 1, totalMs: 85, minMs: 85, maxMs: 85, meanMs: 85 });
		assert.deepEqual(report.waits.reasons, { terminal: 1 });
		assert.deepEqual(report.reads, {
			observed: 4, observedActive: 3, unknownStatus: 0, active: 3,
			observedUnchanged: 2, comparable: 3, unchanged: 2, unavailableComparisons: 1,
		});
	});

	test("uses unioned temporal overlap and measures completion-read and collection lag", () => {
		const report = summarizeBackgroundJobEvents(completeFixture());
		assert.deepEqual(report.jobs, [{
			runtimeId: "runtime-root", sessionId: "session-root", jobId: "job-1", status: "completed", durationMs: 90,
			observedModelOverlapMs: 40, modelOverlapMs: 40, observedToolOverlapMs: 20, toolOverlapMs: 20,
			completionReadLagMs: 10, completionCollectionLagMs: 20,
		}]);
		assert.equal(report.completionReadLag.meanMs, 10);
		assert.equal(report.completionCollectionLag.meanMs, 20);
	});

	test("uses monotonic duration despite wall-clock adjustments", () => {
		const events = completeFixture().filter((record) => record.runtimeId === "runtime-root");
		for (const record of events) if (record.kind.endsWith("_end")) record.timestamp = new Date(origin - 10000).toISOString();
		const report = summarizeBackgroundJobEvents(events);
		assert.equal(report.waits.durations.totalMs, 85);
		assert.equal(report.jobs[0].durationMs, 90);
		assert.equal(report.jobs[0].modelOverlapMs, 20);
	});

	test("reports every wait reason and does not guess durations for missing ends", () => {
		const { event, events } = fixture();
		event("run_start", 0, { runId: "run" });
		let ms = 1;
		for (const reason of ["terminal", "steered", "timeout", "aborted", "revoked"]) {
			event("wait_start", ms++, { waitId: reason });
			event("wait_end", ms++, { waitId: reason, reason });
		}
		event("wait_start", ms++, { waitId: "missing" });
		event("run_end", ms++, { runId: "run" });
		const report = summarizeBackgroundJobEvents(events);
		assert.deepEqual(report.waits.reasons, { terminal: 1, steered: 1, timeout: 1, aborted: 1, revoked: 1 });
		assert.equal(report.waits.durations.samples, 5);
		assert.equal(report.integrity.pairing.wait.missingEnds, 1);
		assert.equal(report.requestsStartedDuringWaits.root, null);
		assert.equal(report.integrity.incomplete, true);
	});

	test("keeps absent usage, reads, overlaps, and collection metrics unavailable", () => {
		const empty = summarizeBackgroundJobEvents([]);
		assert.equal(empty.integrity.incomplete, true);
		assert.equal(empty.logicalRequests.root.tokens, null);
		assert.equal(empty.logicalRequests.child.tokens, null);
		assert.equal(empty.reads.active, null);
		assert.equal(empty.reads.unchanged, null);
		assert.equal(empty.waits.durations, null);
		assert.equal(empty.completionCollectionLag, null);
		const { event, events } = fixture();
		event("run_start", 0, { runId: "run" });
		event("request_start", 1, { requestId: "request" });
		event("request_end", 2, { requestId: "request" });
		event("job_start", 3, { jobId: "job" });
		event("job_end", 4, { jobId: "job" });
		event("job_read", 5, { jobId: "job" });
		event("run_end", 6, { runId: "run" });
		const report = summarizeBackgroundJobEvents(events);
		assert.equal(report.logicalRequests.root.tokens, null);
		assert.equal(report.logicalRequests.root.observedTokens, null);
		assert.equal(report.logicalRequests.root.missingUsage, 1);
		assert.equal(report.reads.active, null);
		assert.equal(report.reads.unchanged, null);
		assert.equal(report.jobs[0].completionCollectionLagMs, null);
		assert.equal(report.jobs[0].modelOverlapMs, 0);
	});

	test("does not count retries or cache usage twice when a batch is duplicated", () => {
		const events = completeFixture();
		const report = summarizeBackgroundJobEvents([...events, ...events]);
		assert.equal(report.integrity.duplicates, events.length);
		assert.equal(report.integrity.conflictingDuplicates, 0);
		assert.equal(report.integrity.incomplete, false);
		assert.equal(report.logicalRequests.root.tokens.totalTokens, 37);
		const conflict = { ...events[0], monotonicMs: 5 };
		const conflicting = summarizeBackgroundJobEvents([...events, conflict]);
		assert.equal(conflicting.integrity.conflictingDuplicates, 1);
		assert.equal(conflicting.logicalRequests.root.tokens, null);
	});

	test("detects sequence gaps, cumulative drops, missing ends, and partial retention", () => {
		const events = completeFixture().filter((record) => record.runtimeId === "runtime-root" && ![1, 4, 17].includes(record.sequence));
		events.at(-1).droppedEvents = 2;
		const report = summarizeBackgroundJobEvents(events);
		assert.equal(report.integrity.partialRetention, true);
		assert.equal(report.integrity.reportedDroppedEvents, 2);
		assert.deepEqual(report.integrity.sequenceGaps, [{
			runtimeId: "runtime-root", afterSequence: 3, beforeSequence: 5, missingRecords: 1,
		}]);
		assert.equal(report.integrity.pairing.tool.missingEnds, 1);
		assert.equal(report.logicalRequests.root.observedTokens.totalTokens, 37);
		assert.equal(report.logicalRequests.root.tokens, null);
		assert.equal(report.jobs[0].modelOverlapMs, null);
		assert.equal(report.jobs[0].observedModelOverlapMs, 20);
	});

	test("surfaces trailing drops without a later sequence and never sums cumulative counters", () => {
		const events = completeFixture();
		for (const record of events) if (record.runtimeId === "runtime-root" && record.sequence >= 10) record.droppedEvents = 7;
		const report = summarizeBackgroundJobEvents(events);
		assert.equal(report.integrity.reportedDroppedEvents, 7);
		assert.equal(report.integrity.incomplete, true);
	});

	test("filters the selected session and descendants without counting another session's sequence as a gap", () => {
		const events = completeFixture();
		const other = { ...events[0], sessionId: "session-unrelated", runId: "unrelated", sequence: 18, monotonicMs: 140 };
		events.push(other, { ...other, kind: "run_end", sequence: 19, monotonicMs: 150 });
		const root = summarizeBackgroundJobEvents(events, { session: "session-root" });
		assert.equal(root.logicalRequests.child.observedStarts, 1);
		assert.equal(root.filter.excludedBySession, 2);
		assert.deepEqual(root.integrity.sequenceGaps, []);
		const child = summarizeBackgroundJobEvents(events, { session: "session-child" });
		assert.equal(child.logicalRequests.root.observedStarts, 0);
		assert.equal(child.logicalRequests.child.observedStarts, 1);
		assert.equal(child.logicalRequests.child.tokens.totalTokens, 37);
	});

	test("marks time-filter boundaries and leaves cut request and wait totals unavailable", () => {
		const report = summarizeBackgroundJobEvents(completeFixture(), {
			since: new Date(origin + 35).toISOString(), until: new Date(origin + 110).toISOString(),
		});
		assert.equal(report.filter.windowMayCutPairs, true);
		assert.ok(report.filter.excludedByTime > 0);
		assert.equal(report.integrity.pairing.request.missingStarts, 1);
		assert.equal(report.integrity.pairing.wait.missingStarts, 1);
		assert.equal(report.logicalRequests.root.tokens, null);
		assert.equal(report.logicalRequests.root.observedTokens.totalTokens, 37);
		assert.equal(report.waits.durations, null);
		assert.equal(report.integrity.partialRetention, false);
	});

	test("detects missing IDs, duplicate lifecycle IDs, invalid intervals, and malformed records", () => {
		const { event, events } = fixture();
		event("run_start", 0, { runId: "run" });
		event("request_start", 1);
		event("wait_start", 2, { waitId: "wait" });
		event("wait_start", 3, { waitId: "wait" });
		event("wait_end", 4, { waitId: "wait" });
		event("tool_start", 8, { toolCallId: "tool" });
		event("tool_end", 7, { toolCallId: "tool" });
		event("run_end", 9, { runId: "run" });
		const report = summarizeBackgroundJobEvents([...events, { kind: "secret" }, null]);
		assert.equal(report.integrity.invalidRecords, 2);
		assert.equal(report.integrity.pairing.request.uncorrelated, 1);
		assert.equal(report.integrity.pairing.wait.ambiguous, 1);
		assert.equal(report.integrity.pairing.tool.invalidIntervals, 1);
		assert.equal(report.integrity.invalidOrdering, 1);
		assert.equal(report.integrity.incomplete, true);
	});

	test("treats an unknown intermediate output revision as an unavailable comparison", () => {
		const { event, events } = fixture();
		event("job_read", 0, { jobId: "job", outputRevision: 1 });
		event("job_read", 1, { jobId: "job" });
		event("job_read", 2, { jobId: "job", outputRevision: 1 });
		assert.equal(summarizeBackgroundJobEvents(events).reads.unchanged, null);
	});

	test("does not expose unspecified record fields or nested payloads", () => {
		const events = completeFixture();
		for (const record of events) {
			record.prompt = "secret-prompt";
			record.command = "secret-command";
			if (record.usage) record.usage = { ...record.usage, payload: "secret-nested" };
		}
		assert.doesNotMatch(JSON.stringify(summarizeBackgroundJobEvents(events)), /secret-/);
	});
});

describe("background performance completed batch reader", () => {
	test("reads only owned regular batches and returns the same metrics through the CLI", async () => {
		const directory = await mkdtemp(join(tmpdir(), "volt-background-report-"));
		try {
			const events = completeFixture();
			await writeFile(join(directory, ownedName()), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
			await writeFile(join(directory, "foreign.jsonl"), "secret-foreign");
			await writeFile(join(directory, `${ownedName(2)}.tmp`), "secret-temporary");
			await mkdir(join(directory, ownedName(3)));
			const target = join(directory, "target");
			await mkdir(target);
			await symlink(target, join(directory, ownedName(4)), process.platform === "win32" ? "junction" : "dir");
			const report = await summarizeBackgroundJobPerformance({ dir: directory });
			assert.equal(report.integrity.filesRead, 1);
			assert.equal(report.integrity.invalidRecords, 0);
			assert.equal(report.logicalRequests.root.tokens.totalTokens, 37);
			const script = fileURLToPath(new URL("./summarize-background-job-performance.mjs", import.meta.url));
			const result = spawnSync(process.execPath, [script, "--dir", directory], { encoding: "utf8", cwd: resolve(tmpdir()) });
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(JSON.parse(result.stdout), report);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test("reports truncated, malformed, oversized, and unsupported-schema data instead of false complete totals", async () => {
		const directory = await mkdtemp(join(tmpdir(), "volt-background-report-"));
		try {
			const valid = completeFixture();
			await writeFile(join(directory, ownedName()), `${valid.map((event) => JSON.stringify(event)).join("\n")}\n`);
			await writeFile(join(directory, ownedName(2)), `{broken}\n${"x".repeat(4096)}\n${JSON.stringify({ ...valid[0], schemaVersion: 2 })}`);
			const huge = await open(join(directory, ownedName(3)), "wx");
			await huge.truncate(256 * 1024);
			await huge.close();
			const report = await summarizeBackgroundJobPerformance({ dir: directory });
			assert.equal(report.integrity.filesRead, 2);
			assert.equal(report.integrity.oversizedFiles, 1);
			assert.equal(report.integrity.invalidRecords, 4);
			assert.equal(report.logicalRequests.root.tokens, null);
			assert.equal(report.logicalRequests.root.observedTokens.totalTokens, 37);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
});
