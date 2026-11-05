import { afterAll, describe, expect, it } from "vitest";
import { CodeModeWorkerPool } from "../../src/core/code-mode/pool.ts";
import {
	type CodeModeCall,
	CodeModeCallError,
	type CodeModeScriptFailure,
	type CodeModeScriptRequest,
	type CodeModeScriptResult,
	runCodeModeScript,
} from "../../src/core/code-mode/runtime.ts";

const pool = new CodeModeWorkerPool();
const extraPools: CodeModeWorkerPool[] = [];

afterAll(() => {
	pool.close();
	for (const extra of extraPools) extra.close();
});

function newPool(options: ConstructorParameters<typeof CodeModeWorkerPool>[0]): CodeModeWorkerPool {
	const created = new CodeModeWorkerPool(options);
	extraPools.push(created);
	return created;
}

function run(
	code: string,
	options: Partial<CodeModeScriptRequest> = {},
	target: CodeModeWorkerPool = pool,
): Promise<CodeModeScriptResult> {
	return runCodeModeScript(target, {
		code,
		bindings: options.bindings ?? [{ name: "call", path: ["call"] }],
		onCall: options.onCall ?? (async () => null),
		...options,
	});
}

function failed(result: CodeModeScriptResult): CodeModeScriptFailure {
	if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
	return result;
}

function texts(result: CodeModeScriptResult): string[] {
	return result.output.map((item) => (item.type === "image" ? item.ref : item.text));
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function never(call: CodeModeCall, honorSignal: boolean): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (honorSignal) call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
	});
}

describe("code mode runtime", () => {
	it("runs nested calls concurrently, resolves them in any order, and streams output in order", async () => {
		const streamed: string[] = [];
		let running = 0;
		let maxRunning = 0;
		const result = await run(
			`
			text("start");
			const [slow, fast] = await Promise.all([tools.slow({ n: 1 }), tools.fast({ n: 2 })]);
			console.log(slow, fast);
			return { slow, fast };
		`,
			{
				bindings: [
					{ name: "slow", path: ["slow"] },
					{ name: "fast", path: ["fast"] },
				],
				onCall: async (call) => {
					running++;
					maxRunning = Math.max(maxRunning, running);
					await new Promise((resolve) => setTimeout(resolve, call.binding === "slow" ? 50 : 1));
					running--;
					return `${call.binding}:${String(call.args.n)}`;
				},
				onOutput: (item) => streamed.push(item.type === "image" ? item.ref : item.text),
			},
		);
		expect(result).toMatchObject({ ok: true, hasValue: true, value: { slow: "slow:1", fast: "fast:2" } });
		expect(maxRunning).toBe(2);
		expect(texts(result)).toStrictEqual(["start", "slow:1 fast:2"]);
		expect(streamed).toStrictEqual(texts(result));
		expect(result.calls.map((call) => [call.seq, call.binding, call.status])).toStrictEqual([
			[1, "slow", "completed"],
			[2, "fast", "completed"],
		]);
	});

	it("rejects calls with the kind the handler chose and bounds result size", async () => {
		const result = await run(
			`
			const outcomes = [];
			for (const name of ["blocked", "large"]) {
				try { await tools.call({ name }); } catch (error) { outcomes.push([error.kind, error.reason ?? null, error.message]); }
			}
			return outcomes;
		`,
			{
				limits: { maxScriptValueBytes: 100 },
				onCall: async (call) => {
					if (call.args.name === "blocked") throw new CodeModeCallError("blocked", "denied by policy");
					return "x".repeat(200);
				},
			},
		);
		expect(result).toMatchObject({
			ok: true,
			value: [
				["blocked", null, "denied by policy"],
				["failed", "result_too_large", "the result is 202 bytes encoded, more than the limit of 100"],
			],
		});
		expect(result.calls.map((call) => call.status)).toStrictEqual(["failed", "failed"]);
	});

	it("answers calls whose handler throws values that cannot be converted to a message", async () => {
		const result = await run(
			`
			const messages = [];
			for (const name of ["null-prototype", "throwing-getter"]) {
				try { await tools.call({ name }); } catch (error) { messages.push(error.kind + ": " + error.message); }
			}
			return messages;
		`,
			{
				onCall: async (call) => {
					if (call.args.name === "null-prototype") throw Object.create(null);
					const error = new Error("hidden");
					Object.defineProperty(error, "message", {
						get() {
							throw new Error("getter");
						},
					});
					throw error;
				},
			},
		);
		expect(result).toMatchObject({ ok: true, value: ["failed: unknown error", "failed: unknown error"] });
	});

	it("counts only encoded arguments toward the outstanding-argument limit", async () => {
		// Each call's arguments, {"s":"x..."}, are exactly 1,000 bytes; the limit admits both at once.
		const result = await run(
			"return await Promise.all([tools.call({ s: 'x'.repeat(992) }), tools.call({ s: 'x'.repeat(992) })]);",
			{
				limits: { maxOutstandingArgumentBytes: 2_000 },
				onCall: async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return "ok";
				},
			},
		);
		expect(result).toMatchObject({ ok: true, value: ["ok", "ok"] });
		expect(result.calls.map((call) => call.status)).toStrictEqual(["completed", "completed"]);
	});

	it("fails the script instead of the process when the output handler throws", async () => {
		const result = failed(
			await run("text('a'); text('b'); return 1;", {
				onOutput: () => {
					throw new Error("sink closed");
				},
			}),
		);
		expect(result.failure).toStrictEqual({ kind: "sandbox", reason: "the output handler failed: sink closed" });
		expect(texts(result)[0]).toBe("a");
	});

	it("terminates a script when its call budget runs out", async () => {
		const result = failed(
			await run("try { for (let i = 0; i < 10; i++) await tools.call({ i }); } catch { text('caught'); }", {
				limits: { callBudget: 3 },
			}),
		);
		expect(result.failure).toStrictEqual({ kind: "call_budget", budget: 3 });
		expect(result.calls).toHaveLength(3);
		expect(texts(result)).toStrictEqual([]);
	});

	it("times out, keeps partial output, and records calls that may still apply", async () => {
		const result = failed(
			await run("text('before'); await tools.call({});", {
				timeoutMs: 100,
				limits: { drainMs: 50 },
				onCall: (call) => never(call, false),
			}),
		);
		expect(result.failure).toStrictEqual({ kind: "timeout", timeoutMs: 100 });
		expect(result.started).toBe(true);
		expect(texts(result)).toStrictEqual(["before"]);
		expect(result.calls.map((call) => call.status)).toStrictEqual(["unsettled"]);
	});

	it("keeps an unsettled record unchanged when the call completes after the script returned", async () => {
		const late = deferred<string>();
		const result = failed(
			await run("await tools.call({});", { timeoutMs: 100, limits: { drainMs: 50 }, onCall: () => late.promise }),
		);
		expect(result.calls[0]).toMatchObject({ status: "unsettled" });
		late.resolve("late");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(result.calls[0]).toMatchObject({ status: "unsettled" });
		expect(result.calls[0].error).toBeUndefined();
	});

	it("aborts in-flight calls through their signal", async () => {
		const controller = new AbortController();
		const result = failed(
			await run("text('working'); await tools.call({});", {
				signal: controller.signal,
				onOutput: () => setTimeout(() => controller.abort(), 10),
				onCall: (call) => never(call, true),
			}),
		);
		expect(result.failure).toStrictEqual({ kind: "aborted" });
		expect(texts(result)).toStrictEqual(["working"]);
		expect(result.calls.map((call) => call.status)).toStrictEqual(["cancelled"]);
	});

	it("does not start a script that was aborted before it ran", async () => {
		const result = failed(await run("text('never');", { signal: AbortSignal.abort() }));
		expect(result).toMatchObject({ failure: { kind: "aborted" }, started: false, output: [] });
	});

	it("stops computing scripts by interrupt or by terminating the worker, then runs the next script", async () => {
		const spinning = failed(await run("while (true) {}", { limits: { computeBudgetMs: 150 } }));
		expect(spinning.failure).toStrictEqual({ kind: "compute_budget", budgetMs: 150 });
		// indexOf does not poll the interrupt handler; the watchdog terminates the worker instead.
		const started = performance.now();
		const blocking = failed(
			await run("const s = 'a'.repeat(1e6); return s.indexOf('a'.repeat(1e4) + 'b');", {
				limits: { computeBudgetMs: 150, graceMs: 100 },
			}),
		);
		expect(blocking.failure).toStrictEqual({ kind: "compute_budget", budgetMs: 150 });
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(await run("return 1 + 1;")).toMatchObject({ ok: true, value: 2 });
	});

	it("fails with an output limit and keeps the output retained until then", async () => {
		const result = failed(await run("for (let i = 0; i < 10; i++) text(i);", { limits: { maxOutputItems: 5 } }));
		expect(result.failure).toStrictEqual({ kind: "output_limit" });
		expect(texts(result)).toStrictEqual(["0", "1", "2", "3", "4"]);
	});

	it("reports stalled scripts and syntax errors as script errors", async () => {
		expect(failed(await run("await new Promise(() => {});")).failure).toMatchObject({
			kind: "script_error",
			error: { name: "stalled" },
		});
		expect(failed(await run("let = ;")).failure).toMatchObject({
			kind: "script_error",
			phase: "evaluate",
			error: { name: "SyntaxError" },
		});
	});
});

describe("code mode worker pool", () => {
	it("queues scripts beyond its workers and fails scripts beyond its queue without starting them", async () => {
		const small = newPool({ maxWorkers: 1, maxQueuedScripts: 1 });
		const release = deferred<string>();
		// Started back to back: the worker the first script is waiting for already counts against the cap.
		const first = run("return await tools.call({});", { onCall: () => release.promise }, small);
		const second = run("return 'second';", {}, small);
		const third = failed(await run("return 'third';", {}, small));
		expect(third).toMatchObject({ started: false, failure: { kind: "sandbox" } });
		expect(third.failure.kind === "sandbox" && third.failure.reason).toBe(
			"1 scripts are running and 1 are waiting in this process",
		);
		release.resolve("first");
		expect(await first).toMatchObject({ ok: true, value: "first" });
		expect(await second).toMatchObject({ ok: true, value: "second" });
		expect(small.stats.workers).toBe(1);
	});

	it("gives up waiting for a worker when the script is aborted", async () => {
		const small = newPool({ maxWorkers: 1, maxQueuedScripts: 1 });
		const release = deferred<null>();
		const first = run("await tools.call({});", { onCall: () => release.promise }, small);
		const controller = new AbortController();
		const queued = run("text('never');", { signal: controller.signal }, small);
		controller.abort();
		expect(failed(await queued)).toMatchObject({ started: false, failure: { kind: "aborted" }, output: [] });
		release.resolve(null);
		expect((await first).ok).toBe(true);
	});

	it("gives up without booting a worker when a script is aborted while the engine loads", async () => {
		const cold = newPool({});
		const controller = new AbortController();
		const pending = run("return 1;", { signal: controller.signal }, cold);
		controller.abort();
		expect(failed(await pending)).toMatchObject({ started: false, failure: { kind: "aborted" } });
		// The worker would otherwise boot and be returned to the pool before the result arrived.
		expect(cold.stats).toStrictEqual({ workers: 0, idle: 0, queued: 0 });
	});

	it("ends running scripts when the pool closes", async () => {
		const closing = newPool({});
		const running = run("await tools.call({});", { onCall: () => new Promise(() => {}) }, closing);
		await new Promise((resolve) => setTimeout(resolve, 300));
		closing.close();
		expect(failed(await running).failure).toStrictEqual({
			kind: "sandbox",
			reason: "the code mode worker pool was closed",
		});
	});

	it("stops idle workers after the idle timeout", async () => {
		const idle = newPool({ idleTimeoutMs: 100 });
		expect((await run("return 1;", {}, idle)).ok).toBe(true);
		expect(idle.stats.workers).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(idle.stats.workers).toBe(0);
	});
});
