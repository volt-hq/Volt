import type { Api, Model } from "@hansjm10/volt-ai";
import type { WorkProgress, WorkProgressStep } from "@hansjm10/volt-protocol";
import type { Cluster, SwarmOptions, SwarmSetup, SwarmState, Verdict, VerifiedFinding } from "./types.ts";
import { addUsage, emptyUsage, formatCost, formatDuration, lineRange, usageText } from "./util.ts";

export function modelRef(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function where(file: string, line: number, endLine?: number): string {
	return `\`${file}:${lineRange(line, endLine)}\``;
}

function clusterAnchor(cluster: Cluster): string {
	const anchor = cluster.candidates[0];
	return anchor ? where(anchor.file, anchor.line, anchor.endLine) : "";
}

/** The verdicts that decide how a cluster is reported; single-verifier clusters use their one verdict. */
function decidingVerdicts(cluster: Cluster): Verdict[] {
	return cluster.verdicts.filter((verdict): verdict is Verdict => verdict !== undefined);
}

function effectiveKind(cluster: Cluster): string {
	return cluster.outcome === "single" ? (decidingVerdicts(cluster)[0]?.verdict ?? "unverified") : cluster.outcome;
}

export interface ReportedFinding extends VerifiedFinding {
	cluster: string;
	workers: number;
	/** both: both verifiers reported it; one: only one did; single: the other verifier failed. */
	agreement: "both" | "one" | "single";
	priorities: number[];
}

/** Kept small: merging two distinct defects would hide one, while a near-duplicate is merely redundant. */
const MATCH_LINE_TOLERANCE = 1;

function sameDefect(a: VerifiedFinding, b: VerifiedFinding): boolean {
	return (
		a.file === b.file &&
		a.line <= (b.endLine ?? b.line) + MATCH_LINE_TOLERANCE &&
		b.line <= (a.endLine ?? a.line) + MATCH_LINE_TOLERANCE
	);
}

/**
 * Findings of a confirmed cluster from both verifiers. Findings both reported (same file, overlapping lines) are
 * merged at the more severe priority; a finding only one verifier reported is kept and labelled as such.
 */
function clusterFindings(cluster: Cluster, workers: number): ReportedFinding[] {
	const base = { cluster: cluster.id, workers };
	if (cluster.outcome === "single") {
		return (decidingVerdicts(cluster)[0]?.findings ?? []).map((finding) => ({
			...finding,
			...base,
			agreement: "single" as const,
			priorities: [finding.priority],
		}));
	}
	const unmatched = [...(cluster.verdicts[1]?.findings ?? [])];
	const results: ReportedFinding[] = [];
	for (const finding of cluster.verdicts[0]?.findings ?? []) {
		const index = unmatched.findIndex((other) => sameDefect(finding, other));
		if (index === -1) {
			results.push({ ...finding, ...base, agreement: "one", priorities: [finding.priority] });
			continue;
		}
		const [other] = unmatched.splice(index, 1);
		results.push({
			...finding,
			...base,
			priority: Math.min(finding.priority, other.priority),
			agreement: "both",
			priorities: [finding.priority, other.priority],
		});
	}
	for (const finding of unmatched) {
		results.push({ ...finding, ...base, agreement: "one", priorities: [finding.priority] });
	}
	return results;
}

export function buildReport(
	setup: SwarmSetup,
	state: SwarmState,
	durationMs: number,
	remembered: number,
): { markdown: string; findings: ReportedFinding[] } {
	const { options, target } = setup;
	const completedWorkers = state.workers.filter((worker) => worker.status === "done").length;
	const byKind = (kind: string): Cluster[] => state.clusters.filter((cluster) => effectiveKind(cluster) === kind);
	const findings: ReportedFinding[] = byKind("confirmed")
		.flatMap((cluster) =>
			clusterFindings(cluster, new Set(cluster.candidates.map((candidate) => candidate.worker)).size),
		)
		.sort((a, b) => a.priority - b.priority || b.workers - a.workers);

	const waves = state.waves.length;
	const lines = [
		`**Swarm review** · ${target.description}`,
		`${completedWorkers}/${state.workers.length} workers in ${waves} wave(s) (${modelRef(setup.workerModel)}, ${options.thinking}) → 2 verifiers per cluster (${modelRef(setup.verifierModel)}, ${options.verifierThinking})${options.exec ? " with command execution" : ""}`,
	];
	if (target.scope.length > 0) lines.push(`Scope: ${target.scope.join(", ")}`);
	if (state.saturated && waves < Math.ceil(options.workers / options.waveSize)) {
		lines.push(`Stopped after wave ${waves}: it added no new issues.`);
	}
	if (target.shards.length > 1) {
		lines.push(`The diff was split into ${target.shards.length} parts across workers.`);
	}
	const failedWave = state.waves.find((summary) => summary.failed);
	if (failedWave) lines.push(`Every worker in wave ${failedWave.wave} failed, so the run stopped early.`);
	if (target.submodules) {
		lines.push("The change updates submodule commits; submodule contents were not available to reviewers.");
	}
	const dropped = state.workers.reduce((sum, worker) => sum + worker.dropped, 0);
	if (dropped > 0) {
		lines.push(`${dropped} claim(s) were dropped because they cited files that do not exist in the checkout.`);
	}
	const fallbackWaves = state.waves.filter((summary) => summary.clusteringFallback).map((summary) => summary.wave);
	if (fallbackWaves.length > 0) {
		lines.push(
			`Clustering failed for wave(s) ${fallbackWaves.join(", ")}; those claims were grouped by file and nearby lines instead.`,
		);
	}
	const partial = target.shards.flatMap((shard) => shard.partialFiles);
	if (partial.length > 0) {
		lines.push(
			`Diffs of ${partial.length} file(s) were cut to fit (${partial.slice(0, 5).join(", ")}${partial.length > 5 ? ", ..." : ""}); reviewers could read their current and previous versions.`,
		);
	}
	const unreviewedShards = target.shards.filter(
		(shard) => !state.workers.some((worker) => worker.shard === shard.index && worker.status === "done"),
	);
	if (unreviewedShards.length > 0) {
		const files = unreviewedShards.flatMap((shard) => shard.files);
		lines.push(
			`**Not reviewed:** ${files.length} file(s) in ${unreviewedShards.length} part(s) had no successful worker (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", ..." : ""}).`,
		);
	}

	const claims = state.clusters.reduce((sum, cluster) => sum + cluster.candidates.length, 0);
	const counts = [
		`**${findings.length} confirmed finding(s)**`,
		`${byKind("disputed").length} disputed`,
		`${byKind("uncertain").length} uncertain`,
		`${byKind("rejected").length} rejected`,
		`${byKind("suppressed").length} suppressed`,
		...(byKind("unverified").length > 0 ? [`${byKind("unverified").length} unverified`] : []),
	];
	lines.push(`${claims} claim(s) → ${state.clusters.length} cluster(s): ${counts.join(", ")}`);
	if (state.clusters.length === 0) lines.push("", "No claims. Nothing to verify.");

	findings.forEach((finding, index) => {
		const [first, second] = finding.priorities;
		const agreement =
			finding.agreement === "single"
				? "confirmed by 1 verifier (the other failed)"
				: finding.agreement === "one"
					? "reported by 1 of 2 verifiers (both confirmed a defect in this cluster)"
					: second !== undefined && first !== second
						? `both verifiers confirmed (P${first} / P${second})`
						: "both verifiers confirmed";
		lines.push(
			"",
			`### ${index + 1}. [P${finding.priority}] ${finding.title}`,
			`${where(finding.file, finding.line, finding.endLine)} · found by ${finding.workers}/${completedWorkers} workers · ${agreement}`,
			"",
			finding.explanation,
		);
		if (finding.fix) lines.push("", `**Fix:** ${finding.fix}`);
	});

	const disputed = byKind("disputed");
	if (disputed.length > 0) {
		lines.push("", "### Disputed (the verifiers disagreed)");
		for (const cluster of disputed) {
			lines.push(`- **${cluster.title}** ${clusterAnchor(cluster)}`);
			cluster.verdicts.forEach((verdict, slot) => {
				if (!verdict) return;
				const finding = verdict.findings[0];
				const detail = finding ? `[P${finding.priority}] ${finding.explanation}` : verdict.reason;
				lines.push(`  - Verifier ${slot + 1}: ${verdict.verdict}. ${detail}`);
			});
		}
	}
	const reasons = (cluster: Cluster): string =>
		[...new Set(decidingVerdicts(cluster).map((v) => v.reason))].join(" / ");
	const uncertain = byKind("uncertain");
	if (uncertain.length > 0) {
		lines.push("", "### Uncertain");
		for (const cluster of uncertain) lines.push(`- ${cluster.title} ${clusterAnchor(cluster)}: ${reasons(cluster)}`);
	}
	const unverified = byKind("unverified");
	if (unverified.length > 0) {
		lines.push("", "### Unverified (both verifiers failed)");
		for (const cluster of unverified) {
			lines.push(`- **${cluster.title}** (${cluster.candidates.length} claim(s))`);
			const seen = new Set<string>();
			for (const candidate of cluster.candidates) {
				if (seen.has(candidate.title)) continue;
				seen.add(candidate.title);
				lines.push(
					`  - ${where(candidate.file, candidate.line, candidate.endLine)} [P${candidate.priority}] ${candidate.title}. Trigger: ${candidate.trigger} Impact: ${candidate.impact}`,
				);
			}
		}
	}
	const rejected = byKind("rejected");
	if (rejected.length > 0) {
		lines.push("", "### Rejected");
		for (const cluster of rejected) {
			const note = cluster.outcome === "single" ? " (1 verifier)" : "";
			lines.push(`- ${cluster.title} ${clusterAnchor(cluster)}${note}: ${reasons(cluster)}`);
		}
	}
	const suppressed = byKind("suppressed");
	if (suppressed.length > 0) {
		lines.push(
			"",
			"### Suppressed (dismissed in an earlier review; the anchored code and its context are unchanged)",
		);
		for (const cluster of suppressed) {
			lines.push(
				`- ${cluster.title} (${cluster.candidates.length} claim(s)): ${cluster.suppressedBy?.reason ?? ""}`,
			);
		}
	}

	const failures = state.workers.filter((worker) => worker.status === "failed");
	if (failures.length > 0) {
		lines.push(
			"",
			`Failed workers: ${failures.map((worker) => `#${worker.index + 1} (${worker.error ?? "unknown error"})`).join("; ")}`,
		);
	}
	const workerUsage = emptyUsage();
	for (const worker of state.workers) addUsage(workerUsage, worker.usage);
	const clusterUsage = emptyUsage();
	for (const pass of state.clusterPasses) addUsage(clusterUsage, pass.usage);
	const verifierUsage = emptyUsage();
	for (const cluster of state.clusters) for (const pass of cluster.verifiers) addUsage(verifierUsage, pass.usage);
	lines.push(
		"",
		`Estimated cost: workers ${usageText(workerUsage)} · clustering ${usageText(clusterUsage)} · verifiers ${usageText(verifierUsage)} · ${formatDuration(durationMs)}`,
	);
	if (remembered > 0) lines.push(`Remembered ${remembered} rejected issue(s) for future reviews.`);
	return { markdown: lines.join("\n"), findings };
}

function progressCounts(state: SwarmState): { claims: number; clusters: number } {
	return {
		claims: state.workers.reduce((sum, worker) => sum + worker.candidates.length, 0),
		clusters: state.clusters.length,
	};
}

export function phaseText(state: SwarmState): string {
	if (state.cancelling) return "Cancelling swarm review...";
	const { claims, clusters } = progressCounts(state);
	if (state.phase === "clustering") return `Clustering ${claims} claim(s) from wave ${state.currentWave}`;
	if (state.phase === "verifying") {
		const passes = state.clusters.flatMap((cluster) => cluster.verifiers);
		const done = passes.filter((pass) => pass.status !== "queued" && pass.status !== "running").length;
		return `Verifying ${clusters} cluster(s): ${done}/${passes.length} verdicts`;
	}
	const wave = state.workers.filter((worker) => worker.wave === state.currentWave);
	const finished = wave.filter((worker) => worker.status !== "queued" && worker.status !== "running").length;
	return `Wave ${state.currentWave}: ${finished}/${wave.length} workers finished · ${claims} claim(s) · ${clusters} cluster(s)`;
}

/** The run's progress: the phase, the estimated cost so far, and a step per wave and for verification. */
export function workProgress(state: SwarmState, options: SwarmOptions): WorkProgress {
	const spent = emptyUsage();
	for (const worker of state.workers) addUsage(spent, worker.usage);
	for (const pass of state.clusterPasses) addUsage(spent, pass.usage);
	for (const cluster of state.clusters) for (const pass of cluster.verifiers) addUsage(spent, pass.usage);
	const ended = state.phase === "verifying" || state.phase === "done";
	const steps: WorkProgressStep[] = [];
	for (let wave = 1; wave <= Math.ceil(options.workers / options.waveSize); wave++) {
		const summary = state.waves.find((entry) => entry.wave === wave);
		const status: WorkProgressStep["status"] = summary
			? summary.failed
				? "failed"
				: "done"
			: wave === state.currentWave
				? "active"
				: ended || wave < state.currentWave
					? "skipped"
					: "pending";
		const detail = summary
			? `: ${summary.candidates} claim(s), ${summary.newClusters} new cluster(s)${summary.clusteringFallback ? " (proximity fallback)" : ""}`
			: "";
		steps.push({ key: `wave-${wave}`, label: `Wave ${wave}${detail}`, status });
	}
	steps.push({
		key: "verify",
		label: `Verify ${state.clusters.filter((cluster) => cluster.outcome !== "suppressed").length} cluster(s)`,
		status: state.phase === "done" ? "done" : state.phase === "verifying" ? "active" : "pending",
	});
	const cost = spent.cost > 0 ? ` · est. ${formatCost(spent.cost)}` : "";
	return { text: `${phaseText(state)}${cost}`, steps };
}

/** The counts and the confirmed findings, one line each: what a notice shows where the report does not fit. */
export function reportSummary(state: SwarmState, findings: readonly ReportedFinding[]): string {
	const count = (kind: string): number => state.clusters.filter((cluster) => effectiveKind(cluster) === kind).length;
	return [
		`${findings.length} confirmed finding(s), ${count("disputed")} disputed, ${count("uncertain")} uncertain, ${count("rejected")} rejected.`,
		...findings.map(
			(finding, index) =>
				`${index + 1}. [P${finding.priority}] ${finding.title} (${finding.file}:${lineRange(finding.line, finding.endLine)})`,
		),
	].join("\n");
}
