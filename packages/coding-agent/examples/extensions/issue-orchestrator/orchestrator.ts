/**
 * The orchestrator: one deterministic loop that owns every scheduling
 * decision. Each tick re-reads the workflow (keeping the last good one when it
 * breaks), stops the runs of issues that left the workflow, then works each
 * labeled issue by what it needs next (`phase.ts`): it starts an agent of the
 * phase's role in the issue's worktree, merges, or hands the issue to a
 * human. A run that ends wakes the loop at once.
 *
 * Its state is in memory only. GitHub is the source of truth: after a
 * restart the next tick finds each issue's phase again. Bounded by:
 * concurrency limits, `agent.max_attempts` runs of one phase of one head
 * commit, exponential backoff after a failed run, and `review.max_rounds`.
 */

import type { Issue, Tracker } from "./github.ts";
import { reviewMarker } from "./github.ts";
import { inspectIssue, isRoutable, type Phase } from "./phase.ts";
import {
	type Role,
	type RoleLimits,
	renderTemplate,
	type TemplateValue,
	type Workflow,
	type WorkflowConfig,
} from "./workflow.ts";

export interface AgentResult {
	readonly status: "completed" | "failed" | "cancelled";
	readonly output?: string;
	readonly error?: string;
	readonly usage: { readonly tokens: number; readonly cost: number };
}

export interface AgentRun {
	readonly id: string;
	readonly ended: Promise<AgentResult>;
}

/** Runs the agents of the roles. */
export interface Agents {
	start(options: { agent: string; task: string; cwd: string; limits: RoleLimits }): Promise<AgentRun>;
	cancel(id: string): Promise<void>;
}

/** An issue's checkout. */
export interface Workspace {
	readonly path: string;
	readonly branch: string;
}

/** What releasing an issue's checkout did: `retry` while something still holds it, `kept` when it must stay. */
export type ReleaseOutcome = "released" | "retry" | "kept";

/** Prepares the checkout an issue's agents work in, and releases it once the orchestrator is done with the issue. */
export interface Workspaces {
	prepare(issue: Issue, config: WorkflowConfig): Promise<Workspace>;
	/** Release issue `number`'s checkout, keeping its branch; a checkout with changes is `kept`. */
	release(number: number): Promise<ReleaseOutcome>;
}

export interface OrchestratorOptions {
	loadWorkflow(): Promise<Workflow>;
	/** The tracker the workflow names; called each tick, so it may cache. */
	tracker(config: WorkflowConfig): Promise<Tracker>;
	agents: Agents;
	workspaces: Workspaces;
	now?: () => number;
	/** Called whenever what the snapshot shows may have changed. */
	onChange?: (snapshot: OrchestratorSnapshot) => void;
	log?: (line: string) => void;
}

export interface RunningIssue {
	readonly issue: number;
	readonly title: string;
	readonly role: Role;
	readonly runId?: string;
	readonly startedAt: number;
}

export interface RetryingIssue {
	readonly issue: number;
	readonly title: string;
	readonly failures: number;
	readonly dueAt: number;
	readonly error: string;
}

export interface NotedIssue {
	readonly issue: number;
	readonly title: string;
	readonly reason: string;
}

export interface OrchestratorSnapshot {
	readonly repo?: string;
	readonly workflowPath?: string;
	/** Why the last tick could not run in full. */
	readonly error?: string;
	readonly running: readonly RunningIssue[];
	readonly retrying: readonly RetryingIssue[];
	readonly waiting: readonly NotedIssue[];
	readonly handedOff: readonly NotedIssue[];
	readonly finished: readonly NotedIssue[];
	readonly totals: { readonly runs: number; readonly tokens: number; readonly cost: number };
	readonly lastTickAt?: number;
}

interface RunningEntry {
	issue: Issue;
	readonly role: Role;
	readonly startedAt: number;
	runId: string | undefined;
	/** Stopped by the orchestrator (the issue left the workflow, or the orchestrator stopped): no retry. */
	cancelled: boolean;
	ended: Promise<void>;
}

interface HandedOff {
	readonly title: string;
	readonly reason: string;
	/** The label applied: once a human removes it, the issue is worked again. */
	readonly label: string | undefined;
}

const BASE_RETRY_DELAY_MS = 10_000;
/** The shortest pause between ticks, whatever is due. */
const MIN_TICK_DELAY_MS = 1_000;
const MAX_FINISHED = 20;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class Orchestrator {
	private readonly options: OrchestratorOptions;
	private readonly now: () => number;
	private workflow: Workflow | undefined;
	private repo: string | undefined;
	private error: string | undefined;
	private lastTickAt: number | undefined;
	private readonly running = new Map<number, RunningEntry>();
	private readonly retries = new Map<number, RetryingIssue>();
	/** Runs started per phase of an issue's head commit: `<issue>:<role>:<head>`. */
	private readonly attempts = new Map<string, number>();
	private waiting = new Map<number, NotedIssue>();
	private readonly handedOff = new Map<number, HandedOff>();
	/** Issues whose checkouts the orchestrator is done with and has yet to release, with their titles. */
	private readonly pendingReleases = new Map<number, string>();
	private readonly finished: NotedIssue[] = [];
	private totals = { runs: 0, tokens: 0, cost: 0 };
	private signal: AbortSignal | undefined;
	private wakeUp: (() => void) | undefined;
	private woken = false;

	constructor(options: OrchestratorOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	/** Run until `signal` aborts; then stop every run it started and wait for them to end. */
	async run(signal: AbortSignal): Promise<void> {
		this.signal = signal;
		const wake = (): void => this.wake();
		signal.addEventListener("abort", wake, { once: true });
		try {
			while (!signal.aborted) {
				await this.tick();
				if (signal.aborted) break;
				await this.sleep(this.nextDelay());
			}
		} finally {
			signal.removeEventListener("abort", wake);
			await this.stopAll();
			this.emit();
		}
	}

	/** Tick again now, instead of at the next poll. */
	wake(): void {
		this.woken = true;
		this.wakeUp?.();
	}

	snapshot(): OrchestratorSnapshot {
		return {
			...(this.repo === undefined ? {} : { repo: this.repo }),
			...(this.workflow === undefined ? {} : { workflowPath: this.workflow.path }),
			...(this.error === undefined ? {} : { error: this.error }),
			running: [...this.running.values()].map((entry) => ({
				issue: entry.issue.number,
				title: entry.issue.title,
				role: entry.role,
				...(entry.runId === undefined ? {} : { runId: entry.runId }),
				startedAt: entry.startedAt,
			})),
			retrying: [...this.retries.values()],
			waiting: [...this.waiting.values()],
			handedOff: [...this.handedOff.entries()].map(([issue, handoff]) => ({
				issue,
				title: handoff.title,
				reason: handoff.reason,
			})),
			finished: [...this.finished],
			totals: { ...this.totals },
			...(this.lastTickAt === undefined ? {} : { lastTickAt: this.lastTickAt }),
		};
	}

	/** One pass: reload the workflow, stop runs of issues that left it, and act on each labeled issue. */
	async tick(): Promise<void> {
		this.lastTickAt = this.now();
		this.woken = false;
		try {
			this.workflow = await this.options.loadWorkflow();
			this.error = undefined;
		} catch (error) {
			// An invalid reload keeps the last good workflow.
			this.error = `Workflow: ${errorText(error)}`;
		}
		const workflow = this.workflow;
		if (workflow === undefined) return this.emit();
		const config = workflow.config;
		let tracker: Tracker;
		try {
			tracker = await this.options.tracker(config);
			this.repo = tracker.repo;
		} catch (error) {
			this.error = `GitHub: ${errorText(error)}`;
			return this.emit();
		}
		await this.reconcile(tracker, config);
		await this.releaseCheckouts();
		let candidates: Issue[];
		try {
			candidates = await tracker.candidates(config.tracker.labels);
		} catch (error) {
			this.error = `GitHub: ${errorText(error)}`;
			return this.emit();
		}
		const waiting = new Map<number, NotedIssue>();
		this.waiting = waiting;
		const ordered = candidates
			.filter((issue) => isRoutable(issue, config))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.number - right.number);
		// A retry of an issue that left the workflow is not coming.
		const worked = new Set(ordered.map((issue) => issue.number));
		for (const number of this.retries.keys()) {
			if (!worked.has(number) && !this.running.has(number)) this.retries.delete(number);
		}
		for (const issue of ordered) {
			if (this.signal?.aborted) break;
			if (this.running.has(issue.number)) continue;
			const handoff = this.handedOff.get(issue.number);
			if (handoff !== undefined) {
				// Labeled, and a human removed the label: work it again from a clean slate.
				if (handoff.label === undefined || issue.labels.includes(handoff.label.toLowerCase())) continue;
				this.forget(issue.number);
				// Its checkout is wanted again; one already released is created again on its branch.
				this.pendingReleases.delete(issue.number);
			}
			const retry = this.retries.get(issue.number);
			if (retry !== undefined && retry.dueAt > this.now()) continue;
			let phase: Phase;
			try {
				phase = await inspectIssue(tracker, config, issue);
			} catch (error) {
				waiting.set(issue.number, {
					issue: issue.number,
					title: issue.title,
					reason: `GitHub: ${errorText(error)}`,
				});
				continue;
			}
			await this.act(tracker, config, issue, phase, waiting);
			this.emit();
		}
		this.emit();
	}

	private async act(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Phase,
		waiting: Map<number, NotedIssue>,
	): Promise<void> {
		const note = (reason: string): void => {
			waiting.set(issue.number, { issue: issue.number, title: issue.title, reason });
		};
		switch (phase.kind) {
			case "done":
				this.finish(issue, phase.reason);
				return;
			case "wait":
				note(phase.reason);
				return;
			case "handoff":
				await this.handOff(tracker, issue, phase.label, phase.reason);
				return;
			case "merge":
				try {
					await tracker.merge(phase.pr.number, config.merge.method);
					this.log(`#${issue.number}: merged pull request #${phase.pr.number}`);
					this.finish(issue, `merged pull request #${phase.pr.number}`);
				} catch (error) {
					await this.handOff(
						tracker,
						issue,
						config.handoffLabel,
						`Merging pull request #${phase.pr.number} failed: ${errorText(error)}`,
					);
				}
				return;
			default: {
				const key = `${issue.number}:${phase.kind}:${"pr" in phase ? phase.pr.headSha : "-"}`;
				const attempts = this.attempts.get(key) ?? 0;
				if (attempts >= config.agent.maxAttempts) {
					await this.handOff(
						tracker,
						issue,
						config.handoffLabel,
						`The ${phase.kind} agent ran ${attempts} times without moving the issue on.`,
					);
					return;
				}
				const role = config.roles[phase.kind];
				const busy = [...this.running.values()];
				if (busy.length >= config.agent.maxConcurrent) return note("waiting for a free agent slot");
				if (
					role.maxConcurrent !== undefined &&
					busy.filter((entry) => entry.role === phase.kind).length >= role.maxConcurrent
				) {
					return note(`waiting for a free ${phase.kind} slot`);
				}
				this.dispatch(tracker, config, issue, phase, key, attempts);
			}
		}
	}

	/**
	 * Start an agent of `phase`'s role on `issue` in the background; its slot is
	 * taken at once. Only an agent that started counts as an attempt of the
	 * phase (`key`): a checkout that could not be prepared is retried with
	 * backoff, never handed off for it.
	 */
	private dispatch(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Extract<Phase, { kind: Role }>,
		key: string,
		attempts: number,
	): void {
		const role = config.roles[phase.kind];
		const ended = Promise.withResolvers<void>();
		const entry: RunningEntry = {
			issue,
			role: phase.kind,
			startedAt: this.now(),
			runId: undefined,
			cancelled: false,
			ended: ended.promise,
		};
		this.running.set(issue.number, entry);
		this.log(`#${issue.number}: starting ${phase.kind} (${role.agent})`);
		void (async () => {
			let result: AgentResult;
			try {
				let workspace: Workspace;
				try {
					workspace = await this.options.workspaces.prepare(issue, config);
				} catch (error) {
					throw new Error(`setting up the checkout failed: ${errorText(error)}`);
				}
				const task = renderTemplate(
					role.prompt,
					this.variables(tracker, config, issue, phase, workspace, attempts),
				);
				if (entry.cancelled) throw new Error("stopped before it started");
				const run = await this.options.agents.start({
					agent: role.agent,
					task,
					cwd: workspace.path,
					limits: role.limits,
				});
				entry.runId = run.id;
				this.attempts.set(key, attempts + 1);
				this.emit();
				// Stopped while it started.
				if (entry.cancelled) await this.options.agents.cancel(run.id).catch(() => undefined);
				result = await run.ended;
			} catch (error) {
				result = { status: "failed", error: errorText(error), usage: { tokens: 0, cost: 0 } };
			}
			this.ended(entry, result, config);
			ended.resolve();
		})();
	}

	private ended(entry: RunningEntry, result: AgentResult, config: WorkflowConfig): void {
		const number = entry.issue.number;
		if (this.running.get(number) === entry) this.running.delete(number);
		if (entry.runId !== undefined) this.totals.runs += 1;
		this.totals.tokens += result.usage.tokens;
		this.totals.cost += result.usage.cost;
		this.log(`#${number}: ${entry.role} ${result.status}${result.error ? `: ${result.error}` : ""}`);
		if (entry.cancelled) {
			// The issue left the workflow, or the orchestrator stopped: nothing to retry.
		} else if (result.status === "completed") {
			// The next tick reads what the run changed and decides again.
			this.retries.delete(number);
		} else {
			const failures = (this.retries.get(number)?.failures ?? 0) + 1;
			const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (failures - 1), config.agent.maxRetryBackoffMs);
			this.retries.set(number, {
				issue: number,
				title: entry.issue.title,
				failures,
				dueAt: this.now() + delay,
				error: result.error ?? result.status,
			});
		}
		this.emit();
		this.wake();
	}

	/** Stop the runs of issues that closed, or lost a required label or gained an excluded one. */
	private async reconcile(tracker: Tracker, config: WorkflowConfig): Promise<void> {
		for (const entry of [...this.running.values()]) {
			if (entry.cancelled) continue;
			let issue: Issue | undefined;
			try {
				issue = await tracker.issue(entry.issue.number);
			} catch {
				// Unknown for now: keep it running and ask again next tick.
				continue;
			}
			if (issue?.open && isRoutable(issue, config)) {
				entry.issue = issue;
				continue;
			}
			this.log(`#${entry.issue.number}: stopping ${entry.role}: the issue left the workflow`);
			await this.cancel(entry);
		}
	}

	/**
	 * Release the checkouts of issues the orchestrator is done with: handed to a
	 * human (a checkout with changes stays for them), approved, or finished.
	 * One a conversation still holds is tried again next tick.
	 */
	private async releaseCheckouts(): Promise<void> {
		for (const [number, title] of [...this.pendingReleases]) {
			if (this.running.has(number)) {
				this.pendingReleases.delete(number);
				continue;
			}
			let outcome: ReleaseOutcome;
			try {
				outcome = await this.options.workspaces.release(number);
			} catch (error) {
				this.log(`#${number}: releasing the checkout failed: ${errorText(error)}`);
				outcome = "kept";
			}
			if (outcome === "retry") continue;
			this.pendingReleases.delete(number);
			this.log(`#${number} (${title}): ${outcome === "released" ? "released its checkout" : "kept its checkout"}`);
		}
	}

	private async cancel(entry: RunningEntry): Promise<void> {
		entry.cancelled = true;
		if (entry.runId !== undefined) await this.options.agents.cancel(entry.runId).catch(() => undefined);
	}

	private async stopAll(): Promise<void> {
		const entries = [...this.running.values()];
		await Promise.all(entries.map((entry) => this.cancel(entry)));
		await Promise.all(entries.map((entry) => entry.ended));
	}

	private async handOff(tracker: Tracker, issue: Issue, label: string, reason: string): Promise<void> {
		let labeled = false;
		try {
			labeled = await tracker.handOff(issue.number, label, `${reason}\n\n_Volt issue orchestrator_`);
		} catch (error) {
			this.log(`#${issue.number}: handing off failed: ${errorText(error)}`);
		}
		this.handedOff.set(issue.number, { title: issue.title, reason, label: labeled ? label : undefined });
		this.retries.delete(issue.number);
		this.pendingReleases.set(issue.number, issue.title);
		this.log(`#${issue.number}: handed to a human: ${reason}`);
	}

	private finish(issue: Issue, reason: string): void {
		this.forget(issue.number);
		this.pendingReleases.set(issue.number, issue.title);
		if (this.finished.some((entry) => entry.issue === issue.number && entry.reason === reason)) return;
		this.finished.unshift({ issue: issue.number, title: issue.title, reason });
		this.finished.length = Math.min(this.finished.length, MAX_FINISHED);
	}

	/** Drop what the orchestrator remembers of an issue's runs. */
	private forget(number: number): void {
		this.retries.delete(number);
		this.handedOff.delete(number);
		for (const key of [...this.attempts.keys()]) if (key.startsWith(`${number}:`)) this.attempts.delete(key);
	}

	private variables(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Extract<Phase, { kind: Role }>,
		workspace: Workspace,
		attempts: number,
	): Record<string, TemplateValue> {
		const pr = "pr" in phase ? phase.pr : undefined;
		return {
			issue: {
				number: issue.number,
				identifier: issue.identifier,
				title: issue.title,
				body: issue.body,
				url: issue.url,
				labels: [...issue.labels],
			},
			repo: tracker.repo,
			gh: config.ghCommand.join(" "),
			tracker: {
				labels: [...config.tracker.labels],
				filed_labels: [...config.tracker.labels, config.tracker.filedLabel],
			},
			worktree: { path: workspace.path, branch: workspace.branch },
			attempt: attempts === 0 ? null : attempts + 1,
			round: "round" in phase ? phase.round : null,
			reason: "reason" in phase ? phase.reason : null,
			pr: { number: pr?.number ?? null, url: pr?.url ?? null, head_sha: pr?.headSha ?? null },
			review: {
				max_rounds: config.review.maxRounds,
				clean_marker: pr === undefined ? null : reviewMarker(pr.headSha, "clean"),
				changes_marker: pr === undefined ? null : reviewMarker(pr.headSha, "changes"),
			},
			ci: { failing: "failing" in phase ? [...phase.failing] : [] },
		};
	}

	/** Until the next poll, or the next retry that comes due before it. */
	private nextDelay(): number {
		const interval = this.workflow?.config.polling.intervalMs ?? 60_000;
		const now = this.now();
		const dues = [...this.retries.values()].filter((retry) => retry.dueAt > now).map((retry) => retry.dueAt - now);
		return Math.max(MIN_TICK_DELAY_MS, Math.min(interval, ...dues));
	}

	private sleep(ms: number): Promise<void> {
		if (this.woken || this.signal?.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(done, ms);
			function done(): void {
				clearTimeout(timer);
				resolve();
			}
			this.wakeUp = () => {
				this.wakeUp = undefined;
				done();
			};
		});
	}

	private emit(): void {
		try {
			this.options.onChange?.(this.snapshot());
		} catch (error) {
			// An observer that fails does not stop the loop.
			this.log(`status update failed: ${errorText(error)}`);
		}
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}
