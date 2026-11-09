import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	chainsCommands,
	formatRunCodeStats,
	parseRunCodeStatsArgs,
	peakInFlight,
	scriptPatterns,
	summarizeRunCodeUsage,
} from "./run-code-stats.mjs";

const statsScript = join(dirname(fileURLToPath(import.meta.url)), "run-code-stats.mjs");

function nested(seq, startMs, durationMs, tool = "read") {
	return { seq, tool, status: "completed", readOnly: true, startMs, durationMs };
}

function details(calls, extra = {}) {
	return JSON.stringify({
		status: "completed",
		language: "javascript",
		wallMs: Math.max(1, ...calls.map((call) => (call.startMs ?? 0) + call.durationMs)),
		calls,
		callTotals: { completed: calls.length, failed: 0, cancelled: 0, unsettled: 0 },
		complete: true,
		...extra,
	});
}

describe("peakInFlight", () => {
	test("counts calls issued together and not calls awaited one after another, allowing for rounding", () => {
		assert.equal(peakInFlight([]), 0);
		assert.equal(peakInFlight([nested(1, 0, 50), nested(2, 0, 50), nested(3, 1, 40)]), 3);
		// Rounded independently, a call issued as the previous settles can appear to start 1 ms early.
		assert.equal(peakInFlight([nested(1, 1, 11), nested(2, 11, 20), nested(3, 31, 5)]), 1);
		// Overlaps within the tolerance do not count.
		assert.equal(peakInFlight([nested(1, 0, 1), nested(2, 0, 1)]), 1);
	});

	test("counts a call of any duration issued well inside another's span", () => {
		assert.equal(peakInFlight([nested(1, 0, 100), nested(2, 10, 1)]), 2);
		assert.equal(peakInFlight([nested(1, 0, 100), nested(2, 10, 0)]), 2);
		assert.equal(peakInFlight([nested(1, 0, 100), nested(2, 10, 1), nested(3, 50, 1)]), 2);
		// In the same millisecond, issue order decides: a short call issued after a long one overlaps it.
		assert.equal(peakInFlight([nested(1, 10, 100), nested(2, 10, 1)]), 2);
		assert.equal(peakInFlight([nested(1, 10, 1), nested(2, 10, 100)]), 1);
	});
});

describe("scriptPatterns", () => {
	test("finds Promise combinators and awaits inside loops", () => {
		assert.deepEqual(scriptPatterns("const r = await Promise.allSettled(paths.map((path) => tools.read({ path })));"), {
			concurrencyHelper: true,
			awaitInLoop: false,
		});
		assert.deepEqual(scriptPatterns("for (const path of paths) {\n  const text = await tools.read({ path });\n}"), {
			concurrencyHelper: false,
			awaitInLoop: true,
		});
		assert.equal(scriptPatterns("for (let i = 0; i < 3; i++) await tools.read({ path: `${i}` });").awaitInLoop, true);
		assert.equal(scriptPatterns("for await (const chunk of stream) text(chunk);").awaitInLoop, true);
		assert.equal(scriptPatterns("for (const p of paths) jobs.push(tools.read({ path: p }));\nawait Promise.all(jobs);").awaitInLoop, false);
	});
});

describe("chainsCommands", () => {
	test("counts separators outside quotes, after any leading cd", () => {
		assert.equal(chainsCommands("ls; pwd"), true);
		assert.equal(chainsCommands("npm ci && npm test"), true);
		assert.equal(chainsCommands("rg foo\nrg bar"), true);
		assert.equal(chainsCommands("cd packages/ai && npm run build"), false);
		assert.equal(chainsCommands("cd a && cd 'b c' && rg x && rg y"), true);
		assert.equal(chainsCommands("ls | wc -l"), false);
		assert.equal(chainsCommands(`sqlite3 db "SELECT 1; SELECT 2;"`), false);
		assert.equal(chainsCommands("git commit -m 'a; b'"), false);
		assert.equal(chainsCommands(undefined), false);
	});
});

describe("summarizeRunCodeUsage", () => {
	const model = { provider: "faux", model: "m1" };
	const callRows = [
		// A turn with two parallel direct calls, one chaining shell commands.
		{ session: "s1", ordinal: 1, ...model, id: "b1", name: "bash", input: "ls; pwd" },
		{ session: "s1", ordinal: 1, ...model, id: "r1", name: "read", input: null },
		{ session: "s1", ordinal: 3, ...model, id: "b2", name: "bash", input: "ls | wc -l" },
		{ session: "s1", ordinal: 5, ...model, id: "c1", name: "run_code", input: "await Promise.all([tools.read({ path: 'a' }), tools.read({ path: 'b' })]);" },
		{ session: "s1", ordinal: 7, ...model, id: "c2", name: "run_code", input: "for (const p of ps) { await tools.read({ path: p }); }" },
		{ session: "s2", ordinal: 1, ...model, id: "c3", name: "run_code", input: "await tools.read({ path: 'a' }); await tools.read({ path: 'b' });" },
		{ session: "s2", ordinal: 3, ...model, id: "c4", name: "run_code", input: "await tools.read({ path: 'a' }); await tools.read({ path: 'b' });" },
		{ session: "s2", ordinal: 5, ...model, id: "c5", name: "run_code", input: "await tools.read({ path: 'a' });" },
		{ session: "s2", ordinal: 7, ...model, id: "c6", name: "run_code", input: "return 1;" },
		{ session: "s3", ordinal: 1, provider: "faux", model: "m2", id: "x1", name: "read", input: null },
	];
	const resultRows = [
		{ session: "s1", id: "c1", details: details([nested(1, 2, 30), nested(2, 2, 25)]) },
		{ session: "s1", id: "c2", details: details([nested(1, 2, 10), nested(2, 12, 10), nested(3, 22, 10)]) },
		// Too fast to tell apart at millisecond precision.
		{ session: "s2", id: "c3", details: details([nested(1, 2, 0), nested(2, 3, 0)]) },
		// Recorded before startMs existed.
		{ session: "s2", id: "c4", details: details([{ seq: 1, tool: "read", status: "completed", durationMs: 9 }, { seq: 2, tool: "read", status: "completed", durationMs: 9 }]) },
		{ session: "s2", id: "c5", details: details([nested(1, 2, 5)], { status: "failed" }) },
	];

	test("counts selection per model and classifies scripts by how they issued their calls", () => {
		const report = summarizeRunCodeUsage(callRows, resultRows, { examples: 5 });
		assert.deepEqual(
			report.models.map((stats) => stats.model),
			["faux/m1", "faux/m2"],
		);
		const [stats] = report.models;
		assert.equal(stats.sessions, 2);
		assert.equal(stats.runCodeSessions, 2);
		assert.equal(stats.toolTurns, 8);
		assert.equal(stats.toolCalls, 9);
		assert.equal(stats.parallelTurns, 1);
		assert.equal(stats.runCodeTurns, 6);
		assert.equal(stats.bashCalls, 2);
		assert.equal(stats.chainedBashCalls, 1);
		const { sequentialExamples, ...scripts } = stats.scripts;
		assert.deepEqual(scripts, {
			total: 6,
			missingResult: 1,
			failed: 1,
			nestedCalls: 10,
			multiCall: 4,
			concurrent: 1,
			sequential: 1,
			unresolved: 1,
			untimed: 1,
			concurrencyHelper: 1,
			awaitInLoop: 1,
			medianCallsPerMultiCallScript: 2,
			medianPeakInFlight: 1,
			maxPeakInFlight: 2,
			// Untimed scripts still give the estimate: [0, 0.94, 1.72, 2].
			medianDurationSumOverWall: 1.33,
		});
		assert.deepEqual(sequentialExamples, [
			{ session: "s1", toolCallId: "c2", calls: 3, tools: ["read"], code: callRows[4].input },
		]);
		assert.match(formatRunCodeStats(report), /with 2\+ calls: 4; concurrent 1, sequential 1, unresolved 1, untimed 1/);
	});

	test("filters by model and treats records dropped to fit the bound as unresolved", () => {
		const incomplete = [{ session: "s1", id: "c2", details: details([nested(1, 2, 10), nested(3, 22, 10)], { complete: false, callTotals: { completed: 3, failed: 0, cancelled: 0, unsettled: 0 } }) }];
		const report = summarizeRunCodeUsage(callRows, incomplete, { model: "m1" });
		assert.deepEqual(
			report.models.map((stats) => stats.model),
			["faux/m1"],
		);
		assert.equal(report.models[0].scripts.unresolved, 1);
		assert.equal(report.models[0].scripts.sequential, 0);
	});

	test("classifies a short call issued while a longer one runs as concurrent", () => {
		const overlapping = [{ session: "s1", id: "c2", details: details([nested(1, 0, 100), nested(2, 10, 1)]) }];
		const { scripts } = summarizeRunCodeUsage(callRows, overlapping, { model: "m1" }).models[0];
		assert.equal(scripts.concurrent, 1);
		assert.equal(scripts.sequential, 0);
		assert.equal(scripts.maxPeakInFlight, 2);
	});
});

describe("run-code-stats CLI", () => {
	test("reads a session store read-only, honoring --since", () => {
		const dir = mkdtempSync(join(tmpdir(), "volt-run-code-stats-"));
		try {
			const path = join(dir, "sessions.sqlite");
			const db = new DatabaseSync(path);
			db.exec(
				"CREATE TABLE entries (session_id TEXT, entry_id TEXT, ordinal INTEGER, entry_type TEXT, timestamp TEXT, payload_json TEXT)",
			);
			const insert = db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)");
			const add = (ordinal, timestamp, message) =>
				insert.run("s1", `e${ordinal}`, ordinal, "message", timestamp, JSON.stringify({ type: "message", message }));
			add(1, "2026-01-01T00:00:00.000Z", {
				role: "assistant",
				provider: "faux",
				model: "old",
				content: [{ type: "toolCall", id: "t0", name: "read", arguments: { path: "a" } }],
			});
			add(2, "2026-02-01T00:00:00.000Z", {
				role: "assistant",
				provider: "faux",
				model: "new",
				content: [
					{ type: "text", text: "running" },
					{ type: "toolCall", id: "t1", name: "run_code", arguments: { code: "await Promise.all([tools.read({ path: 'a' }), tools.read({ path: 'b' })]);" } },
				],
			});
			add(3, "2026-02-01T00:00:01.000Z", {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "run_code",
				content: [{ type: "text", text: "Script completed" }],
				details: JSON.parse(details([nested(1, 2, 30), nested(2, 2, 30)])),
			});
			insert.run("s1", "e4", 4, "model_change", "2026-02-01T00:00:02.000Z", "{}");
			db.close();

			const run = spawnSync(process.execPath, [statsScript, "--db", path, "--since", "2026-01-15", "--json"], {
				encoding: "utf8",
			});
			assert.equal(run.status, 0, run.stderr);
			const report = JSON.parse(run.stdout);
			assert.equal(report.since, "2026-01-15T00:00:00.000Z");
			assert.deepEqual(
				report.models.map((stats) => stats.model),
				["faux/new"],
			);
			assert.equal(report.models[0].runCodeTurns, 1);
			assert.equal(report.models[0].scripts.concurrent, 1);
			assert.equal(report.models[0].scripts.maxPeakInFlight, 2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects invalid arguments", () => {
		assert.throws(() => parseRunCodeStatsArgs(["--since", "soon"]), /not a date/);
		assert.throws(() => parseRunCodeStatsArgs(["--examples", "-1"]), /non-negative/);
		assert.throws(() => parseRunCodeStatsArgs(["--bogus"]), /unknown argument/);
	});
});
