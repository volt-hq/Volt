/** Summaries of a workspace's sessions, with a live conversation's own summary taken from its open log. */

import type { RpcReviewDiscussionLink } from "@hansjm10/volt-protocol";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import type { AgentSession } from "../agent-session.ts";
import { getReviewDiscussionLink, projectReviewDiscussionLink } from "../review-discussions.ts";
import type { RpcGitContext } from "../rpc/types.ts";
import { type SessionInfo, SessionManager, type SessionOrigin } from "../session-manager.ts";

export interface WorkspaceSessionSummary {
	reviewDiscussion?: RpcReviewDiscussionLink;
	sessionId: string;
	sessionName?: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	firstMessage: string;
	current: boolean;
	cwd: string;
	/** "subagent" when this session was created for a delegated subagent run. */
	origin?: SessionOrigin;
	/** First host-observed path-free Git state for this session. */
	startingGitContext?: RpcGitContext | null;
}

export function sameFilesystemLocation(left: string, right: string): boolean {
	return canonicalizePath(resolvePath(left)) === canonicalizePath(resolvePath(right));
}

function toSessionTimestamp(value: string | undefined): string {
	if (!value) {
		return new Date(0).toISOString();
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function sessionInfoToSummary(info: SessionInfo, currentSessionId: string): WorkspaceSessionSummary {
	return {
		sessionId: info.id,
		sessionName: info.name,
		createdAt: info.created.toISOString(),
		modifiedAt: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
		current: info.id === currentSessionId,
		cwd: info.cwd,
		origin: info.origin,
		...(info.startingGitContext === undefined ? {} : { startingGitContext: info.startingGitContext }),
	};
}

/** The open session's summary, read from its log's cached projection. */
export function summarizeOpenSession(session: AgentSession, cwd: string): WorkspaceSessionSummary {
	const header = session.sessionManager.getHeader();
	const startingGitContext = session.sessionManager.getStartingGitContext();
	const summary = session.sessionManager.getSessionEntrySummary();
	const discussion = session.sessionManager.getReviewDiscussion();
	return {
		...(discussion ? { reviewDiscussion: projectReviewDiscussionLink(discussion) } : {}),
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		createdAt: toSessionTimestamp(header?.timestamp),
		modifiedAt:
			typeof summary.lastActivityTime === "number" && summary.lastActivityTime > 0
				? new Date(summary.lastActivityTime).toISOString()
				: toSessionTimestamp(header?.timestamp),
		messageCount: summary.messageCount,
		firstMessage: summary.firstMessage,
		current: true,
		cwd: header?.cwd ?? cwd,
		origin: header?.origin,
		...(startingGitContext === undefined ? {} : { startingGitContext }),
	};
}

/** The stored sessions of `cwd`'s workspace, with the open session's live summary in place of its stored one. */
export async function listWorkspaceSessions(session: AgentSession, cwd: string): Promise<WorkspaceSessionSummary[]> {
	const current = summarizeOpenSession(session, cwd);
	const infos = (await SessionManager.list(cwd, session.sessionManager.getSessionDir())).filter(
		(info) => !info.cwd || sameFilesystemLocation(info.cwd, cwd),
	);
	const summaries = await Promise.all(
		infos.map(async (info) => {
			const reviewDiscussion = await getReviewDiscussionLink(info.ref);
			return {
				...sessionInfoToSummary(info, session.sessionId),
				...(reviewDiscussion ? { reviewDiscussion } : {}),
			};
		}),
	);
	const currentIndex = summaries.findIndex((summary) => summary.sessionId === current.sessionId);
	if (currentIndex === -1) {
		return [current, ...summaries];
	}
	summaries[currentIndex] = current;
	return summaries;
}
