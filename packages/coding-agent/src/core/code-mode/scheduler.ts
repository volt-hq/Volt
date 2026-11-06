import type { ToolExecutionMode } from "@hansjm10/volt-agent-core";
import type { CodeModeBindingTarget } from "./bindings.ts";
import { MAX_CONCURRENT_NESTED_CALLS } from "./limits.ts";

/** How a nested call is scheduled (section 5.13 of docs/code-mode-design.md). */
export type CodeModeSchedulingClass =
	/** Runs concurrently with other calls. */
	| { kind: "parallel" }
	/** Starts after every earlier call of its script has finished, runs alone, and holds back later calls. */
	| { kind: "exclusive" }
	/** Starts while fewer than `limit` calls to `server` run in the process. */
	| { kind: "server"; server: string; limit: number };

/**
 * The scheduling class of a call to a binding's target. MCP tools are limited per server, whatever their direct
 * tool declares; other tools run exclusively if they declare `executionMode: "sequential"`.
 */
export function schedulingClassFor(
	target: CodeModeBindingTarget,
	executionMode: ToolExecutionMode | undefined,
	serverLimit: number,
): CodeModeSchedulingClass {
	if (target.kind === "mcp") return { kind: "server", server: target.server, limit: serverLimit };
	return executionMode === "sequential" ? { kind: "exclusive" } : { kind: "parallel" };
}

/** Rejects a call that was cancelled while it waited to start. It never ran. */
export class CodeModeCallNotStartedError extends Error {
	constructor(reason: unknown) {
		super("The call was cancelled before it ran", { cause: reason });
		this.name = "CodeModeCallNotStartedError";
	}
}

/** A call waiting for a server slot, offered one when a slot frees. */
interface ServerWaiter {
	readonly limit: number;
	/** Starts the call if its script lets it start now. */
	offer(): void;
}

/**
 * Counts the running calls to each MCP server across every script in the process, and the calls waiting for a
 * slot in the order they started waiting. Schedulers use it; nothing else should.
 */
export class CodeModeServerLimiter {
	private readonly running = new Map<string, number>();
	private readonly waiting = new Map<string, Set<ServerWaiter>>();

	/** Takes a slot of `server` if fewer than `limit` of its calls run. */
	tryAcquire(server: string, limit: number): boolean {
		const running = this.running.get(server) ?? 0;
		if (running >= limit) return false;
		this.running.set(server, running + 1);
		return true;
	}

	/** Frees a slot of `server` and offers free slots to waiting calls, longest-waiting first. */
	release(server: string): void {
		const running = (this.running.get(server) ?? 1) - 1;
		if (running > 0) this.running.set(server, running);
		else this.running.delete(server);
		const waiting = this.waiting.get(server);
		if (!waiting) return;
		// A call whose script cannot start it now keeps its place; the slot goes to the next one.
		for (const waiter of [...waiting]) {
			if ((this.running.get(server) ?? 0) < waiter.limit) waiter.offer();
		}
	}

	wait(server: string, waiter: ServerWaiter): void {
		let waiting = this.waiting.get(server);
		if (!waiting) {
			waiting = new Set();
			this.waiting.set(server, waiting);
		}
		waiting.add(waiter);
	}

	stopWaiting(server: string, waiter: ServerWaiter): void {
		const waiting = this.waiting.get(server);
		if (!waiting?.delete(waiter)) return;
		if (waiting.size === 0) this.waiting.delete(server);
	}

	/** Calls to `server` running in the process. */
	runningCalls(server: string): number {
		return this.running.get(server) ?? 0;
	}
}

let processLimiter: CodeModeServerLimiter | undefined;

/** The server limiter shared by every script in this process. */
export function getCodeModeServerLimiter(): CodeModeServerLimiter {
	processLimiter ??= new CodeModeServerLimiter();
	return processLimiter;
}

interface QueuedCall {
	readonly cls: CodeModeSchedulingClass;
	readonly run: () => Promise<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	readonly signal: AbortSignal | undefined;
	onAbort: (() => void) | undefined;
	/** Set while the call waits for a server slot. */
	waiter: ServerWaiter | undefined;
}

export interface CodeModeCallSchedulerOptions {
	limiter?: CodeModeServerLimiter;
	/** Calls of the script that may run at once. */
	maxConcurrentCalls?: number;
}

/**
 * Schedules the nested calls of one script (section 5.13 of docs/code-mode-design.md):
 *
 * - At most `maxConcurrentCalls` calls run at once. A call waiting for its server does not count.
 * - Calls start in submission order. A call waiting for a full server holds back later calls to that server only.
 * - An exclusive call starts after every earlier call has finished, runs alone, and holds back every later call.
 * - Calls to an MCP server are limited across the process by the shared limiter. A freed slot goes to the
 *   longest-waiting call that can start; no slot stays free while a call that could use it waits.
 * - A call cancelled while it waits never starts and rejects with `CodeModeCallNotStartedError`.
 */
export class CodeModeCallScheduler {
	private readonly limiter: CodeModeServerLimiter;
	private readonly maxConcurrentCalls: number;
	/** Calls that have not started, in submission order. */
	private readonly queue: QueuedCall[] = [];
	private running = 0;
	private runningExclusive = false;

	constructor(options: CodeModeCallSchedulerOptions = {}) {
		this.limiter = options.limiter ?? getCodeModeServerLimiter();
		this.maxConcurrentCalls = options.maxConcurrentCalls ?? MAX_CONCURRENT_NESTED_CALLS;
	}

	/** Runs `run` once the rules let the call start, and settles like it. */
	schedule<T>(cls: CodeModeSchedulingClass, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new CodeModeCallNotStartedError(signal.reason));
				return;
			}
			const call: QueuedCall = {
				cls,
				run,
				resolve: resolve as (value: unknown) => void,
				reject,
				signal,
				onAbort: undefined,
				waiter: undefined,
			};
			if (signal) {
				call.onAbort = () => this.cancel(call);
				signal.addEventListener("abort", call.onAbort, { once: true });
			}
			this.queue.push(call);
			this.pump();
		});
	}

	/** Starts every queued call the rules allow, in submission order. */
	private pump(): void {
		if (this.runningExclusive) return;
		const starting: QueuedCall[] = [];
		const fullServers = new Set<string>();
		for (const call of [...this.queue]) {
			const { cls } = call;
			if (cls.kind === "exclusive") {
				if (this.queue[0] === call && this.running === 0) starting.push(this.reserve(call));
				break;
			}
			if (this.running >= this.maxConcurrentCalls) break;
			if (cls.kind === "server") {
				// Calls to a server start in submission order: once one waits, later ones wait behind it.
				if (fullServers.has(cls.server) || !this.limiter.tryAcquire(cls.server, cls.limit)) {
					fullServers.add(cls.server);
					this.waitForServer(call, cls.server, cls.limit);
					continue;
				}
			}
			starting.push(this.reserve(call));
		}
		// Started after the scan, so a call that schedules another while starting cannot disturb it.
		for (const call of starting) this.start(call);
	}

	/** Offered a slot of the server `call` waits for; starts it if nothing in its script must start first. */
	private startWaiting(call: QueuedCall, server: string, limit: number): void {
		if (this.runningExclusive || this.running >= this.maxConcurrentCalls) return;
		for (const earlier of this.queue) {
			if (earlier === call) break;
			// Only an earlier call waiting for another, full server may be passed.
			if (
				earlier.cls.kind !== "server" ||
				earlier.cls.server === server ||
				this.limiter.runningCalls(earlier.cls.server) < earlier.cls.limit
			) {
				return;
			}
		}
		if (!this.limiter.tryAcquire(server, limit)) return;
		this.start(this.reserve(call));
	}

	private waitForServer(call: QueuedCall, server: string, limit: number): void {
		call.waiter ??= { limit, offer: () => this.startWaiting(call, server, limit) };
		this.limiter.wait(server, call.waiter);
	}

	/** Removes a call from the queue and counts it as running; its server slot, if any, is already taken. */
	private reserve(call: QueuedCall): QueuedCall {
		this.queue.splice(this.queue.indexOf(call), 1);
		this.running++;
		if (call.cls.kind === "exclusive") this.runningExclusive = true;
		if (call.waiter && call.cls.kind === "server") this.limiter.stopWaiting(call.cls.server, call.waiter);
		if (call.onAbort) call.signal?.removeEventListener("abort", call.onAbort);
		return call;
	}

	private start(call: QueuedCall): void {
		let result: Promise<unknown>;
		try {
			result = Promise.resolve(call.run());
		} catch (error) {
			result = Promise.reject(error);
		}
		result.then(
			(value) => {
				this.finish(call);
				call.resolve(value);
			},
			(error: unknown) => {
				this.finish(call);
				call.reject(error);
			},
		);
	}

	private finish(call: QueuedCall): void {
		this.running--;
		if (call.cls.kind === "exclusive") this.runningExclusive = false;
		if (call.cls.kind === "server") this.limiter.release(call.cls.server);
		this.pump();
	}

	private cancel(call: QueuedCall): void {
		const index = this.queue.indexOf(call);
		if (index === -1) return;
		this.queue.splice(index, 1);
		if (call.waiter && call.cls.kind === "server") this.limiter.stopWaiting(call.cls.server, call.waiter);
		call.reject(new CodeModeCallNotStartedError(call.signal?.reason));
		// A cancelled call may have been holding back the calls behind it.
		this.pump();
	}
}
