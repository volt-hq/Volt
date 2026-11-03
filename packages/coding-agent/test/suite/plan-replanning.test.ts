import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanExecutionMessage, getPlanLeafSteps } from "../../src/core/planning.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

function toolResponse(name: string, input: JsonObject) {
	return fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" });
}

describe("automatic read-only plan revision", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0).reverse()) await harness.cleanupAsync();
	});

	async function approved() {
		const harness = await createHarness({ log: "memory", initialActiveToolNames: ["read", "write"] });
		harnesses.push(harness);
		const { session } = harness;
		const evidence = join(harness.tempDir, "evidence.txt");
		writeFileSync(evidence, "The implementation needs an additional verification step.");
		await session.setAgentMode("plan");
		const draft = await session.updatePlan({
			title: "Implement the contract",
			summary: "Implement and verify the approved contract.",
			steps: [
				{ text: "Deliver the contract", substeps: [{ text: "Establish the contract" }, { text: "Implement it" }] },
			],
		});
		harness.setResponses([
			toolResponse("read", { path: evidence }),
			toolResponse("submit_plan", {
				planId: draft.id,
				expectedRevision: draft.revision,
				title: draft.title!,
				summary: draft.summary!,
			}),
		]);
		await session.prompt("Prepare the implementation plan");
		const ready = session.planningState.plan!;
		await session.activatePlan(ready.id, ready.revision, {
			id: "original-execution",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: session.sessionId,
			targetSessionId: session.sessionId,
		});
		let active = session.planningState.plan!;
		const [first, second] = getPlanLeafSteps(active);
		active = await session.updatePlanProgress({
			planId: active.id,
			expectedRevision: active.revision,
			updates: [{ id: first!.id, status: "in_progress" }],
		});
		active = await session.updatePlanProgress({
			planId: active.id,
			expectedRevision: active.revision,
			updates: [
				{ id: first!.id, status: "completed", note: "Contract verified" },
				{ id: second!.id, status: "in_progress", note: "Implementation partially verified" },
			],
		});
		return { harness, session, active, evidence };
	}

	it("revises and submits in the same run, then implements only after explicit reapproval", async () => {
		const { harness, session, active, evidence } = await approved();
		const output = join(harness.tempDir, "implementation.txt");
		const [first, second] = getPlanLeafSteps(active);
		const userTexts = getUserTexts(harness);
		const reason = "The implementation requires additional verification.";
		const summary = `${reason} Preserve the verified contract and add a separate verification step.`;
		harness.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("Approval authorizes all remaining checklist items");
				expect(context.systemPrompt).toContain("without asking for per-item confirmation");
				expect(context.systemPrompt).toContain("required project/host approval gates");
				expect(JSON.stringify(context.messages)).toContain("Continue automatically after each verified item");
				return toolResponse("request_replan", {
					planId: active.id,
					expectedRevision: active.revision,
					reason,
				});
			},
			(context) => {
				const draft = session.planningState.plan!;
				expect(session.planningState.mode).toBe("plan");
				expect(draft).toMatchObject({ phase: "draft", revision: active.revision + 1 });
				expect(draft.execution).toBeUndefined();
				expect(draft.steps[0]!.status).toBe("in_progress");
				expect(getPlanLeafSteps(draft)).toEqual([
					{ ...first!, status: "completed" },
					{ ...second!, status: "pending" },
				]);
				expect(context.systemPrompt).toContain("[VOLT PLAN MODE — TRUSTED HOST POLICY]");
				expect(context.systemPrompt).toContain("without waiting for a user continuation message");
				expect(context.systemPrompt).not.toContain("[VOLT APPROVED PLAN — TRUSTED HOST POLICY]");
				expect(context.tools?.map((tool) => tool.name)).toEqual(
					expect.arrayContaining(["read", "update_plan", "submit_plan"]),
				);
				for (const name of ["write", "bash", "update_plan_progress", "request_replan"]) {
					expect(context.tools?.map((tool) => tool.name)).not.toContain(name);
				}
				// The read that supported the original approval cannot satisfy this submission.
				return toolResponse("submit_plan", {
					planId: draft.id,
					expectedRevision: draft.revision,
					title: draft.title!,
					summary,
				});
			},
			() => toolResponse("write", { path: output, content: "must not be written" }),
			() => toolResponse("read", { path: evidence }),
			() => {
				const draft = session.planningState.plan!;
				return toolResponse("update_plan", {
					planId: draft.id,
					expectedRevision: draft.revision,
					summary,
					steps: [
						{
							id: draft.steps[0]!.id,
							text: draft.steps[0]!.text,
							substeps: [
								...getPlanLeafSteps(draft).map(({ id, text }) => ({ id, text })),
								{ text: "Verify the additional requirement" },
							],
						},
					],
				});
			},
			() => {
				const draft = session.planningState.plan!;
				return toolResponse("submit_plan", {
					planId: draft.id,
					expectedRevision: draft.revision,
					title: draft.title!,
					summary: draft.summary!,
				});
			},
			() => {
				const plan = session.planningState.plan!;
				return toolResponse("update_plan_progress", {
					planId: plan.id,
					expectedRevision: plan.revision,
					updates: [{ id: second!.id, status: "in_progress" }],
				});
			},
			toolResponse("write", { path: output, content: "approved implementation" }),
			fauxAssistantMessage("Implementation resumed after approval."),
		]);

		await session.sendCustomMessage(createPlanExecutionMessage(active), { triggerTurn: true });

		const ready = session.planningState.plan!;
		expect(session.planningState.mode).toBe("plan");
		expect(ready).toMatchObject({ id: active.id, phase: "ready", summary });
		expect(ready.execution).toBeUndefined();
		expect(getPlanLeafSteps(ready)).toEqual([
			{ ...first!, status: "completed" },
			{ ...second!, status: "pending" },
			expect.objectContaining({ text: "Verify the additional requirement", status: "pending" }),
		]);
		expect(getUserTexts(harness)).toEqual(userTexts);
		expect(existsSync(output)).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(3);
		const results = harness.eventsOfType("tool_execution_end");
		expect(results.filter((event) => event.isError).map((event) => event.toolName)).toEqual(["submit_plan", "write"]);
		expect(
			session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "submit_plan" && message.isError,
			),
		).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("successful read") }] });
		await expect(
			session.activatePlan(ready.id, active.execution!.approvedRevision, active.execution!),
		).rejects.toThrow("Plan changed");
		expect(existsSync(output)).toBe(false);

		await session.activatePlan(ready.id, ready.revision, {
			...active.execution!,
			id: "reapproved-execution",
			approvedRevision: ready.revision,
		});
		await session.sendCustomMessage(createPlanExecutionMessage(session.planningState.plan!), { triggerTurn: true });
		expect(session.planningState).toMatchObject({ mode: "build", plan: { phase: "active" } });
		expect(getPlanLeafSteps(session.planningState.plan!)[0]).toEqual(first);
		expect(readFileSync(output, "utf8")).toBe("approved implementation");
		expect(getUserTexts(harness)).toEqual(userTexts);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each(["stale", "empty reason", "rolled back commit"] as const)(
		"leaves approved execution unchanged after a failed replan: %s",
		async (failure) => {
			const { harness, session, active } = await approved();
			const before = session.planningState;
			const events = harness.eventsOfType("planning_state_changed");
			if (failure === "rolled back commit") {
				harness.log!.failNext("rolled_back", (batch) =>
					batch.entries.some((entry) => entry.type === "planning_state_change"),
				);
			}
			harness.setResponses([
				toolResponse("request_replan", {
					planId: active.id,
					expectedRevision: active.revision - (failure === "stale" ? 1 : 0),
					reason: failure === "empty reason" ? " " : "An additional verification step is needed.",
				}),
				(context) => {
					expect(context.systemPrompt).toContain("[VOLT APPROVED PLAN — TRUSTED HOST POLICY]");
					expect(context.tools?.map((tool) => tool.name)).toContain("write");
					return fauxAssistantMessage("Replanning failed; execution state is unchanged.");
				},
			]);
			await session.prompt("Execute the approved plan");
			expect(session.planningState).toEqual(before);
			expect(harness.eventsOfType("planning_state_changed")).toEqual(events);
			expect(harness.eventsOfType("tool_execution_end").at(-1)).toMatchObject({
				toolName: "request_replan",
				isError: true,
			});
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it("honors cancellation after committing the draft without restarting planning", async () => {
		const { harness, session, active } = await approved();
		const stopped = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "request_replan" && !event.isError) {
				void session.abort().then(stopped.resolve, stopped.reject);
			}
		});
		harness.setResponses([
			toolResponse("request_replan", {
				planId: active.id,
				expectedRevision: active.revision,
				reason: "Need another verification step.",
			}),
			fauxAssistantMessage("This response must not start after cancellation."),
		]);
		try {
			await session.prompt("Execute the approved plan");
			await stopped.promise;
			await session.waitForIdle();
			expect(session.planningState).toMatchObject({ mode: "plan", plan: { phase: "draft" } });
			expect(session.planningState.plan!.execution).toBeUndefined();
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(session.isBusy).toBe(false);
		} finally {
			unsubscribe();
		}
	});

	it("does not launch runs from direct SDK replanning or manual Change Plan", async () => {
		const { harness, session, active } = await approved();
		harness.setResponses([fauxAssistantMessage("No run should launch.")]);
		const draft = (
			await session.requestReplan({
				planId: active.id,
				expectedRevision: active.revision,
				reason: "Need another verification step.",
			})
		).plan!;
		const ready = await session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: draft.title!,
			summary: draft.summary!,
		});
		await session.changePlan(ready.id, ready.revision);
		await session.waitForIdle();
		expect(session.planningState).toMatchObject({ mode: "plan", plan: { phase: "draft" } });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not blindly restart an active plan after a text-only blocker", async () => {
		const { harness, session, active } = await approved();
		harness.setResponses([
			fauxAssistantMessage("Implementation is blocked on a required user decision."),
			fauxAssistantMessage("This response must not start automatically."),
		]);
		await session.prompt("Execute the approved plan");
		await session.waitForIdle();
		expect(session.planningState.plan).toEqual(active);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
