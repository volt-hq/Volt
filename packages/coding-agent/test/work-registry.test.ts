/**
 * The work registry (RFC §7) over a real conversation kernel: kinds, starts
 * and their limits, executors and their results, cancellation, coarse
 * checkpoints, live progress, closing, suspension and resume, and delivery
 * fences.
 */

import {
	Conversation,
	type ConversationLogEntry,
	InMemoryConversationLog,
	type StreamFn,
} from "@hansjm10/volt-agent-core";
import { type LiveItem, WORK_DATA_MAX_SERIALIZED_BYTES, WORK_OUTPUT_MAX_UTF8_BYTES } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveState } from "../src/core/host/live-state.ts";
import {
	WORK_CHECKPOINT_INTERVAL_MS,
	WORK_CLOSE_GRACE_MS,
	type WorkExecution,
	type WorkExecutor,
	type WorkKindDefinition,
	WorkRegistry,
} from "../src/core/work/registry.ts";

const noTurns: StreamFn = () => {
	throw new Error("No turn runs in this test");
};

const opened: Conversation[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const conversation of opened.splice(0)) await conversation.close().catch(() => undefined);
});

interface Setup {
	readonly conversation: Conversation;
	readonly log: InMemoryConversationLog;
	readonly registry: WorkRegistry;
	/** Every live item the conversation's clients were sent. */
	readonly live: LiveItem[];
	setTurn(turnId: string | undefined): void;
}

async function setup(log = new InMemoryConversationLog("work-registry")): Promise<Setup> {
	const conversation = await Conversation.open({ log, stream: noTurns, resolveModel: () => undefined });
	opened.push(conversation);
	const liveState = new LiveState({ head: () => conversation.state.ordinal });
	const live: LiveItem[] = [];
	liveState.attach("observer", {
		acceptsHostRequest: () => false,
		apply: (update) => {
			live.push(...update.items);
		},
	});
	let turnId: string | undefined;
	const registry = new WorkRegistry({
		work: () => conversation.work,
		state: () => conversation.state,
		live: () => liveState,
		turnId: () => turnId,
	});
	await registry.reconcile();
	return {
		conversation,
		log,
		registry,
		live,
		setTurn: (id) => {
			turnId = id;
		},
	};
}

/** The log's entries (tests write fewer than a page). */
async function entriesOf(log: InMemoryConversationLog): Promise<ConversationLogEntry[]> {
	const page = await log.read(0, 1_000);
	return [...page.entries];
}

async function nextRuntime(previous: Setup): Promise<Setup> {
	const entries = await entriesOf(previous.log);
	await previous.conversation.close();
	const log = new InMemoryConversationLog("work-registry-next");
	const drafts = entries.map(({ ordinal: _ordinal, ...draft }) => draft);
	await log.append({ expectedOrdinal: 0, commitId: "copy", entries: drafts });
	return await setup(log);
}

function kind(overrides: Partial<WorkKindDefinition> = {}): WorkKindDefinition {
	return {
		kind: "ext:test/run",
		delivery: "none",
		cancellable: true,
		maxActive: 4,
		title: (input) => `Run ${JSON.stringify(input)}`,
		...overrides,
	};
}

/** An executor that runs until it is released or aborted. */
function held(): { execute: WorkExecutor; release(execution?: WorkExecution): void; started: Promise<void> } {
	const release = Promise.withResolvers<WorkExecution>();
	const started = Promise.withResolvers<void>();
	return {
		execute: async (ctx) => {
			started.resolve();
			ctx.signal.addEventListener("abort", () => release.resolve({ outcome: "cancelled" }), { once: true });
			return await release.promise;
		},
		release: (execution = { outcome: "completed" }) => release.resolve(execution),
		started: started.promise,
	};
}

function workEntries(entries: readonly ConversationLogEntry[]): Array<{ type: string; payload: unknown }> {
	return entries
		.filter((entry) => entry.type.startsWith("work_"))
		.map((entry) => ({ type: entry.type, payload: entry.payload }));
}

describe("work registry", () => {
	it("records started work, runs its executor, and keeps its output tail as the result", async () => {
		const { registry, log, live } = await setup();
		registry.register(
			kind({ title: () => "Build\n\u001b[31mthe app\u0007", redactInput: () => ({ command: "<redacted>" }) }),
		);
		const record = await registry.start("ext:test/run", { command: "secret" }, async (ctx) => {
			ctx.output("one ");
			ctx.output("two");
			return { outcome: "completed", result: { summary: "built\u001b[0m" } };
		});
		expect(record).toMatchObject({ title: "Build the app", input: { command: "<redacted>" }, state: "running" });
		await registry.waitForIdle();
		expect(registry.get(record.workId)).toMatchObject({
			outcome: "completed",
			result: { summary: "built", output: { text: "one two", truncated: false } },
		});
		expect(registry.output(record.workId)).toEqual({ text: "one two", truncated: false, final: true });
		expect(registry.running()).toEqual([]);
		const key = `work/${record.workId}`;
		expect(live).toContainEqual({ type: "set", key, value: { kind: "work", workId: record.workId } });
		expect(live.at(-1)).toEqual({ type: "clear", key });
		expect(workEntries(await entriesOf(log)).map((entry) => entry.type)).toEqual(["work_started", "work_finished"]);
	});

	it("keeps only the newest output, starting at a character", async () => {
		const { registry } = await setup();
		registry.register(kind());
		const record = await registry.start("ext:test/run", null, async (ctx) => {
			for (let index = 0; index < 120; index++) ctx.output(`${"é".repeat(511)}|${index}\n`);
			return { outcome: "completed" };
		});
		await registry.waitForIdle();
		const output = registry.get(record.workId)?.result?.output;
		expect(output?.truncated).toBe(true);
		expect(Buffer.byteLength(output?.text ?? "", "utf8")).toBeLessThanOrEqual(WORK_OUTPUT_MAX_UTF8_BYTES);
		expect(output?.text.endsWith("|119\n")).toBe(true);
		expect(output?.text.includes("�")).toBe(false);
	});

	it("refuses starts beyond a kind's maxActive, unknown kinds, and tool-scoped starts without a tool call", async () => {
		const { registry } = await setup();
		registry.register(kind({ maxActive: 1 }));
		registry.register(kind({ kind: "job", scoped: "tool_grant" }));
		const first = held();
		await registry.start("ext:test/run", 1, first.execute);
		await expect(registry.start("ext:test/run", 2, held().execute)).rejects.toMatchObject({ code: "limit" });
		await expect(registry.start("ext:test/other", 2, held().execute)).rejects.toMatchObject({
			code: "unknown_kind",
		});
		await expect(registry.start("job", 3, held().execute)).rejects.toMatchObject({ code: "invalid" });
		await expect(
			registry.start("job", 3, async () => ({ outcome: "completed" }), { toolCallId: "call-1" }),
		).resolves.toMatchObject({ kind: "job", toolCallId: "call-1" });
		expect(() => registry.register(kind())).toThrow(/already registered/);
		expect(() => registry.register(kind({ kind: "ext:Bad Kind/x" }))).toThrow(/Invalid work kind/);
		first.release();
		await registry.waitForIdle();
		await expect(registry.start("ext:test/run", 4, async () => ({ outcome: "completed" }))).resolves.toBeDefined();
	});

	it("cancels running work: a cancelling checkpoint, then what its aborted executor returns", async () => {
		const { registry, log } = await setup();
		registry.register(kind());
		registry.register(kind({ kind: "ext:test/fixed", cancellable: false }));
		const run = held();
		const record = await registry.start("ext:test/run", null, run.execute);
		await run.started;
		await registry.cancel(record.workId);
		await registry.waitForIdle();
		expect(workEntries(await entriesOf(log))).toEqual([
			expect.objectContaining({ type: "work_started" }),
			{ type: "work_checkpoint", payload: { workId: record.workId, state: "cancelling" } },
			{ type: "work_finished", payload: { workId: record.workId, outcome: "cancelled" } },
		]);
		await expect(registry.cancel(record.workId)).rejects.toMatchObject({ code: "finished" });
		await expect(registry.cancel("missing")).rejects.toMatchObject({ code: "unknown_work" });
		const fixed = held();
		const pinned = await registry.start("ext:test/fixed", null, fixed.execute);
		await expect(registry.cancel(pinned.workId)).rejects.toMatchObject({ code: "not_cancellable" });
		fixed.release();
		await registry.waitForIdle();
	});

	it("fails work whose executor throws or returns no outcome, and drops result data over its bound", async () => {
		const { registry } = await setup();
		registry.register(kind());
		const thrown = await registry.start("ext:test/run", null, async () => {
			throw new Error("boom");
		});
		const empty = await registry.start("ext:test/run", null, async () => undefined as unknown as WorkExecution);
		const bulky = await registry.start("ext:test/run", null, async () => ({
			outcome: "completed",
			result: { summary: "done", data: { blob: "x".repeat(WORK_DATA_MAX_SERIALIZED_BYTES) } },
		}));
		await registry.waitForIdle();
		expect(registry.get(thrown.workId)).toMatchObject({ outcome: "failed", error: "boom" });
		expect(registry.get(empty.workId)).toMatchObject({ outcome: "failed" });
		expect(registry.get(bulky.workId)).toMatchObject({ outcome: "completed", result: { summary: "done" } });
		expect(registry.get(bulky.workId)?.result?.data).toBeUndefined();
	});

	it("writes a kind phase at once, then at most one per interval, the latest waiting", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { registry, log } = await setup();
		registry.register(kind());
		const run = held();
		let ctx: Parameters<WorkExecutor>[0] | undefined;
		const record = await registry.start("ext:test/run", null, async (context) => {
			ctx = context;
			return await run.execute(context);
		});
		await vi.waitFor(() => expect(ctx).toBeDefined());
		ctx?.checkpoint({ text: "phase 1" });
		ctx?.checkpoint({ text: "phase 2" });
		ctx?.checkpoint({ text: "phase 3" });
		await vi.advanceTimersByTimeAsync(WORK_CHECKPOINT_INTERVAL_MS - 1);
		const phases = async () =>
			workEntries(await entriesOf(log))
				.filter((entry) => entry.type === "work_checkpoint")
				.map((entry) => (entry.payload as { progress?: { text?: string } }).progress?.text);
		expect(await phases()).toEqual(["phase 1"]);
		await vi.advanceTimersByTimeAsync(1);
		expect(await phases()).toEqual(["phase 1", "phase 3"]);
		ctx?.checkpoint({ text: "phase 4" });
		run.release();
		await vi.advanceTimersByTimeAsync(WORK_CHECKPOINT_INTERVAL_MS);
		await registry.waitForIdle();
		// The finish drops a phase still waiting.
		expect(await phases()).toEqual(["phase 1", "phase 3"]);
		expect(registry.get(record.workId)?.outcome).toBe("completed");
	});

	it("coalesces live progress and reports output sizes", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { registry, live } = await setup();
		registry.register(kind());
		const run = held();
		let ctx: Parameters<WorkExecutor>[0] | undefined;
		const record = await registry.start("ext:test/run", null, async (context) => {
			ctx = context;
			return await run.execute(context);
		});
		await vi.waitFor(() => expect(ctx).toBeDefined());
		const key = `work/${record.workId}`;
		const sets = () => live.filter((item) => item.type === "set" && item.key === key);
		expect(sets()).toHaveLength(1);
		for (let step = 1; step <= 5; step++) ctx?.progress({ value: step, max: 5 });
		ctx?.output("abc");
		expect(sets()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(100);
		expect(sets()).toHaveLength(2);
		expect(sets().at(-1)).toMatchObject({
			value: { kind: "work", workId: record.workId, progress: { value: 5, max: 5 }, output: { bytes: 3 } },
		});
		ctx?.progress({ text: "big", steps: [] }, { type: "text", text: [{ text: "x".repeat(20_000) }] });
		await vi.advanceTimersByTimeAsync(100);
		// Detail over the bound is dropped from the live value.
		expect(sets().at(-1)).toMatchObject({ value: { progress: { text: "big" } } });
		expect((sets().at(-1) as { value: { detail?: unknown } }).value.detail).toBeUndefined();
		run.release();
		await registry.waitForIdle();
		expect(live.at(-1)).toEqual({ type: "clear", key });
	});

	it("closing interrupts running work, leaves resumable work open, and a next runtime resumes it", async () => {
		const first = await setup();
		const resumable = kind({ kind: "subagent", resume: () => async () => ({ outcome: "completed" }) });
		first.registry.register(kind());
		first.registry.register(resumable);
		const job = await first.registry.start("ext:test/run", null, held().execute);
		const child = await first.registry.start("subagent", null, held().execute);
		await first.registry.cancelAll("closed");
		expect(first.registry.get(job.workId)?.outcome).toBe("interrupted");
		expect(first.registry.get(child.workId)?.outcome).toBeUndefined();
		await expect(first.registry.start("ext:test/run", null, held().execute)).rejects.toMatchObject({
			code: "closed",
		});

		const second = await nextRuntime(first);
		expect(second.conversation.state.openWork).toEqual([child.workId]);
		expect(second.registry.running()).toEqual([]);
		await expect(second.registry.resume(child.workId)).rejects.toMatchObject({ code: "unavailable" });
		second.registry.register(resumable);
		await second.registry.resume(child.workId);
		await second.registry.waitForIdle();
		expect(second.registry.get(child.workId)?.outcome).toBe("completed");
		const types = workEntries(await entriesOf(second.log)).map((entry) => entry.type);
		expect(types.slice(-2)).toEqual(["work_checkpoint", "work_finished"]);
		await expect(second.registry.resume(child.workId)).rejects.toMatchObject({ code: "finished" });
	});

	it("cancels suspended work without an executor, and refuses to resume what cannot resume", async () => {
		const first = await setup();
		const resumable = kind({ kind: "subagent", resume: () => async () => ({ outcome: "completed" }) });
		first.registry.register(resumable);
		const kept = await first.registry.start("subagent", null, held().execute);
		const dropped = await first.registry.start("subagent", null, held().execute);
		await first.registry.cancelAll("closed");
		const second = await nextRuntime(first);
		second.registry.register(resumable);
		await second.registry.cancel(dropped.workId);
		expect(second.registry.get(dropped.workId)?.outcome).toBe("cancelled");
		const run = held();
		second.registry.register(kind());
		const job = await second.registry.start("ext:test/run", null, run.execute);
		await expect(second.registry.resume(job.workId)).rejects.toMatchObject({ code: "running" });
		run.release();
		await second.registry.waitForIdle();
		await expect(second.registry.resume(job.workId)).rejects.toMatchObject({ code: "finished" });
		expect(second.registry.get(kept.workId)?.outcome).toBeUndefined();
	});

	it("closing waits a grace period for executors that ignore the abort, then interrupts their work", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { registry } = await setup();
		registry.register(kind());
		const record = await registry.start("ext:test/run", null, () => new Promise<WorkExecution>(() => undefined));
		const closing = registry.cancelAll("closed");
		await vi.advanceTimersByTimeAsync(WORK_CLOSE_GRACE_MS);
		await closing;
		expect(registry.get(record.workId)?.outcome).toBe("interrupted");
		expect(registry.running()).toEqual([]);
	});

	it("queues a message notice, and a fenced turn withdraws its notices and delivers no more", async () => {
		const { registry, conversation, setTurn } = await setup();
		registry.register(kind({ delivery: "message" }));
		setTurn("turn-1");
		const early = held();
		const late = held();
		const first = await registry.start("ext:test/run", null, early.execute);
		const second = await registry.start("ext:test/run", null, late.execute);
		setTurn(undefined);
		const outside = await registry.start("ext:test/run", null, async () => ({ outcome: "completed" }));
		early.release();
		await vi.waitFor(() => expect(registry.get(first.workId)?.outcome).toBe("completed"));
		const quiet = () =>
			[...conversation.state.clientInputs.inputs.values()].filter(
				(record) => record.origin === "host" && record.queuedInput?.wake === false,
			);
		await vi.waitFor(() => expect(quiet()).toHaveLength(2));
		await registry.suppressDelivery("turn-1");
		late.release();
		await registry.waitForIdle();
		expect(registry.get(second.workId)?.outcome).toBe("completed");
		const states = quiet().map((record) => record.state);
		// The fenced turn's notice is withdrawn; the work outside it keeps its notice; the late work queued none.
		expect(states.sort()).toEqual(["accepted", "withdrawn"]);
		expect(quiet().find((record) => record.state === "accepted")?.queuedInput?.messages?.[0]).toMatchObject({
			customType: "work_notice",
			details: { workId: outside.workId, outcome: "completed" },
		});
	});

	it("reads the output of running work, and the output a kind keeps itself", async () => {
		const { registry } = await setup();
		registry.register(kind());
		registry.register(kind({ kind: "ext:test/own", output: () => "kept by the kind" }));
		const run = held();
		let ctx: Parameters<WorkExecutor>[0] | undefined;
		const record = await registry.start("ext:test/run", null, async (context) => {
			ctx = context;
			return await run.execute(context);
		});
		await vi.waitFor(() => expect(ctx).toBeDefined());
		expect(registry.output(record.workId)).toEqual({ text: "", truncated: false, final: false });
		ctx?.output("partial");
		expect(registry.output(record.workId)).toEqual({ text: "partial", truncated: false, final: false });
		const own = held();
		const kept = await registry.start("ext:test/own", null, own.execute);
		expect(registry.output(kept.workId)).toEqual({ text: "kept by the kind", truncated: false, final: false });
		expect(registry.output("missing")).toBeUndefined();
		run.release();
		own.release();
		await registry.waitForIdle();
	});
});
