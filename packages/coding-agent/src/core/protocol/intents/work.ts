/**
 * Work intents (RFC §7, §6.3): cancel, open, and resume a work item of the
 * conversation by its id, and start a subagent. Each acts through the
 * conversation's work registry, whose kinds decide what cancelling, opening,
 * and resuming do.
 */

import type { RejectionCode } from "@hansjm10/volt-protocol";
import { WorkError, type WorkErrorCode, type WorkRegistry } from "../../work/registry.ts";
import { targetOf } from "./conversation.ts";
import {
	defineIntent,
	INTENT_ENABLED,
	type IntentAvailability,
	type IntentContext,
	IntentRejectedError,
	type IntentView,
} from "./types.ts";

const control = ["conversation.control.v1"] as const;

/** The rejection a refused work operation answers with. */
const WORK_REJECTIONS: Readonly<Record<WorkErrorCode, RejectionCode>> = {
	unknown_kind: "unavailable",
	unknown_work: "invalid_input",
	invalid: "invalid_input",
	limit: "busy",
	finished: "conflict",
	running: "conflict",
	not_cancellable: "not_allowed",
	not_resumable: "not_allowed",
	unavailable: "unavailable",
	closed: "ended",
};

/** Run a work operation, answering a refusal with its protocol code. */
async function workOperation<T>(ctx: IntentContext, operation: (work: WorkRegistry) => Promise<T>): Promise<T> {
	ctx.assertCurrent?.();
	try {
		return await operation(targetOf(ctx).conversation.work);
	} catch (error) {
		if (error instanceof WorkError) throw new IntentRejectedError(WORK_REJECTIONS[error.code], error.message);
		throw error;
	}
}

/** Whether the conversation holds `workId` as open work; the intent's own checks follow. */
function openWorkAvailability(view: IntentView, workId: string | undefined): IntentAvailability {
	if (workId === undefined || !view.target) return INTENT_ENABLED;
	const record = view.target.conversation.work.get(workId);
	if (!record) return { enabled: false, code: "invalid_input", reason: `Unknown work ${JSON.stringify(workId)}` };
	if (record.outcome !== undefined) return { enabled: false, reason: `Work ${workId} already finished` };
	return INTENT_ENABLED;
}

export const cancelWorkIntent = defineIntent({
	name: "cancel_work",
	label: "Cancel work",
	description: "Cancel a running or suspended work item",
	category: "session",
	scope: "conversation",
	// Work is not on a branch: a branch switch leaves it as it was.
	fence: "none",
	remote: "safe",
	requires: control,
	whileBusy: "run",
	available(view, input) {
		const availability = openWorkAvailability(view, input?.workId);
		if (!availability.enabled || input === undefined || !view.target) return availability;
		const { work } = view.target.conversation;
		const record = work.get(input.workId);
		return record && !work.cancellable(record)
			? { enabled: false, code: "not_allowed", reason: `Work ${input.workId} cannot be cancelled` }
			: INTENT_ENABLED;
	},
	async run(ctx, input) {
		await workOperation(ctx, (work) => work.cancel(input.workId));
	},
});

export const openWorkIntent = defineIntent({
	name: "open_work",
	label: "Open work",
	description: "Open the conversation a work item runs in or produced",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "safe",
	requires: control,
	whileBusy: "run",
	run(ctx, input) {
		const { host, client } = targetOf(ctx);
		return workOperation(ctx, (work) =>
			work.open(input.workId, {
				host,
				client,
				...(ctx.assertCurrent === undefined ? {} : { assertCurrent: ctx.assertCurrent }),
			}),
		);
	},
	accept: (opened) =>
		"cancelled" in opened
			? { result: { cancelled: true as const } }
			: opened.moved
				? { conversation: opened.conversation }
				: { result: { conversation: opened.conversation } },
});

export const resumeWorkIntent = defineIntent({
	name: "resume_work",
	label: "Resume work",
	description: "Continue a work item suspended since a restart",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "safe",
	requires: control,
	whileBusy: "run",
	available: (view, input) => openWorkAvailability(view, input?.workId),
	async run(ctx, input) {
		await workOperation(ctx, (work) => work.resume(input.workId));
	},
});

export const startSubagentIntent = defineIntent({
	name: "start_subagent",
	label: "Start subagent",
	category: "advanced",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: control,
	whileBusy: "run",
	async run(ctx, input) {
		const subagents = ctx.services.subagents;
		if (!subagents) throw new IntentRejectedError("unavailable", "Subagents are not available in this host");
		const started = await subagents.start(input.agent, input.prompt);
		return { workId: started.subagentId, conversation: started.sessionId };
	},
	accept: (result) => ({ result }),
});
