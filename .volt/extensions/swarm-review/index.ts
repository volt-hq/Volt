/**
 * /swarm-review: run the same code review many times with an inexpensive model in waves, cluster the combined claims
 * by root cause, and have two independent verifiers confirm or reject each cluster.
 *
 * Usage:
 *   /swarm-review [--base <ref> | --commit <rev> | --pr <n>] [--scope <glob>]...
 *                 [--workers N] [--wave-size N] [--concurrency N] [--model <ref>] [--thinking <level>]
 *                 [--verifier <ref>] [--verifier-thinking <level>] [--verifier-concurrency N]
 *                 [--exec] [--fresh] [--straggler-grace <seconds>] [focus text...]
 *
 * Without a target option it reviews uncommitted and untracked changes against HEAD. With --base it reviews
 * everything since the merge base with <ref>, including uncommitted changes. The reviewed state is frozen into a
 * throwaway checkout, so edits made during the review do not affect it.
 *
 * A review runs in the background as `ext:swarm-review/run` work: every client sees its progress (a step per wave
 * and for verification) and its detail (the target and models, as UI data) and can cancel it (`cancel_work`; Escape
 * in the TUI). Its report rides the next turn as the work's notice, and is the work's output.
 */

import type { Api, Model, ModelThinkingLevel } from "@hansjm10/volt-ai";
import {
	defineManifest,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	SettingsManager,
	type WorkRunContext,
	type WorkRunResult,
} from "@hansjm10/volt-coding-agent";
import { clusterWave } from "./cluster.ts";
import { loadContextFiles, resolveTarget } from "./git.ts";
import { type Dismissal, loadDismissals, recordDismissals } from "./memory.ts";
import { buildReport, modelRef, reportSummary, runDetail, workProgress } from "./report.ts";
import type { ReviewTarget, SwarmOptions, SwarmSetup, SwarmState, TargetSpec } from "./types.ts";
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
const VALUE_FLAGS = new Set([
	"base",
	"commit",
	"pr",
	"scope",
	"workers",
	"wave-size",
	"concurrency",
	"model",
	"thinking",
	"verifier",
	"verifier-thinking",
	"verifier-concurrency",
	"straggler-grace",
]);
const BOOLEAN_FLAGS = new Set(["exec", "fresh"]);
const USAGE =
	"Usage: /swarm-review [--base <ref> | --commit <rev> | --pr <n>] [--scope <glob>] [--workers N] [--wave-size N] [--concurrency N] [--model <ref>] [--thinking <level>] [--verifier <ref>] [--verifier-thinking <level>] [--verifier-concurrency N] [--exec] [--fresh] [--straggler-grace <seconds>] [focus...]";

// ---------------------------------------------------------------------------
// Arguments and models

/** Throws with a user-facing message on invalid input. */
function parseArgs(input: string): SwarmOptions {
	const tokens = (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
		/^(["']).*\1$/.test(token) ? token.slice(1, -1) : token,
	);
	const values = new Map<string, string>();
	const scope: string[] = [];
	const booleans = new Set<string>();
	const focus: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token.startsWith("--")) {
			focus.push(token);
			continue;
		}
		const equals = token.indexOf("=");
		const name = token.slice(2, equals === -1 ? undefined : equals);
		if (BOOLEAN_FLAGS.has(name) && equals === -1) {
			booleans.add(name);
			continue;
		}
		if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option --${name}. ${USAGE}`);
		const value = equals === -1 ? tokens[++index] : token.slice(equals + 1);
		if (!value) throw new Error(`--${name} needs a value. ${USAGE}`);
		if (name === "scope") scope.push(...value.split(",").filter(Boolean));
		else values.set(name, value);
	}

	const integer = (name: string, fallback: number, max: number): number => {
		const raw = values.get(name);
		if (raw === undefined) return fallback;
		const value = Number(raw);
		if (!Number.isInteger(value) || value < 1 || value > max) {
			throw new Error(`--${name} must be an integer from 1 to ${max}.`);
		}
		return value;
	};
	const thinking = (name: string, fallback: ModelThinkingLevel): ModelThinkingLevel => {
		const raw = values.get(name);
		if (raw === undefined) return fallback;
		const level = THINKING_LEVELS.find((candidate) => candidate === raw);
		if (!level) throw new Error(`--${name} must be one of ${THINKING_LEVELS.join(", ")}.`);
		return level;
	};
	const revision = (name: string): string | undefined => {
		const value = values.get(name);
		if (value?.startsWith("-")) throw new Error(`--${name} must be a Git revision.`);
		return value;
	};

	const base = revision("base");
	const commit = revision("commit");
	const prRaw = values.get("pr");
	if ([base, commit, prRaw].filter((value) => value !== undefined).length > 1) {
		throw new Error("Use only one of --base, --commit, and --pr.");
	}
	let target: TargetSpec = { kind: "worktree", ...(base ? { base } : {}) };
	if (commit) target = { kind: "commit", rev: commit };
	if (prRaw !== undefined) {
		const number = Number(prRaw);
		if (!Number.isInteger(number) || number < 1) throw new Error("--pr must be a pull request number.");
		target = { kind: "pr", number };
	}
	for (const pattern of scope) {
		if (pattern.startsWith("-") || pattern.startsWith(":"))
			throw new Error(`--scope must be a path glob: ${pattern}`);
	}
	const workers = integer("workers", DEFAULT_WORKERS, MAX_WORKERS);
	const waveSize = Math.min(workers, integer("wave-size", DEFAULT_WAVE_SIZE, MAX_WORKERS));
	const stragglerRaw = values.get("straggler-grace");
	let stragglerGrace: number | undefined;
	if (stragglerRaw !== undefined) {
		stragglerGrace = Number(stragglerRaw);
		if (!Number.isFinite(stragglerGrace) || stragglerGrace < 1 || stragglerGrace > 3600) {
			throw new Error("--straggler-grace must be a number of seconds from 1 to 3600.");
		}
	}
	const model = values.get("model");
	const verifier = values.get("verifier");
	return {
		target,
		scope,
		workers,
		waveSize,
		concurrency: integer("concurrency", waveSize, MAX_WORKERS),
		...(model ? { model } : {}),
		thinking: thinking("thinking", DEFAULT_WORKER_THINKING),
		...(verifier ? { verifier } : {}),
		verifierThinking: thinking("verifier-thinking", DEFAULT_VERIFIER_THINKING),
		verifierConcurrency: integer("verifier-concurrency", DEFAULT_VERIFIER_CONCURRENCY, MAX_VERIFIER_CONCURRENCY),
		exec: booleans.has("exec"),
		fresh: booleans.has("fresh"),
		...(stragglerGrace !== undefined ? { stragglerGrace } : {}),
		...(focus.length > 0 ? { focus: focus.join(" ") } : {}),
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
	ctx: ExtensionCommandContext,
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

interface SwarmRun {
	target: ReviewTarget;
	options: SwarmOptions;
	workerModel: Model<Api>;
	verifierModel: Model<Api>;
	settingsManager: SettingsManager;
	modelRegistry: ExtensionCommandContext["modelRegistry"];
	contextFiles: Array<{ path: string; content: string }>;
	dismissals: Dismissal[];
}

/** The work of one review: owns its checkout from here on. */
async function runWork(work: WorkRunContext, run: SwarmRun): Promise<WorkRunResult> {
	const { target, options } = run;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const state: SwarmState = {
			workers: [],
			clusters: [],
			waves: [],
			phase: "workers",
			currentWave: 0,
			clusterPasses: [],
			nextCandidate: 0,
			cancelling: false,
			saturated: false,
		};
		const report = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			work.progress(workProgress(state, options));
		};
		const setup: SwarmSetup = {
			target,
			options,
			workerModel: run.workerModel,
			verifierModel: run.verifierModel,
			settingsManager: run.settingsManager,
			modelRegistry: run.modelRegistry,
			contextFiles: run.contextFiles,
			signal: work.signal,
			onProgress: () => {
				timer ??= setTimeout(report, PROGRESS_INTERVAL_MS);
			},
		};
		const onAbort = (): void => {
			state.cancelling = true;
			report();
		};
		work.signal.addEventListener("abort", onAbort, { once: true });
		const startedAt = Date.now();
		const result = await runSwarm(setup, state, run.dismissals, () =>
			work.checkpoint(workProgress(state, options)),
		).catch(
			(error: unknown): SwarmResult =>
				error instanceof SwarmCancelled || work.signal.aborted
					? { status: "cancelled" }
					: { status: "failed", error: errorText(error) },
		);
		work.signal.removeEventListener("abort", onAbort);
		if (result.status === "cancelled") return { outcome: "cancelled" };
		if (result.status === "failed") return { outcome: "failed", error: result.error };

		const remembered = await recordDismissals(
			target,
			state.clusters.filter((cluster) => cluster.outcome === "rejected"),
		).catch(() => 0);
		const built = buildReport(setup, state, Date.now() - startedAt, remembered);
		return {
			outcome: "completed",
			result: {
				summary: reportSummary(state, built.findings),
				output: { text: built.markdown, truncated: false },
				data: {
					target: target.description,
					workerModel: modelRef(run.workerModel),
					verifierModel: modelRef(run.verifierModel),
					workers: state.workers.length,
					waves: state.waves.length,
					clusters: state.clusters.length,
					findings: built.findings.length,
				},
			},
			// The model reads the whole report with its next turn.
			notice: built.markdown,
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		await target.dispose();
	}
}

// ---------------------------------------------------------------------------
// Command

export const manifest = defineManifest({
	id: "swarm-review",
	displayName: "Swarm Review",
	description: "Reviews changes with many inexpensive reviewers in waves and verifies the clustered findings.",
	permissions: ["exec", "fs-write", "secrets"],
});

export default function swarmReview(volt: ExtensionAPI) {
	volt.registerWorkKind("run", { delivery: "message", detail: runDetail });
	volt.registerCommand("swarm-review", {
		description:
			"Review with waves of cheap workers, cluster their claims, and verify each cluster with two independent verifiers",
		// Audited for paired remote clients: arguments only select Git revisions, path globs, models, and counts, and
		// the review is read-only against a throwaway checkout. --exec (arbitrary commands) is refused unless a local
		// client invoked the command, so a remote client can never enable it.
		remoteSafe: true,
		handler: async (args, ctx) => {
			const notify = (message: string, level: "info" | "warning" | "error"): void => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			};
			let options: SwarmOptions;
			try {
				options = parseArgs(args);
			} catch (error) {
				return notify(error instanceof Error ? error.message : String(error), "error");
			}
			if (options.exec) {
				// Only a user at the host gives verifiers a shell: a paired remote device never does.
				if (ctx.invokedBy !== "local")
					return notify("--exec is only available from a local client, such as the TUI.", "error");
				if (!ctx.hasUI) return notify("--exec needs an interactive confirmation.", "error");
				const allowed = await ctx.ui.confirm(
					"Allow verifiers to run commands?",
					"Verifiers will get bash in a throwaway checkout of the reviewed code, with your node_modules linked in. Commands run with your full permissions, and a prompt injection in the reviewed change could influence what they run. Only continue for code you trust.",
					{ signal: ctx.signal },
				);
				if (!allowed) return notify("Swarm review cancelled.", "info");
			}

			const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: ctx.isProjectTrusted(),
			});
			const worker = selectModel(
				"Worker model",
				"--model",
				options.model,
				[DEFAULT_WORKER_MODEL, settingsManager.getReviewModel()],
				ctx,
			);
			if ("error" in worker) return notify(worker.error, "error");
			const verifier = selectModel(
				"Verifier model",
				"--verifier",
				options.verifier,
				[DEFAULT_VERIFIER_MODEL, settingsManager.getReviewVerifierModel()],
				ctx,
			);
			if ("error" in verifier) return notify(verifier.error, "error");
			for (const warning of [worker.warning, verifier.warning]) if (warning) notify(warning, "warning");

			let resolved: Awaited<ReturnType<typeof resolveTarget>>;
			try {
				resolved = await resolveTarget(ctx.cwd, options.target, options.scope, ctx.signal);
			} catch (error) {
				if (error instanceof SwarmCancelled) return notify("Swarm review cancelled.", "info");
				throw error;
			}
			if (typeof resolved === "string") return notify(resolved, "warning");
			const target = resolved;
			let started = false;
			try {
				let contextFiles: Array<{ path: string; content: string }>;
				try {
					contextFiles = await loadContextFiles(target, ctx.cwd, ctx.signal);
				} catch (error) {
					if (error instanceof SwarmCancelled) return notify("Swarm review cancelled.", "info");
					throw error;
				}
				let dismissals: Dismissal[] = [];
				try {
					if (!options.fresh) dismissals = loadDismissals(target);
				} catch {
					// Unreadable memory must not block a review.
				}
				const run: SwarmRun = {
					target,
					options,
					workerModel: worker.model,
					verifierModel: verifier.model,
					settingsManager,
					modelRegistry: ctx.modelRegistry,
					contextFiles,
					dismissals,
				};
				try {
					await ctx.startWork(
						"run",
						{
							title: `Swarm review: ${target.description}`,
							input: {
								target: { ...options.target },
								scope: options.scope,
								workers: options.workers,
								waveSize: options.waveSize,
								model: modelRef(worker.model),
								thinking: options.thinking,
								verifier: modelRef(verifier.model),
								verifierThinking: options.verifierThinking,
								exec: options.exec,
								...(options.focus ? { focus: options.focus } : {}),
							},
						},
						(work) => runWork(work, run),
					);
					started = true;
				} catch (error) {
					return notify(`Swarm review did not start: ${errorText(error)}`, "error");
				}
				notify(
					`Swarm review started: waves of ${options.waveSize}, up to ${options.workers} × ${worker.model.id} (${options.thinking}) → 2 × ${verifier.model.id} (${options.verifierThinking}). Its report rides your next message.`,
					"info",
				);
			} finally {
				if (!started) await target.dispose();
			}
		},
	});
}
