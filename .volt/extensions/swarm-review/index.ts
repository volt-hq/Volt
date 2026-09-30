/**
 * /swarm-review: run the same code review several times with an inexpensive model,
 * then have one stronger model verify, merge, and prioritize the combined claims.
 *
 * Usage:
 *   /swarm-review [--base <ref>] [--workers N] [--concurrency N]
 *                 [--model <ref>] [--thinking <level>]
 *                 [--verifier <ref>] [--verifier-thinking <level>] [focus text...]
 *
 * Without --base it reviews uncommitted changes (working tree and index vs HEAD).
 * With --base it reviews everything since the merge base with <ref>, including uncommitted changes.
 */

import { constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model, ModelThinkingLevel } from "@hansjm10/volt-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	BorderedLoader,
	createAgentSession,
	createExtensionRuntime,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	loadProjectContextFiles,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type Theme,
	type ToolDefinition,
} from "@hansjm10/volt-coding-agent";
import { Container, Text } from "@hansjm10/volt-tui";
import { type Static, type TSchema, Type } from "typebox";
import {
	VERIFIER_REPAIR,
	VERIFIER_SYSTEM_PROMPT,
	VERIFIER_WRAP_UP,
	WORKER_REPAIR,
	WORKER_SYSTEM_PROMPT,
	WORKER_WRAP_UP,
} from "./prompts.ts";

const DEFAULT_WORKER_MODEL = "gpt-6-luna";
const DEFAULT_WORKER_THINKING: ModelThinkingLevel = "max";
const DEFAULT_VERIFIER_MODEL = "claude-opus-5-5";
const DEFAULT_VERIFIER_THINKING: ModelThinkingLevel = "high";
const DEFAULT_WORKERS = 10;
const MAX_WORKERS = 32;
const MAX_DIFF_CHARS = 200_000;
const MAX_UNTRACKED_LISTED = 500;
const MAX_OMITTED_LISTED = 50;
const MAX_FINDINGS_PER_WORKER = 12;
const GROUP_LINE_TOLERANCE = 3;
const WORKER_TURNS = { wrapUp: 40, max: 60 };
const VERIFIER_TURNS = { wrapUp: 80, max: 120 };
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const WIDGET_KEY = "swarm-review";
const USAGE =
	"Usage: /swarm-review [--base <ref>] [--workers N] [--concurrency N] [--model <ref>] [--thinking <level>] [--verifier <ref>] [--verifier-thinking <level>] [focus...]";

// ---------------------------------------------------------------------------
// Types

interface SwarmOptions {
	base?: string;
	workers: number;
	concurrency: number;
	model?: string;
	thinking: ModelThinkingLevel;
	verifier?: string;
	verifierThinking: ModelThinkingLevel;
	focus?: string;
}

interface ReviewTarget {
	root: string;
	/** Revision the diff is taken against; review policies are read from it. */
	base: string;
	description: string;
	diff: string;
	/** Files whose diff sections were cut from the prompt; empty when the full diff fits. */
	omittedFiles: string[];
	stat: string;
	untracked: string[];
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const FINDING_SCHEMA = Type.Object({
	title: Type.String({ description: "One-line summary of the defect" }),
	file: Type.String({ description: "Repository-relative path of the defect location" }),
	line: Type.Integer({ minimum: 1, description: "Start line in the current working tree" }),
	endLine: Type.Optional(Type.Integer({ minimum: 1, description: "End line in the current working tree" })),
	priority: Type.Integer({ minimum: 0, maximum: 2, description: "0 blocker, 1 urgent, 2 real bounded defect" }),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	trigger: Type.String({ description: "Concrete scenario or input that triggers the defect" }),
	impact: Type.String({ description: "What goes wrong for users or callers" }),
	evidence: Type.String({ description: "Code facts you verified that establish the defect" }),
});

const VERIFICATION_SCHEMA = Type.Object({
	findings: Type.Array(
		Type.Object({
			groups: Type.Array(Type.String(), {
				description:
					"Candidate group IDs this finding confirms. Empty only for a new P0/P1 defect you found yourself.",
			}),
			title: Type.String({ description: "One-line summary of the verified defect" }),
			file: Type.String({ description: "Repository-relative path of an existing file in the current working tree" }),
			line: Type.Integer({ minimum: 1 }),
			endLine: Type.Optional(Type.Integer({ minimum: 1 })),
			priority: Type.Integer({
				minimum: 0,
				maximum: 3,
				description: "0 blocker, 1 urgent, 2 real bounded defect, 3 optional improvement",
			}),
			explanation: Type.String({ description: "The code facts you verified, the trigger, and the impact" }),
			fix: Type.Optional(Type.String({ description: "Concise suggested fix" })),
		}),
	),
	uncertain: Type.Array(
		Type.Object({
			group: Type.String(),
			reason: Type.String({ description: "What cannot be verified statically and the check that would settle it" }),
		}),
	),
	rejected: Type.Array(Type.Object({ group: Type.String(), reason: Type.String() })),
});

type Finding = Static<typeof FINDING_SCHEMA>;
type Verification = Static<typeof VERIFICATION_SCHEMA>;

interface Candidate extends Finding {
	worker: number;
}

interface CandidateGroup {
	id: string;
	file: string;
	start: number;
	end: number;
	candidates: Candidate[];
}

type PassStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "skipped";

interface PassState {
	status: PassStatus;
	toolCalls: number;
	turns: number;
	error?: string;
	usage: UsageTotals;
}

interface WorkerState extends PassState {
	index: number;
	findings: Candidate[];
	dropped: number;
}

interface SwarmState {
	workers: WorkerState[];
	verifier: PassState;
	groups: CandidateGroup[];
	cancelling: boolean;
}

interface SwarmSetup {
	target: ReviewTarget;
	options: SwarmOptions;
	workerModel: Model<Api>;
	verifierModel: Model<Api>;
	settingsManager: SettingsManager;
	modelRegistry: ExtensionCommandContext["modelRegistry"];
	contextFiles: Array<{ path: string; content: string }>;
	signal: AbortSignal;
	onProgress: () => void;
}

type SwarmResult =
	| { status: "cancelled" }
	| { status: "failed"; error: string }
	| { status: "completed"; verification?: Verification; verificationError?: string };

class SwarmCancelled extends Error {
	constructor() {
		super("Swarm review cancelled");
	}
}

// ---------------------------------------------------------------------------
// Arguments and models

/** Throws with a user-facing message on invalid input. */
function parseArgs(input: string): SwarmOptions {
	const tokens = (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
		/^(["']).*\1$/.test(token) ? token.slice(1, -1) : token,
	);
	const values = new Map<string, string>();
	const focus: string[] = [];
	const flags = new Set(["base", "workers", "concurrency", "model", "thinking", "verifier", "verifier-thinking"]);
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token.startsWith("--")) {
			focus.push(token);
			continue;
		}
		const equals = token.indexOf("=");
		const name = token.slice(2, equals === -1 ? undefined : equals);
		if (!flags.has(name)) throw new Error(`Unknown option --${name}. ${USAGE}`);
		const value = equals === -1 ? tokens[++index] : token.slice(equals + 1);
		if (!value) throw new Error(`--${name} needs a value. ${USAGE}`);
		values.set(name, value);
	}

	const count = (name: string, fallback: number): number => {
		const raw = values.get(name);
		if (raw === undefined) return fallback;
		const value = Number(raw);
		if (!Number.isInteger(value) || value < 1 || value > MAX_WORKERS) {
			throw new Error(`--${name} must be an integer from 1 to ${MAX_WORKERS}.`);
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

	const base = values.get("base");
	if (base?.startsWith("-")) throw new Error("--base must be a Git revision.");
	const model = values.get("model");
	const verifier = values.get("verifier");
	const workers = count("workers", DEFAULT_WORKERS);
	return {
		...(base ? { base } : {}),
		workers,
		concurrency: count("concurrency", workers),
		...(model ? { model } : {}),
		thinking: thinking("thinking", DEFAULT_WORKER_THINKING),
		...(verifier ? { verifier } : {}),
		verifierThinking: thinking("verifier-thinking", DEFAULT_VERIFIER_THINKING),
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

function modelRef(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

// ---------------------------------------------------------------------------
// Git target

async function collectTarget(
	volt: ExtensionAPI,
	cwd: string,
	base: string | undefined,
	signal: AbortSignal,
): Promise<ReviewTarget | string> {
	// execCommand reports a process killed by the abort signal with code 0, so partial output must not pass as success.
	const run = async (args: string[], dir: string) => {
		const result = await volt.exec("git", args, { cwd: dir, signal });
		if (result.killed || signal.aborted) throw new SwarmCancelled();
		return result;
	};
	const top = await run(["rev-parse", "--show-toplevel"], cwd);
	if (top.code !== 0) return "Swarm review needs a Git repository.";
	const root = top.stdout.trim();
	const git = (args: string[]) => run(["-c", "core.quotepath=off", ...args], root);

	if ((await git(["rev-parse", "--verify", "--quiet", "HEAD"])).code !== 0) {
		return "Swarm review needs at least one commit.";
	}
	let from = "HEAD";
	let description = "uncommitted changes";
	if (base) {
		const mergeBase = await git(["merge-base", base, "HEAD"]);
		if (mergeBase.code !== 0) return `Could not find a merge base between ${base} and HEAD.`;
		from = mergeBase.stdout.trim();
		description = `changes since ${base} (merge base ${from.slice(0, 10)}), including uncommitted changes`;
	}

	const [diff, stat, untracked] = await Promise.all([
		git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", from, "--"]),
		git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--stat=160", from, "--"]),
		git(["ls-files", "--others", "--exclude-standard"]),
	]);
	const failed = [diff, stat, untracked].find((result) => result.code !== 0);
	if (failed) return `git failed: ${failed.stderr.trim() || `exit code ${failed.code}`}`;

	const untrackedFiles = untracked.stdout.split("\n").filter(Boolean);
	if (!diff.stdout.trim() && untrackedFiles.length === 0) return `No ${description} to review.`;

	const cut =
		diff.stdout.length > MAX_DIFF_CHARS ? diff.stdout.lastIndexOf("\n", MAX_DIFF_CHARS) + 1 : diff.stdout.length;
	return {
		root,
		base: from,
		description,
		diff: diff.stdout.slice(0, cut),
		omittedFiles: omittedDiffFiles(diff.stdout, cut),
		stat: stat.stdout.trimEnd(),
		untracked: untrackedFiles,
	};
}

/** Files whose `diff --git` sections are not entirely before `cut`. */
function omittedDiffFiles(diff: string, cut: number): string[] {
	const headers = [...diff.matchAll(/^diff --git a\/.* b\/(.*)$/gm)];
	return headers
		.filter((_, index) => (headers[index + 1]?.index ?? diff.length) > cut)
		.map((header) => header[1] ?? "");
}

function insideRoot(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Throws unless the path, with symlinks resolved when it exists, stays inside the repository under review. */
function assertInsideRoot(root: string, absolutePath: string): void {
	let target = absolutePath;
	try {
		target = realpathSync(absolutePath);
	} catch {
		// Nonexistent paths are checked lexically; the tool reports them as missing.
	}
	if (!insideRoot(root, target)) {
		throw new Error(`Access outside the repository under review is not allowed: ${absolutePath}`);
	}
}

const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/**
 * Global and above-repository context files come from disk. In-repository AGENTS/CLAUDE/REVIEW files come from
 * the base revision, as in the built-in /review, so the change under review cannot rewrite its own instructions.
 */
async function loadContextFiles(
	volt: ExtensionAPI,
	target: ReviewTarget,
	cwd: string,
	signal: AbortSignal,
): Promise<Array<{ path: string; content: string }>> {
	const resolvedCwd = realpathSync(cwd);
	const files = loadProjectContextFiles({ cwd: resolvedCwd, agentDir: getAgentDir() }).filter(
		(file) => !insideRoot(target.root, file.path),
	);
	const userReviewPolicy = join(getAgentDir(), "REVIEW.md");
	if (existsSync(userReviewPolicy)) {
		files.push({ path: userReviewPolicy, content: readFileSync(userReviewPolicy, "utf8") });
	}
	const readBase = async (path: string): Promise<string | undefined> => {
		const result = await volt.exec("git", ["cat-file", "blob", `${target.base}:${path}`], {
			cwd: target.root,
			signal,
		});
		if (result.killed || signal.aborted) throw new SwarmCancelled();
		return result.code === 0 ? result.stdout : undefined;
	};
	const relativeCwd = relative(target.root, resolvedCwd);
	const segments = insideRoot(target.root, resolvedCwd) ? relativeCwd.split(sep).filter(Boolean) : [];
	const directories = ["", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
	const revision = target.base.slice(0, 10);
	for (const directory of directories) {
		for (const name of CONTEXT_FILE_NAMES) {
			const path = directory ? `${directory}/${name}` : name;
			const content = await readBase(path);
			if (content !== undefined) {
				files.push({ path: `${revision}:${path}`, content });
				break;
			}
		}
		const reviewPath = directory ? `${directory}/REVIEW.md` : "REVIEW.md";
		const review = await readBase(reviewPath);
		if (review !== undefined) files.push({ path: `${revision}:${reviewPath}`, content: review });
	}
	return files;
}

// ---------------------------------------------------------------------------
// Prompts

function codeFence(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	return "`".repeat(Math.max(3, longest + 1));
}

/** Identical for every worker so providers can reuse the cached prompt prefix. */
function changeSection(target: ReviewTarget): string {
	const fence = codeFence(target.diff);
	const lines = [
		`# Change under review`,
		`Target: ${target.description}`,
		"",
		"## Changed files",
		"```",
		target.stat,
		"```",
	];
	if (target.untracked.length > 0) {
		const listed = target.untracked.slice(0, MAX_UNTRACKED_LISTED);
		lines.push(
			"",
			"## New untracked files (not in the diff; read them in full)",
			...listed.map((file) => `- ${file}`),
		);
		if (target.untracked.length > listed.length) {
			lines.push(
				`- ... and ${target.untracked.length - listed.length} more untracked files that are not listed and are not part of this review.`,
			);
		}
	}
	lines.push("", "## Diff");
	if (target.omittedFiles.length > 0) {
		const listed = target.omittedFiles.slice(0, MAX_OMITTED_LISTED);
		const more = target.omittedFiles.length - listed.length;
		lines.push(
			"The diff was truncated to fit the prompt. Changes to these files are missing or incomplete below:",
			...listed.map((file) => `- ${file}`),
			...(more > 0 ? [`- ... and ${more} more`] : []),
			"You can read their current contents, but not their previous versions, their removed lines, or deleted files. Do not assume the missing changes are correct.",
		);
	}
	lines.push(`${fence}diff`, target.diff.trimEnd(), fence);
	return lines.join("\n");
}

function workerPrompt(target: ReviewTarget, focus: string | undefined): string {
	return [
		changeSection(target),
		"",
		"# Task",
		...(focus ? [`User focus: ${focus}`] : []),
		"Review the change, verify with the read-only tools, then call report_findings exactly once.",
	].join("\n");
}

function verifierPrompt(target: ReviewTarget, groups: CandidateGroup[], focus: string | undefined): string {
	const lines = [
		changeSection(target),
		"",
		"# Candidate groups",
		"Candidates from independent reviewers, grouped by file and nearby lines. All are unverified claims.",
	];
	for (const group of groups) {
		lines.push("", `## ${group.id}: ${group.file}:${lineRange(group.start, group.end)}`);
		for (const candidate of group.candidates) {
			lines.push(
				`- ${candidate.title} (line ${lineRange(candidate.line, candidate.endLine ?? candidate.line)})`,
				`  Trigger: ${candidate.trigger}`,
				`  Impact: ${candidate.impact}`,
				`  Evidence: ${candidate.evidence}`,
			);
		}
	}
	lines.push(
		"",
		"# Task",
		...(focus ? [`User focus: ${focus}`] : []),
		`Verify all ${groups.length} candidate groups, then call report_verification exactly once.`,
	);
	return lines.join("\n");
}

function lineRange(start: number, end: number): string {
	return end > start ? `${start}-${end}` : String(start);
}

// ---------------------------------------------------------------------------
// Isolated passes

function isolatedResourceLoader(
	systemPrompt: string,
	agentsFiles: Array<{ path: string; content: string }>,
): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getSubagents: () => ({ definitions: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(target: UsageTotals, value: UsageTotals): void {
	target.input += value.input;
	target.output += value.output;
	target.cacheRead += value.cacheRead;
	target.cacheWrite += value.cacheWrite;
	target.cost += value.cost;
}

function sessionUsage(session: AgentSession): UsageTotals {
	const totals = emptyUsage();
	for (const message of session.messages) {
		if (message.role !== "assistant") continue;
		addUsage(totals, {
			input: message.usage.input,
			output: message.usage.output,
			cacheRead: message.usage.cacheRead,
			cacheWrite: message.usage.cacheWrite,
			cost: message.usage.cost.total,
		});
	}
	return totals;
}

function lastAssistantError(session: AgentSession): string | undefined {
	const last = session.messages.findLast((message) => message.role === "assistant");
	return last?.role === "assistant" && last.stopReason === "error"
		? (last.errorMessage ?? "Model request failed.")
		: undefined;
}

interface PassOptions {
	label: string;
	model: Model<Api>;
	thinking: ModelThinkingLevel;
	systemPrompt: string;
	reportTool: ReturnType<typeof createFindingsTool> | ReturnType<typeof createVerificationTool>;
	hasReport: () => boolean;
	prompt: string;
	wrapUp: string;
	repair: string;
	turns: { wrapUp: number; max: number };
	state: PassState;
	onEvent?: (event: AgentSessionEvent) => void;
}

async function runPass(setup: SwarmSetup, pass: PassOptions): Promise<void> {
	const sessionManager = SessionManager.inMemory(setup.target.root);
	// A named session skips the automatic naming request.
	sessionManager.appendSessionInfo(pass.label);
	const { session } = await createAgentSession({
		cwd: setup.target.root,
		agentDir: getAgentDir(),
		authStorage: setup.modelRegistry.authStorage,
		modelRegistry: setup.modelRegistry,
		settingsManager: setup.settingsManager,
		model: pass.model,
		thinkingLevel: pass.thinking,
		sessionManager,
		resourceLoader: isolatedResourceLoader(pass.systemPrompt, setup.contextFiles),
		customTools: [...createRepositoryTools(setup.target.root), pass.reportTool],
		tools: [...READ_ONLY_TOOLS, pass.reportTool.name],
		disableMcp: true,
	});
	let enforceTurnLimits = true;
	let turnLimitReached = false;
	const unsubscribe = session.subscribe(
		(event) => {
			if (event.type === "tool_execution_start") pass.state.toolCalls++;
			if (event.type === "turn_end" && enforceTurnLimits) {
				pass.state.turns++;
				if (pass.state.turns === pass.turns.wrapUp) void session.steer(pass.wrapUp).catch(() => undefined);
				if (pass.state.turns >= pass.turns.max) {
					turnLimitReached = true;
					void session.abort();
				}
			}
			pass.onEvent?.(event);
			setup.onProgress();
		},
		{ monitorGitContext: false },
	);
	const onAbort = (): void => {
		void session.abort();
	};
	setup.signal.addEventListener("abort", onAbort, { once: true });
	try {
		if (setup.signal.aborted) throw new SwarmCancelled();
		await session.prompt(pass.prompt, { expandPromptTemplates: false });
		if (setup.signal.aborted) throw new SwarmCancelled();
		if (pass.hasReport()) return;
		const failure = lastAssistantError(session);
		if (failure && !turnLimitReached) throw new Error(failure);
		// One repair turn with only the report tool available.
		enforceTurnLimits = false;
		session.setActiveToolsByName([pass.reportTool.name]);
		await session.prompt(pass.repair, { expandPromptTemplates: false });
		if (setup.signal.aborted) throw new SwarmCancelled();
		if (!pass.hasReport()) {
			throw new Error(lastAssistantError(session) ?? `Did not call ${pass.reportTool.name}.`);
		}
	} finally {
		pass.state.usage = sessionUsage(session);
		unsubscribe();
		setup.signal.removeEventListener("abort", onAbort);
		session.dispose();
		await session.waitForClosed();
	}
}

/** Returns the repository-relative path of an existing file inside the root, or undefined. */
function normalizeFile(root: string, raw: string): string | undefined {
	const absolute = resolve(root, raw.trim().replace(/^@/, ""));
	if (absolute === root || !insideRoot(root, absolute) || !existsSync(absolute)) return undefined;
	return relative(root, absolute).split(sep).join("/");
}

function pathArgument(params: unknown): string | undefined {
	return typeof params === "object" && params !== null && "path" in params && typeof params.path === "string"
		? params.path
		: undefined;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Mirrors the built-in tools' resolveToCwd (normalizePath in packages/coding-agent/src/utils/paths.ts):
 * Unicode spaces become ASCII spaces, then `@` is stripped, then `~`, `~/`, `~\` (Windows), and file URLs expand.
 */
function resolveLikeBuiltinTools(root: string, raw: string): string {
	let path = raw.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
		path = join(homedir(), path.slice(2));
	} else if (path.startsWith("file://")) path = fileURLToPath(path);
	return resolve(root, path);
}

/**
 * Rejects `path` arguments that escape the repository with a clear error. Both the raw spelling and the built-in
 * tools' normalized resolution are checked, so neither side of a normalization mismatch can escape.
 */
function confineTool<TParams extends TSchema, TDetails>(tool: ToolDefinition<TParams, TDetails>, root: string) {
	return defineTool({
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const raw = pathArgument(params);
			if (raw) {
				assertInsideRoot(root, resolve(root, raw));
				assertInsideRoot(root, resolveLikeBuiltinTools(root, raw));
			}
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

/**
 * Read-only inspection tools confined to the repository, so a prompt injection in the reviewed change cannot pull
 * host files into findings. read, grep, and ls also check the resolved paths they actually open. find relies on
 * confineTool alone: guarding its resolved path would require replacing the fd backend.
 */
function createRepositoryTools(root: string) {
	const guard = (path: string): string => {
		assertInsideRoot(root, path);
		return path;
	};
	return [
		confineTool(
			createReadToolDefinition(root, {
				operations: {
					access: (path) => access(guard(path), constants.R_OK),
					readFile: (path) => readFile(guard(path)),
				},
			}),
			root,
		),
		confineTool(
			createGrepToolDefinition(root, {
				operations: {
					isDirectory: (path) => statSync(guard(path)).isDirectory(),
					readFile: (path) => readFileSync(guard(path), "utf8"),
				},
			}),
			root,
		),
		confineTool(createFindToolDefinition(root), root),
		confineTool(
			createLsToolDefinition(root, {
				// Only the listed directory is guarded. ls stats each entry just for a "/" suffix and skips entries whose
				// stat fails, so guarding stat would hide in-repository symlink entries without protecting anything.
				operations: {
					exists: (path) => existsSync(guard(path)),
					stat: (path) => statSync(path),
					readdir: (path) => readdirSync(guard(path)),
				},
			}),
			root,
		),
	];
}

function createFindingsTool(worker: WorkerState, root: string, onReport: () => void) {
	return defineTool({
		name: "report_findings",
		label: "Report findings",
		description:
			"Submit your final verified review findings. Call exactly once when your investigation is complete; pass an empty array when you found no defects.",
		parameters: Type.Object({
			findings: Type.Array(FINDING_SCHEMA, { maxItems: MAX_FINDINGS_PER_WORKER }),
		}),
		async execute(_toolCallId, params) {
			worker.findings = [];
			worker.dropped = 0;
			for (const finding of params.findings) {
				const file = normalizeFile(root, finding.file);
				if (file) worker.findings.push({ ...finding, file, worker: worker.index });
				else worker.dropped++;
			}
			onReport();
			return {
				content: [{ type: "text", text: `Recorded ${worker.findings.length} finding(s).` }],
				details: { recorded: worker.findings.length, dropped: worker.dropped },
				disposition: "stop",
			};
		},
	});
}

function createVerificationTool(
	root: string,
	groups: CandidateGroup[],
	onReport: (verification: Verification) => void,
) {
	const known = new Set(groups.map((group) => group.id));
	return defineTool({
		name: "report_verification",
		label: "Report verification",
		description:
			"Submit verified findings, uncertain groups, and rejected groups. Every candidate group must be referenced by a finding or listed once as uncertain or rejected.",
		parameters: VERIFICATION_SCHEMA,
		async execute(_toolCallId, params) {
			const errors: string[] = [];
			const confirmed = new Set<string>();
			const findings: Verification["findings"] = [];
			for (const finding of params.findings) {
				const file = normalizeFile(root, finding.file);
				if (file) findings.push({ ...finding, file });
				else {
					errors.push(
						`Finding "${finding.title}" is anchored to ${finding.file}, which is not an existing file in the repository.`,
					);
				}
				for (const id of finding.groups) {
					if (known.has(id)) confirmed.add(id);
					else errors.push(`Finding "${finding.title}" references unknown group ${id}.`);
				}
				if (finding.groups.length === 0 && finding.priority > 1) {
					errors.push(`Finding "${finding.title}" has no group IDs; only new P0/P1 defects may omit them.`);
				}
			}
			const settled = new Set<string>();
			for (const entry of [...params.uncertain, ...params.rejected]) {
				if (!known.has(entry.group)) errors.push(`Unknown group ${entry.group}.`);
				else if (confirmed.has(entry.group))
					errors.push(`${entry.group} is both confirmed and uncertain/rejected.`);
				else if (settled.has(entry.group)) errors.push(`${entry.group} is listed more than once.`);
				settled.add(entry.group);
			}
			const missing = [...known].filter((id) => !confirmed.has(id) && !settled.has(id));
			if (missing.length > 0) errors.push(`Missing groups: ${missing.join(", ")}.`);
			if (errors.length > 0) {
				return {
					content: [
						{ type: "text", text: `Verification report rejected. Fix and resubmit:\n- ${errors.join("\n- ")}` },
					],
					details: { accepted: false },
					isError: true,
				};
			}
			onReport({ ...params, findings });
			return {
				content: [{ type: "text", text: "Verification recorded." }],
				details: { accepted: true },
				disposition: "stop",
			};
		},
	});
}

// ---------------------------------------------------------------------------
// Orchestration

function groupCandidates(candidates: Candidate[]): CandidateGroup[] {
	const byFile = new Map<string, Candidate[]>();
	for (const candidate of candidates) {
		const list = byFile.get(candidate.file) ?? [];
		list.push(candidate);
		byFile.set(candidate.file, list);
	}
	const groups: CandidateGroup[] = [];
	for (const [file, list] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
		let current: CandidateGroup | undefined;
		for (const candidate of list.sort((a, b) => a.line - b.line)) {
			const end = Math.max(candidate.line, candidate.endLine ?? candidate.line);
			if (current && candidate.line <= current.end + GROUP_LINE_TOLERANCE) {
				current.candidates.push(candidate);
				current.end = Math.max(current.end, end);
			} else {
				current = { id: "", file, start: candidate.line, end, candidates: [candidate] };
				groups.push(current);
			}
		}
	}
	groups.forEach((group, index) => {
		group.id = `G${index + 1}`;
	});
	return groups;
}

async function runPool(count: number, concurrency: number, task: (index: number) => Promise<void>): Promise<void> {
	let next = 0;
	const lanes = Array.from({ length: Math.min(count, concurrency) }, async () => {
		while (next < count) await task(next++);
	});
	await Promise.all(lanes);
}

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
}

async function runSwarm(setup: SwarmSetup, state: SwarmState): Promise<SwarmResult> {
	const { options, target, signal } = setup;
	// Every worker sends the same prompt. Start one first and release the rest once it is streaming,
	// so they can reuse its cached prompt instead of all writing the cache at once.
	let releaseWarmup = (): void => {};
	const warmup = new Promise<void>((resolve) => {
		releaseWarmup = resolve;
	});

	await runPool(options.workers, options.concurrency, async (index) => {
		const worker = state.workers[index];
		let reported = false;
		// Every exit path of worker 1 must release the others, including an abort before it starts.
		try {
			if (index > 0) await warmup;
			if (signal.aborted) {
				worker.status = "cancelled";
				return;
			}
			worker.status = "running";
			setup.onProgress();
			await runPass(setup, {
				label: `Swarm review worker ${index + 1}`,
				model: setup.workerModel,
				thinking: options.thinking,
				systemPrompt: WORKER_SYSTEM_PROMPT,
				reportTool: createFindingsTool(worker, target.root, () => {
					reported = true;
				}),
				hasReport: () => reported,
				prompt: workerPrompt(target, options.focus),
				wrapUp: WORKER_WRAP_UP,
				repair: WORKER_REPAIR,
				turns: WORKER_TURNS,
				state: worker,
				onEvent: (event) => {
					if (index === 0 && event.type === "message_start" && event.message.role === "assistant") releaseWarmup();
				},
			});
			worker.status = "done";
		} catch (error) {
			worker.status = signal.aborted ? "cancelled" : "failed";
			if (!signal.aborted) worker.error = errorText(error);
		} finally {
			if (index === 0) releaseWarmup();
			setup.onProgress();
		}
	});

	if (signal.aborted) return { status: "cancelled" };
	if (!state.workers.some((worker) => worker.status === "done")) {
		return { status: "failed", error: `All workers failed. First error: ${state.workers[0]?.error ?? "unknown"}` };
	}

	state.groups = groupCandidates(state.workers.flatMap((worker) => worker.findings));
	if (state.groups.length === 0) {
		state.verifier.status = "skipped";
		setup.onProgress();
		return { status: "completed" };
	}

	state.verifier.status = "running";
	setup.onProgress();
	let verification: Verification | undefined;
	try {
		await runPass(setup, {
			label: "Swarm review verifier",
			model: setup.verifierModel,
			thinking: options.verifierThinking,
			systemPrompt: VERIFIER_SYSTEM_PROMPT,
			reportTool: createVerificationTool(target.root, state.groups, (value) => {
				verification = value;
			}),
			hasReport: () => verification !== undefined,
			prompt: verifierPrompt(target, state.groups, options.focus),
			wrapUp: VERIFIER_WRAP_UP,
			repair: VERIFIER_REPAIR,
			turns: VERIFIER_TURNS,
			state: state.verifier,
		});
		state.verifier.status = "done";
	} catch (error) {
		if (signal.aborted) {
			state.verifier.status = "cancelled";
			return { status: "cancelled" };
		}
		state.verifier.status = "failed";
		state.verifier.error = errorText(error);
	} finally {
		setup.onProgress();
	}
	return verification
		? { status: "completed", verification }
		: { status: "completed", verificationError: state.verifier.error ?? "Verifier did not report." };
}

// ---------------------------------------------------------------------------
// Presentation

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

function formatCost(value: number): string {
	return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function usageText(usage: UsageTotals): string {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const cached = prompt > 0 ? `, ${Math.round((usage.cacheRead / prompt) * 100)}% cached` : "";
	return `${formatCost(usage.cost)} (${formatTokens(prompt)} in${cached}, ${formatTokens(usage.output)} out)`;
}

function phaseText(state: SwarmState): string {
	if (state.cancelling) return "Cancelling swarm review...";
	if (state.verifier.status === "running") {
		return `Verifying ${state.groups.length} candidate group(s) · ${state.verifier.toolCalls} tool calls`;
	}
	const finished = state.workers.filter((worker) => worker.status !== "queued" && worker.status !== "running").length;
	const candidates = state.workers.reduce((sum, worker) => sum + worker.findings.length, 0);
	return `Swarm review: ${finished}/${state.workers.length} workers finished · ${candidates} candidate(s)`;
}

function statusText(pass: PassState, theme: Theme, doneText: string): string {
	switch (pass.status) {
		case "queued":
			return theme.fg("dim", "queued");
		case "running":
			return theme.fg("accent", `● turn ${pass.turns + 1}, ${pass.toolCalls} tool calls`);
		case "done":
			return theme.fg("success", `✓ ${doneText}`) + theme.fg("dim", ` ${formatCost(pass.usage.cost)}`);
		case "failed":
			return theme.fg("error", `✗ ${pass.error ?? "failed"}`);
		case "cancelled":
			return theme.fg("warning", "cancelled");
		case "skipped":
			return theme.fg("dim", "skipped (no candidates)");
	}
}

function renderProgress(state: SwarmState, setupLabel: string, theme: Theme): string[] {
	const lines = [theme.fg("accent", theme.bold("Swarm review")) + theme.fg("muted", ` · ${setupLabel}`)];
	for (const worker of state.workers) {
		const name = `  worker ${String(worker.index + 1).padStart(2)}`;
		const done = `${worker.findings.length} finding(s)${worker.dropped > 0 ? `, ${worker.dropped} dropped` : ""}`;
		lines.push(`${theme.fg("muted", name)} ${statusText(worker, theme, done)}`);
	}
	const verifierName = "  verifier  ";
	const verifierState =
		state.verifier.status === "queued" ? theme.fg("dim", "waiting") : statusText(state.verifier, theme, "done");
	lines.push(`${theme.fg("muted", verifierName)} ${verifierState}`);
	return lines;
}

/** Per-worker progress above a cancellable loader; Escape reaches the loader. */
class SwarmProgressView extends Container {
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

/** Distinct candidate titles of a proximity group, which may hold unrelated defects. */
function groupTitles(group: CandidateGroup): string {
	const titles = [...new Set(group.candidates.map((candidate) => candidate.title))];
	return titles.length > 3 ? `${titles.slice(0, 3).join("; ")}; +${titles.length - 3} more` : titles.join("; ");
}

interface ConfirmedFinding {
	title: string;
	file: string;
	line: number;
	endLine?: number;
	priority: number;
	explanation: string;
	fix?: string;
	groups: string[];
	workers: number[];
}

function buildReport(
	setup: SwarmSetup,
	state: SwarmState,
	result: Extract<SwarmResult, { status: "completed" }>,
	durationMs: number,
): { markdown: string; confirmed: ConfirmedFinding[] } {
	const { options, target } = setup;
	const groupsById = new Map(state.groups.map((group) => [group.id, group]));
	const where = (file: string, line: number, endLine?: number): string =>
		`\`${file}:${lineRange(line, endLine ?? line)}\``;
	const candidateCount = state.groups.reduce((sum, group) => sum + group.candidates.length, 0);
	const completedWorkers = state.workers.filter((worker) => worker.status === "done").length;

	const confirmed: ConfirmedFinding[] = (result.verification?.findings ?? [])
		.map((finding) => {
			const workers = new Set<number>();
			for (const id of finding.groups) {
				for (const candidate of groupsById.get(id)?.candidates ?? []) workers.add(candidate.worker);
			}
			return {
				title: finding.title,
				file: finding.file,
				line: finding.line,
				...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
				priority: finding.priority,
				explanation: finding.explanation,
				...(finding.fix ? { fix: finding.fix } : {}),
				groups: finding.groups,
				workers: [...workers].sort((a, b) => a - b),
			};
		})
		.sort((a, b) => a.priority - b.priority || b.workers.length - a.workers.length);

	const lines = [
		`**Swarm review** · ${target.description}`,
		`${completedWorkers}/${options.workers} workers (${modelRef(setup.workerModel)}, ${options.thinking}) → verifier ${modelRef(setup.verifierModel)} (${options.verifierThinking})`,
	];
	if (target.omittedFiles.length > 0) {
		const shown = target.omittedFiles.slice(0, 5).join(", ");
		const more = target.omittedFiles.length > 5 ? `, +${target.omittedFiles.length - 5} more` : "";
		lines.push(
			`The diff was truncated: changes to ${target.omittedFiles.length} file(s) were missing or incomplete in the prompt (${shown}${more}). Reviewers could read their current contents but not removed lines or deleted files.`,
		);
	}
	if (target.untracked.length > MAX_UNTRACKED_LISTED) {
		lines.push(
			`${target.untracked.length - MAX_UNTRACKED_LISTED} of ${target.untracked.length} untracked files were not listed to reviewers and were not reviewed.`,
		);
	}

	if (result.verificationError) {
		lines.push(
			"",
			`Verification failed: ${result.verificationError}`,
			`Showing ${state.groups.length} **unverified** candidate group(s):`,
		);
		for (const group of state.groups) {
			lines.push(
				`- **${group.id}** ${where(group.file, group.start, group.end)} (${group.candidates.length} candidate(s))`,
			);
			const seen = new Set<string>();
			for (const candidate of group.candidates) {
				if (seen.has(candidate.title)) continue;
				seen.add(candidate.title);
				lines.push(
					`  - [P${candidate.priority}] ${candidate.title}. Trigger: ${candidate.trigger} Impact: ${candidate.impact}`,
				);
			}
		}
	} else if (state.groups.length === 0) {
		lines.push("", "No candidate findings. Nothing to verify.");
	} else {
		const verification = result.verification;
		lines.push(
			`${candidateCount} candidate(s) in ${state.groups.length} group(s) → **${confirmed.length} confirmed**, ${verification?.uncertain.length ?? 0} uncertain, ${verification?.rejected.length ?? 0} rejected`,
		);
		confirmed.forEach((finding, index) => {
			const origin =
				finding.workers.length > 0
					? `found by ${finding.workers.length}/${completedWorkers} workers`
					: "found by the verifier";
			lines.push(
				"",
				`### ${index + 1}. [P${finding.priority}] ${finding.title}`,
				`${where(finding.file, finding.line, finding.endLine)} · ${origin}`,
				"",
				finding.explanation,
			);
			if (finding.fix) lines.push("", `**Fix:** ${finding.fix}`);
		});
		if (verification && verification.uncertain.length > 0) {
			lines.push("", "### Uncertain");
			for (const entry of verification.uncertain) {
				const group = groupsById.get(entry.group);
				const label = group ? `${where(group.file, group.start, group.end)} ${groupTitles(group)}` : entry.group;
				lines.push(`- ${label}: ${entry.reason}`);
			}
		}
		if (verification && verification.rejected.length > 0) {
			lines.push("", "### Rejected");
			for (const entry of verification.rejected) {
				const group = groupsById.get(entry.group);
				const label = group ? `${where(group.file, group.start, group.end)} ${groupTitles(group)}` : entry.group;
				lines.push(`- ${label}: ${entry.reason}`);
			}
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
	lines.push(
		"",
		`Estimated cost: workers ${usageText(workerUsage)} · verifier ${usageText(state.verifier.usage)} · ${formatDuration(durationMs)}`,
	);
	return { markdown: lines.join("\n"), confirmed };
}

// ---------------------------------------------------------------------------
// Command

export default function swarmReview(volt: ExtensionAPI) {
	volt.registerCommand("swarm-review", {
		description: "Run the same review with several cheap workers, then verify and prioritize their claims",
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
				let target: ReviewTarget;
				let contextFiles: Array<{ path: string; content: string }>;
				try {
					const collected = await collectTarget(volt, ctx.cwd, options.base, controller.signal);
					if (typeof collected === "string") return notify(collected, "warning");
					target = collected;
					contextFiles = await loadContextFiles(volt, target, ctx.cwd, controller.signal);
				} catch (error) {
					if (error instanceof SwarmCancelled) return notify("Swarm review cancelled.", "info");
					throw error;
				}

				const state: SwarmState = {
					workers: Array.from({ length: options.workers }, (_, index) => ({
						index,
						status: "queued",
						toolCalls: 0,
						turns: 0,
						usage: emptyUsage(),
						findings: [],
						dropped: 0,
					})),
					verifier: { status: "queued", toolCalls: 0, turns: 0, usage: emptyUsage() },
					groups: [],
					cancelling: false,
				};
				const setupLabel = `${options.workers} × ${worker.model.id} (${options.thinking}) → ${verifier.model.id} (${options.verifierThinking})`;
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
						if (view) view.update(renderProgress(state, setupLabel, ctx.ui.theme), phaseText(state));
						else if (ctx.hasUI && ctx.mode !== "tui") {
							ctx.ui.setWidget(WIDGET_KEY, renderProgress(state, setupLabel, ctx.ui.theme));
						}
					},
				};

				const startedAt = Date.now();
				setup.onProgress();
				const run = runSwarm(setup, state);
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
							void run.then(
								() => done(),
								() => done(),
							);
							return view;
						});
					} catch (error) {
						controller.abort();
						await run.catch(() => undefined);
						throw error;
					} finally {
						view = undefined;
					}
				}

				let result: SwarmResult;
				try {
					result = await run;
				} catch (error) {
					result = { status: "failed", error: errorText(error) };
				}
				if (result.status === "cancelled") return notify("Swarm review cancelled.", "info");
				if (result.status === "failed") return notify(`Swarm review failed: ${result.error}`, "error");

				const report = buildReport(setup, state, result, Date.now() - startedAt);
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
						workers: options.workers,
						candidates: state.groups.reduce((sum, group) => sum + group.candidates.length, 0),
						groups: state.groups.length,
						confirmed: report.confirmed.map((finding) => ({ ...finding })),
						verified: result.verification !== undefined,
					},
				});
			} finally {
				ctx.signal.removeEventListener("abort", onCommandAbort);
				if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
			}
		},
	});
}
