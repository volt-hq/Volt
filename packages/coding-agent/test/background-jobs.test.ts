import type { AgentToolResult, AgentToolUpdateCallback } from "@hansjm10/volt-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_JOB_MAX_ACTIVE,
	BACKGROUND_JOB_MAX_OUTPUT_BYTES,
	BACKGROUND_JOB_MAX_RETAINED,
	BackgroundJobManager,
	type BackgroundJobSnapshot,
} from "../src/core/background-jobs.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { withBackgroundJobs } from "../src/core/tools/background.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createJobsTool } from "../src/core/tools/jobs.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function snapshot(result: AgentToolResult<unknown>): BackgroundJobSnapshot {
	return (result.details as { backgroundJob: BackgroundJobSnapshot }).backgroundJob;
}

const completed: AgentToolResult<unknown> = { content: [{ type: "text", text: "finished" }] };
const managers: BackgroundJobManager[] = [];
function manager() {
	const jobs = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
	managers.push(jobs);
	return jobs;
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((jobs) => jobs.close()));
	vi.useRealTimers();
});

describe("BackgroundJobManager", () => {
	it("returns a handle before execution settles and retains owned non-destructive snapshots", async () => {
		const jobs = manager();
		const done = deferred();
		let update!: AgentToolUpdateCallback<unknown>;
		const job = jobs.start({
			toolName: "bash",
			toolCallId: "call",
			label: "build",
			execute: async (_signal, onUpdate) => {
				update = onUpdate;
				onUpdate({ content: [{ type: "text", text: "working" }] });
				await done.promise;
				return completed;
			},
		});
		expect(job.status).toBe("running");
		await Promise.resolve();
		expect(jobs.get(job.id).output).toBe("working");
		job.output = "changed by caller";
		expect(jobs.get(job.id).output).toBe("working");
		expect(jobs.pendingNotifications()).toEqual([]);
		done.resolve();
		expect(await jobs.wait(job.id)).toMatchObject({ status: "completed", output: "finished" });
		update({ content: [{ type: "text", text: "late output" }] });
		expect(jobs.get(job.id).output).toBe("finished");
		expect(jobs.get(job.id)).toEqual(jobs.get(job.id));
		expect(jobs.pendingNotifications()).toMatchObject([{ id: job.id, status: "completed" }]);
		expect(jobs.pendingNotifications()[0]).not.toHaveProperty("output");
		jobs.acknowledgeNotifications([job.id]);
		expect(jobs.pendingNotifications()).toEqual([]);
	});

	it.each(["bash", "subagent"] as const)(
		"keeps %s results visible until a native terminal read is acknowledged, without consuming history",
		async (toolName) => {
			const jobs = manager();
			const tool = createJobsTool({ manager: jobs });
			const job = jobs.start({ toolName, toolCallId: "launch", label: "work", execute: async () => completed });
			const terminal = await jobs.wait(job.id);
			expect(jobs.listUncollected()).toMatchObject([{ id: job.id }]);
			jobs.acknowledgeNotifications([job.id]);
			await tool.execute("list", { action: "list" });
			await tool.execute("cancel", { action: "cancel", id: job.id });
			for (const id of ["launch", "list", "cancel"]) jobs.acknowledgeResult(id, terminal);
			expect(jobs.listUncollected()).toHaveLength(1);
			const read = snapshot(await tool.execute("read", { action: "read", id: job.id }));
			expect(jobs.listUncollected()).toHaveLength(1);
			const observer = vi.fn();
			jobs.subscribe(observer);
			jobs.acknowledgeResult("read", { ...read, status: "failed" });
			expect(jobs.listUncollected()).toHaveLength(1);
			jobs.acknowledgeResult("read", read);
			expect(jobs.listUncollected()).toEqual([]);
			expect(jobs.list()).toHaveLength(1);
			expect(jobs.get(job.id)).toEqual(terminal);
			jobs.acknowledgeResult("read", read);
			expect(observer).toHaveBeenCalledTimes(1);
		},
	);

	it("does not let an early read or expired wait acknowledge later completion", async () => {
		const jobs = manager();
		const tool = createJobsTool({ manager: jobs });
		const finish = deferred();
		const job = jobs.start({
			toolName: "bash",
			toolCallId: "launch",
			label: "work",
			execute: async () => {
				await finish.promise;
				return completed;
			},
		});
		await tool.execute("early-read", { action: "read", id: job.id });
		await tool.execute("early-wait", { action: "wait", id: job.id, timeoutMs: 0 });
		finish.resolve();
		const terminal = await jobs.wait(job.id);
		for (const id of ["early-read", "early-wait"]) jobs.acknowledgeResult(id, terminal);
		expect(jobs.listUncollected()).toHaveLength(1);
		const result = await tool.execute("terminal-wait", { action: "wait", id: job.id });
		jobs.acknowledgeResult("terminal-wait", snapshot(result));
		expect(jobs.listUncollected()).toEqual([]);
	});

	it("distinguishes cancellation request from settled cancellation and prevents pre-dispatch work", async () => {
		const jobs = manager();
		const neverStarted = vi.fn(async () => completed);
		const first = jobs.start({ toolName: "bash", toolCallId: "first", label: "first", execute: neverStarted });
		expect(jobs.cancel(first.id).status).toBe("cancelling");
		expect((await jobs.wait(first.id)).status).toBe("cancelled");
		expect(neverStarted).not.toHaveBeenCalled();
		const finish = deferred();
		let signal!: AbortSignal;
		const second = jobs.start({
			toolName: "bash",
			toolCallId: "second",
			label: "second",
			execute: async (value) => {
				signal = value;
				await finish.promise;
				return completed;
			},
		});
		await Promise.resolve();
		expect(jobs.cancel(second.id).status).toBe("cancelling");
		expect(signal.aborted).toBe(true);
		expect((await jobs.wait(second.id, 0)).status).toBe("cancelling");
		finish.resolve();
		expect((await jobs.wait(second.id)).status).toBe("cancelled");
	});

	it("joins newly admitted and revoked work without polling or cancelling it", async () => {
		let allowed = true;
		const jobs = new BackgroundJobManager({ isToolAllowed: () => allowed, getGeneration: () => 0 });
		managers.push(jobs);
		const firstDone = deferred();
		const secondStarted = deferred();
		const secondDone = deferred();
		let secondSignal!: AbortSignal;
		jobs.start({
			toolName: "bash",
			toolCallId: "first",
			label: "first",
			execute: async () => {
				await firstDone.promise;
				jobs.start({
					toolName: "bash",
					toolCallId: "second",
					label: "second",
					execute: async (signal) => {
						secondSignal = signal;
						secondStarted.resolve();
						await secondDone.promise;
						return completed;
					},
				});
				return completed;
			},
		});
		const settled = vi.fn();
		const joining = jobs.waitForIdle().then(settled);
		try {
			firstDone.resolve();
			await secondStarted.promise;
			expect(secondSignal.aborted).toBe(false);
			expect(settled).not.toHaveBeenCalled();
			allowed = false;
			jobs.cancelInaccessible();
			expect(secondSignal.aborted).toBe(true);
			expect(jobs.list()).toEqual([]);
			expect(jobs.hasActive).toBe(true);
			expect(settled).not.toHaveBeenCalled();
		} finally {
			secondDone.resolve();
		}
		await joining;
		expect(jobs.hasActive).toBe(false);
	});

	it("bounds waiting and waiter cancellation does not cancel the job", async () => {
		vi.useFakeTimers();
		const jobs = manager();
		const finish = deferred();
		const job = jobs.start({
			toolName: "bash",
			toolCallId: "call",
			label: "work",
			execute: async () => {
				await finish.promise;
				return completed;
			},
		});
		const waiting = jobs.wait(job.id, 10);
		await vi.advanceTimersByTimeAsync(10);
		expect((await waiting).status).toBe("running");
		const controller = new AbortController();
		const abortedWait = jobs.wait(job.id, 30_000, controller.signal);
		const rejected = expect(abortedWait).rejects.toThrow("Job wait aborted");
		controller.abort();
		await rejected;
		expect(jobs.get(job.id).status).toBe("running");
		expect(vi.getTimerCount()).toBe(0);
		finish.resolve();
		await jobs.wait(job.id);
	});

	it.each([-1, 30_001, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
		"rejects invalid wait duration %s",
		async (timeout) => {
			const jobs = manager();
			const job = jobs.start({
				toolName: "bash",
				toolCallId: "call",
				label: "work",
				execute: async () => completed,
			});
			await expect(jobs.wait(job.id, timeout)).rejects.toThrow("timeoutMs");
		},
	);

	it("bounds active and retained jobs without evicting running work", async () => {
		const jobs = manager();
		const finish = deferred();
		const active = Array.from({ length: BACKGROUND_JOB_MAX_ACTIVE }, (_, index) =>
			jobs.start({
				toolName: "bash",
				toolCallId: String(index),
				label: "pending",
				execute: async () => {
					await finish.promise;
					return completed;
				},
			}),
		);
		expect(() =>
			jobs.start({ toolName: "bash", toolCallId: "overflow", label: "excess", execute: async () => completed }),
		).toThrow("At most");
		finish.resolve();
		await Promise.all(active.map((job) => jobs.wait(job.id)));
		for (let index = 0; index < BACKGROUND_JOB_MAX_RETAINED; index++) {
			const job = jobs.start({
				toolName: "bash",
				toolCallId: `finished-${index}`,
				label: "x".repeat(500),
				execute: async () => completed,
			});
			await jobs.wait(job.id);
		}
		expect(jobs.list()).toHaveLength(BACKGROUND_JOB_MAX_RETAINED);
		expect(jobs.listUncollected()).toHaveLength(BACKGROUND_JOB_MAX_RETAINED);
		expect(jobs.list()[0].label).toHaveLength(200);
		expect(() => jobs.get(active[0].id)).toThrow("Unknown");
	});

	it.each(["x", "é", "€", "😀"])("retains a partial %s line before trailing status text", async (character) => {
		const jobs = manager();
		const suffix = "\nstatus";
		const output = character.repeat(BACKGROUND_JOB_MAX_OUTPUT_BYTES) + suffix;
		const job = jobs.start({
			toolName: "bash",
			toolCallId: "call",
			label: "output with status",
			execute: async () => ({ content: [{ type: "text", text: output }] }),
		});
		const result = await jobs.wait(job.id);
		const retainedCharacters = Math.floor(
			(BACKGROUND_JOB_MAX_OUTPUT_BYTES - Buffer.byteLength(suffix)) / Buffer.byteLength(character),
		);
		expect(result.output).toBe(character.repeat(retainedCharacters) + suffix);
		expect(result.outputTruncated).toBe(true);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(BACKGROUND_JOB_MAX_OUTPUT_BYTES);
	});

	it("bounds multibyte and multiline output", async () => {
		const jobs = manager();
		for (const output of [
			"😀".repeat(30_000),
			"line\n".repeat(3000),
			`${"x".repeat(BACKGROUND_JOB_MAX_OUTPUT_BYTES)}\n${"line\n".repeat(3000)}`,
		]) {
			const job = jobs.start({
				toolName: "bash",
				toolCallId: "call",
				label: "output",
				execute: async () => ({ content: [{ type: "text", text: output }] }),
			});
			const result = await jobs.wait(job.id);
			expect(result.outputTruncated).toBe(true);
			expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(BACKGROUND_JOB_MAX_OUTPUT_BYTES);
			expect(result.output).not.toContain("�");
			expect(result.output.split("\n").length).toBeLessThanOrEqual(2000);
		}
	});

	it.each([
		[undefined, false],
		[null, false],
		["unrelated metadata", false],
		[[], false],
		[{ truncation: null }, false],
		[{ truncation: [] }, false],
		[{ truncation: { truncated: false } }, false],
		[{ truncation: { truncated: "true" } }, false],
		[{ truncation: { truncated: true } }, true],
	] as const)("reads upstream truncation only from an explicit boolean flag: %j", async (details, truncated) => {
		const jobs = manager();
		const job = jobs.start({
			toolName: "bash",
			toolCallId: "call",
			label: "bounded output",
			execute: async () => ({
				content: [{ type: "text", text: "retained output" }],
				...(details === undefined ? {} : { details }),
			}),
		});
		expect(await jobs.wait(job.id)).toMatchObject({
			status: "completed",
			output: "retained output",
			outputTruncated: truncated,
		});
	});

	it("notifies truncation-only changes without changing output time or latching prior metadata", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const jobs = manager();
		const finish = deferred();
		const result: AgentToolResult<unknown> = { content: [{ type: "text", text: "retained output" }] };
		let update!: AgentToolUpdateCallback<unknown>;
		const job = jobs.start({
			toolName: "bash",
			toolCallId: "call",
			label: "repeated output",
			execute: async (_signal, onUpdate) => {
				update = onUpdate;
				onUpdate(result);
				await finish.promise;
				return result;
			},
		});
		try {
			await Promise.resolve();
			expect(jobs.get(job.id)).toMatchObject({ outputTruncated: false, lastOutputAt: 1000 });
			const observer = vi.fn();
			jobs.subscribe(observer);
			vi.setSystemTime(2000);
			update({ ...result, details: { truncation: { truncated: true } } });
			expect(jobs.get(job.id)).toMatchObject({ outputTruncated: true, lastOutputAt: 1000 });
			expect(observer).toHaveBeenCalledTimes(1);
			update({ ...result, details: { truncation: { truncated: true } } });
			expect(observer).toHaveBeenCalledTimes(1);
			update({ ...result, details: { truncation: { truncated: false } } });
			expect(jobs.get(job.id).outputTruncated).toBe(false);
			expect(observer).toHaveBeenCalledTimes(2);
			update({ ...result, details: { truncation: { truncated: true } } });
			expect(observer).toHaveBeenCalledTimes(3);
		} finally {
			finish.resolve();
			await jobs.wait(job.id);
		}
		expect(jobs.get(job.id)).toMatchObject({
			status: "completed",
			output: "retained output",
			outputTruncated: false,
			lastOutputAt: 1000,
		});
	});

	it("contains invalid progress, aborts the worker, and does not retain late output", async () => {
		const jobs = manager();
		let executionSignal!: AbortSignal;
		const job = jobs.start({
			toolName: "bash",
			toolCallId: "call",
			label: "invalid",
			execute: async (signal, update) => {
				executionSignal = signal;
				update({ content: [], details: { bad: Number.NaN } });
				update({ content: [{ type: "text", text: "must not appear" }] });
				return completed;
			},
		});
		const result = await jobs.wait(job.id);
		expect(executionSignal.aborted).toBe(true);
		expect(result.status).toBe("failed");
		expect(result.output).toMatch(/finite/);
		expect(result.output).not.toContain("must not appear");
	});

	it("contains errors and structured failures without exposing prior progress on finalization failure", async () => {
		const jobs = manager();
		const throwing = jobs.start({
			toolName: "bash",
			toolCallId: "call",
			label: "failure",
			execute: async (_signal, update) => {
				update({ content: [{ type: "text", text: "pre-policy secret" }] });
				throw new Error("Result policy rejected output");
			},
		});
		expect(await jobs.wait(throwing.id)).toMatchObject({ status: "failed", output: "Result policy rejected output" });
		const failed = jobs.start({
			toolName: "bash",
			toolCallId: "call2",
			label: "failure",
			execute: async () => ({ ...completed, isError: true }),
		});
		expect((await jobs.wait(failed.id)).status).toBe("failed");
	});

	it("enforces runtime and branch ownership, narrowed grants, and close fencing", async () => {
		let generation = 0;
		let allowed = true;
		const jobs = new BackgroundJobManager({ isToolAllowed: () => allowed, getGeneration: () => generation });
		managers.push(jobs);
		const job = jobs.start({ toolName: "bash", toolCallId: "call", label: "work", execute: async () => completed });
		await jobs.wait(job.id);
		expect(() => manager().get(job.id)).toThrow("Unknown");
		generation++;
		expect(jobs.list()).toEqual([]);
		expect(jobs.listUncollected()).toEqual([]);
		expect(jobs.pendingNotifications()).toEqual([]);
		expect(() => jobs.get(job.id)).toThrow("inaccessible");
		allowed = false;
		expect(() =>
			jobs.start({ toolName: "bash", toolCallId: "new", label: "new", execute: async () => completed }),
		).toThrow("requires both");
		allowed = true;
		await jobs.close();
		expect(() =>
			jobs.start({ toolName: "bash", toolCallId: "new", label: "new", execute: async () => completed }),
		).toThrow("closed");
	});
});

describe("background tool interface", () => {
	it("collects a real native Bash process through the background interface", async () => {
		const jobs = manager();
		const tool = wrapToolDefinition(withBackgroundJobs(createBashToolDefinition(process.cwd()), { manager: jobs }));
		const job = snapshot(
			await tool.execute("shell-smoke", { command: "printf 'background smoke\\n'", background: true }),
		);
		expect(await jobs.wait(job.id)).toMatchObject({ status: "completed", output: "background smoke\n" });
	});

	const schema = Type.Object({ command: Type.String() });
	it("preserves foreground execution and renders a background handle without native result details", async () => {
		const jobs = manager();
		const finish = deferred();
		const definition: ToolDefinition<typeof schema, { marker: string }, object> = {
			name: "bash",
			label: "bash",
			description: "Test Bash",
			parameters: schema,
			execute: async (_id, _input, _signal, update) => {
				update?.({ content: [], details: { marker: "progress" } });
				await finish.promise;
				return { content: [{ type: "text", text: "done" }], details: { marker: "done" } };
			},
		};
		const wrapped = withBackgroundJobs(definition, { manager: jobs });
		const tool = wrapToolDefinition(wrapped);
		const result = await tool.execute("call", { command: "work", background: true });
		const job = snapshot(result);
		expect(job.status).toBe("running");
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining(job.id) });
		finish.resolve();
		expect((await jobs.wait(job.id)).output).toBe("done");
		expect(await tool.execute("foreground", { command: "work" })).toMatchObject({ details: { marker: "done" } });
	});

	it("keeps subagent preflight direct, preserves failure status, and finalizes actual completion once", async () => {
		const jobs = manager();
		const finalize = vi.fn(async (_name, _id, _input, result: AgentToolResult<unknown>) => result);
		const definition = {
			name: "subagent",
			label: "subagent",
			description: "Subagents",
			parameters: Type.Object({ agent: Type.String(), confirm: Type.Optional(Type.String()) }),
			execute: async (_id: string, params: { agent: string; confirm?: string }) => ({
				content: [{ type: "text" as const, text: params.confirm ? "child failed" : "confirm token" }],
				details: { status: params.confirm ? "failed" : "running" },
			}),
		};
		const tool = wrapToolDefinition(withBackgroundJobs(definition, { manager: jobs, finalize }));
		expect(await tool.execute("preflight", { agent: "general", background: true })).toMatchObject({
			content: [{ text: "confirm token" }],
		});
		expect(jobs.list()).toHaveLength(0);
		expect(finalize).not.toHaveBeenCalled();
		const job = snapshot(await tool.execute("confirmed", { agent: "general", confirm: "token", background: true }));
		expect((await jobs.wait(job.id)).status).toBe("failed");
		expect(finalize).toHaveBeenCalledTimes(1);
	});

	it("exposes bounded job control results and rejects ambiguous actions", async () => {
		const jobs = manager();
		const tool = createJobsTool({ manager: jobs });
		const job = jobs.start({ toolName: "bash", toolCallId: "call", label: "work", execute: async () => completed });
		expect(snapshot(await tool.execute("wait", { action: "wait", id: job.id })).status).toBe("completed");
		expect(snapshot(await tool.execute("read", { action: "read", id: job.id })).output).toBe("finished");
		expect(await tool.execute("list", { action: "list" })).toMatchObject({ details: { jobs: [{ id: job.id }] } });
		await expect(tool.execute("bad", { action: "read" })).rejects.toThrow("id is required");
		await expect(tool.execute("bad", { action: "list", id: job.id })).rejects.toThrow("does not accept");
		await expect(tool.execute("bad", { action: "read", id: job.id, timeoutMs: 1 })).rejects.toThrow("wait");
	});
});
