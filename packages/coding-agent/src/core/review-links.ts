/**
 * Review runs across conversations (RFC §14 Q7). A run's source is the
 * conversation whose log anchors it: the `work_started` of the review work
 * that produced it. A handoff target carries a run as an alias
 * (`review_alias`, naming the source), and a finding discussion child names
 * its source in its link. The source's log holds the run's General
 * (`review_general`) and its discussions.
 *
 * Membership comes from a conversation's own host records, which only the
 * host writes and which fork, clone, and import never copy; the store's
 * derived run index confirms the source and answers the General. A write to
 * a source's log re-reads that log first, under its single writer.
 */

import type { RpcReviewGeneral } from "@hansjm10/volt-protocol";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ConversationHost } from "./host/conversation-host.ts";
import { type ReviewSessionIdentity, sameReviewSession } from "./review-log-state.ts";
import { SessionManager, type SessionReference } from "./session-manager.ts";
import { acquireSharedSQLiteSessionStore, type SQLiteSessionStoreClient } from "./session-store/client.ts";
import type { SessionStoreReviewRun } from "./session-store/types.ts";
import type { SessionWriter } from "./session-writer.ts";

export class ReviewSourceUnavailableError extends Error {
	readonly code = "review_source_unavailable";

	constructor(message = "The canonical review source is unavailable.", options?: ErrorOptions) {
		super(message, options);
		this.name = "ReviewSourceUnavailableError";
	}
}

/**
 * Write the log of a run's source `ref`: through the conversation that has
 * it open, or by opening it. Writes to one source run one at a time.
 */
export type ReviewSourceWriter = <T>(ref: SessionReference, write: (writer: SessionWriter) => Promise<T>) => Promise<T>;

function canonicalCwd(cwd: string): string {
	return canonicalizePath(resolvePath(cwd));
}

function identityOf(ref: Pick<SessionReference, "sessionId" | "sessionGeneration">): ReviewSessionIdentity {
	return { sessionId: ref.sessionId, sessionGeneration: ref.sessionGeneration };
}

function sameStore(left: SessionReference, right: SessionReference): boolean {
	return left.storeId === right.storeId && resolvePath(left.sessionDirectory) === resolvePath(right.sessionDirectory);
}

/** A check that `manager` still reads the same session incarnation in the same cwd. */
function managerGuard(manager: SessionManager): () => void {
	const ref = manager.getSessionRef();
	const cwd = manager.getCwd();
	return () => {
		const current = manager.getSessionRef();
		if (
			current?.storeId !== ref?.storeId ||
			current?.sessionId !== ref?.sessionId ||
			current?.sessionGeneration !== ref?.sessionGeneration ||
			manager.getCwd() !== cwd
		)
			throw new ReviewSourceUnavailableError("The review conversation changed during lookup.");
	};
}

async function withStore<T>(ref: SessionReference, read: (store: SQLiteSessionStoreClient) => Promise<T>): Promise<T> {
	const lease = await acquireSharedSQLiteSessionStore(ref.sessionDirectory);
	try {
		if (lease.client.info.storeId !== ref.storeId) throw new ReviewSourceUnavailableError();
		return await read(lease.client);
	} finally {
		await lease.release();
	}
}

interface ReviewMembership {
	/** The run's source. */
	readonly source: SessionReference;
	/** The run as the store indexes it. */
	readonly run: SessionStoreReviewRun;
}

/**
 * Run `runId`'s source and index, when `manager`'s conversation is its
 * source or a handoff alias of it (or, with `children`, a current or earlier
 * discussion child of it); undefined when it is none of them, or when it ran
 * the run before the store indexed runs. A member whose source is gone, or
 * that runs in another cwd than the source, fails.
 */
async function reviewMembership(
	manager: SessionManager,
	runId: string,
	options: { readonly children?: boolean } = {},
): Promise<ReviewMembership | undefined> {
	const ref = manager.getSessionRef();
	if (!ref) return undefined;
	const review = manager.getReviewState();
	const self = identityOf(ref);
	const alias = review.aliases.get(runId);
	const link = review.link;
	let claimed: ReviewSessionIdentity;
	let kind: "source" | "alias" | "child";
	if (review.anchors.has(runId)) {
		claimed = self;
		kind = "source";
	} else if (alias) {
		claimed = alias;
		kind = "alias";
	} else if (options.children && link?.runId === runId) {
		claimed = link.source;
		kind = "child";
	} else {
		return undefined;
	}
	const assertCurrent = managerGuard(manager);
	const cwd = manager.getCwd();
	return withStore(ref, async (store) => {
		const member = await store.findSessionSummary(ref.sessionId, ref.sessionGeneration);
		if (!member) throw new ReviewSourceUnavailableError("The review conversation incarnation is unavailable.");
		const run = await store.findReviewRun(runId);
		const source =
			kind === "source" ? member : await store.findSessionSummary(claimed.sessionId, claimed.sessionGeneration);
		const child = kind === "child" ? await store.findReviewDiscussionChild(self) : undefined;
		assertCurrent();
		if (kind === "source") {
			// A run anchored before v5 was never indexed: it stays an unanchored report.
			if (!run || !sameReviewSession(run.source, self)) return undefined;
		} else if (!run || !sameReviewSession(run.source, claimed)) {
			throw new ReviewSourceUnavailableError();
		}
		if (
			kind === "child" &&
			(child?.runId !== runId ||
				child.discussionId !== link?.discussionId ||
				!sameReviewSession(child.source, claimed))
		) {
			// A discussion child is one only while its source records it.
			throw new ReviewSourceUnavailableError("This conversation is not a discussion of the review run.");
		}
		if (
			!source ||
			canonicalCwd(member.cwd) !== canonicalCwd(source.cwd) ||
			canonicalCwd(cwd) !== canonicalCwd(source.cwd)
		)
			throw new ReviewSourceUnavailableError();
		return { source: { ...ref, ...claimed }, run };
	});
}

/**
 * The source of run `runId` when this conversation is its source or a handoff
 * alias of it; undefined for a run it holds only a copy of (forked, imported,
 * or from before v5), which stays a local report.
 */
export async function resolveCanonicalReviewSource(
	manager: SessionManager,
	runId: string,
): Promise<SessionReference | undefined> {
	return (await reviewMembership(manager, runId))?.source;
}

/**
 * Where run `runId`'s General discussion is. A read for the run's source,
 * its aliases, and its current and earlier discussion children; it grants
 * none of them anything.
 */
export async function getReviewGeneral(manager: SessionManager, runId: string): Promise<RpcReviewGeneral> {
	const ref = manager.getSessionRef();
	if (!ref) throw new ReviewSourceUnavailableError("Review General requires a durable review anchor.");
	const membership = await reviewMembership(manager, runId, { children: true });
	if (!membership)
		throw new ReviewSourceUnavailableError("This conversation is not an exact member of the review run.");
	const { source, run } = membership;
	const assertCurrent = managerGuard(manager);
	const general = await withStore(ref, async (store) => {
		const sourceSummary = await store.findSessionSummary(source.sessionId, source.sessionGeneration);
		const generalSummary = await store.findSessionSummary(run.general.sessionId, run.general.sessionGeneration);
		return (
			sourceSummary !== null &&
			generalSummary !== null &&
			canonicalCwd(generalSummary.cwd) === canonicalCwd(sourceSummary.cwd)
		);
	});
	assertCurrent();
	return {
		runId,
		sourceSessionId: source.sessionId,
		generalSessionId: run.general.sessionId,
		generalSessionGeneration: run.general.sessionGeneration,
		generalAvailable: general,
	};
}

/**
 * Record through `target`, the writer of a handoff's new conversation, that
 * it carries the runs of `runIds` its source `source` is a member of. Runs
 * `source` holds only a copy of stay copies.
 */
export async function registerReviewHandoffAliases(
	source: SessionManager,
	target: SessionWriter,
	runIds: readonly string[],
): Promise<void> {
	if (runIds.length === 0) return;
	const from = source.getSessionRef();
	const to = target.sessionManager.getSessionRef();
	if (!from || !to) return;
	if (!sameStore(from, to)) throw new Error("Review handoff crosses stores");
	const aliases: { runId: string; source: ReviewSessionIdentity }[] = [];
	for (const runId of runIds) {
		const membership = await reviewMembership(source, runId);
		if (!membership) continue;
		if (canonicalCwd(target.sessionManager.getCwd()) !== canonicalCwd(source.getCwd()))
			throw new Error("Review handoff cwd mismatch");
		aliases.push({ runId, source: identityOf(membership.source) });
	}
	if (aliases.length === 0) return;
	await target.recordReviewState((state) => ({
		records: aliases
			.filter(({ runId }) => !state.aliases.has(runId) && !state.anchors.has(runId))
			.map(({ runId, source: sourceIdentity }) => ({
				type: "review_alias" as const,
				runId,
				source: sourceIdentity,
			})),
		result: undefined,
	}));
}

/**
 * Writes a source's log through the conversation `host` has open on it, or,
 * when none does, by opening it, which fails while another host has it open.
 */
export function hostReviewSourceWriter(host: ConversationHost): ReviewSourceWriter {
	const lanes = new Map<string, Promise<unknown>>();
	return <T>(ref: SessionReference, write: (writer: SessionWriter) => Promise<T>): Promise<T> => {
		const key = `${ref.storeId}:${ref.sessionId}`;
		const run = async (): Promise<T> => {
			const live = host.list().find((conversation) => {
				const current = conversation.session.sessionRef;
				return (
					current !== undefined &&
					sameStore(current, ref) &&
					current.sessionId === ref.sessionId &&
					current.sessionGeneration === ref.sessionGeneration
				);
			});
			if (live) return live.whileOpen((session) => write(session.sessionWriter));
			const manager = await SessionManager.open(ref);
			try {
				return await write(manager.logWriter);
			} finally {
				await manager.closePersistence();
			}
		};
		const result = (lanes.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
		lanes.set(key, result);
		void result
			.finally(() => {
				if (lanes.get(key) === result) lanes.delete(key);
			})
			.catch(() => undefined);
		return result;
	};
}

/**
 * Prepare moving run `runId`'s General from `general`, which must be the
 * current General, to a new conversation. `commit` records the move in the
 * run's source, through `writeSource`, once the new conversation is ready:
 * it re-reads the source's log and moves the General only if `general` is
 * still current there, so of competing replacements one wins.
 */
export async function prepareReviewGeneralReplacement(
	general: SessionManager,
	runId: string,
	writeSource: ReviewSourceWriter,
): Promise<{ commit(target: SessionManager): Promise<void> }> {
	const current = await getReviewGeneral(general, runId);
	const from = general.getSessionRef()!;
	if (
		!current.generalAvailable ||
		current.generalSessionId !== from.sessionId ||
		current.generalSessionGeneration !== from.sessionGeneration
	)
		throw new ReviewSourceUnavailableError("Only the exact current General can replace itself.");
	const membership = await reviewMembership(general, runId);
	if (!membership) throw new ReviewSourceUnavailableError("Only the exact current General can replace itself.");
	const source = membership.source;
	return {
		async commit(target) {
			const to = target.getSessionRef();
			if (!to || !sameStore(to, from)) {
				throw new ReviewSourceUnavailableError("Review General replacement crosses stores.");
			}
			const replacement = identityOf(to);
			const carried = target.getReviewState().aliases.get(runId);
			if (
				sameReviewSession(replacement, identityOf(from)) ||
				!carried ||
				!sameReviewSession(carried, identityOf(source)) ||
				canonicalCwd(target.getCwd()) !== canonicalCwd(general.getCwd())
			) {
				throw new ReviewSourceUnavailableError("Replacement General must be a new conversation carrying the run.");
			}
			await writeSource(source, (writer) =>
				writer.recordReviewState((state) => {
					// The source's own log decides: it anchors the run, and `from` is still its General.
					const currentGeneral = state.generals.get(runId) ?? identityOf(source);
					if (!state.anchors.has(runId) || !sameReviewSession(currentGeneral, identityOf(from))) {
						throw new ReviewSourceUnavailableError("Only the exact current General can replace itself.");
					}
					return { records: [{ type: "review_general", runId, general: replacement }], result: undefined };
				}),
			);
		},
	};
}
