import type {
	AgentHarnessNextActionPolicy,
	AgentMessage,
	AgentTool,
	AgentToolDisposition,
	Conversation,
	ConversationPolicy,
	StreamFn,
	ThinkingLevel,
	ToolCallEvent,
	ToolCallResult,
	ToolResultEvent,
} from "@hansjm10/volt-agent-core";
import type { ImageContent, JsonObject, JsonValue, Model, TextContent } from "@hansjm10/volt-ai";
import type { AgentSession } from "../src/core/agent-session.ts";
import { reduceToolCall, type ToolCallPolicy } from "../src/core/session/turn-policy.ts";

/** A tool-result hook's patch, as the conversation's `afterToolCall` merges it. */
export interface ToolResultPatch {
	content?: Array<TextContent | ImageContent>;
	details?: JsonValue;
	isError?: boolean;
	disposition?: AgentToolDisposition;
}

type SessionTestInternals = {
	_conversation: Conversation<AgentTool>;
	_streamFn: StreamFn;
	_toolCallPolicies(signal: AbortSignal | undefined): Iterable<ToolCallPolicy<ToolCallEvent>>;
	_handleToolResultPolicy(event: Omit<ToolResultEvent, "type">): Promise<ToolResultPatch | undefined>;
};

function internals(session: AgentSession): SessionTestInternals {
	return session as unknown as SessionTestInternals;
}

/** The session's conversation policy object, which the conversation reads at every turn. */
function policyOf(session: AgentSession): { -readonly [K in keyof ConversationPolicy]: ConversationPolicy[K] } {
	return (internals(session)._conversation as unknown as { policy: ConversationPolicy }).policy;
}

function messageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n");
}

function messageImages(message: AgentMessage): ImageContent[] {
	if (message.role !== "user" || typeof message.content === "string") return [];
	return message.content.filter((part): part is ImageContent => part.type === "image");
}

/**
 * Test-only controls over a session's conversation: turns, the durable
 * queue, the provider stream, and its policy hooks.
 */
export function createAgentSessionTestControl(session: AgentSession) {
	const conversation = () => internals(session)._conversation;
	/** The running operation's signal; outside one, a fresh signal, so registered turn policies apply. */
	const policySignal = () => conversation().operation?.signal ?? new AbortController().signal;
	return {
		/** The session's conversation kernel. */
		get conversation(): Conversation<AgentTool> {
			return conversation();
		},
		/**
		 * Run a turn that delivers `input`: a user message as a prompt (later
		 * messages attached to it), anything else as host messages. Resolves when
		 * the turn settles.
		 */
		run: async (input: AgentMessage | readonly AgentMessage[]): Promise<void> => {
			const messages = Array.isArray(input) ? [...input] : [input as AgentMessage];
			const [first, ...rest] = messages;
			if (!first) throw new Error("A run needs a message");
			const admission =
				first.role === "user"
					? await conversation().prompt({
							message: messageText(first),
							images: messageImages(first),
							attachments: rest,
						})
					: await conversation().queueMessages("steer", messages);
			await admission.completion;
			await conversation().waitForIdle();
		},
		/** Run a turn over pending input or the context's tail; resolves when it settles. */
		continue: async (): Promise<void> => {
			await conversation().continue();
			await conversation().waitForIdle();
		},
		/** Queue durable host messages; while idle, the conversation starts a turn for them. */
		queueSteer: async (message: AgentMessage): Promise<string> =>
			(await conversation().queueMessages("steer", [message])).clientMessageId,
		queueFollowUp: async (message: AgentMessage): Promise<string> =>
			(await conversation().queueMessages("followUp", [message])).clientMessageId,
		hasQueuedMessages: () => {
			const queue = conversation().queue;
			return queue.prompt.length + queue.steer.length + queue.followUp.length > 0;
		},
		hasPendingPrompt: () => conversation().queue.prompt.length > 0,
		/** Withdraw every queued steer and follow-up; resolves with the withdrawn messages. */
		clearQueue: async () => {
			const cleared = await conversation().clearQueue();
			return [...cleared.steer, ...cleared.followUp];
		},
		getStreamFn: () => internals(session)._streamFn,
		/** Replace the provider stream the session's conversation sends requests through. */
		setStreamFn: (streamFn: StreamFn) => {
			internals(session)._streamFn = streamFn;
		},
		/** Run `handler` after the session's tool-result policy; its patch merges over the result. */
		onToolResult: (
			handler: (event: ToolResultEvent) => Promise<ToolResultPatch | undefined> | ToolResultPatch | undefined,
		) => {
			const policy = policyOf(session);
			const original = policy.afterToolCall;
			policy.afterToolCall = async (context, signal) => {
				const base = await original?.(context, signal);
				const details = (base?.details ?? context.result.details) as JsonValue | undefined;
				const event: ToolResultEvent = {
					type: "tool_result",
					toolCallId: context.toolCall.id,
					toolName: context.toolCall.name,
					input: context.args,
					content: base?.content ?? context.result.content,
					...(details === undefined ? {} : { details }),
					isError: base?.isError ?? context.isError,
				};
				const patch = await handler(event);
				if (!patch) return base;
				return { ...base, ...patch };
			};
			return () => {
				policy.afterToolCall = original;
			};
		},
		/** Register a next-action policy after the session's own; returns its removal. */
		registerNextActionPolicy: (policy: AgentHarnessNextActionPolicy) =>
			session.registerTurnPolicy({ nextAction: policy }),
		transformContext: async (messages: AgentMessage[]) =>
			(await policyOf(session).transformContext?.(messages)) ?? messages,
		/** The session's tool-call decision for `event`; undefined when nothing blocks or explains it. */
		evaluateToolCall: async (event: ToolCallEvent): Promise<ToolCallResult | undefined> => {
			const result = await reduceToolCall(event, internals(session)._toolCallPolicies(policySignal()));
			return result.block === undefined && result.reason === undefined ? undefined : result;
		},
		evaluateToolCallRequest: async (input: { toolCall: { id: string; name: string }; args: JsonObject }) => {
			const result = await reduceToolCall<ToolCallEvent>(
				{ type: "tool_call", toolCallId: input.toolCall.id, toolName: input.toolCall.name, input: input.args },
				internals(session)._toolCallPolicies(policySignal()),
			);
			return result.block === undefined && result.reason === undefined ? undefined : result;
		},
		evaluateToolResult: async (event: ToolResultEvent) => {
			const { type: _type, ...rest } = event;
			const patch = await internals(session)._handleToolResultPolicy(rest);
			return {
				content: patch?.content ?? event.content,
				...((patch?.details ?? event.details) === undefined ? {} : { details: patch?.details ?? event.details }),
				isError: patch?.isError ?? event.isError,
			};
		},
		/** Commit a model change; the session's model comes from the log. */
		setModel: async (model: Model<any>) => await conversation().setModel(model),
		setThinkingLevel: async (level: ThinkingLevel) => await conversation().setThinkingLevel(level),
		getStreamOptions: () => conversation().currentStreamOptions,
		getInferenceSpeed: () => (conversation().state.context.fastMode ? "fast" : "standard"),
		getActiveTools: () => conversation().activeTools,
	};
}

export type AgentSessionTestControl = ReturnType<typeof createAgentSessionTestControl>;
