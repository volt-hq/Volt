import { randomUUID } from "node:crypto";
import type { JsonValue } from "@hansjm10/volt-ai";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { reviewWorkInput } from "../../src/core/review-work.ts";
import { SessionManager, type SessionReference } from "../../src/core/session-manager.ts";
import { seedSession } from "./seed-log.ts";

/**
 * Anchor review run `runId` in `manager`'s log, which no live session holds,
 * as a host that ran it does: the finished `review` work whose `work_started`
 * makes the log the run's source.
 */
export async function anchorReviewRun(manager: SessionManager, runId: string): Promise<void> {
	await seedSession(manager, (log) => {
		log.hostRecord("work_started", {
			workId: runId,
			kind: "review",
			title: `Review ${runId}`,
			input: { action: "review.pr", target: runId },
			cancellable: true,
			delivery: "none",
			resume: false,
			state: "running",
		});
		log.hostRecord("work_finished", { workId: runId, outcome: "completed" });
	});
}

/** Anchor review run `runId` in a live session's log through its work registry, as a review that ran there does. */
export async function anchorLiveReviewRun(session: AgentSession, runId: string): Promise<void> {
	await session.work.start("review", reviewWorkInput("review.pr", runId), async () => ({ outcome: "completed" }), {
		workId: runId,
	});
	await session.work.settled(runId);
}

export interface RecordedReviewDiscussion {
	readonly discussionId: string;
	readonly runId: string;
	readonly findingId: string;
	readonly contextSnapshot: JsonValue;
}

function identityOf(ref: SessionReference): { sessionId: string; sessionGeneration: string } {
	return { sessionId: ref.sessionId, sessionGeneration: ref.sessionGeneration };
}

/**
 * Create a discussion child of a run `source` anchors, as the host's review
 * discussion service does: a hidden conversation whose first entry links it,
 * recorded in `source`'s log, which no live session holds. Resolves with the
 * child's reference.
 */
export async function recordReviewDiscussion(
	source: SessionManager,
	discussion: RecordedReviewDiscussion,
	options: { readonly requestId?: string; readonly kickoffClientMessageId?: string } = {},
): Promise<SessionReference> {
	const sourceRef = source.getSessionRef()!;
	const child = await createDiscussionChild(source, discussion);
	await source.logWriter.recordReviewState(() => ({
		records: [
			{
				type: "review_discussion",
				...discussion,
				child: identityOf(child),
				requestId: options.requestId ?? `create:${discussion.discussionId}`,
				kickoffClientMessageId: options.kickoffClientMessageId ?? randomUUID(),
			},
		],
		result: undefined,
	}));
	return { ...sourceRef, ...identityOf(child) };
}

/** Reset discussion `discussion` of `source` to a new child, as the host does; resolves with the new child's reference. */
export async function resetRecordedReviewDiscussion(
	source: SessionManager,
	discussion: RecordedReviewDiscussion,
	requestId: string,
): Promise<SessionReference> {
	const child = await createDiscussionChild(source, discussion);
	await source.logWriter.recordReviewState(() => ({
		records: [
			{
				type: "review_discussion_reset",
				discussionId: discussion.discussionId,
				child: identityOf(child),
				requestId,
				kickoffClientMessageId: randomUUID(),
			},
		],
		result: undefined,
	}));
	return child;
}

async function createDiscussionChild(
	source: SessionManager,
	discussion: RecordedReviewDiscussion,
): Promise<SessionReference> {
	const sourceRef = source.getSessionRef()!;
	const child = await SessionManager.create(source.getCwd(), sourceRef.sessionDirectory);
	try {
		await child.logWriter.recordReviewState(() => ({
			records: [{ type: "review_discussion_link", ...discussion, source: identityOf(sourceRef) }],
			result: undefined,
		}));
		return child.getSessionRef()!;
	} finally {
		await child.closePersistence();
	}
}
