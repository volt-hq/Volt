import { defineTool } from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";
import type { ReviewEnginePass } from "@hansjm10/volt-coding-agent";
import { changeSection, WORKER_REPAIR, WORKER_SYSTEM_PROMPT, WORKER_WRAP_UP } from "./prompts.ts";
import { type PassControl, runPass } from "./session.ts";
import { canonicalHeadPath } from "./tools.ts";
import { DIFF_PAGE_BYTES, INLINE_DELIVERY_BYTES, pageCount } from "./target.ts";
import type { ReviewTarget, SwarmSetup, SwarmState, WorkerState } from "./types.ts";
import { emptyUsage, errorText, runPool } from "./util.ts";

const MAX_FINDINGS_PER_WORKER = 12;
/** A worker's turns for investigating; each review_diff page its prompt leaves it to read adds one to both. */
const WORKER_TURNS = { wrapUp: 30, max: 45 };
/** Straggler handling starts once this share of a wave (at most all but one worker) has finished. */
const STRAGGLER_SHARE = 0.8;
const MIN_STRAGGLER_GRACE_MS = 30_000;
const MAX_STRAGGLER_GRACE_MS = 5 * 60_000;
const MAX_STRAGGLER_CHECK_MS = 5_000;

const FINDING_SCHEMA = Type.Object({
	title: Type.String({ description: "One-line summary of the defect" }),
	file: Type.String({ description: "Canonical snapshot path reference of the defect location; preserve %HH escapes" }),
	line: Type.Integer({ minimum: 1, description: "Start line in the checkout" }),
	endLine: Type.Optional(Type.Integer({ minimum: 1, description: "End line in the checkout" })),
	priority: Type.Integer({ minimum: 0, maximum: 2, description: "0 blocker, 1 urgent, 2 real bounded defect" }),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	trigger: Type.String({ description: "Concrete scenario or input that triggers the defect" }),
	impact: Type.String({ description: "What goes wrong for users or callers" }),
	evidence: Type.String({ description: "Code facts you verified that establish the defect" }),
});

export function createWorkerState(index: number, wave: number, hunkIds: readonly string[]): WorkerState {
	return {
		index,
		wave,
		missedHunks: [...hunkIds],
		status: "queued",
		toolCalls: 0,
		turns: 0,
		usage: emptyUsage(),
		candidates: [],
		dropped: 0,
	};
}

function createFindingsTool(
	worker: WorkerState,
	state: SwarmState,
	engine: SwarmSetup["engine"],
	onReport: () => void,
) {
	return defineTool({
		name: "report_findings",
		label: "Report findings",
		description:
			"Submit your final verified review findings. Call exactly once when your investigation is complete; pass an empty array when you found no defects.",
		parameters: Type.Object({
			findings: Type.Array(FINDING_SCHEMA, { maxItems: MAX_FINDINGS_PER_WORKER }),
		}),
		async execute(_toolCallId, params, signal) {
			const findings: typeof params.findings = [];
			const errors: string[] = [];
			for (const finding of params.findings) {
				try {
					findings.push({ ...finding, file: await canonicalHeadPath(engine, finding.file) });
				} catch (error) {
					if (signal?.aborted) throw error;
					errors.push(error instanceof Error ? error.message : String(error));
				}
			}
			worker.dropped = errors.length;
			if (errors.length > 0) {
				return {
					content: [
						{ type: "text", text: `Report rejected. Fix canonical snapshot paths and resubmit:\n${errors.join("\n")}` },
					],
					details: { accepted: false, recorded: 0, dropped: errors.length },
					isError: true,
				};
			}
			worker.candidates = findings.map((finding) => ({
				...finding,
				id: `C${++state.nextCandidate}`,
				worker: worker.index,
				wave: worker.wave,
			}));
			onReport();
			return {
				content: [{ type: "text", text: `Recorded ${worker.candidates.length} finding(s).` }],
				details: { accepted: true, recorded: worker.candidates.length, dropped: worker.dropped },
				disposition: "stop",
			};
		},
	});
}

/** What the host delivered of the change to one worker: the diff text in its prompt, and the files it pages. */
export interface WorkerDelivery {
	text: string;
	/** In the change's order: the files laid out to be paged, and any with a hunk the delivery left out. */
	pagedFiles: string[];
}

/**
 * Gives `pass` the diff text every worker's prompt carries. The host counts what it delivers whole as reviewed by
 * this pass; the worker reads the rest of the change through review_diff, which the host counts the same way.
 */
export function deliverDiff(target: ReviewTarget, pass: ReviewEnginePass): WorkerDelivery {
	const delivery = pass.diff(target.inlineHunkIds, INLINE_DELIVERY_BYTES);
	const omitted = new Set(delivery.omitted);
	const paged = new Set(target.pagedFiles);
	const pagedFiles = [...target.fileHunks]
		.filter(([file, ids]) => paged.has(file) || ids.some((id) => omitted.has(id)))
		.map(([file]) => file);
	return { text: delivery.text, pagedFiles };
}

function workerNotes(target: ReviewTarget, delivery: WorkerDelivery): string[] {
	const notes: string[] = [];
	if (delivery.pagedFiles.length > 0) {
		notes.push(
			`To keep this prompt small, the diff below leaves out ${delivery.pagedFiles.length} file(s): ${delivery.pagedFiles.join(", ")}. You review the whole change, so before you report, page each of them to its end with review_diff: its path first, then the cursor each page returns, with maxBytes ${DIFF_PAGE_BYTES}.`,
		);
	}
	if (target.submodules) {
		notes.push(
			"This change updates submodule commits. Submodule contents are not available in the checkout, so review only how this repository uses them.",
		);
	}
	return notes;
}

/**
 * The same for every worker in every wave: each is an independent review of the whole change, so no worker is given
 * a part of it or anything another worker reported.
 */
function workerPrompt(target: ReviewTarget, delivery: WorkerDelivery, focus: string | undefined): string {
	return [
		changeSection(target, delivery.text, workerNotes(target, delivery)),
		"",
		"# Task",
		...(focus ? [`User focus: ${focus}`] : []),
		"Review the whole change, verify with the read-only tools, then call report_findings exactly once.",
	].join("\n");
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Runs one wave. Once most of the wave has finished (at least all but one worker for small waves), a running worker
 * whose own elapsed time exceeds the median finished duration plus a grace period is told to wrap up, and after
 * another grace it is forced to report. Measuring each worker's own elapsed time covers workers that start late
 * (concurrency below the wave size). The grace is half the median, clamped, unless the stragglerGrace setting sets it.
 */
export async function runWave(setup: SwarmSetup, state: SwarmState, workers: WorkerState[]): Promise<void> {
	const { options, signal, target } = setup;
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
				// One host pass per worker: the diff it is given, and the tools it reads through, count for it alone.
				const hostPass = setup.engine.pass();
				const delivery = deliverDiff(target, hostPass);
				const pages = pageCount(target, delivery.pagedFiles);
				await runPass(setup, {
					label: `Swarm review worker ${worker.index + 1}`,
					model: setup.workerModel,
					thinking: options.thinking,
					systemPrompt: WORKER_SYSTEM_PROMPT,
					reportTool: createFindingsTool(worker, state, setup.engine, () => {
						reportedFindings = true;
					}),
					hasReport: () => reportedFindings,
					prompt: workerPrompt(target, delivery, options.focus),
					hostTools: hostPass.tools(),
					wrapUpMessage: WORKER_WRAP_UP,
					repairMessage: WORKER_REPAIR,
					turns: { wrapUp: WORKER_TURNS.wrapUp + pages, max: WORKER_TURNS.max + pages },
					state: worker,
					bindControl: (control) => controls.set(worker.index, control),
				});
				// What the host saw this worker read whole, in its prompt or through review_diff, is what it reviewed.
				const read = new Set(hostPass.coverage().hunksInspected);
				worker.missedHunks = target.hunkIds.filter((id) => !read.has(id));
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
