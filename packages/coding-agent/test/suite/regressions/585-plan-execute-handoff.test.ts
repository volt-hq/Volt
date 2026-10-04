import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { PLAN_EXECUTION_CUSTOM_TYPE, type PlanPhase } from "../../../src/core/planning.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
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
});
