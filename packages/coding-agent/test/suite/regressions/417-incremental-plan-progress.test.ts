import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { formatPlanCheckpoint, getPlanLeafSteps } from "../../../src/core/planning.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("regression #417: incremental approved plan progress", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([false, true])("delivers boundary guidance and intermediate progress (compaction: %s)", async (compact) => {
		const timeline: string[] = [];
		const workSchema = Type.Object({ outcome: Type.String() });
		const workTool: AgentTool<typeof workSchema> = {
			name: "verify_outcome",
			label: "Verify outcome",
			description: "Complete and verify one test outcome",
			parameters: workSchema,
			execute: async (_id, { outcome }) => {
				timeline.push(`work:${outcome}`);
				return { content: [{ type: "text", text: `Verified ${outcome}` }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [workTool],
			initialActiveToolNames: [workTool.name],
			settings: { compaction: { enabled: compact, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.session.setSessionName("incremental plan progress regression");
		harness.sessionManager.appendMessage({ role: "user", content: "Earlier context", timestamp: Date.now() });
		harness.sessionManager.appendMessage(fauxAssistantMessage("Earlier response"));
		await harness.session.setAgentMode("plan");
		const draft = harness.session.updatePlan({
			title: "Verify three outcomes",
			summary: "Complete the first outcome, then two related outcomes together.",
			steps: [
				{ text: "First outcome" },
				{ text: "Related outcomes", substeps: [{ text: "Second outcome" }, { text: "Third outcome" }] },
			],
		});
		const ready = harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: draft.title!,
			summary: draft.summary!,
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "execution-417",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		const active = harness.session.planningState.plan!;
		const [first, second, third] = getPlanLeafSteps(active);
		const snapshots: Array<{ policy: string; description: string; context: string }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "planning_state_changed" && event.planning.plan) {
				timeline.push(
					`progress:${getPlanLeafSteps(event.planning.plan)
						.map((leaf) => leaf.status)
						.join(",")}`,
				);
			}
		});
		let intermediateCheckpoint = "";
		harness.setResponses([
			(context) => {
				snapshots.push({
					policy: context.systemPrompt ?? "",
					description: context.tools?.find((tool) => tool.name === "update_plan_progress")?.description ?? "",
					context: context.messages.map(getMessageText).join("\n"),
				});
				return fauxAssistantMessage(
					fauxToolCall("update_plan_progress", {
						planId: active.id,
						expectedRevision: active.revision,
						updates: [{ id: first!.id, status: "in_progress" }],
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(fauxToolCall(workTool.name, { outcome: "first" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("update_plan_progress", {
					planId: active.id,
					expectedRevision: active.revision + 1,
					updates: [
						{ id: first!.id, status: "completed", note: "Verified first" },
						{ id: second!.id, status: "in_progress" },
						{ id: third!.id, status: "in_progress" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			...(compact
				? [
						fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
						fauxAssistantMessage("First outcome verified; related outcomes remain open."),
					]
				: []),
			(context) => {
				snapshots.push({
					policy: context.systemPrompt ?? "",
					description: context.tools?.find((tool) => tool.name === "update_plan_progress")?.description ?? "",
					context: context.messages.map(getMessageText).join("\n"),
				});
				intermediateCheckpoint = formatPlanCheckpoint(harness.session.planningState);
				return fauxAssistantMessage(fauxToolCall(workTool.name, { outcome: "second" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(fauxToolCall(workTool.name, { outcome: "third" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("update_plan_progress", {
					planId: active.id,
					expectedRevision: active.revision + 2,
					updates: [
						{ id: second!.id, status: "completed", note: "Verified second" },
						{ id: third!.id, status: "completed", note: "Verified third" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			() => {
				timeline.push("final_response");
				return fauxAssistantMessage("All three outcomes verified.");
			},
		]);

		await harness.session.prompt("Execute the approved plan");

		// These scripted calls test guidance delivery and observable event ordering, not model compliance.
		expect(snapshots).toHaveLength(2);
		for (const snapshot of snapshots) {
			expect(snapshot.policy).toContain("not just at kickoff and final verification");
			expect(snapshot.policy).toContain("Mark a leaf in_progress when beginning its work");
			expect(snapshot.policy).toContain("Keep unfinished or unverified work open");
			expect(snapshot.policy).toContain("Batch related transitions");
			expect(snapshot.policy).toContain("Never infer completion from elapsed time or fabricate evidence");
			expect(snapshot.policy).toContain("After compaction or resumption, reconcile the canonical checklist");
			expect(snapshot.description).toContain("before moving to unrelated work; do not wait until the end");
		}
		expect(timeline).toEqual([
			"progress:in_progress,pending,pending",
			"work:first",
			"progress:completed,in_progress,in_progress",
			"work:second",
			"work:third",
			"progress:completed,completed,completed",
			"final_response",
		]);
		expect(intermediateCheckpoint).toContain("[x] First outcome — Verified first");
		expect(intermediateCheckpoint).toContain("[>] Related outcomes");
		const compactions = harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(compact ? 1 : 0);
		if (compact) expect(snapshots[1]!.context).toContain(intermediateCheckpoint);
		expect(harness.session.planningState.plan).toMatchObject({ phase: "completed" });
		expect(harness.eventsOfType("tool_execution_end").every((event) => !event.isError)).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
