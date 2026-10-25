import { StringEnum } from "@hansjm10/volt-ai";
import {
	defineManifest,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	truncateHead,
} from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";
import { AUDIT_REPORT_LIMIT, type AuditOptions, runAudit } from "./auditor.ts";
import {
	type Audit,
	assertCompletable,
	createGoal,
	emptyState,
	type GoalMode,
	type GoalState,
	goalSummary,
	ProposalSchema,
	restoreState,
	STATE_ENTRY,
	updateTask,
} from "./state.ts";

export const manifest = defineManifest({
	id: "goal",
	displayName: "Goal (POC)",
	description: "Confirmed goals, durable task tracking, continuous execution, and independent completion audits.",
	permissions: ["exec", "network", "fs-write", "secrets"],
});

export type AuditRunner = (options: AuditOptions) => Promise<Audit>;

type Sent = Awaited<ReturnType<ExtensionAPI["sendUserMessage"]>>;

/** Why a prompt this extension sent starts no run: the host refused it, or another extension's input hook took it. */
function unstarted(sent: Sent): string | undefined {
	if (!sent.success) return sent.error.split("\n", 1)[0].slice(0, 500);
	return sent.outcome === "handled" ? "another extension handled its prompt" : undefined;
}

/** How a revoked settlement or continuation leaves the goal, by its signal's reason. */
function revoked(reason: unknown): { note: string; status: "paused" | "blocked" } {
	switch (reason) {
		case "failed":
			return { status: "blocked", note: "The automatic continuation failed to start; explicit resume required." };
		case "aborted":
			return { status: "paused", note: "Stopped by an abort; explicit resume required." };
		case "superseded":
			return {
				status: "paused",
				note: "New input, a command, or a session change paused automatic goal execution. Use /goal-resume when ready.",
			};
		case "refused":
			return {
				status: "paused",
				note: "Volt refused the automatic continuation (Plan mode, a review discussion, or a host operation). Use /goal-resume when ready.",
			};
		default:
			return { status: "paused", note: "Continuation cancelled; explicit resume required." };
	}
}

/** Never re-enable an excluded tool or replace a parent override with a native implementation. */
export function auditTools(volt: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">): string[] {
	const active = new Set(volt.getActiveTools());
	return volt
		.getAllTools()
		.filter(
			(tool) => active.has(tool.name) && tool.sourceInfo.source === "builtin" && ["read", "bash"].includes(tool.name),
		)
		.map((tool) => tool.name);
}

function bounded(text: string, maxBytes = 24_000): string {
	const cut = truncateHead(text, { maxBytes, maxLines: 500 });
	return (
		cut.content + (cut.truncated ? "\n[Summary truncated; inspect individual tasks with goal_status(taskId).]" : "")
	);
}

function result(text: string) {
	return { content: [{ type: "text" as const, text: bounded(text) }] };
}

const EXECUTION = [
	"Work only on the user-confirmed goal below, under the existing project instructions and tool permissions.",
	"Use goal_task to record progress and concrete verification evidence. Task status is not proof of completion.",
	"When every task and any background work is finished, call goal_complete alone with your evidence; only the independent auditor can complete the goal.",
	"If blocked, uncertain about authorization, or waiting for the user, call goal_block with the reason instead of looping.",
	"Do not expand the goal. Scope changes require /goal-tweak and another affirmative user confirmation.",
].join("\n");

/** The injected runner is a test seam; production always creates the independent SDK session. */
export function registerGoal(volt: ExtensionAPI, auditRunner: AuditRunner = runAudit): void {
	let state = emptyState();
	let tail = Promise.resolve();
	let faulted = false;
	let retired = false;
	let epoch = 0;
	let control = new AbortController();
	let proposing = false;
	let auditing: Promise<Audit> | undefined;
	let contextFiles: AuditOptions["contextFiles"] = [];
	let unwatchSettlement: (() => void) | undefined;
	// The latest foreground operation this instance saw start, until it settles. Retries and queued successors of one
	// operation share its signal. agent_settled arrives after the operation ended, possibly after a newer one started.
	let run: AbortSignal | undefined;
	let ended: AbortSignal | undefined;
	const clearSettlementWatch = () => {
		unwatchSettlement?.();
		unwatchSettlement = undefined;
	};

	const invalidate = () => {
		clearSettlementWatch();
		epoch++;
		control.abort();
		control = new AbortController();
	};
	const ensureCurrent = (expected: number, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		if (retired || faulted || expected !== epoch)
			throw new Error("Goal operation is no longer current; inspect /goal-status.");
	};
	const show = (ctx: ExtensionContext) => {
		if (retired) return;
		const goal = state.goal;
		ctx.ui.setStatus(
			"goal",
			faulted
				? "Goal: persistence failed"
				: state.draft
					? "Goal: draft awaiting proposal"
					: goal
						? `Goal: ${goal.status}`
						: undefined,
		);
		ctx.ui.setPanel(
			"goal",
			goal
				? {
						title: `Goal: ${goal.status}`,
						node: {
							type: "text",
							text: [
								goal.objective.slice(0, 300),
								...goal.tasks.slice(0, 6).map((task) => `${task.id}. [${task.status}] ${task.title.slice(0, 100)}`),
								...(goal.tasks.length > 6 ? [`${goal.tasks.length - 6} more tasks; /goal-status`] : []),
								goal.note.slice(0, 300),
							]
								.filter(Boolean)
								.join("\n"),
						},
					}
				: undefined,
		);
	};
	// Serialize the whole read/modify/append transaction, not merely its append. Parallel tool calls cannot lose updates.
	const change = (
		ctx: ExtensionContext,
		update: (current: GoalState) => GoalState | undefined,
		expected = epoch,
		closing = false,
	) => {
		const write = tail.then(async () => {
			if (!closing) ensureCurrent(expected);
			if (faulted) throw new Error("Goal persistence failed; reload before resuming.");
			const next = update(state);
			if (!next) return;
			const committed = { ...next, revision: state.revision + 1 };
			try {
				await volt.appendEntry(STATE_ENTRY, committed);
			} catch (error) {
				faulted = true;
				invalidate();
				show(ctx);
				throw error;
			}
			state = committed;
			show(ctx);
		});
		tail = write.catch(() => {});
		return write;
	};
	const pause = async (
		ctx: ExtensionContext,
		note: string,
		status: "paused" | "blocked" = "paused",
		options: { closing?: boolean; replaceReason?: boolean } = {},
	): Promise<boolean> => {
		invalidate();
		let changed = false;
		await change(
			ctx,
			(current) => {
				const goal = current.goal;
				if (
					!current.draft &&
					(!goal ||
						goal.status === "complete" ||
						(!options.replaceReason && (goal.status === "blocked" || goal.status === "paused")))
				)
					return;
				changed = true;
				return { ...current, draft: null, goal: goal && goal.status !== "complete" ? { ...goal, status, note } : goal };
			},
			epoch,
			options.closing,
		);
		return changed;
	};
	const restore = async (ctx: ExtensionContext) => {
		invalidate();
		// Tree navigation and session start run no turn; a settlement skipped by the branch change cannot clear it.
		run = undefined;
		await tail;
		try {
			state = restoreState(ctx.sessionManager.getBranch());
			faulted = false;
			if (state.goal?.status === "active" || state.goal?.status === "auditing" || state.draft) {
				await pause(ctx, "Interrupted or restored goal. Use /goal-resume to continue; drafts require /goal again.");
			}
			show(ctx);
		} catch (error) {
			faulted = true;
			state = emptyState();
			show(ctx);
			throw error;
		}
	};
	volt.on("session_start", async (_event, ctx) => {
		await restore(ctx);
	});
	volt.on("session_tree", async (_event, ctx) => {
		await restore(ctx);
	});
	volt.on("session_before_tree", async (_event, ctx) => {
		await pause(ctx, "Paused for branch navigation.");
	});
	volt.on("session_before_switch", async (_event, ctx) => {
		await pause(ctx, "Paused for session switch.");
	});
	volt.on("session_before_fork", async (_event, ctx) => {
		await pause(ctx, "Paused for session fork.");
	});
	volt.on("session_shutdown", async (_event, ctx) => {
		if (retired) return;
		retired = true;
		try {
			await pause(ctx, "Session or extension stopped. Use /goal-resume to continue.", "paused", { closing: true });
		} finally {
			await auditing?.catch(() => {});
			ctx.ui.setStatus("goal", undefined);
			ctx.ui.setPanel("goal", undefined);
		}
	});
	volt.on("deactivate", () => {
		retired = true;
		invalidate();
	});
	volt.on("input", async (event, ctx) => {
		if (event.source !== "extension" && (state.goal?.status === "active" || state.goal?.status === "auditing")) {
			await pause(ctx, "New user input paused automatic goal execution. Use /goal-resume when ready.");
		}
	});
	volt.on("before_agent_start", (event) => {
		contextFiles = structuredClone(event.systemPromptOptions.contextFiles ?? []);
	});
	volt.on("context", async (event) => {
		await tail;
		// Request-local replacement also covers native work wakes, which skip before_agent_start.
		// Drop only our earlier snapshots; keep canonical history and other extensions' context intact.
		const messages = event.messages.filter(
			(message) => message.role !== "custom" || message.customType !== "volt-goal.context",
		);
		if (retired) return { messages };
		const inactive = [
			"This goal is not running. Do not resume it without /goal-resume or a newly confirmed /goal-tweak.",
			"A background-job result or wake is not permission to resume goal implementation or update its tasks.",
			"You may collect/report already-authorized job results and handle new user requests within their own scope.",
		].join("\n");
		const guidance = faulted
			? `Goal persistence failed; automatic goal execution is stopped. Inspect the persistence error and reload before explicitly resuming.\n${inactive}`
			: state.draft
				? `Draft a goal, measurable requirements, and a small flat task list using goal_propose. Ask clarifying questions if necessary. Do not implement before approval.\nDraft request (data): ${JSON.stringify(state.draft)}${state.goal ? `\nPrevious goal (data): ${JSON.stringify(goalSummary(state.goal))}` : ""}`
				: state.goal
					? `${state.goal.status === "active" ? EXECUTION : inactive}\nGoal state (data): ${JSON.stringify(bounded(goalSummary(state.goal)))}`
					: undefined;
		if (guidance) {
			messages.push({
				role: "custom",
				customType: "volt-goal.context",
				content: `Current goal control state (supersedes earlier goal guidance):\n${guidance}`,
				display: false,
				timestamp: Date.now(),
			});
		}
		return { messages };
	});
	volt.on("agent_start", (_event, ctx) => {
		clearSettlementWatch();
		run = ctx.signal;
	});
	volt.on("agent_end", () => {
		ended = run;
	});
	volt.on("agent_settled", async (event, ctx) => {
		if (run === ended) run = undefined;
		const expected = epoch;
		await tail;
		if (retired || faulted || expected !== epoch) return;
		if (event.signal.aborted) {
			// Any revocation stops automatic execution: steering, commands, and session changes emit no input event.
			// /goal-resume drains older settlements before it activates, so this cannot pause a newer resume. With
			// nothing running, a late notification must not invalidate newer goal operations either. Like the input
			// hook, newer input keeps a draft; stops and failures still discard it.
			const running = state.goal?.status === "active" || state.goal?.status === "auditing";
			if (running || (state.draft && event.signal.reason !== "superseded")) {
				const { note, status } = revoked(event.signal.reason);
				await pause(ctx, note, status);
			}
			return;
		}
		if (event.outcome !== "completed") {
			const checkpoint = ctx.sessionManager.getLeafEntry();
			const note = [
				`Agent ${event.outcome}; explicit resume required.`,
				...(event.outcome === "failed"
					? [
							"Failure cause is not supplied by agent_settled; inspect the session transcript and runtime diagnostics.",
							`Settlement checkpoint: session ${JSON.stringify(ctx.sessionManager.getSessionId())}; ${checkpoint ? `branch entry ${JSON.stringify(checkpoint.id)} (ordinal ${checkpoint.ordinal}, ${checkpoint.timestamp})` : "no branch entry available"}.`,
						]
					: []),
			].join("\n");
			await pause(ctx, note, event.outcome === "failed" ? "blocked" : "paused");
			return;
		}
		if (state.goal?.status === "active" && !state.draft && !ctx.hasPendingMessages()) {
			// Keep watching through preflight/receipt persistence, until the new run actually starts.
			clearSettlementWatch();
			const cancelled = () => {
				if (retired || faulted || expected !== epoch) return;
				const { note, status } = revoked(event.signal.reason);
				void pause(ctx, note, status).catch((error: unknown) =>
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"),
				);
			};
			event.signal.addEventListener("abort", cancelled, { once: true });
			unwatchSettlement = () => event.signal.removeEventListener("abort", cancelled);
			return {
				prompt:
					"Continue the confirmed goal using the current goal state. Make concrete progress, request the independent completion audit when done, or call goal_block if user input or authorization is needed.",
			};
		}
	});

	// A running command counts as conversation activity, so ctx.isIdle() is always false here, and ctx.abort() also
	// cancels every running background job. Abort only a live foreground run, then wait for any operation to finish.
	const stopRun = async (ctx: ExtensionCommandContext) => {
		if (run && !run.aborted) ctx.abort();
		await ctx.waitForIdle();
	};
	const startDraft = async (args: string, ctx: ExtensionCommandContext, mode: GoalMode, revise: boolean) => {
		if (!ctx.hasUI || ctx.invokedBy !== "local") {
			ctx.ui.notify("Goal drafting requires a local UI and affirmative user approval.", "warning");
			return;
		}
		if (revise && !state.goal) throw new Error("No goal to tweak.");
		await pause(ctx, "Paused while drafting a goal.");
		await stopRun(ctx);
		const expected = epoch;
		const signal = AbortSignal.any([ctx.signal, control.signal]);
		let request = args.trim();
		if (!request) {
			const values = await ctx.ui.form(
				{
					title: revise ? "Tweak the goal" : mode === "ordered" ? "Draft an ordered goal" : "Draft a goal",
					fields: [
						{
							kind: "string",
							id: "objective",
							label: revise ? "What should change?" : "What should be achieved?",
							required: true,
							multiline: true,
							maxLength: 8000,
						},
						{
							kind: "string",
							id: "requirements",
							label: "Success criteria and constraints",
							multiline: true,
							maxLength: 4000,
						},
					],
				},
				{ signal },
			);
			if (!values || typeof values.objective !== "string" || !values.objective.trim()) return;
			request =
				`${values.objective.trim()}\n${typeof values.requirements === "string" ? values.requirements : ""}`.trim();
		}
		ensureCurrent(expected, signal);
		if (request.length > 12_000) throw new Error("Keep the draft request below 12,000 characters.");
		await change(ctx, (current) => ({ ...current, draft: { request, mode, revise } }), expected);
		ensureCurrent(expected, signal);
		const reason = unstarted(
			await volt.sendUserMessage(
				"Help draft the requested goal. Call goal_propose for the user's approval; do not implement it yet.",
			),
		);
		if (reason === undefined || retired || faulted || expected !== epoch) return;
		await pause(ctx, `Goal drafting could not start: ${reason}`);
		ctx.ui.notify(`Goal drafting could not start: ${reason}`, "warning");
	};
	volt.registerCommand("goal", {
		description: "Draft a goal for confirmation",
		handler: (args, ctx) => startDraft(args, ctx, "regular", false),
	});
	volt.registerCommand("sisyphus", {
		description: "Draft a goal with ordered steps",
		handler: (args, ctx) => startDraft(args, ctx, "ordered", false),
	});
	volt.registerCommand("goal-tweak", {
		description: "Pause and draft a revised goal for confirmation",
		handler: (args, ctx) => startDraft(args, ctx, state.goal?.mode ?? "regular", true),
	});
	volt.registerCommand("goal-pause", {
		description: "Pause the goal and stop its current run or audit",
		handler: async (_args, ctx) => {
			await pause(ctx, "Paused by the user.");
			await stopRun(ctx);
		},
	});
	volt.registerCommand("goal-resume", {
		description: "Resume the previously confirmed goal",
		handler: async (_args, ctx) => {
			if (ctx.invokedBy !== "local") {
				ctx.ui.notify("Resuming a goal requires a local command.", "warning");
				return;
			}
			if (state.goal?.status === "active" || state.goal?.status === "auditing")
				throw new Error("The goal is already running; pause it first.");
			// Older settlements, which this command's input revoked, pause first; none can revoke the resume after it.
			await ctx.waitForIdle();
			invalidate();
			const expected = epoch;
			await change(
				ctx,
				(current) => {
					if (!current.goal || current.goal.status === "complete")
						throw new Error("There is no unfinished confirmed goal.");
					if (current.draft) throw new Error("Finish or pause the draft before resuming.");
					return { ...current, goal: { ...current.goal, status: "active", note: "" } };
				},
				expected,
			);
			ensureCurrent(expected, ctx.signal);
			const reason = unstarted(
				await volt.sendUserMessage("Resume the confirmed goal. Follow its current requirements and task state."),
			);
			if (reason === undefined || retired || faulted || expected !== epoch) return;
			const note = `The resumed goal could not start; fix the cause, then use /goal-resume. Cause: ${reason}`;
			await pause(ctx, note, "blocked", { replaceReason: true });
		},
	});
	volt.registerCommand("goal-status", {
		description: "Show the goal, task evidence, and latest audit",
		handler: async (_args, ctx) => {
			await tail;
			await ctx.ui.dialog(
				{
					title: "Goal status",
					body: [{ type: "text", text: bounded(state.goal ? goalSummary(state.goal) : "No confirmed goal.", 16_000) }],
					actions: [{ id: "close", label: "Close" }],
				},
				{ signal: ctx.signal },
			);
		},
	});

	volt.registerTool({
		name: "goal_propose",
		label: "Propose goal",
		description:
			"Propose the requested goal for explicit user confirmation. Only after /goal, /sisyphus, or /goal-tweak. Keep the full proposal below 16 KB.",
		parameters: ProposalSchema,
		async execute(_id, params, toolSignal, _update, ctx) {
			await tail;
			if (!state.draft || proposing)
				throw new Error("No draft is awaiting a proposal, or a proposal is already awaiting approval.");
			const expected = epoch;
			const revision = state.revision;
			const goal = createGoal(params, state.draft.mode);
			const signal = AbortSignal.any([control.signal, ...(toolSignal ? [toolSignal] : [])]);
			ensureCurrent(expected, signal);
			proposing = true;
			try {
				const approved =
					ctx.hasUI &&
					(await ctx.ui.confirm(
						"Approve goal and continuous execution?",
						`${goalSummary(goal)}\n\nExecution has no automatic run, time, or cost cap. Completion runs a separate auditor on your current model. Auditor Bash restrictions are prompt-only, not a sandbox. Use /goal-pause or Escape to stop.`,
						{ signal },
					));
				ensureCurrent(expected, signal);
				await change(
					ctx,
					(current) => {
						if (current.revision !== revision)
							throw new Error("The draft changed while confirmation was open; propose it again.");
						return { ...current, draft: null, goal: approved === true ? goal : current.goal };
					},
					expected,
				);
				return result(
					approved === true
						? "Goal confirmed. Execute the approved tasks and record evidence with goal_task."
						: "Goal was not approved. Do not execute it; the user can draft again with /goal.",
				);
			} finally {
				proposing = false;
			}
		},
	});
	volt.registerTool({
		name: "goal_status",
		label: "Goal status",
		description:
			"Read the goal and task evidence (summary capped at 24 KB/500 lines). Pass taskId to inspect one task in full.",
		parameters: Type.Object({ taskId: Type.Optional(Type.String()) }),
		async execute(_id, params) {
			await tail;
			if (!state.goal) return result("No confirmed goal.");
			if (params.taskId) {
				const task = state.goal.tasks.find((task) => task.id === params.taskId);
				if (!task) throw new Error("Unknown task.");
				return result(JSON.stringify(task));
			}
			return result(goalSummary(state.goal));
		},
	});
	volt.registerTool({
		name: "goal_task",
		label: "Update goal task",
		description:
			"Update an existing approved task. Completion needs concrete evidence; skipping needs a reason. Ordered steps cannot be skipped or completed out of order.",
		parameters: Type.Object({
			id: Type.String(),
			status: StringEnum(["pending", "active", "complete", "skipped"] as const),
			evidence: Type.String({ maxLength: 2000 }),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const expected = epoch;
			await change(
				ctx,
				(current) => {
					ensureCurrent(expected, signal);
					if (!current.goal || current.draft) throw new Error("No active approved goal.");
					return { ...current, goal: updateTask(current.goal, params.id, params.status, params.evidence) };
				},
				expected,
			);
			return result("Task progress saved.");
		},
	});
	volt.registerTool({
		name: "goal_block",
		label: "Block goal",
		description:
			"Stop automatic execution when user input, authorization, or an environment repair is required. Never interpret silence as approval.",
		parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
		async execute(_id, params, _signal, _update, ctx) {
			if (!params.reason.trim()) throw new Error("Explain the blocker.");
			if (!(await pause(ctx, params.reason.trim(), "blocked", { replaceReason: true })))
				throw new Error("No unfinished goal to block.");
			return {
				...result("Goal blocked. Wait for the user to resolve it and use /goal-resume or /goal-tweak."),
				disposition: "stop" as const,
			};
		},
	});
	volt.registerTool({
		name: "goal_complete",
		label: "Audit goal completion",
		description:
			"Request an independent completion audit after every task is complete. This does not self-approve. Report concrete verification evidence, not just a success claim.",
		parameters: Type.Object({ evidence: Type.String({ minLength: 1, maxLength: 8000 }) }),
		async execute(_id, params, toolSignal, onUpdate, ctx) {
			const expected = epoch;
			const signal = AbortSignal.any([control.signal, ...(toolSignal ? [toolSignal] : [])]);
			await change(
				ctx,
				(current) => {
					ensureCurrent(expected, signal);
					if (!current.goal || current.draft) throw new Error("No active approved goal.");
					assertCompletable(current.goal);
					return {
						...current,
						goal: { ...current.goal, status: "auditing", note: "Independent completion audit in progress." },
					};
				},
				expected,
			);
			try {
				if (!ctx.isProjectTrusted()) throw new Error("Completion auditing requires a trusted project.");
				const tools = auditTools(volt);
				if (tools.length === 0)
					throw new Error("No active trusted built-in read/bash tool is available to the auditor.");
				const goal = state.goal;
				if (!goal) throw new Error("Goal disappeared before audit.");
				auditing = auditRunner({
					ctx,
					goal: structuredClone(goal),
					claim: params.evidence,
					thinking: volt.getThinkingLevel(),
					tools,
					contextFiles: structuredClone(contextFiles),
					signal,
					onProgress: (text) => {
						if (!signal.aborted && !retired) onUpdate?.(result(text));
					},
				});
				const reported = await auditing;
				const audit = { ...reported, report: reported.report.slice(0, AUDIT_REPORT_LIMIT) };
				ensureCurrent(expected, signal);
				await change(
					ctx,
					(current) => {
						if (current.goal?.id !== goal.id || current.goal.status !== "auditing")
							throw new Error("Stale audit result.");
						return {
							...current,
							goal: {
								...current.goal,
								audit,
								status: audit.verdict === "approved" ? "complete" : audit.verdict === "error" ? "blocked" : "active",
								note:
									audit.verdict === "approved"
										? "Independent auditor approved completion."
										: "Audit did not approve completion; review its report.",
							},
						};
					},
					expected,
				);
				return {
					...result(`Completion audit: ${audit.verdict}\n${audit.report}`),
					...(audit.verdict === "approved" ? { disposition: "final_response" as const } : {}),
				};
			} catch (error) {
				if (!retired && !faulted && expected === epoch) {
					const report = (error instanceof Error ? error.message : String(error)).slice(0, AUDIT_REPORT_LIMIT);
					await change(
						ctx,
						(current) => ({
							...current,
							goal: current.goal
								? {
										...current.goal,
										status: signal.aborted ? "paused" : "blocked",
										note: signal.aborted
											? "Audit interrupted; explicit resume required."
											: "Audit failed; explicit resume required.",
										audit: {
											verdict: "error",
											report,
											model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable",
										},
									}
								: null,
						}),
						expected,
					);
				}
				throw error;
			} finally {
				auditing = undefined;
			}
		},
	});
}

export default function goalExtension(volt: ExtensionAPI): void {
	registerGoal(volt);
}
