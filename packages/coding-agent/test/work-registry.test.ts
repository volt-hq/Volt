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
	WORK_CHECKPOINTS_MAX,
	WORK_CLOSE_GRACE_MS,
	WORK_NOTICES_MAX_QUEUED,
	type WorkContext,
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
		conversationId: () => conversation.conversationId,
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
	// The same conversation, opened again.
	const log = new InMemoryConversationLog(previous.log.conversationId);
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

	it("presents a kind's detail from the item and sends a changed detail as a patch", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { registry, live } = await setup();
		registry.register(
			kind({
				detail: (work) => {
					if (work.progress?.text === "throw") throw new Error("broken presenter");
					return {
						type: "terminal",
						key: "log",
						title: `${work.title} (${work.state})`,
						lines: work.output.text.split("\n").filter(Boolean),
					};
				},
			}),
		);
		const run = held();
		let ctx: Parameters<WorkExecutor>[0] | undefined;
		const record = await registry.start("ext:test/run", { job: 1 }, async (context) => {
			ctx = context;
			return await run.execute(context);
		});
		await vi.waitFor(() => expect(ctx).toBeDefined());
		const key = `work/${record.workId}`;
		const ofKey = () => live.filter((item) => (item.type === "set" || item.type === "patch") && item.key === key);
		expect(ofKey().at(-1)).toMatchObject({
			type: "set",
			value: { detail: { type: "terminal", title: 'Run {"job":1} (running)', lines: [] } },
		});
		ctx?.outputSnapshot({ text: "one\n", truncated: false, bytes: 4 });
		await vi.advanceTimersByTimeAsync(100);
		// Its output bytes changed too: the whole value.
		expect(ofKey().at(-1)).toMatchObject({
			type: "set",
			value: { output: { bytes: 4 }, detail: { lines: ["one"] } },
		});
		// The same bytes reported again with new text change the detail alone: a patch.
		ctx?.outputSnapshot({ text: "one\ntwo\n", truncated: false, bytes: 4 });
		await vi.advanceTimersByTimeAsync(100);
		expect(ofKey().at(-1)).toEqual({
			type: "patch",
			key,
			ops: [{ op: "append_lines", path: ["log"], lines: ["two"] }],
		});
		// A presenter that throws leaves the detail out.
		ctx?.progress({ text: "throw" });
		await vi.advanceTimersByTimeAsync(100);
		expect((ofKey().at(-1) as { value?: { detail?: unknown } }).value?.detail).toBeUndefined();
		run.release();
		await registry.waitForIdle();
	});

	it("presents a gated kind's detail without its input and output text", async () => {
		const { registry } = await setup();
		const seen: unknown[] = [];
		registry.register(
			kind({
				requires: ["host.manage.v1"],
				detail: (work) => {
					seen.push({ input: work.input, output: work.output.text });
					return undefined;
				},
			}),
		);
		const run = held();
		let ctx: Parameters<WorkExecutor>[0] | undefined;
		await registry.start("ext:test/run", { secret: "token" }, async (context) => {
			ctx = context;
			return await run.execute(context);
		});
		await vi.waitFor(() => expect(ctx).toBeDefined());
		ctx?.output("private output");
		await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1));
		expect(seen.every((each) => JSON.stringify(each) === JSON.stringify({ input: null, output: "" }))).toBe(true);
		run.release();
		await registry.waitForIdle();
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

	it("reads the output of running work, appended or reported as a snapshot", async () => {
		const { registry } = await setup();
		registry.register(kind());
		registry.register(kind({ kind: "ext:test/own" }));
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
		let ownCtx: Parameters<WorkExecutor>[0] | undefined;
		const kept = await registry.start("ext:test/own", null, async (context) => {
			ownCtx = context;
			return await own.execute(context);
		});
		await vi.waitFor(() => expect(ownCtx).toBeDefined());
		ownCtx?.outputSnapshot({ text: "first tail", truncated: false, bytes: 10 });
		ownCtx?.outputSnapshot({ text: "kept by the kind", truncated: true, bytes: 900 });
		expect(registry.output(kept.workId)).toEqual({ text: "kept by the kind", truncated: true, final: false });
		expect(registry.output("missing")).toBeUndefined();
		run.release();
		own.release();
		await registry.waitForIdle();
	});
	it("records what it can of a malformed result, never leaving the work open", async () => {
		const { registry } = await setup();
		registry.register(kind({ maxActive: 8 }));
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const results = [
			{ outcome: "completed", result: { summary: 42 } },
			{ outcome: "completed", result: { output: null, summary: "kept" } },
			{ outcome: "completed", result: { data: 10n } },
			{ outcome: "completed", result: { data: circular, child: { conversation: "not a session id" } } },
			{ outcome: "failed", error: { message: "not text" } },
		];
		const records = await Promise.all(
			results.map((result) => registry.start("ext:test/run", null, async () => result as unknown as WorkExecution)),
		);
		await registry.waitForIdle();
		expect(records.map((record) => registry.get(record.workId)?.outcome)).toEqual([
			"completed",
			"completed",
			"completed",
			"completed",
			"failed",
		]);
		expect(registry.get(records[1]!.workId)?.result).toEqual({ summary: "kept" });
		expect(registry.get(records[3]!.workId)?.result).toBeUndefined();
		expect(registry.get(records[4]!.workId)?.error).toBeUndefined();
	});

	it("queues at most a bounded number of notices, recording later results without one", async () => {
		const { registry, conversation } = await setup();
		registry.register(kind({ delivery: "message", maxActive: 64 }));
		const count = WORK_NOTICES_MAX_QUEUED + 4;
		for (let index = 0; index < count; index++) {
			await registry.start("ext:test/run", index, async () => ({ outcome: "completed" }));
			await registry.waitForIdle();
		}
		expect(registry.list().filter((record) => record.outcome === "completed")).toHaveLength(count);
		expect(conversation.state.clientInputs.queued).toHaveLength(WORK_NOTICES_MAX_QUEUED);
	});

	it("runs work awaiting approval only once it is approved, and ends it unrun when stopped first", async () => {
		const { registry, log } = await setup();
		registry.register(kind({ kind: "host_action", approval: true, cancellable: true }));
		let runs = 0;
		const execute: WorkExecutor = async () => {
			runs++;
			return { outcome: "completed" };
		};
		const approved = await registry.start("host_action", null, execute);
		const denied = await registry.start("host_action", null, execute);
		const closed = await registry.start("host_action", null, execute);
		expect(approved.state).toBe("awaiting_approval");
		await Promise.resolve();
		expect(runs).toBe(0);
		await registry.approve(approved.workId);
		await vi.waitFor(() => expect(registry.get(approved.workId)?.outcome).toBe("completed"));
		expect(runs).toBe(1);
		await expect(registry.approve(approved.workId)).rejects.toMatchObject({ code: "finished" });
		await registry.cancel(denied.workId);
		await vi.waitFor(() => expect(registry.get(denied.workId)?.outcome).toBe("cancelled"));
		await registry.cancelAll("closed");
		expect(registry.get(closed.workId)?.outcome).toBe("interrupted");
		expect(runs).toBe(1);
		const states = workEntries(await entriesOf(log))
			.filter((entry) => entry.type === "work_checkpoint")
			.map((entry) => entry.payload);
		expect(states).toEqual([
			{ workId: approved.workId, state: "running" },
			{ workId: denied.workId, state: "cancelling" },
		]);
	});

	it("resumes nothing an executor left behind by closing still runs, in the same process", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const first = await setup();
		const lingering = Promise.withResolvers<WorkExecution>();
		const resumable = kind({ kind: "subagent", resume: () => async () => ({ outcome: "completed" }) });
		first.registry.register(resumable);
		const child = await first.registry.start("subagent", null, () => lingering.promise);
		const closing = first.registry.cancelAll("closed");
		await vi.advanceTimersByTimeAsync(WORK_CLOSE_GRACE_MS);
		await closing;
		const second = await nextRuntime(first);
		second.registry.register(resumable);
		await expect(second.registry.resume(child.workId)).rejects.toMatchObject({ code: "running" });
		lingering.resolve({ outcome: "completed" });
		await vi.waitFor(async () => {
			await second.registry.resume(child.workId);
		});
		await second.registry.waitForIdle();
		expect(second.registry.get(child.workId)?.outcome).toBe("completed");
	});

	it("lets a client cancel suspended work no executor here can resume, whatever its kind declares", async () => {
		const first = await setup();
		const fixed = kind({
			kind: "subagent",
			cancellable: false,
			resume: () => async () => ({ outcome: "completed" }),
		});
		first.registry.register(fixed);
		const kept = await first.registry.start("subagent", null, held().execute);
		const orphan = await first.registry.start("subagent", null, held().execute);
		await first.registry.cancelAll("closed");
		const second = await nextRuntime(first);
		const keptRecord = second.registry.get(kept.workId);
		if (!keptRecord) throw new Error("Expected the suspended work");
		// Nothing here resumes it: it can only be cancelled.
		expect(second.registry.cancellable(keptRecord)).toBe(true);
		await second.registry.cancel(orphan.workId);
		expect(second.registry.get(orphan.workId)?.outcome).toBe("cancelled");
		second.registry.register(fixed);
		expect(second.registry.cancellable(keptRecord)).toBe(false);
		await expect(second.registry.cancel(kept.workId)).rejects.toMatchObject({ code: "not_cancellable" });
	});

	it("writes an unchanged phase once", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { registry, log } = await setup();
		registry.register(kind());
		const run = held();
		let ctx: Parameters<WorkExecutor>[0] | undefined;
		await registry.start("ext:test/run", null, async (context) => {
			ctx = context;
			return await run.execute(context);
		});
		await vi.waitFor(() => expect(ctx).toBeDefined());
		ctx?.checkpoint({ text: "same" });
		await vi.advanceTimersByTimeAsync(WORK_CHECKPOINT_INTERVAL_MS);
		ctx?.checkpoint({ text: "same" });
		await vi.advanceTimersByTimeAsync(WORK_CHECKPOINT_INTERVAL_MS);
		run.release();
		await registry.waitForIdle();
		const checkpoints = workEntries(await entriesOf(log)).filter((entry) => entry.type === "work_checkpoint");
		expect(checkpoints).toHaveLength(1);
	});

	it("removing a kind interrupts its work at once and ignores what the executor returns or reports afterwards", async () => {
		const { registry, log, live } = await setup();
		const remove = registry.register(kind());
		const lingering = Promise.withResolvers<WorkExecution>();
		let ctx: Parameters<WorkExecutor>[0] | undefined;
		const record = await registry.start("ext:test/run", null, async (context) => {
			ctx = context;
			return await lingering.promise;
		});
		await vi.waitFor(() => expect(ctx).toBeDefined());
		ctx?.output("before");
		await remove();
		expect(ctx?.signal.aborted).toBe(true);
		expect(registry.get(record.workId)).toMatchObject({ outcome: "interrupted" });
		expect(registry.running()).toEqual([]);
		expect(live.at(-1)).toEqual({ type: "clear", key: `work/${record.workId}` });
		const before = await entriesOf(log);
		ctx?.output("after");
		ctx?.progress({ text: "after" });
		ctx?.checkpoint({ text: "after" });
		lingering.resolve({ outcome: "completed", result: { summary: "too late" } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await entriesOf(log)).toEqual(before);
		expect(registry.get(record.workId)?.result).toBeUndefined();
		await expect(registry.start("ext:test/run", null, held().execute)).rejects.toMatchObject({
			code: "unknown_kind",
		});
		// The kind registers again, and a second removal does nothing more.
		registry.register(kind());
		await remove();
		expect((await registry.start("ext:test/run", null, async () => ({ outcome: "completed" }))).kind).toBe(
			"ext:test/run",
		);
		await registry.waitForIdle();
	});

	it("runs none of the work of a kind removed while the work started", async () => {
		const { registry } = await setup();
		const remove = registry.register(kind());
		const execute = vi.fn<WorkExecutor>(async () => ({ outcome: "completed" }));
		const starting = registry.start("ext:test/run", null, execute);
		await remove();
		const record = await starting;
		await registry.waitForIdle();
		expect(execute).not.toHaveBeenCalled();
		expect(registry.get(record.workId)?.outcome).toBe("interrupted");
	});

	it("titles an item as its start names it, and queues the notice text its execution gives", async () => {
		const { registry, conversation } = await setup();
		registry.register(kind({ delivery: "message" }));
		const record = await registry.start(
			"ext:test/run",
			{ n: 1 },
			async () => ({
				outcome: "completed",
				result: { summary: "short" },
				deliver: { text: "The whole \u001b[1mreport\u001b[0m\nline two" },
			}),
			{ title: "Custom\ntitle" },
		);
		expect(record.title).toBe("Custom title");
		await registry.waitForIdle();
		// The kind's own text follows the line naming its work.
		expect(conversation.queue.steer).toEqual([
			expect.objectContaining({
				customType: "work_notice",
				content: `Custom title (ext:test/run ${record.workId}) completed.\nThe whole report\nline two`,
			}),
		]);
		// Blank text falls back to the title and summary.
		const blank = await registry.start("ext:test/run", null, async () => ({
			outcome: "completed",
			deliver: { text: " \n" },
		}));
		await registry.waitForIdle();
		expect(conversation.queue.steer.at(-1)).toMatchObject({
			content: `Run null (ext:test/run ${blank.workId}) completed.`,
		});
	});

	it("tells what remote clients need for work of known kinds, and refuses work of an extension kind it does not know", async () => {
		const { registry } = await setup();
		const remove = registry.register(kind({ requires: ["host.manage.v1"] }));
		registry.register(kind({ kind: "job" }));
		const extension = await registry.start("ext:test/run", null, async () => ({ outcome: "completed" }));
		const job = await registry.start("job", null, async () => ({ outcome: "completed" }));
		await registry.waitForIdle();
		expect(registry.requires(extension.workId)).toEqual(["host.manage.v1"]);
		expect(registry.requires(job.workId)).toEqual([]);
		await remove();
		expect(registry.requires(extension.workId)).toBeUndefined();
		expect(registry.requires("missing")).toEqual([]);
	});

	it("stops with the run only work whose kind keeps nothing from remote clients", async () => {
		const { registry } = await setup();
		registry.register(kind());
		registry.register(kind({ kind: "ext:test/kept", cancelOnAbort: false }));
		registry.register(kind({ kind: "ext:test/guarded", requires: ["host.manage.v1"] }));
		registry.register(kind({ kind: "ext:test/local", remote: { cancel: false, resume: true } }));
		const runs = [held(), held(), held(), held()];
		const records = await Promise.all(
			["ext:test/run", "ext:test/kept", "ext:test/guarded", "ext:test/local"].map((name, index) =>
				registry.start(name, null, runs[index]!.execute),
			),
		);
		expect(records.map((record) => registry.cancelsWithRun(record.workId))).toEqual([true, false, false, false]);
		await registry.cancelAll("cancelled");
		expect(records.map((record) => registry.get(record.workId)?.outcome)).toEqual([
			"cancelled",
			undefined,
			undefined,
			undefined,
		]);
		for (const run of runs) run.release();
		await registry.waitForIdle();
		expect(registry.cancelsWithRun(records[1]!.workId)).toBe(false);
	});

	it("fails work whose executor throws a value that has no message, without leaving it running", async () => {
		const { registry } = await setup();
		registry.register(kind());
		const unprintable = {
			toString() {
				throw new Error("no text");
			},
		};
		const thrown = [Object.create(null), unprintable];
		const records = await Promise.all(
			thrown.map((value) =>
				registry.start("ext:test/run", null, async () => {
					throw value;
				}),
			),
		);
		await registry.waitForIdle();
		for (const record of records) {
			expect(registry.get(record.workId)).toMatchObject({ outcome: "failed", error: "Unknown error" });
		}
		expect(registry.running()).toEqual([]);
	});
});

describe("kind policies: stops, remote devices, and resume preparation", () => {
	/** Suspended `subagent` work in a next runtime whose kind resumes through `resume`. */
	async function suspended(resume: WorkKindDefinition["resume"]) {
		const first = await setup();
		first.registry.register(kind({ kind: "subagent", resume: () => async () => ({ outcome: "completed" }) }));
		const record = await first.registry.start("subagent", null, held().execute);
		await first.registry.cancelAll("closed");
		const second = await nextRuntime(first);
		second.registry.register(kind({ kind: "subagent", resume }));
		return { ...second, workId: record.workId };
	}

	it("a stop cancels running work, except of kinds that opt out", async () => {
		const { registry } = await setup();
		registry.register(kind());
		registry.register(kind({ kind: "subagent", cancelOnAbort: false }));
		const job = held();
		const child = held();
		const jobRecord = await registry.start("ext:test/run", null, job.execute);
		const childRecord = await registry.start("subagent", null, child.execute);
		await registry.cancelAll("cancelled");
		expect(registry.get(jobRecord.workId)?.outcome).toBe("cancelled");
		expect(registry.get(childRecord.workId)?.outcome).toBeUndefined();
		expect(registry.running().map((record) => record.workId)).toEqual([childRecord.workId]);
		await registry.cancel(childRecord.workId);
		await registry.waitForIdle();
		expect(registry.get(childRecord.workId)?.outcome).toBe("cancelled");
	});

	it("allows a remote device what a kind's policy allows, and nothing for a kind this host lacks", async () => {
		const { registry } = await setup();
		registry.register(kind());
		registry.register(kind({ kind: "subagent", remote: { cancel: false, resume: false } }));
		const job = await registry.start("ext:test/run", null, held().execute);
		const child = await registry.start("subagent", null, held().execute);
		expect(registry.remoteAllows(job, "cancel")).toBe(true);
		expect(registry.remoteAllows(child, "cancel")).toBe(false);
		expect(registry.remoteAllows(child, "resume")).toBe(false);
		expect(registry.remoteAllows({ ...job, kind: "ext:other/run" }, "cancel")).toBe(false);
		await registry.cancelAll("closed");
	});

	it("prepares a resume before the running checkpoint, and a failed preparation leaves the work suspended", async () => {
		let fail = true;
		const runtime = await suspended(async () => {
			if (fail) throw new Error("its log is locked");
			return async () => ({ outcome: "completed" });
		});
		const before = workEntries(await entriesOf(runtime.log)).length;
		await expect(runtime.registry.resume(runtime.workId)).rejects.toMatchObject({
			code: "unavailable",
			message: expect.stringContaining("its log is locked"),
		});
		// No checkpoint claimed it ran; it is suspended again and may be resumed.
		expect(workEntries(await entriesOf(runtime.log))).toHaveLength(before);
		expect(runtime.registry.running()).toEqual([]);
		expect(runtime.registry.get(runtime.workId)?.outcome).toBeUndefined();
		fail = false;
		await runtime.registry.resume(runtime.workId);
		await runtime.registry.waitForIdle();
		expect(runtime.registry.get(runtime.workId)?.outcome).toBe("completed");
	});

	it("a cancel during the preparation ends the work, and the prepared executor runs stopped to release it", async () => {
		const prepared = Promise.withResolvers<void>();
		const released = vi.fn();
		const runtime = await suspended(async () => {
			await prepared.promise;
			return async (ctx) => {
				if (ctx.signal.aborted) released();
				return { outcome: "cancelled" };
			};
		});
		const resuming = runtime.registry.resume(runtime.workId);
		await vi.waitFor(() => expect(runtime.registry.running()).toHaveLength(1));
		await runtime.registry.cancel(runtime.workId);
		prepared.resolve();
		await resuming;
		await runtime.registry.waitForIdle();
		expect(released).toHaveBeenCalledOnce();
		expect(runtime.registry.get(runtime.workId)?.outcome).toBe("cancelled");
		const types = workEntries(await entriesOf(runtime.log)).map((entry) => entry.payload);
		// The work went from suspended to cancelling, never back to running.
		expect(types.slice(-2)).toEqual([
			{ workId: runtime.workId, state: "cancelling" },
			{ workId: runtime.workId, outcome: "cancelled" },
		]);
	});

	it("a close during the preparation leaves resumable work suspended", async () => {
		const prepared = Promise.withResolvers<void>();
		const runtime = await suspended(async () => {
			await prepared.promise;
			return async () => ({ outcome: "cancelled" });
		});
		const resuming = runtime.registry.resume(runtime.workId);
		await vi.waitFor(() => expect(runtime.registry.running()).toHaveLength(1));
		const closing = runtime.registry.cancelAll("closed");
		prepared.resolve();
		await resuming;
		await closing;
		expect(runtime.registry.get(runtime.workId)?.outcome).toBeUndefined();
		expect(runtime.registry.running()).toEqual([]);
	});
});

describe("work registry bounds and activity", () => {
	it("counts suspended work against its kind's maxActive, and admits its own resume at the limit", async () => {
		const first = await setup();
		const resumable = kind({
			kind: "subagent",
			maxActive: 2,
			resume: () => async () => ({ outcome: "completed" }),
		});
		first.registry.register(resumable);
		const a = await first.registry.start("subagent", 1, held().execute);
		await first.registry.start("subagent", 2, held().execute);
		await first.registry.cancelAll("closed");
		const second = await nextRuntime(first);
		second.registry.register(resumable);
		const record = second.registry.get(a.workId);
		if (!record) throw new Error("Expected the suspended work");
		expect(second.registry.suspended(record)).toBe(true);
		expect(second.registry.busy()).toBe(false);
		// Two suspended items fill the kind: a restart never piles more up.
		await expect(second.registry.start("subagent", 3, held().execute)).rejects.toMatchObject({ code: "limit" });
		await second.registry.resume(a.workId);
		await second.registry.waitForIdle();
		expect(second.registry.get(a.workId)?.outcome).toBe("completed");
		const third = await second.registry.start("subagent", 3, async () => ({ outcome: "completed" }));
		await second.registry.waitForIdle();
		expect(second.registry.get(third.workId)?.outcome).toBe("completed");
	});

	it("records at most WORK_CHECKPOINTS_MAX checkpoints over an item's lifetime; later phases stay live", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { registry, live } = await setup();
		registry.register(kind());
		const ctx = Promise.withResolvers<WorkContext>();
		const running = held();
		const record = await registry.start("ext:test/run", null, async (context) => {
			ctx.resolve(context);
			return await running.execute(context);
		});
		const context = await ctx.promise;
		const phases = WORK_CHECKPOINTS_MAX + 4;
		for (let index = 0; index < phases; index++) {
			context.checkpoint({ text: `phase ${index}` });
			await vi.advanceTimersByTimeAsync(WORK_CHECKPOINT_INTERVAL_MS);
		}
		expect(registry.get(record.workId)?.checkpoints).toBe(WORK_CHECKPOINTS_MAX);
		expect(registry.get(record.workId)?.progress).toEqual({ text: `phase ${WORK_CHECKPOINTS_MAX - 1}` });
		const values = live.flatMap((item) => (item.type === "set" && item.value.kind === "work" ? [item.value] : []));
		expect(values.at(-1)?.progress).toEqual({ text: `phase ${phases - 1}` });
		running.release();
		vi.useRealTimers();
		await registry.waitForIdle();
		expect(registry.get(record.workId)?.outcome).toBe("completed");
	});

	it("counts running work as busy, but not work awaiting approval", async () => {
		const { registry } = await setup();
		registry.register(kind({ kind: "host_action", approval: true }));
		const action = held();
		const record = await registry.start("host_action", null, action.execute);
		expect(registry.running().map((running) => running.workId)).toEqual([record.workId]);
		expect(registry.busy()).toBe(false);
		await registry.waitForNotBusy();
		await registry.approve(record.workId);
		expect(registry.busy()).toBe(true);
		let idle = false;
		const waiting = registry.waitForNotBusy().then(() => {
			idle = true;
		});
		await Promise.resolve();
		expect(idle).toBe(false);
		action.release();
		await waiting;
		expect(registry.busy()).toBe(false);
	});

	it("tells subscribers when work entries commit and when executors attach or detach", async () => {
		const { registry } = await setup();
		registry.register(kind());
		const observer = vi.fn();
		const unsubscribe = registry.subscribe(observer);
		registry.subscribe(() => {
			throw new Error("observers never affect work");
		});
		const running = held();
		await registry.start("ext:test/run", null, running.execute);
		expect(observer).toHaveBeenCalled();
		const attached = observer.mock.calls.length;
		running.release();
		await registry.waitForIdle();
		expect(observer.mock.calls.length).toBeGreaterThan(attached);
		unsubscribe();
		const calls = observer.mock.calls.length;
		registry.changed();
		expect(observer).toHaveBeenCalledTimes(calls);
	});
});
