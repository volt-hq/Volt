import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getPlanLeafSteps, type PlanStepStatus } from "../../src/core/planning.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { initTheme } from "../../src/core/theme/runtime.ts";
import type { PlanStepInput } from "../../src/core/tools/planning.ts";
import { PlanStatusComponent } from "../../src/modes/interactive/components/plan-status.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const layouts: Array<{ name: string; steps: PlanStepInput[] }> = [
	{ name: "flat", steps: [{ text: "First" }, { text: "Second" }, { text: "Third" }] },
	{
		name: "grouped",
		steps: [{ text: "Outcome", substeps: [{ text: "First" }, { text: "Second" }, { text: "Third" }] }],
	},
	{
		name: "mixed",
		steps: [{ text: "First" }, { text: "Outcome", substeps: [{ text: "Second" }, { text: "Third" }] }],
	},
];

type ProgressUpdate = { id: string; status: PlanStepStatus; note?: string };

async function progress(harness: Harness, updates: ProgressUpdate[]) {
	const plan = harness.session.planningState.plan!;
	return harness.session.updatePlanProgress({ planId: plan.id, expectedRevision: plan.revision, updates });
}

async function expectRejected(harness: Harness, updates: ProgressUpdate[], error: string | RegExp) {
	const before = harness.session.planningState;
	const entries = harness.sessionManager.getBranch().filter((entry) => entry.type === "planning_state_change");
	const events = harness.eventsOfType("planning_state_changed");
	await expect(progress(harness, updates)).rejects.toThrow(error);
	expect(harness.session.planningState).toEqual(before);
	expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "planning_state_change")).toEqual(
		entries,
	);
	expect(harness.eventsOfType("planning_state_changed")).toEqual(events);
}

describe("sequential approved-plan progress", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0).reverse()) await harness.cleanupAsync();
	});

	async function approved(steps = layouts[0]!.steps, options: Pick<HarnessOptions, "log" | "settings"> = {}) {
		const harness = await createHarness({ ...options, tools: [] });
		harnesses.push(harness);
		await harness.session.setAgentMode("plan");
		const draft = await harness.session.updatePlan({ title: "Serial work", summary: "Verify each item.", steps });
		const ready = await harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: draft.title!,
			summary: draft.summary!,
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "serial-execution",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		return harness;
	}

	describe.each(layouts)("$name leaves", ({ steps }) => {
		it.each([false, true])("advances one committed item at a time (reverse batch: %s)", async (reverse) => {
			const harness = await approved(steps);
			const original = harness.session.planningState.plan!;
			const leaves = getPlanLeafSteps(original);
			await progress(harness, [{ id: leaves[0]!.id, status: "in_progress" }]);
			for (let index = 0; index < leaves.length; index++) {
				const updates: ProgressUpdate[] = [{ id: leaves[index]!.id, status: "completed", note: "Verified" }];
				if (leaves[index + 1]) updates.push({ id: leaves[index + 1]!.id, status: "in_progress" });
				if (reverse) updates.reverse();
				const plan = await progress(harness, updates);
				expect(getPlanLeafSteps(plan).map((leaf) => leaf.status)).toEqual(
					leaves.map((_, position) =>
						position <= index ? "completed" : position === index + 1 ? "in_progress" : "pending",
					),
				);
				expect(plan.phase).toBe(index === leaves.length - 1 ? "completed" : "active");
				expect(plan).toMatchObject({
					title: original.title,
					summary: original.summary,
					execution: original.execution,
				});
				expect(getPlanLeafSteps(plan).map(({ id, text }) => ({ id, text }))).toEqual(
					leaves.map(({ id, text }) => ({ id, text })),
				);
			}
		});

		it("rejects skips, parallel starts, unstarted/bulk completion and reopening", async () => {
			const harness = await approved(steps);
			const [first, second, third] = getPlanLeafSteps(harness.session.planningState.plan!);
			for (const updates of [
				[{ id: first!.id, status: "completed" as const }],
				[{ id: second!.id, status: "in_progress" as const }],
				[
					{ id: first!.id, status: "in_progress" as const },
					{ id: second!.id, status: "in_progress" as const },
				],
				[
					{ id: first!.id, status: "completed" as const },
					{ id: second!.id, status: "completed" as const },
				],
			]) {
				await expectRejected(harness, updates, first!.id);
			}
			await progress(harness, [{ id: first!.id, status: "in_progress" }]);
			await expectRejected(harness, [{ id: second!.id, status: "in_progress" }], first!.id);
			await expectRejected(
				harness,
				[
					{ id: first!.id, status: "completed" },
					{ id: second!.id, status: "completed" },
				],
				/committed in_progress start/,
			);
			await expectRejected(
				harness,
				[
					{ id: first!.id, status: "completed" },
					{ id: third!.id, status: "in_progress" },
				],
				second!.id,
			);
			await progress(harness, [
				{ id: first!.id, status: "completed" },
				{ id: second!.id, status: "in_progress" },
			]);
			for (const status of ["pending", "in_progress"] as const) {
				await expectRejected(harness, [{ id: first!.id, status }], /request_replan/);
			}
		});
	});

	it("presents only the committed current leaf as execution advances and pauses", async () => {
		initTheme("dark");
		const harness = await approved(layouts[2]!.steps);
		const [first, second, third] = getPlanLeafSteps(harness.session.planningState.plan!);
		const status = new PlanStatusComponent(harness.session.planningState);
		expect(status.render(100).lines.map(stripAnsi).join("\n")).toContain("1 First");
		await progress(harness, [{ id: first!.id, status: "in_progress" }]);
		await progress(harness, [
			{ id: first!.id, status: "completed" },
			{ id: second!.id, status: "in_progress" },
		]);
		status.setPlanning(harness.session.planningState);
		const active = status.render(100).lines.map(stripAnsi).join("\n");
		expect(active).toContain("1/3");
		expect(active).toContain("2.1 Second");
		expect(active).not.toContain("Third");
		await progress(harness, [{ id: second!.id, status: "pending" }]);
		status.setPlanning(harness.session.planningState);
		expect(status.render(100).lines.map(stripAnsi).join("\n")).toContain("2.1 Second");
		await progress(harness, [{ id: second!.id, status: "in_progress" }]);
		await progress(harness, [
			{ id: second!.id, status: "completed" },
			{ id: third!.id, status: "in_progress" },
		]);
		status.setPlanning(harness.session.planningState);
		expect(status.render(100).lines.map(stripAnsi).join("\n")).toContain("2.2 Third");
	});

	it("requires reapproval to revisit completed work and respects reordered retained leaves", async () => {
		const harness = await approved();
		const [first, second, third] = getPlanLeafSteps(harness.session.planningState.plan!);
		await progress(harness, [{ id: first!.id, status: "in_progress" }]);
		const before = await progress(harness, [{ id: first!.id, status: "completed", note: "Original evidence" }]);
		const draft = (
			await harness.session.requestReplan({
				planId: before.id,
				expectedRevision: before.revision,
				reason: "Revisit first with stronger verification",
			})
		).plan!;
		const revised = await harness.session.updatePlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			steps: [
				{ id: third!.id, text: third!.text },
				{ id: first!.id, text: first!.text },
				{ id: second!.id, text: second!.text },
				{ text: "Reverify first against stronger requirements" },
			],
		});
		expect(revised.steps[1]).toMatchObject({ status: "completed", note: "Original evidence" });
		await expect(progress(harness, [{ id: revised.steps[0]!.id, status: "in_progress" }])).rejects.toThrow(
			/only during approved/,
		);
		const ready = await harness.session.submitPlan({
			planId: revised.id,
			expectedRevision: revised.revision,
			title: revised.title!,
			summary: revised.summary!,
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			...before.execution!,
			id: "reordered-execution",
			approvedRevision: ready.revision,
		});
		await expectRejected(harness, [{ id: second!.id, status: "in_progress" }], third!.id);
		await progress(harness, [{ id: third!.id, status: "in_progress" }]);
		await progress(harness, [
			{ id: third!.id, status: "completed" },
			{ id: second!.id, status: "in_progress" },
		]);
		await progress(harness, [
			{ id: second!.id, status: "completed" },
			{ id: revised.steps[3]!.id, status: "in_progress" },
		]);
		expect((await progress(harness, [{ id: revised.steps[3]!.id, status: "completed" }])).phase).toBe("completed");
	});

	it("preserves the committed cursor through compaction and SQLite resume with nonserial history", async () => {
		const harness = await approved(undefined, {
			log: "sqlite",
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		});
		const original = harness.session.planningState.plan!;
		await harness.session.sessionWriter.appendPlanningState({
			mode: "build",
			plan: {
				...original,
				steps: original.steps.map((step) => ({ ...step, status: "in_progress" })),
			},
		});
		await harness.session.sessionWriter.appendPlanningState({ mode: "build", plan: original });
		await harness.session.setSessionName("Sequential persistence");
		for (const text of ["Earlier work", "Recent work"]) {
			await harness.session.sessionWriter.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			await harness.session.sessionWriter.appendMessage(fauxAssistantMessage(`${text} researched.`));
		}
		const [first, second, third] = getPlanLeafSteps(original);
		await progress(harness, [{ id: first!.id, status: "in_progress" }]);
		const committed = await progress(harness, [
			{ id: first!.id, status: "completed", note: "Verified first" },
			{ id: second!.id, status: "in_progress", note: "Second underway" },
		]);
		harness.setResponses([fauxAssistantMessage("First verified; second underway; third pending.")]);
		await harness.session.compact();
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.session.planningState.plan).toEqual(committed);
		const ref = harness.session.sessionRef!;
		harness.session.dispose();
		await harness.session.waitForClosed();
		const resumed = await createHarness({ sessionManager: await SessionManager.open(ref), tools: [] });
		harnesses.push(resumed);
		expect(resumed.session.planningState.plan).toEqual(committed);
		await expectRejected(resumed, [{ id: third!.id, status: "in_progress" }], second!.id);
		await progress(resumed, [
			{ id: second!.id, status: "completed" },
			{ id: third!.id, status: "in_progress" },
		]);
		expect((await progress(resumed, [{ id: third!.id, status: "completed" }])).phase).toBe("completed");
	});

	it.each([false, true])(
		"blocks inconsistent active/ready execution until replanning (parallel: %s)",
		async (parallel) => {
			const harness = await approved();
			const original = harness.session.planningState.plan!;
			const invalid = {
				...original,
				steps: original.steps.map((step, index) => ({
					...step,
					status: index === 1 || (parallel && index === 0) ? ("in_progress" as const) : ("pending" as const),
				})),
			};
			// Historical snapshots remain structurally readable; only execution boundaries enforce the cursor.
			await harness.session.sessionWriter.appendPlanningState({ mode: "build", plan: invalid });
			await expectRejected(
				harness,
				[{ id: invalid.steps[0]!.id, status: invalid.steps[0]!.status, note: "Evidence" }],
				/request_replan/,
			);
			const ready = {
				id: invalid.id,
				revision: invalid.revision,
				phase: "ready" as const,
				title: invalid.title,
				summary: invalid.summary,
				steps: invalid.steps,
			};
			await harness.session.sessionWriter.appendPlanningState({ mode: "plan", plan: ready });
			const before = harness.session.planningState;
			const events = harness.eventsOfType("planning_state_changed");
			await expect(harness.session.activatePlan(ready.id, ready.revision, original.execution!)).rejects.toThrow(
				/Change Plan/,
			);
			await expect(harness.session.markPlanHandedOff(ready.id, ready.revision, original.execution!)).rejects.toThrow(
				/Change Plan/,
			);
			expect(harness.session.planningState).toEqual(before);
			expect(harness.eventsOfType("planning_state_changed")).toEqual(events);
			const draft = (await harness.session.changePlan(ready.id, ready.revision)).plan!;
			expect(getPlanLeafSteps(draft).every((leaf) => leaf.status === "pending")).toBe(true);
		},
	);

	it.each(["request_replan", "manual", "change", "feedback"] as const)(
		"pauses active leaves and preserves completed work/evidence on %s",
		async (path) => {
			const harness = await approved(layouts[1]!.steps);
			const [first, second] = getPlanLeafSteps(harness.session.planningState.plan!);
			await progress(harness, [{ id: first!.id, status: "in_progress" }]);
			const before = await progress(harness, [
				{ id: first!.id, status: "completed", note: "Verified first" },
				{ id: second!.id, status: "in_progress", note: "Partly verified second" },
			]);
			if (path === "change" || path === "feedback") {
				await harness.session.sessionWriter.appendPlanningState({
					mode: "plan",
					plan: {
						id: before.id,
						revision: before.revision,
						phase: "ready",
						title: before.title,
						summary: before.summary,
						steps: before.steps,
					},
				});
			}
			if (path === "request_replan") {
				await harness.session.requestReplan({
					planId: before.id,
					expectedRevision: before.revision,
					reason: "Revise verification",
				});
			} else if (path === "manual") {
				await harness.session.setAgentMode("plan");
			} else if (path === "change") {
				await harness.session.changePlan(before.id, before.revision);
			} else {
				harness.setResponses([fauxAssistantMessage("I will revise the draft.")]);
				await harness.session.prompt("Revise verification");
			}
			const draft = harness.session.planningState.plan!;
			expect(harness.session.planningState.mode).toBe("plan");
			expect(draft).toMatchObject({ id: before.id, revision: before.revision + 1, phase: "draft" });
			expect(draft.execution).toBeUndefined();
			expect(draft.steps[0]!.status).toBe("in_progress");
			expect(getPlanLeafSteps(draft)).toEqual(
				getPlanLeafSteps(before).map((leaf) => ({
					...leaf,
					status: leaf.status === "in_progress" ? "pending" : leaf.status,
				})),
			);
			const revised = await harness.session.updatePlan({
				planId: draft.id,
				expectedRevision: draft.revision,
				steps: [
					{ text: "New earlier work" },
					...draft.steps.map((step) => ({
						id: step.id,
						text: step.text,
						substeps: step.substeps!.map((leaf) => ({ id: leaf.id, text: leaf.text })),
					})),
				],
			});
			expect(getPlanLeafSteps(revised).map((leaf) => leaf.status)).toEqual([
				"pending",
				"completed",
				"pending",
				"pending",
			]);
			const ready = await harness.session.submitPlan({
				planId: revised.id,
				expectedRevision: revised.revision,
				title: revised.title!,
				summary: revised.summary!,
			});
			await harness.session.activatePlan(ready.id, ready.revision, {
				...before.execution!,
				id: "reapproved",
				approvedRevision: ready.revision,
			});
			await progress(harness, [{ id: revised.steps[0]!.id, status: "in_progress" }]);
		},
	);

	it("preserves evidence edits on any leaf, clearing, pauses and derived group statuses", async () => {
		const harness = await approved(layouts[1]!.steps);
		const [first, second, third] = getPlanLeafSteps(harness.session.planningState.plan!);
		await progress(harness, [{ id: first!.id, status: "in_progress" }]);
		await progress(harness, [
			{ id: first!.id, status: "completed" },
			{ id: second!.id, status: "in_progress" },
		]);
		const annotated = await progress(harness, [
			{ id: first!.id, status: "completed", note: " Verified first " },
			{ id: second!.id, status: "in_progress", note: "Started second" },
			{ id: third!.id, status: "pending", note: "Needs verification" },
		]);
		expect(getPlanLeafSteps(annotated).map((leaf) => leaf.note)).toEqual([
			"Verified first",
			"Started second",
			"Needs verification",
		]);
		const paused = await progress(harness, [
			{ id: first!.id, status: "completed", note: "" },
			{ id: second!.id, status: "pending" },
		]);
		expect(paused.steps[0]!.status).toBe("in_progress");
		expect(getPlanLeafSteps(paused).map((leaf) => leaf.status)).toEqual(["completed", "pending", "pending"]);
		expect(getPlanLeafSteps(paused)[0]!.note).toBeUndefined();
		expect(getPlanLeafSteps(paused)[1]!.note).toBe("Started second");
		await expectRejected(harness, [{ id: third!.id, status: "in_progress" }], second!.id);
		await expectRejected(harness, [{ id: second!.id, status: "completed" }], /committed in_progress start/);
		await progress(harness, [{ id: second!.id, status: "in_progress" }]);
		await expectRejected(
			harness,
			[
				{ id: second!.id, status: "pending" },
				{ id: third!.id, status: "in_progress" },
			],
			second!.id,
		);
	});

	it("preserves ID, no-op and revision guards without partial planning writes", async () => {
		const harness = await approved(layouts[2]!.steps);
		const plan = harness.session.planningState.plan!;
		const first = getPlanLeafSteps(plan)[0]!;
		await expectRejected(harness, [], /At least one/);
		await expectRejected(harness, [{ id: plan.steps[1]!.id, status: "completed" }], /group outcome/);
		await expectRejected(harness, [{ id: "unknown", status: "pending" }], /unknown executable/);
		await expectRejected(
			harness,
			[
				{ id: first.id, status: "in_progress" },
				{ id: first.id, status: "completed" },
			],
			/duplicates/,
		);
		await expectRejected(harness, [{ id: first.id, status: "pending" }], /made no changes/);
		await expectRejected(
			harness,
			[
				{ id: first.id, status: "in_progress" },
				{ id: "unknown", status: "pending" },
			],
			/unknown executable/,
		);
		const results = await Promise.allSettled(
			[1, 2].map(() =>
				harness.session.updatePlanProgress({
					planId: plan.id,
					expectedRevision: plan.revision,
					updates: [{ id: first.id, status: "in_progress" }],
				}),
			),
		);
		expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
		expect(results[1]).toMatchObject({ reason: { code: "stale_plan_revision" } });
		expect(harness.session.planningState.plan!.revision).toBe(plan.revision + 1);
	});

	it("allows the final response after the last committed item completes", async () => {
		const harness = await approved([{ text: "Only item" }]);
		const first = getPlanLeafSteps(harness.session.planningState.plan!)[0]!;
		const started = await progress(harness, [{ id: first.id, status: "in_progress" }]);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan_progress", {
					planId: started.id,
					expectedRevision: started.revision,
					updates: [{ id: first.id, status: "completed", note: "Verified" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Verified the completed result."),
		]);
		await harness.session.prompt("Finish and report");
		expect(harness.session.planningState.plan!.phase).toBe("completed");
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Verified the completed result." }],
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("rejects invalid model tool calls without committing progress", async () => {
		const harness = await approved();
		const before = harness.session.planningState;
		const plan = before.plan!;
		const events = harness.eventsOfType("planning_state_changed");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan_progress", {
					planId: plan.id,
					expectedRevision: plan.revision,
					updates: [{ id: plan.steps[1]!.id, status: "in_progress" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The first item must start before later work."),
		]);
		await harness.session.prompt("Execute in order");
		expect(harness.session.planningState).toEqual(before);
		expect(harness.eventsOfType("planning_state_changed")).toEqual(events);
		expect(harness.eventsOfType("tool_execution_end")).toEqual([
			expect.objectContaining({ toolName: "update_plan_progress", isError: true }),
		]);
		expect(harness.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining(plan.steps[0]!.id) }],
		});
	});
});
