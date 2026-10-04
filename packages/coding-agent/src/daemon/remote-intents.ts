/**
 * What the daemon gives a paired device's intents and queries beyond the
 * conversation (Phase 3 plan, "remote host commands"): its push target, the
 * host's keep-awake and web search key, and the stream's registered
 * workspace (sessions, worktrees, folders, configured agents, pull request
 * reviews, device logs, and unregistering it). Every operation acts on the
 * workspace the stream was admitted for; the registry admits each intent and
 * query on the device's grant first.
 *
 * A stream's purpose decides which of these it serves: a conversation stream
 * serves the conversation's intents and the workspace operations a phone uses
 * beside a conversation; each workspace stream serves its purpose only.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	IrohRemoteWorkspaceDiscoveryTarget,
	IrohRemoteWorkspaceManagementTarget,
	IrohRemoteWorktreeSummary,
	PrReviewPrepareRequest,
	PrReviewPrepareResponse,
	PrReviewPullRequest,
	PrReviewResolveResponse,
	PrReviewSourceRequest,
	RpcSessionListItemSchema,
	RpcSessionWorkContextSchema,
} from "@hansjm10/volt-protocol";
import {
	DYNAMIC_INTENT_PATTERN,
	type RejectionReason,
	RpcPreparePrReviewResponseSchema,
	RpcResolvePrReviewResponseSchema,
} from "@hansjm10/volt-protocol";
import type { Static } from "typebox";
import { Compile } from "typebox/compile";
import type { HostedConversation } from "../core/host/hosted-conversation.ts";
import {
	type IntentHostTheme,
	type IntentKeepAwakeService,
	type IntentPushTargetService,
	type IntentServices,
	type IntentWebSearchKeyService,
	type IntentWorkspaceServices,
	WorkspaceIntentError,
} from "../core/protocol/intents/types.ts";
import type { IrohRemoteAgentOptionsRpcBackend } from "../core/remote/iroh/agent-options.ts";
import type { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import { uploadIrohRemoteDeviceLog } from "../core/remote/iroh/device-log-rpc.ts";
import { type IrohRemotePrReviewRpcBackend, PrReviewPreparationError } from "../core/remote/iroh/pr-review-rpc.ts";
import { isIrohRemoteWorkingDirectory } from "../core/remote/iroh/protocol.ts";
import { createIrohRemoteProjectionSanitizer } from "../core/remote/iroh/sanitizer.ts";
import {
	type IrohRemoteSessionContextsRpcBackend,
	isIrohRemoteSessionContextsAnswer,
} from "../core/remote/iroh/session-contexts.ts";
import type { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import type { IrohRemoteWorktreeRpcBackend } from "../core/remote/iroh/worktree-rpc.ts";
import type { ReviewDiscussionService } from "../core/review-discussions.ts";
import { getReviewDiscussionLink } from "../core/review-discussions.ts";
import type { RpcKeepAwakeStatus } from "../core/rpc/types.ts";
import { getDefaultSessionDir, SessionManager } from "../core/session-manager.ts";
import type { KeepAwakeStatus } from "./keep-awake.ts";
import type { LeaseState } from "./lease-broker.ts";
import { listWorkspaceDirectories } from "./workspace-directory.ts";
import { getRegisteredWorkingDirectoryForWorktree, getWorktreesRoot } from "./worktree-manager.ts";

type SessionListItem = Static<typeof RpcSessionListItemSchema>;
type SessionWorkContext = Static<typeof RpcSessionWorkContextSchema>;
export type RemoteSessionRuntimeState = Exclude<LeaseState, "unowned">;

/** Longest session title a device is sent, in Unicode scalars. */
const SESSION_TITLE_MAX_SCALARS = 160;

/** The daemon's backends the remote services call. */
export interface RemoteIntentHost {
	readonly agentDir: string;
	readonly auditLogger: IrohRemoteAuditLogger;
	readonly stateManager: IrohRemoteHostStateManager;
	readonly keepAwake?: IntentKeepAwakeService;
	readonly webSearchKey?: IntentWebSearchKeyService;
	/** The theme the daemon shares with devices, when it shares one. */
	hostTheme?(): IntentHostTheme | undefined;
	pushTargets(authorization: IrohRemoteClientAuthorizationSuccess): IntentPushTargetService;
	worktrees(authorization: IrohRemoteClientAuthorizationSuccess): IrohRemoteWorktreeRpcBackend;
	agentOptions(authorization: IrohRemoteClientAuthorizationSuccess): IrohRemoteAgentOptionsRpcBackend;
	sessionContexts(authorization: IrohRemoteClientAuthorizationSuccess): IrohRemoteSessionContextsRpcBackend;
	prReviews(authorization: IrohRemoteClientAuthorizationSuccess, signal?: AbortSignal): IrohRemotePrReviewRpcBackend;
	/** Which host process serves each live session of a workspace. */
	listRuntimeStates?(workspaceName: string): ReadonlyMap<string, RemoteSessionRuntimeState>;
	/** The daemon's change and pull request association of a session. */
	getWorkContext?(
		workspaceName: string,
		workspaceGeneration: number,
		sessionId: string,
	): SessionWorkContext | undefined;
	/**
	 * Unregister the workspace and retire its streams, runtimes, and relays,
	 * except what `keep` names: the requesting stream, so it is still answered.
	 * Failures throw {@link WorkspaceIntentError}.
	 */
	unregisterWorkspace(
		workspaceName: string,
		keep: RemoteStreamKeep,
	): Promise<{ closedStreamCount: number; stoppedRuntimeCount: number }>;
}

/** What a workspace unregister leaves running so the request is answered. */
export interface RemoteStreamKeep {
	/** The requesting stream's id. */
	readonly streamId?: string;
	/** The requesting conversation's runtime, by session id. */
	readonly sessionId?: string;
	/** The requesting relays, for a stream a TUI serves. */
	readonly relayIds?: ReadonlySet<string>;
}

/** The kind of stream a device opened: a conversation, or one workspace purpose. */
export type RemoteStreamScope =
	| {
			readonly kind: "conversation";
			readonly conversation: HostedConversation;
			readonly reviewDiscussions?: ReviewDiscussionService;
	  }
	/** Frames a TUI relays for a phone on the TUI's session `sessionId`. */
	| { readonly kind: "relay"; readonly sessionId: string }
	| { readonly kind: "discovery"; readonly purpose: IrohRemoteWorkspaceDiscoveryTarget["purpose"] }
	| { readonly kind: "management"; readonly purpose: IrohRemoteWorkspaceManagementTarget["purpose"] };

/** The intents and queries each workspace stream purpose serves. */
const PURPOSE_FRAMES: Readonly<Record<string, { intents: readonly string[]; queries: readonly string[] }>> = {
	list_sessions: { intents: [], queries: ["sessions"] },
	agent_options: { intents: [], queries: ["agent_options"] },
	session_contexts: { intents: [], queries: ["session_contexts"] },
	review: { intents: [], queries: ["pr_review"] },
	unregister_workspace: { intents: ["unregister_workspace"], queries: [] },
	list_workspace_directories: { intents: [], queries: ["workspace_directories"] },
	manage_worktrees: { intents: ["create_worktree", "remove_worktree", "prepare_pr_review"], queries: ["worktrees"] },
};

/** Which intents and queries a stream serves; every remote-safe one on a conversation stream. */
export function remoteStreamAllows(
	scope: RemoteStreamScope,
): ((kind: "intent" | "query", name: string) => boolean) | undefined {
	if (scope.kind === "conversation" || scope.kind === "relay") return undefined;
	const frames = PURPOSE_FRAMES[scope.purpose];
	return (kind, name) => (kind === "intent" ? frames?.intents : frames?.queries)?.includes(name) === true;
}

function truncateScalars(value: string, limit: number): string {
	if (value.length <= limit) return value;
	const scalars = Array.from(value);
	return scalars.length <= limit ? value : scalars.slice(0, limit).join("");
}

/** A session's work context with only the fields a device may see. */
function projectWorkContext(workContext: SessionWorkContext): SessionWorkContext {
	const base = { changeId: workContext.changeId, repository: workContext.repository, branch: workContext.branch };
	if (workContext.resolutionState !== "resolved") return { ...base, resolutionState: workContext.resolutionState };
	const { provider, number, title, status, stale } = workContext.pullRequest;
	return { ...base, resolutionState: "resolved", pullRequest: { provider, number, title, status, stale } };
}

/** A worktree summary with only the fields a device may see: never a path. */
function worktreeSummary(worktree: IrohRemoteWorktreeSummary): IrohRemoteWorktreeSummary {
	return {
		id: worktree.id,
		branch: worktree.branch,
		...(worktree.baseRef === undefined ? {} : { baseRef: worktree.baseRef }),
		createdAt: worktree.createdAt,
		sessionIds: [...worktree.sessionIds],
		...(worktree.available === undefined ? {} : { available: worktree.available }),
		...(worktree.dirty === undefined ? {} : { dirty: worktree.dirty }),
		...(worktree.aheadBehind === undefined
			? {}
			: { aheadBehind: { ahead: worktree.aheadBehind.ahead, behind: worktree.aheadBehind.behind } }),
	};
}

function pullRequestSummary(pullRequest: PrReviewPullRequest): PrReviewPullRequest {
	return {
		provider: pullRequest.provider,
		url: pullRequest.url,
		number: pullRequest.number,
		title: pullRequest.title,
		repository: pullRequest.repository,
		headRefName: pullRequest.headRefName,
		headRefOid: pullRequest.headRefOid,
	};
}

const RESOLVE_RESPONSE = Compile(RpcResolvePrReviewResponseSchema);
const PREPARE_RESPONSE = Compile(RpcPreparePrReviewResponseSchema);

/** A review preparation failure as its stable code: backend diagnostics, git output, and paths stay on the host. */
function reviewFailure(error: unknown): WorkspaceIntentError {
	return new WorkspaceIntentError(
		error instanceof PrReviewPreparationError ? error.code : "review_preparation_failed",
	);
}

async function logAudit(
	auditLogger: IrohRemoteAuditLogger,
	event: Parameters<IrohRemoteAuditLogger["log"]>[0],
): Promise<void> {
	try {
		await auditLogger.log(event);
	} catch {
		// Audit logging is best-effort and never changes the outcome.
	}
}

/** A session's working directory relative to `root`: undefined at the root, null outside it. */
function relativeWorkingDirectory(root: string, cwd: string | undefined): string | null | undefined {
	if (!cwd) return undefined;
	const path = relative(resolve(root), resolve(cwd));
	if (path === "" || path === ".") return undefined;
	if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
	return path.split(sep).join("/");
}

function timestamp(value: string | Date): string {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/**
 * The sessions of the stream's workspace, newest first: its stored sessions,
 * the live summary of the stream's conversation, the worktree each is bound
 * to, which host process serves it, and the daemon's work association.
 */
export async function listRemoteWorkspaceSessions(
	host: Pick<RemoteIntentHost, "agentDir" | "stateManager" | "listRuntimeStates" | "getWorkContext">,
	authorization: IrohRemoteClientAuthorizationSuccess,
	current?: HostedConversation | string,
): Promise<SessionListItem[]> {
	const conversation = typeof current === "string" ? undefined : current;
	const currentId = typeof current === "string" ? current : current?.id;
	const workspace = authorization.workspace;
	// Titles are redacted before they are cut, so a cut never leaves part of a root.
	const titles = createIrohRemoteProjectionSanitizer({
		workspacePath: workspace.path,
		additionalRedactedPaths: [getWorktreesRoot(host.agentDir)],
	});
	const title = (text: string): string => truncateScalars(titles.sanitizeText(text), SESSION_TITLE_MAX_SCALARS);
	const sessions = new Map<string, { item: SessionListItem; cwd?: string }>();
	const add = (
		item: Omit<SessionListItem, "workingDirectory" | "firstMessage" | "sessionName"> & {
			firstMessage: string;
			sessionName?: string;
		},
		cwd: string | undefined,
	): void => {
		const workingDirectory = relativeWorkingDirectory(workspace.path, cwd);
		sessions.set(item.sessionId, {
			item: {
				...item,
				firstMessage: title(item.firstMessage),
				...(item.sessionName === undefined ? {} : { sessionName: title(item.sessionName) }),
				...(typeof workingDirectory === "string" ? { workingDirectory } : {}),
			},
			...(cwd === undefined ? {} : { cwd }),
		});
	};
	for (const info of await SessionManager.list(workspace.path, getDefaultSessionDir(workspace.path, host.agentDir))) {
		const reviewDiscussion = await getReviewDiscussionLink(info.ref);
		add(
			{
				sessionId: info.id,
				...(reviewDiscussion ? { reviewDiscussion } : {}),
				...(info.name === undefined ? {} : { sessionName: info.name }),
				createdAt: timestamp(info.created),
				modifiedAt: timestamp(info.modified),
				messageCount: info.messageCount,
				firstMessage: info.firstMessage,
				current: info.id === currentId,
				...(info.origin === undefined ? {} : { origin: info.origin }),
				...(info.startingGitContext === undefined ? {} : { startingGitContext: info.startingGitContext }),
			},
			info.cwd,
		);
	}
	if (conversation) {
		const live = conversation.summary();
		add(
			{
				sessionId: live.sessionId,
				...(live.reviewDiscussion ? { reviewDiscussion: live.reviewDiscussion } : {}),
				...(live.sessionName === undefined ? {} : { sessionName: live.sessionName }),
				createdAt: timestamp(live.createdAt),
				modifiedAt: timestamp(live.modifiedAt),
				messageCount: live.messageCount,
				firstMessage: live.firstMessage,
				current: true,
				...(live.origin === undefined ? {} : { origin: live.origin }),
				...(live.startingGitContext === undefined ? {} : { startingGitContext: live.startingGitContext }),
			},
			live.cwd,
		);
	}
	try {
		for (const worktree of await host.stateManager.listWorktrees(workspace.name)) {
			for (const sessionId of worktree.sessionIds) {
				const session = sessions.get(sessionId);
				if (!session) continue;
				session.item.worktreeId = worktree.id;
				const inWorktree = relativeWorkingDirectory(worktree.path, session.cwd);
				const workingDirectory =
					inWorktree === null ? undefined : getRegisteredWorkingDirectoryForWorktree(worktree, inWorktree);
				if (workingDirectory === undefined) delete session.item.workingDirectory;
				else session.item.workingDirectory = workingDirectory;
			}
		}
	} catch {
		// Worktree attribution is best-effort; the session list stays authoritative.
	}
	try {
		for (const [sessionId, runtimeState] of host.listRuntimeStates?.(workspace.name) ?? []) {
			const session = sessions.get(sessionId);
			if (session) session.item.runtimeState = runtimeState;
		}
	} catch {
		// Runtime presence is best-effort.
	}
	if (authorization.workspaceGeneration !== undefined && host.getWorkContext) {
		for (const { item } of sessions.values()) {
			const workContext = host.getWorkContext(workspace.name, authorization.workspaceGeneration, item.sessionId);
			if (workContext) item.workContext = projectWorkContext(workContext);
		}
	}
	return [...sessions.values()]
		.map(({ item }) => item)
		.sort(
			(left, right) =>
				Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt) || left.sessionId.localeCompare(right.sessionId),
		);
}

export interface RemoteIntentServicesOptions {
	/** The requesting stream, kept by a workspace unregister until it is answered. */
	readonly keep: RemoteStreamKeep;
	/** The stream ends while a preparation runs: its effects stop. */
	readonly signal?: AbortSignal;
	/**
	 * The device unregisters its own workspace: `begin` before the registry
	 * changes, so its stream is answered; `end` once it finished, when a
	 * successful unregister ends the stream after its answer.
	 */
	readonly workspaceUnregister?: { begin(): void; end(succeeded: boolean): void };
}

/** The daemon's services for one device stream. */
export function remoteIntentServices(
	host: RemoteIntentHost,
	authorization: IrohRemoteClientAuthorizationSuccess,
	scope: RemoteStreamScope,
	options: RemoteIntentServicesOptions,
): IntentServices {
	const workspaceName = authorization.workspace.name;
	const audit = (event: Omit<Parameters<IrohRemoteAuditLogger["log"]>[0], "clientNodeId" | "workspace">) =>
		logAudit(host.auditLogger, { ...event, clientNodeId: authorization.client.nodeId, workspace: workspaceName });
	const source =
		scope.kind === "conversation" || scope.kind === "relay" ? "remote_rpc" : `remote_workspace_${scope.kind}_stream`;

	const worktrees = (): IrohRemoteWorktreeRpcBackend => host.worktrees(authorization);
	const createWorktree: IntentWorkspaceServices["createWorktree"] = async (createOptions) => {
		const created = await worktrees().createWorktree(workspaceName, createOptions);
		if (!created.ok) {
			await audit({ type: "worktree_created", success: false, error: created.error, details: { source } });
			throw new WorkspaceIntentError(created.error);
		}
		await audit({
			type: "worktree_created",
			success: true,
			details: { worktreeId: created.worktree.id, branch: created.worktree.branch, source },
		});
		return worktreeSummary(created.worktree);
	};
	const listWorktrees: IntentWorkspaceServices["listWorktrees"] = async () => {
		const listed = await worktrees().listWorktrees(workspaceName);
		if (!listed.ok) throw new WorkspaceIntentError(listed.error);
		return listed.worktrees.map(worktreeSummary);
	};
	const removeWorktree: IntentWorkspaceServices["removeWorktree"] = async (worktreeId, force) => {
		const removed = await worktrees().removeWorktree(workspaceName, worktreeId, force);
		await audit({
			type: "worktree_removed",
			success: removed.ok,
			...(removed.ok ? {} : { error: removed.error }),
			details: {
				worktreeId,
				force,
				...(removed.ok ? { stoppedRuntimeCount: removed.stoppedRuntimeCount } : {}),
				source,
			},
		});
		if (!removed.ok) throw new WorkspaceIntentError(removed.error);
		return { stoppedRuntimeCount: removed.stoppedRuntimeCount, closedStreamCount: removed.closedStreamCount };
	};
	const unregister: IntentWorkspaceServices["unregister"] = async () => {
		options.workspaceUnregister?.begin();
		try {
			const result = await host.unregisterWorkspace(workspaceName, options.keep);
			await audit({
				type: "workspace_unregistered",
				success: true,
				details: { ...result, source },
			});
		} catch (error) {
			// The device sees a stable code; the host's audit keeps what failed.
			const failure =
				error instanceof WorkspaceIntentError ? error : new WorkspaceIntentError("workspace_unregister_failed");
			await audit({
				type: "workspace_unregistered",
				success: false,
				error: error instanceof WorkspaceIntentError ? failure.error : String(error),
				details: { source, ...(failure.details ?? {}) },
			});
			options.workspaceUnregister?.end(false);
			throw failure;
		}
		options.workspaceUnregister?.end(true);
	};
	const uploadDeviceLogs: IntentWorkspaceServices["uploadDeviceLogs"] = async (upload) => {
		try {
			const uploaded = await uploadIrohRemoteDeviceLog(upload, { workspacePath: authorization.workspace.path });
			await audit({
				type: "device_log_uploaded",
				success: true,
				details: { path: uploaded.path, byteCount: uploaded.byteCount },
			});
			return uploaded;
		} catch (error) {
			await audit({
				type: "device_log_uploaded",
				success: false,
				error: error instanceof WorkspaceIntentError ? error.error : String(error),
			});
			throw error;
		}
	};
	const current =
		scope.kind === "conversation" ? scope.conversation : scope.kind === "relay" ? scope.sessionId : undefined;
	const listSessions: IntentWorkspaceServices["listSessions"] = () =>
		listRemoteWorkspaceSessions(host, authorization, current);
	const resolvePrReview: IntentWorkspaceServices["resolvePrReview"] = async (request: PrReviewSourceRequest) => {
		let resolved: PrReviewResolveResponse;
		try {
			resolved = await host.prReviews(authorization, options.signal).resolvePrReview(workspaceName, request);
		} catch (error) {
			throw reviewFailure(error);
		}
		const answer: PrReviewResolveResponse = {
			workspaceName: resolved.workspaceName,
			pullRequest: pullRequestSummary(resolved.pullRequest),
		};
		if (
			!RESOLVE_RESPONSE.Check(answer) ||
			answer.workspaceName !== workspaceName ||
			(request.number !== undefined && answer.pullRequest.number !== Number(request.number))
		) {
			throw new WorkspaceIntentError("review_preparation_failed");
		}
		return answer;
	};
	const preparePrReview: IntentWorkspaceServices["preparePrReview"] = async (request: PrReviewPrepareRequest) => {
		let prepared: PrReviewPrepareResponse;
		try {
			prepared = await host.prReviews(authorization, options.signal).preparePrReview(workspaceName, request);
		} catch (error) {
			throw reviewFailure(error);
		}
		const answer: PrReviewPrepareResponse = {
			workspaceName: prepared.workspaceName,
			sessionId: prepared.sessionId,
			worktreeId: prepared.worktreeId,
			...(prepared.workingDirectory === undefined ? {} : { workingDirectory: prepared.workingDirectory }),
			pullRequest: pullRequestSummary(prepared.pullRequest),
			disposition: prepared.disposition,
		};
		if (
			!PREPARE_RESPONSE.Check(answer) ||
			(answer.workingDirectory !== undefined && !isIrohRemoteWorkingDirectory(answer.workingDirectory)) ||
			answer.workspaceName !== workspaceName ||
			answer.sessionId !== request.sessionId ||
			answer.pullRequest.url !== request.expectedPullRequest.url ||
			answer.pullRequest.headRefOid !== request.expectedPullRequest.headRefOid ||
			(request.number !== undefined && answer.pullRequest.number !== Number(request.number))
		) {
			throw new WorkspaceIntentError("review_preparation_failed");
		}
		return answer;
	};
	const listDirectories: IntentWorkspaceServices["listDirectories"] = async (path) => {
		const listed = await listWorkspaceDirectories(authorization.workspace.path, path);
		if (!listed.ok) throw new WorkspaceIntentError(listed.error);
		return {
			...(listed.currentPath === undefined ? {} : { path: listed.currentPath }),
			directories: listed.directories,
		};
	};

	const hostServices = {
		...(host.keepAwake === undefined ? {} : { keepAwake: host.keepAwake }),
		...(host.webSearchKey === undefined ? {} : { webSearchKey: host.webSearchKey }),
		...(host.hostTheme === undefined ? {} : { hostTheme: () => host.hostTheme?.() }),
	};
	switch (scope.kind) {
		case "conversation":
		case "relay":
			return {
				...hostServices,
				pushTargets: host.pushTargets(authorization),
				...(scope.kind === "conversation" && scope.reviewDiscussions !== undefined
					? { reviewDiscussions: scope.reviewDiscussions }
					: {}),
				workspace: {
					name: workspaceName,
					unregister,
					createWorktree,
					listWorktrees,
					uploadDeviceLogs,
					listSessions,
				},
			};
		case "discovery":
			return {
				workspace: {
					name: workspaceName,
					listSessions,
					agentOptions: () => host.agentOptions(authorization).getAgentOptions(workspaceName),
					sessionContexts: async (sessionIds) => {
						const contexts = await host
							.sessionContexts(authorization)
							.getSessionContexts(workspaceName, sessionIds);
						if (!isIrohRemoteSessionContextsAnswer(sessionIds, contexts)) {
							throw new WorkspaceIntentError("request_failed");
						}
						return contexts;
					},
					resolvePrReview,
				},
			};
		case "management":
			return {
				workspace: {
					name: workspaceName,
					unregister,
					listDirectories,
					createWorktree,
					listWorktrees,
					removeWorktree,
					preparePrReview,
				},
			};
	}
}

/** Intents that start or replace conversation work. */
const WORK_INTENTS: ReadonlySet<string> = new Set([
	"prompt",
	"steer",
	"follow_up",
	"bash",
	"compact",
	"new_session",
	"switch_session",
	"fork",
	"clone",
	"plan_execute",
	"review_uncommitted",
	"review_branch",
	"review_pr",
	"review_commit",
	"review_rerun",
	"review_open_session",
	"review_start_discussions",
	"review_reset_discussion",
]);

/** What an observer of a subagent conversation may still do: stop it. */
const OBSERVER_INTENTS: ReadonlySet<string> = new Set(["abort", "abort_retry", "abort_bash"]);

const DYNAMIC_INTENT = new RegExp(DYNAMIC_INTENT_PATTERN);

/** Retry hint while a conversation hands off to a desktop TUI. */
export const LEASE_DRAINING_RETRY_AFTER_MS = 1000;

/** The daemon's own admission of a device's intent on a conversation it hosts. */
export function admitRemoteIntent(
	intent: string,
	state: { readonly shuttingDown: boolean; readonly draining: boolean; readonly subagent: boolean },
): RejectionReason | undefined {
	// The phone hides the composer for subagent tabs; a stray client must not inject turns into a delegated run.
	if (state.subagent && !OBSERVER_INTENTS.has(intent)) {
		return { code: "read_only", message: "Subagent sessions are observe-only; prompt the parent agent instead." };
	}
	if (!WORK_INTENTS.has(intent) && !DYNAMIC_INTENT.test(intent)) return undefined;
	if (state.shuttingDown) {
		return { code: "host_shutdown", message: "The host is shutting down; reconnect after it restarts." };
	}
	if (state.draining) {
		return {
			code: "busy",
			message: "Handing off to the desktop TUI; retry shortly.",
			retryAfterMs: LEASE_DRAINING_RETRY_AFTER_MS,
		};
	}
	return undefined;
}

/** The keep-awake state a device sees: never the host mechanism. */
export function toRemoteKeepAwakeStatus(status: KeepAwakeStatus): RpcKeepAwakeStatus {
	return {
		enabled: status.enabled,
		state: status.state,
		...(status.reason === undefined ? {} : { reason: status.reason }),
	};
}
