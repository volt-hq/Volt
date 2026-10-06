/**
 * Summaries of stored sessions: a workspace's, or every session directory's,
 * possibly matching a search, with a live conversation's own summary taken
 * from its open log.
 */

import type { RpcReviewDiscussionLink } from "@hansjm10/volt-protocol";
import type { RpcGitContext } from "@hansjm10/volt-protocol/git-context";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import type { AgentSession } from "../agent-session.ts";
import { getReviewDiscussionLink, projectReviewDiscussionLink } from "../review-discussions.ts";
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
	/** The session this one was started from. */
	parentSessionId?: string;
	/** The session directory the session is stored in; absent for a session that is not stored. */
	sessionDir?: string;
}

/** Which stored sessions a listing reads: the workspace's or every session directory's, possibly searched. */
export interface SessionListingOptions {
	readonly scope?: "workspace" | "all";
	readonly search?: string;
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
		...(info.parentSessionRef === undefined ? {} : { parentSessionId: info.parentSessionRef.sessionId }),
		sessionDir: info.ref.sessionDirectory,
	};
}

/** The open session's summary, read from its log's cached projection. */
export function summarizeOpenSession(session: AgentSession, cwd: string): WorkspaceSessionSummary {
	const header = session.sessionManager.getHeader();
	const startingGitContext = session.sessionManager.getStartingGitContext();
	const summary = session.sessionManager.getSessionEntrySummary();
	const discussion = session.sessionManager.getReviewDiscussion();
	const sessionDir = session.sessionManager.isPersisted() ? session.sessionManager.getSessionDir() : undefined;
	return {
		...(discussion ? { reviewDiscussion: projectReviewDiscussionLink(discussion, session.sessionId) } : {}),
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
		...(header?.parentSession === undefined ? {} : { parentSessionId: header.parentSession.sessionId }),
		...(sessionDir ? { sessionDir } : {}),
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

/**
 * Stored sessions as `options` select them: the workspace's (`listWorkspaceSessions`
 * without a search), or every session directory's, as the session picker
 * lists them. A search keeps the sessions whose text matches it. The open
 * session's live summary replaces its stored one.
 */
export async function listSessionSummaries(
	session: AgentSession,
	cwd: string,
	options: SessionListingOptions = {},
): Promise<WorkspaceSessionSummary[]> {
	const { scope = "workspace", search } = options;
	if (scope === "workspace" && search === undefined) return listWorkspaceSessions(session, cwd);
	const manager = session.sessionManager;
	const sessionDir = manager.getSessionDir();
	let infos: SessionInfo[];
	if (scope === "workspace") {
		infos = (await SessionManager.search(cwd, search ?? "", sessionDir)).filter(
			(info) => !info.cwd || sameFilesystemLocation(info.cwd, cwd),
		);
	} else if (search === undefined) {
		infos = manager.usesDefaultSessionDir()
			? await SessionManager.listAll()
			: await SessionManager.listAll(sessionDir);
	} else {
		infos = manager.usesDefaultSessionDir()
			? await SessionManager.searchAll(search)
			: await SessionManager.searchAll(search, sessionDir);
	}
	const current = summarizeOpenSession(session, cwd);
	return infos.map((info) =>
		info.id === current.sessionId ? current : sessionInfoToSummary(info, session.sessionId),
	);
}
