import type { RoutingCaseResult, RoutingMode } from "./code-mode-routing.ts";

export interface RoutingObservation extends RoutingCaseResult {
	trial: number;
	order: number;
}

export interface RoutingRun {
	format: 2;
	runId: string;
	experimentId: string;
	mode: "live" | "self-test";
	thinking: "xhigh";
	plannedCases: number;
	status: "completed" | "failed-or-incomplete";
	cases: RoutingObservation[];
}

const MODES: readonly RoutingMode[] = ["hybrid", "code-first", "code-only"];

function check(condition: unknown, path: string): asserts condition {
	if (!condition) throw new Error(`Invalid routing run: ${path}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
	check(value !== null && typeof value === "object" && !Array.isArray(value), path);
	return value as Record<string, unknown>;
}

function number(value: unknown, path: string, integer = false): number {
	check(typeof value === "number" && Number.isFinite(value) && value >= 0, path);
	check(!integer || Number.isSafeInteger(value), path);
	return value;
}

function string(value: unknown, path: string): void {
	check(typeof value === "string" && value.trim().length > 0, path);
}

function array(value: unknown, path: string): unknown[] {
	check(Array.isArray(value), path);
	return value;
}

/** Parse an artifact without importing the runner or initializing any provider. */
export function parseRoutingRun(value: unknown): RoutingRun {
	const run = record(value, "run");
	check(run.format === 2, "unsupported format (expected 2)");
	for (const key of ["runId", "experimentId"]) string(run[key], key);
	check(run.mode === "live" || run.mode === "self-test", "mode");
	check(run.thinking === "xhigh", "thinking");
	check(run.status === "completed" || run.status === "failed-or-incomplete", "status");
	const planned = number(run.plannedCases, "plannedCases", true);
	const cases = array(run.cases, "cases");
	check(cases.length <= planned, "cases exceed plannedCases");
	const seen = new Set<string>();
	for (const [index, raw] of cases.entries()) {
		const path = `cases[${index}]`;
		const item = record(raw, path);
		for (const key of ["model", "fixture"]) string(item[key], `${path}.${key}`);
		check(MODES.some((mode) => mode === item.mode), `${path}.mode`);
		check(item.status === "completed" || item.status === "failed", `${path}.status`);
		check(typeof item.correct === "boolean", `${path}.correct`);
		check(!item.correct || item.status === "completed", `${path}.correct/status`);
		check(item.status !== "completed" || item.failure === undefined, `${path}.failure/status`);
		check(typeof item.answer === "string", `${path}.answer`);
		for (const key of ["failure", "gradeReason"]) {
			if (item[key] !== undefined) string(item[key], `${path}.${key}`);
		}
		check(number(item.trial, `${path}.trial`, true) > 0, `${path}.trial must be positive`);
		check(number(item.order, `${path}.order`, true) <= 2, `${path}.order must be 0..2`);
		number(item.elapsedMs, `${path}.elapsedMs`);
		for (const key of ["repeatedDataCalls", "scriptFailures", "toolFailures"]) number(item[key], `${path}.${key}`, true);
		const key = JSON.stringify([item.model, item.fixture, item.trial, item.mode]);
		check(!seen.has(key), `${path}: duplicate model/fixture/trial/mode`);
		seen.add(key);
		for (const [i, rawRequest] of array(item.requests, `${path}.requests`).entries()) {
			const prefix = `${path}.requests[${i}]`;
			const request = record(rawRequest, prefix);
			check(number(request.index, `${prefix}.index`, true) === i + 1, `${prefix}.index sequence`);
			check(request.reasoning === "xhigh", `${prefix}.reasoning`);
			for (const metric of ["contextBytes", "toolSchemaBytes", "systemPromptBytes", "toolResultBytes"])
				number(request[metric], `${prefix}.${metric}`, true);
			number(request.elapsedMs, `${prefix}.elapsedMs`);
			if (request.failure !== undefined) string(request.failure, `${prefix}.failure`);
			if (request.stopReason !== undefined)
				check(typeof request.stopReason === "string" && ["stop", "length", "toolUse", "error", "aborted"].includes(request.stopReason), `${prefix}.stopReason`);
			if (request.usage === undefined) continue;
			const usage = record(request.usage, `${prefix}.usage`);
			check(usage.availability === undefined || (typeof usage.availability === "string" && ["complete", "partial", "unavailable"].includes(usage.availability)), `${prefix}.usage.availability`);
			for (const metric of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
				number(usage[metric], `${prefix}.usage.${metric}`, true);
			if (usage.cacheWrite1h !== undefined) number(usage.cacheWrite1h, `${prefix}.usage.cacheWrite1h`, true);
			const cost = record(usage.cost, `${prefix}.usage.cost`);
			for (const metric of ["input", "output", "cacheRead", "cacheWrite", "total"])
				number(cost[metric], `${prefix}.usage.cost.${metric}`);
		}
		for (const rawCall of array(item.calls, `${path}.calls`)) {
			const call = record(rawCall, `${path}.calls[]`);
			string(call.tool, `${path}.calls[].tool`);
			check(call.route === "direct" || call.route === "programmatic", `${path}.calls[].route`);
			check(typeof call.blocked === "boolean", `${path}.calls[].blocked`);
		}
		for (const rawCall of array(item.dataCalls, `${path}.dataCalls`)) {
			const call = record(rawCall, `${path}.dataCalls[]`);
			string(call.tool, `${path}.dataCalls[].tool`);
			record(call.arguments, `${path}.dataCalls[].arguments`);
			number(call.resultBytes, `${path}.dataCalls[].resultBytes`, true);
			check(typeof call.failed === "boolean", `${path}.dataCalls[].failed`);
		}
		array(item.transcript, `${path}.transcript`);
		if (run.status === "completed") check(item.status === "completed" && item.correct, `${path}: completed run contains unsuccessful case`);
	}
	if (run.status === "completed") check(cases.length === planned, "completed run has missing cases");
	return run as unknown as RoutingRun;
}

function quantile(values: readonly number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const position = (sorted.length - 1) * fraction;
	const lower = Math.floor(position);
	return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

function cell(value: string): string {
	return value.replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
}

/** Resample whole task effects, not individual repeated runs as if they were independent tasks. */
function taskEffectInterval(effects: Map<string, number[]>): { median?: number; tasks: number; interval: string } {
	const values = [...effects.values()].map((deltas) => quantile(deltas, 0.5));
	if (!values.length) return { tasks: 0, interval: "unknown" };
	const median = quantile(values, 0.5);
	if (values.length < 10) return { median, tasks: values.length, interval: "insufficient tasks (<10)" };
	let state = 1729;
	const samples: number[] = [];
	for (let sample = 0; sample < 2000; sample++) {
		const draw: number[] = [];
		for (let index = 0; index < values.length; index++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			draw.push(values[Math.floor((state / 0x1_0000_0000) * values.length)]);
		}
		samples.push(quantile(draw, 0.5));
	}
	return { median, tasks: values.length, interval: `[${quantile(samples, 0.025).toFixed(1)}%, ${quantile(samples, 0.975).toFixed(1)}%]` };
}

function completeInput(item: RoutingObservation): number | undefined {
	if (!item.requests.length || item.requests.some((request) => request.usage?.availability !== "complete")) return undefined;
	return item.requests.reduce((sum, request) => sum + (request.usage ? request.usage.input + request.usage.cacheRead + request.usage.cacheWrite : 0), 0);
}

/** Descriptive summaries only; failures remain visible and never qualify as efficiency wins. */
export function summarizeRoutingRuns(runs: readonly RoutingRun[]): string {
	check(runs.length > 0, "no runs supplied");
	const ids = new Set<string>();
	for (const run of runs) {
		parseRoutingRun(run);
		check(!ids.has(run.runId), `duplicate runId: ${run.runId}`);
		ids.add(run.runId);
		check(run.experimentId === runs[0].experimentId, "incompatible experimentId");
		check(run.mode === runs[0].mode, "mixed live/self-test runs");
		check(run.thinking === runs[0].thinking, "different thinking");
	}
	const entries = runs.flatMap((run) => run.cases.map((item) => ({ runId: run.runId, item })));
	const planned = runs.reduce((sum, run) => sum + run.plannedCases, 0);
	const success = entries.filter(({ item }) => item.status === "completed" && item.correct).length;
	const missing = planned - entries.length;
	const pairKey = (runId: string, item: RoutingObservation) => JSON.stringify([runId, item.model, item.fixture, item.trial]);
	const hybrids = new Map(entries.filter(({ item }) => item.mode === "hybrid").map(({ runId, item }) => [pairKey(runId, item), item]));
	const lines = [
		"# Code-mode routing comparison", "",
		`Experiment: ${cell(runs[0].experimentId)}; ${runs[0].mode}; thinking: ${runs[0].thinking}; ${runs.length} runs.`,
		`Success/all planned: ${success}/${planned}; recorded: ${entries.length}; missing: ${missing}; failed-or-incomplete runs: ${runs.filter((run) => run.status !== "completed").length}.`, "",
		"Grouped success denominators include every recorded case, including failures and incorrect answers. Unrecorded planned cases remain in the overall denominator; their model/task/route is unknown and cannot be allocated to grouped rows.",
		"Latency includes all recorded outcomes. Quartiles use linear interpolation; IQR is Q3 minus Q1. Usage columns sum complete requests only, not partial reports; coverage is complete/all requests. Unknown usage is not zero. A case without requests has unknown usage.",
		"Input includes cache-read and cache-write tokens. Catalog USD estimates are not subscription charges.", "",
		"## Runs", "", "| Run | Status | Success/all planned | Recorded | Missing |", "|---|---|---:|---:|---:|",
		...runs.map((run) => `| ${cell(run.runId)} | ${run.status} | ${run.cases.filter((item) => item.correct).length}/${run.plannedCases} | ${run.cases.length} | ${run.plannedCases - run.cases.length} |`),
	];
	for (const dimension of ["model", "fixture"] as const) {
		const label = dimension === "model" ? "Model" : "Task";
		lines.push("", `## By ${label.toLowerCase()} and route`, "",
			`| ${label} | Route | Success/all recorded | Requests | Latency median ms | Latency IQR ms | Usage coverage | Input incl. cache | Output | Cache read | Cache write | Catalog USD | Scripts | Script failures | Tool failures | Repeated reads |`,
			"|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
		const paired: string[] = [];
		for (const name of new Set(entries.map(({ item }) => item[dimension]))) {
			for (const mode of MODES) {
				const group = entries.filter(({ item }) => item[dimension] === name && item.mode === mode);
				if (!group.length) continue;
				const items = group.map(({ item }) => item);
				const requests = items.flatMap((item) => item.requests);
				const usage = requests.flatMap((request) => request.usage?.availability === "complete" ? [request.usage] : []);
				const totals = usage.reduce((sum, u) => [sum[0] + u.input + u.cacheRead + u.cacheWrite, sum[1] + u.output, sum[2] + u.cacheRead, sum[3] + u.cacheWrite, sum[4] + u.cost.total], [0, 0, 0, 0, 0]);
				const latency = items.map((item) => item.elapsedMs);
				const counts = [items.filter((item) => item.correct).length, requests.length,
					items.reduce((n, item) => n + item.calls.filter((call) => call.tool === "run_code").length, 0),
					...(["scriptFailures", "toolFailures", "repeatedDataCalls"] as const).map((key) => items.reduce((n, item) => n + item[key], 0))];
				const coverage = `${usage.length}/${requests.length}; unknown requests ${requests.length - usage.length}; no-request cases ${items.filter((item) => !item.requests.length).length}`;
				lines.push(`| ${cell(name)} | ${mode} | ${counts[0]}/${items.length} | ${counts[1]} | ${quantile(latency, 0.5).toFixed(1)} | ${(quantile(latency, 0.75) - quantile(latency, 0.25)).toFixed(1)} | ${coverage} | ${totals.map((total, i) => usage.length ? total.toFixed(i === 4 ? 4 : 0) : "unknown").join(" | ")} | ${counts.slice(2).join(" | ")} |`);
				if (mode === "hybrid") continue;
				const latencyDeltas: number[] = [];
				const inputDeltas: number[] = [];
				let eligible = 0;
				for (const { runId, item } of group) {
					const base = hybrids.get(pairKey(runId, item));
					if (!base || !item.correct || !base.correct || item.status !== "completed" || base.status !== "completed") continue;
					eligible++;
					if (base.elapsedMs > 0) latencyDeltas.push(100 * (item.elapsedMs - base.elapsedMs) / base.elapsedMs);
					const input = completeInput(item);
					const baseInput = completeInput(base);
					if (input !== undefined && baseInput !== undefined && baseInput > 0) inputDeltas.push(100 * (input - baseInput) / baseInput);
				}
				paired.push(`| ${cell(name)} | ${mode} | ${eligible}/${group.length} | ${latencyDeltas.length ? `${quantile(latencyDeltas, 0.5).toFixed(1)}%` : "unknown"} | ${latencyDeltas.length} | ${inputDeltas.length ? `${quantile(inputDeltas, 0.5).toFixed(1)}%` : "unknown"} | ${inputDeltas.length} |`);
			}
		}
		lines.push("", `### Paired deltas by ${label.toLowerCase()} versus hybrid`, "",
			`| ${label} | Route | Eligible/all recorded | Median latency delta | Latency pairs | Median input delta | Input pairs |`,
			"|---|---|---:|---:|---:|---:|---:|", ...paired);
	}
	lines.push("", "## Equal-weight task effects versus hybrid", "",
		"Each task contributes its median successful paired percent delta, regardless of repetition count. The point estimate is the median across those task effects. The 95% percentile interval resamples whole task effects (2,000 draws, deterministic seed 1729); intervals require at least ten tasks. These exploratory intervals describe task heterogeneity in this curated suite, not a random sample of real coding work or a reliability guarantee. They do not isolate cache/time effects or fully model within-task inference uncertainty.", "",
		"| Model | Route | Metric | Median task effect | 95% task-bootstrap interval | Tasks | Successful pairs |",
		"|---|---|---|---:|---|---:|---:|");
	for (const model of new Set(entries.map(({ item }) => item.model))) {
		for (const mode of MODES.filter((route) => route !== "hybrid")) {
			for (const metric of ["latency", "input"] as const) {
				const effects = new Map<string, number[]>();
				let pairs = 0;
				for (const { runId, item } of entries) {
					if (item.model !== model || item.mode !== mode || !item.correct) continue;
					const base = hybrids.get(pairKey(runId, item));
					if (!base?.correct) continue;
					const value = metric === "latency" ? item.elapsedMs : completeInput(item);
					const baseline = metric === "latency" ? base.elapsedMs : completeInput(base);
					if (value === undefined || baseline === undefined || baseline <= 0) continue;
					const deltas = effects.get(item.fixture) ?? [];
					deltas.push(100 * (value - baseline) / baseline);
					effects.set(item.fixture, deltas);
					pairs++;
				}
				const effect = taskEffectInterval(effects);
				lines.push(`| ${cell(model)} | ${mode} | ${metric} | ${effect.median === undefined ? "unknown" : `${effect.median.toFixed(1)}%`} | ${effect.interval} | ${effect.tasks} | ${pairs} |`);
			}
		}
	}
	lines.push("", "## Unsuccessful recorded cases", "",
		"| Run | Model | Task | Trial | Route | Status | Reason |", "|---|---|---|---:|---|---|---|",
		...entries.filter(({ item }) => !item.correct).map(({ runId, item }) => `| ${cell(runId)} | ${cell(item.model)} | ${cell(item.fixture)} | ${item.trial} | ${item.mode} | ${item.status} | ${cell(item.failure ?? item.gradeReason ?? "incorrect answer")} |`));
	lines.push("", "## Pairing and limitations", "",
		"- Pairs match the SAME run/model/task/trial. Both cases must be completed and correct. Missing, failed, and incorrect cases are excluded from paired efficiency, not from success accounting.",
		"- Deltas are 100 × (route − hybrid) / hybrid, in percent; negative means lower. Zero hybrid denominators are excluded. Input pairs additionally require complete usage for every request in both cases; pair counts are reported separately.",
		"- These are a few fixed synthetic read-only tasks, not general coding, editing, shell, mutation, or real-network workloads. Task rows pool models; inspect model rows before comparing.",
		"- Cached tokens and order effects are not isolated. Rotated ordering does not remove those confounders.",
		"- Medians and IQRs are descriptive, not statistical significance or evidence for broad coding claims. Self-test results validate wiring only, not model performance.", "");
	return lines.join("\n");
}
