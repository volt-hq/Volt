/**
 * Composition of the session's turn policies into one: the session's own
 * policy first, then each registered turn policy in registration order. These
 * are the reduction rules the session's hooks have always had, as plain
 * functions over an ordered list of policies.
 */

import type { AgentLoopNextAction, AgentLoopNextActionContext, AgentMessage } from "@hansjm10/volt-agent-core";
import type { JsonObject } from "@hansjm10/volt-ai";

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
