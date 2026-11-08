#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

/**
 * Summarizes how models used code mode, from a local session store: how often they chose `run_code` over direct
 * tool calls, and whether their scripts issued independent nested calls concurrently. Reads the store read-only.
 */

const DEFAULT_EXAMPLES = 3;
const EXAMPLE_CODE_CHARS = 400;
/** `startMs` and `durationMs` are rounded independently, so an end can be off by up to 1.5 ms. */
const OVERLAP_TOLERANCE_MS = 1;
/** Calls issued at least this far apart, and not overlapping, were awaited one after another. */
const RESOLVABLE_GAP_MS = 2 * OVERLAP_TOLERANCE_MS + 1;

export const HELP = `Usage: node scripts/run-code-stats.mjs [--db <sessions.sqlite>] [--since <date>] [--model <text>]
       [--examples <n>] [--json]

Summarizes code mode usage per model from a session store, read-only.

  --db <path>      Session store (default: $VOLT_CODING_AGENT_DIR/sessions/sessions.sqlite,
                   or ~/.volt/agent/sessions/sessions.sqlite)
  --since <date>   Only entries at or after this date. Sessions do not record which tools were
                   active, so use the date code mode was enabled to make selection rates meaningful.
  --model <text>   Only models whose provider/model contains this text
  --examples <n>   Sequential multi-call scripts to show per model (default: ${DEFAULT_EXAMPLES})
  --json           Print the report as JSON

Scripts with two or more nested calls are classified from each call's issue time (startMs) and
duration: concurrent when calls were in flight at once, sequential when each was issued after the
previous one settled, unresolved when calls were too fast to tell apart at millisecond precision or
records were dropped, and untimed for results recorded before startMs existed.
`;

export function parseRunCodeStatsArgs(argv) {
	const agentDir = process.env.VOLT_CODING_AGENT_DIR || join(homedir(), ".volt", "agent");
	const options = {
		db: join(agentDir, "sessions", "sessions.sqlite"),
		since: undefined,
		model: undefined,
		examples: DEFAULT_EXAMPLES,
		json: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--db") options.db = resolve(value());
		else if (arg === "--model") options.model = value();
		else if (arg === "--since") {
			const since = value();
			const parsed = Date.parse(since);
			if (Number.isNaN(parsed)) throw new Error(`--since is not a date: ${since}`);
			options.since = new Date(parsed).toISOString();
		} else if (arg === "--examples") {
			const examples = Number(value());
			if (!Number.isInteger(examples) || examples < 0) throw new Error("--examples must be a non-negative integer");
			options.examples = examples;
		} else throw new Error(`unknown argument: ${arg}`);
	}
	return options;
}

/**
 * The most nested calls a script had in flight at once, from each call's issue time and duration. Overlaps within
 * the rounding tolerance do not count, so calls shorter than the tolerance never overlap.
 */
export function peakInFlight(calls) {
	if (calls.length === 0) return 0;
	const events = [];
	for (const { startMs, durationMs } of calls) {
		const end = startMs + durationMs - OVERLAP_TOLERANCE_MS;
		if (end > startMs) events.push([startMs, 1], [end, -1]);
	}
	// At equal times, ends come before starts: a call issued as another settles does not overlap it.
	events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let inFlight = 0;
	let peak = 1;
	for (const [, delta] of events) {
		inFlight += delta;
		peak = Math.max(peak, inFlight);
	}
	return peak;
}

/** The index just past the bracket that closes the one at `open`, or -1. */
function closingIndex(text, open) {
	const openChar = text[open];
	const closeChar = openChar === "(" ? ")" : "}";
	let depth = 0;
	for (let index = open; index < text.length; index++) {
		if (text[index] === openChar) depth++;
		else if (text[index] === closeChar && --depth === 0) return index + 1;
	}
	return -1;
}

const LOOP_HEADER = /\b(?:for|while)\s*(await\s*)?\(/g;

/**
 * Heuristics over a script's source: whether it uses a `Promise` combinator, and whether it awaits inside a loop,
 * which issues the loop's calls one after another. Neither parses the script; strings and comments can mislead them.
 */
export function scriptPatterns(code) {
	const concurrencyHelper = /\bPromise\s*\.\s*(?:all|allSettled|any|race)\s*\(/.test(code);
	let awaitInLoop = false;
	for (const match of code.matchAll(LOOP_HEADER)) {
		if (match[1] !== undefined) {
			awaitInLoop = true;
			break;
		}
		const headerEnd = closingIndex(code, match.index + match[0].length - 1);
		if (headerEnd < 0) continue;
		const rest = code.slice(headerEnd).trimStart();
		let body;
		if (rest.startsWith("{")) {
			const end = closingIndex(rest, 0);
			body = end < 0 ? rest : rest.slice(0, end);
		} else {
			const end = rest.search(/[;\n]/);
			body = end < 0 ? rest : rest.slice(0, end);
		}
		if (/\bawait\b/.test(body)) {
			awaitInLoop = true;
			break;
		}
	}
	return { concurrencyHelper, awaitInLoop };
}

const LEADING_CD = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/;

/**
 * Whether a bash command runs several commands in sequence: a `;`, `&&`, `||`, or line break outside quotes, after
 * any leading `cd <dir> &&`. A heuristic: heredoc bodies and escaped quotes can mislead it.
 */
export function chainsCommands(command) {
	if (typeof command !== "string") return false;
	const text = command.trim().replace(LEADING_CD, "");
	let quote;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		else if (char === ";" || char === "\n") return true;
		else if ((char === "&" || char === "|") && text[index + 1] === char) return true;
	}
	return false;
}

function median(values) {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isTimed(call) {
	return typeof call?.startMs === "number" && typeof call?.durationMs === "number";
}

/** How a script with two or more nested calls issued them. */
function classify(details, calls) {
	if (!calls.every(isTimed)) return { kind: "untimed" };
	const peak = peakInFlight(calls);
	if (peak > 1) return { kind: "concurrent", peak };
	if (details.complete === false) return { kind: "unresolved", peak };
	const ordered = [...calls].sort((a, b) => a.seq - b.seq);
	for (let index = 1; index < ordered.length; index++) {
		if (ordered[index].startMs - ordered[index - 1].startMs < RESOLVABLE_GAP_MS) return { kind: "unresolved", peak };
	}
	return { kind: "sequential", peak };
}

function newModelStats(label) {
	return {
		model: label,
		sessions: new Set(),
		runCodeSessions: new Set(),
		toolTurns: 0,
		toolCalls: 0,
		parallelTurns: 0,
		runCodeTurns: 0,
		bashCalls: 0,
		chainedBashCalls: 0,
		scripts: {
			total: 0,
			missingResult: 0,
			failed: 0,
			nestedCalls: 0,
			multiCall: 0,
			concurrent: 0,
			sequential: 0,
			unresolved: 0,
			untimed: 0,
			concurrencyHelper: 0,
			awaitInLoop: 0,
			callCounts: [],
			peaks: [],
			overlapRatios: [],
			sequentialExamples: [],
		},
	};
}

function parseDetails(raw) {
	if (typeof raw !== "string") return undefined;
	try {
		const details = JSON.parse(raw);
		return details !== null && typeof details === "object" && details.status !== "running" ? details : undefined;
	} catch {
		return undefined;
	}
}

function recordScript(stats, call, rawDetails, examples) {
	const scripts = stats.scripts;
	scripts.total++;
	const code = typeof call.input === "string" ? call.input : "";
	const patterns = scriptPatterns(code);
	if (patterns.concurrencyHelper) scripts.concurrencyHelper++;
	if (patterns.awaitInLoop) scripts.awaitInLoop++;
	const details = parseDetails(rawDetails);
	if (!details) {
		scripts.missingResult++;
		return;
	}
	if (details.status === "failed") scripts.failed++;
	const calls = Array.isArray(details.calls) ? details.calls : [];
	const totals = details.callTotals && typeof details.callTotals === "object" ? Object.values(details.callTotals) : [];
	const total = totals.length > 0 ? totals.reduce((sum, count) => sum + (Number(count) || 0), 0) : calls.length;
	scripts.nestedCalls += total;
	if (total < 2) return;
	scripts.multiCall++;
	scripts.callCounts.push(total);
	if (typeof details.wallMs === "number" && details.wallMs > 0 && calls.length === total) {
		const durations = calls.reduce((sum, nested) => sum + (Number(nested.durationMs) || 0), 0);
		scripts.overlapRatios.push(durations / details.wallMs);
	}
	const outcome = classify(details, calls);
	scripts[outcome.kind]++;
	if (outcome.peak !== undefined) scripts.peaks.push(outcome.peak);
	if (outcome.kind === "sequential" && scripts.sequentialExamples.length < examples) {
		scripts.sequentialExamples.push({
			session: call.session,
			toolCallId: call.id,
			calls: total,
			tools: [...new Set(calls.map((nested) => nested.tool))],
			code: code.length > EXAMPLE_CODE_CHARS ? `${code.slice(0, EXAMPLE_CODE_CHARS)}…` : code,
		});
	}
}

function round(value, digits = 2) {
	return value === undefined ? undefined : Number(value.toFixed(digits));
}

/**
 * The report for tool calls and `run_code` results read from a session store. `callRows` are the tool calls of
 * assistant messages (`session`, `ordinal`, `provider`, `model`, `id`, `name`, and `input`: the script of a `run_code`
 * call or the command of a `bash` call); `resultRows` are `run_code` results (`session`, `id`, `details` as JSON text).
 */
export function summarizeRunCodeUsage(callRows, resultRows, options = {}) {
	const examples = options.examples ?? DEFAULT_EXAMPLES;
	const results = new Map(resultRows.map((row) => [`${row.session}\0${row.id}`, row.details]));
	const turns = new Map();
	for (const row of callRows) {
		const key = `${row.session}\0${row.ordinal}`;
		let turn = turns.get(key);
		if (!turn) {
			turn = { session: row.session, model: `${row.provider ?? "unknown"}/${row.model ?? "unknown"}`, calls: [] };
			turns.set(key, turn);
		}
		turn.calls.push(row);
	}
	const models = new Map();
	for (const turn of turns.values()) {
		if (options.model && !turn.model.includes(options.model)) continue;
		let stats = models.get(turn.model);
		if (!stats) {
			stats = newModelStats(turn.model);
			models.set(turn.model, stats);
		}
		stats.sessions.add(turn.session);
		stats.toolTurns++;
		stats.toolCalls += turn.calls.length;
		if (turn.calls.length > 1) stats.parallelTurns++;
		let usedRunCode = false;
		for (const call of turn.calls) {
			if (call.name === "bash") {
				stats.bashCalls++;
				if (chainsCommands(call.input)) stats.chainedBashCalls++;
			}
			if (call.name !== "run_code") continue;
			usedRunCode = true;
			stats.runCodeSessions.add(turn.session);
			recordScript(stats, call, results.get(`${call.session}\0${call.id}`), examples);
		}
		if (usedRunCode) stats.runCodeTurns++;
	}
	return {
		...(options.since === undefined ? {} : { since: options.since }),
		models: [...models.values()]
			.sort((a, b) => b.toolCalls - a.toolCalls)
			.map(({ sessions, runCodeSessions, scripts, ...stats }) => {
				const { callCounts, peaks, overlapRatios, ...counts } = scripts;
				return {
					...stats,
					sessions: sessions.size,
					runCodeSessions: runCodeSessions.size,
					scripts: {
						...counts,
						medianCallsPerMultiCallScript: median(callCounts),
						medianPeakInFlight: median(peaks),
						maxPeakInFlight: peaks.length > 0 ? Math.max(...peaks) : undefined,
						medianDurationSumOverWall: round(median(overlapRatios)),
					},
				};
			}),
	};
}

const CALLS_SQL = `
SELECT e.session_id AS session, e.ordinal AS ordinal,
	json_extract(e.payload_json, '$.message.provider') AS provider,
	json_extract(e.payload_json, '$.message.model') AS model,
	json_extract(c.value, '$.id') AS id,
	json_extract(c.value, '$.name') AS name,
	CASE json_extract(c.value, '$.name')
		WHEN 'run_code' THEN json_extract(c.value, '$.arguments.code')
		WHEN 'bash' THEN json_extract(c.value, '$.arguments.command')
	END AS input
FROM entries e, json_each(e.payload_json, '$.message.content') c
WHERE e.entry_type = 'message' AND e.timestamp >= ?
	AND json_extract(e.payload_json, '$.message.role') = 'assistant'
	AND (CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.type') END) = 'toolCall'
ORDER BY e.session_id, e.ordinal`;

const RESULTS_SQL = `
SELECT session_id AS session,
	json_extract(payload_json, '$.message.toolCallId') AS id,
	json_extract(payload_json, '$.message.details') AS details
FROM entries
WHERE entry_type = 'message' AND timestamp >= ?
	AND json_extract(payload_json, '$.message.role') = 'toolResult'
	AND json_extract(payload_json, '$.message.toolName') = 'run_code'`;

/** Reads a session store read-only and summarizes its code mode usage. */
export function readRunCodeUsage(options) {
	const db = new DatabaseSync(options.db, { readOnly: true, timeout: 5000 });
	try {
		const since = options.since ?? "";
		const callRows = db.prepare(CALLS_SQL).all(since);
		const resultRows = db.prepare(RESULTS_SQL).all(since);
		return summarizeRunCodeUsage(callRows, resultRows, options);
	} finally {
		db.close();
	}
}

function percent(part, whole) {
	return whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

export function formatRunCodeStats(report) {
	const lines = [];
	if (report.since) lines.push(`Since ${report.since}`, "");
	if (report.models.length === 0) lines.push("No tool calls found.");
	for (const stats of report.models) {
		const s = stats.scripts;
		lines.push(
			stats.model,
			`  Selection: ${stats.toolCalls} tool calls in ${stats.toolTurns} turns across ${stats.sessions} sessions`,
			`    run_code in ${stats.runCodeTurns} turns (${percent(stats.runCodeTurns, stats.toolTurns)}), ${stats.runCodeSessions} sessions`,
			`    turns with parallel tool calls: ${stats.parallelTurns} (${percent(stats.parallelTurns, stats.toolTurns)})`,
			`    bash calls chaining commands: ${stats.chainedBashCalls} of ${stats.bashCalls} (heuristic)`,
		);
		if (s.total > 0) {
			lines.push(
				`  Scripts: ${s.total} (${s.failed} failed, ${s.missingResult} without a result), ${s.nestedCalls} nested calls`,
				`    with 2+ calls: ${s.multiCall}; concurrent ${s.concurrent}, sequential ${s.sequential}, unresolved ${s.unresolved}, untimed ${s.untimed}`,
			);
			if (s.multiCall > 0) {
				lines.push(
					`    median calls ${s.medianCallsPerMultiCallScript ?? "-"}, median peak in flight ${s.medianPeakInFlight ?? "-"}, max ${s.maxPeakInFlight ?? "-"}, median duration sum / wall ${s.medianDurationSumOverWall ?? "-"}`,
				);
			}
			lines.push(`    source: Promise combinator in ${s.concurrencyHelper}, await inside a loop in ${s.awaitInLoop} (heuristics)`);
			for (const example of s.sequentialExamples) {
				lines.push(
					`    sequential: ${example.session} ${example.toolCallId} (${example.calls} calls: ${example.tools.join(", ")})`,
					...example.code.split("\n").map((line) => `      | ${line}`),
				);
			}
		}
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const options = parseRunCodeStatsArgs(process.argv.slice(2));
		if (options.help) process.stdout.write(HELP);
		else {
			const report = readRunCodeUsage(options);
			process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatRunCodeStats(report));
		}
	} catch (error) {
		process.stderr.write(`run_code stats failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
