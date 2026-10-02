import { defineTool } from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";
import type { Dismissal } from "./memory.ts";
import { CLUSTER_REPAIR, CLUSTER_SYSTEM_PROMPT } from "./prompts.ts";
import { runPass } from "./session.ts";
import type { Candidate, Cluster, PassState, SwarmSetup, SwarmState } from "./types.ts";
import { emptyUsage, errorText, lineRange } from "./util.ts";

const CLUSTER_TURNS = { wrapUp: 4, max: 8 };
const GROUP_LINE_TOLERANCE = 3;
const MAX_EVIDENCE_CHARS = 400;

const CLUSTERS_SCHEMA = Type.Object({
	clusters: Type.Array(
		Type.Object({
			id: Type.Optional(
				Type.String({
					description: "Existing cluster (K...) or remembered dismissal (D...) id. Omit for a new cluster.",
				}),
			),
			title: Type.String({ description: "Short, specific title that names the defect" }),
			claims: Type.Array(Type.String(), { description: "New claim ids (C...) in this cluster" }),
		}),
	),
});

interface Assignment {
	id?: string;
	title: string;
	claims: Candidate[];
}

function newCluster(state: SwarmState, title: string, candidates: Candidate[], wave: number): Cluster {
	return {
		id: `K${state.clusters.length + 1}`,
		title,
		candidates,
		wave,
		verifiers: [],
		verdicts: [],
		outcome: "pending",
	};
}

function createClustersTool(
	candidates: Candidate[],
	existing: Cluster[],
	dismissals: Dismissal[],
	onReport: (assignments: Assignment[]) => void,
) {
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const known = new Set([...existing.map((cluster) => cluster.id), ...dismissals.map((entry) => entry.id)]);
	return defineTool({
		name: "report_clusters",
		label: "Report clusters",
		description:
			"Assign every new claim to exactly one cluster: an existing K cluster, a remembered D dismissal, or a new cluster (no id).",
		parameters: CLUSTERS_SCHEMA,
		async execute(_toolCallId, params) {
			const errors: string[] = [];
			const seen = new Set<string>();
			const usedIds = new Set<string>();
			const assignments: Assignment[] = [];
			for (const cluster of params.clusters) {
				if (cluster.id !== undefined) {
					if (!known.has(cluster.id)) errors.push(`Unknown cluster id ${cluster.id}.`);
					else if (usedIds.has(cluster.id)) errors.push(`Cluster ${cluster.id} is listed more than once.`);
					usedIds.add(cluster.id);
				}
				if (cluster.claims.length === 0) errors.push(`Cluster "${cluster.title}" has no claims.`);
				const claims: Candidate[] = [];
				for (const id of cluster.claims) {
					const candidate = byId.get(id);
					if (!candidate) errors.push(`Unknown claim id ${id}.`);
					else if (seen.has(id)) errors.push(`Claim ${id} is assigned more than once.`);
					else claims.push(candidate);
					seen.add(id);
				}
				assignments.push({ ...(cluster.id !== undefined ? { id: cluster.id } : {}), title: cluster.title, claims });
			}
			const missing = candidates.filter((candidate) => !seen.has(candidate.id)).map((candidate) => candidate.id);
			if (missing.length > 0) errors.push(`Unassigned claims: ${missing.join(", ")}.`);
			if (errors.length > 0) {
				return {
					content: [{ type: "text", text: `Clusters rejected. Fix and resubmit:\n- ${errors.join("\n- ")}` }],
					details: { accepted: false },
					isError: true,
				};
			}
			onReport(assignments);
			return {
				content: [{ type: "text", text: "Clusters recorded." }],
				details: { accepted: true },
				disposition: "stop",
			};
		},
	});
}

function clusterPrompt(candidates: Candidate[], existing: Cluster[], dismissals: Dismissal[]): string {
	const lines: string[] = [];
	if (existing.length > 0) {
		lines.push("# Existing clusters");
		for (const cluster of existing) {
			const files = [...new Set(cluster.candidates.map((candidate) => candidate.file))].join(", ");
			lines.push(`- ${cluster.id}: ${cluster.title} (${files}; ${cluster.candidates.length} claim(s))`);
		}
		lines.push("");
	}
	if (dismissals.length > 0) {
		lines.push("# Remembered dismissals (issues rejected in earlier reviews)");
		for (const entry of dismissals) {
			lines.push(`- ${entry.id}: ${entry.title} (${entry.file}:${lineRange(entry.line, entry.endLine)})`);
		}
		lines.push("");
	}
	lines.push("# New claims");
	for (const candidate of candidates) {
		lines.push(
			`- ${candidate.id} [${candidate.file}:${lineRange(candidate.line, candidate.endLine)}] ${candidate.title}`,
			`  Trigger: ${candidate.trigger}`,
			`  Impact: ${candidate.impact}`,
			`  Evidence: ${candidate.evidence.slice(0, MAX_EVIDENCE_CHARS)}`,
		);
	}
	lines.push("", "# Task", "Cluster every new claim by root cause, then call report_clusters exactly once.");
	return lines.join("\n");
}

/** Fallback when the clustering pass fails: claims about nearby lines of the same file form one new cluster. */
function proximityAssignments(candidates: Candidate[]): Assignment[] {
	const byFile = new Map<string, Candidate[]>();
	for (const candidate of candidates) byFile.set(candidate.file, [...(byFile.get(candidate.file) ?? []), candidate]);
	const assignments: Assignment[] = [];
	for (const list of byFile.values()) {
		let current: { end: number; assignment: Assignment } | undefined;
		for (const candidate of [...list].sort((a, b) => a.line - b.line)) {
			const end = Math.max(candidate.line, candidate.endLine ?? candidate.line);
			if (current && candidate.line <= current.end + GROUP_LINE_TOLERANCE) {
				current.assignment.claims.push(candidate);
				current.end = Math.max(current.end, end);
			} else {
				current = { end, assignment: { title: candidate.title, claims: [candidate] } };
				assignments.push(current.assignment);
			}
		}
	}
	return assignments;
}

/**
 * Clusters a wave's new claims into existing clusters, remembered dismissals, or new clusters.
 * Returns the number of new (unsuppressed) clusters and whether the proximity fallback was used.
 */
export async function clusterWave(
	setup: SwarmSetup,
	state: SwarmState,
	candidates: Candidate[],
	dismissals: Dismissal[],
	wave: number,
): Promise<{ newClusters: number; fallback: boolean }> {
	if (candidates.length === 0) return { newClusters: 0, fallback: false };
	const existing = state.clusters.filter((cluster) => cluster.outcome !== "suppressed");
	const pass: PassState = { status: "running", toolCalls: 0, turns: 0, usage: emptyUsage() };
	state.clusterPasses.push(pass);
	setup.onProgress();
	let assignments: Assignment[] | undefined;
	let fallback = false;
	try {
		await runPass(setup, {
			label: `Swarm review clustering (wave ${wave})`,
			model: setup.workerModel,
			thinking: "low",
			systemPrompt: CLUSTER_SYSTEM_PROMPT,
			reportTool: createClustersTool(candidates, existing, dismissals, (value) => {
				assignments = value;
			}),
			hasReport: () => assignments !== undefined,
			prompt: clusterPrompt(candidates, existing, dismissals),
			wrapUpMessage: CLUSTER_REPAIR,
			repairMessage: CLUSTER_REPAIR,
			turns: CLUSTER_TURNS,
			state: pass,
			inspect: false,
		});
		pass.status = "done";
	} catch (error) {
		if (setup.signal.aborted) throw error;
		pass.status = "failed";
		pass.error = errorText(error);
	}
	if (!assignments) {
		fallback = true;
		assignments = proximityAssignments(candidates);
	}
	const clustersById = new Map(state.clusters.map((cluster) => [cluster.id, cluster]));
	const dismissalsById = new Map(dismissals.map((entry) => [entry.id, entry]));
	let newClusters = 0;
	for (const assignment of assignments) {
		const target = assignment.id ? clustersById.get(assignment.id) : undefined;
		if (target) {
			target.candidates.push(...assignment.claims);
			continue;
		}
		const dismissal = assignment.id ? dismissalsById.get(assignment.id) : undefined;
		if (dismissal) {
			// One suppressed cluster per remembered dismissal, reused across waves.
			const suppressed = state.clusters.find(
				(cluster) => cluster.outcome === "suppressed" && cluster.suppressedBy?.title === dismissal.title,
			);
			if (suppressed) suppressed.candidates.push(...assignment.claims);
			else {
				const cluster = newCluster(state, dismissal.title, assignment.claims, wave);
				cluster.outcome = "suppressed";
				cluster.suppressedBy = { title: dismissal.title, reason: dismissal.reason };
				state.clusters.push(cluster);
			}
			continue;
		}
		state.clusters.push(newCluster(state, assignment.title, assignment.claims, wave));
		newClusters++;
	}
	setup.onProgress();
	return { newClusters, fallback };
}
