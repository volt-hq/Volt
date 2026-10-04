/**
 * A ready plan executed in a new conversation. The new conversation's log is
 * written before it opens: the source's review state, the plan as active with
 * its execution, and the source's model, thinking level, and fast mode. Once
 * it opened, the source records the plan as handed off through the source
 * conversation while it is still open, before the client leaves it, so the
 * source's log is never reopened by a second writer. The execution turn starts
 * in the new conversation after the move, or, for a client redirected to a
 * conversation that opens for it elsewhere, is queued in the new log as
 * durable host input that starts once that conversation recovers its input.
 */

import { randomUUID } from "node:crypto";
import type { AgentSession } from "../agent-session.ts";
import type { ReplacedSessionContext } from "../extensions/index.ts";
import {
	clonePlanState,
	createPlanExecutionPrompt,
	PLAN_EXECUTION_CUSTOM_TYPE,
	type PlanExecution,
	type PlanState,
} from "../planning.ts";
import { captureReviewStateForHandoff, restoreReviewStateFromHandoff } from "../review-state.ts";
import type { LogWriter } from "../session-writer.ts";
import type { HostedConversation } from "./hosted-conversation.ts";

export interface PlanHandoff {
	/** Writes the new conversation's log before it opens. */
	setup(writer: LogWriter): Promise<void>;
	/** Queues the execution turn in the new conversation's log, after `setup`, instead of `start`. */
	queueStart(writer: LogWriter): Promise<void>;
	/** Records the plan as handed off in the still-open source, once the new conversation opened. */
	beforeMove(source: HostedConversation): Promise<void>;
	/** Starts the execution turn in the new conversation `target`, after the move. */
	start(target: AgentSession, context: ReplacedSessionContext): Promise<void>;
}

/** Hand `plan`, ready at `expectedRevision` in `source`, to a new conversation. */
export function createPlanHandoff(source: AgentSession, plan: PlanState, expectedRevision: number): PlanHandoff {
	const sourceSessionId = source.sessionId;
	const model = source.model;
	const thinkingLevel = source.thinkingLevel;
	const fastMode = source.fastModeEnabled;
	const reviewState = captureReviewStateForHandoff(source.sessionManager);
	let execution: PlanExecution | undefined;
	let activePlan: PlanState | undefined;
	return {
		async setup(writer) {
			await restoreReviewStateFromHandoff(writer, reviewState);
			execution = {
				id: randomUUID(),
				approvedRevision: expectedRevision,
				strategy: "new_session",
				sourceSessionId,
				targetSessionId: writer.sessionManager.getSessionId(),
			};
			activePlan = { ...clonePlanState(plan), revision: plan.revision + 1, phase: "active", execution };
			await writer.appendPlanningState({ mode: "build", plan: activePlan });
			if (model) await writer.appendModelChange(model.provider, model.id);
			await writer.appendThinkingLevelChange(thinkingLevel);
			if (fastMode) await writer.appendFastModeChange(true);
		},
		async queueStart(writer) {
			if (!activePlan) throw new Error("Plan execution session was not initialized");
			// The same message `start` sends: the turn it triggers is the execution.
			await writer.queueHostMessages("steer", [
				{
					role: "custom",
					customType: PLAN_EXECUTION_CUSTOM_TYPE,
					content: createPlanExecutionPrompt(activePlan),
					display: true,
					timestamp: Date.now(),
				},
			]);
		},
		async beforeMove(from) {
			if (!execution) throw new Error("Plan execution session was not initialized");
			if (from.session !== source) throw new Error("The plan's source session changed");
			await source.markPlanHandedOff(plan.id, expectedRevision, execution);
		},
		async start(target, context) {
			const activePlan = target.planningState.plan;
			if (!activePlan || activePlan.phase !== "active") {
				throw new Error("Plan execution session did not restore its active plan");
			}
			void context
				.sendMessage(
					{
						customType: PLAN_EXECUTION_CUSTOM_TYPE,
						content: createPlanExecutionPrompt(activePlan),
						display: true,
					},
					{ triggerTurn: true },
				)
				.catch(() => undefined);
		},
	};
}
