import type { SubagentDefinitionSource } from "./index.ts";

export type SubagentRegistryStatus = "running" | "completed" | "failed" | "aborted";

/** Public snapshot of one delegated run, safe to hand to any runtime in the tree. */
export interface SubagentRegistryRecord {
	id: string;
	/** Registry id of the runtime that started this run; absent for root-session starts. */
	parentId?: string;
	agent: {
		name: string;
		source?: SubagentDefinitionSource;
	};
	/** Delegation path of agent names from the root session down to this run. */
	path: string[];
	/** Bounded task prompt this run was started with. */
	task?: string;
	status: SubagentRegistryStatus;
	startedAt: number;
	finishedAt?: number;
	error?: string;
}

/** Terminal outcome of a followed run, including its bounded final output. */
export interface SubagentFollowResult {
	id: string;
	agent: SubagentRegistryRecord["agent"];
	task?: string;
	status: Exclude<SubagentRegistryStatus, "running">;
	output?: string;
	error?: string;
	startedAt: number;
	finishedAt: number;
}

interface SubagentRegistryEntry {
	id: string;
	/** Monotonic registration order, so listing stays stable within one millisecond. */
	sequence: number;
	parentId: string | undefined;
	agent: SubagentRegistryRecord["agent"];
	path: string[];
	task: string | undefined;
	status: SubagentRegistryStatus;
	startedAt: number;
	finishedAt: number | undefined;
	error: string | undefined;
	output: string | undefined;
	waiters: Array<{ resolve: (result: SubagentFollowResult) => void }>;
}

const REGISTRY_TASK_LIMIT_CHARS = 2_000;
const REGISTRY_OUTPUT_LIMIT_CHARS = 50_000;
const MAX_REGISTRY_RECORDS = 500;
/** Node key representing the root session in the wait-dependency graph. */
const ROOT_NODE = "root";

function boundText(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, Math.max(1, limit - 1))}…`;
}

/**
 * Session-wide index of every delegated subagent run in one runtime tree.
 *
 * The root session's manager owns one registry for its lifetime and every
 * descendant runtime shares it through its subagent context, so any branch can
 * discover sibling/cousin runs and follow their results instead of duplicating
 * work. Completed outputs are retained bounded; waiting on a running run is
 * cycle-checked against parent-awaits-child and active follow edges so a
 * follow can never deadlock the tree.
 */
export class SubagentRegistry {
	private readonly entries = new Map<string, SubagentRegistryEntry>();
	/** Active follow waits, follower node key -> target ids, for deadlock detection. */
	private readonly activeFollows = new Map<string, Set<string>>();
	private nextSequence = 0;

	register(options: { id: string; parentId?: string; agent: SubagentRegistryRecord["agent"]; path: string[] }): void {
		this.entries.set(options.id, {
			id: options.id,
			sequence: this.nextSequence++,
			parentId: options.parentId,
			agent: { ...options.agent },
			path: [...options.path],
			task: undefined,
			status: "running",
			startedAt: Date.now(),
			finishedAt: undefined,
			error: undefined,
			output: undefined,
			waiters: [],
		});
		this.evictOldestTerminal();
	}

	setTask(id: string, task: string): void {
		const entry = this.entries.get(id);
		if (!entry || entry.status !== "running" || entry.task !== undefined) {
			return;
		}
		entry.task = boundText(task, REGISTRY_TASK_LIMIT_CHARS);
	}

	complete(
		id: string,
		status: Exclude<SubagentRegistryStatus, "running">,
		result: { output?: string; error?: string } = {},
	): void {
		const entry = this.entries.get(id);
		if (!entry || entry.status !== "running") {
			return;
		}
		entry.status = status;
		entry.finishedAt = Date.now();
		entry.error = result.error;
		entry.output = result.output === undefined ? undefined : boundText(result.output, REGISTRY_OUTPUT_LIMIT_CHARS);
		const waiters = entry.waiters;
		entry.waiters = [];
		for (const waiter of waiters) {
			waiter.resolve(this.toFollowResult(entry));
		}
	}

	/** All known runs, running first, then newest first — mirrors activity ordering. */
	list(): SubagentRegistryRecord[] {
		return Array.from(this.entries.values())
			.sort((left, right) => {
				if (left.status === "running" && right.status !== "running") return -1;
				if (left.status !== "running" && right.status === "running") return 1;
				return right.sequence - left.sequence;
			})
			.map((entry) => this.toRecord(entry));
	}

	get(id: string): SubagentRegistryRecord | undefined {
		const entry = this.entries.get(id);
		return entry ? this.toRecord(entry) : undefined;
	}

	/**
	 * Return the target run's terminal result, waiting for completion when it is
	 * still running. `followerId` is the registry id of the waiting runtime
	 * (undefined for the root session) and is used to refuse waits that would
	 * deadlock the tree: a run can never complete while one of its ancestors or
	 * (transitively) awaited dependencies is blocked on it.
	 */
	async follow(followerId: string | undefined, targetId: string, signal?: AbortSignal): Promise<SubagentFollowResult> {
		const entry = this.entries.get(targetId);
		if (!entry) {
			const known = Array.from(this.entries.keys());
			throw new Error(
				known.length > 0
					? `Subagent run "${targetId}" is not in the delegation registry. Known runs: ${known.join(", ")}.`
					: `Subagent run "${targetId}" is not in the delegation registry. No runs have been recorded yet.`,
			);
		}
		if (entry.status !== "running") {
			return this.toFollowResult(entry);
		}
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const followerKey = followerId ?? ROOT_NODE;
		if (this.wouldDeadlock(followerKey, targetId)) {
			throw new Error(
				`Following subagent run "${targetId}" would deadlock: its completion depends on the current runtime finishing first. Continue independently instead.`,
			);
		}

		let followTargets = this.activeFollows.get(followerKey);
		if (!followTargets) {
			followTargets = new Set();
			this.activeFollows.set(followerKey, followTargets);
		}
		followTargets.add(targetId);

		try {
			return await new Promise<SubagentFollowResult>((resolve, reject) => {
				const waiter = { resolve: (result: SubagentFollowResult) => resolve(result) };
				const onAbort = () => {
					entry.waiters = entry.waiters.filter((candidate) => candidate !== waiter);
					reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
				};
				waiter.resolve = (result) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(result);
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				entry.waiters.push(waiter);
			});
		} finally {
			followTargets.delete(targetId);
			if (followTargets.size === 0) {
				this.activeFollows.delete(followerKey);
			}
		}
	}

	/**
	 * True when `followerKey` waiting on `targetId` closes a dependency cycle.
	 * Edges point from a node to what its completion depends on: running child
	 * runs (a parent's tool call awaits its children) and active follow targets.
	 */
	private wouldDeadlock(followerKey: string, targetId: string): boolean {
		const visited = new Set<string>();
		const stack = [targetId];
		while (stack.length > 0) {
			const current = stack.pop();
			if (current === undefined || visited.has(current)) {
				continue;
			}
			if (current === followerKey) {
				return true;
			}
			visited.add(current);
			for (const entry of this.entries.values()) {
				if (entry.status === "running" && (entry.parentId ?? ROOT_NODE) === current) {
					stack.push(entry.id);
				}
			}
			const follows = this.activeFollows.get(current);
			if (follows) {
				stack.push(...follows);
			}
		}
		return false;
	}

	private toRecord(entry: SubagentRegistryEntry): SubagentRegistryRecord {
		return {
			id: entry.id,
			...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}),
			agent: { ...entry.agent },
			path: [...entry.path],
			...(entry.task !== undefined ? { task: entry.task } : {}),
			status: entry.status,
			startedAt: entry.startedAt,
			...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
			...(entry.error !== undefined ? { error: entry.error } : {}),
		};
	}

	private toFollowResult(entry: SubagentRegistryEntry): SubagentFollowResult {
		if (entry.status === "running") {
			throw new Error(`Subagent run "${entry.id}" has not completed`);
		}
		return {
			id: entry.id,
			agent: { ...entry.agent },
			...(entry.task !== undefined ? { task: entry.task } : {}),
			status: entry.status,
			...(entry.output !== undefined ? { output: entry.output } : {}),
			...(entry.error !== undefined ? { error: entry.error } : {}),
			startedAt: entry.startedAt,
			finishedAt: entry.finishedAt ?? entry.startedAt,
		};
	}

	private evictOldestTerminal(): void {
		while (this.entries.size > MAX_REGISTRY_RECORDS) {
			let oldestTerminal: SubagentRegistryEntry | undefined;
			for (const entry of this.entries.values()) {
				if (entry.status !== "running") {
					oldestTerminal = entry;
					break;
				}
			}
			if (!oldestTerminal) return;
			this.entries.delete(oldestTerminal.id);
		}
	}
}
