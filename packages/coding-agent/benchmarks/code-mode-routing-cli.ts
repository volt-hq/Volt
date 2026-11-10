import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Api, builtInProviders, createAiClient, createFauxProvider, fauxAssistantMessage, fauxToolCall,
	getModels, type Model,
} from "@hansjm10/volt-ai";
import { anthropicOAuthProvider, openaiCodexOAuthProvider } from "@hansjm10/volt-ai/oauth";
import { getModels as getSourceModels } from "../../ai/src/models.ts";
import { getAgentDir } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type BenchmarkFixture, createCodeModeFixtures } from "./code-mode-fixtures.ts";
import { createRealisticRoutingFixtures } from "./code-mode-fixtures-realistic.ts";
import { ALL_ROUTING_MODES, CASE_LIMITS, ROUTING_MODES, type RoutingMode, runRoutingCase } from "./code-mode-routing.ts";
import { compareRoutingRuns, parseRoutingRun, type RoutingObservation, type RoutingRun, summarizeRoutingRuns } from "./code-mode-routing-report.ts";

export const DEFAULT_MODELS = ["openai-codex/gpt-6-astra"];
/** One model per run. Both use the stored subscription credential of their provider. */
export const BENCHMARK_MODELS = [...DEFAULT_MODELS, "anthropic/claude-opus-5-5"];
export const ROUTING_SUITES = ["core", "realistic", "all"] as const;
export type RoutingSuite = (typeof ROUTING_SUITES)[number];
export const RUN_LIMITS = { requests: 160, reportedTokens: 500_000, timeoutMs: 30 * 60_000 };
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_REPORT_BYTES = 128 * 1024 * 1024;
export const ROUTING_HELP = `Usage: npm run benchmark:code-mode -- [mode] [options]

Modes (default: --dry-run, no credentials or provider calls):
  --dry-run              Print the exact plan and budgets
  --self-test            Run reference programs with the faux provider
  --live                 Run the selected model at xhigh through its stored subscription login
  --report <path>         Summarize a run directory or results.json; repeat to combine
  --help                 Show this help

Report options:
  --baseline <path>       Compare the --report runs against these runs of another experiment,
                         such as an earlier commit or prompt; repeat to combine

Run options:
  --model <provider/id>   openai-codex/gpt-6-astra (default) or anthropic/claude-opus-5-5
  --routes <list>         Comma-separated routes from direct, hybrid, code-first, code-only
                         (default: hybrid,code-first,code-only). direct has no run_code tool
  --suite <name>          core (default, twenty small tasks), realistic (five large-result tasks), or all
  --task <id[,id...]>     Select fixtures by id from any suite instead of --suite
  --trials <1..50>        Repetitions of every task/route (default: 1)
  --trial-start <1..50>   First trial number, for split batches (default: 1)
  --seed <0..4294967295>  Reproducible ordering seed (default: 1)
  --max-requests <n>     Whole-run request cap, 1..10000 (default: 160)
  --max-tokens <n>       Reported-token admission cap, 1..20000000 (default: 500000)
  --minutes <1..60>      Whole-run deadline (default: 30)
  --out <directory>      New artifact directory outside the repository
                         (default: <agent dir>/benchmarks/code-mode-routing/<time>-<id>)

Route orders are balanced over every n! trials for n routes: two for a pair, six for three.
Each case has independent limits of 20 requests, 200 tool calls, and five minutes. Budgets
never auto-expand. Report mode makes no provider calls and prints Markdown; --out also saves
report.md. Only matching experiment fingerprints and distinct run IDs can be combined.
`;

export interface RoutingArgs {
	mode: "dry-run" | "self-test" | "live" | "report" | "help";
	models: string[];
	trials: number;
	trialStart: number;
	seed: number;
	limits: typeof RUN_LIMITS;
	out: string;
	saveReport: boolean;
	reports: string[];
	baselines: string[];
	routes: RoutingMode[];
	suite: RoutingSuite;
	tasks: string[];
}

/** Fresh fixtures for a suite. The core suite keeps its documented twenty tasks. */
export function createRoutingSuite(suite: RoutingSuite): BenchmarkFixture[] {
	return [...(suite === "realistic" ? [] : createCodeModeFixtures()), ...(suite === "core" ? [] : createRealisticRoutingFixtures())];
}

/** `--task` selects by id across suites, in suite order; otherwise the whole suite runs. */
export function selectRoutingFixtures(args: Pick<RoutingArgs, "suite" | "tasks">): BenchmarkFixture[] {
	if (!args.tasks.length) return createRoutingSuite(args.suite);
	return createRoutingSuite("all").filter((fixture) => args.tasks.includes(fixture.id));
}

function boundedInteger(value: string, name: string, min: number, max: number): number {
	const number = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max)
		throw new Error(`${name} must be an integer from ${min} through ${max}`);
	return number;
}

export function parseRoutingArgs(args: string[]): RoutingArgs {
	const parsed: RoutingArgs = {
		mode: "dry-run", models: [...DEFAULT_MODELS], trials: 1, trialStart: 1, seed: 1, limits: { ...RUN_LIMITS },
		out: join(getAgentDir(), "benchmarks", "code-mode-routing", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`),
		saveReport: false, reports: [], baselines: [], routes: [...ROUTING_MODES], suite: "core", tasks: [],
	};
	const list = (value: string, name: string): string[] => {
		const items = value.split(",");
		if (items.some((item) => !item) || new Set(items).size !== items.length) throw new Error(`${name} needs distinct comma-separated values`);
		return items;
	};
	const seen = new Set<string>();
	let selectedMode = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (seen.has(arg) && arg !== "--report" && arg !== "--baseline") throw new Error(`Duplicate argument: ${arg}`);
		seen.add(arg);
		if (["--dry-run", "--self-test", "--live", "--help"].includes(arg)) {
			if (selectedMode) throw new Error("Choose one execution mode");
			selectedMode = true;
			parsed.mode = arg.slice(2) as RoutingArgs["mode"];
			continue;
		}
		if (!["--model", "--routes", "--suite", "--trials", "--trial-start", "--out", "--task", "--seed", "--max-requests", "--max-tokens", "--minutes", "--report", "--baseline"].includes(arg))
			throw new Error(`Unknown argument: ${arg}`);
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`Missing value: ${arg}`);
		if (arg === "--model") parsed.models = [value];
		if (arg === "--routes") {
			const routes = list(value, arg);
			if (routes.some((route) => !ALL_ROUTING_MODES.some((mode) => mode === route))) throw new Error(`--routes accepts ${ALL_ROUTING_MODES.join(", ")}`);
			// Canonical order, so the schedule does not depend on how the list was typed.
			parsed.routes = ALL_ROUTING_MODES.filter((mode) => routes.includes(mode));
		}
		if (arg === "--suite") {
			const suite = ROUTING_SUITES.find((name) => name === value);
			if (!suite) throw new Error(`--suite accepts ${ROUTING_SUITES.join(", ")}`);
			parsed.suite = suite;
		}
		if (arg === "--trials") parsed.trials = boundedInteger(value, arg, 1, 50);
		if (arg === "--trial-start") parsed.trialStart = boundedInteger(value, arg, 1, 50);
		if (arg === "--seed") parsed.seed = boundedInteger(value, arg, 0, 0xffff_ffff);
		if (arg === "--max-requests") parsed.limits.requests = boundedInteger(value, arg, 1, 10_000);
		if (arg === "--max-tokens") parsed.limits.reportedTokens = boundedInteger(value, arg, 1, 20_000_000);
		if (arg === "--minutes") parsed.limits.timeoutMs = boundedInteger(value, arg, 1, 60) * 60_000;
		if (arg === "--out") { parsed.out = resolve(value); parsed.saveReport = true; }
		if (arg === "--task") parsed.tasks = list(value, arg);
		if (arg === "--baseline") parsed.baselines.push(resolve(value));
		if (arg === "--report") {
			if (selectedMode && parsed.mode !== "report") throw new Error("Choose one execution mode");
			selectedMode = true;
			parsed.mode = "report";
			parsed.reports.push(resolve(value));
		}
	}
	if (parsed.trialStart + parsed.trials - 1 > 50) throw new Error("Last trial must not exceed 50");
	if (parsed.models.some((model) => !BENCHMARK_MODELS.includes(model))) throw new Error(`--model accepts ${BENCHMARK_MODELS.join(" or ")}`);
	if (parsed.tasks.length && seen.has("--suite")) throw new Error("Choose --suite or --task");
	if (selectRoutingFixtures(parsed).length !== (parsed.tasks.length || createRoutingSuite(parsed.suite).length)) throw new Error("Unknown fixture");
	// Self-test replays reference scripts through run_code, which the direct route does not have.
	if (parsed.mode === "self-test" && parsed.routes.includes("direct")) throw new Error("Self-test cannot use the direct route");
	if (parsed.baselines.length && parsed.mode !== "report") throw new Error("--baseline needs --report");
	if ((parsed.mode === "report" || parsed.mode === "help") && [...seen].some((flag) => !["--report", "--baseline", "--out", "--help"].includes(flag)))
		throw new Error("Report/help mode does not accept run options");
	return parsed;
}

function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

/** Seeded order only, not seeded model inference. Every n! trials contain each permutation of n routes once. */
export function routingOrder(trial: number, fixture: string, seed: number, routes: readonly RoutingMode[] = ROUTING_MODES): RoutingMode[] {
	const ranked = permutations(routes).map((order, index) => ({
		order, rank: createHash("sha256").update(`${seed}:${fixture}:${index}`).digest("hex"),
	})).sort((left, right) => left.rank.localeCompare(right.rank));
	return [...ranked[(trial - 1) % ranked.length].order];
}

/** Vary task position so an interrupted batch does not systematically omit the same tail. */
export function routingFixtureOrder(ids: readonly string[], trial: number, seed: number): string[] {
	return ids.map((id) => ({ id, rank: createHash("sha256").update(`task:${seed}:${trial}:${id}`).digest("hex") }))
		.sort((left, right) => left.rank.localeCompare(right.rank)).map(({ id }) => id);
}

/** Reads a snapshot only. No refresh, credential writes, env-key fallback, or login. */
export function subscriptionKey(auth: Pick<AuthStorage, "get">, provider: string): string {
	const credential = auth.get(provider);
	if (credential?.type !== "oauth") throw new Error("auth-unavailable");
	if (!Number.isFinite(credential.expires) || credential.expires <= Date.now()) throw new Error("auth-expired");
	const implementation = provider === "openai-codex" ? openaiCodexOAuthProvider : provider === "anthropic" ? anthropicOAuthProvider : undefined;
	if (!implementation) throw new Error("auth-unavailable");
	const key = implementation.getApiKey(credential);
	if (!key) throw new Error("auth-unavailable");
	return key;
}

/** A new private artifact directory outside the repository; never overwrite an earlier run. */
export async function createRoutingOutput(out: string, repoRoot = REPO_ROOT): Promise<string> {
	const canonical = join(await realpath(dirname(resolve(out))), basename(resolve(out)));
	const inside = relative(await realpath(repoRoot), canonical);
	if (inside === "" || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`)))
		throw new Error("Artifacts must be outside the repository");
	await mkdir(canonical, { mode: 0o700 });
	return canonical;
}

async function loadRoutingReport(path: string): Promise<RoutingRun> {
	const file = (await stat(path)).isDirectory() ? join(path, "results.json") : path;
	if ((await stat(file)).size > MAX_REPORT_BYTES) throw new Error("Report exceeds 128 MiB");
	return parseRoutingRun(JSON.parse(await readFile(file, "utf8")));
}

export async function runRoutingCli(
	args: RoutingArgs,
	executeCase: typeof runRoutingCase = runRoutingCase,
): Promise<{ out?: string; failed: boolean }> {
	if (args.mode === "help") { console.log(ROUTING_HELP); return { failed: false }; }
	if (args.mode === "report") {
		const reports: RoutingRun[] = [];
		for (const path of args.reports) reports.push(await loadRoutingReport(path));
		const baselines: RoutingRun[] = [];
		for (const path of args.baselines) baselines.push(await loadRoutingReport(path));
		const text = baselines.length ? compareRoutingRuns(baselines, reports) : summarizeRoutingRuns(reports);
		console.log(text);
		if (!args.saveReport) return { failed: false };
		const out = await createRoutingOutput(args.out);
		await writeFile(join(out, "report.md"), text, { flag: "wx", mode: 0o600 });
		return { out, failed: false };
	}
	if (getModels !== getSourceModels) throw new Error("Use scripts/run-code-routing.mjs to resolve workspace source");
	const fixtures = selectRoutingFixtures(args);
	const models = args.models.map((name): Model<Api> => {
		const catalog: Model<Api>[] = name.startsWith("anthropic/") ? getModels("anthropic") : getModels("openai-codex");
		const model = catalog.find((item) => item.id === name.slice(name.indexOf("/") + 1));
		if (!model) throw new Error("A requested subscription model is absent from the catalog");
		return model;
	});
	const planned = fixtures.length * args.routes.length * args.trials;
	if (args.mode === "dry-run") {
		console.log(JSON.stringify({ mode: args.mode, runtime: "source", models: args.models, thinking: "xhigh", seed: args.seed, routes: args.routes,
			tasks: fixtures.map((f) => f.id), plannedCases: planned, limits: { run: args.limits, case: CASE_LIMITS },
			worstCaseRequests: planned * CASE_LIMITS.requests, networkRequests: 0,
			orderByTrial: Array.from({ length: args.trials }, (_, index) => ({ trial: index + args.trialStart,
				tasks: routingFixtureOrder(fixtures.map((fixture) => fixture.id), index + args.trialStart, args.seed)
					.map((id) => ({ fixture: id, modes: routingOrder(index + args.trialStart, id, args.seed, args.routes) })),
			})),
		}, null, 2));
		return { failed: false };
	}
	const auth = args.mode === "live" ? AuthStorage.create() : undefined;
	if (auth) for (const model of models) subscriptionKey(auth, model.provider);
	if (!args.saveReport) await mkdir(dirname(args.out), { recursive: true });
	const out = await createRoutingOutput(args.out);
	const cases: RoutingObservation[] = [];
	const sourceHashes: Record<string, string> = {};
	for (const path of [
		"packages/coding-agent/benchmarks/code-mode-routing.ts", "packages/coding-agent/benchmarks/code-mode-routing-cli.ts",
		"packages/coding-agent/benchmarks/code-mode-fixtures.ts", "packages/coding-agent/benchmarks/code-mode-routing-report.ts", "scripts/run-code-routing.mjs",
		"packages/coding-agent/benchmarks/code-mode-fixture-utils.ts", "packages/coding-agent/benchmarks/code-mode-fixtures-data.ts",
		"packages/coding-agent/benchmarks/code-mode-fixtures-workflows.ts", "packages/coding-agent/benchmarks/code-mode-fixtures-realistic.ts",
		"packages/coding-agent/src/core/tools/run-code.ts", "packages/coding-agent/src/core/code-mode/dispatch.ts",
		"packages/coding-agent/src/core/code-mode/runtime.ts", "packages/coding-agent/src/core/code-mode/limits.ts",
		"packages/coding-agent/src/core/mcp/gateway-tool.ts", "packages/coding-agent/src/core/session/tool-runtime.ts", "package-lock.json",
	]) sourceHashes[path] = createHash("sha256").update(await readFile(join(REPO_ROOT, path))).digest("hex");
	const fixtureMetadata = fixtures.map(({ id, prompt, tools, expected }) => ({ id, prompt, tools, expected }));
	const experimentId = createHash("sha256").update(JSON.stringify({ sourceHashes, models, thinking: "xhigh", caseLimits: CASE_LIMITS, fixtures: fixtureMetadata })).digest("hex");
	const manifest = {
		format: 2 as const, runId: randomUUID(), experimentId,
		kind: "code-mode-routing-benchmark", startedAt: new Date().toISOString(), mode: args.mode, models,
		thinking: "xhigh" as const, trials: args.trials, trialStart: args.trialStart, seed: args.seed, routes: args.routes, plannedCases: planned,
		gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
		gitDirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
		sourceHashes, limits: { run: args.limits, case: CASE_LIMITS }, fixtures: fixtureMetadata,
	};
	await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
	const client = createAiClient({ providers: builtInProviders() });
	const controller = new AbortController();
	const cancel = () => controller.abort();
	const timer = setTimeout(cancel, args.limits.timeoutMs);
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	let requests = 0;
	let reportedTokens = 0;
	let failed = false;
	let stopReason: string | undefined;
	try {
		outer: for (let trial = args.trialStart; trial < args.trialStart + args.trials; trial++) {
			for (const fixtureId of routingFixtureOrder(fixtures.map((fixture) => fixture.id), trial, args.seed)) {
				for (const [order, mode] of routingOrder(trial, fixtureId, args.seed, args.routes).entries()) {
					if (controller.signal.aborted) { stopReason = "cancelled-or-deadline"; break outer; }
					if (requests >= args.limits.requests || reportedTokens >= args.limits.reportedTokens) { stopReason = "run-budget"; break outer; }
					const fixture = selectRoutingFixtures(args).find((item) => item.id === fixtureId)!;
					const faux = createFauxProvider();
					const model = args.mode === "self-test" ? faux.getModel() : models[0];
					faux.setResponses([
						fauxAssistantMessage([fauxToolCall("run_code", { code: fixture.referenceCode })], { stopReason: "toolUse" }),
						(context) => {
							const result = context.messages.findLast((message) => message.role === "toolResult");
							const text = result?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
							const marker = "Return value: ";
							return fauxAssistantMessage(text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length).trim() : "{}");
						},
					]);
					console.log(`${cases.length + 1}/${planned} ${model.provider}/${model.id} ${fixture.id} ${mode} trial ${trial}`);
					const result = await executeCase(fixture, mode, {
						model, streamFn: args.mode === "self-test" ? faux.streamSimple : client.streamSimple,
						...(auth ? { getApiKey: () => subscriptionKey(auth, model.provider) } : {}), signal: controller.signal,
						admitRequest: () => {
							if (requests >= args.limits.requests || reportedTokens >= args.limits.reportedTokens) throw new Error("run-budget");
							requests++;
						},
						observeUsage: (usage) => { reportedTokens += usage.totalTokens; },
					});
					const observation = { ...result, trial, order };
					cases.push(observation);
					await writeFile(join(out, `${String(cases.length).padStart(3, "0")}-${fixture.id}-${mode}.json`), JSON.stringify(observation, null, 2), { flag: "wx", mode: 0o600 });
					console.log(`  ${result.correct ? "correct" : "FAILED"}; ${result.requests.length} requests; ${(result.elapsedMs / 1000).toFixed(1)}s; budget ${requests}/${args.limits.requests} requests, ${reportedTokens}/${args.limits.reportedTokens} reported tokens${result.failure ? `; ${result.failure}` : ""}`);
					if (!result.correct) failed = true;
					// Terminate this worker before another case if provider work might still be running. A case that ran out of
					// requests or output finished every request it started, so the next case can go ahead.
					if (result.status === "failed" && result.failure !== "request-limit" && result.failure !== "length") {
						stopReason = result.failure ?? "execution-failed";
						break outer;
					}
				}
			}
		}
	} catch {
		failed = true;
		stopReason = "orchestration-failed";
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
		failed ||= cases.length !== planned;
		const report = { ...manifest, status: failed ? "failed-or-incomplete" as const : "completed" as const,
			...(stopReason ? { stopReason } : {}), requests, reportedTokens, cases };
		await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
		await writeFile(join(out, "report.md"), summarizeRoutingRuns([report]), { flag: "wx", mode: 0o600 });
		console.log(`Artifacts: ${out}`);
	}
	return { out, failed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	Promise.resolve().then(() => parseRoutingArgs(process.argv.slice(2))).then((args) => runRoutingCli(args)).then(
		(result) => { process.exitCode = result.failed ? 1 : 0; },
		(error) => {
			const message = error instanceof Error && ["auth-unavailable", "auth-expired"].includes(error.message) ? error.message : "setup/report validation failed; check arguments with --help (raw diagnostic omitted)";
			console.error(`Routing benchmark: ${message}`);
			process.exitCode = 1;
		},
	).finally(async () => {
		await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((done) => stream.write("", () => done()))));
		process.send?.({ type: "pilot-finished", exitCode: Number(process.exitCode ?? 0) });
	});
}
