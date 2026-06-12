/**
 * Built-in /review support.
 *
 * Resolves a review target (uncommitted changes, branch diff, GitHub PR, or a
 * single commit) into a diff, runs an isolated in-process review session over
 * it, and parses the structured findings from the reviewer's final message.
 *
 * The review session is intentionally separate from the user's session: it has
 * its own context window, its own system prompt, and no extensions, skills, or
 * prompt templates. After the review completes the caller starts a fresh
 * session seeded only with the findings.
 */

import { spawn } from "node:child_process";
import type { ThinkingLevel } from "@earendil-works/volt-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/volt-ai";
import type { AuthStorage } from "./auth-storage.ts";
import { createExtensionRuntime } from "./extensions/loader.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { loadProjectContextFiles, type ResourceLoader } from "./resource-loader.ts";
import { createAgentSession } from "./sdk.ts";
import { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

// ============================================================================
// Review targets
// ============================================================================

export type ReviewTarget =
	| { kind: "uncommitted" }
	| { kind: "branch"; base?: string }
	| { kind: "pr"; number?: string }
	| { kind: "commit"; sha?: string };

export const REVIEW_USAGE =
	"Usage: /review [uncommitted | branch [base] | pr [number] | commit [sha]] (no arguments opens a selector)";

/**
 * Parse the argument text after "/review".
 * Returns an empty object when no arguments were given (caller shows a selector).
 */
export function parseReviewCommandArgs(argsText: string): { target?: ReviewTarget; error?: string } {
	const tokens = argsText.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return {};
	}

	const keyword = tokens[0].toLowerCase();
	switch (keyword) {
		case "uncommitted":
		case "unstaged":
		case "working":
			return { target: { kind: "uncommitted" } };
		case "branch":
			return { target: { kind: "branch", base: tokens[1] } };
		case "pr":
			return { target: { kind: "pr", number: tokens[1] } };
		case "commit":
			// Without a SHA the caller shows a commit picker.
			return { target: { kind: "commit", sha: tokens[1] } };
		default:
			return { error: `Unknown review target "${tokens[0]}". ${REVIEW_USAGE}` };
	}
}

// ============================================================================
// Target resolution (git / gh)
// ============================================================================

/** A review target resolved to a concrete diff plus reviewer-facing metadata. */
export interface ResolvedReview {
	/** Human-readable description, e.g. `branch changes vs main`. */
	description: string;
	/** Command the reviewer can re-run to reproduce the diff. */
	diffCommand: string;
	/** The diff text (possibly truncated, see `truncated`). */
	diff: string;
	/** True when the diff exceeded the inline size limit and was truncated. */
	truncated: boolean;
	/** Extra context: commit log, PR metadata, untracked file list. */
	extraContext?: string;
}

/** Maximum diff characters embedded inline in the review prompt. */
export const MAX_REVIEW_DIFF_CHARS = 150_000;

interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("error", (error) => {
			resolve({ ok: false, stdout, stderr: error.message });
		});
		proc.on("close", (code) => {
			resolve({ ok: code === 0, stdout, stderr });
		});
	});
}

function truncateDiff(diff: string): { diff: string; truncated: boolean } {
	if (diff.length <= MAX_REVIEW_DIFF_CHARS) {
		return { diff, truncated: false };
	}
	return { diff: diff.slice(0, MAX_REVIEW_DIFF_CHARS), truncated: true };
}

async function detectBaseBranch(cwd: string): Promise<string | undefined> {
	const originHead = await runCommand("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (originHead.ok) {
		const ref = originHead.stdout.trim();
		if (ref) {
			return ref.replace(/^origin\//, "");
		}
	}
	for (const candidate of ["main", "master"]) {
		const exists = await runCommand("git", ["rev-parse", "--verify", "--quiet", candidate], cwd);
		if (exists.ok) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Resolve a review target into a concrete diff.
 * Returns `{ error }` for user-facing failures (not a git repo, empty diff, gh missing, ...).
 */
export async function resolveReviewTarget(
	target: ReviewTarget,
	cwd: string,
): Promise<ResolvedReview | { error: string }> {
	const inRepo = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
	if (!inRepo.ok) {
		return { error: "Not inside a git repository." };
	}

	switch (target.kind) {
		case "uncommitted": {
			let diffResult = await runCommand("git", ["diff", "HEAD"], cwd);
			let diffCommand = "git diff HEAD";
			if (!diffResult.ok) {
				// No commits yet: combine the staged diff (index vs the empty tree)
				// with the worktree diff so staged changes are not missed.
				const stagedResult = await runCommand("git", ["diff", "--cached"], cwd);
				const worktreeResult = await runCommand("git", ["diff"], cwd);
				if (!stagedResult.ok || !worktreeResult.ok) {
					const failed = stagedResult.ok ? worktreeResult : stagedResult;
					return { error: `git diff failed: ${failed.stderr.trim()}` };
				}
				diffResult = { ok: true, stdout: stagedResult.stdout + worktreeResult.stdout, stderr: "" };
				diffCommand = "git diff --cached; git diff";
			}
			const untrackedResult = await runCommand("git", ["ls-files", "--others", "--exclude-standard"], cwd);
			const untracked = untrackedResult.ok
				? untrackedResult.stdout
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean)
				: [];
			if (!diffResult.stdout.trim() && untracked.length === 0) {
				return { error: "No uncommitted changes to review." };
			}
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			return {
				description: "uncommitted changes",
				diffCommand,
				diff,
				truncated,
				extraContext:
					untracked.length > 0
						? `Untracked files (not in the diff; read them directly):\n${untracked.map((file) => `- ${file}`).join("\n")}`
						: undefined,
			};
		}
		case "branch": {
			const base = target.base ?? (await detectBaseBranch(cwd));
			if (!base) {
				return { error: "Could not detect a base branch. Use /review branch <base>." };
			}
			const baseExists = await runCommand("git", ["rev-parse", "--verify", "--quiet", base], cwd);
			if (!baseExists.ok) {
				return { error: `Base branch "${base}" not found.` };
			}
			const diffResult = await runCommand("git", ["diff", `${base}...HEAD`], cwd);
			if (!diffResult.ok) {
				return { error: `git diff failed: ${diffResult.stderr.trim()}` };
			}
			if (!diffResult.stdout.trim()) {
				return { error: `No changes between ${base} and HEAD.` };
			}
			const logResult = await runCommand("git", ["log", "--oneline", `${base}..HEAD`], cwd);
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			return {
				description: `branch changes vs ${base}`,
				diffCommand: `git diff ${base}...HEAD`,
				diff,
				truncated,
				extraContext: logResult.ok && logResult.stdout.trim() ? `Commits:\n${logResult.stdout.trim()}` : undefined,
			};
		}
		case "pr": {
			const numberArgs = target.number ? [target.number] : [];
			const viewResult = await runCommand(
				"gh",
				["pr", "view", ...numberArgs, "--json", "number,title,body,baseRefName,headRefName,url"],
				cwd,
			);
			if (!viewResult.ok) {
				const stderr = viewResult.stderr.trim();
				if (/ENOENT|not found|not recognized/i.test(stderr)) {
					return { error: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/" };
				}
				return { error: `gh pr view failed: ${stderr}` };
			}
			let prInfo: {
				number: number;
				title: string;
				body: string;
				baseRefName: string;
				headRefName: string;
				url: string;
			};
			try {
				prInfo = JSON.parse(viewResult.stdout);
			} catch {
				return { error: "Could not parse gh pr view output." };
			}
			const diffResult = await runCommand("gh", ["pr", "diff", String(prInfo.number)], cwd);
			if (!diffResult.ok) {
				return { error: `gh pr diff failed: ${diffResult.stderr.trim()}` };
			}
			if (!diffResult.stdout.trim()) {
				return { error: `PR #${prInfo.number} has an empty diff.` };
			}
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			const bodyText = prInfo.body?.trim();
			return {
				description: `PR #${prInfo.number} (${prInfo.title})`,
				diffCommand: `gh pr diff ${prInfo.number}`,
				diff,
				truncated,
				extraContext: [
					`PR #${prInfo.number}: ${prInfo.title}`,
					`Base branch: ${prInfo.baseRefName}`,
					`Head branch: ${prInfo.headRefName}`,
					`URL: ${prInfo.url}`,
					`Note: the local worktree may not have the PR head checked out. Do not assume local files match the diff; inspect PR file contents against fetched refs instead (e.g. \`git fetch origin ${prInfo.headRefName}\` then \`git show FETCH_HEAD:<path>\`).`,
					bodyText ? `Description:\n${bodyText}` : undefined,
				]
					.filter(Boolean)
					.join("\n"),
			};
		}
		case "commit": {
			if (!target.sha) {
				return { error: "Missing commit SHA." };
			}
			// --diff-merges=first-parent: plain `git show` prints no patch hunks
			// for merge commits; diff against the first parent shows what the
			// merge brought into the branch. Non-merge commits are unaffected.
			const diffResult = await runCommand(
				"git",
				["show", "--stat", "--patch", "--diff-merges=first-parent", target.sha],
				cwd,
			);
			if (!diffResult.ok) {
				return { error: `git show failed: ${diffResult.stderr.trim()}` };
			}
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			return {
				description: `commit ${target.sha}`,
				diffCommand: `git show --stat --patch --diff-merges=first-parent ${target.sha}`,
				diff,
				truncated,
			};
		}
	}
}

/** A commit entry for the /review commit picker. */
export interface RecentCommit {
	sha: string;
	subject: string;
	/** Relative author date, e.g. "2 days ago". */
	date: string;
}

/** List recent commits on HEAD for the /review commit picker. */
export async function listRecentCommits(cwd: string, limit = 30): Promise<RecentCommit[] | { error: string }> {
	const result = await runCommand("git", ["log", "-n", String(limit), "--pretty=format:%h%x09%cr%x09%s"], cwd);
	if (!result.ok) {
		return { error: `git log failed: ${result.stderr.trim()}` };
	}
	const commits: RecentCommit[] = [];
	for (const line of result.stdout.split("\n")) {
		const [sha, date, ...subjectParts] = line.split("\t");
		if (!sha?.trim()) {
			continue;
		}
		commits.push({ sha: sha.trim(), date: date?.trim() ?? "", subject: subjectParts.join("\t").trim() });
	}
	return commits;
}

// ============================================================================
// Review prompt
// ============================================================================

export const REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer operating inside volt, a coding agent harness. You review a code change and report only findings that matter.

You have full tool access (read, bash, edit, write) in the repository being reviewed. Use it:
- Read the full files around changed hunks; never judge a hunk in isolation.
- Trace callers and related code when a change could break an invariant elsewhere.
- If you suspect a behavioral bug, verify it when feasible: run the relevant tests, or write a small scratch test/script to confirm. Delete any scratch files you create and revert any temporary edits before finishing, leaving the working tree as you found it.

What to flag:
- Bugs and logic errors that affect behavior.
- Security issues, data loss, race conditions, broken error handling.
- Changes that contradict explicit project conventions (see project context).
- Regressions: removed checks, broken invariants, missed call sites.

What NOT to flag:
- Style nits, formatting, or naming preferences.
- Speculative concerns you could not substantiate from the code.
- Pre-existing issues in code the change does not touch, unless the change makes them worse.

Each finding needs a confidence assessment grounded in code you actually read or executed. Prefer a few high-signal findings over an exhaustive list.

Output format: end your FINAL message with a single fenced json block, after a short prose summary of what you reviewed and how you verified it:

\`\`\`json
{
  "findings": [
    {
      "title": "Short imperative summary",
      "body": "Explanation with evidence: what is wrong, why, and the concrete impact. Reference files and lines.",
      "priority": 1,
      "confidence": 0.9,
      "file": "relative/path/to/file.ts",
      "line": "120-134"
    }
  ],
  "overall_correctness": "correct" | "incorrect",
  "overall_explanation": "One or two sentences on whether the change is safe to land."
}
\`\`\`

Priorities: 0 = must fix before landing, 1 = should fix, 2 = worth fixing, 3 = optional. Confidence is 0.0-1.0. Use an empty findings array when the change looks good. Do not put anything after the json block.`;

/** Build the user prompt for the review session. */
export function buildReviewPrompt(resolved: ResolvedReview): string {
	const parts: string[] = [`Review the following change: ${resolved.description}.`];
	if (resolved.extraContext) {
		parts.push(resolved.extraContext);
	}
	if (resolved.truncated) {
		parts.push(
			`The diff is too large to include inline. Run \`${resolved.diffCommand}\` yourself to read the full diff. A truncated preview follows:`,
		);
	} else {
		parts.push(`Reproduce this diff with \`${resolved.diffCommand}\`.`);
	}
	parts.push(`<diff>\n${resolved.diff}\n</diff>`);
	parts.push(
		"Investigate the surrounding code before judging any hunk. Verify suspected bugs when feasible. Then produce your findings in the required json format.",
	);
	return parts.join("\n\n");
}

// ============================================================================
// Findings parsing
// ============================================================================

export interface ReviewFinding {
	title: string;
	body: string;
	/** 0 = must fix, 1 = should fix, 2 = worth fixing, 3 = optional. */
	priority?: number;
	/** 0.0 - 1.0 */
	confidence?: number;
	file?: string;
	line?: string;
}

export interface ParsedReview {
	findings: ReviewFinding[];
	overallCorrectness?: string;
	overallExplanation?: string;
}

function coerceFinding(raw: unknown): ReviewFinding | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title.trim() : "";
	const body = typeof record.body === "string" ? record.body.trim() : "";
	if (!title && !body) {
		return undefined;
	}
	return {
		title: title || body.slice(0, 80),
		body,
		priority: typeof record.priority === "number" ? record.priority : undefined,
		confidence: typeof record.confidence === "number" ? record.confidence : undefined,
		file: typeof record.file === "string" && record.file.trim() ? record.file.trim() : undefined,
		line:
			typeof record.line === "string" && record.line.trim()
				? record.line.trim()
				: typeof record.line === "number"
					? String(record.line)
					: undefined,
	};
}

/**
 * Parse the reviewer's final message. Looks for the last fenced json block
 * containing a findings array. Returns undefined when no parseable block exists.
 */
export function parseReviewOutput(text: string): ParsedReview | undefined {
	// Extract fenced blocks line by line. Any info string opens a block (so a
	// ```ts block in prose doesn't pair fences off-by-one), but only json or
	// untagged blocks become candidates. A closer must be a bare ``` line, so
	// fences embedded inside JSON strings don't terminate the block early.
	const candidates: string[] = [];
	let blockLines: string[] | undefined;
	let blockIsCandidate = false;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (blockLines === undefined) {
			if (trimmed.startsWith("```")) {
				const infoString = trimmed.slice(3).trim();
				blockLines = [];
				blockIsCandidate = infoString === "" || infoString === "json";
			}
		} else if (trimmed === "```") {
			if (blockIsCandidate) {
				candidates.push(blockLines.join("\n"));
			}
			blockLines = undefined;
		} else {
			blockLines.push(line);
		}
	}
	// An unterminated trailing block is still worth trying.
	if (blockLines !== undefined && blockIsCandidate) {
		candidates.push(blockLines.join("\n"));
	}
	// Also try the whole text in case the model emitted bare JSON.
	candidates.push(text);

	for (let i = candidates.length - 1; i >= 0; i--) {
		const candidate = candidates[i].trim();
		if (!candidate.startsWith("{")) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) {
			continue;
		}
		const record = parsed as Record<string, unknown>;
		if (!Array.isArray(record.findings)) {
			continue;
		}
		const findings = record.findings
			.map(coerceFinding)
			.filter((finding): finding is ReviewFinding => finding !== undefined);
		return {
			findings,
			overallCorrectness: typeof record.overall_correctness === "string" ? record.overall_correctness : undefined,
			overallExplanation: typeof record.overall_explanation === "string" ? record.overall_explanation : undefined,
		};
	}
	return undefined;
}

// ============================================================================
// Seeding the fresh session
// ============================================================================

/**
 * Format the review result as the seed message for the fresh post-review session.
 * This text is both displayed and sent to the LLM as context.
 */
export function formatReviewForNewSession(
	resolved: Pick<ResolvedReview, "description" | "diffCommand">,
	parsed: ParsedReview | undefined,
	raw: string,
): string {
	const lines: string[] = [
		`An automated code review of ${resolved.description} was completed in a separate session.`,
		"",
	];

	if (!parsed) {
		lines.push("The reviewer's report (unstructured):", "", raw.trim());
	} else {
		if (parsed.overallCorrectness || parsed.overallExplanation) {
			const verdict = [parsed.overallCorrectness, parsed.overallExplanation].filter(Boolean).join(" — ");
			lines.push(`Overall: ${verdict}`, "");
		}
		if (parsed.findings.length === 0) {
			lines.push("The review found no issues worth flagging.");
		} else {
			lines.push("Findings:", "");
			parsed.findings.forEach((finding, index) => {
				const meta: string[] = [];
				if (finding.priority !== undefined) {
					meta.push(`P${finding.priority}`);
				}
				if (finding.confidence !== undefined) {
					meta.push(`confidence ${Math.round(finding.confidence * 100)}%`);
				}
				const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
				const metaText = meta.length > 0 ? ` [${meta.join(", ")}]` : "";
				lines.push(`### ${index + 1}. ${finding.title}${metaText}${location}`, "");
				if (finding.body) {
					lines.push(finding.body, "");
				}
			});
		}
	}

	lines.push(
		"",
		`Reproduce the reviewed diff with \`${resolved.diffCommand}\`.`,
		'The user may refer to findings by number (e.g. "fix 1 and 3"). When asked to fix findings, read the relevant code first and apply minimal, correct fixes.',
	);
	return lines.join("\n");
}

// ============================================================================
// Running the review
// ============================================================================

/** Minimal resource loader for the isolated review session: no extensions, skills, prompts, or themes. */
export function createReviewResourceLoader(cwd: string, agentDir: string): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const agentsFiles = loadProjectContextFiles({ cwd, agentDir });
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles }),
		getSystemPrompt: () => REVIEW_SYSTEM_PROMPT,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export interface RunReviewOptions {
	cwd: string;
	agentDir: string;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	resolved: ResolvedReview;
	/** Aborts the review session when triggered. */
	signal?: AbortSignal;
	/** Called with short progress updates (tool activity) while the review runs. */
	onProgress?: (message: string) => void;
}

export interface ReviewRunResult {
	aborted: boolean;
	/** Full text of the reviewer's final message. */
	raw: string;
	parsed?: ParsedReview;
	errorMessage?: string;
}

function summarizeToolArgs(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) {
		return undefined;
	}
	for (const value of Object.values(args as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim()) {
			const oneLine = value.replace(/\s+/g, " ").trim();
			return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
		}
	}
	return undefined;
}

/**
 * Run a review in an isolated in-process agent session.
 * The session is in-memory (not persisted) and disposed when done.
 */
export async function runReview(options: RunReviewOptions): Promise<ReviewRunResult> {
	const resourceLoader = createReviewResourceLoader(options.cwd, options.agentDir);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		settingsManager: options.settingsManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		sessionManager: SessionManager.inMemory(options.cwd),
		resourceLoader,
	});

	// An abort during session creation fires before the listener below is
	// attached, and AbortSignal does not invoke listeners added after the fact.
	if (options.signal?.aborted) {
		session.dispose();
		return { aborted: true, raw: "" };
	}

	const onAbort = () => {
		void session.abort();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			const summary = summarizeToolArgs(event.args);
			options.onProgress?.(summary ? `${event.toolName}: ${summary}` : event.toolName);
		}
	});

	try {
		await session.prompt(buildReviewPrompt(options.resolved), { expandPromptTemplates: false });

		if (options.signal?.aborted) {
			return { aborted: true, raw: "" };
		}

		const lastAssistant = [...session.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (lastAssistant?.stopReason === "aborted") {
			return { aborted: true, raw: "" };
		}
		if (lastAssistant?.stopReason === "error") {
			return { aborted: false, raw: "", errorMessage: lastAssistant.errorMessage ?? "Review failed" };
		}

		const raw = session.getLastAssistantText() ?? "";
		if (!raw.trim()) {
			return { aborted: false, raw: "", errorMessage: "Review produced no output" };
		}
		return { aborted: false, raw, parsed: parseReviewOutput(raw) };
	} catch (error) {
		if (options.signal?.aborted) {
			return { aborted: true, raw: "" };
		}
		return {
			aborted: false,
			raw: "",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	} finally {
		unsubscribe();
		options.signal?.removeEventListener("abort", onAbort);
		session.dispose();
	}
}
