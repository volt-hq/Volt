/**
 * The daemon's half of a phone's conversation open (Phase 7 plan §1, "Open
 * and attach"): it resolves the target to a session id read-only, with the
 * session's placement and the phone's tool policy, before the worker
 * registry routes the open. A spawn then builds the worker's conversation:
 * the log of a new session is created here, bound to its worktree, and given
 * its pull request review binding, and its lock released, so the worker
 * opens a stored log.
 */

import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { uuidv7 } from "@hansjm10/volt-agent-core";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import {
	IrohRemoteHandshakeError,
	type IrohRemoteHello,
	isIrohRemoteSessionId,
} from "../core/remote/iroh/handshake.ts";
import type {
	IrohRemoteHostHandshakeFailureOutcome,
	IrohRemoteRuntimeToolPolicy,
} from "../core/remote/iroh/protocol.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import { SessionManager, type SessionReference } from "../core/session-manager.ts";
import type { SessionWriter } from "../core/session-writer.ts";
import type { IntegratedConversationSessionSelection } from "./handshake-responses.ts";
import { resolveIrohRemoteSessionTarget, type SessionTargetSessionHandle } from "./session-target.ts";
import type { WorkerSpawnInput } from "./worker-registry.ts";
import type { WorkerCompatibility } from "./worker-spawn-options.ts";
import { isPathInside, type WorkspaceDirectoryResolution } from "./workspace-directory.ts";
import type { WorkspaceSessions } from "./workspace-sessions.ts";
import { getRegisteredWorkingDirectoryForWorktree, type WorktreeRuntimePreparation } from "./worktree-manager.ts";

export function createConversationOpenError(
	outcome: IrohRemoteHostHandshakeFailureOutcome,
	message: string,
	details: Record<string, unknown> = {},
): IrohRemoteHandshakeError {
	const error = new IrohRemoteHandshakeError(outcome, message);
	Object.assign(error, details);
	return error;
}

/** The session a conversation hello names: its own, or for `last` the phone's last one in the workspace. */
export function getResolvedTargetSessionId(
	hello: IrohRemoteHello,
	authorization: IrohRemoteClientAuthorizationSuccess,
): string | undefined {
	if (hello.mode !== "conversation") return undefined;
	if (hello.conversation.target === "session" || hello.conversation.target === "new") {
		return hello.conversation.sessionId;
	}
	if (hello.conversation.target !== "last") return undefined;
	const previousSessionId = authorization.client.lastSessionIdByWorkspace?.[authorization.workspace.name];
	return isIrohRemoteSessionId(previousSessionId) ? previousSessionId : undefined;
}

/** `cwd` relative to `rootPath`, POSIX-style; refused when outside it or unreadable. */
async function resolveInsideRoot(rootPath: string, cwd: string): Promise<WorkspaceDirectoryResolution> {
	let rootReal: string;
	let cwdReal: string;
	try {
		rootReal = await realpath(rootPath);
		cwdReal = await realpath(cwd);
	} catch {
		throw createConversationOpenError("session_unavailable", "session working directory is unavailable");
	}
	if (!isPathInside(rootReal, cwdReal)) {
		throw createConversationOpenError(
			"session_unavailable",
			"stored session working directory is outside the authorized workspace",
		);
	}
	const relativePath = relative(rootReal, cwdReal).split(sep).join("/");
	return { absolutePath: cwdReal, ...(relativePath.length === 0 ? {} : { relativePath }) };
}

/** The daemon's services a conversation open draws on. */
export interface ConversationOpenServices {
	/** The stored sessions each workspace owns: a phone opens only its workspace's. */
	readonly workspaceSessions: WorkspaceSessions;
	readonly profile?: string;
	/** The phone's tool policy: its grant ∩ the workspace ceiling ∩ `remote.allowTools` (D9). */
	toolPolicy(authorization: IrohRemoteClientAuthorizationSuccess): IrohRemoteRuntimeToolPolicy;
	projectTrusted(workspace: IrohRemoteWorkspace): boolean;
	resolveWorktree(
		workspaceName: string,
		hello: IrohRemoteHello,
		targetSessionId: string | undefined,
	): Promise<IrohRemoteWorkspaceWorktree | undefined>;
	resolveWorkingDirectory(options: {
		workspace: IrohRemoteWorkspace;
		rootPath: string;
		workingDirectory?: string;
		worktree?: IrohRemoteWorkspaceWorktree;
	}): Promise<WorkspaceDirectoryResolution>;
	prepareWorktreeRuntime(
		workspaceName: string,
		worktreeId: string,
		sessionId?: string,
	): Promise<WorktreeRuntimePreparation>;
	/** Validate a prepared pull request review; its binding is recorded in the log before the worker opens it. */
	preparePrReviewSession(
		authorization: IrohRemoteClientAuthorizationSuccess,
		hello: IrohRemoteHello,
		signal?: AbortSignal,
	): Promise<((writer: SessionWriter) => Promise<void>) | undefined>;
	bindWorktreeSession(workspaceName: string, worktreeId: string, sessionId: string): Promise<void>;
}

/** A phone's conversation, resolved read-only. */
export interface ResolvedConversationOpen {
	readonly sessionId: string;
	readonly selection: IntegratedConversationSessionSelection;
	readonly worktree?: IrohRemoteWorkspaceWorktree;
	/** The working directory echoed to the phone, relative to the registered workspace. */
	readonly workingDirectory?: string;
	/** The phone's tool policy, which a worker it spawns runs with (D9). */
	readonly toolPolicy: IrohRemoteRuntimeToolPolicy;
	/** What a worker for the conversation runs every conversation with: its compatibility key's inputs (D11 revised). */
	readonly compatibility: Extract<WorkerCompatibility, { origin: "phone" }>;
	/**
	 * Build the spawn of a worker for the conversation: a new session's log is
	 * created (with its id), bound to its worktree, given its pull request
	 * review binding, and closed.
	 */
	prepare(workspaceGeneration: number, signal?: AbortSignal): Promise<WorkerSpawnInput>;
}

/** A session the resolution names before it exists: created only when a worker spawns for it. */
interface DeferredSession extends SessionTargetSessionHandle {
	readonly deferred: true;
}

/**
 * Resolve a phone's conversation hello read-only: the session it names (the
 * id of a new one minted here), its worktree and working directory, and the
 * phone's tool policy.
 */
export async function resolveConversationOpen(
	hello: IrohRemoteHello,
	authorization: IrohRemoteClientAuthorizationSuccess,
	services: ConversationOpenServices,
	signal?: AbortSignal,
): Promise<ResolvedConversationOpen> {
	if (hello.mode !== "conversation") throw new Error("A conversation open needs a conversation stream");
	const workspace = authorization.workspace;
	const requestedTarget = getResolvedTargetSessionId(hello, authorization);
	const worktree = await services.resolveWorktree(workspace.name, hello, requestedTarget);
	signal?.throwIfAborted();
	const rootPath = worktree?.path ?? workspace.path;
	const requestedWorkingDirectory =
		hello.conversation.target === "new" ? hello.conversation.workingDirectory : undefined;
	const initialDirectory = await services.resolveWorkingDirectory({
		workspace,
		rootPath,
		...(requestedWorkingDirectory === undefined ? {} : { workingDirectory: requestedWorkingDirectory }),
		...(worktree === undefined ? {} : { worktree }),
	});
	signal?.throwIfAborted();
	const sessions = services.workspaceSessions;
	const target =
		hello.conversation.target === "new"
			? hello.conversation.sessionId === undefined
				? ({ kind: "last" } as const)
				: ({ kind: "new", sessionId: hello.conversation.sessionId } as const)
			: hello.conversation.target === "session"
				? ({ kind: "session", sessionId: hello.conversation.sessionId } as const)
				: (() => {
						const previous = authorization.client.lastSessionIdByWorkspace?.[workspace.name];
						return previous === undefined
							? ({ kind: "last" } as const)
							: ({ kind: "last", resumeSessionId: previous } as const);
					})();
	// A new conversation's id names one stored conversation: one another workspace owns, or none does, never opens here.
	if (target.kind === "new") {
		const stored = await sessions.locate(target.sessionId).catch(() => undefined);
		if (stored !== undefined && stored.placement?.workspace.name !== workspace.name) {
			throw createConversationOpenError(
				"invalid_conversation_target",
				"session id is already used outside this workspace",
				{ workspace: workspace.name, sessionId: target.sessionId },
			);
		}
	}
	const resolved = await resolveIrohRemoteSessionTarget<SessionManager | DeferredSession>(
		target,
		{ name: workspace.name, path: workspace.path },
		{
			find: async (sessionId) => (await sessions.find(workspace.name, sessionId))?.ref,
			list: async () => (await sessions.list(workspace.name)).map((info) => ({ id: info.id, ref: info.ref })),
			open: (ref) => SessionManager.openReadOnly(ref),
			// Nothing is created yet: a spawn creates the log.
			create: async (sessionId) => {
				const id = sessionId ?? uuidv7();
				return {
					deferred: true,
					getSessionId: () => id,
					getSessionRef: () => undefined,
					closePersistence: async () => {},
				};
			},
		},
	);
	const sessionId = resolved.sessionId;
	const selection: IntegratedConversationSessionSelection =
		resolved.selection === "created"
			? { kind: "created", sessionId }
			: { kind: resolved.selection, requestedSessionId: resolved.requestedSessionId ?? sessionId, sessionId };
	let storedRef: SessionReference | undefined;
	let cwd: WorkspaceDirectoryResolution;
	if ("deferred" in resolved.sessionManager) {
		cwd = initialDirectory;
	} else {
		const manager = resolved.sessionManager;
		storedRef = manager.getSessionRef();
		let storedCwd: string;
		try {
			storedCwd = manager.getCwd();
		} finally {
			await manager.closePersistence();
		}
		cwd = await resolveInsideRoot(rootPath, storedCwd);
	}
	signal?.throwIfAborted();
	const remoteWorkingDirectory =
		worktree === undefined ? cwd.relativePath : getRegisteredWorkingDirectoryForWorktree(worktree, cwd.relativePath);
	if (
		hello.conversation.target === "new" &&
		selection.kind === "resumed" &&
		requestedWorkingDirectory !== remoteWorkingDirectory
	) {
		throw createConversationOpenError(
			"invalid_conversation_target",
			"session id is already bound to a different working directory",
			{ workspace: workspace.name, sessionId },
		);
	}
	const echoedWorkingDirectory =
		hello.conversation.target === "new" && requestedWorkingDirectory === undefined
			? undefined
			: remoteWorkingDirectory;
	const toolPolicy = services.toolPolicy(authorization);
	const compatibility = {
		origin: "phone" as const,
		toolPolicy: { tools: [...toolPolicy.tools], allowUnlistedExtensionTools: toolPolicy.allowUnlistedExtensionTools },
		projectTrusted: services.projectTrusted(workspace),
		...(services.profile === undefined ? {} : { profile: services.profile }),
	};

	return {
		sessionId,
		selection,
		...(worktree === undefined ? {} : { worktree }),
		...(echoedWorkingDirectory === undefined ? {} : { workingDirectory: echoedWorkingDirectory }),
		toolPolicy,
		compatibility,
		prepare: async (workspaceGeneration, prepareSignal) => {
			const bindPrReview = await services.preparePrReviewSession(authorization, hello, prepareSignal);
			const preparation =
				worktree === undefined
					? undefined
					: await services.prepareWorktreeRuntime(workspace.name, worktree.id, sessionId);
			try {
				prepareSignal?.throwIfAborted();
				let ref = storedRef;
				const created = ref === undefined;
				if (created || bindPrReview !== undefined) {
					const manager =
						ref === undefined
							? await SessionManager.create(cwd.absolutePath, sessions.sessionDir, { id: sessionId })
							: await SessionManager.open(ref);
					try {
						await bindPrReview?.(manager.logWriter);
						ref = manager.getSessionRef();
					} finally {
						await manager.closePersistence();
					}
				}
				if (ref === undefined) throw new Error("The conversation's log has no reference");
				// Every session created under a worktree stays bound to it across daemon restarts (#83).
				if (worktree !== undefined && created) {
					await services.bindWorktreeSession(workspace.name, worktree.id, sessionId);
				}
				await preparation?.publish(() => undefined);
				return {
					origin: "phone",
					workspace: { name: workspace.name, path: workspace.path, generation: workspaceGeneration },
					session: ref,
					cwd: cwd.absolutePath,
					root: rootPath,
					projectCwd: rootPath,
					...(worktree?.baseRef === undefined ? {} : { baseRef: worktree.baseRef }),
					toolPolicy: { ...compatibility.toolPolicy, tools: [...compatibility.toolPolicy.tools] },
					projectTrusted: compatibility.projectTrusted,
					...(compatibility.profile === undefined ? {} : { profile: compatibility.profile }),
				};
			} catch (error) {
				await preparation?.release().catch(() => undefined);
				throw error;
			}
		},
	};
}
