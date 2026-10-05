/**
 * Host actions (RFC §7.2) over a real conversation kernel, work registry,
 * and live state: an action is `host_action` work awaiting approval with an
 * approval host request under its work id; only clients that accept
 * approvals are asked; an approval runs it, and any other answer, a timeout,
 * a cancel, or a close ends it without running. Approvals never outlive their
 * runtime.
 */

import {
	Conversation,
	type ConversationLogEntry,
	InMemoryConversationLog,
	type StreamFn,
} from "@hansjm10/volt-agent-core";
import type { HostResponse, LiveItem } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveState } from "../src/core/host/live-state.ts";
import {
	HOST_ACTION_WORK_KIND,
	HOST_ACTIONS_MAX_ACTIVE,
	type HostActionRequest,
	SessionHostActions,
} from "../src/core/session/host-actions.ts";
import { type WorkExecution, type WorkExecutor, WorkRegistry } from "../src/core/work/registry.ts";

const noTurns: StreamFn = () => {
	throw new Error("No turn runs in this test");
};

const opened: Conversation[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const conversation of opened.splice(0)) await conversation.close().catch(() => undefined);
});

interface Setup {
	readonly log: InMemoryConversationLog;
	readonly conversation: Conversation;
	readonly liveState: LiveState;
	readonly registry: WorkRegistry;
	readonly actions: SessionHostActions;
	/** What a client that sees no host requests was sent. */
	readonly observed: LiveItem[];
}

async function setup(log = new InMemoryConversationLog("host-actions")): Promise<Setup> {
	const conversation = await Conversation.open({ log, stream: noTurns, resolveModel: () => undefined });
	opened.push(conversation);
	const liveState = new LiveState({ head: () => conversation.state.ordinal });
	const observed: LiveItem[] = [];
	liveState.attach("observer", { acceptsHostRequest: () => false, apply: (update) => observed.push(...update.items) });
	const registry = new WorkRegistry({
		conversationId: () => conversation.conversationId,
		work: () => conversation.work,
		state: () => conversation.state,
		live: () => liveState,
		turnId: () => undefined,
	});
	registry.register(HOST_ACTION_WORK_KIND);
	await registry.reconcile();
	return {
		log,
		conversation,
		liveState,
		registry,
		actions: new SessionHostActions({ liveState, work: () => registry }),
		observed,
	};
}

/** A client that accepts approvals; it answers those `answer` returns a response for, and keeps the rest pending. */
function approver(
	setup: Setup,
	answer: (requestId: string) => HostResponse | undefined = () => ({ decision: "approved" }),
): { asked: Array<{ requestId: string; request: HostActionRequest }> } {
	const asked: Array<{ requestId: string; request: HostActionRequest }> = [];
	setup.liveState.attach("approver", {
		acceptsHostRequest: (kind) => kind === "approval",
		apply: (update) => {
			for (const item of update.items) {
				if (item.type !== "set" || item.value.kind !== "host_request" || item.value.request.kind !== "approval") {
					continue;
				}
				const { requestId, request } = item.value;
				const { kind: _kind, ...rest } = request;
				asked.push({ requestId, request: rest });
				const response = answer(requestId);
				if (response) queueMicrotask(() => setup.liveState.answer(requestId, response, "approver"));
			}
		},
	});
	return { asked };
}

const REQUEST: HostActionRequest = {
	action: "test.install",
	title: "Install the test tool?",
	commandPreview: "npm install -g test-tool",
	metadata: { tool: "test-tool" },
};

function counting(execution: WorkExecution = { outcome: "completed", result: { summary: "installed" } }): {
	execute: WorkExecutor;
	runs: () => number;
} {
	let runs = 0;
	return {
		execute: async (ctx) => {
			runs++;
			ctx.checkpoint({ text: "Installing" });
			return execution;
		},
		runs: () => runs,
	};
}

async function entriesOf(log: InMemoryConversationLog): Promise<ConversationLogEntry[]> {
	return [...(await log.read(0, 1_000)).entries];
}

function workEntries(entries: readonly ConversationLogEntry[]): Array<{ type: string; payload: unknown }> {
	return entries
		.filter((entry) => entry.type.startsWith("work_"))
		.map((entry) => ({ type: entry.type, payload: entry.payload }));
}

describe("host actions", () => {
	it("asks nothing and records nothing when no attached client accepts approvals", async () => {
		const host = await setup();
		const { execute, runs } = counting();
		expect(await host.actions.run(REQUEST, execute)).toEqual({ status: "unavailable" });
		expect(host.registry.list()).toEqual([]);
		expect(host.liveState.pendingRequests()).toEqual([]);
		expect(runs()).toBe(0);
	});

	it("runs an approved action as host_action work, its approval keyed by the work id", async () => {
		const host = await setup();
		const { asked } = approver(host);
		const { execute, runs } = counting();
		const outcome = await host.actions.run({ ...REQUEST, timeoutMs: 60_000 }, execute);
		expect(outcome).toEqual({ status: "ran", execution: { outcome: "completed", result: { summary: "installed" } } });
		expect(runs()).toBe(1);
		const [record] = host.registry.list();
		expect(asked).toEqual([{ requestId: record?.workId, request: { ...REQUEST, timeoutMs: 60_000 } }]);
		await host.registry.waitForIdle();
		expect(host.registry.get(record!.workId)).toMatchObject({
			kind: "host_action",
			title: REQUEST.title,
			input: {
				action: "test.install",
				title: REQUEST.title,
				commandPreview: REQUEST.commandPreview,
				metadata: { tool: "test-tool" },
			},
			cancellable: true,
			delivery: "none",
			resume: false,
			outcome: "completed",
			result: { summary: "installed" },
		});
		expect(workEntries(await entriesOf(host.log))).toEqual([
			{ type: "work_started", payload: expect.objectContaining({ state: "awaiting_approval" }) },
			{ type: "work_checkpoint", payload: { workId: record?.workId, state: "running" } },
			{ type: "work_checkpoint", payload: { workId: record?.workId, progress: { text: "Installing" } } },
			{ type: "work_finished", payload: expect.objectContaining({ outcome: "completed" }) },
		]);
		// A client that does not accept approvals never sees the request, only the work.
		expect(host.observed.some((item) => item.type === "set" && item.key.startsWith("host_request/"))).toBe(false);
		expect(host.liveState.pendingRequests()).toEqual([]);
	});

	it.each([
		{ answer: { decision: "denied", message: "not now" }, message: "not now" },
		{ answer: { decision: "dismissed" }, message: undefined },
		{ answer: { cancelled: true }, message: undefined },
	] as const)("finishes an action answered $answer cancelled, without running it", async ({ answer, message }) => {
		const host = await setup();
		approver(host, () => answer);
		const { execute, runs } = counting();
		const outcome = await host.actions.run(REQUEST, execute);
		expect(outcome).toEqual({ status: "declined", ...(message === undefined ? {} : { message }) });
		await host.registry.waitForIdle();
		expect(runs()).toBe(0);
		const [record] = host.registry.list();
		expect(record).toMatchObject({ state: "cancelling", outcome: "cancelled" });
		expect(record?.progress).toBeUndefined();
	});

	it("takes the first valid answer: later answers and answers from clients that do not accept approvals are refused", async () => {
		const host = await setup();
		const { asked } = approver(host, () => undefined);
		const { execute, runs } = counting();
		const pending = host.actions.run(REQUEST, execute);
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		const requestId = asked[0]!.requestId;
		expect(host.liveState.answer(requestId, { decision: "approved" }, "observer")).toBe("not_allowed");
		expect(host.liveState.answer(requestId, { confirmed: true }, "approver")).toBe("invalid");
		expect(host.liveState.answer(requestId, { decision: "denied" }, "approver")).toBe("accepted");
		expect(host.liveState.answer(requestId, { decision: "approved" }, "approver")).toBe("unknown");
		expect(await pending).toEqual({ status: "declined" });
		expect(runs()).toBe(0);
	});

	it("ends an unanswered approval at its timeout", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const host = await setup();
		approver(host, () => undefined);
		const { execute, runs } = counting();
		const pending = host.actions.run({ ...REQUEST, timeoutMs: 1_000 }, execute);
		await vi.waitFor(() => expect(host.liveState.pendingRequests()).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await pending).toEqual({ status: "declined", message: "Host action timed out" });
		await host.registry.waitForIdle();
		expect(host.registry.list()[0]).toMatchObject({ outcome: "cancelled" });
		expect(runs()).toBe(0);
	});

	it("withdraws the approval when the work is cancelled or the caller's signal aborts", async () => {
		const host = await setup();
		const { asked } = approver(host, () => undefined);
		const { execute, runs } = counting();
		const cancelled = host.actions.run(REQUEST, execute);
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		await host.registry.cancel(asked[0]!.requestId);
		expect(await cancelled).toEqual({ status: "declined", message: "Host action cancelled" });
		expect(host.liveState.pendingRequest(asked[0]!.requestId)).toBeUndefined();

		const controller = new AbortController();
		const aborted = host.actions.run(REQUEST, execute, { signal: controller.signal });
		await vi.waitFor(() => expect(asked).toHaveLength(2));
		controller.abort();
		expect(await aborted).toEqual({ status: "declined", message: "Host action cancelled" });
		expect(host.liveState.pendingRequests()).toEqual([]);
		await host.registry.waitForIdle();
		expect(host.registry.list().map((record) => record.outcome)).toEqual(["cancelled", "cancelled"]);
		expect(runs()).toBe(0);
	});

	it("cancels a running action through its work, and an abort of the run leaves it running", async () => {
		const host = await setup();
		approver(host);
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<WorkExecution>();
		const pending = host.actions.run(REQUEST, async (ctx) => {
			started.resolve();
			ctx.signal.addEventListener("abort", () => released.resolve({ outcome: "cancelled" }), { once: true });
			return await released.promise;
		});
		await started.promise;
		const [record] = host.registry.running();
		await host.registry.cancelAll("cancelled");
		expect(host.registry.get(record!.workId)).toMatchObject({ state: "running" });
		expect(host.registry.get(record!.workId)?.outcome).toBeUndefined();
		await host.registry.cancel(record!.workId);
		expect(await pending).toEqual({ status: "ran", execution: { outcome: "cancelled" } });
		await host.registry.waitForIdle();
		expect(host.registry.get(record!.workId)).toMatchObject({ state: "cancelling", outcome: "cancelled" });
	});

	it("never runs an action the conversation closed under, before or after its approval was answered", async () => {
		const host = await setup();
		const { asked } = approver(host, () => undefined);
		const { execute, runs } = counting();
		const pending = host.actions.run(REQUEST, execute);
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		await host.registry.cancelAll("closed");
		host.liveState.close();
		expect((await pending).status).toBe("declined");
		expect(host.registry.list()[0]).toMatchObject({ outcome: "interrupted" });
		expect(runs()).toBe(0);
		expect(await host.actions.run(REQUEST, execute)).toEqual({ status: "unavailable" });
	});

	it("interrupts an action still awaiting approval when the next runtime opens the conversation", async () => {
		const first = await setup();
		const { asked } = approver(first, () => undefined);
		const { execute, runs } = counting();
		void first.actions.run(REQUEST, execute);
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		const workId = asked[0]!.requestId;
		// The runtime ends without closing: its log keeps the open work.
		const entries = await entriesOf(first.log);
		const log = new InMemoryConversationLog(first.log.conversationId);
		await log.append({
			expectedOrdinal: 0,
			commitId: "copy",
			entries: entries.map(({ ordinal: _ordinal, ...draft }) => draft),
		});
		const second = await setup(log);
		expect(second.registry.get(workId)).toMatchObject({ state: "awaiting_approval", outcome: "interrupted" });
		// Its approval died with its runtime: answering it now finds nothing.
		approver(second);
		expect(second.liveState.answer(workId, { decision: "approved" }, "approver")).toBe("unknown");
		await expect(second.registry.approve(workId)).rejects.toMatchObject({ code: "finished" });
		expect(runs()).toBe(0);
	});

	it(`runs at most ${HOST_ACTIONS_MAX_ACTIVE} actions at once; past that nothing is asked`, async () => {
		const host = await setup();
		const { asked } = approver(host, () => undefined);
		const { execute } = counting();
		for (let index = 0; index < HOST_ACTIONS_MAX_ACTIVE; index++) void host.actions.run(REQUEST, execute);
		await vi.waitFor(() => expect(asked).toHaveLength(HOST_ACTIONS_MAX_ACTIVE));
		expect(await host.actions.run(REQUEST, execute)).toMatchObject({ status: "unavailable" });
		expect(asked).toHaveLength(HOST_ACTIONS_MAX_ACTIVE);
		await host.registry.cancelAll("closed");
	});

	it("reports an executor that throws as its failed execution", async () => {
		const host = await setup();
		approver(host);
		const outcome = await host.actions.run(REQUEST, async () => {
			throw new Error("installer crashed");
		});
		expect(outcome).toEqual({ status: "ran", execution: { outcome: "failed", error: "installer crashed" } });
		await host.registry.waitForIdle();
		expect(host.registry.list()[0]).toMatchObject({ outcome: "failed", error: "installer crashed" });
	});
});
