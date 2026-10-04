/**
 * The session's conversation policy ({@link SessionTurnPolicy}): extension
 * context, payload, message, and tool hooks; the session's tool-call and
 * tool-result policy; and the turn policies hosts register. Turn policies
 * compose into one: the session's own policy first, then each registered
 * turn policy in registration order. The reduction rules are plain functions
 * over an ordered list of policies.
 */

import type {
	AgentEvent,
	AgentLoopNextAction,
	AgentLoopNextActionContext,
	AgentMessage,
	AgentTool,
	Conversation,
	ConversationCompactionCause,
	ConversationCompactionCheck,
	ConversationCompactionDecision,
	ConversationDelivery,
	ConversationMessageOrigin,
	ConversationPolicy,
	ConversationPreparedDelivery,
} from "@hansjm10/volt-agent-core";
import type { ImageContent, JsonObject, JsonValue, TextContent } from "@hansjm10/volt-ai";
import type { AgentSessionTurnPolicy } from "../agent-session.ts";
import { cloneCanonicalData } from "../canonical-data.ts";
import { ExtensionMessageRoleMismatchError, type ExtensionRunner, type ToolResultEvent } from "../extensions/index.ts";
import type { PolicyRegistration } from "../extensions/policy-registration.ts";
import { withoutExtensionServices } from "../extensions/services-runtime.ts";
import { getClientMessageId } from "../messages.ts";
import {
	authorizeToolOperation,
	type OperationGrantProfile,
	type OperationResolution,
	operationProvidesResearchEvidence,
	RESEARCH_OPERATION_GRANT_PROFILE,
	resolverCanProvideResearchEvidence,
} from "../operation-authorization.ts";
import type { PlanningState } from "../planning.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SessionBackgroundContinuation } from "./background-continuation.ts";
import type { SessionExtensionServices } from "./extension-services.ts";
import { subagentDetailsForAbortedCall } from "./lifecycle.ts";
import type { SessionRetry } from "./retry-policy.ts";
import type { SessionToolRuntime } from "./tool-runtime.ts";

export type NextActionPolicy = (
	context: AgentLoopNextActionContext,
	signal: AbortSignal,
) => AgentLoopNextAction | undefined | Promise<AgentLoopNextAction | undefined>;

function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => structuredClone(message));
}

/** An owned copy of an action; a policy's result never aliases loop state. */
function cloneNextAction(action: AgentLoopNextAction): AgentLoopNextAction {
	if (action.type === "stop") return { type: "stop" };
	if (action.type === "pause") {
		return {
			type: "pause",
			...(action.requestAuthority === undefined ? {} : { requestAuthority: action.requestAuthority }),
		};
	}
	return {
		type: "request",
		reason: action.reason,
		...(action.deliveries === undefined
			? {}
			: {
					deliveries: action.deliveries.map((delivery) => ({
						...(delivery.deliveryId === undefined ? {} : { deliveryId: delivery.deliveryId }),
						messages: cloneMessages(delivery.messages),
					})),
				}),
	};
}

/** An isolated copy of `context` suggesting `defaultAction`. Tools are shared; messages are copied. */
function cloneNextActionContext(
	context: AgentLoopNextActionContext,
	defaultAction: AgentLoopNextAction,
): AgentLoopNextActionContext {
	return {
		context: {
			systemPrompt: context.context.systemPrompt,
			messages: cloneMessages(context.context.messages),
			...(context.context.tools === undefined ? {} : { tools: [...context.context.tools] }),
		},
		newMessages: cloneMessages(context.newMessages),
		...(context.completedTurn === undefined
			? {}
			: {
					completedTurn: {
						message: structuredClone(context.completedTurn.message),
						toolResults: context.completedTurn.toolResults.map((message) => structuredClone(message)),
						disposition: context.completedTurn.disposition,
					},
				}),
		requestAuthority: context.requestAuthority,
		defaultAction: cloneNextAction(defaultAction),
	};
}

/**
 * Reduce the next action through `policies`, in order. Each policy sees the
 * action so far as its context's `defaultAction` and may replace it by
 * returning an action. Resolves the final action when any policy replaced the
 * suggestion, or undefined when none did.
 */
export async function reduceNextAction(
	context: AgentLoopNextActionContext,
	policies: Iterable<NextActionPolicy>,
	signal: AbortSignal,
): Promise<AgentLoopNextAction | undefined> {
	let current = context.defaultAction;
	let overridden = false;
	for (const policy of policies) {
		const pending = policy(cloneNextActionContext(context, current), signal);
		// Copy a synchronous result before yielding, so the policy cannot change it later.
		const result = pending instanceof Promise ? await pending : pending;
		if (result === undefined) continue;
		current = cloneNextAction(result);
		overridden = true;
	}
	return overridden ? current : undefined;
}

/** A tool-call decision: `block` prevents the call, and `reason` explains it. */
export interface ToolCallDecision {
	block?: boolean;
	reason?: string;
}

/** A tool call as the turn policies see it, carrying the decision so far. */
export interface TurnToolCall extends ToolCallDecision {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: JsonObject;
}

export type ToolCallPolicy<TCall extends object> = (
	call: TCall & ToolCallDecision,
) => ToolCallDecision | undefined | Promise<ToolCallDecision | undefined>;

/**
 * Run every policy on a tool call, in order, even after one blocks it. Each
 * sees a copy of the call carrying the decision so far. A block is final;
 * the latest reason wins.
 */
export async function reduceToolCall<TCall extends object>(
	call: TCall,
	policies: Iterable<ToolCallPolicy<TCall>>,
): Promise<ToolCallDecision> {
	const decision: ToolCallDecision = {};
	for (const policy of policies) {
		const result = await policy(structuredClone({ ...call, ...decision }));
		if (result?.block === true) decision.block = true;
		if (result?.reason !== undefined) decision.reason = result.reason;
	}
	return decision;
}

function ownTurnPolicy(policy: AgentSessionTurnPolicy): Readonly<AgentSessionTurnPolicy> {
	const { beforeToolCall, nextAction } = policy;
	if (
		(beforeToolCall !== undefined && typeof beforeToolCall !== "function") ||
		(nextAction !== undefined && typeof nextAction !== "function")
	)
		throw new TypeError("Expected turn policy callbacks");
	return Object.freeze({ beforeToolCall, nextAction });
}

export interface SessionTurnPolicyHost {
	readonly sessionManager: SessionManager;
	readonly retry: SessionRetry;
	conversation(): Conversation<AgentTool>;
	extensionRunner(): ExtensionRunner;
	extensionServices(): SessionExtensionServices;
	tools(): SessionToolRuntime;
	background(): SessionBackgroundContinuation;
	isDisposed(): boolean;
	/** Whether the session lost its log. */
	isLost(): boolean;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	/** Rejects once the session has lost its log. */
	assertNotLost(): void;
	/** The names of the tools active for the session's requests. */
	activeToolNames(): string[];
	/** The capability profile Plan mode restricts tools to, or undefined in Build mode. */
	operationGrantProfile(): OperationGrantProfile | undefined;
	planningState(): PlanningState;
	/** Whether a successful read in the current branch generation satisfies the Plan research gate. */
	hasPlanResearch(): boolean;
	/** A successful read satisfied the Plan research gate in the current branch generation. */
	recordPlanResearch(): void;
	/** Run the extension hooks of a loop event; for `message_end`, resolves the message as the hooks left it. */
	emitExtensionEvent(event: AgentEvent): Promise<AgentMessage | undefined>;
	/** Record a fatal hook error of the running turn: the prompt that ran it rejects with it. */
	recordTurnFatalError(error: Error): void;
	/** A delivered input whose message hook failed: it fails when its turn ends. */
	failDelivery(clientMessageId: string, error: Error): void;
	/** What a delivery commits with besides its messages (the ready-plan transition), or undefined. */
	prepareDelivery(delivery: ConversationDelivery): ConversationPreparedDelivery | undefined;
	/** The automatic compaction policy. */
	compactionDecision(
		cause: Exclude<ConversationCompactionCause, "manual">,
		check: ConversationCompactionCheck,
	): ConversationCompactionDecision | undefined;
}

export class SessionTurnPolicy {
	private readonly host: SessionTurnPolicyHost;
	/** The registered turn policies, in registration order. */
	private readonly workToolPolicies = new Set<{ policy: Readonly<AgentSessionTurnPolicy> }>();
	private workPolicyRevision = 0n;
	/** Operations the Plan capability profile authorized, by tool call, until their results arrive. */
	private readonly authorizedOperationResolutions = new Map<string, OperationResolution>();

	constructor(host: SessionTurnPolicyHost) {
		this.host = host;
	}

	/** The registered turn policies, in registration order. */
	get registrations(): Iterable<{ readonly policy: Readonly<AgentSessionTurnPolicy> }> {
		return this.workToolPolicies;
	}

	/** Changes whenever a registered turn policy's tool-call gate changes. */
	get revision(): bigint {
		return this.workPolicyRevision;
	}

	/**
	 * The session's conversation policy: extension context, payload, and tool
	 * hooks; message hooks; the ready-plan transition; the composed next-action
	 * policies; extension services at request boundaries; retry; and compaction.
	 */
	createPolicy(): ConversationPolicy {
		return {
			transformContext: async (messages) => await this.host.extensionRunner().emitContext(messages),
			beforeProviderPayload: async (payload) =>
				this.host.extensionRunner().hasHandlers("before_provider_request")
					? await this.host.extensionRunner().emitBeforeProviderRequest(payload)
					: undefined,
			afterProviderResponse: async (response) => {
				if (!this.host.extensionRunner().hasHandlers("after_provider_response")) return;
				await this.host.extensionRunner().emit({
					type: "after_provider_response",
					status: response.status,
					headers: response.headers,
				});
			},
			beforeToolCall: async ({ toolCall, args }, signal) =>
				await reduceToolCall<TurnToolCall>(
					{ type: "tool_call", toolCallId: toolCall.id, toolName: toolCall.name, input: args },
					this.toolCallPolicies(signal),
				),
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const details = result.details as JsonValue | undefined;
				return await this.toolResult({
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args,
					content: result.content,
					...(details === undefined ? {} : { details }),
					isError,
				});
			},
			messageEnd: async (message, _signal, origin) => await this.messageEnd(message, origin),
			prepareDelivery: (delivery) => this.host.prepareDelivery(delivery),
			nextAction: (context, signal) => {
				this.host.assertActive();
				this.host.background().decisionStarted();
				return reduceNextAction(context, this.nextActionPolicies(), signal);
			},
			requestBoundary: async (boundary, context, signal) =>
				await this.host.extensionServices().collect(boundary, context, signal),
			retry: (_error, attempt, message) => this.host.retry.delay(message, attempt),
			compaction: (_usage, cause, check) => this.host.compactionDecision(cause, check),
		};
	}

	/** Own callback snapshots; explicit updates/invalidation revoke earlier managed authorization. */
	register(policy: AgentSessionTurnPolicy): PolicyRegistration<AgentSessionTurnPolicy> {
		this.host.assertActive();
		const workPolicy = { policy: ownTurnPolicy(policy) };
		const changed = (previous: Readonly<AgentSessionTurnPolicy>, next: Readonly<AgentSessionTurnPolicy>) => {
			if (previous.beforeToolCall || next.beforeToolCall) this.workPolicyRevision++;
			if (previous.nextAction || next.nextAction) this.host.background().policyChanged();
		};
		this.workToolPolicies.add(workPolicy);
		changed({}, workPolicy.policy);
		let registered = true;
		const assertRegistered = () => {
			this.host.assertActive();
			if (!registered) throw new Error("Policy registration has been removed");
		};
		const remove = () => {
			if (!registered) return;
			registered = false;
			this.workToolPolicies.delete(workPolicy);
			changed(workPolicy.policy, {});
		};
		return Object.freeze(
			Object.assign(remove, {
				update: (next: AgentSessionTurnPolicy) => {
					assertRegistered();
					const previous = workPolicy.policy;
					workPolicy.policy = ownTurnPolicy(next);
					changed(previous, workPolicy.policy);
				},
				invalidate: () => {
					assertRegistered();
					changed(workPolicy.policy, workPolicy.policy);
				},
			}),
		);
	}

	/** A run ended: aborted tool calls can skip their result, so no authorization record outlives its run. */
	clearRunRecords(): void {
		this.authorizedOperationResolutions.clear();
	}

	/**
	 * Extension message hooks before a message commits. A delivered message
	 * gets `message_start` and `message_end` as it is prepared; a message the
	 * loop produced gets `message_end`. A role change is a terminal failure: the
	 * prompt that ran the turn rejects with it, and a delivered input fails.
	 */
	private async messageEnd(
		message: AgentMessage,
		origin: ConversationMessageOrigin,
	): Promise<AgentMessage | undefined> {
		if (this.host.isDisposed() || this.host.isLost()) return undefined;
		try {
			if (origin === "delivery") {
				if (
					!this.host.extensionRunner().hasHandlers("message_start") &&
					!this.host.extensionRunner().hasHandlers("message_end")
				) {
					return undefined;
				}
				const owned = cloneCanonicalData(message, "Delivery message");
				await this.host.emitExtensionEvent({ type: "message_start", message: owned });
			}
			return await this.host.emitExtensionEvent({ type: "message_end", message });
		} catch (error) {
			const fatalError = error instanceof Error ? error : new Error(String(error));
			if (error instanceof ExtensionMessageRoleMismatchError) {
				this.host.recordTurnFatalError(fatalError);
				const clientMessageId = getClientMessageId(message);
				if (clientMessageId !== undefined) this.host.failDelivery(clientMessageId, fatalError);
			}
			throw fatalError;
		}
	}

	/** The session's next-action policy (background notices), then registered turn policies. */
	private *nextActionPolicies(): Generator<NextActionPolicy> {
		yield (context) => this.host.background().notificationAction(context);
		for (const registration of this.workToolPolicies) {
			yield (context, signal) => {
				const snapshot = registration.policy;
				return withoutExtensionServices(() => snapshot.nextAction?.(context, signal));
			};
		}
	}

	/** The session's tool-call policy (activity, extensions, capability profile), then registered turn policies. */
	*toolCallPolicies(signal: AbortSignal | undefined): Generator<ToolCallPolicy<TurnToolCall>> {
		yield (event) => this.toolCall(event, signal);
		for (const registration of this.workToolPolicies) {
			yield async (event) => {
				const snapshot = registration.policy;
				if (!signal) return undefined;
				return await withoutExtensionServices(() => snapshot.beforeToolCall?.(event, signal));
			};
		}
	}

	private async toolCall(
		event: {
			toolName: string;
			toolCallId: string;
			input: JsonObject;
		},
		signal: AbortSignal | undefined,
	): Promise<{ block?: boolean; reason?: string } | undefined> {
		this.host.assertNotLost();
		if (!this.host.activeToolNames().includes(event.toolName)) {
			return {
				block: true,
				reason: this.host.operationGrantProfile()
					? `The active read-only capability profile does not expose ${event.toolName}.`
					: `Tool ${event.toolName} is no longer active for this session.`,
			};
		}
		let extensionDecision: { block?: boolean; reason?: string } | undefined;
		if (this.host.extensionRunner().hasHandlers("tool_call")) {
			extensionDecision = await this.host.extensionRunner().emitToolCall(
				{ type: "tool_call", ...event },
				{
					origin: { kind: "agent" },
					signal,
				},
			);
			if (extensionDecision?.block) return extensionDecision;
		}
		const profile = this.host.operationGrantProfile();
		if (profile) {
			const tools = this.host.tools();
			const decision = authorizeToolOperation(tools.trustedOperationResolver(event.toolName), event.input, profile);
			if (!decision.allowed) {
				return {
					block: true,
					reason: `The ${profile.id} capability profile blocked ${event.toolName}: ${decision.reason ?? "operation denied"}.`,
				};
			}
			if (event.toolName === "submit_plan" && !this.host.hasPlanResearch()) {
				const researchToolAvailable = tools
					.toolNames()
					.some((name) =>
						resolverCanProvideResearchEvidence(
							tools.trustedOperationResolver(name),
							RESEARCH_OPERATION_GRANT_PROFILE,
						),
					);
				return {
					block: true,
					reason: researchToolAvailable
						? "Plan mode requires at least one successful read operation before submitting a plan."
						: "Plan mode requires research evidence before submitting, but this session exposes no research-capable tools, so submit_plan cannot succeed. Tell the user their host configuration disables every builtin read tool.",
				};
			}
			this.authorizedOperationResolutions.set(event.toolCallId, decision.resolution);
		}
		return extensionDecision;
	}

	/**
	 * The session's tool-result policy: Plan research evidence, aborted subagent
	 * details, and extension `tool_result` hooks. A background job's start
	 * acknowledgement passes unchanged; the job's settled result passes here
	 * with `backgroundCompletion`.
	 */
	async toolResult(
		event: {
			toolName: string;
			toolCallId: string;
			input: JsonObject;
			content: Array<TextContent | ImageContent>;
			details?: JsonValue;
			isError: boolean;
		},
		backgroundCompletion = false,
	): Promise<{ content: Array<TextContent | ImageContent>; details?: JsonValue; isError: boolean } | undefined> {
		this.host.assertNotLost();
		if (!backgroundCompletion && this.host.background().takeStartAcknowledgement(event.toolName, event.toolCallId)) {
			// A start acknowledgement is not the native tool's completed result.
			// The worker invokes the original result policy once, at settlement.
			return undefined;
		}
		const resolution = this.authorizedOperationResolutions.get(event.toolCallId);
		this.authorizedOperationResolutions.delete(event.toolCallId);
		if (
			!event.isError &&
			this.host.planningState().mode === "plan" &&
			resolution !== undefined &&
			operationProvidesResearchEvidence(resolution)
		) {
			this.host.recordPlanResearch();
		}
		const abortedSubagentDetails = event.isError
			? subagentDetailsForAbortedCall(this.host.sessionManager, {
					type: "toolCall",
					id: event.toolCallId,
					name: event.toolName,
					arguments: event.input,
				})
			: undefined;
		if (!this.host.extensionRunner().hasHandlers("tool_result")) {
			return abortedSubagentDetails
				? { content: event.content, details: abortedSubagentDetails, isError: event.isError }
				: undefined;
		}
		const hookResult = await this.host.extensionRunner().emitToolResult(
			{
				type: "tool_result",
				...event,
			} satisfies ToolResultEvent,
			{
				origin: { kind: "agent" },
				signal: this.host.background().hookSignal(),
			},
		);
		const finalDetails =
			hookResult?.details !== undefined
				? (hookResult.details as JsonValue)
				: (abortedSubagentDetails ?? event.details);
		return cloneCanonicalData(
			{
				content: hookResult?.content ?? event.content,
				...(finalDetails === undefined ? {} : { details: finalDetails }),
				isError: hookResult?.isError ?? event.isError,
			},
			`Extension tool_result output for ${event.toolName}`,
		);
	}
}
