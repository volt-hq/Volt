import { type BenchmarkFixture, fixture, objectSchema, tool, validateArguments } from "./code-mode-fixture-utils.ts";

/**
 * Tasks shaped like recorded MCP use rather than small lookups: multi-kilobyte results, chains of dependent reads,
 * and steps that need the result to be read. The data is generated job traces of an invented scheduler; none of it
 * is copied from a real system or session. An earlier version used assembly-style listings, which one provider's
 * safety filter refused before the model ran, so the domain is deliberately mundane.
 */

const FILLER_TARGETS = ["copy_block", "enqueue", "allocate", "write_log", "mask_events", "flush_cache"];

interface Job {
	id: string;
	name: string;
	trace: string;
}

type Planted = Record<number, [action: string, operands?: string]>;

function prng(seed: number): (bound: number) => number {
	let state = seed >>> 0;
	return (bound) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return Math.floor((state / 0x1_0000_0000) * bound);
	};
}

/** Step ids are one-based and fixed-width, so they sort and compare as text. */
function step(index: number): string {
	return `s${String(index + 1).padStart(3, "0")}`;
}

function line(index: number, action: string, operands = ""): string {
	return `${step(index)}  ${action.padEnd(10)}${operands}`.trimEnd();
}

/**
 * One step per line. Filler never emits `handoff`, `done`, `ref`, `repeat_if`, or a target outside FILLER_TARGETS,
 * and its `skip_if` only jumps forward, so every such step in a trace was planted. `quiet` is an index range
 * without `invoke` steps.
 */
function trace(lines: number, seed: number, planted: Planted = {}, quiet?: [number, number]): string {
	const next = prng(seed);
	const value = () => `v${next(8)}`;
	return Array.from({ length: lines }, (_, index) => {
		const fixed = planted[index];
		if (fixed) return line(index, fixed[0], fixed[1]);
		const kind = next(8);
		if (kind === 0) return line(index, "copy", `${value()}, ${value()}`);
		if (kind === 1) return line(index, "load", `${value()}, slot.${value()}.${next(32) * 4}`);
		if (kind === 2) return line(index, "save", `${value()}, local.${next(24) * 4}`);
		if (kind === 3) return line(index, "add", `${value()}, ${value()}, #${next(96) + 1}`);
		if (kind === 4) return line(index, "mix", `${value()}, ${value()}`);
		if (kind === 5) return line(index, "check", `${value()}, #${next(200) + 100}`);
		if (kind === 6 && index + 2 < lines) return line(index, "skip_if", step(index + 1 + next(lines - index - 1)));
		if (kind === 7 && !(quiet && index >= quiet[0] && index <= quiet[1]))
			return line(index, "invoke", FILLER_TARGETS[next(FILLER_TARGETS.length)]);
		return line(index, "wait");
	}).join("\n");
}

function job(number: number, lines: number, seed: number, planted: Planted = {}, quiet?: [number, number]): Job {
	return { id: `job-${number}`, name: `nightly_${number}`, trace: trace(lines, seed, planted, quiet) };
}

function readJob(jobs: Job[], args: Record<string, unknown>): Job {
	validateArguments(args, ["id"]);
	const found = jobs.find((entry) => entry.id === args.id);
	if (!found) throw new Error(`Unknown job id: ${String(args.id)}`);
	return found;
}

const READ_JOB_TRACE = tool(
	"read_job_trace",
	"Read one job's full step trace by job id. Each trace line is '<step id>  <action> <operands>'; " +
		"traces are several kilobytes.",
	objectSchema({ id: { type: "string", pattern: "^job-[0-9]+$" } }),
	objectSchema({ id: { type: "string" }, name: { type: "string" }, trace: { type: "string" } }),
);

/** Fan-out over large results where only a count survives: twelve traces, four real invokers, three near misses. */
function traceScan(): BenchmarkFixture {
	const invokes: Record<number, number[]> = { 1: [40], 4: [22, 131], 7: [88], 10: [15, 16, 140] };
	const decoys: Record<number, Planted> = {
		2: { 60: ["invoke", "checksum_final"] },
		4: { 70: ["invoke", "checksum_update_table"] },
		5: { 33: ["ref", "v0, checksum_update"] },
		8: { 101: ["wait", "# todo: invoke checksum_update after the refactor"] },
	};
	const jobs = Array.from({ length: 12 }, (_, index) => {
		const planted: Planted = { ...decoys[index] };
		for (const at of invokes[index] ?? []) planted[at] = ["invoke", "checksum_update"];
		return job(4000 + index * 100, 160, 101 + index, planted);
	});
	return fixture(
		{
			id: "trace-scan",
			prompt:
				"The fixture MCP server exposes the step traces of a synthetic job scheduler. Read every job trace. " +
				"Count the steps whose action is invoke and whose operand is exactly checksum_update. Targets that merely " +
				"start with that name, comments, and ref steps do not count. Return JSON only with exactly these fields: " +
				"scannedCount (jobs read), invokers (ids of jobs containing at least one such step, sorted ascending), " +
				"invokeCount (total such steps).",
			tools: [
				tool(
					"list_jobs",
					"List every job with its id, name, and step count. No pagination.",
					objectSchema({}),
					objectSchema({
						jobs: {
							type: "array",
							items: objectSchema({ id: { type: "string" }, name: { type: "string" }, steps: { type: "integer" } }),
						},
					}),
				),
				READ_JOB_TRACE,
			],
			expected: {
				scannedCount: jobs.length,
				invokers: Object.keys(invokes).map((index) => jobs[Number(index)].id),
				invokeCount: Object.values(invokes).reduce((total, steps) => total + steps.length, 0),
			},
			referenceCode: String.raw`const jobs = (await tools.mcp.fixture.list_jobs({})).structured.jobs;
const results = await Promise.all(jobs.map(entry => tools.mcp.fixture.read_job_trace({ id: entry.id })));
const invokers = [];
let invokeCount = 0;
for (const result of results) {
  const count = result.structured.trace.split("\n").filter(text => /^\S+\s+invoke\s+checksum_update$/.test(text)).length;
  if (count > 0) invokers.push(result.structured.id);
  invokeCount += count;
}
return { scannedCount: results.length, invokers: invokers.sort(), invokeCount };`,
		},
		{
			list_jobs(args) {
				validateArguments(args, []);
				return { jobs: jobs.map(({ id, name, trace: text }) => ({ id, name, steps: text.split("\n").length })) };
			},
			read_job_trace: (args) => ({ ...readJob(jobs, args) }),
		},
	);
}

/** A dependent chain where each next read follows a fixed rule: six handoffs through multi-kilobyte traces. */
function handoffChain(): BenchmarkFixture {
	const lines = 140;
	const id = (index: number) => `job-${6000 + index * 100}`;
	const chain = [0, 3, 7, 2, 8, 5, 6];
	const jobs = Array.from({ length: 9 }, (_, index) => {
		const position = chain.indexOf(index);
		const planted: Planted = {
			// Invoking another job and a handoff that is not the final step do not continue the chain.
			[20 + index]: ["invoke", id((index + 4) % 9)],
			[75 + index]: ["handoff", id((index + 1) % 9)],
			[lines - 1]: position >= 0 && position < chain.length - 1 ? ["handoff", id(chain[position + 1])] : ["done"],
		};
		return job(6000 + index * 100, lines, 301 + index, planted);
	});
	const path = chain.map((index) => jobs[index].id);
	return fixture(
		{
			id: "handoff-chain",
			prompt:
				`Start at job ${path[0]} on the fixture MCP server. The final step of every job trace is either done or ` +
				"handoff <job id>, which passes control to another job. Follow final-step handoffs until you reach a job " +
				"whose final step is done. Ignore invoke steps and any handoff that is not the final step. " +
				"Return JSON only with exactly these fields: path (job ids visited in order, beginning with the start job " +
				"and ending with the job that is done), hops (the number of handoffs followed), terminal (the last id in path).",
			tools: [READ_JOB_TRACE],
			expected: { path, hops: path.length - 1, terminal: path[path.length - 1] },
			referenceCode: String.raw`const path = [];
let id = "${path[0]}";
for (let guard = 0; guard < 20 && id; guard++) {
  path.push(id);
  const text = (await tools.mcp.fixture.read_job_trace({ id })).structured.trace;
  const last = text.slice(text.lastIndexOf("\n") + 1);
  const handoff = /^\S+\s+handoff\s+(job-[0-9]+)$/.exec(last);
  id = handoff ? handoff[1] : null;
}
return { path, hops: path.length - 1, terminal: path[path.length - 1] };`,
		},
		{ read_job_trace: (args) => ({ ...readJob(jobs, args) }) },
	);
}

/** A deterministic sweep followed by reading: four referencing jobs, one of which decides the outcome. */
function messageTriage(): BenchmarkFixture {
	const text = "quota check failed";
	const symbol = "msg.quota_check_failed";
	const branchIndex = 61;
	const failureIndex = 120;
	const plans: Planted[] = [
		{ 30: ["ref", `v0, ${symbol}`], 31: ["invoke", "write_log"] },
		{},
		// The deciding job: total the usage, compare it with the stored limit, jump to the failure steps.
		{
			58: ["invoke", "usage_total"],
			59: ["load", "v1, stored.quota_limit"],
			60: ["check", "v0, v1"],
			[branchIndex]: ["skip_if", step(failureIndex)],
			[failureIndex]: ["ref", `v0, ${symbol}`],
			[failureIndex + 1]: ["invoke", "raise_alert"],
		},
		// Updates the stored limit and never references the message.
		{ 44: ["invoke", "usage_total"], 45: ["save", "v0, stored.quota_limit"] },
		{ 90: ["ref", `v1, ${symbol}`], 91: ["invoke", "format_message"], 130: ["ref", `v1, ${symbol}`], 131: ["invoke", "format_message"] },
		{},
		// Compares a retry counter, then only logs: a compare-and-jump next to the message is not the quota decision.
		{
			70: ["load", "v1, stored.retry_limit"],
			71: ["check", "v2, v1"],
			72: ["skip_if", step(110)],
			73: ["ref", `v0, ${symbol}`],
			74: ["invoke", "write_log"],
		},
		{},
	];
	const jobs = plans.map((planted, index) => job(8000 + index * 100, 150, 501 + index, planted));
	const refs = plans.flatMap((planted, index) =>
		Object.entries(planted)
			.filter(([, planned]) => planned[1]?.includes(symbol))
			.map(([at]) => ({ job: jobs[index].id, step: step(Number(at)) })),
	);
	return fixture(
		{
			id: "message-triage",
			prompt:
				`On the fixture MCP server, find the jobs whose traces reference the message "${text}". Exactly one of them ` +
				"decides the outcome: it compares freshly totalled usage with the stored quota limit and conditionally " +
				"jumps to the failure steps when they differ. The others only log or format the message. Read the " +
				"referencing jobs and identify the deciding one. Return JSON only with exactly these fields: " +
				"referencingCount (distinct jobs that reference the message), decider (id of the deciding job), " +
				"failureJumpStep (the step id of its conditional jump to the failure steps).",
			tools: [
				tool(
					"find_message_refs",
					"Find steps that reference a message, by the message's exact text. A job can appear more than once.",
					objectSchema({ text: { type: "string", minLength: 1 } }),
					objectSchema({
						refs: { type: "array", items: objectSchema({ job: { type: "string" }, step: { type: "string" } }) },
					}),
				),
				READ_JOB_TRACE,
			],
			expected: {
				referencingCount: new Set(refs.map((ref) => ref.job)).size,
				decider: jobs[2].id,
				failureJumpStep: step(branchIndex),
			},
			referenceCode: String.raw`const refs = (await tools.mcp.fixture.find_message_refs({ text: "${text}" })).structured.refs;
const ids = [...new Set(refs.map(ref => ref.job))].sort();
const results = await Promise.all(ids.map(id => tools.mcp.fixture.read_job_trace({ id })));
let decider = null;
let failureJumpStep = null;
for (const result of results) {
  const lines = result.structured.trace.split("\n");
  for (let index = 2; index < lines.length; index++) {
    if (!/^\S+\s+skip_if\s/.test(lines[index]) || !/^\S+\s+check\s/.test(lines[index - 1])) continue;
    if (!/^\S+\s+load\s.*stored\.quota_limit$/.test(lines[index - 2])) continue;
    decider = result.structured.id;
    failureJumpStep = lines[index].split(/\s+/)[0];
  }
}
return { referencingCount: ids.length, decider, failureJumpStep };`,
		},
		{
			find_message_refs(args) {
				validateArguments(args, ["text"]);
				return { refs: args.text === text ? refs : [] };
			},
			read_job_trace: (args) => ({ ...readJob(jobs, args) }),
		},
	);
}

/** Paged raw reads: a marker scan with a match across a page boundary and a match that is not byte-aligned. */
function byteMarkerScan(): BenchmarkFixture {
	const size = 4096;
	const pageBytes = 512;
	const marker = [0xc0, 0xde, 0x7a, 0x11];
	const offsets = [261, 510, 2048, 3650];
	const next = prng(907);
	// Filler avoids the marker's first byte, so only planted bytes can begin a match.
	const bytes = Array.from({ length: size }, () => {
		const value = next(256);
		return value === marker[0] ? 0x3c : value;
	});
	for (const offset of offsets) bytes.splice(offset, marker.length, ...marker);
	bytes.splice(1500, 4, 0xc0, 0xde, 0x7a, 0x10);
	bytes.splice(2500, 4, 0xc0, 0xde, 0x7b, 0x11);
	// "4c0de7a113" contains the marker's hex digits one nibble off a byte boundary.
	bytes.splice(3000, 5, 0x4c, 0x0d, 0xe7, 0xa1, 0x13);
	const image = bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
	return fixture(
		{
			id: "byte-marker-scan",
			prompt:
				`The fixture MCP server exposes a ${size}-byte synthetic export file through read_bytes, at most ${pageBytes} bytes per call. ` +
				"Read the whole file, following nextOffset until null. Find every byte offset at which the four-byte record " +
				"marker c0 de 7a 11 begins. A marker can span two reads. Hex output has two lowercase characters per byte and " +
				"no separators, so a marker must start on a byte boundary. Return JSON only with exactly these fields: " +
				"fileBytes (total bytes read), offsets (marker byte offsets, ascending), count (number of markers).",
			tools: [
				tool(
					"read_bytes",
					`Read raw file bytes as contiguous lowercase hex. Defaults: offset 0, length ${pageBytes}; length cannot exceed ${pageBytes}. ` +
						"Pass nextOffset as offset for the next read; null ends the file.",
					objectSchema(
						{
							offset: { type: "integer", minimum: 0, maximum: size, default: 0 },
							length: { type: "integer", minimum: 1, maximum: pageBytes, default: pageBytes },
						},
						[],
					),
					objectSchema({
						offset: { type: "integer" },
						length: { type: "integer" },
						hex: { type: "string" },
						nextOffset: { type: ["integer", "null"] },
					}),
				),
			],
			expected: { fileBytes: size, offsets, count: offsets.length },
			referenceCode: String.raw`let hex = "";
let offset = 0;
do {
  const chunk = (await tools.mcp.fixture.read_bytes({ offset, length: ${pageBytes} })).structured;
  hex += chunk.hex;
  offset = chunk.nextOffset;
} while (offset !== null);
const offsets = [];
for (let at = hex.indexOf("c0de7a11"); at !== -1; at = hex.indexOf("c0de7a11", at + 1)) {
  if (at % 2 === 0) offsets.push(at / 2);
}
return { fileBytes: hex.length / 2, offsets, count: offsets.length };`,
		},
		{
			read_bytes(args) {
				validateArguments(args, ["offset", "length"]);
				const offset = Object.hasOwn(args, "offset") ? args.offset : 0;
				const length = Object.hasOwn(args, "length") ? args.length : pageBytes;
				if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > size)
					throw new Error(`offset must be an integer from 0 through ${size}`);
				if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > pageBytes)
					throw new Error(`length must be an integer from 1 through ${pageBytes}`);
				const end = Math.min(offset + length, size);
				return { offset, length: end - offset, hex: image.slice(offset * 2, end * 2), nextOffset: end < size ? end : null };
			},
		},
	);
}

/** One large result that has to be read: a control where a script cannot save a round trip. */
function loopInterpretation(): BenchmarkFixture {
	const start = 50;
	const jump = 96;
	const bound = 37;
	const planted: Planted = {
		[start + 9]: ["invoke", "send_batch"],
		[start + 30]: ["invoke", "arm_timer"],
		[jump - 1]: ["check", `v4, #${bound}`],
		[jump]: ["repeat_if", step(start)],
		[219]: ["done"],
	};
	const jobs = [job(9000, 220, 701, planted, [start, jump])];
	return fixture(
		{
			id: "loop-interpretation",
			prompt:
				`Read the trace of job ${jobs[0].id} on the fixture MCP server. It contains exactly one loop, closed by a ` +
				"conditional jump back to an earlier step; every other jump goes forward. Return JSON only with exactly " +
				"these fields: loopStart (the step id the backward jump targets, written like s001), loopBound (the integer " +
				"compared in the step immediately before the backward jump), invokedInLoop (targets invoked from loopStart " +
				"up to the backward jump, in trace order).",
			tools: [READ_JOB_TRACE],
			expected: { loopStart: step(start), loopBound: bound, invokedInLoop: ["send_batch", "arm_timer"] },
			referenceCode: String.raw`const lines = (await tools.mcp.fixture.read_job_trace({ id: "${jobs[0].id}" })).structured.trace.split("\n");
const parsed = lines.map(text => text.split(/\s+/));
const jumpIndex = parsed.findIndex(([at, action, operand]) => /^s\d+$/.test(operand ?? "") && action.endsWith("_if") && operand < at);
const loopStart = parsed[jumpIndex][2];
const startIndex = parsed.findIndex(([at]) => at === loopStart);
return {
  loopStart,
  loopBound: Number(lines[jumpIndex - 1].slice(lines[jumpIndex - 1].indexOf("#") + 1)),
  invokedInLoop: parsed.slice(startIndex, jumpIndex).filter(([, action]) => action === "invoke").map(([, , target]) => target),
};`,
		},
		{ read_job_trace: (args) => ({ ...readJob(jobs, args) }) },
	);
}

/** Every run owns its data and grading state, as in the core suite. */
export function createRealisticRoutingFixtures(): BenchmarkFixture[] {
	return [traceScan(), handoffChain(), messageTriage(), byteMarkerScan(), loopInterpretation()];
}
