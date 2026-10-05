/**
 * The review state one conversation's log holds (RFC §14 Q7), folded from its
 * host records: the runs it anchors (the `work_started` of its review work),
 * the runs it carries as a handoff alias, each anchored run's General, the
 * finding discussions it is the source of, and, for a discussion child, its
 * link. The store enforces how these records relate across logs when it
 * commits them (see session-store/worker.ts); this fold reads one log.
 */

import type { JsonValue } from "@hansjm10/volt-ai";
import type { SessionEntry } from "./session-manager.ts";

/** One exact session incarnation of the store. */
export interface ReviewSessionIdentity {
	readonly sessionId: string;
	readonly sessionGeneration: string;
}

/** One child conversation of a discussion; its first child has ordinal 1, each reset adds the next. */
export interface ReviewDiscussionChild {
	readonly ordinal: number;
	readonly child: ReviewSessionIdentity;
	readonly requestId: string;
	readonly kickoffClientMessageId: string;
	readonly createdAt: string;
}

/** A finding discussion its source's log records. Its current child is the last one. */
export interface ReviewDiscussionRecord {
	readonly discussionId: string;
	readonly runId: string;
	readonly findingId: string;
	readonly contextSnapshot: JsonValue;
	readonly createdAt: string;
	readonly children: readonly ReviewDiscussionChild[];
}

/** What a discussion child's first entry records: the discussion, its finding, its source, and its context. */
export interface ReviewDiscussionLink {
	readonly discussionId: string;
	readonly runId: string;
	readonly findingId: string;
	readonly source: ReviewSessionIdentity;
	readonly contextSnapshot: JsonValue;
}

export interface ReviewLogState {
	/** The runs this log anchors: it ran them, so it is their source. */
	readonly anchors: ReadonlySet<string>;
	/** The runs this log carries as a handoff alias, each with its source. */
	readonly aliases: ReadonlyMap<string, ReviewSessionIdentity>;
	/** Anchored runs whose General moved to another conversation. */
	readonly generals: ReadonlyMap<string, ReviewSessionIdentity>;
	/** The discussions this log is the source of, by discussion id. */
	readonly discussions: ReadonlyMap<string, ReviewDiscussionRecord>;
	/** This log's link when it is a discussion child. */
	readonly link: ReviewDiscussionLink | undefined;
}

export const EMPTY_REVIEW_LOG_STATE: ReviewLogState = Object.freeze({
	anchors: new Set<string>(),
	aliases: new Map<string, ReviewSessionIdentity>(),
	generals: new Map<string, ReviewSessionIdentity>(),
	discussions: new Map<string, ReviewDiscussionRecord>(),
	link: undefined,
});

function identity(value: ReviewSessionIdentity): ReviewSessionIdentity {
	return Object.freeze({ sessionId: value.sessionId, sessionGeneration: value.sessionGeneration });
}

export function sameReviewSession(left: ReviewSessionIdentity, right: ReviewSessionIdentity): boolean {
	return left.sessionId === right.sessionId && left.sessionGeneration === right.sessionGeneration;
}

/** The discussion `state` records for a run's finding. */
export function findReviewDiscussion(
	state: ReviewLogState,
	runId: string,
	findingId: string,
): ReviewDiscussionRecord | undefined {
	for (const discussion of state.discussions.values()) {
		if (discussion.runId === runId && discussion.findingId === findingId) return discussion;
	}
	return undefined;
}

/** The discussion of `state` that `child` is, or was, a child of, and which child it is. */
export function findReviewDiscussionChild(
	state: ReviewLogState,
	child: ReviewSessionIdentity,
): { readonly discussion: ReviewDiscussionRecord; readonly child: ReviewDiscussionChild } | undefined {
	for (const discussion of state.discussions.values()) {
		const match = discussion.children.find((item) => sameReviewSession(item.child, child));
		if (match) return { discussion, child: match };
	}
	return undefined;
}

/**
 * `state` with `entries` folded in. Records that do not apply (a General or
 * discussion of a run this log does not anchor, a second discussion of a
 * finding, a reset of an unknown discussion, a second link) change nothing;
 * the store refuses to commit them.
 */
export function foldReviewEntries(state: ReviewLogState, entries: Iterable<SessionEntry>): ReviewLogState {
	let next:
		| {
				anchors: Set<string>;
				aliases: Map<string, ReviewSessionIdentity>;
				generals: Map<string, ReviewSessionIdentity>;
				discussions: Map<string, ReviewDiscussionRecord>;
				link: ReviewDiscussionLink | undefined;
		  }
		| undefined;
	const edit = () => {
		next ??= {
			anchors: new Set(state.anchors),
			aliases: new Map(state.aliases),
			generals: new Map(state.generals),
			discussions: new Map(state.discussions),
			link: state.link,
		};
		return next;
	};
	const child = (
		ordinal: number,
		entry: { child: ReviewSessionIdentity; requestId: string; kickoffClientMessageId: string; timestamp: string },
	): ReviewDiscussionChild =>
		Object.freeze({
			ordinal,
			child: identity(entry.child),
			requestId: entry.requestId,
			kickoffClientMessageId: entry.kickoffClientMessageId,
			createdAt: entry.timestamp,
		});
	for (const entry of entries) {
		const current: ReviewLogState = next ?? state;
		switch (entry.type) {
			case "work_started":
				if (entry.kind === "review") edit().anchors.add(entry.workId);
				break;
			case "review_alias":
				if (!current.aliases.has(entry.runId)) edit().aliases.set(entry.runId, identity(entry.source));
				break;
			case "review_general":
				if (current.anchors.has(entry.runId)) edit().generals.set(entry.runId, identity(entry.general));
				break;
			case "review_discussion":
				if (
					current.anchors.has(entry.runId) &&
					!current.discussions.has(entry.discussionId) &&
					!findReviewDiscussion(current, entry.runId, entry.findingId)
				) {
					edit().discussions.set(
						entry.discussionId,
						Object.freeze({
							discussionId: entry.discussionId,
							runId: entry.runId,
							findingId: entry.findingId,
							contextSnapshot: entry.contextSnapshot,
							createdAt: entry.timestamp,
							children: Object.freeze([child(1, entry)]),
						}),
					);
				}
				break;
			case "review_discussion_reset": {
				const discussion = current.discussions.get(entry.discussionId);
				if (!discussion) break;
				const children = Object.freeze([...discussion.children, child(discussion.children.length + 1, entry)]);
				edit().discussions.set(entry.discussionId, Object.freeze({ ...discussion, children }));
				break;
			}
			case "review_discussion_link":
				if (current.link) break;
				edit().link = Object.freeze({
					discussionId: entry.discussionId,
					runId: entry.runId,
					findingId: entry.findingId,
					source: identity(entry.source),
					contextSnapshot: entry.contextSnapshot,
				});
				break;
		}
	}
	return next ? Object.freeze(next) : state;
}
