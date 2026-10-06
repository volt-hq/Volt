/**
 * The conversations a conversation's work links (RFC §7): a subagent's child
 * conversation (`subagent` work), and the pass a review runs now (`review`
 * work, whose `child` moves to each pass as it opens). A client of a
 * conversation reads the children its work links, directly or through the
 * children those link, and no other conversation: an open child while it
 * runs, and a closed subagent child from its log, read-only. A closed child
 * is located only by the work record that links it, and its log must name
 * the conversation that holds that record as its parent.
 */

import type { WorkRecord } from "@hansjm10/volt-agent-core";
import type { HostedConversation } from "../host/hosted-conversation.ts";
import type { SessionManager, SessionReference } from "../session-manager.ts";
import { SUBAGENT_WORK_KIND } from "../subagents/work.ts";

/** Most links followed from a conversation to a descendant. */
export const CHILD_LINK_MAX_DEPTH = 8;

/** Most closed logs one search for a closed descendant reads for their links. */
export const CLOSED_LINK_MAX_LOGS = 32;

/** The open conversation `record` of `conversation` links: a subagent's child, or the pass a review runs now. */
function openChild(conversation: HostedConversation, record: WorkRecord): HostedConversation | undefined {
	const id = record.child?.conversation;
	if (id === undefined) return undefined;
	const child =
		record.kind === SUBAGENT_WORK_KIND
			? conversation.session.getSubagentToolManager()?.childConversation?.(id)
			: record.kind === "review"
				? conversation.session.reviewPasses.get(id)
				: undefined;
	return child && !child.closed && child.id === id ? child : undefined;
}

/**
 * The open conversation `id` that `conversation`'s work links, directly or
 * through the open children it links: the only open children a client of
 * `conversation` may observe.
 */
export function linkedChildConversation(
	conversation: HostedConversation,
	id: string,
	depth = CHILD_LINK_MAX_DEPTH,
): HostedConversation | undefined {
	const linked: HostedConversation[] = [];
	for (const record of conversation.work.list()) {
		const child = openChild(conversation, record);
		if (!child) continue;
		if (child.id === id) return child;
		linked.push(child);
	}
	if (depth <= 1) return undefined;
	for (const child of linked) {
		const found = linkedChildConversation(child, id, depth - 1);
		if (found) return found;
	}
	return undefined;
}

/** Where a closed child's log is: the locator its linking work record names, and that record's conversation. */
export interface ClosedChildLink {
	/** The child's conversation id. */
	readonly conversation: string;
	readonly ref: SessionReference;
	/** The conversation whose log holds the linking record: the child's log must name it as its parent. */
	readonly parent: string;
}

/**
 * Opens the log of a closed child read-only, once its header names it a
 * subagent log of `link.parent` with id `link.conversation`; undefined when
 * the log cannot be read or fails that check. It charges what reading the
 * log costs, and throws when the reader may not read that much.
 */
export type ClosedLogReader = (link: ClosedChildLink) => Promise<SessionManager | undefined>;

/** The link of the subagent child `record` (of the conversation `parent`) names, when its log was kept. */
function closedLink(record: WorkRecord, parent: string): ClosedChildLink | undefined {
	const child = record.kind === SUBAGENT_WORK_KIND ? record.child : undefined;
	return child?.ref === undefined ? undefined : { conversation: child.conversation, ref: child.ref, parent };
}

/**
 * The link of the closed child `id` that `conversation`'s work links at any
 * depth: through its open children, whose links cost nothing, and through
 * the logs of its closed children, which `read` opens (breadth first, at most
 * {@link CLOSED_LINK_MAX_LOGS} of them, to {@link CHILD_LINK_MAX_DEPTH}).
 * Undefined when no work links `id`, its child is open, or its log was not
 * kept. Rejects when `read` does.
 */
export async function findClosedDescendant(
	conversation: HostedConversation,
	id: string,
	read: ClosedLogReader,
): Promise<ClosedChildLink | undefined> {
	let open: HostedConversation[] = [conversation];
	let closed: ClosedChildLink[] = [];
	const seen = new Set<string>([conversation.id]);
	let logsRead = 0;
	for (let depth = 0; depth < CHILD_LINK_MAX_DEPTH && (open.length > 0 || closed.length > 0); depth++) {
		const nextOpen: HostedConversation[] = [];
		const nextClosed: ClosedChildLink[] = [];
		for (const parent of open) {
			for (const record of parent.work.list()) {
				const childId = record.child?.conversation;
				if (childId === undefined || seen.has(childId)) continue;
				const child = openChild(parent, record);
				if (childId === id) return child ? undefined : closedLink(record, parent.id);
				if (child) {
					seen.add(childId);
					nextOpen.push(child);
					continue;
				}
				const link = closedLink(record, parent.id);
				if (link) {
					seen.add(childId);
					nextClosed.push(link);
				}
			}
		}
		for (const parent of closed) {
			if (logsRead >= CLOSED_LINK_MAX_LOGS) return undefined;
			logsRead++;
			const log = await read(parent);
			if (!log) continue;
			try {
				// A closed child's children are closed with it: only their logs remain.
				for (const record of log.getConversationState().work.values()) {
					const childId = record.child?.conversation;
					if (childId === undefined || seen.has(childId)) continue;
					const link = closedLink(record, parent.conversation);
					if (childId === id) return link;
					if (link) {
						seen.add(childId);
						nextClosed.push(link);
					}
				}
			} finally {
				await log.closePersistence().catch(() => undefined);
			}
		}
		open = nextOpen;
		closed = nextClosed;
	}
	return undefined;
}
