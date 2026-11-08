import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fc from "fast-check";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type CodeModeImageRef, CodeModeImageStore } from "../../src/core/code-mode/images.ts";
import { MAX_SHOWN_IMAGES } from "../../src/core/code-mode/limits.ts";
import { CodeModeWorker, type CodeModeWorkerListener, CodeModeWorkerPool } from "../../src/core/code-mode/pool.ts";
import type { PreludeConfig } from "../../src/core/code-mode/prelude.ts";
import {
	CODE_MODE_PROTOCOL_VERSION,
	type HostToWorkerMessage,
	type WorkerToHostMessage,
} from "../../src/core/code-mode/protocol.ts";
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
		images: new CodeModeImageStore(),
		...options,
	});
}

const PNG_SIGNATURE = "iVBORw0KGgo=";

/** Retains one image for the call and returns its reference. */
function picture(call: CodeModeCall, data = PNG_SIGNATURE): CodeModeImageRef {
	const [ref] = call.images.add([{ data, mimeType: "image/png" }]);
	return ref;
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

/** A forged message from a worker, or one that fails validation. */
type ForgedMessage = WorkerToHostMessage | "malformed";

/**
 * A pool whose single worker answers `start` with forged messages, standing in for a compromised worker. It
 * implements only what the runtime uses and records whether the runtime released or discarded the worker.
 */
function forgingPool(messagesFor: (id: number) => ForgedMessage[]): { pool: CodeModeWorkerPool; returned: string[] } {
	const returned: string[] = [];
	const worker = {
		control: new SharedArrayBuffer(24),
		alive: true,
		listener: undefined as CodeModeWorkerListener | undefined,
		attach(listener: CodeModeWorkerListener) {
			this.listener = listener;
		},
		detach() {
			this.listener = undefined;
		},
		post(message: HostToWorkerMessage) {
			if (message.type !== "start") return;
			// A macrotask apart, so the host has answered a forged call before the next message arrives.
			const forged = messagesFor(message.id);
			const deliver = (index: number) => {
				if (index >= forged.length) return;
				setImmediate(() => {
					const next = forged[index];
					if (next === "malformed") this.listener?.onMalformed();
					else this.listener?.onMessage(next);
					deliver(index + 1);
				});
			};
			deliver(0);
		},
		terminate() {
			this.alive = false;
		},
	};
	const pool = {
		acquire: async () => worker,
		release: () => returned.push("released"),
		discard: () => returned.push("discarded"),
	} as unknown as CodeModeWorkerPool;
	return { pool, returned };
}

/** Runs `code` on a forging pool's worker, which never runs it; the forged messages decide the outcome. */
function runForged(
	forging: { pool: CodeModeWorkerPool },
	options: Partial<CodeModeScriptRequest> = {},
): Promise<CodeModeScriptResult> {
	return runCodeModeScript(forging.pool, {
		code: "",
		bindings: [{ name: "call", path: ["call"] }],
		onCall: async () => null,
		timeoutMs: 2_000,
		images: new CodeModeImageStore(),
		...options,
	});
}

/** Source of values a script might pass to the script API, from ordinary to hostile. */
const SCRIPT_API_VALUES = [
	"undefined",
	"null",
	"-0",
	"NaN",
	"10n ** 30n",
	'Symbol("s")',
	"function named() {}",
	'"\\ud800 lone surrogate"',
	'"line\\nbreak\\u2028separator"',
	"new Date(0)",
	'new Map([["k", 1]])',
	"new Uint8Array(2)",
	"[1, , 3]",
	"Object.assign([1], { extra: 1 })",
	"Object.create(null)",
	"{ __proto__: { inherited: 1 }, own: 1 }",
	"(() => { const c = { list: [] }; c.list.push(c); return c; })()",
	"(() => { let d = {}; for (let i = 0; i < 70; i++) d = { d }; return d; })()",
	'(() => { const e = new Error("loop"); e.cause = e; return e; })()',
	'Object.defineProperty(new Error("x"), "name", { get() { throw new Error("name getter"); } })',
	'new Proxy({}, { get() { throw new Error("trap"); }, ownKeys() { throw new Error("trap"); }, getPrototypeOf() { throw new Error("trap"); } })',
	"(() => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; })()",
	'{ toString() { throw new Error("toString"); }, valueOf() { throw new Error("valueOf"); } }',
	'{ [Symbol.toPrimitive]() { throw new Error("toPrimitive"); } }',
	'{ get type() { throw new Error("getter"); }, get ref() { throw new Error("getter"); } }',
	'{ type: "image", get ref() { return "r".repeat(65); } }',
	'{ get nested() { tools.call({ from: "getter" }); return 1; } }',
	'{ get printed() { text("from a getter"); return 1; } }',
	"{ get gone() { delete this.later; return 1; }, later: 2 }",
	// A real image reference, which image() shows until the limit.
	"(await tools.picture())",
];

/** Uses of the script API; each `$` is replaced with a value. */
const SCRIPT_API_CALLS = [
	"text($)",
	"console.log($, $)",
	"console.warn($)",
	"console.error($)",
	"console.debug($)",
	"console.info($)",
	"image($)",
	"tools.call($)",
	"tools.call()",
	"tools.nested.deep($)",
	"Reflect.apply(text, undefined, [$])",
	"tools.call.call(null, $)",
	"new tools.call($)",
	"new ToolCallError($, $, $, $)",
	'String(new ToolCallError($, "tool", "failed", $))',
];

/**
 * Patches that persist for the rest of the script. `Promise.prototype.constructor` and `Object.prototype.then`
 * are left alone: they change how `await` itself behaves in any engine.
 */
const SCRIPT_API_PATCHES = [
	'Object.defineProperty(Array.prototype, 0, { configurable: true, get() { return "inherited"; }, set() { throw new Error("setter"); } });',
	'Object.defineProperty(Object.prototype, "get", { configurable: true, value() { throw new Error("descriptor"); } });',
	'JSON.stringify = () => { throw new Error("patched"); };',
	'Array.prototype.push = () => { throw new Error("patched"); };',
	'Array.prototype.join = () => "patched";',
	"Object.keys = () => [];",
	'Map.prototype.set = () => { throw new Error("patched"); };',
	'String.prototype.slice = () => "patched";',
	'Promise.prototype.then = function () { throw new Error("patched"); };',
	'Function.prototype.call = function () { throw new Error("patched"); };',
];

const scriptApiValue = fc.oneof(
	fc.constantFrom(...SCRIPT_API_VALUES),
	fc.jsonValue({ maxDepth: 3 }).map((value) => JSON.stringify(value)),
	fc.constantFrom(0, 63, 64, 65, 1_000, 100_000).map((length) => `"x".repeat(${length})`),
	fc.constantFrom(0, 63, 64, 65).map((length) => `({ type: "image", ref: "r".repeat(${length}) })`),
	// Arguments around the property's 1,000-byte limit, in one-, two-, and four-byte UTF-8 characters.
	fc
		.record({
			unit: fc.constantFrom(["x", 1], ["\\u00e9", 2], ["\\u{1F4A9}", 4] as const),
			delta: fc.integer({ min: -3, max: 3 }),
		})
		.map(({ unit: [char, bytes], delta }) => `({ s: "${char}".repeat(${Math.floor(992 / bytes) + delta}) })`),
);

/** One statement of a generated script; every one catches what it throws. */
const scriptApiStatement = fc.oneof(
	{
		weight: 4,
		arbitrary: fc
			.record({
				call: fc.constantFrom(...SCRIPT_API_CALLS),
				values: fc.array(scriptApiValue, { minLength: 4, maxLength: 4 }),
				awaited: fc.boolean(),
			})
			.map(({ call, values, awaited }) => {
				let next = 0;
				const expression = call.replace(/\$/g, () => values[next++]);
				return awaited
					? `try { await (${expression}); } catch { caught++; }`
					: `try { void (${expression}); } catch { caught++; }`;
			}),
	},
	{
		weight: 1,
		arbitrary: fc.constantFrom(...SCRIPT_API_PATCHES).map((patch) => `try { ${patch} } catch { caught++; }`),
	},
	// Shows a real image reference several times, so scripts reach the limit on shown images.
	{
		weight: 1,
		arbitrary: fc
			.integer({ min: 1, max: 12 })
			.map(
				(times) =>
					`try { const picture = await tools.picture(); for (let i = 0; i < ${times}; i++) image(picture); } catch { caught++; }`,
			),
	},
);

/** Runs `body` in a fresh process with nothing else to keep it alive, after importing the pool and the runtime. */
function runInFreshProcess(body: string): SpawnSyncReturns<string> {
	const poolUrl = new URL("../../src/core/code-mode/pool.ts", import.meta.url).href;
	const runtimeUrl = new URL("../../src/core/code-mode/runtime.ts", import.meta.url).href;
	const imagesUrl = new URL("../../src/core/code-mode/images.ts", import.meta.url).href;
	const program = `
		const { CodeModeWorkerPool } = await import(${JSON.stringify(poolUrl)});
		const { runCodeModeScript } = await import(${JSON.stringify(runtimeUrl)});
		const { CodeModeImageStore } = await import(${JSON.stringify(imagesUrl)});
		${body}
	`;
	return spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 20_000 });
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
		// The timeout includes the wait for a worker. A cold start can take longer than the whole budget on a busy
		// machine, so the script runs on a worker that has already started.
		const warm = newPool({ maxWorkers: 1 });
		expect(await run("return 1;", {}, warm)).toMatchObject({ ok: true, value: 1 });
		const result = failed(
			await run(
				"text('before'); await tools.call({});",
				{ timeoutMs: 500, limits: { drainMs: 50 }, onCall: (call) => never(call, false) },
				warm,
			),
		);
		expect(result.failure).toStrictEqual({ kind: "timeout", timeoutMs: 500 });
		expect(result.started).toBe(true);
		expect(texts(result)).toStrictEqual(["before"]);
		expect(result.calls.map((call) => call.status)).toStrictEqual(["unsettled"]);
	});

	it("keeps an unsettled record unchanged when the call completes after the script returned", async () => {
		const late = deferred<string>();
		// The worker posts the call before the script's result, so the call is in flight when the script returns.
		const result = await run("tools.call({}); return 1;", { limits: { drainMs: 50 }, onCall: () => late.promise });
		expect(result).toMatchObject({ ok: true, value: 1 });
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

	it("cancels in-flight calls at once, even while the VM is stuck in a built-in", async () => {
		const controller = new AbortController();
		let abortedAt = 0;
		let cancelledAt = 0;
		const result = failed(
			await run("tools.call({}); const s = 'a'.repeat(1e6); s.indexOf('a'.repeat(1e4) + 'b');", {
				signal: controller.signal,
				// indexOf does not poll the interrupt handler, so the VM stops only when the grace period ends.
				limits: { graceMs: 1_000 },
				onCall: (call) => {
					setTimeout(() => {
						abortedAt = performance.now();
						controller.abort();
					}, 20);
					return new Promise((_resolve, reject) => {
						call.signal.addEventListener("abort", () => {
							cancelledAt = performance.now();
							reject(call.signal.reason);
						});
					});
				},
			}),
		);
		expect(result.failure).toStrictEqual({ kind: "aborted" });
		expect(cancelledAt - abortedAt).toBeLessThan(300);
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

	it("fails with an output limit when one output item is larger than a message frame", async () => {
		// 600 characters of a two-byte character are 1,200 bytes of UTF-8, over the 1,000-byte frame limit.
		const result = failed(
			await run("text('small'); text('\\u00e9'.repeat(600)); return 1;", { limits: { maxFrameBytes: 1_000 } }),
		);
		expect(result.failure).toStrictEqual({ kind: "output_limit", cause: "output_item" });
		expect(texts(result)).toStrictEqual(["small"]);
	});

	it("fails with an output limit and reuses the worker when the done frame is larger than a message frame", async () => {
		// A well-formed done frame of about 2,000 bytes, over the 1,000-byte frame limit. The VM has ended.
		const payload = JSON.stringify({ ok: true, value: "x".repeat(2_000) });
		const forging = forgingPool((id) => [{ type: "done", id, payload }]);
		const result = failed(await runForged(forging, { limits: { maxFrameBytes: 1_000 } }));
		expect(result.failure).toStrictEqual({ kind: "output_limit", cause: "return_value" });
		expect(forging.returned).toStrictEqual(["released"]);
	});

	it("treats call arguments over the argument limit as a protocol violation", async () => {
		let called = false;
		// Within the coarse check before parsing (limit plus envelope room), but over the limit itself.
		const payload = `{"seq":1,"binding":"call","args":${JSON.stringify({ s: "x".repeat(200) })}}`;
		const result = failed(
			await runForged(
				forgingPool((id) => [{ type: "call", id, payload }]),
				{
					onCall: async () => {
						called = true;
						return null;
					},
					limits: { maxArgumentBytes: 100 },
				},
			),
		);
		expect(result.failure).toStrictEqual({
			kind: "sandbox",
			reason: "protocol violation: call arguments exceed the argument limit",
		});
		expect(called).toBe(false);
	});

	it("fails the script instead of the process when handling a worker message throws", async () => {
		// A payload getter that throws stands in for any bug on the path that handles worker messages.
		const throwing = (id: number): WorkerToHostMessage => ({
			type: "call",
			id,
			get payload(): string {
				throw new Error("handler bug");
			},
		});
		const result = failed(await runForged(forgingPool((id) => [throwing(id)])));
		expect(result.failure).toStrictEqual({
			kind: "sandbox",
			reason: "the host failed while supervising the script: handler bug",
		});
	});

	it("treats hostile worker frames as protocol violations and discards the worker", async () => {
		const call = (id: number, seq: number, binding = "call", args = "{}"): ForgedMessage => ({
			type: "call",
			id,
			payload: `{"seq":${seq},"binding":${JSON.stringify(binding)},"args":${args}}`,
		});
		const failedDone = (error: Record<string, unknown>) =>
			JSON.stringify({
				ok: false,
				phase: "run",
				error: { name: "Error", summary: "Error: x", text: "Error: x", outOfMemory: false, ...error },
			});
		// Each case: the forged messages, the start of the failure reason, and how many calls reach the handler.
		const cases: [(id: number) => ForgedMessage[], string, number][] = [
			[() => ["malformed"], "protocol violation: malformed message", 0],
			[(id) => [{ type: "call", id, payload: "{" }], "protocol violation: invalid call frame", 0],
			[(id) => [call(id, 2)], "protocol violation: call 2 after call 0", 0],
			[(id) => [call(id, 1), call(id, 1)], "protocol violation: call 1 after call 1", 1],
			[(id) => [call(id, 1, "other")], "protocol violation: unknown binding other", 0],
			[
				(id) => [call(id, 1, "call", '{"n":0.1000000000000000055511151231257827}')],
				"protocol violation: invalid call frame",
				0,
			],
			[
				(id) => [{ type: "output", id, payload: '{"type":"console","level":"trace","text":"x"}' }],
				"protocol violation: invalid output frame",
				0,
			],
			[
				(id) => [{ type: "output", id, payload: `{"type":"image","ref":"${"r".repeat(65)}"}` }],
				"protocol violation: invalid output frame",
				0,
			],
			[
				(id) => [{ type: "done", id, payload: failedDone({ summary: "Error: x\nNested tool calls: 0" }) }],
				"protocol violation: error description exceeds its limits",
				0,
			],
			[(id) => [{ type: "done", id, payload: "done" }], "protocol violation: invalid done frame", 0],
		];
		for (const [messagesFor, reason, expectedCalls] of cases) {
			const forging = forgingPool(messagesFor);
			let calls = 0;
			const result = failed(
				await runForged(forging, {
					onCall: async () => {
						calls++;
						return null;
					},
				}),
			);
			expect(result.failure.kind, reason).toBe("sandbox");
			expect(result.failure.kind === "sandbox" && result.failure.reason.startsWith(reason), reason).toBe(true);
			expect(calls, reason).toBe(expectedCalls);
			expect(forging.returned, reason).toStrictEqual(["discarded"]);
		}
	});

	it("runs the host checks for a call in order and ignores messages for other scripts", async () => {
		// A forged call with array arguments fails the last check and is answered, not treated as a violation;
		// a `done` for another script is ignored.
		let called = false;
		const answered = forgingPool((id) => [
			{ type: "done", id: id + 1, payload: '{"ok":true,"value":"another script"}' },
			{ type: "call", id, payload: '{"seq":1,"binding":"call","args":[1]}' },
			{ type: "done", id, payload: '{"ok":true,"value":"this script"}' },
		]);
		const result = await runForged(answered, {
			onCall: async () => {
				called = true;
				return null;
			},
		});
		expect(result).toMatchObject({ ok: true, value: "this script" });
		expect(result.calls).toMatchObject([
			{
				seq: 1,
				status: "failed",
				error: { kind: "invalid_arguments", message: "tool arguments must be an object" },
			},
		]);
		expect(called).toBe(false);
		expect(answered.returned).toStrictEqual(["released"]);
		// The outstanding-argument check comes before the argument check.
		const outstanding = await runForged(
			forgingPool((id) => [
				{ type: "call", id, payload: '{"seq":1,"binding":"call","args":[1]}' },
				{ type: "done", id, payload: '{"ok":true}' },
			]),
			{ limits: { maxOutstandingArgumentBytes: 1 } },
		);
		expect(outstanding.calls).toMatchObject([{ error: { kind: "failed", reason: "limit_exceeded" } }]);
		// The call budget comes before the binding check: the second call exhausts it, so its unknown binding
		// is never examined.
		const budget = forgingPool((id) => [
			{ type: "call", id, payload: '{"seq":1,"binding":"call","args":{}}' },
			{ type: "call", id, payload: '{"seq":2,"binding":"other","args":{}}' },
		]);
		expect(failed(await runForged(budget, { limits: { callBudget: 1 } })).failure).toStrictEqual({
			kind: "call_budget",
			budget: 1,
		});
	});

	it("rejects a call whose arguments would exceed the outstanding-argument limit until earlier calls finish", async () => {
		// Each call's arguments, {"s":"x..."}, are exactly 1,000 bytes; the limit admits one call at a time.
		const result = await run(
			`
			const first = tools.call({ s: 'x'.repeat(992) });
			let second;
			try { second = await tools.call({ s: 'x'.repeat(992) }); } catch (error) { second = [error.kind, error.reason]; }
			await first;
			return [second, await tools.call({ s: 'x'.repeat(992) })];
		`,
			{
				limits: { maxOutstandingArgumentBytes: 1_500 },
				onCall: async (call) => {
					if (call.seq === 1) await new Promise((resolve) => setTimeout(resolve, 50));
					return "ok";
				},
			},
		);
		expect(result).toMatchObject({ ok: true, value: [["failed", "limit_exceeded"], "ok"] });
		expect(result.calls.map((call) => call.status)).toStrictEqual(["completed", "failed", "completed"]);
	});

	it("runs every script in a fresh VM, so nothing a script changes reaches the next one", async () => {
		const single = newPool({ maxWorkers: 1 });
		const changed = await run(
			"globalThis.leak = 1; Array.prototype.push = () => 0; Object.prototype.polluted = 1; tools.extra = 1; return 'changed';",
			{},
			single,
		);
		expect(changed).toMatchObject({ ok: true, value: "changed" });
		const next = await run("return [typeof leak, [].push(1), typeof ({}).polluted, typeof tools.extra];", {}, single);
		expect(next).toMatchObject({ ok: true, value: ["undefined", 1, "undefined", "undefined"] });
		expect(single.stats.workers).toBe(1);
	});

	it("ends stack exhaustion in a catchable error, including source nested deeper than the parser allows", async () => {
		// Runs on a pool worker: the worker's native stack, not the test thread's, decides whether the VM's own stack
		// guard fires first. Parsing deeply nested source overflowed an 8 MB worker stack on Node 24 and 25.
		const result = await run(`
			const probes = [
				() => { function f() { return f() + 1; } f(); },
				() => JSON.parse("[".repeat(100000) + "]".repeat(100000)),
				() => eval("[".repeat(100000) + "]".repeat(100000)),
				() => new Function("return " + "(".repeat(100000) + "1" + ")".repeat(100000))(),
				() => eval("\`\${".repeat(5000) + "1" + "}\`".repeat(5000)),
			];
			const outcomes = [];
			for (const probe of probes) {
				try { probe(); outcomes.push("completed"); } catch (error) { outcomes.push(error.name); }
			}
			return outcomes;
		`);
		expect(result).toMatchObject({
			ok: true,
			value: ["RangeError", "RangeError", "RangeError", "RangeError", "RangeError"],
		});
		const source = failed(await run(`return ${"[".repeat(100_000)}${"]".repeat(100_000)};`));
		expect(source.failure).toMatchObject({ kind: "script_error", phase: "evaluate", error: { name: "RangeError" } });
	});

	it("never ends a script as a sandbox failure, whatever it passes to the script API", async () => {
		// Every host check has a matching prelude check that throws an error the script can catch, so only a forged
		// frame can be a protocol violation.
		await fc.assert(
			fc.asyncProperty(fc.array(scriptApiStatement, { minLength: 1, maxLength: 10 }), async (statements) => {
				const code = `let caught = 0;\n${statements.join("\n")}\nreturn caught;`;
				const result = await run(code, {
					bindings: [
						{ name: "call", path: ["call"] },
						{ name: "nested.deep", path: ["nested", "deep"] },
						{ name: "picture", path: ["picture"] },
					],
					onCall: async (call) => (call.binding === "picture" ? picture(call) : call.args),
					timeoutMs: 20_000,
					limits: { maxArgumentBytes: 1_000 },
				});
				if (!result.ok) throw new Error(`the script failed: ${JSON.stringify(result.failure)}\n${code}`);
				expect(typeof result.value).toBe("number");
			}),
			{ numRuns: 100 },
		);
	}, 120_000);

	it("shows only images the script received in call results, at most the limit", async () => {
		const images = new CodeModeImageStore();
		const result = await run(
			`
			const errors = [];
			// The first call's value is too large, so its image never reaches the script.
			try { await tools.picture({ large: true }); } catch (error) { errors.push(error.reason); }
			try { image({ type: "image", ref: "img_1" }); } catch (error) { errors.push(error.name); }
			// A value shaped like a reference is not one the host issued.
			const forged = await tools.picture({ forged: true });
			try { image(forged); } catch (error) { errors.push(error.name); }
			const picture = (await tools.picture()).found[0];
			for (let i = 0; i <= ${MAX_SHOWN_IMAGES}; i++) {
				try { image(picture); } catch (error) { errors.push(error.name); }
			}
			return [errors, picture.ref];
		`,
			{
				bindings: [{ name: "picture", path: ["picture"] }],
				limits: { maxScriptValueBytes: 1_000 },
				onCall: async (call) => {
					if (call.args.forged) return { type: "image", ref: "img_9" };
					const ref = picture(call);
					return call.args.large ? { ref, padding: "x".repeat(1_000) } : { found: [ref] };
				},
				images,
			},
		);
		expect(result).toMatchObject({
			ok: true,
			value: [["result_too_large", "TypeError", "TypeError", "RangeError"], "img_2"],
		});
		expect(result.output).toStrictEqual(
			Array.from({ length: MAX_SHOWN_IMAGES }, () => ({ type: "image", ref: "img_2" })),
		);
		expect([images.has("img_1"), images.has("img_2")]).toStrictEqual([false, true]);
	});

	it("keeps a call's images only when its value reaches the script", async () => {
		// Room for three images: the images of calls whose values never reach the script must not hold any of it.
		const imageBytes = Buffer.from(PNG_SIGNATURE, "base64").length;
		const images = new CodeModeImageStore(3 * imageBytes);
		const result = await run(
			`
			const outcomes = [];
			for (const mode of ["large", "throws", "ok", "ok"]) {
				try { outcomes.push((await tools.call({ mode })).ref); } catch (error) { outcomes.push(error.reason ?? error.kind); }
			}
			// A call still running when the script ends is unsettled; its images are dropped too.
			tools.call({ mode: "hangs" });
			return outcomes;
		`,
			{
				limits: { maxScriptValueBytes: 1_000, drainMs: 20 },
				onCall: async (call) => {
					const ref = picture(call);
					if (call.args.mode === "large") return { ref, padding: "x".repeat(1_000) };
					if (call.args.mode === "throws") throw new CodeModeCallError("blocked", "denied after running");
					if (call.args.mode === "hangs") return never(call, false);
					return ref;
				},
				images,
			},
		);
		expect(result).toMatchObject({ ok: true, value: ["result_too_large", "blocked", "img_3", "img_4"] });
		expect(result.calls.map((call) => call.status)).toStrictEqual([
			"failed",
			"failed",
			"completed",
			"completed",
			"unsettled",
		]);
		expect(images.retainedBytes).toBe(2 * imageBytes);
		expect(["img_1", "img_2", "img_3", "img_4", "img_5"].map((ref) => images.has(ref))).toStrictEqual([
			false,
			false,
			true,
			true,
			false,
		]);
		// The unsettled call's image no longer counts: one more image fits.
		expect(() => images.stage().add([{ data: PNG_SIGNATURE, mimeType: "image/png" }])).not.toThrow();
	});

	it("counts the images of calls in flight toward the script's image limit", async () => {
		const images = new CodeModeImageStore(Buffer.from(PNG_SIGNATURE, "base64").length);
		const result = await run(
			`
			const settled = await Promise.allSettled([tools.call({ wait: true }), tools.call({})]);
			return settled.map((outcome) => outcome.status === "fulfilled" ? outcome.value.ref : outcome.reason.reason);
		`,
			{
				onCall: async (call) => {
					const ref = picture(call);
					if (call.args.wait) await new Promise((resolve) => setTimeout(resolve, 50));
					return ref;
				},
				images,
			},
		);
		expect(result).toMatchObject({ ok: true, value: ["img_1", "limit_exceeded"] });
	});

	it("reads each property of a call's value once", async () => {
		let reads = 0;
		const result = await run("return await tools.call({});", {
			onCall: async (call) => ({
				image: picture(call),
				get counted() {
					reads++;
					if (reads > 1) throw new Error("read twice");
					return reads;
				},
			}),
		});
		expect(result).toMatchObject({ ok: true, value: { counted: 1 } });
		expect(reads).toBe(1);
	});

	it("treats an image the script could not have shown as a protocol violation", async () => {
		const shown = (ref: string) => `{"type":"image","ref":"${ref}"}`;
		const notReceived = failed(
			await runForged(forgingPool((id) => [{ type: "output", id, payload: shown("img_1") }])),
		);
		expect(notReceived.failure).toStrictEqual({
			kind: "sandbox",
			reason: "protocol violation: an image reference the script did not receive",
		});
		const tooMany = failed(
			await runForged(
				forgingPool((id) => [
					{ type: "call", id, payload: '{"seq":1,"binding":"call","args":{}}' },
					...Array.from(
						{ length: MAX_SHOWN_IMAGES + 1 },
						(): ForgedMessage => ({ type: "output", id, payload: shown("img_1") }),
					),
				]),
				{ onCall: async (call) => picture(call) },
			),
		);
		expect(tooMany.failure).toStrictEqual({
			kind: "sandbox",
			reason: `protocol violation: more than ${MAX_SHOWN_IMAGES} images shown`,
		});
		expect(tooMany.output).toHaveLength(MAX_SHOWN_IMAGES);
	});

	it("agrees with the prelude on the argument limit when the binding name needs escaping", async () => {
		// {"s":"éé..."} with 500 two-byte characters is exactly 1,008 bytes.
		const result = await run(
			`
			const outcomes = [];
			for (const count of [500, 501]) {
				try { outcomes.push(await tools.read({ s: "\\u00e9".repeat(count) })); } catch (error) { outcomes.push(error.message); }
			}
			return outcomes;
		`,
			{
				bindings: [{ name: 'r\u00ebad"\u0001\u2028x', path: ["read"] }],
				limits: { maxArgumentBytes: 1_008 },
				onCall: async () => "sent",
			},
		);
		expect(result).toMatchObject({ ok: true, value: ["sent", "args: 1010 bytes encoded exceeds the limit of 1008"] });
	});

	it("fails with an output limit and keeps the output retained until then", async () => {
		const result = failed(await run("for (let i = 0; i < 10; i++) text(i);", { limits: { maxOutputItems: 5 } }));
		expect(result.failure).toStrictEqual({ kind: "output_limit", cause: "retained_output" });
		expect(texts(result)).toStrictEqual(["0", "1", "2", "3", "4"]);
	});

	it("reports stalled scripts and syntax errors as script errors", async () => {
		expect(failed(await run("await new Promise(() => {});")).failure).toMatchObject({
			kind: "script_error",
			error: { name: "stalled" },
			stalled: true,
		});
		// Only the host marks a script as stalled; an error the script names "stalled" is an ordinary error.
		const forged = failed(
			await run('const error = new Error("nothing can settle"); error.name = "stalled"; throw error;'),
		).failure;
		expect(forged).toMatchObject({ kind: "script_error", phase: "run", error: { name: "stalled" } });
		expect(forged).not.toHaveProperty("stalled");
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

	it("keeps the process alive while a script runs and lets it exit once its worker is idle", () => {
		// The process must wait for the script's result, then exit on its own while the idle worker is still in
		// the pool.
		const child = runInFreshProcess(`
			const result = await runCodeModeScript(new CodeModeWorkerPool(), {
				code: "const end = Date.now() + 300; while (Date.now() < end) {} return 42;",
				bindings: [],
				onCall: async () => null,
				images: new CodeModeImageStore(),
			});
			console.log(JSON.stringify(result.ok ? result.value : result.failure));
		`);
		expect(child.error).toBeUndefined();
		expect(child.stdout.trim()).toBe("42");
		expect(child.status).toBe(0);
	});

	it("keeps the process alive while it drains calls that outlive the script", () => {
		// The worker is back in the pool once the VM ends, and the call's handler holds nothing: only the run itself
		// can keep the process alive until the drain ends and the result is returned.
		const child = runInFreshProcess(`
			const result = await runCodeModeScript(new CodeModeWorkerPool(), {
				code: "tools.call({}); return 1;",
				bindings: [{ name: "call", path: ["call"] }],
				onCall: () => new Promise(() => {}),
				limits: { drainMs: 200 },
				images: new CodeModeImageStore(),
			});
			console.log(JSON.stringify({ value: result.value, calls: result.calls.map((call) => call.status) }));
		`);
		expect(child.error).toBeUndefined();
		expect(child.stdout.trim()).toBe(JSON.stringify({ value: 1, calls: ["unsettled"] }));
		expect(child.status).toBe(0);
	});

	it("fails closed when a worker reports a different protocol version", async () => {
		const source =
			'import { parentPort } from "node:worker_threads"; parentPort.postMessage({ type: "ready", protocol: 999, engine: "stale" }); setInterval(() => {}, 1000);';
		// The stand-in worker never reads its configuration.
		const prelude: PreludeConfig = {
			maxJsonDepth: 1,
			maxErrorChars: 1,
			maxErrorNameChars: 1,
			maxErrorSummaryChars: 1,
			maxImageRefLength: 1,
			maxShownImages: 1,
			scriptFilename: "script.js",
			scriptPrefixLength: 0,
			preludeFilename: "prelude.js",
		};
		let exited = false;
		const worker = new CodeModeWorker(
			new URL(`data:text/javascript,${encodeURIComponent(source)}`),
			{ wasm: {}, memoryLimitBytes: 1024 * 1024, prelude },
			8,
			() => {
				exited = true;
			},
		);
		await expect(worker.ready).rejects.toThrow(
			`The code mode worker failed to start: protocol 999 does not match ${CODE_MODE_PROTOCOL_VERSION}`,
		);
		await vi.waitFor(() => expect(exited).toBe(true));
		expect(worker.alive).toBe(false);
	});

	it("stops idle workers after the idle timeout", async () => {
		const idle = newPool({ idleTimeoutMs: 100 });
		expect((await run("return 1;", {}, idle)).ok).toBe(true);
		expect(idle.stats.workers).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(idle.stats.workers).toBe(0);
	});
});
