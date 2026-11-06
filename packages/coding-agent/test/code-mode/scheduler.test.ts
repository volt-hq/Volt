import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	CodeModeCallNotStartedError,
	CodeModeCallScheduler,
	type CodeModeSchedulingClass,
	CodeModeServerLimiter,
	getCodeModeServerLimiter,
	schedulingClassFor,
} from "../../src/core/code-mode/scheduler.ts";

const MAX_PER_SCRIPT = 3;

/** Waits until every scheduler reaction to the last step has run. */
function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (error: unknown) => void = () => {};
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

type State = "queued" | "running" | "finished" | "cancelled";

interface Call {
	id: number;
	script: number;
	cls: CodeModeSchedulingClass;
	state: State;
	finish: ReturnType<typeof deferred<number>>;
	controller: AbortController;
	outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
}

/**
 * Scripts that share one limiter, and fake calls whose start the scheduler decides and whose end the test decides.
 * Every start is checked against the rules of section 5.13 at that moment.
 */
class Harness {
	readonly calls: Call[] = [];
	readonly violations: string[] = [];
	readonly schedulers: CodeModeCallScheduler[];

	constructor(scripts: number) {
		const limiter = new CodeModeServerLimiter();
		this.schedulers = Array.from(
			{ length: scripts },
			() => new CodeModeCallScheduler({ limiter, maxConcurrentCalls: MAX_PER_SCRIPT }),
		);
	}

	submit(script: number, cls: CodeModeSchedulingClass, signal?: AbortSignal): Call {
		const controller = new AbortController();
		const call: Call = {
			id: this.calls.length,
			script,
			cls,
			// A call whose signal has already aborted is never queued.
			state: signal?.aborted ? "cancelled" : "queued",
			finish: deferred<number>(),
			controller,
			outcome: undefined,
		};
		this.calls.push(call);
		this.schedulers[script]
			.schedule(
				cls,
				() => {
					this.onStart(call);
					return call.finish.promise;
				},
				signal ?? controller.signal,
			)
			.then(
				(value) => {
					call.outcome = { ok: true, value };
				},
				(error: unknown) => {
					call.outcome = { ok: false, error };
				},
			);
		return call;
	}

	running(script?: number): Call[] {
		return this.calls.filter((call) => call.state === "running" && (script === undefined || call.script === script));
	}

	queued(): Call[] {
		return this.calls.filter((call) => call.state === "queued");
	}

	/** Calls to `server` running in the whole process. */
	serverRunning(server: string): number {
		return this.running().filter((call) => call.cls.kind === "server" && call.cls.server === server).length;
	}

	private earlierQueued(call: Call): Call[] {
		return this.calls.filter(
			(other) => other.script === call.script && other.id < call.id && other.state === "queued",
		);
	}

	private onStart(call: Call): void {
		const label = `call ${call.id} (script ${call.script}, ${classLabel(call.cls)})`;
		if (call.state !== "queued") this.violations.push(`${label} started while ${call.state}`);
		const others = this.running(call.script);
		if (others.some((other) => other.cls.kind === "exclusive")) {
			this.violations.push(`${label} started while an exclusive call ran`);
		}
		if (call.cls.kind === "exclusive") {
			if (others.length > 0) this.violations.push(`${label} started while ${others.length} calls ran`);
			if (this.earlierQueued(call).length > 0) this.violations.push(`${label} started before earlier calls`);
		} else {
			if (others.length >= MAX_PER_SCRIPT) this.violations.push(`${label} started beyond the per-script limit`);
			if (call.cls.kind === "server" && this.serverRunning(call.cls.server) >= call.cls.limit) {
				this.violations.push(`${label} started beyond its server's limit`);
			}
			// A call may start ahead of an earlier one only if that one waits for a different, full server.
			for (const earlier of this.earlierQueued(call)) {
				const blocked =
					earlier.cls.kind === "server" &&
					!(call.cls.kind === "server" && call.cls.server === earlier.cls.server) &&
					this.serverRunning(earlier.cls.server) >= earlier.cls.limit;
				if (!blocked) this.violations.push(`${label} started before call ${earlier.id}`);
			}
		}
		call.state = "running";
	}

	/** Whether the rules let a queued call start now; none may be left waiting while it could. */
	startable(call: Call): boolean {
		const running = this.running(call.script);
		const earlier = this.earlierQueued(call);
		if (running.some((other) => other.cls.kind === "exclusive")) return false;
		if (call.cls.kind === "exclusive") return running.length === 0 && earlier.length === 0;
		if (running.length >= MAX_PER_SCRIPT) return false;
		if (earlier.some((other) => other.cls.kind !== "server")) return false;
		if (call.cls.kind !== "server") return true;
		const server = call.cls.server;
		if (this.serverRunning(server) >= call.cls.limit) return false;
		return !earlier.some((other) => other.cls.kind === "server" && other.cls.server === server);
	}

	/**
	 * Finishes a running call. The scheduler frees its slots when it sees the call settle, a moment later, so a
	 * step finishes one call and settles before the next: the harness then never counts a call as finished while
	 * the scheduler still counts it as running.
	 */
	finish(call: Call, fail: boolean): void {
		call.state = "finished";
		if (fail) call.finish.reject(new Error(`call ${call.id} failed`));
		else call.finish.resolve(call.id);
	}

	cancel(call: Call): void {
		call.state = "cancelled";
		call.controller.abort(new Error("cancelled"));
	}
}

function classLabel(cls: CodeModeSchedulingClass): string {
	return cls.kind === "server" ? `server ${cls.server}/${cls.limit}` : cls.kind;
}

const CLASSES: CodeModeSchedulingClass[] = [
	{ kind: "parallel" },
	{ kind: "exclusive" },
	{ kind: "server", server: "a", limit: 1 },
	{ kind: "server", server: "b", limit: 2 },
	{ kind: "server", server: "b", limit: 2 },
];

type Step =
	| { type: "submit"; script: number; cls: number }
	| { type: "finish"; pick: number; fail: boolean }
	| { type: "cancel"; pick: number };

const step: fc.Arbitrary<Step> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({
			type: fc.constant("submit" as const),
			script: fc.nat({ max: 2 }),
			cls: fc.nat({ max: CLASSES.length - 1 }),
		}),
	},
	{ weight: 3, arbitrary: fc.record({ type: fc.constant("finish" as const), pick: fc.nat(), fail: fc.boolean() }) },
	{ weight: 1, arbitrary: fc.record({ type: fc.constant("cancel" as const), pick: fc.nat() }) },
);

describe("code mode call scheduler", () => {
	it("follows the scheduling rules for any sequence of calls, finishes, and cancellations", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 40 }), async (steps) => {
				const harness = new Harness(3);
				for (const current of steps) {
					if (current.type === "submit") {
						harness.submit(current.script, CLASSES[current.cls]);
					} else if (current.type === "finish") {
						const running = harness.running();
						if (running.length > 0) harness.finish(running[current.pick % running.length], current.fail);
					} else {
						const queued = harness.queued();
						if (queued.length > 0) harness.cancel(queued[current.pick % queued.length]);
					}
					await settle();
					expect(harness.violations).toStrictEqual([]);
					for (const call of harness.queued()) {
						expect(harness.startable(call), `call ${call.id} waits although it could start`).toBe(false);
					}
				}
				// Every call that was not cancelled eventually runs.
				while (harness.running().length > 0) {
					harness.finish(harness.running()[0], false);
					await settle();
					for (const call of harness.queued()) {
						expect(harness.startable(call), `call ${call.id} waits although it could start`).toBe(false);
					}
				}
				expect(harness.violations).toStrictEqual([]);
				expect(harness.queued()).toStrictEqual([]);
				for (const call of harness.calls) {
					if (call.state === "cancelled") {
						expect(call.outcome?.ok === false && call.outcome.error).toBeInstanceOf(CodeModeCallNotStartedError);
					} else {
						expect(call.outcome).toBeDefined();
						if (call.outcome?.ok) expect(call.outcome.value).toBe(call.id);
					}
				}
			}),
			{ numRuns: 2000 },
		);
	});

	it("runs an exclusive call after every earlier call has finished and before any later call starts", async () => {
		const harness = new Harness(2);
		// Another script holds the server, so script 0 runs nothing while its first call waits.
		const holder = harness.submit(1, { kind: "server", server: "a", limit: 1 });
		const waiting = harness.submit(0, { kind: "server", server: "a", limit: 1 });
		const exclusive = harness.submit(0, { kind: "exclusive" });
		const later = harness.submit(0, { kind: "parallel" });
		await settle();
		// The exclusive call does not pass the earlier call waiting for its server.
		expect([holder.state, waiting.state, exclusive.state, later.state]).toStrictEqual([
			"running",
			"queued",
			"queued",
			"queued",
		]);
		harness.finish(holder, false);
		await settle();
		expect([waiting.state, exclusive.state, later.state]).toStrictEqual(["running", "queued", "queued"]);
		harness.finish(waiting, false);
		await settle();
		expect([exclusive.state, later.state]).toStrictEqual(["running", "queued"]);
		harness.finish(exclusive, false);
		await settle();
		expect(later.state).toBe("running");
		expect(harness.violations).toStrictEqual([]);
	});

	it("starts calls to other servers and tools while a call waits for its server", async () => {
		const harness = new Harness(1);
		harness.submit(0, { kind: "server", server: "a", limit: 1 });
		const waiting = harness.submit(0, { kind: "server", server: "a", limit: 1 });
		const otherServer = harness.submit(0, { kind: "server", server: "b", limit: 2 });
		const tool = harness.submit(0, { kind: "parallel" });
		await settle();
		expect([waiting.state, otherServer.state, tool.state]).toStrictEqual(["queued", "running", "running"]);
		// The waiting call does not count toward the script's limit, so the script is not full.
		expect(harness.running(0)).toHaveLength(MAX_PER_SCRIPT);
		expect(harness.violations).toStrictEqual([]);
	});

	it("gives a freed server slot to the longest-waiting call that can start, across scripts", async () => {
		const harness = new Harness(3);
		const server: CodeModeSchedulingClass = { kind: "server", server: "a", limit: 1 };
		const holder = harness.submit(0, server);
		// Script 1 waits first but is full when the slot frees; script 2 waits next.
		const fullScriptWaiter = harness.submit(1, server);
		const nextWaiter = harness.submit(2, server);
		const fillers = [0, 1, 2].map(() => harness.submit(1, { kind: "parallel" }));
		await settle();
		expect(fillers.map((call) => call.state)).toStrictEqual(["running", "running", "running"]);
		harness.finish(holder, false);
		await settle();
		expect([fullScriptWaiter.state, nextWaiter.state]).toStrictEqual(["queued", "running"]);
		// Once script 1 has room, its call is the longest-waiting one for the next slot.
		harness.finish(fillers[0], false);
		harness.submit(2, server);
		harness.finish(nextWaiter, false);
		await settle();
		expect(fullScriptWaiter.state).toBe("running");
		expect(harness.violations).toStrictEqual([]);
	});

	it("starts a server call only while fewer calls to that server than its own limit run in the process", async () => {
		const harness = new Harness(2);
		const strict = harness.submit(0, { kind: "server", server: "s", limit: 1 });
		const relaxed = [0, 1, 2].map(() => harness.submit(1, { kind: "server", server: "s", limit: 3 }));
		await settle();
		expect([strict.state, ...relaxed.map((call) => call.state)]).toStrictEqual([
			"running",
			"running",
			"running",
			"queued",
		]);
		const secondStrict = harness.submit(0, { kind: "server", server: "s", limit: 1 });
		harness.finish(relaxed[0], false);
		await settle();
		// With two calls to s running, the limit of 1 holds back the strict call and the limit of 3 admits another.
		expect([secondStrict.state, relaxed[2].state]).toStrictEqual(["queued", "running"]);
		expect(harness.violations).toStrictEqual([]);
	});

	it("rejects calls cancelled before they start, which never run", async () => {
		const harness = new Harness(1);
		const exclusive = harness.submit(0, { kind: "exclusive" });
		const queued = harness.submit(0, { kind: "parallel" });
		const aborted = harness.submit(0, { kind: "parallel" }, AbortSignal.abort(new Error("already aborted")));
		await settle();
		harness.cancel(queued);
		harness.finish(exclusive, false);
		await settle();
		for (const call of [queued, aborted]) {
			expect(call.outcome?.ok === false && call.outcome.error).toBeInstanceOf(CodeModeCallNotStartedError);
		}
		expect(harness.violations).toStrictEqual([]);
		// Cancelling the call at the head of the queue lets the calls behind it start.
		const blocker = harness.submit(0, { kind: "parallel" });
		const barrier = harness.submit(0, { kind: "exclusive" });
		const behind = harness.submit(0, { kind: "parallel" });
		await settle();
		harness.cancel(barrier);
		await settle();
		expect([blocker.state, behind.state]).toStrictEqual(["running", "running"]);
	});

	it("passes on a call's failure, including a synchronous throw, and keeps scheduling", async () => {
		const scheduler = new CodeModeCallScheduler({ limiter: new CodeModeServerLimiter(), maxConcurrentCalls: 1 });
		const thrown = new Error("thrown before returning a promise");
		await expect(
			scheduler.schedule({ kind: "server", server: "a", limit: 1 }, () => {
				throw thrown;
			}),
		).rejects.toBe(thrown);
		const rejected = new Error("rejected");
		await expect(scheduler.schedule({ kind: "parallel" }, () => Promise.reject(rejected))).rejects.toBe(rejected);
		// The failed calls released their script and server slots.
		await expect(scheduler.schedule({ kind: "server", server: "a", limit: 1 }, async () => "next")).resolves.toBe(
			"next",
		);
	});

	it("derives the scheduling class from the binding target and the tool's execution mode", () => {
		expect(schedulingClassFor({ kind: "tool", toolName: "read" }, undefined, 4)).toStrictEqual({ kind: "parallel" });
		expect(schedulingClassFor({ kind: "tool", toolName: "read" }, "parallel", 4)).toStrictEqual({ kind: "parallel" });
		expect(schedulingClassFor({ kind: "tool", toolName: "deploy" }, "sequential", 4)).toStrictEqual({
			kind: "exclusive",
		});
		// MCP tools are limited per server, whatever their direct tool declares.
		expect(schedulingClassFor({ kind: "mcp", server: "github", tool: "x" }, "sequential", 2)).toStrictEqual({
			kind: "server",
			server: "github",
			limit: 2,
		});
	});

	it("shares one server limiter across the process", () => {
		expect(getCodeModeServerLimiter()).toBe(getCodeModeServerLimiter());
	});
});
