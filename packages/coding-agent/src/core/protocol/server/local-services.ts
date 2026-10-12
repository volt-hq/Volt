/**
 * What a local protocol connection gives intents beyond the conversation:
 * aborts that deliver queued input, detached reviews run as the
 * conversation's `review` work (each pass a conversation its clients
 * observe), the conversation's subagents, and subscription usage.
 */

import type { RpcSubagentDefinition } from "@hansjm10/volt-protocol";
import type { HostedConversation } from "../../host/hosted-conversation.ts";
import { executeReviewWorkflow, prepareReviewWorkflow } from "../../review.ts";
import { startConversationReview } from "../../review-start.ts";
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
			const started = await startConversationReview(
				session,
				{ cwd: conversation.cwd, agentDir: conversation.services.agentDir },
				{ prepare: prepareReviewWorkflow, execute: executeReviewWorkflow },
				target,
				reviewOptions,
			);
			return {
				status: "accepted",
				workId: started.workId,
				...(started.message === undefined ? {} : { message: started.message }),
			};
		},
		subagents: localSubagentServices(conversation),
		subscriptionUsage: options.subscriptionUsage,
	};
}
