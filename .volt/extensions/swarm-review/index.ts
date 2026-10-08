/**
 * The swarm review engine: run the same code review many times with an inexpensive model in waves, cluster the
 * combined claims by root cause, and have two independent verifiers confirm or reject each cluster.
 *
 * Run it from `/review --engine swarm`, with the review's own options (`--focus`, `--scope`, `--effort`) and
 * its own:
 *
 *   /review branch main --engine swarm [--workers N] [--wave-size N] [--concurrency N] [--model <ref>]
 *                 [--thinking <level>] [--verifier <ref>] [--verifier-thinking <level>]
 *                 [--verifier-concurrency N] [--exec] [--fresh] [--straggler-grace <seconds>]
 *
 * The host resolves what is reviewed (uncommitted changes, a branch with or without its uncommitted changes, a
 * commit, or a pull request's code) and runs the engine as `review` work, so every client sees its progress (a step
 * per wave and for verification) and its detail (the target and models), and can cancel it. The engine reads the
 * change through the host: its hunks are delivered to each worker and verifier as diff text the host counts as
 * reviewed. The confirmed findings are submitted in the host's report shapes, which validates them (anchors on
 * changed lines) and writes the run's record, so the review opens into the same findings conversation as any
 * review's. The full report, with what the verifiers disputed or rejected, is the work's output.
 *
 * Defaults for models, thinking, and counts are this extension's settings; a flag overrides one for a run.
 */

import type { Api, Model, ModelThinkingLevel } from "@hansjm10/volt-ai";
import {
	defineManifest,
	type ExtensionAPI,
	getAgentDir,
	type ReviewEngineContext,
	SettingsManager,
} from "@hansjm10/volt-coding-agent";
import { clusterWave } from "./cluster.ts";
import { loadContextFiles } from "./git.ts";
import { type Dismissal, loadDismissals, recordDismissals } from "./memory.ts";
import { buildReport, modelRef, reportSummary, runDetail, workProgress } from "./report.ts";
import { buildSubmission } from "./submit.ts";
import { buildTarget } from "./target.ts";
import type { SwarmOptions, SwarmSetup, SwarmState } from "./types.ts";
import { errorText, SwarmCancelled } from "./util.ts";
import { verifyClusters } from "./verify.ts";
import { createWorkerState, runWave } from "./workers.ts";

const DEFAULT_WORKER_MODEL = "gpt-6-luna";
const DEFAULT_WORKER_THINKING: ModelThinkingLevel = "max";
const DEFAULT_VERIFIER_MODEL = "claude-opus-5-5";
const DEFAULT_VERIFIER_THINKING: ModelThinkingLevel = "high";
const DEFAULT_WORKERS = 30;
const DEFAULT_WAVE_SIZE = 10;
const DEFAULT_VERIFIER_CONCURRENCY = 6;
const MAX_WORKERS = 32;
const MAX_VERIFIER_CONCURRENCY = 16;
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Live progress at most this often; worker sessions report every event. */
const PROGRESS_INTERVAL_MS = 250;

export const manifest = defineManifest({
	id: "swarm-review",
	displayName: "Swarm Review",
	description: "Reviews changes with many inexpensive reviewers in waves and verifies the clustered findings.",
	permissions: ["exec", "fs-write", "secrets"],
	settings: {
		type: "object",
		properties: {
			workerModel: {
				type: "string",
				title: "Worker model",
				description: "The model the reviewers use: provider/id, or a bare id.",
				default: DEFAULT_WORKER_MODEL,
			},
			workerThinking: {
				type: "string",
				title: "Worker thinking",
				enum: [...THINKING_LEVELS],
				default: DEFAULT_WORKER_THINKING,
			},
			verifierModel: {
				type: "string",
				title: "Verifier model",
				description: "The model the verifiers use: provider/id, or a bare id.",
				default: DEFAULT_VERIFIER_MODEL,
			},
			verifierThinking: {
				type: "string",
				title: "Verifier thinking",
				enum: [...THINKING_LEVELS],
				default: DEFAULT_VERIFIER_THINKING,
			},
			workers: {
				type: "integer",
				title: "Workers",
				description: "Most reviewers across all waves.",
				minimum: 1,
				maximum: MAX_WORKERS,
				default: DEFAULT_WORKERS,
			},
			waveSize: {
				type: "integer",
				title: "Wave size",
				description: "Reviewers per wave.",
				minimum: 1,
				maximum: MAX_WORKERS,
				default: DEFAULT_WAVE_SIZE,
			},
			verifierConcurrency: {
				type: "integer",
				title: "Verifier concurrency",
				description: "Verifier sessions at once; each cluster uses two.",
				minimum: 1,
				maximum: MAX_VERIFIER_CONCURRENCY,
				default: DEFAULT_VERIFIER_CONCURRENCY,
			},
		},
	},
});

// ---------------------------------------------------------------------------
// Options and models

type Settings = Readonly<Record<string, string | boolean | number | undefined>>;

function integerOf(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function thinkingOf(value: unknown, fallback: ModelThinkingLevel): ModelThinkingLevel {
	return THINKING_LEVELS.find((level) => level === value) ?? fallback;
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The run's options: the review's own (focus and scope, from the host), then the engine's parameters, each over the
 * extension's setting for it. The host has checked every parameter against its declaration.
 */
export function resolveOptions(engine: Pick<ReviewEngineContext, "params" | "target">, settings: Settings): SwarmOptions {
	const { params } = engine;
	const workers = integerOf(params.workers, integerOf(settings.workers, DEFAULT_WORKERS));
	const waveSize = Math.min(workers, integerOf(params.waveSize, integerOf(settings.waveSize, DEFAULT_WAVE_SIZE)));
	const model = stringOf(params.model);
	const verifier = stringOf(params.verifier);
	const stragglerGrace = typeof params.stragglerGrace === "number" ? params.stragglerGrace : undefined;
	const { focus, scope } = engine.target.controls;
	return {
		scope: [...scope],
		workers,
		waveSize,
		concurrency: integerOf(params.concurrency, waveSize),
		...(model ? { model } : {}),
		thinking: thinkingOf(params.thinking, thinkingOf(settings.workerThinking, DEFAULT_WORKER_THINKING)),
		...(verifier ? { verifier } : {}),
		verifierThinking: thinkingOf(
			params.verifierThinking,
			thinkingOf(settings.verifierThinking, DEFAULT_VERIFIER_THINKING),
		),
		verifierConcurrency: integerOf(
			params.verifierConcurrency,
			integerOf(settings.verifierConcurrency, DEFAULT_VERIFIER_CONCURRENCY),
		),
		exec: params.exec === true,
		fresh: params.fresh === true,
		...(stragglerGrace !== undefined ? { stragglerGrace } : {}),
		...(focus ? { focus } : {}),
	};
}

/** Accepts `provider/id` or a bare id. Ambiguous bare ids prefer the current model's provider. */
function resolveModel(
	reference: string,
	available: Model<Api>[],
	preferredProvider: string | undefined,
): Model<Api> | string {
	const normalized = reference.trim().toLowerCase();
	const canonical = available.find((model) => `${model.provider}/${model.id}`.toLowerCase() === normalized);
	if (canonical) return canonical;
	const byId = available.filter((model) => model.id.toLowerCase() === normalized);
	if (byId.length === 1) return byId[0];
	if (byId.length > 1) {
		const preferred = byId.filter((model) => model.provider === preferredProvider);
		if (preferred.length === 1) return preferred[0];
		return `"${reference}" is ambiguous; use one of ${byId.map((model) => `${model.provider}/${model.id}`).join(", ")}.`;
	}
	return `"${reference}" is unknown or not authenticated.`;
}

/** Never falls back to the session's current model: that could silently run every worker on an expensive model. */
function selectModel(
	label: string,
	flag: string,
	explicit: string | undefined,
	fallbacks: Array<string | undefined>,
	ctx: Pick<ReviewEngineContext, "modelRegistry" | "model">,
): { model: Model<Api>; warning?: string } | { error: string } {
	const available = ctx.modelRegistry.getAvailable();
	const preferredProvider = ctx.model?.provider;
	if (explicit) {
		const resolved = resolveModel(explicit, available, preferredProvider);
		return typeof resolved === "string" ? { error: `${label} ${resolved}` } : { model: resolved };
	}
	const failures: string[] = [];
	for (const reference of fallbacks) {
		if (!reference) continue;
		const resolved = resolveModel(reference, available, preferredProvider);
		if (typeof resolved !== "string") {
			return failures.length > 0
				? { model: resolved, warning: `${label} ${failures[0]} Using ${modelRef(resolved)}.` }
				: { model: resolved };
		}
		failures.push(resolved);
	}
	return { error: `${label} ${failures[0] ?? "is not configured."} Pass ${flag} <provider/id>.` };
}

// ---------------------------------------------------------------------------
// Orchestration

type SwarmResult = { status: "completed" } | { status: "cancelled" } | { status: "failed"; error: string };

/**
 * Runs waves until the worker budget is spent or a wave adds no new cluster (once every diff part has had a
 * successful worker), then verifies all clusters. `checkpoint` records each wave's start and the verification's.
 */
async function runSwarm(
	setup: SwarmSetup,
	state: SwarmState,
	dismissals: Dismissal[],
	checkpoint: () => void,
): Promise<SwarmResult> {
	const { options, signal, target } = setup;
	const maxWaves = Math.ceil(options.workers / options.waveSize);
	let nextIndex = 0;
	for (let wave = 1; wave <= maxWaves; wave++) {
		const count = Math.min(options.waveSize, options.workers - nextIndex);
		const workers = Array.from({ length: count }, (_, offset) =>
			createWorkerState(nextIndex + offset, wave, (nextIndex + offset) % target.shards.length),
		);
		nextIndex += count;
		state.workers.push(...workers);
		state.currentWave = wave;
		state.phase = "workers";
		checkpoint();
		await runWave(setup, state, workers);
		if (signal.aborted) return { status: "cancelled" };
		if (!workers.some((worker) => worker.status === "done")) {
			state.waves.push({
				wave,
				workers: count,
				candidates: 0,
				newClusters: 0,
				clusteringFallback: false,
				failed: true,
			});
			break;
		}
		state.phase = "clustering";
		const candidates = workers.flatMap((worker) => worker.candidates);
		const { newClusters, fallback } = await clusterWave(setup, state, candidates, dismissals, wave);
		state.waves.push({
			wave,
			workers: count,
			candidates: candidates.length,
			newClusters,
			clusteringFallback: fallback,
		});
		const covered = target.shards.every((shard) =>
			state.workers.some((worker) => worker.shard === shard.index && worker.status === "done"),
		);
		if (newClusters === 0 && covered) {
			state.saturated = true;
			break;
		}
	}
	if (!state.workers.some((worker) => worker.status === "done")) {
		const error = state.workers.find((worker) => worker.error)?.error ?? "unknown";
		return { status: "failed", error: `All workers failed. First error: ${error}` };
	}
	state.phase = "verifying";
	checkpoint();
	await verifyClusters(setup, state);
	if (signal.aborted) return { status: "cancelled" };
	state.phase = "done";
	return { status: "completed" };
}

/** The run's detail: what it reviews and with which models. */
function detailOf(description: string, options: SwarmOptions, workerModel: Model<Api>, verifierModel: Model<Api>) {
	return runDetail({
		description,
		scope: options.scope,
		workers: options.workers,
		waveSize: options.waveSize,
		model: modelRef(workerModel),
		thinking: options.thinking,
		verifier: modelRef(verifierModel),
		verifierThinking: options.verifierThinking,
		exec: options.exec,
		...(options.focus ? { focus: options.focus } : {}),
	});
}

/** One review, as the host runs it: the host's snapshot is the change, the host validates what is submitted. */
async function runSwarmReview(engine: ReviewEngineContext, settings: Settings): Promise<void> {
	const options = resolveOptions(engine, settings);
	const settingsManager = SettingsManager.create(engine.cwd, getAgentDir(), {
		projectTrusted: engine.isProjectTrusted(),
	});
	const worker = selectModel(
		"Worker model",
		"--model",
		options.model,
		[stringOf(settings.workerModel) ?? DEFAULT_WORKER_MODEL, settingsManager.getReviewModel()],
		engine,
	);
	if ("error" in worker) throw new Error(worker.error);
	const verifier = selectModel(
		"Verifier model",
		"--verifier",
		options.verifier,
		[stringOf(settings.verifierModel) ?? DEFAULT_VERIFIER_MODEL, settingsManager.getReviewVerifierModel()],
		engine,
	);
	if ("error" in verifier) throw new Error(verifier.error);
	const warnings = [worker.warning, verifier.warning].filter((warning): warning is string => warning !== undefined);

	const target = await buildTarget(engine, engine.signal);
	if (typeof target === "string") throw new Error(target);
	let dismissals: Dismissal[] = [];
	try {
		if (!options.fresh) dismissals = loadDismissals(target);
	} catch {
		// Unreadable memory must not block a review.
	}
	const contextFiles = await loadContextFiles(target.repoRoot, target.readBase, engine.cwd, engine.signal);

	let timer: ReturnType<typeof setTimeout> | undefined;
	const state: SwarmState = {
		workers: [],
		clusters: [],
		waves: [],
		phase: "workers",
		currentWave: 0,
		clusterPasses: [],
		nextCandidate: 0,
		commands: [],
		failedCommands: [],
		cancelling: false,
		saturated: false,
	};
	const detail = detailOf(target.description, options, worker.model, verifier.model);
	const report = (): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		engine.progress(workProgress(state, options), detail);
	};
	const setup: SwarmSetup = {
		engine,
		target,
		options,
		workerModel: worker.model,
		verifierModel: verifier.model,
		settingsManager,
		modelRegistry: engine.modelRegistry,
		contextFiles,
		signal: engine.signal,
		onProgress: () => {
			timer ??= setTimeout(report, PROGRESS_INTERVAL_MS);
		},
	};
	const onAbort = (): void => {
		state.cancelling = true;
		report();
	};
	engine.signal.addEventListener("abort", onAbort, { once: true });
	const startedAt = Date.now();
	let result: SwarmResult;
	try {
		result = await runSwarm(setup, state, dismissals, () =>
			engine.checkpoint(workProgress(state, options), detail),
		).catch(
			(error: unknown): SwarmResult =>
				error instanceof SwarmCancelled || engine.signal.aborted
					? { status: "cancelled" }
					: { status: "failed", error: errorText(error) },
		);
	} finally {
		engine.signal.removeEventListener("abort", onAbort);
		if (timer !== undefined) clearTimeout(timer);
	}
	// A cancelled review is the host's to record; so is a failed one, with the reason.
	if (result.status === "cancelled") return;
	if (result.status === "failed") throw new Error(result.error);

	const remembered = await recordDismissals(
		target,
		state.clusters.filter((cluster) => cluster.outcome === "rejected"),
	).catch(() => 0);
	const built = buildReport(setup, state, Date.now() - startedAt, remembered);
	const unreviewedFiles = target.shards
		.filter((shard) => !state.workers.some((entry) => entry.shard === shard.index && entry.status === "done"))
		.flatMap((shard) => shard.files);
	const submission = await engine.submit(
		buildSubmission(state, built.findings, {
			summary: reportSummary(state, built.findings),
			shardCount: target.shards.length,
			unreviewedFiles,
			completedWorkers: state.workers.filter((entry) => entry.status === "done").length,
			limitations: [
				...warnings,
				...(target.submodules ? ["The change updates submodule commits; their contents were not available to reviewers."] : []),
				...(target.shards.some((shard) => shard.partialFiles.length > 0)
					? ["Some hunks were too large to include in a prompt; reviewers paged them."]
					: []),
			],
		}),
	);
	const notes = [
		...warnings,
		...(submission.rejected.length > 0
			? [
					`The host did not accept ${submission.rejected.length} finding(s) (${submission.rejected.join(", ")}): ${submission.errors.join("; ")}. They are in this report only.`,
				]
			: []),
	];
	engine.output(notes.length === 0 ? built.markdown : `${built.markdown}\n\n${notes.map((note) => `> ${note}`).join("\n")}`);
}

export default function swarmReview(volt: ExtensionAPI) {
	volt.registerReviewEngine("swarm", {
		label: "Swarm",
		description: "Many reviewers in waves, their claims clustered by root cause, each cluster verified twice.",
		cost: "Much slower and costlier than the standard review: dozens of model sessions.",
		targets: ["uncommitted", "branch", "branch_uncommitted", "commit", "pr"],
		// Audited for paired remote clients: the options select models, counts, and timing, and the review is read-only
		// against a throwaway checkout. --exec (arbitrary commands) is local-only, so a remote client can never set it.
		remoteSafe: true,
		parameters: {
			type: "object",
			properties: {
				workers: {
					type: "integer",
					title: "Workers",
					description: `Most reviewers across all waves (1 to ${MAX_WORKERS}); the extension's setting by default.`,
					minimum: 1,
					maximum: MAX_WORKERS,
				},
				waveSize: {
					type: "integer",
					title: "Wave size",
					description: "Reviewers per wave; the extension's setting by default.",
					minimum: 1,
					maximum: MAX_WORKERS,
				},
				concurrency: {
					type: "integer",
					title: "Concurrency",
					description: "Reviewers running at once within a wave; the wave size by default.",
					minimum: 1,
					maximum: MAX_WORKERS,
				},
				model: {
					type: "string",
					title: "Worker model",
					description: "The model the reviewers use (provider/id, or a bare id); the extension's setting by default.",
					minLength: 1,
					maxLength: 200,
				},
				thinking: {
					type: "string",
					title: "Worker thinking",
					enum: [...THINKING_LEVELS],
				},
				verifier: {
					type: "string",
					title: "Verifier model",
					description: "The model the verifiers use (provider/id, or a bare id); the extension's setting by default.",
					minLength: 1,
					maxLength: 200,
				},
				verifierThinking: {
					type: "string",
					title: "Verifier thinking",
					enum: [...THINKING_LEVELS],
				},
				verifierConcurrency: {
					type: "integer",
					title: "Verifier concurrency",
					description: "Verifier sessions at once; each cluster uses two.",
					minimum: 1,
					maximum: MAX_VERIFIER_CONCURRENCY,
				},
				stragglerGrace: {
					type: "integer",
					title: "Straggler grace",
					description: "Seconds a slow reviewer gets after most of its wave finished; derived from the wave by default.",
					minimum: 1,
					maximum: 3600,
				},
				fresh: {
					type: "boolean",
					title: "Fresh",
					description: "Ignore the issues earlier reviews of this repository rejected.",
				},
				exec: {
					type: "boolean",
					title: "Run commands",
					description:
						"Give verifiers bash in a throwaway checkout, with your node_modules linked. Commands run with your full permissions and a prompt injection in the change could steer them: use it only for code you trust.",
				},
			},
		},
		// Only a client at the host may let verifiers run commands.
		localOnly: ["exec"],
		run: (engine) => runSwarmReview(engine, volt.settings),
	});
}
