import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundJobManager, type BackgroundJobSnapshot } from "../../../src/core/background-jobs.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { backgroundWaitResult, getBackgroundJobWait } from "../../../src/core/tools/background-wait.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import { createJobsToolDefinition } from "../../../src/core/tools/jobs.ts";
import { BackgroundJobsStatus } from "../../../src/modes/interactive/components/background-jobs.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const managers: BackgroundJobManager[] = [];
const harnesses: Harness[] = [];
const finishes: Array<() => void> = [];
const completed: AgentToolResult<unknown> = { content: [{ type: "text", text: "done" }] };

function controlledJob(manager: BackgroundJobManager, toolName: "bash" | "subagent" = "bash") {
	const finish = deferred();
	finishes.push(finish.resolve);
	let signal: AbortSignal | undefined;
	const snapshot = manager.start({
		toolName,
		toolCallId: "launch",
		label: "worker",
		execute: async (value) => {
			signal = value;
			await finish.promise;
			return completed;
		},
	});
	return {
		snapshot,
		finish,
		get signal() {
			return signal;
		},
	};
}

afterEach(async () => {
	for (const finish of finishes.splice(0)) finish();
	vi.useRealTimers();
	for (const manager of managers.splice(0)) await manager.close();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("event-driven job waits", () => {
	it.each(["bash", "subagent"] as const)(
		"waits ten minutes without a timer for %s; any/all preserve unfinished workers",
		async (toolName) => {
			vi.useFakeTimers();
			const manager = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
			managers.push(manager);
			const first = controlledJob(manager, toolName);
			const second = controlledJob(manager, toolName);
			const resolved = vi.fn();
			const any = manager.wait([first.snapshot.id, second.snapshot.id]).then((result) => {
				resolved();
				return result;
			});
			const all = manager.wait([first.snapshot.id, second.snapshot.id], { mode: "all" });
			await vi.advanceTimersByTimeAsync(600000);
			expect(resolved).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			first.finish.resolve();
			expect(await any).toMatchObject({
				reason: "terminal",
				results: [{ id: first.snapshot.id }],
				pending: [{ id: second.snapshot.id }],
			});
			expect(second.signal?.aborted).toBe(false);
			expect(manager.listWaits()).toHaveLength(1);
			second.finish.resolve();
			expect((await all).results).toHaveLength(2);
			expect(manager.listWaits()).toEqual([]);
		},
	);

	it("batches simultaneous completion and returns metadata-only pending jobs on deadlines and steering", async () => {
		const manager = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
		managers.push(manager);
		const first = controlledJob(manager);
		const second = controlledJob(manager);
		const timed = await manager.wait([first.snapshot.id, second.snapshot.id], { timeoutMs: 0 });
		expect(timed.reason).toBe("timeout");
		expect(timed.pending).toHaveLength(2);
		expect(timed.pending[0]).not.toHaveProperty("output");
		manager.setSteeringPending(true);
		expect((await manager.wait([first.snapshot.id])).reason).toBe("steered");
		manager.setSteeringPending(false);
		const waiting = manager.wait([first.snapshot.id, second.snapshot.id]);
		first.finish.resolve();
		second.finish.resolve();
		expect((await waiting).results).toHaveLength(2);
		expect((await manager.wait([first.snapshot.id])).reason).toBe("terminal");
	});

	it("returns partial all results at an explicit deadline without copying running output", async () => {
		const manager = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
		managers.push(manager);
		const first = controlledJob(manager);
		const second = controlledJob(manager);
		first.finish.resolve();
		await manager.wait([first.snapshot.id]);
		const result = await manager.wait([first.snapshot.id, second.snapshot.id], { mode: "all", timeoutMs: 0 });
		expect(result).toMatchObject({
			reason: "timeout",
			results: [{ id: first.snapshot.id }],
			pending: [{ id: second.snapshot.id }],
		});
		expect(result.pending[0]).not.toHaveProperty("output");
		expect(getBackgroundJobWait(backgroundWaitResult(result).details)?.results).toHaveLength(1);
	});

	it("cleans timers and pins on abort, run replacement, and revoked access", async () => {
		let allowed = true;
		let run = {};
		const manager = new BackgroundJobManager({
			isToolAllowed: () => allowed,
			getGeneration: () => 0,
			getRunIdentity: () => run,
		});
		managers.push(manager);
		const job = controlledJob(manager);
		const controller = new AbortController();
		const waiting = manager.wait([job.snapshot.id], { signal: controller.signal, timeoutMs: 300000 });
		const rejected = expect(waiting).rejects.toThrow("aborted");
		controller.abort();
		await rejected;
		expect(manager.listWaits()).toEqual([]);
		expect(job.signal?.aborted).toBe(false);
		const stale = manager.wait([job.snapshot.id]);
		const staleRejected = expect(stale).rejects.toThrow("inaccessible");
		run = {};
		manager.setSteeringPending(false);
		await staleRejected;
		const revoked = manager.wait([job.snapshot.id]);
		const revokedRejected = expect(revoked).rejects.toThrow("inaccessible");
		allowed = false;
		manager.cancelInaccessible();
		await revokedRejected;
		expect(manager.listWaits()).toEqual([]);
	});

	it("pins terminal records while all waits hold the retention window", async () => {
		const manager = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
		managers.push(manager);
		const ids: string[] = [];
		for (let index = 0; index < 63; index++) {
			const job = manager.start({
				toolName: "bash",
				toolCallId: String(index),
				label: "done",
				execute: async () => completed,
			});
			await manager.wait([job.id]);
			ids.push(job.id);
		}
		const active = controlledJob(manager);
		ids.push(active.snapshot.id);
		const waiting = manager.wait(ids, { mode: "all" });
		expect(() =>
			manager.start({ toolName: "bash", toolCallId: "overflow", label: "blocked", execute: async () => completed }),
		).toThrow("retention");
		active.finish.resolve();
		expect((await waiting).results).toHaveLength(64);
		expect(() =>
			manager.start({ toolName: "bash", toolCallId: "new", label: "allowed", execute: async () => completed }),
		).not.toThrow();
	});

	it("bounds a multi-result envelope and keeps the original output", async () => {
		const output = "😀".repeat(20000) + "\nline".repeat(3000);
		const results: BackgroundJobSnapshot[] = Array.from({ length: 64 }, (_, index) => ({
			id: `job_${index}`,
			toolCallId: `launch_${index}`,
			toolName: "bash",
			label: "not repeated",
			status: index === 0 ? "failed" : "completed",
			startedAt: 1,
			endedAt: 2,
			output,
			outputTruncated: false,
		}));
		const envelope = backgroundWaitResult({
			id: "wait_test",
			ids: results.map((job) => job.id),
			mode: "all",
			reason: "terminal",
			startedAt: 1,
			endedAt: 2,
			results,
			pending: [],
		});
		const text = envelope.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
		expect(text.split("\n").length).toBeLessThanOrEqual(2000);
		expect(text).not.toContain("�");
		expect(envelope.isError).toBe(true);
		expect(getBackgroundJobWait(envelope.details)?.results).toHaveLength(64);
		expect(envelope.details.backgroundJobWait.results.every((job) => job.outputTruncated)).toBe(true);
		expect(results[0].output).toBe(output);
		expect(backgroundWaitResult(envelope.details.backgroundJobWait).content).toEqual(envelope.content);
	});
});

async function setup(diagnostics = false, extra: HarnessOptions = {}) {
	vi.stubEnv("VOLT_BACKGROUND_JOB_DIAGNOSTICS", diagnostics ? "1" : "0");
	const finish = deferred();
	finishes.push(finish.resolve);
	const operations: BashOperations = {
		exec: async (command, _cwd, options) => {
			options.onData(Buffer.from("private worker output"));
			options.signal?.addEventListener("abort", finish.resolve, { once: true });
			await finish.promise;
			return { exitCode: command.includes("fail") ? 1 : 0 };
		},
	};
	const original = nativeTools.createAllToolDefinitions;
	vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
		original(cwd, { ...options, bash: { ...options?.bash, operations } }),
	);
	const harness = await createHarness({
		initialActiveToolNames: ["bash", "jobs"],
		settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
		...extra,
	});
	harnesses.push(harness);
	harness.session.setSessionName("Wait regression");
	const started = deferred();
	const unsubscribe = harness.session.backgroundJobs.subscribe(() => {
		if (harness.session.backgroundJobs.listWaits().length) started.resolve();
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "private command", background: true }), {
			stopReason: "toolUse",
		}),
		() =>
			fauxAssistantMessage(
				fauxToolCall("jobs", { action: "wait", ids: [harness.session.backgroundJobs.list()[0].id] }),
				{ stopReason: "toolUse" },
			),
		fauxAssistantMessage("Result received"),
		fauxAssistantMessage("Follow-up received"),
	]);
	return { harness, finish, started, unsubscribe, operations };
}

describe("multi-job presentation and collection", () => {
	it.each([32, 100])("renders a live any/all wait and its mixed results at width %s", async (width) => {
		initTheme("dark");
		const manager = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
		managers.push(manager);
		const first = controlledJob(manager);
		const second = controlledJob(manager);
		const ids = [first.snapshot.id, second.snapshot.id];
		const definition = createJobsToolDefinition({ manager });
		const card = new ToolExecutionComponent(
			"jobs",
			"wait-call",
			{ action: "wait", ids, mode: "all" },
			{},
			definition,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		const waiting = manager.wait(ids, { mode: "all", toolCallId: "wait-call" });
		try {
			card.markExecutionStarted();
			const dock = new BackgroundJobsStatus(() => manager);
			const frames = [card.render(width), dock.render(width)];
			expect(frames[0].lines.map(stripAnsi).join(" ")).toContain("Waiting for background jobs");
			expect(frames[1].lines.map(stripAnsi).join(" ")).toContain("waiting (all)");
			for (const frame of frames)
				for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			first.finish.resolve();
			second.finish.resolve();
			const result = backgroundWaitResult(await waiting);
			card.updateResult({ ...result, isError: false });
			expect(card.render(100).lines.map(stripAnsi).join(" ")).toContain("jobs wait (all) · 2 completed");
		} finally {
			card.dispose();
		}
	});

	it.each(["valid", "provider-omitted", "model-error", "result-replaced", "payload-changed"])(
		"acknowledges the multi-result envelope only with valid delivery: %s",
		async (variant) => {
			const { harness, finish, started, unsubscribe } = await setup(false, {
				extensionFactories: [
					(api) => {
						if (variant === "result-replaced")
							api.on("tool_result", (event) => {
								if (event.toolName === "jobs") return { content: [{ type: "text", text: "replacement" }] };
							});
						if (variant === "payload-changed")
							api.on("before_provider_request", (event) => {
								return { ...(event.payload as object), extra: true };
							});
					},
				],
			});
			const setResponses = harness.setResponses;
			harness.setResponses = (responses) =>
				setResponses(
					responses.map((response) => async (context, options, state, model) => {
						await options?.onPayload?.({ messages: structuredClone(context.messages) }, model, {
							toolResultMessageIndices:
								variant === "provider-omitted"
									? []
									: context.messages.flatMap((message, index) =>
											message.role === "toolResult" ? [index] : [],
										),
						});
						return typeof response === "function" ? response(context, options, state, model) : response;
					}),
				);
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("bash", { command: "pass", background: true }),
						fauxToolCall("bash", { command: "fail", background: true }),
					],
					{ stopReason: "toolUse" },
				),
				() =>
					fauxAssistantMessage(
						fauxToolCall("jobs", {
							action: "wait",
							ids: harness.session.backgroundJobs.list().map((job) => job.id),
							mode: "all",
						}),
						{ stopReason: "toolUse" },
					),
				fauxAssistantMessage(
					"Received",
					variant === "model-error" ? { stopReason: "error", errorMessage: "fixture error" } : {},
				),
			]);
			const prompting = harness.session.prompt("Collect the jobs");
			await started.promise;
			finish.resolve();
			await prompting;
			expect(
				harness.session.backgroundJobs
					.list()
					.map((job) => job.status)
					.sort(),
			).toEqual(["completed", "failed"]);
			expect(harness.session.backgroundJobs.listUncollected()).toHaveLength(variant === "valid" ? 0 : 2);
			unsubscribe();
		},
	);
});

describe("active-run waiting", () => {
	it.each([false, true])("makes no parent requests during ten minutes with diagnostics=%s", async (diagnostics) => {
		const { harness, finish, started, unsubscribe } = await setup(diagnostics);
		const prompting = harness.session.prompt("Wait for the worker");
		await started.promise;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const calls = harness.faux.state.callCount;
		await vi.advanceTimersByTimeAsync(600000);
		expect(harness.faux.state.callCount).toBe(calls);
		expect(harness.session.isStreaming).toBe(true);
		vi.useRealTimers();
		finish.resolve();
		await prompting;
		expect(harness.faux.state.callCount).toBe(calls + 1);
		expect(harness.session.getLastAssistantText()).toBe("Result received");
		expect(harness.session.backgroundJobs.listWaits()).toEqual([]);
		unsubscribe();
		if (diagnostics) {
			harness.session.dispose();
			await harness.session.waitForClosed();
			const directory = join(harness.tempDir, "background-job-diagnostics");
			const text = readdirSync(directory)
				.filter((file) => file.endsWith(".jsonl"))
				.map((file) => readFileSync(join(directory, file), "utf8"))
				.join("\n");
			expect(text).not.toContain("private command");
			expect(text).not.toContain("private worker output");
			const records = text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { kind: string });
			expect(records.filter((record) => record.kind === "request_start")).toHaveLength(3);
			expect(records.filter((record) => record.kind === "wait_end")).toHaveLength(1);
		}
	});

	it.each([false, true])(
		"interrupts on admitted steering (prequeued=%s) without cancelling work",
		async (prequeued) => {
			const { harness, finish, started, unsubscribe } = await setup();
			if (prequeued)
				harness.session.registerTurnPolicy({
					beforeToolCall: async (event) => {
						if (event.toolName === "jobs") await harness.session.steer("Change the priority");
					},
				});
			const prompting = harness.session.prompt("Start work");
			await started.promise;
			if (!prequeued) await harness.session.steer("Change the priority");
			await prompting;
			expect(harness.session.hasBackgroundJobs).toBe(true);
			const waitResult = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "jobs",
			);
			expect(waitResult?.role === "toolResult" && getBackgroundJobWait(waitResult.details)?.reason).toBe("steered");
			finish.resolve();
			await harness.session.waitForBackgroundJobs();
			expect(harness.faux.state.callCount).toBe(3);
			unsubscribe();
		},
	);

	it("interrupts the wait without cancelling or bypassing a sibling foreground tool", async () => {
		const { harness, started, finish, unsubscribe, operations } = await setup();
		const foreground = deferred();
		const foregroundStarted = deferred();
		finishes.push(foreground.resolve);
		let foregroundSignal: AbortSignal | undefined;
		const exec = operations.exec;
		operations.exec = async (command, cwd, options) => {
			if (command !== "foreground") return exec(command, cwd, options);
			foregroundSignal = options.signal;
			foregroundStarted.resolve();
			await foreground.promise;
			return { exitCode: 0 };
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "background", background: true }), {
				stopReason: "toolUse",
			}),
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("jobs", { action: "wait", ids: [harness.session.backgroundJobs.list()[0].id] }),
						fauxToolCall("bash", { command: "foreground" }),
					],
					{ stopReason: "toolUse" },
				),
			fauxAssistantMessage("Steering after the batch"),
		]);
		const prompting = harness.session.prompt("Run independent tools");
		await started.promise;
		await foregroundStarted.promise;
		const waitFinished = deferred();
		const stopWatching = harness.session.backgroundJobs.subscribe(() => {
			if (!harness.session.backgroundJobs.listWaits().length) waitFinished.resolve();
		});
		await harness.session.steer("Change priority");
		await waitFinished.promise;
		expect(foregroundSignal?.aborted).toBe(false);
		expect(harness.faux.state.callCount).toBe(2);
		foreground.resolve();
		await prompting;
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.hasBackgroundJobs).toBe(true);
		finish.resolve();
		await harness.session.waitForBackgroundJobs();
		stopWatching();
		unsubscribe();
	});

	it("keeps follow-ups queued and does not restart after abort", async () => {
		const { harness, started, unsubscribe } = await setup();
		const prompting = harness.session.prompt("Start work");
		await started.promise;
		await harness.session.followUp("Later");
		expect(harness.session.backgroundJobs.listWaits()).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
		await harness.session.abort();
		await prompting;
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.backgroundJobs.listWaits()).toEqual([]);
		unsubscribe();
	});
});
