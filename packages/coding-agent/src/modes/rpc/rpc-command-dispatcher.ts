/**
 * The legacy RPC command wire over the intent and query registries. Every
 * command that is an intent or a query runs through the registry, which owns
 * admission and the behavior; this module keeps only each command's wire
 * shape. Commands the protocol derives from the subscription (state,
 * transcript, tree, messages) or the connection (capabilities, recovery) stay
 * here until the protocol server replaces the wire.
 */

import { type IntentInput, type RemoteGrant, RPC_STABLE_ERROR_CODES } from "@hansjm10/volt-protocol";
import type { AgentSession } from "../../core/agent-session.ts";
import type { SessionIntentResult } from "../../core/extensions/index.ts";
import type { ConversationHost } from "../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import type { HostClient } from "../../core/host/targets.ts";
import {
	type IntentContext,
	type IntentServices,
	intentRegistry,
	LOCAL_INTENT_PROFILE,
} from "../../core/protocol/intents/index.ts";
import { queryRegistry } from "../../core/protocol/queries/index.ts";
import { toIrohRemoteAgentOptionsCatalogModel } from "../../core/remote/iroh/agent-options.ts";
import { assertReviewDiscussionRpcAllowed } from "../../core/review-discussion-policy.ts";
import { listRpcBackgroundJobs } from "../../core/rpc/background-jobs.ts";
import { getRpcErrorResponseTarget, isUsableRpcConversationIdentifier } from "../../core/rpc/correlation.ts";
import { buildRpcSessionState } from "../../core/rpc/session-state.ts";
import { projectSessionTreePage } from "../../core/rpc/session-tree.ts";
import { resolveSessionToolCallsByResultEntryId } from "../../core/rpc/tool-call-resolution.ts";
import {
	projectConversationTranscriptEntry,
	projectMessageImages,
	projectSessionTranscript,
} from "../../core/rpc/transcript.ts";
import {
	getUiActionCompletions,
	getUiActionDescriptors,
	prepareUiActionInvocation,
} from "../../core/rpc/ui-actions.ts";
import type {
	RpcClientCapabilityFeature,
	RpcCommand,
	RpcHostActionRequest,
	RpcListSubagentsResponse,
	RpcPendingHostActionsResponse,
	RpcResponse,
	RpcSessionIntentResponse,
	RpcSessionState,
	RpcSessionTreePage,
	RpcSlashCommand,
	RpcSubagentStartResponse,
	RpcTranscriptResponse,
	UiActionCapabilities,
} from "./rpc-types.ts";

export const HOST_ACTION_REQUESTS_CAPABILITY: RpcClientCapabilityFeature = "host_action_requests.v1";

export interface RpcCommandDispatcherOptions {
	allowUiActionInvocation: boolean;
	/** A paired device's grant: commands run on the remote profile, limited to remote-safe intents within it. */
	remoteGrant?: RemoteGrant;
}

export interface RpcSubagentLifecycleController {
	list(): RpcListSubagentsResponse;
	start(agent: string, prompt: string): Promise<RpcSubagentStartResponse>;
	abort(subagentId: string): Promise<void>;
	getState(subagentId: string): Promise<RpcSessionState>;
	getTranscript(options: {
		subagentId: string;
		limit?: number;
		beforeEntryId?: string;
	}): Promise<RpcTranscriptResponse>;
	dispose(subagentId: string): Promise<void>;
	disposeAll(): Promise<void>;
}

export interface RpcCommandDispatcherContext {
	/** The session of `conversation`, the conversation the client was on when the command was dispatched. */
	session: AgentSession;
	conversation: HostedConversation;
	/** The client's host and the client itself, whose structural intents move it. */
	host: ConversationHost;
	client: HostClient;
	options: RpcCommandDispatcherOptions;
	/** What this host gives intents beyond the conversation. */
	services: IntentServices;
	output(response: RpcResponse): void;
	setClientCapabilities(features: RpcClientCapabilityFeature[]): void;
	reportStreamDiscontinuity(
		command: Extract<RpcCommand, { type: "report_stream_discontinuity" }>,
	): Promise<{ subscriptionId: string; requestId: string; checkpointCursor: number }>;
	getPendingHostActionRequests(): RpcHostActionRequest[];
	/** Captured at dispatch for generation-scoped Jobs responses on ordered transports. */
	conversationBranchEpoch?: string;
	/** Revalidate the mutation lease after an awaited dispatcher/session preflight boundary. */
	assertConversationGenerationCurrent(): void;
	/**
	 * Claim the deferred launch of a review workflow registered by this
	 * invocation. The dispatcher launches it only after the accepted response is
	 * enqueued, so the response precedes workflow_start on the shared lane.
	 */
	takePendingReviewWorkflow?(workflowId: string): { launch: () => void; cancel: () => void } | undefined;
	subagents: RpcSubagentLifecycleController;
}

function getUiActionCapabilities(invocationEnabled: boolean): UiActionCapabilities {
	return {
		protocolVersion: 1,
		features: invocationEnabled
			? ["ui_actions.v1", "ui_action_invocation.v1", "ui_action_completions.v1"]
			: ["ui_actions.v1", "ui_action_completions.v1"],
		maxActions: 200,
		maxDescriptorBytes: 65_536,
	};
}

export function createRpcSuccessResponse<T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse {
	if (command === "invoke_ui_action" && !isUsableRpcConversationIdentifier(id)) {
		throw new Error("invoke_ui_action success responses require a usable correlation id");
	}
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

const STABLE_RPC_ERROR_CODES: ReadonlySet<string> = new Set(RPC_STABLE_ERROR_CODES);

function getStableRpcErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") {
		return undefined;
	}
	return STABLE_RPC_ERROR_CODES.has(error.code) ? error.code : undefined;
}

export function createRpcErrorResponse(
	id: string | undefined,
	command: string,
	message: string,
	error?: unknown,
): RpcResponse {
	const errorCode = getStableRpcErrorCode(error);
	const target = getRpcErrorResponseTarget({ id, type: command });
	return {
		...(target.id === undefined ? {} : { id: target.id }),
		type: "response",
		command: target.command,
		success: false,
		error: message,
		...(errorCode === undefined ? {} : { errorCode }),
	};
}

export { getRpcErrorResponseTarget };

/** A structural intent's response data: cancelled, or the id of the session the client moved to. */
function projectSessionIntent(result: SessionIntentResult): RpcSessionIntentResponse {
	return result.cancelled ? { cancelled: true } : { cancelled: false, sessionId: result.sessionId };
}

/** The intent context a command runs in: its conversation, this host's services, and the client's profile. */
export function createRpcIntentContext(context: RpcCommandDispatcherContext): IntentContext {
	const { remoteGrant } = context.options;
	return {
		target: {
			session: context.session,
			conversation: context.conversation,
			host: context.host,
			client: context.client,
		},
		services: context.services,
		profile: remoteGrant === undefined ? LOCAL_INTENT_PROFILE : { name: "remote", grant: remoteGrant },
		assertCurrent: () => context.assertConversationGenerationCurrent(),
	};
}

/** Answer a command once its admitted run settles, without holding the command lane until then. */
function respondWhenSettled(
	context: RpcCommandDispatcherContext,
	id: string | undefined,
	command: RpcCommand["type"],
	run: () => Promise<object | undefined>,
): undefined {
	void run().then(
		(data) => context.output(createRpcSuccessResponse(id, command, data)),
		(error: unknown) =>
			context.output(
				createRpcErrorResponse(id, command, error instanceof Error ? error.message : String(error), error),
			),
	);
	return undefined;
}

/** Commands that answer a failure as an error response rather than throwing it to the caller. */
const ANSWERED_FAILURE_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set([
	"prompt",
	"new_session",
	"start_review_discussions",
	"list_review_discussions",
	"reset_review_discussion",
	"get_review_discussion_source",
	"get_review_result",
	"open_review_session",
	"record_review_finding_outcome",
	"rerun_review",
	"publish_review",
	"register_push_target",
	"get_mcp_server",
	"connect_mcp_server",
	"refresh_mcp_server",
	"disconnect_mcp_server",
	"start_mcp_server_auth",
	"complete_mcp_server_auth",
	"poll_mcp_server_auth",
	"cancel_mcp_server_auth",
	"logout_mcp_server",
	"set_mcp_server_enabled",
	"list_mcp_tools",
	"get_mcp_tool",
	"list_mcp_resources",
	"read_mcp_resource",
	"list_mcp_prompts",
	"get_mcp_prompt",
	"set_model",
	"clone",
]);

export async function handleRpcCommand(
	command: RpcCommand,
	context: RpcCommandDispatcherContext,
): Promise<RpcResponse | undefined> {
	assertReviewDiscussionRpcAllowed(context.session, command);
	try {
		return await dispatchRpcCommand(command, context);
	} catch (error) {
		if (!ANSWERED_FAILURE_COMMANDS.has(command.type)) throw error;
		const id = typeof command.id === "string" ? command.id : undefined;
		return createRpcErrorResponse(id, command.type, error instanceof Error ? error.message : String(error), error);
	}
}

async function dispatchRpcCommand(
	command: RpcCommand,
	context: RpcCommandDispatcherContext,
): Promise<RpcResponse | undefined> {
	const { options, session } = context;
	const id = typeof command.id === "string" ? command.id : undefined;
	const intents = createRpcIntentContext(context);

	switch (command.type) {
		// =================================================================
		// Prompting
		// =================================================================

		case "prompt": {
			// Admit now; answer once the prompt passes preflight, without blocking later commands.
			const prepared = intentRegistry.prepare({ ...intents, intentId: command.clientMessageId }, "prompt", {
				message: command.message,
				...(command.images === undefined ? {} : { images: command.images }),
				...(command.streamingBehavior === undefined ? {} : { streamingBehavior: command.streamingBehavior }),
			});
			return respondWhenSettled(context, id, "prompt", async () => (await prepared.run()).outcome);
		}

		case "steer":
		case "follow_up": {
			await intentRegistry.invoke({ ...intents, intentId: command.clientMessageId }, command.type, {
				message: command.message,
				...(command.images === undefined ? {} : { images: command.images }),
			});
			return createRpcSuccessResponse(id, command.type);
		}

		case "abort": {
			await intentRegistry.invoke(intents, "abort", {});
			return createRpcSuccessResponse(id, "abort");
		}

		case "new_session": {
			const { outcome } = await intentRegistry.invoke(intents, "new_session", {
				...(command.parentSessionId === undefined ? {} : { parentSessionId: command.parentSessionId }),
				...(command.preserveReviewRunId === undefined ? {} : { preserveReviewRunId: command.preserveReviewRunId }),
				...(command.replaceReviewGeneral === undefined
					? {}
					: { replaceReviewGeneral: command.replaceReviewGeneral }),
			});
			return createRpcSuccessResponse(id, "new_session", projectSessionIntent(outcome));
		}

		case "set_agent_mode": {
			const { outcome } = await intentRegistry.invoke(intents, "set_agent_mode", { mode: command.mode });
			return createRpcSuccessResponse(id, "set_agent_mode", outcome);
		}

		case "plan_execute": {
			const { outcome } = await intentRegistry.invoke(intents, "plan_execute", {
				planId: command.planId,
				expectedRevision: command.expectedRevision,
				strategy: command.strategy,
			});
			return createRpcSuccessResponse(id, "plan_execute", {
				planning: outcome.planning,
				selectedSessionId: outcome.selectedSessionId,
				started: outcome.started,
			});
		}

		case "plan_change":
		case "plan_discard": {
			const { outcome } = await intentRegistry.invoke(intents, command.type, {
				planId: command.planId,
				expectedRevision: command.expectedRevision,
			});
			return createRpcSuccessResponse(id, command.type, outcome);
		}

		// =================================================================
		// Client capabilities and host-initiated actions
		// =================================================================

		case "set_client_capabilities": {
			context.setClientCapabilities(command.features);
			return createRpcSuccessResponse(id, "set_client_capabilities");
		}

		case "get_pending_host_actions": {
			const data: RpcPendingHostActionsResponse = {
				actions: context.getPendingHostActionRequests(),
			};
			return createRpcSuccessResponse(id, "get_pending_host_actions", data);
		}

		case "report_stream_discontinuity": {
			const data = await context.reportStreamDiscontinuity(command);
			return createRpcSuccessResponse(id, "report_stream_discontinuity", data);
		}

		// =================================================================
		// Native UI Actions
		// =================================================================

		case "get_ui_capabilities": {
			return createRpcSuccessResponse(
				id,
				"get_ui_capabilities",
				getUiActionCapabilities(options.allowUiActionInvocation),
			);
		}

		case "get_ui_actions": {
			return createRpcSuccessResponse(id, "get_ui_actions", {
				actions: getUiActionDescriptors(session, command.scope, {
					remoteSafeOnly: intents.profile.name === "remote",
					detachedReviews: true,
				}),
			});
		}

		case "get_ui_action_completions": {
			return createRpcSuccessResponse(id, "get_ui_action_completions", {
				completions: await getUiActionCompletions(intents, {
					action: command.action,
					argument: command.argument,
					prefix: command.prefix,
				}),
			});
		}

		case "invoke_ui_action": {
			if (!options.allowUiActionInvocation) {
				return createRpcErrorResponse(
					id,
					"invoke_ui_action",
					"UI action invocation is not available over this RPC transport",
				);
			}
			const invocation = prepareUiActionInvocation(intents, {
				action: command.action,
				...(command.args === undefined ? {} : { args: command.args }),
				...(command.streamingBehavior === undefined ? {} : { streamingBehavior: command.streamingBehavior }),
			});
			if (invocation.prompt) {
				return respondWhenSettled(context, id, "invoke_ui_action", () => invocation.run());
			}
			const response = await invocation.run();
			const pendingReviewWorkflow =
				response.status === "accepted" && response.workflowId !== undefined
					? context.takePendingReviewWorkflow?.(response.workflowId)
					: undefined;
			if (pendingReviewWorkflow) {
				try {
					context.output(createRpcSuccessResponse(id, "invoke_ui_action", response));
				} finally {
					// The workflow must always launch once registered; an unlaunched
					// entry would pin the active set (and daemon retention) forever.
					pendingReviewWorkflow.launch();
				}
				return undefined;
			}
			return createRpcSuccessResponse(id, "invoke_ui_action", response);
		}

		// =================================================================
		// Detached review workflows
		// =================================================================

		case "start_review_discussions": {
			const { outcome } = await intentRegistry.invoke(intents, "review_start_discussions", {
				runId: command.runId,
				findingIds: command.findingIds,
				requestId: command.requestId,
				...(command.discussionConfiguration === undefined
					? {}
					: {
							discussionConfiguration:
								command.discussionConfiguration as IntentInput<"review_start_discussions">["discussionConfiguration"],
						}),
			});
			return createRpcSuccessResponse(id, command.type, outcome);
		}

		case "reset_review_discussion": {
			const { outcome } = await intentRegistry.invoke(intents, "review_reset_discussion", {
				discussionId: command.discussionId,
				expectedSessionId: command.expectedSessionId,
				requestId: command.requestId,
			});
			return createRpcSuccessResponse(id, command.type, outcome);
		}

		case "list_review_discussions": {
			const data = await queryRegistry.run(intents, "review.discussions", {
				runId: command.runId,
				...(command.cursor === undefined ? {} : { cursor: command.cursor }),
				...(command.limit === undefined ? {} : { limit: command.limit }),
			});
			return createRpcSuccessResponse(id, command.type, data);
		}

		case "get_review_discussion_source": {
			const { discussion } = await queryRegistry.run(intents, "review.discussion_source", {});
			return createRpcSuccessResponse(id, command.type, discussion);
		}

		case "cancel_workflow": {
			await intentRegistry.invoke(intents, "review_cancel_workflow", { workflowId: command.workflowId });
			return createRpcSuccessResponse(id, "cancel_workflow");
		}

		case "list_review_workflows": {
			const data = await queryRegistry.run(intents, "review.workflows", {
				...(command.cursor === undefined ? {} : { cursor: command.cursor }),
				...(command.limit === undefined ? {} : { limit: command.limit }),
			});
			return createRpcSuccessResponse(id, "list_review_workflows", data);
		}

		case "get_review_general": {
			return createRpcSuccessResponse(
				id,
				"get_review_general",
				await queryRegistry.run(intents, "review.general", { runId: command.runId }),
			);
		}

		case "get_review_result": {
			return createRpcSuccessResponse(
				id,
				"get_review_result",
				await queryRegistry.run(intents, "review.result", { runId: command.runId }),
			);
		}

		case "open_review_session": {
			const { outcome } = await intentRegistry.invoke(intents, "review_open_session", {
				runId: command.runId,
				...(command.findingIds === undefined ? {} : { findingIds: command.findingIds }),
			});
			return createRpcSuccessResponse(id, "open_review_session", projectSessionIntent(outcome.opened));
		}

		case "acknowledge_review": {
			const { outcome } = await intentRegistry.invoke(intents, "review_acknowledge", { runId: command.runId });
			return createRpcSuccessResponse(id, "acknowledge_review", outcome);
		}

		case "record_review_finding_outcome": {
			const { outcome } = await intentRegistry.invoke(intents, "review_record_finding_outcome", {
				runId: command.runId,
				findingId: command.findingId,
				status: command.status,
				...(command.reason === undefined ? {} : { reason: command.reason }),
				...(command.note === undefined ? {} : { note: command.note }),
			});
			return createRpcSuccessResponse(id, "record_review_finding_outcome", outcome);
		}

		case "rerun_review": {
			const { outcome } = await intentRegistry.invoke(intents, "review_rerun", {
				runId: command.runId,
				mode: command.mode ?? "incremental",
			});
			if (outcome.status !== "accepted") {
				return createRpcErrorResponse(id, "rerun_review", "Review rerun was not accepted");
			}
			const pending = context.takePendingReviewWorkflow?.(outcome.workflowId);
			if (!pending)
				return createRpcErrorResponse(id, "rerun_review", "The accepted review rerun was not registered.");
			try {
				context.output(
					createRpcSuccessResponse(id, "rerun_review", { status: "accepted", workflowId: outcome.workflowId }),
				);
			} finally {
				pending.launch();
			}
			return undefined;
		}

		case "publish_review": {
			const { outcome } = await intentRegistry.invoke(intents, "review_publish", {
				runId: command.runId,
				confirmed: true,
			});
			return createRpcSuccessResponse(id, "publish_review", outcome);
		}

		case "export_review_feedback": {
			const { outcome } = await intentRegistry.invoke(intents, "review_export_feedback", {});
			return createRpcSuccessResponse(id, "export_review_feedback", outcome);
		}

		// =================================================================
		// Push notifications
		// =================================================================

		case "register_push_target": {
			const { outcome } = await intentRegistry.invoke(intents, "register_push_target", command.args);
			return createRpcSuccessResponse(id, "register_push_target", outcome);
		}

		// =================================================================
		// MCP management
		// =================================================================

		case "get_mcp_capabilities": {
			return createRpcSuccessResponse(
				id,
				"get_mcp_capabilities",
				await queryRegistry.run(intents, "mcp.capabilities", {}),
			);
		}

		case "list_mcp_servers": {
			return createRpcSuccessResponse(id, "list_mcp_servers", await queryRegistry.run(intents, "mcp.servers", {}));
		}

		case "get_mcp_server": {
			return createRpcSuccessResponse(
				id,
				"get_mcp_server",
				await queryRegistry.run(intents, "mcp.server", { server: command.server }),
			);
		}

		case "connect_mcp_server":
		case "refresh_mcp_server":
		case "disconnect_mcp_server": {
			const intent =
				command.type === "connect_mcp_server"
					? "mcp.connect"
					: command.type === "refresh_mcp_server"
						? "mcp.refresh"
						: "mcp.disconnect";
			const { outcome } = await intentRegistry.invoke(intents, intent, { server: command.server });
			return createRpcSuccessResponse(id, command.type, outcome);
		}

		case "start_mcp_server_auth": {
			// Device-code sign-in is its own intent; every other flow is the local browser sign-in.
			const { outcome } =
				command.flow === "device"
					? await intentRegistry.invoke(intents, "mcp.auth_start_device", { server: command.server })
					: await intentRegistry.invoke(intents, "mcp.auth_start_browser", {
							server: command.server,
							...(command.redirectUrl === undefined ? {} : { redirectUrl: command.redirectUrl }),
						});
			return createRpcSuccessResponse(id, "start_mcp_server_auth", outcome as object);
		}

		case "complete_mcp_server_auth": {
			const { outcome } = await intentRegistry.invoke(intents, "mcp.auth_complete", {
				server: command.server,
				redirectUrl: command.redirectUrl,
				code: command.code,
				...(command.state === undefined ? {} : { state: command.state }),
			});
			return createRpcSuccessResponse(id, "complete_mcp_server_auth", outcome as object);
		}

		case "poll_mcp_server_auth": {
			const { outcome } = await intentRegistry.invoke(intents, "mcp.auth_poll", { server: command.server });
			return createRpcSuccessResponse(id, "poll_mcp_server_auth", outcome as object);
		}

		case "cancel_mcp_server_auth": {
			const { outcome } = await intentRegistry.invoke(intents, "mcp.auth_cancel", { server: command.server });
			return createRpcSuccessResponse(id, "cancel_mcp_server_auth", outcome);
		}

		case "logout_mcp_server": {
			const { outcome } = await intentRegistry.invoke(intents, "mcp.logout", { server: command.server });
			return createRpcSuccessResponse(id, "logout_mcp_server", outcome);
		}

		case "set_mcp_server_enabled": {
			const { outcome } = await intentRegistry.invoke(intents, "mcp.set_enabled", {
				server: command.server,
				enabled: command.enabled,
			});
			return createRpcSuccessResponse(id, "set_mcp_server_enabled", outcome);
		}

		case "list_mcp_tools": {
			return createRpcSuccessResponse(
				id,
				"list_mcp_tools",
				await queryRegistry.run(intents, "mcp.tools", { server: command.server }),
			);
		}

		case "get_mcp_tool": {
			return createRpcSuccessResponse(
				id,
				"get_mcp_tool",
				await queryRegistry.run(intents, "mcp.tool", { server: command.server, tool: command.tool }),
			);
		}

		case "list_mcp_resources": {
			return createRpcSuccessResponse(
				id,
				"list_mcp_resources",
				await queryRegistry.run(intents, "mcp.resources", {
					server: command.server,
					...(command.cursor === undefined ? {} : { cursor: command.cursor }),
				}),
			);
		}

		case "read_mcp_resource": {
			return createRpcSuccessResponse(
				id,
				"read_mcp_resource",
				await queryRegistry.run(intents, "mcp.resource", {
					server: command.server,
					resourceUri: command.resourceUri,
				}),
			);
		}

		case "list_mcp_prompts": {
			return createRpcSuccessResponse(
				id,
				"list_mcp_prompts",
				await queryRegistry.run(intents, "mcp.prompts", {
					server: command.server,
					...(command.cursor === undefined ? {} : { cursor: command.cursor }),
				}),
			);
		}

		case "get_mcp_prompt": {
			return createRpcSuccessResponse(
				id,
				"get_mcp_prompt",
				await queryRegistry.run(intents, "mcp.prompt", {
					server: command.server,
					prompt: command.prompt,
					...(command.arguments === undefined ? {} : { arguments: command.arguments }),
					...(command.argumentsJson === undefined ? {} : { argumentsJson: command.argumentsJson }),
				}),
			);
		}

		case "list_mcp_recent_calls": {
			return createRpcSuccessResponse(
				id,
				"list_mcp_recent_calls",
				await queryRegistry.run(intents, "mcp.recent_calls", {
					...(command.server === undefined ? {} : { server: command.server }),
				}),
			);
		}

		// =================================================================
		// State
		// =================================================================

		case "get_state": {
			return createRpcSuccessResponse(id, "get_state", buildRpcSessionState(session));
		}

		case "get_transcript": {
			const transcript = projectSessionTranscript(session.sessionManager, {
				beforeEntryId: command.beforeEntryId,
				limit: command.limit,
			});
			return createRpcSuccessResponse(id, "get_transcript", transcript);
		}

		case "get_session_tree": {
			const entries = session.sessionManager.getEntries();
			const toolCallsByResultEntryId = resolveSessionToolCallsByResultEntryId(entries);
			const tree: RpcSessionTreePage = projectSessionTreePage(entries, session.sessionManager.getBranch(), {
				sessionId: session.sessionManager.getSessionId(),
				limit: command.limit,
				afterOrdinal: command.afterOrdinal,
				projectTranscriptEntry: (entry) =>
					projectConversationTranscriptEntry(entry, toolCallsByResultEntryId.get(entry.id)),
			});
			return createRpcSuccessResponse(id, "get_session_tree", tree);
		}

		case "get_message_images": {
			const result = projectMessageImages(
				session.sessionManager.getEntries(),
				command.entryId,
				command.startImageIndex,
			);
			if (!result.ok) {
				return createRpcErrorResponse(id, "get_message_images", result.error);
			}
			return createRpcSuccessResponse(id, "get_message_images", {
				sessionId: session.sessionManager.getSessionId(),
				entryId: result.entryId,
				totalImages: result.totalImages,
				images: result.images,
				nextImageIndex: result.nextImageIndex,
			});
		}

		// =================================================================
		// Session-owned background jobs
		// =================================================================

		case "list_jobs":
		case "read_job":
		case "cancel_job": {
			const scope = {
				sessionId: session.sessionId,
				...(context.conversationBranchEpoch === undefined ? {} : { branchEpoch: context.conversationBranchEpoch }),
			};
			if (command.type === "list_jobs") {
				return createRpcSuccessResponse(id, "list_jobs", {
					...scope,
					jobs: listRpcBackgroundJobs(session.backgroundJobs),
				});
			}
			const { job } =
				command.type === "cancel_job"
					? (await intentRegistry.invoke(intents, "cancel_job", { jobId: command.jobId })).outcome
					: await queryRegistry.run(intents, "job_output", { jobId: command.jobId });
			return createRpcSuccessResponse(id, command.type, { ...scope, job });
		}

		// =================================================================
		// Subagents (local RPC only)
		// =================================================================

		case "list_subagents": {
			return createRpcSuccessResponse(
				id,
				"list_subagents",
				await queryRegistry.run(intents, "subagent_definitions", {}),
			);
		}

		case "subagent_start": {
			const { outcome } = await intentRegistry.invoke(intents, "subagent_start", {
				agent: command.agent,
				prompt: command.prompt,
			});
			return createRpcSuccessResponse(id, "subagent_start", outcome);
		}

		case "subagent_abort":
		case "subagent_dispose": {
			await intentRegistry.invoke(intents, command.type, { subagentId: command.subagentId });
			return createRpcSuccessResponse(id, command.type);
		}

		case "subagent_get_state": {
			return createRpcSuccessResponse(
				id,
				"subagent_get_state",
				await context.subagents.getState(command.subagentId),
			);
		}

		case "subagent_get_transcript": {
			return createRpcSuccessResponse(
				id,
				"subagent_get_transcript",
				await context.subagents.getTranscript({
					subagentId: command.subagentId,
					limit: command.limit,
					beforeEntryId: command.beforeEntryId,
				}),
			);
		}

		// =================================================================
		// Model
		// =================================================================

		case "set_model": {
			// Persisting the default is the separate host intent; admit both before either runs.
			const selection = { provider: command.provider, modelId: command.modelId };
			const select = intentRegistry.prepare(intents, "set_model", selection);
			const persist =
				command.persistDefault === false
					? undefined
					: intentRegistry.prepare(intents, "set_default_model", selection);
			const { outcome: model } = await select.run();
			if (persist) {
				await persist.run();
				if (session.supportsThinking() || session.thinkingLevel !== "off") {
					await intentRegistry.invoke(intents, "set_default_thinking_level", { level: session.thinkingLevel });
				}
			}
			return createRpcSuccessResponse(id, "set_model", toIrohRemoteAgentOptionsCatalogModel(model));
		}

		case "cycle_model": {
			const result = await session.cycleModel();
			if (!result) {
				return createRpcSuccessResponse(id, "cycle_model", null);
			}
			return createRpcSuccessResponse(id, "cycle_model", result);
		}

		case "get_available_models": {
			const { models } = await queryRegistry.run(intents, "models", {});
			return createRpcSuccessResponse(id, "get_available_models", { models });
		}

		// =================================================================
		// Thinking
		// =================================================================

		case "set_thinking_level": {
			const select = intentRegistry.prepare(intents, "set_thinking_level", { level: command.level });
			const persist =
				command.persistDefault === false
					? undefined
					: intentRegistry.prepare(intents, "set_default_thinking_level", { level: command.level });
			const previous = session.thinkingLevel;
			const { outcome: level } = await select.run();
			// The default follows only an actual change, to the level the model supports.
			if (persist && level !== previous && (session.supportsThinking() || level !== "off")) {
				await intentRegistry.invoke(intents, "set_default_thinking_level", { level });
			}
			return createRpcSuccessResponse(id, "set_thinking_level", { level: session.thinkingLevel });
		}

		case "cycle_thinking_level": {
			const level = session.cycleThinkingLevel();
			if (!level) {
				return createRpcSuccessResponse(id, "cycle_thinking_level", null);
			}
			await session.settingsManager.flush();
			return createRpcSuccessResponse(id, "cycle_thinking_level", { level });
		}

		// =================================================================
		// Queue Modes, compaction, retry, bash
		// =================================================================

		case "set_steering_mode":
		case "set_follow_up_mode": {
			await intentRegistry.invoke(intents, command.type, { mode: command.mode });
			return createRpcSuccessResponse(id, command.type);
		}

		case "compact": {
			const { outcome } = await intentRegistry.invoke(
				intents,
				"compact",
				command.customInstructions === undefined ? {} : { customInstructions: command.customInstructions },
			);
			return createRpcSuccessResponse(id, "compact", outcome);
		}

		case "set_auto_compaction":
		case "set_auto_retry": {
			await intentRegistry.invoke(intents, command.type, { enabled: command.enabled });
			return createRpcSuccessResponse(id, command.type);
		}

		case "abort_retry":
		case "abort_bash": {
			await intentRegistry.invoke(intents, command.type, {});
			return createRpcSuccessResponse(id, command.type);
		}

		case "bash": {
			const { outcome } = await intentRegistry.invoke(intents, "bash", {
				command: command.command,
				...(command.excludeFromContext === undefined ? {} : { excludeFromContext: command.excludeFromContext }),
			});
			return createRpcSuccessResponse(id, "bash", outcome);
		}

		// =================================================================
		// Session
		// =================================================================

		case "get_session_stats": {
			const { sessionRef: _sessionRef, ...stats } = session.getSessionStats();
			return createRpcSuccessResponse(id, "get_session_stats", stats);
		}

		case "get_subscription_usage": {
			return createRpcSuccessResponse(
				id,
				"get_subscription_usage",
				await queryRegistry.run(intents, "subscription_usage", {}),
			);
		}

		case "list_sessions": {
			const { sessions } = await queryRegistry.run(intents, "sessions", {});
			return createRpcSuccessResponse(id, "list_sessions", { sessions });
		}

		case "export_html": {
			const { outcome } = await intentRegistry.invoke(
				intents,
				"export_html",
				command.outputPath === undefined ? {} : { outputPath: command.outputPath },
			);
			return createRpcSuccessResponse(id, "export_html", outcome);
		}

		case "switch_session":
		case "switch_session_by_id": {
			const { outcome } = await intentRegistry.invoke(intents, "switch_session", { sessionId: command.sessionId });
			return createRpcSuccessResponse(id, command.type, projectSessionIntent(outcome));
		}

		case "fork": {
			const { outcome } = await intentRegistry.invoke(intents, "fork", { entryId: command.entryId });
			if (outcome.cancelled) return createRpcSuccessResponse(id, "fork", { cancelled: true });
			return createRpcSuccessResponse(id, "fork", {
				cancelled: false,
				sessionId: outcome.sessionId,
				text: outcome.selectedText ?? "",
			});
		}

		case "clone": {
			const { outcome } = await intentRegistry.invoke(intents, "clone", {});
			return createRpcSuccessResponse(id, "clone", projectSessionIntent(outcome));
		}

		case "get_fork_messages": {
			const messages = session.getUserMessagesForForking();
			return createRpcSuccessResponse(id, "get_fork_messages", { messages });
		}

		case "get_last_assistant_text": {
			const text = session.getLastAssistantText();
			return createRpcSuccessResponse(id, "get_last_assistant_text", { text });
		}

		case "set_session_name": {
			await intentRegistry.invoke(intents, "set_session_name", { name: command.name });
			return createRpcSuccessResponse(id, "set_session_name");
		}

		// =================================================================
		// Messages
		// =================================================================

		case "get_messages": {
			return createRpcSuccessResponse(id, "get_messages", { messages: session.messages });
		}

		// =================================================================
		// Commands (available for invocation via prompt)
		// =================================================================

		case "get_commands": {
			const commands: RpcSlashCommand[] = [];

			for (const command of session.extensionRunner.getRegisteredCommands()) {
				commands.push({
					name: command.invocationName,
					description: command.description,
					source: "extension",
					sourceInfo: command.sourceInfo,
				});
			}

			for (const template of session.promptTemplates) {
				commands.push({
					name: template.name,
					description: template.description,
					source: "prompt",
					sourceInfo: template.sourceInfo,
				});
			}

			for (const skill of session.resourceLoader.getSkills().skills) {
				commands.push({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				});
			}

			return createRpcSuccessResponse(id, "get_commands", { commands });
		}

		default: {
			const target = getRpcErrorResponseTarget(command);
			return createRpcErrorResponse(target.id, target.command, `Unknown command: ${target.command}`);
		}
	}
}
