/**
 * Terminal-Bench Harbor integration for Volt.
 *
 * Provides /tbench helpers and ships the Harbor agent wrapper in
 * volt_tbench_harbor/agent.py.
 *
 * Settings (`/extensions`, or `extensions.terminal-bench-harbor.settings` in
 * settings.json) hold the defaults /tbench runs with: the model, the task
 * limit (-l), and the concurrent trials (-n).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "@hansjm10/volt-coding-agent";

const DATASET = "terminal-bench/terminal-bench-2-1";
const AGENT_IMPORT_PATH = "volt_tbench_harbor.agent:VoltAgent";
const DEFAULT_MODEL = "openai-codex/gpt-5.5";

/** The settings the manifest declares (package.json `volt.settings`), with their defaults applied. */
type TbenchSettings = {
	readonly model?: string;
	readonly taskLimit: number;
	readonly concurrentTrials: number;
};
type TbenchApi = ExtensionAPI<TbenchSettings>;

type CheckStatus = "ok" | "missing" | "error";
type RunOptionName = "taskLimit" | "concurrentTrials";

interface CheckResult {
	name: string;
	command: string;
	status: CheckStatus;
	detail: string;
}

interface ModelIdentity {
	provider: string;
	id: string;
}

interface ParsedRunArgs {
	model: string | undefined;
	taskLimit: string | undefined;
	concurrentTrials: string | undefined;
	extraArgs: string[];
}

interface RunConfig {
	model: string;
	taskLimit: string;
	concurrentTrials: string;
	extraArgs: string[];
}

function getPackageRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** A PowerShell single-quoted string: PowerShell also reads the typographic quotes U+2018 to U+201B as single quotes. */
function quotePowerShell(value: string): string {
	return `'${value.replace(/['\u2018-\u201B]/g, "$&$&")}'`;
}

function quotePosix(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function getJobsDir(projectRoot: string): string {
	return path.resolve(projectRoot, "jobs", "terminal-bench-volt");
}

function getProjectVoltDir(projectRoot: string): string | undefined {
	const projectVoltDir = path.resolve(projectRoot, ".volt");
	return fs.existsSync(projectVoltDir) && fs.statSync(projectVoltDir).isDirectory() ? projectVoltDir : undefined;
}

function getInheritedAgentKwargs(projectRoot: string): string[] {
	const args = [
		"force_auth_json=true",
		"inherit_agent_dir=true",
		"tools=",
		"exclude_tools=",
	];
	const projectVoltDir = getProjectVoltDir(projectRoot);
	if (projectVoltDir) {
		args.push(`project_volt_dir=${projectVoltDir}`);
	}
	return args;
}

function splitArgs(args: string): string[] {
	return args
		.trim()
		.split(/\s+/)
		.filter((part) => part.length > 0);
}

function formatModelName(model: ModelIdentity): string {
	return `${model.provider}/${model.id}`;
}

function unique(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function getDefaultModel(volt: TbenchApi, ctx: ExtensionCommandContext): string {
	return volt.settings.model ?? (ctx.model ? formatModelName(ctx.model) : DEFAULT_MODEL);
}

function getModelOptions(volt: TbenchApi, ctx: ExtensionCommandContext): string[] {
	const availableModels = ctx.modelRegistry
		.getAvailable()
		.map(formatModelName)
		.sort((left, right) => left.localeCompare(right));
	if (availableModels.length === 0) {
		return unique([getDefaultModel(volt, ctx), DEFAULT_MODEL]);
	}
	const preferredModels = unique([getDefaultModel(volt, ctx), DEFAULT_MODEL]).filter((model) =>
		availableModels.includes(model),
	);
	return unique([...preferredModels, ...availableModels]);
}

function getRunOptionName(arg: string): RunOptionName | undefined {
	if (arg === "-l" || arg === "--n-tasks") return "taskLimit";
	if (arg === "-n" || arg === "--n-concurrent") return "concurrentTrials";
	return undefined;
}

function getAssignedRunOption(arg: string): { name: RunOptionName; value: string } | undefined {
	for (const [prefix, name] of [
		["-l=", "taskLimit"],
		["--n-tasks=", "taskLimit"],
		["-n=", "concurrentTrials"],
		["--n-concurrent=", "concurrentTrials"],
	] as const) {
		if (arg.startsWith(prefix)) {
			return { name, value: arg.slice(prefix.length) };
		}
	}
	return undefined;
}

function parseRunArgs(args: string[]): ParsedRunArgs {
	const [firstArg, ...restArgs] = args;
	const model = firstArg && !firstArg.startsWith("-") ? firstArg : undefined;
	const harborArgs = model ? restArgs : args;
	const parsed: ParsedRunArgs = {
		model,
		taskLimit: undefined,
		concurrentTrials: undefined,
		extraArgs: [],
	};

	for (let index = 0; index < harborArgs.length; index++) {
		const arg = harborArgs[index];
		const assigned = getAssignedRunOption(arg);
		if (assigned) {
			parsed[assigned.name] = assigned.value;
			continue;
		}

		const optionName = getRunOptionName(arg);
		if (optionName) {
			const value = harborArgs[index + 1];
			if (value && !value.startsWith("-")) {
				parsed[optionName] = value;
				index++;
			} else {
				parsed.extraArgs.push(arg);
			}
			continue;
		}

		parsed.extraArgs.push(arg);
	}

	return parsed;
}

function validatePositiveInteger(value: string, label: string, ctx: ExtensionCommandContext): string | undefined {
	const normalized = value.trim();
	if (/^[1-9]\d*$/.test(normalized)) return normalized;
	ctx.ui.notify(`${label} must be a positive integer.`, "warning");
	return undefined;
}

/** Ask for the run's model, task limit, and concurrent trials in one form, starting from the settings. */
async function promptRunConfig(volt: TbenchApi, ctx: ExtensionCommandContext): Promise<RunConfig | undefined> {
	const models = getModelOptions(volt, ctx);
	const defaultModel = getDefaultModel(volt, ctx);
	const values = await ctx.ui.form({
		title: "Terminal-Bench run",
		fields: [
			{
				kind: "enum",
				id: "model",
				label: "Model",
				options: models.map((model) => ({ value: model })),
				...(models.includes(defaultModel) ? { value: defaultModel } : {}),
				required: true,
			},
			{
				kind: "integer",
				id: "taskLimit",
				label: "Task limit (-l)",
				min: 1,
				max: 10000,
				value: volt.settings.taskLimit,
				required: true,
			},
			{
				kind: "integer",
				id: "concurrentTrials",
				label: "Concurrent trials (-n)",
				min: 1,
				max: 64,
				value: volt.settings.concurrentTrials,
				required: true,
			},
			{ kind: "boolean", id: "remember", label: "Remember as defaults", value: false },
		],
	});
	if (values === undefined) return undefined;
	const { model, taskLimit, concurrentTrials } = values;
	if (typeof model !== "string" || typeof taskLimit !== "number" || typeof concurrentTrials !== "number") {
		return undefined;
	}
	if (values.remember === true) {
		try {
			await volt.updateSettings({ model, taskLimit, concurrentTrials });
		} catch (error) {
			ctx.ui.notify(`Could not save the defaults: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}
	return { model, taskLimit: String(taskLimit), concurrentTrials: String(concurrentTrials), extraArgs: [] };
}

async function getRunConfig(
	volt: TbenchApi,
	args: string[],
	ctx: ExtensionCommandContext,
): Promise<RunConfig | undefined> {
	if (args.length === 0 && ctx.hasUI) {
		return promptRunConfig(volt, ctx);
	}

	const parsed = parseRunArgs(args);
	const model = (parsed.model ?? getDefaultModel(volt, ctx)).trim();
	if (!model) {
		ctx.ui.notify("Model is required.", "warning");
		return undefined;
	}
	const taskLimit = validatePositiveInteger(parsed.taskLimit ?? String(volt.settings.taskLimit), "-l", ctx);
	if (taskLimit === undefined) return undefined;
	const concurrentTrials = validatePositiveInteger(
		parsed.concurrentTrials ?? String(volt.settings.concurrentTrials),
		"-n",
		ctx,
	);
	if (concurrentTrials === undefined) return undefined;
	return { model, taskLimit, concurrentTrials, extraArgs: parsed.extraArgs };
}

function truncateOutput(text: string, limit = 2400): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n... truncated ...`;
}

function summarizeExec(result: ExecResult): string {
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	const prefix = `exit ${result.code}${result.killed ? " (killed)" : ""}`;
	return output ? `${prefix}\n${truncateOutput(output)}` : prefix;
}

function getHarborArgs(projectRoot: string, model: string, extraArgs: string[] = []): string[] {
	return [
		"run",
		"-d",
		DATASET,
		"--agent-import-path",
		AGENT_IMPORT_PATH,
		"-m",
		model,
		"--jobs-dir",
		getJobsDir(projectRoot),
		...getInheritedAgentKwargs(projectRoot).flatMap((arg) => ["--agent-kwarg", arg]),
		"--yes",
		...extraArgs,
	];
}

function renderCommand(projectRoot: string, model: string, taskLimit: string, concurrentTrials: string): string {
	const packageRoot = getPackageRoot();
	const jobsDir = getJobsDir(projectRoot);
	const inheritedKwargs = getInheritedAgentKwargs(projectRoot);
	const posix = [
		`cd ${quotePosix(packageRoot)} && \\`,
		"harbor run \\",
		`  -d ${DATASET} \\`,
		`  --agent-import-path ${AGENT_IMPORT_PATH} \\`,
		`  -m ${quotePosix(model)} \\`,
		...inheritedKwargs.map((arg) => `  --agent-kwarg ${quotePosix(arg)} \\`),
		"  --agent-kwarg source_ref=main \\",
		`  --jobs-dir ${quotePosix(jobsDir)} \\`,
		`  -l ${quotePosix(taskLimit)} \\`,
		`  -n ${quotePosix(concurrentTrials)} \\`,
		"  --yes",
	].join("\n");
	const powershell = [
		`Push-Location ${quotePowerShell(packageRoot)}`,
		"harbor run `",
		`  -d ${DATASET} \``,
		`  --agent-import-path ${AGENT_IMPORT_PATH} \``,
		`  -m ${quotePowerShell(model)} \``,
		...inheritedKwargs.map((arg) => `  --agent-kwarg ${quotePowerShell(arg)} \``),
		"  --agent-kwarg source_ref=main `",
		`  --jobs-dir ${quotePowerShell(jobsDir)} \``,
		`  -l ${quotePowerShell(taskLimit)} \``,
		`  -n ${quotePowerShell(concurrentTrials)} \``,
		"  --yes",
		"Pop-Location",
	].join("\n");
	return [`PowerShell:\n${powershell}`, `sh:\n${posix}`].join("\n\n");
}

async function checkCommand(volt: TbenchApi, name: string, command: string, args: string[]): Promise<CheckResult> {
	try {
		const result = await volt.exec(command, args, { timeout: 10_000 });
		const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join(" ");
		return {
			name,
			command: [command, ...args].join(" "),
			status: result.code === 0 ? "ok" : "error",
			detail: truncateOutput(output || `exit ${result.code}`, 500),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { name, command: [command, ...args].join(" "), status: "missing", detail: message };
	}
}

function formatChecks(checks: CheckResult[]): string {
	return checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`).join("\n");
}

async function runTbenchCommand(
	volt: TbenchApi,
	ctx: ExtensionCommandContext,
	args: string[],
	timeout: number,
): Promise<void> {
	ctx.ui.setStatus("tbench", [{ text: "tbench: running", token: "accent" }]);
	try {
		const result = await volt.exec("harbor", args, {
			cwd: getPackageRoot(),
			timeout,
			signal: ctx.signal,
		});
		const message = summarizeExec(result);
		ctx.ui.notify(message, result.code === 0 ? "info" : "error");
	} finally {
		ctx.ui.setStatus("tbench", undefined);
	}
}

export default function terminalBenchHarbor(volt: TbenchApi) {
	volt.registerCommand("tbench", {
		description: "Terminal-Bench Harbor helpers for Volt",
		handler: async (rawArgs, ctx) => {
			const [action = "command", ...rest] = splitArgs(rawArgs);
			if (action === "doctor") {
				const checks = await Promise.all([
					checkCommand(volt, "harbor", "harbor", ["--version"]),
					checkCommand(volt, "docker", "docker", ["--version"]),
					checkCommand(volt, "volt", "volt", ["--version"]),
					checkCommand(volt, "node", "node", ["--version"]),
				]);
				ctx.ui.notify(formatChecks(checks), checks.every((check) => check.status === "ok") ? "info" : "warning");
				return;
			}

			if (action === "command") {
				const config = await getRunConfig(volt, rest, ctx);
				if (config === undefined) return;
				ctx.ui.notify(renderCommand(ctx.cwd, config.model, config.taskLimit, config.concurrentTrials), "info");
				return;
			}

			if (action === "adapter") {
				ctx.ui.notify(`Run Harbor from ${getPackageRoot()} with --agent-import-path ${AGENT_IMPORT_PATH}`, "info");
				return;
			}

			if (action === "oracle") {
				await runTbenchCommand(
					volt,
					ctx,
					[
						"run",
						"-d",
						DATASET,
						"-a",
						"oracle",
						"--jobs-dir",
						getJobsDir(ctx.cwd),
						"-l",
						"1",
						"-n",
						"1",
						"--yes",
						...rest,
					],
					3_600_000,
				);
				return;
			}

			if (action === "smoke") {
				const config = await getRunConfig(volt, rest, ctx);
				if (config === undefined) return;
				await runTbenchCommand(
					volt,
					ctx,
					getHarborArgs(ctx.cwd, config.model, [
						"-l",
						config.taskLimit,
						"-n",
						config.concurrentTrials,
						...config.extraArgs,
					]),
					3_600_000,
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /tbench doctor | command [model] [-l tasks] [-n concurrent] | adapter | oracle [harbor args] | smoke [model] [-l tasks] [-n concurrent] [harbor args]",
				"warning",
			);
		},
	});
}
