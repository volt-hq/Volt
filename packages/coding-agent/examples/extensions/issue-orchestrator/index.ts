/**
 * Issue orchestrator: works a repository's labeled GitHub issues with agents,
 * from implementation through review until clean to merge (or a human's
 * merge), as the repository's `.volt/WORKFLOW.md` says.
 *
 * `/orchestrate start [workflow]` runs the loop as work of this conversation:
 * every agent it starts is a subagent of that work, in the issue's managed
 * worktree, and this conversation's panel shows what each issue is doing.
 * `/orchestrate stop`, `status`, and `refresh` control it. The loop is
 * deterministic code; the conversation's own model is free to talk about it.
 *
 * Needs a conversation the daemon hosts (interactive Volt), a trusted
 * project, GitHub CLI signed in, and the `exec` permission.
 */

import { resolve } from "node:path";
import {
	defineManifest,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionPanel,
} from "@hansjm10/volt-coding-agent";
import type { UiNode } from "@hansjm10/volt-protocol";
import { type GhRunner, GitHubTracker, type Tracker } from "./github.ts";
import { Orchestrator, type OrchestratorSnapshot, type Workspaces } from "./orchestrator.ts";
import { issueBranch, issueWorktree } from "./phase.ts";
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
	const merging =
		config.merge.mode === "auto"
			? `merges approved pull requests whose checks pass (${config.merge.method})`
			: `labels approved pull requests' issues "${config.merge.readyLabel}" for a human to merge`;
	const confirmed = await ctx.ui.confirm(
		"Start the issue orchestrator?",
		`It works open issues labeled ${config.tracker.labels.join(" + ")} in ${config.tracker.repo ?? "this repository"}, including the ones its agents file (also labeled "${config.tracker.filedLabel}"), with up to ${config.agent.maxConcurrent} agents at once, and ${merging}.`,
		{ signal: ctx.signal },
	);
	if (!confirmed) return undefined;

	const controller = new AbortController();
	let workId: string | undefined;
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
			const worktree =
				existing ??
				(await ctx.worktrees.create({
					name,
					branch: issueBranch(issue.number),
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
					...(workId === undefined ? {} : { parentWorkId: workId }),
				});
				return { id: run.id, ended: run.ended };
			},
			cancel: (id) => ctx.subagents.cancel(id),
		},
		workspaces,
		onChange: (snapshot) => ctx.ui.setPanel("orchestrator", panel(snapshot)),
	});

	await ctx.startWork(
		"orchestrator",
		{ title: `Orchestrate issues labeled ${config.tracker.labels.join(" + ")}`, input: { workflow: path } },
		async (work) => {
			workId = work.workId;
			// Cancelling the work, or the conversation's end, stops the loop.
			const cancel = () => controller.abort();
			work.signal.addEventListener("abort", cancel, { once: true });
			ctx.signal.addEventListener("abort", cancel, { once: true });
			const report = setInterval(() => work.progress({ text: summary(orchestrator.snapshot()) }), 5_000);
			try {
				await orchestrator.run(controller.signal);
				const final = orchestrator.snapshot();
				return {
					outcome: work.signal.aborted ? "cancelled" : "completed",
					result: { summary: summary(final) },
				};
			} finally {
				clearInterval(report);
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

function minutes(since: number): string {
	return `${Math.max(0, Math.round((Date.now() - since) / 60_000))}m`;
}

/** The status panel: what runs, waits, retries, and was handed to a human. */
function panel(snapshot: OrchestratorSnapshot): ExtensionPanel {
	const sections: Array<{ key: string; title: string; children: UiNode[] }> = [];
	const table = (key: string, headers: string[], rows: Array<{ key: string; cells: string[] }>): UiNode => ({
		type: "table",
		key,
		columns: headers.map((header) => ({ header })),
		rows,
	});
	if (snapshot.error)
		sections.push({
			key: "error",
			title: "Error",
			children: [{ type: "text", text: snapshot.error, token: "error" }],
		});
	if (snapshot.running.length > 0) {
		sections.push({
			key: "running",
			title: "Running",
			children: [
				table(
					"running",
					["Issue", "Role", "For"],
					snapshot.running.map((run) => ({
						key: String(run.issue),
						cells: [`#${run.issue} ${run.title}`, run.role, minutes(run.startedAt)],
					})),
				),
			],
		});
	}
	const noted = (key: string, title: string, rows: readonly { issue: number; title: string; reason: string }[]) => {
		if (rows.length === 0) return;
		sections.push({
			key,
			title,
			children: [
				table(
					key,
					["Issue", "Why"],
					rows.map((row) => ({ key: String(row.issue), cells: [`#${row.issue} ${row.title}`, row.reason] })),
				),
			],
		});
	};
	noted("waiting", "Waiting", snapshot.waiting);
	noted(
		"retrying",
		"Retrying",
		snapshot.retrying.map((retry) => ({
			issue: retry.issue,
			title: retry.title,
			reason: `${retry.failures} failed: ${retry.error}`,
		})),
	);
	noted("handoff", "Handed to a human", snapshot.handedOff);
	noted("finished", "Finished", snapshot.finished.slice(0, 5));
	const open = snapshot.running.flatMap((run) =>
		run.runId === undefined
			? []
			: [
					{
						id: `open-${run.issue}`,
						label: `Open #${run.issue}`,
						intent: { type: "open_work", input: { workId: run.runId } },
					},
				],
	);
	const command = (id: string, label: string, argument: string) => ({
		id,
		label,
		intent: { type: `extension.command.${manifest.id}.${COMMAND}`, input: { arguments: argument } },
	});
	return {
		title: "Issue orchestrator",
		node: {
			type: "card",
			key: "orchestrator",
			title: snapshot.repo ?? "Issue orchestrator",
			badges: [
				{ label: `${snapshot.running.length} running`, token: snapshot.running.length > 0 ? "accent" : "muted" },
				{ label: `${snapshot.totals.runs} runs` },
				{ label: `$${snapshot.totals.cost.toFixed(2)}` },
			],
			sections:
				sections.length > 0
					? sections
					: [{ key: "idle", children: [{ type: "text", text: "No labeled issues need work.", token: "muted" }] }],
			actions: [...open.slice(0, 4), command("refresh", "Refresh", "refresh"), command("stop", "Stop", "stop")],
		},
	};
}
