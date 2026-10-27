import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runTuiBenchmarkRun } from "./profile-coding-agent-node.mjs";

function startBenchmark(options = {}, stopCode = 0) {
	let clock = 100;
	const calls = [];
	const result = runTuiBenchmarkRun(
		{
			runtime: "node",
			runIndex: 0,
			measuredIndex: 1,
			options: { label: "fixture", isolatedAgentDir: false, cpuProfile: false, offline: true, ...options },
			profileDir: "unused",
		},
		{
			now: () => clock,
			spawnProcess(executable, args, spawnOptions) {
				clock += 25; // Process creation is part of startup, not a pre-measurement warmup.
				const child = new EventEmitter();
				child.stderr = new PassThrough();
				calls.push({ executable, args, options: spawnOptions, child });
				if (args.at(-1) === "stop") {
					queueMicrotask(() => {
						if (stopCode !== 0) child.stderr.write("fixture shutdown failed");
						child.emit("close", stopCode, null);
					});
				}
				return child;
			},
		},
	);
	return {
		result,
		calls,
		setClock: (value) => {
			clock = value;
		},
	};
}

function reportReady(child) {
	child.stderr.write("\n--- Startup Timings ---\n  interactiveMode.init: 12ms\n  TOTAL: 40ms\n------------------------\n");
}

test("TUI profiling preserves terminal input/output and enables its readiness timings", async () => {
	const { result, calls } = startBenchmark();
	const { child, options } = calls[0];
	assert.deepEqual(options.stdio, ["inherit", "inherit", "pipe"]);
	assert.equal(options.env.VOLT_STARTUP_BENCHMARK, "1");
	assert.equal(options.env.VOLT_TIMING, "1");
	reportReady(child);
	child.emit("close", 0, null);
	await result;
});

test("startup includes spawn/import time, handles split readiness output, and excludes teardown", async () => {
	const { result, calls, setClock } = startBenchmark();
	const { child } = calls[0];
	setClock(600);
	child.stderr.write("\n--- Startup Timings ---\n  parseArgs: 28ms\n  interactiveMode.");
	setClock(680);
	child.stderr.write("init: 12ms\n");
	setClock(700);
	child.stderr.write("  TOTAL: 40ms\n------------------------\n");
	setClock(5_000);
	child.emit("close", 0, null);
	const measured = await result;
	assert.equal(measured.elapsedMs, 580);
	assert.equal(measured.timings.get("TOTAL"), 40);
	assert.equal(measured.timings.get("interactiveMode.init"), 12);
});

test("a successful process exit without interactive readiness is not a startup sample", async () => {
	const { result, calls } = startBenchmark();
	calls[0].child.stderr.write("\n--- Startup Timings ---\n  parseArgs: 1ms\n  TOTAL: 1ms\n------------------------\n");
	calls[0].child.emit("close", 0, null);
	await assert.rejects(result, /interactive.*readiness/i);
});

test("readiness does not hide a later nonzero exit", async () => {
	const { result, calls } = startBenchmark();
	reportReady(calls[0].child);
	calls[0].child.stderr.write("fixture startup failed");
	calls[0].child.emit("close", 1, null);
	await assert.rejects(result, /fixture startup failed/);
});

test("isolated profiling stops its daemon before removing state; normal profiling does not stop it", async () => {
	const { result, calls } = startBenchmark({ isolatedAgentDir: true });
	const agentDir = calls[0].options.env.VOLT_CODING_AGENT_DIR;
	const root = dirname(agentDir);
	try {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		writeFileSync(join(agentDir, "daemon", "voltd.pid"), "{}");
		reportReady(calls[0].child);
		calls[0].child.emit("close", 0, null);
		await result;
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[1].args.slice(1), ["daemon", "stop"]);
		assert.equal(calls[1].options.env.VOLT_CODING_AGENT_DIR, agentDir);
		assert.equal(existsSync(root), false);

		const normal = startBenchmark();
		reportReady(normal.calls[0].child);
		normal.calls[0].child.emit("close", 0, null);
		await normal.result;
		assert.equal(normal.calls.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a spawn error fails the sample and removes unused isolated state", async () => {
	const { result, calls } = startBenchmark({ isolatedAgentDir: true });
	const root = dirname(calls[0].options.env.VOLT_CODING_AGENT_DIR);
	try {
		calls[0].child.emit("error", new Error("fixture spawn failed"));
		await assert.rejects(result, /fixture spawn failed/);
		assert.equal(existsSync(root), false);
		assert.equal(calls.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isolated profiling cleans up after missing readiness, but preserves state if shutdown fails", async () => {
	for (const stopCode of [0, 1]) {
		const { result, calls } = startBenchmark({ isolatedAgentDir: true }, stopCode);
		const agentDir = calls[0].options.env.VOLT_CODING_AGENT_DIR;
		const root = dirname(agentDir);
		try {
			mkdirSync(join(agentDir, "daemon"), { recursive: true });
			writeFileSync(join(agentDir, "daemon", "voltd.pid"), "{}");
			calls[0].child.emit("close", 0, null);
			await assert.rejects(result, stopCode === 0 ? /interactive.*readiness/i : /preserved/);
			assert.equal(calls.length, 2);
			assert.equal(existsSync(root), stopCode !== 0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});
