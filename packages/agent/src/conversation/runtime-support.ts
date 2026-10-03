/**
 * Helpers shared by the `Conversation` kernel and its logs: frozen and owned
 * copies of loop values, synthesized failure messages, error normalization,
 * and runtime diagnostics.
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	classifyProviderError,
	createAssistantMessageEventStream,
	createProviderError,
	type Model,
	type ProviderEnv,
	type ThinkingBudgets,
	type ToolArgumentLimits,
} from "@hansjm10/volt-ai";
import type { AgentAbortSource, AgentLoopNextAction, AgentLoopNextActionContext, AgentMessage } from "../types.ts";

/** Normalize unknown thrown values into Error instances before using them as typed error causes. */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

/** Freeze `value` and everything reachable from it. */
export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

export function cloneAgentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => structuredClone(message));
}

/** An owned copy of a next action; host-returned actions never alias loop state. */
export function cloneNextAction(action: AgentLoopNextAction): AgentLoopNextAction {
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
						messages: cloneAgentMessages(delivery.messages),
					})),
				}),
	};
}

/** An isolated next-action context with `defaultAction` replaced. Tools are shared; messages are copied. */
export function cloneNextActionContext(
	context: AgentLoopNextActionContext,
	defaultAction: AgentLoopNextAction,
): AgentLoopNextActionContext {
	return {
		context: {
			systemPrompt: context.context.systemPrompt,
			messages: cloneAgentMessages(context.context.messages),
			...(context.context.tools === undefined ? {} : { tools: [...context.context.tools] }),
		},
		newMessages: cloneAgentMessages(context.newMessages),
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

/** The assistant message that records a run failure or abort that produced no provider message. */
export function createFailureMessage(model: Model<any>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: aborted ? "aborted" : "error",
		error: aborted
			? createProviderError("aborted", error instanceof Error ? error.message : String(error))
			: classifyProviderError(error),
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** A stream holding only an aborted terminal, for a request aborted before it reached the provider. */
export function createAbortedAssistantStream(model: Model<any>): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message = createFailureMessage(model, new Error("Request was aborted"), true);
	stream.push({ type: "error", seq: 0, reason: "aborted", error: message });
	return stream;
}

interface CloneableStreamOptions {
	headers?: Record<string, string> | undefined;
	metadata?: Record<string, unknown> | undefined;
	env?: ProviderEnv | undefined;
	thinkingBudgets?: ThinkingBudgets | undefined;
	toolArgumentLimits?: ToolArgumentLimits | undefined;
}

/** A copy of curated stream options whose nested records are owned. */
export function cloneStreamOptions<T extends CloneableStreamOptions>(streamOptions?: T): T {
	return {
		...streamOptions,
		...(streamOptions?.headers ? { headers: { ...streamOptions.headers } } : {}),
		...(streamOptions?.metadata ? { metadata: { ...streamOptions.metadata } } : {}),
		...(streamOptions?.env ? { env: { ...streamOptions.env } } : {}),
		...(streamOptions?.thinkingBudgets ? { thinkingBudgets: { ...streamOptions.thinkingBudgets } } : {}),
		...(streamOptions?.toolArgumentLimits ? { toolArgumentLimits: { ...streamOptions.toolArgumentLimits } } : {}),
	} as T;
}

/** `message` with exactly one `runtime_abort` diagnostic naming the first abort source. */
export function withRuntimeAbortDiagnostic(
	message: AssistantMessage,
	source: AgentAbortSource,
	timestamp: number,
): AssistantMessage {
	return {
		...message,
		diagnostics: [
			...(message.diagnostics ?? []).filter((diagnostic) => diagnostic.type !== "runtime_abort"),
			{ type: "runtime_abort", timestamp, details: { source } },
		],
	};
}
