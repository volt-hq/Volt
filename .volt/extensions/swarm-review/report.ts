import type { Api, Model } from "@hansjm10/volt-ai";
import type { BorderedLoader, Theme } from "@hansjm10/volt-coding-agent";
import { Container, Text } from "@hansjm10/volt-tui";
import type { Cluster, SwarmSetup, SwarmState, Verdict, VerifiedFinding } from "./types.ts";
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
	agreement: "both" | "single";
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
	const confirmedClusters = byKind("confirmed");
	const findings: ReportedFinding[] = confirmedClusters
		.flatMap((cluster) => {
			const workers = new Set(cluster.candidates.map((candidate) => candidate.worker)).size;
			const agreement: ReportedFinding["agreement"] = cluster.outcome === "single" ? "single" : "both";
			return (decidingVerdicts(cluster)[0]?.findings ?? []).map((finding) => ({
				...finding,
				cluster: cluster.id,
				workers,
				agreement,
			}));
		})
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
		const cluster = state.clusters.find((candidate) => candidate.id === finding.cluster);
		const priorities = cluster
			? decidingVerdicts(cluster).map((verdict) => Math.min(...verdict.findings.map((item) => item.priority)))
			: [];
		const agreement =
			finding.agreement === "single"
				? "confirmed by 1 verifier (the other failed)"
				: priorities.length === 2 && priorities[0] !== priorities[1]
					? `both verifiers confirmed (P${priorities[0]} / P${priorities[1]})`
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
		lines.push("", "### Suppressed (dismissed in an earlier review; the code is unchanged)");
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

export function renderProgress(state: SwarmState, label: string, theme: Theme): string[] {
	const lines = [theme.fg("accent", theme.bold("Swarm review")) + theme.fg("muted", ` · ${label}`)];
	for (const summary of state.waves) {
		lines.push(
			theme.fg(
				"muted",
				`  wave ${summary.wave}: ${summary.workers} workers, ${summary.candidates} claim(s), ${summary.newClusters} new cluster(s)${summary.clusteringFallback ? " (proximity fallback)" : ""}`,
			),
		);
	}
	if (state.phase === "workers") {
		for (const worker of state.workers) {
			if (worker.wave !== state.currentWave) continue;
			const name = theme.fg("muted", `  worker ${String(worker.index + 1).padStart(2)}`);
			if (worker.status === "running") {
				lines.push(`${name} ${theme.fg("accent", `● turn ${worker.turns + 1}, ${worker.toolCalls} tool calls`)}`);
			} else if (worker.status === "failed")
				lines.push(`${name} ${theme.fg("error", `✗ ${worker.error ?? "failed"}`)}`);
		}
	}
	if (state.phase === "verifying") {
		for (const cluster of state.clusters) {
			const running = cluster.verifiers.filter((pass) => pass.status === "running");
			if (running.length === 0) continue;
			const tools = running.reduce((sum, pass) => sum + pass.toolCalls, 0);
			lines.push(
				`${theme.fg("muted", `  ${cluster.id.padEnd(4)}`)} ${theme.fg("accent", `● ${running.length} verifier(s), ${tools} tool calls`)} ${theme.fg("dim", cluster.title.slice(0, 80))}`,
			);
		}
	}
	const spent = emptyUsage();
	for (const worker of state.workers) addUsage(spent, worker.usage);
	for (const pass of state.clusterPasses) addUsage(spent, pass.usage);
	for (const cluster of state.clusters) for (const pass of cluster.verifiers) addUsage(spent, pass.usage);
	if (spent.cost > 0) lines.push(theme.fg("dim", `  estimated cost of finished passes: ${formatCost(spent.cost)}`));
	return lines;
}

/** Progress above a cancellable loader; Escape reaches the loader. */
export class SwarmProgressView extends Container {
	readonly progress = new Text("", 1, 0);
	readonly loader: BorderedLoader;

	constructor(loader: BorderedLoader) {
		super();
		this.loader = loader;
		this.addChild(this.progress);
		this.addChild(loader);
	}

	update(lines: string[], message: string): void {
		this.progress.setText(lines.join("\n"));
		this.loader.setMessage(message);
	}

	handleInput(data: string): void {
		this.loader.handleInput(data);
	}

	dispose(): void {
		this.loader.dispose();
	}
}
