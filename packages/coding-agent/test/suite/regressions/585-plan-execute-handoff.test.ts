import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { PLAN_EXECUTION_CUSTOM_TYPE, type PlanPhase } from "../../../src/core/planning.ts";
import { findSessionInfoById, SessionManager } from "../../../src/core/session-manager.ts";
import { createHostHarness } from "../host-harness.ts";

/** The plan phase of the last planning snapshot on a branch. */
function lastPlanPhase(entries: ReadonlyArray<{ type: string }>): PlanPhase | undefined {
	const snapshots = entries.filter(
		(entry): entry is { type: "planning_state_change"; planning: { plan: { phase: PlanPhase } | null } } =>
			entry.type === "planning_state_change",
	);
	return snapshots.at(-1)?.planning.plan?.phase;
}

describe("regression #585: executing a plan in a new session hands it off through the still-open source", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup() {
		/** For each session_shutdown: the session, and the plan phase its log held. */
		const shutdowns: Array<{ sessionId: string; phase: PlanPhase | undefined }> = [];
		const harness = await createHostHarness({
			responses: ["execution reply"],
			extension: (volt) => {
				volt.on("session_shutdown", (_event, ctx) => {
					shutdowns.push({
						sessionId: ctx.sessionManager.getSessionId(),
						phase: lastPlanPhase(ctx.sessionManager.getBranch()),
					});
				});
			},
		});
		const source = await harness.openStartup();
		const runtime = new AgentSessionRuntime(harness.host, source);
		cleanups.push(async () => {
			await runtime.dispose();
			await harness.cleanup();
		});
		await source.session.setAgentMode("plan");
		const draft = await source.session.updatePlan({
			title: "Hand off",
			summary: "Execute in a fresh session.",
			steps: [{ text: "Make the change" }],
		});
		const ready = await source.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Hand off",
			summary: "Execute in a fresh session.",
		});
		return { harness, source, runtime, ready, shutdowns };
	}

	it("records handed_off in the source before it closes, without reopening it, and starts the plan in the new session", async () => {
		const { source, runtime, ready, shutdowns } = await setup();
		const sourceId = source.id;
		const sourceRef = source.session.sessionRef!;
		const reopen = vi.spyOn(SessionManager, "open");

		const result = await runtime.executePlan(ready.id, ready.revision, "new_session");

		const target = runtime.session;
		expect(result.started).toBe(true);
		expect(result.selectedSessionId).toBe(target.sessionId);
		expect(target.sessionId).not.toBe(sourceId);
		expect(reopen).not.toHaveBeenCalled();
		// The source's log held the handoff before the source closed.
		expect(shutdowns).toEqual([{ sessionId: sourceId, phase: "handed_off" }]);
		expect(target.planningState.plan).toMatchObject({
			id: ready.id,
			phase: "active",
			execution: { strategy: "new_session", sourceSessionId: sourceId, targetSessionId: target.sessionId },
		});
		await target.waitForIdle();
		expect(
			target.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === PLAN_EXECUTION_CUSTOM_TYPE),
		).toHaveLength(1);
		expect(target.messages.at(-1)?.role).toBe("assistant");

		reopen.mockRestore();
		const stored = await SessionManager.open(sourceRef);
		try {
			expect(stored.getConversationState().planning).toMatchObject({
				mode: "build",
				plan: { id: ready.id, phase: "handed_off", execution: { targetSessionId: target.sessionId } },
			});
		} finally {
			await stored.closePersistence();
		}
	});

	it("keeps the client on the source, with the plan still ready, when the handoff cannot be recorded there", async () => {
		const { harness, source, runtime, ready, shutdowns } = await setup();
		vi.spyOn(source.session, "markPlanHandedOff").mockRejectedValueOnce(new Error("handoff refused"));

		await expect(runtime.executePlan(ready.id, ready.revision, "new_session")).rejects.toThrow("handoff refused");

		expect(runtime.session).toBe(source.session);
		expect(harness.host.list()).toEqual([source]);
		expect(shutdowns).toEqual([]);
		expect(source.session.planningState.plan).toMatchObject({ id: ready.id, phase: "ready" });

		// The plan can still be executed from the source.
		const retried = await runtime.executePlan(ready.id, ready.revision, "new_session");
		expect(retried).toMatchObject({ started: true, selectedSessionId: runtime.session.sessionId });
		expect(shutdowns).toEqual([{ sessionId: source.id, phase: "handed_off" }]);
	});

	it("queues the execution in the new log of a redirected client, and runs it once that conversation opens", async () => {
		const { harness, source, runtime, ready, shutdowns } = await setup();
		const view = runtime.attachRedirectClient();
		cleanups.push(() => view.dispose());
		const redirects: string[] = [];
		view.onClientDetached((detachment) => {
			if (detachment.kind === "redirected") redirects.push(detachment.sessionId);
		});

		const result = await view.executePlan(ready.id, ready.revision, "new_session");

		expect(result.started).toBe(true);
		expect(redirects).toEqual([result.selectedSessionId]);
		// The source stays open for its other client, with the plan handed off.
		expect(runtime.session).toBe(source.session);
		expect(source.session.planningState.plan).toMatchObject({
			id: ready.id,
			phase: "handed_off",
			execution: { targetSessionId: result.selectedSessionId },
		});
		expect(shutdowns).toEqual([]);

		// The host the client reconnects through opens the new conversation; its client's attach starts the queued turn.
		const info = await findSessionInfoById(source.session.sessionManager.getSessionDir(), result.selectedSessionId);
		if (!info) throw new Error("the new session is not stored");
		const opened = await harness.host.open({ kind: "session", ref: info.ref });
		if (opened.cancelled) throw new Error("the open was cancelled");
		const target = opened.conversation;
		expect(target.session.planningState.plan).toMatchObject({ id: ready.id, phase: "active" });
		await harness.host.attach(harness.client("phone"), target);
		await target.startRecoveredClientInputs();
		expect(
			target.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === PLAN_EXECUTION_CUSTOM_TYPE),
		).toHaveLength(1);
		expect(target.session.messages.at(-1)?.role).toBe("assistant");
	});

	it("opens the new conversation in the host of a client whose host takes its redirect targets", async () => {
		const { harness, source, runtime, ready } = await setup();
		let hosted: AgentSessionRuntime | undefined;
		const view = runtime.attachRedirectClient({
			hostTarget: async (target) => ({
				commit: async () => {
					hosted = target.runtime;
				},
				abort: async () => {},
			}),
		});
		cleanups.push(() => view.dispose());

		const result = await view.executePlan(ready.id, ready.revision, "new_session");

		if (!hosted) throw new Error("the new conversation was not handed over");
		const target = hosted;
		cleanups.push(() => target.dispose());
		expect(target.session.sessionId).toBe(result.selectedSessionId);
		expect(harness.host.list().map((conversation) => conversation.id)).toEqual([source.id, result.selectedSessionId]);
		expect(source.session.planningState.plan).toMatchObject({ id: ready.id, phase: "handed_off" });
		// No turn runs before a client attaches; the client's attach binds the extensions, then recovery runs the plan.
		expect(target.session.messages).toEqual([]);
		await target.session.attachExtensionClient({ id: "phone", mode: "rpc" }).ready;
		await target.startRecoveredClientInputs();
		expect(target.session.messages.at(-1)?.role).toBe("assistant");
		expect(target.session.planningState.plan).toMatchObject({ id: ready.id, phase: "active" });
	});

	it("prepares the hosted target before writing through the source, and abandons it when that write fails", async () => {
		const { harness, source, runtime, ready } = await setup();
		const steps: string[] = [];
		const handedOff = vi.spyOn(source.session, "markPlanHandedOff").mockImplementationOnce(async () => {
			steps.push("source write");
			throw new Error("handoff refused");
		});
		const view = runtime.attachRedirectClient({
			hostTarget: async () => {
				steps.push("prepare");
				return {
					commit: async () => void steps.push("commit"),
					abort: async () => void steps.push("abort"),
				};
			},
		});
		cleanups.push(() => view.dispose());

		await expect(view.executePlan(ready.id, ready.revision, "new_session")).rejects.toThrow("handoff refused");

		expect(handedOff).toHaveBeenCalledOnce();
		expect(steps).toEqual(["prepare", "source write", "abort"]);
		expect(harness.host.list()).toEqual([source]);
		expect(source.session.planningState.plan).toMatchObject({ id: ready.id, phase: "ready" });
	});
});
