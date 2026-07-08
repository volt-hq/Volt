import { existsSync } from "node:fs";
import { isIrohRemoteSessionId } from "../core/remote/iroh/handshake.ts";
import { IrohRemoteOutcomeError } from "../core/remote/iroh/protocol.ts";
import { SessionManager } from "../core/session-manager.ts";

/**
 * Conversation target for a remote session, after the owner's last-session
 * bookkeeping has been applied ("last" carries the remembered session id).
 */
export type IrohRemoteSessionTarget =
	| { kind: "last"; resumeSessionId?: string }
	| { kind: "new" }
	| { kind: "session"; sessionId: string };

export type IrohRemoteSessionTargetSelection = "created" | "created_after_missing" | "resumed";

export interface ResolvedSessionTarget {
	/** Concrete id (existing file id, or freshly created). */
	sessionId: string;
	sessionFilePath?: string;
	selection: IrohRemoteSessionTargetSelection;
	/** Present for created_after_missing/resumed selections. */
	requestedSessionId?: string;
	workspaceName: string;
	workspacePath: string;
}

export interface SessionTargetSessionHandle {
	getSessionId(): string;
	getSessionFile(): string | undefined;
}

/** Minimal session-store surface consumed by target resolution — injectable for tests. */
export interface SessionTargetSessionStore<H extends SessionTargetSessionHandle = SessionTargetSessionHandle> {
	/** Existing sessions for the workspace (only entries whose files exist on disk). */
	list(): Promise<Array<{ id: string; path: string }>>;
	open(path: string): H;
	create(): H;
}

export interface ResolvedSessionTargetWithManager<H extends SessionTargetSessionHandle = SessionTargetSessionHandle>
	extends ResolvedSessionTarget {
	sessionManager: H;
}

/**
 * Resolve a conversation target to a concrete session, matching the historical
 * behavior of createIrohRemoteAgentRuntimeWithSessionSelection exactly:
 *
 * - new: always create -> "created"
 * - last without a remembered id: create -> "created"
 * - last with a remembered id: open if it exists -> "resumed", else create -> "created_after_missing"
 * - session: open if it exists -> "resumed", else throw session_unavailable
 *   (the wire protocol forbids created_after_missing for explicit session targets)
 */
export async function resolveIrohRemoteSessionTarget<H extends SessionTargetSessionHandle>(
	target: IrohRemoteSessionTarget,
	workspace: { name: string; path: string },
	sessions: SessionTargetSessionStore<H>,
): Promise<ResolvedSessionTargetWithManager<H>> {
	const resolved = (
		sessionManager: H,
		selection: IrohRemoteSessionTargetSelection,
		requestedSessionId?: string,
	): ResolvedSessionTargetWithManager<H> => ({
		sessionId: sessionManager.getSessionId(),
		...(sessionManager.getSessionFile() === undefined ? {} : { sessionFilePath: sessionManager.getSessionFile() }),
		selection,
		...(requestedSessionId === undefined ? {} : { requestedSessionId }),
		workspaceName: workspace.name,
		workspacePath: workspace.path,
		sessionManager,
	});

	if (target.kind === "new") {
		return resolved(sessions.create(), "created");
	}

	const requestedSessionId = target.kind === "last" ? target.resumeSessionId : target.sessionId;
	if (requestedSessionId === undefined) {
		return resolved(sessions.create(), "created");
	}

	if (!isIrohRemoteSessionId(requestedSessionId)) {
		if (target.kind === "session") {
			throw new IrohRemoteOutcomeError("session_unavailable", "session not found in workspace");
		}
		return resolved(sessions.create(), "created_after_missing", requestedSessionId);
	}

	const existingSession = (await sessions.list()).find((session) => session.id === requestedSessionId);
	if (!existingSession) {
		if (target.kind === "session") {
			throw new IrohRemoteOutcomeError("session_unavailable", "session not found in workspace");
		}
		return resolved(sessions.create(), "created_after_missing", requestedSessionId);
	}

	return resolved(sessions.open(existingSession.path), "resumed", requestedSessionId);
}

/** Real SessionManager-backed store for a workspace cwd + session dir. */
export function createSessionManagerTargetStore(
	cwd: string,
	sessionDir: string,
	options: { listAll?: boolean; preserveSessionCwd?: boolean } = {},
): SessionTargetSessionStore<SessionManager> {
	return {
		async list() {
			const sessions = options.listAll
				? await SessionManager.listAll(sessionDir)
				: await SessionManager.list(cwd, sessionDir);
			return sessions
				.filter((session) => existsSync(session.path))
				.map((session) => ({ id: session.id, path: session.path }));
		},
		open(path: string) {
			return SessionManager.open(path, sessionDir, options.preserveSessionCwd ? undefined : cwd);
		},
		create() {
			return SessionManager.create(cwd, sessionDir);
		},
	};
}
