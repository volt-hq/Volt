import type { AgentMessage, AgentTool, ConversationLogAppend } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createUserMessage(text: string): Extract<AgentMessage, { role: "user" }> {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

async function createReadyPlan(harness: Harness): Promise<void> {
	await harness.session.setAgentMode("plan");
	const draft = await harness.session.updatePlan({
		title: "Queued feedback",
		summary: "Exercise transactional feedback admission.",
		steps: [{ text: "Apply feedback" }],
	});
	await harness.session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
}

/** Whether a log batch delivers a user message: a turn's delivery commit. */
function deliversUserMessage(batch: ConversationLogAppend): boolean {
	return batch.entries.some(
		(entry) =>
			entry.type === "message" && (entry.payload as { message?: { role?: string } }).message?.role === "user",
	);
}

function planningEntries(harness: Harness) {
	return harness.sessionManager.getBranch().filter((entry) => entry.type === "planning_state_change");
}

function checkpointEvents(harness: Harness) {
	return harness
		.eventsOfType("message_end")
		.filter((event) => event.message.role === "custom" && event.message.customType === "volt-plan-checkpoint");
}

function createBuildMarkerTool(): AgentTool {
	return {
		name: "build_marker",
		label: "Build marker",
		description: "Observable Build-only test tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "built" }], details: {} }),
	};
}

describe("regression #199: approved plan finalization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("leaves a rolled-back first delivery without planning state or checkpoint side effects", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.setResponses([fauxAssistantMessage("feedback admitted")]);
		const planningEntryCount = planningEntries(harness).length;
		const planningEventCount = harness.eventsOfType("planning_state_changed").length;
		const checkpointEventCount = checkpointEvents(harness).length;
		harness.log!.failNext("rolled_back", deliversUserMessage);

		await harness.control.queueSteer(createUserMessage("rolled back feedback"));
		await harness.session.waitForIdle();

		expect(harness.session.planningState.plan?.phase).toBe("ready");
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventCount);
		expect(checkpointEvents(harness)).toHaveLength(checkpointEventCount);
		expect(planningEntries(harness)).toHaveLength(planningEntryCount);

		await harness.control.clearQueue();
		await harness.control.queueSteer(createUserMessage("admitted feedback"));
		await harness.session.waitForIdle();
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventCount + 1);
		expect(checkpointEvents(harness)).toHaveLength(checkpointEventCount + 1);
	});

	it("commits the ready-plan transition, its checkpoint, and the feedback in one delivery batch", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		await createReadyPlan(harness);
		const planningEntryCount = planningEntries(harness).length;
		const planningEventCount = harness.eventsOfType("planning_state_changed").length;
		let deliveryBatch: string[] | undefined;
		const hold = harness.log!.holdNext((batch) => {
			if (!deliversUserMessage(batch)) return false;
			deliveryBatch = batch.entries.map((entry) =>
				entry.type === "custom_message"
					? (entry.payload as { customType: string }).customType
					: entry.type === "message"
						? `message:${(entry.payload as { message: { role: string } }).message.role}`
						: entry.type,
			);
			return true;
		});

		harness.setResponses([fauxAssistantMessage("feedback committed")]);
		const queued = harness.control.queueSteer(createUserMessage("admitted feedback"));
		await hold.started;
		// Nothing of the delivery is visible before its batch commits.
		expect(harness.session.planningState.plan?.phase).toBe("ready");
		expect(planningEntries(harness)).toHaveLength(planningEntryCount);
		hold.release();
		await queued;
		await harness.session.waitForIdle();

		expect(deliveryBatch).toEqual(
			expect.arrayContaining(["planning_state_change", "volt-plan-checkpoint", "message:user"]),
		);
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(
			harness.session.state.messages
				.slice(0, 2)
				.map((message) => (message.role === "custom" ? message.customType : message.role)),
		).toEqual(["volt-plan-checkpoint", "user"]);
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventCount + 1);
		expect(planningEntries(harness)).toHaveLength(planningEntryCount + 1);
	});

	it("runs the first request after a ready-plan prompt under the Plan policy", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await createReadyPlan(harness);
		await harness.session.setAgentMode("build");
		expect(harness.session.planningState).toMatchObject({ mode: "build", plan: { phase: "ready" } });
		const systemPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				systemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("revising the plan");
			},
		]);

		await harness.session.prompt("Please revise the plan");

		expect(harness.session.planningState).toMatchObject({ mode: "plan", plan: { phase: "draft" } });
		expect(systemPrompts).toHaveLength(1);
		expect(systemPrompts[0]).toContain("[VOLT PLAN MODE — TRUSTED HOST POLICY]");
	});

	it("admits all-mode feedback with one ready-to-draft transition and checkpoint", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.setSteeringMode("all");
		const planningEntryCount = planningEntries(harness).length;
		const planningEventCount = harness.eventsOfType("planning_state_changed").length;
		const checkpointEventCount = checkpointEvents(harness).length;
		harness.setResponses([fauxAssistantMessage("feedback admitted")]);
		// Both steers queue behind a held turn claim, so one delivery takes them together.
		const claim = harness.control.conversation.reserve();
		await harness.control.queueSteer(createUserMessage("first feedback"));
		await harness.control.queueSteer(createUserMessage("second feedback"));
		claim.cancel();
		await harness.session.waitForIdle();

		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(checkpointEvents(harness)).toHaveLength(checkpointEventCount + 1);
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventCount + 1);
		expect(planningEntries(harness)).toHaveLength(planningEntryCount + 1);
	});

	it("persists one tool-free final response and restores Build tools for the next delivery", async () => {
		const harness = await createHarness({
			tools: [createBuildMarkerTool()],
			initialActiveToolNames: ["build_marker"],
		});
		harnesses.push(harness);
		await harness.session.setAgentMode("plan");
		const draft = await harness.session.updatePlan({
			title: "Complete issue 199",
			summary: "Finalize the approved implementation visibly.",
			steps: [{ text: "Finish implementation and verification" }],
		});
		const ready = await harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: draft.title!,
			summary: draft.summary!,
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "execution-199",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		const active = harness.session.planningState.plan!;
		const requestSnapshots: Array<{ tools: string[]; systemPrompt: string }> = [];
		harness.setResponses([
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage(
					fauxToolCall("update_plan_progress", {
						planId: active.id,
						expectedRevision: active.revision,
						updates: [{ id: active.steps[0]!.id, status: "completed", note: "Verified" }],
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage("Implementation and verification completed.");
			},
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage("Build tools restored.");
			},
		]);

		await harness.session.prompt("Complete the approved plan");

		expect(harness.session.planningState.plan).toMatchObject({ phase: "completed" });
		expect(harness.session.getActiveToolNames()).toEqual(["build_marker"]);
		expect(harness.session.state.systemPrompt).not.toContain("[VOLT APPROVED PLAN — TRUSTED HOST POLICY]");
		expect(requestSnapshots[0]!.tools).toContain("update_plan_progress");
		expect(requestSnapshots[1]!.tools).toEqual([]);
		expect(requestSnapshots[1]!.systemPrompt).toContain("[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]");

		const persistedMessages = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		const progressToolCallIndex = persistedMessages.findIndex(
			(message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "toolCall" && part.name === "update_plan_progress"),
		);
		expect(
			persistedMessages.slice(progressToolCallIndex, progressToolCallIndex + 3).map((message) => message.role),
		).toEqual(["assistant", "toolResult", "assistant"]);
		expect(persistedMessages[progressToolCallIndex + 2]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Implementation and verification completed." }],
		});

		await harness.session.prompt("Continue with Build tools");
		expect(requestSnapshots[2]!.tools).toEqual(["build_marker"]);
		expect(requestSnapshots[2]!.systemPrompt).not.toContain("[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]");
	});

	it("retains tool-free final-response authority across a transient provider retry", async () => {
		const harness = await createHarness({
			tools: [createBuildMarkerTool()],
			initialActiveToolNames: ["build_marker"],
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		await harness.session.setAgentMode("plan");
		const draft = await harness.session.updatePlan({ steps: [{ text: "Finish implementation" }] });
		const ready = await harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Finish implementation",
			summary: "Complete the approved work and report it.",
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "execution-final-response-retry",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		const active = harness.session.planningState.plan!;
		const requestSnapshots: Array<{ tools: string[]; systemPrompt: string }> = [];
		let retriedRequestContainedQueuedInput: boolean | undefined;
		let clearedQueuedDeliveries: number | undefined;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan_progress", {
					planId: active.id,
					expectedRevision: active.revision,
					updates: [{ id: active.steps[0]!.id, status: "completed" }],
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				void harness.control.queueFollowUp(createUserMessage("queued during final-response retry"));
				return fauxAssistantMessage("", {
					stopReason: "error",
					error: { kind: "overloaded", retryable: true, message: "overloaded_error" },
				});
			},
			async (context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				retriedRequestContainedQueuedInput = JSON.stringify(context.messages).includes(
					"queued during final-response retry",
				);
				clearedQueuedDeliveries = (await harness.control.clearQueue()).length;
				return fauxAssistantMessage("Final response after retry");
			},
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage("Build tools restored after retry");
			},
		]);

		await harness.session.prompt("Complete the approved plan despite a transient failure");

		expect(requestSnapshots).toHaveLength(2);
		expect(retriedRequestContainedQueuedInput).toBe(false);
		expect(clearedQueuedDeliveries).toBe(1);
		for (const snapshot of requestSnapshots) {
			expect(snapshot.tools).toEqual([]);
			expect(snapshot.systemPrompt).toContain("[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]");
		}
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Final response after retry" }],
		});

		await harness.session.prompt("Start a fresh Build turn");
		expect(requestSnapshots[2]!.tools).toEqual(["build_marker"]);
		expect(requestSnapshots[2]!.systemPrompt).not.toContain("[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]");
	});

	it("retains tool-free final-response authority across overflow compaction", async () => {
		const harness = await createHarness({
			tools: [createBuildMarkerTool()],
			initialActiveToolNames: ["build_marker"],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		await harness.session.setSessionName("final response compaction regression");
		const olderUser = createUserMessage("older compactable turn");
		const olderAssistant = fauxAssistantMessage("older completed response");
		await harness.sessionManager.appendMessage(olderUser);
		await harness.sessionManager.appendMessage(olderAssistant);
		await harness.session.setAgentMode("plan");
		const draft = await harness.session.updatePlan({ steps: [{ text: "Finish compacted implementation" }] });
		const ready = await harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Finish compacted implementation",
			summary: "Complete the approved work after overflow compaction.",
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "execution-final-response-compaction",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		const active = harness.session.planningState.plan!;
		const requestSnapshots: Array<{ tools: string[]; systemPrompt: string }> = [];
		let compactedRequestContainedQueuedInput: boolean | undefined;
		let clearedQueuedDeliveries: number | undefined;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan_progress", {
					planId: active.id,
					expectedRevision: active.revision,
					updates: [{ id: active.steps[0]!.id, status: "completed" }],
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				void harness.control.queueFollowUp(createUserMessage("queued during final-response compaction"));
				return fauxAssistantMessage("", {
					stopReason: "error",
					error: { kind: "context_overflow", retryable: false, message: "prompt is too long" },
				});
			},
			fauxAssistantMessage("compacted final-response context"),
			async (context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				compactedRequestContainedQueuedInput = JSON.stringify(context.messages).includes(
					"queued during final-response compaction",
				);
				clearedQueuedDeliveries = (await harness.control.clearQueue()).length;
				return fauxAssistantMessage("Final response after compaction");
			},
		]);

		await harness.session.prompt("Complete the approved plan despite context overflow");

		expect(requestSnapshots).toHaveLength(2);
		expect(compactedRequestContainedQueuedInput).toBe(false);
		expect(clearedQueuedDeliveries).toBe(1);
		for (const snapshot of requestSnapshots) {
			expect(snapshot.tools).toEqual([]);
			expect(snapshot.systemPrompt).toContain("[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]");
		}
		const compactions = harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect(compactions[0]?.summary).toContain("compacted final-response context");
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Final response after compaction" }],
		});
	});
});
