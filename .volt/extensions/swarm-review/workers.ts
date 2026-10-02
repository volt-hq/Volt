import { defineTool } from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";
import { changeSection, WORKER_REPAIR, WORKER_SYSTEM_PROMPT, WORKER_WRAP_UP } from "./prompts.ts";
import { type PassControl, runPass } from "./session.ts";
import { normalizeFile } from "./tools.ts";
import type { Cluster, DiffShard, ReviewTarget, SwarmSetup, SwarmState, WorkerState } from "./types.ts";
import { emptyUsage, errorText, lineRange, runPool } from "./util.ts";

const MAX_FINDINGS_PER_WORKER = 12;
const MAX_ALREADY_REPORTED = 60;
const WORKER_TURNS = { wrapUp: 30, max: 45 };
/** Straggler handling starts once this share of a wave (at most all but one worker) has finished. */
const STRAGGLER_SHARE = 0.8;
const MIN_STRAGGLER_GRACE_MS = 30_000;
const MAX_STRAGGLER_GRACE_MS = 5 * 60_000;
const MAX_STRAGGLER_CHECK_MS = 5_000;

const FINDING_SCHEMA = Type.Object({
	title: Type.String({ description: "One-line summary of the defect" }),
	file: Type.String({ description: "Repository-relative path of the defect location" }),
	line: Type.Integer({ minimum: 1, description: "Start line in the checkout" }),
	endLine: Type.Optional(Type.Integer({ minimum: 1, description: "End line in the checkout" })),
	priority: Type.Integer({ minimum: 0, maximum: 2, description: "0 blocker, 1 urgent, 2 real bounded defect" }),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	trigger: Type.String({ description: "Concrete scenario or input that triggers the defect" }),
	impact: Type.String({ description: "What goes wrong for users or callers" }),
	evidence: Type.String({ description: "Code facts you verified that establish the defect" }),
});

export function createWorkerState(index: number, wave: number, shard: number): WorkerState {
	return {
		index,
		wave,
		shard,
		status: "queued",
		toolCalls: 0,
		turns: 0,
		usage: emptyUsage(),
		candidates: [],
		dropped: 0,
	};
}

function createFindingsTool(worker: WorkerState, state: SwarmState, checkout: string, onReport: () => void) {
	return defineTool({
		name: "report_findings",
		label: "Report findings",
		description:
			"Submit your final verified review findings. Call exactly once when your investigation is complete; pass an empty array when you found no defects.",
		parameters: Type.Object({
			findings: Type.Array(FINDING_SCHEMA, { maxItems: MAX_FINDINGS_PER_WORKER }),
		}),
		async execute(_toolCallId, params) {
			worker.candidates = [];
			worker.dropped = 0;
			for (const finding of params.findings) {
				const file = normalizeFile(checkout, finding.file);
				if (!file) {
					worker.dropped++;
					continue;
				}
				worker.candidates.push({
					...finding,
					file,
					id: `C${++state.nextCandidate}`,
					worker: worker.index,
					wave: worker.wave,
				});
			}
			onReport();
			return {
				content: [{ type: "text", text: `Recorded ${worker.candidates.length} finding(s).` }],
				details: { recorded: worker.candidates.length, dropped: worker.dropped },
				disposition: "stop",
			};
		},
	});
}

function shardNotes(target: ReviewTarget, shard: DiffShard): string[] {
	const notes: string[] = [];
	if (target.shards.length > 1) {
		notes.push(
			`This change is large and was split among reviewers. Your part of the diff covers ${shard.files.length} file(s); other reviewers cover the rest. Focus on your files, but read any code you need.`,
		);
	}
	if (shard.partialFiles.length > 0) {
		notes.push(
			`The diffs of these files were cut to fit: ${shard.partialFiles.join(", ")}. Read their current contents, and use read_base for their previous versions.`,
		);
	}
	if (target.submodules) {
		notes.push(
			"This change updates submodule commits. Submodule contents are not available in the checkout, so review only how this repository uses them.",
		);
	}
	return notes;
}

/** Everything before the already-reported list is identical for workers in the same shard. */
function workerPrompt(target: ReviewTarget, shard: DiffShard, reported: Cluster[], focus: string | undefined): string {
	const lines = [
		changeSection(target, shard.diff, shardNotes(target, shard)),
		"",
		"# Task",
		...(focus ? [`User focus: ${focus}`] : []),
		"Review the change, verify with the read-only tools, then call report_findings exactly once.",
	];
	const files = new Set(shard.files);
	const relevant = reported.filter(
		(cluster) => target.shards.length === 1 || cluster.candidates.some((candidate) => files.has(candidate.file)),
	);
	if (relevant.length > 0) {
		lines.push(
			"",
			"# Already reported",
			"Earlier reviewers already reported the issues below. Do not report them again unless you have materially new evidence; spend your effort on defects that are not listed.",
			...relevant.slice(0, MAX_ALREADY_REPORTED).map((cluster) => {
				const anchor = cluster.candidates[0];
				return `- ${cluster.title} (${anchor.file}:${lineRange(anchor.line, anchor.endLine)})`;
			}),
		);
	}
	return lines.join("\n");
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Runs one wave. Once most of the wave has finished (at least all but one worker for small waves), a running worker
 * whose own elapsed time exceeds the median finished duration plus a grace period is told to wrap up, and after
 * another grace it is forced to report. Measuring each worker's own elapsed time covers workers that start late
 * (concurrency below the wave size). The grace is half the median, clamped, unless --straggler-grace sets it.
 */
export async function runWave(setup: SwarmSetup, state: SwarmState, workers: WorkerState[]): Promise<void> {
	const { options, signal, target } = setup;
	const reported = state.clusters.filter((cluster) => cluster.outcome !== "suppressed");
	const controls = new Map<number, PassControl>();
	const durations: number[] = [];
	const wrapped = new Set<number>();
	const threshold = Math.max(1, Math.min(workers.length - 1, Math.ceil(workers.length * STRAGGLER_SHARE)));
	const graceMs = (): number =>
		options.stragglerGrace !== undefined
			? options.stragglerGrace * 1000
			: Math.min(MAX_STRAGGLER_GRACE_MS, Math.max(MIN_STRAGGLER_GRACE_MS, median(durations) / 2));
	const checkStragglers = (): void => {
		const finished = workers.filter((worker) => worker.status !== "queued" && worker.status !== "running").length;
		if (workers.length < 2 || finished < threshold) return;
		const grace = graceMs();
		const limit = median(durations) + grace;
		for (const worker of workers) {
			if (worker.status !== "running" || worker.startedAt === undefined) continue;
			const elapsed = Date.now() - worker.startedAt;
			if (elapsed >= limit + grace) controls.get(worker.index)?.finish();
			else if (elapsed >= limit && !wrapped.has(worker.index)) {
				wrapped.add(worker.index);
				controls.get(worker.index)?.wrapUp();
			}
		}
	};
	const interval = setInterval(
		checkStragglers,
		Math.min(MAX_STRAGGLER_CHECK_MS, Math.max(250, (options.stragglerGrace ?? MIN_STRAGGLER_GRACE_MS / 1000) * 250)),
	);
	try {
		await runPool(workers.length, options.concurrency, async (position) => {
			const worker = workers[position];
			if (signal.aborted) {
				worker.status = "cancelled";
				return;
			}
			worker.status = "running";
			setup.onProgress();
			let reportedFindings = false;
			try {
				await runPass(setup, {
					label: `Swarm review worker ${worker.index + 1}`,
					model: setup.workerModel,
					thinking: options.thinking,
					systemPrompt: WORKER_SYSTEM_PROMPT,
					reportTool: createFindingsTool(worker, state, target.checkout, () => {
						reportedFindings = true;
					}),
					hasReport: () => reportedFindings,
					prompt: workerPrompt(target, target.shards[worker.shard], reported, options.focus),
					wrapUpMessage: WORKER_WRAP_UP,
					repairMessage: WORKER_REPAIR,
					turns: WORKER_TURNS,
					state: worker,
					bindControl: (control) => controls.set(worker.index, control),
				});
				worker.status = "done";
			} catch (error) {
				worker.status = signal.aborted ? "cancelled" : "failed";
				if (!signal.aborted) worker.error = errorText(error);
			} finally {
				controls.delete(worker.index);
				if (worker.status === "done" && worker.startedAt !== undefined && worker.finishedAt !== undefined) {
					durations.push(worker.finishedAt - worker.startedAt);
				}
				setup.onProgress();
			}
		});
	} finally {
		clearInterval(interval);
	}
}
