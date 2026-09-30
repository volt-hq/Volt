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
 */

import type { Api, Model, ModelThinkingLevel } from "@hansjm10/volt-ai";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	SettingsManager,
} from "@hansjm10/volt-coding-agent";
import { clusterWave } from "./cluster.ts";
import { loadContextFiles, resolveTarget } from "./git.ts";
import { type Dismissal, loadDismissals, recordDismissals } from "./memory.ts";
import { buildReport, modelRef, phaseText, renderProgress, SwarmProgressView } from "./report.ts";
import type { SwarmOptions, SwarmSetup, SwarmState, TargetSpec } from "./types.ts";
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
const WIDGET_KEY = "swarm-review";
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
 * successful worker), then verifies all clusters.
 */
async function runSwarm(setup: SwarmSetup, state: SwarmState, dismissals: Dismissal[]): Promise<SwarmResult> {
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
		setup.onProgress();
		await runWave(setup, state, workers);
		if (signal.aborted) return { status: "cancelled" };
		if (!workers.some((worker) => worker.status === "done")) break;
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
	setup.onProgress();
	await verifyClusters(setup, state);
	if (signal.aborted) return { status: "cancelled" };
	state.phase = "done";
	return { status: "completed" };
}

// ---------------------------------------------------------------------------
// Command

export default function swarmReview(volt: ExtensionAPI) {
	volt.registerCommand("swarm-review", {
		description:
			"Review with waves of cheap workers, cluster their claims, and verify each cluster with two independent verifiers",
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

			const controller = new AbortController();
			const onCommandAbort = (): void => controller.abort();
			ctx.signal.addEventListener("abort", onCommandAbort, { once: true });
			try {
				let resolved: Awaited<ReturnType<typeof resolveTarget>>;
				try {
					resolved = await resolveTarget(ctx.cwd, options.target, options.scope, controller.signal);
				} catch (error) {
					if (error instanceof SwarmCancelled) return notify("Swarm review cancelled.", "info");
					throw error;
				}
				if (typeof resolved === "string") return notify(resolved, "warning");
				const target = resolved;
				try {
					const contextFiles = await loadContextFiles(target, ctx.cwd, controller.signal);
					const dismissals = options.fresh ? [] : loadDismissals(target);
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
					const label = `waves of ${options.waveSize}, up to ${options.workers} × ${worker.model.id} (${options.thinking}) → 2 × ${verifier.model.id} (${options.verifierThinking})`;
					let view: SwarmProgressView | undefined;
					const setup: SwarmSetup = {
						target,
						options,
						workerModel: worker.model,
						verifierModel: verifier.model,
						settingsManager,
						modelRegistry: ctx.modelRegistry,
						contextFiles,
						signal: controller.signal,
						onProgress: () => {
							// Custom TUI components replace the view, which hides widgets; render progress inside it instead.
							if (view) view.update(renderProgress(state, label, ctx.ui.theme), phaseText(state));
							else if (ctx.hasUI && ctx.mode !== "tui") {
								ctx.ui.setWidget(WIDGET_KEY, renderProgress(state, label, ctx.ui.theme));
							}
						},
					};

					const startedAt = Date.now();
					setup.onProgress();
					const run = runSwarm(setup, state, dismissals).catch(
						(error: unknown): SwarmResult =>
							error instanceof SwarmCancelled || controller.signal.aborted
								? { status: "cancelled" }
								: { status: "failed", error: errorText(error) },
					);
					if (ctx.mode === "tui") {
						try {
							await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
								const loader = new BorderedLoader(tui, theme, phaseText(state));
								loader.onAbort = () => {
									state.cancelling = true;
									controller.abort();
									setup.onProgress();
								};
								view = new SwarmProgressView(loader);
								setup.onProgress();
								void run.then(() => done());
								return view;
							});
						} catch (error) {
							controller.abort();
							await run;
							throw error;
						} finally {
							view = undefined;
						}
					}

					const result = await run;
					if (result.status === "cancelled") return notify("Swarm review cancelled.", "info");
					if (result.status === "failed") return notify(`Swarm review failed: ${result.error}`, "error");

					const remembered = await recordDismissals(
						target,
						state.clusters.filter((cluster) => cluster.outcome === "rejected"),
					).catch(() => 0);
					const report = buildReport(setup, state, Date.now() - startedAt, remembered);
					// The command may have started during an agent turn; post after it so the report is not steered into it.
					await ctx.waitForIdle();
					volt.sendMessage({
						customType: "swarm-review",
						content: report.markdown,
						display: true,
						details: {
							target: target.description,
							workerModel: modelRef(worker.model),
							verifierModel: modelRef(verifier.model),
							workers: state.workers.length,
							waves: state.waves.length,
							clusters: state.clusters.length,
							findings: report.findings.map((finding) => ({ ...finding })),
						},
					});
				} finally {
					await target.dispose();
				}
			} finally {
				ctx.signal.removeEventListener("abort", onCommandAbort);
				if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
			}
		},
	});
}
