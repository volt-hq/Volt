/**
 * What a local protocol connection gives intents beyond the conversation:
 * aborts that deliver queued input, detached reviews run as the
 * conversation's `review` work, the connection's subagents, and subscription
 * usage.
 */

import type { RpcListSubagentsResponse, RpcSubagentDefinition } from "@hansjm10/volt-protocol";
import type { HostedConversation } from "../../host/hosted-conversation.ts";
import { liveKey } from "../../host/live-state.ts";
import {
	executeReviewWorkflow,
	prepareReviewWorkflow,
	REMOTE_REVIEW_FAILURE_MESSAGE,
	REMOTE_REVIEW_TOOL_NAMES,
	reviewWorkExecution,
	reviewWorkTarget,
} from "../../review.ts";
import { reviewWorkInput } from "../../review-work.ts";
import type { SubagentDefinition, SubagentHandle } from "../../subagents/index.ts";
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

interface ConnectionSubagent {
	readonly handle: SubagentHandle;
	/** The conversation that started it, whose live state shows its status. */
	readonly parent: HostedConversation;
	disposed: boolean;
}

/**
 * The subagents one connection started: their status is the parent's live
 * `subagent/<id>` value, and a client subscribes to `conversation` for each
 * one's log. They are disposed when the connection moves or ends.
 */
export class ConnectionSubagents implements IntentSubagentServices {
	private readonly parent: () => HostedConversation;
	private readonly active = new Map<string, ConnectionSubagent>();

	constructor(parent: () => HostedConversation) {
		this.parent = parent;
	}

	list(): RpcListSubagentsResponse {
		return {
			subagents: this.parent().session.resourceLoader.getSubagents().definitions.map(toRpcSubagentDefinition),
		};
	}

	/** The conversation of a running subagent, by its conversation id. */
	conversation(id: string): HostedConversation | undefined {
		for (const subagent of this.active.values()) {
			if (subagent.handle.conversation.id === id) return subagent.handle.conversation;
		}
		return undefined;
	}

	async start(agent: string, prompt: string): Promise<{ subagentId: string; sessionId: string }> {
		const parent = this.parent();
		const session = parent.session;
		const manager = session.getSubagentToolManager();
		if (!manager) throw new Error("Subagent manager is not available");
		const handle = await manager.startByName(agent, { allowedTools: session.getActiveToolNames() });
		const subagent: ConnectionSubagent = { handle, parent, disposed: false };
		this.active.set(handle.id, subagent);
		const setStatus = (status: "running" | "completed" | "failed" | "aborted", error?: string): void => {
			if (subagent.disposed) return;
			try {
				parent.liveState.set(liveKey("subagent", handle.id), {
					kind: "subagent",
					subagentId: handle.id,
					conversation: handle.sessionId,
					agent,
					status,
					...(error === undefined ? {} : { error }),
				});
			} catch {
				// The status is presentation; the child's log is authoritative.
			}
		};
		setStatus("running");
		void handle.waitForEnd().then(
			(result) => setStatus(result.status, result.error),
			(error: unknown) => setStatus("failed", error instanceof Error ? error.message : String(error)),
		);
		try {
			await handle.prompt(prompt);
		} catch (error) {
			await this.disposeSubagent(subagent).catch(() => undefined);
			throw error;
		}
		return { subagentId: handle.id, sessionId: handle.sessionId };
	}

	async abort(subagentId: string): Promise<void> {
		const subagent = this.get(subagentId);
		try {
			await subagent.handle.abort("remote_request");
		} finally {
			await this.disposeSubagent(subagent);
		}
	}

	async dispose(subagentId: string): Promise<void> {
		await this.disposeSubagent(this.get(subagentId));
	}

	async disposeAll(): Promise<void> {
		await Promise.all(
			[...this.active.values()].map((subagent) => this.disposeSubagent(subagent).catch(() => undefined)),
		);
	}

	private get(subagentId: string): ConnectionSubagent {
		const subagent = this.active.get(subagentId);
		if (!subagent || subagent.disposed) throw new Error(`Subagent ${subagentId} is not active`);
		return subagent;
	}

	private async disposeSubagent(subagent: ConnectionSubagent): Promise<void> {
		if (subagent.disposed) return;
		subagent.disposed = true;
		this.active.delete(subagent.handle.id);
		subagent.parent.liveState.clear(liveKey("subagent", subagent.handle.id));
		await subagent.handle.dispose();
	}
}

export interface LocalIntentServicesOptions {
	readonly subagents: ConnectionSubagents;
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
								// Immutable snapshot tools only: reviews get no workspace or command-capable tools.
								tools: REMOTE_REVIEW_TOOL_NAMES,
								signal: ctx.signal,
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
		subagents: options.subagents,
		subscriptionUsage: options.subscriptionUsage,
	};
}
