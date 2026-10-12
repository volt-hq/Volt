/**
 * Issue orchestrator: works a repository's labeled GitHub issues with agents,
 * from implementation through review until clean to merge (or a human's
 * merge), as the repository's `.volt/WORKFLOW.md` says.
 *
 * `/orchestrate start [workflow]` runs the loop as work of this conversation:
 * every agent it starts is a subagent of that work, in the issue's managed
 * worktree, every review it runs on a review engine is review work under it,
 * and this conversation's panel shows what each issue is doing.
 * The work item lists every issue and logs what the loop does, so `/work`
 * shows it full screen. `/orchestrate stop`, `status`, and `refresh` control it. The loop is
 * deterministic code; the conversation's own model is free to talk about it.
 *
 * Needs a conversation the daemon hosts (interactive Volt), a trusted
 * project, GitHub CLI signed in, and the `exec` permission.
 */

import { basename, relative, resolve } from "node:path";
import {
	defineManifest,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionReviewEnd,
	type ExtensionReviewResult,
	type WorkRunContext,
} from "@hansjm10/volt-coding-agent";
import { type GhRunner, GitHubTracker, type Tracker } from "./github.ts";
import {
	Orchestrator,
	type OrchestratorSnapshot,
	type ReleaseOutcome,
	type ReviewFinding,
	type ReviewResult,
	type Workspaces,
} from "./orchestrator.ts";
import { issueBranch, issueWorktree } from "./phase.ts";
import { issueSteps, logLine, noteText, panel } from "./views.ts";
import { loadWorkflow, type WorkflowConfig } from "./workflow.ts";

export const manifest = defineManifest({
	id: "issue-orchestrator",
	displayName: "Issue Orchestrator",
	description:
		"Works labeled GitHub issues with agents: implement, review until clean, then merge or hand to a human.",
	permissions: ["exec"],
});

const COMMAND = "orchestrate";
const DEFAULT_WORKFLOW = ".volt/WORKFLOW.md";
const SUBCOMMANDS = ["start", "stop", "status", "refresh"] as const;
/** The custom message type of the orchestrator's notes in the conversation. */
const NOTE_TYPE = "issue-orchestrator";

interface Active {
	readonly controller: AbortController;
	readonly orchestrator: Orchestrator;
}

export default function issueOrchestrator(volt: ExtensionAPI): void {
	volt.registerWorkKind("orchestrator", { cancelOnAbort: false, maxActive: 1 });
	let active: Active | undefined;

	volt.registerCommand(COMMAND, {
		description: "Work labeled GitHub issues with agents: start [workflow] | stop | status | refresh",
		getArgumentCompletions: (prefix) => {
			const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			const [subcommand = "status", ...rest] = args
				.trim()
				.split(/\s+/)
				.filter((part) => part.length > 0);
			switch (subcommand) {
				case "start":
					if (active) return ctx.ui.notify("The orchestrator is already running.", "warning");
					{
						const started = await start(volt, ctx, rest.join(" "), () => {
							active = undefined;
						});
						// A loop that already stopped is not running.
						active = started?.controller.signal.aborted === false ? started : undefined;
						return;
					}
				case "stop":
					if (!active) return ctx.ui.notify("The orchestrator is not running.", "info");
					active.controller.abort();
					return ctx.ui.notify("Stopping the orchestrator and its agents.", "info");
				case "refresh":
					if (!active) return ctx.ui.notify("The orchestrator is not running.", "info");
					active.orchestrator.wake();
					return;
				case "status":
					return ctx.ui.notify(
						active ? summary(active.orchestrator.snapshot()) : "The orchestrator is not running.",
					);
				default:
					return ctx.ui.notify(`Unknown subcommand ${subcommand}: use ${SUBCOMMANDS.join(", ")}.`, "error");
			}
		},
	});

	volt.on("session_shutdown", () => {
		active?.controller.abort();
	});
}

/** Check the conversation and the workflow, confirm with the user, and start the loop as work. */
async function start(
	volt: ExtensionAPI,
	ctx: ExtensionCommandContext,
	workflowArgument: string,
	stopped: () => void,
): Promise<Active | undefined> {
	if (ctx.invokedBy !== "local") {
		ctx.ui.notify("Only a client at the host can start the orchestrator.", "error");
		return undefined;
	}
	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("Trust this project first: its workflow runs commands.", "error");
		return undefined;
	}
	const path = resolve(ctx.cwd, workflowArgument || DEFAULT_WORKFLOW);
	let config: WorkflowConfig;
	try {
		config = (await loadWorkflow(path)).config;
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
	try {
		await ctx.worktrees.list();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
	const engine = config.review.engine;
	if (engine !== "agent") {
		const engines = ctx.reviews.engines().filter((candidate) => candidate.targets.includes("pr"));
		if (!engines.some((candidate) => candidate.id === engine)) {
			ctx.ui.notify(
				`Review engine ${engine} cannot review pull requests here: set review.engine to agent or one of ${engines.map((candidate) => candidate.id).join(", ")}.`,
				"error",
			);
			return undefined;
		}
	}
	const merging =
		config.merge.mode === "auto"
			? `merges approved pull requests whose checks pass (${config.merge.method})`
			: `labels approved pull requests' issues "${config.merge.readyLabel}" for a human to merge`;
	const confirmed = await ctx.ui.confirm(
		"Start the issue orchestrator?",
		`It works open issues labeled ${config.tracker.labels.join(" + ")} in ${config.tracker.repo ?? "this repository"}, including the ones it files for problems found outside an issue's work (also labeled "${config.tracker.filedLabel}"), with up to ${config.agent.maxConcurrent} agents at once, and ${merging}.`,
		{ signal: ctx.signal },
	);
	if (!confirmed) return undefined;

	// A conversation that holds only work and extension commands has no messages, so session lists
	// would leave it out: a name and a displayed message keep it there, under a title that says what it is.
	const repo = config.tracker.repo ?? basename(ctx.cwd);
	if (volt.getSessionName() === undefined) {
		await volt.setSessionName(`Issue orchestrator · ${repo}`).catch(() => undefined);
	}
	note(
		volt,
		`Issue orchestrator started for ${repo} (${relative(ctx.cwd, path) || path}): working open issues labeled ${config.tracker.labels.join(" + ")}, including the ones it files for problems found outside an issue's work, with up to ${config.agent.maxConcurrent} agents at once, and it ${merging}. Its agents run under its work item, which /work shows full screen with every issue and its log; /orchestrate status, refresh, and stop control it.`,
	);

	const controller = new AbortController();
	/** The loop's work, once it runs. */
	let reporter: WorkRunContext | undefined;
	const report = (snapshot: OrchestratorSnapshot): void =>
		reporter?.progress({ text: summary(snapshot), steps: issueSteps(snapshot) });
	const log = (line: string): void => reporter?.output(`${new Date().toTimeString().slice(0, 8)}  ${line}\n`);
	let tracker: { key: string; tracker: Promise<Tracker> } | undefined;
	const hooked = new Set<string>();
	const gh =
		(config: WorkflowConfig): GhRunner =>
		async (args) => {
			const [command = "gh", ...prefix] = config.ghCommand;
			return await volt.exec(command, [...prefix, ...args], { cwd: ctx.cwd, timeout: 120_000 });
		};
	const workspaces: Workspaces = {
		prepare: async (issue, config) => {
			const name = issueWorktree(issue.number);
			const existing = (await ctx.worktrees.list()).find((worktree) => worktree.id === name);
			if (existing !== undefined && !existing.available) {
				throw new Error(`Worktree ${name} is archived; restore or remove it`);
			}
			// A released issue's branch is still there, with the work done on it: check it out again.
			const worktree =
				existing ??
				(await ctx.worktrees.create({
					name,
					branch: issueBranch(issue.number),
					reuseBranch: true,
					...(config.workspace.baseRef === undefined ? {} : { baseRef: config.workspace.baseRef }),
				}));
			// Once per worktree each time the orchestrator starts: a hook that failed runs again on the next attempt.
			const script = config.workspace.afterCreate;
			if (script !== undefined && (existing === undefined || !hooked.has(name))) {
				const result = await volt.exec("bash", ["-lc", script], {
					cwd: worktree.path,
					timeout: config.workspace.hookTimeoutMs,
				});
				if (result.code !== 0) {
					throw new Error(
						`after_create failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(-500)}`,
					);
				}
			}
			hooked.add(name);
			return { path: worktree.path, branch: worktree.branch };
		},
		release: async (number) => {
			// Releasing drops the checkout's ignored files, the hook's dependencies among them: should the
			// issue come back while the checkout is still there, the hook runs again.
			hooked.delete(issueWorktree(number));
			return await releaseWorktree(ctx.worktrees, (args, cwd) => volt.exec("git", args, { cwd }), number);
		},
		checkouts: async () =>
			(await ctx.worktrees.list()).flatMap((worktree) => {
				const number = /^issue-(\d+)$/.exec(worktree.id)?.[1];
				// An archived worktree has no checkout taking room.
				return number !== undefined && worktree.available ? [Number(number)] : [];
			}),
	};
	const orchestrator = new Orchestrator({
		loadWorkflow: () => loadWorkflow(path),
		tracker: async (config) => {
			const key = JSON.stringify([config.tracker.repo, config.tracker.reviewAuthor, config.ghCommand]);
			if (tracker?.key !== key) {
				tracker = {
					key,
					tracker: GitHubTracker.connect(gh(config), {
						...(config.tracker.repo === undefined ? {} : { repo: config.tracker.repo }),
						...(config.tracker.reviewAuthor === undefined ? {} : { reviewAuthor: config.tracker.reviewAuthor }),
					}),
				};
				// A failed connection is asked again next tick.
				tracker.tracker.catch(() => {
					tracker = undefined;
				});
			}
			return await tracker.tracker;
		},
		agents: {
			start: async ({ agent, task, cwd, limits }) => {
				const run = await ctx.subagents.start({
					agent,
					task,
					cwd,
					limits,
					...(reporter === undefined ? {} : { parentWorkId: reporter.workId }),
				});
				return { id: run.id, ended: run.ended };
			},
			cancel: (id) => ctx.subagents.cancel(id),
		},
		reviews: {
			start: async ({ pr, engine, previousRunId, setup }) => {
				// A run the conversation does not hold, such as another conversation's, is not followed.
				const previous =
					previousRunId !== undefined && (await ctx.reviews.result(previousRunId)) !== undefined
						? previousRunId
						: undefined;
				// The standard review runs the project's checks in a checkout of its own, which the setup prepares.
				const commands =
					engine === "standard" ? { tools: ["bash"], ...(setup === undefined ? {} : { setup }) } : {};
				const run = await ctx.reviews.start({
					target: { kind: "pr", number: pr },
					engine,
					followUps: true,
					...(previous === undefined ? {} : { previousRunId: previous }),
					...commands,
					...(reporter === undefined ? {} : { parentWorkId: reporter.workId }),
				});
				return { id: run.id, ended: run.ended.then(reviewResult) };
			},
			cancel: (id) => ctx.reviews.cancel(id),
			publish: async (id, options) => {
				await ctx.reviews.publish(id, options);
			},
			findings: async (id) =>
				(await ctx.reviews.result(id))?.findings
					?.filter((finding) => finding.status !== "fixed" && finding.status !== "dismissed")
					.map((finding) => reviewNote(finding, finding.changeLocation)),
		},
		workspaces,
		onChange: (snapshot) => {
			ctx.ui.setPanel("orchestrator", panel(snapshot, `extension.command.${manifest.id}.${COMMAND}`));
			report(snapshot);
		},
		announce: (event) => {
			note(volt, noteText(event));
			log(logLine(event));
		},
		log,
	});

	await ctx.startWork(
		"orchestrator",
		{ title: `Orchestrate issues labeled ${config.tracker.labels.join(" + ")}`, input: { workflow: path } },
		async (work) => {
			reporter = work;
			// Cancelling the work, or the conversation's end, stops the loop.
			const cancel = () => controller.abort();
			work.signal.addEventListener("abort", cancel, { once: true });
			ctx.signal.addEventListener("abort", cancel, { once: true });
			// Running times advance between changes.
			const refresh = setInterval(() => report(orchestrator.snapshot()), 5_000);
			log(`started for ${repo}`);
			try {
				await orchestrator.run(controller.signal);
				log("stopped");
				const final = orchestrator.snapshot();
				note(volt, `Issue orchestrator stopped. ${summary(final)}.`);
				return {
					outcome: work.signal.aborted ? "cancelled" : "completed",
					result: { summary: summary(final) },
				};
			} finally {
				clearInterval(refresh);
				work.signal.removeEventListener("abort", cancel);
				ctx.signal.removeEventListener("abort", cancel);
				stopped();
				try {
					ctx.ui.setPanel("orchestrator", undefined);
				} catch {
					// The conversation ended.
				}
			}
		},
	);
	return { controller, orchestrator };
}

/**
 * Release issue `number`'s worktree, keeping its branch. The daemon never
 * removes a checkout holding ignored files, and the setup hook and agents
 * leave dependencies and build output there, so a checkout whose only
 * changes are ignored files loses those first. One with changes to tracked
 * or untracked files is kept for a human; one a conversation still holds is
 * tried again. Rejects when the daemon refuses the removal for another reason,
 * for the orchestrator to try again later.
 */
export async function releaseWorktree(
	worktrees: Pick<ExtensionCommandContext["worktrees"], "list" | "remove">,
	git: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>,
	number: number,
): Promise<ReleaseOutcome> {
	const name = issueWorktree(number);
	const worktree = (await worktrees.list()).find((candidate) => candidate.id === name);
	if (worktree === undefined) return "released";
	if (worktree.available) {
		const status = await git(["status", "--porcelain", "--untracked-files=all"], worktree.path);
		if (status.code !== 0 || status.stdout.trim().length > 0) return "kept";
		if ((await git(["clean", "-fdX", "--quiet"], worktree.path)).code !== 0) return "kept";
	}
	try {
		await worktrees.remove(name);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("worktree_busy")) return "retry";
		if (message.startsWith("worktree_dirty")) return "kept";
		if (!message.startsWith("worktree_not_found")) throw error;
	}
	return "released";
}

/** A review's finding or follow-up as the orchestrator reads it. */
function reviewNote(
	note: { title: string; body: string; priority: number },
	location: { path: string; startLine: number; endLine: number },
): ReviewFinding {
	return {
		title: note.title,
		body: note.body,
		priority: note.priority,
		path: location.path,
		startLine: location.startLine,
		endLine: location.endLine,
	};
}

/** What a review run used: its tokens and estimated cost, when it reported them. */
function reviewUsage(run: ExtensionReviewResult | undefined): ReviewResult["usage"] {
	const usage = run?.usage;
	if (usage === undefined || !("costBasis" in usage)) return { tokens: 0, cost: 0 };
	const tokens = usage.tokens;
	return {
		tokens: tokens === undefined ? 0 : tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		cost: usage.estimatedCost?.total ?? 0,
	};
}

/**
 * How a review ended, as the orchestrator reads it: a complete review's
 * verdict is `clean` when it found the change correct (no open P0 to P2
 * finding), else `changes`, on the pull request head it reviewed.
 */
function reviewResult(end: ExtensionReviewEnd): ReviewResult {
	const run = end.run;
	const usage = reviewUsage(run);
	if (end.status === "cancelled") return { status: "cancelled", followUps: [], usage };
	if (end.status === "failed" || run === undefined) {
		return { status: "failed", error: end.error ?? "the review failed", followUps: [], usage };
	}
	const headSha = run.target.identity.pullRequest?.headRefOid;
	if (run.completionStatus !== "complete" || run.overallCorrectness === undefined || headSha === undefined) {
		return {
			status: "completed",
			...(run.overallExplanation ? { error: run.overallExplanation } : {}),
			followUps: [],
			usage,
		};
	}
	return {
		status: "completed",
		verdict: { value: run.overallCorrectness === "correct" ? "clean" : "changes", headSha },
		followUps: (run.followUps ?? []).map((followUp) => ({
			...reviewNote(followUp, followUp.location),
			fingerprint: followUp.fingerprint,
		})),
		usage,
	};
}

/** Post a line about the orchestrator to the conversation; it shows to every client and stays in the transcript. */
function note(volt: ExtensionAPI, text: string): void {
	try {
		volt.sendMessage({ customType: NOTE_TYPE, content: text, display: true });
	} catch {
		// The conversation is closing or the extension stopping: nothing to tell.
	}
}

function summary(snapshot: OrchestratorSnapshot): string {
	const parts = [
		`${snapshot.running.length} running`,
		`${snapshot.waiting.length} waiting`,
		`${snapshot.retrying.length} retrying`,
		`${snapshot.handedOff.length} handed off`,
		`${snapshot.totals.runs} runs, $${snapshot.totals.cost.toFixed(2)}`,
	];
	return `${snapshot.repo ?? "Issue orchestrator"}: ${parts.join(", ")}${snapshot.error ? ` (${snapshot.error})` : ""}`;
}
