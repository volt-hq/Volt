/**
 * What a local protocol connection gives intents beyond the conversation:
 * aborts that deliver queued input, detached review workflows launched once
 * their acceptance is written, the conversation's subagents, and subscription
 * usage.
 */

import type { RpcSubagentDefinition } from "@hansjm10/volt-protocol";
import type { HostedConversation } from "../../host/hosted-conversation.ts";
import {
	executeReviewWorkflow,
	prepareReviewWorkflow,
	REMOTE_REVIEW_FAILURE_MESSAGE,
	REMOTE_REVIEW_TOOL_NAMES,
} from "../../review.ts";
import { appendReviewRun, createReviewRunRecord } from "../../review-state.ts";
import { createEmptyReviewUsage } from "../../review-usage.ts";
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

interface PendingReviewWorkflow {
	readonly launch: () => void;
	readonly cancel: () => void;
}

/**
 * Detached review workflows an intent registered: each launches once the
 * intent's acceptance is written, so `accepted` precedes the workflow's live
 * progress, or is cancelled when the intent is not accepted.
 */
export class PendingReviewWorkflows {
	private readonly pending = new Map<string, PendingReviewWorkflow>();

	add(workflowId: string, workflow: PendingReviewWorkflow): void {
		this.pending.set(workflowId, workflow);
	}

	/** Launch what an accepted intent registered; nothing stays pending. */
	launchAll(): void {
		for (const [workflowId, workflow] of [...this.pending]) {
			this.pending.delete(workflowId);
			workflow.launch();
		}
	}

	/** Cancel what a rejected intent registered. */
	cancelAll(): void {
		for (const [workflowId, workflow] of [...this.pending]) {
			this.pending.delete(workflowId);
			workflow.cancel();
		}
	}
}

export interface LocalIntentServicesOptions {
	readonly reviews: PendingReviewWorkflows;
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
			// The fast preflight runs inline so target errors fail the intent; the
			// execution is registered and launched once the acceptance is written.
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
			let started: ReturnType<typeof conversation.reviewWorkflows.start>;
			try {
				started = conversation.reviewWorkflows.start({
					prepared,
					fastModeEnabled,
					execute: async (hooks) => {
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
								// Immutable snapshot tools only: reviews get no workspace or command-capable tools.
								tools: REMOTE_REVIEW_TOOL_NAMES,
								signal: hooks.signal,
								onEvent: hooks.onEvent,
							});
							if (reviewOptions.remote && result.status === "failed") {
								return { ...result, errorMessage: REMOTE_REVIEW_FAILURE_MESSAGE };
							}
							return result;
						} catch (error) {
							if (reviewOptions.remote) return { status: "failed", errorMessage: REMOTE_REVIEW_FAILURE_MESSAGE };
							throw error;
						}
					},
				});
			} catch (error) {
				await prepared.resolution.dispose();
				throw error;
			}
			const { descriptor, launch } = started;
			let launched = false;
			options.reviews.add(descriptor.workflowId, {
				launch: () => {
					launched = true;
					launch();
				},
				cancel: () => {
					if (!launched) {
						// The cancelled run record is best-effort; a lost log ends the runtime.
						void appendReviewRun(
							session.sessionWriter,
							createReviewRunRecord({
								workflowId: prepared.workflowId,
								workflowAction: prepared.action,
								startedAt: prepared.startedAt,
								snapshot: prepared.resolution,
								controls: prepared.controls,
								status: "cancelled",
								usage: createEmptyReviewUsage(),
								incrementalPlan: prepared.incrementalPlan,
							}),
						).catch(() => {});
					}
					conversation.reviewWorkflows.cancel(descriptor.workflowId);
				},
			});
			return {
				status: "accepted",
				workflowId: descriptor.workflowId,
				...(prepared.modelWarning === undefined || reviewOptions.remote ? {} : { message: prepared.modelWarning }),
			};
		},
		subagents: localSubagentServices(conversation),
		subscriptionUsage: options.subscriptionUsage,
	};
}
