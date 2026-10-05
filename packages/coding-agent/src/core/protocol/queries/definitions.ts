import { stripVTControlCharacters } from "node:util";
import { CONTENT_TEXT_MAX_SCALARS, type QueryName, type QueryResult } from "@hansjm10/volt-protocol";
import { getMcpRpcCapabilities, listMcpRpcServers } from "../../mcp/rpc.ts";
import type { McpGatewayExecutionContext } from "../../mcp/types.ts";
import { toIrohRemoteAgentOptionsCatalogModel } from "../../remote/iroh/agent-options.ts";
import { getReviewGeneral } from "../../review-general.ts";
import { getCanonicalReviewRun, type HydratedReviewRunRecord, listCanonicalReviewRuns } from "../../review-state.ts";
import { UNAVAILABLE_REVIEW_USAGE } from "../../review-usage.ts";
import { createReviewFileMetadata, createReviewPullRequestMetadata } from "../../review-workflows.ts";
import type { SubscriptionUsageReport } from "../../subscription-usage.ts";
import { targetOf } from "../intents/conversation.ts";
import { mcpManagerOf, workspaceService } from "../intents/host.ts";
import { intentRegistry } from "../intents/index.ts";
import { runReviewDiscussion } from "../intents/review.ts";
import { intentStateOf } from "../intents/state.ts";
import { contentQuery, historyQuery } from "./log.ts";
import { defineQuery, type QueryDefinition, QueryRejectedError } from "./types.ts";

const observe = ["conversation.observe.v1"] as const;
const integrations = ["integrations.manage.v1"] as const;

// ============================================================================
// Intents
// ============================================================================

export const intentsQuery = defineQuery({
	name: "intents",
	scope: "conversation",
	remote: "safe",
	requires: observe,
	async run(ctx) {
		const view = { state: intentStateOf(ctx.target?.session), services: ctx.services, profile: ctx.profile };
		return { intents: intentRegistry.descriptors(view, ctx.target) };
	},
});

export const intentCompletionsQuery = defineQuery({
	name: "intent_completions",
	scope: "conversation",
	remote: "safe",
	requires: observe,
	async run(ctx, params) {
		return { completions: await intentRegistry.complete(ctx, params.intent, params.field, params.prefix ?? "") };
	},
});

// ============================================================================
// Catalogs
// ============================================================================

export const modelsQuery = defineQuery({
	name: "models",
	scope: "conversation",
	remote: "safe",
	requires: ["model.select.v1"],
	async run(ctx) {
		const { session } = targetOf(ctx);
		// Reload credentials and models from disk so logins, logouts, and API keys
		// saved by other volt processes become selectable without a host restart.
		session.modelRegistry.refreshFromDisk();
		const models = await session.modelRegistry.getAvailable();
		const scoped = session.scopedModels
			.map((scopedModel) => scopedModel.model)
			.filter((model) => session.modelRegistry.hasConfiguredAuth(model));
		const cycleScope = session.scopedModels.length > 0 ? scoped : models;
		return {
			models: models.map(toIrohRemoteAgentOptionsCatalogModel),
			cycleScope: cycleScope.map((model) => ({ provider: model.provider, modelId: model.id })),
		};
	},
});

export const sessionsQuery = defineQuery({
	name: "sessions",
	// A remote host lists its workspace's sessions without a conversation (a workspace stream).
	scope: "host",
	remote: "safe",
	requires: observe,
	async run(ctx, params) {
		const listWorkspace = ctx.services.workspace?.listSessions;
		const sessions = listWorkspace ? await listWorkspace() : await targetOf(ctx).conversation.listSessions();
		const start = params.cursor === undefined ? 0 : Number(params.cursor);
		if (
			!Number.isSafeInteger(start) ||
			start < 0 ||
			(String(start) !== params.cursor && params.cursor !== undefined)
		) {
			throw new QueryRejectedError("invalid_input", "Unknown sessions cursor");
		}
		const end = params.limit === undefined ? sessions.length : Math.min(sessions.length, start + params.limit);
		const hasMore = end < sessions.length;
		return { sessions: sessions.slice(start, end), hasMore, nextCursor: hasMore ? String(end) : null };
	},
});

export const settingsQuery = defineQuery({
	name: "settings",
	scope: "conversation",
	remote: "safe",
	requires: observe,
	async run(ctx) {
		const { session } = targetOf(ctx);
		return {
			steeringMode: session.steeringMode,
			followUpMode: session.followUpMode,
			autoCompaction: session.autoCompactionEnabled,
			autoRetry: session.autoRetryEnabled,
			profile: session.settingsManager.getActiveProfile() ?? "",
		};
	},
});

/** The provider usage a client sees: limits and errors, never provider metadata. */
export function projectSubscriptionUsageReport(report: SubscriptionUsageReport): QueryResult<"subscription_usage"> {
	if (report.status !== "providers") {
		return { status: report.status };
	}
	return {
		status: "providers",
		providers: report.providers.map((provider) => {
			if (provider.result.status === "error") {
				return {
					providerId: provider.providerId,
					result: {
						status: "error",
						error: {
							code: provider.result.error.code,
							message: provider.result.error.message,
						},
					},
				};
			}
			const snapshot = provider.result.snapshot;
			return {
				providerId: provider.providerId,
				result: {
					status: "success",
					snapshot: {
						providerId: provider.providerId,
						fetchedAt: snapshot.fetchedAt,
						...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }),
						limits: snapshot.limits.map((limit) => ({
							id: limit.id,
							label: limit.label,
							usedPercent: limit.usedPercent,
							...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
							...(limit.windowDurationMs === undefined ? {} : { windowDurationMs: limit.windowDurationMs }),
							...(limit.limitReached === undefined ? {} : { limitReached: limit.limitReached }),
						})),
					},
				},
			};
		}),
	};
}

export const subscriptionUsageQuery = defineQuery({
	name: "subscription_usage",
	scope: "conversation",
	remote: "safe",
	requires: ["host.manage.v1"],
	async run(ctx) {
		const { session } = targetOf(ctx);
		const service = ctx.services.subscriptionUsage;
		if (!service) throw new QueryRejectedError("unavailable", "Subscription usage is not available in this host");
		return projectSubscriptionUsageReport(await service.fetch(session.modelRegistry, session.model?.provider));
	},
});

export const hostStatusQuery = defineQuery({
	name: "host_status",
	scope: "host",
	remote: "safe",
	requires: observe,
	async run(ctx) {
		const keepAwake = ctx.services.keepAwake;
		if (!keepAwake) throw new QueryRejectedError("unavailable", "unsupported_remote_command");
		const theme = ctx.services.hostTheme?.();
		return {
			keepAwake: keepAwake.status(),
			...(theme === undefined ? {} : { theme: { themeName: theme.themeName, tokens: { ...theme.tokens } } }),
		};
	},
});

export const webSearchStatusQuery = defineQuery({
	name: "web_search_status",
	scope: "host",
	remote: "safe",
	requires: integrations,
	async run(ctx) {
		const webSearchKey = ctx.services.webSearchKey;
		if (!webSearchKey) throw new QueryRejectedError("unavailable", "unsupported_remote_command");
		return { webSearch: { configured: webSearchKey.configured } };
	},
});

export const subagentDefinitionsQuery = defineQuery({
	name: "subagent_definitions",
	scope: "conversation",
	remote: "unsafe",
	requires: observe,
	async run(ctx) {
		const subagents = ctx.services.subagents;
		if (!subagents) throw new QueryRejectedError("unavailable", "Subagents are not available in this host");
		return subagents.list();
	},
});

export const workOutputQuery = defineQuery({
	name: "work_output",
	scope: "conversation",
	remote: "safe",
	requires: observe,
	async run(ctx, params) {
		const output = targetOf(ctx).conversation.work.output(params.workId);
		if (!output) throw new QueryRejectedError("invalid_input", `Unknown work ${JSON.stringify(params.workId)}`);
		// Plain text, its paths redacted for the subscriber before it is cut into chunks.
		let plain = stripVTControlCharacters(output.text)
			.replace(/\r\n?/g, "\n")
			.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
		if (output.truncated && ctx.subscriber?.fidelity === "transcript") {
			// The kept tail starts mid-line, where a root may have been cut: a transcript profile starts at the next line.
			const lineEnd = plain.indexOf("\n");
			plain = lineEnd === -1 ? "" : plain.slice(lineEnd + 1);
		}
		const scalars = Array.from(ctx.subscriber ? ctx.subscriber.source(plain) : plain);
		const offset = Math.min(params.offset ?? 0, scalars.length);
		const end = Math.min(scalars.length, offset + CONTENT_TEXT_MAX_SCALARS);
		return {
			workId: params.workId,
			text: scalars.slice(offset, end).join(""),
			offset,
			nextOffset: end < scalars.length ? end : null,
			totalScalars: scalars.length,
			truncated: output.truncated,
			final: output.final,
		};
	},
});

// ============================================================================
// The connection's workspace
// ============================================================================

export const agentOptionsQuery = defineQuery({
	name: "agent_options",
	scope: "host",
	remote: "safe",
	requires: ["model.select.v1"],
	run: (ctx) => workspaceService(ctx, "agentOptions").operation(),
});

export const sessionContextsQuery = defineQuery({
	name: "session_contexts",
	scope: "host",
	remote: "safe",
	requires: observe,
	async run(ctx, params) {
		return { contexts: await workspaceService(ctx, "sessionContexts").operation(params.sessionIds) };
	},
});

export const worktreesQuery = defineQuery({
	name: "worktrees",
	scope: "host",
	remote: "safe",
	requires: observe,
	async run(ctx) {
		return { worktrees: await workspaceService(ctx, "listWorktrees").operation() };
	},
});

export const workspaceDirectoriesQuery = defineQuery({
	name: "workspace_directories",
	scope: "host",
	remote: "safe",
	requires: observe,
	run: (ctx, params) => workspaceService(ctx, "listDirectories").operation(params.path),
});

export const prReviewQuery = defineQuery({
	name: "pr_review",
	scope: "host",
	remote: "safe",
	requires: observe,
	run: (ctx, params) => workspaceService(ctx, "resolvePrReview").operation(params),
});

// ============================================================================
// MCP
// ============================================================================

function mcpExecutionContext(): McpGatewayExecutionContext {
	return { mode: "rpc", caller: "user" };
}

const mcp = { scope: "host", remote: "safe", requires: integrations } as const;

export const mcpCapabilitiesQuery = defineQuery({
	...mcp,
	name: "mcp.capabilities",
	run: async () => getMcpRpcCapabilities(),
});

export const mcpServersQuery = defineQuery({
	...mcp,
	name: "mcp.servers",
	run: async (ctx) => listMcpRpcServers(ctx.target?.session.getMcpManager()),
});

export const mcpServerQuery = defineQuery({
	...mcp,
	name: "mcp.server",
	run: async (ctx, params) => ({ server: mcpManagerOf(ctx).getServer(params.server) }),
});

export const mcpToolsQuery = defineQuery({
	...mcp,
	name: "mcp.tools",
	run: (ctx, params) => mcpManagerOf(ctx).listTools(params.server),
});

export const mcpToolQuery = defineQuery({
	...mcp,
	name: "mcp.tool",
	async run(ctx, params) {
		const tools = await mcpManagerOf(ctx).listTools(params.server);
		const tool = tools.tools.find((entry) => entry.name === params.tool);
		if (!tool) throw new Error(`MCP tool not found: ${params.server}.${params.tool}`);
		return { tool };
	},
});

export const mcpResourcesQuery = defineQuery({
	...mcp,
	name: "mcp.resources",
	run: (ctx, params) => mcpManagerOf(ctx).listResources(params.server, params.cursor),
});

export const mcpResourceQuery = defineQuery({
	...mcp,
	name: "mcp.resource",
	async run(ctx, params) {
		return {
			result: await mcpManagerOf(ctx).readResource(params.server, params.resourceUri, mcpExecutionContext()),
		};
	},
});

export const mcpPromptsQuery = defineQuery({
	...mcp,
	name: "mcp.prompts",
	run: (ctx, params) => mcpManagerOf(ctx).listPrompts(params.server, params.cursor),
});

export const mcpPromptQuery = defineQuery({
	...mcp,
	name: "mcp.prompt",
	async run(ctx, params) {
		const result = await mcpManagerOf(ctx).getPrompt(
			params.server,
			params.prompt,
			{ action: "get_prompt", arguments: params.arguments, argumentsJson: params.argumentsJson },
			mcpExecutionContext(),
		);
		return { result };
	},
});

export const mcpRecentCallsQuery = defineQuery({
	...mcp,
	name: "mcp.recent_calls",
	async run(ctx, params) {
		const manager = ctx.target?.session.getMcpManager();
		if (!manager) return { calls: [] };
		const calls = params.server
			? manager.getServer(params.server).recentCalls
			: manager.listServers().flatMap((server) => server.recentCalls);
		return { calls };
	},
});

// ============================================================================
// Review
// ============================================================================

function projectReviewTargetIdentity(
	identity: HydratedReviewRunRecord["target"]["identity"],
	includePullRequestBody: boolean,
): Record<string, unknown> {
	const pullRequest = identity.pullRequest;
	return {
		kind: identity.kind,
		baseTree: identity.baseTree,
		headTree: identity.headTree,
		...(identity.baseCommit ? { baseCommit: identity.baseCommit } : {}),
		...(identity.mergeBaseCommit ? { mergeBaseCommit: identity.mergeBaseCommit } : {}),
		...(identity.headCommit ? { headCommit: identity.headCommit } : {}),
		...(pullRequest
			? {
					pullRequest: {
						number: pullRequest.number,
						title: pullRequest.title,
						...(includePullRequestBody ? { body: pullRequest.body } : {}),
						url: pullRequest.url,
						baseRefName: pullRequest.baseRefName,
						headRefName: pullRequest.headRefName,
						baseRefOid: pullRequest.baseRefOid,
						headRefOid: pullRequest.headRefOid,
					},
				}
			: {}),
	};
}

/** A durable review run as clients see it: in full with its result, or summarized in a listing. */
export function projectReviewRun(record: HydratedReviewRunRecord, includeResult: boolean): Record<string, unknown> {
	const result = record.result;
	const pullRequest = createReviewPullRequestMetadata(record.target.identity);
	const files = createReviewFileMetadata(record.target.files, record.target.fileSummary, includeResult);
	return {
		runId: record.runId,
		workflowAction: record.workflowAction,
		status: record.status,
		startedAt: record.startedAt,
		...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
		usage: record.usage?.summary ?? UNAVAILABLE_REVIEW_USAGE,
		...(record.usage
			? {
					usageUpdatedAt: record.usage.updatedAt,
					...(includeResult ? { usageBreakdown: record.usage.attempts } : {}),
				}
			: {}),
		...(record.acknowledgedAt === undefined ? {} : { acknowledgedAt: record.acknowledgedAt }),
		target: {
			description: record.target.description,
			diffCommand: record.target.diffCommand,
			identity: projectReviewTargetIdentity(record.target.identity, includeResult),
			...(pullRequest ? { pullRequest } : {}),
			files,
			...(record.target.context ? { context: record.target.context } : {}),
		},
		options: record.options,
		...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
		...(record.incrementalFallbackReason ? { incrementalFallbackReason: record.incrementalFallbackReason } : {}),
		...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
		...(result
			? includeResult
				? {
						completionStatus: result.completionStatus,
						summary: result.summary,
						findings: result.findings,
						coverage: result.coverage,
						...(result.overallCorrectness ? { overallCorrectness: result.overallCorrectness } : {}),
						overallExplanation: result.overallExplanation,
						...(result.verificationChallenge ? { verificationChallenge: result.verificationChallenge } : {}),
					}
				: { completionStatus: result.completionStatus, findingsCount: result.findings.length }
			: {}),
	};
}

const review = { scope: "conversation", remote: "safe", requires: observe } as const;

export const reviewDiscussionsQuery = defineQuery({
	...review,
	name: "review.discussions",
	run: (ctx, params) => runReviewDiscussion(ctx, (service) => service.list(params.runId, params.cursor, params.limit)),
});

export const reviewDiscussionSourceQuery = defineQuery({
	...review,
	name: "review.discussion_source",
	run: (ctx) => runReviewDiscussion(ctx, async (service) => ({ discussion: await service.source() })),
});

export const reviewGeneralQuery = defineQuery({
	...review,
	name: "review.general",
	run: (ctx, params) => getReviewGeneral(targetOf(ctx).session.sessionManager, params.runId),
});

export const reviewResultQuery = defineQuery({
	...review,
	name: "review.result",
	async run(ctx, params) {
		const record = await getCanonicalReviewRun(targetOf(ctx).session.sessionManager, params.runId);
		if (!record) throw new Error(`Unknown durable review run: ${params.runId}`);
		return projectReviewRun(record, true) as QueryResult<"review.result">;
	},
});

export const reviewWorkflowsQuery = defineQuery({
	...review,
	name: "review.workflows",
	async run(ctx, params) {
		const { session, conversation } = targetOf(ctx);
		const page = await listCanonicalReviewRuns(session.sessionManager, {
			cursor: params.cursor,
			limit: params.limit,
		});
		return {
			runs: page.runs.map((run) => projectReviewRun(run, false)),
			activeWorkflows: conversation.reviewWorkflows.list().filter((workflow) => workflow.status === "running"),
			...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
		} as QueryResult<"review.workflows">;
	},
});

/** Every query this host serves, in protocol order. */
export const BUILTIN_QUERIES = {
	intents: intentsQuery,
	intent_completions: intentCompletionsQuery,
	history: historyQuery,
	content: contentQuery,
	models: modelsQuery,
	sessions: sessionsQuery,
	settings: settingsQuery,
	subscription_usage: subscriptionUsageQuery,
	host_status: hostStatusQuery,
	web_search_status: webSearchStatusQuery,
	subagent_definitions: subagentDefinitionsQuery,
	work_output: workOutputQuery,
	agent_options: agentOptionsQuery,
	session_contexts: sessionContextsQuery,
	worktrees: worktreesQuery,
	workspace_directories: workspaceDirectoriesQuery,
	pr_review: prReviewQuery,
	"mcp.capabilities": mcpCapabilitiesQuery,
	"mcp.servers": mcpServersQuery,
	"mcp.server": mcpServerQuery,
	"mcp.tools": mcpToolsQuery,
	"mcp.tool": mcpToolQuery,
	"mcp.resources": mcpResourcesQuery,
	"mcp.resource": mcpResourceQuery,
	"mcp.prompts": mcpPromptsQuery,
	"mcp.prompt": mcpPromptQuery,
	"mcp.recent_calls": mcpRecentCallsQuery,
	"review.discussions": reviewDiscussionsQuery,
	"review.discussion_source": reviewDiscussionSourceQuery,
	"review.general": reviewGeneralQuery,
	"review.result": reviewResultQuery,
	"review.workflows": reviewWorkflowsQuery,
} as const satisfies { readonly [N in QueryName]: QueryDefinition<N> };
