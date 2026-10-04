/**
 * The Iroh remote host commands over the intent and query registries, until
 * the protocol server serves intent frames: each daemon backend the legacy
 * command handlers call is wrapped so the call becomes an intent or query on
 * the client's remote profile, with the real backend as the intent's
 * workspace service. The handlers keep their wire validation and responses.
 */

import type { PrReviewPrepareRequest, PrReviewSourceRequest, RemoteGrant } from "@hansjm10/volt-protocol";
import {
	type IntentContext,
	type IntentProfile,
	IntentRejectedError,
	type IntentWorkspaceServices,
	intentRegistry,
	WorkspaceIntentError,
} from "../core/protocol/intents/index.ts";
import { QueryRejectedError, queryRegistry } from "../core/protocol/queries/index.ts";
import { parseIrohRemoteRpcGrant } from "../core/remote/iroh/access-grant.ts";
import type { IrohRemoteAgentOptionsRpcBackend } from "../core/remote/iroh/agent-options.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import type { IrohRemotePrReviewRpcBackend } from "../core/remote/iroh/pr-review-rpc.ts";
import type { IrohRemoteSessionContextsRpcBackend } from "../core/remote/iroh/session-contexts.ts";
import type { IrohRemoteWorktreeRpcBackend } from "../core/remote/iroh/worktree-rpc.ts";

/**
 * The remote profile of a paired client: its intents and queries run within
 * its grant. A malformed stored grant throws; callers reach here only after
 * the stream admitted the client under that grant.
 */
export function remoteIntentProfile(authorization: IrohRemoteClientAuthorizationSuccess): IntentProfile {
	const grant: RemoteGrant = parseIrohRemoteRpcGrant(authorization.client.rpcGrant, "client rpcGrant");
	return { name: "remote", grant };
}

function workspaceContext(
	authorization: IrohRemoteClientAuthorizationSuccess,
	workspace: Omit<IntentWorkspaceServices, "name">,
): IntentContext {
	return {
		services: { workspace: { name: authorization.workspace.name, ...workspace } },
		profile: remoteIntentProfile(authorization),
	};
}

/** A failed worktree operation as the backend reports it; anything else propagates as it always did. */
function worktreeFailure(error: unknown): { ok: false; error: string } {
	if (error instanceof WorkspaceIntentError) return { ok: false, error: error.error };
	if (error instanceof IntentRejectedError || error instanceof QueryRejectedError) {
		return { ok: false, error: "invalid_request" };
	}
	throw error;
}

/** Worktree commands as `create_worktree`, `remove_worktree`, and the `worktrees` query. */
export function intentWorktreeBackend(
	backend: IrohRemoteWorktreeRpcBackend,
	authorization: IrohRemoteClientAuthorizationSuccess,
): IrohRemoteWorktreeRpcBackend {
	return {
		createWorktree: async (workspaceName, options) => {
			const ctx = workspaceContext(authorization, {
				createWorktree: async (createOptions) => {
					const created = await backend.createWorktree(workspaceName, createOptions);
					if (!created.ok) throw new WorkspaceIntentError(created.error);
					return created.worktree;
				},
			});
			try {
				const { outcome } = await intentRegistry.invoke(ctx, "create_worktree", {
					...(options.id === undefined ? {} : { worktreeName: options.id }),
					...(options.branch === undefined ? {} : { branch: options.branch }),
					...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
					...(options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory }),
				});
				return { ok: true, worktree: outcome.worktree };
			} catch (error) {
				return worktreeFailure(error);
			}
		},
		listWorktrees: async (workspaceName) => {
			const ctx = workspaceContext(authorization, {
				listWorktrees: async () => {
					const listed = await backend.listWorktrees(workspaceName);
					if (!listed.ok) throw new WorkspaceIntentError(listed.error);
					return listed.worktrees;
				},
			});
			try {
				return { ok: true, worktrees: (await queryRegistry.run(ctx, "worktrees", {})).worktrees };
			} catch (error) {
				return worktreeFailure(error);
			}
		},
		removeWorktree: async (workspaceName, worktreeId, force) => {
			const ctx = workspaceContext(authorization, {
				removeWorktree: async (id, forced) => {
					const removed = await backend.removeWorktree(workspaceName, id, forced);
					if (!removed.ok) throw new WorkspaceIntentError(removed.error);
					return {
						stoppedRuntimeCount: removed.stoppedRuntimeCount,
						closedStreamCount: removed.closedStreamCount,
					};
				},
			});
			try {
				const { outcome } = await intentRegistry.invoke(ctx, "remove_worktree", { worktreeId, force });
				return {
					ok: true,
					stoppedRuntimeCount: outcome.stoppedRuntimeCount,
					closedStreamCount: outcome.closedStreamCount,
				};
			} catch (error) {
				return worktreeFailure(error);
			}
		},
	};
}

/** `get_agent_options` as the `agent_options` query. */
export function intentAgentOptionsBackend(
	backend: IrohRemoteAgentOptionsRpcBackend,
	authorization: IrohRemoteClientAuthorizationSuccess,
): IrohRemoteAgentOptionsRpcBackend {
	return {
		getAgentOptions: (workspaceName) =>
			queryRegistry.run(
				workspaceContext(authorization, { agentOptions: () => backend.getAgentOptions(workspaceName) }),
				"agent_options",
				{},
			),
	};
}

/** `get_session_contexts` as the `session_contexts` query. */
export function intentSessionContextsBackend(
	backend: IrohRemoteSessionContextsRpcBackend,
	authorization: IrohRemoteClientAuthorizationSuccess,
): IrohRemoteSessionContextsRpcBackend {
	return {
		getSessionContexts: async (workspaceName, sessionIds) => {
			const ctx = workspaceContext(authorization, {
				sessionContexts: (ids) => backend.getSessionContexts(workspaceName, ids),
			});
			return (await queryRegistry.run(ctx, "session_contexts", { sessionIds: [...sessionIds] })).contexts;
		},
	};
}

/** `resolve_pr_review` as the `pr_review` query and `prepare_pr_review` as its intent. */
export function intentPrReviewBackend(
	backend: IrohRemotePrReviewRpcBackend,
	authorization: IrohRemoteClientAuthorizationSuccess,
): IrohRemotePrReviewRpcBackend {
	return {
		resolvePrReview: (workspaceName, request: PrReviewSourceRequest) =>
			queryRegistry.run(
				workspaceContext(authorization, {
					resolvePrReview: (source) => backend.resolvePrReview(workspaceName, source),
				}),
				"pr_review",
				request,
			),
		preparePrReview: async (workspaceName, request: PrReviewPrepareRequest) => {
			const ctx = workspaceContext(authorization, {
				preparePrReview: (prepare) => backend.preparePrReview(workspaceName, prepare),
			});
			return (await intentRegistry.invoke(ctx, "prepare_pr_review", request)).outcome;
		},
	};
}
