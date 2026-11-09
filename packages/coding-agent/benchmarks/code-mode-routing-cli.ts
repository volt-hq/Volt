import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Api, builtInProviders, createAiClient, createFauxProvider, fauxAssistantMessage, fauxToolCall,
	getModels, type Model,
} from "@hansjm10/volt-ai";
import { anthropicOAuthProvider, openaiCodexOAuthProvider } from "@hansjm10/volt-ai/oauth";
import { getModels as getSourceModels } from "../../ai/src/models.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createCodeModeFixtures } from "./code-mode-fixtures.ts";
import { CASE_LIMITS, ROUTING_MODES, type RoutingMode, runRoutingCase } from "./code-mode-routing.ts";
import { parseRoutingRun, type RoutingObservation, type RoutingRun, summarizeRoutingRuns } from "./code-mode-routing-report.ts";

export const DEFAULT_MODELS = ["openai-codex/gpt-6-astra"];
export const RUN_LIMITS = { requests: 160, reportedTokens: 500_000, timeoutMs: 30 * 60_000 };
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_REPORT_BYTES = 128 * 1024 * 1024;
export const ROUTING_HELP = `Usage: npm run benchmark:code-mode -- [mode] [options]

Modes (default: --dry-run, no credentials or provider calls):
  --dry-run              Print the exact plan and budgets
  --self-test            Run reference programs with the faux provider
  --live                 Run gpt-6-astra/xhigh through existing Codex OAuth
  --report <path>         Summarize a run directory or results.json; repeat to combine
  --help                 Show this help

Run options:
  --trials <1..50>        Repetitions of every task/route (default: 1)
  --trial-start <1..50>   First trial number, for split batches (default: 1)
  --seed <0..4294967295>  Reproducible ordering seed (default: 1)
  --task <id>            Select one fixture; --dry-run lists all twenty
  --max-requests <n>     Whole-run request cap, 1..10000 (default: 160)
  --max-tokens <n>       Reported-token admission cap, 1..20000000 (default: 500000)
  --minutes <1..60>      Whole-run deadline (default: 30)
  --out <directory>      New artifact directory outside the repository

All six route permutations are balanced over six trials. Each case has independent
limits of 12 requests, 200 tool calls, and five minutes. Budgets never auto-expand.
Report mode makes no provider calls and prints Markdown; --out also saves report.md.
Only matching experiment fingerprints and distinct run IDs can be combined.
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
	task?: string;
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
		out: join(tmpdir(), `volt-code-mode-routing-${randomUUID()}`), saveReport: false, reports: [],
	};
	const seen = new Set<string>();
	let selectedMode = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (seen.has(arg) && arg !== "--report") throw new Error(`Duplicate argument: ${arg}`);
		seen.add(arg);
		if (["--dry-run", "--self-test", "--live", "--help"].includes(arg)) {
			if (selectedMode) throw new Error("Choose one execution mode");
			selectedMode = true;
			parsed.mode = arg.slice(2) as RoutingArgs["mode"];
			continue;
		}
		if (!["--models", "--trials", "--trial-start", "--out", "--task", "--seed", "--max-requests", "--max-tokens", "--minutes", "--report"].includes(arg))
			throw new Error(`Unknown argument: ${arg}`);
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`Missing value: ${arg}`);
		if (arg === "--models") parsed.models = value.split(",");
		if (arg === "--trials") parsed.trials = boundedInteger(value, arg, 1, 50);
		if (arg === "--trial-start") parsed.trialStart = boundedInteger(value, arg, 1, 50);
		if (arg === "--seed") parsed.seed = boundedInteger(value, arg, 0, 0xffff_ffff);
		if (arg === "--max-requests") parsed.limits.requests = boundedInteger(value, arg, 1, 10_000);
		if (arg === "--max-tokens") parsed.limits.reportedTokens = boundedInteger(value, arg, 1, 20_000_000);
		if (arg === "--minutes") parsed.limits.timeoutMs = boundedInteger(value, arg, 1, 60) * 60_000;
		if (arg === "--out") { parsed.out = resolve(value); parsed.saveReport = true; }
		if (arg === "--task") parsed.task = value;
		if (arg === "--report") {
			if (selectedMode && parsed.mode !== "report") throw new Error("Choose one execution mode");
			selectedMode = true;
			parsed.mode = "report";
			parsed.reports.push(resolve(value));
		}
	}
	if (parsed.trialStart + parsed.trials - 1 > 50) throw new Error("Last trial must not exceed 50");
	if (new Set(parsed.models).size !== parsed.models.length || parsed.models.some((model) => !DEFAULT_MODELS.includes(model)))
		throw new Error("This benchmark accepts only openai-codex/gpt-6-astra");
	if (parsed.task && !createCodeModeFixtures().some((fixture) => fixture.id === parsed.task)) throw new Error("Unknown fixture");
	if ((parsed.mode === "report" || parsed.mode === "help") && [...seen].some((flag) => !["--report", "--out", "--help"].includes(flag)))
		throw new Error("Report/help mode does not accept run options");
	return parsed;
}

/** Seeded order only, not seeded model inference. Every six trials contain each permutation once. */
export function routingOrder(trial: number, fixture: string, seed: number): RoutingMode[] {
	const [a, b, c] = ROUTING_MODES;
	const permutations = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
	const ranked = permutations.map((order, index) => ({
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
		const text = summarizeRoutingRuns(reports);
		console.log(text);
		if (!args.saveReport) return { failed: false };
		const out = await createRoutingOutput(args.out);
		await writeFile(join(out, "report.md"), text, { flag: "wx", mode: 0o600 });
		return { out, failed: false };
	}
	if (getModels !== getSourceModels) throw new Error("Use scripts/run-code-routing.mjs to resolve workspace source");
	const fixtures = createCodeModeFixtures().filter((fixture) => !args.task || fixture.id === args.task);
	const models = args.models.map((name): Model<Api> => {
		const model = getModels("openai-codex").find((item) => item.id === name.slice(name.indexOf("/") + 1));
		if (!model) throw new Error("A requested subscription model is absent from the catalog");
		return model;
	});
	const planned = fixtures.length * ROUTING_MODES.length * args.trials;
	if (args.mode === "dry-run") {
		console.log(JSON.stringify({ mode: args.mode, runtime: "source", models: args.models, thinking: "xhigh", seed: args.seed,
			tasks: fixtures.map((f) => f.id), plannedCases: planned, limits: { run: args.limits, case: CASE_LIMITS },
			worstCaseRequests: planned * CASE_LIMITS.requests, networkRequests: 0,
			orderByTrial: Array.from({ length: args.trials }, (_, index) => ({ trial: index + args.trialStart,
				tasks: routingFixtureOrder(fixtures.map((fixture) => fixture.id), index + args.trialStart, args.seed)
					.map((id) => ({ fixture: id, modes: routingOrder(index + args.trialStart, id, args.seed) })),
			})),
		}, null, 2));
		return { failed: false };
	}
	const auth = args.mode === "live" ? AuthStorage.create() : undefined;
	if (auth) for (const model of models) subscriptionKey(auth, model.provider);
	const out = await createRoutingOutput(args.out);
	const cases: RoutingObservation[] = [];
	const sourceHashes: Record<string, string> = {};
	for (const path of [
		"packages/coding-agent/benchmarks/code-mode-routing.ts", "packages/coding-agent/benchmarks/code-mode-routing-cli.ts",
		"packages/coding-agent/benchmarks/code-mode-fixtures.ts", "packages/coding-agent/benchmarks/code-mode-routing-report.ts", "scripts/run-code-routing.mjs",
		"packages/coding-agent/benchmarks/code-mode-fixture-utils.ts", "packages/coding-agent/benchmarks/code-mode-fixtures-data.ts",
		"packages/coding-agent/benchmarks/code-mode-fixtures-workflows.ts",
		"packages/coding-agent/src/core/tools/run-code.ts", "packages/coding-agent/src/core/code-mode/dispatch.ts",
		"packages/coding-agent/src/core/code-mode/runtime.ts", "packages/coding-agent/src/core/code-mode/limits.ts",
		"packages/coding-agent/src/core/mcp/gateway-tool.ts", "packages/coding-agent/src/core/session/tool-runtime.ts", "package-lock.json",
	]) sourceHashes[path] = createHash("sha256").update(await readFile(join(REPO_ROOT, path))).digest("hex");
	const fixtureMetadata = fixtures.map(({ id, prompt, tools, expected }) => ({ id, prompt, tools, expected }));
	const experimentId = createHash("sha256").update(JSON.stringify({ sourceHashes, models, thinking: "xhigh", caseLimits: CASE_LIMITS, fixtures: fixtureMetadata })).digest("hex");
	const manifest = {
		format: 2 as const, runId: randomUUID(), experimentId,
		kind: "code-mode-routing-benchmark", startedAt: new Date().toISOString(), mode: args.mode, models,
		thinking: "xhigh" as const, trials: args.trials, trialStart: args.trialStart, seed: args.seed, plannedCases: planned,
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
				for (const [order, mode] of routingOrder(trial, fixtureId, args.seed).entries()) {
					if (controller.signal.aborted) { stopReason = "cancelled-or-deadline"; break outer; }
					if (requests >= args.limits.requests || reportedTokens >= args.limits.reportedTokens) { stopReason = "run-budget"; break outer; }
					const fixture = createCodeModeFixtures().find((item) => item.id === fixtureId)!;
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
					// Terminate this worker before another case if provider work might still be running.
					if (result.status === "failed") { stopReason = result.failure ?? "execution-failed"; break outer; }
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
