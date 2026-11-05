import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeBridgeValue, encodeBridgeValue } from "../../src/core/code-mode/codec.ts";
import {
	type CodeModeBinding,
	PRELUDE_FILENAME,
	type PreludeConfig,
	SCRIPT_FILENAME,
	SCRIPT_PREFIX,
} from "../../src/core/code-mode/prelude.ts";
import {
	type CodeModeOutputItem,
	type CompiledWasm,
	type ParsedDone,
	parseCallPayload,
	parseDonePayload,
	parseOutputPayload,
} from "../../src/core/code-mode/protocol.ts";
import { ScriptVm, type ScriptVmMessage } from "../../src/core/code-mode/vm.ts";
import { bridgeValue, expectedAfterRoundTrip } from "./values.ts";

const MIB = 1024 * 1024;
const PRELUDE: PreludeConfig = {
	maxJsonDepth: 64,
	maxErrorChars: 8192,
	scriptFilename: SCRIPT_FILENAME,
	scriptPrefixLength: SCRIPT_PREFIX.length,
	preludeFilename: PRELUDE_FILENAME,
};

const wasmApi = (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<CompiledWasm> } })
	.WebAssembly;
let wasm: CompiledWasm;

beforeAll(async () => {
	wasm = await wasmApi.compile(await readFile(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")));
});

type CallHandler = (binding: string, args: unknown) => unknown;

interface RunOptions {
	bindings?: CodeModeBinding[];
	onCall?: CallHandler;
	computeBudgetMs?: number;
	memoryLimitBytes?: number;
	maxArgumentBytes?: number;
}

interface RunResult {
	messages: ScriptVmMessage[];
	output: CodeModeOutputItem[];
	calls: { seq: number; binding: string; args: unknown }[];
	end: ScriptVmMessage;
	done: ParsedDone | undefined;
}

/** Runs a script in-process, answering nested calls in the order they arrive. */
async function runScript(code: string, options: RunOptions = {}): Promise<RunResult> {
	const vm = await ScriptVm.boot({ wasm, memoryLimitBytes: options.memoryLimitBytes ?? 64 * MIB, prelude: PRELUDE });
	const messages: ScriptVmMessage[] = [];
	const queue: string[] = [];
	const calls: RunResult["calls"] = [];
	try {
		vm.start(
			{
				code,
				bindings: options.bindings ?? [],
				computeBudgetMs: options.computeBudgetMs ?? 30_000,
				maxReportedRejections: 10,
				maxArgumentBytes: options.maxArgumentBytes ?? MIB,
			},
			(message) => {
				messages.push(message);
				if (message.type === "call") queue.push(message.payload);
			},
		);
		while (!vm.finished) {
			const payload = queue.shift();
			if (payload === undefined) throw new Error("The VM is idle without calls but has not finished");
			const call = parseCallPayload(payload);
			calls.push(call);
			try {
				const value = await (options.onCall ?? (() => null))(call.binding, call.args);
				vm.settle(call.seq, true, encodeBridgeValue(value, "result"));
			} catch (error) {
				vm.settle(call.seq, false, JSON.stringify({ kind: "failed", message: (error as Error).message }));
			}
		}
	} finally {
		vm.dispose();
	}
	const end = messages[messages.length - 1];
	return {
		messages,
		output: messages
			.filter((message) => message.type === "output")
			.map((message) => parseOutputPayload(message.payload)),
		calls,
		end,
		done: end.type === "done" ? parseDonePayload(end.payload) : undefined,
	};
}

function texts(result: RunResult): string[] {
	return result.output.map((item) => (item.type === "image" ? `[image ${item.ref}]` : item.text));
}

function failure(result: RunResult) {
	if (result.done?.ok !== false) throw new Error(`expected a failed script, got ${JSON.stringify(result.end)}`);
	return result.done;
}

describe("code mode VM output", () => {
	it("formats values leniently and keeps console levels", async () => {
		const result = await runScript(`
			text("plain string");
			text({ a: [1, "x", undefined, null], n: -0, big: 12n, nan: NaN });
			text(new Map([["k", 1]]));
			text(new Set([1, 2]));
			text(new Date(0));
			text(new TypeError("bad"));
			text(function named() {});
			const cycle = { name: "c" }; cycle.self = cycle;
			text(cycle);
			text(Symbol("s"));
			text(new Uint8Array([1, 2]));
			text(new (class Point { constructor() { this.x = 1; } })());
			console.log("a", 1, { b: true });
			console.warn("careful");
			console.error("broken");
		`);
		expect(texts(result)).toStrictEqual([
			"plain string",
			'{"a":[1,"x",undefined,null],"n":-0,"big":12n,"nan":NaN}',
			'Map(1) {"k" => 1}',
			"Set(2) {1, 2}",
			"1970-01-01T00:00:00.000Z",
			"TypeError: bad",
			"[Function named]",
			'{"name":"c","self":[Circular]}',
			"Symbol(s)",
			"Uint8Array(2) [1,2]",
			'Point {"x":1}',
			'a 1 {"b":true}',
			"careful",
			"broken",
		]);
		expect(result.output.filter((item) => item.type === "console").map((item) => item.level)).toStrictEqual([
			"log",
			"warn",
			"error",
		]);
	});

	it("returns values through the codec and reports values it cannot represent", async () => {
		expect((await runScript("return { n: 2n ** 70n + 1n, list: [1, 'two'] };")).done).toStrictEqual({
			ok: true,
			hasValue: true,
			value: { n: 2n ** 70n + 1n, list: [1, "two"] },
		});
		expect((await runScript("text('only output');")).done).toStrictEqual({ ok: true, hasValue: false });
		const unrepresentable = failure(await runScript("return { when: new Date(0) };"));
		expect(unrepresentable.error.summary).toBe("TypeError: return value.when: Date is not JSON; use .toISOString()");
	});

	it("round-trips accepted values through the VM exactly", async () => {
		const samples = fc.sample(bridgeValue, { numRuns: 300, seed: 42 });
		const result = await runScript("return await tools.get();", {
			bindings: [{ name: "get", path: ["get"] }],
			onCall: () => samples,
		});
		expect(result.done).toStrictEqual({ ok: true, hasValue: true, value: expectedAfterRoundTrip(samples) });
	});
});

describe("code mode VM bindings", () => {
	it("installs nested bindings and passes arguments", async () => {
		const result = await runScript(
			`
			const a = await tools.read({ path: "a.ts", n: 9007199254740993n });
			const b = await tools.mcp["my-server"]["create.issue"]();
			return [a, b, typeof tools.read, tools.read.name];
		`,
			{
				bindings: [
					{ name: "read", path: ["read"] },
					{ name: "mcp__my-server__create.issue", path: ["mcp", "my-server", "create.issue"] },
				],
				onCall: (binding, args) => ({ binding, args }),
			},
		);
		expect(result.calls.map((call) => call.args)).toStrictEqual([{ path: "a.ts", n: 9007199254740993n }, {}]);
		expect(result.done).toStrictEqual({
			ok: true,
			hasValue: true,
			value: [
				{ binding: "read", args: { path: "a.ts", n: 9007199254740993n } },
				{ binding: "mcp__my-server__create.issue", args: {} },
				"function",
				"read",
			],
		});
	});

	it("rejects arguments the codec cannot encode without issuing a call", async () => {
		const result = await runScript(
			`
			const errors = [];
			for (const args of [{ when: new Date(0) }, [1], "text", { big: "x".repeat(2000) }]) {
				try { await tools.read(args); } catch (error) { errors.push(error.constructor.name + ": " + error.message); }
			}
			return errors;
		`,
			{ bindings: [{ name: "read", path: ["read"] }], maxArgumentBytes: 1000 },
		);
		expect(result.calls).toStrictEqual([]);
		expect(result.done).toStrictEqual({
			ok: true,
			hasValue: true,
			value: [
				"TypeError: args.when: Date is not JSON; use .toISOString()",
				"TypeError: args: tool arguments must be an object, not an array",
				"TypeError: args: tool arguments must be an object",
				"RangeError: args: 2010 bytes encoded exceeds the limit of 1000",
			],
		});
	});

	it("rejects failed calls with a typed ToolCallError", async () => {
		const result = await runScript(
			`
			try { await tools.read({}); } catch (error) {
				return [error instanceof ToolCallError, error instanceof Error, error.name, error.tool, error.kind, error.message];
			}
		`,
			{
				bindings: [{ name: "read", path: ["read"] }],
				onCall: () => {
					throw new Error("missing file");
				},
			},
		);
		expect(result.done).toStrictEqual({
			ok: true,
			hasValue: true,
			value: [true, true, "ToolCallError", "read", "failed", "missing file"],
		});
	});

	it("assigns call numbers after encoding so nested calls keep the order they are posted in", async () => {
		const result = await runScript(
			`
			const outer = tools.a({ get x() { tools.b({}); return 1; } });
			await outer;
		`,
			{
				bindings: [
					{ name: "a", path: ["a"] },
					{ name: "b", path: ["b"] },
				],
			},
		);
		expect(result.calls.map((call) => [call.seq, call.binding])).toStrictEqual([
			[1, "b"],
			[2, "a"],
		]);
	});

	it("keeps the bridge working after a script patches built-ins", async () => {
		const result = await runScript(
			`
			JSON.stringify = () => "patched";
			JSON.parse = () => "patched";
			Array.prototype.push = () => { throw new Error("patched push"); };
			Array.prototype.join = () => "patched";
			Object.keys = () => [];
			Map.prototype.get = () => undefined;
			Map.prototype.set = () => { throw new Error("patched set"); };
			Promise.prototype.then = function () { throw new Error("patched then"); };
			String.prototype.slice = () => "patched";
			const value = await tools.echo({ a: [1, 2], b: "x" });
			console.log("still", value);
			return value;
		`,
			{ bindings: [{ name: "echo", path: ["echo"] }], onCall: (_binding, args) => args },
		);
		expect(texts(result)).toStrictEqual(['still {"a":[1,2],"b":"x"}']);
		expect(result.done).toStrictEqual({ ok: true, hasValue: true, value: { a: [1, 2], b: "x" } });
	});
});

describe("code mode VM failures", () => {
	it("describes uncaught errors with script line and column numbers", async () => {
		// QuickJS attributes property access on a literal null to the function start, so the value is a parameter.
		const error = failure(await runScript("function parse(v) {\n  return v.length;\n}\nparse(null);")).error;
		expect(error.name).toBe("TypeError");
		expect(error.text).toContain("at parse (script.js:2:10)");
		expect(error.text).toContain("at <anonymous> (script.js:4:7)");
		expect(error.text).not.toContain(PRELUDE_FILENAME);
		// The first line shares its line with the wrapper prefix; its columns are mapped back to the script.
		const firstLine = failure(await runScript("const v = null; v.x;")).error;
		const column = Number(/script\.js:1:(\d+)/.exec(firstLine.text)?.[1]);
		expect(column).toBeGreaterThan(15);
		expect(column).toBeLessThanOrEqual(20);
	});

	it("reports syntax errors in the evaluate phase", async () => {
		const done = failure(await runScript("let = ;"));
		expect(done.phase).toBe("evaluate");
		expect(done.error.name).toBe("SyntaxError");
		expect(done.error.text).toContain("script.js:1:7");
	});

	it("describes causes, inner errors, and thrown values that are not errors", async () => {
		const withCause = failure(
			await runScript('throw new Error("outer", { cause: new SyntaxError("inner", { cause: "root" }) });'),
		).error;
		expect(withCause.text).toContain("Caused by: SyntaxError: inner\nCaused by: Thrown string: root");
		const aggregate = failure(await runScript('throw new AggregateError([new Error("a"), 1], "all");')).error;
		expect(aggregate.text).toContain("  [1] Error: a\n  [2] Thrown number: 1");
		expect(failure(await runScript('throw "plain";')).error).toMatchObject({
			name: "thrown string",
			summary: "Thrown string: plain",
		});
		expect(failure(await runScript("throw { code: 1 };")).error.summary).toBe('Thrown object: {"code":1}');
		expect(failure(await runScript("throw null;")).error.summary).toBe("Thrown null");
	});

	it("reports unhandled rejections as warnings and ignores ones handled later", async () => {
		const result = await runScript(`
			Promise.reject(new Error("lost"));
			const later = Promise.reject(new Error("handled"));
			later.catch(() => {});
			text("done");
		`);
		expect(texts(result)).toStrictEqual(["done", "unhandled rejection: Error: lost"]);
		expect(result.done).toStrictEqual({ ok: true, hasValue: false });
	});

	it("detects a script waiting on a promise nothing can settle", async () => {
		const result = await runScript("await new Promise(() => {}); text('never');");
		expect(result.end).toStrictEqual({ type: "stalled" });
	});

	it("stops a script that exhausts its compute budget, which the script cannot catch", async () => {
		const result = await runScript("try { while (true) {} } catch (error) { text('caught'); }", {
			computeBudgetMs: 100,
		});
		expect(result.end).toStrictEqual({ type: "stopped", reason: "compute_budget" });
		expect(result.output).toStrictEqual([]);
	});

	it("keeps out-of-memory catchable and flags it when uncaught", async () => {
		// Distinct strings: QuickJS concatenates with ropes, so doubling one string hits the length limit instead.
		const caught = await runScript(
			"try { const keep = []; while (true) keep.push('x'.repeat(1e5) + keep.length); } catch (error) { return error.name + ': ' + error.message; }",
			{ memoryLimitBytes: 16 * MIB },
		);
		expect(caught.done).toStrictEqual({ ok: true, hasValue: true, value: "InternalError: out of memory" });
		const uncaught = failure(
			await runScript("const keep = []; while (true) keep.push('x'.repeat(1e5) + keep.length);", {
				memoryLimitBytes: 16 * MIB,
			}),
		);
		expect(uncaught.error.outOfMemory).toBe(true);
	});
});

describe("code mode VM engine configuration", () => {
	it("omits WeakRef, module loading, and host globals", async () => {
		const result = await runScript(`
			let imported;
			try { await import("node:fs"); imported = "loaded"; } catch (error) { imported = error.name; }
			return [typeof WeakRef, typeof FinalizationRegistry, typeof process, typeof require, typeof bridge, imported];
		`);
		const value = result.done?.ok ? (result.done.value as string[]) : [];
		expect(value.slice(0, 5)).toStrictEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);
		expect(value[5]).not.toBe("loaded");
	});

	it("seeds Math.random differently in every VM", async () => {
		const values = new Set<unknown>();
		for (let i = 0; i < 4; i++) {
			const result = await runScript("return Math.random();");
			values.add(result.done?.ok ? result.done.value : undefined);
		}
		expect(values.size).toBe(4);
	});

	it("decodes results with the codec inside the VM", async () => {
		const result = await runScript(
			"const v = await tools.get(); return [typeof v.big, v.big === 2n ** 64n + 1n, typeof v.exact, Object.is(v.zero, -0)];",
			{
				bindings: [{ name: "get", path: ["get"] }],
				// A BigInt that a double holds exactly arrives as a number.
				onCall: () => ({ big: 2n ** 64n + 1n, exact: 2n ** 64n, zero: -0 }),
			},
		);
		expect(result.done).toStrictEqual({ ok: true, hasValue: true, value: ["bigint", true, "number", true] });
		expect(decodeBridgeValue(encodeBridgeValue(2n ** 64n, "value"))).toBe(2 ** 64);
	});
});
