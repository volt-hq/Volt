import { ConversationLockedError } from "../core/conversation-log/conversation-lock.ts";
import { isIrohRemoteSessionId } from "../core/remote/iroh/handshake.ts";
import {
	IROH_REMOTE_HOST_STORAGE_FULL_MESSAGE,
	IrohRemoteOutcomeError,
	isIrohRemoteHostStorageFullError,
} from "../core/remote/iroh/protocol.ts";
import { SessionManager, type SessionReference } from "../core/session-manager.ts";
import { SessionStoreError } from "../core/session-store/types.ts";

/**
 * Map a session open or create failure to a phone-facing outcome. Messages are
 * constant: the cause (which can name host paths) stays on `cause` only.
 */
function sessionTargetFailure(error: unknown, workspace: string, sessionId?: string): IrohRemoteOutcomeError {
	const identity = sessionId === undefined ? { workspace } : { workspace, sessionId };
	if (error instanceof ConversationLockedError) {
		// A lock held by this daemon belongs to a runtime that is still being created or retired here.
		return error.holder === "this_process"
			? Object.assign(
					new IrohRemoteOutcomeError(
						"duplicate_conversation_connection",
						"conversation runtime is changing; retry",
					),
					{ cause: error, ...identity, retryAfterMs: 500 },
				)
			: Object.assign(
					new IrohRemoteOutcomeError(
						"conversation_locked",
						"conversation is open in another Volt process on the host",
					),
					{ cause: error, ...identity },
				);
	}
	if (isIrohRemoteHostStorageFullError(error) || (error instanceof SessionStoreError && error.code === "store_full")) {
		return Object.assign(new IrohRemoteOutcomeError("host_storage_full", IROH_REMOTE_HOST_STORAGE_FULL_MESSAGE), {
			cause: error,
			...identity,
		});
	}
	if (
		error instanceof SessionStoreError &&
		[
			"closed",
			"invalid_response",
			"store_initialization_failed",
			"store_schema_mismatch",
			"store_busy",
			"store_io_error",
			"worker_failed",
		].includes(error.code)
	) {
		// A workspace-wide store failure says nothing about this conversation's
		// identity. Keep it retryable instead of making every saved pin stale.
		return Object.assign(
			new IrohRemoteOutcomeError(
				"workspace_unavailable",
				"workspace session storage is unavailable; retry after the host recovers",
			),
			{ cause: error, workspace, retryAfterMs: 5_000 },
		);
	}
	return Object.assign(new IrohRemoteOutcomeError("session_unavailable", "session state is corrupt or ambiguous"), {
		cause: error,
		...identity,
	});
}

/**
 * Conversation target for a remote session, after the owner's last-session
 * bookkeeping has been applied ("last" carries the remembered session id).
 */
export type IrohRemoteSessionTarget =
	| { kind: "last"; resumeSessionId?: string }
	| { kind: "new"; sessionId: string }
	| { kind: "session"; sessionId: string };

export type IrohRemoteSessionTargetSelection = "created" | "created_after_missing" | "resumed";

export interface ResolvedSessionTarget {
	/** Concrete id (existing session id, or freshly created). */
	sessionId: string;
	sessionRef?: SessionReference;
	selection: IrohRemoteSessionTargetSelection;
	/** Present for created_after_missing/resumed selections. */
	requestedSessionId?: string;
	workspaceName: string;
	workspacePath: string;
}

export interface SessionTargetSessionHandle {
	getSessionId(): string;
	getSessionRef(): SessionReference | undefined;
	/** Release the handle, including the session lock a writer holds. */
	closePersistence(): Promise<void>;
}

/** Minimal session-store surface consumed by target resolution — injectable for tests. */
export interface SessionTargetSessionStore<H extends SessionTargetSessionHandle = SessionTargetSessionHandle> {
	/** Existing sessions for the workspace. */
	list(): Promise<Array<{ id: string; ref: SessionReference }>>;
	/** Strict internal lookup that may include selector-hidden WAL-only sessions. */
	find?(sessionId: string): Promise<SessionReference | undefined>;
	open(ref: SessionReference): Promise<H>;
	create(sessionId?: string): Promise<H>;
}

export interface ResolvedSessionTargetWithManager<H extends SessionTargetSessionHandle = SessionTargetSessionHandle>
	extends ResolvedSessionTarget {
	sessionManager: H;
}

/**
 * Resolve a conversation target to a concrete session, matching the historical
 * behavior of createIrohRemoteAgentRuntimeWithSessionSelection exactly:
 *
 * - new: create the caller-named id once, or resume that exact id on retry
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
	): ResolvedSessionTargetWithManager<H> => {
		const sessionRef = sessionManager.getSessionRef();
		return {
			sessionId: sessionManager.getSessionId(),
			...(sessionRef === undefined ? {} : { sessionRef }),
			selection,
			...(requestedSessionId === undefined ? {} : { requestedSessionId }),
			workspaceName: workspace.name,
			workspacePath: workspace.path,
			sessionManager,
		};
	};

	// Creating takes the new session's lock; its failures are mapped like an open's.
	const create = async (sessionId?: string): Promise<H> => {
		try {
			return await sessions.create(sessionId);
		} catch (error) {
			throw sessionTargetFailure(error, workspace.name, sessionId);
		}
	};

	const requestedSessionId = target.kind === "last" ? target.resumeSessionId : target.sessionId;
	if (requestedSessionId === undefined) {
		return resolved(await create(), "created");
	}

	if (!isIrohRemoteSessionId(requestedSessionId)) {
		if (target.kind === "session" || target.kind === "new") {
			throw new IrohRemoteOutcomeError("session_unavailable", "session not found in workspace");
		}
		return resolved(await create(), "created_after_missing", requestedSessionId);
	}

	let existingSessionRef: SessionReference | undefined;
	try {
		existingSessionRef = sessions.find
			? await sessions.find(requestedSessionId)
			: (await sessions.list()).find((session) => session.id === requestedSessionId)?.ref;
	} catch (error) {
		// Corrupt or duplicate durable identity is unavailable, never missing. In
		// particular, `last` must not create a fresh idempotency domain and replay
		// a handled side effect under the same clientMessageId.
		throw sessionTargetFailure(error, workspace.name, requestedSessionId);
	}
	if (!existingSessionRef) {
		if (target.kind === "session") {
			throw new IrohRemoteOutcomeError("session_unavailable", "session not found in workspace");
		}
		if (target.kind === "new") {
			return resolved(await create(requestedSessionId), "created");
		}
		return resolved(await create(), "created_after_missing", requestedSessionId);
	}

	let sessionManager: H | undefined;
	try {
		sessionManager = await sessions.open(existingSessionRef);
		if (sessionManager.getSessionId() !== requestedSessionId) {
			throw new Error("session identity changed while opening resume target");
		}
		return resolved(sessionManager, "resumed", target.kind === "new" ? undefined : requestedSessionId);
	} catch (error) {
		// Lookup and open cannot be atomic across an arbitrary injected store. Fail
		// closed if the target disappears, is replaced, or no longer claims the
		// requested durable idempotency domain between those operations, releasing
		// what was opened (and its session lock) first.
		await sessionManager?.closePersistence().catch(() => {});
		throw sessionTargetFailure(error, workspace.name, requestedSessionId);
	}
}

/**
 * Real SessionManager-backed store for a workspace cwd + session dir. Existing
 * sessions open for writing (taking their lock) unless `readOnly` is set.
 */
export function createSessionManagerTargetStore(
	cwd: string,
	sessionDir: string,
	options: { listAll?: boolean; preserveSessionCwd?: boolean; readOnly?: boolean } = {},
): SessionTargetSessionStore<SessionManager> {
	return {
		async find(sessionId) {
			return SessionManager.findForResume(sessionDir, sessionId);
		},
		async list() {
			const sessions = options.listAll
				? await SessionManager.listAll(sessionDir)
				: await SessionManager.list(cwd, sessionDir);
			return sessions.map((session) => ({ id: session.id, ref: session.ref }));
		},
		async open(ref) {
			const cwdOverride = options.preserveSessionCwd ? undefined : cwd;
			return options.readOnly
				? SessionManager.openReadOnly(ref, cwdOverride)
				: SessionManager.open(ref, cwdOverride);
		},
		async create(sessionId) {
			return SessionManager.create(cwd, sessionDir, sessionId === undefined ? undefined : { id: sessionId });
		},
	};
}
