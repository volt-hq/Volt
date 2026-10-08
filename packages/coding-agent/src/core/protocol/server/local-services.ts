/**
 * What a local protocol connection gives intents beyond the conversation:
 * aborts that deliver queued input, detached reviews run as the
 * conversation's `review` work (each pass a conversation its clients
 * observe), the conversation's subagents, and subscription usage.
 */

import type { RpcSubagentDefinition } from "@hansjm10/volt-protocol";
import type { HostedConversation } from "../../host/hosted-conversation.ts";
import {
	executeReviewWorkflow,
	prepareReviewWorkflow,
	REMOTE_REVIEW_FAILURE_MESSAGE,
	REMOTE_REVIEW_TOOL_NAMES,
	reviewWorkExecution,
	reviewWorkTarget,
} from "../../review.ts";
import { startEngineReview } from "../../review-engine-run.ts";
import { reviewWorkInput } from "../../review-work.ts";
import type { SubagentDefinition } from "../../subagents/index.ts";
import type { SubscriptionUsageService } from "../../subscription-usage.ts";
import type { IntentServices, IntentSubagentServices } from "../intents/types.ts";

function toRpcSubagentDefinition(definition: SubagentDefinition): RpcSubagentDefinition {
	return {
		name: definition.name,
		description: definition.description,
		source: definition.source,
		sourceInfo: {
			source: definition.sourceInfo.source,
			scope: definition.sourceInfo.scope,
			origin: definition.sourceInfo.origin,
		},
		...(definition.tools ? { tools: definition.tools } : {}),
		...(definition.excludedTools ? { excludedTools: definition.excludedTools } : {}),
		...(definition.allowedSubagents ? { allowedSubagents: definition.allowedSubagents } : {}),
		...(definition.maxSubagentDepth !== undefined ? { maxSubagentDepth: definition.maxSubagentDepth } : {}),
		...(definition.maxChildAgents !== undefined ? { maxChildAgents: definition.maxChildAgents } : {}),
		...(definition.model ? { model: definition.model } : {}),
		...(definition.thinking ? { thinking: definition.thinking } : {}),
	};
}

/** The subagents a local client may start on `conversation`: work of the conversation, through its manager. */
function localSubagentServices(conversation: HostedConversation): IntentSubagentServices {
	const session = conversation.session;
	return {
		list: () => ({
			subagents: session.resourceLoader.getSubagents().definitions.map(toRpcSubagentDefinition),
		}),
		start: async (agent, prompt) => {
			const manager = session.getSubagentToolManager();
			if (!manager?.startWork) throw new Error("Subagent manager is not available");
			return await manager.startWork(agent, prompt);
		},
	};
}

export interface LocalIntentServicesOptions {
	readonly subscriptionUsage: SubscriptionUsageService;
}

/** The services local intents get on `conversation`. */
export function createLocalIntentServices(
	conversation: HostedConversation,
	options: LocalIntentServicesOptions,
): IntentServices {
	const session = conversation.session;
	return {
		abortRun: (target) => target.abort("remote_request", { deliverQueuedMessages: true }),
		detachedReviews: true,
		runReview: async (target, reviewOptions) => {
			if (reviewOptions.engine !== undefined) {
				const engine = session.reviewEngines.get(reviewOptions.engine);
				if (!engine) throw new Error(`Unknown review engine: ${reviewOptions.engine}`);
				const { workId } = await startEngineReview({
					engine,
					target,
					controls: reviewOptions.controls,
					remote: reviewOptions.remote,
					cwd: conversation.cwd,
					work: conversation.work,
					settingsManager: session.settingsManager,
					sessionManager: session.sessionManager,
					sessionWriter: session.sessionWriter,
				});
				return { status: "accepted", workId };
			}
			// The fast preflight runs inline so target errors fail the intent; the
			// review then runs as the conversation's work.
			const prepared = await prepareReviewWorkflow({
				target,
				controls: reviewOptions.controls,
				...(reviewOptions.parentRunId ? { parentRunId: reviewOptions.parentRunId } : {}),
				cwd: conversation.cwd,
				settingsManager: session.settingsManager,
				modelRegistry: session.modelRegistry,
				currentModel: session.model,
				sessionManager: session.sessionManager,
				requireProjectTrust: reviewOptions.remote,
				sanitizeRemoteErrors: reviewOptions.remote,
			});
			const thinkingLevel = session.thinkingLevel;
			const fastModeEnabled = session.fastModeEnabled;
			const authStorage = session.modelRegistry.authStorage;
			const modelRegistry = session.modelRegistry;
			const settingsManager = session.settingsManager;
			// Immutable snapshot tools only, unless a local client named auxiliary tools of the conversation
			// (never its workspace file tools). A remote review gets no auxiliary or extension tools at all.
			const tools = reviewOptions.remote
				? REMOTE_REVIEW_TOOL_NAMES
				: (reviewOptions.tools ?? REMOTE_REVIEW_TOOL_NAMES);
			const parentResourceLoader = reviewOptions.remote ? undefined : session.resourceLoader;
			const reviewed = reviewWorkTarget(prepared.resolution);
			try {
				await conversation.work.start(
					"review",
					reviewWorkInput(prepared.action, reviewed),
					async (ctx) => {
						try {
							const result = await executeReviewWorkflow({
								prepared,
								cwd: conversation.cwd,
								agentDir: conversation.services.agentDir,
								authStorage,
								modelRegistry,
								settingsManager,
								sessionWriter: session.sessionWriter,
								sanitizeRemoteErrors: reviewOptions.remote,
								thinkingLevel,
								fastModeEnabled,
								parentResourceLoader,
								tools,
								signal: ctx.signal,
								passes: session.reviewPasses,
								work: ctx,
							});
							if (reviewOptions.remote && result.status === "failed") {
								return { outcome: "failed", error: REMOTE_REVIEW_FAILURE_MESSAGE };
							}
							return reviewWorkExecution(result, reviewed);
						} catch (error) {
							if (reviewOptions.remote) return { outcome: "failed", error: REMOTE_REVIEW_FAILURE_MESSAGE };
							throw error;
						}
					},
					{ workId: prepared.workflowId },
				);
			} catch (error) {
				await prepared.resolution.dispose();
				throw error;
			}
			return {
				status: "accepted",
				workId: prepared.workflowId,
				...(prepared.modelWarning === undefined || reviewOptions.remote ? {} : { message: prepared.modelWarning }),
			};
		},
		subagents: localSubagentServices(conversation),
		subscriptionUsage: options.subscriptionUsage,
	};
}
