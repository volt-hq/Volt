/**
 * The single context builder (RFC §4.3): the provider messages for the fold's
 * active branch are `applyReplayPolicy(convertToLlm(transformContext(messages)))`.
 * Model-dependent normalization stays in providers at request time.
 */

import { applyReplayPolicy, type Message } from "@hansjm10/volt-ai";
import type { AgentMessage } from "../types.ts";
import type { ConversationState } from "./fold.ts";

export interface BuildContextOptions {
	/** Rewrites the branch messages before conversion. It receives a copy it may change freely. */
	readonly transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Converts runtime messages to provider messages; drops each user message's `clientMessageId`. */
	readonly convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	readonly signal?: AbortSignal;
}

/** The provider messages for the fold's active branch. Never changes `state`. */
export async function buildContext(state: ConversationState, options: BuildContextOptions): Promise<Message[]> {
	const messages = options.transformContext
		? await options.transformContext(structuredClone([...state.context.messages]), options.signal)
		: [...state.context.messages];
	return applyReplayPolicy(await options.convertToLlm(messages));
}
